import {
  buildResponseCommitment,
  type StableSuccessfulResponseProjection,
} from "./commitments.js";
import { readBoundedBody } from "./boundedBody.js";
import type { ProviderResult } from "../core/service.js";

const REPLAY_TIMEOUT_MS = 15_000;
const REPLAY_MAX_RESPONSE_BYTES = 1_048_576;

export interface ReliabilityReplayHttpInput {
  baseUrl: string;
  endpoint: string;
  laneCredential: string;
  requestId: string;
  operationId: string;
  mandateId: string;
  branchId: string;
  body: unknown;
  expectedCommitment: string;
  fetch?: typeof fetch;
}

function invalid(): never { throw new Error("REPLAY_RESPONSE_INVALID"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}
function atomic(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) invalid();
  return value;
}

function parseResponse(value: unknown): {
  projection: StableSuccessfulResponseProjection;
  providerResult: ProviderResult;
} {
  const root = record(value);
  const choices = root["choices"];
  if (typeof root["id"] !== "string" || !root["id"]
    || root["object"] !== "chat.completion"
    || typeof root["model"] !== "string" || !root["model"]
    || !Array.isArray(choices) || choices.length !== 1) invalid();
  const choice = record(choices[0]);
  const message = record(choice["message"]);
  if (choice["index"] !== 0 || choice["finish_reason"] !== "stop"
    || message["role"] !== "assistant" || typeof message["content"] !== "string") invalid();

  const usage = record(root["usage"]);
  const promptTokens = nonnegativeInteger(usage["prompt_tokens"]);
  const completionTokens = nonnegativeInteger(usage["completion_tokens"]);
  const totalTokens = nonnegativeInteger(usage["total_tokens"]);
  if (totalTokens !== promptTokens + completionTokens) invalid();

  const fuse = record(root["fuse"]);
  const decision = record(fuse["decision"]);
  if (typeof decision["id"] !== "string" || !decision["id"]
    || decision["outcome"] !== "ALLOW" || decision["wouldOutcome"] !== "ALLOW"
    || decision["enforced"] !== true || !Array.isArray(decision["reasonCodes"])
    || decision["reasonCodes"].length !== 0) invalid();
  const reservationAtomic = atomic(fuse["reservationAtomic"]);
  const actualCostAtomic = atomic(fuse["actualCostAtomic"]);
  if (BigInt(actualCostAtomic) > BigInt(reservationAtomic)) invalid();
  const scopeValue = fuse["workloadScope"];
  const workloadScope = scopeValue === undefined ? undefined : record(scopeValue);
  if (workloadScope && (typeof workloadScope["branchId"] !== "string"
    || typeof workloadScope["workloadClass"] !== "string")) invalid();

  const projection: StableSuccessfulResponseProjection = {
    id: root["id"], object: "chat.completion", model: root["model"],
    choices: [{ index: 0, finish_reason: "stop", message: {
      role: "assistant", content: message["content"],
    } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
    fuse: {
      decision: {
        id: decision["id"], outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [],
      },
      ...(workloadScope ? { workloadScope: {
        branchId: workloadScope["branchId"] as string,
        workloadClass: workloadScope["workloadClass"] as string,
      } } : {}),
      reservationAtomic,
      actualCostAtomic,
    },
  };
  return {
    projection,
    providerResult: {
      id: projection.id,
      content: projection.choices[0].message.content,
      usage: { inputTokens: promptTokens, outputTokens: completionTokens },
      providerCostUsd: `${BigInt(actualCostAtomic) / 1_000_000n}.${(BigInt(actualCostAtomic) % 1_000_000n).toString().padStart(6, "0")}`,
      providerModel: projection.model,
    },
  };
}

export async function performReliabilityReplayHttp(input: ReliabilityReplayHttpInput): Promise<{
  expectedCommitment: string;
  responseCommitment: string;
  response: ProviderResult;
}> {
  if (!input.laneCredential.trim()) throw new Error("REPLAY_LANE_CREDENTIAL_REQUIRED");
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.requestId)
    || !/^replay-[0-9a-f-]{16,80}$/i.test(input.operationId)) throw new Error("REPLAY_ID_INVALID");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": input.requestId,
    "X-Fuse-Replay-Operation": input.operationId,
    "X-Fuse-Mandate": input.mandateId,
    "X-Fuse-Branch": input.branchId,
    Authorization: `Bearer ${input.laneCredential}`,
  };
  const response = await (input.fetch ?? fetch)(`${input.baseUrl.replace(/\/$/, "")}${input.endpoint}`, {
    method: "POST",
    signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
    headers,
    body: JSON.stringify(input.body),
  });
  let bounded;
  try { bounded = await readBoundedBody(response, REPLAY_MAX_RESPONSE_BYTES); }
  catch (error) {
    if (error instanceof Error && error.message === "RESPONSE_BODY_OVERSIZED") throw new Error("REPLAY_RESPONSE_OVERSIZED");
    throw new Error("REPLAY_RESPONSE_TRUNCATED");
  }
  if (!response.ok) throw new Error(`REPLAY_HTTP_${response.status}`);
  let parsed: unknown;
  try { parsed = JSON.parse(bounded.bytes.toString("utf8")); }
  catch { throw new Error("REPLAY_RESPONSE_INVALID"); }
  const { projection, providerResult } = parseResponse(parsed);
  const responseCommitment = buildResponseCommitment(projection);
  if (responseCommitment !== input.expectedCommitment) throw new Error("REPLAY_COMMITMENT_MISMATCH");
  return { expectedCommitment: input.expectedCommitment, responseCommitment, response: providerResult };
}
