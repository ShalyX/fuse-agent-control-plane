import { describe, expect, it, vi } from "vitest";
import { InferenceExecutionService, issueReliabilityProtocolContext, type InferenceExecutionStore } from "../src/inference/inferenceExecution.js";
import { ReliabilityInferenceExecutionStore } from "../src/reliability/inferenceStore.js";
import { executeConcurrentReconciliation, heldLaneFifoResolution } from "../src/reliability/operationalV2.js";
import { RELIABILITY_SCHEMA_SQL } from "../src/reliability/reliabilitySchema.js";
import * as runner from "../scripts/held-out-reliability-v2.js";

const decision = { id: "decision", result: { outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] }, input: { model: "model", branchId: "branch", workloadClass: "baseline-lookup" } } as never;
const response = { id: "generation", content: "ok", usage: { inputTokens: 1, outputTokens: 1 }, providerCostUsd: "0.000001", providerModel: "model" };

describe("operational P0/P1 closure", () => {
  it("commits ordinary and protocol completion through one shared transaction hook", async () => {
    const calls: string[] = [];
    const sharedClient = { tag: "shared" };
    const policy = {
      admitInference: async () => ({ status: "execute", reservedCostAtomic: 10n, decision }),
      admitInferenceAtomically: async (_input: unknown, hook: (client: unknown, result: unknown) => Promise<void>) => {
        const result = { status: "execute", reservedCostAtomic: 10n, decision };
        await hook(sharedClient, result);
        return result;
      },
      completeInference: async () => { throw new Error("SPLIT_COMPLETION_FORBIDDEN"); },
      completeInferenceAtomically: async (input: any, hook: (client: unknown, result: unknown) => Promise<void>) => {
        calls.push("ordinary");
        const result = { status: "completed", reservedCostAtomic: 10n, actualCostAtomic: input.actualCostAtomic, response: input.response };
        await hook(sharedClient, result);
        calls.push("commit");
        return result;
      },
      holdInference: async () => undefined,
    } as unknown as InferenceExecutionStore;
    const protocol = {
      readSealedReservation: async () => 10n,
      recordAttemptOnClient: async () => undefined,
      recordAttempt: async () => undefined,
      authorizeReliabilityDispatch: async () => ({ tokenId: "token" }),
      awaitReliabilityDispatchRelease: async () => undefined,
      markReliabilityDispatchPrimitiveEntered: async () => undefined,
      completeReliabilityAttempt: async () => { throw new Error("SPLIT_PROTOCOL_COMPLETION_FORBIDDEN"); },
      completeReliabilityAttemptOnClient: async (client: unknown) => { expect(client).toBe(sharedClient); calls.push("protocol"); },
      holdReliabilityAttempt: async () => undefined,
      classifyReliabilityNotDispatched: async () => undefined,
      failProtocol: async () => undefined,
    };
    const store = new ReliabilityInferenceExecutionStore(policy, protocol as never);
    const service = new InferenceExecutionService({ store, provider: { complete: async (request: any) => { await request.onDispatchPrimitiveEntered(); return response; } }, providerName: "openrouter", model: "model", price: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" }, requireProviderCost: true, requireProviderModelMatch: true });
    await service.execute({ requestId: "request", organizationId: "org", credentialId: "credential", mandateId: "mandate", branchId: "branch", workloadClass: "baseline-lookup", agentId: "agent", agentCapabilities: ["inference:invoke"], inputTokens: 1, maxOutputTokens: 8, messages: [{ role: "user", content: "x" }], reliabilityContext: issueReliabilityProtocolContext({ runId: "run", laneId: "normal-paced", block: 1, callOrdinal: 1 }) });
    expect(calls).toEqual(["ordinary", "protocol", "commit"]);
  });

  it("rolls back ordinary failure when protocol not-dispatched terminalization fails", async () => {
    const committed = { ordinaryFailed: false, protocolNotDispatched: false };
    const sharedClient = { pending: { ordinaryFailed: false, protocolNotDispatched: false } };
    const policy = {
      failInference: async () => { throw new Error("SPLIT_ORDINARY_FAILURE_FORBIDDEN"); },
      failInferenceAtomically: async (_input: unknown, hook: (client: unknown) => Promise<void>) => {
        sharedClient.pending.ordinaryFailed = true;
        try {
          await hook(sharedClient);
          committed.ordinaryFailed = sharedClient.pending.ordinaryFailed;
          committed.protocolNotDispatched = sharedClient.pending.protocolNotDispatched;
        } finally {
          sharedClient.pending = { ordinaryFailed: false, protocolNotDispatched: false };
        }
      },
    } as unknown as InferenceExecutionStore;
    const protocol = {
      classifyReliabilityNotDispatched: async () => { throw new Error("SPLIT_PROTOCOL_FAILURE_FORBIDDEN"); },
      classifyReliabilityNotDispatchedOnClient: async (client: typeof sharedClient) => {
        expect(client).toBe(sharedClient);
        client.pending.protocolNotDispatched = true;
        throw new Error("PROTOCOL_TERMINALIZATION_FAILED");
      },
    };
    const store = new ReliabilityInferenceExecutionStore(policy, protocol as never);
    await expect(store.classifyReliabilityNotDispatchedAtomically!({
      ordinary: { requestId: "request", organizationId: "org", failureCode: "PROVIDER_NOT_DISPATCHED", failedAt: new Date(0).toISOString() },
      protocol: { runId: "run", laneId: "normal-paced", requestId: "request", reasonCode: "HOOK" },
    })).rejects.toThrow("PROTOCOL_TERMINALIZATION_FAILED");
    expect(committed).toEqual({ ordinaryFailed: false, protocolNotDispatched: false });
  });

  it("commits pre-entry crash recovery across ordinary and protocol ledgers through one transaction", async () => {
    const calls: string[] = [];
    const sharedClient = { tag: "shared-recovery" };
    const policy = {
      failInferenceAtomically: async (_input: unknown, hook: (client: unknown) => Promise<unknown>) => {
        calls.push("ordinary");
        const result = await hook(sharedClient);
        calls.push("commit");
        return result;
      },
    } as unknown as InferenceExecutionStore;
    const protocol = {
      recoverPreEntryDispatchOnClient: async (client: unknown) => {
        expect(client).toBe(sharedClient);
        calls.push("protocol");
        return "not_dispatched" as const;
      },
    };
    const store = new ReliabilityInferenceExecutionStore(policy, protocol as never);
    const result = await (store as any).recoverPreEntryDispatchAtomically({
      ordinary: { requestId: "request", organizationId: "org", failureCode: "PRE_ENTRY_WORKER_CRASH", failedAt: new Date(0).toISOString() },
      protocol: { runId: "run", laneId: "normal-paced", requestId: "request", reasonCode: "PRE_ENTRY_WORKER_CRASH" },
    });
    expect(result).toBe("not_dispatched");
    expect(calls).toEqual(["ordinary", "protocol", "commit"]);
  });

  it("continues later reconciliation offsets after an offset-zero resident failure", async () => {
    const lookedUp: number[] = [];
    const failed: number[] = [];
    const result = await executeConcurrentReconciliation({
      requests: [{ requestId: "request", generationId: "generation", ambiguityEnteredAt: "2026-07-23T00:00:00.000Z" }],
      offsets: [0, 60],
      authorizeOffset: async () => ({ credentialId: "reconciler", authorizationSha256: `sha256:${"a".repeat(64)}` }),
      waitUntil: async () => undefined,
      lookup: async ({ offsetSeconds }) => { lookedUp.push(offsetSeconds); if (offsetSeconds === 0) throw new Error("OFFSET_ZERO_CRASH"); return { disposition: "terminal", terminal: true }; },
      persistPhase: async (phase) => { if (phase.phase === "failed") failed.push(phase.offsetSeconds); },
    });
    expect(lookedUp).toEqual([0, 60]);
    expect(failed).toEqual([0]);
    expect(result).toEqual({ requests: 1, terminal: 1, failed: 1 });
  });

  it("removes independently terminal held siblings while preserving sealed membership order", () => {
    expect(heldLaneFifoResolution({ members: ["a", "b", "c"], requestId: "b", transitionCommittedAtMs: 1 })).toEqual({ remaining: ["a", "c"], resumeAtMs: null });
    expect(heldLaneFifoResolution({ members: ["c"], requestId: "c", transitionCommittedAtMs: 300_000 })).toEqual({ remaining: [], resumeAtMs: 600_000 });
  });

  it("expands exact setup authority and exposes durable backlog and report schedule semantics", () => {
    const source = runner.expectedProductionSetupSnapshot.toString();
    for (const field of ["credentialVersion", "encryptionKeyId", "workloadClass", "workloadShadow", "allowedWorkloadClasses", "schemaFingerprint"]) expect(source).toContain(field);
    for (const fragment of ["reliability_lane_backlog", "nominal_scheduled_at", "actual_scheduled_at", "pause_duration_seconds", "member_state"]) expect(RELIABILITY_SCHEMA_SQL).toContain(fragment);
  });

  it("exposes production store operations for atomic completion, conservative pre-entry recovery, and durable resumed work", async () => {
    const store = (await import("../src/reliability/protocolStore.js")).ReliabilityProtocolStore.prototype as unknown as Record<string, unknown>;
    for (const method of ["completeReliabilityAttemptOnClient", "recoverPreEntryDispatchOnClient", "enqueueHeldLaneWork", "claimDueResumedWork", "completeResumedWorkGroup", "loadReliabilityScheduleReport"]) expect(typeof store[method]).toBe("function");
  });

  it("wires held backlog draining and pre-entry recovery into production without serializing independent reconciliations", () => {
    const source = runner.createReliabilityOperations.toString();
    for (const call of ["enqueueHeldLaneWork", "claimDueResumedWork", "completeResumedWorkGroup", "recoverPreEntryDispatchAtomically"]) expect(source).toContain(call);
    expect(source).not.toContain("store.recoverPreEntryDispatch(");
    expect(source).not.toContain("isHeldLaneHead");
  });
});
