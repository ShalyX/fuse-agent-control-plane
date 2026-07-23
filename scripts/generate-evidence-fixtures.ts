#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
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
  writeOnceJson,
} from "../src/evidence/durableArtifacts.js";
import {
  runWithIncompleteEvidenceCapture,
  type EvidenceRunFailure,
  type EvidenceRunStage,
} from "../src/evidence/runLifecycle.js";

const dryRun = process.argv.includes("--dry-run");
const heldOutPlanPath = process.env["FUSE_HELD_OUT_PLAN"]?.trim();
const runId = validateEvidenceRunId(
  process.env["FUSE_EVIDENCE_RUN_ID"]?.trim() ?? `evidence-${Date.now()}`,
);
const evidenceType = heldOutPlanPath ? "held-out" as const : "fixed-fixtures" as const;
const outputPath = join(process.cwd(), "evidence",
  evidenceType === "held-out" ? "held-out/manifests" : "fixtures", `${runId}.json`);
const claimPath = join(process.cwd(), "evidence", ".run-claims", evidenceType, `${runId}.claim`);

let configurationReady = false;
let heldOutPlan: HeldOutPlan | null = null;
let provider: "anthropic" | "openrouter" = "anthropic";
let model = "";
let mandateId = evidenceType === "held-out" ? `heldout-${runId}` : `fixture-${runId}`;
let policyId = evidenceType === "held-out" ? `heldout-policy-${runId}` : `fixture-policy-${runId}`;
let agentId = evidenceType === "held-out" ? `heldout-agent-${runId}` : `fixture-agent-${runId}`;
let baseUrl = "";
let setupPlan: SetupOperation[] = [];
let callPlan: FixtureCall[] = [];
let configuration = buildEvidenceConfiguration("anthropic", "configuration-pending");
let configurationFingerprint = "";
let configurationFingerprintProvenance: "sealed-drand-plan" | "pre-run-generated" = "pre-run-generated";
let providerCostCapAtomic: bigint | null = null;
let replicationBaselineRunId: string | null = null;
let intendedAuthoritativeSetup: ReturnType<typeof buildIntendedAuthoritativeSetup> | null = null;

async function loadAndValidateConfiguration(): Promise<void> {
  heldOutPlan = heldOutPlanPath
    ? JSON.parse(await readConfigurationFile(heldOutPlanPath)) as HeldOutPlan
    : null;
  if (heldOutPlan) validateHeldOutPlan(heldOutPlan);
  const providerValue = heldOutPlan?.provider
    ?? process.env["FUSE_PROVIDER"]?.trim().toLowerCase() ?? "anthropic";
  if (providerValue !== "anthropic" && providerValue !== "openrouter") {
    throw new Error("FUSE_PROVIDER_INVALID");
  }
  provider = providerValue;
  model = heldOutPlan?.model ?? process.env["FUSE_EVIDENCE_MODEL"]?.trim()
    ?? process.env["ANTHROPIC_MODEL"]?.trim() ?? "claude-sonnet-4-6";
  if (heldOutPlan && (process.env["FUSE_PROVIDER"]?.trim().toLowerCase() ?? provider) !== provider) {
    throw new Error("HELD_OUT_PROVIDER_OVERRIDE_FORBIDDEN");
  }
  if (heldOutPlan && (process.env["FUSE_EVIDENCE_MODEL"]?.trim() ?? model) !== model) {
    throw new Error("HELD_OUT_MODEL_OVERRIDE_FORBIDDEN");
  }
  baseUrl = validateFuseUrl(process.env["FUSE_URL"]?.trim() ?? "http://127.0.0.1:8787");
  setupPlan = heldOutPlan
    ? buildHeldOutSetupPlan(heldOutPlan, runId)
    : buildFixtureSetupPlan({ runId, provider, model, mandateId, policyId, agentId });
  callPlan = heldOutPlan ? buildHeldOutCallPlan(heldOutPlan, runId) : buildFixtureCallPlan(runId, model);
  configuration = buildEvidenceConfiguration(provider, model);
  configurationFingerprint = heldOutPlan
    ? buildHeldOutConfigurationFingerprint(heldOutPlan)
    : buildEvidenceConfigurationFingerprint(configuration);
  configurationFingerprintProvenance = heldOutPlan ? "sealed-drand-plan" : "pre-run-generated";
  const providerCostCapValue = process.env["FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC"]?.trim();
  providerCostCapAtomic = providerCostCapValue
    ? validateEvidenceProviderCostCapAtomic(providerCostCapValue)
    : null;
  if (heldOutPlan && !dryRun && providerCostCapAtomic === null) {
    throw new Error("HELD_OUT_PROVIDER_COST_CAP_REQUIRED");
  }
  const baselinePath = process.env["FUSE_EVIDENCE_BASELINE_MANIFEST"]?.trim();
  if (heldOutPlan && baselinePath) throw new Error("HELD_OUT_BASELINE_POOLING_FORBIDDEN");
  replicationBaselineRunId = null;
  if (baselinePath) {
    const baseline = JSON.parse(await readConfigurationFile(baselinePath)) as ReplicationBaselineManifest;
    replicationBaselineRunId = validateReplicationBaseline(
      baseline, configurationFingerprint, configuration.calls.length,
    ).baselineRunId;
  }
  if (heldOutPlan && !dryRun) {
    await assertArtifactCommittedAtHead(heldOutPlanPath!);
  }
  intendedAuthoritativeSetup = buildIntendedAuthoritativeSetup({
    setupPlan, provider, model, mandateId, policyId, agentId,
  });
  configurationReady = true;
}

if (dryRun) {
  await loadAndValidateConfiguration();
  const dryHeldOutPlan = heldOutPlan as HeldOutPlan | null;
  const dryProviderCostCapAtomic = providerCostCapAtomic as bigint | null;
  console.log(JSON.stringify({
    phase: "dry-run", runId, provider, model, configurationFingerprint,
    configurationFingerprintProvenance,
    heldOutPlanFingerprint: dryHeldOutPlan?.planFingerprint ?? null,
    providerCostCapAtomic: dryProviderCostCapAtomic?.toString() ?? null,
    replicationBaselineRunId, mandateId, policyId, agentId,
    setupOperations: setupPlan.map(({ kind, method, path }) => ({ kind, method, path })),
    evidenceType,
    protocolVersion: dryHeldOutPlan?.protocolVersion ?? null,
    heldOutRound: dryHeldOutPlan?.beacon.round ?? null,
    heldOutChainHash: dryHeldOutPlan?.beacon.chainHash ?? null,
    fixtures: dryHeldOutPlan?.cohorts ?? fixtureScenarios,
    callCount: callPlan.length,
    paidCallsExecuted: 0,
  }, null, 2));
  process.exit(0);
}

let adminToken = "";
let databaseUrl = "";
let runtimeToken = "";
let authoritativeSetup: { fingerprint: string; source: string } | null = null;
const attempts: AttemptManifestEntry[] = [];
let activeAttempt: { requestId: string; sequence: number } | null = null;
let lifecycleStage: EvidenceRunStage = "setup";
const runAbort = new AbortController();
const interruptionHandlers = new Map<NodeJS.Signals, () => void>();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const handler = () => {
    lifecycleStage = "interrupted";
    runAbort.abort(new Error("EVIDENCE_RUN_INTERRUPTED"));
  };
  interruptionHandlers.set(signal, handler);
  process.on(signal, handler);
}

try {
  await acquireRunClaim(claimPath, {
    schemaVersion: 1,
    runId,
    evidenceType,
    claimedAt: new Date().toISOString(),
  });
  await persistManifest("running", null, true);
  await runWithIncompleteEvidenceCapture(
    async () => {
      throwIfInterrupted();
      await loadAndValidateConfiguration();
      await persistManifest("running");
      const expectedAuthoritativeSetup = intendedAuthoritativeSetup;
      if (!expectedAuthoritativeSetup) throw new Error("EVIDENCE_CONFIGURATION_INVALID");
      adminToken = requiredEnv("FUSE_ADMIN_TOKEN");
      databaseUrl = process.env["DATABASE_URL_UNPOOLED"]?.trim()
        ?? process.env["DATABASE_URL"]?.trim()
        ?? "";
      if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
      if (new URL(databaseUrl).hostname.includes("-pooler")) {
        throw new Error("USE_UNPOOLED_CONNECTION");
      }
      for (const [index, operation] of setupPlan.entries()) {
        const result = await executeAdminOperation(operation, index + 1);
        if (operation.kind === "agentCredential") {
          const token = result && typeof result === "object" && "token" in result ? result.token : undefined;
          if (typeof token !== "string" || !token.trim()) throw new Error("FIXTURE_AGENT_TOKEN_MISSING");
          runtimeToken = token;
        }
      }
      if (!runtimeToken) throw new Error("FIXTURE_AGENT_TOKEN_MISSING");

      lifecycleStage = "authoritative-setup";
      throwIfInterrupted();
      const setupClient = new Client({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 10_000,
        query_timeout: 30_000,
        statement_timeout: 30_000,
      });
      let setupClientClosed = false;
      const closeSetupClient = () => {
        setupClient.connection.stream.destroy();
        if (setupClientClosed) return;
        setupClientClosed = true;
        void setupClient.end().catch(() => undefined);
      };
      try {
        await runAbortable(() => setupClient.connect(), closeSetupClient);
        authoritativeSetup = await runAbortable(() => withVerifiedAuthoritativeSetup(
          expectedAuthoritativeSetup,
          () => queryAuthoritativeSetup(setupClient, { mandateId, policyId, policyVersion: 1 }),
          async (verification) => verification,
        ), closeSetupClient);
      } finally {
        if (!setupClientClosed) {
          setupClientClosed = true;
          await runAbortable(() => setupClient.end(), closeSetupClient);
        }
      }
      throwIfInterrupted();
      await persistManifest("running");

      lifecycleStage = "provider-call";
      for (const [index, call] of callPlan.entries()) {
        activeAttempt = { requestId: call.requestId, sequence: index + 1 };
        throwIfInterrupted();
        if (providerCostCapAtomic !== null) {
          assertEvidenceProviderCostCap(attempts, call, providerCostCapAtomic);
        }
        const attempt = await executeFixtureCall(call, runtimeToken, index + 1);
        lifecycleStage = "post-call-validation";
        await recordAttemptDurablyBeforeAssertions(
          attempts,
          attempt,
          () => persistManifest("running"),
          () => {
            throwIfInterrupted();
            if (providerCostCapAtomic !== null) {
              assertEvidenceProviderCostSpent(attempts, providerCostCapAtomic);
            }
            if (call.expected !== "completed-or-denied" && attempt.outcome !== call.expected) {
              throw new Error(`FIXTURE_EXPECTATION_FAILED:${call.requestId}:${call.expected}:${attempt.outcome}`);
            }
          },
        );
        throwIfInterrupted();
        lifecycleStage = "provider-call";
      }

      activeAttempt = null;
      throwIfInterrupted();
      lifecycleStage = "final-validation";
      if (heldOutPlan) validateEvidenceCallOutcomes(callPlan, attempts);
      else validateFixtureOutcomes(callPlan, attempts);
      await persistManifest("complete");
    },
    (failure) => persistManifest("incomplete", failure),
    () => ({
      stage: lifecycleStage,
      requestId: activeAttempt?.requestId ?? null,
      attemptSequence: activeAttempt?.sequence ?? null,
      attemptsPersisted: attempts.length,
      plannedAttempts: callPlan.length,
    }),
  );
} finally {
  for (const [signal, handler] of interruptionHandlers) process.removeListener(signal, handler);
}
console.log(JSON.stringify({ phase: "complete", runId, attempts: attempts.length, outputPath }));

async function persistManifest(
  phase: "running" | "complete" | "incomplete",
  failure: EvidenceRunFailure | null = null,
  initial = false,
): Promise<void> {
  const manifest = {
    schemaVersion: 3,
    evidenceType,
    configurationStatus: configurationReady ? "ready" : "pending",
    protocolVersion: configurationReady ? heldOutPlan?.protocolVersion ?? null : null,
    phase,
    runId,
    mandateId,
    policyId,
    agentId,
    provider: configurationReady ? provider : null,
    model: configurationReady ? model : null,
    configurationFingerprint: configurationReady ? configurationFingerprint : null,
    configurationFingerprintProvenance: configurationReady ? configurationFingerprintProvenance : null,
    authoritativeSetupFingerprint: authoritativeSetup?.fingerprint ?? null,
    authoritativeSetupSource: authoritativeSetup?.source ?? null,
    heldOutPlanFingerprint: configurationReady ? heldOutPlan?.planFingerprint ?? null : null,
    providerCostCapAtomic: configurationReady ? providerCostCapAtomic?.toString() ?? null : null,
    replicationBaselineRunId: configurationReady ? replicationBaselineRunId : null,
    heldOutBeaconRound: configurationReady ? heldOutPlan?.beacon.round ?? null : null,
    heldOutBeaconChainHash: configurationReady ? heldOutPlan?.beacon.chainHash ?? null : null,
    generatedAt: new Date().toISOString(),
    failure,
    attempts,
  };
  if (initial) {
    await writeOnceJson(outputPath, manifest);
    return;
  }
  await atomicReplaceJson(outputPath, manifest, { immutableWhenTerminal: true });
}

function throwIfInterrupted(): void {
  if (runAbort.signal.aborted) throw runAbort.signal.reason;
}

async function runAbortable<T>(
  operation: () => Promise<T>,
  cancel: () => void = () => undefined,
): Promise<T> {
  throwIfInterrupted();
  const pending = operation();
  let timeout: NodeJS.Timeout | undefined;
  let cancellationRequested = false;
  const requestCancellation = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    try { cancel(); } catch { /* preserve the lifecycle failure that requested cancellation */ }
  };
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    requestCancellation();
    rejectAbort(runAbort.signal.reason);
  };
  runAbort.signal.addEventListener("abort", onAbort, { once: true });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      requestCancellation();
      reject(new Error("EVIDENCE_OPERATION_TIMEOUT"));
    }, 30_000);
  });
  try {
    return await Promise.race([pending, aborted, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
    runAbort.signal.removeEventListener("abort", onAbort);
  }
}

async function readConfigurationFile(path: string): Promise<string> {
  if (dryRun) return readFile(path, "utf8");
  const controller = new AbortController();
  return runAbortable(
    () => readFile(path, { encoding: "utf8", signal: controller.signal }),
    () => controller.abort(),
  );
}

async function fetchJson(
  url: string,
  init: Omit<RequestInit, "signal">,
): Promise<{ response: Response; body: Record<string, unknown> | undefined }> {
  throwIfInterrupted();
  const controller = new AbortController();
  const onRunAbort = () => { controller.abort(runAbort.signal.reason); };
  runAbort.signal.addEventListener("abort", onRunAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error("EVIDENCE_OPERATION_TIMEOUT"));
  }, 30_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, body: await readJson(response, controller.signal) };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    runAbort.signal.removeEventListener("abort", onRunAbort);
  }
}

async function executeAdminOperation(
  operation: SetupOperation,
  index: number,
): Promise<Record<string, unknown> | undefined> {
  const { response, body } = await fetchJson(`${baseUrl}${operation.path}`, {
    method: operation.method,
    headers: {
      "Authorization": `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      "X-Request-Id": `${runId}-admin-${index}`,
    },
    body: JSON.stringify(operation.body),
    redirect: "error",
  });
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
  const initialResult = await fetchJson(`${baseUrl}/v1/chat/completions`, {
    method: "POST", headers, body, redirect: "error",
  });
  let response = initialResult.response;
  let responseBody = initialResult.body;
  if (response.status === 402) {
    throw new Error("EVIDENCE_X402_PAYMENT_REQUIRED");
  }
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

async function readJson(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (response.status === 204 || !response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort(signal?.reason ?? new Error("EVIDENCE_RUN_INTERRUPTED"));
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 1_048_576) {
        const error = new Error("EVIDENCE_RESPONSE_BODY_TOO_LARGE");
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(item.value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(body: Record<string, unknown> | undefined): string {
  const persistedResponseErrorCodes = new Set([
  "ACTUAL_COST_EXCEEDS_RESERVATION",
  "AGENT_CREDENTIAL_REQUIRED",
  "AGENT_NOT_AUTHORIZED",
  "BRANCH_BUDGET_EXCEEDED",
  "BRANCH_EXPIRED",
  "BRANCH_NOT_AUTHORIZED",
  "BRANCH_TRIPPED",
  "CAPABILITY_MISSING",
  "DAILY_LIMIT_EXCEEDED",
  "HOURLY_LIMIT_EXCEEDED",
  "IDEMPOTENCY_CONFLICT",
  "INCOMPLETE_WORKLOAD_SCOPE",
  "INFERENCE_EXECUTION_UNAVAILABLE",
  "INPUT_TOKEN_LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
  "INVALID_COMPLETION_REQUEST",
  "INVALID_WORKLOAD_SCOPE",
  "MANDATE_BUDGET_EXCEEDED",
  "MANDATE_EXPIRED",
  "MANDATE_INACTIVE",
  "MANDATE_NOT_FOUND",
  "MISSING_IDEMPOTENCY_KEY",
  "MISSING_MANDATE",
  "MODEL_NOT_ALLOWED",
  "OUTPUT_TOKEN_LIMIT_EXCEEDED",
  "PER_CALL_LIMIT_EXCEEDED",
  "POLICY_PAUSED",
  "PROVIDER_NOT_ALLOWED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMIT_EXCEEDED",
  "REQUESTED_MODEL_MISMATCH",
  "REQUEST_IN_PROGRESS",
  "REQUEST_REQUIRES_REVIEW",
  "WORKLOAD_CLASS_BUDGET_EXCEEDED",
  "WORKLOAD_CLASS_INVOCATION_LIMIT_EXCEEDED",
  "WORKLOAD_CLASS_NOT_ALLOWED",
  "WORKLOAD_CLASS_PER_CALL_LIMIT_EXCEEDED",
  "WORKLOAD_CLASS_REQUIRED",
  "WORKLOAD_CLASS_SHAPE_MISMATCH",
  "WORKLOAD_SHADOW_ROLLOUT_DISABLED",
]);
  const error = body?.["error"];
  if (!error || typeof error !== "object") return "EVIDENCE_RESPONSE_ERROR_CODE_UNTRUSTED";
  const reasonCodes = "reasonCodes" in error ? error.reasonCodes : undefined;
  const code = Array.isArray(reasonCodes) && typeof reasonCodes[0] === "string"
    ? reasonCodes[0]
    : "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code && persistedResponseErrorCodes.has(code)
    ? code
    : "EVIDENCE_RESPONSE_ERROR_CODE_UNTRUSTED";
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
