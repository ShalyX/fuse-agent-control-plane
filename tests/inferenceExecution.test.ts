import { newDb } from "pg-mem";
import { expect, it } from "vitest";
import type { Pool } from "pg";
import type { InferenceProvider } from "../src/core/service.js";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { PolicyStore } from "../src/persistence/policyStore.js";
import {
  InferenceExecutionService,
  type InferenceExecutionStore,
} from "../src/inference/inferenceExecution.js";

class CountingProvider implements InferenceProvider {
  calls = 0;

  constructor(private readonly providerCostUsd: string | undefined = "0.0005") {}

  async complete() {
    this.calls += 1;
    const result = {
      id: "gen-1",
      content: "allowed response",
      usage: { inputTokens: 100, outputTokens: 20 },
      ...(this.providerCostUsd === undefined ? {} : { providerCostUsd: this.providerCostUsd }),
    };
    return result;
  }
}

async function setup(options: {
  maximumSpendAtomic?: bigint;
  assignAgent?: boolean;
  maxRequestsPerMinute?: number;
  mode?: "dry_run" | "enforce";
  maxInputTokens?: number;
} = {}) {
  const db = newDb({ noAstCoverageCheck: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;
  const now = "2026-07-13T23:00:00.000Z";
  const context = {
    actorId: "service_account:admin-1",
    causationId: "setup",
    occurredAt: now,
  };
  const identity = new IdentityStore(pool);
  await identity.createOrganization({ id: "org-shaly", name: "Shaly", ...context });
  await identity.registerAgent({
    id: "mans-primary",
    organizationId: "org-shaly",
    name: "Mans Primary",
    ...context,
  });
  const policies = new PolicyStore(pool);
  await policies.publishPolicy({
    id: "shaly-inference",
    organizationId: "org-shaly",
    version: 1,
    mode: options.mode ?? "enforce",
    allowedProviders: ["openrouter"],
    allowedModels: ["anthropic/claude-sonnet-4.6"],
    requiredCapability: "inference:invoke",
    limits: {
      maxPerCallAtomic: 10_000n,
      maxHourlyAtomic: 50_000n,
      maxDailyAtomic: 250_000n,
      maxRequestsPerMinute: options.maxRequestsPerMinute ?? 10,
      maxInputTokens: options.maxInputTokens ?? 20_000,
      maxOutputTokens: 4_000,
    },
    createdAt: now,
  }, context);
  await policies.createMandate({
    id: "shaly-main",
    organizationId: "org-shaly",
    name: "Shaly inference",
    assetId: "usd-micros",
    maximumSpendAtomic: options.maximumSpendAtomic ?? 250_000n,
    state: "draft",
    policyId: "shaly-inference",
    policyVersion: 1,
    expiresAt: null,
    ...context,
  });
  if (options.assignAgent !== false) {
    await policies.assignAgent({
      organizationId: "org-shaly",
      mandateId: "shaly-main",
      agentId: "mans-primary",
      ...context,
    });
  }
  await policies.transitionMandateState("org-shaly", "shaly-main", "active", context);
  return { pool, policies };
}

it("resolves provider execution settings from the authenticated organization", async () => {
  const calls: string[] = [];
  const provider = new CountingProvider(undefined);
  const store: InferenceExecutionStore = {
    async admitInference(input) {
      calls.push(`${input.organizationId}:${input.provider}:${input.model}:${input.estimatedCostAtomic}`);
      return {
        status: "execute",
        decision: {
          id: "decision-1", requestId: input.requestId, organizationId: input.organizationId,
          mandateId: input.mandateId, agentId: input.agentId, policyId: "policy-1", policyVersion: 1,
          result: { outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] },
          input: {
            id: "decision-1", requestId: input.requestId, organizationId: input.organizationId,
            mandateId: input.mandateId, agentId: input.agentId, agentCapabilities: input.agentCapabilities,
            provider: input.provider, model: input.model, estimatedCostAtomic: input.estimatedCostAtomic,
            inputTokens: input.inputTokens, maxOutputTokens: input.maxOutputTokens,
            spentHourAtomic: 0n, spentDayAtomic: 0n, mandateSpentAtomic: 0n,
            mandateMaximumAtomic: 10_000n, requestCountLastMinute: 0, decidedAt: input.decidedAt,
          },
        },
        reservedCostAtomic: input.estimatedCostAtomic,
      };
    },
    async completeInference(input) {
      return {
        status: "completed", reservedCostAtomic: 1800n,
        actualCostAtomic: input.actualCostAtomic, response: input.response,
      };
    },
    async holdInference() { throw new Error("unexpected hold"); },
  };
  const service = new InferenceExecutionService({
    store,
    resolveProvider: async (organizationId) => {
      expect(organizationId).toBe("org-customer-zero");
      return {
        provider,
        providerName: "anthropic",
        model: "claude-sonnet-4-6",
        price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
      };
    },
    now: () => "2026-07-19T16:00:00.000Z",
  });

  const result = await service.execute({
    requestId: "req-tenant-provider", organizationId: "org-customer-zero",
    mandateId: "mandate-1", agentId: "agent-1", agentCapabilities: ["inference:invoke"],
    inputTokens: 100, maxOutputTokens: 100, messages: [{ role: "user", content: "Hello" }],
  });

  expect(result.status).toBe("completed");
  expect(calls).toEqual(["org-customer-zero:anthropic:claude-sonnet-4-6:1800"]);
  expect(provider.calls).toBe(1);
});

it("fails before admission or reservation when the tenant has no provider configuration", async () => {
  let admissions = 0;
  const store: InferenceExecutionStore = {
    async admitInference() { admissions += 1; throw new Error("unexpected admission"); },
    async completeInference() { throw new Error("unexpected completion"); },
    async holdInference() { throw new Error("unexpected hold"); },
  };
  const service = new InferenceExecutionService({
    store,
    resolveProvider: async () => { throw new Error("PROVIDER_CONFIGURATION_NOT_FOUND"); },
  });
  await expect(service.execute({
    requestId: "req-missing-config", organizationId: "org-without-provider",
    mandateId: "mandate-1", agentId: "agent-1", agentCapabilities: ["inference:invoke"],
    inputTokens: 10, maxOutputTokens: 10, messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("PROVIDER_CONFIGURATION_NOT_FOUND");
  expect(admissions).toBe(0);
});

it("rejects a requested model that differs from the tenant provider before admission", async () => {
  const provider = new CountingProvider();
  let admissions = 0;
  const store: InferenceExecutionStore = {
    async admitInference() { admissions += 1; throw new Error("unexpected admission"); },
    async completeInference() { throw new Error("unexpected completion"); },
    async holdInference() { throw new Error("unexpected hold"); },
  };
  const service = new InferenceExecutionService({
    store,
    provider,
    providerName: "openrouter",
    model: "approved/model",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
  });

  await expect(service.execute({
    requestId: "req-model-mismatch", organizationId: "org-shaly", mandateId: "shaly-main",
    agentId: "mans-primary", agentCapabilities: ["inference:invoke"],
    requestedModel: "different/model", inputTokens: 10, maxOutputTokens: 10,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("REQUESTED_MODEL_MISMATCH");
  expect(admissions).toBe(0);
  expect(provider.calls).toBe(0);
});

it("reserves before invoking an allowed provider and reconciles provider-reported cost", async () => {
  const { pool, policies } = await setup();
  const provider = new CountingProvider();
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
    now: () => "2026-07-13T23:01:00.000Z",
  });

  const result = await service.execute({
    requestId: "req-allowed",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  });

  expect(result).toMatchObject({
    status: "completed",
    actualCostAtomic: 500n,
    response: { id: "gen-1", content: "allowed response" },
  });
  expect(provider.calls).toBe(1);
  expect((await pool.query(
    "SELECT status, reserved_cost_atomic, actual_cost_atomic FROM inference_executions WHERE request_id = 'req-allowed'",
  )).rows[0]).toEqual({
    status: "completed",
    reserved_cost_atomic: 1800,
    actual_cost_atomic: 500,
  });
  await pool.end();
});

it("replays a completed request after provider credential rotation without another provider call", async () => {
  const { pool, policies } = await setup();
  const firstProvider = new CountingProvider();
  const rotatedProvider = new CountingProvider();
  let credentialVersion = 1;
  const service = new InferenceExecutionService({
    store: policies,
    resolveProvider: async () => ({
      provider: credentialVersion === 1 ? firstProvider : rotatedProvider,
      providerName: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
      requireProviderCost: true,
    }),
    now: () => "2026-07-13T23:01:00.000Z",
  });
  const input = {
    requestId: "req-rotation-replay", organizationId: "org-shaly", mandateId: "shaly-main",
    agentId: "mans-primary", agentCapabilities: ["inference:invoke" as const],
    inputTokens: 100, maxOutputTokens: 100,
    messages: [{ role: "user" as const, content: "Hello" }],
  };

  const first = await service.execute(input);
  credentialVersion = 2;
  const replay = await service.execute(input);

  expect(first.status).toBe("completed");
  expect(replay).toEqual(first);
  expect(firstProvider.calls).toBe(1);
  expect(rotatedProvider.calls).toBe(0);
  await pool.end();
});

it("executes and reserves dry-run policy violations while recording the would-be denial", async () => {
  const { pool, policies } = await setup({ mode: "dry_run", maxInputTokens: 10 });
  const provider = new CountingProvider();
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
    now: () => "2026-07-13T23:01:00.000Z",
  });

  const result = await service.execute({
    requestId: "req-dry-run-observation",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  });

  expect(result).toMatchObject({
    status: "completed",
    decision: {
      result: {
        outcome: "ALLOW",
        wouldOutcome: "DENY",
        enforced: false,
        reasonCodes: ["INPUT_TOKEN_LIMIT_EXCEEDED"],
      },
    },
    actualCostAtomic: 500n,
  });
  expect(provider.calls).toBe(1);
  expect((await pool.query(
    `SELECT status, reserved_cost_atomic::text, actual_cost_atomic::text
     FROM inference_executions WHERE request_id = 'req-dry-run-observation'`,
  )).rows[0]).toEqual({
    status: "completed",
    reserved_cost_atomic: "1800",
    actual_cost_atomic: "500",
  });
  await pool.end();
});

it("holds reconciliation and pauses the mandate when actual cost exceeds the reservation", async () => {
  const { pool, policies } = await setup();
  const provider = new CountingProvider("0.01");
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
    now: () => "2026-07-13T23:01:00.000Z",
  });

  await expect(service.execute({
    requestId: "req-overrun",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("ACTUAL_COST_EXCEEDS_RESERVATION");

  expect(provider.calls).toBe(1);
  expect((await pool.query(
    "SELECT status, actual_cost_atomic FROM inference_executions WHERE request_id = 'req-overrun'",
  )).rows[0]).toEqual({ status: "reconciliation_hold", actual_cost_atomic: 10000 });
  expect((await pool.query(
    "SELECT state FROM control_mandates WHERE id = 'shaly-main'",
  )).rows[0]).toEqual({ state: "reconciliation_hold" });
  await pool.end();
});

it("does not resurrect a terminal mandate when late provider evidence enters hold", async () => {
  const { pool, policies } = await setup();
  const admission = await policies.admitInference({
    requestId: "req-late-overrun",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    estimatedCostAtomic: 1_800n,
    inputTokens: 100,
    maxOutputTokens: 100,
    requestFingerprint: "a".repeat(64),
    decidedAt: "2026-07-13T23:01:00.000Z",
  });
  expect(admission.status).toBe("execute");
  await policies.transitionMandateState("org-shaly", "shaly-main", "closing", {
    actorId: "service_account:admin-1", causationId: "close", occurredAt: "2026-07-13T23:02:00.000Z",
  });
  await policies.transitionMandateState("org-shaly", "shaly-main", "closed", {
    actorId: "service_account:admin-1", causationId: "closed", occurredAt: "2026-07-13T23:03:00.000Z",
  });

  const completion = await policies.completeInference({
    requestId: "req-late-overrun",
    organizationId: "org-shaly",
    actualCostAtomic: 10_000n,
    response: {
      id: "gen-late", content: "late", usage: { inputTokens: 100, outputTokens: 20 },
      providerCostUsd: "0.01",
    },
    completedAt: "2026-07-13T23:04:00.000Z",
  });

  expect(completion.status).toBe("reconciliation_hold");
  expect((await pool.query(
    "SELECT state FROM control_mandates WHERE organization_id = 'org-shaly' AND id = 'shaly-main'",
  )).rows[0]).toEqual({ state: "closed" });
  await policies.resolveReconciliation({
    organizationId: "org-shaly", requestId: "req-late-overrun", resolution: "settle",
    actualCostAtomic: 10_000n, note: "Late provider response verified",
    externalReference: "provider-ledger:gen-late", actorId: "service_account:admin-1",
    causationId: "resolve-late", occurredAt: "2026-07-13T23:05:00.000Z",
  });
  expect((await pool.query(
    "SELECT state FROM control_mandates WHERE organization_id = 'org-shaly' AND id = 'shaly-main'",
  )).rows[0]).toEqual({ state: "closed" });
  await pool.end();
});

it("holds ambiguous provider exceptions instead of releasing their reservations", async () => {
  const { pool, policies } = await setup();
  const provider = {
    calls: 0,
    async complete() {
      this.calls += 1;
      throw new Error("OPENROUTER_504: upstream request failed");
    },
  };
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.30", outputUsdPerMillion: "16.50" },
    now: () => "2026-07-13T23:01:00.000Z",
  });

  await expect(service.execute({
    requestId: "req-provider-ambiguous",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("OPENROUTER_504");

  expect(provider.calls).toBe(1);
  expect((await pool.query(
    "SELECT status, failure_code FROM inference_executions WHERE request_id = 'req-provider-ambiguous'",
  )).rows[0]).toEqual({
    status: "reconciliation_hold",
    failure_code: "PROVIDER_OUTCOME_AMBIGUOUS",
  });
  expect((await pool.query(
    "SELECT state FROM control_mandates WHERE id = 'shaly-main'",
  )).rows[0]).toEqual({ state: "reconciliation_hold" });
  await pool.end();
});

it("does not release a request as failed after reconciliation has entered hold", async () => {
  let failCalls = 0;
  const store = {
    admitInference: async () => ({
      status: "execute",
      reservedCostAtomic: 1_800n,
      decision: { id: "decision-1", result: { outcome: "ALLOW" } },
    }),
    completeInference: async () => ({
      status: "reconciliation_hold",
      reservedCostAtomic: 1_800n,
      actualCostAtomic: 10_000n,
      response: {
        id: "gen-1",
        content: "response",
        usage: { inputTokens: 100, outputTokens: 20 },
        providerCostUsd: "0.01",
      },
    }),
    failInference: async () => { failCalls += 1; },
  } as unknown as InferenceExecutionStore;
  const service = new InferenceExecutionService({
    provider: new CountingProvider("0.01"),
    store,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
  });

  await expect(service.execute({
    requestId: "req-hold",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("ACTUAL_COST_EXCEEDS_RESERVATION");
  expect(failCalls).toBe(0);
});

it("attempts immediate hold when completion persistence fails", async () => {
  const holdCalls: Array<{ reasonCode: string; response?: { id: string } }> = [];
  const store = {
    admitInference: async () => ({
      status: "execute",
      reservedCostAtomic: 1_800n,
      decision: { id: "decision-ambiguous", result: { outcome: "ALLOW" } },
    }),
    completeInference: async () => {
      throw new Error("DATABASE_COMPLETION_UNAVAILABLE");
    },
    holdInference: async (input: { reasonCode: string; response?: { id: string } }) => {
      holdCalls.push(input);
    },
  } as unknown as InferenceExecutionStore;
  const provider = new CountingProvider("0.0005");
  const service = new InferenceExecutionService({
    provider,
    store,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.30", outputUsdPerMillion: "16.50" },
  });

  await expect(service.execute({
    requestId: "req-ambiguous",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("DATABASE_COMPLETION_UNAVAILABLE");
  expect(provider.calls).toBe(1);
  expect(holdCalls).toEqual([expect.objectContaining({
    reasonCode: "POST_PROVIDER_RECONCILIATION_FAILED",
    response: expect.objectContaining({ id: "gen-1" }),
  })]);
});

it("records a policy denial without provider invocation or monetary reservation", async () => {
  const { pool, policies } = await setup({ assignAgent: false });
  const provider = new CountingProvider();
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
    now: () => "2026-07-13T23:01:00.000Z",
  });

  const result = await service.execute({
    requestId: "req-denied-real",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  });

  expect(result).toMatchObject({
    status: "denied",
    decision: { result: { reasonCodes: ["AGENT_NOT_AUTHORIZED"] } },
  });
  expect(provider.calls).toBe(0);
  expect((await pool.query(
    "SELECT status, reserved_cost_atomic, actual_cost_atomic FROM inference_executions WHERE request_id = 'req-denied-real'",
  )).rows[0]).toEqual({ status: "denied", reserved_cost_atomic: 0, actual_cost_atomic: null });
  await pool.end();
});

it("does not let denied attempts consume an authorized mandate rate quota", async () => {
  const { pool, policies } = await setup({ maxRequestsPerMinute: 1 });
  const provider = new CountingProvider();
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.30", outputUsdPerMillion: "16.50" },
    now: () => "2026-07-13T23:01:00.000Z",
  });
  const base = {
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  };

  const denied = await service.execute({
    ...base,
    requestId: "req-denied-quota",
    agentCapabilities: [],
  });
  const allowed = await service.execute({
    ...base,
    requestId: "req-allowed-after-denial",
    agentCapabilities: ["inference:invoke"],
  });

  expect(denied).toMatchObject({ status: "denied" });
  expect(allowed).toMatchObject({ status: "completed" });
  expect(provider.calls).toBe(1);
  await pool.end();
});

it("moves an expired execution lease into review without redispatch", async () => {
  const { pool, policies } = await setup();
  const input = {
    requestId: "req-expired-lease",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"] as Array<"inference:invoke">,
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    estimatedCostAtomic: 1_800n,
    inputTokens: 100,
    maxOutputTokens: 100,
    requestFingerprint: "b".repeat(64),
  };

  expect(await policies.admitInference({
    ...input, decidedAt: "2026-07-13T23:01:00.000Z",
  })).toMatchObject({ status: "execute" });
  expect(await policies.admitInference({
    ...input, decidedAt: "2026-07-13T23:07:00.000Z",
  })).toEqual({ status: "failed" });

  expect((await pool.query(
    "SELECT status, failure_code FROM inference_executions WHERE request_id = 'req-expired-lease'",
  )).rows[0]).toEqual({
    status: "reconciliation_hold",
    failure_code: "EXECUTION_LEASE_EXPIRED",
  });
  expect((await pool.query(
    "SELECT state FROM control_mandates WHERE id = 'shaly-main'",
  )).rows[0]).toEqual({ state: "reconciliation_hold" });
  await pool.end();
});

it("replays a completed request without a second provider invocation", async () => {
  const { pool, policies } = await setup();
  const provider = new CountingProvider();
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
    now: () => "2026-07-13T23:01:00.000Z",
  });
  const input = {
    requestId: "req-replay",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"] as const,
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  };

  const first = await service.execute({ ...input, agentCapabilities: [...input.agentCapabilities] });
  const second = await service.execute({ ...input, agentCapabilities: [...input.agentCapabilities] });
  expect(first).toMatchObject({ status: "completed", actualCostAtomic: 500n });
  expect(second).toMatchObject({ status: "completed", actualCostAtomic: 500n });
  expect(provider.calls).toBe(1);
  await pool.end();
});

it("rejects reuse of an idempotency key for a different controlled request", async () => {
  const { pool, policies } = await setup();
  const provider = new CountingProvider();
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
    now: () => "2026-07-13T23:01:00.000Z",
  });
  const base = {
    requestId: "req-conflict",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"] as Array<"inference:invoke">,
    inputTokens: 100,
    maxOutputTokens: 100,
  };

  await service.execute({ ...base, messages: [{ role: "user", content: "first" }] });
  await expect(service.execute({
    ...base,
    messages: [{ role: "user", content: "different" }],
  })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(provider.calls).toBe(1);
  await pool.end();
});

it("derives mandate spend from persisted executions and denies oversubscription", async () => {
  const { pool, policies } = await setup({ maximumSpendAtomic: 2_000n });
  const provider = new CountingProvider();
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
    now: () => "2026-07-13T23:01:00.000Z",
  });
  const base = {
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"] as Array<"inference:invoke">,
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  };

  expect((await service.execute({ ...base, requestId: "req-first" })).status).toBe("completed");
  const denied = await service.execute({ ...base, requestId: "req-over-budget" });
  expect(denied).toMatchObject({
    status: "denied",
    decision: { result: { reasonCodes: ["MANDATE_BUDGET_EXCEEDED"] } },
  });
  expect(provider.calls).toBe(1);
  await pool.end();
});

it("holds reconciliation when OpenRouter succeeds without provider-reported cost", async () => {
  const { pool, policies } = await setup();
  const provider = {
    calls: 0,
    async complete() {
      this.calls += 1;
      return {
        id: "gen-1",
        content: "allowed response",
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.30", outputUsdPerMillion: "16.50" },
    requireProviderCost: true,
    now: () => "2026-07-13T23:01:00.000Z",
  });

  await expect(service.execute({
    requestId: "req-missing-cost",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("PROVIDER_COST_MISSING");

  expect(provider.calls).toBe(1);
  expect((await pool.query(
    "SELECT status, actual_cost_atomic, response_json FROM inference_executions WHERE request_id = 'req-missing-cost'",
  )).rows[0]).toMatchObject({
    status: "reconciliation_hold",
    actual_cost_atomic: null,
    response_json: { id: "gen-1" },
  });
  expect((await pool.query(
    "SELECT state FROM control_mandates WHERE id = 'shaly-main'",
  )).rows[0]).toEqual({ state: "reconciliation_hold" });
  await pool.end();
});

it("immediately holds a successful response whose cost cannot be reconciled", async () => {
  const { pool, policies } = await setup();
  const provider = {
    async complete() {
      return {
        id: "gen-unreconcilable",
        content: "response",
        usage: { inputTokens: 100, outputTokens: 20 },
        providerCostUsd: "1e101",
        providerModel: "anthropic/claude-sonnet-4.6",
      };
    },
  };
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.30", outputUsdPerMillion: "16.50" },
    requireProviderCost: true,
    requireProviderModelMatch: true,
    now: () => "2026-07-13T23:01:00.000Z",
  });

  await expect(service.execute({
    requestId: "req-unreconcilable-cost",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("INVALID_PROVIDER_COST");

  expect((await pool.query(
    "SELECT status, failure_code, response_json FROM inference_executions WHERE request_id = 'req-unreconcilable-cost'",
  )).rows[0]).toMatchObject({
    status: "reconciliation_hold",
    failure_code: "POST_PROVIDER_RECONCILIATION_FAILED",
    response_json: { id: "gen-unreconcilable" },
  });
  expect((await pool.query(
    "SELECT state FROM control_mandates WHERE id = 'shaly-main'",
  )).rows[0]).toEqual({ state: "reconciliation_hold" });
  await pool.end();
});

it("holds reconciliation when OpenRouter reports a different model", async () => {
  const { pool, policies } = await setup();
  const provider = {
    calls: 0,
    async complete() {
      this.calls += 1;
      return {
        id: "gen-model-mismatch",
        content: "provider output",
        usage: { inputTokens: 100, outputTokens: 20 },
        providerCostUsd: "0.0005",
        providerModel: "anthropic/claude-opus-4.6",
      };
    },
  };
  const service = new InferenceExecutionService({
    provider,
    store: policies,
    providerName: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    price: { inputUsdPerMillion: "3.30", outputUsdPerMillion: "16.50" },
    requireProviderCost: true,
    requireProviderModelMatch: true,
    now: () => "2026-07-13T23:02:00.000Z",
  });

  await expect(service.execute({
    requestId: "req-model-mismatch",
    organizationId: "org-shaly",
    mandateId: "shaly-main",
    agentId: "mans-primary",
    agentCapabilities: ["inference:invoke"],
    inputTokens: 100,
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("PROVIDER_MODEL_MISMATCH");

  expect(provider.calls).toBe(1);
  expect((await pool.query(
    "SELECT status, failure_code, response_json FROM inference_executions WHERE request_id = 'req-model-mismatch'",
  )).rows[0]).toMatchObject({
    status: "reconciliation_hold",
    failure_code: "PROVIDER_MODEL_MISMATCH",
    response_json: { id: "gen-model-mismatch", providerModel: "anthropic/claude-opus-4.6" },
  });
  await pool.end();
});
