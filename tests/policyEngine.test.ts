import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  validatePolicy,
  type PolicyVersion,
  type PolicyEvaluationInput,
} from "../src/domain/policy.js";

const policy = (overrides: Partial<PolicyVersion> = {}): PolicyVersion => ({
  id: "policy-1",
  organizationId: "org-1",
  version: 1,
  mode: "enforce",
  allowedProviders: ["anthropic"],
  allowedModels: ["claude-sonnet-4-6"],
  requiredCapability: "inference:invoke",
  limits: {
    maxPerCallAtomic: 10_000n,
    maxHourlyAtomic: 50_000n,
    maxDailyAtomic: 250_000n,
    maxRequestsPerMinute: 10,
    maxInputTokens: 20_000,
    maxOutputTokens: 4_000,
  },
  createdAt: "2026-07-13T19:00:00.000Z",
  ...overrides,
});

const evaluation = (overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput => ({
  now: "2026-07-13T19:01:00.000Z",
  mandateState: "active",
  mandateExpiresAt: "2026-08-13T19:00:00.000Z",
  agentAuthorized: true,
  agentCapabilities: ["inference:invoke"],
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  estimatedCostAtomic: 5_000n,
  inputTokens: 1_000,
  maxOutputTokens: 500,
  spentHourAtomic: 10_000n,
  spentDayAtomic: 20_000n,
  mandateSpentAtomic: 20_000n,
  mandateMaximumAtomic: 250_000n,
  requestCountLastMinute: 2,
  ...overrides,
});

describe("policy engine", () => {
  it("allows a request that satisfies the active policy and mandate", () => {
    expect(evaluatePolicy(policy(), evaluation())).toEqual({
      outcome: "ALLOW",
      wouldOutcome: "ALLOW",
      enforced: true,
      reasonCodes: [],
    });
  });

  it("returns deterministic reason codes for every violated control", () => {
    const decision = evaluatePolicy(policy(), evaluation({
      mandateState: "paused",
      mandateExpiresAt: "2026-07-13T19:00:00.000Z",
      agentAuthorized: false,
      agentCapabilities: [],
      provider: "openai",
      model: "gpt-5",
      estimatedCostAtomic: 11_000n,
      inputTokens: 21_000,
      maxOutputTokens: 4_001,
      spentHourAtomic: 45_000n,
      spentDayAtomic: 245_000n,
      requestCountLastMinute: 10,
    }));
    expect(decision).toEqual({
      outcome: "DENY",
      wouldOutcome: "DENY",
      enforced: true,
      reasonCodes: [
        "MANDATE_INACTIVE",
        "MANDATE_EXPIRED",
        "AGENT_NOT_AUTHORIZED",
        "CAPABILITY_MISSING",
        "PROVIDER_NOT_ALLOWED",
        "MODEL_NOT_ALLOWED",
        "PER_CALL_LIMIT_EXCEEDED",
        "HOURLY_LIMIT_EXCEEDED",
        "DAILY_LIMIT_EXCEEDED",
        "RATE_LIMIT_EXCEEDED",
        "INPUT_TOKEN_LIMIT_EXCEEDED",
        "OUTPUT_TOKEN_LIMIT_EXCEEDED",
      ],
    });
  });

  it("records a denial in dry-run mode without blocking the request", () => {
    expect(evaluatePolicy(policy({ mode: "dry_run" }), evaluation({
      provider: "openai",
    }))).toEqual({
      outcome: "ALLOW",
      wouldOutcome: "DENY",
      enforced: false,
      reasonCodes: ["PROVIDER_NOT_ALLOWED"],
    });
  });

  it("keeps mandate lifecycle, assignment, expiry, and capability checks fail-closed in dry-run", () => {
    expect(evaluatePolicy(policy({ mode: "dry_run" }), evaluation({
      mandateState: "draft",
      mandateExpiresAt: "2026-07-13T19:00:00.000Z",
      agentAuthorized: false,
      agentCapabilities: [],
    }))).toEqual({
      outcome: "DENY",
      wouldOutcome: "DENY",
      enforced: true,
      reasonCodes: [
        "MANDATE_INACTIVE",
        "MANDATE_EXPIRED",
        "AGENT_NOT_AUTHORIZED",
        "CAPABILITY_MISSING",
      ],
    });
  });

  it("denies reservations that would exceed the mandate-wide budget", () => {
    const input = {
      ...evaluation(),
      mandateSpentAtomic: 248_000n,
      mandateMaximumAtomic: 250_000n,
      estimatedCostAtomic: 5_000n,
    } as PolicyEvaluationInput & {
      mandateSpentAtomic: bigint;
      mandateMaximumAtomic: bigint;
    };
    expect(evaluatePolicy(policy(), input)).toMatchObject({
      outcome: "DENY",
      reasonCodes: ["MANDATE_BUDGET_EXCEEDED"],
    });
  });

  it("treats policy-bound workload-class authority as a hard envelope even in dry-run", () => {
    const controlled = policy({
      mode: "dry_run",
      workloadClasses: [{
        id: "lookup",
        maxCostPerCallAtomic: 2_000n,
        maxInvocationsPerBranch: 3,
        aggregateBudgetAtomic: 5_000n,
        minimumInputTokens: 10,
        shadow: null,
      }],
    });

    expect(evaluatePolicy(controlled, evaluation({
      workload: {
        branchId: "branch-scout",
        workloadClass: "deep_research",
        branchAuthorized: true,
        branchMaximumAtomic: 50_000n,
        branchSpentAtomic: 0n,
        branchExpiresAt: null,
        classAuthorized: false,
        classInvocationCount: 0,
        classSpentAtomic: 0n,
      },
    }))).toEqual({
      outcome: "DENY",
      wouldOutcome: "DENY",
      enforced: true,
      reasonCodes: ["WORKLOAD_CLASS_NOT_ALLOWED"],
    });
  });

  it("enforces per-class call, invocation, budget, and request-shape limits", () => {
    const controlled = policy({
      workloadClasses: [{
        id: "lookup",
        maxCostPerCallAtomic: 2_000n,
        maxInvocationsPerBranch: 3,
        aggregateBudgetAtomic: 5_000n,
        minimumInputTokens: 10,
        shadow: null,
      }],
    });

    expect(evaluatePolicy(controlled, evaluation({
      estimatedCostAtomic: 2_500n,
      inputTokens: 5,
      workload: {
        branchId: "branch-scout",
        workloadClass: "lookup",
        branchAuthorized: true,
        branchMaximumAtomic: 50_000n,
        branchSpentAtomic: 0n,
        branchExpiresAt: null,
        classAuthorized: true,
        classInvocationCount: 3,
        classSpentAtomic: 4_000n,
      },
    }))).toEqual({
      outcome: "DENY",
      wouldOutcome: "DENY",
      enforced: true,
      reasonCodes: [
        "WORKLOAD_CLASS_PER_CALL_LIMIT_EXCEEDED",
        "WORKLOAD_CLASS_INVOCATION_LIMIT_EXCEEDED",
        "WORKLOAD_CLASS_BUDGET_EXCEEDED",
        "WORKLOAD_CLASS_SHAPE_MISMATCH",
      ],
    });
    expect(evaluatePolicy(controlled, evaluation({
      estimatedCostAtomic: 100n,
      workload: {
        branchId: "branch-scout", workloadClass: "lookup", branchAuthorized: true,
        branchMaximumAtomic: 5_000n, branchSpentAtomic: 4_950n,
        branchExpiresAt: "2026-07-13T19:00:00.000Z", classAuthorized: true,
        classInvocationCount: 0, classSpentAtomic: 0n,
      },
    }))).toMatchObject({
      outcome: "DENY", enforced: true,
      reasonCodes: ["BRANCH_EXPIRED", "BRANCH_BUDGET_EXCEEDED"],
    });
  });

  it("denies every request when the policy is paused", () => {
    expect(evaluatePolicy(policy({ mode: "paused" }), evaluation())).toEqual({
      outcome: "DENY",
      wouldOutcome: "DENY",
      enforced: true,
      reasonCodes: ["POLICY_PAUSED"],
    });
  });

  it("rejects malformed or internally inconsistent policy versions", () => {
    expect(() => validatePolicy(policy({ version: 0 }))).toThrow("POLICY_VERSION_INVALID");
    expect(() => validatePolicy(policy({
      requiredCapability: "wallet:drain" as "inference:invoke",
    }))).toThrow("POLICY_CAPABILITY_INVALID");
    expect(() => validatePolicy(policy({ allowedProviders: ["anthropic", "anthropic"] })))
      .toThrow("POLICY_PROVIDER_DUPLICATE");
    expect(() => validatePolicy(policy({
      limits: { ...policy().limits, maxPerCallAtomic: -1n },
    }))).toThrow("POLICY_LIMIT_INVALID:maxPerCallAtomic");
    expect(() => evaluatePolicy(policy(), evaluation({
      agentCapabilities: ["wallet:drain" as "inference:invoke"],
    }))).toThrow("POLICY_EVALUATION_CAPABILITY_INVALID");
    const workloadClass = {
      id: "lookup",
      maxCostPerCallAtomic: 1_000n,
      maxInvocationsPerBranch: 3,
      aggregateBudgetAtomic: 5_000n,
      minimumInputTokens: 0,
      shadow: {
        classPriorWindowSpendAtomic: 1_000n,
        windowSeconds: 900,
        targetMinimumObservations: 3,
        siblingMinimumForScoring: 2,
        siblingMinimumForIntervention: 3,
        confidenceConstant: 5,
        divergenceThresholdBps: 30_000,
      },
    };
    expect(() => validatePolicy(policy({ workloadClasses: [workloadClass, workloadClass] })))
      .toThrow("WORKLOAD_CLASS_DUPLICATE");
    expect(() => validatePolicy(policy({
      workloadClasses: [{ ...workloadClass, maxCostPerCallAtomic: -1n }],
    }))).toThrow("WORKLOAD_CLASS_LIMIT_INVALID");
    expect(() => validatePolicy(policy({
      workloadClasses: [{
        ...workloadClass,
        shadow: { ...workloadClass.shadow, siblingMinimumForIntervention: 1 },
      }],
    }))).toThrow("WORKLOAD_CLASS_SHADOW_INVALID");
  });
});
