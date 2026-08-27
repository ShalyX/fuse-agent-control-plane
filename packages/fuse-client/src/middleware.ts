import { FuseClientError } from "./errors.js";
import type { FuseClient, } from "./client.js";
import type { FuseInferenceInput, FuseInferenceResult } from "./types.js";

export type FuseMiddlewareOutcome =
  | { kind: "completed"; result: FuseInferenceResult }
  | { kind: "authorization_denied"; error: FuseClientError }
  | { kind: "payment_required"; error: FuseClientError }
  | { kind: "idempotency_conflict"; error: FuseClientError }
  | { kind: "uncertain"; error: FuseClientError };

export interface FuseMiddlewareOptions {
  onUncertain?: (error: FuseClientError) => void | Promise<void>;
}

export async function executeWithFuseMiddleware(
  client: Pick<FuseClient, "inference">,
  input: FuseInferenceInput,
  options: FuseMiddlewareOptions = {},
): Promise<FuseMiddlewareOutcome> {
  try {
    return { kind: "completed", result: await client.inference(input) };
  } catch (error) {
    if (!(error instanceof FuseClientError)) throw error;
    if (error.code === "POLICY_DENIED" || error.status === 403) return { kind: "authorization_denied", error };
    if (error.status === 402 || error.code === "PAYMENT_REQUIRED") return { kind: "payment_required", error };
    if (error.code === "REQUEST_IN_PROGRESS" || error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT") {
      return { kind: "idempotency_conflict", error };
    }
    if (error.code === "REQUEST_REQUIRES_REVIEW" || error.code === "INFERENCE_EXECUTION_UNAVAILABLE" || error.status >= 500) {
      await options.onUncertain?.(error);
      return { kind: "uncertain", error };
    }
    throw error;
  }
}
