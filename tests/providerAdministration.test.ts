import { expect, it } from "vitest";
import { ProviderAdministration } from "../src/providers/providerAdministration.js";

it("derives provider configuration tenant and actor from the admin principal", async () => {
  const calls: unknown[] = [];
  const admin = new ProviderAdministration({
    async configure(input) { calls.push(input); return input as never; },
    async list(organizationId) { calls.push({ organizationId }); return []; },
  }, () => "2026-07-19T16:00:00.000Z");
  const principal = {
    principalType: "service_account" as const,
    principalId: "admin-1",
    organizationId: "org-customer-zero",
    credentialId: "credential-1",
    capabilities: ["providers:read", "providers:write"] as const,
    role: "admin" as const,
  };

  await admin.configure(principal, {
    configId: "primary", provider: "anthropic", model: "claude-sonnet-4-6",
    apiKey: "sk-ant-secret",
    inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00", requestId: "request-1",
  });
  await admin.list(principal);

  expect(calls).toEqual([
    {
      id: "primary", organizationId: "org-customer-zero", provider: "anthropic",
      model: "claude-sonnet-4-6", apiKey: "sk-ant-secret",
      inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "service_account:admin-1", causationId: "request-1",
      occurredAt: "2026-07-19T16:00:00.000Z",
    },
    { organizationId: "org-customer-zero" },
  ]);
});

it("rejects non-admin provider configuration even with the capability", async () => {
  const admin = new ProviderAdministration({
    async configure() { throw new Error("unexpected"); },
    async list() { return []; },
  });
  await expect(admin.configure({
    principalType: "service_account", principalId: "operator-1", organizationId: "org-1",
    credentialId: "credential-1", capabilities: ["providers:write"], role: "operator",
  }, {
    configId: "primary", provider: "anthropic", model: "claude-sonnet-4-6",
    apiKey: "secret", inputUsdPerMillion: "3", outputUsdPerMillion: "15",
    requestId: "request-1",
  })).rejects.toThrow("SERVICE_ACCOUNT_ADMIN_REQUIRED");
});
