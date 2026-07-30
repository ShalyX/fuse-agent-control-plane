/** Pure protocol-v2 reconciliation kernel. It performs no I/O and returns one plan
 * that a store must apply under the protocol-control -> lane lock order. */

export const RECONCILIATION_OFFSETS_SECONDS = [
  0, 60, 300, 900, 1_800, 3_600, 7_200, 14_400, 28_800, 43_200, 64_800, 86_300,
] as const;

export type TerminalReconciliationState = 3 | 4 | 5 | 6 | 7;
export type ProtocolAttemptState = "ordinary_inflight" | "reconciliation_pending";
export type HeldMemberState = ProtocolAttemptState;

type JsonObject = Record<string, unknown>;
export interface ProviderCapture {
  status: number;
  bodySha256: string;
  bodyBase64: string;
  retrievedAtMs: number;
}
export interface ReconciliationMetadata extends ProviderCapture {
  data?: {
    id?: unknown; request_id?: unknown; model?: unknown; provider_name?: unknown; created_at?: unknown;
    cancelled?: unknown; finish_reason?: unknown; native_finish_reason?: unknown;
    native_tokens_prompt?: unknown; native_tokens_completion?: unknown;
    tokens_prompt?: unknown; tokens_completion?: unknown; total_cost?: unknown; usage?: unknown;
    upstream_id?: unknown; router?: unknown; provider_responses?: unknown;
  };
}
export interface ReconciliationContent extends ProviderCapture { body: unknown }
export interface ReconciliationEvidence {
  credentialId: string;
  generationId: string;
  retrievalStartedAtMs: number;
  metadata: ReconciliationMetadata;
  content: ReconciliationContent;
}
export interface AcceptedEvidenceBinding {
  requestId: string;
  providerName: string;
  upstreamId: string;
  router: string | null;
  providerResponsesCanonical: string;
}

type ScheduledOperation = {
  kind: "scheduled";
  offsetSeconds: number;
  scheduledAtMs: number;
  startedAtMs: number;
  getsCompletedAtMs: number;
  evidenceValidatedAtMs: number;
  evidenceCommittedAtMs: number;
  transitionCommittedAtMs: number;
};
type PreAmbiguityOperation = Omit<ScheduledOperation, "kind" | "offsetSeconds"> & {
  kind: "pre_ambiguity";
  errorReceivedAtMs: number;
  errorHttpStatus: number;
  errorEnvelopeGenerationId: string;
};
type CutoffOperation = {
  kind: "cutoff";
  scheduledAtMs: number;
  startedAtMs: number;
  transitionCommittedAtMs: number;
};
export type ReconciliationOperation = ScheduledOperation | PreAmbiguityOperation | CutoffOperation;

export interface ReconciliationStateInput {
  runId: string;
  requestId: string;
  laneId: string;
  currentState: ProtocolAttemptState;
  generationId: string;
  expectedReconcilerCredentialId: string;
  openRouterRequestId: string | null;
  model: string;
  dispatchTokenAtMs: number;
  ambiguityEnteredAtMs: number | null;
  admissionStartedAtMs: number;
  originalMessages: readonly unknown[];
  sealedRequestCommitmentMatches: boolean;
  existingResponseCommitment: string | null;
  recoveredResponseCommitment: string | null;
  acceptedBinding: AcceptedEvidenceBinding | null;
  operation: ReconciliationOperation;
  evidence: ReconciliationEvidence | null;
  heldMemberState: HeldMemberState;
  heldMembersBefore: readonly string[];
  nonusableAllowanceOwner: string | null;
  controlState: "active" | "failed";
}

export interface ReconciliationMutationPlan {
  version: 1;
  runId: string;
  requestId: string;
  laneId: string;
  lockOrder: readonly ["protocol_control", "protocol_lane"];
  schedule: { valid: true } | { valid: false; reason: string };
  evidence: { accepted: boolean; conflict: boolean; reason: string | null; binding: AcceptedEvidenceBinding | null };
  persistAttempt: boolean;
  terminal: { state: TerminalReconciliationState; name: string } | null;
  attemptState: "unchanged_pending" | "enter_ambiguity" | "terminal";
  execution: null | {
    status: "failed" | "completed" | "reconciliation_hold";
    actualCostMicros: string | null;
    responseCommitment: string | null;
    enqueueShadow: boolean;
    retainReservationExposure: boolean;
  };
  counters: { gateClassifications: 0 | 1; usable: 0 | 1 };
  allowance: { action: "none" } | { action: "claim" | "already_claimed"; ownerRequestId: string };
  holdMember: "keep" | "remove" | "change_to_reconciliation_pending";
  cancelOffsets: readonly { offsetSeconds: number; status: "canceled_terminal" }[];
  lane: { action: "remain_held" | "none" } | { action: "schedule_resume"; resumeAtEpochSecond: number };
  globalFailure: { trigger: false } | { trigger: true; reason: string };
  events: readonly { type: string; data: Readonly<Record<string, unknown>> }[];
}

const REQUIRED_METADATA = ["id", "request_id", "model", "provider_name", "created_at", "cancelled",
  "finish_reason", "native_finish_reason", "native_tokens_prompt", "native_tokens_completion", "tokens_prompt",
  "tokens_completion", "total_cost", "usage", "upstream_id", "router", "provider_responses"] as const;
const PINNED_MODEL = "nousresearch/hermes-4-405b";

function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function integerTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function has(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as JsonObject;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}
function decimalMicros(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) return null;
  try {
    const result = BigInt(whole!) * 1_000_000n + BigInt((fraction.slice(0, 6) + "000000").slice(0, 6));
    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? result : null;
  } catch { return null; }
}
function nullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function nullableCount(value: unknown): boolean { return value === null || (Number.isSafeInteger(value) && Number(value) >= 0); }

function invalidSchedule(reason: string): { valid: false; reason: string } { return { valid: false, reason }; }
function schedule(input: ReconciliationStateInput): ReconciliationMutationPlan["schedule"] {
  const op = input.operation;
  if (![op.scheduledAtMs, op.startedAtMs, op.transitionCommittedAtMs].every(integerTime)) return invalidSchedule("DATABASE_TIME_INVALID");
  if (op.startedAtMs < op.scheduledAtMs || op.startedAtMs >= op.scheduledAtMs + 1_000) return invalidSchedule("OPERATION_START_WINDOW_MISSED");
  if (op.kind === "cutoff") {
    const cutoff = input.ambiguityEnteredAtMs! + 86_400_000;
    if (op.scheduledAtMs !== cutoff) return invalidSchedule("CUTOFF_SCHEDULE_MISMATCH");
    if (op.transitionCommittedAtMs < op.startedAtMs || op.transitionCommittedAtMs - op.startedAtMs > 30_000
      || op.transitionCommittedAtMs >= input.ambiguityEnteredAtMs! + 86_431_000) {
      return invalidSchedule("CUTOFF_CLASSIFICATION_DEADLINE_MISSED");
    }
    return { valid: true };
  }
  if (![op.getsCompletedAtMs, op.evidenceValidatedAtMs, op.evidenceCommittedAtMs].every(integerTime)) return invalidSchedule("DATABASE_TIME_INVALID");
  if (op.transitionCommittedAtMs - op.startedAtMs > 55_000) return invalidSchedule("WHOLE_OPERATION_DEADLINE_MISSED");
  if (op.getsCompletedAtMs < op.startedAtMs || op.getsCompletedAtMs - op.startedAtMs > 30_000) return invalidSchedule("HTTP_PHASE_DEADLINE_MISSED");
  if (op.evidenceValidatedAtMs < op.getsCompletedAtMs || op.evidenceValidatedAtMs - op.getsCompletedAtMs > 5_000) return invalidSchedule("VALIDATION_PHASE_DEADLINE_MISSED");
  if (op.evidenceCommittedAtMs < op.evidenceValidatedAtMs || op.evidenceCommittedAtMs - op.evidenceValidatedAtMs > 15_000) return invalidSchedule("PERSISTENCE_PHASE_DEADLINE_MISSED");
  if (op.transitionCommittedAtMs < op.evidenceCommittedAtMs || op.transitionCommittedAtMs - op.evidenceCommittedAtMs > 5_000) return invalidSchedule("TRANSITION_PHASE_DEADLINE_MISSED");
  if (op.kind === "scheduled") {
    if (!RECONCILIATION_OFFSETS_SECONDS.includes(op.offsetSeconds as any)) return invalidSchedule("LOOKUP_OFFSET_NOT_SEALED");
    if (op.scheduledAtMs !== input.ambiguityEnteredAtMs! + op.offsetSeconds * 1_000) return invalidSchedule("LOOKUP_SCHEDULE_MISMATCH");
  } else {
    if (op.scheduledAtMs !== op.errorReceivedAtMs) return invalidSchedule("PRE_AMBIGUITY_SCHEDULE_MISMATCH");
  }
  return { valid: true };
}

type EvidenceResult = ReconciliationMutationPlan["evidence"] & { kind: "canceled" | "positive_response" | "positive_no_response" | "pending" | "credential_drift"; cost: bigint | null };
function evidenceResult(input: ReconciliationStateInput): EvidenceResult {
  const pending = (reason: string, conflict = true): EvidenceResult => ({ accepted: false, conflict, reason, binding: null, kind: "pending", cost: null });
  const e = input.evidence;
  if (!e) return { accepted: false, conflict: false, reason: "NO_EVIDENCE", binding: null, kind: "pending", cost: null };
  if (e.metadata.status === 401 || e.metadata.status === 403 || e.content.status === 401 || e.content.status === 403) {
    return { accepted: false, conflict: false, reason: "RECONCILIATION_CREDENTIAL_DRIFT", binding: null, kind: "credential_drift", cost: null };
  }
  if (!integerTime(e.retrievalStartedAtMs) || !integerTime(e.metadata.retrievedAtMs) || !integerTime(e.content.retrievedAtMs)
    || !e.credentialId || !/^[a-f0-9]{64}$/.test(e.metadata.bodySha256) || !/^[a-f0-9]{64}$/.test(e.content.bodySha256)
    || typeof e.metadata.bodyBase64 !== "string" || typeof e.content.bodyBase64 !== "string") return pending("EVIDENCE_CAPTURE_INVALID");
  if (e.credentialId !== input.expectedReconcilerCredentialId) return pending("RECONCILER_CREDENTIAL_CONFLICT");
  if (e.generationId !== input.generationId) return pending("GENERATION_ID_CONFLICT");
  if (input.ambiguityEnteredAtMs !== null && e.retrievalStartedAtMs >= input.ambiguityEnteredAtMs + 86_400_000) return pending("EVIDENCE_RETRIEVAL_AT_OR_AFTER_CUTOFF");
  const m = e.metadata.data;
  if (e.metadata.status !== 200 || !m || !REQUIRED_METADATA.every((key) => has(m, key))) return pending("METADATA_SCHEMA_CONFLICT");
  if (m.id !== input.generationId) return pending("METADATA_GENERATION_CONFLICT");
  if (typeof m.request_id !== "string" || !m.request_id || (input.openRouterRequestId !== null && m.request_id !== input.openRouterRequestId)) return pending("PROVIDER_REQUEST_ID_CONFLICT");
  if (m.model !== PINNED_MODEL || input.model !== PINNED_MODEL) return pending("MODEL_CONFLICT");
  if (typeof m.provider_name !== "string" || !m.provider_name || typeof m.upstream_id !== "string" || !m.upstream_id
    || !(m.router === null || (typeof m.router === "string" && m.router.length > 0))
    || !(m.provider_responses === null || Array.isArray(m.provider_responses))) return pending("PROVIDER_BINDING_CONFLICT");
  const binding: AcceptedEvidenceBinding = { requestId: m.request_id, providerName: m.provider_name,
    upstreamId: m.upstream_id, router: m.router as string | null, providerResponsesCanonical: canonical(m.provider_responses) };
  if (input.acceptedBinding && canonical(input.acceptedBinding) !== canonical(binding)) return pending("IMMUTABLE_EVIDENCE_CONFLICT");
  if (typeof m.cancelled !== "boolean" || !nullableString(m.finish_reason) || !nullableString(m.native_finish_reason)
    || !nullableCount(m.native_tokens_prompt) || !nullableCount(m.native_tokens_completion)
    || !nullableCount(m.tokens_prompt) || !nullableCount(m.tokens_completion)) return pending("METADATA_TYPE_CONFLICT");
  if (m.native_tokens_prompt !== null && m.tokens_prompt !== null && m.native_tokens_prompt !== m.tokens_prompt) return pending("TOKEN_COUNT_CONFLICT");
  if (m.native_tokens_completion !== null && m.tokens_completion !== null && m.native_tokens_completion !== m.tokens_completion) return pending("TOKEN_COUNT_CONFLICT");
  const total = decimalMicros(m.total_cost); const usage = decimalMicros(m.usage);
  if (total === null || usage === null || total !== usage) return pending("COST_CONFLICT");
  const createdAt = typeof m.created_at === "string" ? Date.parse(m.created_at) : NaN;
  const upper = input.ambiguityEnteredAtMs === null ? input.operation.transitionCommittedAtMs : input.ambiguityEnteredAtMs + 300_000;
  if (!Number.isFinite(createdAt) || createdAt < input.dispatchTokenAtMs - 300_000 || createdAt > upper) return pending("CREATED_AT_CONFLICT");
  if (m.cancelled) {
    if (total !== 0n || usage !== 0n) return pending("CANCELLATION_COST_CONFLICT");
    return { accepted: true, conflict: false, reason: null, binding, kind: "canceled", cost: 0n };
  }
  const positiveMetadata = total > 0n && m.finish_reason === "stop"
    && Number.isSafeInteger(m.native_tokens_prompt) && Number(m.native_tokens_prompt) >= 0
    && Number.isSafeInteger(m.native_tokens_completion) && Number(m.native_tokens_completion) >= 0
    && Number.isSafeInteger(m.tokens_prompt) && Number(m.tokens_prompt) >= 0
    && Number.isSafeInteger(m.tokens_completion) && Number(m.tokens_completion) >= 0;
  if (!positiveMetadata) return pending("POSITIVE_METADATA_CONFLICT");
  if (!input.sealedRequestCommitmentMatches) return pending("REQUEST_COMMITMENT_CONFLICT");
  const root = isObject(e.content.body) ? e.content.body : {};
  const exact404 = e.content.status === 404 && !has(root, "data") && isObject(root.error)
    && typeof root.error.message === "string" && root.error.message.length > 0;
  if (exact404) return { accepted: true, conflict: false, reason: null, binding, kind: "positive_no_response", cost: total };
  if (e.content.status !== 200 || !isObject(root.data) || !isObject(root.data.input) || !isObject(root.data.output)
    || !has(root.data.input, "messages") || !has(root.data.output, "completion") || !has(root.data.output, "reasoning")
    || !Array.isArray(root.data.input.messages) || canonical(root.data.input.messages) !== canonical(input.originalMessages)
    || root.data.output.reasoning !== null || !(typeof root.data.output.completion === "string" || root.data.output.completion === null)) {
    return pending("CONTENT_CONFLICT");
  }
  if (typeof root.data.output.completion === "string") {
    if (!input.recoveredResponseCommitment) return pending("RECOVERED_RESPONSE_COMMITMENT_MISSING");
    if (input.existingResponseCommitment !== null && input.existingResponseCommitment !== input.recoveredResponseCommitment) return pending("RESPONSE_COMMITMENT_CONFLICT");
    return { accepted: true, conflict: false, reason: null, binding, kind: "positive_response", cost: total };
  }
  return { accepted: true, conflict: false, reason: null, binding, kind: "positive_no_response", cost: total };
}

const terminalName: Record<TerminalReconciliationState, string> = {
  3: "terminal_rejected_not_billed", 4: "reconciled_not_billed", 5: "reconciled_billed_with_response",
  6: "reconciled_billed_no_response", 7: "unresolved_provider_outcome",
};
function nextBoundary(epochMs: number): number {
  const second = Math.floor(epochMs / 1_000);
  return 300 * (Math.floor(second / 300) + 1);
}

export function planReconciliationMutation(input: ReconciliationStateInput): ReconciliationMutationPlan {
  invariant(Boolean(input.runId && input.requestId && input.laneId && input.generationId
    && input.expectedReconcilerCredentialId), "RECONCILIATION_INPUT_INVALID");
  invariant([input.dispatchTokenAtMs, input.admissionStartedAtMs].every(integerTime), "RECONCILIATION_INPUT_INVALID");
  invariant(input.heldMembersBefore.includes(input.requestId), "RECONCILIATION_HOLD_INVARIANT");
  invariant(input.heldMemberState === input.currentState, "RECONCILIATION_HOLD_INVARIANT");
  if (input.operation.kind === "pre_ambiguity") {
    invariant(input.currentState === "ordinary_inflight" && input.ambiguityEnteredAtMs === null, "RECONCILIATION_STATE_INVARIANT");
    invariant(Number.isInteger(input.operation.errorHttpStatus)
      && (input.operation.errorHttpStatus < 200 || input.operation.errorHttpStatus >= 300)
      && input.operation.errorEnvelopeGenerationId === input.generationId,
    "PRE_AMBIGUITY_ERROR_ENVELOPE_INVALID");
  } else {
    invariant(input.currentState === "reconciliation_pending" && integerTime(input.ambiguityEnteredAtMs), "RECONCILIATION_STATE_INVARIANT");
  }

  const timing = schedule(input);
  const ev = evidenceResult(input);
  const base = {
    version: 1 as const, runId: input.runId, requestId: input.requestId, laneId: input.laneId,
    lockOrder: ["protocol_control", "protocol_lane"] as const, schedule: timing,
    evidence: { accepted: ev.accepted, conflict: ev.conflict, reason: ev.reason, binding: ev.binding },
    persistAttempt: true as const,
  };
  const pending = (globalFailure: ReconciliationMutationPlan["globalFailure"], attemptState: ReconciliationMutationPlan["attemptState"] = "unchanged_pending",
    holdMember: ReconciliationMutationPlan["holdMember"] = "keep", persistAttempt = true): ReconciliationMutationPlan => ({ ...base,
    persistAttempt,
    terminal: null, attemptState, execution: null, counters: { gateClassifications: 0, usable: 0 },
    allowance: { action: "none" }, holdMember, cancelOffsets: [], lane: { action: "remain_held" }, globalFailure,
    events: [{ type: timing.valid ? "reconciliation_attempt_persisted" : "reconciliation_schedule_failed",
      data: timing.valid ? { evidenceReason: ev.reason } : { reason: timing.reason } }],
  });
  if (!timing.valid) return pending({ trigger: true, reason: "RECONCILIATION_SCHEDULE_FAILURE" });
  if (ev.kind === "credential_drift") return pending({ trigger: true, reason: "RECONCILIATION_CREDENTIAL_DRIFT" });

  let state: TerminalReconciliationState | null = null;
  if (input.operation.kind === "pre_ambiguity") {
    const eligible = input.operation.errorReceivedAtMs <= input.admissionStartedAtMs + 19_000;
    if (!eligible) return { ...pending({ trigger: false }, "enter_ambiguity", "change_to_reconciliation_pending", false),
      evidence: { accepted: false, conflict: false, reason: "PRE_AMBIGUITY_LOOKUP_SKIPPED", binding: null },
      events: [{ type: "ambiguity_entered", data: { reason: "SYNCHRONOUS_ERROR_AFTER_19_SECONDS" } }],
    };
    if (ev.kind === "canceled") state = 3;
    else return pending({ trigger: false }, "enter_ambiguity", "change_to_reconciliation_pending");
  } else if (input.operation.kind === "cutoff") {
    state = 7;
  } else if (ev.kind === "canceled") state = 4;
  else if (ev.kind === "positive_response") state = 5;
  else if (ev.kind === "positive_no_response" && input.operation.offsetSeconds === 86_300) state = 6;
  else return pending({ trigger: false });

  const cost = state === 3 || state === 4 ? 0n : state === 5 || state === 6 ? ev.cost : null;
  invariant((state === 7 && cost === null) || cost !== null, "RECONCILIATION_COST_INVARIANT");
  const allowanceState = state === 3 || state === 4 || state === 6;
  const allowance: ReconciliationMutationPlan["allowance"] = !allowanceState ? { action: "none" }
    : input.nonusableAllowanceOwner === null ? { action: "claim", ownerRequestId: input.requestId }
    : { action: "already_claimed", ownerRequestId: input.nonusableAllowanceOwner };
  const failedForAllowance = allowanceState && input.nonusableAllowanceOwner !== null && input.nonusableAllowanceOwner !== input.requestId;
  const globalFailure: ReconciliationMutationPlan["globalFailure"] = state === 7
    ? { trigger: true, reason: "UNRESOLVED_PROVIDER_OUTCOME" }
    : failedForAllowance ? { trigger: true, reason: "NONUSABLE_ALLOWANCE_EXCEEDED" }
    : { trigger: false };
  const currentOffset = input.operation.kind === "scheduled" ? input.operation.offsetSeconds : -1;
  const cancelOffsets = RECONCILIATION_OFFSETS_SECONDS.filter((offset) => offset > currentOffset)
    .map((offsetSeconds) => ({ offsetSeconds, status: "canceled_terminal" as const }));
  const remaining = input.heldMembersBefore.filter((id) => id !== input.requestId);
  const lane: ReconciliationMutationPlan["lane"] = globalFailure.trigger ? { action: remaining.length ? "remain_held" : "none" }
    : remaining.length ? { action: "remain_held" }
    : { action: "schedule_resume", resumeAtEpochSecond: nextBoundary(input.operation.transitionCommittedAtMs) };
  const execution: NonNullable<ReconciliationMutationPlan["execution"]> = state === 5
    ? { status: "completed", actualCostMicros: cost!.toString(), responseCommitment: input.recoveredResponseCommitment, enqueueShadow: true, retainReservationExposure: false }
    : state === 7
      ? { status: "reconciliation_hold", actualCostMicros: null, responseCommitment: null, enqueueShadow: false, retainReservationExposure: true }
      : { status: "failed", actualCostMicros: cost!.toString(), responseCommitment: null, enqueueShadow: false, retainReservationExposure: false };
  return { ...base, terminal: { state, name: terminalName[state] }, attemptState: "terminal", execution,
    counters: { gateClassifications: 1, usable: state === 5 ? 1 : 0 }, allowance, holdMember: "remove",
    cancelOffsets, lane, globalFailure,
    events: [
      ...(ev.accepted ? [{ type: "provider_evidence_attached", data: { state, binding: ev.binding } }] : []),
      { type: "gate_classified", data: { state, name: terminalName[state] } },
      ...cancelOffsets.map(({ offsetSeconds }) => ({ type: "reconciliation_offset_canceled", data: { offsetSeconds, status: "canceled_terminal" } })),
      ...(globalFailure.trigger ? [{ type: "global_failure_requested", data: { reason: globalFailure.reason } }] : []),
    ],
  };
}
