import { expect, it, vi } from "vitest";
import { AgentRouterProvider } from "../src/providers/agentRouter.js";

it("calls AgentRouter with its mandatory user agent and normalizes usage", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    id: "msg-router",
    choices: [{ message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 93, completion_tokens: 13, total_tokens: 106 },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const provider = new AgentRouterProvider({
    apiKey: "secret",
    baseUrl: "https://agentrouter.org/v1",
    userAgent: "claude-cli/2.0.0 (external, cli)",
    fetch: fetcher,
  });

  const result = await provider.complete({
    requestId: "req",
    childId: "scout",
    model: "claude-opus-4-8",
    inputTokens: 100,
    maxOutputTokens: 64,
    messages: [{ role: "user", content: "Hello" }],
  });

  expect(result).toEqual({
    id: "msg-router",
    content: "ok",
    usage: { inputTokens: 93, outputTokens: 13 },
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://agentrouter.org/v1/chat/completions",
    expect.objectContaining({
      headers: expect.objectContaining({
        "user-agent": "claude-cli/2.0.0 (external, cli)",
      }),
    }),
  );
});
