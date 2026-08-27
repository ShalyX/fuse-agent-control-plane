import { describe, expect, it } from "vitest";
import { MandateManagementService } from "../src/product/mandateManagement.js";
import type { PolicyAdministrationPort } from "../src/policy/policyAdministration.js";

const principal = {
  credentialId: "credential-1", principalType: "service_account" as const,
  principalId: "operator-1", organizationId: "workspace-1",
  capabilities: ["mandates:admin"] as const, role: "admin" as const,
};

it("rejects negative product atomic amounts before policy administration", async () => {
  let called = false;
  const administration = {
    async createMandate() { called = true; },
  } as unknown as PolicyAdministrationPort;
  const service = new MandateManagementService(administration);

  await expect(service.createMandate(principal, {
    mandateId: "mandate-1", name: "Primary", assetId: "usd-micros",
    maximumSpendAtomic: "-1", policyId: "policy-1", policyVersion: 1,
    expiresAt: null, requestId: "request-1",
  })).rejects.toThrow("PRODUCT_ATOMIC_AMOUNT_INVALID");
  expect(called).toBe(false);
});
