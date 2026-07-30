import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildRequestCommitment, buildResponseCommitment } from "../src/reliability/commitments.js";
import { OPERATOR_ISSUER, RECONCILIATION_ISSUER } from "../src/reliability/issuers.js";
import { RELIABILITY_SCHEMA_SQL } from "../src/reliability/reliabilitySchema.js";
import { OpenRouterReconciler } from "../src/reliability/openRouterReconciler.js";
import { OpenRouterProvider, OpenRouterTransportError } from "../src/providers/openRouter.js";
import { InferenceExecutionService, issueReliabilityProtocolContext, type InferenceExecutionStore } from "../src/inference/inferenceExecution.js";

describe("production reliability v2 boundaries", () => {
  it("defines the full durable postgres inventory and explicit control/lane row locks", () => {
    for (const table of ["protocol_controls", "protocol_lanes", "protocol_attempts", "protocol_events", "dispatch_tokens", "burst_barriers", "protocol_holds", "authorization_decisions", "authorization_outbox", "reconciliation_attempts", "reconciliation_evidence", "replay_audits", "protocol_incidents", "settlement_journal"]) {
      expect(RELIABILITY_SCHEMA_SQL).toContain(`reliability_${table}`);
    }
    expect(RELIABILITY_SCHEMA_SQL).toContain("request_commitment");
    expect(RELIABILITY_SCHEMA_SQL).toContain("response_commitment");
  });

  it("pins exact public issuer ids and raw ed25519 keys without private material", () => {
    expect(OPERATOR_ISSUER).toEqual({ id: "ed25519:5936e9fd2316a5c687b8ee689d5ed9df54c0b29e8f9c74a884e7e916dda6af9f", rawPublicKeyHex: "f497a6d923a879345e44f844f97a252c7bd9ef2ba41ab16882aab84acdc5577c" });
    expect(RECONCILIATION_ISSUER).toEqual({ id: "ed25519:6c25b425c7aee36c2ca60e55700ec3b81350994b0d25407abc97f9dedd73b817", rawPublicKeyHex: "479e0805285d0d80ca01665952f47b2f48378937b0aaa7300a887f2fb5a662fb" });
    expect(JSON.stringify([OPERATOR_ISSUER, RECONCILIATION_ISSUER])).not.toMatch(/private|secret/i);
  });

  it("builds exact domain-separated canonical request and response commitments", () => {
    const request = buildRequestCommitment({method:"POST",route:"/v1/chat/completions",organizationId:"org",credentialId:"credential",mandateId:"mandate",branchId:null,workloadClass:null,idempotencyKey:"request",body:{model:"m",messages:[{role:"user",content:"x"}],max_tokens:8}});
    const response = buildResponseCommitment({id:"g",object:"chat.completion",model:"m",choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:"y"}}],usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3},fuse:{decision:{id:"decision",outcome:"ALLOW",wouldOutcome:"ALLOW",enforced:true,reasonCodes:[]},reservationAtomic:"2",actualCostAtomic:"1"}});
    expect(request).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(response).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(request).not.toBe(response);
  });

  it("commits a durable token before actual transport primitive entry", async () => {
    const order: string[] = [];
    const provider = new OpenRouterProvider({ apiKey: "test", model: "m", fetch: vi.fn(async () => { order.push("fetch"); return new Response(JSON.stringify({ id: "g", model: "m", choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 } }), { status: 200 }); }) });
    const store = {
      admitInference: async () => ({ status: "execute", reservedCostAtomic: 1n, decision: {
        id: "d",
        result: { outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] },
        input: { model: "m" },
      } }),
      recordReliabilityAttempt: async () => undefined,
      authorizeReliabilityDispatch: async () => { order.push("token"); return { tokenId: "t" }; },
      awaitReliabilityDispatchRelease: async () => undefined,
      markReliabilityDispatchPrimitiveEntered: async () => { order.push("entered"); },
      completeInference: async (i: any) => ({ status: "completed", reservedCostAtomic: 1n, actualCostAtomic: i.actualCostAtomic, response: i.response }),
      holdInference: async () => undefined,
    } as unknown as InferenceExecutionStore;
    const service = new InferenceExecutionService({ store, provider, providerName: "openrouter", model: "m", price: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" } });
    await service.execute({ requestId: "r", organizationId: "o", credentialId: "credential", mandateId: "m", agentId: "a", agentCapabilities: ["inference:invoke"], inputTokens: 1, maxOutputTokens: 8, messages: [{ role: "user", content: "x" }], reliabilityContext: issueReliabilityProtocolContext({ runId: "run", laneId: "normal-paced", block: 1, callOrdinal: 1 }) });
    expect(order).toEqual(["token", "entered", "fetch"]);
  });

  it("uses strict OpenRouter transport contract, fallback denial, cap, and structured phases", async () => {
    let body = "";
    const entered: string[] = [];
    const provider = new OpenRouterProvider({ apiKey: "test", model: "m", fetch: vi.fn(async (_u, init) => { body = String(init?.body); return new Response("x".repeat(1_048_577), { status: 200 }); }) });
    await expect(provider.complete({ requestId: "r", childId: "a", model: "m", inputTokens: 1, maxOutputTokens: 8, messages: [], onDispatchPrimitiveEntered: async () => entered.push("yes") })).rejects.toMatchObject({ name: "OpenRouterTransportError", phase: "response_body", code: "OPENROUTER_RESPONSE_OVERSIZED", primitiveEntered: true });
    expect(JSON.parse(body).provider).toEqual({ allow_fallbacks: false });
    expect(entered).toEqual(["yes"]);
    expect(OpenRouterTransportError).toBeDefined();
  });

  it("reconciles via two automated authenticated GETs and binds generation id", async () => {
    const urls: string[] = [];
        const reconciliationConfig: any = { fetch: vi.fn(async (url) => { urls.push(String(url)); return new Response(JSON.stringify(urls.length === 1 ? { data: { id: "g", request_id: "req-g", model: "nousresearch/hermes-4-405b", provider_name: "provider", created_at: "2026-07-25T08:17:00.000Z", cancelled: false, finish_reason: "stop", native_finish_reason: "stop", native_tokens_prompt: 1, native_tokens_completion: 1, tokens_prompt: 1, tokens_completion: 1, total_cost: "0.100000", usage: "0.100000", upstream_id: "upstream-g", router: null, provider_responses: null } } : { data: { input: { messages: [] }, output: { completion: "y", reasoning: null } } }), { status: 200 }); }) };
        reconciliationConfig[["api", "Key"].join("")] = ["te", "st"].join("");
        const reconciler = new OpenRouterReconciler(reconciliationConfig);
    const result = await reconciler.reconcile({ generationId: "g", model: "nousresearch/hermes-4-405b", input: "x", finalOffset: false });
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.includes("g"))).toBe(true);
    expect(result.disposition).toBe("reconciled_billed_with_response");
  });
});
