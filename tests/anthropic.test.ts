import { expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";

it("calls the official Anthropic Messages API and uses provider-reported usage", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    id: "msg_official",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "text", text: "Fuse official Anthropic response" },
      { type: "thinking", thinking: "hidden" },
    ],
    usage: { input_tokens: 123, output_tokens: 17 },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const provider = new AnthropicProvider({
    apiKey: "official-anthropic-key",
    model: "claude-sonnet-4-6",
    fetch: fetcher,
  });

  const result = await provider.complete({
    requestId: "req-official",
    childId: "scout",
    model: "obsolete-client-model",
    inputTokens: 100,
    maxOutputTokens: 64,
    messages: [{ role: "user", content: "Hello" }],
  });

  expect(result).toEqual({
    id: "msg_official",
    content: "Fuse official Anthropic response",
    usage: { inputTokens: 123, outputTokens: 17 },
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.anthropic.com/v1/messages",
    expect.objectContaining({
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": "official-anthropic-key",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello" }],
      }),
    }),
  );
});

it("returns a sanitized error when Anthropic sends a non-JSON response", async () => {
  const provider = new AnthropicProvider({
    apiKey: "official-anthropic-key",
    model: "claude-sonnet-4-6",
    fetch: vi.fn(async () => new Response("upstream proxy page", { status: 502 })),
  });

  await expect(provider.complete({
    requestId: "req-error",
    childId: "scout",
    model: "ignored",
    inputTokens: 1,
    maxOutputTokens: 8,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("ANTHROPIC_502: upstream request failed");
});
