import { describe, expect, it } from "vitest";
import { buildSetupReadiness } from "../src/product/setupReadiness.js";

describe("setup readiness", () => {
  it("reports the workspace as incomplete without claiming payment readiness", () => {
    const result = buildSetupReadiness(
      { organizationId: "org-a" },
      {
        database: true,
        providerConfiguration: false,
        signerConfiguration: false,
        walletChain: false,
        gatewayEnvironment: false,
        sandbox: true,
      },
    );

    expect(result).toEqual({
      workspaceId: "org-a",
      status: "incomplete",
      checks: {
        database: "verified",
        provider: "unavailable",
        signer: "unavailable",
        wallet: "unavailable",
        gateway: "unavailable",
        sandbox: "verified",
      },
      missingSteps: [
        "Connect a provider",
        "Configure the signer boundary",
        "Verify the wallet chain",
        "Align the Gateway environment",
      ],
    });
  });

  it("isolates readiness to the authenticated workspace", () => {
    const result = buildSetupReadiness(
      { organizationId: "org-b" },
      {
        database: true,
        providerConfiguration: true,
        signerConfiguration: true,
        walletChain: true,
        gatewayEnvironment: true,
        sandbox: true,
      },
    );

    expect(result.workspaceId).toBe("org-b");
    expect(result.status).toBe("ready");
    expect(result.missingSteps).toEqual([]);
  });

  it.each([
    ["database", "Restore the durable database connection"],
    ["sandbox", "Restore the durable sandbox run store"],
  ] as const)("fails closed when %s is unavailable", (check, action) => {
    const input = {
      database: true, providerConfiguration: true, signerConfiguration: true,
      walletChain: true, gatewayEnvironment: true, sandbox: true,
    };
    input[check] = false;
    const result = buildSetupReadiness({ organizationId: "org-c" }, input);
    expect(result.status).toBe("incomplete");
    expect(result.missingSteps).toContain(action);
  });
});
