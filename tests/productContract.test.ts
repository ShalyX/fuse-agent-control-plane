import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contract = readFileSync(new URL("../docs/product/api-contract.md", import.meta.url), "utf8");

describe("product API contract", () => {
  it("documents the authenticated product surfaces and stable receipt errors", () => {
    for (const marker of [
      "GET /api/v1/product/readiness",
      "POST /agents",
      "POST /agent-credentials",
      "POST /provider-connections",
      "POST /policies",
      "POST /mandates",
      "POST /inference",
      "POST /sandbox/runs",
      "GET /mandates/:mandateId/receipts",
      "GET /receipts/:requestId",
      "INVALID_RECEIPT_CURSOR",
      "RECEIPT_NOT_FOUND",
      "reconciliation_hold",
      "settledAtomic",
      "not_applicable",
    ]) {
      expect(contract).toContain(marker);
    }
  });

  it("documents the non-negotiable product invariants", () => {
    expect(contract).toContain("workspace identity from authentication");
    expect(contract).toContain("does not create a second balance or ledger");
    expect(contract).toContain("does not authorize signing");
    expect(contract).toContain("Clients must treat cursors as opaque");
  });
});
