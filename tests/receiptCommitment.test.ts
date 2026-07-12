import { describe, expect, it } from "vitest";
import { buildReceiptCommitment } from "../src/core/receiptCommitment.js";

const receipts = [
  {
    sequence: 2,
    requestId: "req-2",
    childId: "scout",
    inputTokens: 320,
    outputTokens: 6,
    costAtomic: "1050",
    authorizationHash: "auth-2",
    circuitState: "ELEVATED",
  },
  {
    sequence: 1,
    requestId: "req-1",
    childId: "scout",
    inputTokens: 30,
    outputTokens: 6,
    costAtomic: "180",
    authorizationHash: "auth-1",
    circuitState: "HEALTHY",
  },
];

describe("receipt commitment", () => {
  it("sorts receipts and produces a deterministic keccak256 commitment", () => {
    const first = buildReceiptCommitment("mandate-1", receipts);
    const reversed = buildReceiptCommitment("mandate-1", [...receipts].reverse());

    expect(first).toEqual(reversed);
    expect(first.bundle.version).toBe(1);
    expect(first.bundle.receipts.map((receipt) => receipt.sequence)).toEqual([1, 2]);
    expect(first.totalPaidAtomic).toBe(1230n);
    expect(first.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when a committed receipt field changes", () => {
    const first = buildReceiptCommitment("mandate-1", receipts);
    const changed = buildReceiptCommitment("mandate-1", receipts.map((receipt) =>
      receipt.sequence === 2 ? { ...receipt, costAtomic: "1051" } : receipt));

    expect(changed.hash).not.toBe(first.hash);
    expect(changed.totalPaidAtomic).toBe(1231n);
  });

  it("rejects duplicate sequences and non-canonical atomic values", () => {
    expect(() => buildReceiptCommitment("mandate-1", [receipts[0], { ...receipts[1], sequence: 2 }]))
      .toThrow("DUPLICATE_RECEIPT_SEQUENCE");
    expect(() => buildReceiptCommitment("mandate-1", [{ ...receipts[0], costAtomic: "001050" }]))
      .toThrow("INVALID_COST_ATOMIC");
  });
});
