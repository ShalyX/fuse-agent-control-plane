import { createHash } from "node:crypto";
import {
  EVIDENCE_WORKLOAD_MAX_COST_ATOMIC,
  buildFixtureSetupPlan,
  type AttemptManifestEntry,
  type FixtureCall,
  type PersistedShadowEvidence,
  type SetupOperation,
} from "./harness.js";

export const HELD_OUT_PROTOCOL_VERSION = 1 as const;
export const HELD_OUT_DRAND_CHAIN_HASH = "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce";
export const HELD_OUT_DRAND_ROUND = 6311188;
export const HELD_OUT_BEACON_URL = "https://api.drand.sh/public/6311188";

export interface HeldOutBeacon {
  round: number;
  randomness: string;
  signature: string;
}

export type HeldOutScenarioType =
  | "runaway-target"
  | "legitimate-unusual-target"
  | "legitimate-correlated-shift"
  | "legitimate-sparse-target";

export interface HeldOutCohort {
  cohortId: string;
  fanOut: 2 | 3 | 4;
  scenarioType: HeldOutScenarioType;
  groundTruth: "runaway" | "legitimate";
  workloadClass: "baseline-lookup" | "spike-burst";
  targetBranchId: string;
  siblingBranchIds: string[];
}

export interface HeldOutCallSpec {
  sequence: number;
  cohortId: string;
  branchId: string;
  role: "target" | "sibling";
  phase: "warmup" | "burst" | "shift" | "sparse";
  label: "legitimate" | "runaway";
  expected: "completed";
  workloadClass: "baseline-lookup" | "spike-burst";
  model: string;
  contextUnits: number;
  maxOutputTokens: 8;
}

export interface HeldOutPlan {
  schemaVersion: 1;
  evidenceType: "held-out";
  protocolVersion: 1;
  provider: "anthropic" | "openrouter";
  model: string;
  beacon: HeldOutBeacon & { chainHash: string };
  cohorts: HeldOutCohort[];
  calls: HeldOutCallSpec[];
  planFingerprint: string;
}

function generateHeldOutPlan(
  beacon: HeldOutBeacon,
  provider: "anthropic" | "openrouter",
  model: string,
): HeldOutPlan {
  validateBeacon(beacon);
  if (!model.trim()) throw new Error("HELD_OUT_MODEL_INVALID");
  const random = new HashWordStream(beacon.randomness);
  const cohorts: HeldOutCohort[] = [];
  const calls: HeldOutCallSpec[] = [];
  let sequence = 1;

  const addCall = (
    cohort: HeldOutCohort,
    branchId: string,
    role: HeldOutCallSpec["role"],
    phase: HeldOutCallSpec["phase"],
    label: HeldOutCallSpec["label"],
    minContext: number,
    maxContext: number,
  ): void => {
    calls.push({
      sequence: sequence++,
      cohortId: cohort.cohortId,
      branchId,
      role,
      phase,
      label,
      expected: "completed",
      workloadClass: cohort.workloadClass,
      model,
      contextUnits: random.integer(minContext, maxContext),
      maxOutputTokens: 8,
    });
  };

  const cohortOrdinals = new Map<number, number>();
  const makeCohort = (
    fanOut: 2 | 3 | 4,
    scenarioType: HeldOutScenarioType,
  ): HeldOutCohort => {
    const ordinal = (cohortOrdinals.get(fanOut) ?? 0) + 1;
    cohortOrdinals.set(fanOut, ordinal);
    const cohortId = `ho-f${fanOut}-c${ordinal}`;
    const cohort: HeldOutCohort = {
      cohortId,
      fanOut,
      scenarioType,
      groundTruth: scenarioType === "runaway-target" ? "runaway" : "legitimate",
      workloadClass: random.integer(0, 1) === 0 ? "baseline-lookup" : "spike-burst",
      targetBranchId: `${cohortId}-target`,
      siblingBranchIds: Array.from({ length: fanOut - 1 }, (_, index) => `${cohortId}-sibling-${index + 1}`),
    };
    cohorts.push(cohort);
    return cohort;
  };

  for (const fanOut of [2, 3, 4] as const) {
    for (let remaining = 3; remaining > 0; remaining--) {
      const cohort = makeCohort(fanOut, "runaway-target");
      for (const sibling of cohort.siblingBranchIds) {
        for (let observation = 0; observation < 3; observation++) {
          addCall(cohort, sibling, "sibling", "warmup", "legitimate", 30, 120);
        }
      }
      for (let observation = 0; observation < 3; observation++) {
        addCall(cohort, cohort.targetBranchId, "target", "warmup", "legitimate", 30, 120);
      }
      const burstLength = random.integer(4, 6);
      for (let observation = 0; observation < burstLength; observation++) {
        addCall(cohort, cohort.targetBranchId, "target", "burst", "runaway", 450, 850);
      }
    }

    {
      const cohort = makeCohort(fanOut, "legitimate-unusual-target");
      for (const sibling of cohort.siblingBranchIds) {
        for (let observation = 0; observation < 3; observation++) {
          addCall(cohort, sibling, "sibling", "warmup", "legitimate", 30, 120);
        }
      }
      for (let observation = 0; observation < 3; observation++) {
        addCall(cohort, cohort.targetBranchId, "target", "warmup", "legitimate", 30, 120);
      }
      for (let observation = 0; observation < 2; observation++) {
        addCall(cohort, cohort.targetBranchId, "target", "burst", "legitimate", 300, 650);
      }
    }

    {
      const cohort = makeCohort(fanOut, "legitimate-correlated-shift");
      const branches = [cohort.targetBranchId, ...cohort.siblingBranchIds];
      for (let observation = 0; observation < 3; observation++) {
        for (const [index, branchId] of branches.entries()) {
          addCall(cohort, branchId, index === 0 ? "target" : "sibling", "warmup", "legitimate", 30, 120);
        }
      }
      for (let observation = 0; observation < 2; observation++) {
        for (const [index, branchId] of branches.entries()) {
          addCall(cohort, branchId, index === 0 ? "target" : "sibling", "shift", "legitimate", 300, 600);
        }
      }
    }

    {
      const cohort = makeCohort(fanOut, "legitimate-sparse-target");
      for (const sibling of cohort.siblingBranchIds) {
        for (let observation = 0; observation < 3; observation++) {
          addCall(cohort, sibling, "sibling", "warmup", "legitimate", 30, 120);
        }
      }
      for (let observation = 0; observation < 2; observation++) {
        addCall(cohort, cohort.targetBranchId, "target", "sparse", "legitimate", 200, 450);
      }
    }
  }

  const payload = {
    schemaVersion: 1 as const,
    evidenceType: "held-out" as const,
    protocolVersion: HELD_OUT_PROTOCOL_VERSION,
    provider,
    model,
    beacon: { ...beacon, chainHash: HELD_OUT_DRAND_CHAIN_HASH },
    cohorts,
    calls,
  };
  const plan: HeldOutPlan = { ...payload, planFingerprint: fingerprint(payload) };
  return plan;
}

export function buildHeldOutPlan(
  beacon: HeldOutBeacon,
  provider: "anthropic" | "openrouter",
  model: string,
): HeldOutPlan {
  const plan = generateHeldOutPlan(beacon, provider, model);
  validateHeldOutPlan(plan);
  return plan;
}

export function buildHeldOutCallPlan(plan: HeldOutPlan, runId: string): FixtureCall[] {
  validateHeldOutPlan(plan);
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(runId)) throw new Error("EVIDENCE_RUN_ID_INVALID");
  const cohortNumbers = new Map(plan.cohorts.map((cohort, index) => [cohort.cohortId, index + 1]));
  return plan.calls.map((call) => ({
    runId,
    fixtureId: cohortNumbers.get(call.cohortId)!,
    mandateId: `heldout-${runId}`,
    requestId: `${runId}-ho-${call.sequence}`,
    branchId: call.branchId,
    workloadClass: call.workloadClass,
    model: call.model,
    contextUnits: call.contextUnits,
    maxOutputTokens: call.maxOutputTokens,
    label: call.label,
    expected: call.expected,
  }));
}

export function buildHeldOutSetupPlan(plan: HeldOutPlan, runId: string): SetupOperation[] {
  validateHeldOutPlan(plan);
  const mandateId = `heldout-${runId}`;
  const policyId = `heldout-policy-${runId}`;
  const agentId = `heldout-agent-${runId}`;
  const base = buildFixtureSetupPlan({ runId, provider: plan.provider, model: plan.model,
    mandateId, policyId, agentId });
  const totalEnvelope = plan.calls.reduce((total, call) => {
    const maximum = EVIDENCE_WORKLOAD_MAX_COST_ATOMIC[call.workloadClass];
    if (maximum === undefined) throw new Error("EVIDENCE_WORKLOAD_COST_CAP_MISSING");
    return total + maximum;
  }, 0n);
  const aggregateAuthority = (totalEnvelope + 1n).toString();
  const setup = base.filter(({ kind }) => kind !== "branch" && kind !== "activation").map((operation) => {
    if (operation.kind === "policy") {
      const limits = operation.body["limits"] as Record<string, unknown>;
      const workloadClasses = operation.body["workloadClasses"] as Array<Record<string, unknown>>;
      return {
        ...operation,
        body: {
          ...operation.body,
          limits: { ...limits, maxHourlyAtomic: aggregateAuthority, maxDailyAtomic: aggregateAuthority },
          workloadClasses: workloadClasses.map((workload) => ({
            ...workload,
            aggregateBudgetAtomic: aggregateAuthority,
          })),
        },
      };
    }
    if (operation.kind === "mandate") {
      return { ...operation, body: { ...operation.body, maximumSpendAtomic: aggregateAuthority } };
    }
    return operation;
  });
  const branchOperations: SetupOperation[] = [];
  for (const cohort of plan.cohorts) {
    const childBranches = [cohort.targetBranchId, ...cohort.siblingBranchIds];
    const childEnvelopes = childBranches.map((branchId) => {
      const calls = plan.calls.filter((call) => call.cohortId === cohort.cohortId && call.branchId === branchId);
      const maximum = EVIDENCE_WORKLOAD_MAX_COST_ATOMIC[cohort.workloadClass];
      if (maximum === undefined || calls.length === 0) throw new Error("HELD_OUT_PLAN_INVALID");
      return { branchId, envelope: maximum * BigInt(calls.length) + 1n };
    });
    const rootBranchId = `${cohort.cohortId}-root`;
    branchOperations.push({
      kind: "branch",
      method: "POST",
      path: `/api/v1/admin/mandates/${encodeURIComponent(mandateId)}/branches`,
      body: {
        branchId: rootBranchId,
        parentBranchId: null,
        agentId,
        allowedWorkloadClasses: [cohort.workloadClass],
        maximumSpendAtomic: childEnvelopes.reduce((total, child) => total + child.envelope, 0n).toString(),
        expiresAt: null,
      },
    });
    for (const child of childEnvelopes) {
      branchOperations.push({
        kind: "branch",
        method: "POST",
        path: `/api/v1/admin/mandates/${encodeURIComponent(mandateId)}/branches`,
        body: {
          branchId: child.branchId,
          parentBranchId: rootBranchId,
          agentId,
          allowedWorkloadClasses: [cohort.workloadClass],
          maximumSpendAtomic: child.envelope.toString(),
          expiresAt: null,
        },
      });
    }
  }
  return [
    ...setup,
    ...branchOperations,
    { kind: "activation", method: "POST",
      path: `/api/v1/admin/mandates/${encodeURIComponent(mandateId)}/transitions`, body: { to: "active" } },
  ];
}

export function buildHeldOutConfigurationFingerprint(plan: HeldOutPlan): string {
  validateHeldOutPlan(plan);
  const sentinelRunId = "held-out-configuration";
  return fingerprint({
    evidenceType: "held-out",
    protocolVersion: HELD_OUT_PROTOCOL_VERSION,
    planFingerprint: plan.planFingerprint,
    setup: buildHeldOutSetupPlan(plan, sentinelRunId),
    calls: buildHeldOutCallPlan(plan, sentinelRunId),
  });
}

export interface HeldOutReplaySummary {
  unitOfAnalysis: "cohort";
  runawayCohorts: 9;
  detectedRunawayCohorts: number;
  legitimateCohorts: 9;
  falseInterventionCohorts: number;
  byFanOut: Record<"2" | "3" | "4", { runaway: number; detected: number; legitimate: number; falseInterventions: number }>;
  byScenario: Record<Exclude<HeldOutScenarioType, "runaway-target">,
    { cohorts: number; falseInterventions: number }>;
  coverage: { attempts: number; persistedShadowEvidence: number };
  secondary: {
    runawaySpendThroughFirstDetectionAtomic: Array<{ cohortId: string; detected: boolean; spendAtomic: string }>;
    classPriorWarningCohortsByLabel: { runaway: number; legitimate: number };
    selectiveConversionCohortsByLabel: { runaway: number; legitimate: number };
    correlatedShift: { cohortsWithSignal: number; eligibleCohorts: number };
  };
  wilson95: {
    runawayDetection: { lower: number; upper: number };
    legitimateFalseIntervention: { lower: number; upper: number };
  };
  gate: { passed: boolean; reasons: string[] };
}

export function buildHeldOutReplaySummary(
  plan: HeldOutPlan,
  attempts: readonly AttemptManifestEntry[],
  evidence: readonly PersistedShadowEvidence[],
): HeldOutReplaySummary {
  validateHeldOutPlan(plan);
  if (attempts.length !== plan.calls.length || attempts.some((attempt) => attempt.outcome !== "completed")) {
    throw new Error("HELD_OUT_RUN_INCOMPLETE");
  }
  const evidenceByRequest = new Map(evidence.map((item) => [item.requestId, item]));
  const runId = attempts[0]?.runId;
  if (!runId) throw new Error("HELD_OUT_RUN_INCOMPLETE");
  const runtimeCalls = buildHeldOutCallPlan(plan, runId);
  const evidenceBySequence = new Map<number, PersistedShadowEvidence>();
  for (const [index, attempt] of attempts.entries()) {
    const expected = runtimeCalls[index]!;
    if (attempt.sequence !== index + 1 || attempt.requestId !== expected.requestId
      || attempt.label !== expected.label || attempt.fixtureId !== expected.fixtureId) {
      throw new Error("HELD_OUT_MANIFEST_MISMATCH");
    }
    const persisted = evidenceByRequest.get(attempt.requestId);
    if (!persisted) throw new Error("HELD_OUT_SHADOW_EVIDENCE_MISSING");
    evidenceBySequence.set(index + 1, persisted);
  }
  if (evidence.length !== attempts.length || evidenceByRequest.size !== evidence.length) {
    throw new Error("HELD_OUT_SHADOW_EVIDENCE_COVERAGE_INVALID");
  }
  const byFanOut: HeldOutReplaySummary["byFanOut"] = {
    "2": { runaway: 0, detected: 0, legitimate: 0, falseInterventions: 0 },
    "3": { runaway: 0, detected: 0, legitimate: 0, falseInterventions: 0 },
    "4": { runaway: 0, detected: 0, legitimate: 0, falseInterventions: 0 },
  };
  const byScenario: HeldOutReplaySummary["byScenario"] = {
    "legitimate-unusual-target": { cohorts: 0, falseInterventions: 0 },
    "legitimate-correlated-shift": { cohorts: 0, falseInterventions: 0 },
    "legitimate-sparse-target": { cohorts: 0, falseInterventions: 0 },
  };
  const runawaySpendThroughFirstDetectionAtomic: HeldOutReplaySummary["secondary"]["runawaySpendThroughFirstDetectionAtomic"] = [];
  let classPriorRunaway = 0;
  let classPriorLegitimate = 0;
  let selectiveRunaway = 0;
  let selectiveLegitimate = 0;
  let correlatedWithSignal = 0;
  let correlatedEligible = 0;
  let detectedRunawayCohorts = 0;
  let falseInterventionCohorts = 0;
  for (const cohort of plan.cohorts) {
    const key = String(cohort.fanOut) as keyof typeof byFanOut;
    const cohortCalls = plan.calls.filter((call) => call.cohortId === cohort.cohortId);
    const detectedCall = cohort.groundTruth === "runaway" ? cohortCalls.find((call) => {
      const persisted = evidenceBySequence.get(call.sequence)!;
      return call.label === "runaway" && persisted.eligibleForIntervention
        && persisted.signals.includes("SIBLING_DIVERGENCE");
    }) : undefined;
    const detected = detectedCall !== undefined;
    const falseIntervention = cohort.groundTruth === "legitimate" && cohortCalls.some((call) => {
      const persisted = evidenceBySequence.get(call.sequence)!;
      return persisted.eligibleForIntervention && persisted.wouldSignalTarget;
    });
    const classPriorOnRunaway = cohortCalls.some((call) => call.label === "runaway"
      && evidenceBySequence.get(call.sequence)!.signals.includes("CLASS_PRIOR_EXCEEDED"));
    const classPriorOnLegitimate = cohortCalls.some((call) => call.label === "legitimate"
      && evidenceBySequence.get(call.sequence)!.signals.includes("CLASS_PRIOR_EXCEEDED"));
    if (classPriorOnRunaway) classPriorRunaway++;
    if (classPriorOnLegitimate) classPriorLegitimate++;
    if (classPriorOnRunaway && detected) selectiveRunaway++;
    if (classPriorOnLegitimate && falseIntervention) selectiveLegitimate++;
    if (cohort.groundTruth === "runaway") {
      const spendThrough = cohortCalls
        .filter((call) => call.branchId === cohort.targetBranchId
          && (!detectedCall || call.sequence <= detectedCall.sequence))
        .reduce((total, call) => total + BigInt(attempts[call.sequence - 1]!.actualCostAtomic), 0n);
      runawaySpendThroughFirstDetectionAtomic.push({
        cohortId: cohort.cohortId,
        detected,
        spendAtomic: spendThrough.toString(),
      });
      byFanOut[key].runaway++;
      if (detected) {
        detectedRunawayCohorts++;
        byFanOut[key].detected++;
      }
    } else {
      const scenario = byScenario[cohort.scenarioType as keyof typeof byScenario];
      scenario.cohorts++;

      if (cohort.scenarioType === "legitimate-correlated-shift") {
        const hasCorrelatedSignal = cohortCalls.some((call) =>
          evidenceBySequence.get(call.sequence)!.signals.includes("CORRELATED_COHORT_SHIFT"));
        if (hasCorrelatedSignal) correlatedWithSignal++;
        if (falseIntervention) correlatedEligible++;
      }
      byFanOut[key].legitimate++;
      if (falseIntervention) {
        falseInterventionCohorts++;
        byFanOut[key].falseInterventions++;
        scenario.falseInterventions++;
      }
    }
  }
  const reasons: string[] = [];
  if (detectedRunawayCohorts < 7) reasons.push("RUNAWAY_DETECTION_BELOW_7_OF_9");
  for (const fanOut of ["2", "3", "4"] as const) {
    if (byFanOut[fanOut].detected < 2) reasons.push(`FANOUT_${fanOut}_DETECTION_BELOW_2_OF_3`);
  }
  if (falseInterventionCohorts > 0) reasons.push("LEGITIMATE_FALSE_INTERVENTION");
  return {
    unitOfAnalysis: "cohort",
    runawayCohorts: 9,
    detectedRunawayCohorts,
    legitimateCohorts: 9,
    falseInterventionCohorts,
    byFanOut,
    byScenario,
    coverage: { attempts: attempts.length, persistedShadowEvidence: evidenceBySequence.size },
    secondary: {
      runawaySpendThroughFirstDetectionAtomic,
      classPriorWarningCohortsByLabel: { runaway: classPriorRunaway, legitimate: classPriorLegitimate },
      selectiveConversionCohortsByLabel: { runaway: selectiveRunaway, legitimate: selectiveLegitimate },
      correlatedShift: { cohortsWithSignal: correlatedWithSignal, eligibleCohorts: correlatedEligible },
    },
    wilson95: {
      runawayDetection: wilson95(detectedRunawayCohorts, 9),
      legitimateFalseIntervention: wilson95(falseInterventionCohorts, 9),
    },
    gate: { passed: reasons.length === 0, reasons },
  };
}

function wilson95(successes: number, total: number): { lower: number; upper: number } {
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) / total)
    + (z * z) / (4 * total * total)) / denominator;
  return {
    lower: successes === 0 ? 0 : Math.max(0, center - margin),
    upper: successes === total ? 1 : Math.min(1, center + margin),
  };
}

export function validateHeldOutPlan(plan: HeldOutPlan): void {
  if (plan.schemaVersion !== 1 || plan.evidenceType !== "held-out"
    || plan.protocolVersion !== HELD_OUT_PROTOCOL_VERSION
    || (plan.provider !== "anthropic" && plan.provider !== "openrouter")
    || !plan.model?.trim() || plan.beacon.chainHash !== HELD_OUT_DRAND_CHAIN_HASH) {
    throw new Error("HELD_OUT_PLAN_INVALID");
  }
  validateBeacon(plan.beacon);
  if (!Array.isArray(plan.cohorts) || plan.cohorts.length !== 18 || !Array.isArray(plan.calls)) {
    throw new Error("HELD_OUT_PLAN_INVALID");
  }
  const cohorts = new Map(plan.cohorts.map((cohort) => [cohort.cohortId, cohort]));
  if (cohorts.size !== plan.cohorts.length) throw new Error("HELD_OUT_PLAN_INVALID");
  for (const [index, call] of plan.calls.entries()) {
    const cohort = cohorts.get(call.cohortId);
    if (!cohort || call.sequence !== index + 1 || call.model !== plan.model
      || call.workloadClass !== cohort.workloadClass || call.expected !== "completed"
      || !Number.isSafeInteger(call.contextUnits) || call.contextUnits < 1
      || call.maxOutputTokens !== 8) {
      throw new Error("HELD_OUT_PLAN_INVALID");
    }
    const branchIds = new Set([cohort.targetBranchId, ...cohort.siblingBranchIds]);
    if (!branchIds.has(call.branchId)) throw new Error("HELD_OUT_PLAN_INVALID");
    if (cohort.groundTruth === "legitimate" && call.label !== "legitimate") {
      throw new Error("HELD_OUT_PLAN_LABEL_INVALID");
    }
    if (call.label === "runaway"
      && (cohort.groundTruth !== "runaway" || call.role !== "target" || call.phase !== "burst")) {
      throw new Error("HELD_OUT_PLAN_LABEL_INVALID");
    }
  }
  for (const cohort of plan.cohorts) {
    const cohortCalls = plan.calls.filter((call) => call.cohortId === cohort.cohortId);
    const runawayCalls = cohortCalls.filter((call) => call.label === "runaway");
    if (cohort.groundTruth === "runaway" && runawayCalls.length < 4) {
      throw new Error("HELD_OUT_PLAN_LABEL_INVALID");
    }
    if (cohort.groundTruth === "legitimate" && runawayCalls.length !== 0) {
      throw new Error("HELD_OUT_PLAN_LABEL_INVALID");
    }
  }
  const { planFingerprint: ignored, ...payload } = plan;
  void ignored;
  if (plan.planFingerprint !== fingerprint(payload)) {
    throw new Error("HELD_OUT_PLAN_FINGERPRINT_MISMATCH");
  }
  const expected = generateHeldOutPlan(plan.beacon, plan.provider, plan.model);
  if (canonicalJson(plan) !== canonicalJson(expected)) {
    throw new Error("HELD_OUT_PLAN_RECIPE_MISMATCH");
  }
}

export function parseHeldOutBeaconResponse(value: unknown): HeldOutBeacon {
  if (!value || typeof value !== "object") throw new Error("HELD_OUT_BEACON_INVALID");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["round"] !== "number"
    || typeof candidate["randomness"] !== "string"
    || typeof candidate["signature"] !== "string") {
    throw new Error("HELD_OUT_BEACON_INVALID");
  }
  const beacon: HeldOutBeacon = {
    round: candidate["round"],
    randomness: candidate["randomness"],
    signature: candidate["signature"],
  };
  validateBeacon(beacon);
  return beacon;
}

function validateBeacon(beacon: HeldOutBeacon): void {
  const signatureValid = /^[a-f0-9]{192}$/.test(beacon.signature);
  const expectedRandomness = signatureValid
    ? createHash("sha256").update(Buffer.from(beacon.signature, "hex")).digest("hex")
    : "";
  if (beacon.round !== HELD_OUT_DRAND_ROUND
    || !/^[a-f0-9]{64}$/.test(beacon.randomness)
    || !signatureValid
    || beacon.randomness !== expectedRandomness) {
    throw new Error("HELD_OUT_BEACON_INVALID");
  }
}

class HashWordStream {
  private blockIndex = 0;
  private words: number[] = [];

  constructor(private readonly randomness: string) {}

  integer(minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
      throw new Error("HELD_OUT_RANDOM_RANGE_INVALID");
    }
    if (this.words.length === 0) this.refill();
    const word = this.words.shift()!;
    return minimum + (word % (maximum - minimum + 1));
  }

  private refill(): void {
    const index = Buffer.alloc(4);
    index.writeUInt32BE(this.blockIndex++);
    const digest = createHash("sha256")
      .update("fuse-held-out-v1")
      .update(Buffer.from(this.randomness, "hex"))
      .update(index)
      .digest();
    this.words = Array.from({ length: 8 }, (_, offset) => digest.readUInt32BE(offset * 4));
  }
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
