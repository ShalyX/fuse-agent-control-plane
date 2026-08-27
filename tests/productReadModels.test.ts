import { describe, expect, it } from "vitest";
import { projectProductExecution } from "../src/product/executionReadModel.js";
import { projectProductReceipt } from "../src/product/receiptReadModel.js";

function decision() {
  return {
    id: "decision-1", requestId: "request-1", organizationId: "workspace-1", mandateId: "mandate-1", agentId: "agent-1",
    policyId: "policy-1", policyVersion: 2,
    result: { outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: ["ALLOW"] },
    input: { estimatedCostAtomic: 100n },
  } as any;
}

describe("product execution and receipt read models", () => {
  it("projects a live execution without inferring settlement", () => {
    const execution = projectProductExecution({
      organizationId: "workspace-1", decision: decision(), mode: "live", status: "held",
      settlement: { requestId: "request-1", status: "reconciliation_hold", reservedCostAtomic: 100n, actualCostAtomic: null, failureCode: "UPSTREAM_AMBIGUOUS", resolved: false },
      evidence: { provider: "anthropic", model: "claude", branchId: "reviewer", workloadClass: "baseline", payment: { status: "pending_batch", facilitatorReference: "gateway-1" }, arc: { status: "pending", commitmentReference: null } },
    });
    expect(execution.costs).toEqual({ requestedAtomic: "100", reservedAtomic: "100", reportedAtomic: null, settledAtomic: null });
    expect(execution.payment).toEqual({ status: "pending_batch", facilitatorReference: "gateway-1" });
    expect(execution.arc).toEqual({ status: "pending", commitmentReference: null });
    expect(execution.status).toBe("held");
  });

  it("marks sandbox payment and chain evidence as not applicable", () => {
    const receipt = projectProductReceipt({ organizationId: "workspace-1", decision: decision(), mode: "sandbox", status: "completed" });
    expect(receipt.execution.mode).toBe("sandbox");
    expect(receipt.execution.payment).toEqual({ status: "not_applicable", facilitatorReference: null });
    expect(receipt.execution.arc).toEqual({ status: "not_applicable", commitmentReference: null });
  });

  it("exposes verified Arc evidence only when supplied explicitly", () => {
    const receipt = projectProductReceipt({
      organizationId: "workspace-1", decision: decision(), mode: "live", status: "completed",
      evidence: { payment: { status: "settled", facilitatorReference: "gateway-1" }, arc: { status: "verified", commitmentReference: "arc-commitment-1" } },
    });
    expect(receipt.execution.payment.status).toBe("settled");
    expect(receipt.execution.arc).toEqual({ status: "verified", commitmentReference: "arc-commitment-1" });
  });
});
