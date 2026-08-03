import { createHash } from "node:crypto";
import {
  RELIABILITY_V2_CHAIN_HASH,
  RELIABILITY_V2_CHAIN_PUBLIC_KEY,
  RELIABILITY_V2_MODEL,
  RELIABILITY_V2_PROVIDER,
  V2_LANES,
  verifyPinnedDrandChainedBeaconAtRound,
  canonicalJson,
  fingerprint,
  type ChainedBlsVerifier,
  type ExecutableIdentity,
} from "./heldOutReliabilityV2.js";
import type { G2ChainedBeacon } from "drand-client";
import { RELIABILITY_V3_PROFILE } from "../reliability/protocolProfile.js";

export { canonicalJson, fingerprint } from "./heldOutReliabilityV2.js";

export const RELIABILITY_V3_CHAIN_HASH = RELIABILITY_V2_CHAIN_HASH;
export const RELIABILITY_V3_CHAIN_PUBLIC_KEY = RELIABILITY_V2_CHAIN_PUBLIC_KEY;
export const RELIABILITY_V3_ROUND = 6_338_040;
export const RELIABILITY_V3_BEACON_AVAILABLE_AT = "2026-08-01T08:17:00.000Z" as const;
export const RELIABILITY_V3_PROVIDER = RELIABILITY_V2_PROVIDER;
export const RELIABILITY_V3_MODEL = RELIABILITY_V2_MODEL;
export const RELIABILITY_V3_RANDOMNESS_DOMAIN = "fuse-held-out-reliability-v3" as const;
export const RELIABILITY_V3_REQUEST_ID_DOMAIN = "fuse-held-out-reliability-v3-request" as const;
export const RELIABILITY_V3_EVIDENCE_TYPE = "held-out-reliability-v3" as const;
export const RELIABILITY_V3_REQUEST_RECIPE_VERSION = 1 as const;
export const RELIABILITY_V3_REQUEST_RECIPE = {
  domain:"fuse-held-out-reliability-v3-request-recipe",fuse:{authorization:{authenticatedCredentialId:"<lane-credential-id>",scheme:"Bearer",secretBytes:"excluded"},
    bodyEncoding:"utf8",bodyMemberOrder:["model","max_tokens","workload_class","messages"],
    bodyTemplate:'{"model":"nousresearch/hermes-4-405b","max_tokens":8,"workload_class":"<workload-class>","messages":[{"role":"user","content":"Reliability context <context-units>: <x repeated context-units times>"}]}',bodyTrailingNewline:false,
    headers:[{name:"content-type",value:"application/json"},{name:"idempotency-key",valueSource:"requestId"},{name:"x-fuse-mandate",valueSource:"mandateId"},{name:"x-fuse-branch",valueSource:"branchId"},{name:"x-fuse-reliability-run",valueSource:"runId"},{name:"x-fuse-reliability-lane",valueSource:"lane"},{name:"x-fuse-reliability-block",valueSource:"base10Block"}],method:"POST",route:"/v1/chat/completions"},
  protocolVersion:3,provider:{authorization:{credentialId:"<provider-credential-id>",scheme:"Bearer",secretBytes:"excluded"},bodyEncoding:"utf8",
    bodyMemberOrder:["model","max_tokens","messages","provider"],
    bodyTemplate:'{"model":"nousresearch/hermes-4-405b","max_tokens":8,"messages":[{"role":"user","content":"Reliability context <context-units>: <x repeated context-units times>"}],"provider":{"allow_fallbacks":false}}',bodyTrailingNewline:false,
    headers:[{name:"content-type",value:"application/json"}],method:"POST",url:"https://openrouter.ai/api/v1/chat/completions"},version:1,
} as const;
export const RELIABILITY_V3_REQUEST_RECIPE_FINGERPRINT=`sha256:${createHash("sha256").update(canonicalJson(RELIABILITY_V3_REQUEST_RECIPE)).digest("hex")}` as const;
export const V3_ARTIFACT_ROOT = "evidence/held-out-reliability-v3" as const;
export const RELIABILITY_V3_PREREGISTRATION_COMMIT = "0a29a7e63d3659c1c374f535aeac9da2ca2d4d69" as const;
export const EXPECTED_V3_PLAN_FINGERPRINT_TEST_BEACON = "sha256:6ab7d8754797da9acd4c2cb7381030f7590607a0a960aa2acc3df81c25d795f9";

export const V3_AUTHORIZATION_WINDOW = {
  startsAt: "2026-08-02T08:16:00.000Z",
  startsBefore: "2026-08-02T08:16:01.000Z",
  operationDeadlineMs: 55_000,
} as const;

export const V3_LANES = V2_LANES;
export type ReliabilityV3LaneId = typeof V3_LANES[number]["id"];

export const V3_SCHEDULE = [
  { block: 1, opensAt: "2026-08-02T08:17:00.000Z", launchDeadline: "2026-08-02T08:22:00.000Z" },
  { block: 2, opensAt: "2026-08-02T20:17:00.000Z", launchDeadline: "2026-08-02T20:22:00.000Z" },
  { block: 3, opensAt: "2026-08-03T08:17:00.000Z", launchDeadline: "2026-08-03T08:22:00.000Z" },
  { block: 4, opensAt: "2026-08-03T20:17:00.000Z", launchDeadline: "2026-08-03T20:22:00.000Z" },
  { block: 5, opensAt: "2026-08-04T08:17:00.000Z", launchDeadline: "2026-08-04T08:22:00.000Z" },
] as const;

export interface VerifiedReliabilityV3Beacon {
  round: 6338040;
  randomness: string;
  signature: string;
  previousSignature: string;
  chainHash: typeof RELIABILITY_V3_CHAIN_HASH;
  verified: true;
}

export interface ReliabilityProtocolSourceRecord {
  path: string;
  commit: string;
  gitBlob: string;
  sha256: string;
}

export interface ExecutableV3Identity extends ExecutableIdentity {
  inheritedV2Commit: string;
  amendmentCommit: string;
  protocolSources: readonly [ReliabilityProtocolSourceRecord, ReliabilityProtocolSourceRecord];
  providerCredentialEncryptionKeyId: string;
  providerCredentialCiphertextEnvelopeSha256: `sha256:${string}`;
}

export async function verifyPinnedReliabilityV3Beacon(value: unknown): Promise<VerifiedReliabilityV3Beacon> {
  if (!await verifyPinnedDrandChainedBeaconAtRound(value, RELIABILITY_V3_ROUND)) {
    throw new Error("RELIABILITY_V3_BEACON_BLS_INVALID");
  }
  const item = value as G2ChainedBeacon;
  return {
    round: RELIABILITY_V3_ROUND,
    randomness: item.randomness,
    signature: item.signature,
    previousSignature: item.previous_signature,
    chainHash: RELIABILITY_V3_CHAIN_HASH,
    verified: true,
  };
}

export async function verifyReliabilityV3ChainedBeacon(value: unknown, verifier: ChainedBlsVerifier): Promise<VerifiedReliabilityV3Beacon> {
  if (!value || typeof value !== "object") throw new Error("RELIABILITY_V3_BEACON_INVALID");
  const item = value as Record<string, unknown>;
  if (item.round !== RELIABILITY_V3_ROUND || typeof item.randomness !== "string"
    || typeof item.signature !== "string" || typeof item.previous_signature !== "string"
    || !/^[a-f0-9]{64}$/.test(item.randomness) || !/^[a-f0-9]{192}$/.test(item.signature)
    || !/^[a-f0-9]{192}$/.test(item.previous_signature)) throw new Error("RELIABILITY_V3_BEACON_INVALID");
  const ok = await verifier({
    round: item.round, randomness: item.randomness, signature: item.signature,
    previousSignature: item.previous_signature, chainHash: RELIABILITY_V3_CHAIN_HASH,
    publicKey: RELIABILITY_V3_CHAIN_PUBLIC_KEY, scheme: "pedersen-bls-chained",
  });
  if (!ok) throw new Error("RELIABILITY_V3_BEACON_BLS_INVALID");
  return {
    round: RELIABILITY_V3_ROUND,
    randomness: item.randomness,
    signature: item.signature,
    previousSignature: item.previous_signature,
    chainHash: RELIABILITY_V3_CHAIN_HASH,
    verified: true,
  };
}

export interface ReliabilityV3Call {
  block: number; lane: ReliabilityV3LaneId; laneOrdinal: number; callOrdinal: number;
  laneCallOrdinal: number; requestId: string; branch: 1 | 2; workloadClass: "baseline-lookup" | "spike-burst";
  contextUnits: number; maxOutputTokens: 8; reservationUsdMicros: "10000" | "50000";
  requestIdFullDigest:string; requestRecipeVersion:1; requestRecipeFingerprint:string;
  fuseRequestBodySha256:string; providerRequestBodySha256:string; requestCommitment:string;
}

export interface ReliabilityV3LaneAuthority {
  lane: ReliabilityV3LaneId; agentId: string; credentialId: string;
  policy: { id: string; version: 1; mode: "enforce"; workloadClass: "baseline-lookup" | "spike-burst";
    perCallUsdMicros: "10000" | "50000"; aggregateUsdMicros: string; hourlyUsdMicros: string;
    dailyUsdMicros: string; maxRequestsPerMinute: 5; maxInputTokens: 850; maxOutputTokens: 8;
    expiresAt: "2026-08-05T10:30:00.000Z" };
  mandate: { id: string; maximumUsdMicros: string; expiresAt: "2026-08-05T10:30:00.000Z" };
  root: { id: string; maximumUsdMicros: string; expiresAt: "2026-08-05T10:30:00.000Z" };
  children: readonly [
    { id: string; branch: 1; maximumUsdMicros: string; expiresAt: "2026-08-05T10:30:00.000Z" },
    { id: string; branch: 2; maximumUsdMicros: string; expiresAt: "2026-08-05T10:30:00.000Z" },
  ];
}

export interface ReliabilityV3Setup {
  organizationId: string; providerConfigurationId: string; runnerServiceAccountId: string;
  reconcilerServiceAccountId: string; reconcilerCredentialId: string;
  setupAdminActorId:string; setupAdminCredentialId:string; providerCredentialOwnerId:string; providerCredentialId:string;
  providerCredentialVersion:1; providerCredentialEncryptionKeyId:string; providerCredentialCiphertextEnvelopeSha256:string;
  operatorServiceAccountId:string; operatorCredentialId:string; runnerOrchestrationCredentialId:string;
  endpoints: { inference: "/v1/chat/completions"; generation: "/api/v1/generation"; generationContent: "/api/v1/generation/content"; mappingVersion: 2 };
  hardFinalizationAt: "2026-08-05T09:30:00.000Z"; authority: ReliabilityV3LaneAuthority[];
  configurationFingerprint: string; setupFingerprint: string;
}

export interface ReliabilityV3Plan {
  schemaVersion: 2; evidenceType: typeof RELIABILITY_V3_EVIDENCE_TYPE; protocolVersion: 3; runId: string;
  provider: "openrouter"; model: "nousresearch/hermes-4-405b"; allowFallbacks: false; adapterRetryCount: 0;
  beacon: VerifiedReliabilityV3Beacon; identity: ExecutableV3Identity; schedule: typeof V3_SCHEDULE;
  lanes: typeof V3_LANES; setup: ReliabilityV3Setup; calls: ReliabilityV3Call[];
  replayTargets: Array<{ block: number; lane: ReliabilityV3LaneId; callOrdinal: number; requestId: string }>;
  cost: { knownCostCapUsdMicros: "3000000"; unresolvedExposureCapUsdMicros: "320000" };
  profileFingerprint: string;
  planFingerprint: string;
}

class V3RejectionWordStream {
  private counter = 0;
  private words: number[] = [];
  constructor(private readonly randomness: string) {}
  draw(min: number, max: number): number {
    const m = max - min + 1;
    const limit = Math.floor(0x1_0000_0000 / m) * m;
    let word: number;
    do word = this.next(); while (word >= limit);
    return min + (word % m);
  }
  private next(): number {
    if (this.words.length === 0) {
      const index = Buffer.alloc(4); index.writeUInt32BE(this.counter++);
      const digest = createHash("sha256").update(RELIABILITY_V3_RANDOMNESS_DOMAIN)
        .update(Buffer.from(this.randomness, "hex")).update(index).digest();
      this.words = Array.from({ length: 8 }, (_, offset) => digest.readUInt32BE(offset * 4));
    }
    return this.words.shift()!;
  }
}

function requireV3RunId(runId: string): void {
  if (!/^hov3-[A-Za-z0-9._:-]{1,97}$/.test(runId)) throw new Error("RELIABILITY_V3_RUN_ID_INVALID");
}

export function deriveReliabilityV3RequestId(runId: string, block: number, lane: ReliabilityV3LaneId, callOrdinal: number): string {
  requireV3RunId(runId);
  if (!Number.isInteger(block) || block < 1 || block > 5 || !V3_LANES.some((item) => item.id === lane)
    || !Number.isInteger(callOrdinal) || callOrdinal < 1 || callOrdinal > 5) {
    throw new Error("RELIABILITY_V3_REQUEST_ID_INPUT_INVALID");
  }
  const digest = createHash("sha256").update(canonicalJson({
    domain: RELIABILITY_V3_REQUEST_ID_DOMAIN, protocolVersion: 3, runId, block, lane, callOrdinal,
  })).digest("hex");
  return `hov3_${digest.slice(0, 48)}`;
}

function requestIdFullDigest(runId:string,block:number,lane:ReliabilityV3LaneId,callOrdinal:number):string{
  return createHash("sha256").update(canonicalJson({domain:RELIABILITY_V3_REQUEST_ID_DOMAIN,protocolVersion:3,runId,block,lane,callOrdinal})).digest("hex");
}
export function reliabilityV3FuseRequestBody(input:{workloadClass:string;contextUnits:number}){
  return {model:RELIABILITY_V3_MODEL,max_tokens:8,workload_class:input.workloadClass,messages:[{role:"user",content:`Reliability context ${input.contextUnits}: ${"x".repeat(input.contextUnits)}`}]};
}
export function reliabilityV3ProviderRequestBody(input:{contextUnits:number}){
  return {model:RELIABILITY_V3_MODEL,max_tokens:8,messages:[{role:"user",content:`Reliability context ${input.contextUnits}: ${"x".repeat(input.contextUnits)}`}],provider:{allow_fallbacks:false}};
}
export interface ReliabilityV3RequestCommitmentInput{
  runId:string;block:number;lane:string;requestId:string;requestIdFullDigest:string;planFingerprint:string;profileFingerprint:string;
  organizationId:string;authenticatedCredentialId:string;credentialOwnerId:string;mandateId:string;branchId:string;workloadClass:string;contextUnits:number;
  fuseRequestBodySha256:string;providerRequestBodySha256:string;providerConfigurationId:string;providerCredentialId:string;
  providerCredentialOwnerId:string;providerCredentialVersion:number;providerCredentialEncryptionKeyId:string;providerCredentialCiphertextEnvelopeSha256:string;
}
export function buildReliabilityV3RequestCommitment(input:ReliabilityV3RequestCommitmentInput):string{
  const projection={domain:"fuse-reliability-request-v2",fuse:{authorization:{authenticatedCredentialId:input.authenticatedCredentialId,
      credentialOwnerId:input.credentialOwnerId,scheme:"Bearer",secretBytes:"excluded"},body:reliabilityV3FuseRequestBody(input),bodySha256:input.fuseRequestBodySha256,
      headers:{"content-type":"application/json","idempotency-key":input.requestId,"x-fuse-branch":input.branchId,"x-fuse-mandate":input.mandateId,
        "x-fuse-reliability-block":String(input.block),"x-fuse-reliability-lane":input.lane,"x-fuse-reliability-run":input.runId},method:"POST",route:"/v1/chat/completions"},
    idempotencyKey:input.requestId,organizationId:input.organizationId,planFingerprint:input.planFingerprint,profileFingerprint:input.profileFingerprint,protocolVersion:3,
    provider:{authorization:{credentialId:input.providerCredentialId,scheme:"Bearer",secretBytes:"excluded"},bodySha256:input.providerRequestBodySha256,
      configurationId:input.providerConfigurationId,credentialCiphertextEnvelopeSha256:input.providerCredentialCiphertextEnvelopeSha256,
      credentialEncryptionKeyId:input.providerCredentialEncryptionKeyId,credentialOwnerId:input.providerCredentialOwnerId,credentialVersion:input.providerCredentialVersion,
      headers:{"content-type":"application/json","http-referer":null,"x-openrouter-title":null},method:"POST",url:"https://openrouter.ai/api/v1/chat/completions"},
    requestId:input.requestId,requestIdFullDigest:input.requestIdFullDigest,requestRecipeFingerprint:RELIABILITY_V3_REQUEST_RECIPE_FINGERPRINT,
    workload:{branchId:input.branchId,class:input.workloadClass,lane:input.lane,mandateId:input.mandateId}};
  return fingerprint(projection);
}

export function buildReliabilityV3Plan(
  beacon: VerifiedReliabilityV3Beacon,
  runId: string,
  identity: ExecutableV3Identity,
  internalSkipValidation = false,
): ReliabilityV3Plan {
  requireV3RunId(runId);
  validateV3Identity(identity);
  if (beacon.verified !== true || beacon.round !== RELIABILITY_V3_ROUND || beacon.chainHash !== RELIABILITY_V3_CHAIN_HASH
    || !/^[a-f0-9]{64}$/.test(beacon.randomness)) throw new Error("RELIABILITY_V3_BEACON_INVALID");
  const random = new V3RejectionWordStream(beacon.randomness);
  const organizationId = runId;
  const expiry = "2026-08-05T10:30:00.000Z" as const;
  const authority: ReliabilityV3LaneAuthority[] = V3_LANES.map((lane) => {
    const maximum = lane.mandateMaximum;
    const perCall = lane.workloadClass === "baseline-lookup" ? "10000" as const : "50000" as const;
    return { lane: lane.id, agentId: `${organizationId}-agent-${lane.id}`, credentialId: `${organizationId}-credential-${lane.id}`,
      policy: { id: `${organizationId}-policy-${lane.id}`, version: 1, mode: "enforce", workloadClass: lane.workloadClass,
        perCallUsdMicros: perCall, aggregateUsdMicros: maximum, hourlyUsdMicros: maximum, dailyUsdMicros: maximum,
        maxRequestsPerMinute: 5, maxInputTokens: 850, maxOutputTokens: 8, expiresAt: expiry },
      mandate: { id: `${organizationId}-mandate-${lane.id}`, maximumUsdMicros: maximum, expiresAt: expiry },
      root: { id: `${organizationId}-root-${lane.id}`, maximumUsdMicros: maximum, expiresAt: expiry },
      children: [
        { id: `${organizationId}-child-${lane.id}-1`, branch: 1, maximumUsdMicros: lane.children[0], expiresAt: expiry },
        { id: `${organizationId}-child-${lane.id}-2`, branch: 2, maximumUsdMicros: lane.children[1], expiresAt: expiry },
      ] };
  });
  const setupConfiguration = { organizationId, setupAdminActorId:`${organizationId}-setup-admin`,setupAdminCredentialId:`${organizationId}-setup-admin-credential`,
    providerCredentialOwnerId:`${organizationId}-provider-owner`,providerCredentialId:`${organizationId}-openrouter-credential`,providerCredentialVersion:1 as const,
    providerCredentialEncryptionKeyId:identity.providerCredentialEncryptionKeyId,providerCredentialCiphertextEnvelopeSha256:identity.providerCredentialCiphertextEnvelopeSha256,
    providerConfigurationId: `${organizationId}-openrouter`,operatorServiceAccountId:`${organizationId}-operator`,operatorCredentialId:`${organizationId}-operator-credential`,
    runnerServiceAccountId: `${organizationId}-runner`,runnerOrchestrationCredentialId:`${organizationId}-runner-credential`,reconcilerServiceAccountId: `${organizationId}-reconciler`,
    reconcilerCredentialId: `${organizationId}-reconciler-credential`,
    endpoints: { inference: "/v1/chat/completions" as const, generation: "/api/v1/generation" as const,
      generationContent: "/api/v1/generation/content" as const, mappingVersion: 2 as const },
    hardFinalizationAt: "2026-08-05T09:30:00.000Z" as const };
  const setup: ReliabilityV3Setup = { ...setupConfiguration, authority,
    configurationFingerprint: fingerprint({ ...setupConfiguration, provider: RELIABILITY_V3_PROVIDER, model: RELIABILITY_V3_MODEL, allowFallbacks: false }),
    setupFingerprint: fingerprint(authority) };
  const calls: Array<Omit<ReliabilityV3Call,"requestCommitment">> = [];
  for (let block = 1; block <= 5; block++) {
    for (const [laneIndex, lane] of V3_LANES.entries()) {
      for (let callOrdinal = 1; callOrdinal <= 5; callOrdinal++) {
        const laneCallOrdinal = (block - 1) * 5 + callOrdinal;
        const oddLane = (laneIndex + 1) % 2 === 1;
        const branch = ((laneCallOrdinal % 2 === 1) === oddLane ? 1 : 2) as 1 | 2;
        const contextUnits=random.draw(lane.contextMin,lane.contextMax);const requestId=deriveReliabilityV3RequestId(runId,block,lane.id,callOrdinal);
        const fuseBody=JSON.stringify(reliabilityV3FuseRequestBody({workloadClass:lane.workloadClass,contextUnits}));
        const providerBody=JSON.stringify(reliabilityV3ProviderRequestBody({contextUnits}));
        calls.push({block,lane:lane.id,laneOrdinal:laneIndex+1,callOrdinal,laneCallOrdinal,requestId,branch,workloadClass:lane.workloadClass,contextUnits,
          maxOutputTokens:8,reservationUsdMicros:lane.workloadClass==="baseline-lookup"?"10000":"50000",
          requestIdFullDigest:requestIdFullDigest(runId,block,lane.id,callOrdinal),requestRecipeVersion:1,requestRecipeFingerprint:RELIABILITY_V3_REQUEST_RECIPE_FINGERPRINT,
          fuseRequestBodySha256:`sha256:${createHash("sha256").update(fuseBody).digest("hex")}`,
          providerRequestBodySha256:`sha256:${createHash("sha256").update(providerBody).digest("hex")}`});
      }
    }
  }
  const replayTargets: ReliabilityV3Plan["replayTargets"] = [];
  for (let block = 1; block <= 5; block++) for (const lane of V3_LANES) {
    const callOrdinal = random.draw(1, 5);
    replayTargets.push({ block, lane: lane.id, callOrdinal,
      requestId: deriveReliabilityV3RequestId(runId, block, lane.id, callOrdinal) });
  }
  const basePayload = {
    schemaVersion: 2 as const, evidenceType: RELIABILITY_V3_EVIDENCE_TYPE, protocolVersion: 3 as const,
    runId, provider: RELIABILITY_V3_PROVIDER, model: RELIABILITY_V3_MODEL, allowFallbacks: false as const,
    adapterRetryCount: 0 as const, profileFingerprint: RELIABILITY_V3_PROFILE.profileFingerprint,
    beacon, identity, schedule: V3_SCHEDULE, lanes: V3_LANES, setup, calls, replayTargets,
    cost: { knownCostCapUsdMicros: "3000000" as const, unresolvedExposureCapUsdMicros: "320000" as const },
  };
  const planFingerprint=fingerprint(basePayload);
  const committedCalls:ReliabilityV3Call[]=calls.map(call=>{const laneAuthority=authority.find(item=>item.lane===call.lane)!;return {...call,
    requestCommitment:buildReliabilityV3RequestCommitment({runId,block:call.block,lane:call.lane,requestId:call.requestId,requestIdFullDigest:call.requestIdFullDigest,
      planFingerprint,profileFingerprint:RELIABILITY_V3_PROFILE.profileFingerprint,organizationId,authenticatedCredentialId:laneAuthority.credentialId,
      credentialOwnerId:laneAuthority.agentId,mandateId:laneAuthority.mandate.id,branchId:laneAuthority.children[call.branch-1].id,workloadClass:call.workloadClass,
      contextUnits:call.contextUnits,fuseRequestBodySha256:call.fuseRequestBodySha256,providerRequestBodySha256:call.providerRequestBodySha256,
      providerConfigurationId:setup.providerConfigurationId,providerCredentialId:setup.providerCredentialId,providerCredentialOwnerId:setup.providerCredentialOwnerId,
      providerCredentialVersion:setup.providerCredentialVersion,providerCredentialEncryptionKeyId:setup.providerCredentialEncryptionKeyId,
      providerCredentialCiphertextEnvelopeSha256:setup.providerCredentialCiphertextEnvelopeSha256})};});
  const plan = { ...basePayload,calls:committedCalls,planFingerprint };
  if (!internalSkipValidation) validateReliabilityV3Plan(plan, false);
  return plan;
}

const V3_PLAN_KEYS = ["adapterRetryCount", "allowFallbacks", "beacon", "calls", "cost", "evidenceType", "identity", "lanes", "model", "planFingerprint", "profileFingerprint", "protocolVersion", "provider", "replayTargets", "runId", "schedule", "schemaVersion", "setup"];
export function validateReliabilityV3Plan(plan: ReliabilityV3Plan, enforceTestGolden = true): void {
  if (!plan || typeof plan !== "object" || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(V3_PLAN_KEYS))
    throw new Error("RELIABILITY_V3_PLAN_UNKNOWN_FIELD");
  requireV3RunId(plan.runId);
  if (plan.schemaVersion !== 2 || plan.evidenceType !== RELIABILITY_V3_EVIDENCE_TYPE || plan.protocolVersion !== 3
    || plan.profileFingerprint !== RELIABILITY_V3_PROFILE.profileFingerprint
    || plan.provider !== RELIABILITY_V3_PROVIDER || plan.model !== RELIABILITY_V3_MODEL || plan.allowFallbacks !== false
    || plan.adapterRetryCount !== 0 || canonicalJson(plan.schedule) !== canonicalJson(V3_SCHEDULE)
    || canonicalJson(plan.lanes) !== canonicalJson(V3_LANES)) throw new Error("RELIABILITY_V3_PLAN_DRIFT");
  validateV3Identity(plan.identity);
  const { planFingerprint, ...payload } = plan;
  const calls=payload.calls.map(({requestCommitment:_,...call})=>call);
  if (planFingerprint !== fingerprint({...payload,calls})) throw new Error("RELIABILITY_V3_PLAN_FINGERPRINT_MISMATCH");
  const expected = buildReliabilityV3Plan(plan.beacon, plan.runId, plan.identity, true);
  if (canonicalJson(expected) !== canonicalJson(plan)) throw new Error("RELIABILITY_V3_PLAN_RECIPE_MISMATCH");
  if (enforceTestGolden && plan.beacon.randomness === "11".repeat(32)
    && plan.planFingerprint !== EXPECTED_V3_PLAN_FINGERPRINT_TEST_BEACON) throw new Error("RELIABILITY_V3_PLAN_GOLDEN_MISMATCH");
}

function validateV3Identity(identity: ExecutableV3Identity): void {
  const sha = /^sha256:[a-f0-9]{64}$/;
  const coordinates = RELIABILITY_V3_PROFILE.coordinates!;
  const expectedSources = coordinates.protocolSources;
  if (identity.preregistrationCommit !== RELIABILITY_V3_PREREGISTRATION_COMMIT
    || identity.inheritedV2Commit !== coordinates.inheritedV2Commit
    || identity.amendmentCommit !== coordinates.amendmentCommit
    || canonicalJson(identity.protocolSources) !== canonicalJson(expectedSources)
    || !/^[a-f0-9]{40}$/.test(identity.implementationCommit)
    || !/^[a-f0-9]{40}$/.test(identity.implementationTree) || !sha.test(identity.reviewDigest)
    || !sha.test(identity.buildDigest) || !sha.test(identity.runtimeImageDigest) || !sha.test(identity.schemaFingerprint)
    || !sha.test(identity.runnerDigest) || !sha.test(identity.adapterDigest)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(identity.providerCredentialEncryptionKeyId)
    || !sha.test(identity.providerCredentialCiphertextEnvelopeSha256)) throw new Error("RELIABILITY_V3_IDENTITY_UNREVIEWED");
}
