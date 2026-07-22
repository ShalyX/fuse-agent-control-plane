#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";
import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { createCircleGatewaySigner } from "../src/circle/developerWalletSigner.js";
import {
  buildFixtureCallPlan,
  buildFixtureSetupPlan,
  fixtureScenarios,
  validateEvidenceRunId,
  validateFixtureOutcomes,
  validateFuseUrl,
  type AttemptManifestEntry,
  type FixtureCall,
  type SetupOperation,
} from "../src/evidence/harness.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient: typeof InitiateClient;
};

const dryRun = process.argv.includes("--dry-run");
const runId = validateEvidenceRunId(
  process.env["FUSE_EVIDENCE_RUN_ID"]?.trim() ?? `evidence-${Date.now()}`,
);
const providerValue = process.env["FUSE_PROVIDER"]?.trim().toLowerCase() ?? "anthropic";
if (providerValue !== "anthropic" && providerValue !== "openrouter") {
  throw new Error("FUSE_PROVIDER_INVALID");
}
const provider: "anthropic" | "openrouter" = providerValue;
const model = process.env["FUSE_EVIDENCE_MODEL"]?.trim()
  ?? process.env["ANTHROPIC_MODEL"]?.trim() ?? "claude-sonnet-4-6";
const mandateId = `fixture-${runId}`;
const policyId = `fixture-policy-${runId}`;
const agentId = `fixture-agent-${runId}`;
const baseUrl = validateFuseUrl(
  process.env["FUSE_URL"]?.trim() ?? "http://127.0.0.1:8787",
);
const setupPlan = buildFixtureSetupPlan({ runId, provider, model, mandateId, policyId, agentId });
const callPlan = buildFixtureCallPlan(runId, model);

if (dryRun) {
  console.log(JSON.stringify({
    phase: "dry-run",
    runId,
    provider,
    model,
    mandateId,
    policyId,
    agentId,
    setupOperations: setupPlan.map(({ kind, method, path }) => ({ kind, method, path })),
    fixtures: fixtureScenarios,
    callCount: callPlan.length,
    paidCallsExecuted: 0,
  }, null, 2));
  process.exit(0);
}

const adminToken = requiredEnv("FUSE_ADMIN_TOKEN");
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

const attempts: AttemptManifestEntry[] = [];
const outputPath = join(process.cwd(), "evidence", "fixtures", `${runId}.json`);
await persistManifest("running");
for (const [index, call] of callPlan.entries()) {
  const attempt = await executeFixtureCall(call, runtimeToken, index + 1);
  attempts.push(attempt);
  await persistManifest("running");
  if (call.expected !== "completed-or-denied" && attempt.outcome !== call.expected) {
    throw new Error(`FIXTURE_EXPECTATION_FAILED:${call.requestId}:${call.expected}:${attempt.outcome}`);
  }
}

validateFixtureOutcomes(callPlan, attempts);
await persistManifest("complete");
console.log(JSON.stringify({ phase: "complete", runId, attempts: attempts.length, outputPath }));

async function persistManifest(phase: "running" | "complete"): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({
    schemaVersion: 1,
    phase,
    runId,
    mandateId,
    policyId,
    agentId,
    provider,
    model,
    generatedAt: new Date().toISOString(),
    attempts,
  }, null, 2), { mode: 0o600 });
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
  if (response.ok) {
    const actual = responseBody?.["fuse"];
    const actualCostAtomic = actual && typeof actual === "object" && "actualCostAtomic" in actual
      ? actual.actualCostAtomic : undefined;
    if (typeof actualCostAtomic !== "string" || !/^\d+$/.test(actualCostAtomic)) {
      throw new Error(`FIXTURE_COST_MISSING:${call.requestId}`);
    }
    return { runId, fixtureId: call.fixtureId, requestId: call.requestId, sequence,
      label: call.label, outcome: "completed", actualCostAtomic, occurredAt };
  }
  if (response.status >= 400 && response.status < 500) {
    return { runId, fixtureId: call.fixtureId, requestId: call.requestId, sequence,
      label: call.label, outcome: "denied", actualCostAtomic: "0",
      denialCode: errorCode(responseBody), occurredAt };
  }
  throw new Error(`FIXTURE_CALL_FAILED:${call.requestId}:${response.status}:${errorCode(responseBody)}`);
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
