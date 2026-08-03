import { createHash } from "node:crypto";
import { buildAuthoritativeClosureReport, type AuthoritativeClosureReport, type EvidenceClosureRows } from "./evidenceSettlementClosure.js";
import { reduceAuthoritativeReliabilityEvidence, type AuthoritativeEvidenceInventory, type AuthoritativeEvidenceReport } from "./authoritativeEvidence.js";
import { canonicalJson } from "./heldOutReliabilityV2.js";
import { reliabilityArtifactNamespace, reliabilityArtifactPath } from "./reliabilityArtifactNamespace.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const NONNEGATIVE = /^(0|[1-9][0-9]*)$/;

export const AUTHORITATIVE_SNAPSHOT_INVENTORIES = [
  "sealedCalls", "attempts", "executions", "decisions", "shadowQueue", "shadowEvidence",
  "dispatchTokens", "lifecycleEvents", "replayAudits", "replayCancellations",
  "protocolControls", "protocolLanes", "blockClaims", "laneBacklog", "authorizationDecisions", "authorizationOutbox",
  "reconciliationAttempts", "reconciliationEvidence", "holds", "incidents", "schedulerClaims", "costRows",
  "artifactBindings",
] as const;

export type AuthoritativeSnapshotInventoryName = typeof AUTHORITATIVE_SNAPSHOT_INVENTORIES[number];
export type DurableReliabilityStage = "running" | "fresh_terminal" | "replay_terminal" | "artifact_bound" | "settled" | "final_committed";

function rows(value: unknown): Array<Record<string, unknown>> | null {
  return Array.isArray(value) && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
    ? value as Array<Record<string, unknown>> : null;
}

function exactArtifactBindings(bindings: Array<Record<string, unknown>>, expected: Readonly<Record<string, string>>): boolean {
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  const actual = bindings.map((row) => [row["path"], row["digest"]] as const).sort(([left], [right]) => String(left).localeCompare(String(right)));
  return actual.length === expectedEntries.length
    && new Set(actual.map(([path]) => path)).size === actual.length
    && actual.every(([path, digest], index) => typeof path === "string" && SHA256.test(String(digest))
      && path === expectedEntries[index]?.[0] && digest === expectedEntries[index]?.[1]);
}

function authorizationOutboxBoundToArtifacts(
  outbox: Array<Record<string, unknown>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return (["operator", "reconciliation"] as const).every((kind) => {
    const row = outbox.find((candidate) => candidate["kind"] === kind);
    const receipt = row?.["receipt"];
    if (row?.["published"] !== true || receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return false;
    const parsed = receipt as Record<string, unknown>;
    const runId = parsed["runId"];
    const presented = parsed["presentedArtifactSha256"];
    if (typeof runId !== "string" || !runId || !SHA256.test(String(presented))
      || parsed["artifactKind"] !== "authorization_receipt" || parsed["kind"] !== kind
      || parsed["status"] !== (kind === "operator" ? "consumed" : "validated")) return false;
    const receiptEntries = Object.entries(expected).filter(([path]) => path.endsWith(`/authorization-receipts/${kind}/${runId}.json`));
    const signedEntries = Object.entries(expected).filter(([path]) => path.endsWith(`/authorizations/${kind}/${runId}.json`));
    const receiptDigest = `sha256:${createHash("sha256").update(`${canonicalJson(receipt)}\n`).digest("hex")}`;
    return receiptEntries.length === 1 && signedEntries.length === 1
      && receiptEntries[0]![1] === receiptDigest && signedEntries[0]![1] === presented;
  });
}

/**
 * Validates the additional authoritative inventories which must participate in
 * the accepted repeatable-read snapshot. Absence is different from an empty
 * inventory: every named table must be represented by the snapshot reader.
 */
export function assertAcceptedSnapshotAuthority(
  input: Readonly<Record<string, unknown>>,
  expectedArtifactDigests: Readonly<Record<string, string>>,
): { complete: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const inventories = new Map<string, Array<Record<string, unknown>>>();
  for (const key of AUTHORITATIVE_SNAPSHOT_INVENTORIES) {
    const inventory = rows(input[key]);
    if (inventory === null) reasons.push(`SNAPSHOT_INVENTORY_MISSING:${key}`);
    else inventories.set(key, inventory);
  }
  const controls = inventories.get("protocolControls") ?? [];
  if (controls.length !== 1 || controls[0]?.["state"] === "failed" || Number(controls[0]?.["failureSequence"]) !== 0
    || Number(controls[0]?.["gateClassificationCount"]) !== 100 || Number(controls[0]?.["replayPassedCount"]) !== 20) {
    reasons.push("SNAPSHOT_PROTOCOL_CONTROL_INVALID");
  }
  const decisions = inventories.get("authorizationDecisions") ?? [];
  if (decisions.length !== 1 || decisions[0]?.["active"] !== true || decisions[0]?.["operatorValid"] !== true
    || decisions[0]?.["reconciliationValid"] !== true || decisions[0]?.["decisionIdValid"] !== true) reasons.push("SNAPSHOT_AUTHORIZATION_INVALID");
  const outbox = inventories.get("authorizationOutbox") ?? [];
  if (outbox.length !== 2 || !authorizationOutboxBoundToArtifacts(outbox, expectedArtifactDigests))
    reasons.push("SNAPSHOT_AUTHORIZATION_OUTBOX_INVALID");
  const holds = inventories.get("holds") ?? [];
  if (holds.some((row) => row["resolved"] !== true || !Array.isArray(row["heldUnresolved"]) || row["heldUnresolved"].length !== 0))
    reasons.push("SNAPSHOT_HOLD_UNRESOLVED");
  const incidents = inventories.get("incidents") ?? [];
  if (incidents.length !== 0) reasons.push("SNAPSHOT_INCIDENT_PRESENT");
  const reconciliationAttempts = inventories.get("reconciliationAttempts") ?? [];
  if (reconciliationAttempts.some((row) => !["terminal", "committed", "canceled_terminal"].includes(String(row["phase"]))))
    reasons.push("SNAPSHOT_RECONCILIATION_NONTERMINAL");
  const bindings = inventories.get("artifactBindings") ?? [];
  const bindingByPath=new Map(bindings.map(row=>[String(row["path"]),String(row["digest"])]));
  const claims = inventories.get("schedulerClaims") ?? [];
  if (claims.some((row) => row["state"] !== "terminal" || row["manifestFsynced"]!==true
    || !SHA256.test(String(row["manifestDigest"]))
    || bindingByPath.get(String(row["manifestPath"]))!==String(row["manifestDigest"])))
    reasons.push("SNAPSHOT_CLAIM_INVALID");
  const costs = inventories.get("costRows") ?? [];
  if (costs.length !== 1 || !NONNEGATIVE.test(String(costs[0]?.["knownCostMicros"]))
    || BigInt(String(costs[0]?.["knownCostMicros"] ?? "-1")) > 3_000_000n
    || costs[0]?.["unresolvedExposureMicros"] !== "0") reasons.push("SNAPSHOT_COST_INVALID");
  if (!exactArtifactBindings(bindings, expectedArtifactDigests)) reasons.push("SNAPSHOT_ARTIFACT_BINDING_INVALID");
  return { complete: reasons.length === 0, reasons };
}

const STAGE_ORDER: readonly DurableReliabilityStage[] = ["running", "fresh_terminal", "replay_terminal", "artifact_bound", "settled", "final_committed"];

export function planDurableStageTransition(input: {
  stage: DurableReliabilityStage;
  terminalFresh: number;
  openHolds: number;
  replayAudits: number;
  artifactsBound?: boolean;
  settlementPassed: boolean;
}, target: Exclude<DurableReliabilityStage, "running">): DurableReliabilityStage {
  if (STAGE_ORDER.indexOf(target) !== STAGE_ORDER.indexOf(input.stage) + 1) throw new Error("DURABLE_STAGE_ORDER_INVALID");
  if (target === "fresh_terminal" && (input.terminalFresh !== 100 || input.openHolds !== 0)) throw new Error("FRESH_TERMINAL_INVENTORY_INCOMPLETE");
  if (target === "replay_terminal" && input.replayAudits !== 20) throw new Error("REPLAY_INVENTORY_INCOMPLETE");
  if (target === "artifact_bound" && !input.artifactsBound) throw new Error("ARTIFACT_BINDING_INCOMPLETE");
  if (target === "settled" && !input.settlementPassed) throw new Error("ACCEPTED_SETTLEMENT_REQUIRED");
  return target;
}

export function canonicalFinalCommitPath(runId: string): string {
  return reliabilityArtifactPath(runId, "replay", `${runId}.json`);
}

/** Replay is diagnostic until settlement. It must never occupy the canonical commit path. */
export function preliminaryReplayArtifactPath(runId: string): string {
  return reliabilityArtifactPath(runId, "replay-preliminary", `${runId}.json`);
}

export interface UnifiedFinalEvidenceReport extends AuthoritativeClosureReport {
  strict: AuthoritativeEvidenceReport;
  snapshotAuthority: { complete: boolean; reasons: string[] };
}

/** The one production final-report reducer. No caller may choose a permissive verdict. */
export function finalEvidenceClosure(input: {
  closure: {
    runId: string;
    rows: EvidenceClosureRows;
    replayTargetRequestIds: readonly string[];
    acceptedSnapshot: { digest: string; databaseStartedAtMs: number };
    settlement: { passed: boolean; acceptedSnapshotDigest: string };
  };
  strictInventory: AuthoritativeEvidenceInventory;
  expectedArtifactDigests: Readonly<Record<string, string>>;
}): UnifiedFinalEvidenceReport {
  const closure = buildAuthoritativeClosureReport(input.closure);
  const strict = reduceAuthoritativeReliabilityEvidence(input.strictInventory);
  const snapshotAuthority = assertAcceptedSnapshotAuthority(
    input.closure.rows as unknown as Readonly<Record<string, unknown>>,
    input.expectedArtifactDigests,
  );
  const reasons = [...new Set([...closure.reasons, ...snapshotAuthority.reasons, ...strict.reasons])];
  return { ...closure, passed: reasons.length === 0, reasons, strict, snapshotAuthority };
}

export interface CanonicalFinalCommitMarker {
  evidenceType: "held-out-reliability" | "held-out-reliability-v3";
  protocolVersion: 2 | 3;
  artifactKind: "final_commit";
  state: "committed";
  runId: string;
  planFingerprint: string;
  passed: boolean;
  settlement: { acceptedSnapshotDigest: string; journalCardinality: number };
  authoritativeInventoryDigest: string;
  artifactDigests: Readonly<Record<string, string>>;
}

export function buildCanonicalFinalCommitMarker(input: {
  runId: string;
  planFingerprint: string;
  stage: DurableReliabilityStage;
  reportPassed: boolean;
  settlementDigest: string;
  settlementJournalCardinality: number;
  authoritativeInventoryDigest: string;
  artifactDigests: Readonly<Record<string, string>>;
}): CanonicalFinalCommitMarker {
  if (input.stage !== "settled") throw new Error("SETTLEMENT_REQUIRED_BEFORE_FINAL_COMMIT");
  if (!input.runId || !SHA256.test(input.planFingerprint) || !SHA256.test(input.settlementDigest)
    || !SHA256.test(input.authoritativeInventoryDigest) || !Number.isSafeInteger(input.settlementJournalCardinality)
    || input.settlementJournalCardinality < 1 || Object.values(input.artifactDigests).some((value) => !SHA256.test(value))) {
    throw new Error("FINAL_COMMIT_INPUT_INVALID");
  }
  const namespace=reliabilityArtifactNamespace(input.runId);
  return {
    evidenceType: namespace.evidenceType, protocolVersion: namespace.protocolVersion, artifactKind: "final_commit", state: "committed",
    runId: input.runId, planFingerprint: input.planFingerprint, passed: input.reportPassed,
    settlement: { acceptedSnapshotDigest: input.settlementDigest, journalCardinality: input.settlementJournalCardinality },
    authoritativeInventoryDigest: input.authoritativeInventoryDigest,
    artifactDigests: Object.fromEntries(Object.entries(input.artifactDigests).sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function hardFinalizationTerminalState(input: {
  admissionStarted: boolean;
  dispatchToken: boolean;
  primitiveEntered: boolean;
}): "not_dispatched" | "unresolved_provider_outcome" {
  if (input.primitiveEntered && (!input.dispatchToken || !input.admissionStarted)) throw new Error("HARD_FINALIZATION_STATE_CONFLICT");
  return input.primitiveEntered ? "unresolved_provider_outcome" : "not_dispatched";
}
