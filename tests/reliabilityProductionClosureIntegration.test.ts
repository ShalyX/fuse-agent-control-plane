import { describe, expect, it } from "vitest";
import * as runner from "../scripts/held-out-reliability-v2.js";
import { RELIABILITY_SCHEMA_SQL } from "../src/reliability/reliabilitySchema.js";
import * as storeModule from "../src/reliability/protocolStore.js";
import type { AuthoritativeEvidenceInventory } from "../src/evidence/authoritativeEvidence.js";
import { authoritativeSnapshotDigest } from "../src/evidence/authoritativeSettlement.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const lanes = ["normal-paced", "high-envelope", "bounded-burst", "restart-resume"];

describe("production evidence closure integration", () => {
  it("produces exactly one byte-authoritative terminal claim per lane", () => {
    const producer = (runner as Record<string, unknown>)["buildFourLaneClaimArtifacts"] as ((input: {
      runId: string; planFingerprint: string;
    }) => Array<{ lane: string; artifactKind: string; state: string; path: string }>) | undefined;
    expect(typeof producer).toBe("function");
    if (!producer) throw new Error("FOUR_LANE_CLAIM_PRODUCER_MISSING");
    const claims = producer({ runId: "run-1", planFingerprint: fingerprint });
    expect(claims.map((claim) => claim.lane)).toEqual(lanes);
    expect(claims).toHaveLength(4);
    expect(claims.every((claim) => claim.artifactKind === "lane_claim" && claim.state === "terminal")).toBe(true);
    expect(claims.map((claim) => claim.path)).toEqual(lanes.map((lane) => `evidence/.run-claims/held-out-reliability/run-1/${lane}.claim`));
  });

  it("exposes authoritative closure loading, byte coordinates, and one atomic hard finalizer", () => {
    const prototype = storeModule.ReliabilityProtocolStore.prototype as unknown as Record<string, unknown>;
    expect(typeof prototype["loadEvidenceClosureSnapshot"]).toBe("function");
    expect(typeof prototype["loadArtifactIncidentCoordinates"]).toBe("function");
    expect(typeof prototype["hardFinalizeReliabilityRun"]).toBe("function");
    expect(RELIABILITY_SCHEMA_SQL).toContain("accepted_database_started_at");
    expect(RELIABILITY_SCHEMA_SQL).toContain("snapshot_rows JSONB");
    expect(RELIABILITY_SCHEMA_SQL).toContain("reliability_failure_report_outbox");
  });

  it("rejects an accepted snapshot that omitted any authoritative inventory", async () => {
    const snapshotRows = { sealedCalls: [] };
    const database = { query: async () => ({ rows: [{ snapshot_digest: authoritativeSnapshotDigest(snapshotRows),
      accepted_database_started_at: new Date(1), snapshot_rows: snapshotRows, passed: true }] }) };
    const store = new storeModule.ReliabilityProtocolStore(database as never);
    await expect(store.loadEvidenceClosureSnapshot("run-1")).rejects.toThrow("ACCEPTED_SETTLEMENT_SNAPSHOT_INCOMPLETE");
  });

  it("uses finalEvidenceClosure as the production verdict for the 98-usable/two-nonusable counterexample", () => {
    const build = (runner as Record<string, unknown>)["buildProductionEvidenceReport"] as ((input: {
      closure: Record<string, unknown>;
      strictInventory: AuthoritativeEvidenceInventory;
      artifactDigests: Record<string, string>;
      artifactPaths: string[];
      claimInventoryAuthority: Record<string, unknown>;
    }) => { passed: boolean; reasons: string[]; strict: { counts: { usable: number } } }) | undefined;
    expect(typeof build).toBe("function");
    if (!build) throw new Error("PRODUCTION_FINAL_EVIDENCE_OPERATION_MISSING");
    const requestIds = Array.from({ length: 100 }, (_, index) => `r-${index + 1}`);
    const attempts = requestIds.map((requestId, index) => ({ requestId,
      state: index < 98 ? "completed_verified" as const : "reconciled_billed_no_response" as const,
      gateClassificationCount: 1, admissionStarted: true, actualCostMicros: "0", reservedCostMicros: "1" }));
    const closureRows = {
      sealedCalls: requestIds.map((requestId, index) => ({ requestId, lane: lanes[index % 4], block: Math.floor(index / 20) + 1, callOrdinal: Math.floor((index % 20) / 4) + 1 })),
      attempts: attempts.map((row) => ({ ...row, canceledAfterGateFailure: false })),
      executions: [], decisions: [], dispatchTokens: [], shadowQueue: [], shadowEvidence: [], replayAudits: [], lifecycleEvents: [],
      replayCancellations: [], protocolControls: [], protocolLanes: [], blockClaims: [], laneBacklog: [], authorizationDecisions: [],
      authorizationOutbox: [], reconciliationAttempts: [], reconciliationEvidence: [], holds: [], incidents: [],
      schedulerClaims: [], costRows: [], artifactBindings: [],
    };
    const report = build({
      closure: { runId: "run-1", rows: closureRows, replayTargetRequestIds: [],
        acceptedSnapshot: { digest: fingerprint, databaseStartedAtMs: 1 },
        settlement: { passed: true, acceptedSnapshotDigest: fingerprint } },
      strictInventory: { runId: "run-1", planFingerprint: fingerprint, requestIds, replayTargetRequestIds: [], attempts,
        executions: [], decisions: [], dispatchTokens: [], shadowQueue: [], shadowEvidence: [], replayAudits: [],
        authorizationReceipts: [], signedAuthorizations: [], claims: [], manifests: [], reconciliation: [], incidents: [],
        settlement: { passed: true, acceptedOffsetSeconds: 0, journalCardinality: 1, finalSnapshotDigest: fingerprint, finalRowCardinality: 100 },
        costs: { knownCostMicros: "0", unresolvedExposureMicros: "0", knownCostCapMicros: "3000000", unresolvedExposureCapMicros: "320000" },
        hardFinalization: { allTerminal: true, finalizedAt: "2026-07-28T09:29:00.000Z", deadline: "2026-07-28T09:30:00.000Z" }, artifactPaths: [] },
      artifactDigests: {}, artifactPaths: [], claimInventoryAuthority: {},
    });
    expect(report.passed).toBe(false);
    expect(report.strict.counts.usable).toBe(98);
    expect(report.reasons).toEqual(expect.arrayContaining(["USABLE_OUTCOMES_INVALID", "NONUSABLE_ALLOWANCE_EXCEEDED"]));
  });

  it("removes the metadata trust boundary from production evidence/report arguments", () => {
    const validate = (runner as Record<string, unknown>)["validateEvidenceReportArguments"] as ((args: readonly string[]) => {
      planPath: string; outputPath: string | null;
    }) | undefined;
    expect(typeof validate).toBe("function");
    if (!validate) throw new Error("EVIDENCE_ARGUMENT_VALIDATOR_MISSING");
    expect(validate(["--plan", "plan.json", "--output", "report.json"])).toEqual({ planPath: "plan.json", outputPath: "report.json" });
    expect(() => validate(["--plan", "plan.json", "--metadata", "forged.json"])).toThrow("CALLER_METADATA_PROHIBITED");
  });
});
