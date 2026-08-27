import { describe, expect, it, vi } from "vitest";
import { verifyOpenRouterCredential } from "../src/providers/openRouterCredentialVerifier.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenRouter credential verification", () => {
  it("uses the authenticated models endpoint and verifies the configured model", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/models");
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
      return response({ data: [{ id: "anthropic/claude-sonnet-4.6" }] });
    });

    await expect(verifyOpenRouterCredential({
      apiKey: "test-key",
      model: "anthropic/claude-sonnet-4.6",
      fetch: fetcher,
    })).resolves.toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-4.6" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails closed when the configured model is unavailable", async () => {
    await expect(verifyOpenRouterCredential({
      apiKey: "test-key",
      model: "missing/model",
      fetch: async () => response({ data: [{ id: "other/model" }] }),
    })).rejects.toThrow("OPENROUTER_MODEL_UNAVAILABLE");
  });

  it("maps upstream auth failure without exposing the response body", async () => {
    await expect(verifyOpenRouterCredential({
      apiKey: "test-key",
      model: "other/model",
      fetch: async () => response({ error: { message: "secret upstream detail" } }, 401),
    })).rejects.toThrow("OPENROUTER_CREDENTIAL_INVALID");
  });
});
