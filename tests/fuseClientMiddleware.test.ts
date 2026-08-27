import { describe, expect, it, vi } from "vitest";
import { executeWithFuseMiddleware, FuseClientError } from "../packages/fuse-client/src/index.js";
import type { FuseInferenceInput, FuseInferenceResult } from "../packages/fuse-client/src/types.js";

const input: FuseInferenceInput = {
  mandateId: "mandate-1",
  requestId: "request-1",
  model: "model-1",
  messages: [{ role: "user", content: "hello" }],
};

function client(error?: FuseClientError) {
  return { inference: error ? vi.fn(async () => { throw error; }) : vi.fn(async () => ({ status: "completed", response: "ok", decisionId: "d1", reservedCostAtomic: "1", actualCostAtomic: "1" } satisfies FuseInferenceResult)) };
}

describe("fuse provider middleware", () => {
  it.each([
    [403, "POLICY_DENIED", "authorization_denied"],
    [402, "PAYMENT_REQUIRED", "payment_required"],
    [409, "REQUEST_IN_PROGRESS", "idempotency_conflict"],
    [409, "REQUEST_REQUIRES_REVIEW", "uncertain"],
    [503, "INFERENCE_EXECUTION_UNAVAILABLE", "uncertain"],
  ] as const)("classifies %s %s as %s", async (status, code, kind) => {
    const result = await executeWithFuseMiddleware(client(new FuseClientError(status, code)), input);
    expect(result.kind).toBe(kind);
  });

  it("does not retry uncertain execution and invokes the review hook", async () => {
    const onUncertain = vi.fn();
    const provider = client(new FuseClientError(409, "REQUEST_REQUIRES_REVIEW"));
    const result = await executeWithFuseMiddleware(provider, input, { onUncertain });
    expect(result.kind).toBe("uncertain");
    expect(provider.inference).toHaveBeenCalledTimes(1);
    expect(onUncertain).toHaveBeenCalledTimes(1);
  });

  it("returns completed output without transforming it", async () => {
    const result = await executeWithFuseMiddleware(client(), input);
    expect(result).toMatchObject({ kind: "completed", result: { response: "ok" } });
  });
});
