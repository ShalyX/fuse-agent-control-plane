import { readFile } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeReliabilityCli } from "../src/evidence/reliabilityCliV2.js";
import * as v2Runner from "../scripts/held-out-reliability-v2.js";
import * as v3Runner from "../scripts/held-out-reliability-v3.js";
import { authorizationPayloadBytes, type AuthorizationArtifact } from "../src/evidence/reliabilityRuntimeV2.js";
import { V3_AUTHORIZATION_ISSUERS } from "../src/reliability/issuersV3.js";

function normalizeV3Runner(source: string): string {
  return source
    .replace('  V3_AUTHORIZATION_WINDOW, V3_LANES,', '  V3_LANES,')
    .replace('import { V3_AUTHORIZATION_ISSUERS } from "../src/reliability/issuersV3.js";\n', "")
    .replace('import { RELIABILITY_V3_PROFILE } from "../src/reliability/protocolProfile.js";\n', "")
    .replace(',profile:RELIABILITY_V3_PROFILE', '')
    .replace(',requestCommitment:call.requestCommitment', '')
    .replace('  const now=await databaseNow(db); const expected=(kind:"operator"|"reconciliation")=>{const principal=kind==="operator"?plan.setup.operatorServiceAccountId:plan.setup.reconcilerServiceAccountId;return {now,expectedRunId:plan.runId,expectedPlanFingerprint:plan.planFingerprint,expectedExecutableFingerprint:executableFingerprint(plan),expectedV3Identity:{organizationId:plan.setup.organizationId,profileFingerprint:plan.profileFingerprint,serviceAccountId:principal,credentialId:kind==="operator"?plan.setup.operatorCredentialId:plan.setup.reconcilerCredentialId,credentialOwnerId:principal}}};\n  const operatorValid=v3AuthorizationIdentityValid(plan,operator,"operator")&&verifyAuthorizationArtifact(operator,"operator",expected("operator"),V3_AUTHORIZATION_ISSUERS);\n  const reconciliationValid=v3AuthorizationIdentityValid(plan,reconciliation,"reconciliation")&&verifyAuthorizationArtifact(reconciliation,"reconciliation",expected("reconciliation"),V3_AUTHORIZATION_ISSUERS)\n', '  const now=await databaseNow(db); const expected={now,expectedRunId:plan.runId,expectedPlanFingerprint:plan.planFingerprint,expectedExecutableFingerprint:executableFingerprint(plan)};\n  const operatorValid=verifyAuthorizationArtifact(operator,"operator",expected);\n  const reconciliationValid=verifyAuthorizationArtifact(reconciliation,"reconciliation",expected)\n')
    .replace(/\nexport function v3AuthorizationIdentityValid[\s\S]*?\n}\n\nfunction callBody/, "\nfunction callBody")
    .replace('      if(!actorId.startsWith("hov3-")||issuerCredentialId!==V3_AUTHORIZATION_ISSUERS[kind].id)throw new Error("RELIABILITY_V3_AUTHORIZATION_IDENTITY_INVALID");\n      const expectedExpiry=kind==="operator"?"2026-08-02T08:22:00.000Z":"2026-08-05T09:30:00.000Z";if(expiresAt!==expectedExpiry)throw new Error("RELIABILITY_V3_AUTHORIZATION_EXPIRY_INVALID");\n      const nonce=kind==="operator"?required(args,"--nonce"):null;if(kind==="operator"&&!nonce!.startsWith(`hov3:${plan.runId}:`))throw new Error("RELIABILITY_V3_AUTHORIZATION_NONCE_INVALID");\n', "")
    .replace(',nonce,expiresAt};', ',nonce:kind==="operator"?required(args,"--nonce"):null,expiresAt};')
    .replace('      const credentialId=kind==="operator"?plan.setup.operatorCredentialId:plan.setup.reconcilerCredentialId;\n      const payload:AuthorizationPayload={kind,runId:plan.runId,organizationId:plan.setup.organizationId,planFingerprint:plan.planFingerprint,profileFingerprint:plan.profileFingerprint,\n        executableFingerprint:executableFingerprint(plan),actorId,serviceAccountId:actorId,credentialId,credentialOwnerId:actorId,issuerCredentialId,\n        capability:kind==="operator"?"evidence:authorize-spend":"evidence:authorize-reconciliation",nonce:kind==="operator"?required(args,"--nonce"):null,expiresAt};', '      const payload:AuthorizationPayload={kind,runId:plan.runId,planFingerprint:plan.planFingerprint,executableFingerprint:executableFingerprint(plan),actorId,issuerCredentialId,capability:kind==="operator"?"evidence:authorize-spend":"evidence:authorize-reconciliation",nonce:kind==="operator"?required(args,"--nonce"):null,expiresAt};')
    .replace('      const publicKeyPath=required(args,"--public-key"); const publicKey=createPublicKey(await readFile(resolve(cwd,publicKeyPath)));\n      const publicDer=publicKey.export({type:"spki",format:"der"});const publicRaw=Buffer.from(publicDer).subarray(-32).toString("hex");if(publicRaw!==V3_AUTHORIZATION_ISSUERS[kind].rawPublicKeyHex)throw new Error("RELIABILITY_V3_AUTHORIZATION_KEY_UNPINNED");\n      if(!verify(null,authorizationPayloadBytes(payload),publicKey,Buffer.from(artifact.signature,"base64")))throw new Error("AUTHORIZATION_SIGNATURE_SELF_CHECK_FAILED");', '      const publicKeyPath=required(args,"--public-key"); const publicKey=createPublicKey(await readFile(resolve(cwd,publicKeyPath))); if(!verify(null,authorizationPayloadBytes(payload),publicKey,Buffer.from(artifact.signature,"base64")))throw new Error("AUTHORIZATION_SIGNATURE_SELF_CHECK_FAILED");')
    .replace('  const decisionKind=active?"active":"readiness_failed" as const;\n  const reasonCode=active?"valid_pair":"absent_or_invalid_pair";\n  const decisionId=deterministicAuthorizationDecisionId({runId:plan.runId,planFingerprint:plan.planFingerprint,\n    profileFingerprint:plan.profileFingerprint,decisionKind,reasonCode,\n    operatorArtifactSha256:operatorReceipt.presentedArtifactSha256 as `sha256:${string}`,\n    reconciliationArtifactSha256:reconciliationReceipt.presentedArtifactSha256 as `sha256:${string}`});\n  await store.commitAuthorization({runId:plan.runId,decisionId,verdict,active,\n', '  await store.commitAuthorization({runId:plan.runId,decisionId:deterministicAuthorizationDecisionId(plan.runId),verdict,active,\n')
    .replaceAll('},V3_AUTHORIZATION_ISSUERS)', '})')
    .replace('        const replayInventory=await store.registerReplayAuthorizationInventory({runId:plan.runId,planFingerprint:plan.planFingerprint,requestIds:plan.replayTargets.map(target=>target.requestId)});', '        const operator=parse<AuthorizationArtifact>(files.authorization!,"OPERATOR_AUTHORIZATION_INVALID");\n        const now=await databaseNow(db);\n        if(!verifyAuthorizationArtifact(operator,"operator",{now,expectedRunId:plan.runId,expectedPlanFingerprint:plan.planFingerprint,expectedExecutableFingerprint:executableFingerprint(plan)}))throw new Error("OPERATOR_AUTHORIZATION_INVALID");\n        const authorizationSha256=`sha256:${createHash("sha256").update(files.authorization!).digest("hex")}`;\n        const replayInventory=buildReplayAuthorizationInventory({runId:plan.runId,authorizationSha256,requestIds:plan.replayTargets.map(target=>target.requestId)});\n        await store.registerReplayAuthorizationInventory({runId:plan.runId,authorizationSha256,requestIds:plan.replayTargets.map(target=>target.requestId)});')
    .replaceAll('runId:plan.runId,planFingerprint:plan.planFingerprint,authorizationSha256', 'runId:plan.runId,authorizationSha256')
    .replace(/      const rawOperator=files\.authorization;[\s\S]*?        if\(\(await store\.databaseTime\(\)\)\.getTime\(\)>validationStartedAt\.getTime\(\)\+20_000\)await failPredecision\("AUTHORIZATION_VALIDATION_DEADLINE_MISSED"\);\n/, '        const operator=parse<AuthorizationArtifact>(files.authorization!,"OPERATOR_AUTHORIZATION_INVALID"); const reconciliation=parse<AuthorizationArtifact>(files.reconciliationAuthorization!,"RECONCILIATION_AUTHORIZATION_INVALID");\n        const setupReadinessReceipt=await store.requireSetupReadinessReceipt({runId:plan.runId,planFingerprint:plan.planFingerprint});\n        await verifyPair(store,db,plan,operator,reconciliation,async (kind,receipt)=>{\n          const path=resolve(cwd,"evidence","held-out-reliability-v3","authorization-receipts",kind,`${plan.runId}.json`);\n          await publishAbsolute(path,receipt);\n        });\n')
    .replace('      const db=pool(); const store=new ReliabilityProtocolStore(db); let dispatched=0;\n      try{\n        await store.createSchema();\n        const operator=parse<AuthorizationArtifact>', '      const operator=parse<AuthorizationArtifact>')
    .replace(' const reconciliation=parse<AuthorizationArtifact>(files.reconciliationAuthorization!,"RECONCILIATION_AUTHORIZATION_INVALID");\n        const setupReadinessReceipt=', ' const reconciliation=parse<AuthorizationArtifact>(files.reconciliationAuthorization!,"RECONCILIATION_AUTHORIZATION_INVALID");\n      const db=pool(); const store=new ReliabilityProtocolStore(db); let dispatched=0;\n      try{\n        await store.createSchema();\n        const setupReadinessReceipt=')
    .replace(',durableRunPredecision:true,operations:', ',operations:')
    .replaceAll("heldOutReliabilityV3", "heldOutReliabilityV2")
    .replaceAll("ReliabilityV3Plan", "ReliabilityPlan")
    .replaceAll("ExecutableV3Identity", "ExecutableIdentity")
    .replaceAll("V3_LANES", "V2_LANES")
    .replaceAll("buildReliabilityV3Plan", "buildReliabilityPlan")
    .replaceAll("validateReliabilityV3Plan", "validateReliabilityPlan")
    .replaceAll("verifyPinnedReliabilityV3Beacon", "verifyPinnedReliabilityBeacon")
    .replaceAll("RELIABILITY_V3_", "RELIABILITY_V2_")
    .replaceAll("held-out-reliability-v3.ts", "held-out-reliability-v2.ts")
    .replaceAll("held-out-reliability-v3", "held-out-reliability")
    .replaceAll("protocolVersion:3", "protocolVersion:2")
    .replaceAll("2026-08-05T09:30:00.000Z", "2026-07-28T09:30:00.000Z");
}

function maskAuthorizationPrelude(source:string):string{
  return source
    .replace(/\nexport function verifyPinnedAuthorizationSignature[\s\S]*?\n}\nexport function runnerCallFailureDisposition/, "\nexport function runnerCallFailureDisposition")
    .replace(/    evidence: async \([\s\S]*?\n    report:/, "    evidence: async ()=>{/* protocol-specific evidence binding */},\n    report:")
    .replace('import { reconstructReliabilityArtifacts, reconstructSchedulerManifestArtifacts, type ReconstructedReliabilityArtifacts, type SchedulerManifestBindingRow } from "../src/evidence/artifactReconstruction.js";',
      'import { reconstructReliabilityArtifacts, type ReconstructedReliabilityArtifacts } from "../src/evidence/artifactReconstruction.js";')
    .replace('      const manifestRelativePath=required(args,"--manifest");\n      const manifestPath=resolve(cwd,manifestRelativePath);const db=pool(),store=new ReliabilityProtocolStore(db);',
      '      const manifestPath=resolve(cwd,required(args,"--manifest"));const db=pool(),store=new ReliabilityProtocolStore(db);')
    .replace('manifestPath:manifestRelativePath});','manifestPath});')
    .replace(/            publishManifest:async manifest=>publishManifestDurably\(manifestPath,\{\.\.\.manifest,evidenceType:"held-out-reliability",protocolVersion:2,\n              planFingerprint:plan\.planFingerprint,artifactKind:"scheduler_manifest",runId:plan\.runId,requestId,laneId:call\.lane,block:call\.block,ownerId,generation:claim\.generation\}\),/,
      '            publishManifest:async manifest=>publishManifestDurably(manifestPath,{...manifest,runId:plan.runId,requestId,laneId:call.lane,block:call.block,ownerId,generation:claim.generation}),')
    .replace(/            publishManifest:async manifest=>\{[\s\S]*?\n            \},/,
      '            publishManifest:async manifest=>publishManifestDurably(manifestPath,{...manifest,runId:plan.runId,requestId,laneId:call.lane,block:call.block,ownerId,generation:claim.generation}),')
    .replace(/        const claimed=\{evidenceType:"held-out-reliability",protocolVersion:2,planFingerprint:plan\.planFingerprint,\n          artifactKind:"scheduler_manifest",state:"claimed",sequence:1,/,
      '        const claimed={state:"claimed",sequence:1,')
    .replace(/        const terminalManifest=\{\.\.\.claimed,state:"terminal",sequence:4,recoveryDecision:recovery\.decision\};\n        await publishManifestDurably\(manifestPath,terminalManifest\);\n        await store\.recordRecoveredTerminalSchedulerManifest\(\{runId:plan\.runId,requestId,laneId:call\.lane,generation:claim\.generation,\n          manifestDigest:`sha256:\$\{createHash\("sha256"\)\.update\(`\$\{canonicalJson\(terminalManifest\)\}\\n`\)\.digest\("hex"\)\}`\}\);/,
      '        await publishManifestDurably(manifestPath,{...claimed,state:"terminal",sequence:4,recoveryDecision:recovery.decision});')
    .replace(/        const schedulerClaims=await store\.loadSchedulerManifestBindings\(plan\.runId\);\n        const schedulerManifests[\s\S]*?        return \{runId:plan\.runId,artifactBound:true,artifactCount:Object\.keys\(artifactDigests\)\.length,artifactDigests\};/,
      '        await store.bindArtifactInventory(plan.runId,reconstructed.artifactDigests);\n        return {runId:plan.runId,artifactBound:true,artifactCount:reconstructed.artifactPaths.length,artifactDigests:reconstructed.artifactDigests};')
    .replace('import { buildCanonicalFinalCommitMarker, finalEvidenceClosure, preliminaryReplayArtifactPath } from "../src/evidence/finalEvidenceClosure.js";', 'import { finalEvidenceClosure, preliminaryReplayArtifactPath } from "../src/evidence/finalEvidenceClosure.js";')
    .replace('import type { AuthoritativeSettlementResult } from "../src/evidence/authoritativeSettlement.js";\n', '')
    .replace(/async function buildStrictSettlementAuthority[\s\S]*?\nasync function buildEvidenceReport/,"async function buildEvidenceReport")
    .replace(/const result=await store\.runAndPersistAuthoritativeSettlement\(plan\.runId,\n\s*settlement=>buildStrictSettlementAuthority\(cwd,args,plan,settlement\)\)/,
      'const result=await store.runAndPersistAuthoritativeSettlement(plan.runId)')
    .replace(/async function buildEvidenceReport[\s\S]*?\nasync function verifyPair/,"/* protocol-specific report publisher */\nasync function verifyPair")
    .replace(/\n{2,}(\/\* protocol-specific report publisher \*\/)/,"\n$1")
    .replace(/type SetupSnapshot=[\s\S]*?\nasync function recordExactProductionReadiness/,"/* protocol-specific exact setup snapshot */\nasync function recordExactProductionReadiness")
    .replace('        const refreshedSetupReadiness=await recordExactProductionReadiness(store,db,plan);\n        const setupReadinessReceipt=refreshedSetupReadiness.snapshotDigest;', '        const setupReadinessReceipt=await store.requireSetupReadinessReceipt({runId:plan.runId,planFingerprint:plan.planFingerprint});')
    .replace(/async function verifyPair[\s\S]*?\nfunction callBody/,"/* protocol-specific authorization verifier */\nfunction callBody")
    .replace(/(    run: async \(\{args,files\}\)=>\{\n      const plan=.*?validateReliabilityPlan\(plan,false\);)\n[\s\S]*?(        const baseUrl=)/,
      "$1\n        /* protocol-specific authorization prelude */\n$2");
}

describe("protocol v3 inherited production-path conformance", () => {
  it("keeps the complete runner byte-equivalent after only preregistered replacements", async () => {
    const [v2, v3] = await Promise.all([
      readFile(new URL("../scripts/held-out-reliability-v2.ts", import.meta.url), "utf8"),
      readFile(new URL("../scripts/held-out-reliability-v3.ts", import.meta.url), "utf8"),
    ]);
    expect(maskAuthorizationPrelude(normalizeV3Runner(v3))).toBe(maskAuthorizationPrelude(v2));
  });

  it("inherits runner failure, setup, and report guards exactly", () => {
    for (const state of [null, "reconciliation_pending", "completed_verified", "not_dispatched"]) {
      expect(v3Runner.runnerCallFailureDisposition(state)).toBe(v2Runner.runnerCallFailureDisposition(state));
    }
    const matrices = [
      ["completed_verified", "completed_verified"],
      ["reconciliation_pending", "completed_verified"],
      [null, "completed_verified"],
    ];
    for (const states of matrices) {
      expect(v3Runner.boundedBurstFailureDisposition(states)).toBe(v2Runner.boundedBurstFailureDisposition(states));
    }
    expect(() => v3Runner.validateEvidenceReportArguments(["--metadata", "x", "--plan", "plan.json"]))
      .toThrow("CALLER_METADATA_PROHIBITED");
  });

  it("uses the committed active authorization decision as the sole v3 replay authority", async () => {
    const source=await readFile(new URL("../scripts/held-out-reliability-v3.ts",import.meta.url),"utf8");
    const replayBlock=source.slice(source.indexOf('    replay: async ({args,files})=>{'),source.indexOf('    reconcile: async',source.indexOf('    replay: async ({args,files})=>{')));
    expect(replayBlock).not.toContain("files.authorization");
    expect(replayBlock).not.toContain("verifyAuthorizationArtifact(operator");
    expect(replayBlock).not.toContain("authorizationSha256");
    expect(replayBlock).toContain("registerReplayAuthorizationInventory({runId:plan.runId,planFingerprint:plan.planFingerprint,requestIds:");
  });

  it("binds scheduler artifacts from replay-terminal claims before any settlement snapshot exists", async () => {
    const source=await readFile(new URL("../scripts/held-out-reliability-v3.ts",import.meta.url),"utf8");
    const evidence=source.slice(source.indexOf("    evidence: async"),source.indexOf("    report: async",source.indexOf("    evidence: async")));
    expect(evidence).toContain("loadSchedulerManifestBindings(plan.runId)");
    expect(evidence).not.toContain("loadEvidenceClosureSnapshot(plan.runId)");
    expect(evidence.indexOf("loadSchedulerManifestBindings")).toBeLessThan(evidence.indexOf("bindArtifactInventory"));
    expect(evidence).not.toContain("--operator-public-key");
    expect(evidence).not.toContain("--reconciliation-public-key");
  });

  it("rejects an attacker signature even when its payload names the pinned issuer", () => {
    const {privateKey}=generateKeyPairSync("ed25519");
    const payload={kind:"operator",issuerCredentialId:V3_AUTHORIZATION_ISSUERS.operator.id} as AuthorizationArtifact["payload"];
    const artifact={payload,signature:sign(null,authorizationPayloadBytes(payload),privateKey).toString("base64")};
    expect(v3Runner.verifyPinnedAuthorizationSignature("operator",artifact as unknown as Record<string,unknown>)).toBe(false);
  });

  it("refreshes authoritative setup readback in setup and authorization admission", async () => {
    const source=await readFile(new URL("../scripts/held-out-reliability-v3.ts",import.meta.url),"utf8");
    const setup=source.slice(source.indexOf("setup: async"),source.indexOf("worker: async"));
    const run=source.slice(source.indexOf("run: async"),source.indexOf("reconcile: async"));
    expect(setup).toContain("recordExactProductionReadiness(store,db,plan)");
    expect(run).toContain("recordExactProductionReadiness(store,db,plan)");
  });

  it("requires an on-time completed authorization operation before v3 admission", async () => {
    const source=await readFile(new URL("../src/reliability/protocolStore.ts",import.meta.url),"utf8");
    const start=source.indexOf("async claimBlock(");
    const claim=source.slice(start,source.indexOf("async beginAuthorizationOperation",start));
    expect(claim).toContain("reliability_authorization_operations");
    expect(claim).toContain("transition_completed_at IS NOT NULL");
    expect(claim).toContain("failure_reason IS NULL");
  });

  it("durably starts authorization before classification or readiness work", async () => {
    const source=await readFile(new URL("../scripts/held-out-reliability-v3.ts",import.meta.url),"utf8");
    const start=source.indexOf("run: async ({args,files})=>");
    const run=source.slice(start,source.indexOf("const baseUrl=",start));
    const begin=run.indexOf("await store.beginAuthorizationOperation(plan.runId)");
    expect(begin).toBeGreaterThan(run.indexOf("await store.createSchema()"));
    expect(begin).toBeLessThan(run.indexOf("classifyPresentedAuthorizationArtifacts"));
    expect(run).toContain("authorizationOperation.decisionDeadline");
    expect(run).toContain("authorizationOperation.publicationDeadline");
    expect(run).toContain("authorizationOperation.transitionDeadline");
  });

  it("preserves the real no-spend CLI boundary for every preauthorization fault", async () => {
    await expect(executeReliabilityCli(["dry"], { network: async () => { throw new Error("NETWORK_CALLED"); } }))
      .resolves.toMatchObject({ ok: true, providerCalls: 0, paymentCalls: 0, beaconCalls: 0 });
    await expect(executeReliabilityCli(["run", "--plan", "missing.json"])).resolves.toMatchObject({ ok: false, errorCode: "NETWORK_DEFAULT_DENY", providerCalls: 0 });
    await expect(executeReliabilityCli(["run", "--allow-provider-network", "--plan", "missing.json"])).resolves.toMatchObject({ ok: false, errorCode: "PLAN_REQUIRED", providerCalls: 0 });
    await expect(executeReliabilityCli(["seal"])).resolves.toMatchObject({ ok: false, errorCode: "LOCAL_BEACON_REQUIRED", beaconCalls: 0 });
    await expect(executeReliabilityCli(["run", "--allow-payment"])).resolves.toMatchObject({ ok: false, errorCode: "PAYMENT_PATH_PROHIBITED", paymentCalls: 0 });
    await expect(executeReliabilityCli(["run", "--http-status", "402"])).resolves.toMatchObject({ ok: false, errorCode: "PAYMENT_REQUIRED_FAIL_CLOSED", paymentCalls: 0 });
  });
});
