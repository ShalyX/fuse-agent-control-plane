#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";
import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { Pool } from "pg";
import { createCircleGatewaySigner } from "../src/circle/developerWalletSigner.js";
import { assertArtifactCommittedAtHead } from "../src/evidence/committedArtifact.js";
import {
  assertEvidenceProviderCostCap,
  assertEvidenceProviderCostSpent,
  buildEvidenceConfiguration,
  buildEvidenceConfigurationFingerprint,
  buildFixtureCallPlan,
  buildFixtureSetupPlan,
  fixtureScenarios,
  validateEvidenceProviderCostCapAtomic,
  validateEvidenceCallOutcomes,
  validateEvidenceRunId,
  validateFixtureOutcomes,
  validateFuseUrl,
  validateReplicationBaseline,
  type AttemptManifestEntry,
  type FixtureCall,
  type ReplicationBaselineManifest,
  type SetupOperation,
} from "../src/evidence/harness.js";
import {
  buildHeldOutCallPlan,
  buildHeldOutConfigurationFingerprint,
  buildHeldOutSetupPlan,
  validateHeldOutPlan,
  type HeldOutPlan,
} from "../src/evidence/heldOut.js";
import {
  buildIntendedAuthoritativeSetup,
  queryAuthoritativeSetup,
  withVerifiedAuthoritativeSetup,
} from "../src/evidence/authoritative.js";
import {
  acquireRunClaim,
  atomicReplaceJson,
  recordAttemptDurablyBeforeAssertions,
} from "../src/evidence/durableArtifacts.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient: typeof InitiateClient;
};

const dryRun = process.argv.includes("--dry-run");
const heldOutPlanPath = process.env["FUSE_HELD_OUT_PLAN"]?.trim();
const heldOutPlan = heldOutPlanPath
  ? JSON.parse(await readFile(heldOutPlanPath, "utf8")) as HeldOutPlan
  : null;
if (heldOutPlan) validateHeldOutPlan(heldOutPlan);
const runId = validateEvidenceRunId(
  process.env["FUSE_EVIDENCE_RUN_ID"]?.trim() ?? `evidence-${Date.now()}`,
);
const providerValue = heldOutPlan?.provider
  ?? process.env["FUSE_PROVIDER"]?.trim().toLowerCase() ?? "anthropic";
if (providerValue !== "anthropic" && providerValue !== "openrouter") {
  throw new Error("FUSE_PROVIDER_INVALID");
}
const provider: "anthropic" | "openrouter" = providerValue;
const model = heldOutPlan?.model ?? process.env["FUSE_EVIDENCE_MODEL"]?.trim()
  ?? process.env["ANTHROPIC_MODEL"]?.trim() ?? "claude-sonnet-4-6";
if (heldOutPlan && (process.env["FUSE_PROVIDER"]?.trim().toLowerCase() ?? provider) !== provider) {
  throw new Error("HELD_OUT_PROVIDER_OVERRIDE_FORBIDDEN");
}
if (heldOutPlan && (process.env["FUSE_EVIDENCE_MODEL"]?.trim() ?? model) !== model) {
  throw new Error("HELD_OUT_MODEL_OVERRIDE_FORBIDDEN");
}
const mandateId = heldOutPlan ? `heldout-${runId}` : `fixture-${runId}`;
const policyId = heldOutPlan ? `heldout-policy-${runId}` : `fixture-policy-${runId}`;
const agentId = heldOutPlan ? `heldout-agent-${runId}` : `fixture-agent-${runId}`;
const baseUrl = validateFuseUrl(
  process.env["FUSE_URL"]?.trim() ?? "http://127.0.0.1:8787",
);
const setupPlan = heldOutPlan
  ? buildHeldOutSetupPlan(heldOutPlan, runId)
  : buildFixtureSetupPlan({ runId, provider, model, mandateId, policyId, agentId });
const callPlan = heldOutPlan ? buildHeldOutCallPlan(heldOutPlan, runId) : buildFixtureCallPlan(runId, model);
const configuration = buildEvidenceConfiguration(provider, model);
const configurationFingerprint = heldOutPlan
  ? buildHeldOutConfigurationFingerprint(heldOutPlan)
  : buildEvidenceConfigurationFingerprint(configuration);
const configurationFingerprintProvenance = heldOutPlan
  ? "sealed-drand-plan" as const
  : "pre-run-generated" as const;
const providerCostCapValue = process.env["FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC"]?.trim();
const providerCostCapAtomic = providerCostCapValue
  ? validateEvidenceProviderCostCapAtomic(providerCostCapValue)
  : null;
if (heldOutPlan && !dryRun && providerCostCapAtomic === null) {
  throw new Error("HELD_OUT_PROVIDER_COST_CAP_REQUIRED");
}
const baselinePath = process.env["FUSE_EVIDENCE_BASELINE_MANIFEST"]?.trim();
if (heldOutPlan && baselinePath) throw new Error("HELD_OUT_BASELINE_POOLING_FORBIDDEN");
let replicationBaselineRunId: string | null = null;
if (baselinePath) {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as ReplicationBaselineManifest;
  replicationBaselineRunId = validateReplicationBaseline(
    baseline,
    configurationFingerprint,
    configuration.calls.length,
  ).baselineRunId;
}
const outputPath = join(process.cwd(), "evidence", heldOutPlan ? "held-out/manifests" : "fixtures", `${runId}.json`);
if (heldOutPlan && !dryRun) {
  await assertArtifactCommittedAtHead(heldOutPlanPath!);
  try {
    await access(outputPath);
    throw new Error("HELD_OUT_MANIFEST_ALREADY_EXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "HELD_OUT_MANIFEST_ALREADY_EXISTS") throw error;
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

if (dryRun) {
  console.log(JSON.stringify({
    phase: "dry-run",
    runId,
    provider,
    model,
    configurationFingerprint,
    configurationFingerprintProvenance,
    heldOutPlanFingerprint: heldOutPlan?.planFingerprint ?? null,
    providerCostCapAtomic: providerCostCapAtomic?.toString() ?? null,
    replicationBaselineRunId,
    mandateId,
    policyId,
    agentId,
    setupOperations: setupPlan.map(({ kind, method, path }) => ({ kind, method, path })),
    evidenceType: heldOutPlan ? "held-out" : "fixed-fixtures",
    protocolVersion: heldOutPlan?.protocolVersion ?? null,
    heldOutRound: heldOutPlan?.beacon.round ?? null,
    heldOutChainHash: heldOutPlan?.beacon.chainHash ?? null,
    fixtures: heldOutPlan?.cohorts ?? fixtureScenarios,
    callCount: callPlan.length,
    paidCallsExecuted: 0,
  }, null, 2));
  process.exit(0);
}

const adminToken = requiredEnv("FUSE_ADMIN_TOKEN");
const claimPath = join(process.cwd(), "evidence", ".run-claims",
  heldOutPlan ? "held-out" : "fixed-fixtures", `${runId}.claim`);
await acquireRunClaim(claimPath, {
  schemaVersion: 1,
  runId,
  evidenceType: heldOutPlan ? "held-out" : "fixed-fixtures",
  claimedAt: new Date().toISOString(),
});
let paymentHttp: x402HTTPClient | undefined;

async function getPaymentHttp(): Promise<x402HTTPClient> {
  if (paymentHttp) return paymentHttp;
  const apiKey = requiredEnv("CIRCLE_API_KEY");
  const entitySecret = requiredEnv("CIRCLE_ENTITY_SECRET");
  const payerAddress = requiredEnv("FUSE_PAYER_ADDRESS").toLowerCase();
  const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const wallets = (await circle.listWallets()).data?.wallets ?? [];
  const wallet = wallets.find((candidate) => candidate.address?.toLowerCase() === payerAddress);
  if (!wallet?.address) throw new Error("FUSE_PAYER_WALLET_NOT_FOUND");
  const signer = createCircleGatewaySigner({
    client: circle,
    walletId: wallet.id,
    walletAddress: wallet.address as `0x${string}`,
  });
  const paymentClient = new x402Client();
  registerBatchScheme(paymentClient, { signer });
  paymentHttp = new x402HTTPClient(paymentClient);
  return paymentHttp;
}

let runtimeToken = "";
for (const [index, operation] of setupPlan.entries()) {
  const result = await executeAdminOperation(operation, index + 1);
  if (operation.kind === "agentCredential") {
    const token = result && typeof result === "object" && "token" in result ? result.token : undefined;
    if (typeof token !== "string" || !token.trim()) throw new Error("FIXTURE_AGENT_TOKEN_MISSING");
    runtimeToken = token;
  }
}
if (!runtimeToken) throw new Error("FIXTURE_AGENT_TOKEN_MISSING");

const databaseUrl = process.env["DATABASE_URL_UNPOOLED"]?.trim()
  ?? process.env["DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
if (new URL(databaseUrl).hostname.includes("-pooler")) throw new Error("USE_UNPOOLED_CONNECTION");
const intendedAuthoritativeSetup = buildIntendedAuthoritativeSetup({
  setupPlan, provider, model, mandateId, policyId, agentId,
});
const setupPool = new Pool({ connectionString: databaseUrl, max: 1 });
const authoritativeSetup = await (async () => {
  try {
    return await withVerifiedAuthoritativeSetup(
      intendedAuthoritativeSetup,
      () => queryAuthoritativeSetup(setupPool, { mandateId, policyId, policyVersion: 1 }),
      async (verification) => verification,
    );
  } finally {
    await setupPool.end();
  }
})();

const attempts: AttemptManifestEntry[] = [];
await persistManifest("running");
for (const [index, call] of callPlan.entries()) {
  if (providerCostCapAtomic !== null) {
    assertEvidenceProviderCostCap(attempts, call, providerCostCapAtomic);
  }
  const attempt = await executeFixtureCall(call, runtimeToken, index + 1);
  await recordAttemptDurablyBeforeAssertions(
    attempts,
    attempt,
    () => persistManifest("running"),
    () => {
      if (providerCostCapAtomic !== null) {
        assertEvidenceProviderCostSpent(attempts, providerCostCapAtomic);
      }
      if (call.expected !== "completed-or-denied" && attempt.outcome !== call.expected) {
        throw new Error(`FIXTURE_EXPECTATION_FAILED:${call.requestId}:${call.expected}:${attempt.outcome}`);
      }
    },
  );
}

if (heldOutPlan) validateEvidenceCallOutcomes(callPlan, attempts);
else validateFixtureOutcomes(callPlan, attempts);
await persistManifest("complete");
console.log(JSON.stringify({ phase: "complete", runId, attempts: attempts.length, outputPath }));

async function persistManifest(phase: "running" | "complete"): Promise<void> {
  await atomicReplaceJson(outputPath, {
    schemaVersion: 2,
    evidenceType: heldOutPlan ? "held-out" : "fixed-fixtures",
    protocolVersion: heldOutPlan?.protocolVersion ?? null,
    phase,
    runId,
    mandateId,
    policyId,
    agentId,
    provider,
    model,
    configurationFingerprint,
    configurationFingerprintProvenance,
    authoritativeSetupFingerprint: authoritativeSetup.fingerprint,
    authoritativeSetupSource: authoritativeSetup.source,
    heldOutPlanFingerprint: heldOutPlan?.planFingerprint ?? null,
    providerCostCapAtomic: providerCostCapAtomic?.toString() ?? null,
    replicationBaselineRunId,
    heldOutBeaconRound: heldOutPlan?.beacon.round ?? null,
    heldOutBeaconChainHash: heldOutPlan?.beacon.chainHash ?? null,
    generatedAt: new Date().toISOString(),
    attempts,
  }, { immutableWhenComplete: true });
}

async function executeAdminOperation(
  operation: SetupOperation,
  index: number,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(`${baseUrl}${operation.path}`, {
    method: operation.method,
    headers: {
      "Authorization": `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      "X-Request-Id": `${runId}-admin-${index}`,
    },
    body: JSON.stringify(operation.body),
    redirect: "error",
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error(`FIXTURE_SETUP_FAILED:${operation.kind}:${response.status}:${errorCode(body)}`);
  return body;
}

async function executeFixtureCall(
  call: FixtureCall,
  token: string,
  sequence: number,
): Promise<AttemptManifestEntry> {
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": call.requestId,
    "X-Fuse-Mandate": call.mandateId,
    "X-Fuse-Branch": call.branchId,
  };
  const body = JSON.stringify({
    model: call.model,
    max_tokens: call.maxOutputTokens,
    workload_class: call.workloadClass,
    messages: [{ role: "user", content: `${"context ".repeat(call.contextUnits)}\nReply only: FUSE` }],
  });
  const initial = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers, body, redirect: "error",
  });
  let response = initial;
  if (initial.status === 402) {
    const initialBody = await readJson(initial);
    const http = await getPaymentHttp();
    const required = http.getPaymentRequiredResponse((name) => initial.headers.get(name), initialBody);
    const payload = await http.createPaymentPayload(required);
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, ...http.encodePaymentSignatureHeader(payload) },
      body,
      redirect: "error",
    });
  }
  const responseBody = await readJson(response);
  const occurredAt = new Date().toISOString();
  const dimensions = {
    provider,
    model: call.model,
    branchId: call.branchId,
    workloadClass: call.workloadClass,
    maxOutputTokens: call.maxOutputTokens,
    agentId,
    policyId,
    policyVersion: 1,
  } as const;
  if (response.ok) {
    const actual = responseBody?.["fuse"];
    const actualCostAtomic = actual && typeof actual === "object" && "actualCostAtomic" in actual
      ? actual.actualCostAtomic : undefined;
    const decision = actual && typeof actual === "object" && "decision" in actual
      && actual.decision && typeof actual.decision === "object"
      ? actual.decision as Record<string, unknown> : undefined;
    if (typeof actualCostAtomic !== "string" || !/^\d+$/.test(actualCostAtomic)
      || typeof decision?.["id"] !== "string" || typeof decision["outcome"] !== "string"
      || typeof decision["wouldOutcome"] !== "string" || typeof decision["enforced"] !== "boolean") {
      return { runId, fixtureId: call.fixtureId, requestId: call.requestId, sequence,
        label: call.label, outcome: "error", actualCostAtomic: "0",
        denialCode: "FIXTURE_RESPONSE_EVIDENCE_MISSING", occurredAt, ...dimensions };
    }
    return { runId, fixtureId: call.fixtureId, requestId: call.requestId, sequence,
      label: call.label, outcome: "completed", actualCostAtomic, occurredAt, ...dimensions,
      decisionId: decision["id"], decisionOutcome: decision["outcome"],
      decisionWouldOutcome: decision["wouldOutcome"], decisionEnforced: decision["enforced"] };
  }
  if (response.status >= 400 && response.status < 500) {
    const error = responseBody?.["error"];
    const decisionId = error && typeof error === "object" && "decisionId" in error
      && typeof error.decisionId === "string" ? error.decisionId : undefined;
    return { runId, fixtureId: call.fixtureId, requestId: call.requestId, sequence,
      label: call.label, outcome: "denied", actualCostAtomic: "0",
      denialCode: errorCode(responseBody), occurredAt, ...dimensions,
      ...(decisionId ? { decisionId } : {}) };
  }
  return { runId, fixtureId: call.fixtureId, requestId: call.requestId, sequence,
    label: call.label, outcome: "error", actualCostAtomic: "0",
    denialCode: `FIXTURE_CALL_FAILED_${response.status}_${errorCode(responseBody)}`,
    occurredAt, ...dimensions };
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  if (response.status === 204) return undefined;
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(body: Record<string, unknown> | undefined): string {
  const error = body?.["error"];
  if (!error || typeof error !== "object") return "UNKNOWN";
  const reasonCodes = "reasonCodes" in error ? error.reasonCodes : undefined;
  if (Array.isArray(reasonCodes) && typeof reasonCodes[0] === "string") return reasonCodes[0];
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
