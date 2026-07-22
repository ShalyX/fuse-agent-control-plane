#!/usr/bin/env node
import { chmod, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Pool } from "pg";
import {
  buildEvidenceConfiguration,
  buildEvidenceConfigurationFingerprint,
  buildFixtureCallPlan,
  buildReplayReport,
  validateAuthoritativeAttempts,
  validateEvidenceRunId,
  validateFixtureOutcomes,
  type AttemptManifestEntry,
  type AuthoritativeExecution,
  type PersistedShadowEvidence,
} from "../src/evidence/harness.js";

interface FixtureManifest {
  schemaVersion: number;
  runId: string;
  mandateId: string;
  provider: "anthropic" | "openrouter";
  model: string;
  configurationFingerprint: string;
  configurationFingerprintProvenance: string;
  replicationBaselineRunId: string | null;
  attempts: AttemptManifestEntry[];
}

const manifestPath = process.env["FUSE_EVIDENCE_MANIFEST"]?.trim();
if (!manifestPath) throw new Error("FUSE_EVIDENCE_MANIFEST_REQUIRED");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
if (manifest.schemaVersion !== 2 || !manifest.runId?.trim() || !manifest.mandateId?.trim()
  || (manifest.provider !== "anthropic" && manifest.provider !== "openrouter")
  || !manifest.model?.trim() || !Array.isArray(manifest.attempts)
  || !/^sha256:[a-f0-9]{64}$/.test(manifest.configurationFingerprint)
  || (manifest.configurationFingerprintProvenance !== "pre-run-generated"
    && manifest.configurationFingerprintProvenance !== "post-hoc-db-verified")) {
  throw new Error("EVIDENCE_MANIFEST_INVALID");
}
validateEvidenceRunId(manifest.runId);
const expectedFingerprint = buildEvidenceConfigurationFingerprint(
  buildEvidenceConfiguration(manifest.provider, manifest.model),
);
if (manifest.configurationFingerprint !== expectedFingerprint) {
  throw new Error("EVIDENCE_CONFIGURATION_FINGERPRINT_MISMATCH");
}
const fixtureCalls = buildFixtureCallPlan(manifest.runId, manifest.model);
if (manifest.mandateId !== `fixture-${manifest.runId}`) throw new Error("EVIDENCE_MANIFEST_INVALID");
validateFixtureOutcomes(fixtureCalls, manifest.attempts);

const databaseUrl = process.env["DATABASE_URL_UNPOOLED"]?.trim()
  ?? process.env["DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
if (new URL(databaseUrl).hostname.includes("-pooler")) throw new Error("USE_UNPOOLED_CONNECTION");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const requestIds = manifest.attempts.map(({ requestId }) => requestId);
  const executionsResult = await pool.query<{
    request_id: string;
    status: string;
    actual_cost_atomic: string | null;
  }>(`
    SELECT request_id, status, actual_cost_atomic::text
    FROM inference_executions
    WHERE mandate_id = $1 AND request_id = ANY($2::text[])
  `, [manifest.mandateId, requestIds]);
  const executions: AuthoritativeExecution[] = executionsResult.rows.map((row) => ({
    requestId: row.request_id,
    status: row.status,
    actualCostAtomic: row.actual_cost_atomic,
  }));
  const authoritativeCoverage = validateAuthoritativeAttempts(manifest.attempts, executions);

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
  const report = buildReplayReport(manifest.attempts, evidence);
  const outputPath = join(process.cwd(), "evidence", "replay", `${manifest.runId}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({
    schemaVersion: 1,
    runId: manifest.runId,
    mandateId: manifest.mandateId,
    configurationFingerprint: manifest.configurationFingerprint,
    configurationFingerprintProvenance: manifest.configurationFingerprintProvenance,
    replicationBaselineRunId: manifest.replicationBaselineRunId,
    sourceManifest: relative(process.cwd(), manifestPath),
    generatedAt: new Date().toISOString(),
    authoritativeCoverage,
    policySemantics: {
      A: "persisted deterministic ceiling/policy outcomes plus explicitly listed pre-execution model-binding denials",
      B: "class-prior-only v1, projected from persisted CLASS_PRIOR_EXCEEDED evidence",
      C: "persisted branch-aware shadow evidence; no cohort reconstruction",
    },
    ...report,
  }, null, 2), { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(JSON.stringify({ phase: "complete", runId: manifest.runId, outputPath,
    coverage: report.coverage }));
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
