import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { buildHttpBodyCommitment, buildResponseCommitment, buildSealedRequestCommitment, type StableSuccessfulResponseProjection } from "./commitments.js";
import type { ProviderResult } from "../core/service.js";
import { OpenRouterTransportError } from "../providers/openRouter.js";
import { RELIABILITY_SCHEMA_SQL } from "./reliabilitySchema.js";
import { RECONCILIATION_OFFSETS_SECONDS, heldLaneFifoResolution, reconciliationWindow, setupSnapshotDifferences } from "./operationalV2.js";
import { currentTrustedReplayOperation } from "./replayOperationContext.js";
import { planReconciliationMutation, type ReconciliationEvidence, type ReconciliationMutationPlan } from "./reconciliationStateMachine.js";
import { authoritativeSnapshotDigest, runAuthoritativeSettlement, type AuthoritativeSettlementResult } from "../evidence/authoritativeSettlement.js";
import { AUTHORITATIVE_SNAPSHOT_INVENTORIES, canonicalFinalCommitPath, hardFinalizationTerminalState, planDurableStageTransition, type CanonicalFinalCommitMarker, type DurableReliabilityStage } from "../evidence/finalEvidenceClosure.js";
import type { AuthoritativeEvidenceInventory } from "../evidence/authoritativeEvidence.js";
import { acquireOrdinaryMutationExclusion, acquireReplayExclusion, acquireReplaySessionExclusion, releaseReplaySessionExclusion } from "./protocolMutationExclusion.js";
import {
  exactProviderCostMicros,
  loadAuthoritativeResponseFields,
  reconstructStableResponseFromEvidence,
  settleOrdinaryReconciliationOnClient,
} from "./ordinaryReconciliationSettlement.js";
import { evaluateSettlementSnapshotCompleteness, planHardFinalization, type EvidenceClosureRows, type HardFinalizationPlan } from "../evidence/evidenceSettlementClosure.js";
import { canonicalJson } from "../evidence/heldOutReliabilityV2.js";


type Queryable = { query<R extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<R>> };
type Connectable = Queryable & { connect?: () => Promise<PoolClient> };

export type ReplayTransportFailureDisposition = "retryable" | "ambiguous_consumed";
export function classifyReplayTransportFailure(error:unknown):ReplayTransportFailureDisposition{
  return error instanceof OpenRouterTransportError && error.primitiveEntered===false
    ? "retryable"
    : "ambiguous_consumed";
}

export type SchedulerRecoveryDecision = "already_terminal" | "await_authoritative_outcome"
  | "reconcile_without_redispatch" | "dispatch_original";
export interface SchedulerRecoveryState { terminal: boolean; dispatchToken: boolean; primitiveEntered: boolean }
export function reliabilityAdmissionWindowEligible(input:{laneId:string;callOrdinal:number;nowMs:number;claimedAtMs:number;priorTerminalAtMs:number|null}):boolean{
  const origin=input.laneId==="bounded-burst"||input.callOrdinal===1?input.claimedAtMs:input.priorTerminalAtMs;
  if(origin===null)return false;
  const delay=input.laneId==="bounded-burst"||input.callOrdinal===1?1_000:5_000;
  return input.nowMs>=origin+delay&&input.nowMs<origin+delay+1_000;
}
export function schedulerRecoveryDecision(state: SchedulerRecoveryState): SchedulerRecoveryDecision {
  if (state.terminal) return "already_terminal";
  if (state.primitiveEntered) return "reconcile_without_redispatch";
  if (state.dispatchToken) return "await_authoritative_outcome";
  return "dispatch_original";
}

export type ReliabilityDispatchCapDisposition = "allow" | "known_cost_cap_exceeded" | "unresolved_exposure_cap_exceeded";
export function reliabilityDispatchCapDisposition(input: { knownCostMicros: bigint; unresolvedExposureMicros: bigint }): ReliabilityDispatchCapDisposition {
  if (input.knownCostMicros > 3_000_000n) return "known_cost_cap_exceeded";
  if (input.unresolvedExposureMicros > 320_000n) return "unresolved_exposure_cap_exceeded";
  return "allow";
}

export function preserveAuthorizedOwnerOnGlobalFailure(input: {
  laneId: string;
  tokenCommitted: boolean;
  burstBarrierState: string | null;
}): boolean {
  return input.tokenCommitted && (input.laneId !== "bounded-burst" || input.burstBarrierState === "released");
}

export function deterministicAuthorizationDecisionId(runId: string): string {
  const hex = createHash("sha256").update(`fuse-reliability-v2-authorization:${runId}`).digest("hex").slice(0,32);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;
}

export function buildReplayAuthorizationInventory(input: {
  runId: string; authorizationSha256: string; requestIds: readonly string[];
}): Array<{ ordinal: number; requestId: string; operationId: string }> {
  if (!input.runId.trim() || !/^sha256:[a-f0-9]{64}$/.test(input.authorizationSha256)
    || input.requestIds.length !== 20 || new Set(input.requestIds).size !== 20
    || input.requestIds.some((requestId) => !requestId.trim())) {
    throw new Error("REPLAY_AUTHORIZATION_INVENTORY_INVALID");
  }
  return input.requestIds.map((requestId, index) => {
    const ordinal = index + 1;
    const digest = createHash("sha256").update(
      `fuse-reliability-v2-replay-operation:${input.runId}:${input.authorizationSha256}:${ordinal}:${requestId}`,
    ).digest("hex");
    return { ordinal, requestId, operationId: `replay-${digest}` };
  });
}

export class ReliabilityProtocolStore {
  constructor(private readonly database: Connectable) {}
  async createSchema(): Promise<void> { await this.database.query(RELIABILITY_SCHEMA_SQL); }

  async initializeRun(input: { runId: string; planFingerprint: string; lanes: readonly string[]; reconciliationCredentialId?: string }): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("INSERT INTO reliability_protocol_controls(run_id,state,plan_fingerprint,reconciliation_credential_id) VALUES($1,'active',$2,$3) ON CONFLICT DO NOTHING", [input.runId, input.planFingerprint, input.reconciliationCredentialId ?? null]);
      const control = await client.query<{ plan_fingerprint: string; reconciliation_credential_id: string | null }>("SELECT plan_fingerprint,reconciliation_credential_id FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE", [input.runId]);
      if (control.rows[0]?.plan_fingerprint !== input.planFingerprint
        || (input.reconciliationCredentialId !== undefined && control.rows[0]?.reconciliation_credential_id !== input.reconciliationCredentialId)) throw new Error("PROTOCOL_PLAN_CONFLICT");
      for (const lane of input.lanes) await client.query("INSERT INTO reliability_protocol_lanes(run_id,lane_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [input.runId, lane]);
    });
  }
  async registerReplayAuthorizationInventory(input:{runId:string;authorizationSha256:string;requestIds:string[]}):Promise<void>{
    const inventory=buildReplayAuthorizationInventory(input);
    await this.transaction(async client=>{
      const authority=await client.query<{decision_id:string;operator_published:boolean;reconciliation_published:boolean;durable_stage:string}>(`SELECT decision.decision_id,control.durable_stage,
        EXISTS(SELECT 1 FROM reliability_authorization_outbox outbox WHERE outbox.run_id=decision.run_id AND outbox.receipt_kind='operator' AND outbox.published_at IS NOT NULL) operator_published,
        EXISTS(SELECT 1 FROM reliability_authorization_outbox outbox WHERE outbox.run_id=decision.run_id AND outbox.receipt_kind='reconciliation' AND outbox.published_at IS NOT NULL) reconciliation_published
        FROM reliability_authorization_decisions decision JOIN reliability_protocol_controls control ON control.run_id=decision.run_id
        WHERE decision.run_id=$1 AND decision.verdict->>'operatorValid'='true' AND decision.verdict->>'reconciliationValid'='true'
        FOR UPDATE OF decision,control`,[input.runId]);
      if(!authority.rows[0]?.operator_published||!authority.rows[0]?.reconciliation_published)throw new Error("REPLAY_RUN_AUTHORIZATION_REQUIRED");
      if(authority.rows[0].durable_stage!=="fresh_terminal")throw new Error("REPLAY_STAGE_PREREQUISITE_UNMET");
      const sealed=await client.query<{request_id:string}>("SELECT request_id FROM reliability_sealed_calls WHERE run_id=$1 AND request_id=ANY($2::text[]) FOR UPDATE",[input.runId,input.requestIds]);
      if(sealed.rows.length!==20||new Set(sealed.rows.map(row=>row.request_id)).size!==20)throw new Error("REPLAY_TARGET_INVENTORY_NOT_SEALED");
      for(const item of inventory)await client.query(`INSERT INTO reliability_replay_authorizations(run_id,replay_ordinal,request_id,operation_id,authorization_decision_id,signed_authorization_sha256)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,request_id) DO NOTHING`,[input.runId,item.ordinal,item.requestId,item.operationId,authority.rows[0].decision_id,input.authorizationSha256]);
      const exact=await client.query<{replay_ordinal:number;request_id:string;operation_id:string;authorization_decision_id:string;signed_authorization_sha256:string}>(`SELECT replay_ordinal,request_id,operation_id,authorization_decision_id::text,signed_authorization_sha256
        FROM reliability_replay_authorizations WHERE run_id=$1 ORDER BY replay_ordinal`,[input.runId]);
      if(exact.rows.length!==20||exact.rows.some((row,index)=>row.replay_ordinal!==inventory[index]!.ordinal
        ||row.request_id!==inventory[index]!.requestId||row.operation_id!==inventory[index]!.operationId
        ||row.authorization_decision_id!==authority.rows[0]!.decision_id
        ||row.signed_authorization_sha256!==input.authorizationSha256))throw new Error("REPLAY_AUTHORIZATION_INVENTORY_CONFLICT");
    });
  }

  async registerSealedCalls(input: { runId: string; calls: readonly {
    requestId: string; block: number; laneId: string; callOrdinal: number; body: unknown;
    organizationId: string; agentId: string; credentialId: string; mandateId: string; branchId: string;
    workloadClass: string; provider: string; model: string; maxOutputTokens: number;
    reservationCostMicros: bigint; claimFingerprint: string;
  }[] }): Promise<void> {
    if (input.calls.length === 0 || new Set(input.calls.map((call) => call.requestId)).size !== input.calls.length) {
      throw new Error("SEALED_CALL_REGISTRY_INVALID");
    }
    await this.transaction(async (client) => {
      const control = await client.query<{ state: string; plan_fingerprint: string }>(
        "SELECT state,plan_fingerprint FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE", [input.runId],
      );
      if (!control.rows[0] || control.rows[0].state !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
      for (const call of input.calls) {
        if (call.claimFingerprint !== control.rows[0].plan_fingerprint) throw new Error("PROTOCOL_PLAN_CONFLICT");
        await client.query(`INSERT INTO reliability_sealed_calls
          (run_id,request_id,block_no,lane_id,call_ordinal,body_commitment,organization_id,agent_id,credential_id,mandate_id,branch_id,
           workload_class,provider,model,max_output_tokens,reservation_cost_micros,claim_fingerprint,request_body)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
          ON CONFLICT(run_id,request_id) DO NOTHING`, [
          input.runId, call.requestId, call.block, call.laneId, call.callOrdinal, buildHttpBodyCommitment(call.body),
          call.organizationId, call.agentId, call.credentialId, call.mandateId, call.branchId, call.workloadClass, call.provider, call.model,
          call.maxOutputTokens, call.reservationCostMicros.toString(), call.claimFingerprint, JSON.stringify(call.body),
        ]);
        const exact = await client.query(`SELECT 1 FROM reliability_sealed_calls WHERE run_id=$1 AND request_id=$2
          AND block_no=$3 AND lane_id=$4 AND call_ordinal=$5 AND body_commitment=$6 AND organization_id=$7
          AND agent_id=$8 AND credential_id=$9 AND mandate_id=$10 AND branch_id=$11 AND workload_class=$12 AND provider=$13
          AND model=$14 AND max_output_tokens=$15 AND reservation_cost_micros=$16 AND claim_fingerprint=$17
          AND request_body=$18::jsonb`, [
          input.runId, call.requestId, call.block, call.laneId, call.callOrdinal, buildHttpBodyCommitment(call.body),
          call.organizationId, call.agentId, call.credentialId, call.mandateId, call.branchId, call.workloadClass, call.provider, call.model,
          call.maxOutputTokens, call.reservationCostMicros.toString(), call.claimFingerprint, JSON.stringify(call.body),
        ]);
        if (!exact.rows[0]) throw new Error("SEALED_CALL_CONFLICT");
        const planned = await client.query(`INSERT INTO reliability_protocol_attempts
          (run_id,request_id,lane_id,block_no,state,request_commitment,reserved_cost_micros)
          VALUES($1,$2,$3,$4,'planned',$5,$6) ON CONFLICT(run_id,request_id) DO NOTHING RETURNING 1`,
        [input.runId,call.requestId,call.laneId,call.block,buildHttpBodyCommitment(call.body),call.reservationCostMicros.toString()]);
        if (planned.rows[0]) await this.appendEvent(client,input.runId,call.requestId,"planned",{
          block: call.block, laneId: call.laneId, callOrdinal: call.callOrdinal,
        });
      }
    });
  }

  async readSchedulerRecoveryState(input: { runId: string; requestId: string }): Promise<SchedulerRecoveryState & { decision: SchedulerRecoveryDecision }> {
    const result = await this.database.query<{ terminal: boolean; dispatch_token: boolean; primitive_entered: boolean }>(`SELECT
      attempt.terminal_at IS NOT NULL AS terminal, token.request_id IS NOT NULL AS dispatch_token,
      token.primitive_entered_at IS NOT NULL AS primitive_entered
      FROM reliability_protocol_attempts attempt LEFT JOIN reliability_dispatch_tokens token
        ON token.run_id=attempt.run_id AND token.request_id=attempt.request_id
      WHERE attempt.run_id=$1 AND attempt.request_id=$2`, [input.runId,input.requestId]);
    if (!result.rows[0]) throw new Error("PROTOCOL_ATTEMPT_NOT_FOUND");
    const state = { terminal: result.rows[0].terminal, dispatchToken: result.rows[0].dispatch_token, primitiveEntered: result.rows[0].primitive_entered };
    return { ...state, decision: schedulerRecoveryDecision(state) };
  }

  async acquireSchedulerClaim(input: { runId: string; requestId: string; laneId: string; block: number; ownerId: string; leaseSeconds: number; manifestPath: string }): Promise<{ acquired: boolean; generation: number | null; decision: SchedulerRecoveryDecision }> {
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 300 || !input.manifestPath.trim()) throw new Error("SCHEDULER_CLAIM_INVALID");
    return this.transaction(async (client) => {
      const control = await this.lockControlLane(client,input.runId,input.laneId);
      const recovery = await client.query<{ terminal:boolean;dispatch_token:boolean;primitive_entered:boolean }>(`SELECT
        attempt.terminal_at IS NOT NULL terminal, token.request_id IS NOT NULL dispatch_token,
        token.primitive_entered_at IS NOT NULL primitive_entered
        FROM reliability_protocol_attempts attempt LEFT JOIN reliability_dispatch_tokens token
          ON token.run_id=attempt.run_id AND token.request_id=attempt.request_id
        WHERE attempt.run_id=$1 AND attempt.request_id=$2 AND attempt.lane_id=$3 AND attempt.block_no=$4
        FOR UPDATE OF attempt`,[input.runId,input.requestId,input.laneId,input.block]);
      if(!recovery.rows[0])throw new Error("PROTOCOL_ATTEMPT_NOT_FOUND");
      const state={terminal:recovery.rows[0].terminal,dispatchToken:recovery.rows[0].dispatch_token,primitiveEntered:recovery.rows[0].primitive_entered};
      const decision=schedulerRecoveryDecision(state);
      const existing=await client.query<{owner_id:string;generation:number;state:string;expired:boolean;manifest_path:string}>(`SELECT owner_id,generation,state,manifest_path,
        lease_expires_at <= clock_timestamp() AS expired FROM reliability_scheduler_claims
        WHERE run_id=$1 AND request_id=$2 FOR UPDATE`,[input.runId,input.requestId]);
      if(decision!=="dispatch_original") return {acquired:false,generation:existing.rows[0]?.generation??null,decision};
      if (control !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
      const claim=existing.rows[0];
      if(claim?.state==="terminal") return {acquired:false,generation:claim.generation,decision:"already_terminal"};
      if(claim && !claim.expired && claim.owner_id!==input.ownerId) return {acquired:false,generation:claim.generation,decision};
      if(claim && claim.manifest_path!==input.manifestPath)throw new Error("SCHEDULER_MANIFEST_PATH_CONFLICT");
      const generation=claim ? claim.generation+(claim.owner_id===input.ownerId&&!claim.expired?0:1) : 1;
      await client.query(`INSERT INTO reliability_scheduler_claims
        (run_id,request_id,lane_id,block_no,owner_id,generation,state,lease_expires_at,manifest_path)
        VALUES($1,$2,$3,$4,$5,$6,'claimed',clock_timestamp()+($7*interval '1 second'),$8)
        ON CONFLICT(run_id,request_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,generation=EXCLUDED.generation,
          state='claimed',heartbeat_at=clock_timestamp(),lease_expires_at=EXCLUDED.lease_expires_at`,
      [input.runId,input.requestId,input.laneId,input.block,input.ownerId,generation,input.leaseSeconds,input.manifestPath]);
      return {acquired:true,generation,decision};
    });
  }

  async renewSchedulerClaim(input:{runId:string;requestId:string;laneId:string;ownerId:string;generation:number;leaseSeconds:number}):Promise<void>{
    if(!Number.isInteger(input.leaseSeconds)||input.leaseSeconds<1||input.leaseSeconds>300)throw new Error("SCHEDULER_CLAIM_INVALID");
    await this.transaction(async client=>{const control=await this.lockControlLane(client,input.runId,input.laneId);if(control!=="active")throw new Error("PROTOCOL_CONTROL_FAILED");
      const updated=await client.query(`UPDATE reliability_scheduler_claims SET heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+($6*interval '1 second')
        WHERE run_id=$1 AND request_id=$2 AND lane_id=$3 AND owner_id=$4 AND generation=$5 AND state<>'terminal' AND lease_expires_at>clock_timestamp() RETURNING 1`,
      [input.runId,input.requestId,input.laneId,input.ownerId,input.generation,input.leaseSeconds]);if(!updated.rows[0])throw new Error("SCHEDULER_CLAIM_LOST");});
  }

  async recordSchedulerManifestFsynced(input:{runId:string;requestId:string;laneId:string;ownerId:string;generation:number;manifestDigest:string;state:"claimed"|"admission_started"|"awaiting_outcome"}):Promise<void>{
    if(!/^sha256:[a-f0-9]{64}$/.test(input.manifestDigest))throw new Error("SCHEDULER_MANIFEST_DIGEST_INVALID");
    await this.transaction(async client=>{const control=await this.lockControlLane(client,input.runId,input.laneId);if(control!=="active")throw new Error("PROTOCOL_CONTROL_FAILED");
      const updated=await client.query(`UPDATE reliability_scheduler_claims SET state=$6,manifest_digest=$7,manifest_fsynced_at=clock_timestamp(),heartbeat_at=clock_timestamp()
        WHERE run_id=$1 AND request_id=$2 AND lane_id=$3 AND owner_id=$4 AND generation=$5 AND state<>'terminal'
          AND CASE state WHEN 'claimed' THEN 1 WHEN 'admission_started' THEN 2 WHEN 'awaiting_outcome' THEN 3 ELSE 4 END
            <= CASE $6 WHEN 'claimed' THEN 1 WHEN 'admission_started' THEN 2 WHEN 'awaiting_outcome' THEN 3 ELSE 0 END RETURNING 1`,
      [input.runId,input.requestId,input.laneId,input.ownerId,input.generation,input.state,input.manifestDigest]);if(!updated.rows[0])throw new Error("SCHEDULER_CLAIM_LOST");});
  }

  async terminalizeSchedulerClaim(input:{runId:string;requestId:string;laneId:string;ownerId:string;generation:number}):Promise<void>{
    await this.transaction(async client=>{await this.lockControlLane(client,input.runId,input.laneId);
      const updated=await client.query(`UPDATE reliability_scheduler_claims claim SET state='terminal',terminal_at=attempt.terminal_at,
        heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp() FROM reliability_protocol_attempts attempt
        WHERE claim.run_id=$1 AND claim.request_id=$2 AND claim.lane_id=$3 AND claim.owner_id=$4 AND claim.generation=$5
          AND attempt.run_id=claim.run_id AND attempt.request_id=claim.request_id AND attempt.terminal_at IS NOT NULL
          AND claim.state<>'terminal' RETURNING 1`,[input.runId,input.requestId,input.laneId,input.ownerId,input.generation]);
      if(!updated.rows[0]){const exact=await client.query("SELECT 1 FROM reliability_scheduler_claims WHERE run_id=$1 AND request_id=$2 AND lane_id=$3 AND owner_id=$4 AND generation=$5 AND state='terminal'",[input.runId,input.requestId,input.laneId,input.ownerId,input.generation]);if(!exact.rows[0])throw new Error("SCHEDULER_TERMINAL_CONFLICT");}});
  }

  async authorizeHttpReliabilityContext(input: {
    runId: string | null; laneId: string | null; block: number | null; requestId: string;
    organizationId: string; agentId: string; credentialId: string; mandateId: string; branchId: string | null;
    workloadClass: string | null; model: string; maxOutputTokens: number; body: unknown;
  }): Promise<{ kind: "ordinary" } | { kind: "reliability"; callOrdinal: number } | null> {
    const binding = await this.database.query<{ protocol_bound: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM reliability_sealed_calls sealed WHERE sealed.organization_id=$1
        AND (sealed.credential_id=$2 OR sealed.mandate_id=$3
          OR ($4::text IS NOT NULL AND sealed.branch_id=$4))) protocol_bound`,
    [input.organizationId,input.credentialId,input.mandateId,input.branchId]);
    if (!binding.rows[0]?.protocol_bound) return { kind: "ordinary" };
    if (!input.runId || !input.laneId || input.block === null || !input.branchId || !input.workloadClass) return null;
    const row = await this.database.query<{ call_ordinal: number }>(`SELECT sealed.call_ordinal FROM reliability_sealed_calls sealed
      JOIN reliability_protocol_controls control ON control.run_id=sealed.run_id
      JOIN reliability_protocol_lanes lane ON lane.run_id=sealed.run_id AND lane.lane_id=sealed.lane_id
      JOIN reliability_block_claims claim ON claim.run_id=sealed.run_id AND claim.block_no=sealed.block_no
      JOIN reliability_authorization_decisions decision ON decision.run_id=sealed.run_id
      WHERE sealed.run_id=$1 AND sealed.request_id=$2 AND sealed.lane_id=$3 AND sealed.block_no=$4
        AND sealed.organization_id=$5 AND sealed.agent_id=$6 AND sealed.credential_id=$7 AND sealed.mandate_id=$8 AND sealed.branch_id=$9
        AND sealed.workload_class=$10 AND sealed.model=$11 AND sealed.max_output_tokens=$12
        AND sealed.provider='openrouter' AND sealed.body_commitment=$13
        AND sealed.claim_fingerprint=control.plan_fingerprint AND claim.plan_fingerprint=control.plan_fingerprint
        AND control.state='active' AND lane.state='ready' AND claim.state='claimed'
        AND claim.claimed_at >= claim.opens_at AND claim.claimed_at < claim.launch_deadline
        AND (
          ((sealed.lane_id='bounded-burst' OR sealed.call_ordinal=1)
            AND clock_timestamp() >= claim.claimed_at + interval '1 second'
            AND clock_timestamp() < claim.claimed_at + interval '2 seconds')
          OR
          (sealed.lane_id<>'bounded-burst' AND sealed.call_ordinal>1 AND EXISTS (
            SELECT 1 FROM reliability_sealed_calls immediate_prior
            JOIN reliability_protocol_attempts prior_attempt
              ON prior_attempt.run_id=immediate_prior.run_id AND prior_attempt.request_id=immediate_prior.request_id
            WHERE immediate_prior.run_id=sealed.run_id AND immediate_prior.lane_id=sealed.lane_id
              AND immediate_prior.block_no=sealed.block_no AND immediate_prior.call_ordinal=sealed.call_ordinal-1
              AND prior_attempt.terminal_at IS NOT NULL
              AND clock_timestamp() >= prior_attempt.terminal_at + interval '5 seconds'
              AND clock_timestamp() < prior_attempt.terminal_at + interval '6 seconds'
          ))
        )
        AND decision.verdict->>'operatorValid'='true' AND decision.verdict->>'reconciliationValid'='true'
        AND (SELECT count(*) FROM reliability_authorization_outbox outbox
             WHERE outbox.run_id=sealed.run_id AND outbox.published_at IS NOT NULL)=2
        AND (sealed.lane_id='bounded-burst' OR NOT EXISTS (
          SELECT 1 FROM reliability_sealed_calls prior
          JOIN reliability_protocol_attempts attempt ON attempt.run_id=prior.run_id AND attempt.request_id=prior.request_id
          WHERE prior.run_id=sealed.run_id AND prior.lane_id=sealed.lane_id
            AND (prior.block_no < sealed.block_no OR (prior.block_no=sealed.block_no AND prior.call_ordinal < sealed.call_ordinal))
            AND attempt.state NOT IN ('not_dispatched','completed_verified','terminal_rejected_not_billed',
              'reconciled_not_billed','reconciled_billed_with_response','reconciled_billed_no_response','unresolved_provider_outcome')
        ))`, [input.runId,input.requestId,input.laneId,input.block,input.organizationId,input.agentId,input.credentialId,input.mandateId,
          input.branchId,input.workloadClass,input.model,input.maxOutputTokens,buildHttpBodyCommitment(input.body)]);
    return row.rows[0] ? { kind: "reliability", callOrdinal: row.rows[0].call_ordinal } : null;
  }
  async readSealedReservation(input:{runId:string;requestId:string;laneId:string;block:number}):Promise<bigint>{
    const row=await this.database.query<{reservation_cost_micros:string}>("SELECT reservation_cost_micros::text FROM reliability_sealed_calls WHERE run_id=$1 AND request_id=$2 AND lane_id=$3 AND block_no=$4",[input.runId,input.requestId,input.laneId,input.block]);
    if(!row.rows[0])throw new Error("SEALED_CALL_REQUIRED");return BigInt(row.rows[0].reservation_cost_micros);
  }
  async recordAttemptOnClient(client:Queryable,input:{runId:string;requestId:string;laneId:string;block:number;requestCommitment:string;reservedCostMicros:bigint}):Promise<void>{
    const state=await this.lockControlLane(client,input.runId,input.laneId);if(state!=="active")throw new Error("PROTOCOL_CONTROL_FAILED");
    const updated=await client.query(`UPDATE reliability_protocol_attempts attempt SET state='admission_started',request_commitment=$5,reserved_cost_micros=$6,admission_started_at=COALESCE(admission_started_at,clock_timestamp())
      FROM reliability_sealed_calls sealed WHERE attempt.run_id=$1 AND attempt.request_id=$2 AND attempt.lane_id=$3 AND attempt.block_no=$4
        AND sealed.run_id=attempt.run_id AND sealed.request_id=attempt.request_id AND sealed.reservation_cost_micros=$6
        AND attempt.state IN ('planned','admission_started') RETURNING attempt.state`,[input.runId,input.requestId,input.laneId,input.block,input.requestCommitment,input.reservedCostMicros.toString()]);
    if(!updated.rows[0])throw new Error("SEALED_CALL_REQUIRED");
    const exists=await client.query("SELECT 1 FROM reliability_protocol_events WHERE run_id=$1 AND request_id=$2 AND event_type='admission_started'",[input.runId,input.requestId]);
    if(!exists.rows[0])await this.appendEvent(client,input.runId,input.requestId,"admission_started",{block:input.block});
  }
  async recordAttempt(input: { runId: string; requestId: string; laneId: string; block: number; requestCommitment: string; reservedCostMicros: bigint }): Promise<void> {
    await this.transaction(async (client) => this.recordAttemptOnClient(client,input));
  }
  /* legacy body removed */
  async authorizeReliabilityDispatch(input: { runId: string; requestId: string; laneId: string; block: number; ownerId: string }): Promise<{ tokenId: string }> {
    const result = await this.transaction(async (client) => {
      const state = await this.lockControlLane(client, input.runId, input.laneId);
      if (state !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
      const existing = await client.query<{ token_id: string }>("SELECT token_id::text FROM reliability_dispatch_tokens WHERE run_id=$1 AND request_id=$2", [input.runId, input.requestId]);
      if (existing.rows[0]) return { tokenId: existing.rows[0].token_id };
      const exposure = await client.query<{ known_cost_micros: string; unresolved_exposure_micros: string }>(`SELECT
        COALESCE(SUM(CASE WHEN attempt.terminal_at IS NOT NULL AND attempt.state <> 'unresolved_provider_outcome' THEN COALESCE(attempt.actual_cost_micros,0) ELSE 0 END),0)::text known_cost_micros,
        COALESCE(SUM(CASE WHEN (attempt.request_id=$2 OR (token.request_id IS NOT NULL AND token.canceled_at IS NULL))
          AND (attempt.terminal_at IS NULL OR attempt.state='unresolved_provider_outcome')
          THEN attempt.reserved_cost_micros ELSE 0 END),0)::text unresolved_exposure_micros
        FROM reliability_protocol_attempts attempt
        LEFT JOIN reliability_dispatch_tokens token ON token.run_id=attempt.run_id AND token.request_id=attempt.request_id
        WHERE attempt.run_id=$1`,[input.runId,input.requestId]);
      const cap = reliabilityDispatchCapDisposition({
        knownCostMicros: BigInt(exposure.rows[0]?.known_cost_micros ?? "0"),
        unresolvedExposureMicros: BigInt(exposure.rows[0]?.unresolved_exposure_micros ?? "0"),
      });
      if (cap !== "allow") {
        await this.failProtocolLocked(client,input.runId,cap === "known_cost_cap_exceeded" ? "KNOWN_COST_CAP_EXCEEDED" : "UNRESOLVED_EXPOSURE_CAP_EXCEEDED");
        return { capFailure: cap } as const;
      }
      const count = await client.query<{ dispatch_token_count: number }>("UPDATE reliability_protocol_controls SET dispatch_token_count=dispatch_token_count+1 WHERE run_id=$1 AND dispatch_token_count < 100 RETURNING dispatch_token_count", [input.runId]);
      if (!count.rows[0]) throw new Error("DISPATCH_TOKEN_FENCE_EXCEEDED");
      const attempt = await client.query(`SELECT 1 FROM reliability_protocol_attempts attempt
        JOIN reliability_sealed_calls sealed ON sealed.run_id=attempt.run_id AND sealed.request_id=attempt.request_id
        WHERE attempt.run_id=$1 AND attempt.request_id=$2 AND attempt.lane_id=$3 AND attempt.block_no=$4
          AND attempt.state='admission_started' AND sealed.agent_id=$5 FOR UPDATE OF attempt`,
      [input.runId, input.requestId, input.laneId, input.block, input.ownerId]);
      if (!attempt.rows[0]) throw new Error("PROTOCOL_ATTEMPT_REQUIRED");
      const tokenId = randomUUID();
      await client.query("INSERT INTO reliability_dispatch_tokens(run_id,request_id,token_id,lane_id,owner_id) VALUES($1,$2,$3,$4,$5)", [input.runId, input.requestId, tokenId, input.laneId, input.ownerId]);
      await client.query("UPDATE reliability_protocol_attempts SET state='dispatch_authorized' WHERE run_id=$1 AND request_id=$2",[input.runId,input.requestId]);
      await this.appendEvent(client, input.runId, input.requestId, "dispatch_authorized", { tokenId, block: input.block });
      return { tokenId };
    });
    if ("capFailure" in result) throw new Error(result.capFailure === "known_cost_cap_exceeded" ? "KNOWN_COST_CAP_EXCEEDED" : "UNRESOLVED_EXPOSURE_CAP_EXCEEDED");
    return result;
  }
  async awaitReliabilityDispatchRelease(input: { runId: string; requestId: string; laneId: string; block: number; tokenId: string }): Promise<void> {
    if (input.laneId !== "bounded-burst") return;
    const deadline = Date.now() + 75_000;
    for (;;) {
      const row = await this.database.query<{ state: string; canceled_at: Date | null }>(`SELECT barrier.state,token.canceled_at
        FROM reliability_dispatch_tokens token JOIN reliability_burst_barriers barrier
          ON barrier.run_id=token.run_id AND barrier.lane_id=token.lane_id AND barrier.block_no=$4
        WHERE token.run_id=$1 AND token.request_id=$2 AND token.token_id=$3`,
      [input.runId,input.requestId,input.tokenId,input.block]);
      if (!row.rows[0] || row.rows[0].canceled_at || row.rows[0].state === "canceled") throw new Error("BURST_BARRIER_CANCELED");
      if (row.rows[0].state === "released") return;
      if (Date.now() >= deadline) throw new Error("BURST_BARRIER_RELEASE_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async markReliabilityDispatchPrimitiveEntered(input: { runId: string; requestId: string; tokenId: string }): Promise<void> {
    await this.transaction(async (client) => {
      const token = await client.query<{ lane_id: string }>("SELECT lane_id FROM reliability_dispatch_tokens WHERE run_id=$1 AND request_id=$2 AND token_id=$3", [input.runId, input.requestId, input.tokenId]);
      if (!token.rows[0]) throw new Error("DISPATCH_TOKEN_NOT_OWNED");
      await this.lockControlLane(client, input.runId, token.rows[0].lane_id);
      const updated = await client.query(`UPDATE reliability_dispatch_tokens token
        SET primitive_entered_at=clock_timestamp()
        WHERE token.run_id=$1 AND token.request_id=$2 AND token.token_id=$3
          AND token.canceled_at IS NULL AND token.primitive_entered_at IS NULL
          AND (token.lane_id <> 'bounded-burst' OR EXISTS (
            SELECT 1 FROM reliability_protocol_attempts attempt
            JOIN reliability_burst_barriers barrier ON barrier.run_id=attempt.run_id
              AND barrier.lane_id=attempt.lane_id AND barrier.block_no=attempt.block_no
            WHERE attempt.run_id=token.run_id AND attempt.request_id=token.request_id AND barrier.state='released'))
        RETURNING 1`, [input.runId, input.requestId, input.tokenId]);
      if (!updated.rows[0]) {
        const existing = await client.query("SELECT 1 FROM reliability_dispatch_tokens WHERE run_id=$1 AND request_id=$2 AND token_id=$3 AND primitive_entered_at IS NOT NULL AND canceled_at IS NULL",[input.runId,input.requestId,input.tokenId]);
        if (existing.rows[0]) return;
        throw new Error(token.rows[0].lane_id === "bounded-burst" ? "BURST_DISPATCH_NOT_RELEASED" : "DISPATCH_TOKEN_NOT_OWNED");
      }
      await client.query("UPDATE reliability_protocol_attempts SET state='primitive_entered' WHERE run_id=$1 AND request_id=$2",[input.runId,input.requestId]);
      await this.appendEvent(client, input.runId, input.requestId, "dispatch_primitive_entered", { tokenId: input.tokenId });
    });
  }

  async completeReliabilityAttempt(input: { runId: string; laneId: string; requestId: string; response: ProviderResult; responseProjection: StableSuccessfulResponseProjection; actualCostMicros: bigint }): Promise<void> {
    await this.transaction(async (client) => this.completeReliabilityAttemptOnClient(client,input));
  }

  async completeReliabilityAttemptOnClient(client: Queryable,input: { runId: string; laneId: string; requestId: string; response: ProviderResult; responseProjection: StableSuccessfulResponseProjection; actualCostMicros: bigint }): Promise<void> {
      await acquireOrdinaryMutationExclusion(client);
      const state = await this.lockControlLane(client,input.runId,input.laneId);
      if (state !== "active" && state !== "failed") throw new Error("PROTOCOL_CONTROL_FAILED");
      const responseCommitment = buildResponseCommitment(input.responseProjection);
      const updated = await client.query(`UPDATE reliability_protocol_attempts attempt SET state='completed_verified',
          response_commitment=$4,provider_generation_id=$5,actual_cost_micros=$6,
          gate_classified_at=clock_timestamp(),terminal_at=clock_timestamp()
        FROM reliability_dispatch_tokens token WHERE attempt.run_id=$1 AND attempt.request_id=$2 AND attempt.lane_id=$3
          AND token.run_id=attempt.run_id AND token.request_id=attempt.request_id
          AND token.primitive_entered_at IS NOT NULL AND attempt.gate_classified_at IS NULL RETURNING 1`,
      [input.runId,input.requestId,input.laneId,responseCommitment,input.response.id,input.actualCostMicros.toString()]);
      if (!updated.rows[0]) {
        const exact = await client.query("SELECT 1 FROM reliability_protocol_attempts WHERE run_id=$1 AND request_id=$2 AND state='completed_verified' AND response_commitment=$3 AND provider_generation_id=$4 AND actual_cost_micros=$5",[input.runId,input.requestId,responseCommitment,input.response.id,input.actualCostMicros.toString()]);
        if (exact.rows[0]) return;
        throw new Error("RELIABILITY_TERMINAL_CONFLICT");
      }
      await client.query("UPDATE reliability_protocol_controls SET gate_classification_count=gate_classification_count+1,usable_count=usable_count+1 WHERE run_id=$1",[input.runId]);
      await this.appendEvent(client,input.runId,input.requestId,"provider_response_persisted",{ generationId: input.response.id, actualCostMicros: input.actualCostMicros.toString(), responseCommitment });
      await this.appendEvent(client,input.runId,input.requestId,"gate_classified",{ state: "completed_verified" });
  }

  async holdReliabilityAttempt(input: { runId: string; laneId: string; requestId: string; reasonCode: string; generationId?: string; response?: ProviderResult }): Promise<void> {
    await this.transaction(async (client) => {
      const state = await this.lockControlLane(client,input.runId,input.laneId);
      if (state !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
      const updated = await client.query(`UPDATE reliability_protocol_attempts SET state='reconciliation_pending',
          ambiguity_entered_at=COALESCE(ambiguity_entered_at,clock_timestamp()),provider_generation_id=COALESCE(provider_generation_id,$4)
        WHERE run_id=$1 AND request_id=$2 AND lane_id=$3 AND gate_classified_at IS NULL
          AND state <> 'reconciliation_pending' RETURNING 1`,[input.runId,input.requestId,input.laneId,input.generationId ?? input.response?.id ?? null]);
      if (updated.rows[0]) {
        await client.query("UPDATE reliability_protocol_controls SET ambiguity_count=ambiguity_count+1 WHERE run_id=$1",[input.runId]);
        await this.appendEvent(client,input.runId,input.requestId,"ambiguity_entered",{ reasonCode: input.reasonCode, generationId: input.generationId ?? input.response?.id ?? null });
      }
      await this.enterLaneHoldLocked(client,input);
    });
  }

  async classifyReliabilityNotDispatched(input: { runId: string; laneId: string; requestId: string; reasonCode: string }): Promise<void> {
    await this.transaction(async (client) => this.classifyReliabilityNotDispatchedOnClient(client, input));
  }

  async classifyReliabilityNotDispatchedOnClient(client: Queryable, input: { runId: string; laneId: string; requestId: string; reasonCode: string }): Promise<void> {
      await this.lockControlLane(client,input.runId,input.laneId);
      const updated = await client.query(`UPDATE reliability_protocol_attempts SET state='not_dispatched',actual_cost_micros=0,
          gate_classified_at=clock_timestamp(),terminal_at=clock_timestamp()
        WHERE run_id=$1 AND request_id=$2 AND lane_id=$3 AND gate_classified_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM reliability_dispatch_tokens token WHERE token.run_id=$1 AND token.request_id=$2 AND token.primitive_entered_at IS NOT NULL)
        RETURNING 1`,[input.runId,input.requestId,input.laneId]);
      if (!updated.rows[0]) throw new Error("RELIABILITY_TERMINAL_CONFLICT");
      await client.query("UPDATE reliability_protocol_controls SET gate_classification_count=gate_classification_count+1 WHERE run_id=$1",[input.runId]);
      await this.appendEvent(client,input.runId,input.requestId,"gate_classified",{ state: "not_dispatched", reasonCode: input.reasonCode });
      await this.failProtocolLocked(client,input.runId,`NOT_DISPATCHED:${input.reasonCode}`);
  }
  async failProtocol(runId: string, reason: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.failProtocolLocked(client,runId,reason);
    });
  }

  async claimBlock(input: { runId: string; block: number; ownerId: string; opensAt: string; launchDeadline: string; planFingerprint?: string }): Promise<{ claimedAt: string }> {
    return this.transaction(async (client) => {
      const control = await client.query<{ state: string; plan_fingerprint: string }>("SELECT state,plan_fingerprint FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE", [input.runId]);
      const state = control.rows[0]?.state;
      if (!state) throw new Error("PROTOCOL_CONTROL_NOT_FOUND");
      if (state !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
      if (input.planFingerprint && control.rows[0]!.plan_fingerprint !== input.planFingerprint) throw new Error("PROTOCOL_PLAN_CONFLICT");
      const authorization = await client.query(`SELECT 1 FROM reliability_authorization_decisions decision
        WHERE decision.run_id=$1 AND decision.verdict->>'operatorValid'='true'
          AND decision.verdict->>'reconciliationValid'='true'
          AND (SELECT count(*) FROM reliability_authorization_outbox outbox
               WHERE outbox.run_id=decision.run_id AND outbox.published_at IS NOT NULL)=2`,[input.runId]);
      if (!authorization.rows[0]) throw new Error("AUTHORIZATION_RECEIPTS_NOT_PUBLISHED");
      const sealed = await client.query<{ count: string }>("SELECT count(*)::text count FROM reliability_sealed_calls WHERE run_id=$1 AND claim_fingerprint=$2",[input.runId,control.rows[0]!.plan_fingerprint]);
      if (Number(sealed.rows[0]?.count ?? 0) === 0) throw new Error("SEALED_CALL_REGISTRY_REQUIRED");
      const existing = await client.query<{ owner_id: string; claimed_at: Date; opens_at: Date; launch_deadline: Date; plan_fingerprint: string }>(`SELECT owner_id,claimed_at,opens_at,launch_deadline,plan_fingerprint
        FROM reliability_block_claims WHERE run_id=$1 AND block_no=$2 FOR UPDATE`,[input.runId,input.block]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.owner_id !== input.ownerId) throw new Error("BLOCK_ALREADY_CLAIMED");
        if (row.plan_fingerprint !== control.rows[0]!.plan_fingerprint
          || row.opens_at.toISOString() !== new Date(input.opensAt).toISOString()
          || row.launch_deadline.toISOString() !== new Date(input.launchDeadline).toISOString()) throw new Error("BLOCK_CLAIM_CONFLICT");
        return { claimedAt: row.claimed_at.toISOString() };
      }
      const now = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const claimedAt = now.rows[0]!.now;
      if (claimedAt < new Date(input.opensAt) || claimedAt >= new Date(input.launchDeadline)) throw new Error("BLOCK_ADMISSION_WINDOW_MISSED");
      const row = await client.query<{ owner_id: string; claimed_at: Date }>(`INSERT INTO reliability_block_claims
        (run_id,lane_id,block_no,owner_id,opens_at,launch_deadline,claimed_at,plan_fingerprint) VALUES($1,'normal-paced',$2,$3,$4,$5,$6,$7)
        RETURNING owner_id,claimed_at`, [input.runId,input.block,input.ownerId,input.opensAt,input.launchDeadline,claimedAt,control.rows[0]!.plan_fingerprint]);
      await this.appendEvent(client, input.runId, null, "block_claimed", { block: input.block, ownerId: input.ownerId });
      return { claimedAt: row.rows[0]!.claimed_at.toISOString() };
    });
  }

  async commitAuthorization(input: { runId: string; decisionId: string; verdict: unknown; active: boolean; operatorIssuerId: string; operatorNonce: string | null; operatorReceipt: unknown; reconciliationReceipt: unknown }): Promise<void> {
    if (input.decisionId !== deterministicAuthorizationDecisionId(input.runId)) throw new Error("AUTHORIZATION_DECISION_ID_INVALID");
    const verdict = input.verdict as Record<string, unknown>;
    const operatorReceipt = input.operatorReceipt as Record<string, unknown>;
    const reconciliationReceipt = input.reconciliationReceipt as Record<string, unknown>;
    if (input.active && (verdict?.operatorValid !== true || verdict?.reconciliationValid !== true
      || operatorReceipt?.kind !== "operator" || operatorReceipt?.status !== "consumed"
      || reconciliationReceipt?.kind !== "reconciliation" || reconciliationReceipt?.status !== "validated")) {
      throw new Error("AUTHORIZATION_VALID_PAIR_REQUIRED");
    }
    await this.transaction(async (client) => {
      const control = await client.query<{ state: string }>("SELECT state FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE", [input.runId]);
      if (!control.rows[0]) throw new Error("PROTOCOL_CONTROL_NOT_FOUND");
      const existing = await client.query<{ decision_id: string; verdict: unknown }>("SELECT decision_id::text,verdict FROM reliability_authorization_decisions WHERE run_id=$1", [input.runId]);
      if (existing.rows[0]) {
        if (existing.rows[0].decision_id !== input.decisionId || JSON.stringify(existing.rows[0].verdict) !== JSON.stringify(input.verdict)) throw new Error("AUTHORIZATION_DECISION_CONFLICT");
        return;
      }
      if (input.active) {
        if (!input.operatorNonce) throw new Error("AUTHORIZATION_NONCE_REQUIRED");
        await client.query("INSERT INTO reliability_authorization_nonces(issuer_id,nonce,run_id) VALUES($1,$2,$3)", [input.operatorIssuerId,input.operatorNonce,input.runId]);
      }
      await client.query("INSERT INTO reliability_authorization_decisions(run_id,decision_id,verdict,operator_nonce) VALUES($1,$2,$3::jsonb,$4)", [input.runId,input.decisionId,JSON.stringify(input.verdict),input.operatorNonce]);
      await client.query(`INSERT INTO reliability_authorization_outbox(run_id,receipt_kind,receipt) VALUES
        ($1,'operator',$2::jsonb),($1,'reconciliation',$3::jsonb)`, [input.runId,JSON.stringify(input.operatorReceipt),JSON.stringify(input.reconciliationReceipt)]);
      if (!input.active) await client.query("UPDATE reliability_protocol_controls SET state='failed',failed_at=clock_timestamp() WHERE run_id=$1", [input.runId]);
    });
  }

  async publishAuthorizationOutbox(runId: string, publish: (kind: string, receipt: unknown) => Promise<void>): Promise<void> {
    const rows = await this.database.query<{ receipt_kind: string; receipt: unknown }>("SELECT receipt_kind,receipt FROM reliability_authorization_outbox WHERE run_id=$1 AND published_at IS NULL ORDER BY receipt_kind", [runId]);
    for (const row of rows.rows) {
      await publish(row.receipt_kind, row.receipt);
      await this.transaction(async (client) => {
        await client.query("UPDATE reliability_authorization_outbox SET published_at=COALESCE(published_at,clock_timestamp()) WHERE run_id=$1 AND receipt_kind=$2", [runId,row.receipt_kind]);
      });
    }
  }

  async createBurstBarrier(input: { runId: string; laneId: string; block: number; requestIds: readonly string[] }): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockControlLane(client,input.runId,input.laneId);
      await client.query("INSERT INTO reliability_burst_barriers(run_id,lane_id,block_no,state,planned_request_ids) VALUES($1,$2,$3,'preparing',$4::jsonb)", [input.runId,input.laneId,input.block,JSON.stringify([...input.requestIds])]);
    });
  }

  async releaseBurstBarrier(input: { runId: string; laneId: string; block: number }): Promise<void> {
    await this.transaction(async (client) => {
      const state = await this.lockControlLane(client,input.runId,input.laneId); if (state !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
      const barrier = await client.query<{ planned_request_ids: string[] }>("SELECT planned_request_ids FROM reliability_burst_barriers WHERE run_id=$1 AND lane_id=$2 AND block_no=$3 FOR UPDATE", [input.runId,input.laneId,input.block]);
      if (!barrier.rows[0]) throw new Error("BURST_BARRIER_NOT_FOUND");
      const count = await client.query<{ count: string }>("SELECT count(*)::text count FROM reliability_dispatch_tokens WHERE run_id=$1 AND request_id=ANY($2::text[])", [input.runId,barrier.rows[0].planned_request_ids]);
      if (Number(count.rows[0]!.count) !== barrier.rows[0].planned_request_ids.length) throw new Error("BURST_BARRIER_NOT_READY");
      await client.query("UPDATE reliability_burst_barriers SET state='released',released_at=clock_timestamp() WHERE run_id=$1 AND lane_id=$2 AND block_no=$3", [input.runId,input.laneId,input.block]);
      for (const id of barrier.rows[0].planned_request_ids) await this.appendEvent(client,input.runId,id,"barrier_released",{});
    });
  }

  async enterLaneHold(input: { runId: string; laneId: string; requestId: string }): Promise<{ holdId: string; members: string[] }> {
    return this.transaction(async (client) => {
      const state = await this.lockControlLane(client,input.runId,input.laneId); if (state !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
      return this.enterLaneHoldLocked(client,input);
    });
  }

  private async enterLaneHoldLocked(client: Queryable,input:{runId:string;laneId:string;requestId:string}):Promise<{holdId:string;members:string[]}>{
    const active=await client.query("SELECT 1 FROM reliability_protocol_attempts WHERE run_id=$1 AND lane_id=$2 AND request_id=$3 AND terminal_at IS NULL FOR UPDATE",[input.runId,input.laneId,input.requestId]);
    if(!active.rows[0])throw new Error("HOLD_MEMBER_NOT_ACTIVE");
    const open = await client.query<{ hold_id: string; held_unresolved: string[] }>("SELECT hold_id::text,held_unresolved FROM reliability_protocol_holds WHERE run_id=$1 AND lane_id=$2 AND resolved_at IS NULL FOR UPDATE", [input.runId,input.laneId]);
    if(open.rows[0]){
      if(open.rows[0].held_unresolved.includes(input.requestId))return {holdId:open.rows[0].hold_id,members:open.rows[0].held_unresolved};
      const members=[...open.rows[0].held_unresolved,input.requestId];
      await client.query("UPDATE reliability_protocol_holds SET held_unresolved=$4::jsonb WHERE run_id=$1 AND lane_id=$2 AND hold_id=$3",[input.runId,input.laneId,open.rows[0].hold_id,JSON.stringify(members)]);
      await client.query("INSERT INTO reliability_hold_members(run_id,lane_id,hold_id,request_id,member_sequence) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[input.runId,input.laneId,open.rows[0].hold_id,input.requestId,members.length]);
      return {holdId:open.rows[0].hold_id,members};
    }
    const holdId=randomUUID();
    const barrier=await client.query<{planned_request_ids:string[]}>(`SELECT planned_request_ids FROM reliability_burst_barriers
      WHERE run_id=$1 AND lane_id=$2 AND state='released' AND planned_request_ids ? $3
      ORDER BY block_no DESC LIMIT 1 FOR UPDATE`,[input.runId,input.laneId,input.requestId]);
    let members=[input.requestId];
    if(barrier.rows[0]){
      const planned=barrier.rows[0].planned_request_ids;
      const nonterminal=await client.query<{request_id:string}>(`SELECT request_id FROM reliability_protocol_attempts
        WHERE run_id=$1 AND lane_id=$2 AND request_id=ANY($3::text[]) AND terminal_at IS NULL FOR UPDATE`,[input.runId,input.laneId,planned]);
      const activeIds=new Set(nonterminal.rows.map(row=>row.request_id));
      members=planned.filter(requestId=>activeIds.has(requestId));
      if(!members.includes(input.requestId))throw new Error("HOLD_MEMBER_NOT_ACTIVE");
    }
    await client.query("INSERT INTO reliability_protocol_holds(run_id,lane_id,hold_id,held_unresolved) VALUES($1,$2,$3,$4::jsonb)", [input.runId,input.laneId,holdId,JSON.stringify(members)]);
    for(const [index,requestId] of members.entries())await client.query("INSERT INTO reliability_hold_members(run_id,lane_id,hold_id,request_id,member_sequence) VALUES($1,$2,$3,$4,$5)",[input.runId,input.laneId,holdId,requestId,index+1]);
    await client.query("UPDATE reliability_protocol_lanes SET state='held',resume_at=NULL WHERE run_id=$1 AND lane_id=$2", [input.runId,input.laneId]);
    return { holdId,members };
  }

  async resolveHeldMember(input: { runId: string; laneId: string; requestId: string; allowance: boolean }): Promise<{ remaining: string[]; resumeAt: string | null }> {
    const result = await this.transaction(async (client) => {
      let state=await this.lockControlLane(client,input.runId,input.laneId);
      const hold=await client.query<{ hold_id:string; held_unresolved:string[] }>("SELECT hold_id::text,held_unresolved FROM reliability_protocol_holds WHERE run_id=$1 AND lane_id=$2 AND resolved_at IS NULL FOR UPDATE",[input.runId,input.laneId]);
      if(!hold.rows[0] || !hold.rows[0].held_unresolved.includes(input.requestId)) throw new Error("HELD_MEMBER_NOT_FOUND");
      const measured=await client.query<{now:Date}>("SELECT clock_timestamp() now");
      const fifo=heldLaneFifoResolution({members:hold.rows[0].held_unresolved,requestId:input.requestId,transitionCommittedAtMs:measured.rows[0]!.now.getTime()});
      const remaining=fifo.remaining;
      let globalFailed=false;
      if(input.allowance){
        const control=await client.query<{nonusable_allowance_owner:string|null}>("SELECT nonusable_allowance_owner FROM reliability_protocol_controls WHERE run_id=$1",[input.runId]);
        if(control.rows[0]?.nonusable_allowance_owner && control.rows[0].nonusable_allowance_owner!==input.requestId) {
          await this.failProtocolLocked(client,input.runId,"SECOND_ALLOWANCE_GLOBAL_FAILURE");
          state="failed"; globalFailed=true;
        } else {
          await client.query("UPDATE reliability_protocol_controls SET nonusable_allowance_owner=$2 WHERE run_id=$1",[input.runId,input.requestId]);
        }
      }
      await client.query("UPDATE reliability_hold_members SET resolved_at=COALESCE(resolved_at,clock_timestamp()) WHERE run_id=$1 AND lane_id=$2 AND hold_id=$3 AND request_id=$4",[input.runId,input.laneId,hold.rows[0].hold_id,input.requestId]);
      let resumeAt:string|null=null;
      if(remaining.length===0){
        const resumed=await client.query<{resume_at:Date}>(`UPDATE reliability_protocol_lanes SET state=CASE WHEN $3='active' THEN 'resume_pending' ELSE 'failed' END,
          resume_at=CASE WHEN $3='active' THEN to_timestamp($4 / 1000.0) ELSE NULL END
          WHERE run_id=$1 AND lane_id=$2 RETURNING resume_at`,[input.runId,input.laneId,state,fifo.resumeAtMs]);
        await client.query("UPDATE reliability_protocol_holds SET held_unresolved='[]'::jsonb,resolved_at=clock_timestamp() WHERE run_id=$1 AND lane_id=$2 AND hold_id=$3",[input.runId,input.laneId,hold.rows[0].hold_id]);
        resumeAt=resumed.rows[0]?.resume_at?.toISOString()??null;
      } else await client.query("UPDATE reliability_protocol_holds SET held_unresolved=$4::jsonb WHERE run_id=$1 AND lane_id=$2 AND hold_id=$3",[input.runId,input.laneId,hold.rows[0].hold_id,JSON.stringify(remaining)]);
      return {remaining,resumeAt,globalFailed};
    });
    if (result.globalFailed) throw new Error("SECOND_ALLOWANCE_GLOBAL_FAILURE");
    return { remaining: result.remaining, resumeAt: result.resumeAt };
  }

  async resumeDueLanes(runId: string): Promise<string[]> {
    return this.transaction(async (client) => {
      const control=await client.query<{state:string}>("SELECT state FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[runId]);
      if(control.rows[0]?.state!=="active")return [];
      const resumed=await client.query<{lane_id:string}>(`UPDATE reliability_protocol_lanes SET state='ready',resume_at=NULL
        WHERE run_id=$1 AND state='resume_pending' AND resume_at IS NOT NULL AND resume_at<=clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM reliability_protocol_holds hold WHERE hold.run_id=$1 AND hold.lane_id=reliability_protocol_lanes.lane_id AND hold.resolved_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM reliability_lane_backlog backlog WHERE backlog.run_id=$1 AND backlog.lane_id=reliability_protocol_lanes.lane_id AND backlog.state IN ('queued','scheduled','claimed'))
        RETURNING lane_id`,[runId]);
      return resumed.rows.map(row=>row.lane_id).sort();
    });
  }

  async recoverPreEntryDispatchOnClient(client:Queryable,input:{runId:string;laneId:string;requestId:string;reasonCode?:string}):Promise<"already_terminal"|"not_dispatched">{
      await this.lockControlLane(client,input.runId,input.laneId);
      const row=await client.query<{terminal:boolean;primitive_entered:boolean;canceled:boolean}>(`SELECT
        attempt.terminal_at IS NOT NULL terminal,token.primitive_entered_at IS NOT NULL primitive_entered,
        token.canceled_at IS NOT NULL canceled
        FROM reliability_protocol_attempts attempt JOIN reliability_dispatch_tokens token
          ON token.run_id=attempt.run_id AND token.request_id=attempt.request_id
        WHERE attempt.run_id=$1 AND attempt.request_id=$2 AND attempt.lane_id=$3 FOR UPDATE OF attempt,token`,
      [input.runId,input.requestId,input.laneId]);
      if(!row.rows[0])throw new Error("PRE_ENTRY_DISPATCH_NOT_FOUND");
      if(row.rows[0].terminal)return "already_terminal";
      if(row.rows[0].primitive_entered)throw new Error("PRE_ENTRY_RECOVERY_REQUIRES_RECONCILIATION");
      await client.query("UPDATE reliability_dispatch_tokens SET canceled_at=COALESCE(canceled_at,clock_timestamp()) WHERE run_id=$1 AND request_id=$2 AND primitive_entered_at IS NULL",[input.runId,input.requestId]);
      const updated=await client.query(`UPDATE reliability_protocol_attempts SET state='not_dispatched',actual_cost_micros=0,
        gate_classified_at=clock_timestamp(),terminal_at=clock_timestamp()
        WHERE run_id=$1 AND request_id=$2 AND lane_id=$3 AND terminal_at IS NULL RETURNING 1`,[input.runId,input.requestId,input.laneId]);
      if(!updated.rows[0])throw new Error("PRE_ENTRY_RECOVERY_CONFLICT");
      await client.query("UPDATE reliability_protocol_controls SET gate_classification_count=gate_classification_count+1 WHERE run_id=$1",[input.runId]);
      const reasonCode=input.reasonCode??"PRE_ENTRY_WORKER_CRASH";
      await this.appendEvent(client,input.runId,input.requestId,"gate_classified",{state:"not_dispatched",reasonCode});
      await this.failProtocolLocked(client,input.runId,reasonCode);
      return "not_dispatched";
  }

  async enqueueHeldLaneWork(input:{runId:string;laneId:string;block:number;callOrdinal:number;requestId:string;nominalScheduledAt:string}):Promise<{queued:boolean}>{
    if(!Number.isInteger(input.block)||input.block<1||!Number.isInteger(input.callOrdinal)||input.callOrdinal<1||!Number.isFinite(Date.parse(input.nominalScheduledAt)))throw new Error("HELD_LANE_BACKLOG_INPUT_INVALID");
    return this.transaction(async client=>{
      const state=await this.lockControlLane(client,input.runId,input.laneId);
      if(state!=="active")throw new Error("PROTOCOL_CONTROL_FAILED");
      const lane=await client.query<{state:string}>("SELECT state FROM reliability_protocol_lanes WHERE run_id=$1 AND lane_id=$2",[input.runId,input.laneId]);
      if(!["held","resume_pending","resuming"].includes(lane.rows[0]?.state??""))return {queued:false};
      const sealed=await client.query("SELECT 1 FROM reliability_sealed_calls WHERE run_id=$1 AND lane_id=$2 AND block_no=$3 AND call_ordinal=$4 AND request_id=$5",[input.runId,input.laneId,input.block,input.callOrdinal,input.requestId]);
      if(!sealed.rows[0])throw new Error("HELD_LANE_BACKLOG_NOT_SEALED");
      await client.query(`INSERT INTO reliability_lane_backlog(run_id,lane_id,block_no,call_ordinal,request_id,nominal_scheduled_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,lane_id,block_no,call_ordinal) DO NOTHING`,
      [input.runId,input.laneId,input.block,input.callOrdinal,input.requestId,input.nominalScheduledAt]);
      const exact=await client.query<{request_id:string;nominal_scheduled_at:Date}>("SELECT request_id,nominal_scheduled_at FROM reliability_lane_backlog WHERE run_id=$1 AND lane_id=$2 AND block_no=$3 AND call_ordinal=$4",[input.runId,input.laneId,input.block,input.callOrdinal]);
      if(exact.rows[0]?.request_id!==input.requestId||exact.rows[0].nominal_scheduled_at.toISOString()!==new Date(input.nominalScheduledAt).toISOString())throw new Error("HELD_LANE_BACKLOG_CONFLICT");
      return {queued:true};
    });
  }

  async claimDueResumedWork(input:{runId:string;laneId:string;mode:"bounded-burst"|"sequential"}):Promise<null|{block:number;scheduledAt:string;requestIds:string[]}>{
    return this.transaction(async client=>{
      const state=await this.lockControlLane(client,input.runId,input.laneId);
      if(state!=="active")return null;
      const lane=await client.query<{state:string;resume_at:Date|null}>("SELECT state,resume_at FROM reliability_protocol_lanes WHERE run_id=$1 AND lane_id=$2",[input.runId,input.laneId]);
      if(lane.rows[0]?.state!=="resume_pending"||!lane.rows[0].resume_at)return null;
      const now=await client.query<{now:Date}>("SELECT clock_timestamp() now");
      if(now.rows[0]!.now<lane.rows[0].resume_at)return null;
      const oldest=await client.query<{block_no:number}>("SELECT block_no FROM reliability_lane_backlog WHERE run_id=$1 AND lane_id=$2 AND state='queued' ORDER BY block_no,call_ordinal LIMIT 1",[input.runId,input.laneId]);
      if(!oldest.rows[0])return null;
      const claimed=await client.query<{request_id:string}>(`UPDATE reliability_lane_backlog SET state='claimed',claimed_at=clock_timestamp(),
        actual_scheduled_at=$4,pause_duration_seconds=GREATEST(0,EXTRACT(EPOCH FROM ($4-nominal_scheduled_at))::bigint)
        WHERE run_id=$1 AND lane_id=$2 AND block_no=$3 AND state='queued'
          AND ($5='bounded-burst' OR call_ordinal=(SELECT min(candidate.call_ordinal) FROM reliability_lane_backlog candidate
            WHERE candidate.run_id=$1 AND candidate.lane_id=$2 AND candidate.block_no=$3 AND candidate.state='queued'))
        RETURNING request_id,call_ordinal`,
      [input.runId,input.laneId,oldest.rows[0].block_no,lane.rows[0].resume_at,input.mode]);
      await client.query("UPDATE reliability_protocol_lanes SET state='resuming',resume_at=NULL WHERE run_id=$1 AND lane_id=$2",[input.runId,input.laneId]);
      return {block:oldest.rows[0].block_no,scheduledAt:lane.rows[0].resume_at.toISOString(),requestIds:claimed.rows.map(row=>row.request_id)};
    });
  }

  async completeResumedWorkGroup(input:{runId:string;laneId:string;block:number}):Promise<{nextResumeAt:string|null}>{
    return this.transaction(async client=>{
      const state=await this.lockControlLane(client,input.runId,input.laneId);
      if(state!=="active")throw new Error("PROTOCOL_CONTROL_FAILED");
      const pending=await client.query("SELECT 1 FROM reliability_lane_backlog backlog JOIN reliability_protocol_attempts attempt ON attempt.run_id=backlog.run_id AND attempt.request_id=backlog.request_id WHERE backlog.run_id=$1 AND backlog.lane_id=$2 AND backlog.block_no=$3 AND backlog.state='claimed' AND attempt.terminal_at IS NULL LIMIT 1",[input.runId,input.laneId,input.block]);
      if(pending.rows[0])throw new Error("RESUMED_WORK_GROUP_NOT_TERMINAL");
      const finished=await client.query<{terminal_at:Date}>(`UPDATE reliability_lane_backlog backlog SET state='terminal',terminal_at=attempt.terminal_at
        FROM reliability_protocol_attempts attempt WHERE backlog.run_id=$1 AND backlog.lane_id=$2 AND backlog.block_no=$3
          AND backlog.state='claimed' AND attempt.run_id=backlog.run_id AND attempt.request_id=backlog.request_id
        RETURNING backlog.terminal_at`,[input.runId,input.laneId,input.block]);
      if(!finished.rows.length)throw new Error("RESUMED_WORK_GROUP_NOT_CLAIMED");
      const queued=await client.query<{block_no:number}>("SELECT block_no FROM reliability_lane_backlog WHERE run_id=$1 AND lane_id=$2 AND state='queued' ORDER BY block_no,call_ordinal LIMIT 1",[input.runId,input.laneId]);
      if(!queued.rows[0]){await client.query("UPDATE reliability_protocol_lanes SET state='ready',resume_at=NULL WHERE run_id=$1 AND lane_id=$2",[input.runId,input.laneId]);return {nextResumeAt:null};}
      const latest=Math.max(...finished.rows.map(row=>row.terminal_at.getTime()));
      const nextResumeAt=new Date(latest+(queued.rows[0].block_no===input.block?5_000:60_000)).toISOString();
      await client.query("UPDATE reliability_protocol_lanes SET state='resume_pending',resume_at=$3 WHERE run_id=$1 AND lane_id=$2",[input.runId,input.laneId,nextResumeAt]);
      return {nextResumeAt};
    });
  }

  async loadReliabilityScheduleReport(runId:string):Promise<Array<{laneId:string;block:number;callOrdinal:number;requestId:string;state:string;nominalScheduledAt:string;actualScheduledAt:string|null;pauseDurationSeconds:number|null}>>{
    const rows=await this.database.query<{lane_id:string;block_no:number;call_ordinal:number;request_id:string;state:string;nominal_scheduled_at:Date;actual_scheduled_at:Date|null;pause_duration_seconds:string|null}>(`SELECT lane_id,block_no,call_ordinal,request_id,state,nominal_scheduled_at,actual_scheduled_at,pause_duration_seconds::text
      FROM reliability_lane_backlog WHERE run_id=$1 ORDER BY block_no,lane_id,call_ordinal`,[runId]);
    return rows.rows.map(row=>({laneId:row.lane_id,block:row.block_no,callOrdinal:row.call_ordinal,requestId:row.request_id,state:row.state,nominalScheduledAt:row.nominal_scheduled_at.toISOString(),actualScheduledAt:row.actual_scheduled_at?.toISOString()??null,pauseDurationSeconds:row.pause_duration_seconds===null?null:Number(row.pause_duration_seconds)}));
  }

  async isHeldLaneHead(input:{runId:string;laneId:string;requestId:string}):Promise<boolean>{
    const row=await this.database.query<{request_id:string}>(`SELECT member.request_id FROM reliability_hold_members member
      JOIN reliability_protocol_holds hold ON hold.run_id=member.run_id AND hold.lane_id=member.lane_id AND hold.hold_id=member.hold_id
      WHERE member.run_id=$1 AND member.lane_id=$2 AND hold.resolved_at IS NULL AND member.resolved_at IS NULL
      ORDER BY member.member_sequence LIMIT 1`,[input.runId,input.laneId]);
    return row.rows[0]?.request_id===input.requestId;
  }

  async authorizeReconciliationOffset(input:{runId:string;requestId:string;offsetSeconds:number;credentialId:string;authorizationSha256:string}):Promise<void>{
    if(!/^sha256:[a-f0-9]{64}$/.test(input.authorizationSha256))throw new Error("RECONCILIATION_OFFSET_AUTHORIZATION_INVALID");
    await this.transaction(async client=>{
      const control=await client.query<{reconciliation_credential_id:string|null}>("SELECT reconciliation_credential_id FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[input.runId]);
      if(!control.rows[0]||control.rows[0].reconciliation_credential_id!==input.credentialId)throw new Error("RECONCILIATION_CREDENTIAL_DRIFT");
      const updated=await client.query(`UPDATE reliability_reconciliation_attempts SET phase='authorized',credential_id=$4,authorization_sha256=$5,authorized_at=COALESCE(authorized_at,clock_timestamp()),failure_code=NULL
        WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3 AND phase IN ('scheduled','authorized') AND canceled_at IS NULL
          AND (credential_id IS NULL OR credential_id=$4) AND (authorization_sha256 IS NULL OR authorization_sha256=$5) RETURNING 1`,[input.runId,input.requestId,input.offsetSeconds,input.credentialId,input.authorizationSha256]);
      if(!updated.rows[0])throw new Error("RECONCILIATION_OFFSET_AUTHORIZATION_CONFLICT");
    });
  }

  async failReconciliationOffset(input:{runId:string;requestId:string;offsetSeconds:number;failureCode:string}):Promise<void>{
    if(!input.failureCode.trim())throw new Error("RECONCILIATION_FAILURE_CODE_REQUIRED");
    await this.transaction(async client=>{await client.query(`UPDATE reliability_reconciliation_attempts SET phase='failed',failure_code=$4,lookup_finished_at=COALESCE(lookup_finished_at,clock_timestamp()),finished_at=COALESCE(finished_at,clock_timestamp())
      WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3 AND phase NOT IN ('terminal','canceled_terminal')`,[input.runId,input.requestId,input.offsetSeconds,input.failureCode]);});
  }

  async finishReconciliationLookup(input:{runId:string;requestId:string;offsetSeconds:number}):Promise<void>{
    await this.transaction(async client=>{const updated=await client.query(`UPDATE reliability_reconciliation_attempts
      SET lookup_finished_at=COALESCE(lookup_finished_at,clock_timestamp())
      WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3 AND phase IN ('running','committed','terminal') RETURNING 1`,
    [input.runId,input.requestId,input.offsetSeconds]);
    if(!updated.rows[0])throw new Error("RECONCILIATION_LOOKUP_PHASE_CONFLICT");});
  }

  async recordSetupReadinessReceipt(input:{runId:string;expectedSnapshot:unknown;actualSnapshot:unknown}):Promise<{ready:boolean;differingFields:string[];snapshotDigest:string}>{
    const differingFields=setupSnapshotDifferences(input.expectedSnapshot,input.actualSnapshot);
    const snapshotDigest=`sha256:${createHash("sha256").update(JSON.stringify({expected:input.expectedSnapshot,actual:input.actualSnapshot,differingFields})).digest("hex")}`;
    const ready=differingFields.length===0;
    await this.transaction(async client=>{await client.query(`INSERT INTO reliability_setup_readiness_receipts(run_id,expected_snapshot,actual_snapshot,differing_fields,snapshot_digest,ready)
      VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6) ON CONFLICT(run_id) DO UPDATE SET expected_snapshot=EXCLUDED.expected_snapshot,actual_snapshot=EXCLUDED.actual_snapshot,differing_fields=EXCLUDED.differing_fields,snapshot_digest=EXCLUDED.snapshot_digest,ready=EXCLUDED.ready,checked_at=clock_timestamp()`,[input.runId,JSON.stringify(input.expectedSnapshot),JSON.stringify(input.actualSnapshot),JSON.stringify(differingFields),snapshotDigest,ready]);});
    return {ready,differingFields,snapshotDigest};
  }

  async requireSetupReadinessReceipt(input:{runId:string;planFingerprint:string}):Promise<string>{
    const receipt=await this.database.query<{snapshot_digest:string}>(`SELECT receipt.snapshot_digest
      FROM reliability_setup_readiness_receipts receipt
      JOIN reliability_protocol_controls control ON control.run_id=receipt.run_id
      WHERE receipt.run_id=$1 AND control.plan_fingerprint=$2 AND receipt.ready=true
        AND receipt.differing_fields='[]'::jsonb
        AND receipt.snapshot_digest ~ '^sha256:[a-f0-9]{64}$'`,[input.runId,input.planFingerprint]);
    if(!receipt.rows[0])throw new Error("SETUP_READINESS_RECEIPT_REQUIRED");
    return receipt.rows[0].snapshot_digest;
  }

  async scheduleReconciliation(input: { runId: string; requestId: string; offsetSeconds: number; scheduledAt: string; evidenceCutoff: string; classificationDeadline: string }): Promise<void> {
    if (!RECONCILIATION_OFFSETS_SECONDS.includes(input.offsetSeconds as never)) throw new Error("RECONCILIATION_OFFSET_INVALID");
    const ambiguity = new Date(Date.parse(input.scheduledAt) - input.offsetSeconds * 1_000).toISOString();
    const expected = reconciliationWindow(ambiguity, input.offsetSeconds);
    if (input.scheduledAt !== expected.scheduledAt || input.evidenceCutoff !== expected.evidenceCutoff || input.classificationDeadline !== expected.classificationDeadline) throw new Error("RECONCILIATION_WINDOW_INVALID");
    await this.transaction(async client=>{await client.query(`INSERT INTO reliability_reconciliation_attempts
      (run_id,request_id,offset_seconds,phase,scheduled_at,evidence_cutoff,classification_deadline)
      VALUES($1,$2,$3,'scheduled',$4,$5,$6) ON CONFLICT DO NOTHING`,
    [input.runId,input.requestId,input.offsetSeconds,input.scheduledAt,input.evidenceCutoff,input.classificationDeadline]);});
  }

  async commitReconciliationEvidence(input: { runId: string; requestId: string; offsetSeconds: number; metadata: unknown; content: unknown; disposition: string }): Promise<void> {
    await this.transaction(async (client) => {
      const attempt=await client.query("SELECT 1 FROM reliability_reconciliation_attempts WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3 FOR UPDATE",[input.runId,input.requestId,input.offsetSeconds]);
      if(!attempt.rows[0]) throw new Error("RECONCILIATION_SCHEDULE_REQUIRED");
      await client.query(`INSERT INTO reliability_reconciliation_evidence(run_id,request_id,offset_seconds,metadata,content,disposition)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) ON CONFLICT(run_id,request_id,offset_seconds) DO NOTHING`,[input.runId,input.requestId,input.offsetSeconds,JSON.stringify(input.metadata),JSON.stringify(input.content),input.disposition]);
      await client.query("UPDATE reliability_reconciliation_attempts SET phase='committed',finished_at=clock_timestamp() WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3",[input.runId,input.requestId,input.offsetSeconds]);
    });
  }

  async beginReconciliationLookup(input: { runId: string; requestId: string; offsetSeconds: number }): Promise<{ startedAtMs: number; scheduledAtMs: number }> {
    if (!RECONCILIATION_OFFSETS_SECONDS.includes(input.offsetSeconds as never)) throw new Error("RECONCILIATION_OFFSET_INVALID");
    return this.transaction(async (client) => {
      const attempt = await client.query<{ lane_id: string }>("SELECT lane_id FROM reliability_protocol_attempts WHERE run_id=$1 AND request_id=$2", [input.runId,input.requestId]);
      if (!attempt.rows[0]) throw new Error("PROTOCOL_ATTEMPT_NOT_FOUND");
      const state = await this.lockControlLane(client,input.runId,attempt.rows[0].lane_id);
      if (state !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
      const row = await client.query<{ started_at: Date; scheduled_at: Date }>(`UPDATE reliability_reconciliation_attempts SET
        phase='running',started_at=COALESCE(started_at,clock_timestamp()),lookup_started_at=COALESCE(lookup_started_at,clock_timestamp())
        WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3 AND phase IN ('scheduled','authorized','running')
          AND canceled_at IS NULL AND clock_timestamp() >= scheduled_at AND clock_timestamp() < scheduled_at + interval '1 second'
        RETURNING started_at,scheduled_at`,[input.runId,input.requestId,input.offsetSeconds]);
      if (!row.rows[0]) throw new Error("RECONCILIATION_START_WINDOW_MISSED");
      return { startedAtMs: row.rows[0].started_at.getTime(), scheduledAtMs: row.rows[0].scheduled_at.getTime() };
    });
  }

  async applyAuthoritativeReconciliation(input: {
    runId: string; requestId: string; laneId: string;
    operation: { kind: "scheduled"; offsetSeconds: number } | { kind: "cutoff" } | {
      kind: "pre_ambiguity"; errorHttpStatus: number; errorEnvelopeGenerationId: string;
    };
    evidence: ReconciliationEvidence | null; recoveredResponse?: ProviderResult;
  }): Promise<{ applied: boolean; plan: ReconciliationMutationPlan | null; terminalState: string | null }> {
    return this.transaction(async (client) => {
      const control = await client.query<{ state:"active"|"failed"; nonusable_allowance_owner:string|null; reconciliation_credential_id:string|null }>(
        "SELECT state,nonusable_allowance_owner,reconciliation_credential_id FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[input.runId]);
      if (!control.rows[0]) throw new Error("PROTOCOL_CONTROL_NOT_FOUND");
      const lane = await client.query("SELECT state FROM reliability_protocol_lanes WHERE run_id=$1 AND lane_id=$2 FOR UPDATE",[input.runId,input.laneId]);
      if (!lane.rows[0]) throw new Error("PROTOCOL_LANE_NOT_FOUND");
      const row = await client.query<any>(`SELECT attempt.*,sealed.model,sealed.provider,sealed.max_output_tokens,sealed.body_commitment,sealed.request_body,sealed.organization_id,sealed.agent_id,sealed.credential_id,sealed.mandate_id,sealed.branch_id,sealed.workload_class,
        token.created_at AS dispatch_token_at,execution.response_json
        FROM reliability_protocol_attempts attempt JOIN reliability_sealed_calls sealed
          ON sealed.run_id=attempt.run_id AND sealed.request_id=attempt.request_id
        JOIN reliability_dispatch_tokens token ON token.run_id=attempt.run_id AND token.request_id=attempt.request_id
        LEFT JOIN inference_executions execution ON execution.organization_id=sealed.organization_id AND execution.request_id=attempt.request_id
        WHERE attempt.run_id=$1 AND attempt.request_id=$2 AND attempt.lane_id=$3 FOR UPDATE OF attempt`,[input.runId,input.requestId,input.laneId]);
      const attempt=row.rows[0]; if(!attempt)throw new Error("AUTHORITATIVE_RECONCILIATION_INPUT_MISSING");
      if(attempt.terminal_at) return {applied:false,plan:null,terminalState:attempt.state};
      if(!control.rows[0].reconciliation_credential_id)throw new Error("RECONCILIATION_CREDENTIAL_AUTHORITY_MISSING");
      const hold=await client.query<{held_unresolved:string[]}>("SELECT held_unresolved FROM reliability_protocol_holds WHERE run_id=$1 AND lane_id=$2 AND resolved_at IS NULL FOR UPDATE",[input.runId,input.laneId]);
      const heldMembers=hold.rows[0]?.held_unresolved ?? [input.requestId];
      if(!heldMembers.includes(input.requestId))throw new Error("RECONCILIATION_HOLD_INVARIANT");
      const nowRows=await client.query<{now:Date}>("SELECT clock_timestamp() now"); const now=nowRows.rows[0]!.now.getTime();
      let operation: any;
      let offset=-1;
      if(input.operation.kind==="scheduled"){
        offset=input.operation.offsetSeconds;
        const scheduled=await client.query<{scheduled_at:Date;started_at:Date|null}>("SELECT scheduled_at,started_at FROM reliability_reconciliation_attempts WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3 AND canceled_at IS NULL FOR UPDATE",[input.runId,input.requestId,offset]);
        if(!scheduled.rows[0]?.started_at)throw new Error("RECONCILIATION_LOOKUP_NOT_STARTED");
        operation={kind:"scheduled",offsetSeconds:offset,scheduledAtMs:scheduled.rows[0].scheduled_at.getTime(),startedAtMs:scheduled.rows[0].started_at.getTime(),getsCompletedAtMs:now,evidenceValidatedAtMs:now,evidenceCommittedAtMs:now,transitionCommittedAtMs:now};
      }else if(input.operation.kind==="cutoff"){
        const scheduledAt=attempt.ambiguity_entered_at?.getTime()+86_400_000;
        operation={kind:"cutoff",scheduledAtMs:scheduledAt,startedAtMs:now,transitionCommittedAtMs:now};
      }else{
        await client.query(`INSERT INTO reliability_reconciliation_attempts
          (run_id,request_id,offset_seconds,phase,scheduled_at,evidence_cutoff,classification_deadline,started_at)
          VALUES($1,$2,-1,'running',clock_timestamp(),clock_timestamp() + interval '86400 seconds',
            clock_timestamp() + interval '86431 seconds',clock_timestamp()) ON CONFLICT DO NOTHING`,[input.runId,input.requestId]);
        operation={kind:"pre_ambiguity",errorReceivedAtMs:now,errorHttpStatus:input.operation.errorHttpStatus,
          errorEnvelopeGenerationId:input.operation.errorEnvelopeGenerationId,scheduledAtMs:now,startedAtMs:now,
          getsCompletedAtMs:now,evidenceValidatedAtMs:now,evidenceCommittedAtMs:now,transitionCommittedAtMs:now};
      }
      const body=attempt.request_body as Record<string,unknown>;
      let recoveredCommitment:string|null=null;
      const contentRoot=input.evidence?.content.body as any;
      if(typeof contentRoot?.data?.output?.completion==="string"){
        const authoritative=await loadAuthoritativeResponseFields(client as any,attempt.organization_id,input.requestId,
          exactProviderCostMicros(input.evidence?.metadata.data?.total_cost));
        recoveredCommitment=reconstructStableResponseFromEvidence(input.evidence!,authoritative.authority).commitment;
      }
      const accepted=await client.query<{accepted_binding:unknown}>("SELECT accepted_binding FROM reliability_reconciliation_evidence WHERE run_id=$1 AND request_id=$2 AND accepted=true ORDER BY offset_seconds LIMIT 1",[input.runId,input.requestId]);
      const plan=planReconciliationMutation({runId:input.runId,requestId:input.requestId,laneId:input.laneId,
        currentState:attempt.state==="reconciliation_pending"?"reconciliation_pending":"ordinary_inflight",
        generationId:attempt.provider_generation_id,expectedReconcilerCredentialId:control.rows[0].reconciliation_credential_id,
        openRouterRequestId:null,model:attempt.model,dispatchTokenAtMs:attempt.dispatch_token_at.getTime(),
        ambiguityEnteredAtMs:attempt.ambiguity_entered_at?.getTime()??null,
        admissionStartedAtMs:(attempt.admission_started_at??attempt.created_at).getTime(),
        originalMessages:Array.isArray(body.messages)?body.messages:[],sealedRequestCommitmentMatches:attempt.request_commitment===buildSealedRequestCommitment({body,organizationId:attempt.organization_id,credentialId:attempt.credential_id,mandateId:attempt.mandate_id,branchId:attempt.branch_id,workloadClass:attempt.workload_class,requestId:input.requestId}),
        existingResponseCommitment:attempt.response_commitment,recoveredResponseCommitment:recoveredCommitment,
        acceptedBinding:(accepted.rows[0]?.accepted_binding as any)??null,operation,evidence:input.evidence,
        heldMemberState:attempt.state==="reconciliation_pending"?"reconciliation_pending":"ordinary_inflight",
        heldMembersBefore:heldMembers,nonusableAllowanceOwner:control.rows[0].nonusable_allowance_owner,controlState:control.rows[0].state});
      if(plan.persistAttempt && input.evidence){
        const metadata={...input.evidence.metadata}; const content={...input.evidence.content};
        const inserted=await client.query(`INSERT INTO reliability_reconciliation_evidence
          (run_id,request_id,offset_seconds,metadata,content,disposition,credential_id,generation_id,accepted,conflict,reason,accepted_binding)
          VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT DO NOTHING RETURNING 1`,
        [input.runId,input.requestId,offset,JSON.stringify(metadata),JSON.stringify(content),plan.terminal?.name??"reconciliation_pending",
          input.evidence.credentialId,input.evidence.generationId,plan.evidence.accepted,plan.evidence.conflict,plan.evidence.reason,JSON.stringify(plan.evidence.binding)]);
        if(!inserted.rows[0]){
          const exact=await client.query("SELECT 1 FROM reliability_reconciliation_evidence WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3 AND metadata=$4::jsonb AND content=$5::jsonb AND accepted=$6 AND conflict=$7 AND reason IS NOT DISTINCT FROM $8",[input.runId,input.requestId,offset,JSON.stringify(metadata),JSON.stringify(content),plan.evidence.accepted,plan.evidence.conflict,plan.evidence.reason]);
          if(!exact.rows[0])throw new Error("IMMUTABLE_RECONCILIATION_EVIDENCE_CONFLICT");
        }
      }
      if(offset>=0)await client.query("UPDATE reliability_reconciliation_attempts SET phase=$4,finished_at=clock_timestamp() WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3",[input.runId,input.requestId,offset,plan.terminal?"terminal":"committed"]);
      if(plan.attemptState==="enter_ambiguity"){
        await client.query("UPDATE reliability_protocol_attempts SET state='reconciliation_pending',ambiguity_entered_at=COALESCE(ambiguity_entered_at,clock_timestamp()) WHERE run_id=$1 AND request_id=$2",[input.runId,input.requestId]);
        await client.query("UPDATE reliability_protocol_controls SET ambiguity_count=ambiguity_count+1 WHERE run_id=$1",[input.runId]);
        if(!hold.rows[0]){
          const members=await client.query<{request_id:string}>(`SELECT request_id FROM reliability_protocol_attempts WHERE run_id=$1 AND lane_id=$2 AND terminal_at IS NULL ORDER BY block_no,request_id`,[input.runId,input.laneId]);
          await client.query("INSERT INTO reliability_protocol_holds(run_id,lane_id,hold_id,held_unresolved) VALUES($1,$2,$3,$4::jsonb)",[input.runId,input.laneId,randomUUID(),JSON.stringify(members.rows.map(r=>r.request_id))]);
          await client.query("UPDATE reliability_protocol_lanes SET state='held' WHERE run_id=$1 AND lane_id=$2",[input.runId,input.laneId]);
        }
        const ambiguity=await client.query<{ambiguity_entered_at:Date}>("SELECT ambiguity_entered_at FROM reliability_protocol_attempts WHERE run_id=$1 AND request_id=$2",[input.runId,input.requestId]);
        for(const candidate of RECONCILIATION_OFFSETS_SECONDS){const times=reconciliationWindow(ambiguity.rows[0]!.ambiguity_entered_at.toISOString(),candidate);await client.query(`INSERT INTO reliability_reconciliation_attempts(run_id,request_id,offset_seconds,phase,scheduled_at,evidence_cutoff,classification_deadline) VALUES($1,$2,$3,'scheduled',$4,$5,$6) ON CONFLICT DO NOTHING`,[input.runId,input.requestId,candidate,times.scheduledAt,times.evidenceCutoff,times.classificationDeadline]);}
      }
      if(plan.terminal&&plan.execution){
        const actual=plan.execution.actualCostMicros;
        const ordinary=await settleOrdinaryReconciliationOnClient({client:client as any,requestId:input.requestId,
          organizationId:attempt.organization_id,terminalState:plan.terminal.state,actualCostAtomic:actual,
          evidence:input.evidence,occurredAt:new Date(now).toISOString()});
        if(plan.execution.responseCommitment!==ordinary.responseCommitment)throw new Error("ORDINARY_PROTOCOL_RESPONSE_COMMITMENT_CONFLICT");
        const terminalized=await client.query(`UPDATE reliability_protocol_attempts SET state=$3,response_commitment=$4,actual_cost_micros=$5,
          gate_classified_at=clock_timestamp(),terminal_at=clock_timestamp() WHERE run_id=$1 AND request_id=$2 AND terminal_at IS NULL RETURNING request_id`,
        [input.runId,input.requestId,plan.terminal.name,plan.execution.responseCommitment,actual]);
        if(!terminalized.rows[0])throw new Error("TERMINAL_WRITER_LOST_RACE");
        await client.query("UPDATE reliability_protocol_controls SET gate_classification_count=gate_classification_count+$2,usable_count=usable_count+$3 WHERE run_id=$1",[input.runId,plan.counters.gateClassifications,plan.counters.usable]);
        if(plan.allowance.action==="claim"){
          const allowance=await client.query("UPDATE reliability_protocol_controls SET nonusable_allowance_owner=$2 WHERE run_id=$1 AND nonusable_allowance_owner IS NULL RETURNING run_id",[input.runId,input.requestId]);
          if(!allowance.rows[0])throw new Error("NONUSABLE_ALLOWANCE_RACE");
        }
        const remaining=heldMembers.filter(id=>id!==input.requestId);
        if(hold.rows[0]){
          if(remaining.length)await client.query("UPDATE reliability_protocol_holds SET held_unresolved=$3::jsonb WHERE run_id=$1 AND lane_id=$2 AND resolved_at IS NULL",[input.runId,input.laneId,JSON.stringify(remaining)]);
          else await client.query("UPDATE reliability_protocol_holds SET held_unresolved='[]'::jsonb,resolved_at=clock_timestamp() WHERE run_id=$1 AND lane_id=$2 AND resolved_at IS NULL",[input.runId,input.laneId]);
        }
        for(const canceled of plan.cancelOffsets)await client.query("UPDATE reliability_reconciliation_attempts SET phase='canceled_terminal',canceled_at=COALESCE(canceled_at,clock_timestamp()) WHERE run_id=$1 AND request_id=$2 AND offset_seconds=$3 AND phase='scheduled'",[input.runId,input.requestId,canceled.offsetSeconds]);
        if(plan.lane.action==="schedule_resume")await client.query("UPDATE reliability_protocol_lanes SET state='resume_pending',resume_at=to_timestamp($3) WHERE run_id=$1 AND lane_id=$2",[input.runId,input.laneId,plan.lane.resumeAtEpochSecond]);
      }
      for(const event of plan.events)await this.appendEvent(client,input.runId,input.requestId,event.type,event.data);
      if(plan.globalFailure.trigger)await this.failProtocolLocked(client,input.runId,plan.globalFailure.reason);
      return {applied:true,plan,terminalState:plan.terminal?.name??null};
    });
  }

  private async readEvidenceClosureRows(client: Queryable, runId: string): Promise<EvidenceClosureRows> {
    const q=async(sql:string)=>(await client.query(sql,[runId])).rows as any[];
    const sealedCalls=await q(`SELECT request_id "requestId",lane_id lane,block_no::int block,call_ordinal::int "callOrdinal"
      FROM reliability_sealed_calls WHERE run_id=$1 ORDER BY block_no,lane_id,call_ordinal`);
    const attempts=await q(`SELECT request_id "requestId",state,
      CASE WHEN gate_classified_at IS NULL THEN 0 ELSE 1 END "gateClassificationCount",
      admission_started_at IS NOT NULL "admissionStarted",
      admission_started_at IS NULL AND state='not_dispatched' "canceledAfterGateFailure",
      actual_cost_micros::text "actualCostMicros",reserved_cost_micros::text "reservedCostMicros"
      FROM reliability_protocol_attempts WHERE run_id=$1 ORDER BY request_id`);
    const executions=await q(`SELECT execution.request_id "requestId",execution.status,
      execution.actual_cost_atomic::text "actualCostMicros",execution.shadow_order_state "shadowOrderState",
      execution.shadow_cohort_ordinal::int "cohortOrdinal" FROM inference_executions execution
      JOIN reliability_sealed_calls sealed ON sealed.organization_id=execution.organization_id AND sealed.request_id=execution.request_id
      WHERE sealed.run_id=$1 ORDER BY execution.request_id`);
    const decisions=await q(`SELECT decision.request_id "requestId",decision.outcome FROM policy_decisions decision
      JOIN reliability_sealed_calls sealed ON sealed.organization_id=decision.organization_id AND sealed.request_id=decision.request_id
      WHERE sealed.run_id=$1 ORDER BY decision.request_id`);
    const dispatchTokens=await q(`SELECT request_id "requestId",primitive_entered_at IS NOT NULL "primitiveEntered",
      canceled_at IS NOT NULL AND primitive_entered_at IS NULL "preDispatchProof" FROM reliability_dispatch_tokens
      WHERE run_id=$1 ORDER BY request_id`);
    const shadowQueue=await q(`SELECT queue.request_id "requestId",queue.state,queue.attempts FROM shadow_evaluation_queue queue
      JOIN reliability_sealed_calls sealed ON sealed.organization_id=queue.organization_id AND sealed.request_id=queue.request_id
      WHERE sealed.run_id=$1 ORDER BY queue.request_id`);
    const shadowEvidence=await q(`SELECT evidence.request_id "requestId" FROM shadow_evaluations evidence
      JOIN reliability_sealed_calls sealed ON sealed.organization_id=evidence.organization_id AND sealed.request_id=evidence.request_id
      WHERE sealed.run_id=$1 ORDER BY evidence.request_id`);
    const replayAudits=await q(`SELECT request_id "requestId",replay_no::int "replayNo",
      original_response_commitment "originalResponseCommitment",replay_response_commitment "replayResponseCommitment",write_set "writeSet"
      FROM reliability_replay_audits WHERE run_id=$1 ORDER BY replay_no`);
    const lifecycleEvents=await q(`SELECT event.request_id "requestId",event.event_type "eventType",
      (extract(epoch FROM event.occurred_at)*1000)::float8 "databaseTimeMs",
      CASE WHEN event.event_type='admission_started' THEN (extract(epoch FROM claim.claimed_at)*1000)::float8 END "blockClaimedAtMs",
      CASE WHEN event.event_type='admission_started' THEN (extract(epoch FROM prior.terminal_at)*1000)::float8 END "priorTerminalAtMs"
      FROM reliability_protocol_events event
      LEFT JOIN reliability_sealed_calls sealed ON sealed.run_id=event.run_id AND sealed.request_id=event.request_id
      LEFT JOIN reliability_block_claims claim ON claim.run_id=sealed.run_id AND claim.block_no=sealed.block_no
      LEFT JOIN LATERAL (SELECT attempt.terminal_at FROM reliability_sealed_calls prior_sealed
        JOIN reliability_protocol_attempts attempt ON attempt.run_id=prior_sealed.run_id AND attempt.request_id=prior_sealed.request_id
        WHERE prior_sealed.run_id=sealed.run_id AND prior_sealed.lane_id=sealed.lane_id
          AND prior_sealed.block_no=sealed.block_no AND prior_sealed.call_ordinal=sealed.call_ordinal-1) prior ON true
      WHERE event.run_id=$1 AND event.request_id IS NOT NULL AND event.event_type=ANY(ARRAY[
        'planned','admission_started','dispatch_authorized','barrier_released','barrier_canceled_before_dispatch',
        'dispatch_primitive_entered','ambiguity_entered','provider_evidence_attached','gate_classified'])
      ORDER BY event.event_sequence`);
    const replayCancellations=await q(`SELECT replay_no::int "replayNo",request_id "requestId",reason,
      (extract(epoch FROM canceled_at)*1000)::float8 "canceledAtMs" FROM reliability_replay_cancellations WHERE run_id=$1 ORDER BY replay_no`);
    const protocolControls=await q(`SELECT state,failure_sequence::int "failureSequence",gate_classification_count::int "gateClassificationCount",
      replay_passed_count::int "replayPassedCount",durable_stage "durableStage" FROM reliability_protocol_controls WHERE run_id=$1`);
    const protocolLanes=await q(`SELECT lane_id lane,state,(extract(epoch FROM resume_at)*1000)::float8 "resumeAtMs"
      FROM reliability_protocol_lanes WHERE run_id=$1 ORDER BY lane_id`);
    const blockClaims=await q(`SELECT block_no::int block,lane_id lane,state,owner_id "ownerId",plan_fingerprint "planFingerprint",
      (extract(epoch FROM claimed_at)*1000)::float8 "claimedAtMs" FROM reliability_block_claims WHERE run_id=$1 ORDER BY block_no`);
    const authorizationDecisions=await q(`SELECT verdict->>'operatorValid'='true' "operatorValid",
      verdict->>'reconciliationValid'='true' "reconciliationValid",
      (verdict->>'operatorValid'='true' AND verdict->>'reconciliationValid'='true') active,
      decision_id::text "decisionId",operator_nonce "operatorNonce" FROM reliability_authorization_decisions WHERE run_id=$1`);
    const authorizationOutbox=await q(`SELECT receipt_kind kind,published_at IS NOT NULL published,receipt
      FROM reliability_authorization_outbox WHERE run_id=$1 ORDER BY receipt_kind`);
    const reconciliationAttempts=await q(`SELECT request_id "requestId",offset_seconds::int "offsetSeconds",phase,
      credential_id "credentialId",canceled_at IS NOT NULL canceled FROM reliability_reconciliation_attempts
      WHERE run_id=$1 ORDER BY request_id,offset_seconds`);
    const reconciliationEvidence=await q(`SELECT request_id "requestId",offset_seconds::int "offsetSeconds",accepted,conflict,
      disposition,credential_id "credentialId",generation_id "generationId",accepted_binding "acceptedBinding"
      FROM reliability_reconciliation_evidence WHERE run_id=$1 ORDER BY request_id,offset_seconds`);
    const holds=await q(`SELECT lane_id lane,resolved_at IS NOT NULL resolved,held_unresolved "heldUnresolved",
      hold_id::text "holdId" FROM reliability_protocol_holds WHERE run_id=$1 ORDER BY lane_id,created_at`);
    const incidents=await q(`SELECT incident_sequence::int sequence,event_type "eventType",evidence,
      (extract(epoch FROM created_at)*1000)::float8 "createdAtMs" FROM reliability_protocol_incidents WHERE run_id=$1 ORDER BY incident_sequence`);
    const schedulerClaims=await q(`SELECT request_id "requestId",lane_id lane,block_no::int block,state,generation,
      manifest_path "manifestPath",manifest_digest "manifestDigest",manifest_fsynced_at IS NOT NULL "manifestFsynced"
      FROM reliability_scheduler_claims WHERE run_id=$1 ORDER BY request_id`);
    const costRows=await q(`SELECT
      COALESCE(sum(actual_cost_micros) FILTER (WHERE state<>'unresolved_provider_outcome'),0)::text "knownCostMicros",
      COALESCE(sum(reserved_cost_micros) FILTER (WHERE state='unresolved_provider_outcome'),0)::text "unresolvedExposureMicros"
      FROM reliability_protocol_attempts WHERE run_id=$1`);
    const artifactBindings=await q(`SELECT path,digest FROM reliability_artifact_bindings WHERE run_id=$1 ORDER BY path`);
    return {sealedCalls,attempts,executions,decisions,dispatchTokens,shadowQueue,shadowEvidence,replayAudits,lifecycleEvents,
      replayCancellations,protocolControls,protocolLanes,blockClaims,authorizationDecisions,authorizationOutbox,
      reconciliationAttempts,reconciliationEvidence,holds,incidents,schedulerClaims,costRows,artifactBindings};
  }

  async loadEvidenceClosureSnapshot(runId: string): Promise<{
    rows: EvidenceClosureRows; replayTargetRequestIds: string[];
    acceptedSnapshot: { digest:string; databaseStartedAtMs:number };
    settlement: { passed:boolean; acceptedSnapshotDigest:string; acceptedOffsetSeconds:number; journalCardinality:number; rowCardinality:number; committedAt:string };
  }> {
    const final=await this.database.query<{snapshot_digest:string;accepted_database_started_at:Date;snapshot_rows:EvidenceClosureRows;passed:boolean;accepted_offset_seconds:number;journal_cardinality:number;row_cardinality:number;committed_at:Date}>(
      `SELECT snapshot_digest,accepted_database_started_at,snapshot_rows,passed,accepted_offset_seconds,journal_cardinality,row_cardinality,committed_at
       FROM reliability_settlement_final_snapshots WHERE run_id=$1`,[runId]);
    const row=final.rows[0];
    if(!row?.passed||!row.snapshot_digest||!row.accepted_database_started_at||!row.snapshot_rows)throw new Error("ACCEPTED_SETTLEMENT_SNAPSHOT_REQUIRED");
    if(authoritativeSnapshotDigest(row.snapshot_rows as unknown as Readonly<Record<string,readonly unknown[]>>)!==row.snapshot_digest)
      throw new Error("ACCEPTED_SETTLEMENT_SNAPSHOT_CONFLICT");
    if(AUTHORITATIVE_SNAPSHOT_INVENTORIES.some(name=>!Array.isArray((row.snapshot_rows as unknown as Record<string,unknown>)[name])))
      throw new Error("ACCEPTED_SETTLEMENT_SNAPSHOT_INCOMPLETE");
    const replayTargetRequestIds=[...row.snapshot_rows.replayAudits].sort((a,b)=>a.replayNo-b.replayNo).map(item=>item.requestId);
    return {rows:row.snapshot_rows,replayTargetRequestIds,acceptedSnapshot:{digest:row.snapshot_digest,databaseStartedAtMs:row.accepted_database_started_at.getTime()},
      settlement:{passed:true,acceptedSnapshotDigest:row.snapshot_digest,acceptedOffsetSeconds:row.accepted_offset_seconds,
        journalCardinality:row.journal_cardinality,rowCardinality:row.row_cardinality,committedAt:row.committed_at.toISOString()}};
  }

  async loadArtifactIncidentCoordinates(runId:string):Promise<Array<{sequence:number;eventType:string}>>{
    const rows=await this.database.query<{sequence:number;eventType:string}>(`SELECT incident_sequence::int sequence,event_type "eventType"
      FROM reliability_protocol_incidents WHERE run_id=$1 ORDER BY incident_sequence`,[runId]);
    return rows.rows;
  }

  async advanceDurableStage(runId: string, target: Exclude<DurableReliabilityStage,"running">): Promise<DurableReliabilityStage> {
    return this.transaction(async client => {
      const control = await client.query<{durable_stage:DurableReliabilityStage;state:string}>(
        "SELECT durable_stage,state FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[runId]);
      if(!control.rows[0] || control.rows[0].state==="failed")throw new Error("PROTOCOL_CONTROL_FAILED");
      const counts=await client.query<{terminal_fresh:string;open_holds:string;replay_audits:string;settlement_passed:boolean}>(`SELECT
        (SELECT count(*)::text FROM reliability_protocol_attempts WHERE run_id=$1 AND terminal_at IS NOT NULL) terminal_fresh,
        (SELECT count(*)::text FROM reliability_protocol_holds WHERE run_id=$1 AND resolved_at IS NULL) open_holds,
        (SELECT count(*)::text FROM reliability_replay_audits WHERE run_id=$1) replay_audits,
        EXISTS(SELECT 1 FROM reliability_settlement_final_snapshots WHERE run_id=$1 AND passed=true) settlement_passed`,[runId]);
      const count=counts.rows[0]!;
      const next=planDurableStageTransition({stage:control.rows[0].durable_stage,terminalFresh:Number(count.terminal_fresh),
        openHolds:Number(count.open_holds),replayAudits:Number(count.replay_audits),artifactsBound:target==="artifact_bound",settlementPassed:count.settlement_passed},target);
      await client.query("UPDATE reliability_protocol_controls SET durable_stage=$2 WHERE run_id=$1",[runId,next]);
      return next;
    });
  }

  async bindArtifactInventory(runId:string, artifactDigests:Readonly<Record<string,string>>):Promise<void>{
    const entries=Object.entries(artifactDigests).sort(([a],[b])=>a.localeCompare(b));
    if(!entries.length||entries.some(([path,digest])=>!path||!/^sha256:[a-f0-9]{64}$/.test(digest)))throw new Error("ARTIFACT_BINDING_INVALID");
    await this.transaction(async client=>{
      const control=await client.query<{durable_stage:string}>("SELECT durable_stage FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[runId]);
      if(!control.rows[0]||control.rows[0].durable_stage!=="replay_terminal")throw new Error("ARTIFACT_BINDING_STAGE_INVALID");
      for(const [path,digest] of entries){
        await client.query("INSERT INTO reliability_artifact_bindings(run_id,path,digest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[runId,path,digest]);
        const exact=await client.query("SELECT 1 FROM reliability_artifact_bindings WHERE run_id=$1 AND path=$2 AND digest=$3",[runId,path,digest]);
        if(!exact.rows[0])throw new Error("IMMUTABLE_ARTIFACT_BINDING_CONFLICT");
      }
      const inventory=await client.query<{path:string;digest:string}>("SELECT path,digest FROM reliability_artifact_bindings WHERE run_id=$1 ORDER BY path",[runId]);
      if(inventory.rows.length!==entries.length||inventory.rows.some((row,index)=>row.path!==entries[index]![0]||row.digest!==entries[index]![1]))
        throw new Error("ARTIFACT_BINDING_INVENTORY_CONFLICT");
      await client.query("UPDATE reliability_protocol_controls SET durable_stage='artifact_bound' WHERE run_id=$1 AND durable_stage='replay_terminal'",[runId]);
    });
  }

  async commitCanonicalFinalReport(input:{runId:string;marker:CanonicalFinalCommitMarker}):Promise<void>{
    const canonicalPath=canonicalFinalCommitPath(input.runId);
    const reportBytes=`${JSON.stringify(input.marker)}\n`;
    const reportDigest=`sha256:${createHash("sha256").update(reportBytes).digest("hex")}`;
    await this.transaction(async client=>{
      const control=await client.query<{durable_stage:DurableReliabilityStage}>("SELECT durable_stage FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[input.runId]);
      if(control.rows[0]?.durable_stage!=="settled")throw new Error("SETTLEMENT_REQUIRED_BEFORE_FINAL_COMMIT");
      const settled=await client.query("SELECT 1 FROM reliability_settlement_final_snapshots WHERE run_id=$1 AND passed=true AND snapshot_digest=$2",[input.runId,input.marker.settlement.acceptedSnapshotDigest]);
      if(!settled.rows[0])throw new Error("FINAL_COMMIT_SETTLEMENT_CONFLICT");
      await client.query(`INSERT INTO reliability_final_report_outbox(run_id,canonical_path,report_bytes,report_digest)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[input.runId,canonicalPath,reportBytes,reportDigest]);
      const exact=await client.query("SELECT 1 FROM reliability_final_report_outbox WHERE run_id=$1 AND canonical_path=$2 AND report_bytes=$3 AND report_digest=$4",[input.runId,canonicalPath,reportBytes,reportDigest]);
      if(!exact.rows[0])throw new Error("IMMUTABLE_FINAL_COMMIT_CONFLICT");
    });
  }

  async publishPendingCanonicalFinalReport(runId:string,publish:(path:string,bytes:string)=>Promise<void>):Promise<{published:boolean;path:string|null}>{
    const pending=await this.database.query<{canonical_path:string;report_bytes:string}>(
      "SELECT canonical_path,report_bytes FROM reliability_final_report_outbox WHERE run_id=$1",[runId]);
    const row=pending.rows[0];if(!row)return {published:false,path:null};
    if(row.canonical_path!==canonicalFinalCommitPath(runId))throw new Error("FINAL_COMMIT_PATH_CONFLICT");
    await publish(row.canonical_path,row.report_bytes);
    await this.transaction(async client=>{
      const control=await client.query<{durable_stage:DurableReliabilityStage}>("SELECT durable_stage FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[runId]);
      if(control.rows[0]?.durable_stage!=="settled"&&control.rows[0]?.durable_stage!=="final_committed")throw new Error("SETTLEMENT_REQUIRED_BEFORE_FINAL_COMMIT");
      await client.query("UPDATE reliability_final_report_outbox SET published_at=COALESCE(published_at,clock_timestamp()) WHERE run_id=$1",[runId]);
      await client.query("UPDATE reliability_protocol_controls SET durable_stage='final_committed',state='complete' WHERE run_id=$1",[runId]);
    });
    return {published:true,path:row.canonical_path};
  }

  async publishPendingFailureReport(runId:string,publish:(path:string,value:unknown)=>Promise<void>):Promise<{published:boolean;paths:string[]}>{
    const pending=await this.database.query<{publication_items:Array<{path:string;bytes:string;digest:string}>;published_at:Date|null}>(`SELECT publication_items,published_at
      FROM reliability_failure_report_outbox WHERE run_id=$1`,[runId]);
    const row=pending.rows[0];if(!row)return {published:false,paths:[]};
    const paths:string[]=[];
    if(!Array.isArray(row.publication_items)||row.publication_items.length===0)throw new Error("FAILURE_PUBLICATION_ITEMS_REQUIRED");
    for(const item of row.publication_items){
      if(!item||typeof item.path!=="string"||typeof item.bytes!=="string"||!/^sha256:[a-f0-9]{64}$/.test(item.digest)
        ||`sha256:${createHash("sha256").update(item.bytes).digest("hex")}`!==item.digest)throw new Error("FAILURE_PUBLICATION_ITEM_INVALID");
      await publish(item.path,item.bytes);paths.push(item.path);
    }
    await this.transaction(async client=>{const updated=await client.query("UPDATE reliability_failure_report_outbox SET published_at=COALESCE(published_at,clock_timestamp()) WHERE run_id=$1 RETURNING 1",[runId]);if(!updated.rows[0])throw new Error("FAILURE_REPORT_OUTBOX_LOST");});
    return {published:true,paths};
  }

  async hardFinalizeReliabilityRun(input:{runId:string;deadlineMs:number;replayTargetRequestIds?:readonly string[]}):Promise<HardFinalizationPlan>{
    return this.transaction(async client=>{
      const control=await client.query<{state:"active"|"failed"|"complete";plan_fingerprint:string}>(
        "SELECT state,plan_fingerprint FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[input.runId]);
      if(!control.rows[0])throw new Error("PROTOCOL_CONTROL_NOT_FOUND");
      const attempts=await client.query<{request_id:string;admission_started:boolean;dispatch_token:boolean;primitive_entered:boolean}>(`SELECT attempt.request_id,
        attempt.admission_started_at IS NOT NULL admission_started, token.request_id IS NOT NULL dispatch_token,
        token.primitive_entered_at IS NOT NULL primitive_entered FROM reliability_protocol_attempts attempt
        LEFT JOIN reliability_dispatch_tokens token ON token.run_id=attempt.run_id AND token.request_id=attempt.request_id
        WHERE attempt.run_id=$1 AND attempt.terminal_at IS NULL ORDER BY attempt.request_id FOR UPDATE OF attempt`,[input.runId]);
      const now=await client.query<{now:Date}>("SELECT clock_timestamp() now");
      const nonterminal=attempts.rows.map(row=>row.request_id);
      const plan=planHardFinalization({databaseNowMs:now.rows[0]!.now.getTime(),deadlineMs:input.deadlineMs,
        runState:nonterminal.length===0?"terminal":control.rows[0].state==="active"?"active":"failed",nonterminalRequestIds:nonterminal});
      if(plan.action!=="finalize_failure")return plan;
      const byState=new Map<"not_dispatched"|"unresolved_provider_outcome",string[]>([["not_dispatched",[]],["unresolved_provider_outcome",[]]]);
      for(const row of attempts.rows)byState.get(hardFinalizationTerminalState({admissionStarted:row.admission_started,dispatchToken:row.dispatch_token,primitiveEntered:row.primitive_entered}))!.push(row.request_id);
      const terminalized:string[]=[];
      for(const [state,requestIds] of byState){
        if(!requestIds.length)continue;
        const updated=await client.query<{request_id:string}>(`UPDATE reliability_protocol_attempts SET state=$3,
          actual_cost_micros=CASE WHEN $3='not_dispatched' THEN 0 ELSE actual_cost_micros END,
          gate_classified_at=clock_timestamp(),terminal_at=clock_timestamp()
          WHERE run_id=$1 AND request_id=ANY($2::text[]) AND terminal_at IS NULL RETURNING request_id`,[input.runId,requestIds,state]);
        if(updated.rows.length!==requestIds.length)throw new Error("HARD_FINALIZATION_TERMINAL_CONFLICT");
        terminalized.push(...updated.rows.map(row=>row.request_id));
      }
      const unresolvedIds=byState.get("unresolved_provider_outcome")!;
      if(unresolvedIds.length)await client.query(`UPDATE inference_executions execution SET status='reconciliation_hold',failure_code='HARD_FINALIZATION_DEADLINE',updated_at=clock_timestamp()
        FROM reliability_sealed_calls sealed WHERE sealed.run_id=$1 AND sealed.request_id=execution.request_id
          AND sealed.organization_id=execution.organization_id AND sealed.request_id=ANY($2::text[])`,[input.runId,unresolvedIds]);
      await client.query(`UPDATE reliability_protocol_controls SET state='failed',failed_at=COALESCE(failed_at,clock_timestamp()),
        gate_classification_count=gate_classification_count+$2 WHERE run_id=$1`,[input.runId,terminalized.length]);
      await client.query("UPDATE reliability_protocol_lanes SET state='failed',resume_at=NULL WHERE run_id=$1",[input.runId]);
      await client.query("UPDATE reliability_dispatch_tokens SET canceled_at=COALESCE(canceled_at,clock_timestamp()) WHERE run_id=$1 AND primitive_entered_at IS NULL",[input.runId]);
      await client.query("UPDATE reliability_reconciliation_attempts SET phase='canceled_hard_finalization',canceled_at=COALESCE(canceled_at,clock_timestamp()) WHERE run_id=$1 AND canceled_at IS NULL AND phase IN ('scheduled','running')",[input.runId]);
      for(const requestId of terminalized){const state=byState.get("unresolved_provider_outcome")!.includes(requestId)?"unresolved_provider_outcome":"not_dispatched";await this.appendEvent(client,input.runId,requestId,"gate_classified",{state,reasonCode:plan.transition.reason});}
      const replayTargets=[...(input.replayTargetRequestIds??[])];
      if(replayTargets.length&& (replayTargets.length!==20||new Set(replayTargets).size!==20))throw new Error("REPLAY_CANCELLATION_INVENTORY_INVALID");
      for(const [index,requestId] of replayTargets.entries())await client.query(`INSERT INTO reliability_replay_cancellations(run_id,replay_no,request_id,reason)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[input.runId,index+1,requestId,plan.transition.reason]);
      const sequence=await this.appendIncident(client,input.runId,plan.incident.eventType,{requestIds:plan.terminalize,deadlineMs:input.deadlineMs});
      const reportIntent={kind:"create_only_failure_report",runId:input.runId,reason:plan.transition.reason,
        incidentSequence:sequence,publishByMs:plan.reportPublicationDeadlineMs};
      const common={evidenceType:"held-out-reliability",protocolVersion:2,runId:input.runId,planFingerprint:control.rows[0]!.plan_fingerprint};
      const values:Array<{path:string;value:Record<string,unknown>}>=[];
      for(const lane of ["normal-paced","high-envelope","bounded-burst","restart-resume"]){
        values.push({path:`evidence/.run-claims/held-out-reliability/${input.runId}/${lane}.claim`,value:{...common,artifactKind:"lane_claim",lane,state:"canceled",reason:plan.transition.reason}});
        for(let block=1;block<=5;block++)values.push({path:`evidence/held-out-reliability/manifests/${input.runId}/${lane}-${block}.json`,value:{...common,artifactKind:"manifest",lane,block,state:"canceled",reason:plan.transition.reason}});
      }
      values.push({path:`evidence/held-out-reliability/incidents/${input.runId}/${sequence}-hard_finalization_deadline.json`,value:{...common,artifactKind:"incident",sequence,eventType:"hard_finalization_deadline",state:"failed"}});
      values.push({path:canonicalFinalCommitPath(input.runId),value:{...common,artifactKind:"final_commit",state:"canceled",passed:false,reason:plan.transition.reason,incidentSequence:sequence}});
      const publicationItems=values.map(item=>{const bytes=`${JSON.stringify(item.value)}\n`;return {path:item.path,bytes,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`};});
      await client.query(`INSERT INTO reliability_failure_report_outbox(run_id,report_intent,publication_items,publish_by) VALUES($1,$2::jsonb,$3::jsonb,to_timestamp($4/1000.0))
        ON CONFLICT(run_id) DO NOTHING`,[input.runId,JSON.stringify(reportIntent),JSON.stringify(publicationItems),plan.reportPublicationDeadlineMs]);
      const exact=await client.query("SELECT 1 FROM reliability_failure_report_outbox WHERE run_id=$1 AND report_intent=$2::jsonb AND publication_items=$3::jsonb AND publish_by=to_timestamp($4/1000.0)",[input.runId,JSON.stringify(reportIntent),JSON.stringify(publicationItems),plan.reportPublicationDeadlineMs]);
      if(!exact.rows[0])throw new Error("IMMUTABLE_FAILURE_PUBLICATION_CONFLICT");
      return plan;
    });
  }

  async runAndPersistAuthoritativeSettlement(runId: string): Promise<AuthoritativeSettlementResult> {
    const gate=await this.database.query<{durable_stage:DurableReliabilityStage;state:string}>(
      "SELECT durable_stage,state FROM reliability_protocol_controls WHERE run_id=$1",[runId]);
    if(gate.rows[0]?.durable_stage!=="artifact_bound"||gate.rows[0]?.state!=="active")throw new Error("ARTIFACT_BINDING_REQUIRED_BEFORE_SETTLEMENT");
    const started=await this.database.query<{now:Date}>("SELECT clock_timestamp() now");
    const startMs=started.rows[0]!.now.getTime();
    const result=await runAuthoritativeSettlement({runId,primitives:{
      nowMs:()=>startMs,
      sleepUntil:async(epochMs)=>{while(true){const now=await this.database.query<{now:Date}>("SELECT clock_timestamp() now");const wait=epochMs-now.rows[0]!.now.getTime();if(wait<=0)return;await new Promise(r=>setTimeout(r,Math.min(wait,1000)));}},
      transaction:async(options,operation)=>{const connected=this.database.connect?await this.database.connect():this.database;const client=connected as any;try{
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");await client.query("SET LOCAL statement_timeout = '30000ms'");
        const begun=await client.query("SELECT clock_timestamp() now");const value=await operation(client);const finished=await client.query("SELECT clock_timestamp() now");await client.query("COMMIT");
        return {value,databaseStartedAtMs:begun.rows[0].now.getTime(),queryFinishedAtMs:finished.rows[0].now.getTime()};
      }catch(error){await client.query("ROLLBACK");throw error;}finally{const releasable=connected as {release?:()=>void};if(typeof releasable.release==="function")releasable.release();}},
    },readSnapshot:async(client:any)=>{
      const rows=await this.readEvidenceClosureRows(client,runId);
      const replayTargetRequestIds=[...rows.replayAudits].sort((a,b)=>a.replayNo-b.replayNo).map(item=>item.requestId);
      return {complete:evaluateSettlementSnapshotCompleteness({rows,replayTargetRequestIds}).complete,
        rows:rows as unknown as Readonly<Record<string,readonly unknown[]>>};
    }});
    await this.transaction(async client=>{
      await client.query("SELECT state FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[runId]);
      for(const entry of result.journal)await client.query(`INSERT INTO reliability_settlement_journal(run_id,poll_no,offset_seconds,snapshot_digest,complete,scheduled_at,started_at,query_finished_at,deadline_eligible,row_cardinality,error_code)
        VALUES($1,$2,$3,$4,$5,to_timestamp($6/1000.0),COALESCE(to_timestamp($7/1000.0),clock_timestamp()),to_timestamp($8/1000.0),$9,$10,$11) ON CONFLICT(run_id,poll_no) DO UPDATE SET snapshot_digest=EXCLUDED.snapshot_digest WHERE reliability_settlement_journal.snapshot_digest IS NOT DISTINCT FROM EXCLUDED.snapshot_digest`,
      [runId,entry.pollNo,entry.offsetSeconds,entry.snapshotDigest,entry.complete,entry.scheduledAtMs,entry.databaseStartedAtMs,entry.queryFinishedAtMs,entry.deadlineEligible,entry.rowCardinality,entry.errorCode]);
      await client.query(`INSERT INTO reliability_settlement_final_snapshots(run_id,snapshot_digest,journal_cardinality,accepted_offset_seconds,row_cardinality,passed,accepted_database_started_at,snapshot_rows)
        VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8::jsonb) ON CONFLICT(run_id) DO NOTHING`,[runId,result.finalSnapshot.digest,result.finalSnapshot.journalCardinality,result.acceptedOffsetSeconds,result.finalSnapshot.rowCardinality,result.passed,result.acceptedSnapshot?.databaseStartedAtMs??null,result.acceptedSnapshot?JSON.stringify(result.acceptedSnapshot.rows):null]);
      const exact=await client.query("SELECT 1 FROM reliability_settlement_final_snapshots WHERE run_id=$1 AND snapshot_digest IS NOT DISTINCT FROM $2 AND journal_cardinality=$3 AND accepted_offset_seconds IS NOT DISTINCT FROM $4 AND row_cardinality=$5 AND passed=$6 AND accepted_database_started_at IS NOT DISTINCT FROM to_timestamp($7/1000.0) AND snapshot_rows IS NOT DISTINCT FROM $8::jsonb",[runId,result.finalSnapshot.digest,result.finalSnapshot.journalCardinality,result.acceptedOffsetSeconds,result.finalSnapshot.rowCardinality,result.passed,result.acceptedSnapshot?.databaseStartedAtMs??null,result.acceptedSnapshot?JSON.stringify(result.acceptedSnapshot.rows):null]);
      if(!exact.rows[0])throw new Error("SETTLEMENT_FINAL_SNAPSHOT_CONFLICT");
    });
    return result;
  }

  async loadAuthoritativeEvidenceInventory(input: { runId:string; planFingerprint:string; requestIds:string[]; replayTargetRequestIds:string[];
    authorizationReceipts:AuthoritativeEvidenceInventory["authorizationReceipts"]; signedAuthorizations:AuthoritativeEvidenceInventory["signedAuthorizations"];
    claims:AuthoritativeEvidenceInventory["claims"]; manifests:AuthoritativeEvidenceInventory["manifests"]; artifactPaths:string[]; hardFinalizationDeadline:string;
  }):Promise<AuthoritativeEvidenceInventory>{
    const q=async<T=any>(sql:string,values:any[]=[input.runId])=>(await this.database.query<T & QueryResultRow>(sql,values)).rows as any[];
    const attempts=await q(`SELECT request_id "requestId",state,CASE WHEN gate_classified_at IS NULL THEN 0 ELSE 1 END "gateClassificationCount",admission_started_at IS NOT NULL "admissionStarted",actual_cost_micros::text "actualCostMicros",reserved_cost_micros::text "reservedCostMicros" FROM reliability_protocol_attempts WHERE run_id=$1`);
    const executions=await q(`SELECT execution.request_id "requestId",execution.status,execution.actual_cost_atomic::text "actualCostMicros",execution.shadow_order_state "shadowOrderState",execution.shadow_cohort_ordinal::int "cohortOrdinal" FROM inference_executions execution JOIN reliability_sealed_calls sealed ON sealed.organization_id=execution.organization_id AND sealed.request_id=execution.request_id WHERE sealed.run_id=$1`);
    const decisions=await q(`SELECT decision.request_id "requestId",decision.outcome FROM policy_decisions decision JOIN reliability_sealed_calls sealed ON sealed.organization_id=decision.organization_id AND sealed.request_id=decision.request_id WHERE sealed.run_id=$1`);
    const dispatchTokens=await q(`SELECT request_id "requestId",primitive_entered_at IS NOT NULL "primitiveEntered",canceled_at IS NOT NULL AND primitive_entered_at IS NULL "preDispatchProof" FROM reliability_dispatch_tokens WHERE run_id=$1`);
    const shadowQueue=await q(`SELECT queue.request_id "requestId",queue.state,queue.attempts FROM shadow_evaluation_queue queue JOIN reliability_sealed_calls sealed ON sealed.organization_id=queue.organization_id AND sealed.request_id=queue.request_id WHERE sealed.run_id=$1`);
    const shadowEvidence=await q(`SELECT evidence.request_id "requestId" FROM shadow_evaluations evidence JOIN reliability_sealed_calls sealed ON sealed.organization_id=evidence.organization_id AND sealed.request_id=evidence.request_id WHERE sealed.run_id=$1`);
    const replayAudits=await q(`SELECT request_id "requestId",replay_no "replayNo",original_response_commitment "originalResponseCommitment",replay_response_commitment "replayResponseCommitment",write_set "writeSet" FROM reliability_replay_audits WHERE run_id=$1`);
    const reconciliation=await q(`SELECT evidence.request_id "requestId",evidence.accepted,attempt.state "terminalState" FROM reliability_reconciliation_evidence evidence JOIN reliability_protocol_attempts attempt ON attempt.run_id=evidence.run_id AND attempt.request_id=evidence.request_id WHERE evidence.run_id=$1 AND attempt.terminal_at IS NOT NULL AND evidence.offset_seconds=(SELECT max(e2.offset_seconds) FROM reliability_reconciliation_evidence e2 WHERE e2.run_id=evidence.run_id AND e2.request_id=evidence.request_id)`);
    const incidentsRows=await q(`SELECT incident_sequence::int sequence,event_type "eventType" FROM reliability_protocol_incidents WHERE run_id=$1 ORDER BY incident_sequence`);
    const settlementRows=await q(`SELECT snapshot_digest "finalSnapshotDigest",journal_cardinality "journalCardinality",accepted_offset_seconds "acceptedOffsetSeconds",row_cardinality "finalRowCardinality",passed,committed_at FROM reliability_settlement_final_snapshots WHERE run_id=$1`);
    const control=(await q(`SELECT gate_classification_count,created_at FROM reliability_protocol_controls WHERE run_id=$1`))[0];const settlement=settlementRows[0];
    const known=attempts.reduce((s,r)=>r.state==="unresolved_provider_outcome"?s:s+BigInt(r.actualCostMicros??"0"),0n);const unresolved=attempts.reduce((s,r)=>r.state==="unresolved_provider_outcome"?s+BigInt(r.reservedCostMicros):s,0n);
    const incidents=incidentsRows.map(r=>({...r,path:`evidence/held-out-reliability/incidents/${input.runId}/${r.sequence}-${r.eventType}.json`}));
    return {runId:input.runId,planFingerprint:input.planFingerprint,requestIds:input.requestIds,replayTargetRequestIds:input.replayTargetRequestIds,attempts,executions,decisions,dispatchTokens,shadowQueue,shadowEvidence,replayAudits,
      authorizationReceipts:input.authorizationReceipts,signedAuthorizations:input.signedAuthorizations,claims:input.claims,manifests:input.manifests,reconciliation,incidents,
      settlement:{passed:settlement?.passed===true,acceptedOffsetSeconds:settlement?.acceptedOffsetSeconds??null,journalCardinality:settlement?.journalCardinality??0,finalSnapshotDigest:settlement?.finalSnapshotDigest??"",finalRowCardinality:settlement?.finalRowCardinality??0},
      costs:{knownCostMicros:known.toString(),unresolvedExposureMicros:unresolved.toString(),knownCostCapMicros:"3000000",unresolvedExposureCapMicros:"320000"},
      hardFinalization:{allTerminal:Number(control?.gate_classification_count)===input.requestIds.length,finalizedAt:settlement?.committed_at?.toISOString()??new Date(0).toISOString(),deadline:input.hardFinalizationDeadline},artifactPaths:input.artifactPaths};
  }

  async executeAuthenticatedSealedReplay(input: {
    operationId: string; organizationId: string; credentialId: string; agentId: string;
    mandateId: string; branchId: string | null; workloadClass: string | null;
    requestId: string; body: unknown;
  }): Promise<StableSuccessfulResponseProjection> {
    if (!/^replay-[0-9a-f-]{16,80}$/i.test(input.operationId)) throw new Error("REPLAY_OPERATION_ID_INVALID");
    if (!input.branchId || !input.workloadClass) throw new Error("REPLAY_TARGET_NOT_IMMUTABLE");
    const branchId=input.branchId,workloadClass=input.workloadClass;
    return this.transaction(async client=>{
      await client.query("SELECT set_config('fuse.replay_operation_id',$1,true)",[input.operationId]);
      const target=await client.query<{
          run_id:string;model:string;response_commitment:string;reservation_cost_micros:string;
          actual_cost_micros:string;decision_id:string;replay_ordinal:number;replay_state:string;
          durable_stage:string;response_projection:StableSuccessfulResponseProjection|null;response_json:ProviderResult;
        }>(`SELECT sealed.run_id,sealed.model,
            attempt.response_commitment,attempt.reserved_cost_micros::text reservation_cost_micros,
            attempt.actual_cost_micros::text actual_cost_micros,decision.id decision_id,replay_authorization.replay_ordinal,
            replay_authorization.state replay_state,replay_authorization.response_projection,control.durable_stage,
            execution.response_json
          FROM reliability_sealed_calls sealed
          JOIN reliability_protocol_attempts attempt ON attempt.run_id=sealed.run_id AND attempt.request_id=sealed.request_id
          JOIN reliability_protocol_controls control ON control.run_id=sealed.run_id
          JOIN inference_executions execution ON execution.organization_id=sealed.organization_id AND execution.request_id=sealed.request_id
          JOIN policy_decisions decision ON decision.organization_id=execution.organization_id AND decision.id=execution.decision_id
          JOIN reliability_replay_authorizations replay_authorization ON replay_authorization.run_id=sealed.run_id AND replay_authorization.request_id=sealed.request_id
          WHERE sealed.request_id=$1 AND sealed.organization_id=$2 AND sealed.credential_id=$3
            AND sealed.agent_id=$4 AND sealed.mandate_id=$5 AND sealed.branch_id=$6 AND sealed.workload_class=$7
            AND sealed.body_commitment=$8 AND sealed.request_body=$9::jsonb
            AND attempt.state IN ('completed_verified','reconciled_billed_with_response')
            AND attempt.response_commitment IS NOT NULL AND attempt.actual_cost_micros IS NOT NULL
            AND execution.status='completed' AND decision.outcome='ALLOW' AND decision.would_outcome='ALLOW'
            AND decision.enforced=true AND decision.reason_codes='[]'::jsonb
            AND replay_authorization.operation_id=$10 FOR UPDATE OF replay_authorization,control`,[
          input.requestId,input.organizationId,input.credentialId,input.agentId,input.mandateId,input.branchId,
          input.workloadClass,buildHttpBodyCommitment(input.body),JSON.stringify(input.body),input.operationId,
        ]);
      if(target.rows.length!==1)throw new Error("REPLAY_TARGET_NOT_IMMUTABLE");
      const sealed=target.rows[0]!;
      if(sealed.durable_stage!=="fresh_terminal"&&sealed.durable_stage!=="replay_terminal")throw new Error("REPLAY_STAGE_PREREQUISITE_UNMET");
      const persisted=sealed.response_json;
      if(!persisted||typeof persisted.id!=="string"||typeof persisted.content!=="string"
        ||!persisted.usage||!Number.isSafeInteger(persisted.usage.inputTokens)
        ||!Number.isSafeInteger(persisted.usage.outputTokens))throw new Error("REPLAY_PERSISTED_PROJECTION_CONFLICT");
      const projection:StableSuccessfulResponseProjection={
        id:persisted.id,object:"chat.completion",model:sealed.model,
        choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:persisted.content}}],
        usage:{prompt_tokens:persisted.usage.inputTokens,completion_tokens:persisted.usage.outputTokens,
          total_tokens:persisted.usage.inputTokens+persisted.usage.outputTokens},
        fuse:{decision:{id:sealed.decision_id,outcome:"ALLOW",wouldOutcome:"ALLOW",enforced:true,reasonCodes:[]},
          workloadScope:{branchId,workloadClass},reservationAtomic:sealed.reservation_cost_micros,
          actualCostAtomic:sealed.actual_cost_micros},
      };
      const commitment=buildResponseCommitment(projection);
      if(commitment!==sealed.response_commitment)throw new Error("REPLAY_COMMITMENT_MISMATCH");
      if(sealed.replay_state==="passed"){
        if(!sealed.response_projection||buildResponseCommitment(sealed.response_projection)!==commitment)throw new Error("REPLAY_PERSISTED_PROJECTION_CONFLICT");
        return projection;
      }
      if(sealed.replay_state!=="authorized")throw new Error("REPLAY_AUTHORIZATION_ALREADY_CONSUMED");
      const writes=await client.query("SELECT table_name,operation,row_identity FROM reliability_replay_write_audit WHERE operation_id=$1 ORDER BY audit_id",[input.operationId]);
      if(writes.rows.length)throw new Error("REPLAY_WRITE_SET_NOT_EMPTY");
      await client.query(`INSERT INTO reliability_replay_audits(run_id,request_id,replay_no,original_response_commitment,replay_response_commitment,write_set)
        VALUES($1,$2,$3,$4,$4,'[]'::jsonb)`,[sealed.run_id,input.requestId,sealed.replay_ordinal,commitment]);
      const passed=await client.query(`UPDATE reliability_replay_authorizations SET state='passed',completed_at=clock_timestamp(),response_projection=$4::jsonb
        WHERE run_id=$1 AND request_id=$2 AND operation_id=$3 AND state='authorized' RETURNING 1`,
      [sealed.run_id,input.requestId,input.operationId,JSON.stringify(projection)]);
      if(!passed.rows[0])throw new Error("REPLAY_COMPLETION_CONFLICT");
      return projection;
    },"replay");
  }

  async withReplayMutex<T>(input: { runId: string; requestId?: string; ownerId: string }, operation: (client: Queryable) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      // The transaction is already under the protocol-wide exclusive replay lock.
      await client.query(`INSERT INTO reliability_replay_mutex(run_id,request_id,owner_id,acquired_at)
        VALUES($1,'__global__',$2,clock_timestamp()) ON CONFLICT(run_id) DO UPDATE
        SET request_id='__global__',owner_id=EXCLUDED.owner_id,acquired_at=EXCLUDED.acquired_at`,[input.runId,input.ownerId]);
      return operation(client);
    }, "replay");
  }

  async completeReplayRun(runId:string):Promise<void>{
    await this.transaction(async client=>{
      const control=await client.query<{durable_stage:string}>("SELECT durable_stage FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE",[runId]);
      if(!control.rows[0]||!['fresh_terminal','replay_terminal'].includes(control.rows[0].durable_stage))throw new Error("REPLAY_STAGE_PREREQUISITE_UNMET");
      const rows=await client.query<{replay_ordinal:number;request_id:string;state:string;audited:boolean|number}>(`SELECT authorization.replay_ordinal,authorization.request_id,authorization.state,
        (count(audit.request_id)=1) audited FROM reliability_replay_authorizations authorization
        LEFT JOIN reliability_replay_audits audit ON audit.run_id=authorization.run_id
          AND audit.request_id=authorization.request_id AND audit.replay_no=authorization.replay_ordinal
        WHERE authorization.run_id=$1 GROUP BY authorization.replay_ordinal,authorization.request_id,authorization.state
        ORDER BY authorization.replay_ordinal`,[runId]);
      if(rows.rows.length!==20||new Set(rows.rows.map(row=>row.request_id)).size!==20
        ||rows.rows.some((row,index)=>row.replay_ordinal!==index+1||row.state!=="passed"||!(row.audited===true||row.audited===1)))
        throw new Error("REPLAY_INVENTORY_INCOMPLETE");
      await client.query("UPDATE reliability_protocol_controls SET replay_passed_count=20,durable_stage='replay_terminal' WHERE run_id=$1 AND durable_stage IN ('fresh_terminal','replay_terminal')",[runId]);
    });
  }

  async recordReplayAudit(input: { runId: string; requestId: string; replayNo: number; originalResponseCommitment: string; replayResponseCommitment: string; writeSet: readonly string[] }): Promise<void> {
    if(input.originalResponseCommitment!==input.replayResponseCommitment) throw new Error("REPLAY_COMMITMENT_MISMATCH");
    if(input.writeSet.length) throw new Error("REPLAY_WRITE_SET_NOT_EMPTY");
    await this.transaction(async client=>{await client.query(`INSERT INTO reliability_replay_audits(run_id,request_id,replay_no,original_response_commitment,replay_response_commitment,write_set)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[input.runId,input.requestId,input.replayNo,input.originalResponseCommitment,input.replayResponseCommitment,JSON.stringify(input.writeSet)]);});
  }

  async appendSettlementPoll(input: { runId: string; pollNo: number; offsetSeconds: number; snapshotDigest: string; complete: boolean }): Promise<void> {
    const exact=Array.from({length:25},(_,index)=>index*5);
    if(exact[input.pollNo-1]!==input.offsetSeconds) throw new Error("SETTLEMENT_OFFSET_INVALID");
    await this.transaction(async client=>{await client.query("INSERT INTO reliability_settlement_journal(run_id,poll_no,offset_seconds,snapshot_digest,complete) VALUES($1,$2,$3,$4,$5)",[input.runId,input.pollNo,input.offsetSeconds,input.snapshotDigest,input.complete]);});
  }

  async finalizeSettlement(input: { runId: string; snapshotDigest: string; acceptedOffsetSeconds: number | null }): Promise<void> {
    await this.transaction(async (client)=>{
      const rows=await client.query<{poll_no:number;offset_seconds:number;complete:boolean}>("SELECT poll_no,offset_seconds,complete FROM reliability_settlement_journal WHERE run_id=$1 ORDER BY poll_no FOR UPDATE",[input.runId]);
      const exact=Array.from({length:25},(_,index)=>index*5);
      if(rows.rows.length!==25 || rows.rows.some((row,index)=>row.poll_no!==index+1||row.offset_seconds!==exact[index])) throw new Error("SETTLEMENT_JOURNAL_INVALID");
      const accepted=rows.rows.find((row)=>row.complete)?.offset_seconds??null;
      if(accepted!==input.acceptedOffsetSeconds) throw new Error("SETTLEMENT_FINAL_SNAPSHOT_CONFLICT");
      await client.query("INSERT INTO reliability_settlement_final_snapshots(run_id,snapshot_digest,journal_cardinality,accepted_offset_seconds) VALUES($1,$2,$3,$4)",[input.runId,input.snapshotDigest,rows.rows.length,input.acceptedOffsetSeconds]);
    });
  }

  private async failProtocolLocked(client: Queryable, runId: string, reason: string): Promise<void> {
    const row = await client.query<{ state: string; failure_sequence: string }>(
      "SELECT state,failure_sequence::text FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE", [runId],
    );
    if (!row.rows[0]) throw new Error("PROTOCOL_CONTROL_NOT_FOUND");
    if (row.rows[0].state !== "active") return;
    const sequence = Number(row.rows[0].failure_sequence) + 1;
    await client.query("UPDATE reliability_protocol_controls SET state='failed',failure_sequence=$2,failed_at=clock_timestamp() WHERE run_id=$1", [runId,sequence]);
    const canceled = await client.query<{ request_id: string; lane_id: string }>(`UPDATE reliability_dispatch_tokens token SET canceled_at=clock_timestamp()
      WHERE token.run_id=$1 AND token.primitive_entered_at IS NULL AND token.canceled_at IS NULL
        AND token.lane_id='bounded-burst'
        AND NOT EXISTS (SELECT 1 FROM reliability_protocol_attempts owner_attempt
          JOIN reliability_burst_barriers barrier ON barrier.run_id=owner_attempt.run_id
            AND barrier.lane_id=owner_attempt.lane_id AND barrier.block_no=owner_attempt.block_no
          WHERE owner_attempt.run_id=token.run_id AND owner_attempt.request_id=token.request_id AND barrier.state='released')
      RETURNING token.request_id,token.lane_id`,[runId]);
    await client.query("UPDATE reliability_burst_barriers SET state='canceled',canceled_at=clock_timestamp() WHERE run_id=$1 AND state <> 'released'",[runId]);
    const terminalized = await client.query<{ request_id: string }>(`UPDATE reliability_protocol_attempts attempt
      SET state='not_dispatched',actual_cost_micros=0,gate_classified_at=clock_timestamp(),terminal_at=clock_timestamp()
      WHERE attempt.run_id=$1 AND attempt.gate_classified_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM reliability_dispatch_tokens token WHERE token.run_id=attempt.run_id
          AND token.request_id=attempt.request_id AND (token.primitive_entered_at IS NOT NULL
            OR (token.canceled_at IS NULL AND (token.lane_id<>'bounded-burst' OR EXISTS (
              SELECT 1 FROM reliability_burst_barriers barrier WHERE barrier.run_id=attempt.run_id
                AND barrier.lane_id=attempt.lane_id AND barrier.block_no=attempt.block_no AND barrier.state='released')))))
      RETURNING attempt.request_id`,[runId]);
    if (terminalized.rows.length) await client.query("UPDATE reliability_protocol_controls SET gate_classification_count=gate_classification_count+$2 WHERE run_id=$1",[runId,terminalized.rows.length]);
    const canceledIds = new Set(canceled.rows.map((item)=>item.request_id));
    for (const item of terminalized.rows) {
      if (canceledIds.has(item.request_id)) await this.appendEvent(client,runId,item.request_id,"barrier_canceled_before_dispatch",{});
      await this.appendEvent(client,runId,item.request_id,"gate_classified",{ state: "not_dispatched", reasonCode: reason });
    }
    await this.appendIncident(client,runId,"global_failure",{ reason,sequence });
  }

  private async appendEvent(client: Queryable, runId: string, requestId: string | null, eventType: string, payload: unknown): Promise<number> {
    const sequence=await client.query<{event_sequence:string}>("UPDATE reliability_protocol_controls SET next_event_sequence=next_event_sequence+1 WHERE run_id=$1 RETURNING (next_event_sequence-1)::text event_sequence",[runId]);
    if(!sequence.rows[0]) throw new Error("PROTOCOL_CONTROL_NOT_FOUND");
    const value=Number(sequence.rows[0].event_sequence);
    await client.query("INSERT INTO reliability_protocol_events(run_id,event_sequence,request_id,event_type,payload) VALUES($1,$2,$3,$4,$5::jsonb)",[runId,value,requestId,eventType,JSON.stringify(payload)]);
    return value;
  }

  private async appendIncident(client: Queryable, runId: string, eventType: string, evidence: unknown): Promise<number> {
    const sequence=await client.query<{incident_sequence:string}>("UPDATE reliability_protocol_controls SET next_incident_sequence=next_incident_sequence+1 WHERE run_id=$1 RETURNING (next_incident_sequence-1)::text incident_sequence",[runId]);
    if(!sequence.rows[0]) throw new Error("PROTOCOL_CONTROL_NOT_FOUND");
    const value=Number(sequence.rows[0].incident_sequence);
    await client.query("INSERT INTO reliability_protocol_incidents(run_id,incident_sequence,event_type,evidence) VALUES($1,$2,$3,$4::jsonb)",[runId,value,eventType,JSON.stringify(evidence)]);
    return value;
  }

  private async lockControlLane(client: Queryable, runId: string, laneId: string): Promise<string> {
    const control = await client.query<{ state: string }>("SELECT state FROM reliability_protocol_controls WHERE run_id=$1 FOR UPDATE", [runId]);
    if (!control.rows[0]) throw new Error("PROTOCOL_CONTROL_NOT_FOUND");
    const lane = await client.query("SELECT state FROM reliability_protocol_lanes WHERE run_id=$1 AND lane_id=$2 FOR UPDATE", [runId, laneId]);
    if (!lane.rows[0]) throw new Error("PROTOCOL_LANE_NOT_FOUND");
    return control.rows[0].state;
  }
  private async transactionOnClient<T>(client:Queryable,operation:()=>Promise<T>):Promise<T>{
    try{await client.query("BEGIN");const value=await operation();await client.query("COMMIT");return value;}
    catch(error){await client.query("ROLLBACK");throw error;}
  }
  private async transaction<T>(operation: (client: Queryable) => Promise<T>, exclusion:"ordinary"|"replay"="ordinary"): Promise<T> {
    const connected = this.database.connect ? await this.database.connect() : this.database;
    const client = connected as unknown as Queryable;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('lock_timeout',$1,true)", ["5000ms"]);
      if (exclusion === "replay") await acquireReplayExclusion(client);
      else await acquireOrdinaryMutationExclusion(client);
      const replayOperation = currentTrustedReplayOperation();
      if (replayOperation) await client.query("SELECT set_config('fuse.replay_operation_id',$1,true)", [replayOperation]);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally {
      const releasable = connected as unknown as { release?: () => void };
      if (typeof releasable.release === "function") releasable.release();
    }
  }
}
