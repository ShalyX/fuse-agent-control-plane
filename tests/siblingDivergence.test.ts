import { describe, expect, it } from "vitest";
import { evaluateSiblingDivergence } from "../src/anomaly/siblingDivergence.js";

const config = {
  classPriorWindowSpendAtomic: 100n,
  confidenceConstant: 5,
  targetMinimumObservations: 3,
  siblingMinimumForScoring: 2,
  siblingMinimumForIntervention: 3,
  divergenceThresholdBps: 30_000,
};

const branch = (
  branchId: string,
  spendAtomic: bigint,
  observationCount = 3,
  overrides: Partial<{
    parentBranchId: string;
    workloadClass: string;
  }> = {},
) => ({
  branchId,
  parentBranchId: "root",
  workloadClass: "lookup",
  spendAtomic,
  observationCount,
  ...overrides,
});

describe("sibling divergence shadow evaluator", () => {
  it("scores two comparable siblings with a small-n mean but never marks them intervention-eligible", () => {
    const result = evaluateSiblingDivergence(
      config,
      branch("target", 400n),
      [branch("sibling-a", 100n), branch("sibling-b", 300n)],
    );

    expect(result).toMatchObject({
      status: "scored",
      comparableSiblingCount: 2,
      siblingAggregate: "mean",
      siblingAggregateAtomic: 200n,
      siblingWeightBps: 2_857,
      effectiveBaselineAtomic: 128n,
      divergenceRatioBps: 31_111,
      eligibleForIntervention: false,
      wouldSignal: false,
    });
  });

  it("keeps target observation confidence separate from sibling availability", () => {
    const result = evaluateSiblingDivergence(
      config,
      branch("target", 1_000n, 2),
      [branch("a", 100n), branch("b", 100n), branch("c", 100n)],
    );

    expect(result).toEqual(expect.objectContaining({
      status: "insufficient_target_observations",
      targetObservationCount: 2,
      comparableSiblingCount: 3,
      wouldSignal: false,
    }));
  });

  it("uses all three sibling values instead of a lossy median", () => {
    const result = evaluateSiblingDivergence(
      config,
      branch("target", 500n),
      [branch("a", 100n), branch("b", 200n), branch("c", 900n)],
    );

    expect(result).toMatchObject({
      status: "scored",
      siblingAggregate: "mean",
      siblingAggregateAtomic: 400n,
      siblingWeightBps: 3_750,
      effectiveBaselineAtomic: 212n,
      eligibleForIntervention: true,
    });
  });

  it("documents arithmetic-mean behavior for adversarial n=4 cohorts", () => {
    const oneExtreme = evaluateSiblingDivergence(config, branch("target", 1_000n), [
      branch("a", 100n), branch("b", 100n), branch("c", 100n), branch("d", 10_000n),
    ]);
    expect(oneExtreme).toMatchObject({
      siblingAggregate: "mean", siblingAggregateAtomic: 2_575n,
      effectiveBaselineAtomic: 1_200n,
      signals: ["CLASS_PRIOR_EXCEEDED", "CORRELATED_COHORT_SHIFT"],
    });
    expect(oneExtreme.signals).not.toContain("SIBLING_DIVERGENCE");

    const twoUnusual = evaluateSiblingDivergence(config, branch("target", 1_000n), [
      branch("a", 100n), branch("b", 100n), branch("c", 1_000n), branch("d", 1_000n),
    ]);
    expect(twoUnusual).toMatchObject({
      siblingAggregateAtomic: 550n, effectiveBaselineAtomic: 300n,
      signals: ["SIBLING_DIVERGENCE", "CLASS_PRIOR_EXCEEDED", "CORRELATED_COHORT_SHIFT"],
    });
  });

  it("uses a one-point trimmed mean once five comparable siblings exist", () => {
    const result = evaluateSiblingDivergence(
      config,
      branch("target", 800n),
      [
        branch("a", 1n), branch("b", 100n), branch("c", 200n),
        branch("d", 300n), branch("e", 10_000n),
      ],
    );

    expect(result).toMatchObject({
      siblingAggregate: "trimmed_mean",
      siblingAggregateAtomic: 200n,
      siblingWeightBps: 5_000,
      effectiveBaselineAtomic: 150n,
    });
  });

  it("retains a class-prior cohort signal when every sibling shifts together", () => {
    const result = evaluateSiblingDivergence(
      config,
      branch("target", 1_000n),
      [branch("a", 1_000n), branch("b", 1_000n), branch("c", 1_000n)],
    );

    expect(result).toMatchObject({
      divergenceRatioBps: 22_857,
      cohortPriorRatioBps: 100_000,
      signals: ["CLASS_PRIOR_EXCEEDED", "CORRELATED_COHORT_SHIFT"],
      wouldSignal: true,
    });
  });

  it("does not label a healthy target as a target signal for a cohort-only shift", () => {
    const result = evaluateSiblingDivergence(
      config,
      branch("target", 100n),
      [branch("a", 1_000n), branch("b", 1_000n), branch("c", 1_000n)],
    );
    expect(result).toMatchObject({
      signals: ["CORRELATED_COHORT_SHIFT"], wouldEmitAnySignal: true,
      wouldSignalTarget: false, cohortShift: true, wouldSignal: false,
    });
  });

  it("emits the independent class-prior signal even without enough siblings", () => {
    const result = evaluateSiblingDivergence(config, branch("target", 400n), [branch("a", 100n)]);
    expect(result).toMatchObject({
      status: "insufficient_siblings", signals: ["CLASS_PRIOR_EXCEEDED"],
      wouldSignalTarget: true, eligibleForIntervention: false, wouldSignal: false,
    });
  });

  it("uses exact rational comparison instead of a floored blended baseline", () => {
    const result = evaluateSiblingDivergence(
      { ...config, siblingMinimumForScoring: 1, siblingMinimumForIntervention: 1 },
      branch("target", 301n),
      [branch("sibling-a", 103n)],
    );

    expect(result.effectiveBaselineAtomic).toBe(100n);
    expect(result.divergenceRatioBps).toBe(29_950);
    expect(result.signals).not.toContain("SIBLING_DIVERGENCE");
    expect(result.signals).toContain("CLASS_PRIOR_EXCEEDED");
  });

  it("filters different parents, classes, under-observed siblings, and the target itself", () => {
    const result = evaluateSiblingDivergence(
      config,
      branch("target", 500n),
      [
        branch("target", 500n),
        branch("good-a", 100n),
        branch("good-b", 100n),
        branch("other-parent", 100n, 3, { parentBranchId: "other" }),
        branch("other-class", 100n, 3, { workloadClass: "summary" }),
        branch("too-new", 100n, 2),
      ],
    );

    expect(result).toMatchObject({ comparableSiblingCount: 2, siblingAggregateAtomic: 100n });
  });
});
