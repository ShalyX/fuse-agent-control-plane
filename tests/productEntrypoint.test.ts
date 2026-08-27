import { describe, expect, it } from "vitest";
import { ProductApiError, ProductClient, type ProductReceipt, type ProductTransport } from "../src/product/index.js";

describe("public product entrypoint", () => {
  it("exports the consumer client and product read-model types", () => {
    expect(ProductClient).toBeTypeOf("function");
    expect(ProductApiError).toBeTypeOf("function");
    const receipt: ProductReceipt = {
      decisionId: "decision-1", requestId: "request-1", workspaceId: "workspace-1", mandateId: "mandate-1",
      agentId: "agent-1", policyId: "policy-1", policyVersion: 1, outcome: "ALLOW", wouldOutcome: "ALLOW",
      enforced: true, reasonCodes: [], estimatedCostAtomic: "1", reservedCostAtomic: null,
      actualCostAtomic: null, executionStatus: null, failureCode: null, reconciliationResolved: false,
    };
    expect(receipt.requestId).toBe("request-1");
  });

  it("keeps the transport injectable through the public entrypoint", () => {
    const transport: ProductTransport = { async request<T>() { return {} as T; } };
    expect(new ProductClient({ baseUrl: "https://fuse.test", token: "token", transport })).toBeInstanceOf(ProductClient);
  });
});
