import { describe, expect, it } from "vitest";
import * as ordinary from "../src/reliability/ordinaryReconciliationSettlement.js";
import * as protocol from "../src/reliability/protocolStore.js";
import { buildResponseCommitment } from "../src/reliability/commitments.js";

const evidence = {
  credentialId: "reconciler", generationId: "gen-1", retrievalStartedAtMs: 1,
  metadata: { status: 200, bodySha256: "a".repeat(64), bodyBase64: "e30=", retrievedAtMs: 2,
    data: { id: "gen-1", request_id: "or-1", model: "nousresearch/hermes-4-405b", provider_name: "provider",
      created_at: "2026-07-23T00:00:00.000Z", cancelled: false, finish_reason: "stop", native_finish_reason: "stop",
      native_tokens_prompt: 2, native_tokens_completion: 3, tokens_prompt: 2, tokens_completion: 3,
      total_cost: "0.000005", usage: "0.000005", upstream_id: "upstream", router: null, provider_responses: null } },
  content: { status: 200, bodySha256: "b".repeat(64), bodyBase64: "e30=", retrievedAtMs: 2,
    body: { data: { input: { messages: [{ role: "user", content: "hello" }] }, output: { completion: "exact answer", reasoning: null } } } },
} as const;

const authority = {
  decisionId: "decision-1", outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] as const,
  branchId: "branch-1", workloadClass: "reliability.normal", reservationAtomic: "9", actualCostAtomic: "5",
} as const;

describe("reliability v2 residual P0 closure", () => {
  it("reconstructs the exact stable response and commitment from provider evidence plus authoritative decision/accounting", () => {
    const reconstruct = (ordinary as Record<string, unknown>)["reconstructStableResponseFromEvidence"] as ((e: unknown, a: unknown) => any) | undefined;
    expect(typeof reconstruct).toBe("function");
    if (!reconstruct) throw new Error("RESPONSE_RECONSTRUCTION_MISSING");
    const recovered = reconstruct(evidence, authority);
    expect(recovered.providerResult).toEqual({ id: "gen-1", content: "exact answer", usage: { inputTokens: 2, outputTokens: 3 }, providerCostUsd: "0.000005", providerModel: "nousresearch/hermes-4-405b" });
    expect(recovered.projection).toMatchObject({
      id: "gen-1", model: "nousresearch/hermes-4-405b",
      choices: [{ message: { content: "exact answer" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      fuse: { decision: { id: "decision-1", outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] },
        workloadScope: { branchId: "branch-1", workloadClass: "reliability.normal" }, reservationAtomic: "9", actualCostAtomic: "5" },
    });
    expect(recovered.commitment).toBe(buildResponseCommitment(recovered.projection));
  });

  it.each([
    ["decision", { ...authority, decisionId: "decision-2" }],
    ["reservation", { ...authority, reservationAtomic: "10" }],
    ["actual", { ...authority, actualCostAtomic: "6" }],
  ])("binds authoritative %s into the recovered commitment", (_name, changed) => {
    const reconstruct = (ordinary as any).reconstructStableResponseFromEvidence;
    expect(typeof reconstruct).toBe("function");
    expect(reconstruct(evidence, changed).commitment).not.toBe(reconstruct(evidence, authority).commitment);
  });

  it("fails closed instead of inventing a response when provider or decision evidence is incomplete", () => {
    const reconstruct = (ordinary as any).reconstructStableResponseFromEvidence;
    expect(typeof reconstruct).toBe("function");
    expect(() => reconstruct({ ...evidence, content: { ...evidence.content, body: { data: { output: { completion: null, reasoning: null } } } } }, authority)).toThrow("RECOVERED_RESPONSE_EVIDENCE_INVALID");
    expect(() => reconstruct(evidence, { ...authority, enforced: false })).toThrow("RECOVERED_RESPONSE_AUTHORITY_INVALID");
  });

  it("preserves committed non-burst and released-burst owners on global failure", () => {
    const preserve = (protocol as Record<string, unknown>)["preserveAuthorizedOwnerOnGlobalFailure"] as ((x: unknown) => boolean) | undefined;
    expect(typeof preserve).toBe("function");
    if (!preserve) throw new Error("GLOBAL_FAILURE_OWNER_RULE_MISSING");
    expect(preserve({ laneId: "normal-paced", tokenCommitted: true, burstBarrierState: null })).toBe(true);
    expect(preserve({ laneId: "bounded-burst", tokenCommitted: true, burstBarrierState: "released" })).toBe(true);
    expect(preserve({ laneId: "bounded-burst", tokenCommitted: true, burstBarrierState: "preparing" })).toBe(false);
    expect(preserve({ laneId: "normal-paced", tokenCommitted: false, burstBarrierState: null })).toBe(false);
  });
});
