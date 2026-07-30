import { describe, expect, it } from "vitest";
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

const sha = (c: string) => `sha256:${c.repeat(64)}`;

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
    authorizationDecisions: [{ active: true, operatorValid: true, reconciliationValid: true }],
    authorizationOutbox: [{ kind: "operator", published: true }, { kind: "reconciliation", published: true }],
    reconciliationAttempts: [{ requestId: "r-1", phase: "terminal" }],
    reconciliationEvidence: [{ requestId: "r-1", accepted: true }],
    holds: [{ lane: "normal-paced", resolved: true, heldUnresolved: [] }],
    incidents: [] as Array<{ sequence: number; eventType: string }>,
    schedulerClaims: [{ requestId: "r-1", state: "terminal", manifestDigest: sha("a") }],
    costRows: [{ knownCostMicros: "100", unresolvedExposureMicros: "0" }],
    artifactBindings: [{ path: "evidence/protocol.json", digest: sha("b") }],
  };
}

describe("P0 authoritative snapshot and final commit closure", () => {
  it("requires every authoritative protocol/auth/reconciliation/hold/incident/claim/cost/artifact inventory", () => {
    const rows = authoritativeRows();
    expect(assertAcceptedSnapshotAuthority(rows, { "evidence/protocol.json": sha("b") })).toEqual({ complete: true, reasons: [] });
    for (const key of Object.keys(rows)) {
      const mutated = structuredClone(rows) as Record<string, unknown>;
      delete mutated[key];
      expect(assertAcceptedSnapshotAuthority(mutated, { "evidence/protocol.json": sha("b") }).complete, key).toBe(false);
    }
  });

  it("fails closed on failed controls, inactive auth, unresolved holds, incidents, exposure, or artifact substitution", () => {
    const cases = [
      (r: ReturnType<typeof authoritativeRows>) => { r.protocolControls[0]!.state = "failed"; },
      (r: ReturnType<typeof authoritativeRows>) => { r.authorizationDecisions[0]!.active = false; },
      (r: ReturnType<typeof authoritativeRows>) => { r.holds[0]!.resolved = false; r.holds[0]!.heldUnresolved = ["r-2"]; },
      (r: ReturnType<typeof authoritativeRows>) => { r.incidents.push({ sequence: 1, eventType: "control_failure" }); },
      (r: ReturnType<typeof authoritativeRows>) => { r.costRows[0]!.unresolvedExposureMicros = "1"; },
    ];
    for (const mutate of cases) {
      const rows = authoritativeRows(); mutate(rows);
      expect(assertAcceptedSnapshotAuthority(rows, { "evidence/protocol.json": sha("b") }).complete).toBe(false);
    }
    expect(assertAcceptedSnapshotAuthority(authoritativeRows(), { "evidence/protocol.json": sha("c") }).reasons)
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
      .toMatchObject({ artifactKind: "final_commit", state: "committed", passed: true });
    expect(() => buildCanonicalFinalCommitMarker({ runId: "run-1", planFingerprint: sha("d"), stage: "replay_terminal", reportPassed: true,
      settlementDigest: sha("e"), settlementJournalCardinality: 1, authoritativeInventoryDigest: sha("f"), artifactDigests: {} }))
      .toThrow("SETTLEMENT_REQUIRED_BEFORE_FINAL_COMMIT");
    expect(canonicalFinalCommitPath("run-1")).toBe("evidence/held-out-reliability/replay/run-1.json");
    expect(preliminaryReplayArtifactPath("run-1")).toBe("evidence/held-out-reliability/replay-preliminary/run-1.json");
    expect(preliminaryReplayArtifactPath("run-1")).not.toBe(canonicalFinalCommitPath("run-1"));
    expect(() => canonicalFinalCommitPath("../escape")).toThrow("RUN_ID_INVALID");
  });

  it("names every accepted snapshot inventory that decides strict closure", () => {
    expect(AUTHORITATIVE_SNAPSHOT_INVENTORIES).toEqual(expect.arrayContaining([
      "sealedCalls", "attempts", "executions", "decisions", "shadowQueue", "shadowEvidence",
      "dispatchTokens", "lifecycleEvents", "replayAudits", "replayCancellations",
      "protocolControls", "protocolLanes", "blockClaims", "authorizationDecisions",
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
    const prototype = ReliabilityProtocolStore.prototype as unknown as Record<string, unknown>;
    expect(prototype["advanceDurableStage"]).toBeTypeOf("function");
    expect(prototype["publishPendingFailureReport"]).toBeTypeOf("function");
    expect(prototype["commitCanonicalFinalReport"]).toBeTypeOf("function");
    expect(prototype["publishPendingCanonicalFinalReport"]).toBeTypeOf("function");
  });

  it("replays failure publication from exact durable bytes without recomputing artifacts", async () => {
    const bytes = `${JSON.stringify({ artifactKind: "final_commit", passed: false, nonce: "durable" })}\n`;
    const digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`;
    const queries: string[] = [];
    const database = { query: async (statement: string) => {
      queries.push(statement);
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
      return { rows: [{ durable_stage: "replay_terminal", state: "active" }] };
    } };
    const store = new ReliabilityProtocolStore(database as never);
    await expect(store.runAndPersistAuthoritativeSettlement("run-1")).rejects.toThrow("ARTIFACT_BINDING_REQUIRED_BEFORE_SETTLEMENT");
    expect(statements.some((statement) => statement.includes("INSERT INTO reliability_settlement_final_snapshots"))).toBe(false);
  });
});
