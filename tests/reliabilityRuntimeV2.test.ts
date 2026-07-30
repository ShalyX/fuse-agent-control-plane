import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AuthorizationDecisionStore,
  BurstBarrier,
  ProtocolRuntime,
  authorizationPayloadBytes,
  classifyProviderFault,
  expectedOutcomeEvidence,
  type AuthorizationArtifact,
  type OutcomeState,
} from "../src/evidence/reliabilityRuntimeV2.js";
import { fingerprint } from "../src/evidence/heldOutReliabilityV2.js";

const now = "2026-07-25T08:16:00.500Z";
const operatorKeys = generateKeyPairSync("ed25519");
const reconciliationKeys = generateKeyPairSync("ed25519");
const raw = (key: typeof operatorKeys.publicKey) => key.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
const TEST_ISSUERS = {
  operator: { id: "operator-issuer", rawPublicKeyHex: raw(operatorKeys.publicKey) },
  reconciliation: { id: "reconciliation-issuer", rawPublicKeyHex: raw(reconciliationKeys.publicKey) },
};
function signedArtifact(kind: "operator" | "reconciliation", valid = true): AuthorizationArtifact {
  const { privateKey } = kind === "operator" ? operatorKeys : reconciliationKeys;
  const payload = {
    kind, runId: "run-v2", planFingerprint: `sha256:${"a".repeat(64)}`,
    executableFingerprint: `sha256:${"b".repeat(64)}`, actorId: `${kind}-actor`,
    issuerCredentialId: TEST_ISSUERS[kind].id, capability: kind === "operator" ? "evidence:authorize-spend" : "evidence:authorize-reconciliation",
    nonce: kind === "operator" ? "nonce-1" : null,
    expiresAt: "2026-07-25T08:22:00.000Z",
  } as const;
  const signature = sign(null, authorizationPayloadBytes(payload), privateKey).toString("base64");
  return { payload, signature: valid ? signature : `${signature.slice(0, -2)}xx` };
}

describe("v2 crash-atomic authorization readiness", () => {
  it.each([
    [true, true, "consumed", "validated", true],
    [true, false, "valid_not_consumed_peer_invalid", "absent_or_invalid", false],
    [false, true, "absent_or_invalid", "valid_not_activated_peer_invalid", false],
    [false, false, "absent_or_invalid", "absent_or_invalid", false],
  ] as const)("maps operator=%s reconciliation=%s exactly", (operatorValid, reconciliationValid, operatorStatus, reconciliationStatus, active) => {
    const store = new AuthorizationDecisionStore(TEST_ISSUERS);
    const decision = store.decide({
      now, expectedRunId: "run-v2", expectedPlanFingerprint: `sha256:${"a".repeat(64)}`,
      expectedExecutableFingerprint: `sha256:${"b".repeat(64)}`,
      operator: signedArtifact("operator", operatorValid), reconciliation: signedArtifact("reconciliation", reconciliationValid),
    });
    expect(decision.operatorReceipt.status).toBe(operatorStatus);
    expect(decision.reconciliationReceipt.status).toBe(reconciliationStatus);
    expect(decision.control).toBe(active ? "active" : "failed");
    expect(store.nonceConsumed("nonce-1")).toBe(active);
    expect(store.providerCalls).toBe(0);
  });

  it("recovers byte-identical receipts after each post-commit crash and never recomputes the verdict", () => {
    for (const crashAt of ["after-commit", "after-operator-receipt", "after-reconciliation-receipt"] as const) {
      const store = new AuthorizationDecisionStore(TEST_ISSUERS);
      expect(() => store.decide({
        now, expectedRunId: "run-v2", expectedPlanFingerprint: `sha256:${"a".repeat(64)}`,
        expectedExecutableFingerprint: `sha256:${"b".repeat(64)}`,
        operator: signedArtifact("operator"), reconciliation: signedArtifact("reconciliation"), crashAt,
      })).toThrow("INJECTED_AUTHORIZATION_CRASH");
      const committed = store.committedDecision!;
      const recovered = store.recoverPublication();
      expect(recovered.decisionId).toBe(committed.decisionId);
      expect(fingerprint(recovered.operatorReceipt)).toBe(fingerprint(committed.operatorReceipt));
      expect(fingerprint(recovered.reconciliationReceipt)).toBe(fingerprint(committed.reconciliationReceipt));
      expect(store.nonceConsumed("nonce-1")).toBe(true);
      expect(store.decisionCount).toBe(1);
    }
  });

  it("rolls back a pre-commit crash and records readiness failure without consuming nonce", () => {
    const store = new AuthorizationDecisionStore(TEST_ISSUERS);
    expect(() => store.decide({
      now, expectedRunId: "run-v2", expectedPlanFingerprint: `sha256:${"a".repeat(64)}`,
      expectedExecutableFingerprint: `sha256:${"b".repeat(64)}`,
      operator: signedArtifact("operator"), reconciliation: signedArtifact("reconciliation"), crashAt: "before-commit",
    })).toThrow("INJECTED_AUTHORIZATION_CRASH");
    expect(store.decisionCount).toBe(0);
    const failure = store.failPredecision("decision_phase_deadline", now);
    expect(failure.operatorReceipt).toMatchObject({ status: "readiness_failed", reasonCode: "decision_phase_deadline" });
    expect(failure.reconciliationReceipt).toMatchObject({ status: "readiness_failed", reasonCode: "decision_phase_deadline" });
    expect(store.nonceConsumed("nonce-1")).toBe(false);
  });
});

describe("v2 lifecycle, outcomes, barrier, and global stop", () => {
  it("maps all terminal outcomes to exact execution/decision/token/cost/shadow/replay requirements", () => {
    const states: OutcomeState[] = ["not_dispatched", "completed_verified", "terminal_rejected_not_billed",
      "reconciled_not_billed", "reconciled_billed_with_response", "reconciled_billed_no_response", "unresolved_provider_outcome"];
    expect(states.map(expectedOutcomeEvidence)).toEqual([
      expect.objectContaining({ outcome: "not_dispatched", replayEligible: false }),
      expect.objectContaining({ executionStatus: "completed", shadowOrderState: "queued", replayEligible: true }),
      expect.objectContaining({ executionStatus: "failed", actualCost: "0", replayEligible: false }),
      expect.objectContaining({ executionStatus: "failed", actualCost: "0", replayEligible: false }),
      expect.objectContaining({ executionStatus: "completed", shadowOrderState: "queued", replayEligible: true }),
      expect.objectContaining({ executionStatus: "failed", shadowOrderState: null, replayEligible: false }),
      expect.objectContaining({ executionStatus: "reconciliation_hold", actualCost: null, replayEligible: false }),
    ]);
  });

  it.each([
    ["connect-before-dispatch", "not_dispatched"], ["timeout-after-dispatch", "reconciliation_pending"],
    ["http-429", "reconciliation_pending"], ["http-500", "reconciliation_pending"], ["http-502", "reconciliation_pending"],
    ["truncated", "reconciliation_pending"], ["oversized", "reconciliation_pending"], ["malformed", "reconciliation_pending"],
    ["model-mismatch", "reconciliation_pending"], ["missing-cost", "reconciliation_pending"], ["invalid-cost", "reconciliation_pending"],
    ["database-after-response", "reconciliation_pending"],
  ] as const)("classifies no-spend provider fault %s", (fault, outcome) => {
    expect(classifyProviderFault(fault)).toBe(outcome);
  });

  it("exhaustively cancels every unreleased identity-specific burst token across all 32 subsets", () => {
    const ids = ["a", "b", "c", "d", "e"];
    for (let mask = 0; mask < 32; mask++) {
      const tokens = ids.filter((_, index) => (mask & (1 << index)) !== 0);
      const barrier = new BurstBarrier(ids);
      for (const id of tokens) barrier.commitToken(id);
      barrier.globalFail();
      for (const id of ids) {
        expect(barrier.tokenCount(id)).toBe(tokens.includes(id) ? 1 : 0);
        expect(barrier.eventCount(id, "barrier_canceled_before_dispatch")).toBe(tokens.includes(id) ? 1 : 0);
        expect(barrier.adapterEntered(id)).toBe(false);
      }
      expect(() => barrier.commitToken("a")).toThrow("PROTOCOL_CONTROL_FAILED");
    }
  });

  it("releases all five only under active control and prevents any token after global failure", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const barrier = new BurstBarrier(ids);
    ids.forEach((id) => barrier.commitToken(id));
    barrier.release();
    ids.forEach((id) => {
      barrier.enterAdapter(id);
      expect(barrier.eventCount(id, "barrier_released")).toBe(1);
      expect(barrier.adapterEntered(id)).toBe(true);
    });
    barrier.globalFail();
    expect(() => barrier.commitToken("z")).toThrow("PROTOCOL_CONTROL_FAILED");
  });

  it("enforces 100-token hard fence, exact idempotency, and mandatory global stop", () => {
    const runtime = new ProtocolRuntime(Array.from({ length: 100 }, (_, i) => `id-${i}`));
    for (let i = 0; i < 100; i++) expect(runtime.authorizeDispatch(`id-${i}`)).toBe(true);
    expect(runtime.authorizeDispatch("id-0")).toBe(false);
    expect(() => runtime.authorizeDispatch("unplanned")).toThrow("UNPLANNED_REQUEST_ID");
    runtime.fail("COST_EXPOSURE_BREACH");
    expect(runtime.control).toBe("failed");
    expect(() => runtime.authorizeDispatch("id-99")).not.toThrow();
    expect(runtime.failureSequence).toBe(1);
  });
});
