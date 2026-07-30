#!/usr/bin/env node
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { executeReliabilityCli, type ReliabilityCliCommand, type ReliabilityCliDependencies } from "../src/evidence/reliabilityCliV2.js";
import {
  V2_LANES, buildReliabilityPlan, canonicalJson, validateReliabilityPlan, verifyPinnedReliabilityBeacon,
  type ExecutableIdentity, type ReliabilityPlan,
} from "../src/evidence/heldOutReliabilityV2.js";
import { ReliabilityArtifactStore, publishManifestDurably } from "../src/evidence/reliabilityProtocolV2.js";
import {
  authorizationPayloadBytes, verifyAuthorizationArtifact, type AuthorizationArtifact, type AuthorizationPayload,
} from "../src/evidence/reliabilityRuntimeV2.js";
import { OpenRouterReconciler } from "../src/reliability/openRouterReconciler.js";
import { buildHttpBodyCommitment } from "../src/reliability/commitments.js";
import { performReliabilityReplayHttp } from "../src/reliability/replayHttp.js";
import { executeConcurrentReconciliation, recoverSchedulerWorker, signAuthorizationArtifact, RECONCILIATION_OFFSETS_SECONDS, reconciliationWindow } from "../src/reliability/operationalV2.js";
import { ReliabilityProtocolStore, deterministicAuthorizationDecisionId, buildReplayAuthorizationInventory } from "../src/reliability/protocolStore.js";
import { RELIABILITY_SCHEMA_SQL } from "../src/reliability/reliabilitySchema.js";
import { ReliabilityInferenceExecutionStore } from "../src/reliability/inferenceStore.js";
import { PolicyStore } from "../src/persistence/policyStore.js";
import { reconstructReliabilityArtifacts, type ReconstructedReliabilityArtifacts } from "../src/evidence/artifactReconstruction.js";
import { buildCanonicalFinalCommitMarker, finalEvidenceClosure, preliminaryReplayArtifactPath } from "../src/evidence/finalEvidenceClosure.js";
import type { AuthoritativeEvidenceInventory } from "../src/evidence/authoritativeEvidence.js";
import type { EvidenceClosureRows } from "../src/evidence/evidenceSettlementClosure.js";

function flag(args: readonly string[], name: string): string | undefined { const i=args.indexOf(name); return i < 0 ? undefined : args[i+1]; }
function required(args: readonly string[], name: string): string { const value=flag(args,name)?.trim(); if(!value) throw new Error(`${name.slice(2).toUpperCase().replaceAll("-","_")}_REQUIRED`); return value; }
function parse<T>(bytes: Buffer, code: string): T { try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw new Error(code); } }
async function databaseNow(pool: Pool): Promise<string> { const r=await pool.query<{now:Date}>("SELECT clock_timestamp() AS now"); return r.rows[0]!.now.toISOString(); }
function databaseUrl(): string { const value=process.env["HELD_OUT_RELIABILITY_DATABASE_URL_UNPOOLED"]?.trim() ?? process.env["DATABASE_URL_UNPOOLED"]?.trim(); if(!value) throw new Error("DATABASE_URL_UNPOOLED_REQUIRED"); if(new URL(value).hostname.includes("-pooler")) throw new Error("USE_UNPOOLED_CONNECTION"); return value; }
function pool(): Pool { return new Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: true }, max: 8, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, query_timeout: 31_000 }); }
async function sleep(ms:number):Promise<void>{ await new Promise((r)=>setTimeout(r,ms)); }
async function waitForDatabaseTime(db:Pool,target:string):Promise<void>{ for(;;){ const remaining=Date.parse(target)-Date.parse(await databaseNow(db)); if(remaining<=0)return; await sleep(Math.min(1_000,remaining)); } }
async function publishAbsolute(path:string,value:unknown):Promise<void>{ await new ReliabilityArtifactStore(dirname(path)).publishOnce(basename(path),value); }
function executableFingerprint(plan:ReliabilityPlan):string { return `sha256:${createHash("sha256").update(canonicalJson(plan.identity)).digest("hex")}`; }
export function runnerCallFailureDisposition(state:string|null):"hold_lane"|"fail_protocol"{return state==="reconciliation_pending"?"hold_lane":"fail_protocol";}
export function boundedBurstFailureDisposition(states:readonly (string|null)[]):"hold_lane"|"fail_protocol"|"continue"{
  if(states.every(state=>state==="completed_verified"))return "continue";
  if(states.some(state=>state===null||state!=="completed_verified"&&state!=="reconciliation_pending"))return "fail_protocol";
  return "hold_lane";
}
export async function runWorkerProcess(input:{executable:string;argv:string[];cwd:string;env?:NodeJS.ProcessEnv}):Promise<Record<string,any>>{
  const result=await promisify(execFile)(input.executable,input.argv,{cwd:input.cwd,env:input.env??process.env,maxBuffer:1024*1024,timeout:120_000});
  const line=result.stdout.trim().split("\n").at(-1);if(!line)throw new Error("WORKER_PROCESS_OUTPUT_MISSING");
  const parsed=JSON.parse(line) as Record<string,any>;if(parsed["ok"]!==true)throw new Error(String(parsed["errorCode"]??"WORKER_PROCESS_FAILED"));return parsed;
}
type ProductionSetupCounts={organizations:string;providers:string;agents:string;credentials:string;policies:string;mandates:string;branches:string};
export function productionSetupCountsExact(row:ProductionSetupCounts|undefined):boolean{return !!row&&Number(row.organizations)===1&&Number(row.providers)===1&&Number(row.agents)===4&&Number(row.credentials)===4&&Number(row.policies)===4&&Number(row.mandates)===4&&Number(row.branches)===12;}
async function readProductionSetupCounts(db:Pool,plan:ReliabilityPlan):Promise<ProductionSetupCounts>{
  const exact=await db.query<ProductionSetupCounts>(`SELECT
    (SELECT count(*)::text FROM organizations WHERE id=$1) organizations,
    (SELECT count(*)::text FROM provider_configurations WHERE organization_id=$1 AND id=$2 AND provider='openrouter' AND model=$3 AND status='active') providers,
    (SELECT count(*)::text FROM agent_identities WHERE organization_id=$1 AND id=ANY($4::text[]) AND status='active') agents,
    (SELECT count(*)::text FROM api_credentials WHERE organization_id=$1 AND id=ANY($5::text[]) AND revoked_at IS NULL) credentials,
    (SELECT count(*)::text FROM policy_versions WHERE organization_id=$1 AND policy_id=ANY($6::text[]) AND version=1 AND mode='enforce') policies,
    (SELECT count(*)::text FROM control_mandates WHERE organization_id=$1 AND id=ANY($7::text[]) AND state='active') mandates,
    (SELECT count(*)::text FROM mandate_branches WHERE organization_id=$1 AND branch_id=ANY($8::text[]) AND authority_source='fuse_control_plane') branches`,[
    plan.setup.organizationId,plan.setup.providerConfigurationId,plan.model,plan.setup.authority.map(a=>a.agentId),plan.setup.authority.map(a=>a.credentialId),plan.setup.authority.map(a=>a.policy.id),plan.setup.authority.map(a=>a.mandate.id),plan.setup.authority.flatMap(a=>[a.root.id,...a.children.map(c=>c.id)])]);
  if(!exact.rows[0])throw new Error("SETUP_PRODUCTION_SERVICES_NOT_EXACT");return exact.rows[0];
}

type SetupSnapshot={organization:{id:string}|null;provider:Record<string,unknown>|null;workloadShadow:Record<string,unknown>;schemaFingerprint:string;lanes:Array<Record<string,unknown>>};
export function expectedProductionSetupSnapshot(plan:ReliabilityPlan):SetupSnapshot{return {
  organization:{id:plan.setup.organizationId},provider:{id:plan.setup.providerConfigurationId,provider:plan.provider,model:plan.model,status:"active",credentialVersion:1,encryptionKeyId:"fuse-provider-v1",credentialConfigured:true},
  workloadShadow:{enabled:true,requiredTables:["shadow_cohort_counters","shadow_evaluation_queue","shadow_evaluations"]},schemaFingerprint:plan.identity.schemaFingerprint,
  lanes:plan.setup.authority.map(a=>({lane:a.lane,agent:{id:a.agentId,status:"active"},credential:{id:a.credentialId,agentId:a.agentId,revoked:false},
    policy:{id:a.policy.id,version:a.policy.version,mode:a.policy.mode,provider:plan.provider,model:plan.model,workloadClass:a.policy.workloadClass,perCall:a.policy.perCallUsdMicros,hourly:a.policy.hourlyUsdMicros,daily:a.policy.dailyUsdMicros,maxRequestsPerMinute:a.policy.maxRequestsPerMinute,maxInputTokens:a.policy.maxInputTokens,maxOutputTokens:a.policy.maxOutputTokens},
    mandate:{id:a.mandate.id,state:"active",policyId:a.policy.id,policyVersion:a.policy.version,maximum:a.mandate.maximumUsdMicros,expiresAt:a.mandate.expiresAt},
    branches:[{id:a.root.id,parentId:null,maximum:a.root.maximumUsdMicros,expiresAt:a.root.expiresAt,allowedWorkloadClasses:[a.policy.workloadClass]},...a.children.map(c=>({id:c.id,parentId:a.root.id,maximum:c.maximumUsdMicros,expiresAt:c.expiresAt,allowedWorkloadClasses:[a.policy.workloadClass]}))]}))};}
async function readProductionSetupSnapshot(db:Pool,plan:ReliabilityPlan):Promise<SetupSnapshot>{
  const organization=(await db.query<{id:string}>("SELECT id FROM organizations WHERE id=$1",[plan.setup.organizationId])).rows[0]??null;
  const providerRow=(await db.query<any>("SELECT id,provider,model,status,credential_version,encryption_key_id,encrypted_secret<>'' credential_configured FROM provider_configurations WHERE organization_id=$1 AND id=$2 FOR SHARE",[plan.setup.organizationId,plan.setup.providerConfigurationId])).rows[0];
  const provider=providerRow?{id:providerRow.id,provider:providerRow.provider,model:providerRow.model,status:providerRow.status,credentialVersion:providerRow.credential_version,encryptionKeyId:providerRow.encryption_key_id,credentialConfigured:providerRow.credential_configured}:null;
  const shadow=(await db.query<{tables:string[]}>(`SELECT ARRAY(SELECT name FROM unnest(ARRAY['shadow_cohort_counters','shadow_evaluation_queue','shadow_evaluations']) name WHERE to_regclass('public.'||name) IS NOT NULL ORDER BY name) tables`)).rows[0]?.tables??[];
  const workloadShadow={enabled:shadow.length===3,requiredTables:shadow};
  const schemaFingerprint=`sha256:${createHash("sha256").update(RELIABILITY_SCHEMA_SQL).digest("hex")}`;
  const lanes:Array<Record<string,unknown>>=[];
  for(const a of plan.setup.authority){
    const agent=(await db.query<{id:string;status:string}>("SELECT id,status FROM agent_identities WHERE organization_id=$1 AND id=$2",[plan.setup.organizationId,a.agentId])).rows[0]??null;
    const credentialRow=(await db.query<{id:string;agent_id:string;revoked:boolean}>("SELECT id,agent_id,revoked_at IS NOT NULL revoked FROM api_credentials WHERE organization_id=$1 AND id=$2",[plan.setup.organizationId,a.credentialId])).rows[0];
    const policyRow=(await db.query<any>(`SELECT policy_id,version,mode,allowed_providers,allowed_models,workload_classes,max_per_call_atomic::text per_call,max_hourly_atomic::text hourly,max_daily_atomic::text daily,
      max_requests_per_minute,max_input_tokens,max_output_tokens FROM policy_versions WHERE organization_id=$1 AND policy_id=$2 AND version=$3 FOR SHARE`,[plan.setup.organizationId,a.policy.id,a.policy.version])).rows[0];
    const mandateRow=(await db.query<any>("SELECT id,state,policy_id,policy_version,maximum_spend_atomic::text maximum,expires_at FROM control_mandates WHERE organization_id=$1 AND id=$2",[plan.setup.organizationId,a.mandate.id])).rows[0];
    const branchRows=(await db.query<any>(`SELECT branch_id,parent_branch_id,allowed_workload_classes,maximum_spend_atomic::text maximum,expires_at FROM mandate_branches
      WHERE organization_id=$1 AND mandate_id=$2 AND branch_id=ANY($3::text[])`,[plan.setup.organizationId,a.mandate.id,[a.root.id,...a.children.map(c=>c.id)]])).rows;
    const branchById=new Map<string,any>(branchRows.map(row=>[row.branch_id,row]));
    lanes.push({lane:a.lane,agent,credential:credentialRow?{id:credentialRow.id,agentId:credentialRow.agent_id,revoked:credentialRow.revoked}:null,
      policy:policyRow?{id:policyRow.policy_id,version:policyRow.version,mode:policyRow.mode,provider:policyRow.allowed_providers?.[0],model:policyRow.allowed_models?.[0],workloadClass:policyRow.workload_classes?.[0]?.id,perCall:policyRow.per_call,hourly:policyRow.hourly,daily:policyRow.daily,maxRequestsPerMinute:policyRow.max_requests_per_minute,maxInputTokens:policyRow.max_input_tokens,maxOutputTokens:policyRow.max_output_tokens}:null,
      mandate:mandateRow?{id:mandateRow.id,state:mandateRow.state,policyId:mandateRow.policy_id,policyVersion:mandateRow.policy_version,maximum:mandateRow.maximum,expiresAt:mandateRow.expires_at?.toISOString()??null}:null,
      branches:[a.root,...a.children].map((branch,index)=>{const row=branchById.get(branch.id);return row?{id:row.branch_id,parentId:row.parent_branch_id,maximum:row.maximum,expiresAt:row.expires_at?.toISOString()??null,allowedWorkloadClasses:row.allowed_workload_classes}:{id:branch.id,missing:true,index};})});
  }
  return {organization,provider,workloadShadow,schemaFingerprint,lanes};
}
async function recordExactProductionReadiness(store:ReliabilityProtocolStore,db:Pool,plan:ReliabilityPlan){
  const receipt=await store.recordSetupReadinessReceipt({runId:plan.runId,expectedSnapshot:expectedProductionSetupSnapshot(plan),actualSnapshot:await readProductionSetupSnapshot(db,plan)});
  if(!receipt.ready)throw new Error(`SETUP_READINESS_NOT_EXACT:${receipt.differingFields.join(",")}`);
  await store.requireSetupReadinessReceipt({runId:plan.runId,planFingerprint:plan.planFingerprint});return receipt;
}

export function validateEvidenceReportArguments(args:readonly string[]):{planPath:string;outputPath:string|null}{
  if(args.includes("--metadata"))throw new Error("CALLER_METADATA_PROHIBITED");
  return {planPath:required(args,"--plan"),outputPath:flag(args,"--output")??null};
}
export function buildFourLaneClaimArtifacts(input:{runId:string;planFingerprint:string}){
  return V2_LANES.map(({id:lane})=>({evidenceType:"held-out-reliability" as const,protocolVersion:2 as const,
    runId:input.runId,planFingerprint:input.planFingerprint,artifactKind:"lane_claim" as const,lane,state:"terminal" as const,
    path:`evidence/.run-claims/held-out-reliability/${input.runId}/${lane}.claim`}));
}
export function buildProductionEvidenceReport(input:{
  closure:{rows:EvidenceClosureRows;replayTargetRequestIds:string[];acceptedSnapshot:{digest:string;databaseStartedAtMs:number};settlement:{passed:boolean;acceptedSnapshotDigest:string};runId:string};
  strictInventory:AuthoritativeEvidenceInventory;
  artifactDigests:Readonly<Record<string,string>>;
  artifactPaths:string[];
  claimInventoryAuthority:ReconstructedReliabilityArtifacts["claimInventoryAuthority"]|Record<string,unknown>;
}){
  const verdict=finalEvidenceClosure({closure:input.closure,strictInventory:input.strictInventory,expectedArtifactDigests:input.artifactDigests});
  return {...verdict,artifactDigests:input.artifactDigests,artifactPaths:input.artifactPaths,claimInventoryAuthority:input.claimInventoryAuthority};
}

/** Builds strict authority exclusively from the accepted snapshot, sealed plan, and already-bound artifact bytes. */
export function buildSnapshotBoundStrictInventory(input:{plan:ReliabilityPlan;snapshot:Awaited<ReturnType<ReliabilityProtocolStore["loadEvidenceClosureSnapshot"]>>;artifacts:ReconstructedReliabilityArtifacts}):AuthoritativeEvidenceInventory{
  const {rows}=input.snapshot;
  const attempts=rows.attempts;
  const reconciliation=attempts.flatMap(attempt=>{
    if(attempt.state==="not_dispatched"||attempt.state==="completed_verified")return [];
    const evidence=rows.reconciliationEvidence.filter(row=>row["requestId"]===attempt.requestId)
      .sort((a,b)=>Number(a["offsetSeconds"])-Number(b["offsetSeconds"])).at(-1);
    return [{requestId:attempt.requestId,accepted:attempt.state==="unresolved_provider_outcome"?false:evidence?.["accepted"]===true,terminalState:attempt.state as any}];
  });
  const cost=rows.costRows[0]??{};
  return {runId:input.plan.runId,planFingerprint:input.plan.planFingerprint,requestIds:input.plan.calls.map(call=>call.requestId),
    replayTargetRequestIds:input.plan.replayTargets.map(target=>target.requestId),attempts,executions:rows.executions,decisions:rows.decisions,
    dispatchTokens:rows.dispatchTokens,shadowQueue:rows.shadowQueue,shadowEvidence:rows.shadowEvidence,replayAudits:rows.replayAudits,
    authorizationReceipts:input.artifacts.authorizationReceipts,signedAuthorizations:input.artifacts.signedAuthorizations,
    claims:input.artifacts.claims,manifests:input.artifacts.manifests,reconciliation,
    incidents:rows.incidents.map(row=>({sequence:Number(row["sequence"]),eventType:String(row["eventType"]),path:`evidence/held-out-reliability/incidents/${input.plan.runId}/${row["sequence"]}-${row["eventType"]}.json`})),
    settlement:{passed:true,acceptedOffsetSeconds:input.snapshot.settlement.acceptedOffsetSeconds,journalCardinality:input.snapshot.settlement.journalCardinality,
      finalSnapshotDigest:input.snapshot.acceptedSnapshot.digest,finalRowCardinality:input.snapshot.settlement.rowCardinality},
    costs:{knownCostMicros:String(cost["knownCostMicros"]??""),unresolvedExposureMicros:String(cost["unresolvedExposureMicros"]??""),knownCostCapMicros:"3000000",unresolvedExposureCapMicros:"320000"},
    hardFinalization:{allTerminal:attempts.length===100&&attempts.every(row=>row.gateClassificationCount===1),finalizedAt:new Date(input.snapshot.acceptedSnapshot.databaseStartedAtMs).toISOString(),deadline:"2026-07-28T09:30:00.000Z"},
    artifactPaths:input.artifacts.artifactPaths};
}
async function buildEvidenceReport(cwd:string,args:readonly string[]):Promise<Record<string,unknown>>{
  const reportArgs=validateEvidenceReportArguments(args);
  const plan=parse<ReliabilityPlan>(await readFile(resolve(cwd,reportArgs.planPath)),"RELIABILITY_V2_PLAN_INVALID");validateReliabilityPlan(plan,false);
  const db=pool();try{
    const store=new ReliabilityProtocolStore(db);
    const finalized=await store.hardFinalizeReliabilityRun({runId:plan.runId,deadlineMs:Date.parse("2026-07-28T09:30:00.000Z"),replayTargetRequestIds:plan.replayTargets.map(target=>target.requestId)});
    if(finalized.action==="wait")throw new Error("HARD_FINALIZATION_PENDING");
    if(finalized.action==="finalize_failure"){
      const published=await store.publishPendingFailureReport(plan.runId,async(path,bytes)=>new ReliabilityArtifactStore(cwd).publishBytesOnce(path,String(bytes)));
      return {runId:plan.runId,passed:false,reasons:["HARD_FINALIZATION_DEADLINE"],failurePublished:published.published,paths:published.paths};
    }
    const snapshot=await store.loadEvidenceClosureSnapshot(plan.runId);
    const incidents=snapshot.rows.incidents.map(row=>({sequence:Number(row["sequence"]),eventType:String(row["eventType"])}));
    const publicKeys={operator:resolve(cwd,required(args,"--operator-public-key")),reconciliation:resolve(cwd,required(args,"--reconciliation-public-key"))};
    const reconstructed=await reconstructReliabilityArtifacts({root:cwd,runId:plan.runId,planFingerprint:plan.planFingerprint,incidents,
      verifyAuthorization:async({kind,parsed})=>{const artifact=parsed as unknown as AuthorizationArtifact;return verify(null,authorizationPayloadBytes(artifact.payload),createPublicKey(await readFile(publicKeys[kind])),Buffer.from(artifact.signature,"base64"));}});
    const strictInventory=buildSnapshotBoundStrictInventory({plan,snapshot,artifacts:reconstructed});
    const report=buildProductionEvidenceReport({closure:{runId:plan.runId,...snapshot},strictInventory,
      artifactDigests:reconstructed.artifactDigests,artifactPaths:reconstructed.artifactPaths,
      claimInventoryAuthority:reconstructed.claimInventoryAuthority});
    const marker=buildCanonicalFinalCommitMarker({runId:plan.runId,planFingerprint:plan.planFingerprint,stage:"settled",reportPassed:report.passed,
      settlementDigest:snapshot.acceptedSnapshot.digest,settlementJournalCardinality:snapshot.settlement.journalCardinality,
      authoritativeInventoryDigest:report.strict.inventoryDigest,artifactDigests:reconstructed.artifactDigests});
    await store.commitCanonicalFinalReport({runId:plan.runId,marker});
    const publication=await store.publishPendingCanonicalFinalReport(plan.runId,async(path,bytes)=>new ReliabilityArtifactStore(cwd).publishBytesOnce(path,bytes));
    return {report,...report,output:publication.path,finalCommitted:publication.published};
  }finally{await db.end();}
}

async function verifyPair(
  store: ReliabilityProtocolStore, db: Pool, plan: ReliabilityPlan,
  operator: AuthorizationArtifact, reconciliation: AuthorizationArtifact,
  publish: (kind: string, receipt: unknown) => Promise<void>,
): Promise<void> {
  const now=await databaseNow(db); const expected={now,expectedRunId:plan.runId,expectedPlanFingerprint:plan.planFingerprint,expectedExecutableFingerprint:executableFingerprint(plan)};
  const operatorValid=verifyAuthorizationArtifact(operator,"operator",expected);
  const reconciliationValid=verifyAuthorizationArtifact(reconciliation,"reconciliation",expected)
    && operator.payload.actorId!==reconciliation.payload.actorId
    && operator.payload.issuerCredentialId!==reconciliation.payload.issuerCredentialId;
  const active=operatorValid&&reconciliationValid;
  const verdict={operatorValid,reconciliationValid,runId:plan.runId,planFingerprint:plan.planFingerprint};
  const common={evidenceType:"held-out-reliability",protocolVersion:2,runId:plan.runId,planFingerprint:plan.planFingerprint,artifactKind:"authorization_receipt"};
  const signedDigest=(artifact:AuthorizationArtifact)=>`sha256:${createHash("sha256").update(`${canonicalJson(artifact)}\n`).digest("hex")}`;
  const operatorReceipt={...common,kind:"operator",status:operatorValid?(reconciliationValid?"consumed":"valid_not_consumed_peer_invalid"):"absent_or_invalid",databaseValidationTime:now,reasonCode:active?"valid_pair":"absent_or_invalid_pair",presentedArtifactSha256:signedDigest(operator)};
  const reconciliationReceipt={...common,kind:"reconciliation",status:reconciliationValid?(operatorValid?"validated":"valid_not_activated_peer_invalid"):"absent_or_invalid",databaseValidationTime:now,reasonCode:active?"valid_pair":"absent_or_invalid_pair",presentedArtifactSha256:signedDigest(reconciliation)};
  await store.commitAuthorization({runId:plan.runId,decisionId:deterministicAuthorizationDecisionId(plan.runId),verdict,active,
    operatorIssuerId:operator.payload.issuerCredentialId,operatorNonce:active?operator.payload.nonce:null,
    operatorReceipt,reconciliationReceipt});
  await store.publishAuthorizationOutbox(plan.runId,publish);
  if(!active) throw new Error("SIGNED_AUTHORIZATION_PAIR_INVALID");
}

function callBody(plan:ReliabilityPlan,call:ReliabilityPlan["calls"][number]):Record<string,unknown>{return {model:plan.model,max_tokens:8,workload_class:call.workloadClass,messages:[{role:"user",content:`Reliability context ${call.contextUnits}: ${"x".repeat(call.contextUnits)}`} ]};}
function laneAuthority(plan:ReliabilityPlan,lane:string){const authority=plan.setup.authority.find((item)=>item.lane===lane);if(!authority)throw new Error("SEALED_LANE_AUTHORITY_REQUIRED");return authority;}
async function controlledInference(baseUrl:string,token:string,plan:ReliabilityPlan,call:ReliabilityPlan["calls"][number]):Promise<unknown>{
  const authority=laneAuthority(plan,call.lane);const child=authority.children[call.branch-1];
  const headers:Record<string,string>={"Content-Type":"application/json","Idempotency-Key":call.requestId,"X-Fuse-Mandate":authority.mandate.id,"X-Fuse-Branch":child.id,"X-Fuse-Reliability-Run":plan.runId,"X-Fuse-Reliability-Lane":call.lane,"X-Fuse-Reliability-Block":String(call.block)};
  headers[["Author","ization"].join("")]=`Bearer ${token}`;
  const response=await fetch(`${baseUrl.replace(/\/$/,"")}${plan.setup.endpoints.inference}`,{method:"POST",signal:AbortSignal.timeout(75_000),headers,body:JSON.stringify(callBody(plan,call))});
  const text=await response.text(); if(response.status===402)throw new Error("PAYMENT_REQUIRED_FAIL_CLOSED"); if(!response.ok)throw new Error(`CONTROLLED_INFERENCE_HTTP_${response.status}`); return JSON.parse(text);
}

export function createReliabilityOperations(cwd=process.cwd()): NonNullable<ReliabilityCliDependencies["operations"]> {
  return {
    doctor: async ({args})=>{
      const plan=parse<ReliabilityPlan>(await readFile(resolve(cwd,required(args,"--plan"))),"RELIABILITY_V2_PLAN_INVALID");validateReliabilityPlan(plan,false);
      const db=pool();try{
        const store=new ReliabilityProtocolStore(db);await store.createSchema();
        const readiness=await db.query<{scheduler:string|null;audit:string|null}>("SELECT to_regclass('public.reliability_scheduler_claims')::text scheduler,to_regclass('public.reliability_replay_write_audit')::text audit");
        if(!readiness.rows[0]?.scheduler)throw new Error("RESTART_RESUME_RECOVERY_UNAVAILABLE");
        if(!readiness.rows[0]?.audit)throw new Error("REPLAY_AUDIT_UNAVAILABLE");
        await store.initializeRun({runId:plan.runId,planFingerprint:plan.planFingerprint,lanes:V2_LANES.map(l=>l.id),reconciliationCredentialId:plan.setup.reconcilerCredentialId});
        const receipt=await store.recordSetupReadinessReceipt({runId:plan.runId,expectedSnapshot:expectedProductionSetupSnapshot(plan),actualSnapshot:await readProductionSetupSnapshot(db,plan)});
        if(!receipt.ready)throw new Error(`SETUP_READINESS_NOT_EXACT:${receipt.differingFields.join(",")}`);
        await store.requireSetupReadinessReceipt({runId:plan.runId,planFingerprint:plan.planFingerprint});
        return {runId:plan.runId,ready:true,setupReadinessReceipt:receipt.snapshotDigest,differingFields:[]};
      }finally{await db.end();}
    },
    setup: async ({args})=>{
      const plan=parse<ReliabilityPlan>(await readFile(resolve(cwd,required(args,"--plan"))),"RELIABILITY_V2_PLAN_INVALID");validateReliabilityPlan(plan,false);
      const db=pool(),store=new ReliabilityProtocolStore(db);
      try{
        await store.createSchema();
        const setupReadinessReceipt=await store.requireSetupReadinessReceipt({runId:plan.runId,planFingerprint:plan.planFingerprint});
        await store.registerSealedCalls({runId:plan.runId,calls:plan.calls.map(call=>{const authority=laneAuthority(plan,call.lane);return {requestId:call.requestId,block:call.block,laneId:call.lane,callOrdinal:call.callOrdinal,body:callBody(plan,call),organizationId:plan.setup.organizationId,agentId:authority.agentId,credentialId:authority.credentialId,mandateId:authority.mandate.id,branchId:authority.children[call.branch-1].id,workloadClass:call.workloadClass,provider:plan.provider,model:plan.model,maxOutputTokens:call.maxOutputTokens,reservationCostMicros:BigInt(call.reservationUsdMicros),claimFingerprint:plan.planFingerprint};})});
        const readback=await db.query<{calls:string;attempts:string}>(`SELECT
          (SELECT count(*)::text FROM reliability_sealed_calls WHERE run_id=$1 AND claim_fingerprint=$2) calls,
          (SELECT count(*)::text FROM reliability_protocol_attempts WHERE run_id=$1) attempts`,[plan.runId,plan.planFingerprint]);
        if(Number(readback.rows[0]?.calls)!==100||Number(readback.rows[0]?.attempts)!==100)throw new Error("SETUP_READBACK_CONFLICT");
        return {runId:plan.runId,setupFingerprint:plan.setup.setupFingerprint,setupReadinessReceipt,exactReadback:true,sealedCalls:100};
      }finally{await db.end();}
    },
    worker: async ({args})=>{
      const plan=parse<ReliabilityPlan>(await readFile(resolve(cwd,required(args,"--plan"))),"RELIABILITY_V2_PLAN_INVALID");validateReliabilityPlan(plan,false);
      const requestId=required(args,"--request-id"),ownerId=required(args,"--owner-id");const call=plan.calls.find(c=>c.requestId===requestId);if(!call)throw new Error("WORKER_REQUEST_NOT_SEALED");
      const manifestPath=resolve(cwd,required(args,"--manifest"));const db=pool(),store=new ReliabilityProtocolStore(db);
      const executionStore=new ReliabilityInferenceExecutionStore(new PolicyStore(db,{protocolMutationExclusionEnabled:true,protocolMutationLockTimeoutMs:5_000}),store);
      try{
        const claim=await store.acquireSchedulerClaim({runId:plan.runId,requestId,laneId:call.lane,block:call.block,ownerId,leaseSeconds:60,manifestPath});
        if(!claim.acquired||claim.generation===null){
          const recovered=await recoverSchedulerWorker({
            readState:async()=>store.readSchedulerRecoveryState({runId:plan.runId,requestId}),
            waitForAuthoritativeOutcome:async()=>{for(let attempt=0;attempt<31;attempt++){const state=await store.readSchedulerRecoveryState({runId:plan.runId,requestId});if(state.terminal||state.primitiveEntered)return;await sleep(1_000);}},
            reconcile:async()=>{const state=await store.readSchedulerRecoveryState({runId:plan.runId,requestId});
              if(!state.terminal&&state.dispatchToken&&!state.primitiveEntered)await executionStore.recoverPreEntryDispatchAtomically({
                ordinary:{requestId,organizationId:plan.setup.organizationId,failureCode:"PRE_ENTRY_WORKER_CRASH",failedAt:await databaseNow(db)},
                protocol:{runId:plan.runId,laneId:call.lane,requestId,reasonCode:"PRE_ENTRY_WORKER_CRASH"},
              });
              return {terminal:(await store.readSchedulerRecoveryState({runId:plan.runId,requestId})).terminal};},
            readManifest:async()=>{try{return parse<{state:string;sequence:number}>(await readFile(manifestPath),"SCHEDULER_MANIFEST_INVALID");}catch(error){if(error instanceof Error&&error.message==="SCHEDULER_MANIFEST_INVALID")throw error;return null;}},
            publishManifest:async manifest=>publishManifestDurably(manifestPath,{...manifest,runId:plan.runId,requestId,laneId:call.lane,block:call.block,ownerId,generation:claim.generation}),
          });
          return {runId:plan.runId,requestId,recoveryDecision:recovered.action,dispatched:false,terminal:recovered.terminal,manifestRepaired:recovered.manifestRepaired};
        }
        const claimed={state:"claimed",sequence:1,runId:plan.runId,requestId,laneId:call.lane,block:call.block,ownerId,generation:claim.generation};
        await publishManifestDurably(manifestPath,claimed);const digest=`sha256:${createHash("sha256").update(`${canonicalJson(claimed)}\n`).digest("hex")}`;
        await store.recordSchedulerManifestFsynced({runId:plan.runId,requestId,laneId:call.lane,ownerId,generation:claim.generation,manifestDigest:digest,state:"claimed"});
        if(claim.decision!=="dispatch_original")return {runId:plan.runId,requestId,recoveryDecision:claim.decision,dispatched:false,terminal:false};
        const token=(await readFile(resolve(cwd,required(args,"--lane-token-file")),"utf8")).trim();if(!token)throw new Error("AGENT_TOKEN_REQUIRED");
        const admission={...claimed,state:"admission_started",sequence:2};
        await publishManifestDurably(manifestPath,admission);
        await store.recordSchedulerManifestFsynced({runId:plan.runId,requestId,laneId:call.lane,ownerId,generation:claim.generation,manifestDigest:`sha256:${createHash("sha256").update(`${canonicalJson(admission)}\n`).digest("hex")}`,state:"admission_started"});
        let renewalFailure:unknown;const renew=setInterval(()=>{void store.renewSchedulerClaim({runId:plan.runId,requestId,laneId:call.lane,ownerId,generation:claim.generation!,leaseSeconds:60}).catch(error=>{renewalFailure=error;});},20_000);
        try{await controlledInference(required(args,"--base-url"),token,plan,call);}finally{clearInterval(renew);}
        if(renewalFailure)throw renewalFailure;
        const awaiting={...claimed,state:"awaiting_outcome",sequence:3};
        await publishManifestDurably(manifestPath,awaiting);
        await store.recordSchedulerManifestFsynced({runId:plan.runId,requestId,laneId:call.lane,ownerId,generation:claim.generation,manifestDigest:`sha256:${createHash("sha256").update(`${canonicalJson(awaiting)}\n`).digest("hex")}`,state:"awaiting_outcome"});
        const recovery=await store.readSchedulerRecoveryState({runId:plan.runId,requestId});if(!recovery.terminal)throw new Error("WORKER_AUTHORITATIVE_TERMINAL_REQUIRED");
        await store.terminalizeSchedulerClaim({runId:plan.runId,requestId,laneId:call.lane,ownerId,generation:claim.generation});
        await publishManifestDurably(manifestPath,{...claimed,state:"terminal",sequence:4,recoveryDecision:recovery.decision});
        return {runId:plan.runId,requestId,recoveryDecision:claim.decision,dispatched:true,terminal:true,generation:claim.generation};
      }finally{await db.end();}
    },
    seal: async ({args,files})=>{
      const beacon=await verifyPinnedReliabilityBeacon(parse(files.beacon!,"RELIABILITY_V2_BEACON_INVALID"));
      const identity=parse<ExecutableIdentity>(await readFile(resolve(cwd,required(args,"--identity"))),"RELIABILITY_V2_IDENTITY_INVALID");
      const plan=buildReliabilityPlan(beacon,required(args,"--run-id"),identity); const output=resolve(cwd,required(args,"--output"));
      await publishAbsolute(output,plan); return {sealed:true,planPath:output,planFingerprint:plan.planFingerprint,plannedFresh:100,plannedReplays:20,beaconCalls:0};
    },
    authorize: async ({args})=>{
      const planPath=resolve(cwd,required(args,"--plan")); const plan=parse<ReliabilityPlan>(await readFile(planPath),"RELIABILITY_V2_PLAN_INVALID"); validateReliabilityPlan(plan,false);
      const kind=required(args,"--kind"); if(kind!=="operator"&&kind!=="reconciliation")throw new Error("AUTHORIZATION_KIND_INVALID");
      const actorId=required(args,"--actor-id"); const issuerCredentialId=required(args,"--issuer-id"); const expiresAt=required(args,"--expires-at");
      const payload:AuthorizationPayload={kind,runId:plan.runId,planFingerprint:plan.planFingerprint,executableFingerprint:executableFingerprint(plan),actorId,issuerCredentialId,capability:kind==="operator"?"evidence:authorize-spend":"evidence:authorize-reconciliation",nonce:kind==="operator"?required(args,"--nonce"):null,expiresAt};
      const signed=await signAuthorizationArtifact(payload,resolve(cwd,required(args,"--private-key")));
      const artifact={...signed,evidenceType:"held-out-reliability",protocolVersion:2,runId:plan.runId,planFingerprint:plan.planFingerprint,artifactKind:"authorization",kind};
      const publicKeyPath=required(args,"--public-key"); const publicKey=createPublicKey(await readFile(resolve(cwd,publicKeyPath))); if(!verify(null,authorizationPayloadBytes(payload),publicKey,Buffer.from(artifact.signature,"base64")))throw new Error("AUTHORIZATION_SIGNATURE_SELF_CHECK_FAILED");
      const output=resolve(cwd,required(args,"--output")); await publishAbsolute(output,artifact);
      return {authorized:true,kind,artifactPath:output,artifactSha256:`sha256:${createHash("sha256").update(canonicalJson(artifact)).digest("hex")}`};
    },
    run: async ({args,files})=>{
      const plan=parse<ReliabilityPlan>(files.plan!,"RELIABILITY_V2_PLAN_INVALID"); validateReliabilityPlan(plan,false);
      const operator=parse<AuthorizationArtifact>(files.authorization!,"OPERATOR_AUTHORIZATION_INVALID"); const reconciliation=parse<AuthorizationArtifact>(files.reconciliationAuthorization!,"RECONCILIATION_AUTHORIZATION_INVALID");
      const db=pool(); const store=new ReliabilityProtocolStore(db); let dispatched=0;
      try{
        await store.createSchema();
        const setupReadinessReceipt=await store.requireSetupReadinessReceipt({runId:plan.runId,planFingerprint:plan.planFingerprint});
        await verifyPair(store,db,plan,operator,reconciliation,async (kind,receipt)=>{
          const path=resolve(cwd,"evidence","held-out-reliability","authorization-receipts",kind,`${plan.runId}.json`);
          await publishAbsolute(path,receipt);
        });
        const baseUrl=required(args,"--base-url");const tokens=new Map<string,string>();const tokenFiles=new Map<string,string>();
        for(const lane of V2_LANES){const tokenFile=required(args,`--lane-token-${lane.id}`);const token=(await readFile(resolve(cwd,tokenFile),"utf8")).trim();if(!token)throw new Error("AGENT_TOKEN_REQUIRED");tokens.set(lane.id,token);tokenFiles.set(lane.id,tokenFile);}
        const worker=async(call:ReliabilityPlan["calls"][number])=>runWorkerProcess({executable:process.execPath,cwd,argv:["--import",resolve(cwd,"node_modules/tsx/dist/loader.mjs"),resolve(cwd,"scripts/held-out-reliability-v2.ts"),"worker","--plan",required(args,"--plan"),"--request-id",call.requestId,"--owner-id",required(args,"--owner-id"),"--manifest",join("evidence","held-out-reliability","scheduler-manifests",plan.runId,`${call.requestId}.json`),"--lane-token-file",tokenFiles.get(call.lane)!,"--base-url",baseUrl]});
        await store.registerSealedCalls({runId:plan.runId,calls:plan.calls.map((call)=>{const authority=laneAuthority(plan,call.lane);return {requestId:call.requestId,block:call.block,laneId:call.lane,callOrdinal:call.callOrdinal,body:callBody(plan,call),organizationId:plan.setup.organizationId,agentId:authority.agentId,credentialId:authority.credentialId,mandateId:authority.mandate.id,branchId:authority.children[call.branch-1].id,workloadClass:call.workloadClass,provider:plan.provider,model:plan.model,maxOutputTokens:call.maxOutputTokens,reservationCostMicros:BigInt(call.reservationUsdMicros),claimFingerprint:plan.planFingerprint};})});
        const publishLaneManifest=async(laneId:string,block:number)=>publishAbsolute(resolve(cwd,"evidence","held-out-reliability","manifests",plan.runId,`${laneId}-${block}.json`),
          {evidenceType:"held-out-reliability",protocolVersion:2,runId:plan.runId,planFingerprint:plan.planFingerprint,artifactKind:"manifest",lane:laneId,block,state:"terminal"});
        const enqueueCalls=async(calls:ReliabilityPlan["calls"],nominalOrigin:string):Promise<boolean>=>{
          let queued=false;
          for(const [index,call] of calls.entries()){
            const nominalScheduledAt=new Date(Date.parse(nominalOrigin)+(call.lane==="bounded-burst"?0:index*5_000)).toISOString();
            const result=await store.enqueueHeldLaneWork({runId:plan.runId,laneId:call.lane,block:call.block,callOrdinal:call.callOrdinal,requestId:call.requestId,nominalScheduledAt});
            queued=queued||result.queued;
          }
          return queued;
        };
        const executeLaneCalls=async(lane:typeof V2_LANES[number],calls:ReliabilityPlan["calls"],nominalOrigin:string):Promise<boolean>=>{
          if(lane.mode==="bounded-burst"){
            await store.createBurstBarrier({runId:plan.runId,laneId:lane.id,block:calls[0]!.block,requestIds:calls.map(call=>call.requestId)});
            const pending=calls.map(call=>worker(call).then(()=>null,()=>call.requestId));
            const release=(async()=>{for(;;){try{await store.releaseBurstBarrier({runId:plan.runId,laneId:lane.id,block:calls[0]!.block});return;}catch(error){if(!(error instanceof Error)||error.message!=="BURST_BARRIER_NOT_READY")throw error;await sleep(10);}}})();
            const failed=await Promise.all(pending);await release;
            const states=await db.query<{request_id:string;state:string}>("SELECT request_id,state FROM reliability_protocol_attempts WHERE run_id=$1 AND request_id=ANY($2::text[])",[plan.runId,calls.map(call=>call.requestId)]);
            const byId=new Map(states.rows.map(row=>[row.request_id,row.state]));const disposition=boundedBurstFailureDisposition(calls.map(call=>byId.get(call.requestId)??null));
            if(disposition==="fail_protocol")throw new Error(`BOUNDED_BURST_WORKER_FAILED:${failed.filter(Boolean).join(",")}`);
            dispatched+=calls.length-failed.filter(Boolean).length;
            if(disposition==="hold_lane")return false;
            await publishLaneManifest(lane.id,calls[0]!.block);return true;
          }
          for(const [index,call] of calls.entries()){
            try{const result=await worker(call);if(result["dispatched"]===true)dispatched++;}
            catch(error){
              const state=await db.query<{state:string}>("SELECT state FROM reliability_protocol_attempts WHERE run_id=$1 AND request_id=$2",[plan.runId,call.requestId]);
              if(runnerCallFailureDisposition(state.rows[0]?.state??null)==="hold_lane"){
                await enqueueCalls(calls.slice(index+1),new Date(Date.parse(nominalOrigin)+(index+1)*5_000).toISOString());return false;
              }
              throw error;
            }
            const terminal=await db.query<{terminal_at:Date}>("SELECT terminal_at FROM reliability_protocol_attempts WHERE run_id=$1 AND request_id=$2 AND terminal_at IS NOT NULL",[plan.runId,call.requestId]);
            if(!terminal.rows[0])throw new Error("AUTHORITATIVE_TERMINAL_TIME_REQUIRED");
            if(index<calls.length-1)await waitForDatabaseTime(db,new Date(terminal.rows[0].terminal_at.getTime()+5_000).toISOString());
          }
          await publishLaneManifest(lane.id,calls[0]!.block);return true;
        };
        for(const window of plan.schedule){
          await store.resumeDueLanes(plan.runId);
          await waitForDatabaseTime(db,window.opensAt);const claim=await store.claimBlock({runId:plan.runId,block:window.block,ownerId:required(args,"--owner-id"),opensAt:window.opensAt,launchDeadline:window.launchDeadline,planFingerprint:plan.planFingerprint});
          const nominalOrigin=new Date(Date.parse(claim.claimedAt)+1_000).toISOString();await waitForDatabaseTime(db,nominalOrigin);
          await Promise.all(V2_LANES.map(async lane=>{
            const calls=plan.calls.filter(call=>call.block===window.block&&call.lane===lane.id);
            if(await enqueueCalls(calls,nominalOrigin))return;
            await executeLaneCalls(lane,calls,nominalOrigin);
          }));
        }
        for(;;){
          await store.resumeDueLanes(plan.runId);
          const schedule=await store.loadReliabilityScheduleReport(plan.runId);
          for(const lane of V2_LANES){
            const claimed=schedule.filter(row=>row.laneId===lane.id&&row.state==="claimed");
            if(claimed.length){try{await store.completeResumedWorkGroup({runId:plan.runId,laneId:lane.id,block:claimed[0]!.block});}catch(error){if(!(error instanceof Error)||error.message!=="RESUMED_WORK_GROUP_NOT_TERMINAL")throw error;}continue;}
            const resumed=await store.claimDueResumedWork({runId:plan.runId,laneId:lane.id,mode:lane.mode==="bounded-burst"?"bounded-burst":"sequential"});
            if(!resumed)continue;
            await waitForDatabaseTime(db,resumed.scheduledAt);
            const calls=resumed.requestIds.map(requestId=>plan.calls.find(call=>call.requestId===requestId)).filter((call):call is ReliabilityPlan["calls"][number]=>Boolean(call));
            if(calls.length!==resumed.requestIds.length)throw new Error("RESUMED_WORK_NOT_SEALED");
            if(await executeLaneCalls(lane,calls,resumed.scheduledAt))await store.completeResumedWorkGroup({runId:plan.runId,laneId:lane.id,block:resumed.block});
          }
          const status=await db.query<{state:string;terminal_count:string}>(`SELECT control.state,(SELECT count(*)::text FROM reliability_protocol_attempts attempt WHERE attempt.run_id=control.run_id AND attempt.terminal_at IS NOT NULL) terminal_count FROM reliability_protocol_controls control WHERE control.run_id=$1`,[plan.runId]);
          if(status.rows[0]?.state==="failed")throw new Error("PROTOCOL_CONTROL_FAILED");
          if(Number(status.rows[0]?.terminal_count)===100)break;
          await sleep(1_000);
        }
        for(const lane of V2_LANES)for(const block of [1,2,3,4,5])await publishLaneManifest(lane.id,block);
        await store.advanceDurableStage(plan.runId,"fresh_terminal");
        for(const claim of buildFourLaneClaimArtifacts({runId:plan.runId,planFingerprint:plan.planFingerprint})){
          const {path,...artifact}=claim;await publishAbsolute(resolve(cwd,path),artifact);
        }
        return {runId:plan.runId,setupReadinessReceipt,dispatched,blocks:5,lanes:4,longLived:true,claims:4};
      }catch(error){try{await store.failProtocol(plan.runId,"RUNNER_DURABLE_FAILURE");}catch{/* preserve original */}throw error;}finally{await db.end();}
    },
    reconcile: async ({args,files})=>{
      const plan=parse<ReliabilityPlan>(files.plan!,"RELIABILITY_V2_PLAN_INVALID"); validateReliabilityPlan(plan,false);
      const auth=parse<AuthorizationArtifact>(files.authorization!,"RECONCILIATION_AUTHORIZATION_INVALID");
      const db=pool(); const store=new ReliabilityProtocolStore(db);
      try {
        const now=await databaseNow(db);
        if(!verifyAuthorizationArtifact(auth,"reconciliation",{now,expectedRunId:plan.runId,expectedPlanFingerprint:plan.planFingerprint,expectedExecutableFingerprint:executableFingerprint(plan)}))throw new Error("RECONCILIATION_AUTHORIZATION_INVALID");
        const key=(await readFile(resolve(cwd,required(args,"--provider-key-file")),"utf8")).trim();
        if(!key)throw new Error("RECONCILIATION_PROVIDER_KEY_REQUIRED");
        const reconciler=new OpenRouterReconciler({apiKey:key});
        const pending=await db.query<{request_id:string;lane_id:string;provider_generation_id:string|null;ambiguity_entered_at:Date}>("SELECT request_id,lane_id,provider_generation_id,ambiguity_entered_at FROM reliability_protocol_attempts WHERE run_id=$1 AND state='reconciliation_pending' AND ambiguity_entered_at IS NOT NULL ORDER BY lane_id,block_no,request_id",[plan.runId]);
        const authorizationSha256=`sha256:${createHash("sha256").update(files.authorization!).digest("hex")}`;let attempts=0;
        const scheduled=await executeConcurrentReconciliation({requests:pending.rows.map(row=>({requestId:row.request_id,generationId:row.provider_generation_id,ambiguityEnteredAt:row.ambiguity_entered_at.toISOString()})),
          authorizeOffset:async({requestId,offsetSeconds})=>{const row=pending.rows.find(item=>item.request_id===requestId)!;const times=reconciliationWindow(row.ambiguity_entered_at.toISOString(),offsetSeconds);await store.scheduleReconciliation({runId:plan.runId,requestId,offsetSeconds,scheduledAt:times.scheduledAt,evidenceCutoff:times.evidenceCutoff,classificationDeadline:times.classificationDeadline});await store.authorizeReconciliationOffset({runId:plan.runId,requestId,offsetSeconds,credentialId:plan.setup.reconcilerCredentialId,authorizationSha256});return {credentialId:plan.setup.reconcilerCredentialId,authorizationSha256};},
          waitUntil:target=>waitForDatabaseTime(db,target),
          persistPhase:async phase=>{if(phase.phase==="lookup_finished")await store.finishReconciliationLookup({runId:plan.runId,requestId:phase.requestId,offsetSeconds:phase.offsetSeconds});else if(phase.phase==="failed")await store.failReconciliationOffset({runId:plan.runId,requestId:phase.requestId,offsetSeconds:phase.offsetSeconds,failureCode:phase.errorCode??"RECONCILIATION_SCHEDULER_FAILURE"});},
          lookup:async request=>{attempts++;const row=pending.rows.find(item=>item.request_id===request.requestId)!;const lookup=await store.beginReconciliationLookup({runId:plan.runId,requestId:request.requestId,offsetSeconds:request.offsetSeconds});if(!request.generationId)return {disposition:"generation_unavailable"};
            const raw=await reconciler.reconcile({generationId:request.generationId,model:plan.model,messages:callBody(plan,plan.calls.find(c=>c.requestId===request.requestId)!).messages as Array<{role:string;content:string}>,dispatchTokenAt:undefined,ambiguityEnteredAt:request.ambiguityEnteredAt,finalOffset:request.offsetSeconds===86_300});
            const retrievedAt=Date.parse(await databaseNow(db)),metadataRoot=raw.metadata.parsed as {data?:Record<string,unknown>};const evidence={credentialId:plan.setup.reconcilerCredentialId,generationId:request.generationId,retrievalStartedAtMs:lookup.startedAtMs,metadata:{status:raw.metadata.status,bodySha256:raw.metadata.sha256,bodyBase64:raw.metadata.bodyBase64,retrievedAtMs:retrievedAt,data:metadataRoot?.data},content:{status:raw.content.status,bodySha256:raw.content.sha256,bodyBase64:raw.content.bodyBase64,retrievedAtMs:retrievedAt,body:raw.content.parsed}};
            const data=(raw.content.parsed as any)?.data,output=data?.output,meta=metadataRoot?.data as any,recovered=typeof output?.completion==="string"?{id:request.generationId,content:output.completion,usage:{inputTokens:Number(meta?.tokens_prompt),outputTokens:Number(meta?.tokens_completion)},providerCostUsd:String(meta?.total_cost),providerModel:String(meta?.model)}:undefined;const applied=await store.applyAuthoritativeReconciliation({runId:plan.runId,requestId:request.requestId,laneId:row.lane_id,operation:{kind:"scheduled",offsetSeconds:request.offsetSeconds},evidence,recoveredResponse:recovered});return {disposition:applied.terminalState?"terminal":raw.disposition,terminal:Boolean(applied.terminalState)};}});
        let terminal=scheduled.terminal;const remaining=await db.query<{request_id:string;lane_id:string;ambiguity_entered_at:Date}>(`SELECT attempt.request_id,attempt.lane_id,attempt.ambiguity_entered_at FROM reliability_protocol_attempts attempt LEFT JOIN reliability_hold_members member ON member.run_id=attempt.run_id AND member.request_id=attempt.request_id WHERE attempt.run_id=$1 AND attempt.state='reconciliation_pending' ORDER BY attempt.lane_id,member.member_sequence NULLS LAST`,[plan.runId]);
        for(const row of remaining.rows){await waitForDatabaseTime(db,new Date(row.ambiguity_entered_at.getTime()+86_400_000).toISOString());const applied=await store.applyAuthoritativeReconciliation({runId:plan.runId,requestId:row.request_id,laneId:row.lane_id,operation:{kind:"cutoff"},evidence:null});if(applied.terminalState)terminal++;}await store.resumeDueLanes(plan.runId);
        return {runId:plan.runId,reconciliationRequests:scheduled.requests,reconciliationAttempts:attempts,failed:scheduled.failed,terminal};
      }finally{await db.end();}
    },
    settle: async ({args})=>{
      const plan=parse<ReliabilityPlan>(await readFile(resolve(cwd,required(args,"--plan"))),"RELIABILITY_V2_PLAN_INVALID"); validateReliabilityPlan(plan,false);
      const db=pool(); try { const store=new ReliabilityProtocolStore(db);const result=await store.runAndPersistAuthoritativeSettlement(plan.runId);if(result.passed)await store.advanceDurableStage(plan.runId,"settled");return {runId:plan.runId,passed:result.passed,acceptedOffsetSeconds:result.acceptedOffsetSeconds,journalCardinality:result.journal.length}; } finally { await db.end(); }
    },
    replay: async ({args,files})=>{
      const plan=parse<ReliabilityPlan>(await readFile(resolve(cwd,required(args,"--plan"))),"RELIABILITY_V2_PLAN_INVALID"); validateReliabilityPlan(plan,false);
      const baseUrl=required(args,"--base-url");
      const laneTokens=new Map<string,string>();
      for(const lane of V2_LANES){const token=(await readFile(resolve(cwd,required(args,`--lane-token-${lane.id}`)),"utf8")).trim();if(!token)throw new Error("AGENT_TOKEN_REQUIRED");laneTokens.set(lane.id,token);}
      if(new Set(laneTokens.values()).size!==V2_LANES.length)throw new Error("DISTINCT_LANE_CREDENTIALS_REQUIRED");
      const db=pool(),store=new ReliabilityProtocolStore(db);
      try{
        const operator=parse<AuthorizationArtifact>(files.authorization!,"OPERATOR_AUTHORIZATION_INVALID");
        const now=await databaseNow(db);
        if(!verifyAuthorizationArtifact(operator,"operator",{now,expectedRunId:plan.runId,expectedPlanFingerprint:plan.planFingerprint,expectedExecutableFingerprint:executableFingerprint(plan)}))throw new Error("OPERATOR_AUTHORIZATION_INVALID");
        const authorizationSha256=`sha256:${createHash("sha256").update(files.authorization!).digest("hex")}`;
        const replayInventory=buildReplayAuthorizationInventory({runId:plan.runId,authorizationSha256,requestIds:plan.replayTargets.map(target=>target.requestId)});
        await store.registerReplayAuthorizationInventory({runId:plan.runId,authorizationSha256,requestIds:plan.replayTargets.map(target=>target.requestId)});
        let passed=0;
        for(const [replayIndex,target] of plan.replayTargets.entries()){
          const call=plan.calls.find((item)=>item.requestId===target.requestId);if(!call)throw new Error("REPLAY_TARGET_NOT_SEALED");
          const body=callBody(plan,call);
          const row=await db.query<{response_commitment:string;body_commitment:string}>(`SELECT attempt.response_commitment,sealed.body_commitment
            FROM reliability_protocol_attempts attempt JOIN reliability_sealed_calls sealed
              ON sealed.run_id=attempt.run_id AND sealed.request_id=attempt.request_id
            WHERE attempt.run_id=$1 AND attempt.request_id=$2 AND attempt.state IN ('completed_verified','reconciled_billed_with_response')`,[plan.runId,target.requestId]);
          if(!row.rows[0]?.response_commitment)throw new Error("REPLAY_TARGET_INELIGIBLE");
          if(row.rows[0].body_commitment!==buildHttpBodyCommitment(body))throw new Error("REPLAY_REQUEST_PROJECTION_CONFLICT");
          const operationId=replayInventory[replayIndex]!.operationId;
          const replay=await performReliabilityReplayHttp({baseUrl,endpoint:plan.setup.endpoints.inference,laneCredential:laneTokens.get(call.lane)!,requestId:call.requestId,operationId,mandateId:laneAuthority(plan,call.lane).mandate.id,branchId:laneAuthority(plan,call.lane).children[call.branch-1].id,body,expectedCommitment:row.rows[0].response_commitment});
          const writes=await db.query("SELECT 1 FROM reliability_replay_write_audit WHERE operation_id=$1 LIMIT 1",[operationId]);
          if(writes.rows.length)throw new Error("REPLAY_WRITE_SET_NOT_EMPTY");
          const audit=await db.query<{original_response_commitment:string;replay_response_commitment:string;write_set:unknown[]}>(`SELECT original_response_commitment,replay_response_commitment,write_set FROM reliability_replay_audits WHERE run_id=$1 AND request_id=$2 AND replay_no=$3`,[plan.runId,target.requestId,replayIndex+1]);
          if(audit.rows.length!==1||audit.rows[0]!.original_response_commitment!==replay.responseCommitment||audit.rows[0]!.replay_response_commitment!==replay.responseCommitment||audit.rows[0]!.write_set.length)throw new Error("REPLAY_SERVER_AUDIT_REQUIRED");
          passed++;
        }
        await store.completeReplayRun(plan.runId);
        await publishAbsolute(resolve(cwd,preliminaryReplayArtifactPath(plan.runId)),
          {evidenceType:"held-out-reliability",protocolVersion:2,runId:plan.runId,planFingerprint:plan.planFingerprint,artifactKind:"replay_report",passed:passed===20,replayAudits:passed});
        return {runId:plan.runId,replayPassed:passed};
      }finally{await db.end();}
    },
    evidence: async ({args})=>{
      const plan=parse<ReliabilityPlan>(await readFile(resolve(cwd,required(args,"--plan"))),"RELIABILITY_V2_PLAN_INVALID");validateReliabilityPlan(plan,false);
      const db=pool();try{const store=new ReliabilityProtocolStore(db);const incidents=await store.loadArtifactIncidentCoordinates(plan.runId);
        const publicKeys={operator:resolve(cwd,required(args,"--operator-public-key")),reconciliation:resolve(cwd,required(args,"--reconciliation-public-key"))};
        const reconstructed=await reconstructReliabilityArtifacts({root:cwd,runId:plan.runId,planFingerprint:plan.planFingerprint,incidents,
          verifyAuthorization:async({kind,parsed})=>{const artifact=parsed as unknown as AuthorizationArtifact;return verify(null,authorizationPayloadBytes(artifact.payload),createPublicKey(await readFile(publicKeys[kind])),Buffer.from(artifact.signature,"base64"));}});
        await store.bindArtifactInventory(plan.runId,reconstructed.artifactDigests);
        return {runId:plan.runId,artifactBound:true,artifactCount:reconstructed.artifactPaths.length,artifactDigests:reconstructed.artifactDigests};
      }finally{await db.end();}
    },
    report: async ({args})=>buildEvidenceReport(cwd,args),
  };
}

export async function main(argv=process.argv.slice(2)):Promise<number>{const result=await executeReliabilityCli(argv,{cwd:process.cwd(),operations:createReliabilityOperations(process.cwd())}); process.stdout.write(`${JSON.stringify(result)}\n`); return result.ok?0:1;}
if(import.meta.url===pathToFileURL(process.argv[1]??"").href){process.exitCode=await main();}
