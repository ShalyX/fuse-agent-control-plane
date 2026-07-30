import { describe, expect, it, vi } from "vitest";
import { OpenRouterTransportError } from "../src/providers/openRouter.js";
import {
  InferenceExecutionService,
  issueReliabilityProtocolContext,
  type InferenceExecutionStore,
} from "../src/inference/inferenceExecution.js";
import { RELIABILITY_SCHEMA_SQL } from "../src/reliability/reliabilitySchema.js";

describe("reliability v2 P0 trust and lifecycle closure", () => {
  it("persists an exact sealed-call registry rather than deriving authority from headers", () => {
    expect(RELIABILITY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS reliability_sealed_calls");
    for (const field of [
      "call_ordinal", "body_commitment", "organization_id", "agent_id", "mandate_id", "branch_id",
      "workload_class", "provider", "model", "max_output_tokens", "claim_fingerprint",
    ]) expect(RELIABILITY_SCHEMA_SQL).toContain(field);
  });

  it("closes the successful lifecycle through one durable gate classification", async () => {
    const order: string[] = [];
    const store = {
      admitInference: async () => ({ status: "execute", reservedCostAtomic: 10n, decision: { id: "decision", result:{outcome:"ALLOW",wouldOutcome:"ALLOW",enforced:true,reasonCodes:[]}, input:{model:"model",branchId:"branch",workloadClass:"baseline-lookup"} } }),
      recordReliabilityAttempt: async () => { order.push("admission_started"); },
      authorizeReliabilityDispatch: async () => { order.push("dispatch_authorized"); return { tokenId: "token" }; },
      awaitReliabilityDispatchRelease: async () => { order.push("released"); },
      markReliabilityDispatchPrimitiveEntered: async () => { order.push("primitive_entered"); },
      completeInference: async (input: any) => ({ status: "completed", reservedCostAtomic: 10n, actualCostAtomic: input.actualCostAtomic, response: input.response }),
      completeReliabilityAttempt: async () => { order.push("gate_classified"); },
      holdInference: async () => undefined,
      holdReliabilityAttempt: async () => undefined,
      classifyReliabilityNotDispatched: async () => undefined,
    } as unknown as InferenceExecutionStore;
    const provider = { complete: async (request: any) => {
      await request.onDispatchPrimitiveEntered();
      order.push("provider");
      return { id: "generation", content: "ok", usage: { inputTokens: 1, outputTokens: 1 }, providerCostUsd: "0.000001", providerModel: "model" };
    } };
    const service = new InferenceExecutionService({ store, provider, providerName: "openrouter", model: "model", price: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" }, requireProviderCost: true, requireProviderModelMatch: true });
    await service.execute({ requestId: "request", organizationId: "org", credentialId: "credential", mandateId: "mandate", branchId: "branch", workloadClass: "baseline-lookup", agentId: "agent", agentCapabilities: ["inference:invoke"], inputTokens: 1, maxOutputTokens: 8, messages: [{ role: "user", content: "x" }], reliabilityContext: issueReliabilityProtocolContext({ runId: "run", laneId: "normal-paced", block: 1, callOrdinal: 1 }) });
    expect(order).toEqual(["admission_started", "dispatch_authorized", "released", "primitive_entered", "provider", "gate_classified"]);
  });

  it("distinguishes provable pre-entry failure from post-entry ambiguity", async () => {
    const outcomes: string[] = [];
    const makeStore = () => ({
      admitInference: async () => ({ status: "execute", reservedCostAtomic: 10n, decision: { id: "decision", result:{outcome:"ALLOW",wouldOutcome:"ALLOW",enforced:true,reasonCodes:[]}, input:{model:"model",branchId:"branch",workloadClass:"baseline-lookup"} } }),
      recordReliabilityAttempt: async () => undefined,
      authorizeReliabilityDispatch: async () => ({ tokenId: "token" }),
      awaitReliabilityDispatchRelease: async () => undefined,
      markReliabilityDispatchPrimitiveEntered: async () => undefined,
      completeInference: async () => { throw new Error("unexpected"); },
      completeReliabilityAttempt: async () => undefined,
      classifyReliabilityNotDispatchedAtomically: async () => {
        outcomes.push("not_dispatched", "ordinary_failed");
      },
      failInference: async () => { throw new Error("NON_ATOMIC_ORDINARY_FAILURE"); },
      holdInference: async () => outcomes.push("ordinary_held"),
      holdReliabilityAttempt: async () => outcomes.push("ambiguous"),
      classifyReliabilityNotDispatched: async () => { throw new Error("NON_ATOMIC_PROTOCOL_FAILURE"); },
    }) as unknown as InferenceExecutionStore;
    const common = { requestId: "request", organizationId: "org", credentialId: "credential", mandateId: "mandate", branchId: "branch", workloadClass: "baseline-lookup", agentId: "agent", agentCapabilities: ["inference:invoke" as const], inputTokens: 1, maxOutputTokens: 8, messages: [{ role: "user" as const, content: "x" }], reliabilityContext: issueReliabilityProtocolContext({ runId: "run", laneId: "normal-paced", block: 1, callOrdinal: 1 }) };
    const before = new InferenceExecutionService({ store: makeStore(), provider: { complete: async () => { throw new OpenRouterTransportError("HOOK", "dispatch_hook", false); } }, providerName: "openrouter", model: "model", price: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" } });
    await expect(before.execute(common)).rejects.toThrow("HOOK");
    const after = new InferenceExecutionService({ store: makeStore(), provider: { complete: async () => { throw new OpenRouterTransportError("HTTP", "http_dispatch", true, undefined, "generation"); } }, providerName: "openrouter", model: "model", price: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" } });
    await expect(after.execute(common)).rejects.toThrow("HTTP");
    expect(outcomes).toEqual([
      "not_dispatched", "ordinary_failed",
      "ambiguous", "ordinary_held",
    ]);
  });

  it("does not enter the provider until the durable burst release waiter resolves", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async () => ({ id: "generation", content: "ok", usage: { inputTokens: 1, outputTokens: 1 } }));
    const store = {
      admitInference: async () => ({ status: "execute", reservedCostAtomic: 10n, decision: { id: "decision", result:{outcome:"ALLOW",wouldOutcome:"ALLOW",enforced:true,reasonCodes:[]}, input:{model:"model",branchId:"branch",workloadClass:"baseline-lookup"} } }),
      recordReliabilityAttempt: async () => undefined,
      authorizeReliabilityDispatch: async () => ({ tokenId: "token" }),
      awaitReliabilityDispatchRelease: async () => released,
      markReliabilityDispatchPrimitiveEntered: async () => undefined,
      completeInference: async (input: any) => ({ status: "completed", reservedCostAtomic: 10n, actualCostAtomic: input.actualCostAtomic, response: input.response }),
      completeReliabilityAttempt: async () => undefined,
      holdInference: async () => undefined,
      holdReliabilityAttempt: async () => undefined,
      classifyReliabilityNotDispatched: async () => undefined,
    } as unknown as InferenceExecutionStore;
    const service = new InferenceExecutionService({ store, provider: { complete: fetch }, providerName: "openrouter", model: "model", price: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" } });
    const pending = service.execute({ requestId: "request", organizationId: "org", credentialId: "credential", mandateId: "mandate", branchId: "branch", workloadClass: "baseline-lookup", agentId: "agent", agentCapabilities: ["inference:invoke"], inputTokens: 1, maxOutputTokens: 8, messages: [{ role: "user", content: "x" }], reliabilityContext: issueReliabilityProtocolContext({ runId: "run", laneId: "bounded-burst", block: 1, callOrdinal: 1 }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
    release();
    await pending;
    expect(fetch).toHaveBeenCalledOnce();
  });
});
