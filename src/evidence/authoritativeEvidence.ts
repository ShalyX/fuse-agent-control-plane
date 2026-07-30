import { createHash } from "node:crypto";

export type AuthoritativeOutcomeState =
  | "not_dispatched"
  | "completed_verified"
  | "terminal_rejected_not_billed"
  | "reconciled_not_billed"
  | "reconciled_billed_with_response"
  | "reconciled_billed_no_response"
  | "unresolved_provider_outcome";

export interface AuthoritativeAttemptRow {
  requestId: string;
  state: AuthoritativeOutcomeState;
  gateClassificationCount: number;
  admissionStarted: boolean;
  actualCostMicros: string | null;
  reservedCostMicros: string;
}
export interface AuthoritativeExecutionRow {
  requestId: string;
  status: "denied" | "failed" | "completed" | "reconciliation_hold";
  actualCostMicros: string | null;
  shadowOrderState: "queued" | null;
  cohortOrdinal: number | null;
}
export interface AuthoritativeDecisionRow { requestId: string; outcome: "ALLOW" | "DENY" }
export interface AuthoritativeDispatchTokenRow { requestId: string; primitiveEntered: boolean; preDispatchProof: boolean }
export interface AuthoritativeShadowQueueRow { requestId: string; state: "completed" | "pending" | "failed"; attempts: number }
export interface AuthoritativeReplayAuditRow {
  requestId: string; replayNo: number; originalResponseCommitment: string;
  replayResponseCommitment: string; writeSet: string[];
}
export interface AuthoritativeReconciliationRow {
  requestId: string; accepted: boolean; terminalState: Exclude<AuthoritativeOutcomeState, "not_dispatched" | "completed_verified">;
}

export interface AuthoritativeEvidenceInventory {
  runId: string;
  planFingerprint: string;
  requestIds: string[];
  replayTargetRequestIds: string[];
  attempts: AuthoritativeAttemptRow[];
  executions: AuthoritativeExecutionRow[];
  decisions: AuthoritativeDecisionRow[];
  dispatchTokens: AuthoritativeDispatchTokenRow[];
  shadowQueue: AuthoritativeShadowQueueRow[];
  shadowEvidence: Array<{ requestId: string }>;
  replayAudits: AuthoritativeReplayAuditRow[];
  authorizationReceipts: Array<{ kind: "operator" | "reconciliation"; status: string; path: string }>;
  signedAuthorizations: Array<{ kind: "operator" | "reconciliation"; path: string }>;
  claims: Array<{ lane: string; terminal: boolean; path: string }>;
  manifests: Array<{ lane: string; block: number; terminal: boolean; digest: string; path: string }>;
  reconciliation: AuthoritativeReconciliationRow[];
  incidents: Array<{ sequence: number; eventType: string; path: string }>;
  settlement: {
    passed: boolean; acceptedOffsetSeconds: number | null; journalCardinality: number;
    finalSnapshotDigest: string; finalRowCardinality: number;
  };
  costs: {
    knownCostMicros: string; unresolvedExposureMicros: string;
    knownCostCapMicros: string; unresolvedExposureCapMicros: string;
  };
  hardFinalization: { allTerminal: boolean; finalizedAt: string; deadline: string };
  artifactPaths: string[];
}

export interface AuthoritativeEvidenceReport {
  schemaVersion: 1;
  runId: string;
  passed: boolean;
  reasons: string[];
  counts: {
    planned: number; classified: number; usable: number; unresolved: number;
    replayAudits: number; claims: number; manifests: number; incidents: number;
  };
  outcomeCounts: Record<AuthoritativeOutcomeState, number>;
  inventoryDigest: string;
}

const LANES = ["normal-paced", "high-envelope", "bounded-burst", "restart-resume"] as const;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_STATES: readonly AuthoritativeOutcomeState[] = [
  "not_dispatched", "completed_verified", "terminal_rejected_not_billed", "reconciled_not_billed",
  "reconciled_billed_with_response", "reconciled_billed_no_response", "unresolved_provider_outcome",
];

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
}
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function exactMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return unique(actual) && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}
function exactNonnegativeMicros(value: string | null): bigint | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}
function rowsFor<T extends { requestId: string }>(rows: readonly T[], requestId: string): T[] {
  return rows.filter((row) => row.requestId === requestId);
}

export function expectedReliabilityArtifactPaths(input: {
  runId: string; planFingerprint: string; lanes?: readonly string[]; incidentPaths: readonly string[];
}): string[] {
  const lanes = input.lanes ?? LANES;
  return [
    "evidence/held-out-reliability/protocols/held-out-reliability-v2.json",
    "evidence/held-out-reliability/beacons/drand-6315000.json",
    `evidence/held-out-reliability/plans/${input.planFingerprint}.json`,
    `evidence/held-out-reliability/authorizations/operator/${input.runId}.json`,
    `evidence/held-out-reliability/authorizations/reconciliation/${input.runId}.json`,
    `evidence/held-out-reliability/authorization-receipts/operator/${input.runId}.json`,
    `evidence/held-out-reliability/authorization-receipts/reconciliation/${input.runId}.json`,
    ...lanes.map((lane) => `evidence/.run-claims/held-out-reliability/${input.runId}/${lane}.claim`),
    ...lanes.flatMap((lane) => Array.from({ length: 5 }, (_, index) => `evidence/held-out-reliability/manifests/${input.runId}/${lane}-${index + 1}.json`)),
    `evidence/held-out-reliability/replay-preliminary/${input.runId}.json`,
    ...input.incidentPaths,
  ].sort();
}

function matrixValid(input: AuthoritativeEvidenceInventory): boolean {
  for (const attempt of input.attempts) {
    const executions = rowsFor(input.executions, attempt.requestId);
    const decisions = rowsFor(input.decisions, attempt.requestId);
    const tokens = rowsFor(input.dispatchTokens, attempt.requestId);
    const queues = rowsFor(input.shadowQueue, attempt.requestId);
    const evidence = rowsFor(input.shadowEvidence, attempt.requestId);
    const reconciliation = rowsFor(input.reconciliation, attempt.requestId);
    const actual = exactNonnegativeMicros(attempt.actualCostMicros);
    const reservation = exactNonnegativeMicros(attempt.reservedCostMicros);
    if (reservation === null) return false;
    const decision = decisions[0];
    const execution = executions[0];
    const token = tokens[0];
    const behavioral = attempt.state === "completed_verified" || attempt.state === "reconciled_billed_with_response";
    if (behavioral) {
      if (executions.length !== 1 || execution?.status !== "completed" || decisions.length !== 1 || decision?.outcome !== "ALLOW"
        || tokens.length !== 1 || token?.primitiveEntered !== true || actual === null || actual > reservation || execution.actualCostMicros !== attempt.actualCostMicros
        || execution.shadowOrderState !== "queued" || !Number.isSafeInteger(execution.cohortOrdinal) || (execution.cohortOrdinal ?? 0) < 1
        || queues.length !== 1 || queues[0]?.state !== "completed" || !Number.isInteger(queues[0].attempts)
        || queues[0].attempts < 1 || queues[0].attempts > 3 || evidence.length !== 1) return false;
      if (attempt.state === "completed_verified" && reconciliation.length !== 0) return false;
      if (attempt.state === "reconciled_billed_with_response" && !hasAcceptedResolution(reconciliation, attempt.state)) return false;
      continue;
    }
    if (queues.length !== 0 || evidence.length !== 0) return false;
    if (attempt.state === "not_dispatched") {
      const beforeAdmission = executions.length === 0 && decisions.length === 0 && tokens.length === 0;
      const denied = executions.length === 1 && execution?.status === "denied" && decisions.length === 1 && decision?.outcome === "DENY" && tokens.length === 0;
      const failedBeforeToken = executions.length === 1 && execution?.status === "failed" && decisions.length === 1 && decision?.outcome === "ALLOW" && tokens.length === 0;
      const provenBeforePrimitive = executions.length === 1 && execution?.status === "failed" && decisions.length === 1 && decision?.outcome === "ALLOW"
        && tokens.length === 1 && token?.preDispatchProof === true && token.primitiveEntered === false;
      if (!(beforeAdmission || denied || failedBeforeToken || provenBeforePrimitive) || actual !== 0n || reconciliation.length !== 0) return false;
    } else if (attempt.state === "unresolved_provider_outcome") {
      if (executions.length !== 1 || execution?.status !== "reconciliation_hold" || decisions.length !== 1 || decision?.outcome !== "ALLOW"
        || tokens.length !== 1 || token?.primitiveEntered !== true || reconciliation.length !== 1 || reconciliation[0]?.terminalState !== attempt.state || reconciliation[0].accepted) return false;
    } else {
      if (executions.length !== 1 || execution?.status !== "failed" || decisions.length !== 1 || decision?.outcome !== "ALLOW"
        || tokens.length !== 1 || token?.primitiveEntered !== true
        || !hasAcceptedResolution(reconciliation, attempt.state)) return false;
      const zeroCost = attempt.state === "terminal_rejected_not_billed" || attempt.state === "reconciled_not_billed";
      if (zeroCost ? actual !== 0n : actual === null) return false;
    }
  }
  const planned = new Set(input.requestIds);
  return [input.executions, input.decisions, input.dispatchTokens, input.shadowQueue, input.shadowEvidence, input.reconciliation]
    .every((rows) => rows.every((row) => planned.has(row.requestId)));
}
function hasAcceptedResolution(rows: readonly AuthoritativeReconciliationRow[], state: AuthoritativeOutcomeState): boolean {
  return rows.length === 1 && rows[0]?.accepted === true && rows[0].terminalState === state;
}

export function reduceAuthoritativeReliabilityEvidence(input: AuthoritativeEvidenceInventory): AuthoritativeEvidenceReport {
  const reasons: string[] = [];
  const plannedValid = input.requestIds.length === 100 && unique(input.requestIds);
  const attemptsValid = input.attempts.length === 100 && unique(input.attempts.map((row) => row.requestId))
    && exactMembers(input.attempts.map((row) => row.requestId), input.requestIds)
    && input.attempts.every((row) => TERMINAL_STATES.includes(row.state));
  if (!plannedValid || !attemptsValid) reasons.push("ATTEMPT_INVENTORY_INVALID");
  if (!attemptsValid || input.attempts.some((row) => row.gateClassificationCount !== 1)) reasons.push("CLASSIFICATION_CARDINALITY_INVALID");
  if (!attemptsValid || !matrixValid(input)) reasons.push("OUTCOME_MATRIX_INVALID");

  const replayInventoryValid = input.replayTargetRequestIds.length === 20 && unique(input.replayTargetRequestIds)
    && input.replayTargetRequestIds.every((id) => input.requestIds.includes(id))
    && input.replayTargetRequestIds.every((id) => input.attempts.some((row) => row.requestId === id
      && (row.state === "completed_verified" || row.state === "reconciled_billed_with_response")))
    && input.replayAudits.length === 20 && unique(input.replayAudits.map((row) => row.requestId))
    && exactMembers(input.replayAudits.map((row) => row.requestId), input.replayTargetRequestIds)
    && [...input.replayAudits].sort((a, b) => a.replayNo - b.replayNo).every((row, index) => row.replayNo === index + 1)
    && input.replayAudits.every((row) => SHA256.test(row.originalResponseCommitment) && row.originalResponseCommitment === row.replayResponseCommitment);
  if (!replayInventoryValid) reasons.push("REPLAY_AUDIT_INVENTORY_INVALID");
  if (input.replayAudits.some((row) => row.writeSet.length !== 0)) reasons.push("REPLAY_WRITE_SET_NOT_EMPTY");

  const expectedReceipts = [
    `operator:consumed:evidence/held-out-reliability/authorization-receipts/operator/${input.runId}.json`,
    `reconciliation:validated:evidence/held-out-reliability/authorization-receipts/reconciliation/${input.runId}.json`,
  ];
  const actualReceipts = input.authorizationReceipts.map((row) => `${row.kind}:${row.status}:${row.path}`);
  const signed = input.signedAuthorizations.map((row) => `${row.kind}:${row.path}`);
  if (!exactMembers(actualReceipts, expectedReceipts) || !exactMembers(signed, [
    `operator:evidence/held-out-reliability/authorizations/operator/${input.runId}.json`,
    `reconciliation:evidence/held-out-reliability/authorizations/reconciliation/${input.runId}.json`,
  ])) reasons.push("AUTHORIZATION_RECEIPTS_INVALID");

  // Protocol source of truth (docs lines 420 and 426) requires one claim per lane.
  // The prior five block-claim interpretation was contradictory and is rejected.
  const claimPaths = LANES.map((lane) => `evidence/.run-claims/held-out-reliability/${input.runId}/${lane}.claim`);
  if (input.claims.length !== 4 || unique(input.claims.map((row) => row.lane)) === false
    || !input.claims.every((row) => row.terminal && LANES.includes(row.lane as typeof LANES[number]))
    || !exactMembers(input.claims.map((row) => row.path), claimPaths)) reasons.push("CLAIM_INVENTORY_INVALID");

  const expectedManifests = LANES.flatMap((lane) => Array.from({ length: 5 }, (_, index) => `evidence/held-out-reliability/manifests/${input.runId}/${lane}-${index + 1}.json`));
  if (input.manifests.length !== 20 || !input.manifests.every((row) => row.terminal && SHA256.test(row.digest))
    || !exactMembers(input.manifests.map((row) => row.path), expectedManifests)) reasons.push("MANIFEST_INVENTORY_INVALID");

  if (!input.settlement.passed || input.settlement.acceptedOffsetSeconds === null
    || !Number.isInteger(input.settlement.acceptedOffsetSeconds) || input.settlement.acceptedOffsetSeconds < 0
    || input.settlement.acceptedOffsetSeconds > 120 || input.settlement.acceptedOffsetSeconds % 5 !== 0
    || input.settlement.journalCardinality !== input.settlement.acceptedOffsetSeconds / 5 + 1
    || !SHA256.test(input.settlement.finalSnapshotDigest) || input.settlement.finalRowCardinality < 100) reasons.push("SETTLEMENT_INVALID");

  const known = exactNonnegativeMicros(input.costs.knownCostMicros);
  const unresolved = exactNonnegativeMicros(input.costs.unresolvedExposureMicros);
  const knownCap = exactNonnegativeMicros(input.costs.knownCostCapMicros);
  const unresolvedCap = exactNonnegativeMicros(input.costs.unresolvedExposureCapMicros);
  const authoritativeKnown = input.attempts.reduce((sum, row) =>
    row.state === "unresolved_provider_outcome" ? sum : sum + (exactNonnegativeMicros(row.actualCostMicros) ?? 0n), 0n);
  const authoritativeUnresolved = input.attempts.reduce((sum, row) =>
    row.state === "unresolved_provider_outcome" ? sum + (exactNonnegativeMicros(row.reservedCostMicros) ?? 0n) : sum, 0n);
  if (known === null || knownCap === null || knownCap !== 3_000_000n || known !== authoritativeKnown || known > knownCap) reasons.push("KNOWN_COST_CAP_EXCEEDED");
  if (unresolved === null || unresolvedCap === null || unresolvedCap !== 320_000n || unresolved !== authoritativeUnresolved
    || unresolved > unresolvedCap || unresolved !== 0n) reasons.push("UNRESOLVED_EXPOSURE_INVALID");

  const finalizedAt = Date.parse(input.hardFinalization.finalizedAt);
  const deadline = Date.parse(input.hardFinalization.deadline);
  if (!input.hardFinalization.allTerminal || input.hardFinalization.deadline !== "2026-07-28T09:30:00.000Z"
    || !Number.isFinite(finalizedAt) || !Number.isFinite(deadline) || finalizedAt > deadline) reasons.push("HARD_FINALIZATION_INVALID");

  const incidentPaths = input.incidents.map((row) => row.path);
  const incidentsValid = unique(incidentPaths) && [...input.incidents].sort((a, b) => a.sequence - b.sequence).every((row, index) =>
    row.sequence === index + 1 && /^[a-z0-9_]+$/.test(row.eventType)
      && row.path === `evidence/held-out-reliability/incidents/${input.runId}/${row.sequence}-${row.eventType}.json`);
  if (!incidentsValid) reasons.push("INCIDENT_INVENTORY_INVALID");

  const expectedPaths = expectedReliabilityArtifactPaths({ runId: input.runId, planFingerprint: input.planFingerprint, incidentPaths });
  if (!exactMembers(input.artifactPaths, expectedPaths)) reasons.push("ARTIFACT_PATH_INVENTORY_INVALID");

  const outcomeCounts = Object.fromEntries(TERMINAL_STATES.map((state) => [state, input.attempts.filter((row) => row.state === state).length])) as Record<AuthoritativeOutcomeState, number>;
  const usable = outcomeCounts.completed_verified + outcomeCounts.reconciled_billed_with_response;
  if (usable < 99 || outcomeCounts.not_dispatched !== 0) reasons.push("USABLE_OUTCOMES_INVALID");
  if (outcomeCounts.unresolved_provider_outcome !== 0) reasons.push("UNRESOLVED_OUTCOME");
  const nonusable = outcomeCounts.terminal_rejected_not_billed + outcomeCounts.reconciled_not_billed + outcomeCounts.reconciled_billed_no_response;
  if (nonusable > 1) reasons.push("NONUSABLE_ALLOWANCE_EXCEEDED");

  const counts = {
    planned: input.requestIds.length, classified: input.attempts.reduce((sum, row) => sum + row.gateClassificationCount, 0),
    usable, unresolved: outcomeCounts.unresolved_provider_outcome, replayAudits: input.replayAudits.length,
    claims: input.claims.length, manifests: input.manifests.length, incidents: input.incidents.length,
  };
  const inventoryDigest = digest({
    runId: input.runId, planFingerprint: input.planFingerprint, counts, outcomeCounts,
    reasons, settlement: input.settlement, artifactPaths: [...input.artifactPaths].sort(),
  });
  return { schemaVersion: 1, runId: input.runId, passed: reasons.length === 0, reasons, counts, outcomeCounts, inventoryDigest };
}
