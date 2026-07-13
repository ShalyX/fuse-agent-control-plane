import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { createApiCredential } from "../src/identity/apiCredentials.js";
import { ProductionFoundationStore } from "../src/persistence/productionFoundation.js";

async function createStores() {
  const db = newDb();
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const audit = new ProductionFoundationStore(pool);
  const identity = new IdentityStore(pool);
  await identity.ensureSchema();
  return { pool, audit, identity };
}

const context = {
  actorId: "user:founder",
  causationId: "request:onboard-1",
  occurredAt: "2026-07-13T17:00:00.000Z",
};

describe("IdentityStore", () => {
  it("initializes a clean identity and audit schema before mutations", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const identity = new IdentityStore(pool);
    const audit = new ProductionFoundationStore(pool);

    await identity.createOrganization({ id: "org-clean", name: "Clean Org", ...context });

    expect((await pool.query("SELECT id FROM organizations")).rows).toEqual([{ id: "org-clean" }]);
    expect((await audit.listAuditEvents("org-clean", "organization", "org-clean"))[0]?.action)
      .toBe("organization.created");
    await pool.end();
  });

  it("creates an organization and agent identity with durable audit events", async () => {
    const { pool, audit, identity } = await createStores();

    await identity.createOrganization({ id: "org-1", name: "Acme Agents", ...context });
    await identity.registerAgent({
      id: "agent-1",
      organizationId: "org-1",
      name: "Scout",
      ...context,
      causationId: "request:agent-1",
    });

    expect(await identity.getAgent("org-1", "agent-1")).toEqual({
      id: "agent-1",
      organizationId: "org-1",
      name: "Scout",
      status: "active",
      createdAt: context.occurredAt,
      revokedAt: null,
    });
    expect((await audit.listAuditEvents("org-1", "organization", "org-1")).map((event) => event.action))
      .toEqual(["organization.created"]);
    expect((await audit.listAuditEvents("org-1", "agent_identity", "agent-1")).map((event) => event.action))
      .toEqual(["agent.registered"]);

    await pool.end();
  });

  it("issues and authenticates a scoped agent credential without storing the raw token", async () => {
    const { pool, identity } = await createStores();
    await identity.createOrganization({ id: "org-1", name: "Acme Agents", ...context });
    await identity.registerAgent({
      id: "agent-1",
      organizationId: "org-1",
      name: "Scout",
      ...context,
      causationId: "request:agent-1",
    });
    const issued = createApiCredential({
      id: "cred-1",
      organizationId: "org-1",
      agentId: "agent-1",
      name: "Scout runtime",
      capabilities: ["inference:invoke", "receipts:read"],
      createdAt: context.occurredAt,
      expiresAt: "2026-08-13T17:00:00.000Z",
    }, () => Buffer.alloc(32, 9));

    await identity.issueCredential(issued.record, {
      ...context,
      causationId: "request:credential-1",
    });

    expect(await identity.authenticateToken(
      issued.token,
      "2026-07-14T00:00:00.000Z",
    )).toEqual({
      organizationId: "org-1",
      agentId: "agent-1",
      credentialId: "cred-1",
      capabilities: ["inference:invoke", "receipts:read"],
    });
    const stored = await pool.query("SELECT * FROM api_credentials WHERE id = 'cred-1'");
    expect(stored.rows[0]).not.toHaveProperty("token");

    await pool.end();
  });

  it("rejects tampered credential records at the persistence boundary", async () => {
    const { pool, identity } = await createStores();
    await identity.createOrganization({ id: "org-1", name: "Acme", ...context });
    await identity.registerAgent({ id: "agent-1", organizationId: "org-1", name: "Scout", ...context });
    const issued = createApiCredential({
      id: "cred-1",
      organizationId: "org-1",
      agentId: "agent-1",
      name: "runtime",
      capabilities: ["inference:invoke"],
      createdAt: context.occurredAt,
      expiresAt: "2026-08-13T17:00:00.000Z",
    }, () => Buffer.alloc(32, 7));

    const invalidRecords = [
      [{ ...issued.record, tokenPrefix: "not-a-fuse-key" }, "API_CREDENTIAL_PREFIX_INVALID"],
      [{ ...issued.record, createdAt: "not-a-date" }, "API_CREDENTIAL_CREATED_AT_INVALID"],
      [{ ...issued.record, expiresAt: context.occurredAt }, "API_CREDENTIAL_EXPIRY_INVALID"],
      [{ ...issued.record, revokedAt: context.occurredAt }, "API_CREDENTIAL_ALREADY_REVOKED"],
      [{ ...issued.record, capabilities: ["inference:invoke", "inference:invoke"] }, "API_CREDENTIAL_CAPABILITY_DUPLICATE"],
    ] as const;

    for (const [record, error] of invalidRecords) {
      await expect(identity.issueCredential(record, context)).rejects.toThrow(error);
    }
    expect((await pool.query("SELECT id FROM api_credentials")).rows).toEqual([]);
    await pool.end();
  });

  it("revokes a credential transactionally and records the revocation audit event", async () => {
    const { pool, audit, identity } = await createStores();
    await identity.createOrganization({ id: "org-1", name: "Acme Agents", ...context });
    await identity.registerAgent({
      id: "agent-1",
      organizationId: "org-1",
      name: "Scout",
      ...context,
      causationId: "request:agent-1",
    });
    const issued = createApiCredential({
      id: "cred-1",
      organizationId: "org-1",
      agentId: "agent-1",
      name: "Scout runtime",
      capabilities: ["inference:invoke"],
      createdAt: context.occurredAt,
      expiresAt: null,
    }, () => Buffer.alloc(32, 4));
    await identity.issueCredential(issued.record, context);

    await identity.revokeCredential("org-1", "cred-1", {
      actorId: "user:security",
      causationId: "request:revoke-1",
      occurredAt: "2026-07-14T01:00:00.000Z",
    });

    expect(await identity.authenticateToken(
      issued.token,
      "2026-07-14T02:00:00.000Z",
    )).toBeNull();
    expect((await audit.listAuditEvents("org-1", "api_credential", "cred-1")).map((event) => event.action))
      .toEqual(["credential.issued", "credential.revoked"]);
    await pool.end();
  });
});
