import { describe, expect, it } from "vitest";
import {
  RELIABILITY_V3_CHAIN_HASH,
  RELIABILITY_V3_ROUND,
  RELIABILITY_V3_BEACON_AVAILABLE_AT,
  V3_AUTHORIZATION_WINDOW,
  V3_SCHEDULE,
  V3_ARTIFACT_ROOT,
  EXPECTED_V3_PLAN_FINGERPRINT_TEST_BEACON,
  buildReliabilityV3Plan,
  deriveReliabilityV3RequestId,
  validateReliabilityV3Plan,
  verifyReliabilityV3ChainedBeacon,
  type ExecutableV3Identity,
  type VerifiedReliabilityV3Beacon,
} from "../src/evidence/heldOutReliabilityV3.js";
import { reliabilityArtifactNamespace } from "../src/evidence/reliabilityArtifactNamespace.js";
import { canonicalFinalCommitPath, preliminaryReplayArtifactPath } from "../src/evidence/finalEvidenceClosure.js";
import { expectedReliabilityArtifactPaths } from "../src/evidence/authoritativeEvidence.js";
import { expectedProductionSetupSnapshot, v3AuthorizationIdentityValid } from "../scripts/held-out-reliability-v3.js";
import * as v3Runner from "../scripts/held-out-reliability-v3.js";
import { V3_AUTHORIZATION_ISSUERS } from "../src/reliability/issuersV3.js";
import type { AuthorizationArtifact } from "../src/evidence/reliabilityRuntimeV2.js";
import * as v3Module from "../src/evidence/heldOutReliabilityV3.js";

const protocolSources = [
  {
    path: "docs/held-out-reliability-protocol-v2.md",
    commit: "6c6ef80f909998af45576baa07e03733cd5d0950",
    gitBlob: "a0c750c4826cf838ad338e7f135a0622d34f4cca",
    sha256: "sha256:841909a2a99ba29eb6b80179cd2bf267ef1f73dab4f1af1870680e6cc20d4c96",
  },
  {
    path: "docs/held-out-reliability-protocol-v3.md",
    commit: "a8001d519c108f7cc55efeb4d1e6cc032bbf98a9",
    gitBlob: "562f516e55304e9befe40b811ce1fc1eafd01789",
    sha256: "sha256:7572ce3364859cba49bb0e2f725a61309f4435acac53a282c0882c1f56f0d631",
  },
] as const;

const identity: ExecutableV3Identity = {
  preregistrationCommit: "0a29a7e63d3659c1c374f535aeac9da2ca2d4d69",
  inheritedV2Commit: "6c6ef80f909998af45576baa07e03733cd5d0950",
  amendmentCommit: "a8001d519c108f7cc55efeb4d1e6cc032bbf98a9",
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

const beacon: VerifiedReliabilityV3Beacon = {
  round: 6_338_040,
  randomness: "11".repeat(32),
  signature: "22".repeat(96),
  previousSignature: "33".repeat(96),
  chainHash: "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce",
  verified: true,
};

describe("held-out provider-path reliability protocol v3", () => {
  it("classifies absent and malformed signed artifacts through the total readiness matrix", () => {
    const classify=(v3Runner as unknown as Record<string,unknown>)["classifyPresentedAuthorizationArtifacts"];
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
    const module=v3Module as unknown as Record<string,unknown>;
    expect(module["RELIABILITY_V3_REQUEST_RECIPE_FINGERPRINT"]).toBe("sha256:8c1f93cee52535ecc3568970e8a52b1efeb2e78f44cf46ae5aa440a067b64fa2");
    const build=module["buildReliabilityV3RequestCommitment"] as undefined|((input:Record<string,unknown>)=>string);
    expect(build).toBeTypeOf("function");
    expect(build!({runId:"hov3-golden",block:1,lane:"normal-paced",requestId:`hov3_${"0".repeat(48)}`,
      requestIdFullDigest:"0".repeat(64),planFingerprint:`sha256:${"0".repeat(64)}`,profileFingerprint:`sha256:${"0".repeat(64)}`,
      organizationId:"hov3-golden",authenticatedCredentialId:"hov3-golden-credential-normal-paced",credentialOwnerId:"hov3-golden-agent-normal-paced",
      mandateId:"hov3-golden-mandate-normal-paced",branchId:"hov3-golden-child-normal-paced-1",workloadClass:"baseline-lookup",contextUnits:1,
      fuseRequestBodySha256:`sha256:${"0".repeat(64)}`,providerRequestBodySha256:`sha256:${"0".repeat(64)}`,
      providerConfigurationId:"hov3-golden-openrouter",providerCredentialId:"hov3-golden-openrouter-credential",
      providerCredentialOwnerId:"hov3-golden-provider-owner",providerCredentialVersion:1,providerCredentialEncryptionKeyId:"golden-key",
      providerCredentialCiphertextEnvelopeSha256:`sha256:${"0".repeat(64)}`}))
      .toBe("sha256:4837489bdb7807c708e80aaa5cf83df15fbb51e2b15d5adc2e39778cd4eaed59");
  });

  it("seals every exact request byte coordinate before dispatch",()=>{
    const plan=buildReliabilityV3Plan(beacon,"hov3-request-bytes",identity);
    expect(plan.calls.every(call=>call.requestRecipeVersion===1
      &&call.requestRecipeFingerprint==="sha256:8c1f93cee52535ecc3568970e8a52b1efeb2e78f44cf46ae5aa440a067b64fa2"
      &&/^sha256:[a-f0-9]{64}$/.test(call.fuseRequestBodySha256)
      &&/^sha256:[a-f0-9]{64}$/.test(call.providerRequestBodySha256)
      &&/^[a-f0-9]{64}$/.test(call.requestIdFullDigest)
      &&/^sha256:[a-f0-9]{64}$/.test(call.requestCommitment))).toBe(true);
  });
  it("pins the publicly preregistered v3 beacon and timing constants", () => {
    expect(RELIABILITY_V3_CHAIN_HASH).toBe("8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce");
    expect(RELIABILITY_V3_ROUND).toBe(6_338_040);
    expect(RELIABILITY_V3_BEACON_AVAILABLE_AT).toBe("2026-08-01T08:17:00.000Z");
    expect(V3_AUTHORIZATION_WINDOW).toEqual({ startsAt: "2026-08-02T08:16:00.000Z", startsBefore: "2026-08-02T08:16:01.000Z", operationDeadlineMs: 55_000 });
    expect(V3_SCHEDULE).toHaveLength(5);
    expect(V3_SCHEDULE[0]).toEqual({ block: 1, opensAt: "2026-08-02T08:17:00.000Z", launchDeadline: "2026-08-02T08:22:00.000Z" });
    expect(V3_SCHEDULE[4]).toEqual({ block: 5, opensAt: "2026-08-04T08:17:00.000Z", launchDeadline: "2026-08-04T08:22:00.000Z" });
    expect(V3_ARTIFACT_ROOT).toBe("evidence/held-out-reliability-v3");
  });

  it("builds a deterministic v3 plan with disjoint identities and inherited fixed semantics", () => {
    const first = buildReliabilityV3Plan(beacon, "hov3-qualification-001", identity);
    const second = buildReliabilityV3Plan(beacon, "hov3-qualification-001", identity);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 2,
      evidenceType: "held-out-reliability-v3",
      protocolVersion: 3,
      provider: "openrouter",
      model: "nousresearch/hermes-4-405b",
      allowFallbacks: false,
      adapterRetryCount: 0,
      cost: { knownCostCapUsdMicros: "3000000", unresolvedExposureCapUsdMicros: "320000" },
    });
    expect(first.calls).toHaveLength(100);
    expect(first.planFingerprint).toBe(EXPECTED_V3_PLAN_FINGERPRINT_TEST_BEACON);
    expect(first.replayTargets).toHaveLength(20);
    expect(new Set(first.calls.map((call) => call.requestId)).size).toBe(100);
    expect(first.calls.every((call) => call.requestId.startsWith("hov3_"))).toBe(true);
    expect(first.setup.organizationId).toBe("hov3-qualification-001");
    expect(first.setup.hardFinalizationAt).toBe("2026-08-05T09:30:00.000Z");
    expect(first.setup.authority.every((item) => item.policy.expiresAt === "2026-08-05T10:30:00.000Z")).toBe(true);
    expect(() => validateReliabilityV3Plan(first)).not.toThrow();
  });

  it("requires every setup principal, credential, and provider binding in the exact snapshot", () => {
    const plan=buildReliabilityV3Plan(beacon,"hov3-principal-readiness",identity);
    const snapshot=expectedProductionSetupSnapshot(plan) as unknown as Record<string,any>;
    expect(snapshot.principals).toEqual([
      {kind:"setup_admin",serviceAccountId:plan.setup.setupAdminActorId,credentialId:plan.setup.setupAdminCredentialId,credentialOwnerId:plan.setup.setupAdminActorId,capabilities:["reliability:setup"],active:true,payer:false},
      {kind:"provider_owner",serviceAccountId:plan.setup.providerCredentialOwnerId,credentialId:plan.setup.providerCredentialId,credentialOwnerId:plan.setup.providerCredentialOwnerId,capabilities:["provider:configure"],active:true,payer:false},
      {kind:"operator",serviceAccountId:plan.setup.operatorServiceAccountId,credentialId:plan.setup.operatorCredentialId,credentialOwnerId:plan.setup.operatorServiceAccountId,capabilities:["reliability:operate"],active:true,payer:false},
      {kind:"runner",serviceAccountId:plan.setup.runnerServiceAccountId,credentialId:plan.setup.runnerOrchestrationCredentialId,credentialOwnerId:plan.setup.runnerServiceAccountId,capabilities:["reliability:orchestrate"],active:true,payer:false},
      {kind:"reconciliation",serviceAccountId:plan.setup.reconcilerServiceAccountId,credentialId:plan.setup.reconcilerCredentialId,credentialOwnerId:plan.setup.reconcilerServiceAccountId,capabilities:["reliability:reconcile"],active:true,payer:false},
    ]);
    expect(snapshot.provider).toMatchObject({credentialId:plan.setup.providerCredentialId,credentialOwnerId:plan.setup.providerCredentialOwnerId,
      credentialCapabilities:["provider:invoke:openrouter"],soleCredential:true,ciphertextEnvelopeSha256:plan.setup.providerCredentialCiphertextEnvelopeSha256});
    expect(snapshot.payerAbsence).toEqual({principals:0,credentials:0,paymentConfigurations:0,paymentCapabilities:0});
    expect(snapshot.identityIsolation).toEqual({allDistinct:true,principalCount:11});
    expect(new Set(snapshot.principals.map((principal:Record<string,string>)=>principal.serviceAccountId)).size).toBe(5);
  });

  it("binds every sealed plan to the merged amendment sources and production profile", () => {
    const sourceBoundIdentity = {
      ...identity,
      inheritedV2Commit: "6c6ef80f909998af45576baa07e03733cd5d0950",
      amendmentCommit: "a8001d519c108f7cc55efeb4d1e6cc032bbf98a9",
      protocolSources,
    } as ExecutableV3Identity;
    const plan = buildReliabilityV3Plan(beacon, "hov3-source-bound", sourceBoundIdentity);
    expect((plan as unknown as Record<string, unknown>).profileFingerprint)
      .toBe("sha256:618fa81c9a6587a5e5eda113d2a45a896f839cc2a7965068efc36bd87dedbea8");
    expect(plan.identity).toMatchObject({
      inheritedV2Commit: "6c6ef80f909998af45576baa07e03733cd5d0950",
      amendmentCommit: "a8001d519c108f7cc55efeb4d1e6cc032bbf98a9",
      protocolSources,
    });
    expect(() => buildReliabilityV3Plan(beacon, "hov3-source-wrong", {
      ...sourceBoundIdentity,
      amendmentCommit: "0".repeat(40),
    } as ExecutableV3Identity)).toThrow("RELIABILITY_V3_IDENTITY_UNREVIEWED");
  });

  it("uses v3 domains and refuses v1/v2 run and identity reuse", () => {
    const v3 = deriveReliabilityV3RequestId("hov3-qualification-001", 1, "normal-paced", 1);
    expect(v3).toMatch(/^hov3_[a-f0-9]{48}$/);
    expect(() => deriveReliabilityV3RequestId("run-v2-test", 1, "normal-paced", 1)).toThrow("RELIABILITY_V3_RUN_ID_INVALID");
    expect(() => buildReliabilityV3Plan(beacon, "hov3-qualification-001", { ...identity, preregistrationCommit: "6c6ef80" })).toThrow("RELIABILITY_V3_IDENTITY_UNREVIEWED");
  });

  it("enforces the published 102-character complete v3 run-ID ceiling and 128-character setup-ID ceiling", () => {
    const atLimit = `hov3-${"a".repeat(96)}:`;
    const overLimit = `hov3-${"a".repeat(97)}:`;
    expect(() => deriveReliabilityV3RequestId(atLimit, 1, "normal-paced", 1)).not.toThrow();
    expect(() => deriveReliabilityV3RequestId(overLimit, 1, "normal-paced", 1))
      .toThrow("RELIABILITY_V3_RUN_ID_INVALID");
    const maxPlan = buildReliabilityV3Plan({ ...beacon, randomness: "22".repeat(32) }, atLimit, identity);
    expect(() => validateReliabilityV3Plan(maxPlan)).not.toThrow();
    const setupIds = [maxPlan.setup.organizationId, maxPlan.setup.providerConfigurationId,
      maxPlan.setup.runnerServiceAccountId, maxPlan.setup.reconcilerServiceAccountId, maxPlan.setup.reconcilerCredentialId,
      ...maxPlan.setup.authority.flatMap(item => [item.agentId, item.credentialId, item.policy.id, item.mandate.id, item.root.id, ...item.children.map(child => child.id)])];
    expect(Math.max(...setupIds.map(value => value.length))).toBe(128);
    expect(setupIds.every(value => value.length <= 128)).toBe(true);
  });

  it("routes every v3 artifact to a namespace disjoint from historical v2", () => {
    const runId = "hov3-qualification-001";
    const namespace = reliabilityArtifactNamespace(runId);
    expect(namespace).toMatchObject({
      root: "evidence/held-out-reliability-v3",
      evidenceType: "held-out-reliability-v3",
      protocolVersion: 3,
      protocolArtifact: "held-out-reliability-v3.json",
      beaconRound: 6_338_040,
    });
    expect(canonicalFinalCommitPath(runId)).toBe(`evidence/held-out-reliability-v3/replay/${runId}.json`);
    expect(preliminaryReplayArtifactPath(runId)).toBe(`evidence/held-out-reliability-v3/replay-preliminary/${runId}.json`);
    const paths = expectedReliabilityArtifactPaths({ runId, planFingerprint: `sha256:${"a".repeat(64)}`, incidentPaths: [] });
    expect(paths).toHaveLength(32);
    expect(paths.every((path) => path.startsWith("evidence/held-out-reliability-v3/")
      || path.startsWith("evidence/.run-claims/held-out-reliability-v3/"))).toBe(true);

    expect(reliabilityArtifactNamespace("historical-v2").protocolVersion).toBe(2);
    expect(canonicalFinalCommitPath("historical-v2")).toBe("evidence/held-out-reliability/replay/historical-v2.json");
  });

  it("accepts only the exact run-derived v3 authorization actor, expiry, and nonce", () => {
    const plan = buildReliabilityV3Plan(beacon, "hov3-qualification-001", identity);
    const operator = { payload: {
      kind: "operator", runId: plan.runId, organizationId: plan.setup.organizationId,
      planFingerprint: plan.planFingerprint, profileFingerprint: plan.profileFingerprint,
      executableFingerprint: `sha256:${"9".repeat(64)}`, actorId: `${plan.runId}-operator`,
      serviceAccountId: plan.setup.operatorServiceAccountId, credentialId: plan.setup.operatorCredentialId,
      credentialOwnerId: plan.setup.operatorServiceAccountId,
      issuerCredentialId: V3_AUTHORIZATION_ISSUERS.operator.id,
      capability: "evidence:authorize-spend", nonce: `hov3:${plan.runId}:${"a".repeat(64)}`,
      expiresAt: "2026-08-02T08:22:00.000Z",
    }, signature: "AA==" } as unknown as AuthorizationArtifact;
    expect(v3AuthorizationIdentityValid(plan, operator, "operator")).toBe(true);
    const missingCredential={...operator,payload:{...operator.payload,credentialId:undefined}} as unknown as AuthorizationArtifact;
    expect(v3AuthorizationIdentityValid(plan, missingCredential, "operator")).toBe(false);
    expect(v3AuthorizationIdentityValid(plan, { ...operator, payload: { ...operator.payload, nonce: "v2-nonce" } }, "operator")).toBe(false);
    expect(v3AuthorizationIdentityValid(plan, { ...operator, payload: { ...operator.payload, issuerCredentialId: "ed25519:v2" } }, "operator")).toBe(false);
    expect(v3AuthorizationIdentityValid(plan, { ...operator, payload: { ...operator.payload, expiresAt: "2026-07-28T09:30:00.000Z" } }, "operator")).toBe(false);
  });

  it("verifies only the pinned v3 round through the chained BLS boundary", async () => {
    const raw = { round: 6_338_040, randomness: "11".repeat(32), signature: "22".repeat(96), previous_signature: "33".repeat(96) };
    const verifier = async (input: { round: number }) => input.round === 6_338_040;
    await expect(verifyReliabilityV3ChainedBeacon(raw, verifier)).resolves.toMatchObject({ round: 6_338_040, verified: true });
    await expect(verifyReliabilityV3ChainedBeacon({ ...raw, round: 6_315_000 }, verifier)).rejects.toThrow("RELIABILITY_V3_BEACON_INVALID");
  });
});
