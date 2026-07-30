import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { executeReliabilityCli } from "../src/evidence/reliabilityCliV2.js";
import {
  authorizationPayloadBytes,
  verifyAuthorizationArtifact,
  type AuthorizationArtifact,
} from "../src/evidence/reliabilityRuntimeV2.js";
import {
  InferenceExecutionService,
  issueReliabilityProtocolContext,
  type InferenceExecutionStore,
} from "../src/inference/inferenceExecution.js";
import { ReliabilityInferenceExecutionStore } from "../src/reliability/inferenceStore.js";
import { OpenRouterReconciler } from "../src/reliability/openRouterReconciler.js";
import { exactSettlementOffsets } from "../src/evidence/reliabilityProtocolV2.js";

const decision = { id: "d", result:{outcome:"ALLOW",wouldOutcome:"ALLOW",enforced:true,reasonCodes:[]}, input:{model:"m"} } as never;

describe("reliability v2 production pass 3", () => {
  it("executes the CLI service path after local run checks instead of returning a placeholder", async () => {
    const run = vi.fn(async () => ({ runId: "run-1", dispatched: 0 }));
    const result = await executeReliabilityCli([
      "run", "--allow-provider-network", "--plan", "plan.json",
      "--operator-authorization", "operator.json", "--reconciliation-authorization", "reconciliation.json", "--json",
    ], {
      cwd: "/virtual",
      readLocal: async (name) => name.endsWith("plan.json") ? Buffer.from("{}") : Buffer.from("auth"),
      operations: { run },
      now: () => "2026-07-23T00:00:00.000Z",
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, runId: "run-1", dispatched: 0 });
  });

  it("records the admitted attempt before committing a dispatch token and rejects a forged context", async () => {
    const order: string[] = [];
    const policy = {
      admitInference: async () => ({ status: "execute", reservedCostAtomic: 10n, decision }),
      admitInferenceAtomically: async (_input:any,hook:(client:unknown,result:any)=>Promise<void>)=>{const result={status:"execute",reservedCostAtomic:10n,decision};await hook({},result);return result;},
      completeInference: async (input: any) => ({ status: "completed", reservedCostAtomic: 10n, actualCostAtomic: input.actualCostAtomic, response: input.response }),
      completeInferenceAtomically: async (input: any, hook: (client: unknown, result: any) => Promise<void>) => {
        const result = { status: "completed", reservedCostAtomic: 10n, actualCostAtomic: input.actualCostAtomic, response: input.response };
        await hook({}, result);
        return result;
      },
      holdInference: async () => undefined,
    } as InferenceExecutionStore;
    const protocol = {
      readSealedReservation: async()=>10n,
      recordAttemptOnClient: async () => { order.push("attempt"); },
      recordAttempt: async () => { throw new Error("non-atomic"); },
      authorizeReliabilityDispatch: async () => { order.push("token"); return { tokenId: "token" }; },
      awaitReliabilityDispatchRelease: async () => undefined,
      markReliabilityDispatchPrimitiveEntered: async () => { order.push("entered"); },
      completeReliabilityAttempt: async () => undefined,
      completeReliabilityAttemptOnClient: async () => undefined,
      holdReliabilityAttempt: async () => undefined,
      classifyReliabilityNotDispatched: async () => undefined,
      failProtocol: async () => undefined,
    };
    const store = new ReliabilityInferenceExecutionStore(policy, protocol as never);
    const provider = { complete: async (request: any) => { await request.onDispatchPrimitiveEntered(); order.push("provider"); return { id: "g", content: "ok", usage: { inputTokens: 1, outputTokens: 1 } }; } };
    const service = new InferenceExecutionService({ store, provider, providerName: "stub", model: "m", price: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" } });
    const common = { requestId: "r", organizationId: "o", credentialId: "credential", mandateId: "m", agentId: "a", agentCapabilities: ["inference:invoke" as const], inputTokens: 1, maxOutputTokens: 1, messages: [{ role: "user", content: "x" }] };
    await expect(service.execute({ ...common, reliabilityContext: { runId: "run", laneId: "normal-paced", block: 1 } as never })).rejects.toThrow("RELIABILITY_PROTOCOL_CONTEXT_INVALID");
    await service.execute({ ...common, reliabilityContext: issueReliabilityProtocolContext({ runId: "run", laneId: "normal-paced", block: 1, callOrdinal: 1 }) });
    expect(order).toEqual(["attempt", "token", "entered", "provider"]);
  });

  it("uses one atomic ordinary/protocol admission with the sealed fixed reservation", async () => {
    const calls: string[] = [];
    const policy = {
      admitInference: async () => { calls.push("non-atomic"); return { status: "execute", reservedCostAtomic: 1n, decision }; },
      admitInferenceAtomically: async (input: any, hook: (client: unknown, result: unknown) => Promise<void>) => {
        calls.push(`ordinary:${input.estimatedCostAtomic}`);
        const result = { status: "execute", reservedCostAtomic: input.estimatedCostAtomic, decision };
        await hook({}, result);
        return result;
      },
      completeInference: async (input: any) => ({ status: "completed", reservedCostAtomic: 50_000n, actualCostAtomic: input.actualCostAtomic, response: input.response }),
      completeInferenceAtomically: async (input: any, hook: (client: unknown, result: any) => Promise<void>) => {
        const result = { status: "completed", reservedCostAtomic: 50_000n, actualCostAtomic: input.actualCostAtomic, response: input.response };
        await hook({}, result);
        return result;
      },
      holdInference: async () => undefined,
    } as unknown as InferenceExecutionStore;
    const protocol = {
      readSealedReservation: async () => 50_000n,
      recordAttemptOnClient: async (_client: unknown, input: any) => { calls.push(`protocol:${input.reservedCostMicros}`); },
      recordAttempt: async () => { calls.push("partial-protocol"); },
      authorizeReliabilityDispatch: async () => ({ tokenId: "token" }), awaitReliabilityDispatchRelease: async () => undefined,
      markReliabilityDispatchPrimitiveEntered: async () => undefined, completeReliabilityAttempt: async () => undefined,
      completeReliabilityAttemptOnClient: async () => undefined,
      holdReliabilityAttempt: async () => undefined, classifyReliabilityNotDispatched: async () => undefined, failProtocol: async () => undefined,
    };
    const store = new ReliabilityInferenceExecutionStore(policy, protocol as never);
    const service = new InferenceExecutionService({ store, provider: { complete: async (request: any) => { await request.onDispatchPrimitiveEntered(); return { id: "g", content: "ok", usage: { inputTokens: 1, outputTokens: 1 } }; } }, providerName: "stub", model: "m", price: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" } });
    await service.execute({ requestId: "r", organizationId: "o", credentialId: "credential", mandateId: "m", agentId: "a", agentCapabilities: ["inference:invoke"], inputTokens: 1, maxOutputTokens: 1, messages: [{ role: "user", content: "x" }], reliabilityContext: issueReliabilityProtocolContext({ runId: "run", laneId: "normal-paced", block: 1, callOrdinal: 1 }) });
    expect(calls).toEqual(["ordinary:50000", "protocol:50000"]);
  });

  it("pins authorization verification to trusted issuer id and raw key, never artifact key material", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const payload = { kind: "operator", runId: "run", planFingerprint: `sha256:${"a".repeat(64)}`, executableFingerprint: `sha256:${"b".repeat(64)}`, actorId: "actor", issuerCredentialId: "issuer", capability: "evidence:authorize-spend", nonce: "n", expiresAt: "2026-07-25T08:22:00.000Z" } as const;
    const artifact: AuthorizationArtifact = { payload, signature: sign(null, authorizationPayloadBytes(payload), privateKey).toString("base64") };
    const expected = { now: "2026-07-25T08:16:00.500Z", expectedRunId: "run", expectedPlanFingerprint: payload.planFingerprint, expectedExecutableFingerprint: payload.executableFingerprint };
    expect(verifyAuthorizationArtifact(artifact, "operator", expected, { operator: { id: "issuer", rawPublicKeyHex: raw }, reconciliation: { id: "other", rawPublicKeyHex: "00".repeat(32) } })).toBe(true);
    expect(verifyAuthorizationArtifact(artifact, "operator", expected, { operator: { id: "different", rawPublicKeyHex: raw }, reconciliation: { id: "other", rawPublicKeyHex: "00".repeat(32) } })).toBe(false);
  });

  it("uses exact OpenRouter generation endpoints and treats either auth failure as global", async () => {
    const urls: string[] = [];
    const reconciler = new OpenRouterReconciler({ apiKey: "k", fetch: vi.fn(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ error: { code: 401 } }), { status: urls.length === 1 ? 401 : 403 });
    }) });
    const result = await reconciler.reconcile({ generationId: "g", model: "nousresearch/hermes-4-405b", input: "x", finalOffset: false });
    expect(urls).toEqual([
      "https://openrouter.ai/api/v1/generation?id=g",
      "https://openrouter.ai/api/v1/generation/content?id=g",
    ]);
    expect(result.disposition).toBe("global_failure");
  });

  it("pins exact settlement polling offsets and cardinality", () => {
    expect(exactSettlementOffsets()).toEqual(Array.from({ length: 25 }, (_, index) => index * 5));
  });
});
