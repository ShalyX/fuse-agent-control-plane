import type { CompletionRequest, InferenceProvider } from "../core/service.js";

type RouterResponse = {
  id?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
};

export class AgentRouterProvider implements InferenceProvider {
  constructor(private readonly config: {
    apiKey: string;
    baseUrl: string;
    userAgent: string;
    fetch?: typeof fetch;
  }) {}

  async complete(request: CompletionRequest) {
    const fetcher = this.config.fetch ?? fetch;
    const response = await fetcher(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        "user-agent": this.config.userAgent,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        messages: request.messages,
      }),
    });
    const body = await response.json() as RouterResponse;
    if (!response.ok) {
      throw new Error(`AGENTROUTER_${response.status}: ${body.error?.message ?? "request failed"}`);
    }
    const inputTokens = body.usage?.prompt_tokens ?? body.usage?.input_tokens;
    const outputTokens = body.usage?.completion_tokens ?? body.usage?.output_tokens;
    const content = body.choices?.[0]?.message?.content;
    if (!body.id || content === undefined || inputTokens === undefined || outputTokens === undefined) {
      throw new Error("AGENTROUTER_INVALID_RESPONSE");
    }
    return {
      id: body.id,
      content,
      usage: { inputTokens, outputTokens },
    };
  }
}
