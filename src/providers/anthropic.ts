import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, InferenceProvider } from "../core/service.js";

export class AnthropicProvider implements InferenceProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: CompletionRequest) {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" as const : "user" as const,
        content: message.content,
      }));

    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxOutputTokens,
      system: system || undefined,
      messages,
    });
    const content = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      id: response.id,
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
