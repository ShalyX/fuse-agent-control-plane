#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  buildReplicationComparison,
  validateEvidenceRunId,
  type ReplicationComparableReport,
} from "../src/evidence/harness.js";

const [baselinePath, ...candidatePaths] = process.argv.slice(2);
if (!baselinePath || candidatePaths.length === 0) {
  throw new Error("USAGE: evidence:compare <baseline-report.json> <candidate-report.json> [...]");
}

const baseline = await readReport(baselinePath);
const candidates = await Promise.all(candidatePaths.map(readReport));
const comparison = buildReplicationComparison(baseline, candidates);
const outputPath = join(
  process.cwd(),
  "evidence",
  "replication",
  `${validateEvidenceRunId(baseline.runId)}-comparison.json`,
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baselineReport: relative(process.cwd(), baselinePath),
  candidateReports: candidatePaths.map((path) => relative(process.cwd(), path)),
  ...comparison,
}, null, 2), { mode: 0o600 });
await chmod(outputPath, 0o600);
console.log(JSON.stringify({
  phase: "complete",
  baselineRunId: comparison.baselineRunId,
  candidateCount: comparison.candidateCount,
  outputPath,
  exactOutcomeAgreement: comparison.exactOutcomeAgreement,
}));

async function readReport(path: string): Promise<ReplicationComparableReport> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") throw new Error("EVIDENCE_REPLICATION_REPORT_INVALID");
  return value as ReplicationComparableReport;
}
