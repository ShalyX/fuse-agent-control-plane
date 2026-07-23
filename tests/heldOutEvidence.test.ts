import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildHeldOutCallPlan,
  buildHeldOutConfigurationFingerprint,
  buildHeldOutPlan,
  buildHeldOutReplaySummary,
  buildHeldOutSetupPlan,
  parseHeldOutBeaconResponse,
  validateHeldOutPlan,
  type HeldOutPlan,
} from "../src/evidence/heldOut.js";
import {
  validateEvidenceCallOutcomes,
  type AttemptManifestEntry,
  type PersistedShadowEvidence,
} from "../src/evidence/harness.js";
import { writeOnceJsonPair } from "../src/evidence/writeOnce.js";
import { assertArtifactCommittedAtHead } from "../src/evidence/committedArtifact.js";
import { evaluateSiblingDivergence } from "../src/anomaly/siblingDivergence.js";

const execFileAsync = promisify(execFile);

const signature = "22".repeat(96);
const beacon = {
  round: 6311188,
  randomness: createHash("sha256").update(Buffer.from(signature, "hex")).digest("hex"),
  signature,
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function refingerprint(plan: HeldOutPlan): HeldOutPlan {
  const { planFingerprint: ignored, ...payload } = plan;
  void ignored;
  return {
    ...plan,
    planFingerprint: `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`,
  };
}

describe("held-out evidence plan", () => {
  it("builds the preregistered balanced cohort allocation deterministically", () => {
    const first = buildHeldOutPlan(beacon, "openrouter", "nousresearch/hermes-4-405b");
    const second = buildHeldOutPlan(beacon, "openrouter", "nousresearch/hermes-4-405b");

    expect(first).toEqual(second);
    expect(first.evidenceType).toBe("held-out");
    expect(first.protocolVersion).toBe(1);
    expect(first.beacon.round).toBe(6311188);
    expect(first.cohorts).toHaveLength(18);
    expect(first.cohorts.every(({ cohortId, targetBranchId, siblingBranchIds }) =>
      !/(runaway|legitimate|unusual|shift|sparse)/.test([cohortId, targetBranchId, ...siblingBranchIds].join("-"))))
      .toBe(true);
    expect(first.cohorts.filter(({ groundTruth }) => groundTruth === "runaway")).toHaveLength(9);
    expect(first.cohorts.filter(({ groundTruth }) => groundTruth === "legitimate")).toHaveLength(9);
    for (const fanOut of [2, 3, 4]) {
      const cohorts = first.cohorts.filter((cohort) => cohort.fanOut === fanOut);
      expect(cohorts).toHaveLength(6);
      expect(cohorts.filter(({ groundTruth }) => groundTruth === "runaway")).toHaveLength(3);
      expect(cohorts.filter(({ groundTruth }) => groundTruth === "legitimate")).toHaveLength(3);
    }
    expect(first.calls.length).toBeGreaterThanOrEqual(219);
    expect(first.calls.length).toBeLessThanOrEqual(237);
    expect(first.calls.every(({ expected }) => expected === "completed")).toBe(true);
    expect(first.planFingerprint).toBe("sha256:f2c445409e139543062e5b70e79048b15c22ebac0c88cebc1dd7c0615fa7bcd6");
    const independentlyHashedPayload = (({ planFingerprint: _ignored, ...payload }) => payload)(first);
    expect(`sha256:${createHash("sha256").update(canonicalJson(independentlyHashedPayload)).digest("hex")}`)
      .toBe(first.planFingerprint);
    expect(() => validateHeldOutPlan(first)).not.toThrow();
  });

  it("rejects beacon drift, plan tampering, and labels that disagree with cohort truth", () => {
    expect(parseHeldOutBeaconResponse({ ...beacon, previous_signature: signature })).toEqual(beacon);
    expect(() => parseHeldOutBeaconResponse({ ...beacon, round: String(beacon.round) }))
      .toThrow("HELD_OUT_BEACON_INVALID");
    expect(() => buildHeldOutPlan({ ...beacon, round: 6311187 }, "openrouter", "nousresearch/hermes-4-405b"))
      .toThrow("HELD_OUT_BEACON_INVALID");
    expect(() => buildHeldOutPlan({ ...beacon, randomness: "bad" }, "openrouter", "nousresearch/hermes-4-405b"))
      .toThrow("HELD_OUT_BEACON_INVALID");
    expect(() => buildHeldOutPlan({ ...beacon, randomness: "33".repeat(32) }, "openrouter", "nousresearch/hermes-4-405b"))
      .toThrow("HELD_OUT_BEACON_INVALID");

    const plan = buildHeldOutPlan(beacon, "openrouter", "nousresearch/hermes-4-405b");
    const tampered: HeldOutPlan = {
      ...plan,
      calls: plan.calls.map((call, index) => index === 0 ? { ...call, contextUnits: call.contextUnits + 1 } : call),
    };
    expect(() => validateHeldOutPlan(tampered)).toThrow("HELD_OUT_PLAN_FINGERPRINT_MISMATCH");
    expect(() => validateHeldOutPlan(refingerprint(tampered))).toThrow("HELD_OUT_PLAN_RECIPE_MISMATCH");

    const unknownClass = {
      ...plan,
      calls: plan.calls.map((call, index) => index === 0
        ? { ...call, workloadClass: "unknown-class" }
        : call),
    } as HeldOutPlan;
    expect(() => validateHeldOutPlan(unknownClass)).toThrow("HELD_OUT_PLAN_INVALID");

    const malformed = {
      ...plan,
      calls: plan.calls.map((call, index) => index === 0 ? { ...call, maxOutputTokens: 9 } : call),
    } as HeldOutPlan;
    expect(() => validateHeldOutPlan(malformed)).toThrow("HELD_OUT_PLAN_INVALID");

    const relabeled: HeldOutPlan = {
      ...plan,
      calls: plan.calls.map((call) => call.label === "runaway" ? { ...call, label: "legitimate" as const } : call),
    };
    expect(() => validateHeldOutPlan(relabeled)).toThrow("HELD_OUT_PLAN_LABEL_INVALID");
  });

  it("builds isolated runtime setup and calls from only the sealed plan", () => {
    const plan = buildHeldOutPlan(beacon, "openrouter", "nousresearch/hermes-4-405b");
    const calls = buildHeldOutCallPlan(plan, "held-out-1");
    const setup = buildHeldOutSetupPlan(plan, "held-out-1");
    const configurationFingerprint = buildHeldOutConfigurationFingerprint(plan);

    expect(calls).toHaveLength(plan.calls.length);
    expect(calls.every(({ mandateId }) => mandateId === "heldout-held-out-1")).toBe(true);
    expect(calls.every(({ requestId }, index) => requestId === `held-out-1-ho-${index + 1}`)).toBe(true);
    expect(setup.filter(({ kind }) => kind === "branch")).toHaveLength(72);
    expect(setup.at(-1)).toMatchObject({ kind: "activation", body: { to: "active" } });
    const completeEnvelope = plan.calls.reduce((total, call) => {
      const perCall = call.workloadClass === "baseline-lookup" ? 10_000n : 50_000n;
      return total + perCall;
    }, 0n);
    const policy = setup.find(({ kind }) => kind === "policy")!;
    const mandate = setup.find(({ kind }) => kind === "mandate")!;
    expect(BigInt((policy.body.limits as Record<string, string>).maxHourlyAtomic)).toBeGreaterThan(completeEnvelope);
    expect(BigInt((policy.body.limits as Record<string, string>).maxDailyAtomic)).toBeGreaterThan(completeEnvelope);
    expect(BigInt(mandate.body.maximumSpendAtomic as string)).toBeGreaterThan(completeEnvelope);
    for (const workload of policy.body.workloadClasses as Array<Record<string, unknown>>) {
      const classEnvelope = plan.calls
        .filter(({ workloadClass }) => workloadClass === workload.id)
        .reduce((total, call) => total + (call.workloadClass === "baseline-lookup" ? 10_000n : 50_000n), 0n);
      expect(BigInt(workload.aggregateBudgetAtomic as string)).toBeGreaterThan(classEnvelope);
    }
    for (const branch of setup.filter(({ kind }) => kind === "branch")) {
      const branchId = branch.body.branchId as string;
      const descendants = branch.body.parentBranchId === null
        ? setup.filter((candidate) => candidate.kind === "branch" && candidate.body.parentBranchId === branchId)
          .map((candidate) => candidate.body.branchId as string)
        : [branchId];
      const branchEnvelope = plan.calls.filter(({ branchId: id }) => descendants.includes(id))
        .reduce((total, call) => total + (call.workloadClass === "baseline-lookup" ? 10_000n : 50_000n), 0n);
      expect(BigInt(branch.body.maximumSpendAtomic as string)).toBeGreaterThan(branchEnvelope);
    }
    expect(configurationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(configurationFingerprint).not.toBe(plan.planFingerprint);
    expect(buildHeldOutConfigurationFingerprint(plan)).toBe(configurationFingerprint);
  });

  it("scores the preregistered cohort gate without treating calls as independent units", () => {
    const plan = buildHeldOutPlan(beacon, "openrouter", "nousresearch/hermes-4-405b");
    const calls = buildHeldOutCallPlan(plan, "held-out-1");
    const attempts: AttemptManifestEntry[] = calls.map((call, index) => ({
      runId: "held-out-1", fixtureId: call.fixtureId, requestId: call.requestId, sequence: index + 1,
      label: call.label, outcome: "completed", actualCostAtomic: "1",
      occurredAt: "2026-07-22T00:00:00.000Z",
    }));
    expect(() => validateEvidenceCallOutcomes(calls, attempts)).not.toThrow();
    const evidence: PersistedShadowEvidence[] = calls.map((call, index) => {
      const spec = plan.calls[index]!;
      const firstRunawayBurst = spec.label === "runaway"
        && !plan.calls.slice(0, spec.sequence - 1).some((candidate) =>
          candidate.cohortId === spec.cohortId && candidate.label === "runaway");
      return {
        requestId: call.requestId,
        signals: firstRunawayBurst ? ["SIBLING_DIVERGENCE"] : [],
        eligibleForIntervention: firstRunawayBurst,
        wouldSignalTarget: firstRunawayBurst,
        cohortShift: false,
        cohortOrdinal: String(spec.sequence),
      };
    });

    const passing = buildHeldOutReplaySummary(plan, attempts, evidence);
    expect(passing).toMatchObject({
      unitOfAnalysis: "cohort",
      runawayCohorts: 9,
      detectedRunawayCohorts: 9,
      legitimateCohorts: 9,
      falseInterventionCohorts: 0,
      byScenario: {
        "legitimate-unusual-target": { cohorts: 3, falseInterventions: 0 },
        "legitimate-correlated-shift": { cohorts: 3, falseInterventions: 0 },
        "legitimate-sparse-target": { cohorts: 3, falseInterventions: 0 },
      },
      coverage: { attempts: plan.calls.length, persistedShadowEvidence: plan.calls.length },
      gate: { passed: true },
    });
    expect(passing.wilson95.runawayDetection.lower).toBeCloseTo(0.70085, 4);
    expect(passing.wilson95.runawayDetection.upper).toBe(1);
    expect(passing.wilson95.legitimateFalseIntervention.lower).toBe(0);
    expect(passing.wilson95.legitimateFalseIntervention.upper).toBeCloseTo(0.29915, 4);
    expect(passing.secondary.runawaySpendThroughFirstDetectionAtomic).toHaveLength(9);
    expect(passing.secondary.runawaySpendThroughFirstDetectionAtomic.every(({ spendAtomic }) => spendAtomic === "4"))
      .toBe(true);

    const balancedProductionEvaluation = evaluateSiblingDivergence(
      {
        classPriorWindowSpendAtomic: 100n,
        confidenceConstant: 1,
        targetMinimumObservations: 3,
        siblingMinimumForScoring: 2,
        siblingMinimumForIntervention: 2,
        divergenceThresholdBps: 20_000,
      },
      {
        branchId: "target",
        parentBranchId: "parent",
        workloadClass: "baseline-lookup",
        spendAtomic: 100n,
        observationCount: 3,
      },
      ["sibling-1", "sibling-2"].map((branchId) => ({
        branchId,
        parentBranchId: "parent",
        workloadClass: "baseline-lookup",
        spendAtomic: 100n,
        observationCount: 3,
      })),
    );
    expect(balancedProductionEvaluation).toMatchObject({
      eligibleForIntervention: true,
      wouldSignalTarget: false,
      wouldSignal: false,
      signals: [],
    });
    const firstLegitimateCall = plan.calls.find((call) =>
      plan.cohorts.find(({ cohortId }) => cohortId === call.cohortId)?.groundTruth === "legitimate")!;
    const withMatureBalancedLegitimate = evidence.map((item) => item.requestId
      === calls[firstLegitimateCall.sequence - 1]!.requestId
      ? {
          ...item,
          signals: balancedProductionEvaluation.signals,
          eligibleForIntervention: balancedProductionEvaluation.eligibleForIntervention,
          wouldSignalTarget: balancedProductionEvaluation.wouldSignalTarget,
          cohortShift: balancedProductionEvaluation.cohortShift,
        }
      : item);
    expect(buildHeldOutReplaySummary(plan, attempts, withMatureBalancedLegitimate)).toMatchObject({
      falseInterventionCohorts: 0,
      gate: { passed: true },
    });
    const firstRunawayRequest = evidence.find(({ signals }) => signals.includes("SIBLING_DIVERGENCE"))!.requestId;
    const firstLegitimateSequence = plan.calls.find(({ cohortId, label }) => label === "legitimate"
      && plan.cohorts.find((cohort) => cohort.cohortId === cohortId)?.groundTruth === "legitimate")!.sequence;
    const withClassPrior: PersistedShadowEvidence[] = evidence.map((item, index) => {
      if (item.requestId === firstRunawayRequest || index === firstLegitimateSequence - 1) {
        return { ...item, signals: [...item.signals, "CLASS_PRIOR_EXCEEDED"] };
      }
      return item;
    });
    expect(buildHeldOutReplaySummary(plan, attempts, withClassPrior).secondary).toMatchObject({
      classPriorWarningCohortsByLabel: { runaway: 1, legitimate: 1 },
      selectiveConversionCohortsByLabel: { runaway: 1, legitimate: 0 },
    });
    expect(() => buildHeldOutReplaySummary(plan, attempts, evidence.slice(1)))
      .toThrow("HELD_OUT_SHADOW_EVIDENCE_MISSING");
    expect(() => buildHeldOutReplaySummary(plan, attempts, [...evidence, evidence[0]!]))
      .toThrow("HELD_OUT_SHADOW_EVIDENCE_COVERAGE_INVALID");

    const fanOutTwoMisses = new Set(plan.cohorts
      .filter(({ fanOut, groundTruth }) => fanOut === 2 && groundTruth === "runaway")
      .slice(0, 2)
      .map(({ cohortId }) => cohortId));
    const fanOutDeficient: PersistedShadowEvidence[] = evidence.map((item, index) =>
      fanOutTwoMisses.has(plan.calls[index]!.cohortId)
        ? { ...item, signals: [], eligibleForIntervention: false, wouldSignalTarget: false }
        : item);
    const fanOutFailure = buildHeldOutReplaySummary(plan, attempts, fanOutDeficient);
    expect(fanOutFailure.detectedRunawayCohorts).toBe(7);
    expect(fanOutFailure.byFanOut["2"].detected).toBe(1);
    expect(fanOutFailure.gate).toMatchObject({
      passed: false,
      reasons: expect.arrayContaining(["FANOUT_2_DETECTION_BELOW_2_OF_3"]),
    });

    const legitimateCall = plan.calls.find((call) => call.label === "legitimate"
      && plan.cohorts.find(({ cohortId }) => cohortId === call.cohortId)?.groundTruth === "legitimate")!;
    const withFalseIntervention: PersistedShadowEvidence[] = evidence.map((item) =>
      item.requestId === calls[legitimateCall.sequence - 1]!.requestId
        ? {
            ...item,
            eligibleForIntervention: true,
            wouldSignalTarget: true,
            signals: ["SIBLING_DIVERGENCE"],
          }
        : item);
    expect(buildHeldOutReplaySummary(plan, attempts, withFalseIntervention).gate.passed).toBe(false);
  });

  it("writes sealed artifacts mode 0600 and refuses overwrite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-held-out-"));
    const beaconPath = join(directory, "beacon.json");
    const planPath = join(directory, "plan.json");
    await writeOnceJsonPair(beaconPath, { round: 1 }, planPath, { fingerprint: "first" });
    await expect(writeOnceJsonPair(beaconPath, { round: 2 }, planPath, { fingerprint: "second" }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(planPath, "utf8"))).toEqual({ fingerprint: "first" });
    expect((await stat(beaconPath)).mode & 0o777).toBe(0o600);
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);
  });

  it("recovers an exact beacon-plan transaction after interruption left only the beacon", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-held-out-recovery-"));
    const beaconPath = join(directory, "beacon.json");
    const planPath = join(directory, "plan.json");
    const beaconValue = { round: 1 };
    const planValue = { fingerprint: "first" };
    await writeFile(beaconPath, `${JSON.stringify(beaconValue, null, 2)}\n`, { mode: 0o600 });

    await expect(writeOnceJsonPair(beaconPath, beaconValue, planPath, planValue)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(beaconPath, "utf8"))).toEqual(beaconValue);
    expect(JSON.parse(await readFile(planPath, "utf8"))).toEqual(planValue);
  });

  it.each([
    ["after the first link", "afterFirstLink"],
    ["after the second link", "afterSecondLink"],
    ["before directory sync", "beforeDirectorySync"],
  ] as const)("recovers an exact pair when interrupted %s", async (_label, hook) => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-held-out-interruption-"));
    const beaconPath = join(directory, "beacon.json");
    const planPath = join(directory, "plan.json");
    const beaconValue = { round: 1 };
    const planValue = { fingerprint: "first" };
    await expect(writeOnceJsonPair(beaconPath, beaconValue, planPath, planValue, {
      [hook]: () => { throw new Error(`injected:${hook}`); },
    })).rejects.toThrow(`injected:${hook}`);

    await expect(writeOnceJsonPair(beaconPath, beaconValue, planPath, planValue)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(beaconPath, "utf8"))).toEqual(beaconValue);
    expect(JSON.parse(await readFile(planPath, "utf8"))).toEqual(planValue);
    expect((await stat(beaconPath)).mode & 0o777).toBe(0o600);
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);
  });

  it("requires the paid-run plan bytes to be committed at Git HEAD", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-held-out-git-"));
    await execFileAsync("git", ["init", "-q"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "held-out@example.invalid"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Held Out Test"], { cwd: directory });
    const path = join(directory, "plan.json");
    await writeFile(path, "{\"fingerprint\":\"first\"}\n");
    await execFileAsync("git", ["add", "plan.json"], { cwd: directory });
    await execFileAsync("git", ["commit", "-qm", "seal plan"], { cwd: directory });
    await expect(assertArtifactCommittedAtHead(path, directory)).resolves.toBeUndefined();
    await writeFile(path, "{\"fingerprint\":\"changed\"}\n");
    await expect(assertArtifactCommittedAtHead(path, directory))
      .rejects.toThrow("HELD_OUT_PLAN_NOT_COMMITTED");
  });
});
