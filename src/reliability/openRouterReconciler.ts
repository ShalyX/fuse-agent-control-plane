import { canonicalJson } from "../evidence/heldOutReliabilityV2.js";
import { classifyReconciliationContent, type ReconciliationDisposition } from "../evidence/reliabilityProtocolV2.js";
import { readBoundedBody } from "./boundedBody.js";

const MAX_BYTES = 1_048_576;
type Evidence = { parsed: unknown; status: number; bodyBase64: string; bytes: number; sha256: string };

async function json(response: Response): Promise<Evidence> {
  let body;
  try { body = await readBoundedBody(response, MAX_BYTES); }
  catch (error) { throw new Error(error instanceof Error && error.message === "RESPONSE_BODY_OVERSIZED" ? "RECONCILIATION_RESPONSE_OVERSIZED" : "RECONCILIATION_RESPONSE_TRUNCATED"); }
  let parsed: unknown;
  try { parsed = JSON.parse(body.bytes.toString("utf8")); } catch { throw new Error("RECONCILIATION_RESPONSE_INVALID"); }
  return { parsed, status: response.status, bodyBase64: body.bytes.toString("base64"), bytes: body.bytes.length, sha256: body.sha256 };
}
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function has(value: Record<string, any>, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function nullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function nullableCount(value: unknown): boolean { return value === null || (Number.isSafeInteger(value) && Number(value) >= 0); }

/** Converts an OpenRouter decimal USD value to integral micros without binary arithmetic. */
export function decimalUsdToMicros(value: string | number): bigint {
  const text = typeof value === "number" ? value.toString() : value;
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("PROVIDER_COST_DECIMAL_INVALID");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) throw new Error("PROVIDER_COST_PRECISION_INVALID");
  const micros = BigInt(whole!) * 1_000_000n + BigInt((fraction.slice(0, 6) + "000000").slice(0, 6));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PROVIDER_COST_RANGE_INVALID");
  return micros;
}

export interface ReconciliationLookupInput {
  generationId: string; openRouterRequestId?: string | null; model: string;
  messages?: readonly { role: string; content: string }[]; input?: string;
  dispatchTokenAt?: string; ambiguityEnteredAt?: string; finalOffset: boolean;
}

export class OpenRouterReconciler {
  constructor(private readonly config: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number }) {}
  async reconcile(input: ReconciliationLookupInput): Promise<{ disposition: ReconciliationDisposition; metadata: Evidence; content: Evidence }> {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.generationId)) throw new Error("GENERATION_ID_INVALID");
    const fetcher = this.config.fetch ?? fetch;
    const base = this.config.baseUrl ?? "https://openrouter.ai/api/v1";
    const operationTimeout = Math.min(this.config.timeoutMs ?? 55_000, 55_000);
    const controller = new AbortController();
    const operationTimer = setTimeout(() => controller.abort(new Error("RECONCILIATION_OPERATION_TIMEOUT")), operationTimeout);
    const headers = { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json" };
    const get = (path: string) => fetcher(`${base}${path}`, { method: "GET", headers, signal: controller.signal });
    try {
      const [metadataResponse, contentResponse] = await Promise.all([
        get(`/generation?id=${encodeURIComponent(input.generationId)}`),
        get(`/generation/content?id=${encodeURIComponent(input.generationId)}`),
      ]);
      const [metadataEvidence, contentEvidence] = await Promise.all([json(metadataResponse), json(contentResponse)]);
      if ([metadataResponse.status, contentResponse.status].some((status) => status === 401 || status === 403)) {
        return { disposition: "global_failure", metadata: metadataEvidence, content: contentEvidence };
      }
      const metadataRoot = record(metadataEvidence.parsed); const metadata = record(metadataRoot.data);
      const contentRoot = record(contentEvidence.parsed); const content = record(contentRoot.data);
      const required = ["id","request_id","model","provider_name","created_at","cancelled","finish_reason","native_finish_reason","native_tokens_prompt","native_tokens_completion","tokens_prompt","tokens_completion","total_cost","usage","upstream_id","router","provider_responses"];
      const requiredPresent = required.every((key) => has(metadata, key));
      let totalCostMicros = -1; let usageCostMicros = -2;
      try { totalCostMicros = Number(decimalUsdToMicros(metadata.total_cost)); usageCostMicros = Number(decimalUsdToMicros(metadata.usage)); } catch { /* pending */ }
      const createdAt = Date.parse(String(metadata.created_at ?? ""));
      const lower = input.dispatchTokenAt ? Date.parse(input.dispatchTokenAt) - 300_000 : Number.NEGATIVE_INFINITY;
      const upper = input.ambiguityEnteredAt ? Date.parse(input.ambiguityEnteredAt) + 300_000 : Number.POSITIVE_INFINITY;
      const requestBound = input.openRouterRequestId ? metadata.request_id === input.openRouterRequestId : typeof metadata.request_id === "string" && metadata.request_id.length > 0;
      const tokenPairsAgree = (!Number.isInteger(metadata.native_tokens_prompt) || !Number.isInteger(metadata.tokens_prompt) || metadata.native_tokens_prompt === metadata.tokens_prompt)
        && (!Number.isInteger(metadata.native_tokens_completion) || !Number.isInteger(metadata.tokens_completion) || metadata.native_tokens_completion === metadata.tokens_completion);
      const metadataValid = metadataResponse.status === 200 && requiredPresent && metadata.id === input.generationId && requestBound
        && metadata.model === input.model && typeof metadata.provider_name === "string" && metadata.provider_name.length > 0
        && typeof metadata.upstream_id === "string" && metadata.upstream_id.length > 0
        && (metadata.router === null || (typeof metadata.router === "string" && metadata.router.length > 0))
        && (metadata.provider_responses === null || Array.isArray(metadata.provider_responses))
        && typeof metadata.cancelled === "boolean" && nullableString(metadata.finish_reason) && nullableString(metadata.native_finish_reason)
        && nullableCount(metadata.native_tokens_prompt) && nullableCount(metadata.native_tokens_completion)
        && nullableCount(metadata.tokens_prompt) && nullableCount(metadata.tokens_completion) && tokenPairsAgree
        && Number.isFinite(createdAt) && createdAt >= lower && createdAt <= upper;
      const inputMessages = record(content.input).messages; const output = record(content.output);
      const inputMatches = Array.isArray(inputMessages) && canonicalJson(inputMessages) === canonicalJson(input.messages ?? []);
      const exact404Error = contentResponse.status === 404 && !has(contentRoot, "data")
        && typeof record(contentRoot.error).message === "string" && record(contentRoot.error).message.length > 0;
      const disposition = classifyReconciliationContent({ metadataStatus: metadataResponse.status, contentStatus: contentResponse.status,
        finalOffset: input.finalOffset, cancelled: metadata.cancelled === true, totalCostMicros, usageCostMicros,
        model: metadataValid ? String(metadata.model) : "", finishReason: typeof metadata.finish_reason === "string" ? metadata.finish_reason : null,
        tokenCountsValid: metadataValid && Number.isSafeInteger(metadata.tokens_prompt) && metadata.tokens_prompt >= 0
          && Number.isSafeInteger(metadata.tokens_completion) && metadata.tokens_completion >= 0,
        inputMatches, completion: has(output, "completion") && (typeof output.completion === "string" || output.completion === null) ? output.completion : undefined,
        reasoning: has(output, "reasoning") && (typeof output.reasoning === "string" || output.reasoning === null) ? output.reasoning : "invalid",
        generationIdBound: metadataValid, exact404Error });
      return { disposition, metadata: metadataEvidence, content: contentEvidence };
    } finally { clearTimeout(operationTimer); }
  }
}
