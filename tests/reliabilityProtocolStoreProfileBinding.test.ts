import { describe, expect, it, vi } from "vitest";
import { deterministicAuthorizationDecisionId, ReliabilityProtocolStore } from "../src/reliability/protocolStore.js";
import { RELIABILITY_V3_PROFILE } from "../src/reliability/protocolProfile.js";

const planFingerprint = `sha256:${"1".repeat(64)}`;

function mismatchedControl() {
  return {
    state: "active", plan_fingerprint: planFingerprint, failure_sequence: "0",
    protocol_version: 3, evidence_type: "held-out-reliability-v3", plan_schema_version: 2, mapping_version: 2,
    profile_fingerprint: `sha256:${"0".repeat(64)}`,
  };
}

function sealedCall() {
  return {
    requestId: "request-1", block: 1, laneId: "normal-paced", callOrdinal: 1, body: { prompt: "sealed" },
    organizationId: "org", agentId: "agent", credentialId: "credential", mandateId: "mandate", branchId: "branch",
    workloadClass: "baseline-lookup", provider: "openrouter", model: "nousresearch/hermes-4-405b",
    maxOutputTokens: 8, reservationCostMicros: 10n, claimFingerprint: planFingerprint,
  };
}

function mismatchedDatabase(statements: string[]) {
  return { query: vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes("FROM reliability_protocol_controls") && sql.includes("FOR UPDATE")) return { rows: [mismatchedControl()] };
    if (sql.includes("FROM reliability_protocol_lanes")) return { rows: [{ state: "ready" }] };
    return { rows: [] };
  }) };
}

describe("durable reliability profile mutation gate", () => {
  it("durably starts one v3 authorization operation with fixed database-time deadlines", async () => {
    const statements:string[]=[];
    const startedAt=new Date("2026-08-02T08:16:00.250Z");
    const database={query:vi.fn(async(sql:string)=>{
      statements.push(sql);
      if(sql.includes("FROM reliability_protocol_controls")&&sql.includes("FOR UPDATE"))return {rows:[{...mismatchedControl(),profile_fingerprint:RELIABILITY_V3_PROFILE.profileFingerprint}]};
      if(sql.includes("INSERT INTO reliability_authorization_operations"))return {rows:[{started_at:startedAt,validation_deadline:new Date(startedAt.getTime()+5_000),decision_deadline:new Date(startedAt.getTime()+20_000),publication_deadline:new Date(startedAt.getTime()+50_000),transition_deadline:new Date(startedAt.getTime()+55_000)}]};
      return {rows:[]};
    })};
    const store=new ReliabilityProtocolStore(database as never);
    const begin=(store as unknown as Record<string,unknown>)["beginAuthorizationOperation"];
    expect(begin).toBeTypeOf("function");
    await expect((begin as (runId:string)=>Promise<unknown>).call(store,"hov3-operation-deadlines")).resolves.toEqual({
      startedAt:startedAt.toISOString(),validationDeadline:new Date(startedAt.getTime()+5_000).toISOString(),decisionDeadline:new Date(startedAt.getTime()+20_000).toISOString(),publicationDeadline:new Date(startedAt.getTime()+50_000).toISOString(),transitionDeadline:new Date(startedAt.getTime()+55_000).toISOString(),
    });
    expect(statements.some(sql=>sql.includes("INSERT INTO reliability_authorization_operations"))).toBe(true);
    expect(statements).toContain("COMMIT");
  });

  it("rejects a late v3 authorization decision before decision or outbox writes", async () => {
    const statements:string[]=[];
    const database={query:vi.fn(async(sql:string)=>{
      statements.push(sql);
      if(sql.includes("FROM reliability_protocol_controls")&&sql.includes("FOR UPDATE"))return {rows:[{...mismatchedControl(),profile_fingerprint:RELIABILITY_V3_PROFILE.profileFingerprint}]};
      if(sql.includes("FROM reliability_authorization_operations")&&sql.includes("FOR UPDATE"))return {rows:[{decision_deadline:new Date("2026-08-02T08:16:20.000Z")}]};
      if(sql.includes("clock_timestamp() AS now"))return {rows:[{now:new Date("2026-08-02T08:16:21.000Z")}]};
      return {rows:[]};
    })};
    const store=new ReliabilityProtocolStore(database as never);
    await expect(store.commitAuthorization({runId:"hov3-decision-deadline",decisionId:"unused",verdict:{},active:false,
      operatorIssuerId:"operator",operatorNonce:null,operatorReceipt:{},reconciliationReceipt:{},decisionDeadline:"2026-08-02T08:16:20.000Z"} as never))
      .rejects.toThrow("AUTHORIZATION_DECISION_DEADLINE_MISSED");
    expect(statements.some(sql=>sql.includes("INSERT INTO reliability_authorization_decisions"))).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });

  it("rolls back a lane-bound mutation before attempt writes when the control profile differs", async () => {
    const statements: string[] = [];
    const store = new ReliabilityProtocolStore(mismatchedDatabase(statements) as never);
    await expect(store.recordAttempt({
      runId: "hov3-profile-gate", requestId: "request-1", laneId: "normal-paced", block: 1,
      requestCommitment: `sha256:${"2".repeat(64)}`, reservedCostMicros: 10n,
    })).rejects.toThrow("PROTOCOL_PROFILE_CONFLICT");
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((sql) => sql.includes("UPDATE reliability_protocol_attempts"))).toBe(false);
  });

  it("rejects authorization commits before decision or outbox writes when the control profile differs", async () => {
    const statements: string[] = [];
    const database = mismatchedDatabase(statements);
    const store = new ReliabilityProtocolStore(database as never);
    const runId = "hov3-profile-mismatch";
    await expect(store.commitAuthorization({
      runId, decisionId: deterministicAuthorizationDecisionId(runId), verdict: {}, active: false,
      operatorIssuerId: "operator", operatorNonce: null, operatorReceipt: {}, reconciliationReceipt: {},
    })).rejects.toThrow("PROTOCOL_PROFILE_CONFLICT");
    expect(statements.some((sql) => sql.includes("INSERT INTO reliability_authorization_decisions"))).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });

  it("rejects replay and settlement writes when the control profile differs", async () => {
    for (const [operation, forbiddenWrite] of [
      [(store: ReliabilityProtocolStore) => store.recordReplayAudit({ runId: "hov3-profile-mismatch", requestId: "r1", replayNo: 1, originalResponseCommitment: planFingerprint, replayResponseCommitment: planFingerprint, writeSet: [] }), "INSERT INTO reliability_replay_audits"],
      [(store: ReliabilityProtocolStore) => store.appendSettlementPoll({ runId: "hov3-profile-mismatch", pollNo: 1, offsetSeconds: 0, snapshotDigest: planFingerprint, complete: false }), "INSERT INTO reliability_settlement_journal"],
    ] as const) {
      const statements: string[] = [];
      const store = new ReliabilityProtocolStore(mismatchedDatabase(statements) as never);
      await expect(operation(store)).rejects.toThrow("PROTOCOL_PROFILE_CONFLICT");
      expect(statements.some((sql) => sql.includes(forbiddenWrite))).toBe(false);
      expect(statements).toContain("ROLLBACK");
    }
  });

  it("rejects stage, artifact, replay-completion, and settlement-finalization writes when the profile differs", async () => {
    const operations = [
      (store: ReliabilityProtocolStore) => store.advanceDurableStage("hov3-profile-mismatch", "fresh_terminal"),
      (store: ReliabilityProtocolStore) => store.bindArtifactInventory("hov3-profile-mismatch", { "artifact.json": planFingerprint }),
      (store: ReliabilityProtocolStore) => store.completeReplayRun("hov3-profile-mismatch"),
      (store: ReliabilityProtocolStore) => store.finalizeSettlement({ runId: "hov3-profile-mismatch", snapshotDigest: planFingerprint, acceptedOffsetSeconds: null }),
    ];
    for (const operation of operations) {
      const statements: string[] = [];
      const store = new ReliabilityProtocolStore(mismatchedDatabase(statements) as never);
      await expect(operation(store)).rejects.toThrow("PROTOCOL_PROFILE_CONFLICT");
      expect(statements).toContain("ROLLBACK");
    }
  });

  it("rejects replay inventory, reconciliation, hard-finalization, and final-report staging when the profile differs", async () => {
    const operations = [
      (store: ReliabilityProtocolStore) => store.registerReplayAuthorizationInventory({
        runId: "hov3-profile-mismatch", authorizationSha256: planFingerprint,
        requestIds: Array.from({ length: 20 }, (_, index) => `request-${index + 1}`),
      }),
      (store: ReliabilityProtocolStore) => store.authorizeReconciliationOffset({
        runId: "hov3-profile-mismatch", requestId: "request-1", offsetSeconds: 0,
        credentialId: "credential-1", authorizationSha256: planFingerprint,
      }),
      (store: ReliabilityProtocolStore) => store.applyAuthoritativeReconciliation({ runId: "hov3-profile-mismatch" } as never),
      (store: ReliabilityProtocolStore) => store.hardFinalizeReliabilityRun({ runId: "hov3-profile-mismatch", deadlineMs: 1 }),
      (store: ReliabilityProtocolStore) => store.commitCanonicalFinalReport({
        runId: "hov3-profile-mismatch", marker: { settlement: { acceptedSnapshotDigest: planFingerprint } } as never,
      }),
      (store: ReliabilityProtocolStore) => store.publishPendingCanonicalFinalReport("hov3-profile-mismatch", vi.fn()),
      (store: ReliabilityProtocolStore) => store.publishPendingFailureReport("hov3-profile-mismatch", vi.fn()),
      (store: ReliabilityProtocolStore) => store.publishAuthorizationOutbox("hov3-profile-mismatch", vi.fn()),
      (store: ReliabilityProtocolStore) => store.resumeDueLanes("hov3-profile-mismatch"),
      (store: ReliabilityProtocolStore) => store.failReconciliationOffset({ runId: "hov3-profile-mismatch", requestId: "request-1", offsetSeconds: 0, failureCode: "FAILED" }),
      (store: ReliabilityProtocolStore) => store.finishReconciliationLookup({ runId: "hov3-profile-mismatch", requestId: "request-1", offsetSeconds: 0 }),
      (store: ReliabilityProtocolStore) => store.recordSetupReadinessReceipt({ runId: "hov3-profile-mismatch", expectedSnapshot: {}, actualSnapshot: {} }),
      (store: ReliabilityProtocolStore) => store.commitReconciliationEvidence({ runId: "hov3-profile-mismatch", requestId: "request-1", offsetSeconds: 0, metadata: {}, content: {}, disposition: "absent" }),
      (store: ReliabilityProtocolStore) => store.withReplayMutex({ runId: "hov3-profile-mismatch", ownerId: "owner-1" }, async () => undefined),
      (store: ReliabilityProtocolStore) => store.runAndPersistAuthoritativeSettlement("hov3-profile-mismatch"),
    ];
    for (const operation of operations) {
      const statements: string[] = [];
      const store = new ReliabilityProtocolStore(mismatchedDatabase(statements) as never);
      await expect(operation(store)).rejects.toThrow("PROTOCOL_PROFILE_CONFLICT");
      expect(statements).toContain("ROLLBACK");
    }
  });

  it("rolls back a v3 sealed-call mutation when the locked control profile differs from production", async () => {
    const statements: string[] = [];
    const store = new ReliabilityProtocolStore(mismatchedDatabase(statements) as never);
    await expect(store.registerSealedCalls({ runId: "hov3-profile-gate", calls: [sealedCall()] }))
      .rejects.toThrow("PROTOCOL_PROFILE_CONFLICT");
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((sql) => sql.includes("INSERT INTO reliability_sealed_calls"))).toBe(false);
    expect(statements).not.toContain("COMMIT");
  });

  it("rejects block claims before authorization or claim writes when the control profile differs", async () => {
    const statements: string[] = [];
    const store = new ReliabilityProtocolStore(mismatchedDatabase(statements) as never);
    await expect(store.claimBlock({
      runId: "hov3-profile-gate", block: 1, ownerId: "runner",
      opensAt: "2026-08-01T00:00:00.000Z", launchDeadline: "2026-08-01T00:05:00.000Z",
      planFingerprint,
    })).rejects.toThrow("PROTOCOL_PROFILE_CONFLICT");
    expect(statements.some((sql) => sql.includes("reliability_authorization_decisions"))).toBe(false);
    expect(statements.some((sql) => sql.includes("INSERT INTO reliability_block_claims"))).toBe(false);
  });

  it("rejects protocol failure before control or token updates when the control profile differs", async () => {
    const statements: string[] = [];
    const store = new ReliabilityProtocolStore(mismatchedDatabase(statements) as never);
    await expect(store.failProtocol("hov3-profile-gate", "TEST_FAILURE"))
      .rejects.toThrow("PROTOCOL_PROFILE_CONFLICT");
    expect(statements.some((sql) => sql.includes("UPDATE reliability_protocol_controls"))).toBe(false);
    expect(statements.some((sql) => sql.includes("UPDATE reliability_dispatch_tokens"))).toBe(false);
  });
});
