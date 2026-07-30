import { describe, expect, it } from "vitest";
import {
  authoritativeSnapshotDigest,
  runAuthoritativeSettlement,
  type SettlementTransactionPrimitives,
} from "../src/evidence/authoritativeSettlement.js";
import {
  expectedReliabilityArtifactPaths,
  reduceAuthoritativeReliabilityEvidence,
  type AuthoritativeEvidenceInventory,
} from "../src/evidence/authoritativeEvidence.js";

function settlementPrimitives(completesAt: number | null) {
  let clock = 1_000_000;
  const calls: Array<{ isolationLevel: string; readOnly: boolean; startDeadlineMs: number; queryDeadlineMs: number }> = [];
  const primitives: SettlementTransactionPrimitives = {
    nowMs: () => clock,
    sleepUntil: async (at) => { clock = Math.max(clock, at); },
    transaction: async (options, operation) => {
      calls.push(options);
      const databaseStartedAtMs = clock;
      const value = await operation({});
      clock += 10;
      return { value, databaseStartedAtMs, queryFinishedAtMs: clock };
    },
  };
  let query = 0;
  return {
    calls,
    primitives,
    readSnapshot: async () => {
      const offset = query++ * 5;
      return { complete: offset === completesAt, rows: { attempts: [{ requestId: "b" }, { requestId: "a" }] } };
    },
  };
}

describe("authoritative settlement", () => {
  it("uses bounded repeatable-read read-only snapshots and stops at the first complete poll", async () => {
    const fixture = settlementPrimitives(10);
    const result = await runAuthoritativeSettlement({ runId: "run-1", primitives: fixture.primitives, readSnapshot: fixture.readSnapshot });
    expect(result.passed).toBe(true);
    expect(result.acceptedOffsetSeconds).toBe(10);
    expect(result.journal).toHaveLength(3);
    expect(result.finalSnapshot.journalCardinality).toBe(3);
    expect(result.acceptedSnapshot).toMatchObject({ databaseStartedAtMs: 1_010_000 });
    expect(result.acceptedSnapshot?.rows).toEqual({ attempts: [{ requestId: "b" }, { requestId: "a" }] });
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.calls.every((call) => call.isolationLevel === "REPEATABLE READ" && call.readOnly)).toBe(true);
    expect(fixture.calls.every((call) => call.queryDeadlineMs - call.startDeadlineMs === 30_000)).toBe(true);
  });

  it("runs all offsets 0 through 120 when no complete snapshot exists", async () => {
    const fixture = settlementPrimitives(null);
    const result = await runAuthoritativeSettlement({ runId: "run-2", primitives: fixture.primitives, readSnapshot: fixture.readSnapshot });
    expect(result.passed).toBe(false);
    expect(result.journal.map((poll) => poll.offsetSeconds)).toEqual(Array.from({ length: 25 }, (_, index) => index * 5));
    expect(result.finalSnapshot.journalCardinality).toBe(25);
  });

  it("rejects a snapshot whose database start or query finish misses its deadline", async () => {
    let clock = 0;
    const primitives: SettlementTransactionPrimitives = {
      nowMs: () => clock,
      sleepUntil: async (at) => { clock = at; },
      transaction: async (_options, operation) => {
        const value = await operation({});
        return { value, databaseStartedAtMs: 120_001, queryFinishedAtMs: 150_002 };
      },
    };
    const result = await runAuthoritativeSettlement({ runId: "late", primitives, readSnapshot: async () => ({ complete: true, rows: { attempts: [] } }) });
    expect(result.passed).toBe(false);
    expect(result.journal).toHaveLength(25);
    expect(result.journal.every((poll) => !poll.deadlineEligible)).toBe(true);
  });

  it("digests key-sorted inventories independent of row and object key order", () => {
    expect(authoritativeSnapshotDigest({ b: [{ z: 2, a: 1 }], a: [{ id: "2" }, { id: "1" }] }))
      .toEqual(authoritativeSnapshotDigest({ a: [{ id: "1" }, { id: "2" }], b: [{ a: 1, z: 2 }] }));
  });
});

const lanes = ["normal-paced", "high-envelope", "bounded-burst", "restart-resume"] as const;
function passingEvidence(): AuthoritativeEvidenceInventory {
  const runId = "run-evidence";
  const planFingerprint = "sha256:" + "a".repeat(64);
  const requestIds = Array.from({ length: 100 }, (_, index) => `r-${String(index + 1).padStart(3, "0")}`);
  const replayIds = requestIds.slice(0, 20);
  const attempts = requestIds.map((requestId) => ({ requestId, state: "completed_verified" as const, gateClassificationCount: 1, admissionStarted: true, actualCostMicros: "1", reservedCostMicros: "10000" }));
  return {
    runId, planFingerprint, requestIds, replayTargetRequestIds: replayIds,
    attempts,
    executions: requestIds.map((requestId) => ({ requestId, status: "completed" as const, actualCostMicros: "1", shadowOrderState: "queued" as const, cohortOrdinal: 1 })),
    decisions: requestIds.map((requestId) => ({ requestId, outcome: "ALLOW" as const })),
    dispatchTokens: requestIds.map((requestId) => ({ requestId, primitiveEntered: true, preDispatchProof: false })),
    shadowQueue: requestIds.map((requestId) => ({ requestId, state: "completed" as const, attempts: 1 })),
    shadowEvidence: requestIds.map((requestId) => ({ requestId })),
    replayAudits: replayIds.map((requestId, index) => ({ requestId, replayNo: index + 1, originalResponseCommitment: `sha256:${"b".repeat(64)}`, replayResponseCommitment: `sha256:${"b".repeat(64)}`, writeSet: [] })),
    authorizationReceipts: [
      { kind: "operator", status: "consumed", path: `evidence/held-out-reliability/authorization-receipts/operator/${runId}.json` },
      { kind: "reconciliation", status: "validated", path: `evidence/held-out-reliability/authorization-receipts/reconciliation/${runId}.json` },
    ],
    signedAuthorizations: [
      { kind: "operator", path: `evidence/held-out-reliability/authorizations/operator/${runId}.json` },
      { kind: "reconciliation", path: `evidence/held-out-reliability/authorizations/reconciliation/${runId}.json` },
    ],
    claims: lanes.map((lane) => ({ lane, terminal: true, path: `evidence/.run-claims/held-out-reliability/${runId}/${lane}.claim` })),
    manifests: lanes.flatMap((lane) => Array.from({ length: 5 }, (_, index) => ({ lane, block: index + 1, terminal: true, digest: `sha256:${String(index).padStart(64, "0")}`, path: `evidence/held-out-reliability/manifests/${runId}/${lane}-${index + 1}.json` }))),
    reconciliation: [], incidents: [],
    settlement: { passed: true, acceptedOffsetSeconds: 0, journalCardinality: 1, finalSnapshotDigest: `sha256:${"c".repeat(64)}`, finalRowCardinality: 100 },
    costs: { knownCostMicros: "100", unresolvedExposureMicros: "0", knownCostCapMicros: "3000000", unresolvedExposureCapMicros: "320000" },
    hardFinalization: { allTerminal: true, finalizedAt: "2026-07-28T09:29:00.000Z", deadline: "2026-07-28T09:30:00.000Z" },
    artifactPaths: expectedReliabilityArtifactPaths({ runId, planFingerprint, lanes, incidentPaths: [] }),
  };
}

describe("authoritative evidence reducer", () => {
  it("passes a complete authoritative inventory deterministically", () => {
    const input = passingEvidence();
    const first = reduceAuthoritativeReliabilityEvidence(input);
    const second = reduceAuthoritativeReliabilityEvidence(structuredClone(input));
    expect(first).toEqual(second);
    expect(first.passed).toBe(true);
    expect(first.reasons).toEqual([]);
    expect(first.counts).toMatchObject({ planned: 100, classified: 100, usable: 100, replayAudits: 20, claims: 4, manifests: 20 });
  });

  it("checks matrix cardinality, real replay write sets, receipts, settlement, caps, finalization, and exact paths", () => {
    const input = passingEvidence();
    input.attempts[0]!.gateClassificationCount = 2;
    input.executions.pop();
    input.replayAudits[0]!.writeSet.push("inference_executions:update");
    input.authorizationReceipts[0]!.status = "valid_not_consumed_peer_invalid";
    input.manifests[0]!.terminal = false;
    input.settlement.passed = false;
    input.costs.knownCostMicros = "3000001";
    input.hardFinalization.finalizedAt = "2026-07-28T09:31:00.000Z";
    input.artifactPaths.push("evidence/held-out-reliability/unexpected.json");
    const report = reduceAuthoritativeReliabilityEvidence(input);
    expect(report.passed).toBe(false);
    expect(report.reasons).toEqual(expect.arrayContaining([
      "CLASSIFICATION_CARDINALITY_INVALID", "OUTCOME_MATRIX_INVALID", "REPLAY_WRITE_SET_NOT_EMPTY",
      "AUTHORIZATION_RECEIPTS_INVALID", "MANIFEST_INVENTORY_INVALID", "SETTLEMENT_INVALID",
      "KNOWN_COST_CAP_EXCEEDED", "HARD_FINALIZATION_INVALID", "ARTIFACT_PATH_INVENTORY_INVALID",
    ]));
  });

  it("fails the exact 98-usable/two-nonusable counterexample", () => {
    const input = passingEvidence();
    for (const index of [98, 99]) {
      const requestId = input.requestIds[index]!;
      input.attempts[index] = { ...input.attempts[index]!, state: "reconciled_billed_no_response", actualCostMicros: "5" };
      input.executions[index] = { requestId, status: "failed", actualCostMicros: "5", shadowOrderState: null, cohortOrdinal: null };
      input.shadowQueue = input.shadowQueue.filter((row) => row.requestId !== requestId);
      input.shadowEvidence = input.shadowEvidence.filter((row) => row.requestId !== requestId);
      input.reconciliation.push({ requestId, accepted: true, terminalState: "reconciled_billed_no_response" });
    }
    input.replayTargetRequestIds = input.requestIds.slice(0, 20);
    input.costs.knownCostMicros = "108";
    const report = reduceAuthoritativeReliabilityEvidence(input);
    expect(report.passed).toBe(false);
    expect(report.counts.usable).toBe(98);
    expect(report.reasons).toEqual(expect.arrayContaining(["USABLE_OUTCOMES_INVALID", "NONUSABLE_ALLOWANCE_EXCEEDED"]));
  });

  it("enforces non-usable and unresolved outcome matrix rows", () => {
    const input = passingEvidence();
    const index = 99;
    const requestId = input.requestIds[index]!;
    input.attempts[index] = { ...input.attempts[index]!, state: "reconciled_billed_no_response", actualCostMicros: "5" };
    input.executions[index] = { requestId, status: "failed", actualCostMicros: "5", shadowOrderState: null, cohortOrdinal: null };
    input.shadowQueue = input.shadowQueue.filter((row) => row.requestId !== requestId);
    input.shadowEvidence = input.shadowEvidence.filter((row) => row.requestId !== requestId);
    input.reconciliation.push({ requestId, accepted: true, terminalState: "reconciled_billed_no_response" });
    input.costs.knownCostMicros = "104";
    expect(reduceAuthoritativeReliabilityEvidence(input).passed).toBe(true);
    input.shadowEvidence.push({ requestId });
    expect(reduceAuthoritativeReliabilityEvidence(input).reasons).toContain("OUTCOME_MATRIX_INVALID");
  });
});
