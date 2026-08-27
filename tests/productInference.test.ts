import { describe, expect, it } from "vitest";
import { ProductInferenceService } from "../src/product/inference.js";

const agent = { principalType: "agent" as const, principalId: "agent-1", organizationId: "workspace-1", credentialId: "credential-1", capabilities: ["inference:invoke"] as const };

describe("ProductInferenceService", () => {
  it("derives workspace, agent, credential, and capabilities from the authenticated principal", async () => {
    let captured: any;
    const service = new ProductInferenceService({ async execute(input) { captured = input; return { status: "in_progress" }; } });
    const result = await service.execute(agent, {
      requestId: "request-1", mandateId: "mandate-1", inputTokens: 10, maxOutputTokens: 20,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.status).toBe("in_progress");
    expect(captured).toMatchObject({ organizationId: "workspace-1", agentId: "agent-1", credentialId: "credential-1", agentCapabilities: ["inference:invoke"] });
  });

  it("rejects service-account principals before inference execution", async () => {
    const service = new ProductInferenceService({ async execute() { throw new Error("should not execute"); } });
    await expect(service.execute({ ...agent, principalType: "service_account" }, {
      requestId: "request-1", mandateId: "mandate-1", inputTokens: 1, maxOutputTokens: 1, messages: [],
    })).rejects.toThrow("AGENT_CREDENTIAL_REQUIRED");
  });
});
