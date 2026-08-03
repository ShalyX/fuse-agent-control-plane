import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  AUTHORITATIVE_SNAPSHOT_INVENTORIES,
  assertAcceptedSnapshotAuthority,
  buildCanonicalFinalCommitMarker,
  canonicalFinalCommitPath,
  preliminaryReplayArtifactPath,
  finalEvidenceClosure,
  hardFinalizationTerminalState,
  planDurableStageTransition,
  type DurableReliabilityStage,
} from "../src/evidence/finalEvidenceClosure.js";
import { planHardFinalization } from "../src/evidence/evidenceSettlementClosure.js";
import { RELIABILITY_SCHEMA_SQL } from "../src/reliability/reliabilitySchema.js";
import { ReliabilityProtocolStore } from "../src/reliability/protocolStore.js";
import { RELIABILITY_V2_PROFILE } from "../src/reliability/protocolProfile.js";
import { canonicalJson } from "../src/evidence/heldOutReliabilityV2.js";

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const artifactDigest=(value:unknown)=>`sha256:${createHash("sha256").update(`${canonicalJson(value)}\n`).digest("hex")}`;
const AUTH_RECEIPTS={
  operator:{artifactKind:"authorization_receipt",kind:"operator",runId:"run-1",status:"consumed",presentedArtifactSha256:sha("c")},
  reconciliation:{artifactKind:"authorization_receipt",kind:"reconciliation",runId:"run-1",status:"validated",presentedArtifactSha256:sha("d")},
};
const EXPECTED_ARTIFACTS={"evidence/protocol.json":sha("b"),"evidence/scheduler/r-1.json":sha("a"),
  "evidence/authorizations/operator/run-1.json":sha("c"),"evidence/authorizations/reconciliation/run-1.json":sha("d"),
  "evidence/authorization-receipts/operator/run-1.json":artifactDigest(AUTH_RECEIPTS.operator),
  "evidence/authorization-receipts/reconciliation/run-1.json":artifactDigest(AUTH_RECEIPTS.reconciliation)};

function authoritativeRows() {
  return {
    sealedCalls: [{ requestId: "r-1" }],
    attempts: [{ requestId: "r-1" }],
    executions: [{ requestId: "r-1" }],
    decisions: [{ requestId: "r-1" }],
    shadowQueue: [{ requestId: "r-1" }],
    shadowEvidence: [{ requestId: "r-1" }],
    dispatchTokens: [{ requestId: "r-1" }],
    lifecycleEvents: [{ requestId: "r-1" }],
    replayAudits: [{ requestId: "r-1" }],
    replayCancellations: [] as Array<{ requestId: string }>,
    protocolControls: [{ state: "active", failureSequence: 0, gateClassificationCount: 100, replayPassedCount: 20 }],
    protocolLanes: [{ lane: "normal-paced", state: "ready", resumeAtMs: null }],
    blockClaims: [{ block: 1, state: "claimed" }],
    laneBacklog: [],
    authorizationDecisions: [{ active: true, operatorValid: true, reconciliationValid: true, decisionIdValid:true }],
    authorizationOutbox: [{ kind: "operator", published: true,receipt:AUTH_RECEIPTS.operator }, { kind: "reconciliation", published: true,receipt:AUTH_RECEIPTS.reconciliation }],
    reconciliationAttempts: [{ requestId: "r-1", phase: "terminal" }],
    reconciliationEvidence: [{ requestId: "r-1", accepted: true }],
    holds: [{ lane: "normal-paced", resolved: true, heldUnresolved: [] as string[] }],
    incidents: [] as Array<{ sequence: number; eventType: string }>,
    schedulerClaims: [{ requestId: "r-1", state: "terminal", manifestPath:"evidence/scheduler/r-1.json",manifestDigest: sha("a"),manifestFsynced:true }],
    costRows: [{ knownCostMicros: "100", unresolvedExposureMicros: "0" }],
    artifactBindings: Object.entries(EXPECTED_ARTIFACTS).map(([path,digest])=>({path,digest})),
  };
}

describe("P0 authoritative snapshot and final commit closure", () => {
  it("requires every authoritative protocol/auth/reconciliation/hold/incident/claim/cost/artifact inventory", () => {
    const rows = authoritativeRows();
    expect(assertAcceptedSnapshotAuthority(rows, EXPECTED_ARTIFACTS)).toEqual({ complete: true, reasons: [] });
    for (const key of Object.keys(rows)) {
      const mutated = structuredClone(rows) as Record<string, unknown>;
      delete mutated[key];
      expect(assertAcceptedSnapshotAuthority(mutated, EXPECTED_ARTIFACTS).complete, key).toBe(false);
    }
  });

  it("fails closed on failed controls, inactive auth, unresolved holds, incidents, exposure, or artifact substitution", () => {
    const cases = [
      (r: ReturnType<typeof authoritativeRows>) => { r.protocolControls[0]!.state = "failed"; },
      (r: ReturnType<typeof authoritativeRows>) => { r.authorizationDecisions[0]!.active = false; },
      (r: ReturnType<typeof authoritativeRows>) => { r.authorizationDecisions[0]!.decisionIdValid = false; },
      (r: ReturnType<typeof authoritativeRows>) => { r.authorizationOutbox[0]!.receipt.status = "substituted"; },
      (r: ReturnType<typeof authoritativeRows>) => { r.holds[0]!.resolved = false; r.holds[0]!.heldUnresolved = ["r-2"]; },
      (r: ReturnType<typeof authoritativeRows>) => { r.incidents.push({ sequence: 1, eventType: "control_failure" }); },
      (r: ReturnType<typeof authoritativeRows>) => { r.costRows[0]!.unresolvedExposureMicros = "1"; },
    ];
    for (const mutate of cases) {
      const rows = authoritativeRows(); mutate(rows);
      expect(assertAcceptedSnapshotAuthority(rows, EXPECTED_ARTIFACTS).complete).toBe(false);
    }
    expect(assertAcceptedSnapshotAuthority(authoritativeRows(), { ...EXPECTED_ARTIFACTS,"evidence/protocol.json":sha("c") }).reasons)
      .toContain("SNAPSHOT_ARTIFACT_BINDING_INVALID");
  });

  it("enforces durable fresh-terminal -> replay-terminal -> settled -> final-committed order", () => {
    let stage: DurableReliabilityStage = "running";
    expect(() => planDurableStageTransition({ stage, terminalFresh: 100, openHolds: 0, replayAudits: 0, settlementPassed: false }, "settled"))
      .toThrow("DURABLE_STAGE_ORDER_INVALID");
    stage = planDurableStageTransition({ stage, terminalFresh: 100, openHolds: 0, replayAudits: 0, settlementPassed: false }, "fresh_terminal");
    expect(() => planDurableStageTransition({ stage, terminalFresh: 100, openHolds: 0, replayAudits: 19, settlementPassed: false }, "replay_terminal"))
      .toThrow("REPLAY_INVENTORY_INCOMPLETE");
    stage = planDurableStageTransition({ stage, terminalFresh: 100, openHolds: 0, replayAudits: 20, settlementPassed: false }, "replay_terminal");
    stage = planDurableStageTransition({ stage, terminalFresh: 100, openHolds: 0, replayAudits: 20, artifactsBound: true, settlementPassed: false }, "artifact_bound");
    stage = planDurableStageTransition({ stage, terminalFresh: 100, openHolds: 0, replayAudits: 20, artifactsBound: true, settlementPassed: true }, "settled");
    expect(buildCanonicalFinalCommitMarker({ runId: "run-1", planFingerprint: sha("d"), stage, reportPassed: true,
      settlementDigest: sha("e"), settlementJournalCardinality: 1, authoritativeInventoryDigest: sha("f"), artifactDigests: { "evidence/protocol.json": sha("b") } }))
      .toMatchObject({ evidenceType:"held-out-reliability", protocolVersion:2, artifactKind: "final_commit", state: "committed", passed: true });
    expect(buildCanonicalFinalCommitMarker({ runId: "hov3-run:colon", planFingerprint: sha("d"), stage, reportPassed: true,
      settlementDigest: sha("e"), settlementJournalCardinality: 1, authoritativeInventoryDigest: sha("f"), artifactDigests: { "evidence/protocol.json": sha("b") } }))
      .toMatchObject({ evidenceType:"held-out-reliability-v3", protocolVersion:3, runId:"hov3-run:colon" });
    expect(() => buildCanonicalFinalCommitMarker({ runId: "run-1", planFingerprint: sha("d"), stage: "replay_terminal", reportPassed: true,
      settlementDigest: sha("e"), settlementJournalCardinality: 1, authoritativeInventoryDigest: sha("f"), artifactDigests: {} }))
      .toThrow("SETTLEMENT_REQUIRED_BEFORE_FINAL_COMMIT");
    expect(canonicalFinalCommitPath("run-1")).toBe("evidence/held-out-reliability/replay/run-1.json");
    expect(canonicalFinalCommitPath("hov3-run:colon")).toBe("evidence/held-out-reliability-v3/replay/hov3-run:colon.json");
    expect(preliminaryReplayArtifactPath("run-1")).toBe("evidence/held-out-reliability/replay-preliminary/run-1.json");
    expect(preliminaryReplayArtifactPath("run-1")).not.toBe(canonicalFinalCommitPath("run-1"));
    expect(() => canonicalFinalCommitPath("../escape")).toThrow("RUN_ID_INVALID");
  });

  it("names every accepted snapshot inventory that decides strict closure", () => {
    expect(AUTHORITATIVE_SNAPSHOT_INVENTORIES).toEqual(expect.arrayContaining([
      "sealedCalls", "attempts", "executions", "decisions", "shadowQueue", "shadowEvidence",
      "dispatchTokens", "lifecycleEvents", "replayAudits", "replayCancellations",
      "protocolControls", "protocolLanes", "blockClaims", "laneBacklog", "authorizationDecisions",
      "authorizationOutbox", "reconciliationAttempts", "reconciliationEvidence", "holds",
      "incidents", "schedulerClaims", "costRows", "artifactBindings",
    ]));
  });

  it("uses the strict reducer as the sole final pass authority", () => {
    const requestIds = Array.from({ length: 100 }, (_, index) => `r-${index + 1}`);
    const attempts = requestIds.map((requestId, index) => ({ requestId,
      state: index >= 98 ? "reconciled_billed_no_response" : "completed_verified",
      gateClassificationCount: 1, admissionStarted: true, actualCostMicros: "0", reservedCostMicros: "1" }));
    const report = finalEvidenceClosure({
      closure: { runId: "run-1", rows: authoritativeRows(), replayTargetRequestIds: [],
        acceptedSnapshot: { digest: sha("a"), databaseStartedAtMs: 1 },
        settlement: { passed: true, acceptedSnapshotDigest: sha("a") } },
      strictInventory: { runId: "run-1", planFingerprint: sha("b"), requestIds, replayTargetRequestIds: [], attempts,
        executions: [], decisions: [], dispatchTokens: [], shadowQueue: [], shadowEvidence: [], replayAudits: [],
        authorizationReceipts: [], signedAuthorizations: [], claims: [], manifests: [], reconciliation: [], incidents: [],
        settlement: { passed: true, acceptedOffsetSeconds: 0, journalCardinality: 1, finalSnapshotDigest: sha("a"), finalRowCardinality: 100 },
        costs: { knownCostMicros: "0", unresolvedExposureMicros: "0", knownCostCapMicros: "3000000", unresolvedExposureCapMicros: "320000" },
        hardFinalization: { allTerminal: true, finalizedAt: "2026-07-28T09:29:00.000Z", deadline: "2026-07-28T09:30:00.000Z" }, artifactPaths: [] } as never,
      expectedArtifactDigests: { "evidence/protocol.json": sha("b") },
    });
    expect(report.passed).toBe(false);
    expect(report.reasons).toEqual(expect.arrayContaining(["USABLE_OUTCOMES_INVALID", "NONUSABLE_ALLOWANCE_EXCEEDED"]));
    expect(report.strict.counts.usable).toBe(98);
  });
});

describe("hard finalizer production contract", () => {
  it("maps unstarted/pre-primitive requests to not_dispatched and only entered primitives to unresolved", () => {
    expect(hardFinalizationTerminalState({ admissionStarted: false, dispatchToken: false, primitiveEntered: false })).toBe("not_dispatched");
    expect(hardFinalizationTerminalState({ admissionStarted: true, dispatchToken: true, primitiveEntered: false })).toBe("not_dispatched");
    expect(hardFinalizationTerminalState({ admissionStarted: true, dispatchToken: true, primitiveEntered: true })).toBe("unresolved_provider_outcome");
  });

  it("requires durable replay cancellations, canceled artifacts, and recoverable publishers", () => {
    const plan = planHardFinalization({ databaseNowMs: 10, deadlineMs: 10, runState: "active", nonterminalRequestIds: ["r-1"] });
    expect(plan).toMatchObject({ action: "finalize_failure", createCanceledArtifacts: true, persistReplayCancellations: true });
    expect(RELIABILITY_SCHEMA_SQL).toContain("durable_stage");
    expect(RELIABILITY_SCHEMA_SQL).toContain("reliability_replay_cancellations");
    expect(RELIABILITY_SCHEMA_SQL).toContain("reliability_artifact_bindings");
    expect(RELIABILITY_SCHEMA_SQL).toContain("'artifact_bound'");
    expect(RELIABILITY_SCHEMA_SQL).toContain("publication_items JSONB");
    expect(RELIABILITY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS reliability_report_publication_outbox");
    for(const column of ["intent_sequence BIGINT","profile_fingerprint TEXT","report_kind TEXT","destination TEXT","report_sha256 TEXT","report_bytes_base64 TEXT","intent_path TEXT","intent_sha256 TEXT","intent_bytes_base64 TEXT","artifact_inventory_sha256 TEXT","accepted_snapshot_sha256 TEXT","publication_deadline TIMESTAMPTZ","supersedes_intent_sequence BIGINT","next_event_sequence BIGINT","state TEXT"]){
      expect(RELIABILITY_SCHEMA_SQL).toContain(column);
    }
    expect(RELIABILITY_SCHEMA_SQL).toContain("next_report_intent_sequence BIGINT");
    expect(RELIABILITY_SCHEMA_SQL).toContain("'superseded','publication_failed','artifact_conflict'");
    expect(RELIABILITY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS reliability_report_publication_events");
    expect(RELIABILITY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS reliability_report_publication_receipts");
    const prototype = ReliabilityProtocolStore.prototype as unknown as Record<string, unknown>;
    expect(prototype["advanceDurableStage"]).toBeTypeOf("function");
    expect(prototype["publishPendingFailureReport"]).toBeTypeOf("function");
    expect(prototype["commitCanonicalFinalReport"]).toBeTypeOf("function");
    expect(prototype["publishPendingCanonicalFinalReport"]).toBeTypeOf("function");
    expect(prototype["publishPendingReportIntent"]).toBeTypeOf("function");
    expect(prototype["commitAuthorizationPredecisionFailure"]).toBeTypeOf("function");
    expect(ReliabilityProtocolStore.prototype.commitAuthorization.toString()).toContain("commitReportIntentLocked");
  });

  it("replays failure publication from exact durable bytes without recomputing artifacts", async () => {
    const bytes = `${JSON.stringify({ artifactKind: "final_commit", passed: false, nonce: "durable" })}\n`;
    const digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`;
    const queries: string[] = [];
    const database = { query: async (statement: string) => {
      queries.push(statement);
      if (statement.includes("FROM reliability_protocol_controls") && statement.includes("FOR UPDATE")) return { rows: [{
        state: "failed", durable_stage: "failed", plan_fingerprint: sha("f"), failure_sequence: "1",
        reconciliation_credential_id: null, nonusable_allowance_owner: null,
        protocol_version: RELIABILITY_V2_PROFILE.protocolVersion, evidence_type: RELIABILITY_V2_PROFILE.evidenceType,
        plan_schema_version: RELIABILITY_V2_PROFILE.planSchemaVersion, mapping_version: RELIABILITY_V2_PROFILE.mappingVersion,
        profile_fingerprint: RELIABILITY_V2_PROFILE.profileFingerprint,
      }] };
      if (statement.includes("publication_items")) return { rows: [{ publication_items: [{ path: "evidence/held-out-reliability/replay/run-1.json", bytes, digest }], published_at: null }] };
      return { rows: [{ ok: 1 }] };
    } };
    const published: Array<{ path: string; bytes: string }> = [];
    const store = new ReliabilityProtocolStore(database as never);
    await expect(store.publishPendingFailureReport("run-1", async (path, exactBytes) => { published.push({ path, bytes: exactBytes }); }))
      .resolves.toMatchObject({ published: true, paths: ["evidence/held-out-reliability/replay/run-1.json"] });
    expect(published).toEqual([{ path: "evidence/held-out-reliability/replay/run-1.json", bytes }]);
    expect(queries.some((statement) => statement.includes("report_intent"))).toBe(false);
  });

  it("rejects settlement before artifact_bound without creating an immutable snapshot", async () => {
    const statements: string[] = [];
    const database = { query: async (statement: string) => {
      statements.push(statement);
      return { rows: [{ durable_stage: "replay_terminal", state: "active", plan_fingerprint: sha("f"), failure_sequence: "0",
        reconciliation_credential_id: null, nonusable_allowance_owner: null,
        protocol_version: RELIABILITY_V2_PROFILE.protocolVersion, evidence_type: RELIABILITY_V2_PROFILE.evidenceType,
        plan_schema_version: RELIABILITY_V2_PROFILE.planSchemaVersion, mapping_version: RELIABILITY_V2_PROFILE.mappingVersion,
        profile_fingerprint: RELIABILITY_V2_PROFILE.profileFingerprint }] };
    } };
    const store = new ReliabilityProtocolStore(database as never);
    await expect(store.runAndPersistAuthoritativeSettlement("run-1")).rejects.toThrow("ARTIFACT_BINDING_REQUIRED_BEFORE_SETTLEMENT");
    expect(statements.some((statement) => statement.includes("INSERT INTO reliability_settlement_final_snapshots"))).toBe(false);
  });
});
