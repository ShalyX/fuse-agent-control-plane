import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PolicyStore } from "../src/persistence/policyStore.js";
import { ReliabilityProtocolStore, deterministicAuthorizationDecisionId } from "../src/reliability/protocolStore.js";
import { PROTOCOL_MUTATION_EXCLUSION_KEY } from "../src/reliability/protocolMutationExclusion.js";
import { RELIABILITY_V2_PROFILE, RELIABILITY_V3_PROFILE, RELIABILITY_V4_PROFILE } from "../src/reliability/protocolProfile.js";

const url = process.env.HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL_UNPOOLED;
const enabled = process.env.RUN_NEON_INTEGRATION === "1";
const execFileAsync=promisify(execFile);

async function bootstrapProductionSchemas(pool: Pool, store: ReliabilityProtocolStore): Promise<void> {
  await new PolicyStore(pool).ensureSchema();
  await store.createSchema();
}
if (enabled && url) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname.includes("-pooler") || hostname.includes(".pooler")) {
    throw new Error("HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED points to a pooled hostname");
  }
}

describe.skipIf(!enabled)("reliability v2 real unpooled PostgreSQL", () => {
  it("durably binds a v4 run to the exact v4 profile and rejects v3 reopening", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 2 });
    const store = new ReliabilityProtocolStore(pool);
    const runId = `hov4-test-${randomUUID()}`;
    const fingerprint = `sha256:${"4".repeat(64)}`;
    try {
      await bootstrapProductionSchemas(pool, store);
      await store.initializeRun({ runId, planFingerprint: fingerprint, lanes: ["normal-paced"], profile: RELIABILITY_V4_PROFILE });
      expect((await pool.query(`SELECT protocol_version,evidence_type,plan_schema_version,mapping_version,profile_fingerprint
        FROM reliability_protocol_controls WHERE run_id=$1`, [runId])).rows[0]).toEqual({
        protocol_version: 4,
        evidence_type: "held-out-reliability-v4",
        plan_schema_version: 2,
        mapping_version: 2,
        profile_fingerprint: RELIABILITY_V4_PROFILE.profileFingerprint,
      });
      await expect(store.initializeRun({ runId, planFingerprint: fingerprint, lanes: ["normal-paced"], profile: RELIABILITY_V3_PROFILE }))
        .rejects.toThrow("PROTOCOL_PROFILE_RUN_ID_CONFLICT");
    } finally {
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1", [runId]);
      await pool.end();
    }
  }, 90_000);

  it("rejects a pre-existing non-normative v4 attempt commitment during registration", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:true},max:2});const store=new ReliabilityProtocolStore(pool);
    const runId=`hov4-commitment-${randomUUID()}`,fingerprint=`sha256:${"c".repeat(64)}`,requestId=`request-${randomUUID()}`;
    const call={requestId,block:1,laneId:"normal-paced",callOrdinal:1,body:{model:"model",messages:[]},organizationId:"org",agentId:"agent",credentialId:"credential",mandateId:"mandate",branchId:"branch",workloadClass:"class",provider:"openrouter",model:"model",maxOutputTokens:8,reservationCostMicros:1n,claimFingerprint:fingerprint,requestCommitment:`sha256:${"d".repeat(64)}`};
    try{
      await bootstrapProductionSchemas(pool,store);await store.initializeRun({runId,planFingerprint:fingerprint,lanes:["normal-paced"],profile:RELIABILITY_V4_PROFILE});
      await store.registerSealedCalls({runId,calls:[call]});
      await pool.query("UPDATE reliability_protocol_attempts SET request_commitment=$3 WHERE run_id=$1 AND request_id=$2",[runId,requestId,`sha256:${"e".repeat(64)}`]);
      await expect(store.registerSealedCalls({runId,calls:[call]})).rejects.toThrow("PROTOCOL_ATTEMPT_CONFLICT");
    }finally{
      await pool.query("DELETE FROM reliability_protocol_events WHERE run_id=$1",[runId]);await pool.query("DELETE FROM reliability_protocol_attempts WHERE run_id=$1",[runId]);
      await pool.query("DELETE FROM reliability_sealed_calls WHERE run_id=$1",[runId]);await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1",[runId]);await pool.end();
    }
  }, 90_000);

  it("completes the inherited v4 authorization publication lifecycle", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 2 });
    const store = new ReliabilityProtocolStore(pool);
    const runId = `hov4-auth-${randomUUID()}`;
    const planFingerprint = `sha256:${"a".repeat(64)}`;
    const operatorDigest = `sha256:${"b".repeat(64)}` as const;
    const reconciliationDigest = `sha256:${"c".repeat(64)}` as const;
    const reasonCode = "valid_pair";
    try {
      await bootstrapProductionSchemas(pool, store);
      await store.initializeRun({ runId, planFingerprint, lanes: ["normal-paced"], profile: RELIABILITY_V4_PROFILE });
      const operation = await store.beginAuthorizationOperation(runId);
      const decisionId = deterministicAuthorizationDecisionId({ runId, planFingerprint,
        profileFingerprint: RELIABILITY_V4_PROFILE.profileFingerprint, decisionKind: "active", reasonCode,
        operatorArtifactSha256: operatorDigest, reconciliationArtifactSha256: reconciliationDigest });
      await store.commitAuthorization({ runId, decisionId, active: true, operatorIssuerId: "v4-operator",
        operatorNonce: `hov4-operator-${randomUUID()}`, decisionDeadline: operation.decisionDeadline,
        verdict: { operatorValid: true, reconciliationValid: true },
        operatorReceipt: { kind: "operator", status: "consumed", reasonCode, presentedArtifactSha256: operatorDigest },
        reconciliationReceipt: { kind: "reconciliation", status: "validated", reasonCode, presentedArtifactSha256: reconciliationDigest } });
      const published: string[] = [];
      await store.publishAuthorizationOutbox(runId, async kind => { published.push(kind); }, operation.publicationDeadline);
      await store.completeAuthorizationOperation(runId, operation.transitionDeadline);
      expect(published.sort()).toEqual(["operator", "reconciliation"]);
      expect((await pool.query("SELECT publication_completed_at IS NOT NULL published,transition_completed_at IS NOT NULL transitioned FROM reliability_authorization_operations WHERE run_id=$1", [runId])).rows[0])
        .toEqual({ published: true, transitioned: true });
    } finally {
      for (const table of ["reliability_report_publication_receipts", "reliability_report_publication_events", "reliability_report_publication_outbox", "reliability_protocol_incidents", "reliability_authorization_outbox", "reliability_authorization_decisions", "reliability_authorization_operations", "reliability_authorization_nonces"])
        await pool.query(`DELETE FROM ${table} WHERE run_id=$1`, [runId]);
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1", [runId]);
      await pool.end();
    }
  }, 90_000);

  it("registers v4 replay authority from the committed authorization decision", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 2 });
    const store = new ReliabilityProtocolStore(pool);
    const runId = `hov4-replay-${randomUUID()}`;
    const planFingerprint = `sha256:${"d".repeat(64)}`;
    const operatorDigest = `sha256:${"e".repeat(64)}` as const;
    const reconciliationDigest = `sha256:${"f".repeat(64)}` as const;
    const decisionId = deterministicAuthorizationDecisionId({ runId, planFingerprint,
      profileFingerprint: RELIABILITY_V4_PROFILE.profileFingerprint, decisionKind: "active", reasonCode: "valid_pair",
      operatorArtifactSha256: operatorDigest, reconciliationArtifactSha256: reconciliationDigest });
    const requestIds = Array.from({ length: 20 }, (_, index) => `r${index + 1}`);
    try {
      await bootstrapProductionSchemas(pool, store);
      await store.initializeRun({ runId, planFingerprint, lanes: ["normal-paced"], profile: RELIABILITY_V4_PROFILE });
      await store.registerSealedCalls({ runId, calls: requestIds.map((requestId, index) => ({ requestId,
        block: 1, laneId: "normal-paced", callOrdinal: index + 1, body: { index }, organizationId: "org",
        agentId: "worker", credentialId: "credential", mandateId: "mandate", branchId: "branch",
        workloadClass: "baseline-lookup", provider: "openrouter", model: "nousresearch/hermes-4-405b",
        maxOutputTokens: 8, reservationCostMicros: 10n, claimFingerprint: planFingerprint })) });
      await pool.query("INSERT INTO reliability_authorization_decisions(run_id,decision_id,verdict) VALUES($1,$2,$3::jsonb)",
        [runId, decisionId, JSON.stringify({ operatorValid: true, reconciliationValid: true })]);
      await pool.query("INSERT INTO reliability_authorization_outbox(run_id,receipt_kind,receipt,published_at) VALUES($1,'operator','{}'::jsonb,clock_timestamp()),($1,'reconciliation','{}'::jsonb,clock_timestamp())", [runId]);
      await pool.query("UPDATE reliability_protocol_controls SET durable_stage='fresh_terminal' WHERE run_id=$1", [runId]);
      await expect(store.registerReplayAuthorizationInventory({ runId, requestIds })).resolves.toHaveLength(20);
      const rows = await pool.query("SELECT authorization_decision_id::text,signed_authorization_sha256 FROM reliability_replay_authorizations WHERE run_id=$1", [runId]);
      expect(rows.rows).toHaveLength(20);
      expect(rows.rows.every(row => row.authorization_decision_id === decisionId && row.signed_authorization_sha256 === null)).toBe(true);
    } finally {
      for (const table of ["reliability_replay_authorizations", "reliability_authorization_outbox", "reliability_authorization_decisions"])
        await pool.query(`DELETE FROM ${table} WHERE run_id=$1`, [runId]);
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1", [runId]);
      await pool.end();
    }
  }, 90_000);

  it("recovers v4 hard-finalization publications in a fresh process", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:true},max:2});
    const store=new ReliabilityProtocolStore(pool);const runId=`hov4-finalize-${randomUUID()}`,fingerprint=`sha256:${"8".repeat(64)}`;
    try{
      await bootstrapProductionSchemas(pool,store);
      await store.initializeRun({runId,planFingerprint:fingerprint,lanes:["normal-paced"],profile:RELIABILITY_V4_PROFILE});
      await store.registerSealedCalls({runId,calls:[{requestId:`request-${randomUUID()}`,block:1,laneId:"normal-paced",callOrdinal:1,
        body:{model:"nousresearch/hermes-4-405b",max_tokens:8,messages:[]},organizationId:"org",agentId:"agent",credentialId:"credential",
        mandateId:"mandate",branchId:"branch",workloadClass:"held-out-normal",provider:"openrouter",model:"nousresearch/hermes-4-405b",
        maxOutputTokens:8,reservationCostMicros:30_000n,claimFingerprint:fingerprint,requestCommitment:`sha256:${"9".repeat(64)}`}]});
      expect((await store.hardFinalizeReliabilityRun({runId,deadlineMs:0})).action).toBe("finalize_failure");
      await pool.end();
      const moduleUrl=new URL("../src/reliability/protocolStore.ts",import.meta.url).href;
      const child=`import pg from 'pg';import {ReliabilityProtocolStore} from ${JSON.stringify(moduleUrl)};const pool=new pg.Pool({connectionString:process.env.CHILD_DB_URL,ssl:{rejectUnauthorized:true},max:2});const store=new ReliabilityProtocolStore(pool);const action=(await store.hardFinalizeReliabilityRun({runId:process.env.CHILD_RUN_ID,deadlineMs:0})).action;let supportCount=0,reportCount=0;const support=await store.publishPendingFailureReport(process.env.CHILD_RUN_ID,async()=>{supportCount++});const report=await store.publishPendingReportIntent(process.env.CHILD_RUN_ID,async()=>{reportCount++});await pool.end();console.log(JSON.stringify({action,support,report,supportCount,reportCount}));`;
      const result=await execFileAsync(process.execPath,["--import",`${process.cwd()}/node_modules/tsx/dist/loader.mjs`,"--input-type=module","--eval",child],
        {cwd:process.cwd(),env:{...process.env,CHILD_DB_URL:url,CHILD_RUN_ID:runId},maxBuffer:1024*1024});
      const recovered=JSON.parse(result.stdout.trim()) as {action:string;support:{published:boolean};report:{published:boolean;path:string};supportCount:number;reportCount:number};
      expect(recovered.action).toBe("already_terminal");expect(recovered.support.published).toBe(true);expect(recovered.supportCount).toBeGreaterThan(0);
      expect(recovered.report.published).toBe(true);expect(recovered.report.path).toBeTruthy();expect(recovered.reportCount).toBeGreaterThan(0);
    }finally{
      await pool.end().catch(()=>undefined);
      const cleanup=new Pool({connectionString:url,ssl:{rejectUnauthorized:true},max:1});
      for(const table of ["reliability_report_publication_receipts","reliability_report_publication_events","reliability_report_publication_outbox","reliability_failure_report_outbox","reliability_protocol_events","reliability_protocol_incidents","reliability_protocol_attempts","reliability_sealed_calls"])
        await cleanup.query(`DELETE FROM ${table} WHERE run_id=$1`,[runId]);
      await cleanup.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1",[runId]);await cleanup.end();
    }
  }, 90_000);

  it("durably binds a v3 run to its complete profile and rejects cross-version reopening", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 2 });
    const store = new ReliabilityProtocolStore(pool);
    const suffix = randomUUID();
    const v3RunId = `hov3-test-${suffix}`;
    const v2RunId = `test-${suffix}`;
    const fingerprint = `sha256:${"7".repeat(64)}`;
    try {
      await bootstrapProductionSchemas(pool, store);
      await store.initializeRun({ runId: v3RunId, planFingerprint: fingerprint, lanes: ["normal-paced"], profile: RELIABILITY_V3_PROFILE });
      const row = await pool.query(`SELECT protocol_version,evidence_type,plan_schema_version,mapping_version,profile_fingerprint
        FROM reliability_protocol_controls WHERE run_id=$1`, [v3RunId]);
      expect(row.rows[0]).toEqual({
        protocol_version: 3,
        evidence_type: "held-out-reliability-v3",
        plan_schema_version: 2,
        mapping_version: 2,
        profile_fingerprint: RELIABILITY_V3_PROFILE.profileFingerprint,
      });
      await expect(store.initializeRun({ runId: v3RunId, planFingerprint: fingerprint, lanes: ["normal-paced"], profile: RELIABILITY_V2_PROFILE }))
        .rejects.toThrow("PROTOCOL_PROFILE_RUN_ID_CONFLICT");
      await store.initializeRun({ runId: v2RunId, planFingerprint: fingerprint, lanes: ["normal-paced"], profile: RELIABILITY_V2_PROFILE });
      expect((await pool.query("SELECT profile_fingerprint FROM reliability_protocol_controls WHERE run_id=$1", [v2RunId])).rows[0]?.profile_fingerprint)
        .toBe(RELIABILITY_V2_PROFILE.profileFingerprint);
    } finally {
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=ANY($1::text[])", [[v3RunId, v2RunId]]);
      await pool.end();
    }
  }, 90_000);

  it("recomputes v3 authorization decision authority from the accepted outbox receipts", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:true},max:2});
    const store=new ReliabilityProtocolStore(pool);const runId=`hov3-auth-${randomUUID()}`;
    const planFingerprint=`sha256:${"9".repeat(64)}`;
    const operatorReceipt={artifactKind:"authorization_receipt",kind:"operator",runId,status:"consumed",reasonCode:"valid_pair",presentedArtifactSha256:`sha256:${"a".repeat(64)}`};
    const reconciliationReceipt={artifactKind:"authorization_receipt",kind:"reconciliation",runId,status:"validated",reasonCode:"valid_pair",presentedArtifactSha256:`sha256:${"b".repeat(64)}`};
    const decisionId=deterministicAuthorizationDecisionId({runId,planFingerprint,profileFingerprint:RELIABILITY_V3_PROFILE.profileFingerprint,
      decisionKind:"active",reasonCode:"valid_pair",operatorArtifactSha256:operatorReceipt.presentedArtifactSha256 as `sha256:${string}`,
      reconciliationArtifactSha256:reconciliationReceipt.presentedArtifactSha256 as `sha256:${string}`});
    try{
      await bootstrapProductionSchemas(pool, store);await store.initializeRun({runId,planFingerprint,lanes:["normal-paced"],profile:RELIABILITY_V3_PROFILE});
      await pool.query("INSERT INTO reliability_authorization_decisions(run_id,decision_id,verdict) VALUES($1,$2,$3::jsonb)",[runId,decisionId,JSON.stringify({operatorValid:true,reconciliationValid:true})]);
      await pool.query("INSERT INTO reliability_authorization_outbox(run_id,receipt_kind,receipt,published_at) VALUES($1,'operator',$2::jsonb,clock_timestamp()),($1,'reconciliation',$3::jsonb,clock_timestamp())",
        [runId,JSON.stringify(operatorReceipt),JSON.stringify(reconciliationReceipt)]);
      const accepted=await (store as any).readEvidenceClosureRows(pool,runId);
      expect(accepted.authorizationDecisions).toHaveLength(1);expect(accepted.authorizationDecisions[0]).toMatchObject({decisionId,decisionIdValid:true});
      await pool.query("UPDATE reliability_authorization_outbox SET receipt=jsonb_set(receipt,'{presentedArtifactSha256}',to_jsonb($2::text)) WHERE run_id=$1 AND receipt_kind='operator'",
        [runId,`sha256:${"c".repeat(64)}`]);
      const substituted=await (store as any).readEvidenceClosureRows(pool,runId);
      expect(substituted.authorizationDecisions[0]).toMatchObject({decisionId,decisionIdValid:false});
    }finally{
      await pool.query("DELETE FROM reliability_authorization_outbox WHERE run_id=$1",[runId]);
      await pool.query("DELETE FROM reliability_authorization_decisions WHERE run_id=$1",[runId]);
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1",[runId]);await pool.end();
    }
  },90_000);

  it("recomputes v4 authorization decision authority from the accepted outbox receipts", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:true},max:2});
    const store=new ReliabilityProtocolStore(pool);const runId=`hov4-auth-evidence-${randomUUID()}`;
    const planFingerprint=`sha256:${"7".repeat(64)}`;
    const operatorReceipt={artifactKind:"authorization_receipt",kind:"operator",runId,status:"consumed",reasonCode:"valid_pair",presentedArtifactSha256:`sha256:${"8".repeat(64)}`};
    const reconciliationReceipt={artifactKind:"authorization_receipt",kind:"reconciliation",runId,status:"validated",reasonCode:"valid_pair",presentedArtifactSha256:`sha256:${"9".repeat(64)}`};
    const decisionId=deterministicAuthorizationDecisionId({runId,planFingerprint,profileFingerprint:RELIABILITY_V4_PROFILE.profileFingerprint,
      decisionKind:"active",reasonCode:"valid_pair",operatorArtifactSha256:operatorReceipt.presentedArtifactSha256 as `sha256:${string}`,
      reconciliationArtifactSha256:reconciliationReceipt.presentedArtifactSha256 as `sha256:${string}`});
    try{
      await bootstrapProductionSchemas(pool, store);await store.initializeRun({runId,planFingerprint,lanes:["normal-paced"],profile:RELIABILITY_V4_PROFILE});
      await pool.query("INSERT INTO reliability_authorization_decisions(run_id,decision_id,verdict) VALUES($1,$2,$3::jsonb)",[runId,decisionId,JSON.stringify({operatorValid:true,reconciliationValid:true})]);
      await pool.query("INSERT INTO reliability_authorization_outbox(run_id,receipt_kind,receipt,published_at) VALUES($1,'operator',$2::jsonb,clock_timestamp()),($1,'reconciliation',$3::jsonb,clock_timestamp())",
        [runId,JSON.stringify(operatorReceipt),JSON.stringify(reconciliationReceipt)]);
      const accepted=await (store as any).readEvidenceClosureRows(pool,runId);
      expect(accepted.authorizationDecisions).toEqual([expect.objectContaining({decisionId,decisionIdValid:true})]);
    }finally{
      await pool.query("DELETE FROM reliability_authorization_outbox WHERE run_id=$1",[runId]);
      await pool.query("DELETE FROM reliability_authorization_decisions WHERE run_id=$1",[runId]);
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1",[runId]);await pool.end();
    }
  },90_000);

  it("counts only dispatch-owned unresolved reservations when all 100 sealed calls are planned", async () => {
    if (!url) throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 4 });
    const store = new ReliabilityProtocolStore(pool);
    const runId = `test-${randomUUID()}`;
    try {
      await bootstrapProductionSchemas(pool, store);
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
      await bootstrapProductionSchemas(pool, store);
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
    try { await bootstrapProductionSchemas(pool, store); const fingerprint=`sha256:${"c".repeat(64)}`; await store.initializeRun({runId,planFingerprint:fingerprint,lanes:["normal-paced"]});
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
      await bootstrapProductionSchemas(pool, store);
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

  it("removes bounded-burst hold siblings independently and admits queued work in resumed FIFO order", async()=>{
    if(!url)throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:true},max:4});const store=new ReliabilityProtocolStore(pool);
    const runId=`hov3-lifecycle-${randomUUID()}`,fingerprint=`sha256:${"6".repeat(64)}`;
    try{
      await bootstrapProductionSchemas(pool, store);await store.initializeRun({runId,planFingerprint:fingerprint,lanes:["bounded-burst"],profile:RELIABILITY_V3_PROFILE});
      await store.registerSealedCalls({runId,calls:Array.from({length:5},(_,index)=>({requestId:`r${index+1}`,block:index<3?1:2,laneId:"bounded-burst",callOrdinal:index<3?index+1:index-2,
        body:{index},organizationId:"org",agentId:"worker",credentialId:"credential",mandateId:"m",branchId:"b",workloadClass:"bounded-burst",
        provider:"openrouter",model:"nousresearch/hermes-4-405b",maxOutputTokens:8,reservationCostMicros:10n,claimFingerprint:fingerprint}))});
      await pool.query("INSERT INTO reliability_block_claims(run_id,lane_id,block_no,owner_id,opens_at,launch_deadline,claimed_at,plan_fingerprint) VALUES($1,'bounded-burst',2,'owner',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp(),$2)",[runId,fingerprint]);
      await pool.query("INSERT INTO reliability_authorization_decisions(run_id,decision_id,verdict) VALUES($1,$2,$3::jsonb)",[runId,randomUUID(),JSON.stringify({operatorValid:true,reconciliationValid:true})]);
      await pool.query("INSERT INTO reliability_authorization_outbox(run_id,receipt_kind,receipt,published_at) VALUES($1,'operator','{}'::jsonb,clock_timestamp()),($1,'reconciliation','{}'::jsonb,clock_timestamp())",[runId]);
      await pool.query("INSERT INTO reliability_burst_barriers(run_id,lane_id,block_no,state,planned_request_ids,released_at) VALUES($1,'bounded-burst',1,'released',$2::jsonb,clock_timestamp())",[runId,JSON.stringify(["r1","r2","r3"])]);
      await expect(store.enterLaneHold({runId,laneId:"bounded-burst",requestId:"r2"})).resolves.toMatchObject({members:["r1","r2","r3"]});
      await store.enqueueHeldLaneWork({runId,laneId:"bounded-burst",block:2,callOrdinal:1,requestId:"r4",nominalScheduledAt:new Date().toISOString()});
      await store.enqueueHeldLaneWork({runId,laneId:"bounded-burst",block:2,callOrdinal:2,requestId:"r5",nominalScheduledAt:new Date().toISOString()});
      await pool.query("UPDATE reliability_protocol_attempts SET state='reconciled_not_billed',terminal_at=clock_timestamp() WHERE run_id=$1 AND request_id='r2'",[runId]);
      await expect(store.resolveHeldMember({runId,laneId:"bounded-burst",requestId:"r2",allowance:false})).resolves.toMatchObject({remaining:["r1","r3"],resumeAt:null});
      await pool.query("INSERT INTO reliability_dispatch_tokens(run_id,request_id,token_id,lane_id,owner_id,primitive_entered_at) VALUES($1,'r1',$2,'bounded-burst','worker',clock_timestamp())",[runId,randomUUID()]);
      const projection={id:"generation-r1",object:"chat.completion",model:"nousresearch/hermes-4-405b",choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:"ok"}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2},fuse:{decision:{id:"decision-r1",outcome:"ALLOW",wouldOutcome:"ALLOW",enforced:true,reasonCodes:[]},reservationAtomic:"10",actualCostAtomic:"1"}} as const;
      await store.completeReliabilityAttempt({runId,laneId:"bounded-burst",requestId:"r1",response:{id:"generation-r1",content:"ok",usage:{inputTokens:1,outputTokens:1}},responseProjection:projection,actualCostMicros:1n});
      expect((await pool.query("SELECT held_unresolved FROM reliability_protocol_holds WHERE run_id=$1 AND resolved_at IS NULL",[runId])).rows[0]?.held_unresolved).toEqual(["r3"]);
      await pool.query("UPDATE reliability_protocol_attempts SET state='reconciled_not_billed',terminal_at=clock_timestamp() WHERE run_id=$1 AND request_id='r3'",[runId]);
      await expect(store.resolveHeldMember({runId,laneId:"bounded-burst",requestId:"r3",allowance:false})).resolves.toMatchObject({remaining:[],resumeAt:expect.any(String)});
      await pool.query("UPDATE reliability_protocol_lanes SET resume_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",[runId]);
      const resumed=await store.claimDueResumedWork({runId,laneId:"bounded-burst",mode:"sequential"});
      expect(resumed?.requestIds).toEqual(["r4"]);
      await pool.query("UPDATE reliability_lane_backlog SET actual_scheduled_at=clock_timestamp() WHERE run_id=$1 AND request_id='r4'",[runId]);
      const admitted=await store.authorizeHttpReliabilityContext({runId,laneId:"bounded-burst",block:2,requestId:"r4",organizationId:"org",agentId:"worker",credentialId:"credential",mandateId:"m",branchId:"b",workloadClass:"bounded-burst",model:"nousresearch/hermes-4-405b",maxOutputTokens:8,body:{index:3}});
      expect(admitted).toMatchObject({kind:"reliability",callOrdinal:1,requestCommitment:expect.stringMatching(/^sha256:/)});
      await store.recordAttempt({runId,requestId:"r4",laneId:"bounded-burst",block:2,requestCommitment:(admitted as {requestCommitment:string}).requestCommitment,reservedCostMicros:10n});
      await pool.query("UPDATE reliability_protocol_attempts SET state='usable',terminal_at=clock_timestamp() WHERE run_id=$1 AND request_id='r4'",[runId]);
      await expect(store.completeResumedWorkGroup({runId,laneId:"bounded-burst",block:2})).resolves.toMatchObject({nextResumeAt:expect.any(String)});
      const members=await pool.query("SELECT request_id,resolved_at IS NOT NULL resolved FROM reliability_hold_members WHERE run_id=$1 ORDER BY member_sequence",[runId]);
      expect(members.rows).toEqual([{request_id:"r1",resolved:true},{request_id:"r2",resolved:true},{request_id:"r3",resolved:true}]);
    }finally{
      for(const table of ["reliability_dispatch_tokens","reliability_lane_backlog","reliability_protocol_holds","reliability_burst_barriers","reliability_authorization_outbox","reliability_authorization_decisions","reliability_block_claims"])
        await pool.query(`DELETE FROM ${table} WHERE run_id=$1`,[runId]);
      await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1",[runId]);await pool.end();
    }
  },90_000);

  it("requires every terminal v3 scheduler manifest digest in the immutable artifact binding inventory",async()=>{
    if(!url)throw new Error("RUN_NEON_INTEGRATION requires HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED");
    const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:true},max:3});const store=new ReliabilityProtocolStore(pool);
    const runId=`hov3-artifact-${randomUUID()}`,fingerprint=`sha256:${"5".repeat(64)}`,digest=`sha256:${"4".repeat(64)}`;
    const path=`evidence/held-out-reliability-v3/scheduler-manifests/${runId}/r1.json`;
    try{
      await bootstrapProductionSchemas(pool, store);await store.initializeRun({runId,planFingerprint:fingerprint,lanes:["normal-paced"],profile:RELIABILITY_V3_PROFILE});
      await store.registerSealedCalls({runId,calls:[{requestId:"r1",block:1,laneId:"normal-paced",callOrdinal:1,body:{},organizationId:"org",agentId:"worker",credentialId:"credential",mandateId:"m",branchId:"b",workloadClass:"baseline-lookup",provider:"openrouter",model:"nousresearch/hermes-4-405b",maxOutputTokens:8,reservationCostMicros:10n,claimFingerprint:fingerprint}]});
      const claim=await store.acquireSchedulerClaim({runId,requestId:"r1",laneId:"normal-paced",block:1,ownerId:"owner",leaseSeconds:30,manifestPath:path});
      await store.recordSchedulerManifestFsynced({runId,requestId:"r1",laneId:"normal-paced",ownerId:"owner",generation:claim.generation!,manifestDigest:digest,state:"claimed"});
      await pool.query("UPDATE reliability_protocol_attempts SET state='usable',terminal_at=clock_timestamp() WHERE run_id=$1 AND request_id='r1'",[runId]);
      await store.terminalizeSchedulerClaim({runId,requestId:"r1",laneId:"normal-paced",ownerId:"owner",generation:claim.generation!});
      await pool.query("UPDATE reliability_protocol_controls SET durable_stage='replay_terminal' WHERE run_id=$1",[runId]);
      await expect(store.loadEvidenceClosureSnapshot(runId)).rejects.toThrow("ACCEPTED_SETTLEMENT_SNAPSHOT_REQUIRED");
      await expect(store.loadSchedulerManifestBindings(runId)).resolves.toEqual([expect.objectContaining({requestId:"r1",state:"terminal",manifestPath:path,manifestDigest:digest,manifestFsynced:true})]);
      await expect(store.bindArtifactInventory(runId,{"evidence/other.json":`sha256:${"3".repeat(64)}`})).rejects.toThrow("SCHEDULER_MANIFEST_NOT_BOUND:r1");
      await expect(store.bindArtifactInventory(runId,{[path]:digest})).resolves.toBeUndefined();
    }finally{await pool.query("DELETE FROM reliability_scheduler_claims WHERE run_id=$1",[runId]);await pool.query("DELETE FROM reliability_protocol_controls WHERE run_id=$1",[runId]);await pool.end();}
  },90_000);
});
