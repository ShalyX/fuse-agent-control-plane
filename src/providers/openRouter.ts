import type { CompletionRequest, InferenceProvider } from "../core/service.js";
import { readBoundedBody } from "../reliability/boundedBody.js";

type OpenRouterResponse = {
  id?: string; model?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null }; error?: { code?: number; message?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};
const MAX_RESPONSE_BYTES = 1_048_576;
function isValidTokenCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

export type OpenRouterFailurePhase = "dispatch_hook" | "http_dispatch" | "response_body" | "response_parse" | "response_validation";
export class OpenRouterTransportError extends Error {
  override readonly name = "OpenRouterTransportError";
  constructor(public readonly code: string, public readonly phase: OpenRouterFailurePhase, public readonly primitiveEntered: boolean, public readonly status?: number, public readonly generationId?: string) {
    super(code);
  }
}

export class OpenRouterProvider implements InferenceProvider {
  constructor(private readonly config: { apiKey: string; model: string; baseUrl?: string; siteUrl?: string; appName?: string; fetch?: typeof fetch; timeoutMs?: number }) {}

  async complete(request: CompletionRequest) {
    const fetcher = this.config.fetch ?? fetch;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" };
    if (!request.suppressAttributionHeaders && this.config.siteUrl) headers["HTTP-Referer"] = this.config.siteUrl;
    if (!request.suppressAttributionHeaders && this.config.appName) headers["X-OpenRouter-Title"] = this.config.appName;
    const body = JSON.stringify({ model: this.config.model, max_tokens: request.maxOutputTokens, messages: request.messages, provider: { allow_fallbacks: false } });

    let primitiveEntered = false;
    if (request.onDispatchPrimitiveEntered) {
      try { await request.onDispatchPrimitiveEntered(); }
      catch { throw new OpenRouterTransportError("OPENROUTER_DISPATCH_HOOK_FAILED", "dispatch_hook", false); }
    }
    primitiveEntered = true;
    let response: Response;
    try {
      response = await fetcher(`${this.config.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
        method: "POST", headers, body, signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
      });
    } catch { throw new OpenRouterTransportError("OPENROUTER_HTTP_DISPATCH_FAILED", "http_dispatch", primitiveEntered); }

    let text: string;
    try { text = (await readBoundedBody(response, MAX_RESPONSE_BYTES)).bytes.toString("utf8"); }
    catch (error) { throw new OpenRouterTransportError(error instanceof Error && error.message === "RESPONSE_BODY_OVERSIZED" ? "OPENROUTER_RESPONSE_OVERSIZED" : "OPENROUTER_RESPONSE_TRUNCATED", "response_body", true, response.status); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new OpenRouterTransportError("OPENROUTER_RESPONSE_MALFORMED", "response_parse", true, response.status); }
    const value = parsed && typeof parsed === "object" ? parsed as OpenRouterResponse : {};
    const generationId = typeof value.id === "string" ? value.id : undefined;
    if (!response.ok) throw new OpenRouterTransportError(`OPENROUTER_${response.status}`, "response_validation", true, response.status, generationId);
    if (value.choices?.[0]?.error) throw new OpenRouterTransportError("OPENROUTER_COMPLETION_ERROR", "response_validation", true, response.status, generationId);
    const choice = value.choices?.[0];
    const content = choice?.message?.content;
    const inputTokens = value.usage?.prompt_tokens;
    const outputTokens = value.usage?.completion_tokens;
    if (!generationId || typeof value.model !== "string" || value.model !== this.config.model || typeof content !== "string"
      || !["stop", "length"].includes(choice?.finish_reason ?? "")
      || !isValidTokenCount(inputTokens) || !isValidTokenCount(outputTokens)) {
      throw new OpenRouterTransportError("OPENROUTER_INVALID_RESPONSE", "response_validation", true, response.status, generationId);
    }
    const providerCost = value.usage?.cost;
    if (providerCost === undefined || !Number.isFinite(providerCost) || providerCost < 0) {
      throw new OpenRouterTransportError("OPENROUTER_INVALID_COST", "response_validation", true, response.status, generationId);
    }
    return { id: generationId, content, usage: { inputTokens, outputTokens }, providerCostUsd: String(providerCost), providerModel: value.model };
  }
}
