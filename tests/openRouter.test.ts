import { expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../src/providers/openRouter.js";

it("calls OpenRouter chat completions and uses provider-reported usage", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    id: "gen-openrouter-1",
    object: "chat.completion",
    model: "anthropic/claude-sonnet-4.6",
    choices: [{
      finish_reason: "stop",
      native_finish_reason: "stop",
      message: { role: "assistant", content: "Fuse OpenRouter response" },
    }],
    usage: {
      prompt_tokens: 123,
      completion_tokens: 17,
      total_tokens: 140,
      cost: 0.000624,
    },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const provider = new OpenRouterProvider({
    apiKey: "openrouter-key",
    model: "anthropic/claude-sonnet-4.6",
    siteUrl: "https://fuse-agent-control-plane.vercel.app",
    appName: "Fuse",
    fetch: fetcher,
  });

  const result = await provider.complete({
    requestId: "req-openrouter",
    childId: "scout",
    model: "obsolete-client-model",
    inputTokens: 100,
    maxOutputTokens: 64,
    messages: [
      { role: "system", content: "Be concise" },
      { role: "user", content: "Hello" },
    ],
  });

  expect(result).toEqual({
    id: "gen-openrouter-1",
    content: "Fuse OpenRouter response",
    usage: { inputTokens: 123, outputTokens: 17 },
    providerCostUsd: "0.000624",
    providerModel: "anthropic/claude-sonnet-4.6",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://openrouter.ai/api/v1/chat/completions",
    expect.objectContaining({
      method: "POST",
      headers: {
        Authorization: "Bearer openrouter-key",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://fuse-agent-control-plane.vercel.app",
        "X-OpenRouter-Title": "Fuse",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.6",
        max_tokens: 64,
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Hello" },
        ],
      }),
    }),
  );
});

it("returns a sanitized completion error when OpenRouter reports a choice-level failure", async () => {
  const provider = new OpenRouterProvider({
    apiKey: "openrouter-key",
    model: "anthropic/claude-sonnet-4.6",
    fetch: vi.fn(async () => new Response(JSON.stringify({
      id: "gen-openrouter-error",
      choices: [{
        error: {
          code: 429,
          message: "sensitive upstream provider detail",
          metadata: { raw: "must not leak" },
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    }), { status: 200, headers: { "content-type": "application/json" } })),
  });

  await expect(provider.complete({
    requestId: "req-choice-error",
    childId: "scout",
    model: "ignored",
    inputTokens: 1,
    maxOutputTokens: 8,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("OPENROUTER_COMPLETION_ERROR");
});

it("rejects invalid provider usage instead of inventing or accepting token counts", async () => {
  const provider = new OpenRouterProvider({
    apiKey: "openrouter-key",
    model: "anthropic/claude-sonnet-4.6",
    fetch: vi.fn(async () => new Response(JSON.stringify({
      id: "gen-openrouter-invalid-usage",
      choices: [{ message: { role: "assistant", content: "response" } }],
      usage: { prompt_tokens: -1, completion_tokens: 3, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } })),
  });

  await expect(provider.complete({
    requestId: "req-invalid-usage",
    childId: "scout",
    model: "ignored",
    inputTokens: 1,
    maxOutputTokens: 8,
    messages: [{ role: "user", content: "Hello" }],
  })).rejects.toThrow("OPENROUTER_INVALID_RESPONSE");
});
