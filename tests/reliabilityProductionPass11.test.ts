import { describe, expect, it } from "vitest";
import { reliabilityAdmissionWindowEligible } from "../src/reliability/protocolStore.js";
import { executeReliabilityCli } from "../src/evidence/reliabilityCliV2.js";
import { buildRequestCommitment, buildSealedRequestCommitment } from "../src/reliability/commitments.js";
import { runnerCallFailureDisposition, productionSetupCountsExact } from "../scripts/held-out-reliability-v2.js";

describe("reliability v2 production admission schedule", () => {
  it("uses the claim window for call one and the prior terminal window for later sequential calls", () => {
    const claim = Date.parse("2026-07-24T08:17:00.000Z");
    const terminal = Date.parse("2026-07-24T08:17:09.000Z");
    expect(reliabilityAdmissionWindowEligible({ laneId: "normal-paced", callOrdinal: 1, nowMs: claim + 1_000, claimedAtMs: claim, priorTerminalAtMs: null })).toBe(true);
    expect(reliabilityAdmissionWindowEligible({ laneId: "normal-paced", callOrdinal: 1, nowMs: claim + 2_000, claimedAtMs: claim, priorTerminalAtMs: null })).toBe(false);
    expect(reliabilityAdmissionWindowEligible({ laneId: "normal-paced", callOrdinal: 2, nowMs: terminal + 5_000, claimedAtMs: claim, priorTerminalAtMs: terminal })).toBe(true);
    expect(reliabilityAdmissionWindowEligible({ laneId: "normal-paced", callOrdinal: 2, nowMs: terminal + 4_999, claimedAtMs: claim, priorTerminalAtMs: terminal })).toBe(false);
    expect(reliabilityAdmissionWindowEligible({ laneId: "normal-paced", callOrdinal: 2, nowMs: terminal + 6_000, claimedAtMs: claim, priorTerminalAtMs: terminal })).toBe(false);
  });

  it("admits every bounded-burst member only in the claim release window", () => {
    const claim = Date.parse("2026-07-24T08:17:00.000Z");
    expect(reliabilityAdmissionWindowEligible({ laneId: "bounded-burst", callOrdinal: 5, nowMs: claim + 1_999, claimedAtMs: claim, priorTerminalAtMs: null })).toBe(true);
    expect(reliabilityAdmissionWindowEligible({ laneId: "bounded-burst", callOrdinal: 5, nowMs: claim + 2_000, claimedAtMs: claim, priorTerminalAtMs: null })).toBe(false);
  });

  it("reconstructs the full request commitment from the sealed HTTP projection", () => {
    const body={model:"nousresearch/hermes-4-405b",max_tokens:8,messages:[{role:"user",content:"hello"}]};
    const projection={method:"POST" as const,route:"/v1/chat/completions" as const,organizationId:"org",credentialId:"credential",mandateId:"mandate",branchId:"branch",workloadClass:"reliability.normal",idempotencyKey:"request-1",body};
    const direct=buildRequestCommitment(projection);
    expect(buildSealedRequestCommitment({body,organizationId:"org",credentialId:"credential",mandateId:"mandate",branchId:"branch",workloadClass:"reliability.normal",requestId:"request-1"})).toBe(direct);
  });

  it("keeps a provider ambiguity lane-local instead of globally failing the run", () => {
    expect(runnerCallFailureDisposition("reconciliation_pending")).toBe("hold_lane");
    expect(runnerCallFailureDisposition("dispatch_entered")).toBe("fail_protocol");
    expect(runnerCallFailureDisposition(null)).toBe("fail_protocol");
  });

  it("requires exact production setup cardinalities before a paid run", () => {
    expect(productionSetupCountsExact({organizations:"1",providers:"1",agents:"4",credentials:"4",policies:"4",mandates:"4",branches:"12"})).toBe(true);
    expect(productionSetupCountsExact({organizations:"1",providers:"1",agents:"3",credentials:"4",policies:"4",mandates:"4",branches:"12"})).toBe(false);
  });

  it("fails the CLI when the authoritative evidence report fails", async () => {
    const result=await executeReliabilityCli(["report"],{operations:{report:async()=>({passed:false,reasons:["OUTCOME_MATRIX_INVALID"]})}});
    expect(result).toMatchObject({ok:false,passed:false,errorCode:"AUTHORITATIVE_EVIDENCE_FAILED"});
  });
});
