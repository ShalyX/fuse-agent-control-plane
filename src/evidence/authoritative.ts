import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { SetupOperation } from "./harness.js";

type AuthoritativeQueryClient = Pick<Pool, "query">;

export const AUTHORITATIVE_SETUP_SOURCE = "postgres-authoritative-setup-v1" as const;

type ShadowSetup = {
  classPriorWindowSpendAtomic: string;
  windowSeconds: number;
  targetMinimumObservations: number;
  siblingMinimumForScoring: number;
  siblingMinimumForIntervention: number;
  confidenceConstant: number;
  divergenceThresholdBps: number;
};

type WorkloadSetup = {
  id: string;
  maxCostPerCallAtomic: string;
  maxInvocationsPerBranch: number;
  aggregateBudgetAtomic: string;
  minimumInputTokens: number;
  shadow: ShadowSetup | null;
};

export interface AuthoritativeSetup {
  schemaVersion: 1;
  provider: { provider: string; model: string };
  policy: {
    policyId: string;
    version: number;
    mode: string;
    allowedProviders: string[];
    allowedModels: string[];
    requiredCapability: string;
    limits: {
      maxPerCallAtomic: string;
      maxHourlyAtomic: string;
      maxDailyAtomic: string;
      maxRequestsPerMinute: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    };
    workloadClasses: WorkloadSetup[];
  };
  mandate: {
    mandateId: string;
    assetId: string;
    maximumSpendAtomic: string;
    state: string;
    policyId: string;
    policyVersion: number;
    expiresAt: string | null;
  };
  assignedAgentIds: string[];
  branches: Array<{
    branchId: string;
    parentBranchId: string | null;
    agentId: string;
    policyId: string;
    policyVersion: number;
    allowedWorkloadClasses: string[];
    maximumSpendAtomic: string;
    expiresAt: string | null;
  }>;
}

function requiredOperation(setupPlan: readonly SetupOperation[], kind: SetupOperation["kind"]): SetupOperation {
  const operation = setupPlan.find((candidate) => candidate.kind === kind);
  if (!operation) throw new Error("EVIDENCE_SETUP_PLAN_INVALID");
  return operation;
}

export function buildIntendedAuthoritativeSetup(input: {
  setupPlan: readonly SetupOperation[];
  provider: string;
  model: string;
  mandateId: string;
  policyId: string;
  agentId: string;
}): AuthoritativeSetup {
  const policy = requiredOperation(input.setupPlan, "policy").body;
  const mandate = requiredOperation(input.setupPlan, "mandate").body;
  const branches = input.setupPlan.filter(({ kind }) => kind === "branch").map(({ body }) => ({
    branchId: String(body["branchId"]),
    parentBranchId: body["parentBranchId"] === null ? null : String(body["parentBranchId"]),
    agentId: String(body["agentId"]),
    policyId: input.policyId,
    policyVersion: Number(policy["version"]),
    allowedWorkloadClasses: [...body["allowedWorkloadClasses"] as string[]].sort(),
    maximumSpendAtomic: String(body["maximumSpendAtomic"]),
    expiresAt: body["expiresAt"] === null ? null : String(body["expiresAt"]),
  })).sort((left, right) => left.branchId.localeCompare(right.branchId));
  return {
    schemaVersion: 1,
    provider: { provider: input.provider, model: input.model },
    policy: {
      policyId: String(policy["policyId"]),
      version: Number(policy["version"]),
      mode: String(policy["mode"]),
      allowedProviders: [...policy["allowedProviders"] as string[]],
      allowedModels: [...policy["allowedModels"] as string[]],
      requiredCapability: String(policy["requiredCapability"]),
      limits: structuredClone(policy["limits"]) as AuthoritativeSetup["policy"]["limits"],
      workloadClasses: structuredClone(policy["workloadClasses"]) as WorkloadSetup[],
    },
    mandate: {
      mandateId: input.mandateId,
      assetId: String(mandate["assetId"]),
      maximumSpendAtomic: String(mandate["maximumSpendAtomic"]),
      state: "active",
      policyId: String(mandate["policyId"]),
      policyVersion: Number(mandate["policyVersion"]),
      expiresAt: mandate["expiresAt"] === null ? null : String(mandate["expiresAt"]),
    },
    assignedAgentIds: [input.agentId],
    branches,
  };
}

export async function queryAuthoritativeSetup(
  pool: AuthoritativeQueryClient,
  input: { mandateId: string; policyId: string; policyVersion: number },
): Promise<AuthoritativeSetup> {
  const provider = await pool.query<{ organization_id: string; provider: string; model: string }>(`
    SELECT configuration.organization_id, configuration.provider, configuration.model
    FROM provider_configurations configuration
    JOIN control_mandates mandate ON mandate.organization_id = configuration.organization_id
    WHERE mandate.id = $1 AND configuration.status = 'active'
  `, [input.mandateId]);
  if (provider.rows.length !== 1) throw new Error("EVIDENCE_AUTHORITATIVE_SETUP_COVERAGE_INVALID");
  const organizationId = provider.rows[0]!.organization_id;
  const policies = await pool.query<{
    policy_id: string; version: number; mode: string; allowed_providers: string[]; allowed_models: string[];
    required_capability: string; max_per_call_atomic: string; max_hourly_atomic: string;
    max_daily_atomic: string; max_requests_per_minute: number; max_input_tokens: number;
    max_output_tokens: number; workload_classes: WorkloadSetup[];
  }>(`
    SELECT policy_id, version, mode, allowed_providers, allowed_models, required_capability,
      max_per_call_atomic::text, max_hourly_atomic::text, max_daily_atomic::text,
      max_requests_per_minute, max_input_tokens, max_output_tokens, workload_classes
    FROM policy_versions WHERE organization_id = $1 AND policy_id = $2 AND version = $3
  `, [organizationId, input.policyId, input.policyVersion]);
  const mandates = await pool.query<{
    id: string; asset_id: string; maximum_spend_atomic: string; state: string; policy_id: string;
    policy_version: number; expires_at: Date | null;
  }>(`
    SELECT id, asset_id, maximum_spend_atomic::text, state, policy_id, policy_version, expires_at
    FROM control_mandates WHERE organization_id = $1 AND id = $2
  `, [organizationId, input.mandateId]);
  const assignments = await pool.query<{ agent_id: string }>(`
    SELECT agent_id FROM mandate_agent_assignments
    WHERE organization_id = $1 AND mandate_id = $2 ORDER BY agent_id
  `, [organizationId, input.mandateId]);
  const branchRows = await pool.query<{
    branch_id: string; parent_branch_id: string | null; agent_id: string; policy_id: string;
    policy_version: number; allowed_workload_classes: string[]; maximum_spend_atomic: string;
    expires_at: Date | null;
  }>(`
    SELECT branch_id, parent_branch_id, agent_id, policy_id, policy_version,
      allowed_workload_classes, maximum_spend_atomic::text, expires_at
    FROM mandate_branches WHERE organization_id = $1 AND mandate_id = $2 ORDER BY branch_id
  `, [organizationId, input.mandateId]);
  if (policies.rows.length !== 1 || mandates.rows.length !== 1) {
    throw new Error("EVIDENCE_AUTHORITATIVE_SETUP_COVERAGE_INVALID");
  }
  const policy = policies.rows[0]!;
  const mandate = mandates.rows[0]!;
  return {
    schemaVersion: 1,
    provider: { provider: provider.rows[0]!.provider, model: provider.rows[0]!.model },
    policy: {
      policyId: policy.policy_id,
      version: policy.version,
      mode: policy.mode,
      allowedProviders: policy.allowed_providers,
      allowedModels: policy.allowed_models,
      requiredCapability: policy.required_capability,
      limits: {
        maxPerCallAtomic: policy.max_per_call_atomic,
        maxHourlyAtomic: policy.max_hourly_atomic,
        maxDailyAtomic: policy.max_daily_atomic,
        maxRequestsPerMinute: policy.max_requests_per_minute,
        maxInputTokens: policy.max_input_tokens,
        maxOutputTokens: policy.max_output_tokens,
      },
      workloadClasses: policy.workload_classes,
    },
    mandate: {
      mandateId: mandate.id,
      assetId: mandate.asset_id,
      maximumSpendAtomic: mandate.maximum_spend_atomic,
      state: mandate.state,
      policyId: mandate.policy_id,
      policyVersion: mandate.policy_version,
      expiresAt: mandate.expires_at?.toISOString() ?? null,
    },
    assignedAgentIds: assignments.rows.map(({ agent_id }) => agent_id),
    branches: branchRows.rows.map((branch) => ({
      branchId: branch.branch_id,
      parentBranchId: branch.parent_branch_id,
      agentId: branch.agent_id,
      policyId: branch.policy_id,
      policyVersion: branch.policy_version,
      allowedWorkloadClasses: [...branch.allowed_workload_classes].sort(),
      maximumSpendAtomic: branch.maximum_spend_atomic,
      expiresAt: branch.expires_at?.toISOString() ?? null,
    })),
  };
}

export function fingerprintAuthoritativeSetup(setup: AuthoritativeSetup): string {
  return `sha256:${createHash("sha256").update(canonicalJson(setup)).digest("hex")}`;
}

export function validateAuthoritativeSetup(
  intended: AuthoritativeSetup,
  actual: AuthoritativeSetup,
): { fingerprint: string; source: typeof AUTHORITATIVE_SETUP_SOURCE } {
  if (canonicalJson(intended) !== canonicalJson(actual)) {
    throw new Error("EVIDENCE_AUTHORITATIVE_SETUP_MISMATCH");
  }
  return { fingerprint: fingerprintAuthoritativeSetup(actual), source: AUTHORITATIVE_SETUP_SOURCE };
}

export async function withVerifiedAuthoritativeSetup<T>(
  intended: AuthoritativeSetup,
  readPersisted: () => Promise<AuthoritativeSetup>,
  onVerified: (verification: ReturnType<typeof validateAuthoritativeSetup>) => Promise<T>,
): Promise<T> {
  const verification = validateAuthoritativeSetup(intended, await readPersisted());
  return onVerified(verification);
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
