import { describe, expect, it } from "vitest";
import { MandateManagementService } from "../src/product/mandateManagement.js";
import type { PolicyAdministrationPort } from "../src/policy/policyAdministration.js";

const principal = {
  credentialId: "credential-1",
  principalType: "service_account" as const,
  principalId: "operator-1",
  organizationId: "workspace-1",
  capabilities: ["mandates:admin"] as const,
  role: "admin" as const,
};

describe("MandateManagementService", () => {
  it("creates a workspace-scoped draft mandate with a request id", async () => {
    const calls: unknown[] = [];
    const administration = {
      async createMandate(receivedPrincipal: unknown, input: unknown) {
        calls.push({ receivedPrincipal, input });
      },
    } as Pick<PolicyAdministrationPort, "createMandate">;
    const service = new MandateManagementService(administration as PolicyAdministrationPort);

    await service.createMandate(principal, {
      mandateId: "mandate-1",
      name: "Primary",
      assetId: "usd-micros",
      maximumSpendAtomic: "250000",
      policyId: "policy-1",
      policyVersion: 1,
      expiresAt: null,
      requestId: "request-1",
    });

    expect(calls).toEqual([{
      receivedPrincipal: principal,
      input: expect.objectContaining({
        mandateId: "mandate-1",
        maximumSpendAtomic: 250000n,
        requestId: "request-1",
      }),
    }]);
  });

  it("returns the created branch without exposing a mutable authority copy", async () => {
    const branch = {
      id: "branch-1",
      mandateId: "mandate-1",
      organizationId: "workspace-1",
      parentBranchId: null,
      agentId: "agent-1",
      allowedWorkloadClasses: ["lookup"],
      maximumSpendAtomic: 60000n,
      expiresAt: null,
      delegationHash: "hash-1",
    };
    const administration = {
      async createBranch() { return branch; },
    } as Pick<PolicyAdministrationPort, "createBranch">;
    const service = new MandateManagementService(administration as PolicyAdministrationPort);

    const result = await service.createBranch(principal, {
      mandateId: "mandate-1",
      branchId: "branch-1",
      parentBranchId: null,
      agentId: "agent-1",
      allowedWorkloadClasses: ["lookup"],
      maximumSpendAtomic: "60000",
      expiresAt: null,
      requestId: "request-2",
    });

    expect(result).toEqual(branch);
    expect(result).not.toBe(branch);
  });
});
