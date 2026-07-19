import { expect, it } from "vitest";
import type { InferenceProvider } from "../src/core/service.js";
import { TenantProviderResolver } from "../src/providers/tenantProviderResolver.js";

it("builds an execution binding from the authenticated tenant configuration", async () => {
  const provider = { complete: async () => ({
    id: "result", content: "ok", usage: { inputTokens: 1, outputTokens: 1 },
  }) } satisfies InferenceProvider;
  const observed: Record<string, unknown>[] = [];
  const resolver = new TenantProviderResolver({
    async resolve(organizationId: string) {
      expect(organizationId).toBe("org-customer-zero");
      return {
        id: "primary", organizationId, provider: "anthropic" as const,
        model: "claude-sonnet-4-6",
        inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
        credentialVersion: 2, status: "active" as const,
        updatedAt: "2026-07-19T16:00:00.000Z", apiKey: "sk-ant-secret",
        requireProviderCost: false, requireProviderModelMatch: false,
      };
    },
  }, {
    anthropic: (options) => { observed.push(options); return provider; },
    openrouter: () => { throw new Error("wrong factory"); },
  });

  const binding = await resolver.resolve("org-customer-zero");

  expect(binding).toEqual({
    provider,
    providerName: "anthropic",
    model: "claude-sonnet-4-6",
    price: { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" },
    requireProviderCost: false,
    requireProviderModelMatch: false,
  });
  expect(observed).toEqual([{
    apiKey: "sk-ant-secret", model: "claude-sonnet-4-6",
  }]);
});
