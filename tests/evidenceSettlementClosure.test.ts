import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import * as artifacts from "../src/evidence/artifactReconstruction.js";
import * as closure from "../src/evidence/evidenceSettlementClosure.js";
import { authoritativeSnapshotDigest } from "../src/evidence/authoritativeSettlement.js";
import { expectedReliabilityArtifactPaths } from "../src/evidence/authoritativeEvidence.js";
import { V2_SCHEDULE } from "../src/evidence/heldOutReliabilityV2.js";
import { evaluateSettlementRowsForRun } from "../src/reliability/protocolStore.js";

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const lanes = ["normal-paced", "high-envelope", "bounded-burst", "restart-resume"] as const;
const json = (value: unknown) => `${JSON.stringify(value)}\n`;

async function write(root: string, relative: string, value: unknown): Promise<Buffer> {
  const bytes = Buffer.from(json(value));
  await mkdir(join(root, relative, ".."), { recursive: true });
  await writeFile(join(root, relative), bytes);
  return bytes;
}

async function artifactFixture() {
  const root = await mkdtemp(join(tmpdir(), "fuse-closure-"));
  const runId = "run-closure";
  const planFingerprint = `sha256:${"a".repeat(64)}`;
  const common = { evidenceType: "held-out-reliability", protocolVersion: 2, runId, planFingerprint };
  await write(root, "evidence/held-out-reliability/protocols/held-out-reliability-v2.json", { ...common, artifactKind: "protocol" });
  await write(root, "evidence/held-out-reliability/beacons/drand-6315000.json", { ...common, artifactKind: "beacon", round: 6315000 });
  await write(root, `evidence/held-out-reliability/plans/${planFingerprint}.json`, { ...common, artifactKind: "plan" });
  for (const kind of ["operator", "reconciliation"] as const) {
    const signed = await write(root, `evidence/held-out-reliability/authorizations/${kind}/${runId}.json`, { ...common, artifactKind: "authorization", kind, signature: `${kind}-signature` });
    await write(root, `evidence/held-out-reliability/authorization-receipts/${kind}/${runId}.json`, {
      ...common, artifactKind: "authorization_receipt", kind,
      status: kind === "operator" ? "consumed" : "validated", presentedArtifactSha256: sha(signed),
    });
  }
  for (const lane of lanes) {
    await write(root, `evidence/.run-claims/held-out-reliability/${runId}/${lane}.claim`, { ...common, artifactKind: "lane_claim", lane, state: "terminal" });
    for (let block = 1; block <= 5; block++) {
      await write(root, `evidence/held-out-reliability/manifests/${runId}/${lane}-${block}.json`, { ...common, artifactKind: "manifest", lane, block, state: "terminal" });
    }
  }
  await write(root, `evidence/held-out-reliability/replay-preliminary/${runId}.json`, { ...common, artifactKind: "replay_report", passed: true, replayAudits: 20 });
  return { root, runId, planFingerprint };
}

describe("artifact-byte authority", () => {
  it("resolves the legacy inventory contradiction in favor of the protocol's four lane claims", () => {
    const paths = expectedReliabilityArtifactPaths({ runId: "run", planFingerprint: `sha256:${"a".repeat(64)}`, incidentPaths: [] });
    expect(paths.filter((path) => path.endsWith(".claim"))).toEqual(lanes.map((lane) => `evidence/.run-claims/held-out-reliability/run/${lane}.claim`).sort());
  });

  it("reconstructs the protocol's four lane claims, manifests, receipt status, signatures, and digests from bytes", async () => {
    expect(artifacts.reconstructReliabilityArtifacts).toBeTypeOf("function");
    const fixture = await artifactFixture();
    const result = await artifacts.reconstructReliabilityArtifacts({ ...fixture, incidents: [], verifyAuthorization: async ({ kind, parsed }) => parsed.signature === `${kind}-signature` });
    expect(result.claims.map((row) => row.lane).sort()).toEqual([...lanes].sort());
    expect(result.claims).toHaveLength(4);
    expect(result.manifests).toHaveLength(20);
    expect(result.authorizationReceipts.map((row) => `${row.kind}:${row.status}`).sort()).toEqual(["operator:consumed", "reconciliation:validated"]);
    expect(result.artifacts.every((row) => /^sha256:[a-f0-9]{64}$/.test(row.digest))).toBe(true);
    expect(result.claimInventoryAuthority).toEqual({ source: "docs/held-out-reliability-protocol-v2.md:420,426", claims: "four_lane_claims", contradictionDetected: true, contradictedLegacyShape: "five_block_claims" });
  });

  it("rejects a caller assertion when receipt or manifest bytes contradict it", async () => {
    const fixture = await artifactFixture();
    const receipt = `evidence/held-out-reliability/authorization-receipts/operator/${fixture.runId}.json`;
    await write(fixture.root, receipt, { evidenceType: "held-out-reliability", protocolVersion: 2, runId: fixture.runId, planFingerprint: fixture.planFingerprint, artifactKind: "authorization_receipt", kind: "operator", status: "consumed", presentedArtifactSha256: `sha256:${"0".repeat(64)}` });
    await expect(artifacts.reconstructReliabilityArtifacts({ ...fixture, incidents: [], verifyAuthorization: async () => true })).rejects.toThrow("ARTIFACT_RECEIPT_PRESENTED_DIGEST_MISMATCH");
  });
});

function passingSnapshot() {
  const runId = "run-closure";
  const requestIds = Array.from({ length: 100 }, (_, i) => `r-${i + 1}`);
  const sealedCalls = requestIds.map((requestId, index) => ({ requestId, lane: lanes[index % 4]!, block: Math.floor(index / 20) + 1, callOrdinal: Math.floor((index % 20) / 4) + 1 }));
  const attempts = sealedCalls.map((call) => ({ requestId: call.requestId, state: "completed_verified" as const, gateClassificationCount: 1, admissionStarted: true, canceledAfterGateFailure: false, actualCostMicros: "1", reservedCostMicros: "50000" }));
  const events = sealedCalls.flatMap((call, index) => {
    const claimedAtMs = Date.parse(V2_SCHEDULE[call.block - 1]!.opensAt);
    return [
      { requestId: call.requestId, eventType: "planned" as const, databaseTimeMs: claimedAtMs - 1 },
      { requestId: call.requestId, eventType: "admission_started" as const, databaseTimeMs: claimedAtMs + 1_000, blockClaimedAtMs: claimedAtMs, priorTerminalAtMs: call.callOrdinal === 1 ? null : claimedAtMs - 4_000 },
      { requestId: call.requestId, eventType: "dispatch_authorized" as const, databaseTimeMs: claimedAtMs + 1_100 },
      { requestId: call.requestId, eventType: "dispatch_primitive_entered" as const, databaseTimeMs: claimedAtMs + 1_200 },
      { requestId: call.requestId, eventType: "gate_classified" as const, databaseTimeMs: claimedAtMs + 2_000 + index },
    ];
  });
  const replayIds = requestIds.slice(0, 20);
  const rows = {
    sealedCalls,
    attempts,
    executions: requestIds.map((requestId) => ({ requestId, status: "completed" as const, actualCostMicros: "1", shadowOrderState: "queued" as const, cohortOrdinal: 1 })),
    decisions: requestIds.map((requestId) => ({ requestId, outcome: "ALLOW" as const })),
    dispatchTokens: requestIds.map((requestId) => ({ requestId, primitiveEntered: true, preDispatchProof: false })),
    shadowQueue: requestIds.map((requestId) => ({ requestId, state: "completed" as const, attempts: 1 })),
    shadowEvidence: requestIds.map((requestId) => ({ requestId })),
    replayAudits: replayIds.map((requestId, index) => ({ requestId, replayNo: index + 1, originalResponseCommitment: `sha256:${"b".repeat(64)}`, replayResponseCommitment: `sha256:${"b".repeat(64)}`, writeSet: [] as string[] })),
    lifecycleEvents: events,
    laneBacklog: [] as Array<{requestId:string;lane:typeof lanes[number];block:number;callOrdinal:number;state:string;actualScheduledAtMs:number|null}>,
  };
  return { runId, requestIds, replayIds, rows };
}

describe("accepted-snapshot closure", () => {
  it.each(["run-v2-settlement","hov3-settlement","hov4-settlement"])("uses the run-version schedule in the production settlement reader for %s", (runId) => {
    const fixture=passingSnapshot();
    const schedule=closure.reliabilityScheduleForRunId(runId);
    const callByRequest=new Map(fixture.rows.sealedCalls.map(call=>[call.requestId,call]));
    for(const event of fixture.rows.lifecycleEvents){
      const block=callByRequest.get(event.requestId)!.block;
      const delta=Date.parse(schedule[block-1]!.opensAt)-Date.parse(V2_SCHEDULE[block-1]!.opensAt);
      event.databaseTimeMs+=delta;
      if(event.blockClaimedAtMs!==undefined&&event.blockClaimedAtMs!==null)event.blockClaimedAtMs+=delta;
      if(event.priorTerminalAtMs!==undefined&&event.priorTerminalAtMs!==null)event.priorTerminalAtMs+=delta;
    }
    expect(evaluateSettlementRowsForRun(runId,fixture.rows,fixture.replayIds)).toEqual({complete:true,reasons:[]});
  });

  it("accepts only the exact sealed matrix with 100 shadow completions and 20 ordered replays", () => {
    expect(closure.evaluateSettlementSnapshotCompleteness).toBeTypeOf("function");
    const fixture = passingSnapshot();
    expect(closure.evaluateSettlementSnapshotCompleteness({ rows: fixture.rows, replayTargetRequestIds: fixture.replayIds })).toEqual({ complete: true, reasons: [] });
    fixture.rows.shadowEvidence.pop();
    fixture.rows.replayAudits.pop();
    expect(closure.evaluateSettlementSnapshotCompleteness({ rows: fixture.rows, replayTargetRequestIds: fixture.replayIds }).reasons).toEqual(expect.arrayContaining(["SNAPSHOT_OUTCOME_MATRIX_INVALID", "SNAPSHOT_REPLAY_MATRIX_INVALID"]));
  });

  it("derives authority from the sealed registry and validates schedule/lifecycle predicates", () => {
    const fixture = passingSnapshot();
    fixture.rows.sealedCalls[0]!.requestId = "forged-id";
    expect(closure.evaluateSettlementSnapshotCompleteness({ rows: fixture.rows, replayTargetRequestIds: fixture.replayIds }).reasons).toContain("SEALED_REGISTRY_INVALID");
    fixture.rows.sealedCalls[0]!.requestId = fixture.requestIds[0]!;
    const admission = fixture.rows.lifecycleEvents.find((event) => event.requestId === fixture.requestIds[0] && event.eventType === "admission_started")!;
    admission.databaseTimeMs = admission.blockClaimedAtMs! + 2_000;
    expect(closure.evaluateSettlementSnapshotCompleteness({ rows: fixture.rows, replayTargetRequestIds: fixture.replayIds }).reasons).toContain("SCHEDULE_LIFECYCLE_INVALID");
  });

  it("rejects block claims outside the sealed absolute schedule even when relative admission timing is valid", () => {
    const fixture = passingSnapshot();
    for (const event of fixture.rows.lifecycleEvents.filter((row) => row.eventType === "admission_started" && fixture.rows.sealedCalls.find((call) => call.requestId === row.requestId)!.block === 1)) {
      event.blockClaimedAtMs! += 10 * 60_000;
      event.databaseTimeMs += 10 * 60_000;
      if (event.priorTerminalAtMs !== null && event.priorTerminalAtMs !== undefined) event.priorTerminalAtMs += 10 * 60_000;
    }
    expect(closure.evaluateSettlementSnapshotCompleteness({ rows: fixture.rows, replayTargetRequestIds: fixture.replayIds }).reasons).toContain("SCHEDULE_LIFECYCLE_INVALID");
  });

  it("uses the accepted resumed backlog timestamp as schedule authority", () => {
    const fixture=passingSnapshot();
    const call=fixture.rows.sealedCalls[0]!;
    const admission=fixture.rows.lifecycleEvents.find(event=>event.requestId===call.requestId&&event.eventType==="admission_started")!;
    admission.databaseTimeMs+=10_000;
    fixture.rows.laneBacklog.push({requestId:call.requestId,lane:call.lane,block:call.block,callOrdinal:call.callOrdinal,
      state:"terminal",actualScheduledAtMs:admission.databaseTimeMs});
    expect(closure.evaluateSettlementSnapshotCompleteness({rows:fixture.rows,replayTargetRequestIds:fixture.replayIds}).complete).toBe(true);
    fixture.rows.laneBacklog[0]!.actualScheduledAtMs=admission.databaseTimeMs-2_000;
    expect(closure.evaluateSettlementSnapshotCompleteness({rows:fixture.rows,replayTargetRequestIds:fixture.replayIds}).reasons).toContain("SCHEDULE_LIFECYCLE_INVALID");
  });

  it("binds the authoritative report to accepted as-of bytes and emits Clopper-Pearson only without early stop", () => {
    expect(closure.buildAuthoritativeClosureReport).toBeTypeOf("function");
    const fixture = passingSnapshot();
    const acceptedSnapshotDigest = authoritativeSnapshotDigest(fixture.rows);
    const report = closure.buildAuthoritativeClosureReport({ runId: fixture.runId, rows: fixture.rows, replayTargetRequestIds: fixture.replayIds, acceptedSnapshot: { digest: acceptedSnapshotDigest, databaseStartedAtMs: 1234 }, settlement: { passed: true, acceptedSnapshotDigest } });
    expect(report.passed).toBe(true);
    expect(report.acceptedSnapshot).toEqual({ digest: acceptedSnapshotDigest, databaseStartedAtMs: 1234 });
    expect(report.diagnostics).toMatchObject({ usable: { successes: 100, trials: 100, displayLower: "0.970487" }, unresolved: { successes: 0, trials: 100, displayUpper: "0.029513" } });
    fixture.rows.attempts[99]!.admissionStarted = false;
    fixture.rows.attempts[99]!.canceledAfterGateFailure = true;
    const early = closure.buildAuthoritativeClosureReport({ runId: fixture.runId, rows: fixture.rows, replayTargetRequestIds: fixture.replayIds, acceptedSnapshot: { digest: authoritativeSnapshotDigest(fixture.rows), databaseStartedAtMs: 1234 }, settlement: { passed: true, acceptedSnapshotDigest: authoritativeSnapshotDigest(fixture.rows) } });
    expect(early.diagnostics).toBeNull();
    expect(early.diagnosticsSuppressedReason).toBe("EARLY_STOP_NOT_BINOMIAL");
  });

  it("fails report binding when any post-snapshot inventory is substituted", () => {
    const fixture = passingSnapshot();
    const digest = authoritativeSnapshotDigest(fixture.rows);
    fixture.rows.attempts[0]!.actualCostMicros = "2";
    const report = closure.buildAuthoritativeClosureReport({ runId: fixture.runId, rows: fixture.rows, replayTargetRequestIds: fixture.replayIds, acceptedSnapshot: { digest, databaseStartedAtMs: 1234 }, settlement: { passed: true, acceptedSnapshotDigest: digest } });
    expect(report.passed).toBe(false);
    expect(report.reasons).toContain("REPORT_ACCEPTED_SNAPSHOT_MISMATCH");
  });
});

describe("hard finalizer", () => {
  it("returns one non-optional atomic failure plan at and after the sealed deadline", () => {
    expect(closure.planHardFinalization).toBeTypeOf("function");
    const deadlineMs = Date.parse("2026-07-28T09:30:00.000Z");
    expect(closure.planHardFinalization({ databaseNowMs: deadlineMs - 1, deadlineMs, runState: "active", nonterminalRequestIds: ["r-1"] })).toEqual({ action: "wait", wakeAtMs: deadlineMs });
    const plan = closure.planHardFinalization({ databaseNowMs: deadlineMs, deadlineMs, runState: "active", nonterminalRequestIds: ["r-2", "r-1"] });
    expect(plan).toMatchObject({ action: "finalize_failure", lockOrder: ["protocol_control", "protocol_attempts"], transition: { from: "active", to: "failed", reason: "HARD_FINALIZATION_DEADLINE" }, terminalize: ["r-1", "r-2"], incident: { eventType: "hard_finalization_deadline" }, reportPublicationDeadlineMs: deadlineMs + 60_000 });
  });
});
