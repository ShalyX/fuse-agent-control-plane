import { describe, expect, it } from "vitest";
import { buildProductReadiness } from "../src/product/productReadiness.js";

describe("product readiness", () => {
  it("reports a fully configured customer-direct control workspace as ready", () => {
    const result = buildProductReadiness({ organizationId: "workspace-control" }, {
      paymentMode: "control",
      database: true, providerConfiguration: true, policyConfiguration: true,
      agentCredential: true, mandate: true, signerConfiguration: false,
      walletChain: false, gatewayEnvironment: false, sandbox: true,
    });

    expect(result.status).toBe("ready");
    expect(result.checks).toMatchObject({
      signer: "not_applicable", wallet: "not_applicable", gateway: "not_applicable",
    });
    expect(result.missingSteps).toEqual([]);
  });

  it.each([
    ["database", "Restore the durable database connection"],
    ["sandbox", "Restore the durable sandbox run store"],
  ] as const)("does not report ready when %s is unavailable", (check, action) => {
    const input = {
      paymentMode: "control" as const,
      database: true, providerConfiguration: true, policyConfiguration: true,
      agentCredential: true, mandate: true, signerConfiguration: false,
      walletChain: false, gatewayEnvironment: false, sandbox: true,
    };
    input[check] = false;

    const result = buildProductReadiness({ organizationId: "workspace-control" }, input);

    expect(result.status).toBe("incomplete");
    expect(result.missingSteps).toContain(action);
  });

  it("reports every product setup dimension and actionable steps", () => {
    const result = buildProductReadiness({ organizationId: "workspace-a" }, {
      paymentMode: "settlement",
      database: true, providerConfiguration: true, policyConfiguration: false,
      agentCredential: false, mandate: false, signerConfiguration: true,
      walletChain: true, gatewayEnvironment: true, sandbox: true,
    });
    expect(result.status).toBe("incomplete");
    expect(result.checks).toMatchObject({ database: "verified", provider: "configured", policy: "unavailable", agentCredential: "unavailable", mandate: "unavailable" });
    expect(result.missingSteps).toEqual(["Publish a policy", "Issue an agent credential", "Create a mandate"]);
  });

  it("does not include secrets or caller-selected workspace identifiers", () => {
    const result = buildProductReadiness({ organizationId: "workspace-authenticated" }, {
      paymentMode: "settlement",
      database: true, providerConfiguration: true, policyConfiguration: true,
      agentCredential: true, mandate: true, signerConfiguration: true,
      walletChain: true, gatewayEnvironment: true, sandbox: true,
    });
    expect(result.workspaceId).toBe("workspace-authenticated");
    expect(JSON.stringify(result)).not.toMatch(/secret|token|api.?key/i);
  });
});
