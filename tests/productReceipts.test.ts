import { describe, expect, it } from "vitest";
import { ProductReceiptService } from "../src/product/receipts.js";

const principal = { principalType: "agent" as const, principalId: "agent-1", organizationId: "workspace-1", credentialId: "credential-1", capabilities: ["receipts:read"] as const };

describe("ProductReceiptService", () => {
  it("projects decisions into a secret-free product receipt", async () => {
    const service = new ProductReceiptService({
      async listDecisions(organizationId, mandateId) {
        expect(organizationId).toBe("workspace-1");
        expect(mandateId).toBe("mandate-1");
        return [{
          id: "decision-1", requestId: "request-1", organizationId, mandateId,
          agentId: "agent-1", policyId: "policy-1", policyVersion: 2,
          result: { outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [] },
          input: { estimatedCostAtomic: 123n },
        } as any];
      },
    });
    const result = await service.list(principal, "mandate-1");
    expect(result).toEqual([{
      decisionId: "decision-1", requestId: "request-1", workspaceId: "workspace-1",
      mandateId: "mandate-1", agentId: "agent-1", policyId: "policy-1", policyVersion: 2,
      outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [],
      estimatedCostAtomic: "123", reservedCostAtomic: null, actualCostAtomic: null,
      executionStatus: null, failureCode: null, reconciliationResolved: false, payment: null,
    }]);
    expect(JSON.stringify(result)).not.toMatch(/secret|token|prompt|message/i);
  });

  it("joins settled and held execution state by request id", async () => {
    const service = new ProductReceiptService({
      async listDecisions() {
        return [
          { id: "decision-complete", requestId: "request-complete", organizationId: "workspace-1", mandateId: "mandate-1", agentId: "agent-1", policyId: "policy-1", policyVersion: 1, result: { outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [] }, input: { estimatedCostAtomic: 100n } },
          { id: "decision-hold", requestId: "request-hold", organizationId: "workspace-1", mandateId: "mandate-1", agentId: "agent-1", policyId: "policy-1", policyVersion: 1, result: { outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [] }, input: { estimatedCostAtomic: 200n } },
        ] as any;
      },
      async listExecutionSettlements() {
        return [
          { requestId: "request-complete", status: "completed", reservedCostAtomic: 100n, actualCostAtomic: 87n, failureCode: null, resolved: false },
          { requestId: "request-hold", status: "reconciliation_hold", reservedCostAtomic: 200n, actualCostAtomic: null, failureCode: "PROVIDER_RESPONSE_MISSING", resolved: false },
        ];
      },
    });
    const result = await service.list(principal, "mandate-1");
    expect(result.map(({ requestId, reservedCostAtomic, actualCostAtomic, executionStatus, failureCode }) => ({ requestId, reservedCostAtomic, actualCostAtomic, executionStatus, failureCode }))).toEqual([
      { requestId: "request-complete", reservedCostAtomic: "100", actualCostAtomic: "87", executionStatus: "completed", failureCode: null },
      { requestId: "request-hold", reservedCostAtomic: "200", actualCostAtomic: null, executionStatus: "reconciliation_hold", failureCode: "PROVIDER_RESPONSE_MISSING" },
    ]);
  });

  it("projects scoped verified payment evidence without exposing the raw payload", async () => {
    const service = new ProductReceiptService({
      async listDecisions() {
        return [{ id: "decision-paid", requestId: "request-paid", organizationId: "workspace-1", mandateId: "mandate-1", agentId: "agent-1", policyId: "policy-1", policyVersion: 1, result: { outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [] }, input: { estimatedCostAtomic: 200n } }] as any;
      },
      async listPaymentEvidence() {
        return [{ requestId: "request-paid", organizationId: "workspace-1", actualCostAtomic: "141", recordedAt: "2026-08-15T00:00:00.000Z", payment: { verified: true, transaction: "tx-1", network: "eip155:8453", payer: "0xpayer", secret: "must-not-escape" } }];
      },
    });
    const result = await service.list(principal, "mandate-1");
    expect(result[0]?.payment).toEqual({ verified: true, transactionId: "tx-1", network: "eip155:8453", payer: "0xpayer" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns one receipt by request id and distinguishes missing receipts", async () => {
    const service = new ProductReceiptService({
      async listDecisions() {
        return [{ id: "decision-1", requestId: "request-target", organizationId: "workspace-1", mandateId: "mandate-1", agentId: "agent-1", policyId: "policy-1", policyVersion: 1, result: { outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [] }, input: { estimatedCostAtomic: 50n } }] as any;
      },
      async listExecutionSettlements() {
        return [{ requestId: "request-target", status: "reconciliation_hold", reservedCostAtomic: 50n, actualCostAtomic: null, failureCode: "PROVIDER_RESPONSE_MISSING", resolved: false }];
      },
    });
    const receipt = await service.get(principal, "mandate-1", "request-target");
    expect(receipt.executionStatus).toBe("reconciliation_hold");
    await expect(service.get(principal, "mandate-1", "request-missing")).rejects.toThrow("RECEIPT_NOT_FOUND");
  });

  it("limits agents to their own receipts while operators retain workspace visibility", async () => {
    const service = new ProductReceiptService({
      async listDecisions() {
        return ["agent-1", "agent-2"].map((agentId, index) => ({
          id: `decision-${index}`, requestId: `request-${index}`, organizationId: "workspace-1", mandateId: "mandate-1", agentId,
          policyId: "policy-1", policyVersion: 1, result: { outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [] }, input: { estimatedCostAtomic: 10n },
        })) as any;
      },
    });
    expect((await service.list(principal, "mandate-1")).map((receipt) => receipt.agentId)).toEqual(["agent-1"]);
    const operator = { ...principal, principalType: "service_account" as const, principalId: "operator-1", capabilities: ["receipts:read"] as const, role: "operator" as const };
    expect((await service.list(operator, "mandate-1")).map((receipt) => receipt.agentId)).toEqual(["agent-1", "agent-2"]);
    await expect(service.get(principal, "mandate-1", "request-1")).rejects.toThrow("RECEIPT_NOT_FOUND");
  });

  it("uses a keyset-capable query adapter and emits v2 cursors", async () => {
    const service = new ProductReceiptService({
      async listDecisions() { return []; },
      async listDecisionsPage(_organizationId, _mandateId, limit, cursor) {
        expect(limit).toBe(2);
        if (!cursor) {
          return { decisions: [{ id: "decision-1", requestId: "request-1", organizationId: "workspace-1", mandateId: "mandate-1", agentId: "agent-1", policyId: "policy-1", policyVersion: 1, result: { outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [] }, input: { estimatedCostAtomic: 10n } }] as any, hasMore: true, nextCursor: { decidedAt: "2026-08-11T00:00:00.000Z", id: "decision-1" } };
        }
        expect(cursor).toEqual({ decidedAt: "2026-08-11T00:00:00.000Z", id: "decision-1" });
        return { decisions: [], hasMore: false, nextCursor: null };
      },
      async listExecutionSettlementsForRequests() { return []; },
    });
    const first = await service.listPage(principal, "mandate-1", { limit: 2 });
    expect(first.nextCursor).toBeTruthy();
    const second = await service.listPage(principal, "mandate-1", { limit: 2, cursor: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
  });

  it("uses direct decision lookup for a single receipt", async () => {
    let listed = false;
    const service = new ProductReceiptService({
      async listDecisions() { listed = true; return []; },
      async getDecision() { return { id: "decision-direct", requestId: "request-direct", organizationId: "workspace-1", mandateId: "mandate-1", agentId: "agent-1", policyId: "policy-1", policyVersion: 1, result: { outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [] }, input: { estimatedCostAtomic: 11n } } as any; },
      async listExecutionSettlementsForRequests() { return []; },
    });
    const receipt = await service.get(principal, "mandate-1", "request-direct");
    expect(receipt.requestId).toBe("request-direct");
    expect(listed).toBe(false);
  });

  it("enforces page-size and cursor validation without a page adapter", async () => {
    const service = new ProductReceiptService({
      async listDecisions() {
        return [0, 1, 2].map((index) => ({ id: `decision-${index}`, requestId: `request-${index}`, organizationId: "workspace-1", mandateId: "mandate-1", agentId: "agent-1", policyId: "policy-1", policyVersion: 1, result: { outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [] }, input: { estimatedCostAtomic: 10n } })) as any;
      },
    });
    const first = await service.listPage(principal, "mandate-1", { limit: 2 });
    expect(first.receipts.map((receipt) => receipt.requestId)).toEqual(["request-0", "request-1"]);
    expect(first.nextCursor).toBeNull();
    await expect(service.listPage(principal, "mandate-1", { limit: 2, cursor: "invalid" })).rejects.toThrow("INVALID_RECEIPT_CURSOR");
    await expect(service.listPage(principal, "mandate-1", { limit: 101 })).rejects.toThrow("INVALID_RECEIPT_PAGE_SIZE");
    await expect(service.listPage(principal, "mandate-1", { cursor: "invalid" })).rejects.toThrow("INVALID_RECEIPT_CURSOR");
  });
});
