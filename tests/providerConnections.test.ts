import { describe, expect, it } from "vitest";
import { ProviderConnectionService } from "../src/product/providerConnections.js";
import type { ProviderAdministrationPort } from "../src/providers/providerAdministration.js";

const principal = {
  principalType: "service_account" as const,
  principalId: "operator-a",
  organizationId: "workspace-a",
  credentialId: "credential-a",
  capabilities: ["providers:read", "providers:write"] as const,
  role: "admin" as const,
};

const summary = {
  id: "primary",
  organizationId: "workspace-a",
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  inputUsdPerMillion: "3.00",
  outputUsdPerMillion: "15.00",
  credentialVersion: 1,
  status: "active" as const,
  updatedAt: "2026-08-11T00:00:00.000Z",
};

describe("provider connection service", () => {
  it("connects a workspace provider through the existing administration boundary", async () => {
    const calls: unknown[] = [];
    const administration: ProviderAdministrationPort = {
      async configure(receivedPrincipal, input) {
        calls.push({ receivedPrincipal, input });
        return summary;
      },
      async list() { return [summary]; },
    };
    const service = new ProviderConnectionService(administration);

    const result = await service.connect(principal, {
      configId: "primary",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "provider-secret",
      inputUsdPerMillion: "3.00",
      outputUsdPerMillion: "15.00",
      requestId: "request-connect-1",
    });

    expect(result).toEqual(summary);
    expect(calls).toEqual([{
      receivedPrincipal: principal,
      input: {
        configId: "primary",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "provider-secret",
        inputUsdPerMillion: "3.00",
        outputUsdPerMillion: "15.00",
        requestId: "request-connect-1",
      },
    }]);
  });

  it("lists metadata without creating a second provider read path", async () => {
    const administration: ProviderAdministrationPort = {
      async configure() { return summary; },
      async list(receivedPrincipal) {
        expect(receivedPrincipal.organizationId).toBe("workspace-a");
        return [summary];
      },
    };
    const service = new ProviderConnectionService(administration);

    await expect(service.list(principal)).resolves.toEqual([summary]);
  });
});
