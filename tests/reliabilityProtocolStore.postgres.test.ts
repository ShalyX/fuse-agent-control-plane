import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { ReliabilityProtocolStore } from "../src/reliability/protocolStore.js";
import { PROTOCOL_MUTATION_EXCLUSION_KEY } from "../src/reliability/protocolMutationExclusion.js";

const url = process.env.HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL_UNPOOLED;
const enabled = process.env.RUN_NEON_INTEGRATION === "1";

describe.skipIf(!enabled)("reliability v2 real unpooled PostgreSQL", () => {
  it("counts only dispatch-owned unresolved reservations when all 100 sealed calls are planned", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 4 });
    const store = new ReliabilityProtocolStore(pool);
    const runId = `test-${randomUUID()}`;
    try {
      await store.createSchema();
      const planFingerprint = `sha256:${"e".repeat(64)}`;
      await store.initializeRun({ runId, planFingerprint, lanes: ["normal-paced"] });
      await store.registerSealedCalls({ runId, calls: Array.from({ length: 100 }, (_, index) => ({
        requestId: `r${index + 1}`, block: Math.floor(index / 20) + 1,
        laneId: "normal-paced", callOrdinal: (index % 20) + 1, body: { index },
        organizationId: "org", agentId: "worker", credentialId: "credential", mandateId: "mandate", branchId: "branch",
        workloadClass: "baseline-lookup", provider: "openrouter", model: "nousresearch/hermes-4-405b",
        maxOutputTokens: 8, reservationCostMicros: 30_000n, claimFingerprint: planFingerprint,
      })) });
      await store.recordAttempt({ runId, requestId: "r1", laneId: "normal-paced", block: 1,
        requestCommitment: `sha256:${"f".repeat(64)}`, reservedCostMicros: 30_000n });
      await expect(store.authorizeReliabilityDispatch({ runId, requestId: "r1", laneId: "normal-paced", block: 1, ownerId: "worker" })).resolves.toMatchObject({ tokenId: expect.any(String) });
      const exposure = await pool.query<{ unresolved: string }>(`SELECT COALESCE(SUM(attempt.reserved_cost_micros),0)::text unresolved
        FROM reliability_protocol_attempts attempt JOIN reliability_dispatch_tokens token
          ON token.run_id=attempt.run_id AND token.request_id=attempt.request_id
        WHERE attempt.run_id=$1 AND attempt.terminal_at IS NULL AND token.canceled_at IS NULL`, [runId]);
      expect(exposure.rows[0]?.unresolved).toBe("30000");
    } finally {
      await pool.query("DELETE FROM reliability_dispatch_tokens WHERE run_id=$1", [runId]);
      await pool.query("DELETE FROM reliability_protocol_events WHERE run_id=$1", [runId]);
      await pool.query("DELETE FROM reliability_protocol_incidents WHERE run_id=$1", [runId]);
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1", [runId]);
      await pool.end();
    }
  }, 90_000);

  it("serializes genuinely concurrent token creation against global failure", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 4 });
    const store = new ReliabilityProtocolStore(pool);
    const runId = `test-${randomUUID()}`;
    try {
      await store.createSchema();
      const planFingerprint = `sha256:${"a".repeat(64)}`;
      await store.initializeRun({ runId, planFingerprint, lanes: ["normal-paced"] });
      await store.registerSealedCalls({ runId, calls: [{
        requestId: "r1", block: 1, laneId: "normal-paced", callOrdinal: 1, body: {},
        organizationId: "org", agentId: "worker", credentialId: "credential", mandateId: "mandate", branchId: "branch",
        workloadClass: "baseline-lookup", provider: "openrouter", model: "nousresearch/hermes-4-405b",
        maxOutputTokens: 8, reservationCostMicros: 10n, claimFingerprint: planFingerprint,
      }] });
      await store.recordAttempt({ runId, requestId: "r1", laneId: "normal-paced", block: 1, requestCommitment: `sha256:${"b".repeat(64)}`, reservedCostMicros: 10n });
      const [dispatch, failure] = await Promise.allSettled([
        store.authorizeReliabilityDispatch({ runId, requestId: "r1", laneId: "normal-paced", block: 1, ownerId: "worker" }),
        store.failProtocol(runId, "TEST_FAILURE"),
      ]);
      expect(failure.status).toBe("fulfilled");
      const rows = await pool.query("SELECT control.state control_state,attempt.state attempt_state,attempt.terminal_at IS NOT NULL terminal,token.canceled_at IS NOT NULL canceled,token.primitive_entered_at IS NOT NULL entered FROM reliability_protocol_controls control JOIN reliability_protocol_attempts attempt ON attempt.run_id=control.run_id LEFT JOIN reliability_dispatch_tokens token ON token.run_id=attempt.run_id AND token.request_id=attempt.request_id WHERE control.run_id=$1 AND attempt.request_id='r1'", [runId]);
      expect(rows.rows[0]).toMatchObject({ control_state: "failed", entered: false });
      if (dispatch.status === "fulfilled") expect(rows.rows[0]).toMatchObject({ canceled: false, terminal:false, attempt_state: "dispatch_authorized" });
      else { expect(String(dispatch.reason)).toContain("PROTOCOL_CONTROL_FAILED"); expect(rows.rows[0]).toMatchObject({terminal:true,attempt_state:"not_dispatched"}); }
    } finally {
      await pool.query("DELETE FROM reliability_dispatch_tokens WHERE run_id=$1", [runId]);
      await pool.query("DELETE FROM reliability_protocol_events WHERE run_id=$1", [runId]);
      await pool.query("DELETE FROM reliability_protocol_incidents WHERE run_id=$1", [runId]);
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1", [runId]);
      await pool.end();
    }
  }, 90_000);

  it("permits only one concurrent scheduler claimant and never claims a tokenized call", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 6 }); const store = new ReliabilityProtocolStore(pool); const runId=`test-${randomUUID()}`;
    try { await store.createSchema(); const fingerprint=`sha256:${"c".repeat(64)}`; await store.initializeRun({runId,planFingerprint:fingerprint,lanes:["normal-paced"]});
      await store.registerSealedCalls({runId,calls:[{requestId:"r1",block:1,laneId:"normal-paced",callOrdinal:1,body:{},organizationId:"org",agentId:"worker",credentialId:"credential",mandateId:"m",branchId:"b",workloadClass:"baseline-lookup",provider:"openrouter",model:"nousresearch/hermes-4-405b",maxOutputTokens:8,reservationCostMicros:10n,claimFingerprint:fingerprint}]});
      const claims=await Promise.all(["owner-a","owner-b"].map(ownerId=>store.acquireSchedulerClaim({runId,requestId:"r1",laneId:"normal-paced",block:1,ownerId,leaseSeconds:30,manifestPath:"/tmp/r1.json"})));
      expect(claims.filter(c=>c.acquired)).toHaveLength(1);
      await store.recordAttempt({runId,requestId:"r1",laneId:"normal-paced",block:1,requestCommitment:`sha256:${"d".repeat(64)}`,reservedCostMicros:10n});
      await store.authorizeReliabilityDispatch({runId,requestId:"r1",laneId:"normal-paced",block:1,ownerId:"worker"});
      const recovered=await store.acquireSchedulerClaim({runId,requestId:"r1",laneId:"normal-paced",block:1,ownerId:"owner-c",leaseSeconds:30,manifestPath:"/tmp/r1.json"});
      expect(recovered).toMatchObject({acquired:false,decision:"await_authoritative_outcome"});
    } finally { await pool.query("DELETE FROM reliability_dispatch_tokens WHERE run_id=$1",[runId]);await pool.query("DELETE FROM reliability_scheduler_claims WHERE run_id=$1",[runId]);await pool.query("DELETE FROM reliability_protocol_events WHERE run_id=$1",[runId]);await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1",[runId]);await pool.end(); }
  }, 90_000);

  it("durably gates execution on an exact readiness receipt and mechanically resumes a drained FIFO lane", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 4 });
    const store = new ReliabilityProtocolStore(pool); const runId=`test-${randomUUID()}`;
    const fingerprint=`sha256:${"9".repeat(64)}`;
    try {
      await store.createSchema();
      await store.initializeRun({runId,planFingerprint:fingerprint,lanes:["normal-paced"]});
      await expect(store.requireSetupReadinessReceipt({runId,planFingerprint:fingerprint})).rejects.toThrow("SETUP_READINESS_RECEIPT_REQUIRED");
      await store.recordSetupReadinessReceipt({runId,expectedSnapshot:{provider:{model:"sealed"}},actualSnapshot:{provider:{model:"drifted"}}});
      await expect(store.requireSetupReadinessReceipt({runId,planFingerprint:fingerprint})).rejects.toThrow("SETUP_READINESS_RECEIPT_REQUIRED");
      const receipt=await store.recordSetupReadinessReceipt({runId,expectedSnapshot:{provider:{model:"sealed"}},actualSnapshot:{provider:{model:"sealed"}}});
      await expect(store.requireSetupReadinessReceipt({runId,planFingerprint:fingerprint})).resolves.toBe(receipt.snapshotDigest);
      await pool.query("UPDATE reliability_protocol_lanes SET state='resume_pending',resume_at=clock_timestamp()-interval '1 second' WHERE run_id=$1 AND lane_id='normal-paced'",[runId]);
      await expect(store.resumeDueLanes(runId)).resolves.toEqual(["normal-paced"]);
      const lane=await pool.query("SELECT state,resume_at FROM reliability_protocol_lanes WHERE run_id=$1 AND lane_id='normal-paced'",[runId]);
      expect(lane.rows[0]).toMatchObject({state:"ready",resume_at:null});
    } finally {
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1",[runId]);
      await pool.end();
    }
  }, 90_000);

  it("bounds protocol transactions waiting on the replay exclusion lock", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 3 });
    const blocker = await pool.connect();
    const store = new ReliabilityProtocolStore(pool);
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [PROTOCOL_MUTATION_EXCLUSION_KEY]);
      const startedAt = Date.now();
      await expect(store.initializeRun({
        runId: `test-${randomUUID()}`,
        planFingerprint: `sha256:${"8".repeat(64)}`,
        lanes: ["normal-paced"],
      })).rejects.toMatchObject({ code: "55P03" });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(4_000);
      expect(elapsedMs).toBeLessThan(15_000);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pool.end();
    }
  }, 30_000);
});
