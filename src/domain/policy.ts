import { API_CAPABILITIES, type ApiCapability } from "../identity/apiCredentials.js";

export type PolicyMode = "dry_run" | "enforce" | "paused";
export type PolicyOutcome = "ALLOW" | "DENY" | "REVIEW";

export interface PolicyLimits {
  maxPerCallAtomic: bigint;
  maxHourlyAtomic: bigint;
  maxDailyAtomic: bigint;
  maxRequestsPerMinute: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface WorkloadClassShadowPolicy {
  classPriorWindowSpendAtomic: bigint;
  windowSeconds: number;
  targetMinimumObservations: number;
  siblingMinimumForScoring: number;
  siblingMinimumForIntervention: number;
  confidenceConstant: number;
  divergenceThresholdBps: number;
}

export interface WorkloadClassPolicy {
  id: string;
  maxCostPerCallAtomic: bigint;
  maxInvocationsPerBranch: number;
  aggregateBudgetAtomic: bigint;
  minimumInputTokens: number;
  shadow: WorkloadClassShadowPolicy | null;
}

export interface PolicyVersion {
  id: string;
  organizationId: string;
  version: number;
  mode: PolicyMode;
  allowedProviders: string[];
  allowedModels: string[];
  requiredCapability: ApiCapability;
  limits: PolicyLimits;
  workloadClasses?: WorkloadClassPolicy[];
  createdAt: string;
}

export type PolicyReasonCode =
  | "POLICY_PAUSED"
  | "MANDATE_INACTIVE"
  | "MANDATE_EXPIRED"
  | "AGENT_NOT_AUTHORIZED"
  | "CAPABILITY_MISSING"
  | "PROVIDER_NOT_ALLOWED"
  | "MODEL_NOT_ALLOWED"
  | "PER_CALL_LIMIT_EXCEEDED"
  | "HOURLY_LIMIT_EXCEEDED"
  | "DAILY_LIMIT_EXCEEDED"
  | "MANDATE_BUDGET_EXCEEDED"
  | "RATE_LIMIT_EXCEEDED"
  | "INPUT_TOKEN_LIMIT_EXCEEDED"
  | "OUTPUT_TOKEN_LIMIT_EXCEEDED"
  | "WORKLOAD_CLASS_REQUIRED"
  | "BRANCH_NOT_AUTHORIZED"
  | "BRANCH_EXPIRED"
  | "BRANCH_BUDGET_EXCEEDED"
  | "WORKLOAD_CLASS_NOT_ALLOWED"
  | "WORKLOAD_CLASS_PER_CALL_LIMIT_EXCEEDED"
  | "WORKLOAD_CLASS_INVOCATION_LIMIT_EXCEEDED"
  | "WORKLOAD_CLASS_BUDGET_EXCEEDED"
  | "WORKLOAD_CLASS_SHAPE_MISMATCH";

export interface WorkloadEvaluationInput {
  branchId: string;
  workloadClass: string;
  branchAuthorized: boolean;
  branchMaximumAtomic: bigint;
  branchSpentAtomic: bigint;
  branchExpiresAt: string | null;
  classAuthorized: boolean;
  classInvocationCount: number;
  classSpentAtomic: bigint;
}

export interface PolicyEvaluationInput {
  now: string;
  mandateState: string;
  mandateExpiresAt: string | null;
  agentAuthorized: boolean;
  agentCapabilities: readonly ApiCapability[];
  provider: string;
  model: string;
  estimatedCostAtomic: bigint;
  inputTokens: number;
  maxOutputTokens: number;
  spentHourAtomic: bigint;
  spentDayAtomic: bigint;
  mandateSpentAtomic: bigint;
  mandateMaximumAtomic: bigint;
  requestCountLastMinute: number;
  workload?: WorkloadEvaluationInput;
}

export interface PolicyDecisionResult {
  outcome: PolicyOutcome;
  wouldOutcome: PolicyOutcome;
  enforced: boolean;
  reasonCodes: PolicyReasonCode[];
}

export function validatePolicy(candidate: PolicyVersion): void {
  if (!candidate.id.trim()) throw new Error("POLICY_ID_REQUIRED");
  if (!candidate.organizationId.trim()) throw new Error("POLICY_ORGANIZATION_REQUIRED");
  if (!Number.isInteger(candidate.version) || candidate.version < 1) {
    throw new Error("POLICY_VERSION_INVALID");
  }
  if (!["dry_run", "enforce", "paused"].includes(candidate.mode)) {
    throw new Error("POLICY_MODE_INVALID");
  }
  if (Number.isNaN(Date.parse(candidate.createdAt))) throw new Error("POLICY_CREATED_AT_INVALID");
  if (!API_CAPABILITIES.includes(candidate.requiredCapability)) {
    throw new Error("POLICY_CAPABILITY_INVALID");
  }
  validateUniqueList(candidate.allowedProviders, "POLICY_PROVIDER");
  validateUniqueList(candidate.allowedModels, "POLICY_MODEL");
  validateWorkloadClasses(candidate.workloadClasses ?? []);
  const atomicLimits: Array<[keyof PolicyLimits, bigint]> = [
    ["maxPerCallAtomic", candidate.limits.maxPerCallAtomic],
    ["maxHourlyAtomic", candidate.limits.maxHourlyAtomic],
    ["maxDailyAtomic", candidate.limits.maxDailyAtomic],
  ];
  for (const [name, value] of atomicLimits) {
    if (value < 0n) throw new Error(`POLICY_LIMIT_INVALID:${name}`);
  }
  const integerLimits: Array<[keyof PolicyLimits, number]> = [
    ["maxRequestsPerMinute", candidate.limits.maxRequestsPerMinute],
    ["maxInputTokens", candidate.limits.maxInputTokens],
    ["maxOutputTokens", candidate.limits.maxOutputTokens],
  ];
  for (const [name, value] of integerLimits) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`POLICY_LIMIT_INVALID:${name}`);
  }
}

export function evaluatePolicy(
  policy: PolicyVersion,
  input: PolicyEvaluationInput,
): PolicyDecisionResult {
  validatePolicy(policy);
  validateEvaluation(input);
  if (policy.mode === "paused") {
    return {
      outcome: "DENY",
      wouldOutcome: "DENY",
      enforced: true,
      reasonCodes: ["POLICY_PAUSED"],
    };
  }

  const reasons: PolicyReasonCode[] = [];
  if (input.mandateState !== "active") reasons.push("MANDATE_INACTIVE");
  if (input.mandateExpiresAt !== null
    && Date.parse(input.mandateExpiresAt) <= Date.parse(input.now)) {
    reasons.push("MANDATE_EXPIRED");
  }
  if (!input.agentAuthorized) reasons.push("AGENT_NOT_AUTHORIZED");
  if (!input.agentCapabilities.includes(policy.requiredCapability)) reasons.push("CAPABILITY_MISSING");
  if (!policy.allowedProviders.includes(input.provider)) reasons.push("PROVIDER_NOT_ALLOWED");
  if (!policy.allowedModels.includes(input.model)) reasons.push("MODEL_NOT_ALLOWED");
  if (input.estimatedCostAtomic > policy.limits.maxPerCallAtomic) {
    reasons.push("PER_CALL_LIMIT_EXCEEDED");
  }
  if (input.spentHourAtomic + input.estimatedCostAtomic > policy.limits.maxHourlyAtomic) {
    reasons.push("HOURLY_LIMIT_EXCEEDED");
  }
  if (input.spentDayAtomic + input.estimatedCostAtomic > policy.limits.maxDailyAtomic) {
    reasons.push("DAILY_LIMIT_EXCEEDED");
  }
  if (input.mandateSpentAtomic + input.estimatedCostAtomic > input.mandateMaximumAtomic) {
    reasons.push("MANDATE_BUDGET_EXCEEDED");
  }
  if (input.requestCountLastMinute >= policy.limits.maxRequestsPerMinute) {
    reasons.push("RATE_LIMIT_EXCEEDED");
  }
  if (input.inputTokens > policy.limits.maxInputTokens) reasons.push("INPUT_TOKEN_LIMIT_EXCEEDED");
  if (input.maxOutputTokens > policy.limits.maxOutputTokens) {
    reasons.push("OUTPUT_TOKEN_LIMIT_EXCEEDED");
  }
  if ((policy.workloadClasses?.length ?? 0) > 0) {
    if (!input.workload) {
      reasons.push("WORKLOAD_CLASS_REQUIRED");
    } else if (!input.workload.branchAuthorized) {
      reasons.push("BRANCH_NOT_AUTHORIZED");
    } else {
      if (input.workload.branchExpiresAt !== null
        && Date.parse(input.now) >= Date.parse(input.workload.branchExpiresAt)) {
        reasons.push("BRANCH_EXPIRED");
      }
      if (input.workload.branchSpentAtomic + input.estimatedCostAtomic
        > input.workload.branchMaximumAtomic) {
        reasons.push("BRANCH_BUDGET_EXCEEDED");
      }
      if (!input.workload.classAuthorized
        || !policy.workloadClasses!.some(({ id }) => id === input.workload!.workloadClass)) {
        reasons.push("WORKLOAD_CLASS_NOT_ALLOWED");
      } else {
      const workloadClass = policy.workloadClasses!
        .find(({ id }) => id === input.workload!.workloadClass)!;
      if (input.estimatedCostAtomic > workloadClass.maxCostPerCallAtomic) {
        reasons.push("WORKLOAD_CLASS_PER_CALL_LIMIT_EXCEEDED");
      }
      if (input.workload.classInvocationCount >= workloadClass.maxInvocationsPerBranch) {
        reasons.push("WORKLOAD_CLASS_INVOCATION_LIMIT_EXCEEDED");
      }
      if (input.workload.classSpentAtomic + input.estimatedCostAtomic
        > workloadClass.aggregateBudgetAtomic) {
        reasons.push("WORKLOAD_CLASS_BUDGET_EXCEEDED");
      }
      if (input.inputTokens < workloadClass.minimumInputTokens) {
        reasons.push("WORKLOAD_CLASS_SHAPE_MISMATCH");
      }
      }
    }
  }

  const wouldOutcome: PolicyOutcome = reasons.length === 0 ? "ALLOW" : "DENY";
  const hardDenial = reasons.some((reason) => [
    "MANDATE_INACTIVE",
    "MANDATE_EXPIRED",
    "AGENT_NOT_AUTHORIZED",
    "CAPABILITY_MISSING",
    "MANDATE_BUDGET_EXCEEDED",
    "WORKLOAD_CLASS_REQUIRED",
    "BRANCH_NOT_AUTHORIZED",
    "BRANCH_EXPIRED",
    "BRANCH_BUDGET_EXCEEDED",
    "WORKLOAD_CLASS_NOT_ALLOWED",
    "WORKLOAD_CLASS_PER_CALL_LIMIT_EXCEEDED",
    "WORKLOAD_CLASS_INVOCATION_LIMIT_EXCEEDED",
    "WORKLOAD_CLASS_BUDGET_EXCEEDED",
    "WORKLOAD_CLASS_SHAPE_MISMATCH",
  ].includes(reason));
  if (hardDenial) {
    return { outcome: "DENY", wouldOutcome, enforced: true, reasonCodes: reasons };
  }
  if (policy.mode === "dry_run") {
    return { outcome: "ALLOW", wouldOutcome, enforced: false, reasonCodes: reasons };
  }
  return { outcome: wouldOutcome, wouldOutcome, enforced: true, reasonCodes: reasons };
}

function validateUniqueList(values: readonly string[], prefix: string): void {
  if (values.length === 0 || values.some((value) => !value.trim())) {
    throw new Error(`${prefix}_REQUIRED`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${prefix}_DUPLICATE`);
}

function validateWorkloadClasses(workloadClasses: readonly WorkloadClassPolicy[]): void {
  const ids = workloadClasses.map(({ id }) => id);
  if (ids.some((id) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(id))) {
    throw new Error("WORKLOAD_CLASS_ID_INVALID");
  }
  if (new Set(ids).size !== ids.length) throw new Error("WORKLOAD_CLASS_DUPLICATE");
  for (const workloadClass of workloadClasses) {
    if (workloadClass.maxCostPerCallAtomic <= 0n
      || workloadClass.aggregateBudgetAtomic <= 0n
      || workloadClass.aggregateBudgetAtomic < workloadClass.maxCostPerCallAtomic
      || !Number.isSafeInteger(workloadClass.maxInvocationsPerBranch)
      || workloadClass.maxInvocationsPerBranch < 1
      || !Number.isSafeInteger(workloadClass.minimumInputTokens)
      || workloadClass.minimumInputTokens < 0) {
      throw new Error("WORKLOAD_CLASS_LIMIT_INVALID");
    }
    const shadow = workloadClass.shadow;
    if (!shadow) continue;
    const counts = [
      shadow.windowSeconds,
      shadow.targetMinimumObservations,
      shadow.siblingMinimumForScoring,
      shadow.siblingMinimumForIntervention,
      shadow.confidenceConstant,
      shadow.divergenceThresholdBps,
    ];
    if (shadow.classPriorWindowSpendAtomic <= 0n
      || counts.some((value) => !Number.isSafeInteger(value) || value < 1)
      || shadow.siblingMinimumForIntervention < shadow.siblingMinimumForScoring) {
      throw new Error("WORKLOAD_CLASS_SHADOW_INVALID");
    }
  }
}

function validateEvaluation(input: PolicyEvaluationInput): void {
  if (Number.isNaN(Date.parse(input.now))) throw new Error("POLICY_EVALUATION_TIME_INVALID");
  if (input.mandateExpiresAt !== null && Number.isNaN(Date.parse(input.mandateExpiresAt))) {
    throw new Error("MANDATE_EXPIRY_INVALID");
  }
  if (!input.provider.trim()) throw new Error("POLICY_EVALUATION_PROVIDER_REQUIRED");
  if (!input.model.trim()) throw new Error("POLICY_EVALUATION_MODEL_REQUIRED");
  if (input.agentCapabilities.some((capability) => !API_CAPABILITIES.includes(capability))
    || new Set(input.agentCapabilities).size !== input.agentCapabilities.length) {
    throw new Error("POLICY_EVALUATION_CAPABILITY_INVALID");
  }
  if (input.estimatedCostAtomic < 0n || input.spentHourAtomic < 0n || input.spentDayAtomic < 0n
    || input.mandateSpentAtomic < 0n || input.mandateMaximumAtomic < 0n) {
    throw new Error("POLICY_EVALUATION_AMOUNT_INVALID");
  }
  for (const value of [input.inputTokens, input.maxOutputTokens, input.requestCountLastMinute]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("POLICY_EVALUATION_COUNT_INVALID");
  }
}
