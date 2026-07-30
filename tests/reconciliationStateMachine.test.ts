import { describe, expect, it } from "vitest";
import {
  RECONCILIATION_OFFSETS_SECONDS,
  planReconciliationMutation,
  type AcceptedEvidenceBinding,
  type ReconciliationEvidence,
  type ReconciliationStateInput,
} from "../src/reliability/reconciliationStateMachine.js";

const T0 = 1_800_000_000_000;
const baseBinding: AcceptedEvidenceBinding = {
  requestId: "or-request-1", providerName: "provider-a", upstreamId: "upstream-1",
  router: null, providerResponsesCanonical: "null",
};
const evidence = (overrides: Partial<ReconciliationEvidence> = {}): ReconciliationEvidence => ({
  credentialId: "reconciler-credential", generationId: "gen-1", retrievalStartedAtMs: T0,
  metadata: {
    status: 200, bodySha256: "a".repeat(64), bodyBase64: "e30=", retrievedAtMs: T0 + 100,
    data: {
      id: "gen-1", request_id: "or-request-1", model: "nousresearch/hermes-4-405b",
      provider_name: "provider-a", created_at: new Date(T0 - 1_000).toISOString(), cancelled: false,
      finish_reason: "stop", native_finish_reason: "stop", native_tokens_prompt: 2,
      native_tokens_completion: 3, tokens_prompt: 2, tokens_completion: 3,
      total_cost: "0.000005", usage: "0.000005", upstream_id: "upstream-1",
      router: null, provider_responses: null,
    },
  },
  content: {
    status: 200, bodySha256: "b".repeat(64), bodyBase64: "e30=", retrievedAtMs: T0 + 100,
    body: { data: { input: { messages: [{ role: "user", content: "hello" }] }, output: { completion: "ok", reasoning: null } } },
  },
  ...overrides,
});
const scheduled = (overrides: Partial<ReconciliationStateInput> = {}): ReconciliationStateInput => ({
  runId: "run-1", requestId: "fuse-request-1", laneId: "normal-paced", currentState: "reconciliation_pending",
  generationId: "gen-1", openRouterRequestId: "or-request-1", model: "nousresearch/hermes-4-405b",
  expectedReconcilerCredentialId: "reconciler-credential",
  dispatchTokenAtMs: T0 - 10_000, ambiguityEnteredAtMs: T0, admissionStartedAtMs: T0 - 20_000,
  originalMessages: [{ role: "user", content: "hello" }], sealedRequestCommitmentMatches: true,
  existingResponseCommitment: null, recoveredResponseCommitment: "sha256:response", acceptedBinding: baseBinding,
  operation: { kind: "scheduled", offsetSeconds: 0, scheduledAtMs: T0, startedAtMs: T0,
    getsCompletedAtMs: T0 + 30_000, evidenceValidatedAtMs: T0 + 35_000,
    evidenceCommittedAtMs: T0 + 50_000, transitionCommittedAtMs: T0 + 55_000 },
  evidence: evidence(), heldMemberState: "reconciliation_pending", heldMembersBefore: ["fuse-request-1"],
  nonusableAllowanceOwner: null, controlState: "active", ...overrides,
});

describe("production reconciliation timing", () => {
  it("exports the exact immutable lookup schedule", () => {
    expect(RECONCILIATION_OFFSETS_SECONDS).toEqual([0,60,300,900,1800,3600,7200,14400,28800,43200,64800,86300]);
  });

  it("accepts every inclusive phase/whole-operation limit and half-open start upper boundary", () => {
    const input = scheduled({ operation: { kind: "scheduled", offsetSeconds: 0, scheduledAtMs: T0,
      startedAtMs: T0 + 999, getsCompletedAtMs: T0 + 30_999, evidenceValidatedAtMs: T0 + 35_999,
      evidenceCommittedAtMs: T0 + 50_999, transitionCommittedAtMs: T0 + 55_999 } });
    expect(planReconciliationMutation(input).schedule).toEqual({ valid: true });
  });

  it.each([
    ["start before", { startedAtMs: T0 - 1 }], ["start at +1s", { startedAtMs: T0 + 1_000 }],
    ["GET over 30s", { getsCompletedAtMs: T0 + 30_001 }],
    ["parse over 5s", { evidenceValidatedAtMs: T0 + 35_001 }],
    ["transaction over 15s", { evidenceCommittedAtMs: T0 + 50_001 }],
    ["remaining over 5s", { transitionCommittedAtMs: T0 + 55_001 }],
  ])("fails globally on %s", (_name, patch) => {
    const operation = { ...scheduled().operation, ...patch } as ReconciliationStateInput["operation"];
    const plan = planReconciliationMutation(scheduled({ operation }));
    expect(plan.schedule.valid).toBe(false);
    expect(plan.globalFailure).toEqual({ trigger: true, reason: "RECONCILIATION_SCHEDULE_FAILURE" });
    expect(plan.terminal).toBeNull();
  });

  it("rejects a 55,001ms whole operation even when each phase is individually bounded", () => {
    const plan = planReconciliationMutation(scheduled({ operation: { kind: "scheduled", offsetSeconds: 0,
      scheduledAtMs: T0, startedAtMs: T0, getsCompletedAtMs: T0 + 30_000,
      evidenceValidatedAtMs: T0 + 35_000, evidenceCommittedAtMs: T0 + 50_000,
      transitionCommittedAtMs: T0 + 55_001 } }));
    expect(plan.schedule).toMatchObject({ valid: false, reason: "WHOLE_OPERATION_DEADLINE_MISSED" });
  });

  it("uses <=19s for pre-ambiguity eligibility and the same half-open lookup start", () => {
    const pre = (errorReceivedAtMs: number, startedAtMs: number) => scheduled({
      currentState: "ordinary_inflight", ambiguityEnteredAtMs: null, heldMemberState: "ordinary_inflight",
      operation: { kind: "pre_ambiguity", errorReceivedAtMs, errorHttpStatus: 502, errorEnvelopeGenerationId: "gen-1",
        scheduledAtMs: errorReceivedAtMs, startedAtMs,
        getsCompletedAtMs: startedAtMs + 1, evidenceValidatedAtMs: startedAtMs + 2,
        evidenceCommittedAtMs: startedAtMs + 3, transitionCommittedAtMs: startedAtMs + 4 },
      evidence: evidence({ retrievalStartedAtMs: startedAtMs, metadata: { ...evidence().metadata,
        data: { ...evidence().metadata.data!, cancelled: true, finish_reason: null, native_finish_reason: null,
          native_tokens_prompt: null, native_tokens_completion: null, tokens_prompt: null, tokens_completion: null,
          total_cost: "0", usage: "0" } } }),
    });
    expect(planReconciliationMutation(pre(T0 - 1_000, T0 - 1_000)).terminal?.state).toBe(3);
    const late = planReconciliationMutation(pre(T0 - 999, T0 - 999));
    expect(late.terminal).toBeNull(); expect(late.attemptState).toBe("enter_ambiguity");
    expect(late.persistAttempt).toBe(false);
    const startLate = planReconciliationMutation(pre(T0 - 1_000, T0));
    expect(startLate.schedule.valid).toBe(false);
  });

  it("enforces cutoff retrieval strictness and cutoff classification half-open/30s/+86431 boundaries", () => {
    const cutoff = T0 + 86_400_000;
    const accepted = planReconciliationMutation(scheduled({ evidence: evidence({ retrievalStartedAtMs: cutoff - 1 }) }));
    expect(accepted.evidence.accepted).toBe(true);
    expect(planReconciliationMutation(scheduled({ evidence: evidence({ retrievalStartedAtMs: cutoff }) })).evidence)
      .toMatchObject({ accepted: false, conflict: true, reason: "EVIDENCE_RETRIEVAL_AT_OR_AFTER_CUTOFF" });
    const cutoffInput = (startedAtMs: number, committedAtMs: number) => scheduled({ evidence: null,
      operation: { kind: "cutoff", scheduledAtMs: cutoff, startedAtMs, transitionCommittedAtMs: committedAtMs } });
    expect(planReconciliationMutation(cutoffInput(cutoff, cutoff + 30_000)).terminal?.state).toBe(7);
    expect(planReconciliationMutation(cutoffInput(cutoff + 999, cutoff + 30_999)).terminal?.state).toBe(7);
    expect(planReconciliationMutation(cutoffInput(cutoff + 1_000, cutoff + 30_999)).schedule.valid).toBe(false);
    expect(planReconciliationMutation(cutoffInput(cutoff, cutoff + 30_001)).schedule.valid).toBe(false);
    expect(planReconciliationMutation(cutoffInput(cutoff, cutoff + 31_000)).schedule.valid).toBe(false);
  });
});

describe("accepted evidence invariants, conflicts, and exact terminal mapping", () => {
  it("maps canceled zero-cost evidence to state 4 after ambiguity and state 3 only before ambiguity", () => {
    const canceled = evidence({ metadata: { ...evidence().metadata, data: { ...evidence().metadata.data!, cancelled: true,
      finish_reason: null, native_finish_reason: null, native_tokens_prompt: null, native_tokens_completion: null,
      tokens_prompt: null, tokens_completion: null, total_cost: "0", usage: "0" } } });
    expect(planReconciliationMutation(scheduled({ evidence: canceled })).terminal?.state).toBe(4);
    const pre = scheduled({ currentState: "ordinary_inflight", ambiguityEnteredAtMs: null, heldMemberState: "ordinary_inflight",
      operation: { kind: "pre_ambiguity", errorReceivedAtMs: T0 - 1_000, errorHttpStatus: 502,
        errorEnvelopeGenerationId: "gen-1", scheduledAtMs: T0 - 1_000,
        startedAtMs: T0 - 1_000, getsCompletedAtMs: T0 - 999, evidenceValidatedAtMs: T0 - 998,
        evidenceCommittedAtMs: T0 - 997, transitionCommittedAtMs: T0 - 996 },
      evidence: { ...canceled, retrievalStartedAtMs: T0 - 1_000 } });
    expect(planReconciliationMutation(pre).terminal?.state).toBe(3);
    expect(() => planReconciliationMutation({ ...pre, operation: { ...pre.operation, errorHttpStatus: 200 } }))
      .toThrow("PRE_AMBIGUITY_ERROR_ENVELOPE_INVALID");
    expect(() => planReconciliationMutation({ ...pre, operation: { ...pre.operation, errorEnvelopeGenerationId: "other" } }))
      .toThrow("PRE_AMBIGUITY_ERROR_ENVELOPE_INVALID");
  });

  it("maps valid positive-cost response to 5 and only final offset null/exact-404 to 6", () => {
    expect(planReconciliationMutation(scheduled()).terminal?.state).toBe(5);
    const nullContent = evidence({ content: { ...evidence().content,
      body: { data: { input: { messages: [{ role: "user", content: "hello" }] }, output: { completion: null, reasoning: null } } } } });
    expect(planReconciliationMutation(scheduled({ evidence: nullContent })).terminal).toBeNull();
    expect(planReconciliationMutation(scheduled({ operation: { ...scheduled().operation, offsetSeconds: 86300,
      scheduledAtMs: T0 + 86_300_000, startedAtMs: T0 + 86_300_000, getsCompletedAtMs: T0 + 86_300_001,
      evidenceValidatedAtMs: T0 + 86_300_002, evidenceCommittedAtMs: T0 + 86_300_003,
      transitionCommittedAtMs: T0 + 86_300_004 }, evidence: { ...nullContent, retrievalStartedAtMs: T0 + 86_300_000 } })).terminal?.state).toBe(6);
    const exact404 = evidence({ content: { status: 404, bodySha256: "c".repeat(64), bodyBase64: "e30=",
      retrievedAtMs: T0 + 100, body: { error: { message: "not found" } } } });
    expect(planReconciliationMutation(scheduled({ operation: { ...scheduled().operation, offsetSeconds: 86300,
      scheduledAtMs: T0 + 86_300_000, startedAtMs: T0 + 86_300_000, getsCompletedAtMs: T0 + 86_300_001,
      evidenceValidatedAtMs: T0 + 86_300_002, evidenceCommittedAtMs: T0 + 86_300_003,
      transitionCommittedAtMs: T0 + 86_300_004 }, evidence: { ...exact404, retrievalStartedAtMs: T0 + 86_300_000 } })).terminal?.state).toBe(6);
  });

  it.each([
    ["generation", (e: ReconciliationEvidence) => ({ ...e, generationId: "other" })],
    ["request", (e: ReconciliationEvidence) => ({ ...e, metadata: { ...e.metadata, data: { ...e.metadata.data!, request_id: "other" } } })],
    ["model", (e: ReconciliationEvidence) => ({ ...e, metadata: { ...e.metadata, data: { ...e.metadata.data!, model: "other" } } })],
    ["provider", (e: ReconciliationEvidence) => ({ ...e, metadata: { ...e.metadata, data: { ...e.metadata.data!, provider_name: "other" } } })],
    ["cost", (e: ReconciliationEvidence) => ({ ...e, metadata: { ...e.metadata, data: { ...e.metadata.data!, usage: "0.000006" } } })],
    ["tokens", (e: ReconciliationEvidence) => ({ ...e, metadata: { ...e.metadata, data: { ...e.metadata.data!, tokens_prompt: 9 } } })],
    ["created_at", (e: ReconciliationEvidence) => ({ ...e, metadata: { ...e.metadata, data: { ...e.metadata.data!, created_at: new Date(T0 - 310_001).toISOString() } } })],
    ["input", (e: ReconciliationEvidence) => ({ ...e, content: { ...e.content, body: { data: { input: { messages: [] }, output: { completion: "ok", reasoning: null } } } } })],
    ["commitment", (e: ReconciliationEvidence) => e],
  ])("marks %s mismatch as conflicting pending evidence", (name, mutate) => {
    const plan = planReconciliationMutation(scheduled({ evidence: mutate(evidence()),
      ...(name === "commitment" ? { sealedRequestCommitmentMatches: false } : {}) }));
    expect(plan.evidence).toMatchObject({ accepted: false, conflict: true });
    expect(plan.terminal).toBeNull(); expect(plan.holdMember).toBe("keep");
  });

  it("rejects missing nullable metadata fields, malformed content, response-commitment conflict, and credential drift", () => {
    const missing = { ...evidence().metadata.data! }; delete (missing as any).router;
    expect(planReconciliationMutation(scheduled({ evidence: evidence({ metadata: { ...evidence().metadata, data: missing as any } }) })).evidence.conflict).toBe(true);
    expect(planReconciliationMutation(scheduled({ evidence: evidence({ content: { ...evidence().content, body: { data: {} } } }) })).evidence.conflict).toBe(true);
    expect(planReconciliationMutation(scheduled({ existingResponseCommitment: "sha256:different" })).evidence)
      .toMatchObject({ conflict: true, reason: "RESPONSE_COMMITMENT_CONFLICT" });
    expect(planReconciliationMutation(scheduled({ evidence: evidence({ credentialId: "other-credential" }) })).evidence)
      .toMatchObject({ conflict: true, reason: "RECONCILER_CREDENTIAL_CONFLICT" });
    const auth = planReconciliationMutation(scheduled({ evidence: evidence({ metadata: { ...evidence().metadata, status: 401 } }) }));
    expect(auth.globalFailure).toEqual({ trigger: true, reason: "RECONCILIATION_CREDENTIAL_DRIFT" });
    expect(auth.terminal).toBeNull();
  });
});

describe("deterministic atomic transition intents", () => {
  it.each([
    [3, "failed", "0", 0, true], [4, "failed", "0", 0, true],
    [5, "completed", "5", 1, false], [6, "failed", "5", 0, true],
  ] as const)("maps terminal state %i into exact execution/counter/allowance intents", (state, execution, cost, usable, allowance) => {
    const canceled = evidence({ metadata: { ...evidence().metadata, data: { ...evidence().metadata.data!, cancelled: true,
      finish_reason: null, native_finish_reason: null, native_tokens_prompt: null, native_tokens_completion: null,
      tokens_prompt: null, tokens_completion: null, total_cost: "0", usage: "0" } } });
    const nullContent = evidence({ content: { ...evidence().content, body: { data: { input: { messages: [{ role: "user", content: "hello" }] }, output: { completion: null, reasoning: null } } } } });
    let input = state === 4 ? scheduled({ evidence: canceled }) : state === 5 ? scheduled() : scheduled({ evidence: nullContent,
      operation: { ...scheduled().operation, offsetSeconds: 86300, scheduledAtMs: T0 + 86_300_000,
        startedAtMs: T0 + 86_300_000, getsCompletedAtMs: T0 + 86_300_001, evidenceValidatedAtMs: T0 + 86_300_002,
        evidenceCommittedAtMs: T0 + 86_300_003, transitionCommittedAtMs: T0 + 86_300_004 } });
    if (state === 3) input = { ...scheduled({ evidence: canceled }), currentState: "ordinary_inflight", ambiguityEnteredAtMs: null,
      heldMemberState: "ordinary_inflight", operation: { kind: "pre_ambiguity", errorReceivedAtMs: T0 - 1_000,
        errorHttpStatus: 502, errorEnvelopeGenerationId: "gen-1",
        scheduledAtMs: T0 - 1_000, startedAtMs: T0 - 1_000, getsCompletedAtMs: T0 - 999,
        evidenceValidatedAtMs: T0 - 998, evidenceCommittedAtMs: T0 - 997, transitionCommittedAtMs: T0 - 996 },
      evidence: { ...canceled, retrievalStartedAtMs: T0 - 1_000 } };
    const plan = planReconciliationMutation(input);
    expect(plan.terminal?.state).toBe(state);
    expect(plan.execution).toMatchObject({ status: execution, actualCostMicros: cost });
    expect(plan.counters).toEqual({ gateClassifications: 1, usable: usable });
    expect(plan.allowance.action === "claim").toBe(allowance);
    expect(plan.holdMember).toBe("remove");
  });

  it("maps cutoff to state 7, retains reservation exposure, removes hold, and globally fails atomically", () => {
    const cutoff = T0 + 86_400_000;
    const plan = planReconciliationMutation(scheduled({ evidence: null, operation: { kind: "cutoff",
      scheduledAtMs: cutoff, startedAtMs: cutoff, transitionCommittedAtMs: cutoff + 1 } }));
    expect(plan.terminal?.state).toBe(7);
    expect(plan.execution).toMatchObject({ status: "reconciliation_hold", actualCostMicros: null, retainReservationExposure: true });
    expect(plan.counters).toEqual({ gateClassifications: 1, usable: 0 });
    expect(plan.globalFailure).toEqual({ trigger: true, reason: "UNRESOLVED_PROVIDER_OUTCOME" });
    expect(plan.holdMember).toBe("remove");
  });

  it("claims the sole allowance, or terminalizes and fails globally when another owner exists", () => {
    const canceled = evidence({ metadata: { ...evidence().metadata, data: { ...evidence().metadata.data!, cancelled: true,
      finish_reason: null, native_finish_reason: null, native_tokens_prompt: null, native_tokens_completion: null,
      tokens_prompt: null, tokens_completion: null, total_cost: "0", usage: "0" } } });
    const first = planReconciliationMutation(scheduled({ evidence: canceled }));
    expect(first.allowance).toEqual({ action: "claim", ownerRequestId: "fuse-request-1" });
    const second = planReconciliationMutation(scheduled({ evidence: canceled, nonusableAllowanceOwner: "earlier" }));
    expect(second.terminal?.state).toBe(4);
    expect(second.allowance).toEqual({ action: "already_claimed", ownerRequestId: "earlier" });
    expect(second.globalFailure).toEqual({ trigger: true, reason: "NONUSABLE_ALLOWANCE_EXCEEDED" });
  });

  it("cancels every future offset after terminal classification and computes final-member resume only without failure", () => {
    const plan = planReconciliationMutation(scheduled({ operation: { ...scheduled().operation, offsetSeconds: 300,
      scheduledAtMs: T0 + 300_000, startedAtMs: T0 + 300_000, getsCompletedAtMs: T0 + 300_001,
      evidenceValidatedAtMs: T0 + 300_002, evidenceCommittedAtMs: T0 + 300_003,
      transitionCommittedAtMs: T0 + 300_004 }, evidence: evidence({ retrievalStartedAtMs: T0 + 300_000 }) }));
    expect(plan.cancelOffsets).toEqual(RECONCILIATION_OFFSETS_SECONDS.filter((offset) => offset > 300)
      .map((offsetSeconds) => ({ offsetSeconds, status: "canceled_terminal" })));
    expect(plan.lane).toEqual({ action: "schedule_resume", resumeAtEpochSecond: 1_800_000_600 });
    const held = planReconciliationMutation(scheduled({ heldMembersBefore: ["fuse-request-1", "sibling"] }));
    expect(held.lane).toEqual({ action: "remain_held" });
  });

  it("is pure and returns byte-identical plans for identical frozen snapshots", () => {
    const input = scheduled();
    expect(JSON.stringify(planReconciliationMutation(input))).toBe(JSON.stringify(planReconciliationMutation(structuredClone(input))));
  });

  it("fails closed on invalid snapshots instead of inventing a mutation", () => {
    expect(() => planReconciliationMutation(scheduled({ requestId: "" }))).toThrow("RECONCILIATION_INPUT_INVALID");
    expect(() => planReconciliationMutation(scheduled({ heldMembersBefore: [] }))).toThrow("RECONCILIATION_HOLD_INVARIANT");
    expect(() => planReconciliationMutation(scheduled({ currentState: "ordinary_inflight", heldMemberState: "ordinary_inflight" }))).toThrow("RECONCILIATION_STATE_INVARIANT");
  });
});
