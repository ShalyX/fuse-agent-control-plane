import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  RELIABILITY_V4_CHAIN_HASH,
  RELIABILITY_V4_ROUND,
  RELIABILITY_V4_BEACON_AVAILABLE_AT,
  V4_AUTHORIZATION_WINDOW,
  V4_SCHEDULE,
  V4_ARTIFACT_ROOT,
  EXPECTED_V4_PLAN_FINGERPRINT_TEST_BEACON,
  buildReliabilityV4Plan,
  deriveReliabilityV4RequestId,
  validateReliabilityV4Plan,
  verifyReliabilityV4ChainedBeacon,
  type ExecutableV4Identity,
  type VerifiedReliabilityV4Beacon,
} from "../src/evidence/heldOutReliabilityV4.js";
import { reliabilityArtifactNamespace } from "../src/evidence/reliabilityArtifactNamespace.js";
import { canonicalFinalCommitPath, preliminaryReplayArtifactPath } from "../src/evidence/finalEvidenceClosure.js";
import { expectedReliabilityArtifactPaths } from "../src/evidence/authoritativeEvidence.js";
import * as authoritativeEvidence from "../src/evidence/authoritativeEvidence.js";
import * as settlementClosure from "../src/evidence/evidenceSettlementClosure.js";
import * as artifactReconstruction from "../src/evidence/artifactReconstruction.js";
import { expectedProductionSetupSnapshot, productionSetupCountsExact, v4AuthorizationIdentityValid } from "../scripts/held-out-reliability-v4.js";
import * as v4Runner from "../scripts/held-out-reliability-v4.js";
import { V4_AUTHORIZATION_ISSUERS } from "../src/reliability/issuersV4.js";
import type { AuthorizationArtifact } from "../src/evidence/reliabilityRuntimeV2.js";
import { buildReplayAuthorizationInventory, deterministicAuthorizationDecisionId, reconciliationRequestCommitmentMatches, ReliabilityProtocolStore } from "../src/reliability/protocolStore.js";
import * as v4Module from "../src/evidence/heldOutReliabilityV4.js";

const protocolSources = [
  {
    path: "docs/held-out-reliability-protocol-v2.md",
    commit: "6c6ef80f909998af45576baa07e03733cd5d0950",
    gitBlob: "a0c750c4826cf838ad338e7f135a0622d34f4cca",
    sha256: "sha256:841909a2a99ba29eb6b80179cd2bf267ef1f73dab4f1af1870680e6cc20d4c96",
  },
  {
    path: "docs/held-out-reliability-protocol-v3.md",
    commit: "9a3ba41770e251e15065e14f49c2193f365c3afb",
    gitBlob: "562f516e55304e9befe40b811ce1fc1eafd01789",
    sha256: "sha256:7572ce3364859cba49bb0e2f725a61309f4435acac53a282c0882c1f56f0d631",
  },
  {
    path: "docs/held-out-reliability-protocol-v4.md",
    commit: "1055aecef8b0e10eda3af02334fa432fffd564da",
    gitBlob: "fc3207ec0414573ed430d391eb2b012ad1d3110c",
    sha256: "sha256:089c21170a3550f557522f8aab1a72fcc713507962ee85e1e7c77721c7e5447f",
  },
] as const;

const identity: ExecutableV4Identity = {
  preregistrationCommit: "1055aecef8b0e10eda3af02334fa432fffd564da",
  inheritedV2Commit: "6c6ef80f909998af45576baa07e03733cd5d0950",
  inheritedV3Commit: "9a3ba41770e251e15065e14f49c2193f365c3afb",
  amendmentCommit: "1055aecef8b0e10eda3af02334fa432fffd564da",
  protocolSources,
  implementationCommit: "1".repeat(40),
  implementationTree: "2".repeat(40),
  reviewDigest: `sha256:${"3".repeat(64)}`,
  buildDigest: `sha256:${"4".repeat(64)}`,
  runtimeImageDigest: `sha256:${"5".repeat(64)}`,
  schemaFingerprint: `sha256:${"6".repeat(64)}`,
  runnerDigest: `sha256:${"7".repeat(64)}`,
  adapterDigest: `sha256:${"8".repeat(64)}`,
  providerCredentialEncryptionKeyId: "test-key",
  providerCredentialCiphertextEnvelopeSha256: `sha256:${"a".repeat(64)}`,
};

const beacon: VerifiedReliabilityV4Beacon = {
  round: 6_355_320,
  randomness: "11".repeat(32),
  signature: "22".repeat(96),
  previousSignature: "33".repeat(96),
  chainHash: "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce",
  verified: true,
};

describe("held-out provider-path reliability protocol v4", () => {
  it("classifies absent and malformed signed artifacts through the total readiness matrix", () => {
    const classify=(v4Runner as unknown as Record<string,unknown>)["classifyPresentedAuthorizationArtifacts"];
    expect(classify).toBeTypeOf("function");
    const absent=(classify as (operator?:Buffer,reconciler?:Buffer)=>any)();
    expect(absent).toMatchObject({operator:null,reconciliation:null,operatorArtifactSha256:"absent",reconciliationArtifactSha256:"absent"});
    const malformed=(classify as (operator?:Buffer,reconciler?:Buffer)=>any)(Buffer.from("{"),Buffer.from("not-json"));
    expect(malformed.operator).toBeNull();
    expect(malformed.reconciliation).toBeNull();
    expect(malformed.operatorArtifactSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(malformed.reconciliationArtifactSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("matches the normative request-recipe and request-commitment golden vectors",()=>{
    const module=v4Module as unknown as Record<string,unknown>;
    expect(module["RELIABILITY_V4_REQUEST_RECIPE_FINGERPRINT"]).toBe("sha256:cfc5442e706679541709f76eede919150b2a867021a700d2d47a23dace040da2");
    const build=module["buildReliabilityV4RequestCommitment"] as undefined|((input:Record<string,unknown>)=>string);
    expect(build).toBeTypeOf("function");
    expect(build!({runId:"hov4-golden",block:1,lane:"normal-paced",requestId:`hov4_${"0".repeat(48)}`,
      requestIdFullDigest:"0".repeat(64),planFingerprint:`sha256:${"0".repeat(64)}`,profileFingerprint:`sha256:${"0".repeat(64)}`,
      organizationId:"hov4-golden",authenticatedCredentialId:"hov4-golden-credential-normal-paced",credentialOwnerId:"hov4-golden-agent-normal-paced",
      mandateId:"hov4-golden-mandate-normal-paced",branchId:"hov4-golden-child-normal-paced-1",workloadClass:"baseline-lookup",contextUnits:1,
      fuseRequestBodySha256:`sha256:${"0".repeat(64)}`,providerRequestBodySha256:`sha256:${"0".repeat(64)}`,
      providerConfigurationId:"hov4-golden-openrouter",providerCredentialId:"hov4-golden-openrouter-credential",
      providerCredentialOwnerId:"hov4-golden-provider-owner",providerCredentialVersion:1,providerCredentialEncryptionKeyId:"golden-key",
      providerCredentialCiphertextEnvelopeSha256:`sha256:${"0".repeat(64)}`}))
      .toBe("sha256:3e5cac75120ed8a6cb0d59e988685de533b3d6377d9986e0195c44ba37ec3af7");
  });

  it("seals every exact request byte coordinate before dispatch",()=>{
    const plan=buildReliabilityV4Plan(beacon,"hov4-request-bytes",identity);
    expect(plan.calls.every(call=>call.requestRecipeVersion===1
      &&call.requestRecipeFingerprint==="sha256:cfc5442e706679541709f76eede919150b2a867021a700d2d47a23dace040da2"
      &&/^sha256:[a-f0-9]{64}$/.test(call.fuseRequestBodySha256)
      &&/^sha256:[a-f0-9]{64}$/.test(call.providerRequestBodySha256)
      &&/^[a-f0-9]{64}$/.test(call.requestIdFullDigest)
      &&/^sha256:[a-f0-9]{64}$/.test(call.requestCommitment))).toBe(true);
  });

  it("rejects arbitrary v4 seal output coordinates before beacon processing", async () => {
    const operations=v4Runner.createReliabilityOperations("/tmp");
    await expect(operations.seal!({
      args:["--run-id","hov4-output-rejection","--identity","identity.json","--output","elsewhere.json"],
      files:{beacon:"{}"},
    } as never)).rejects.toThrow("BEACON_PLAN_ARBITRARY_OUTPUT_FORBIDDEN");
  });
  it("pins the publicly preregistered v4 beacon and timing constants", () => {
    expect(RELIABILITY_V4_CHAIN_HASH).toBe("8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce");
    expect(RELIABILITY_V4_ROUND).toBe(6_355_320);
    expect(RELIABILITY_V4_BEACON_AVAILABLE_AT).toBe("2026-08-07T08:17:00.000Z");
    expect(V4_AUTHORIZATION_WINDOW).toEqual({ startsAt: "2026-08-08T08:16:00.000Z", startsBefore: "2026-08-08T08:16:01.000Z", operationDeadlineMs: 55_000 });
    expect(V4_SCHEDULE).toHaveLength(5);
    expect(V4_SCHEDULE[0]).toEqual({ block: 1, opensAt: "2026-08-08T08:17:00.000Z", launchDeadline: "2026-08-08T08:22:00.000Z" });
    expect(V4_SCHEDULE[4]).toEqual({ block: 5, opensAt: "2026-08-10T08:17:00.000Z", launchDeadline: "2026-08-10T08:22:00.000Z" });
    expect(V4_ARTIFACT_ROOT).toBe("evidence/held-out-reliability-v4");
  });

  it("builds a deterministic v4 plan with disjoint identities and inherited fixed semantics", () => {
    const first = buildReliabilityV4Plan(beacon, "hov4-qualification-001", identity);
    const second = buildReliabilityV4Plan(beacon, "hov4-qualification-001", identity);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 2,
      evidenceType: "held-out-reliability-v4",
      protocolVersion: 4,
      provider: "openrouter",
      model: "nousresearch/hermes-4-405b",
      allowFallbacks: false,
      adapterRetryCount: 0,
      cost: { knownCostCapUsdMicros: "3000000", unresolvedExposureCapUsdMicros: "320000" },
    });
    expect(first.calls).toHaveLength(100);
    expect(first.planFingerprint).toBe(EXPECTED_V4_PLAN_FINGERPRINT_TEST_BEACON);
    expect(first.replayTargets).toHaveLength(20);
    expect(new Set(first.calls.map((call) => call.requestId)).size).toBe(100);
    expect(first.calls.every((call) => call.requestId.startsWith("hov4_"))).toBe(true);
    expect(first.setup.organizationId).toBe("hov4-qualification-001");
    expect(first.setup.hardFinalizationAt).toBe("2026-08-11T09:30:00.000Z");
    expect(first.setup.authority.every((item) => item.policy.expiresAt === "2026-08-11T10:30:00.000Z")).toBe(true);
    expect(() => validateReliabilityV4Plan(first)).not.toThrow();
  });

  it("replays pending hard-finalization support before the canonical report on restart", async () => {
    const calls:string[]=[];
    const recover=(v4Runner as unknown as {publishPendingV4FinalizationArtifacts:(store:unknown,runId:string,support:()=>Promise<void>,report:()=>Promise<void>)=>Promise<unknown>}).publishPendingV4FinalizationArtifacts;
    await recover({
      publishPendingFailureReport:async()=>{calls.push("support");return {published:true,paths:["support"]};},
      publishPendingReportIntent:async()=>{calls.push("report");return {published:true,path:"report",report:{passed:false}};},
    },"hov4-hard-finalization-restart",async()=>{},async()=>{});
    expect(calls).toEqual(["support","report"]);
  });

  it("registers the normative v4 request commitment identically from setup and run", () => {
    const plan=buildReliabilityV4Plan(beacon,"hov4-register-commitment",identity);
    const registration=v4Runner.v4SealedCallRegistration(plan,plan.calls[0]!);
    expect(registration.requestCommitment).toBe(plan.calls[0]!.requestCommitment);
    const common={body:registration.body,organizationId:registration.organizationId,credentialId:registration.credentialId,
      mandateId:registration.mandateId,branchId:registration.branchId,workloadClass:registration.workloadClass,requestId:registration.requestId};
    expect(reconciliationRequestCommitmentMatches({protocolVersion:4},{stored:registration.requestCommitment,sealed:registration.requestCommitment,...common})).toBe(true);
    expect(reconciliationRequestCommitmentMatches({protocolVersion:4},{stored:registration.requestCommitment,sealed:`sha256:${"0".repeat(64)}`,...common})).toBe(false);
  });

  it("initializes the exact v4 control before setup readiness mutations", async () => {
    const plan=buildReliabilityV4Plan(beacon,"hov4-setup-control",identity);
    const initialize=(v4Runner as unknown as Record<string,unknown>)["initializeV4SetupControl"];
    expect(initialize).toBeTypeOf("function");
    const calls:unknown[]=[];
    await (initialize as (store:unknown,plan:unknown)=>Promise<void>)({initializeRun:async(input:unknown)=>{calls.push(input);}},plan);
    expect(calls).toEqual([expect.objectContaining({runId:plan.runId,planFingerprint:plan.planFingerprint,
      lanes:["normal-paced","high-envelope","bounded-burst","restart-resume"],profile:expect.objectContaining({protocolVersion:4})})]);
  });

  it("requires every setup principal, credential, and provider binding in the exact snapshot", () => {
    const plan=buildReliabilityV4Plan(beacon,"hov4-principal-readiness",identity);
    const snapshot=expectedProductionSetupSnapshot(plan) as unknown as Record<string,any>;
    expect(snapshot.principals).toEqual([
      {kind:"setup_admin",serviceAccountId:plan.setup.setupAdminActorId,credentialId:plan.setup.setupAdminCredentialId,credentialOwnerId:plan.setup.setupAdminActorId,capabilities:["reliability:setup"],active:true,payer:false},
      {kind:"provider_owner",serviceAccountId:plan.setup.providerCredentialOwnerId,credentialId:plan.setup.providerCredentialId,credentialOwnerId:plan.setup.providerCredentialOwnerId,role:"admin",capabilities:["provider:configure"],credentialCapabilities:["provider:invoke:openrouter"],active:true,payer:false},
      {kind:"operator",serviceAccountId:plan.setup.operatorServiceAccountId,credentialId:plan.setup.operatorCredentialId,credentialOwnerId:plan.setup.operatorServiceAccountId,capabilities:["reliability:operate"],active:true,payer:false},
      {kind:"runner",serviceAccountId:plan.setup.runnerServiceAccountId,credentialId:plan.setup.runnerOrchestrationCredentialId,credentialOwnerId:plan.setup.runnerServiceAccountId,capabilities:["reliability:orchestrate"],active:true,payer:false},
      {kind:"reconciliation",serviceAccountId:plan.setup.reconcilerServiceAccountId,credentialId:plan.setup.reconcilerCredentialId,credentialOwnerId:plan.setup.reconcilerServiceAccountId,capabilities:["reliability:reconcile"],active:true,payer:false},
    ]);
    expect(snapshot.provider).toMatchObject({credentialId:plan.setup.providerCredentialId,credentialOwnerId:plan.setup.providerCredentialOwnerId,
      credentialCapabilities:["provider:invoke:openrouter"],soleCredential:true,ciphertextEnvelopeSha256:plan.setup.providerCredentialCiphertextEnvelopeSha256});
    expect(snapshot.payerAbsence).toEqual({principals:0,credentials:0,paymentConfigurations:0,paymentCapabilities:0});
    expect(snapshot.identityIsolation).toEqual({allDistinct:true,principalCount:11});
    expect(snapshot.cardinalities).toEqual({organizations:"1",providers:"1",serviceAccounts:"5",serviceAccountCredentials:"5",agents:"4",credentials:"4",policies:"4",mandates:"4",branches:"12"});
    expect(snapshot.lanes.every((lane:Record<string,any>)=>JSON.stringify(lane.credential.capabilities)==='["inference:execute"]')).toBe(true);
    expect(productionSetupCountsExact(snapshot.cardinalities)).toBe(true);
    expect(productionSetupCountsExact({...snapshot.cardinalities,credentials:"5"})).toBe(false);
    expect(new Set(snapshot.principals.map((principal:Record<string,string>)=>principal.serviceAccountId)).size).toBe(5);
  });

  it("binds reconciliation verification to the complete v4 protocol identity", () => {
    const plan=buildReliabilityV4Plan(beacon,"hov4-reconciliation-identity",identity);
    const builder=(v4Runner as unknown as Record<string,unknown>)["v4AuthorizationVerificationOptions"];
    expect(builder).toBeTypeOf("function");
    expect((builder as (plan:unknown,kind:string,now:string)=>unknown)(plan,"reconciliation","2026-08-07T09:00:00.000Z")).toMatchObject({
      now:"2026-08-07T09:00:00.000Z",expectedRunId:plan.runId,expectedPlanFingerprint:plan.planFingerprint,
      expectedProtocolIdentity:{organizationId:plan.setup.organizationId,profileFingerprint:plan.profileFingerprint,
        serviceAccountId:plan.setup.reconcilerServiceAccountId,credentialId:plan.setup.reconcilerCredentialId,
        credentialOwnerId:plan.setup.reconcilerServiceAccountId},
    });
  });

  it("binds every sealed plan to the merged amendment sources and production profile", () => {
    const sourceBoundIdentity = {
      ...identity,
      inheritedV2Commit: "6c6ef80f909998af45576baa07e03733cd5d0950",
      inheritedV3Commit: "9a3ba41770e251e15065e14f49c2193f365c3afb",
      amendmentCommit: "1055aecef8b0e10eda3af02334fa432fffd564da",
      protocolSources,
    } as ExecutableV4Identity;
    const plan = buildReliabilityV4Plan(beacon, "hov4-source-bound", sourceBoundIdentity);
    expect((plan as unknown as Record<string, unknown>).profileFingerprint)
      .toBe("sha256:fbb455b9faa778aef5b00bce3422fbcef3dcef74e25526132fcda04c6dd2f434");
    expect(plan.identity).toMatchObject({
      inheritedV2Commit: "6c6ef80f909998af45576baa07e03733cd5d0950",
      inheritedV3Commit: "9a3ba41770e251e15065e14f49c2193f365c3afb",
      amendmentCommit: "1055aecef8b0e10eda3af02334fa432fffd564da",
      protocolSources,
    });
    expect(() => buildReliabilityV4Plan(beacon, "hov4-source-wrong", {
      ...sourceBoundIdentity,
      amendmentCommit: "0".repeat(40),
    } as ExecutableV4Identity)).toThrow("RELIABILITY_V4_IDENTITY_UNREVIEWED");
  });

  it("uses v4 domains and refuses v1/v2 run and identity reuse", () => {
    const v4 = deriveReliabilityV4RequestId("hov4-qualification-001", 1, "normal-paced", 1);
    const expected=createHash("sha256").update(JSON.stringify({block:1,callOrdinal:1,domain:"fuse-held-out-reliability-v4-request",lane:"normal-paced",protocolVersion:4,runId:"hov4-qualification-001"})).digest("hex");
    expect(v4).toBe(`hov4_${expected.slice(0,48)}`);
    expect(v4).toMatch(/^hov4_[a-f0-9]{48}$/);
    expect(() => deriveReliabilityV4RequestId("run-v2-test", 1, "normal-paced", 1)).toThrow("RELIABILITY_V4_RUN_ID_INVALID");
    expect(() => buildReliabilityV4Plan(beacon, "hov4-qualification-001", { ...identity, preregistrationCommit: "6c6ef80" })).toThrow("RELIABILITY_V4_IDENTITY_UNREVIEWED");
  });

  it("derives the preregistered v4 authorization and replay golden IDs", () => {
    const zero = `sha256:${"0".repeat(64)}`;
    const decisionId = deterministicAuthorizationDecisionId({
      runId: "hov4-golden", planFingerprint: zero, profileFingerprint: zero,
      decisionKind: "readiness_predecision_failed", reasonCode: "READINESS_PREDECISION_FAILED",
      operatorArtifactSha256: "absent", reconciliationArtifactSha256: "absent",
    });
    expect(decisionId).toBe("bbac0f3b-3c93-5daa-aa2c-bbf16befb84a");
    const requestIds = [`hov4_${"0".repeat(48)}`, ...Array.from({ length: 19 }, (_, index) => `hov4_${String(index + 1).padStart(48, "0")}`)];
    const inventory = buildReplayAuthorizationInventory({
      runId: "hov4-golden", planFingerprint: zero, profileFingerprint: zero,
      authorizationDecisionId: decisionId, requestIds,
    });
    expect(inventory[0]?.operationId).toBe("replay-a692751f7a7adc0a42cc13b6d284ec9b214dc51c0f3de3e5ed3ad67c0d5d35e4");
  });

  it("returns the sealed v4 request commitment at the HTTP authorization boundary", async () => {
    let query = 0;
    const store = new ReliabilityProtocolStore({ query: async () => (++query === 1
      ? { rows: [{ protocol_bound: true }] }
      : { rows: [{ call_ordinal: 1, request_commitment: `sha256:${"a".repeat(64)}` }] }) } as any);
    const result = await store.authorizeHttpReliabilityContext({
      runId: "hov4-boundary", laneId: "normal-paced", block: 1, requestId: `hov4_${"1".repeat(48)}`,
      organizationId: "organization", agentId: "agent", credentialId: "credential", mandateId: "mandate",
      branchId: "branch", workloadClass: "normal-paced", model: "nousresearch/hermes-4-405b", maxOutputTokens: 8,
      body: { model: "nousresearch/hermes-4-405b" },
    });
    expect(result).toMatchObject({ kind: "reliability", callOrdinal: 1, requestCommitment: `sha256:${"a".repeat(64)}` });
  });

  it("enforces the published 102-character complete v4 run-ID ceiling and 128-character setup-ID ceiling", () => {
    const atLimit = `hov4-${"a".repeat(96)}:`;
    const overLimit = `hov4-${"a".repeat(97)}:`;
    expect(() => deriveReliabilityV4RequestId(atLimit, 1, "normal-paced", 1)).not.toThrow();
    expect(() => deriveReliabilityV4RequestId(overLimit, 1, "normal-paced", 1))
      .toThrow("RELIABILITY_V4_RUN_ID_INVALID");
    const maxPlan = buildReliabilityV4Plan({ ...beacon, randomness: "22".repeat(32) }, atLimit, identity);
    expect(() => validateReliabilityV4Plan(maxPlan)).not.toThrow();
    const setupIds = [maxPlan.setup.organizationId, maxPlan.setup.providerConfigurationId,
      maxPlan.setup.runnerServiceAccountId, maxPlan.setup.reconcilerServiceAccountId, maxPlan.setup.reconcilerCredentialId,
      ...maxPlan.setup.authority.flatMap(item => [item.agentId, item.credentialId, item.policy.id, item.mandate.id, item.root.id, ...item.children.map(child => child.id)])];
    expect(Math.max(...setupIds.map(value => value.length))).toBe(128);
    expect(setupIds.every(value => value.length <= 128)).toBe(true);
  });

  it("rejects noncanonical v4 scheduler manifest paths before durable mutation", async () => {
    const store=new ReliabilityProtocolStore({query:async()=>{throw new Error("DATABASE_MUST_NOT_BE_REACHED");}} as never);
    await expect(store.acquireSchedulerClaim({runId:"hov4-scheduler-path",requestId:"request-1",laneId:"normal-paced",block:1,
      ownerId:"worker",leaseSeconds:30,manifestPath:"/tmp/arbitrary.json"})).rejects.toThrow("SCHEDULER_MANIFEST_PATH_INVALID");
  });

  it("routes every v4 artifact to a namespace disjoint from historical v2", () => {
    const runId = "hov4-qualification-001";
    const namespace = reliabilityArtifactNamespace(runId);
    expect(namespace).toMatchObject({
      root: "evidence/held-out-reliability-v4",
      evidenceType: "held-out-reliability-v4",
      protocolVersion: 4,
      protocolArtifact: "held-out-reliability-v4.json",
      beaconRound: 6_355_320,
    });
    expect(canonicalFinalCommitPath(runId)).toBe(`evidence/held-out-reliability-v4/replay/${runId}.json`);
    expect(preliminaryReplayArtifactPath(runId)).toBe(`evidence/held-out-reliability-v4/replay-preliminary/${runId}.json`);
    const paths = expectedReliabilityArtifactPaths({ runId, planFingerprint: `sha256:${"a".repeat(64)}`, incidentPaths: [] });
    expect(paths).toHaveLength(32);
    expect(paths.every((path) => path.startsWith("evidence/held-out-reliability-v4/")
      || path.startsWith("evidence/.run-claims/held-out-reliability-v4/"))).toBe(true);

    expect(reliabilityArtifactNamespace("historical-v2").protocolVersion).toBe(2);
    expect(canonicalFinalCommitPath("historical-v2")).toBe("evidence/held-out-reliability/replay/historical-v2.json");
  });

  it("uses the preregistered v4 hard-finalization deadline", () => {
    const deadlineFor = (authoritativeEvidence as unknown as { hardFinalizationDeadlineForRunId?: (runId:string)=>string }).hardFinalizationDeadlineForRunId;
    expect(deadlineFor).toBeTypeOf("function");
    expect(deadlineFor?.("hov4-deadline")).toBe("2026-08-11T09:30:00.000Z");
    expect(deadlineFor?.("hov3-deadline")).toBe("2026-08-05T09:30:00.000Z");
  });

  it("selects the preregistered v4 schedule for settlement", () => {
    const scheduleFor = (settlementClosure as unknown as { reliabilityScheduleForRunId?: (runId:string)=>readonly {opensAt:string}[] }).reliabilityScheduleForRunId;
    expect(scheduleFor).toBeTypeOf("function");
    expect(scheduleFor?.("hov4-settlement")[0]?.opensAt).toBe("2026-08-08T08:17:00.000Z");
    expect(scheduleFor?.("hov3-settlement")[0]?.opensAt).toBe("2026-08-02T08:17:00.000Z");
  });

  it("attributes the inherited four-lane claim inventory to the v4 amendment", () => {
    const sourceFor = (artifactReconstruction as unknown as { claimInventoryAuthoritySource?: (runId:string)=>string }).claimInventoryAuthoritySource;
    expect(sourceFor).toBeTypeOf("function");
    expect(sourceFor?.("hov4-evidence")).toBe("docs/held-out-reliability-protocol-v4.md:inherited-v3-four-lane-claims");
    expect(sourceFor?.("hov3-evidence")).toBe("docs/held-out-reliability-protocol-v3.md:inherited-v2-four-lane-claims");
  });

  it("accepts only the exact run-derived v4 authorization actor, expiry, and nonce", () => {
    const plan = buildReliabilityV4Plan(beacon, "hov4-qualification-001", identity);
    const operator = { payload: {
      kind: "operator", runId: plan.runId, organizationId: plan.setup.organizationId,
      planFingerprint: plan.planFingerprint, profileFingerprint: plan.profileFingerprint,
      executableFingerprint: `sha256:${createHash("sha256").update(v4Module.canonicalJson(plan.identity)).digest("hex")}`, actorId: `${plan.runId}-operator`,
      serviceAccountId: plan.setup.operatorServiceAccountId, credentialId: plan.setup.operatorCredentialId,
      credentialOwnerId: plan.setup.operatorServiceAccountId,
      issuerCredentialId: V4_AUTHORIZATION_ISSUERS.operator.id,
      capability: "evidence:authorize-spend", nonce: `hov4:${plan.runId}:${"a".repeat(64)}`,
      expiresAt: "2026-08-08T08:22:00.000Z",
    }, signature: "AA==" } as unknown as AuthorizationArtifact;
    expect(v4AuthorizationIdentityValid(plan, operator, "operator")).toBe(true);
    const missingCredential={...operator,payload:{...operator.payload,credentialId:undefined}} as unknown as AuthorizationArtifact;
    expect(v4AuthorizationIdentityValid(plan, missingCredential, "operator")).toBe(false);
    expect(v4AuthorizationIdentityValid(plan, { ...operator, payload: { ...operator.payload, nonce: "v2-nonce" } }, "operator")).toBe(false);
    expect(v4AuthorizationIdentityValid(plan, { ...operator, payload: { ...operator.payload, issuerCredentialId: "ed25519:v2" } }, "operator")).toBe(false);
    expect(v4AuthorizationIdentityValid(plan, { ...operator, payload: { ...operator.payload, expiresAt: "2026-07-28T09:30:00.000Z" } }, "operator")).toBe(false);
  });

  it("verifies only the pinned v4 round through the chained BLS boundary", async () => {
    const raw = { round: 6_355_320, randomness: "11".repeat(32), signature: "22".repeat(96), previous_signature: "33".repeat(96) };
    const verifier = async (input: { round: number }) => input.round === 6_355_320;
    await expect(verifyReliabilityV4ChainedBeacon(raw, verifier)).resolves.toMatchObject({ round: 6_355_320, verified: true });
    await expect(verifyReliabilityV4ChainedBeacon({ ...raw, round: 6_315_000 }, verifier)).rejects.toThrow("RELIABILITY_V4_BEACON_INVALID");
  });
});
