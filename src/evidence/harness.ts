import { createHash } from "node:crypto";

export type FixtureLabel = "legitimate" | "runaway" | "hard-deny";
export type AttemptOutcome = "completed" | "denied" | "error";

export interface AttemptManifestEntry {
  runId: string;
  fixtureId: number;
  requestId: string;
  sequence: number;
  label: FixtureLabel;
  outcome: AttemptOutcome;
  actualCostAtomic: string;
  denialCode?: string;
  occurredAt: string;
}

export interface PersistedShadowEvidence {
  requestId: string;
  signals: Array<"SIBLING_DIVERGENCE" | "CLASS_PRIOR_EXCEEDED" | "CORRELATED_COHORT_SHIFT">;
  eligibleForIntervention: boolean;
  wouldSignalTarget: boolean;
  cohortShift: boolean;
  cohortOrdinal: string;
}

export interface FixtureScenario {
  id: number;
  name: string;
  fanOut: number;
}

export const fixtureScenarios: readonly FixtureScenario[] = [
  { id: 1, name: "legitimate-burst-summary", fanOut: 1 },
  { id: 2, name: "runaway-child", fanOut: 3 },
  { id: 3, name: "legitimately-unusual-siblings", fanOut: 2 },
  { id: 4, name: "correlated-cohort-shift", fanOut: 4 },
  { id: 5, name: "unauthorized-class-escalation", fanOut: 1 },
  { id: 6, name: "alternating-classes", fanOut: 1 },
  { id: 7, name: "sparse-target-mature-siblings", fanOut: 4 },
  { id: 8, name: "mature-target-sparse-siblings", fanOut: 3 },
  { id: 9, name: "provider-model-mismatch", fanOut: 1 },
  { id: 10, name: "deterministic-hard-budget", fanOut: 1 },
] as const;

export type SetupOperationKind =
  | "agent"
  | "agentCredential"
  | "policy"
  | "mandate"
  | "assignment"
  | "branch"
  | "activation";

export interface SetupOperation {
  kind: SetupOperationKind;
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}

interface SetupInput {
  runId: string;
  provider: "anthropic" | "openrouter";
  model: string;
  mandateId: string;
  policyId: string;
  agentId: string;
}

interface BranchDefinition {
  branchId: string;
  parentBranchId: string | null;
  classes: string[];
  maximumSpendAtomic: string;
}

const BASELINE = "baseline-lookup";
const EXPENSIVE = "expensive-summary";
const SPIKE = "spike-burst";
const WORKLOAD_MAX_COST_ATOMIC: Readonly<Record<string, bigint>> = {
  [BASELINE]: 10000n,
  [EXPENSIVE]: 30000n,
  [SPIKE]: 50000n,
};

const branchDefinitions: readonly BranchDefinition[] = [
  { branchId: "f1-parent", parentBranchId: null, classes: [BASELINE, EXPENSIVE], maximumSpendAtomic: "300000" },
  { branchId: "f1-normal", parentBranchId: "f1-parent", classes: [BASELINE, EXPENSIVE], maximumSpendAtomic: "250000" },
  { branchId: "f2-parent", parentBranchId: null, classes: [BASELINE, SPIKE], maximumSpendAtomic: "800000" },
  { branchId: "f2-healthy-1", parentBranchId: "f2-parent", classes: [SPIKE], maximumSpendAtomic: "100000" },
  { branchId: "f2-healthy-2", parentBranchId: "f2-parent", classes: [SPIKE], maximumSpendAtomic: "100000" },
  { branchId: "f2-runaway", parentBranchId: "f2-parent", classes: [SPIKE], maximumSpendAtomic: "550000" },
  { branchId: "f3-parent", parentBranchId: null, classes: [EXPENSIVE], maximumSpendAtomic: "400000" },
  { branchId: "f3-unusual-1", parentBranchId: "f3-parent", classes: [EXPENSIVE], maximumSpendAtomic: "180000" },
  { branchId: "f3-unusual-2", parentBranchId: "f3-parent", classes: [EXPENSIVE], maximumSpendAtomic: "180000" },
  { branchId: "f4-parent", parentBranchId: null, classes: [BASELINE], maximumSpendAtomic: "700000" },
  ...[1, 2, 3, 4].map((index) => ({ branchId: `f4-shift-${index}`, parentBranchId: "f4-parent", classes: [BASELINE], maximumSpendAtomic: "150000" })),
  { branchId: "f5-parent", parentBranchId: null, classes: [BASELINE], maximumSpendAtomic: "100000" },
  { branchId: "f5-escalation", parentBranchId: "f5-parent", classes: [BASELINE], maximumSpendAtomic: "80000" },
  { branchId: "f6-parent", parentBranchId: null, classes: [BASELINE, SPIKE], maximumSpendAtomic: "350000" },
  { branchId: "f6-alternating", parentBranchId: "f6-parent", classes: [BASELINE, SPIKE], maximumSpendAtomic: "300000" },
  { branchId: "f7-parent", parentBranchId: null, classes: [BASELINE], maximumSpendAtomic: "700000" },
  ...[1, 2, 3].map((index) => ({ branchId: `f7-mature-${index}`, parentBranchId: "f7-parent", classes: [BASELINE], maximumSpendAtomic: "150000" })),
  { branchId: "f7-sparse", parentBranchId: "f7-parent", classes: [BASELINE], maximumSpendAtomic: "150000" },
  { branchId: "f8-parent", parentBranchId: null, classes: [BASELINE], maximumSpendAtomic: "500000" },
  { branchId: "f8-mature", parentBranchId: "f8-parent", classes: [BASELINE], maximumSpendAtomic: "250000" },
  { branchId: "f8-sparse-1", parentBranchId: "f8-parent", classes: [BASELINE], maximumSpendAtomic: "100000" },
  { branchId: "f8-sparse-2", parentBranchId: "f8-parent", classes: [BASELINE], maximumSpendAtomic: "100000" },
  { branchId: "f9-parent", parentBranchId: null, classes: [BASELINE], maximumSpendAtomic: "100000" },
  { branchId: "f9-mismatch", parentBranchId: "f9-parent", classes: [BASELINE], maximumSpendAtomic: "80000" },
  { branchId: "f10-parent", parentBranchId: null, classes: [BASELINE], maximumSpendAtomic: "30000" },
  { branchId: "f10-budget", parentBranchId: "f10-parent", classes: [BASELINE], maximumSpendAtomic: "15000" },
];

export function buildFixtureSetupPlan(input: SetupInput): SetupOperation[] {
  const mandatePath = `/api/v1/admin/mandates/${encodeURIComponent(input.mandateId)}`;
  const shadow = {
    classPriorWindowSpendAtomic: "1000",
    windowSeconds: 900,
    targetMinimumObservations: 3,
    siblingMinimumForScoring: 2,
    siblingMinimumForIntervention: 2,
    confidenceConstant: 5,
    divergenceThresholdBps: 15000,
  };
  const workloadClasses = [
    { id: BASELINE, maxCostPerCallAtomic: WORKLOAD_MAX_COST_ATOMIC[BASELINE]!.toString(), maxInvocationsPerBranch: 100, aggregateBudgetAtomic: "1000000", minimumInputTokens: 1, shadow },
    { id: EXPENSIVE, maxCostPerCallAtomic: WORKLOAD_MAX_COST_ATOMIC[EXPENSIVE]!.toString(), maxInvocationsPerBranch: 100, aggregateBudgetAtomic: "1000000", minimumInputTokens: 1, shadow },
    { id: SPIKE, maxCostPerCallAtomic: WORKLOAD_MAX_COST_ATOMIC[SPIKE]!.toString(), maxInvocationsPerBranch: 100, aggregateBudgetAtomic: "1000000", minimumInputTokens: 1, shadow },
  ];

  return [
    { kind: "agent", method: "POST", path: "/api/v1/admin/agents", body: { agentId: input.agentId, name: "Sibling divergence fixture agent" } },
    { kind: "agentCredential", method: "POST", path: "/api/v1/admin/agent-credentials", body: { credentialId: `fixture-runtime-${input.runId}`, agentId: input.agentId, name: "Sibling divergence fixture runtime", capabilities: ["inference:invoke", "mandates:read", "receipts:read"], expiresAt: null } },
    { kind: "policy", method: "POST", path: "/api/v1/admin/policies", body: { policyId: input.policyId, version: 1, mode: "enforce", allowedProviders: [input.provider], allowedModels: [input.model], requiredCapability: "inference:invoke", limits: { maxPerCallAtomic: "50000", maxHourlyAtomic: "1000000", maxDailyAtomic: "1000000", maxRequestsPerMinute: 1000, maxInputTokens: 50000, maxOutputTokens: 1000 }, workloadClasses } },
    { kind: "mandate", method: "POST", path: "/api/v1/admin/mandates", body: { mandateId: input.mandateId, name: "Sibling divergence evidence fixtures", assetId: "usd-micros", maximumSpendAtomic: "1000000", policyId: input.policyId, policyVersion: 1, expiresAt: null } },
    { kind: "assignment", method: "POST", path: `${mandatePath}/agents`, body: { agentId: input.agentId } },
    ...branchDefinitions.map<SetupOperation>((branch) => ({ kind: "branch", method: "POST", path: `${mandatePath}/branches`, body: { branchId: branch.branchId, parentBranchId: branch.parentBranchId, agentId: input.agentId, allowedWorkloadClasses: branch.classes, maximumSpendAtomic: branch.maximumSpendAtomic, expiresAt: null } })),
    { kind: "activation", method: "POST", path: `${mandatePath}/transitions`, body: { to: "active" } },
  ];
}

export interface FixtureCall {
  runId: string;
  fixtureId: number;
  mandateId: string;
  requestId: string;
  branchId: string;
  workloadClass: string;
  model: string;
  contextUnits: number;
  maxOutputTokens: number;
  label: FixtureLabel;
  expected: "completed" | "denied" | "completed-or-denied";
}

export interface EvidenceConfiguration {
  schemaVersion: 1;
  provider: "anthropic" | "openrouter";
  model: string;
  fixtures: Array<{ id: number; name: string; fanOut: number }>;
  runtimeCapabilities: string[];
  policy: Record<string, unknown>;
  mandate: Record<string, unknown>;
  branches: Array<{
    branchId: string;
    parentBranchId: string | null;
    allowedWorkloadClasses: string[];
    maximumSpendAtomic: string;
    expiresAt: null;
  }>;
  calls: Array<Omit<FixtureCall, "runId" | "mandateId" | "requestId">>;
}

export interface ReplicationBaselineManifest {
  schemaVersion: number;
  phase: string;
  runId: string;
  provider: string;
  model: string;
  configurationFingerprint: string;
  configurationFingerprintProvenance: string;
  attempts: unknown[];
}

export function buildFixtureCallPlan(runId: string, model: string): FixtureCall[] {
  const calls: FixtureCall[] = [];
  const mandateId = `fixture-${runId}`;
  const add = (
    fixtureId: number,
    branchId: string,
    workloadClass: string,
    contextUnits: number,
    label: FixtureLabel = "legitimate",
    expected: FixtureCall["expected"] = "completed",
    selectedModel = model,
    maxOutputTokens = 8,
  ) => {
    calls.push({
      runId,
      fixtureId,
      mandateId,
      requestId: `${runId}-f${fixtureId}-${calls.length + 1}`,
      branchId,
      workloadClass,
      model: selectedModel,
      contextUnits,
      maxOutputTokens,
      label,
      expected,
    });
  };

  for (let index = 0; index < 5; index++) add(1, "f1-normal", BASELINE, 20);
  add(1, "f1-normal", EXPENSIVE, 800, "legitimate", "completed", model, 256);

  for (let index = 0; index < 3; index++) {
    add(2, "f2-healthy-1", SPIKE, 50);
    add(2, "f2-healthy-2", SPIKE, 50);
  }
  // Behavioral evaluation is shadow-only. Deterministic authority is sized for the
  // worst-case 6 × 50,000-atomic class envelope, so these calls must complete;
  // a denial would contaminate the behavioral fixture rather than prove detection.
  for (let index = 0; index < 6; index++) {
    add(2, "f2-runaway", SPIKE, 600, "runaway", "completed");
  }

  for (let index = 0; index < 3; index++) {
    add(3, "f3-unusual-1", EXPENSIVE, 1_200, "legitimate", "completed", model, 128);
    add(3, "f3-unusual-2", EXPENSIVE, 1_200, "legitimate", "completed", model, 128);
  }

  for (let index = 1; index <= 4; index++) add(4, `f4-shift-${index}`, BASELINE, 50);
  for (let index = 1; index <= 4; index++) add(4, `f4-shift-${index}`, BASELINE, 400);

  add(5, "f5-escalation", EXPENSIVE, 100, "hard-deny", "denied");

  for (let index = 0; index < 8; index++) {
    const spike = index % 2 === 1;
    add(6, "f6-alternating", spike ? SPIKE : BASELINE, spike ? 400 : 30,
      spike ? "runaway" : "legitimate", "completed");
  }

  for (let sibling = 1; sibling <= 3; sibling++) {
    for (let index = 0; index < 8; index++) add(7, `f7-mature-${sibling}`, BASELINE, 80);
  }
  add(7, "f7-sparse", BASELINE, 300);
  add(7, "f7-sparse", BASELINE, 350);

  for (let index = 0; index < 12; index++) add(8, "f8-mature", BASELINE, 100);
  add(8, "f8-sparse-1", BASELINE, 50);
  add(8, "f8-sparse-2", BASELINE, 50);

  add(9, "f9-mismatch", BASELINE, 10, "hard-deny", "denied", "gpt-4o");
  for (let index = 0; index < 10; index++) {
    add(10, "f10-budget", BASELINE, 1_000, "hard-deny", "completed-or-denied");
  }
  return calls;
}

export function validateEvidenceProviderCostCapAtomic(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error("EVIDENCE_PROVIDER_COST_CAP_INVALID");
  const cap = BigInt(value);
  if (cap <= 0n) throw new Error("EVIDENCE_PROVIDER_COST_CAP_INVALID");
  return cap;
}

export function assertEvidenceProviderCostCap(
  attempts: readonly AttemptManifestEntry[],
  nextCall: FixtureCall,
  capAtomic: bigint,
): void {
  const spentAtomic = attempts.reduce((total, attempt) => {
    if (!/^\d+$/.test(attempt.actualCostAtomic)) throw new Error("EVIDENCE_PROVIDER_COST_INVALID");
    return total + BigInt(attempt.actualCostAtomic);
  }, 0n);
  const nextMaximumAtomic = WORKLOAD_MAX_COST_ATOMIC[nextCall.workloadClass];
  if (nextMaximumAtomic === undefined) throw new Error("EVIDENCE_WORKLOAD_COST_CAP_MISSING");
  if (spentAtomic + nextMaximumAtomic > capAtomic) {
    throw new Error("EVIDENCE_PROVIDER_COST_CAP_EXCEEDED");
  }
}

export function buildEvidenceConfiguration(
  provider: "anthropic" | "openrouter",
  model: string,
): EvidenceConfiguration {
  const sentinel = "configuration-fingerprint";
  const setup = buildFixtureSetupPlan({
    runId: sentinel,
    provider,
    model,
    mandateId: `fixture-${sentinel}`,
    policyId: `fixture-policy-${sentinel}`,
    agentId: `fixture-agent-${sentinel}`,
  });
  const credential = setup.find(({ kind }) => kind === "agentCredential")?.body;
  const policy = setup.find(({ kind }) => kind === "policy")?.body;
  const mandate = setup.find(({ kind }) => kind === "mandate")?.body;
  if (!credential || !policy || !mandate) throw new Error("EVIDENCE_CONFIGURATION_INVALID");
  const capabilities = credential["capabilities"];
  if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string")) {
    throw new Error("EVIDENCE_CONFIGURATION_INVALID");
  }
  const { policyId: ignoredPolicyId, ...policyConfiguration } = policy;
  const {
    mandateId: ignoredMandateId,
    name: ignoredMandateName,
    policyId: ignoredMandatePolicyId,
    ...mandateConfiguration
  } = mandate;
  void ignoredPolicyId;
  void ignoredMandateId;
  void ignoredMandateName;
  void ignoredMandatePolicyId;
  const calls = buildFixtureCallPlan(sentinel, model).map((call) => ({
    fixtureId: call.fixtureId,
    branchId: call.branchId,
    workloadClass: call.workloadClass,
    model: call.model,
    contextUnits: call.contextUnits,
    maxOutputTokens: call.maxOutputTokens,
    label: call.label,
    expected: call.expected,
  }));
  return {
    schemaVersion: 1,
    provider,
    model,
    fixtures: fixtureScenarios.map(({ id, name, fanOut }) => ({ id, name, fanOut })),
    runtimeCapabilities: [...capabilities],
    policy: policyConfiguration,
    mandate: mandateConfiguration,
    branches: branchDefinitions.map((branch) => ({
      branchId: branch.branchId,
      parentBranchId: branch.parentBranchId,
      allowedWorkloadClasses: [...branch.classes],
      maximumSpendAtomic: branch.maximumSpendAtomic,
      expiresAt: null,
    })),
    calls,
  };
}

export function buildEvidenceConfigurationFingerprint(
  configuration: EvidenceConfiguration,
): string {
  const canonical = canonicalJson(configuration);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function validateReplicationBaseline(
  baseline: ReplicationBaselineManifest,
  configurationFingerprint: string,
  expectedAttemptCount: number,
): { baselineRunId: string; configurationFingerprint: string } {
  if (baseline.schemaVersion !== 2
    || !baseline.runId?.trim()
    || !/^sha256:[a-f0-9]{64}$/.test(baseline.configurationFingerprint)
    || baseline.configurationFingerprint !== configurationFingerprint) {
    throw new Error("EVIDENCE_REPLICATION_CONFIGURATION_MISMATCH");
  }
  if (baseline.configurationFingerprintProvenance !== "pre-run-generated"
    && baseline.configurationFingerprintProvenance !== "post-hoc-db-verified") {
    throw new Error("EVIDENCE_REPLICATION_PROVENANCE_INVALID");
  }
  if (baseline.phase !== "complete"
    || !Array.isArray(baseline.attempts)
    || baseline.attempts.length !== expectedAttemptCount) {
    throw new Error("EVIDENCE_REPLICATION_BASELINE_INCOMPLETE");
  }
  return { baselineRunId: baseline.runId, configurationFingerprint };
}

export interface ReplicationComparableReport {
  runId: string;
  phase: "complete";
  configurationFingerprint: string;
  configurationFingerprintProvenance: string;
  replicationBaselineRunId: string | null;
  policies: {
    A: { hardDenials: number; warnings: number; wouldIntervene: number; falseWarnings: number };
    B: { hardDenials: number; warnings: number; wouldIntervene: number; falseWarnings: number };
    C: { hardDenials: number; warnings: number; wouldIntervene: number; falseWarnings: number };
  };
  coverage: {
    attempts: number;
    completed: number;
    denied: number;
    withPersistedShadowEvidence: number;
    missingShadowEvidence: string[];
  };
}

export interface ReplicationComparison {
  baselineRunId: string;
  configurationFingerprint: string;
  candidateCount: number;
  runs: Array<{
    runId: string;
    hardDenials: number;
    policyCWarnings: number;
    policyCFalseWarnings: number;
    policyCWouldIntervene: number;
  }>;
  exactOutcomeAgreement: {
    hardDenials: boolean;
    policyCWarnings: boolean;
    policyCFalseWarnings: boolean;
    policyCWouldIntervene: boolean;
  };
}

export function buildReplicationComparison(
  baseline: ReplicationComparableReport,
  candidates: readonly ReplicationComparableReport[],
): ReplicationComparison {
  validateCompleteReplicationReport(baseline);
  if (candidates.length === 0) throw new Error("EVIDENCE_REPLICATION_CANDIDATE_REQUIRED");
  for (const candidate of candidates) {
    if (candidate.configurationFingerprintProvenance !== "pre-run-generated") {
      throw new Error("EVIDENCE_REPLICATION_PROVENANCE_INVALID");
    }
    if (candidate.configurationFingerprint !== baseline.configurationFingerprint) {
      throw new Error("EVIDENCE_REPLICATION_CONFIGURATION_MISMATCH");
    }
    if (candidate.replicationBaselineRunId !== baseline.runId) {
      throw new Error("EVIDENCE_REPLICATION_BASELINE_MISMATCH");
    }
    if (candidate.coverage.attempts !== baseline.coverage.attempts) {
      throw new Error("EVIDENCE_REPLICATION_INCOMPLETE");
    }
    validateCompleteReplicationReport(candidate);
  }
  const runs = [baseline, ...candidates].map((report) => ({
    runId: report.runId,
    hardDenials: report.policies.A.hardDenials,
    policyCWarnings: report.policies.C.warnings,
    policyCFalseWarnings: report.policies.C.falseWarnings,
    policyCWouldIntervene: report.policies.C.wouldIntervene,
  }));
  const exact = (key: keyof Omit<(typeof runs)[number], "runId">): boolean =>
    runs.every((run) => run[key] === runs[0]![key]);
  return {
    baselineRunId: baseline.runId,
    configurationFingerprint: baseline.configurationFingerprint,
    candidateCount: candidates.length,
    runs,
    exactOutcomeAgreement: {
      hardDenials: exact("hardDenials"),
      policyCWarnings: exact("policyCWarnings"),
      policyCFalseWarnings: exact("policyCFalseWarnings"),
      policyCWouldIntervene: exact("policyCWouldIntervene"),
    },
  };
}

function validateCompleteReplicationReport(report: ReplicationComparableReport): void {
  if (report.phase !== "complete"
    || !report.runId.trim()
    || !/^sha256:[a-f0-9]{64}$/.test(report.configurationFingerprint)
    || (report.configurationFingerprintProvenance !== "pre-run-generated"
      && report.configurationFingerprintProvenance !== "post-hoc-db-verified")
    || report.coverage.attempts !== report.coverage.completed + report.coverage.denied
    || report.coverage.withPersistedShadowEvidence !== report.coverage.completed
    || report.coverage.missingShadowEvidence.length > 0) {
    throw new Error("EVIDENCE_REPLICATION_INCOMPLETE");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateEvidenceRunId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(value)) throw new Error("EVIDENCE_RUN_ID_INVALID");
  return value;
}

export function validateFuseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("FUSE_URL_CREDENTIALS_FORBIDDEN");
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("FUSE_URL_INSECURE");
  }
  return url.origin;
}

export function validateFixtureOutcomes(
  calls: readonly FixtureCall[],
  attempts: readonly AttemptManifestEntry[],
): void {
  if (attempts.length !== calls.length) throw new Error("FIXTURE_MANIFEST_MISMATCH");
  const byRequest = new Map(attempts.map((attempt) => [attempt.requestId, attempt]));
  for (const [index, call] of calls.entries()) {
    const attempt = byRequest.get(call.requestId);
    if (!attempt) throw new Error("FIXTURE_ATTEMPT_MISSING");
    if (attempt.runId !== call.runId
      || attempt.fixtureId !== call.fixtureId
      || attempt.sequence !== index + 1
      || attempt.label !== call.label) {
      throw new Error("FIXTURE_MANIFEST_MISMATCH");
    }
    if (call.expected !== "completed-or-denied" && attempt.outcome !== call.expected) {
      throw new Error("FIXTURE_OUTCOME_MISMATCH");
    }
    const expectedDenial = call.fixtureId === 5 ? "WORKLOAD_CLASS_NOT_ALLOWED"
      : call.fixtureId === 9 ? "REQUESTED_MODEL_MISMATCH" : null;
    if (expectedDenial && attempt.denialCode !== expectedDenial) {
      throw new Error("FIXTURE_DENIAL_REASON_MISMATCH");
    }
  }
  const hardBudgetCodes = new Set([
    "BRANCH_BUDGET_EXCEEDED",
    "WORKLOAD_CLASS_BUDGET_EXCEEDED",
    "MANDATE_BUDGET_EXCEEDED",
  ]);
  const hardBudgetAttempts = attempts.filter((attempt) => attempt.fixtureId === 10
    && attempt.outcome === "denied");
  if (hardBudgetAttempts.length === 0) throw new Error("FIXTURE_HARD_BUDGET_DENIAL_MISSING");
  if (hardBudgetAttempts.some((attempt) => attempt.denialCode === undefined
    || !hardBudgetCodes.has(attempt.denialCode))) {
    throw new Error("FIXTURE_DENIAL_REASON_MISMATCH");
  }
}

interface PolicyMetrics {
  hardDenials: number;
  warnings: number;
  wouldIntervene: number;
  falseWarnings: number;
  firstSignalRequestId: string | null;
  spendBeforeFirstSignalAtomic: string | null;
  firstRunawaySignalRequestId: string | null;
  runawaySpendBeforeFirstSignalAtomic: string | null;
  firstSiblingDivergenceRequestId: string | null;
  runawaySpendBeforeSiblingDivergenceAtomic: string | null;
}

export interface ReplayReport {
  phase: "complete";
  policies: { A: PolicyMetrics; B: PolicyMetrics; C: PolicyMetrics };
  coverage: {
    attempts: number;
    completed: number;
    denied: number;
    withPersistedShadowEvidence: number;
    missingShadowEvidence: string[];
  };
  unavailableMetrics: string[];
}

export interface AuthoritativeExecution {
  requestId: string;
  status: string;
  actualCostAtomic: string | null;
}

export interface AuthoritativeValidationSummary {
  executionRows: number;
  preExecutionDenials: string[];
}

export function validateAuthoritativeAttempts(
  attempts: readonly AttemptManifestEntry[],
  executions: readonly AuthoritativeExecution[],
): AuthoritativeValidationSummary {
  const byRequest = new Map(executions.map((execution) => [execution.requestId, execution]));
  const preExecutionDenials: string[] = [];
  for (const attempt of attempts) {
    const execution = byRequest.get(attempt.requestId);
    if (!execution) {
      if (attempt.outcome === "denied" && attempt.denialCode === "REQUESTED_MODEL_MISMATCH"
        && attempt.actualCostAtomic === "0") {
        preExecutionDenials.push(attempt.requestId);
        continue;
      }
      throw new Error("REPLAY_AUTHORITATIVE_EXECUTION_MISSING");
    }
    const authoritativeOutcome = execution.status === "completed" ? "completed"
      : execution.status === "denied" ? "denied" : "error";
    if (attempt.outcome !== authoritativeOutcome) throw new Error("REPLAY_AUTHORITATIVE_OUTCOME_MISMATCH");
    if (attempt.outcome === "completed"
      && execution.actualCostAtomic !== attempt.actualCostAtomic) {
      throw new Error("REPLAY_AUTHORITATIVE_COST_MISMATCH");
    }
  }
  return { executionRows: executions.length, preExecutionDenials };
}

export function buildReplayReport(
  attempts: readonly AttemptManifestEntry[],
  evidence: readonly PersistedShadowEvidence[],
): ReplayReport {
  const requestIds = new Set<string>();
  for (const attempt of attempts) {
    if (requestIds.has(attempt.requestId)) throw new Error("REPLAY_REQUEST_ID_DUPLICATE");
    requestIds.add(attempt.requestId);
    if (!/^\d+$/.test(attempt.actualCostAtomic)) throw new Error("REPLAY_ATOMIC_AMOUNT_INVALID");
    if (!Number.isSafeInteger(attempt.sequence) || attempt.sequence < 1) throw new Error("REPLAY_SEQUENCE_INVALID");
  }
  const evidenceByRequest = new Map<string, PersistedShadowEvidence>();
  for (const item of evidence) {
    if (!requestIds.has(item.requestId)) throw new Error("REPLAY_EVIDENCE_WITHOUT_ATTEMPT");
    if (evidenceByRequest.has(item.requestId)) throw new Error("REPLAY_EVIDENCE_DUPLICATE");
    evidenceByRequest.set(item.requestId, item);
  }
  const sorted = [...attempts].sort((left, right) => left.sequence - right.sequence);
  const base = (): PolicyMetrics => ({
    hardDenials: 0,
    warnings: 0,
    wouldIntervene: 0,
    falseWarnings: 0,
    firstSignalRequestId: null,
    spendBeforeFirstSignalAtomic: null,
    firstRunawaySignalRequestId: null,
    runawaySpendBeforeFirstSignalAtomic: null,
    firstSiblingDivergenceRequestId: null,
    runawaySpendBeforeSiblingDivergenceAtomic: null,
  });
  const policies = { A: base(), B: base(), C: base() };
  const hardDenials = sorted.filter(({ outcome }) => outcome === "denied").length;
  policies.A.hardDenials = hardDenials;
  policies.B.hardDenials = hardDenials;
  policies.C.hardDenials = hardDenials;

  let cumulativeSpend = 0n;
  let runawaySpend = 0n;
  for (const attempt of sorted) {
    const item = evidenceByRequest.get(attempt.requestId);
    const bSignal = item?.signals.includes("CLASS_PRIOR_EXCEEDED") ?? false;
    const cSignal = item?.wouldSignalTarget ?? false;
    for (const [policy, signal] of [[policies.B, bSignal], [policies.C, cSignal]] as const) {
      if (!signal) continue;
      policy.warnings += 1;
      if (attempt.label === "legitimate") policy.falseWarnings += 1;
      if (policy.firstSignalRequestId === null) {
        policy.firstSignalRequestId = attempt.requestId;
        policy.spendBeforeFirstSignalAtomic = cumulativeSpend.toString();
      }
      if (attempt.label === "runaway" && policy.firstRunawaySignalRequestId === null) {
        policy.firstRunawaySignalRequestId = attempt.requestId;
        policy.runawaySpendBeforeFirstSignalAtomic = runawaySpend.toString();
      }
    }
    if (attempt.label === "runaway" && item?.signals.includes("SIBLING_DIVERGENCE")
      && policies.C.firstSiblingDivergenceRequestId === null) {
      policies.C.firstSiblingDivergenceRequestId = attempt.requestId;
      policies.C.runawaySpendBeforeSiblingDivergenceAtomic = runawaySpend.toString();
    }
    if (item?.eligibleForIntervention && item.wouldSignalTarget) policies.C.wouldIntervene += 1;
    if (attempt.outcome === "completed") {
      const cost = BigInt(attempt.actualCostAtomic);
      cumulativeSpend += cost;
      if (attempt.label === "runaway") runawaySpend += cost;
    }
  }

  const completed = sorted.filter(({ outcome }) => outcome === "completed");
  return {
    phase: "complete",
    policies,
    coverage: {
      attempts: sorted.length,
      completed: completed.length,
      denied: hardDenials,
      withPersistedShadowEvidence: evidenceByRequest.size,
      missingShadowEvidence: completed.filter(({ requestId }) => !evidenceByRequest.has(requestId)).map(({ requestId }) => requestId),
    },
    unavailableMetrics: ["operatorRecoveryTime", "actualBehavioralInterventions"],
  };
}
