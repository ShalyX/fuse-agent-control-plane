import { authoritativeSnapshotDigest } from "./authoritativeSettlement.js";
import { clopperPearsonDiagnostics } from "./reliabilityProtocolV2.js";
import type {
  AuthoritativeAttemptRow,
  AuthoritativeDecisionRow,
  AuthoritativeDispatchTokenRow,
  AuthoritativeExecutionRow,
  AuthoritativeOutcomeState,
  AuthoritativeReplayAuditRow,
  AuthoritativeShadowQueueRow,
} from "./authoritativeEvidence.js";
import { RELIABILITY_LANES, type ReliabilityLane } from "./artifactReconstruction.js";
import { V2_SCHEDULE } from "./heldOutReliabilityV2.js";
import { V3_SCHEDULE } from "./heldOutReliabilityV3.js";
import { V4_SCHEDULE } from "./heldOutReliabilityV4.js";

type ReliabilitySchedule = ReadonlyArray<{ block: number; opensAt: string; launchDeadline: string }>;

export function reliabilityScheduleForRunId(runId:string):ReliabilitySchedule {
  return runId.startsWith("hov4-") ? V4_SCHEDULE : runId.startsWith("hov3-") ? V3_SCHEDULE : V2_SCHEDULE;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const USABLE = new Set<AuthoritativeOutcomeState>(["completed_verified", "reconciled_billed_with_response"]);
export type LifecycleEventType = "planned" | "admission_started" | "dispatch_authorized" | "barrier_released"
  | "barrier_canceled_before_dispatch" | "dispatch_primitive_entered" | "ambiguity_entered"
  | "provider_evidence_attached" | "gate_classified";

export interface SealedCallRow {
  requestId: string;
  lane: ReliabilityLane;
  block: number;
  callOrdinal: number;
}
export interface ClosureAttemptRow extends AuthoritativeAttemptRow {
  canceledAfterGateFailure: boolean;
}
export interface LifecycleEventRow {
  requestId: string;
  eventType: LifecycleEventType;
  databaseTimeMs: number;
  blockClaimedAtMs?: number;
  priorTerminalAtMs?: number | null;
}
export interface LaneBacklogRow {
  requestId: string;
  lane: ReliabilityLane;
  block: number;
  callOrdinal: number;
  state: string;
  actualScheduledAtMs: number | null;
}
export interface EvidenceClosureRows {
  sealedCalls: SealedCallRow[];
  attempts: ClosureAttemptRow[];
  executions: AuthoritativeExecutionRow[];
  decisions: AuthoritativeDecisionRow[];
  dispatchTokens: AuthoritativeDispatchTokenRow[];
  shadowQueue: AuthoritativeShadowQueueRow[];
  shadowEvidence: Array<{ requestId: string }>;
  replayAudits: AuthoritativeReplayAuditRow[];
  replayCancellations: Array<Record<string, unknown>>;
  lifecycleEvents: LifecycleEventRow[];
  protocolControls: Array<Record<string, unknown>>;
  protocolLanes: Array<Record<string, unknown>>;
  blockClaims: Array<Record<string, unknown>>;
  laneBacklog: LaneBacklogRow[];
  authorizationDecisions: Array<Record<string, unknown>>;
  authorizationOutbox: Array<Record<string, unknown>>;
  reconciliationAttempts: Array<Record<string, unknown>>;
  reconciliationEvidence: Array<Record<string, unknown>>;
  holds: Array<Record<string, unknown>>;
  incidents: Array<Record<string, unknown>>;
  schedulerClaims: Array<Record<string, unknown>>;
  costRows: Array<Record<string, unknown>>;
  artifactBindings: Array<{ path: string; digest: string }>;
}

function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function exactIds(actual: readonly string[], expected: readonly string[]): boolean {
  if (!unique(actual) || !unique(expected) || actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((value) => set.has(value));
}
function one<T extends { requestId: string }>(rows: readonly T[], requestId: string): T | null {
  const found = rows.filter((row) => row.requestId === requestId);
  return found.length === 1 ? found[0]! : null;
}
function noRows<T extends { requestId: string }>(rows: readonly T[], requestId: string): boolean {
  return rows.every((row) => row.requestId !== requestId);
}

function sealedRegistryValid(rows: EvidenceClosureRows): boolean {
  if (rows.sealedCalls.length !== 100 || !unique(rows.sealedCalls.map((row) => row.requestId))) return false;
  const coordinates = new Set<string>();
  for (const call of rows.sealedCalls) {
    if (!RELIABILITY_LANES.includes(call.lane) || !Number.isSafeInteger(call.block) || call.block < 1 || call.block > 5
      || !Number.isSafeInteger(call.callOrdinal) || call.callOrdinal < 1 || call.callOrdinal > 5) return false;
    coordinates.add(`${call.block}:${call.lane}:${call.callOrdinal}`);
  }
  if (coordinates.size !== 100) return false;
  for (let block = 1; block <= 5; block++) for (const lane of RELIABILITY_LANES) for (let ordinal = 1; ordinal <= 5; ordinal++) {
    if (!coordinates.has(`${block}:${lane}:${ordinal}`)) return false;
  }
  const sealed = rows.sealedCalls.map((row) => row.requestId);
  const inventories: ReadonlyArray<readonly { requestId: string }[]> = [rows.attempts, rows.executions, rows.decisions,
    rows.dispatchTokens, rows.shadowQueue, rows.shadowEvidence, rows.replayAudits, rows.lifecycleEvents, rows.laneBacklog];
  return inventories.every((inventory) => inventory.every((row) => sealed.includes(row.requestId)))
    && exactIds(rows.attempts.map((row) => row.requestId), sealed);
}

function lifecycleAndScheduleValid(rows: EvidenceClosureRows, schedule: ReliabilitySchedule): boolean {
  const blockClaims = new Map<number, number>();
  for (const call of rows.sealedCalls) {
    const events = rows.lifecycleEvents.filter((row) => row.requestId === call.requestId);
    const attempts = rows.attempts.filter((row) => row.requestId === call.requestId);
    if (attempts.length !== 1 || events.filter((event) => event.eventType === "planned").length !== 1
      || events.filter((event) => event.eventType === "gate_classified").length !== 1) return false;
    const admission = events.filter((event) => event.eventType === "admission_started");
    if (attempts[0]!.admissionStarted !== (admission.length === 1)) return false;
    if (admission.length === 0) {
      if (attempts[0]!.state !== "not_dispatched" || !attempts[0]!.canceledAfterGateFailure) return false;
      continue;
    }
    if (admission.length !== 1) return false;
    const event = admission[0]!;
    if (!Number.isFinite(event.blockClaimedAtMs)) return false;
    const sealedWindow = schedule[call.block - 1];
    const opensAtMs = Date.parse(sealedWindow!.opensAt);
    const launchDeadlineMs = Date.parse(sealedWindow!.launchDeadline);
    if (event.blockClaimedAtMs! < opensAtMs || event.blockClaimedAtMs! >= launchDeadlineMs) return false;
    const priorClaim = blockClaims.get(call.block);
    if (priorClaim !== undefined && priorClaim !== event.blockClaimedAtMs) return false;
    blockClaims.set(call.block, event.blockClaimedAtMs!);
    const resumed=rows.laneBacklog.filter(item=>item.requestId===call.requestId&&item.lane===call.lane
      &&item.block===call.block&&item.callOrdinal===call.callOrdinal);
    if(resumed.length>1||resumed.some(item=>item.state!=="terminal"||!Number.isFinite(item.actualScheduledAtMs)))return false;
    const isFirstWindow = call.callOrdinal === 1 || call.lane === "bounded-burst";
    const scheduled = resumed.length===1 ? resumed[0]!.actualScheduledAtMs!
      : isFirstWindow ? event.blockClaimedAtMs! + 1_000 : (event.priorTerminalAtMs ?? Number.NaN) + 5_000;
    if (!Number.isFinite(scheduled) || event.databaseTimeMs < scheduled || event.databaseTimeMs >= scheduled + 1_000) return false;
    const token = one(rows.dispatchTokens, call.requestId);
    const authorized = events.filter((item) => item.eventType === "dispatch_authorized");
    const primitive = events.filter((item) => item.eventType === "dispatch_primitive_entered");
    if ((token !== null) !== (authorized.length === 1) || primitive.length > 1 || (token?.primitiveEntered === true) !== (primitive.length === 1)) return false;
    const ambiguity = events.filter((item) => item.eventType === "ambiguity_entered");
    if (ambiguity.length > 1) return false;
    if (attempts[0]!.state === "unresolved_provider_outcome" && ambiguity.length !== 1) return false;
  }
  return true;
}

function outcomeMatrixValid(rows: EvidenceClosureRows): boolean {
  for (const attempt of rows.attempts) {
    if (attempt.gateClassificationCount !== 1) return false;
    const execution = one(rows.executions, attempt.requestId);
    const decision = one(rows.decisions, attempt.requestId);
    const token = one(rows.dispatchTokens, attempt.requestId);
    const queue = one(rows.shadowQueue, attempt.requestId);
    const evidence = one(rows.shadowEvidence, attempt.requestId);
    if (USABLE.has(attempt.state)) {
      if (!execution || execution.status !== "completed" || execution.actualCostMicros !== attempt.actualCostMicros
        || execution.shadowOrderState !== "queued" || !Number.isSafeInteger(execution.cohortOrdinal) || (execution.cohortOrdinal ?? 0) < 1
        || !decision || decision.outcome !== "ALLOW" || !token || !token.primitiveEntered || !queue || queue.state !== "completed"
        || !Number.isSafeInteger(queue.attempts) || queue.attempts < 1 || queue.attempts > 3 || !evidence || attempt.actualCostMicros === null) return false;
      continue;
    }
    if (queue || evidence) return false;
    if (attempt.state === "not_dispatched") {
      const beforeAdmission = !execution && !decision && !token;
      const denied = execution?.status === "denied" && decision?.outcome === "DENY" && !token;
      const beforeToken = execution?.status === "failed" && decision?.outcome === "ALLOW" && !token;
      const beforePrimitive = execution?.status === "failed" && decision?.outcome === "ALLOW" && token?.preDispatchProof && !token.primitiveEntered;
      if (!(beforeAdmission || denied || beforeToken || beforePrimitive) || attempt.actualCostMicros !== "0") return false;
    } else if (attempt.state === "unresolved_provider_outcome") {
      if (execution?.status !== "reconciliation_hold" || decision?.outcome !== "ALLOW" || !token?.primitiveEntered) return false;
    } else {
      if (execution?.status !== "failed" || decision?.outcome !== "ALLOW" || !token?.primitiveEntered) return false;
      if ((attempt.state === "terminal_rejected_not_billed" || attempt.state === "reconciled_not_billed") && attempt.actualCostMicros !== "0") return false;
      if (attempt.state === "reconciled_billed_no_response" && attempt.actualCostMicros === null) return false;
    }
  }
  return true;
}

function replayMatrixValid(rows: EvidenceClosureRows, targets: readonly string[]): boolean {
  const sealed = new Set(rows.sealedCalls.map((row) => row.requestId));
  if (targets.length !== 20 || !unique(targets) || targets.some((id) => !sealed.has(id))
    || !exactIds(rows.replayAudits.map((row) => row.requestId), targets)) return false;
  return [...rows.replayAudits].sort((a, b) => a.replayNo - b.replayNo).every((row, index) =>
    row.replayNo === index + 1 && SHA256.test(row.originalResponseCommitment)
    && row.originalResponseCommitment === row.replayResponseCommitment && row.writeSet.length === 0
    && USABLE.has(rows.attempts.find((attempt) => attempt.requestId === row.requestId)!.state));
}

export function evaluateSettlementSnapshotCompleteness(input: {
  rows: EvidenceClosureRows;
  replayTargetRequestIds: readonly string[];
  schedule?: ReliabilitySchedule;
}): { complete: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!sealedRegistryValid(input.rows)) reasons.push("SEALED_REGISTRY_INVALID");
  if (!outcomeMatrixValid(input.rows)) reasons.push("SNAPSHOT_OUTCOME_MATRIX_INVALID");
  if (!replayMatrixValid(input.rows, input.replayTargetRequestIds)) reasons.push("SNAPSHOT_REPLAY_MATRIX_INVALID");
  if (!lifecycleAndScheduleValid(input.rows, input.schedule ?? V2_SCHEDULE)) reasons.push("SCHEDULE_LIFECYCLE_INVALID");
  return { complete: reasons.length === 0, reasons };
}

export interface AuthoritativeClosureReport {
  schemaVersion: 2;
  runId: string;
  passed: boolean;
  reasons: string[];
  acceptedSnapshot: { digest: string; databaseStartedAtMs: number };
  counts: { planned: number; usable: number; unresolved: number; ambiguous: number; replayAudits: number };
  diagnostics: null | {
    usable: { successes: number; trials: 100; lower: number; displayLower: string };
    unresolved: { successes: number; trials: 100; upper: number; displayUpper: string };
  };
  diagnosticsSuppressedReason: null | "EARLY_STOP_NOT_BINOMIAL";
}

export function buildAuthoritativeClosureReport(input: {
  runId: string;
  rows: EvidenceClosureRows;
  replayTargetRequestIds: readonly string[];
  acceptedSnapshot: { digest: string; databaseStartedAtMs: number };
  settlement: { passed: boolean; acceptedSnapshotDigest: string };
}): AuthoritativeClosureReport {
  const schedule = reliabilityScheduleForRunId(input.runId);
  const completeness = evaluateSettlementSnapshotCompleteness({ rows: input.rows, replayTargetRequestIds: input.replayTargetRequestIds, schedule });
  const reasons = [...completeness.reasons];
  const currentDigest = authoritativeSnapshotDigest(input.rows as unknown as Readonly<Record<string, readonly unknown[]>>);
  if (!input.settlement.passed || input.acceptedSnapshot.digest !== input.settlement.acceptedSnapshotDigest
    || currentDigest !== input.acceptedSnapshot.digest || !SHA256.test(input.acceptedSnapshot.digest)) reasons.push("REPORT_ACCEPTED_SNAPSHOT_MISMATCH");
  const usable = input.rows.attempts.filter((row) => USABLE.has(row.state)).length;
  const unresolved = input.rows.attempts.filter((row) => row.state === "unresolved_provider_outcome").length;
  const ambiguous = new Set(input.rows.lifecycleEvents.filter((row) => row.eventType === "ambiguity_entered").map((row) => row.requestId)).size;
  const fullTrial = input.rows.attempts.length === 100 && input.rows.attempts.every((row) => row.admissionStarted && !row.canceledAfterGateFailure);
  const bounds = fullTrial ? clopperPearsonDiagnostics({ planned: 100, admissionStarted: 100, canceledAfterGateFailure: 0, usable, unresolved }) : null;
  return {
    schemaVersion: 2, runId: input.runId, passed: reasons.length === 0, reasons,
    acceptedSnapshot: input.acceptedSnapshot,
    counts: { planned: input.rows.sealedCalls.length, usable, unresolved, ambiguous, replayAudits: input.rows.replayAudits.length },
    diagnostics: bounds ? {
      usable: { successes: usable, trials: 100, lower: bounds.usableLower, displayLower: bounds.usableLower.toFixed(6) },
      unresolved: { successes: unresolved, trials: 100, upper: bounds.unresolvedUpper, displayUpper: bounds.unresolvedUpper.toFixed(6) },
    } : null,
    diagnosticsSuppressedReason: bounds ? null : "EARLY_STOP_NOT_BINOMIAL",
  };
}

export type HardFinalizationPlan =
  | { action: "wait"; wakeAtMs: number }
  | { action: "already_terminal" }
  | {
    action: "finalize_failure";
    lockOrder: ["protocol_control", "protocol_attempts"];
    transition: { from: "active"; to: "failed"; reason: "HARD_FINALIZATION_DEADLINE" };
    terminalize: string[];
    terminalState: "unresolved_provider_outcome";
    appendGateClassification: true;
    cancelFutureAdmissionsAndReplays: true;
    persistReplayCancellations: true;
    createCanceledArtifacts: true;
    incident: { eventType: "hard_finalization_deadline" };
    publishCreateOnlyFailureReport: true;
    reportPublicationDeadlineMs: number;
  };

/** Produces the complete transaction/publication intent; callers may not select sub-actions. */
export function planHardFinalization(input: {
  databaseNowMs: number;
  deadlineMs: number;
  runState: "active" | "failed" | "terminal";
  nonterminalRequestIds: readonly string[];
}): HardFinalizationPlan {
  if (![input.databaseNowMs, input.deadlineMs].every(Number.isFinite) || !unique(input.nonterminalRequestIds)) throw new Error("HARD_FINALIZATION_INPUT_INVALID");
  if (input.runState === "terminal" && input.nonterminalRequestIds.length === 0) return { action: "already_terminal" };
  if (input.databaseNowMs < input.deadlineMs) return { action: "wait", wakeAtMs: input.deadlineMs };
  return {
    action: "finalize_failure", lockOrder: ["protocol_control", "protocol_attempts"],
    transition: { from: "active", to: "failed", reason: "HARD_FINALIZATION_DEADLINE" },
    terminalize: [...input.nonterminalRequestIds].sort(), terminalState: "unresolved_provider_outcome",
    appendGateClassification: true, cancelFutureAdmissionsAndReplays: true,
    persistReplayCancellations: true, createCanceledArtifacts: true,
    incident: { eventType: "hard_finalization_deadline" }, publishCreateOnlyFailureReport: true,
    reportPublicationDeadlineMs: input.databaseNowMs + 60_000,
  };
}
