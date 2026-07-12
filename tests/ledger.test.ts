import { describe, expect, it } from "vitest";
import { FuseLedger } from "../src/core/ledger.js";

describe("FuseLedger", () => {
  it("reserves against both child and root budgets, then reconciles actual spend", () => {
    const ledger = new FuseLedger({
      mandateId: "mandate-1",
      maximumSpendMicros: 250_000n,
      children: {
        scout: 60_000n,
        builder: 120_000n,
        reviewer: 50_000n,
      },
    });

    const reservation = ledger.reserve("scout", 20_000n, "request-1");
    expect(reservation.maximumMicros).toBe(20_000n);
    expect(ledger.snapshot().root.availableMicros).toBe(230_000n);
    expect(ledger.snapshot().children.scout.availableMicros).toBe(40_000n);

    ledger.reconcile("request-1", 11_391n);
    expect(ledger.snapshot().root.settledMicros).toBe(11_391n);
    expect(ledger.snapshot().root.reservedMicros).toBe(0n);
    expect(ledger.snapshot().children.scout.availableMicros).toBe(48_609n);
  });

  it("reclaims a tripped child's unspent allowance into the parent pool", () => {
    const ledger = new FuseLedger({
      mandateId: "m1",
      maximumSpendMicros: 250_000n,
      children: { scout: 60_000n, builder: 120_000n, reviewer: 50_000n },
    });
    ledger.reserve("scout", 40_000n, "s1");
    ledger.reconcile("s1", 31_500n);

    expect(ledger.snapshot().parentUnallocatedMicros).toBe(20_000n);
    expect(ledger.reclaimAvailable("scout")).toBe(28_500n);
    const snapshot = ledger.snapshot();
    expect(snapshot.parentUnallocatedMicros).toBe(48_500n);
    expect(snapshot.children.scout).toMatchObject({
      authorizedMicros: 31_500n,
      availableMicros: 0n,
    });
  });

  it("rejects child allocations above the root budget", () => {
    expect(() => new FuseLedger({
      mandateId: "mandate-2",
      maximumSpendMicros: 100_000n,
      children: { scout: 80_000n, builder: 80_000n },
    })).toThrowError("CHILD_ALLOCATIONS_EXCEED_ROOT");
  });

  it("returns an existing reservation for an idempotent request", () => {
    const ledger = new FuseLedger({
      mandateId: "mandate-3",
      maximumSpendMicros: 100_000n,
      children: { scout: 50_000n },
    });

    const first = ledger.reserve("scout", 10_000n, "same-request");
    const second = ledger.reserve("scout", 10_000n, "same-request");
    expect(second).toEqual(first);
    expect(ledger.snapshot().root.reservedMicros).toBe(10_000n);
  });
});
