import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { PolicyStore } from "../src/persistence/policyStore.js";
import type { PolicyVersion } from "../src/domain/policy.js";

const context = {
  actorId: "service_account:admin-1",
  causationId: "request:setup",
  occurredAt: "2026-07-13T20:00:00.000Z",
};

const version = (overrides: Partial<PolicyVersion> = {}): PolicyVersion => ({
  id: "policy-1",
  organizationId: "org-1",
  version: 1,
  mode: "enforce",
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
  createdAt: context.occurredAt,
  ...overrides,
});

async function setup() {
  const db = newDb({ noAstCoverageCheck: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const identity = new IdentityStore(pool);
  await identity.createOrganization({ id: "org-1", name: "Acme", ...context });
  await identity.registerAgent({
    id: "agent-1", organizationId: "org-1", name: "Scout", ...context,
  });
  const policies = new PolicyStore(pool);
  return { pool, identity, policies };
}

describe("PolicyStore", () => {
  it("serializes concurrent policy schema initialization", async () => {
    const db = newDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    await new IdentityStore(pool).ensureSchema();
    await Promise.all([
      new PolicyStore(pool).ensureSchema(),
      new PolicyStore(pool).ensureSchema(),
    ]);
    expect((await pool.query("SELECT version FROM policy_schema_migrations ORDER BY version")).rows)
      .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    await pool.end();
  });

  it("fails closed on an unversioned reconciliation table", async () => {
    const db = newDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    await new IdentityStore(pool).ensureSchema();
    await new PolicyStore(pool).ensureSchema();
    await pool.query("DELETE FROM policy_schema_migrations WHERE version >= 2");
    expect((await pool.query(
      "SELECT version FROM policy_schema_migrations ORDER BY version",
    )).rows).toEqual([{ version: 1 }]);

    await expect(new PolicyStore(pool).ensureSchema())
      .rejects.toThrow("UNVERSIONED_RECONCILIATION_SCHEMA_UNSUPPORTED");
    // pg-mem does not roll back the migration marker; real PostgreSQL does.
    await pool.end();
  });

  it("publishes an immutable policy and creates an auditable active mandate assignment", async () => {
    const { pool, policies } = await setup();
    const candidate = version();
    const pendingPublish = policies.publishPolicy(candidate, context);
    candidate.allowedProviders[0] = "openai";
    candidate.limits.maxPerCallAtomic = 1n;
    await pendingPublish;
    await policies.createMandate({
      id: "mandate-1",
      organizationId: "org-1",
      name: "Inference allowance",
      assetId: "arc-testnet/usdc",
      maximumSpendAtomic: 250_000n,
      state: "draft",
      policyId: "policy-1",
      policyVersion: 1,
      expiresAt: "2026-08-13T20:00:00.000Z",
      ...context,
    });
    await policies.assignAgent({
      organizationId: "org-1",
      mandateId: "mandate-1",
      agentId: "agent-1",
      ...context,
    });

    expect(await policies.getPolicy("org-1", "policy-1", 1)).toEqual(version());
    expect((await pool.query("SELECT action FROM audit_events ORDER BY occurred_at, id")).rows
      .map((row) => row.action)).toContain("mandate.agent_assigned");
    await expect(policies.publishPolicy(version({ mode: "paused" }), context)).rejects.toThrow();
    expect((await policies.getPolicy("org-1", "policy-1", 1))?.mode).toBe("enforce");
    await pool.query(
      "UPDATE policy_versions SET required_capability = 'wallet:drain' WHERE policy_id = 'policy-1'",
    );
    await expect(policies.getPolicy("org-1", "policy-1", 1))
      .rejects.toThrow("POLICY_CAPABILITY_INVALID");
    await pool.end();
  });

  it("allows tenant-local policy and mandate identifiers without cross-tenant collisions", async () => {
    const { pool, identity, policies } = await setup();
    await identity.createOrganization({ id: "org-2", name: "Other tenant", ...context });
    await policies.publishPolicy(version(), context);
    await policies.publishPolicy(version({ organizationId: "org-2" }), context);

    for (const organizationId of ["org-1", "org-2"]) {
      await policies.createMandate({
        id: "shared-mandate-id", organizationId, name: "Tenant-local allowance",
        assetId: "usdc", maximumSpendAtomic: 1_000n, state: "draft",
        policyId: "policy-1", policyVersion: 1, expiresAt: null, ...context,
      });
    }

    expect((await pool.query(
      "SELECT organization_id, id FROM control_mandates WHERE id = 'shared-mandate-id' ORDER BY organization_id",
    )).rows).toEqual([
      { organization_id: "org-1", id: "shared-mandate-id" },
      { organization_id: "org-2", id: "shared-mandate-id" },
    ]);
    await pool.end();
  });

  it("lists and settles a held execution without redispatching it", async () => {
    const { pool, policies } = await setup();
    await policies.publishPolicy(version(), context);
    await policies.createMandate({
      id: "mandate-1", organizationId: "org-1", name: "Inference allowance",
      assetId: "usd-micros", maximumSpendAtomic: 250_000n, state: "draft",
      policyId: "policy-1", policyVersion: 1, expiresAt: null, ...context,
    });
    await policies.assignAgent({
      organizationId: "org-1", mandateId: "mandate-1", agentId: "agent-1", ...context,
    });
    await policies.transitionMandateState("org-1", "mandate-1", "active", context);
    await policies.admitInference({
      requestId: "held-request", requestFingerprint: "a".repeat(64), organizationId: "org-1",
      mandateId: "mandate-1", agentId: "agent-1",
      agentCapabilities: ["inference:invoke"], provider: "anthropic",
      model: "claude-sonnet-4-6", estimatedCostAtomic: 1_000n,
      inputTokens: 10, maxOutputTokens: 10, spentHourAtomic: 0n,
      spentDayAtomic: 0n, mandateSpentAtomic: 0n, mandateMaximumAtomic: 250_000n,
      requestCountLastMinute: 0, decidedAt: "2026-07-13T20:01:00.000Z",
    });
    await policies.holdInference({
      organizationId: "org-1", requestId: "held-request",
      reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS",
      response: { id: "provider-1", content: "held", usage: { inputTokens: 10, outputTokens: 2 } },
      heldAt: "2026-07-13T20:02:00.000Z",
    });

    expect(await policies.listReconciliationCases("org-1")).toEqual([
      expect.objectContaining({
        requestId: "held-request", mandateId: "mandate-1",
        reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS", reservedCostAtomic: 1_000n,
        hasProviderResponse: true,
      }),
    ]);
    await policies.resolveReconciliation({
      organizationId: "org-1", requestId: "held-request", resolution: "settle",
      actualCostAtomic: 125n, note: "Confirmed against provider usage ledger",
      externalReference: "provider-ledger:provider-1",
      actorId: "service_account:admin-1", causationId: "request:resolve",
      occurredAt: "2026-07-13T20:03:00.000Z",
    });

    expect(await policies.listReconciliationCases("org-1")).toEqual([]);
    expect((await pool.query(
      "SELECT status, actual_cost_atomic::text FROM inference_executions WHERE request_id = 'held-request'",
    )).rows[0]).toEqual({ status: "completed", actual_cost_atomic: "125" });
    expect((await pool.query(
      "SELECT state FROM control_mandates WHERE organization_id = 'org-1' AND id = 'mandate-1'",
    )).rows[0]).toEqual({ state: "paused" });
    expect((await pool.query(
      "SELECT resolution, external_reference FROM reconciliation_resolutions",
    )).rows).toEqual([{ resolution: "settle", external_reference: "provider-ledger:provider-1" }]);

    await policies.transitionMandateState("org-1", "mandate-1", "active", {
      ...context, causationId: "request:resume-after-review",
    });
    await policies.admitInference({
      requestId: "unbilled-request", requestFingerprint: "b".repeat(64), organizationId: "org-1",
      mandateId: "mandate-1", agentId: "agent-1", agentCapabilities: ["inference:invoke"],
      provider: "anthropic", model: "claude-sonnet-4-6", estimatedCostAtomic: 1_000n,
      inputTokens: 10, maxOutputTokens: 10, decidedAt: "2026-07-13T20:04:00.000Z",
    });
    await policies.holdInference({
      organizationId: "org-1", requestId: "unbilled-request",
      reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS", heldAt: "2026-07-13T20:05:00.000Z",
    });
    await policies.resolveReconciliation({
      organizationId: "org-1", requestId: "unbilled-request",
      resolution: "confirm_not_billed", note: "Provider ledger confirms no request",
      externalReference: "provider-ledger:none", actorId: "service_account:admin-1",
      causationId: "request:resolve-unbilled", occurredAt: "2026-07-13T20:06:00.000Z",
    });
    expect((await pool.query(
      `SELECT status, actual_cost_atomic::text, failure_code
       FROM inference_executions WHERE request_id = 'unbilled-request'`,
    )).rows[0]).toEqual({
      status: "failed", actual_cost_atomic: "0", failure_code: "RECONCILED_NOT_BILLED",
    });
    await policies.resolveReconciliation({
      organizationId: "org-1", requestId: "unbilled-request",
      resolution: "confirm_not_billed", note: "Provider ledger confirms no request",
      externalReference: "provider-ledger:none", actorId: "service_account:admin-1",
      causationId: "request:retry", occurredAt: "2026-07-13T20:07:00.000Z",
    });
    await expect(policies.resolveReconciliation({
      organizationId: "org-1", requestId: "unbilled-request",
      resolution: "confirm_not_billed", note: "Conflicting evidence",
      externalReference: "provider-ledger:none", actorId: "service_account:admin-1",
      causationId: "request:conflict", occurredAt: "2026-07-13T20:08:00.000Z",
    })).rejects.toThrow("RECONCILIATION_RESOLUTION_CONFLICT");

    await policies.transitionMandateState("org-1", "mandate-1", "active", {
      ...context, causationId: "request:resume-for-billed-no-response",
    });
    await policies.admitInference({
      requestId: "billed-no-response", requestFingerprint: "c".repeat(64), organizationId: "org-1",
      mandateId: "mandate-1", agentId: "agent-1", agentCapabilities: ["inference:invoke"],
      provider: "anthropic", model: "claude-sonnet-4-6", estimatedCostAtomic: 1_000n,
      inputTokens: 10, maxOutputTokens: 10, decidedAt: "2026-07-13T20:09:00.000Z",
    });
    await policies.admitInference({
      requestId: "second-billed-no-response", requestFingerprint: "d".repeat(64), organizationId: "org-1",
      mandateId: "mandate-1", agentId: "agent-1", agentCapabilities: ["inference:invoke"],
      provider: "anthropic", model: "claude-sonnet-4-6", estimatedCostAtomic: 1_000n,
      inputTokens: 10, maxOutputTokens: 10, decidedAt: "2026-07-13T20:09:01.000Z",
    });
    await policies.transitionMandateState("org-1", "mandate-1", "closing", {
      ...context, causationId: "request:close-while-executing",
    });
    await policies.holdInference({
      organizationId: "org-1", requestId: "billed-no-response",
      reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS", heldAt: "2026-07-13T20:10:00.000Z",
    });
    await policies.holdInference({
      organizationId: "org-1", requestId: "second-billed-no-response",
      reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS", heldAt: "2026-07-13T20:10:01.000Z",
    });
    await Promise.all([
      policies.resolveReconciliation({
        organizationId: "org-1", requestId: "billed-no-response", resolution: "settle",
        actualCostAtomic: 75n, note: "Provider ledger confirms a billed request without response",
        externalReference: "provider-ledger:billed-timeout", actorId: "service_account:admin-1",
        causationId: "request:resolve-billed-timeout", occurredAt: "2026-07-13T20:11:00.000Z",
      }),
      policies.resolveReconciliation({
        organizationId: "org-1", requestId: "second-billed-no-response", resolution: "settle",
        actualCostAtomic: 25n, note: "Second provider ledger entry confirms billing",
        externalReference: "provider-ledger:second-timeout", actorId: "service_account:admin-1",
        causationId: "request:resolve-second-timeout", occurredAt: "2026-07-13T20:11:01.000Z",
      }),
    ]);
    expect(await policies.listReconciliationCases("org-1")).toEqual([]);
    expect((await pool.query(
      `SELECT status, actual_cost_atomic::text, failure_code FROM inference_executions
       WHERE request_id = 'billed-no-response'`,
    )).rows[0]).toEqual({
      status: "failed", actual_cost_atomic: "75",
      failure_code: "RECONCILED_BILLED_NO_RESPONSE",
    });
    expect((await pool.query(
      "SELECT state FROM control_mandates WHERE organization_id = 'org-1' AND id = 'mandate-1'",
    )).rows[0]).toEqual({ state: "closing" });
    await pool.end();
  });

  it("fails closed instead of silently adopting an unversioned policy schema", async () => {
    const db = newDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool() as unknown as Pool;
    await pool.query("CREATE TABLE policy_versions (organization_id TEXT NOT NULL)");

    await expect(new PolicyStore(pool).ensureSchema())
      .rejects.toThrow("POLICY_SCHEMA_MIGRATION_REQUIRED");
    await pool.end();
  });

  it("requires mandates to start in draft before explicit activation", async () => {
    const { pool, policies } = await setup();
    await policies.publishPolicy(version(), context);
    await expect(policies.createMandate({
      id: "mandate-active", organizationId: "org-1", name: "Unsafe shortcut",
      assetId: "arc-testnet/usdc", maximumSpendAtomic: 1n, state: "active",
      policyId: "policy-1", policyVersion: 1, expiresAt: null, ...context,
    })).rejects.toThrow("CONTROL_MANDATE_INITIAL_STATE_INVALID");
    await pool.end();
  });

  it("applies audited mandate state transitions and rejects invalid shortcuts", async () => {
    const { pool, policies } = await setup();
    await policies.publishPolicy(version(), context);
    await policies.createMandate({
      id: "mandate-1", organizationId: "org-1", name: "Inference allowance",
      assetId: "arc-testnet/usdc", maximumSpendAtomic: 250_000n, state: "draft",
      policyId: "policy-1", policyVersion: 1, expiresAt: null, ...context,
    });
    await policies.transitionMandateState("org-1", "mandate-1", "active", {
      ...context, causationId: "request:activate",
    });
    await policies.publishPolicy(version({ version: 2, mode: "enforce" }), {
      ...context, causationId: "request:policy-v2",
    });
    await expect(policies.setMandatePolicy("org-1", "mandate-1", "policy-1", 2, {
      ...context, causationId: "request:unsafe-bind-v2",
    })).rejects.toThrow("CONTROL_MANDATE_POLICY_CHANGE_REQUIRES_PAUSE");
    await policies.transitionMandateState("org-1", "mandate-1", "paused", {
      ...context, causationId: "request:pause",
    });
    await policies.setMandatePolicy("org-1", "mandate-1", "policy-1", 2, {
      ...context, causationId: "request:bind-v2",
    });
    expect((await pool.query(
      "SELECT state, policy_version FROM control_mandates WHERE id = 'mandate-1'",
    )).rows[0]).toEqual({ state: "paused", policy_version: 2 });
    await expect(policies.transitionMandateState("org-1", "mandate-1", "closed", {
      ...context, causationId: "request:invalid-close",
    })).rejects.toThrow("CONTROL_MANDATE_TRANSITION_INVALID:paused->closed");
    expect((await pool.query("SELECT state FROM control_mandates WHERE id = 'mandate-1'")).rows[0])
      .toEqual({ state: "paused" });
    await pool.end();
  });

  it("evaluates persisted policy state, derives assignment, and records one decision per request", async () => {
    const { pool, policies } = await setup();
    await policies.publishPolicy(version(), context);
    await policies.createMandate({
      id: "mandate-1", organizationId: "org-1", name: "Inference allowance",
      assetId: "arc-testnet/usdc", maximumSpendAtomic: 250_000n, state: "draft",
      policyId: "policy-1", policyVersion: 1, expiresAt: "2026-08-13T20:00:00.000Z",
      ...context,
    });
    await policies.transitionMandateState("org-1", "mandate-1", "active", {
      ...context, causationId: "request:activate",
    });
    await policies.assignAgent({
      organizationId: "org-1", mandateId: "mandate-1", agentId: "agent-1", ...context,
    });

    const decisionInput = {
      id: "decision-1",
      requestId: "inference:req-1",
      organizationId: "org-1",
      mandateId: "mandate-1",
      agentId: "agent-1",
      agentCapabilities: ["inference:invoke"] as Array<"inference:invoke">,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      estimatedCostAtomic: 5_000n,
      inputTokens: 1_000,
      maxOutputTokens: 500,
      spentHourAtomic: 0n,
      spentDayAtomic: 0n,
      mandateSpentAtomic: 0n,
      mandateMaximumAtomic: 250_000n,
      requestCountLastMinute: 0,
      decidedAt: "2026-07-13T20:01:00.000Z",
    };
    const pendingDecision = policies.evaluateAndRecord(decisionInput);
    decisionInput.provider = "openai";
    decisionInput.agentCapabilities.length = 0;
    const decision = await pendingDecision;
    expect(decision.result.outcome).toBe("ALLOW");
    expect(decision.policyVersion).toBe(1);
    await expect(policies.evaluateAndRecord({
      ...decision.input,
      id: "decision-2",
    })).rejects.toThrow();
    expect((await policies.listDecisions("org-1", "mandate-1")).map((item) => item.id))
      .toEqual(["decision-1"]);
    await pool.end();
  });

  it("fails closed when the agent is not assigned to the tenant mandate", async () => {
    const { pool, policies } = await setup();
    await policies.publishPolicy(version(), context);
    await policies.createMandate({
      id: "mandate-1", organizationId: "org-1", name: "Inference allowance",
      assetId: "arc-testnet/usdc", maximumSpendAtomic: 250_000n, state: "draft",
      policyId: "policy-1", policyVersion: 1, expiresAt: null, ...context,
    });
    await policies.transitionMandateState("org-1", "mandate-1", "active", {
      ...context, causationId: "request:activate",
    });
    const decision = await policies.evaluateAndRecord({
      id: "decision-1", requestId: "inference:req-1", organizationId: "org-1",
      mandateId: "mandate-1", agentId: "agent-1", agentCapabilities: ["inference:invoke"],
      provider: "anthropic", model: "claude-sonnet-4-6", estimatedCostAtomic: 1n,
      inputTokens: 1, maxOutputTokens: 1, spentHourAtomic: 0n, spentDayAtomic: 0n,
      mandateSpentAtomic: 0n, mandateMaximumAtomic: 250_000n,
      requestCountLastMinute: 0, decidedAt: "2026-07-13T20:01:00.000Z",
    });
    expect(decision.result).toMatchObject({
      outcome: "DENY",
      reasonCodes: ["AGENT_NOT_AUTHORIZED"],
    });
    await pool.end();
  });
});
