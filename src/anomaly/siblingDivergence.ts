export interface SiblingDivergenceConfig {
  classPriorWindowSpendAtomic: bigint;
  confidenceConstant: number;
  targetMinimumObservations: number;
  siblingMinimumForScoring: number;
  siblingMinimumForIntervention: number;
  divergenceThresholdBps: number;
}

export interface BranchWindowObservation {
  branchId: string;
  parentBranchId: string;
  workloadClass: string;
  spendAtomic: bigint;
  observationCount: number;
}

export type SiblingDivergenceSignal =
  | "SIBLING_DIVERGENCE"
  | "CLASS_PRIOR_EXCEEDED"
  | "CORRELATED_COHORT_SHIFT";

export interface SiblingDivergenceResult {
  status: "scored" | "insufficient_target_observations" | "insufficient_siblings";
  targetObservationCount: number;
  comparableSiblingCount: number;
  siblingAggregate: "none" | "mean" | "trimmed_mean";
  siblingAggregateAtomic: bigint;
  siblingWeightBps: number;
  effectiveBaselineAtomic: bigint;
  divergenceRatioBps: number;
  targetPriorRatioBps: number;
  cohortPriorRatioBps: number;
  eligibleForIntervention: boolean;
  signals: SiblingDivergenceSignal[];
  wouldEmitAnySignal: boolean;
  wouldSignalTarget: boolean;
  cohortShift: boolean;
  wouldSignal: boolean;
}

const BPS = 10_000n;

export function evaluateSiblingDivergence(
  config: SiblingDivergenceConfig,
  target: BranchWindowObservation,
  candidates: readonly BranchWindowObservation[],
): SiblingDivergenceResult {
  validateConfig(config);
  validateObservation(target);
  const comparable = candidates.filter((candidate) => {
    validateObservation(candidate);
    return candidate.branchId !== target.branchId
      && candidate.parentBranchId === target.parentBranchId
      && candidate.workloadClass === target.workloadClass
      && candidate.observationCount >= config.targetMinimumObservations;
  });
  const base = {
    targetObservationCount: target.observationCount,
    comparableSiblingCount: comparable.length,
    siblingAggregate: "none" as const,
    siblingAggregateAtomic: 0n,
    siblingWeightBps: 0,
    effectiveBaselineAtomic: config.classPriorWindowSpendAtomic,
    divergenceRatioBps: ratioBps(target.spendAtomic, config.classPriorWindowSpendAtomic),
    targetPriorRatioBps: ratioBps(target.spendAtomic, config.classPriorWindowSpendAtomic),
    cohortPriorRatioBps: 0,
    eligibleForIntervention: false,
    signals: [] as SiblingDivergenceSignal[],
    wouldEmitAnySignal: false,
    wouldSignalTarget: false,
    cohortShift: false,
    wouldSignal: false,
  };
  if (target.observationCount < config.targetMinimumObservations) {
    return { status: "insufficient_target_observations", ...base };
  }
  const classPriorExceeded = atOrAboveThreshold(
    target.spendAtomic,
    config.classPriorWindowSpendAtomic,
    config.divergenceThresholdBps,
  );
  if (comparable.length < config.siblingMinimumForScoring) {
    const signals: SiblingDivergenceSignal[] = classPriorExceeded ? ["CLASS_PRIOR_EXCEEDED"] : [];
    return {
      status: "insufficient_siblings",
      ...base,
      signals,
      wouldEmitAnySignal: signals.length > 0,
      wouldSignalTarget: classPriorExceeded,
    };
  }

  const sorted = comparable.map(({ spendAtomic }) => spendAtomic).sort(compareBigint);
  const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
  const siblingSumAtomic = trimmed.reduce((total, value) => total + value, 0n);
  const siblingCount = BigInt(trimmed.length);
  const siblingAggregateAtomic = siblingSumAtomic / siblingCount;
  const comparableCount = BigInt(comparable.length);
  const confidenceConstant = BigInt(config.confidenceConstant);
  const siblingWeightBps = Number(
    comparableCount * BPS / (comparableCount + confidenceConstant),
  );
  const baselineNumerator = comparableCount * siblingSumAtomic
    + confidenceConstant * config.classPriorWindowSpendAtomic * siblingCount;
  const baselineDenominator = (comparableCount + confidenceConstant) * siblingCount;
  const effectiveBaselineAtomic = baselineNumerator / baselineDenominator;
  const divergenceRatioBps = ratioFractionBps(
    target.spendAtomic * baselineDenominator,
    baselineNumerator,
  );
  const targetPriorRatioBps = ratioBps(target.spendAtomic, config.classPriorWindowSpendAtomic);
  const cohortPriorRatioBps = ratioFractionBps(
    siblingSumAtomic,
    config.classPriorWindowSpendAtomic * siblingCount,
  );
  const eligibleForIntervention = comparable.length >= config.siblingMinimumForIntervention;
  const signals: SiblingDivergenceSignal[] = [];
  if (atOrAboveThreshold(
    target.spendAtomic * baselineDenominator,
    baselineNumerator,
    config.divergenceThresholdBps,
  )) signals.push("SIBLING_DIVERGENCE");
  if (classPriorExceeded) signals.push("CLASS_PRIOR_EXCEEDED");
  if (atOrAboveThreshold(
    siblingSumAtomic,
    config.classPriorWindowSpendAtomic * siblingCount,
    config.divergenceThresholdBps,
  )) signals.push("CORRELATED_COHORT_SHIFT");
  const wouldSignalTarget = signals.includes("SIBLING_DIVERGENCE")
    || signals.includes("CLASS_PRIOR_EXCEEDED");
  const cohortShift = signals.includes("CORRELATED_COHORT_SHIFT");

  return {
    status: "scored",
    targetObservationCount: target.observationCount,
    comparableSiblingCount: comparable.length,
    siblingAggregate: sorted.length >= 5 ? "trimmed_mean" : "mean",
    siblingAggregateAtomic,
    siblingWeightBps,
    effectiveBaselineAtomic,
    divergenceRatioBps,
    targetPriorRatioBps,
    cohortPriorRatioBps,
    eligibleForIntervention,
    signals,
    wouldEmitAnySignal: signals.length > 0,
    wouldSignalTarget,
    cohortShift,
    wouldSignal: eligibleForIntervention && wouldSignalTarget,
  };
}

function ratioBps(numerator: bigint, denominator: bigint): number {
  return ratioFractionBps(numerator, denominator);
}

function ratioFractionBps(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new Error("SIBLING_DIVERGENCE_PRIOR_INVALID");
  const ratio = numerator * BPS / denominator;
  return Number(ratio > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : ratio);
}

function atOrAboveThreshold(
  numerator: bigint,
  denominator: bigint,
  thresholdBps: number,
): boolean {
  if (denominator <= 0n) throw new Error("SIBLING_DIVERGENCE_PRIOR_INVALID");
  return numerator * BPS >= BigInt(thresholdBps) * denominator;
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateObservation(observation: BranchWindowObservation): void {
  if (!observation.branchId.trim()) throw new Error("SIBLING_DIVERGENCE_BRANCH_REQUIRED");
  if (!observation.parentBranchId.trim()) throw new Error("SIBLING_DIVERGENCE_PARENT_REQUIRED");
  if (!observation.workloadClass.trim()) throw new Error("SIBLING_DIVERGENCE_CLASS_REQUIRED");
  if (observation.spendAtomic < 0n) throw new Error("SIBLING_DIVERGENCE_SPEND_INVALID");
  if (!Number.isSafeInteger(observation.observationCount) || observation.observationCount < 0) {
    throw new Error("SIBLING_DIVERGENCE_OBSERVATION_COUNT_INVALID");
  }
}

function validateConfig(config: SiblingDivergenceConfig): void {
  if (config.classPriorWindowSpendAtomic <= 0n) throw new Error("SIBLING_DIVERGENCE_PRIOR_INVALID");
  for (const value of [
    config.confidenceConstant,
    config.targetMinimumObservations,
    config.siblingMinimumForScoring,
    config.siblingMinimumForIntervention,
    config.divergenceThresholdBps,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("SIBLING_DIVERGENCE_CONFIG_INVALID");
  }
  if (config.siblingMinimumForIntervention < config.siblingMinimumForScoring) {
    throw new Error("SIBLING_DIVERGENCE_CONFIG_INVALID");
  }
}
