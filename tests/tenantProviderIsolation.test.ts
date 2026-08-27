import { expect, it } from "vitest";
import type { InferenceProvider } from "../src/core/service.js";
import { TenantProviderResolver } from "../src/providers/tenantProviderResolver.js";

it("rejects a provider configuration returned for a different workspace", async () => {
  const provider = { complete: async () => ({
    id: "result", content: "ok", usage: { inputTokens: 1, outputTokens: 1 },
  }) } satisfies InferenceProvider;
  const resolver = new TenantProviderResolver({
    async resolve() {
      return {
        id: "primary", organizationId: "workspace-other", provider: "anthropic" as const,
        model: "claude-sonnet-4-6",
        inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
        credentialVersion: 1, status: "active" as const,
        updatedAt: "2026-08-14T00:00:00.000Z", apiKey: "secret",
        requireProviderCost: false, requireProviderModelMatch: false,
      };
    },
  }, {
    anthropic: () => provider,
    openrouter: () => provider,
  });

  await expect(resolver.resolve("workspace-requested")).rejects.toThrow("PROVIDER_CONFIGURATION_TENANT_MISMATCH");
});
