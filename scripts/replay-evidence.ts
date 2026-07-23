#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Pool } from "pg";
import { assertArtifactCommittedAtHead } from "../src/evidence/committedArtifact.js";
import {
  assertEvidenceProviderCostSpent,
  buildEvidenceConfiguration,
  buildEvidenceConfigurationFingerprint,
  buildFixtureCallPlan,
  buildFixtureSetupPlan,
  buildReplayReport,
  validateAuthoritativeAttempts,
  validateEvidenceCallOutcomes,
  validateEvidenceProviderCostCapAtomic,
  validateEvidenceRunId,
  validateFixtureOutcomes,
  type AttemptManifestEntry,
  type AuthoritativeExecution,
  type PersistedShadowEvidence,
} from "../src/evidence/harness.js";
import {
  buildHeldOutCallPlan,
  buildHeldOutConfigurationFingerprint,
  buildHeldOutReplaySummary,
  buildHeldOutSetupPlan,
  validateHeldOutPlan,
  type HeldOutPlan,
} from "../src/evidence/heldOut.js";
import {
  AUTHORITATIVE_SETUP_SOURCE,
  buildIntendedAuthoritativeSetup,
  queryAuthoritativeSetup,
  validateAuthoritativeSetup,
} from "../src/evidence/authoritative.js";
import { writeOnceJson } from "../src/evidence/durableArtifacts.js";

interface FixtureManifest {
  schemaVersion: number;
  phase: "running" | "complete";
  evidenceType?: "fixed-fixtures" | "held-out";
  protocolVersion?: number | null;
  runId: string;
  mandateId: string;
  policyId: string;
  agentId: string;
  provider: "anthropic" | "openrouter";
  model: string;
  configurationFingerprint: string;
  configurationFingerprintProvenance: string;
  authoritativeSetupFingerprint: string;
  authoritativeSetupSource: string;
  replicationBaselineRunId: string | null;
  heldOutPlanFingerprint?: string | null;
  heldOutBeaconRound?: number | null;
  heldOutBeaconChainHash?: string | null;
  providerCostCapAtomic?: string | null;
  attempts: AttemptManifestEntry[];
}

const manifestPath = process.env["FUSE_EVIDENCE_MANIFEST"]?.trim();
if (!manifestPath) throw new Error("FUSE_EVIDENCE_MANIFEST_REQUIRED");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
if (manifest.schemaVersion !== 2 || manifest.phase !== "complete"
  || !manifest.runId?.trim() || !manifest.mandateId?.trim() || !manifest.policyId?.trim()
  || !manifest.agentId?.trim()
  || (manifest.provider !== "anthropic" && manifest.provider !== "openrouter")
  || !manifest.model?.trim() || !Array.isArray(manifest.attempts)
  || !/^sha256:[a-f0-9]{64}$/.test(manifest.configurationFingerprint)
  || !/^sha256:[a-f0-9]{64}$/.test(manifest.authoritativeSetupFingerprint)
  || manifest.authoritativeSetupSource !== AUTHORITATIVE_SETUP_SOURCE
  || (manifest.configurationFingerprintProvenance !== "pre-run-generated"
    && manifest.configurationFingerprintProvenance !== "post-hoc-db-verified"
    && manifest.configurationFingerprintProvenance !== "sealed-drand-plan")) {
  throw new Error("EVIDENCE_MANIFEST_INVALID");
}
validateEvidenceRunId(manifest.runId);
const heldOut = manifest.evidenceType === "held-out";
const heldOutPlanPath = process.env["FUSE_HELD_OUT_PLAN"]?.trim();
if (heldOut && !heldOutPlanPath) throw new Error("FUSE_HELD_OUT_PLAN_REQUIRED");
if (!heldOut && heldOutPlanPath) throw new Error("HELD_OUT_MANIFEST_REQUIRED");
if (heldOut) await assertArtifactCommittedAtHead(heldOutPlanPath!);
const heldOutPlan = heldOut
  ? JSON.parse(await readFile(heldOutPlanPath!, "utf8")) as HeldOutPlan
  : null;
if (heldOutPlan) validateHeldOutPlan(heldOutPlan);
if (heldOutPlan && (manifest.provider !== heldOutPlan.provider || manifest.model !== heldOutPlan.model)) {
  throw new Error("HELD_OUT_MANIFEST_PLAN_BINDING_MISMATCH");
}
const expectedFingerprint = heldOutPlan
  ? buildHeldOutConfigurationFingerprint(heldOutPlan)
  : buildEvidenceConfigurationFingerprint(buildEvidenceConfiguration(manifest.provider, manifest.model));
if (manifest.configurationFingerprint !== expectedFingerprint) {
  throw new Error("EVIDENCE_CONFIGURATION_FINGERPRINT_MISMATCH");
}
const fixtureCalls = heldOutPlan
  ? buildHeldOutCallPlan(heldOutPlan, manifest.runId)
  : buildFixtureCallPlan(manifest.runId, manifest.model);
const setupPlan = heldOutPlan
  ? buildHeldOutSetupPlan(heldOutPlan, manifest.runId)
  : buildFixtureSetupPlan({
    runId: manifest.runId,
    provider: manifest.provider,
    model: manifest.model,
    mandateId: manifest.mandateId,
    policyId: manifest.policyId,
    agentId: manifest.agentId,
  });
const expectedMandate = heldOut ? `heldout-${manifest.runId}` : `fixture-${manifest.runId}`;
if (manifest.mandateId !== expectedMandate) throw new Error("EVIDENCE_MANIFEST_INVALID");
if (heldOut && (manifest.heldOutPlanFingerprint !== heldOutPlan!.planFingerprint
  || manifest.heldOutBeaconRound !== heldOutPlan!.beacon.round
  || manifest.heldOutBeaconChainHash !== heldOutPlan!.beacon.chainHash
  || manifest.protocolVersion !== heldOutPlan!.protocolVersion
  || typeof manifest.providerCostCapAtomic !== "string"
  || !/^\d+$/.test(manifest.providerCostCapAtomic)
  || manifest.replicationBaselineRunId !== null)) {
  throw new Error("HELD_OUT_MANIFEST_PLAN_MISMATCH");
}
const heldOutProviderCostCapAtomic = heldOut
  ? validateEvidenceProviderCostCapAtomic(manifest.providerCostCapAtomic!)
  : null;
if (heldOut) validateEvidenceCallOutcomes(fixtureCalls, manifest.attempts);
else validateFixtureOutcomes(fixtureCalls, manifest.attempts);
if (heldOut) assertEvidenceProviderCostSpent(
  manifest.attempts,
  heldOutProviderCostCapAtomic!,
);

const databaseUrl = process.env["DATABASE_URL_UNPOOLED"]?.trim()
  ?? process.env["DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
if (new URL(databaseUrl).hostname.includes("-pooler")) throw new Error("USE_UNPOOLED_CONNECTION");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const requestIds = manifest.attempts.map(({ requestId }) => requestId);
  const intendedSetup = buildIntendedAuthoritativeSetup({
    setupPlan,
    provider: manifest.provider,
    model: manifest.model,
    mandateId: manifest.mandateId,
    policyId: manifest.policyId,
    agentId: manifest.agentId,
  });
  const replaySetup = validateAuthoritativeSetup(
    intendedSetup,
    await queryAuthoritativeSetup(pool, {
      mandateId: manifest.mandateId,
      policyId: manifest.policyId,
      policyVersion: 1,
    }),
  );
  if (replaySetup.fingerprint !== manifest.authoritativeSetupFingerprint
    || replaySetup.source !== manifest.authoritativeSetupSource) {
    throw new Error("REPLAY_AUTHORITATIVE_SETUP_FINGERPRINT_MISMATCH");
  }
  const executionsResult = await pool.query<{
    organization_id: string;
    request_id: string;
    status: string;
    actual_cost_atomic: string | null;
    provider: string;
    model: string;
    branch_id: string | null;
    workload_class: string | null;
    max_output_tokens: number;
    input_tokens: number;
    agent_id: string;
    policy_id: string;
    policy_version: number;
    decision_id: string;
    request_fingerprint: string;
    decision_outcome: string;
    decision_would_outcome: string;
    decision_enforced: boolean;
  }>(`
    SELECT execution.organization_id, execution.request_id, execution.status,
      execution.actual_cost_atomic::text,
      execution.provider, execution.model, execution.branch_id, execution.workload_class,
      execution.max_output_tokens, execution.input_tokens, execution.agent_id, execution.decision_id,
      execution.request_fingerprint, decision.policy_id, decision.policy_version,
      decision.outcome AS decision_outcome, decision.would_outcome AS decision_would_outcome,
      decision.enforced AS decision_enforced
    FROM inference_executions execution
    JOIN policy_decisions decision
      ON decision.organization_id = execution.organization_id
     AND decision.id = execution.decision_id
    WHERE execution.mandate_id = $1
  `, [manifest.mandateId]);
  const executions: AuthoritativeExecution[] = executionsResult.rows.map((row) => ({
    organizationId: row.organization_id,
    requestId: row.request_id,
    status: row.status,
    actualCostAtomic: row.actual_cost_atomic,
    provider: row.provider,
    model: row.model,
    branchId: row.branch_id,
    workloadClass: row.workload_class,
    maxOutputTokens: row.max_output_tokens,
    inputTokens: row.input_tokens,
    agentId: row.agent_id,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    decisionId: row.decision_id,
    requestFingerprint: row.request_fingerprint,
    decisionOutcome: row.decision_outcome,
    decisionWouldOutcome: row.decision_would_outcome,
    decisionEnforced: row.decision_enforced,
  }));
  const authoritativeCoverage = validateAuthoritativeAttempts(
    manifest.attempts,
    executions,
    fixtureCalls,
    heldOut ? { provider: manifest.provider, model: manifest.model } : undefined,
  );

  const evidenceResult = await pool.query<{ evidence: Record<string, unknown> }>(`
    SELECT evaluation.evidence
    FROM shadow_evaluations evaluation
    JOIN inference_executions execution
      ON execution.organization_id = evaluation.organization_id
     AND execution.request_id = evaluation.request_id
    WHERE execution.mandate_id = $1
      AND evaluation.request_id = ANY($2::text[])
    ORDER BY (evaluation.evidence->>'cohortOrdinal')::numeric
  `, [manifest.mandateId, requestIds]);
  const evidence = evidenceResult.rows.map(({ evidence: value }) => parseEvidence(value));
  const report = heldOutPlan ? null : buildReplayReport(manifest.attempts, evidence);
  const heldOutSummary = heldOutPlan
    ? buildHeldOutReplaySummary(heldOutPlan, manifest.attempts, evidence)
    : null;
  const outputPath = join(process.cwd(), "evidence", heldOut ? "held-out/replay" : "replay", `${manifest.runId}.json`);
  await writeOnceJson(outputPath, {
    schemaVersion: 1,
    runId: manifest.runId,
    mandateId: manifest.mandateId,
    configurationFingerprint: manifest.configurationFingerprint,
    configurationFingerprintProvenance: manifest.configurationFingerprintProvenance,
    authoritativeSetupFingerprint: replaySetup.fingerprint,
    authoritativeSetupSource: replaySetup.source,
    replicationBaselineRunId: manifest.replicationBaselineRunId,
    sourceManifest: relative(process.cwd(), manifestPath),
    generatedAt: new Date().toISOString(),
    authoritativeCoverage,
    evidenceType: heldOut ? "held-out" : "fixed-fixtures",
    protocolVersion: heldOutPlan?.protocolVersion ?? null,
    heldOutPlanFingerprint: heldOutPlan?.planFingerprint ?? null,
    heldOutBeaconRound: heldOutPlan?.beacon.round ?? null,
    heldOutBeaconChainHash: heldOutPlan?.beacon.chainHash ?? null,
    authoritativeTrustBoundary: {
      setup: "PostgreSQL persisted provider binding, policy/version and workload/shadow configuration, mandate, assignment, and branch hierarchy",
      executions: "Every inference_executions and joined policy_decisions dimension available in the current schema",
      unavailable: ["provider-side prompt bytes", "provider-side hidden routing beyond persisted provider/model"],
    },
    policySemantics: {
      A: "persisted deterministic ceiling/policy outcomes plus explicitly listed pre-execution model-binding denials",
      B: "class-prior-only v1, projected from persisted CLASS_PRIOR_EXCEEDED evidence",
      C: "persisted branch-aware shadow evidence; no cohort reconstruction",
    },
    ...(report ?? {}),
    heldOutSummary,
  });
  console.log(JSON.stringify({ phase: "complete", runId: manifest.runId, outputPath,
    coverage: report?.coverage ?? { attempts: manifest.attempts.length, evidence: evidence.length },
    heldOutGate: heldOutSummary?.gate ?? null }));
} finally {
  await pool.end();
}

function parseEvidence(value: Record<string, unknown>): PersistedShadowEvidence {
  const requestId = value["requestId"];
  const signals = value["signals"];
  const eligibleForIntervention = value["eligibleForIntervention"];
  const wouldSignalTarget = value["wouldSignalTarget"];
  const cohortShift = value["cohortShift"];
  const cohortOrdinal = value["cohortOrdinal"];
  const allowedSignals = new Set([
    "SIBLING_DIVERGENCE", "CLASS_PRIOR_EXCEEDED", "CORRELATED_COHORT_SHIFT",
  ]);
  if (typeof requestId !== "string" || !Array.isArray(signals)
    || !signals.every((signal) => typeof signal === "string" && allowedSignals.has(signal))
    || typeof eligibleForIntervention !== "boolean" || typeof wouldSignalTarget !== "boolean"
    || typeof cohortShift !== "boolean" || typeof cohortOrdinal !== "string"
    || !/^\d+$/.test(cohortOrdinal)) {
    throw new Error("PERSISTED_SHADOW_EVIDENCE_INVALID");
  }
  return {
    requestId,
    signals: signals as PersistedShadowEvidence["signals"],
    eligibleForIntervention,
    wouldSignalTarget,
    cohortShift,
    cohortOrdinal,
  };
}
