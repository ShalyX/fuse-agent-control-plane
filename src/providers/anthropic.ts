import type { CompletionRequest, InferenceProvider } from "../core/service.js";

type AnthropicResponse = {
  id?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

export class AnthropicProvider implements InferenceProvider {
  constructor(private readonly config: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {}

  async complete(request: CompletionRequest) {
    const fetcher = this.config.fetch ?? fetch;
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));
    const payload: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: request.maxOutputTokens,
      messages,
    };
    if (system) payload.system = system;

    const response = await fetcher(`${this.config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": this.config.apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
    });
    let body: AnthropicResponse | undefined;
    try {
      body = await response.json() as AnthropicResponse;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      throw new Error(`ANTHROPIC_${response.status}: ${body?.error?.message ?? "upstream request failed"}`);
    }
    const content = body?.content
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    const inputTokens = body?.usage?.input_tokens;
    const outputTokens = body?.usage?.output_tokens;
    if (!body?.id || content === undefined
      || typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0
      || typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
      throw new Error("ANTHROPIC_INVALID_RESPONSE");
    }
    return {
      id: body.id,
      content,
      usage: { inputTokens, outputTokens },
    };
  }
}
