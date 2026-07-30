import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createFuseApp } from "../src/http/app.js";
import type { CredentialAuthenticator } from "../src/http/auth.js";
import type { ControlledInferenceInput } from "../src/inference/inferenceExecution.js";
import {
  buildRequestCommitment,
  buildResponseCommitment,
  type StableSuccessfulResponseProjection,
} from "../src/reliability/commitments.js";
import { currentTrustedReplayOperation } from "../src/reliability/replayOperationContext.js";
import {
  installReplayAuditTriggers,
  verifyReplayAuditTriggerCatalog,
  RELIABILITY_SCHEMA_SQL,
} from "../src/reliability/reliabilitySchema.js";
import {
  acquireOrdinaryMutationExclusion,
  acquireReplayExclusion,
} from "../src/reliability/protocolMutationExclusion.js";
import { ReliabilityProtocolStore } from "../src/reliability/protocolStore.js";
import * as protocolStoreModule from "../src/reliability/protocolStore.js";
import { PolicyStore } from "../src/persistence/policyStore.js";
import { OpenRouterTransportError } from "../src/providers/openRouter.js";

const authenticator: CredentialAuthenticator = {
  authenticateToken: async () => ({
    principalType: "agent", principalId: "agent-1", organizationId: "org-1",
    credentialId: "credential-1", capabilities: ["inference:invoke"],
  }),
};

const body = {
  model: "nousresearch/hermes-4-405b",
  max_tokens: 8,
  workload_class: "reliability.normal",
  messages: [{ role: "user" as const, content: "hello" }],
};

function completed(input: ControlledInferenceInput) {
  return {
    status: "completed" as const,
    decision: {
      id: "decision-1", requestId: input.requestId, organizationId: input.organizationId,
      mandateId: input.mandateId, agentId: input.agentId, policyId: "policy-1", policyVersion: 1,
      result: { outcome: "ALLOW" as const, wouldOutcome: "ALLOW" as const, enforced: true, reasonCodes: [] },
      input: { model: body.model, branchId: input.branchId, workloadClass: input.workloadClass },
    },
    reservedCostAtomic: 12n, actualCostAtomic: 10n,
    response: { id: "generation-1", content: "ok", usage: { inputTokens: 2, outputTokens: 1 } },
  };
}

function replayRequest(app: ReturnType<typeof createFuseApp>, operationId = "replay-1234567890abcdef") {
  return request(app).post("/v1/chat/completions")
    .set("Authorization", "Bearer authenticated-agent")
    .set("Idempotency-Key", "request-1")
    .set("X-Fuse-Mandate", "mandate-1")
    .set("X-Fuse-Branch", "branch-1")
    .set("X-Fuse-Replay-Operation", operationId)
    .send(body);
}

describe("durable replay authorization inventory", () => {
  it("persists authorization-bound ordinals with one-shot state and run-wide cap", () => {
    expect(RELIABILITY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS reliability_replay_authorizations");
    expect(RELIABILITY_SCHEMA_SQL).toContain("CHECK(replay_ordinal BETWEEN 1 AND 20)");
    expect(RELIABILITY_SCHEMA_SQL).toContain("UNIQUE(run_id,replay_ordinal)");
    expect(RELIABILITY_SCHEMA_SQL).toContain("UNIQUE(operation_id)");
    expect(RELIABILITY_SCHEMA_SQL).toContain("transport_started_at");
  });

  it("registers all twenty rows atomically only against the committed run authorization decision", async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const requestIds = Array.from({ length: 20 }, (_, index) => `request-${index + 1}`);
    const authorizationSha256 = `sha256:${"a".repeat(64)}`;
    const expectedInventory = protocolStoreModule.buildReplayAuthorizationInventory({ runId: "run-1", authorizationSha256, requestIds });
    const database = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.includes("FROM reliability_authorization_decisions") && sql.includes("FOR UPDATE")) {
        return { rows: [{ decision_id: "11111111-1111-5111-a111-111111111111", operator_published: true, reconciliation_published: true, durable_stage: "fresh_terminal" }] };
      }
      if (sql.includes("FROM reliability_sealed_calls") && sql.includes("request_id=ANY")) {
        return { rows: requestIds.map((request_id) => ({ request_id })) };
      }
      if (sql.includes("FROM reliability_replay_authorizations WHERE run_id=$1 ORDER BY replay_ordinal")) {
        return { rows: expectedInventory.map((item) => ({ replay_ordinal: item.ordinal, request_id: item.requestId,
          operation_id: item.operationId, authorization_decision_id: "11111111-1111-5111-a111-111111111111",
          signed_authorization_sha256: authorizationSha256 })) };
      }
      return { rows: [] };
    }) };
    const store = new ReliabilityProtocolStore(database as never) as ReliabilityProtocolStore & {
      registerReplayAuthorizationInventory(input: { runId: string; authorizationSha256: string; requestIds: string[] }): Promise<void>;
    };
    expect(typeof store.registerReplayAuthorizationInventory).toBe("function");
    await store.registerReplayAuthorizationInventory({ runId: "run-1", authorizationSha256, requestIds });
    expect(statements.filter(({ sql }) => sql.includes("INSERT INTO reliability_replay_authorizations"))).toHaveLength(20);
    expect(statements[0]?.sql).toBe("BEGIN");
    expect(statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("derives exactly twenty stable one-shot operation IDs and ordinals from signed run authority", () => {
    const build = (protocolStoreModule as unknown as { buildReplayAuthorizationInventory?: (input: {
      runId: string; authorizationSha256: string; requestIds: readonly string[];
    }) => Array<{ ordinal: number; requestId: string; operationId: string }> }).buildReplayAuthorizationInventory;
    expect(typeof build).toBe("function");
    const requestIds = Array.from({ length: 20 }, (_, index) => `request-${index + 1}`);
    const first = build!({ runId: "run-1", authorizationSha256: `sha256:${"a".repeat(64)}`, requestIds });
    const restarted = build!({ runId: "run-1", authorizationSha256: `sha256:${"a".repeat(64)}`, requestIds });
    expect(first).toEqual(restarted);
    expect(first.map((item) => item.ordinal)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(new Set(first.map((item) => item.operationId)).size).toBe(20);
    expect(first.map((item) => item.requestId)).toEqual(requestIds);
    expect(() => build!({ runId: "run-1", authorizationSha256: `sha256:${"a".repeat(64)}`, requestIds: requestIds.slice(1) }))
      .toThrow("REPLAY_AUTHORIZATION_INVENTORY_INVALID");
    expect(() => build!({ runId: "run-1", authorizationSha256: `sha256:${"a".repeat(64)}`, requestIds: [...requestIds.slice(0, 19), requestIds[0]!] }))
      .toThrow("REPLAY_AUTHORIZATION_INVENTORY_INVALID");
  });

  it("refuses replay registration before the durable fresh-terminal stage", async () => {
    const database = { query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM reliability_authorization_decisions") && sql.includes("FOR UPDATE")) {
        return { rows: [{ decision_id: "11111111-1111-5111-a111-111111111111", operator_published: true, reconciliation_published: true, durable_stage: "running" }] };
      }
      return { rows: [] };
    }) };
    const store = new ReliabilityProtocolStore(database as never);
    await expect(store.registerReplayAuthorizationInventory({
      runId: "run-1", authorizationSha256: `sha256:${"a".repeat(64)}`,
      requestIds: Array.from({ length: 20 }, (_, index) => `request-${index + 1}`),
    })).rejects.toThrow("REPLAY_STAGE_PREREQUISITE_UNMET");
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO reliability_replay_authorizations"))).toBe(false);
  });
});

describe("protocol-bound HTTP authority", () => {
  it("rejects a protocol lane credential that omits the exact sealed reliability coordinates before ordinary execution", async () => {
    const execute = vi.fn();
    const resolveAuthority = vi.fn(async () => null);
    const app = createFuseApp({
      provider: { complete: async () => { throw new Error("unused"); } },
      paymentGuard: () => (_request, response) => response.status(500).end(),
      estimateInputTokens: () => 2,
      credentialAuthenticator: authenticator,
      workloadShadowEnabled: true,
      reliabilityContextIssuer: resolveAuthority,
      inferenceExecution: { execute },
    });

    const response = await request(app).post("/v1/chat/completions")
      .set("Authorization", "Bearer authenticated-agent")
      .set("Idempotency-Key", "request-1")
      .set("X-Fuse-Mandate", "mandate-1")
      .set("X-Fuse-Branch", "branch-1")
      .send(body);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { code: "RELIABILITY_PROTOCOL_CONTEXT_REQUIRED" } });
    expect(resolveAuthority).toHaveBeenCalledWith(expect.objectContaining({
      runId: null, laneId: null, block: null,
      credentialId: "credential-1", mandateId: "mandate-1", branchId: "branch-1",
    }));
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("authenticated replay operation trust boundary", () => {
  it("uses the dedicated sealed replay executor and returns its exact stable response without ordinary execution", async () => {
    const ordinaryExecute = vi.fn();
    const stable = {
      id: "generation-1", object: "chat.completion" as const, model: body.model,
      choices: [{ index: 0 as const, finish_reason: "stop" as const, message: { role: "assistant" as const, content: "ok" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      fuse: {
        decision: { id: "decision-1", outcome: "ALLOW" as const, wouldOutcome: "ALLOW" as const, enforced: true as const, reasonCodes: [] as never[] },
        workloadScope: { branchId: "branch-1", workloadClass: "reliability.normal" },
        reservationAtomic: "12", actualCostAtomic: "10",
      },
    };
    const replayExecute = vi.fn(async () => stable);
    const app = createFuseApp({
      provider: { complete: async () => { throw new Error("unused"); } },
      paymentGuard: () => (_request, response) => response.status(500).end(),
      estimateInputTokens: () => 2, credentialAuthenticator: authenticator,
      workloadShadowEnabled: true, inferenceExecution: { execute: ordinaryExecute },
      sealedReplayExecution: { execute: replayExecute },
    });

    const response = await replayRequest(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(stable);
    expect(ordinaryExecute).not.toHaveBeenCalled();
    expect(replayExecute).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "replay-1234567890abcdef", organizationId: "org-1",
      credentialId: "credential-1", agentId: "agent-1", requestId: "request-1",
      mandateId: "mandate-1", branchId: "branch-1", workloadClass: "reliability.normal", body,
    }));
  });

  it("establishes trusted replay context only after authenticated sealed replay authorization", async () => {
    const observed: Array<string | undefined> = [];
    const authorize = vi.fn(async () => ({ authorized: true as const }));
    const app = createFuseApp({
      provider: { complete: async () => { throw new Error("unused"); } },
      paymentGuard: () => (_request, response) => response.status(500).end(),
      estimateInputTokens: () => 2,
      credentialAuthenticator: authenticator,
      workloadShadowEnabled: true,
      replayOperationAuthorizer: authorize,
      inferenceExecution: { execute: async (input) => {
        observed.push(currentTrustedReplayOperation());
        return completed(input);
      } },
    });

    const response = await replayRequest(app);

    expect(response.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "replay-1234567890abcdef", organizationId: "org-1",
      credentialId: "credential-1", agentId: "agent-1", idempotencyKey: "request-1",
      mandateId: "mandate-1", branchId: "branch-1", workloadClass: "reliability.normal", body,
    }));
    expect(observed).toEqual(["replay-1234567890abcdef"]);
    expect(currentTrustedReplayOperation()).toBeUndefined();
  });

  it("rejects a forged public replay header after authentication without executing", async () => {
    const execute = vi.fn();
    const app = createFuseApp({
      provider: { complete: async () => { throw new Error("unused"); } },
      paymentGuard: () => (_request, response) => response.status(500).end(),
      estimateInputTokens: () => 2, credentialAuthenticator: authenticator,
      workloadShadowEnabled: true, inferenceExecution: { execute },
    });

    const response = await replayRequest(app);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { code: "REPLAY_AUTHORIZATION_INVALID" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a mutating replay target when sealed replay authorization refuses it", async () => {
    const execute = vi.fn();
    const app = createFuseApp({
      provider: { complete: async () => { throw new Error("unused"); } },
      paymentGuard: () => (_request, response) => response.status(500).end(),
      estimateInputTokens: () => 2, credentialAuthenticator: authenticator,
      workloadShadowEnabled: true,
      replayOperationAuthorizer: async () => null,
      inferenceExecution: { execute },
    });

    const response = await replayRequest(app);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: "REPLAY_TARGET_NOT_IMMUTABLE" } });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("exact protocol commitment projections", () => {
  it("binds the exact non-secret HTTP request projection", () => {
    const projection = {
      method: "POST" as const, route: "/v1/chat/completions" as const,
      organizationId: "org-1", credentialId: "credential-1", mandateId: "mandate-1",
      branchId: "branch-1", workloadClass: "reliability.normal",
      idempotencyKey: "request-1", body,
    };
    const baseline = buildRequestCommitment(projection);
    for (const [key, replacement] of [
      ["method", "PUT"], ["route", "/other"], ["credentialId", "forged"],
      ["idempotencyKey", "request-2"], ["workloadClass", "other"],
    ] as const) {
      expect(buildRequestCommitment({ ...projection, [key]: replacement } as never)).not.toBe(baseline);
    }
  });

  it("binds every field in the stable successful response and excludes only shadowEvaluation", () => {
    const projection: StableSuccessfulResponseProjection = {
      id: "generation-1", object: "chat.completion", model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      fuse: {
        decision: { id: "decision-1", outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] },
        workloadScope: { branchId: "branch-1", workloadClass: "reliability.normal" },
        reservationAtomic: "12", actualCostAtomic: "10",
      },
    };
    const baseline = buildResponseCommitment(projection);
    expect(buildResponseCommitment({ ...projection, object: "forged" } as never)).not.toBe(baseline);
    expect(buildResponseCommitment({ ...projection, usage: { ...projection.usage, total_tokens: 4 } })).not.toBe(baseline);
    expect(buildResponseCommitment({ ...projection, fuse: { ...projection.fuse, actualCostAtomic: "11" } })).not.toBe(baseline);
    expect(buildResponseCommitment({ ...projection, fuse: { ...projection.fuse, shadowEvaluation: { ignored: true } } } as never)).toBe(baseline);
  });
});

describe("protocol-wide mutation exclusion", () => {
  it("uses one shared advisory API for ordinary mutations and exclusive replay", async () => {
    const ordinary: string[] = [];
    const replay: string[] = [];
    await acquireOrdinaryMutationExclusion({ query: async (sql: string) => { ordinary.push(sql); return { rows: [] }; } });
    await acquireReplayExclusion({ query: async (sql: string) => { replay.push(sql); return { rows: [] }; } });
    expect(ordinary[0]).toContain("pg_advisory_xact_lock_shared");
    expect(replay[0]).toContain("pg_advisory_xact_lock(");
    expect(ordinary[0]?.match(/hashtextextended\('([^']+)'/)?.[1])
      .toBe(replay[0]?.match(/hashtextextended\('([^']+)'/)?.[1]);
  });

  it("routes audited direct and failure-path writers through the shared transaction exclusion", async () => {
    const protocolSql: string[] = [];
    const protocolClient = { query: vi.fn(async (sql: string) => {
      protocolSql.push(sql);
      if (sql.includes("SELECT receipt_kind,receipt")) return { rows: [{ receipt_kind: "operator", receipt: {} }] };
      return { rows: [] };
    }), release: vi.fn() };
    const protocolStore = new ReliabilityProtocolStore({
      query: protocolClient.query,
      connect: vi.fn(async () => protocolClient),
    } as never);
    await protocolStore.publishAuthorizationOutbox("run-1", async () => undefined);
    expect(protocolSql).toContain("BEGIN");
    const protocolTimeoutIndex = protocolSql.findIndex((sql) => sql.includes("set_config('lock_timeout'"));
    const protocolLockIndex = protocolSql.findIndex((sql) => sql.includes("pg_advisory_xact_lock_shared"));
    expect(protocolTimeoutIndex).toBeGreaterThan(-1);
    expect(protocolLockIndex).toBeGreaterThan(protocolTimeoutIndex);
    expect(protocolSql).toContain("COMMIT");

    const defaultPolicySql: string[] = [];
    const defaultPolicyClient = { query: vi.fn(async (sql: string) => { defaultPolicySql.push(sql); return { rows: [] }; }), release: vi.fn() };
    const defaultPolicyPool = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn(async () => defaultPolicyClient) };
    const defaultPolicyStore = new PolicyStore(defaultPolicyPool as never);
    (defaultPolicyStore as unknown as { initialized: Promise<void> }).initialized = Promise.resolve();
    await defaultPolicyStore.failInference({ requestId: "request-default", organizationId: "org-1", failureCode: "FAILED", failedAt: new Date(0).toISOString() });
    expect(defaultPolicySql).toContain("BEGIN");
    expect(defaultPolicySql.some((sql) => sql.includes("pg_advisory_xact_lock_shared"))).toBe(false);
    expect(defaultPolicySql).toContain("COMMIT");

    const enabledPolicySql: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const enabledPolicyClient = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      enabledPolicySql.push({ sql, values });
      return { rows: [] };
    }), release: vi.fn() };
    const enabledPolicyPool = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn(async () => enabledPolicyClient) };
    const enabledPolicyStore = new PolicyStore(enabledPolicyPool as never, {
      protocolMutationExclusionEnabled: true,
      protocolMutationLockTimeoutMs: 5_000,
    });
    (enabledPolicyStore as unknown as { initialized: Promise<void> }).initialized = Promise.resolve();
    await enabledPolicyStore.failInference({ requestId: "request-enabled", organizationId: "org-1", failureCode: "FAILED", failedAt: new Date(0).toISOString() });
    expect(enabledPolicySql.some(({ sql, values }) => sql.includes("set_config('lock_timeout'")
      && values?.[0] === "5000ms")).toBe(true);
    expect(enabledPolicySql.some(({ sql }) => sql.includes("pg_advisory_xact_lock_shared"))).toBe(true);
  });
});

describe("sealed replay production store boundary", () => {
  it("exposes one exclusive authenticated transport operation instead of composing ordinary execution", () => {
    const store = new ReliabilityProtocolStore({ query: vi.fn() } as never);
    expect(typeof (store as unknown as { executeAuthenticatedSealedReplay?: unknown })
      .executeAuthenticatedSealedReplay).toBe("function");
  });

  it("reopens only a proven pre-primitive failure and permanently consumes ambiguous transport", () => {
    const classify = (protocolStoreModule as unknown as { classifyReplayTransportFailure?: (error: unknown) => string }).classifyReplayTransportFailure;
    expect(typeof classify).toBe("function");
    expect(classify!(new OpenRouterTransportError("HOOK", "dispatch_hook", false))).toBe("retryable");
    expect(classify!(new OpenRouterTransportError("TIMEOUT", "http_dispatch", true))).toBe("ambiguous_consumed");
    expect(classify!(new Error("unknown transport failure"))).toBe("ambiguous_consumed");
  });
});

describe("late-table replay trigger coverage", () => {
  it("installs missing triggers and verifies the PostgreSQL catalog fail closed", async () => {
    const statements: string[] = [];
    const client = { query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("pg_catalog.pg_trigger")) return { rows: [{ table_name: "inference_executions" }] };
      return { rows: [] };
    } };
    await installReplayAuditTriggers(client, ["inference_executions"]);
    await verifyReplayAuditTriggerCatalog(client, ["inference_executions"]);
    expect(statements.some((sql) => sql.includes("CREATE TRIGGER reliability_replay_audit_inference_executions"))).toBe(true);
    await expect(verifyReplayAuditTriggerCatalog({ query: async () => ({ rows: [] }) }, ["inference_executions"]))
      .rejects.toThrow("REPLAY_AUDIT_TRIGGER_COVERAGE_INCOMPLETE");
  });
});
