import { describe, expect, it } from "vitest";
import { PolicyPublishingService } from "../src/product/policyPublishing.js";
import type { PolicyAdministrationPort } from "../src/policy/policyAdministration.js";

const principal = {
  credentialId: "credential-1", principalType: "service_account" as const,
  principalId: "operator-1", organizationId: "workspace-1",
  capabilities: ["policies:write"] as const, role: "admin" as const,
};

describe("PolicyPublishingService", () => {
  it("converts JSON atomic strings before publishing a policy", async () => {
    let captured: unknown;
    const administration = {
      async publishPolicy(_principal: unknown, input: unknown) { captured = input; },
    } as unknown as PolicyAdministrationPort;
    const service = new PolicyPublishingService(administration);

    await service.publish(principal, {
      policyId: "policy-1", version: 1, mode: "enforce",
      allowedProviders: ["anthropic"], allowedModels: ["claude-sonnet-4-6"],
      requiredCapability: "inference:invoke", requestId: "request-1",
      limits: {
        maxPerCallAtomic: "10000", maxHourlyAtomic: "50000", maxDailyAtomic: "250000",
        maxRequestsPerMinute: 30, maxInputTokens: 20000, maxOutputTokens: 4000,
      },
      workloadClasses: [{
        id: "lookup", maxCostPerCallAtomic: "10000", maxInvocationsPerBranch: 20,
        aggregateBudgetAtomic: "60000", minimumInputTokens: 1,
        shadow: { classPriorWindowSpendAtomic: "3000", windowSeconds: 900,
          targetMinimumObservations: 3, siblingMinimumForScoring: 2,
          siblingMinimumForIntervention: 3, confidenceConstant: 5, divergenceThresholdBps: 30000 },
      }],
    });

    expect(captured).toMatchObject({
      requestId: "request-1", limits: { maxPerCallAtomic: 10000n, maxDailyAtomic: 250000n },
      workloadClasses: [{ maxCostPerCallAtomic: 10000n, aggregateBudgetAtomic: 60000n,
        shadow: { classPriorWindowSpendAtomic: 3000n } }],
    });
  });
});
