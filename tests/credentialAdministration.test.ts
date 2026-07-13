import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { CredentialAdministration } from "../src/identity/credentialAdministration.js";
import { IdentityStore } from "../src/persistence/identityStore.js";

const now = "2026-07-13T18:00:00.000Z";

async function setup() {
  const db = newDb();
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const store = new IdentityStore(pool);
  await store.createOrganization({
    id: "org-1", name: "Acme", actorId: "bootstrap", causationId: "setup", occurredAt: now,
  });
  await store.registerAgent({
    id: "agent-1", organizationId: "org-1", name: "Scout",
    actorId: "bootstrap", causationId: "setup-agent", occurredAt: now,
  });
  return { pool, store };
}

const principal = {
  principalType: "service_account" as const,
  role: "admin" as const,
  principalId: "service-1",
  organizationId: "org-1",
  credentialId: "service-cred-1",
  capabilities: ["credentials:issue", "credentials:revoke"] as const,
};

describe("CredentialAdministration", () => {
  it("issues an agent credential once within the caller's organization", async () => {
    const { pool, store } = await setup();
    const administration = new CredentialAdministration(store, () => now, () => Buffer.alloc(32, 13));

    const issued = await administration.issueAgentCredential(principal, {
      credentialId: "agent-cred-1",
      agentId: "agent-1",
      name: "Scout runtime",
      capabilities: ["inference:invoke", "receipts:read"],
      expiresAt: "2026-08-13T18:00:00.000Z",
      requestId: "request:issue-1",
    });

    expect(issued.token).toMatch(/^fuse_sk_/);
    expect(issued).toMatchObject({
      credentialId: "agent-cred-1",
      tokenPrefix: issued.token.slice(0, 20),
      capabilities: ["inference:invoke", "receipts:read"],
    });
    expect((await pool.query("SELECT organization_id, agent_id FROM api_credentials")).rows)
      .toEqual([{ organization_id: "org-1", agent_id: "agent-1" }]);
    await pool.end();
  });

  it("rotates and revokes administrative service-account credentials", async () => {
    const { pool, store } = await setup();
    await store.createServiceAccount({
      id: "service-1", organizationId: "org-1", name: "Provisioner", role: "admin",
      actorId: "bootstrap", causationId: "setup-service", occurredAt: now,
    });
    const administration = new CredentialAdministration(store, () => now, () => Buffer.alloc(32, 14));
    const issued = await administration.issueServiceAccountCredential(principal, {
      credentialId: "service-cred-2",
      serviceAccountId: "service-1",
      name: "rotated administration",
      capabilities: ["credentials:issue", "credentials:revoke"],
      expiresAt: "2026-07-14T18:00:00.000Z",
      requestId: "request:rotate-1",
    });
    expect(await store.authenticateToken(issued.token, "2026-07-13T19:00:00.000Z"))
      .toMatchObject({ role: "admin", credentialId: "service-cred-2" });
    await administration.revokeServiceAccountCredential(
      principal, "service-cred-2", "request:revoke-service-1",
    );
    expect(await store.authenticateToken(issued.token, "2026-07-13T19:00:00.000Z")).toBeNull();
    await pool.end();
  });

  it("rejects non-service principals and administrative capabilities on agent keys", async () => {
    const { pool, store } = await setup();
    const administration = new CredentialAdministration(store, () => now, () => Buffer.alloc(32, 13));
    await expect(administration.issueAgentCredential(
      { ...principal, principalType: "agent" },
      {
        credentialId: "bad-1", agentId: "agent-1", name: "bad",
        capabilities: ["inference:invoke"], requestId: "request:bad-1",
      },
    )).rejects.toThrow("SERVICE_ACCOUNT_REQUIRED");
    await expect(administration.issueAgentCredential(
      { ...principal, role: "viewer" },
      {
        credentialId: "bad-role", agentId: "agent-1", name: "bad",
        capabilities: ["inference:invoke"], requestId: "request:bad-role",
      },
    )).rejects.toThrow("SERVICE_ACCOUNT_ADMIN_REQUIRED");
    await expect(administration.issueAgentCredential(principal, {
      credentialId: "bad-2", agentId: "agent-1", name: "bad",
      capabilities: ["credentials:issue"], requestId: "request:bad-2",
    })).rejects.toThrow("AGENT_CREDENTIAL_CAPABILITY_INVALID");
    await pool.end();
  });
});
