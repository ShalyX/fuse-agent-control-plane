import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { PolicyAdministration } from "../src/policy/policyAdministration.js";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { PolicyStore } from "../src/persistence/policyStore.js";

const now = "2026-07-13T21:00:00.000Z";
const principal = {
  principalType: "service_account" as const,
  role: "admin" as const,
  principalId: "admin-1",
  organizationId: "org-1",
  credentialId: "admin-cred-1",
  capabilities: ["policies:read", "policies:write", "mandates:admin"] as const,
};

async function setup() {
  const db = newDb({ noAstCoverageCheck: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const identity = new IdentityStore(pool);
  await identity.createOrganization({
    id: "org-1", name: "Acme", actorId: "bootstrap", causationId: "setup", occurredAt: now,
  });
  await identity.registerAgent({
    id: "agent-1", organizationId: "org-1", name: "Scout",
    actorId: "bootstrap", causationId: "setup-agent", occurredAt: now,
  });
  const store = new PolicyStore(pool);
  return { pool, store, administration: new PolicyAdministration(store, () => now) };
}

describe("PolicyAdministration", () => {
  it("derives tenant and audit actor while publishing policy, mandate, and assignment", async () => {
    const { pool, store, administration } = await setup();
    await administration.publishPolicy(principal, {
      policyId: "policy-1",
      version: 1,
      mode: "dry_run",
      allowedProviders: ["anthropic"],
      allowedModels: ["claude-sonnet-4-6"],
      requiredCapability: "inference:invoke",
      limits: {
        maxPerCallAtomic: 10_000n,
        maxHourlyAtomic: 50_000n,
        maxDailyAtomic: 250_000n,
        maxRequestsPerMinute: 10,
        maxInputTokens: 20_000,
        maxOutputTokens: 4_000,
      },
      requestId: "request:policy-1",
    });
    await administration.createMandate(principal, {
      mandateId: "mandate-1",
      name: "Inference allowance",
      assetId: "arc-testnet/usdc",
      maximumSpendAtomic: 250_000n,
      policyId: "policy-1",
      policyVersion: 1,
      expiresAt: "2026-08-13T21:00:00.000Z",
      requestId: "request:mandate-1",
    });
    await administration.transitionMandate(principal, {
      mandateId: "mandate-1",
      to: "active",
      requestId: "request:activate-1",
    });
    await administration.assignAgent(principal, {
      mandateId: "mandate-1",
      agentId: "agent-1",
      requestId: "request:assignment-1",
    });
    await administration.transitionMandate(principal, {
      mandateId: "mandate-1",
      to: "paused",
      requestId: "request:pause-1",
    });
    await administration.publishPolicy(principal, {
      policyId: "policy-1",
      version: 2,
      mode: "enforce",
      allowedProviders: ["anthropic"],
      allowedModels: ["claude-sonnet-4-6"],
      requiredCapability: "inference:invoke",
      limits: {
        maxPerCallAtomic: 10_000n, maxHourlyAtomic: 50_000n, maxDailyAtomic: 250_000n,
        maxRequestsPerMinute: 10, maxInputTokens: 20_000, maxOutputTokens: 4_000,
      },
      requestId: "request:policy-2",
    });
    await administration.setMandatePolicy(principal, {
      mandateId: "mandate-1",
      policyId: "policy-1",
      policyVersion: 2,
      requestId: "request:bind-2",
    });

    expect((await store.getPolicy("org-1", "policy-1", 1))?.mode).toBe("dry_run");
    const viewer = { ...principal, role: "viewer" as const, capabilities: ["policies:read"] as const };
    expect((await administration.getPolicy(viewer, "policy-1", 1))?.organizationId).toBe("org-1");
    expect(await administration.listDecisions(viewer, "mandate-1")).toEqual([]);
    const audit = await pool.query(
      "SELECT organization_id, actor_id, action FROM audit_events WHERE action = 'mandate.agent_assigned'",
    );
    expect(audit.rows).toEqual([{
      organization_id: "org-1",
      actor_id: "service_account:admin-1",
      action: "mandate.agent_assigned",
    }]);
    await pool.end();
  });

  it("requires both admin role and the exact policy capability", async () => {
    const { pool, administration } = await setup();
    const input = {
      policyId: "policy-1", version: 1, mode: "enforce" as const,
      allowedProviders: ["anthropic"], allowedModels: ["claude-sonnet-4-6"],
      requiredCapability: "inference:invoke" as const,
      limits: {
        maxPerCallAtomic: 1n, maxHourlyAtomic: 1n, maxDailyAtomic: 1n,
        maxRequestsPerMinute: 1, maxInputTokens: 1, maxOutputTokens: 1,
      },
      requestId: "request:policy-1",
    };
    await expect(administration.publishPolicy({ ...principal, role: "viewer" }, input))
      .rejects.toThrow("SERVICE_ACCOUNT_ADMIN_REQUIRED");
    await expect(administration.publishPolicy({
      ...principal,
      capabilities: ["policies:read"],
    }, input)).rejects.toThrow("POLICY_CAPABILITY_REQUIRED");
    await pool.end();
  });
});
