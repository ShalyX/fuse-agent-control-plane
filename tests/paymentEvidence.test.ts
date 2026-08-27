import { describe, expect, it } from "vitest";
import { MemoryPaymentEvidenceStore } from "../src/product/paymentEvidence.js";

const evidence = (payment: unknown, recordedAt = "2026-08-15T00:00:00.000Z") => ({
  requestId: "request-1",
  organizationId: "workspace-1",
  actualCostAtomic: "1000",
  payment,
  recordedAt,
});

describe("payment evidence durability boundary", () => {
  it("replays identical evidence without changing the stored record", async () => {
    const store = new MemoryPaymentEvidenceStore();
    await store.record(evidence({ status: "settled", txHash: "0xabc" }));
    await expect(store.record(evidence({ status: "settled", txHash: "0xabc" }))).resolves.toBeUndefined();
    expect(store.records.get("workspace-1:request-1")).toMatchObject({
      actualCostAtomic: "1000",
      payment: { status: "settled", txHash: "0xabc" },
    });
  });

  it("rejects conflicting evidence for an already recorded request", async () => {
    const store = new MemoryPaymentEvidenceStore();
    await store.record(evidence({ status: "pending_batch", txHash: null }));
    await expect(store.record(evidence({ status: "settled", txHash: "0xabc" })))
      .rejects.toThrow("PAYMENT_EVIDENCE_CONFLICT");
    expect(store.records.get("workspace-1:request-1")?.payment).toEqual({ status: "pending_batch", txHash: null });
  });

  it("isolates identical request IDs across workspaces", async () => {
    const store = new MemoryPaymentEvidenceStore();
    await store.record(evidence({ verified: true, transaction: "tx-a" }));
    await store.record({ ...evidence({ verified: true, transaction: "tx-b" }), organizationId: "workspace-2" });

    await expect(store.get("workspace-1", "request-1")).resolves.toMatchObject({
      organizationId: "workspace-1", payment: { transaction: "tx-a" },
    });
    await expect(store.get("workspace-2", "request-1")).resolves.toMatchObject({
      organizationId: "workspace-2", payment: { transaction: "tx-b" },
    });
    await expect(store.get("workspace-3", "request-1")).resolves.toBeNull();
    await expect(store.listForRequests("workspace-1", ["request-1"])).resolves.toHaveLength(1);
    await expect(store.listForRequests("workspace-2", ["request-1"])).resolves.toHaveLength(1);
  });
});
