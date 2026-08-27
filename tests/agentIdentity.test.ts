import { describe, expect, it } from "vitest";
import { AgentIdentityService } from "../src/product/agentIdentity.js";
import type { CredentialAdministrationPort } from "../src/identity/credentialAdministration.js";

const principal = {
  credentialId: "credential-1", principalType: "service_account" as const,
  principalId: "operator-1", organizationId: "workspace-1",
  capabilities: ["agents:write", "credentials:issue"] as const, role: "admin" as const,
};

describe("AgentIdentityService", () => {
  it("registers an agent with the authenticated workspace and request id", async () => {
    let captured: unknown;
    const administration = { async registerAgent(_principal: unknown, input: unknown) { captured = input; } } as unknown as CredentialAdministrationPort;
    const service = new AgentIdentityService(administration);
    await service.registerAgent(principal, { agentId: "agent-1", name: "Builder", requestId: "request-1" });
    expect(captured).toEqual({ agentId: "agent-1", name: "Builder", requestId: "request-1" });
  });

  it("returns a newly issued credential exactly once to the product caller", async () => {
    const issued = { credentialId: "credential-2", token: "fuse_sk_secret", tokenPrefix: "fuse_sk_",
      capabilities: ["inference:invoke"], expiresAt: null };
    const administration = { async issueAgentCredential() { return issued; } } as unknown as CredentialAdministrationPort;
    const service = new AgentIdentityService(administration);
    const result = await service.issueCredential(principal, {
      credentialId: "credential-2", agentId: "agent-1", name: "Runtime",
      capabilities: ["inference:invoke"], requestId: "request-2",
    });
    expect(result).toEqual(issued);
  });
});
