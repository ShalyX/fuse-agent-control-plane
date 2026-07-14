import type { CompletionRequest, InferenceProvider } from "../core/service.js";

type OpenRouterResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    error?: { code?: number; message?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
};

function isValidTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class OpenRouterProvider implements InferenceProvider {
  constructor(private readonly config: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    siteUrl?: string;
    appName?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {}

  async complete(request: CompletionRequest) {
    const fetcher = this.config.fetch ?? fetch;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.config.siteUrl) headers["HTTP-Referer"] = this.config.siteUrl;
    if (this.config.appName) headers["X-OpenRouter-Title"] = this.config.appName;

    const response = await fetcher(
      `${this.config.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: request.maxOutputTokens,
          messages: request.messages,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
      },
    );

    let body: OpenRouterResponse | undefined;
    try {
      body = await response.json() as OpenRouterResponse;
    } catch {
      body = undefined;
    }
    if (!response.ok) throw new Error(`OPENROUTER_${response.status}: upstream request failed`);
    if (body?.choices?.[0]?.error) throw new Error("OPENROUTER_COMPLETION_ERROR");

    const content = body?.choices?.[0]?.message?.content;
    const inputTokens = body?.usage?.prompt_tokens;
    const outputTokens = body?.usage?.completion_tokens;
    if (!body?.id || typeof content !== "string"
      || !isValidTokenCount(inputTokens) || !isValidTokenCount(outputTokens)) {
      throw new Error("OPENROUTER_INVALID_RESPONSE");
    }

    const providerCost = body.usage?.cost;
    if (providerCost !== undefined && (!Number.isFinite(providerCost) || providerCost < 0)) {
      throw new Error("OPENROUTER_INVALID_RESPONSE");
    }
    return {
      id: body.id,
      content,
      usage: { inputTokens, outputTokens },
      ...(providerCost === undefined ? {} : { providerCostUsd: String(providerCost) }),
      ...(typeof body.model === "string" ? { providerModel: body.model } : {}),
    };
  }
}
