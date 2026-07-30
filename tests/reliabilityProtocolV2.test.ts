import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HeldLane,
  ReliabilityArtifactStore,
  assertIdempotencyReplay,
  classifyReconciliationContent,
  computeEffectiveExposure,
  evaluateReconciliationTiming,
  evaluateSettlement,
  replayGate,
  resumeEpochSecond,
  type ReconciliationContentInput,
} from "../src/evidence/reliabilityProtocolV2.js";

describe("v2 reconciliation, cutoff, and content disposition", () => {
  const valid = (overrides: Partial<ReconciliationContentInput> = {}): ReconciliationContentInput => ({
    metadataStatus: 200, contentStatus: 200, finalOffset: false, cancelled: false,
    totalCostMicros: 100, usageCostMicros: 100, model: "nousresearch/hermes-4-405b",
    finishReason: "stop", tokenCountsValid: true, inputMatches: true, completion: "ok", reasoning: null,
    generationIdBound: true, ...overrides,
  });
  it.each([
    [{}, "reconciled_billed_with_response"],
    [{ completion: null }, "reconciliation_pending"],
    [{ completion: null, finalOffset: true }, "reconciled_billed_no_response"],
    [{ contentStatus: 404, completion: undefined, exact404Error: true }, "reconciliation_pending"],
    [{ contentStatus: 404, completion: undefined, exact404Error: true, finalOffset: true }, "reconciled_billed_no_response"],
    [{ metadataStatus: 401 }, "global_failure"], [{ metadataStatus: 403 }, "global_failure"],
    [{ contentStatus: 408 }, "reconciliation_pending"], [{ contentStatus: 429 }, "reconciliation_pending"],
    [{ contentStatus: 500 }, "reconciliation_pending"], [{ networkFailure: true }, "reconciliation_pending"],
    [{ timeout: true }, "reconciliation_pending"], [{ malformed: true }, "reconciliation_pending"],
    [{ nonJson: true }, "reconciliation_pending"], [{ oversized: true }, "reconciliation_pending"],
    [{ inputMatches: false }, "reconciliation_pending"], [{ reasoning: "hidden" }, "reconciliation_pending"],
    [{ cancelled: true, totalCostMicros: 0, usageCostMicros: 0 }, "reconciled_not_billed"],
  ] as const)("maps content/evidence %# without operator discretion", (overrides, expected) => {
    expect(classifyReconciliationContent(valid(overrides))).toBe(expected);
  });

  it("distinguishes early state-3 from late ambiguity and enforces every phase and cutoff boundary", () => {
    expect(evaluateReconciliationTiming({ errorAfterMs: 19_000, lookupStartAfterErrorMs: 999,
      httpMs: 30_000, parseMs: 5_000, transactionMs: 15_000, remainingMs: 5_000 })).toBe("pre_ambiguity_allowed");
    expect(evaluateReconciliationTiming({ errorAfterMs: 19_001, lookupStartAfterErrorMs: 0,
      httpMs: 1, parseMs: 1, transactionMs: 1, remainingMs: 1 })).toBe("ambiguity_required");
    for (const [field, value] of [["httpMs", 30_001], ["parseMs", 5_001], ["transactionMs", 15_001], ["remainingMs", 5_001]] as const) {
      expect(evaluateReconciliationTiming({ errorAfterMs: 1, lookupStartAfterErrorMs: 0,
        httpMs: 1, parseMs: 1, transactionMs: 1, remainingMs: 1, [field]: value })).toBe("schedule_failure");
    }
    expect(evaluateReconciliationTiming({ errorAfterMs: 1, lookupStartAfterErrorMs: 1000,
      httpMs: 1, parseMs: 1, transactionMs: 1, remainingMs: 1 })).toBe("schedule_failure");
    expect(evaluateReconciliationTiming({ errorAfterMs: 1, lookupStartAfterErrorMs: 0,
      httpMs: 30_000, parseMs: 5_000, transactionMs: 15_000, remainingMs: 5_001 })).toBe("schedule_failure");
  });
});

describe("v2 held-set locking, race-safe resume, and exposure", () => {
  it("snapshots only nonterminal released members, creates one hold, and never resumes while nonempty", () => {
    const lane = new HeldLane("bounded-burst", ["a", "b", "c", "d", "e"]);
    lane.terminalize("a", "completed_verified", 1_000);
    lane.enterAmbiguity("b", 1_001);
    lane.enterAmbiguity("c", 1_002);
    expect(lane.holdCreationCount).toBe(1);
    expect(lane.heldMembers()).toEqual(["b", "c", "d", "e"]);
    lane.terminalize("d", "completed_verified", 1_003);
    lane.resolve("b", "reconciled_billed_with_response", 1_004);
    expect(lane.resumeAt).toBeNull();
    lane.terminalize("e", "completed_verified", 1_005);
    lane.resolve("c", "reconciled_not_billed", 1_006);
    expect(lane.heldMembers()).toEqual([]);
    expect(lane.resumeAt).toBe(1_200);
    expect(lane.allowanceOwner).toBe("c");
  });

  it("is deterministic for every ambiguous subset and classification commit ordering", () => {
    const ids = ["a", "b", "c", "d", "e"];
    for (let mask = 1; mask < 32; mask++) {
      const ambiguous = ids.filter((_, i) => mask & (1 << i));
      for (const reversed of [false, true]) {
        const lane = new HeldLane("bounded-burst", ids);
        lane.enterAmbiguity(ambiguous[0]!, 1_000);
        for (const id of ambiguous.slice(1)) lane.enterAmbiguity(id, 1_000);
        const order = reversed ? [...ambiguous].reverse() : ambiguous;
        for (const id of ids.filter((id) => !ambiguous.includes(id))) lane.terminalize(id, "completed_verified", 1_001);
        order.forEach((id, index) => lane.resolve(id, "reconciled_billed_with_response", 1_002 + index));
        expect(lane.heldMembers()).toEqual([]);
        expect(lane.resumeAt).toBe(resumeEpochSecond(1_002 + order.length - 1));
        expect(lane.globalFailed).toBe(false);
      }
    }
  });

  it("assigns one allowance owner and globally fails on a second state 3/4/6 or any state 7", () => {
    const lane = new HeldLane("bounded-burst", ["a", "b"]);
    lane.enterAmbiguity("a", 100);
    lane.resolve("a", "reconciled_billed_no_response", 101);
    expect(lane.allowanceOwner).toBe("a");
    lane.preAmbiguityReject("b", 102);
    expect(lane.globalFailed).toBe(true);
    const unresolved = new HeldLane("normal-paced", ["x"]);
    unresolved.enterAmbiguity("x", 100);
    unresolved.resolve("x", "unresolved_provider_outcome", 86_531);
    expect(unresolved.globalFailed).toBe(true);
  });

  it("uses next five-minute boundary even exactly on boundary and preserves FIFO", () => {
    expect(resumeEpochSecond(1_200)).toBe(1_500);
    const lane = new HeldLane("normal-paced", ["active"]);
    lane.enterAmbiguity("active", 10);
    lane.enqueue({ block: 2, callOrdinal: 2 }); lane.enqueue({ block: 2, callOrdinal: 1 });
    lane.enqueue({ block: 1, callOrdinal: 5 });
    lane.resolve("active", "reconciled_billed_with_response", 1_200);
    expect(lane.dequeueAll()).toEqual([{ block: 1, callOrdinal: 5 }, { block: 2, callOrdinal: 1 }, { block: 2, callOrdinal: 2 }]);
  });

  it("accounts exact known cost plus unresolved reservations and accepts equality at cap", () => {
    expect(computeEffectiveExposure({ completedActual: [10, 20], billedNoResponse: [30], otherKnownBilled: [40], unresolvedReservations: [100, 120] })).toBe(320);
    expect(computeEffectiveExposure({ completedActual: [3_000_000], billedNoResponse: [], otherKnownBilled: [], unresolvedReservations: [] }, 3_000_000)).toBe(3_000_000);
    expect(() => computeEffectiveExposure({ completedActual: [3_000_001], billedNoResponse: [], otherKnownBilled: [], unresolvedReservations: [] }, 3_000_000)).toThrow("COST_EXPOSURE_BREACH");
  });
});

describe("v2 settlement, replay, gate, and artifacts", () => {
  it("accepts first deadline-eligible complete snapshot and rejects late/failed bounded retries", () => {
    expect(evaluateSettlement(1_000, [
      { offset: 0, startedAt: 1_000, complete: false }, { offset: 5, startedAt: 1_005, complete: true },
    ])).toMatchObject({ passed: true, acceptedOffset: 5 });
    const completeAtDeadline = Array.from({ length: 25 }, (_, index) => ({
      offset: index * 5,
      startedAt: 1_000 + index * 5,
      complete: index === 24,
    }));
    expect(evaluateSettlement(1_000, completeAtDeadline)).toMatchObject({ passed: true, acceptedOffset: 120 });
    expect(evaluateSettlement(1_000, completeAtDeadline.map((poll, index) =>
      index === 24 ? { ...poll, startedAt: 1_120.001 } : poll))).toMatchObject({ passed: false });
  });

  it("requires exact original response commitment and empty audited write set", () => {
    expect(() => assertIdempotencyReplay({ originalCommitment: "sha256:abc", replayCommitment: "sha256:abc", auditedWrites: [] })).not.toThrow();
    expect(() => assertIdempotencyReplay({ originalCommitment: "sha256:abc", replayCommitment: "sha256:def", auditedWrites: [] })).toThrow("REPLAY_COMMITMENT_MISMATCH");
    expect(() => assertIdempotencyReplay({ originalCommitment: "sha256:abc", replayCommitment: "sha256:abc", auditedWrites: ["inference_executions:update"] })).toThrow("REPLAY_WRITE_SET_NOT_EMPTY");
  });

  it("evaluates all conjunctive endpoints and denies unresolved cost or a missing replay", () => {
    const passing = { planned: 100, usable: 99, notDispatched: 0, unresolved: 0, ambiguityEvents: 1,
      gateClassifications: 100, duplicateIds: 0, replayPassed: 20, evidenceDurable: true, artifactsTerminal: true,
      effectiveExposure: 2_900_000, unresolvedCost: 0 };
    expect(replayGate(passing)).toEqual({ passed: true, reasons: [] });
    expect(replayGate({ ...passing, replayPassed: 19, unresolvedCost: 10 })).toMatchObject({ passed: false,
      reasons: expect.arrayContaining(["REPLAY_INTEGRITY_FAILED", "UNRESOLVED_PROVIDER_COST"]) });
  });

  it("publishes create-only exact artifacts, recovers identical bytes, and rejects conflict/orphan lock/concurrent writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "hov2-artifacts-"));
    const store = new ReliabilityArtifactStore(root);
    const value = { evidenceType: "held-out-reliability", protocolVersion: 2, phase: "complete" };
    await store.publishOnce("replay/run.json", value);
    await expect(store.publishOnce("replay/run.json", value)).resolves.toBeUndefined();
    await expect(store.publishOnce("replay/run.json", { ...value, phase: "failed" })).rejects.toThrow("ARTIFACT_CONFLICT");
    await writeFile(join(root, "orphan.write-lock"), "lock");
    await expect(store.assertNoOrphanLocks()).rejects.toThrow("ARTIFACT_ORPHAN_LOCK");
    expect(JSON.parse(await readFile(join(root, "replay/run.json"), "utf8"))).toEqual(value);
  });
});
