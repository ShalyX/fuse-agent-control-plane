import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  evaluatePolicy,
  validatePolicy,
  type PolicyDecisionResult,
  type PolicyEvaluationInput,
  type PolicyMode,
  type PolicyReasonCode,
  type PolicyVersion,
  type WorkloadClassPolicy,
} from "../domain/policy.js";
import type { ApiCapability } from "../identity/apiCredentials.js";
import type { ProviderResult } from "../core/service.js";
import type {
  AdmissionResult,
  CompletionPersistenceResult,
  InferenceExecutionStore,
} from "../inference/inferenceExecution.js";
import type { MandateState } from "../domain/lifecycles.js";
import { withSchemaBootstrapLock } from "./schemaBootstrap.js";
import {
  evaluateSiblingDivergence,
  type SiblingDivergenceSignal,
} from "../anomaly/siblingDivergence.js";

const mandateTransitions: Record<MandateState, readonly MandateState[]> = {
  draft: ["active", "expired"],
  active: ["paused", "closing", "exhausted", "tripped", "expired", "reconciliation_hold"],
  paused: ["active", "closing", "expired", "reconciliation_hold"],
  closing: ["closed", "reconciliation_hold"],
  closed: [],
  exhausted: ["closing", "reconciliation_hold"],
  tripped: ["active", "closing", "reconciliation_hold"],
  expired: ["closing"],
  reconciliation_hold: ["closing"],
};

export interface PolicyMutationContext {
  actorId: string;
  causationId: string;
  occurredAt: string;
}

export interface CreateControlMandateInput extends PolicyMutationContext {
  id: string;
  organizationId: string;
  name: string;
  assetId: string;
  maximumSpendAtomic: bigint;
  state: MandateState;
  policyId: string;
  policyVersion: number;
  expiresAt: string | null;
}

export interface AssignMandateAgentInput extends PolicyMutationContext {
  organizationId: string;
  mandateId: string;
  agentId: string;
}

export interface CreateMandateBranchInput extends PolicyMutationContext {
  id: string;
  organizationId: string;
  mandateId: string;
  parentBranchId: string | null;
  agentId: string;
  allowedWorkloadClasses: string[];
  maximumSpendAtomic: bigint;
  expiresAt: string | null;
}

export interface MandateBranch {
  id: string;
  organizationId: string;
  mandateId: string;
  parentBranchId: string | null;
  agentId: string;
  policyId: string;
  policyVersion: number;
  allowedWorkloadClasses: string[];
  maximumSpendAtomic: bigint;
  expiresAt: string | null;
  delegationHash: string;
  authoritySource: "fuse_control_plane";
  createdAt: string;
  createdBy: string;
}

export interface ShadowEvaluationRecord {
  requestId: string;
  organizationId: string;
  mandateId: string;
  branchId: string;
  workloadClass: string;
  provider: string;
  model: string;
  cohortKey: string;
  cohortOrdinal: bigint;
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
  wouldSignal: boolean;
  evaluatedAt: string;
}

export interface ExposureSnapshot {
  branchLimitAtomic: bigint;
  branchCommittedBeforeAtomic: bigint;
  requestReservationAtomic: bigint;
  maximumExposureAtomic: bigint;
  remainingAuthorityAtomic: bigint;
}

export interface PolicyDecisionInput {
  id: string;
  requestId: string;
  organizationId: string;
  mandateId: string;
  agentId: string;
  agentCapabilities: ApiCapability[];
  provider: string;
  model: string;
  branchId?: string;
  workloadClass?: string;
  estimatedCostAtomic: bigint;
  inputTokens: number;
  maxOutputTokens: number;
  spentHourAtomic: bigint;
  spentDayAtomic: bigint;
  mandateSpentAtomic: bigint;
  mandateMaximumAtomic: bigint;
  requestCountLastMinute: number;
  workload?: PolicyEvaluationInput["workload"];
  exposure?: ExposureSnapshot;
  decidedAt: string;
}

export interface StoredPolicyDecision {
  id: string;
  requestId: string;
  organizationId: string;
  mandateId: string;
  agentId: string;
  policyId: string;
  policyVersion: number;
  result: PolicyDecisionResult;
  input: PolicyDecisionInput;
}

export interface ReconciliationCase {
  requestId: string;
  mandateId: string;
  agentId: string;
  provider: string;
  model: string;
  reasonCode: string;
  reservedCostAtomic: bigint;
  reportedCostAtomic: bigint | null;
  hasProviderResponse: boolean;
  heldAt: string;
}

export type ReconciliationResolution = "settle" | "confirm_not_billed";

export interface ResolveReconciliationInput extends PolicyMutationContext {
  organizationId: string;
  requestId: string;
  resolution: ReconciliationResolution;
  actualCostAtomic?: bigint;
  note: string;
  externalReference: string;
}

export class PolicyStore implements InferenceExecutionStore {
  private schemaReady?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly options: { supportsSavepoints?: boolean } = {},
  ) {}

  ensureSchema(): Promise<void> {
    this.schemaReady ??= this.createSchema().catch((error) => {
      this.schemaReady = undefined;
      throw error;
    });
    return this.schemaReady;
  }

  async workloadShadowSchemaReady(): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query<{ version: number }>(
      "SELECT version FROM policy_schema_migrations WHERE version IN (4, 5) ORDER BY version",
    );
    return result.rows.length === 2
      && result.rows[0]?.version === 4 && result.rows[1]?.version === 5;
  }

  async publishPolicy(policy: PolicyVersion, context: PolicyMutationContext): Promise<void> {
    context = { ...context };
    policy = {
      ...policy,
      allowedProviders: [...policy.allowedProviders],
      allowedModels: [...policy.allowedModels],
      limits: { ...policy.limits },
      workloadClasses: this.cloneWorkloadClasses(policy.workloadClasses ?? []),
    };
    validatePolicy(policy);
    this.validateContext(context);
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO policy_versions
         (organization_id, policy_id, version, mode, allowed_providers, allowed_models,
          required_capability, max_per_call_atomic, max_hourly_atomic, max_daily_atomic,
          max_requests_per_minute, max_input_tokens, max_output_tokens, workload_classes,
          created_at, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13,
                 $14::jsonb, $15, $16)`,
        [
          policy.organizationId, policy.id, policy.version, policy.mode,
          JSON.stringify(policy.allowedProviders), JSON.stringify(policy.allowedModels),
          policy.requiredCapability, policy.limits.maxPerCallAtomic.toString(),
          policy.limits.maxHourlyAtomic.toString(), policy.limits.maxDailyAtomic.toString(),
          policy.limits.maxRequestsPerMinute, policy.limits.maxInputTokens,
          policy.limits.maxOutputTokens, JSON.stringify(this.serializeWorkloadClasses(policy.workloadClasses ?? [])),
          policy.createdAt, context.actorId,
        ],
      );
      await this.appendAudit(client, {
        organizationId: policy.organizationId,
        entityType: "policy_version",
        entityId: `${policy.id}:${policy.version}`,
        action: "policy.published",
        payload: { policyId: policy.id, version: policy.version, mode: policy.mode },
        ...context,
      });
    });
  }

  async createMandate(input: CreateControlMandateInput): Promise<void> {
    input = { ...input };
    this.validateContext(input);
    if (!input.id.trim()) throw new Error("CONTROL_MANDATE_ID_REQUIRED");
    if (!input.organizationId.trim()) throw new Error("CONTROL_MANDATE_ORGANIZATION_REQUIRED");
    if (!input.name.trim()) throw new Error("CONTROL_MANDATE_NAME_REQUIRED");
    if (!input.assetId.trim()) throw new Error("CONTROL_MANDATE_ASSET_REQUIRED");
    if (input.maximumSpendAtomic <= 0n) throw new Error("CONTROL_MANDATE_MAXIMUM_INVALID");
    if (!Number.isInteger(input.policyVersion) || input.policyVersion < 1) {
      throw new Error("CONTROL_MANDATE_POLICY_VERSION_INVALID");
    }
    if (input.expiresAt !== null && Number.isNaN(Date.parse(input.expiresAt))) {
      throw new Error("CONTROL_MANDATE_EXPIRY_INVALID");
    }
    if (input.state !== "draft") throw new Error("CONTROL_MANDATE_INITIAL_STATE_INVALID");
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO control_mandates
         (id, organization_id, name, asset_id, maximum_spend_atomic, state,
          policy_id, policy_version, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.id, input.organizationId, input.name, input.assetId,
          input.maximumSpendAtomic.toString(), input.state, input.policyId,
          input.policyVersion, input.expiresAt, input.occurredAt,
        ],
      );
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "control_mandate",
        entityId: input.id,
        action: "mandate.created",
        payload: {
          state: input.state,
          assetId: input.assetId,
          maximumSpendAtomic: input.maximumSpendAtomic.toString(),
          policyId: input.policyId,
          policyVersion: input.policyVersion,
          expiresAt: input.expiresAt,
        },
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
      });
    });
  }

  async assignAgent(input: AssignMandateAgentInput): Promise<void> {
    input = { ...input };
    this.validateContext(input);
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO mandate_agent_assignments
         (organization_id, mandate_id, agent_id, assigned_at)
         VALUES ($1, $2, $3, $4)`,
        [input.organizationId, input.mandateId, input.agentId, input.occurredAt],
      );
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "control_mandate",
        entityId: input.mandateId,
        action: "mandate.agent_assigned",
        payload: { agentId: input.agentId },
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
      });
    });
  }

  async createBranch(input: CreateMandateBranchInput): Promise<MandateBranch> {
    input = { ...input, allowedWorkloadClasses: [...input.allowedWorkloadClasses].sort() };
    this.validateContext(input);
    if (!input.id.trim()) throw new Error("MANDATE_BRANCH_ID_REQUIRED");
    if (!input.organizationId.trim()) throw new Error("MANDATE_BRANCH_ORGANIZATION_REQUIRED");
    if (!input.mandateId.trim()) throw new Error("MANDATE_BRANCH_MANDATE_REQUIRED");
    if (!input.agentId.trim()) throw new Error("MANDATE_BRANCH_AGENT_REQUIRED");
    if (input.allowedWorkloadClasses.length === 0
      || input.allowedWorkloadClasses.some((id) => !id.trim())) {
      throw new Error("MANDATE_BRANCH_WORKLOAD_CLASS_REQUIRED");
    }
    if (new Set(input.allowedWorkloadClasses).size !== input.allowedWorkloadClasses.length) {
      throw new Error("MANDATE_BRANCH_WORKLOAD_CLASS_DUPLICATE");
    }
    if (input.maximumSpendAtomic <= 0n) throw new Error("MANDATE_BRANCH_BUDGET_INVALID");
    if (input.expiresAt !== null && (Number.isNaN(Date.parse(input.expiresAt))
      || Date.parse(input.expiresAt) <= Date.parse(input.occurredAt))) {
      throw new Error("MANDATE_BRANCH_EXPIRY_INVALID");
    }
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const mandateResult = await client.query<{
        state: MandateState;
        policy_id: string;
        policy_version: number;
        workload_classes: SerializedWorkloadClass[];
        maximum_spend_atomic: string;
        expires_at: Date | null;
      }>(
        `SELECT mandates.state, mandates.policy_id, mandates.policy_version, policies.workload_classes,
                mandates.maximum_spend_atomic, mandates.expires_at
         FROM control_mandates mandates
         JOIN policy_versions policies
           ON policies.organization_id = mandates.organization_id
          AND policies.policy_id = mandates.policy_id
          AND policies.version = mandates.policy_version
         WHERE mandates.organization_id = $1 AND mandates.id = $2 FOR UPDATE`,
        [input.organizationId, input.mandateId],
      );
      const mandate = mandateResult.rows[0];
      if (!mandate) throw new Error("CONTROL_MANDATE_NOT_FOUND");
      if (mandate.state !== "draft" && mandate.state !== "paused") {
        throw new Error("MANDATE_BRANCH_CHANGE_REQUIRES_PAUSE");
      }
      if (input.maximumSpendAtomic > BigInt(mandate.maximum_spend_atomic)) {
        throw new Error("MANDATE_BRANCH_BUDGET_EXCEEDS_MANDATE");
      }
      if (input.expiresAt !== null && mandate.expires_at !== null
        && Date.parse(input.expiresAt) > mandate.expires_at.getTime()) {
        throw new Error("MANDATE_BRANCH_EXPIRY_EXCEEDS_MANDATE");
      }
      const configuredClasses = new Set(mandate.workload_classes.map(({ id }) => id));
      if (input.allowedWorkloadClasses.some((id) => !configuredClasses.has(id))) {
        throw new Error("MANDATE_BRANCH_WORKLOAD_CLASS_NOT_IN_POLICY");
      }
      const assignment = await client.query(
        `SELECT 1 FROM mandate_agent_assignments
         WHERE organization_id = $1 AND mandate_id = $2 AND agent_id = $3`,
        [input.organizationId, input.mandateId, input.agentId],
      );
      if (assignment.rowCount !== 1) throw new Error("MANDATE_BRANCH_AGENT_NOT_ASSIGNED");
      if (input.parentBranchId !== null) {
        const parent = await client.query<MandateBranchRow>(
          `SELECT * FROM mandate_branches
           WHERE organization_id = $1 AND mandate_id = $2 AND branch_id = $3
           FOR UPDATE`,
          [input.organizationId, input.mandateId, input.parentBranchId],
        );
        const parentRow = parent.rows[0];
        if (!parentRow) throw new Error("MANDATE_PARENT_BRANCH_NOT_FOUND");
        this.verifyBranchIntegrity(parentRow);
        if (parentRow.policy_id !== mandate.policy_id
          || parentRow.policy_version !== mandate.policy_version) {
          throw new Error("MANDATE_PARENT_BRANCH_POLICY_MISMATCH");
        }
        if (input.allowedWorkloadClasses.some(
          (id) => !parentRow.allowed_workload_classes.includes(id),
        )) throw new Error("MANDATE_BRANCH_PARENT_AUTHORITY_EXCEEDED");
        const allocated = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(maximum_spend_atomic), 0)::text AS total
           FROM mandate_branches
           WHERE organization_id = $1 AND mandate_id = $2 AND parent_branch_id = $3`,
          [input.organizationId, input.mandateId, input.parentBranchId],
        );
        if (input.maximumSpendAtomic + BigInt(allocated.rows[0]?.total ?? "0")
          > BigInt(parentRow.maximum_spend_atomic)) {
          throw new Error("MANDATE_BRANCH_PARENT_BUDGET_EXCEEDED");
        }
        if (parentRow.expires_at !== null && (input.expiresAt === null
          || Date.parse(input.expiresAt) > parentRow.expires_at.getTime())) {
          throw new Error("MANDATE_BRANCH_PARENT_EXPIRY_EXCEEDED");
        }
      }
      const createdAt = new Date(input.occurredAt).toISOString();
      const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt).toISOString();
      const canonical = {
        authoritySource: "fuse_control_plane",
        organizationId: input.organizationId,
        mandateId: input.mandateId,
        branchId: input.id,
        parentBranchId: input.parentBranchId,
        agentId: input.agentId,
        policyId: mandate.policy_id,
        policyVersion: mandate.policy_version,
        allowedWorkloadClasses: input.allowedWorkloadClasses,
        maximumSpendAtomic: input.maximumSpendAtomic.toString(),
        expiresAt,
        createdAt,
        createdBy: input.actorId,
      } as const;
      const delegationHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
      await client.query(
        `INSERT INTO mandate_branches
         (organization_id, mandate_id, branch_id, parent_branch_id, agent_id,
          policy_id, policy_version, allowed_workload_classes, maximum_spend_atomic, expires_at,
          delegation_hash, authority_source, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)`,
        [
          input.organizationId, input.mandateId, input.id, input.parentBranchId, input.agentId,
          mandate.policy_id, mandate.policy_version, JSON.stringify(input.allowedWorkloadClasses),
          input.maximumSpendAtomic.toString(), expiresAt, delegationHash, "fuse_control_plane",
          createdAt, input.actorId,
        ],
      );
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "mandate_branch",
        entityId: input.id,
        action: "mandate.branch_created",
        payload: { ...canonical, delegationHash },
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
      });
      return {
        id: canonical.branchId,
        organizationId: canonical.organizationId,
        mandateId: canonical.mandateId,
        parentBranchId: canonical.parentBranchId,
        agentId: canonical.agentId,
        policyId: canonical.policyId,
        policyVersion: canonical.policyVersion,
        allowedWorkloadClasses: [...canonical.allowedWorkloadClasses],
        maximumSpendAtomic: input.maximumSpendAtomic,
        expiresAt,
        delegationHash,
        authoritySource: canonical.authoritySource,
        createdAt: canonical.createdAt,
        createdBy: canonical.createdBy,
      };
    });
  }

  async getBranch(
    organizationId: string,
    mandateId: string,
    branchId: string,
  ): Promise<MandateBranch | null> {
    await this.ensureSchema();
    const result = await this.pool.query<MandateBranchRow>(
      `SELECT * FROM mandate_branches
       WHERE organization_id = $1 AND mandate_id = $2 AND branch_id = $3`,
      [organizationId, mandateId, branchId],
    );
    return result.rows[0] ? this.branchFromRow(result.rows[0]) : null;
  }

  async listShadowEvaluations(
    organizationId: string,
    mandateId: string,
  ): Promise<ShadowEvaluationRecord[]> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const branches = await client.query<MandateBranchRow>(
        `SELECT branch.* FROM mandate_branches branch
         JOIN shadow_evaluations evaluation
           ON evaluation.organization_id = branch.organization_id
          AND evaluation.mandate_id = branch.mandate_id
          AND evaluation.branch_id = branch.branch_id
         WHERE branch.organization_id = $1 AND branch.mandate_id = $2
         FOR UPDATE`,
        [organizationId, mandateId],
      );
      for (const branch of branches.rows) this.verifyBranchIntegrity(branch);
      const result = await client.query<ShadowEvaluationRow>(
        `SELECT * FROM shadow_evaluations
         WHERE organization_id = $1 AND mandate_id = $2
         ORDER BY evaluated_at ASC, request_id ASC`,
        [organizationId, mandateId],
      );
      return result.rows.map((row) => this.shadowEvaluationFromRow(row));
    });
  }

  async transitionMandateState(
    organizationId: string,
    mandateId: string,
    to: MandateState,
    context: PolicyMutationContext,
  ): Promise<void> {
    context = { ...context };
    this.validateContext(context);
    if (!organizationId.trim()) throw new Error("CONTROL_MANDATE_ORGANIZATION_REQUIRED");
    if (!mandateId.trim()) throw new Error("CONTROL_MANDATE_ID_REQUIRED");
    await this.ensureSchema();
    await this.transaction(async (client) => {
      const result = await client.query<{ state: MandateState }>(
        `SELECT state FROM control_mandates
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, mandateId],
      );
      const from = result.rows[0]?.state;
      if (!from) throw new Error("CONTROL_MANDATE_NOT_FOUND");
      if (!mandateTransitions[from].includes(to)) {
        throw new Error(`CONTROL_MANDATE_TRANSITION_INVALID:${from}->${to}`);
      }
      await client.query(
        `UPDATE control_mandates SET state = $3
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, mandateId, to],
      );
      await this.appendAudit(client, {
        organizationId,
        entityType: "control_mandate",
        entityId: mandateId,
        action: "mandate.state_changed",
        payload: { from, to },
        ...context,
      });
    });
  }

  async setMandatePolicy(
    organizationId: string,
    mandateId: string,
    policyId: string,
    policyVersion: number,
    context: PolicyMutationContext,
  ): Promise<void> {
    context = { ...context };
    this.validateContext(context);
    if (!organizationId.trim()) throw new Error("CONTROL_MANDATE_ORGANIZATION_REQUIRED");
    if (!mandateId.trim()) throw new Error("CONTROL_MANDATE_ID_REQUIRED");
    if (!policyId.trim()) throw new Error("CONTROL_MANDATE_POLICY_REQUIRED");
    if (!Number.isInteger(policyVersion) || policyVersion < 1) {
      throw new Error("CONTROL_MANDATE_POLICY_VERSION_INVALID");
    }
    await this.ensureSchema();
    await this.transaction(async (client) => {
      const result = await client.query<{
        policy_id: string;
        policy_version: number;
        state: MandateState;
      }>(
        `SELECT policy_id, policy_version, state FROM control_mandates
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, mandateId],
      );
      const previous = result.rows[0];
      if (!previous) throw new Error("CONTROL_MANDATE_NOT_FOUND");
      if (previous.state !== "draft" && previous.state !== "paused") {
        throw new Error("CONTROL_MANDATE_POLICY_CHANGE_REQUIRES_PAUSE");
      }
      await client.query(
        `UPDATE control_mandates SET policy_id = $3, policy_version = $4
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, mandateId, policyId, policyVersion],
      );
      await this.appendAudit(client, {
        organizationId,
        entityType: "control_mandate",
        entityId: mandateId,
        action: "mandate.policy_changed",
        payload: {
          fromPolicyId: previous.policy_id,
          fromPolicyVersion: previous.policy_version,
          toPolicyId: policyId,
          toPolicyVersion: policyVersion,
        },
        ...context,
      });
    });
  }

  async getPolicy(
    organizationId: string,
    policyId: string,
    version: number,
  ): Promise<PolicyVersion | null> {
    await this.ensureSchema();
    const result = await this.pool.query<PolicyRow>(
      `SELECT * FROM policy_versions
       WHERE organization_id = $1 AND policy_id = $2 AND version = $3`,
      [organizationId, policyId, version],
    );
    return result.rows[0] ? this.policyFromRow(result.rows[0]) : null;
  }

  async evaluateAndRecord(input: PolicyDecisionInput): Promise<StoredPolicyDecision> {
    input = { ...input, agentCapabilities: [...input.agentCapabilities] };
    this.validateDecisionInput(input);
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const mandateResult = await client.query<MandatePolicyRow>(
        `SELECT mandates.state AS mandate_state, mandates.expires_at AS mandate_expires_at,
                mandates.maximum_spend_atomic AS mandate_maximum_spend_atomic,
                mandates.policy_id, mandates.policy_version,
                policies.mode, policies.allowed_providers, policies.allowed_models,
                policies.required_capability, policies.max_per_call_atomic,
                policies.max_hourly_atomic, policies.max_daily_atomic,
                policies.max_requests_per_minute, policies.max_input_tokens,
                policies.max_output_tokens, policies.workload_classes, policies.created_at
         FROM control_mandates mandates
         JOIN policy_versions policies
           ON policies.organization_id = mandates.organization_id
          AND policies.policy_id = mandates.policy_id
          AND policies.version = mandates.policy_version
         WHERE mandates.organization_id = $1 AND mandates.id = $2
         FOR UPDATE`,
        [input.organizationId, input.mandateId],
      );
      const row = mandateResult.rows[0];
      if (!row) throw new Error("CONTROL_MANDATE_NOT_FOUND");
      const assignment = await client.query(
        `SELECT 1 FROM mandate_agent_assignments
         WHERE organization_id = $1 AND mandate_id = $2 AND agent_id = $3`,
        [input.organizationId, input.mandateId, input.agentId],
      );
      const policy: PolicyVersion = {
        id: row.policy_id,
        organizationId: input.organizationId,
        version: row.policy_version,
        mode: row.mode,
        allowedProviders: row.allowed_providers,
        allowedModels: row.allowed_models,
        requiredCapability: row.required_capability,
        limits: {
          maxPerCallAtomic: BigInt(row.max_per_call_atomic),
          maxHourlyAtomic: BigInt(row.max_hourly_atomic),
          maxDailyAtomic: BigInt(row.max_daily_atomic),
          maxRequestsPerMinute: row.max_requests_per_minute,
          maxInputTokens: row.max_input_tokens,
          maxOutputTokens: row.max_output_tokens,
        },
        workloadClasses: this.deserializeWorkloadClasses(row.workload_classes),
        createdAt: row.created_at.toISOString(),
      };
      const evaluation: PolicyEvaluationInput = {
        now: input.decidedAt,
        mandateState: row.mandate_state,
        mandateExpiresAt: row.mandate_expires_at?.toISOString() ?? null,
        agentAuthorized: assignment.rowCount === 1,
        agentCapabilities: input.agentCapabilities,
        provider: input.provider,
        model: input.model,
        estimatedCostAtomic: input.estimatedCostAtomic,
        inputTokens: input.inputTokens,
        maxOutputTokens: input.maxOutputTokens,
        spentHourAtomic: input.spentHourAtomic,
        spentDayAtomic: input.spentDayAtomic,
        mandateSpentAtomic: input.mandateSpentAtomic,
        mandateMaximumAtomic: input.mandateMaximumAtomic,
        requestCountLastMinute: input.requestCountLastMinute,
      };
      const result = evaluatePolicy(policy, evaluation);
      const snapshot = this.serializeDecisionInput(input);
      await client.query(
        `INSERT INTO policy_decisions
         (id, organization_id, request_id, mandate_id, agent_id, policy_id, policy_version,
          outcome, would_outcome, enforced, reason_codes, input_snapshot, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)`,
        [
          input.id, input.organizationId, input.requestId, input.mandateId, input.agentId,
          policy.id, policy.version, result.outcome, result.wouldOutcome, result.enforced,
          JSON.stringify(result.reasonCodes), JSON.stringify(snapshot), input.decidedAt,
        ],
      );
      return {
        id: input.id,
        requestId: input.requestId,
        organizationId: input.organizationId,
        mandateId: input.mandateId,
        agentId: input.agentId,
        policyId: policy.id,
        policyVersion: policy.version,
        result,
        input: { ...input, agentCapabilities: [...input.agentCapabilities] },
      };
    });
  }

  async admitInference(input: {
    requestId: string;
    organizationId: string;
    mandateId: string;
    agentId: string;
    agentCapabilities: ApiCapability[];
    provider: string;
    model: string;
    branchId?: string;
    workloadClass?: string;
    estimatedCostAtomic: bigint;
    inputTokens: number;
    maxOutputTokens: number;
    requestFingerprint: string;
    decidedAt: string;
  }): Promise<AdmissionResult> {
    input = { ...input, agentCapabilities: [...input.agentCapabilities] };
    if (!input.requestId.trim()) throw new Error("POLICY_DECISION_REQUEST_REQUIRED");
    if (!input.organizationId.trim()) throw new Error("POLICY_DECISION_ORGANIZATION_REQUIRED");
    if (!input.mandateId.trim()) throw new Error("POLICY_DECISION_MANDATE_REQUIRED");
    if (!input.agentId.trim()) throw new Error("POLICY_DECISION_AGENT_REQUIRED");
    if (!/^[a-f0-9]{64}$/.test(input.requestFingerprint)) {
      throw new Error("REQUEST_FINGERPRINT_INVALID");
    }
    if (Number.isNaN(Date.parse(input.decidedAt))) throw new Error("POLICY_DECISION_TIME_INVALID");
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const mandateResult = await client.query<MandatePolicyRow>(
        `SELECT mandates.state AS mandate_state, mandates.expires_at AS mandate_expires_at,
                mandates.maximum_spend_atomic AS mandate_maximum_spend_atomic,
                mandates.policy_id, mandates.policy_version,
                policies.mode, policies.allowed_providers, policies.allowed_models,
                policies.required_capability, policies.max_per_call_atomic,
                policies.max_hourly_atomic, policies.max_daily_atomic,
                policies.max_requests_per_minute, policies.max_input_tokens,
                policies.max_output_tokens, policies.workload_classes, policies.created_at
         FROM control_mandates mandates
         JOIN policy_versions policies
           ON policies.organization_id = mandates.organization_id
          AND policies.policy_id = mandates.policy_id
          AND policies.version = mandates.policy_version
         WHERE mandates.organization_id = $1 AND mandates.id = $2
         FOR UPDATE`,
        [input.organizationId, input.mandateId],
      );
      const row = mandateResult.rows[0];
      if (!row) throw new Error("CONTROL_MANDATE_NOT_FOUND");

      const existing = await client.query<InferenceExecutionRow>(
        `SELECT * FROM inference_executions
         WHERE organization_id = $1 AND request_id = $2`,
        [input.organizationId, input.requestId],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        if (existingRow.request_fingerprint !== input.requestFingerprint) {
          throw new Error("IDEMPOTENCY_CONFLICT");
        }
        return this.admissionFromExecution(client, existingRow, input.decidedAt);
      }

      const assignment = await client.query(
        `SELECT 1 FROM mandate_agent_assignments
         WHERE organization_id = $1 AND mandate_id = $2 AND agent_id = $3`,
        [input.organizationId, input.mandateId, input.agentId],
      );
      const decidedAtMs = Date.parse(input.decidedAt);
      const hourStart = new Date(decidedAtMs - 60 * 60 * 1000).toISOString();
      const dayStart = new Date(decidedAtMs - 24 * 60 * 60 * 1000).toISOString();
      const minuteStart = new Date(decidedAtMs - 60 * 1000).toISOString();
      const counters = await client.query<{
        spent_hour_atomic: string;
        spent_day_atomic: string;
        mandate_spent_atomic: string;
        request_count_last_minute: number;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN created_at >= $3 AND (status IN ('executing','completed','reconciliation_hold')
             OR failure_code = 'RECONCILED_BILLED_NO_RESPONSE')
             THEN CASE WHEN status = 'completed' OR failure_code = 'RECONCILED_BILLED_NO_RESPONSE'
               THEN actual_cost_atomic ELSE reserved_cost_atomic END
             ELSE 0 END), 0)::text AS spent_hour_atomic,
           COALESCE(SUM(CASE WHEN created_at >= $4 AND (status IN ('executing','completed','reconciliation_hold')
             OR failure_code = 'RECONCILED_BILLED_NO_RESPONSE')
             THEN CASE WHEN status = 'completed' OR failure_code = 'RECONCILED_BILLED_NO_RESPONSE'
               THEN actual_cost_atomic ELSE reserved_cost_atomic END
             ELSE 0 END), 0)::text AS spent_day_atomic,
           COALESCE(SUM(CASE WHEN (status IN ('executing','completed','reconciliation_hold')
             OR failure_code = 'RECONCILED_BILLED_NO_RESPONSE')
             THEN CASE WHEN status = 'completed' OR failure_code = 'RECONCILED_BILLED_NO_RESPONSE'
               THEN actual_cost_atomic ELSE reserved_cost_atomic END
             ELSE 0 END), 0)::text AS mandate_spent_atomic,
           COALESCE(SUM(CASE WHEN created_at >= $5 AND status <> 'denied' THEN 1 ELSE 0 END), 0)::int
             AS request_count_last_minute
         FROM inference_executions
         WHERE organization_id = $1 AND mandate_id = $2`,
        [input.organizationId, input.mandateId, hourStart, dayStart, minuteStart],
      );
      const counter = counters.rows[0] ?? {
        spent_hour_atomic: "0", spent_day_atomic: "0", mandate_spent_atomic: "0",
        request_count_last_minute: 0,
      };
      let workload: PolicyEvaluationInput["workload"];
      let branch: MandateBranchRow | undefined;
      const usageByClass = new Map<string, { invocationCount: number; spentAtomic: bigint }>();
      if (input.branchId && input.workloadClass) {
        const branchResult = await client.query<MandateBranchRow>(
          `SELECT * FROM mandate_branches
           WHERE organization_id = $1 AND mandate_id = $2 AND branch_id = $3`,
          [input.organizationId, input.mandateId, input.branchId],
        );
        branch = branchResult.rows[0];
        if (branch) this.verifyBranchIntegrity(branch);
        const usage = await client.query<WorkloadUsageRow>(
          `SELECT workload_class,
                  COALESCE(SUM(CASE WHEN status <> 'denied' THEN 1 ELSE 0 END), 0)::int
                    AS invocation_count,
                  COALESCE(SUM(CASE
                    WHEN status IN ('executing', 'reconciliation_hold') THEN reserved_cost_atomic
                    WHEN status = 'completed' OR failure_code = 'RECONCILED_BILLED_NO_RESPONSE'
                      THEN actual_cost_atomic
                    ELSE 0 END), 0)::text AS spent_atomic
           FROM inference_executions
           WHERE organization_id = $1 AND mandate_id = $2 AND branch_id = $3
             AND workload_class IS NOT NULL
           GROUP BY workload_class`,
          [input.organizationId, input.mandateId, input.branchId],
        );
        for (const row of usage.rows) {
          usageByClass.set(row.workload_class, {
            invocationCount: Number(row.invocation_count),
            spentAtomic: BigInt(row.spent_atomic),
          });
        }
        const classUsage = usageByClass.get(input.workloadClass);
        const childAuthority = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(maximum_spend_atomic), 0)::text AS total
           FROM mandate_branches
           WHERE organization_id = $1 AND mandate_id = $2 AND parent_branch_id = $3`,
          [input.organizationId, input.mandateId, input.branchId],
        );
        const branchSpentAtomic = [...usageByClass.values()]
          .reduce((total, current) => total + current.spentAtomic, 0n)
          + BigInt(childAuthority.rows[0]?.total ?? "0");
        workload = {
          branchId: input.branchId,
          workloadClass: input.workloadClass,
          branchAuthorized: Boolean(branch
            && branch.agent_id === input.agentId
            && branch.policy_id === row.policy_id
            && branch.policy_version === row.policy_version),
          branchMaximumAtomic: branch ? BigInt(branch.maximum_spend_atomic) : 0n,
          branchSpentAtomic,
          branchExpiresAt: branch?.expires_at?.toISOString() ?? null,
          classAuthorized: Boolean(branch?.allowed_workload_classes.includes(input.workloadClass)),
          classInvocationCount: classUsage?.invocationCount ?? 0,
          classSpentAtomic: classUsage?.spentAtomic ?? 0n,
        };
      }
      const policy: PolicyVersion = {
        id: row.policy_id,
        organizationId: input.organizationId,
        version: row.policy_version,
        mode: row.mode,
        allowedProviders: row.allowed_providers,
        allowedModels: row.allowed_models,
        requiredCapability: row.required_capability,
        limits: {
          maxPerCallAtomic: BigInt(row.max_per_call_atomic),
          maxHourlyAtomic: BigInt(row.max_hourly_atomic),
          maxDailyAtomic: BigInt(row.max_daily_atomic),
          maxRequestsPerMinute: row.max_requests_per_minute,
          maxInputTokens: row.max_input_tokens,
          maxOutputTokens: row.max_output_tokens,
        },
        workloadClasses: this.deserializeWorkloadClasses(row.workload_classes),
        createdAt: row.created_at.toISOString(),
      };
      const decisionInput: PolicyDecisionInput = {
        id: randomUUID(),
        ...input,
        spentHourAtomic: BigInt(counter.spent_hour_atomic),
        spentDayAtomic: BigInt(counter.spent_day_atomic),
        mandateSpentAtomic: BigInt(counter.mandate_spent_atomic),
        mandateMaximumAtomic: BigInt(row.mandate_maximum_spend_atomic),
        requestCountLastMinute: Number(counter.request_count_last_minute),
        ...(workload ? { workload } : {}),
      };
      const evaluation = evaluatePolicy(policy, {
        now: input.decidedAt,
        mandateState: row.mandate_state,
        mandateExpiresAt: row.mandate_expires_at?.toISOString() ?? null,
        agentAuthorized: assignment.rowCount === 1,
        agentCapabilities: input.agentCapabilities,
        provider: input.provider,
        model: input.model,
        estimatedCostAtomic: input.estimatedCostAtomic,
        inputTokens: input.inputTokens,
        maxOutputTokens: input.maxOutputTokens,
        spentHourAtomic: decisionInput.spentHourAtomic,
        spentDayAtomic: decisionInput.spentDayAtomic,
        mandateSpentAtomic: decisionInput.mandateSpentAtomic,
        mandateMaximumAtomic: decisionInput.mandateMaximumAtomic,
        requestCountLastMinute: decisionInput.requestCountLastMinute,
        ...(workload ? { workload } : {}),
      });
      if (workload?.branchAuthorized && branch) {
        const allowedClasses = (policy.workloadClasses ?? [])
          .filter(({ id }) => branch!.allowed_workload_classes.includes(id));
        const branchLimitAtomic = BigInt(branch.maximum_spend_atomic);
        const branchCommittedBeforeAtomic = allowedClasses.reduce(
          (total, configured) => total + (usageByClass.get(configured.id)?.spentAtomic ?? 0n),
          0n,
        );
        const classAuthorityRemainingAtomic = allowedClasses.reduce((total, configured) => {
          const spent = usageByClass.get(configured.id)?.spentAtomic ?? 0n;
          return total + (configured.aggregateBudgetAtomic > spent
            ? configured.aggregateBudgetAtomic - spent : 0n);
        }, 0n);
        const lifetimeRemainingAtomic = branchLimitAtomic > branchCommittedBeforeAtomic
          ? branchLimitAtomic - branchCommittedBeforeAtomic : 0n;
        const branchRemainingBeforeAtomic = classAuthorityRemainingAtomic < lifetimeRemainingAtomic
          ? classAuthorityRemainingAtomic : lifetimeRemainingAtomic;
        const mandateRemainingBeforeAtomic = decisionInput.mandateMaximumAtomic
          > decisionInput.mandateSpentAtomic
          ? decisionInput.mandateMaximumAtomic - decisionInput.mandateSpentAtomic : 0n;
        const maximumExposureAtomic = branchRemainingBeforeAtomic < mandateRemainingBeforeAtomic
          ? branchRemainingBeforeAtomic : mandateRemainingBeforeAtomic;
        const requestReservationAtomic = evaluation.outcome === "ALLOW"
          ? input.estimatedCostAtomic : 0n;
        decisionInput.exposure = {
          branchLimitAtomic,
          branchCommittedBeforeAtomic,
          requestReservationAtomic,
          maximumExposureAtomic,
          remainingAuthorityAtomic: maximumExposureAtomic > requestReservationAtomic
            ? maximumExposureAtomic - requestReservationAtomic : 0n,
        };
      }
      await client.query(
        `INSERT INTO policy_decisions
         (id, organization_id, request_id, mandate_id, agent_id, policy_id, policy_version,
          outcome, would_outcome, enforced, reason_codes, input_snapshot, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)`,
        [
          decisionInput.id, input.organizationId, input.requestId, input.mandateId, input.agentId,
          policy.id, policy.version, evaluation.outcome, evaluation.wouldOutcome,
          evaluation.enforced, JSON.stringify(evaluation.reasonCodes),
          JSON.stringify(this.serializeDecisionInput(decisionInput)), input.decidedAt,
        ],
      );
      const decision: StoredPolicyDecision = {
        id: decisionInput.id,
        requestId: input.requestId,
        organizationId: input.organizationId,
        mandateId: input.mandateId,
        agentId: input.agentId,
        policyId: policy.id,
        policyVersion: policy.version,
        result: evaluation,
        input: decisionInput,
      };
      const status = evaluation.outcome === "ALLOW" ? "executing" : "denied";
      const reservation = evaluation.outcome === "ALLOW" ? input.estimatedCostAtomic : 0n;
      await client.query(
        `INSERT INTO inference_executions
         (organization_id, request_id, mandate_id, agent_id, decision_id, provider, model,
          branch_id, workload_class, request_fingerprint, status, reserved_cost_atomic,
          input_tokens, max_output_tokens, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
        [
          input.organizationId, input.requestId, input.mandateId, input.agentId,
          decision.id, input.provider, input.model, input.branchId ?? null, input.workloadClass ?? null,
          input.requestFingerprint, status, reservation.toString(), input.inputTokens,
          input.maxOutputTokens, input.decidedAt,
        ],
      );
      return evaluation.outcome === "ALLOW"
        ? { status: "execute", decision, reservedCostAtomic: reservation }
        : { status: "denied", decision };
    });
  }

  async completeInference(input: {
    requestId: string;
    organizationId: string;
    actualCostAtomic: bigint;
    response: ProviderResult;
    completedAt: string;
  }): Promise<CompletionPersistenceResult> {
    if (input.actualCostAtomic < 0n) throw new Error("ACTUAL_COST_INVALID");
    await this.ensureSchema();
    const completion = await this.transaction(async (client) => {
      const execution = await client.query<InferenceExecutionRow>(
        `SELECT * FROM inference_executions
         WHERE organization_id = $1 AND request_id = $2 FOR UPDATE`,
        [input.organizationId, input.requestId],
      );
      const row = execution.rows[0];
      if (!row) throw new Error("INFERENCE_EXECUTION_NOT_FOUND");
      if (row.status !== "executing") throw new Error("INFERENCE_EXECUTION_NOT_EXECUTING");
      const reservedCostAtomic = BigInt(row.reserved_cost_atomic);
      if (input.actualCostAtomic > reservedCostAtomic) {
        await client.query(
          `UPDATE inference_executions
           SET status = 'reconciliation_hold', actual_cost_atomic = $3,
               response_json = $4::jsonb, updated_at = $5
           WHERE organization_id = $1 AND request_id = $2`,
          [input.organizationId, input.requestId, input.actualCostAtomic.toString(),
            JSON.stringify(input.response), input.completedAt],
        );
        await this.holdMandateForReconciliation(client, input.organizationId, row.mandate_id);
        return {
          result: {
            status: "reconciliation_hold" as const,
            reservedCostAtomic,
            actualCostAtomic: input.actualCostAtomic,
            response: input.response,
          },
          shadowQueued: false,
        };
      }
      await client.query(
        `UPDATE inference_executions
         SET status = 'completed', actual_cost_atomic = $3,
             response_json = $4::jsonb, updated_at = $5
         WHERE organization_id = $1 AND request_id = $2`,
        [input.organizationId, input.requestId, input.actualCostAtomic.toString(),
          JSON.stringify(input.response), input.completedAt],
      );
      const shadowQueued = await this.queueShadowBookkeepingBestEffort(
        client,
        { ...row, status: "completed", actual_cost_atomic: input.actualCostAtomic.toString(),
          response_json: input.response, updated_at: new Date(input.completedAt) },
        input.completedAt,
      );
      return {
        result: {
          status: "completed" as const,
          reservedCostAtomic,
          actualCostAtomic: input.actualCostAtomic,
          response: input.response,
        },
        shadowQueued,
      };
    });
    if (!completion.shadowQueued || completion.result.status !== "completed") return completion.result;
    const shadowEvaluation = await this.processShadowEvaluationBestEffort(
      input.organizationId,
      input.requestId,
      input.completedAt,
    );
    return {
      ...completion.result,
      ...(shadowEvaluation ? { shadowEvaluation } : {}),
    };
  }

  async holdInference(input: {
    requestId: string;
    organizationId: string;
    reasonCode: string;
    response?: ProviderResult;
    heldAt: string;
  }): Promise<void> {
    if (!/^[A-Z0-9_]{3,64}$/.test(input.reasonCode)) throw new Error("HOLD_REASON_INVALID");
    await this.ensureSchema();
    await this.transaction(async (client) => {
      const execution = await client.query<InferenceExecutionRow>(
        `SELECT * FROM inference_executions
         WHERE organization_id = $1 AND request_id = $2 FOR UPDATE`,
        [input.organizationId, input.requestId],
      );
      const row = execution.rows[0];
      if (!row || row.status !== "executing") throw new Error("EXECUTION_NOT_ACTIVE");
      await client.query(
        `UPDATE inference_executions
         SET status = 'reconciliation_hold', response_json = $3::jsonb,
             failure_code = $4, updated_at = $5
         WHERE organization_id = $1 AND request_id = $2`,
        [input.organizationId, input.requestId,
          input.response === undefined ? null : JSON.stringify(input.response),
          input.reasonCode, input.heldAt],
      );
      await this.holdMandateForReconciliation(client, input.organizationId, row.mandate_id);
    });
  }

  async failInference(input: {
    requestId: string;
    organizationId: string;
    failureCode: string;
    failedAt: string;
  }): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE inference_executions
       SET status = 'failed', failure_code = $3, updated_at = $4
       WHERE organization_id = $1 AND request_id = $2 AND status = 'executing'`,
      [input.organizationId, input.requestId, input.failureCode, input.failedAt],
    );
  }

  async listReconciliationCases(organizationId: string): Promise<ReconciliationCase[]> {
    if (!organizationId.trim()) throw new Error("RECONCILIATION_ORGANIZATION_REQUIRED");
    await this.ensureSchema();
    const result = await this.pool.query<{
      request_id: string;
      mandate_id: string;
      agent_id: string;
      provider: string;
      model: string;
      failure_code: string | null;
      reserved_cost_atomic: string;
      actual_cost_atomic: string | null;
      response_json: ProviderResult | null;
      updated_at: Date;
    }>(
      `SELECT execution.request_id, execution.mandate_id, execution.agent_id,
              execution.provider, execution.model, execution.failure_code,
              execution.reserved_cost_atomic::text, execution.actual_cost_atomic::text,
              execution.response_json, execution.updated_at
       FROM inference_executions AS execution
       LEFT JOIN reconciliation_resolutions AS resolution
         ON resolution.organization_id = execution.organization_id
        AND resolution.request_id = execution.request_id
       WHERE execution.organization_id = $1
         AND execution.status = 'reconciliation_hold'
         AND resolution.request_id IS NULL
       ORDER BY execution.updated_at ASC, execution.request_id ASC`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      requestId: row.request_id,
      mandateId: row.mandate_id,
      agentId: row.agent_id,
      provider: row.provider,
      model: row.model,
      reasonCode: row.failure_code ?? "COST_OVERRUN",
      reservedCostAtomic: BigInt(row.reserved_cost_atomic),
      reportedCostAtomic: row.actual_cost_atomic === null ? null : BigInt(row.actual_cost_atomic),
      hasProviderResponse: row.response_json !== null,
      heldAt: row.updated_at.toISOString(),
    }));
  }

  async resolveReconciliation(input: ResolveReconciliationInput): Promise<void> {
    input = { ...input };
    this.validateContext(input);
    if (!input.organizationId.trim()) throw new Error("RECONCILIATION_ORGANIZATION_REQUIRED");
    if (!input.requestId.trim()) throw new Error("RECONCILIATION_REQUEST_REQUIRED");
    if (!input.note.trim() || input.note.length > 2_000) throw new Error("RECONCILIATION_NOTE_INVALID");
    if (!input.externalReference.trim() || input.externalReference.length > 512) {
      throw new Error("RECONCILIATION_REFERENCE_INVALID");
    }
    if (input.resolution === "settle") {
      if (input.actualCostAtomic === undefined || input.actualCostAtomic < 0n) {
        throw new Error("RECONCILIATION_ACTUAL_COST_REQUIRED");
      }
    } else if (input.resolution === "confirm_not_billed") {
      if (input.actualCostAtomic !== undefined) throw new Error("RECONCILIATION_ACTUAL_COST_FORBIDDEN");
    } else {
      throw new Error("RECONCILIATION_RESOLUTION_INVALID");
    }
    await this.ensureSchema();
    const shadowQueued = await this.transaction(async (client) => {
      const execution = await client.query<InferenceExecutionRow>(
        `SELECT * FROM inference_executions
         WHERE organization_id = $1 AND request_id = $2 FOR UPDATE`,
        [input.organizationId, input.requestId],
      );
      const row = execution.rows[0];
      if (!row) throw new Error("INFERENCE_EXECUTION_NOT_FOUND");
      const actualCostAtomic = input.resolution === "settle" ? input.actualCostAtomic! : 0n;
      const prior = await client.query<{
        resolution: ReconciliationResolution;
        actual_cost_atomic: string;
        note: string;
        external_reference: string;
        resolved_by: string;
      }>(
        `SELECT resolution, actual_cost_atomic::text, note, external_reference, resolved_by
         FROM reconciliation_resolutions
         WHERE organization_id = $1 AND request_id = $2`,
        [input.organizationId, input.requestId],
      );
      const existing = prior.rows[0];
      if (existing) {
        const exactReplay = existing.resolution === input.resolution
          && BigInt(existing.actual_cost_atomic) === actualCostAtomic
          && existing.note === input.note
          && existing.external_reference === input.externalReference
          && existing.resolved_by === input.actorId;
        if (!exactReplay) throw new Error("RECONCILIATION_RESOLUTION_CONFLICT");
        return Boolean(row.status === "completed" && row.branch_id && row.workload_class);
      }
      if (row.status !== "reconciliation_hold") throw new Error("RECONCILIATION_CASE_NOT_OPEN");
      await client.query(
        `INSERT INTO reconciliation_resolutions
         (organization_id, request_id, resolution, actual_cost_atomic, note,
          external_reference, resolved_by, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [input.organizationId, input.requestId, input.resolution, actualCostAtomic.toString(),
          input.note, input.externalReference, input.actorId, input.occurredAt],
      );
      await client.query(
        input.resolution === "settle" && row.response_json !== null
          ? `UPDATE inference_executions
             SET status = 'completed', actual_cost_atomic = $3, failure_code = NULL, updated_at = $4
             WHERE organization_id = $1 AND request_id = $2`
          : input.resolution === "settle"
            ? `UPDATE inference_executions
               SET status = 'failed', actual_cost_atomic = $3,
                   failure_code = 'RECONCILED_BILLED_NO_RESPONSE', updated_at = $4
               WHERE organization_id = $1 AND request_id = $2`
            : `UPDATE inference_executions
               SET status = 'failed', actual_cost_atomic = $3,
                   failure_code = 'RECONCILED_NOT_BILLED', updated_at = $4
               WHERE organization_id = $1 AND request_id = $2`,
        [input.organizationId, input.requestId, actualCostAtomic.toString(), input.occurredAt],
      );
      const mayCompleteWithScope = input.resolution === "settle" && row.response_json !== null
        && Boolean(row.branch_id && row.workload_class);
      const completedWithScope = mayCompleteWithScope
        ? await this.queueShadowBookkeepingBestEffort(
          client,
          { ...row, status: "completed", actual_cost_atomic: actualCostAtomic.toString(),
            updated_at: new Date(input.occurredAt) },
          input.occurredAt,
        )
        : false;
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "inference_execution",
        entityId: input.requestId,
        action: `reconciliation.${input.resolution}`,
        payload: {
          resolution: input.resolution,
          actualCostAtomic: actualCostAtomic.toString(),
          externalReference: input.externalReference,
        },
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
      });
      const mandate = await client.query<{ state: MandateState }>(
        `SELECT state FROM control_mandates
         WHERE organization_id = $1 AND id = $2
         FOR UPDATE`,
        [input.organizationId, row.mandate_id],
      );
      const state = mandate.rows[0]?.state;
      if (!state) throw new Error("CONTROL_MANDATE_NOT_FOUND");
      const hold = await client.query<{ prior_state: MandateState }>(
        `SELECT prior_state FROM mandate_reconciliation_holds
         WHERE organization_id = $1 AND mandate_id = $2`,
        [input.organizationId, row.mandate_id],
      );
      const lifecycle = { state, prior_state: hold.rows[0]?.prior_state ?? null };
      const openCases = await client.query(
        `SELECT 1 FROM inference_executions AS execution
         LEFT JOIN reconciliation_resolutions AS resolution
           ON resolution.organization_id = execution.organization_id
          AND resolution.request_id = execution.request_id
         WHERE execution.organization_id = $1 AND execution.mandate_id = $2
           AND execution.status = 'reconciliation_hold'
           AND resolution.request_id IS NULL
         LIMIT 1`,
        [input.organizationId, row.mandate_id],
      );
      if (openCases.rowCount === 0) {
        if (!lifecycle.prior_state) {
          if (lifecycle.state !== "closed" && lifecycle.state !== "expired") {
            throw new Error("RECONCILIATION_MANDATE_STATE_MISSING");
          }
        } else {
          if (lifecycle.state === "reconciliation_hold") {
            const restoredState = lifecycle.prior_state === "active" ? "paused" : lifecycle.prior_state;
            await client.query(
              `UPDATE control_mandates SET state = $3
               WHERE organization_id = $1 AND id = $2 AND state = 'reconciliation_hold'`,
              [input.organizationId, row.mandate_id, restoredState],
            );
          } else if (lifecycle.state !== "closing") {
            throw new Error(`RECONCILIATION_MANDATE_STATE_CONFLICT:${lifecycle.state}`);
          }
          await client.query(
            `DELETE FROM mandate_reconciliation_holds
             WHERE organization_id = $1 AND mandate_id = $2`,
            [input.organizationId, row.mandate_id],
          );
        }
      }
      return completedWithScope;
    });
    if (shadowQueued) {
      await this.processShadowEvaluationBestEffort(
        input.organizationId, input.requestId, input.occurredAt,
      );
    }
  }

  async listDecisions(organizationId: string, mandateId: string): Promise<StoredPolicyDecision[]> {
    await this.ensureSchema();
    const result = await this.pool.query<DecisionRow>(
      `SELECT * FROM policy_decisions
       WHERE organization_id = $1 AND mandate_id = $2
       ORDER BY decided_at ASC, id ASC`,
      [organizationId, mandateId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      organizationId: row.organization_id,
      mandateId: row.mandate_id,
      agentId: row.agent_id,
      policyId: row.policy_id,
      policyVersion: row.policy_version,
      result: {
        outcome: row.outcome,
        wouldOutcome: row.would_outcome,
        enforced: row.enforced,
        reasonCodes: row.reason_codes,
      },
      input: this.deserializeDecisionInput(row.input_snapshot),
    }));
  }

  private async enqueueShadowEvaluation(
    client: PoolClient,
    organizationId: string,
    requestId: string,
    queuedAt: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO shadow_evaluation_queue
       (organization_id, request_id, state, attempts, queued_at, updated_at)
       VALUES ($1, $2, 'pending', 0, $3, $3)
       ON CONFLICT (organization_id, request_id) DO NOTHING`,
      [organizationId, requestId, queuedAt],
    );
  }

  private async queueShadowBookkeepingBestEffort(
    client: PoolClient,
    execution: InferenceExecutionRow,
    queuedAt: string,
  ): Promise<boolean> {
    if (!execution.branch_id || !execution.workload_class) return false;
    const supportsSavepoints = this.options.supportsSavepoints !== false;
    if (supportsSavepoints) await client.query("SAVEPOINT shadow_bookkeeping");
    try {
      const scope = await this.assignShadowCohortOrdinal(client, execution);
      if (!scope) {
        await client.query(
          `UPDATE inference_executions SET shadow_order_state = 'not_applicable'
           WHERE organization_id = $1 AND request_id = $2`,
          [execution.organization_id, execution.request_id],
        );
        if (supportsSavepoints) await client.query("RELEASE SAVEPOINT shadow_bookkeeping");
        return false;
      }
      await this.enqueueShadowEvaluation(
        client, execution.organization_id, execution.request_id, queuedAt,
      );
      await client.query(
        `UPDATE inference_executions SET shadow_order_state = 'queued'
         WHERE organization_id = $1 AND request_id = $2`,
        [execution.organization_id, execution.request_id],
      );
      if (supportsSavepoints) await client.query("RELEASE SAVEPOINT shadow_bookkeeping");
      return true;
    } catch {
      if (supportsSavepoints) await client.query("ROLLBACK TO SAVEPOINT shadow_bookkeeping");
      await client.query(
        `UPDATE inference_executions SET shadow_order_state = 'failed'
         WHERE organization_id = $1 AND request_id = $2`,
        [execution.organization_id, execution.request_id],
      );
      if (supportsSavepoints) await client.query("RELEASE SAVEPOINT shadow_bookkeeping");
      return false;
    }
  }

  private async assignShadowCohortOrdinal(
    client: PoolClient,
    execution: InferenceExecutionRow,
  ): Promise<{ cohortKey: string; cohortOrdinal: bigint } | undefined> {
    if (!execution.branch_id || !execution.workload_class) return undefined;
    const branchResult = await client.query<MandateBranchRow>(
      `SELECT * FROM mandate_branches
       WHERE organization_id = $1 AND mandate_id = $2 AND branch_id = $3`,
      [execution.organization_id, execution.mandate_id, execution.branch_id],
    );
    const branch = branchResult.rows[0];
    if (!branch) throw new Error("MANDATE_BRANCH_NOT_FOUND");
    this.verifyBranchIntegrity(branch);
    if (!branch.parent_branch_id) return undefined;
    const shadowPolicy = await client.query<{ workload_classes: SerializedWorkloadClass[] }>(
      `SELECT workload_classes FROM policy_versions
       WHERE organization_id = $1 AND policy_id = $2 AND version = $3`,
      [execution.organization_id, branch.policy_id, branch.policy_version],
    );
    const shadowClass = this.deserializeWorkloadClasses(
      shadowPolicy.rows[0]?.workload_classes ?? [],
    ).find(({ id }) => id === execution.workload_class);
    if (!shadowClass?.shadow) return undefined;
    const cohortEnvelope = {
      organizationId: execution.organization_id,
      mandateId: execution.mandate_id,
      parentBranchId: branch.parent_branch_id,
      workloadClass: execution.workload_class,
      provider: execution.provider,
      model: execution.model,
      policyId: branch.policy_id,
      policyVersion: branch.policy_version,
    } as const;
    const cohortKey = createHash("sha256")
      .update(JSON.stringify(cohortEnvelope))
      .digest("hex");
    const counter = await client.query<{ last_ordinal: string }>(
      `INSERT INTO shadow_cohort_counters
       (organization_id, cohort_key, last_ordinal, updated_at)
       VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (organization_id, cohort_key) DO UPDATE
       SET last_ordinal = shadow_cohort_counters.last_ordinal + 1,
           updated_at = EXCLUDED.updated_at
       RETURNING last_ordinal::text`,
      [execution.organization_id, cohortKey],
    );
    const cohortOrdinal = BigInt(counter.rows[0]!.last_ordinal);
    await client.query(
      `UPDATE inference_executions
       SET shadow_cohort_key = $3, shadow_cohort_ordinal = $4,
           shadow_completed_at = clock_timestamp()
       WHERE organization_id = $1 AND request_id = $2`,
      [execution.organization_id, execution.request_id, cohortKey, cohortOrdinal.toString()],
    );
    return { cohortKey, cohortOrdinal };
  }

  private async processShadowEvaluationBestEffort(
    organizationId: string,
    requestId: string,
    evaluatedAt: string,
  ): Promise<ShadowEvaluationRecord | undefined> {
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    try {
      const claimed = await this.transaction(async (client) => {
        const queue = await client.query<{
          state: string; attempts: number; claim_token: string | null; lease_expires_at: Date | null;
        }>(
          `SELECT state, attempts, claim_token, lease_expires_at
           FROM shadow_evaluation_queue
           WHERE organization_id = $1 AND request_id = $2 FOR UPDATE`,
          [organizationId, requestId],
        );
        const job = queue.rows[0];
        if (!job || job.state === "completed" || job.attempts >= 3) {
          const existing = await client.query<ShadowEvaluationRow>(
            `SELECT * FROM shadow_evaluations
             WHERE organization_id = $1 AND request_id = $2`,
            [organizationId, requestId],
          );
          return { acquired: false as const,
            evidence: existing.rows[0] ? this.shadowEvaluationFromRow(existing.rows[0]) : undefined };
        }
        if (job.claim_token && job.lease_expires_at
          && job.lease_expires_at.getTime() > Date.now()) {
          return { acquired: false as const, evidence: undefined };
        }
        await client.query(
          `UPDATE shadow_evaluation_queue
           SET attempts = attempts + 1, claim_token = $3, lease_expires_at = $4,
               last_error = NULL, updated_at = $5
           WHERE organization_id = $1 AND request_id = $2`,
          [organizationId, requestId, claimToken, leaseExpiresAt, evaluatedAt],
        );
        return { acquired: true as const, evidence: undefined };
      });
      if (!claimed.acquired) return claimed.evidence;
      return await this.transaction(async (client) => {
        const ownership = await client.query<{ claim_token: string | null }>(
          `SELECT claim_token FROM shadow_evaluation_queue
           WHERE organization_id = $1 AND request_id = $2 FOR UPDATE`,
          [organizationId, requestId],
        );
        if (ownership.rows[0]?.claim_token !== claimToken) return undefined;
        const execution = await client.query<InferenceExecutionRow>(
          `SELECT * FROM inference_executions
           WHERE organization_id = $1 AND request_id = $2 AND status = 'completed'`,
          [organizationId, requestId],
        );
        const row = execution.rows[0];
        if (!row) return undefined;
        const evidence = await this.evaluateAndPersistShadow(client, row);
        await client.query(
          `UPDATE shadow_evaluation_queue
           SET state = 'completed', claim_token = NULL, lease_expires_at = NULL,
               last_error = NULL, updated_at = $3
           WHERE organization_id = $1 AND request_id = $2 AND claim_token = $4`,
          [organizationId, requestId, evaluatedAt, claimToken],
        );
        return evidence;
      });
    } catch {
      try {
        await this.pool.query(
          `UPDATE shadow_evaluation_queue
           SET state = 'failed', claim_token = NULL, lease_expires_at = NULL,
               last_error = 'SHADOW_EVALUATION_FAILED', updated_at = $3
           WHERE organization_id = $1 AND request_id = $2
             AND claim_token = $4
             AND state IN ('pending', 'failed')
             AND attempts <= 3
             AND NOT EXISTS (
               SELECT 1 FROM shadow_evaluations evidence
               WHERE evidence.organization_id = $1 AND evidence.request_id = $2
             )`,
          [organizationId, requestId, evaluatedAt, claimToken],
        );
      } catch {
        // Shadow telemetry must never alter the authoritative completion result.
      }
      return undefined;
    }
  }

  async retryPendingShadowEvaluations(limit = 20): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("SHADOW_RETRY_LIMIT_INVALID");
    }
    await this.ensureSchema();
    const queued = await this.pool.query<{ organization_id: string; request_id: string; queued_at: Date }>(
      `SELECT organization_id, request_id, queued_at FROM shadow_evaluation_queue
       WHERE state IN ('pending', 'failed') AND attempts < 3
         AND (claim_token IS NULL OR lease_expires_at <= clock_timestamp())
       ORDER BY queued_at, request_id LIMIT $1`,
      [limit],
    );
    let completed = 0;
    for (const row of queued.rows) {
      const evidence = await this.processShadowEvaluationBestEffort(
        row.organization_id, row.request_id, row.queued_at.toISOString(),
      );
      if (evidence) completed += 1;
    }
    return completed;
  }

  async shadowQueueStatus(): Promise<{
    pending: number; retryable: number; exhausted: number; completed: number;
  }> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      pending: number; retryable: number; exhausted: number; completed: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending,
         COALESCE(SUM(CASE WHEN state = 'failed' AND attempts < 3 THEN 1 ELSE 0 END), 0)::int
           AS retryable,
         COALESCE(SUM(CASE WHEN state = 'failed' AND attempts >= 3 THEN 1 ELSE 0 END), 0)::int
           AS exhausted,
         COALESCE(SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed
       FROM shadow_evaluation_queue`,
    );
    return result.rows[0] ?? { pending: 0, retryable: 0, exhausted: 0, completed: 0 };
  }

  private async evaluateAndPersistShadow(
    client: PoolClient,
    execution: InferenceExecutionRow,
  ): Promise<ShadowEvaluationRecord | undefined> {
    if (!execution.branch_id || !execution.workload_class) return undefined;
    if (!execution.shadow_cohort_key || execution.shadow_cohort_ordinal === null
      || execution.shadow_completed_at === null) {
      throw new Error("SHADOW_COHORT_ORDER_MISSING");
    }
    const canonicalEvaluatedAt = execution.shadow_completed_at.toISOString();
    const branchResult = await client.query<MandateBranchRow>(
      `SELECT * FROM mandate_branches
       WHERE organization_id = $1 AND mandate_id = $2 AND branch_id = $3`,
      [execution.organization_id, execution.mandate_id, execution.branch_id],
    );
    const branch = branchResult.rows[0];
    if (branch) this.verifyBranchIntegrity(branch);
    if (!branch?.parent_branch_id) return undefined;
    const policyResult = await client.query<{ workload_classes: SerializedWorkloadClass[] }>(
      `SELECT workload_classes FROM policy_versions
       WHERE organization_id = $1 AND policy_id = $2 AND version = $3`,
      [execution.organization_id, branch.policy_id, branch.policy_version],
    );
    const configured = this.deserializeWorkloadClasses(
      policyResult.rows[0]?.workload_classes ?? [],
    ).find(({ id }) => id === execution.workload_class);
    if (!configured?.shadow) return undefined;
    const windowStart = new Date(
      Date.parse(canonicalEvaluatedAt) - configured.shadow.windowSeconds * 1_000,
    ).toISOString();
    const observations = await client.query<BranchObservationRow>(
      `SELECT execution.branch_id,
              COUNT(*)::int AS observation_count,
              COALESCE(SUM(execution.actual_cost_atomic), 0)::text AS spend_atomic
       FROM inference_executions execution
       JOIN mandate_branches branch
         ON branch.organization_id = execution.organization_id
        AND branch.mandate_id = execution.mandate_id
        AND branch.branch_id = execution.branch_id
       WHERE execution.organization_id = $1
         AND execution.mandate_id = $2
         AND execution.workload_class = $3
         AND execution.provider = $6
         AND execution.model = $7
         AND execution.status = 'completed'
         AND execution.shadow_cohort_key = $10
         AND execution.shadow_cohort_ordinal <= $11
         AND execution.shadow_completed_at >= $4
         AND branch.parent_branch_id = $5
         AND branch.policy_id = $8
         AND branch.policy_version = $9::int
       GROUP BY execution.branch_id
       ORDER BY execution.branch_id`,
      [execution.organization_id, execution.mandate_id, execution.workload_class,
        windowStart, branch.parent_branch_id, execution.provider, execution.model,
        branch.policy_id, branch.policy_version,
        execution.shadow_cohort_key, execution.shadow_cohort_ordinal],
    );
    const targetRow = observations.rows.find(({ branch_id }) => branch_id === execution.branch_id);
    if (!targetRow) throw new Error("SHADOW_TARGET_OBSERVATION_MISSING");
    const toObservation = (row: BranchObservationRow) => ({
      branchId: row.branch_id,
      parentBranchId: branch.parent_branch_id!,
      workloadClass: execution.workload_class!,
      spendAtomic: BigInt(row.spend_atomic),
      observationCount: Number(row.observation_count),
    });
    const result = evaluateSiblingDivergence({
      classPriorWindowSpendAtomic: configured.shadow.classPriorWindowSpendAtomic,
      confidenceConstant: configured.shadow.confidenceConstant,
      targetMinimumObservations: configured.shadow.targetMinimumObservations,
      siblingMinimumForScoring: configured.shadow.siblingMinimumForScoring,
      siblingMinimumForIntervention: configured.shadow.siblingMinimumForIntervention,
      divergenceThresholdBps: configured.shadow.divergenceThresholdBps,
    }, toObservation(targetRow), observations.rows.map(toObservation));
    const record: ShadowEvaluationRecord = {
      requestId: execution.request_id,
      organizationId: execution.organization_id,
      mandateId: execution.mandate_id,
      branchId: execution.branch_id,
      workloadClass: execution.workload_class,
      provider: execution.provider,
      model: execution.model,
      cohortKey: execution.shadow_cohort_key,
      cohortOrdinal: BigInt(execution.shadow_cohort_ordinal),
      ...result,
      evaluatedAt: canonicalEvaluatedAt,
    };
    await client.query(
      `INSERT INTO shadow_evaluations
       (organization_id, request_id, mandate_id, branch_id, workload_class, evidence, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (organization_id, request_id) DO NOTHING`,
      [record.organizationId, record.requestId, record.mandateId, record.branchId,
        record.workloadClass, JSON.stringify(this.serializeShadowEvaluation(record)), canonicalEvaluatedAt],
    );
    return record;
  }

  private async holdMandateForReconciliation(
    client: PoolClient,
    organizationId: string,
    mandateId: string,
  ): Promise<void> {
    const result = await client.query<{ state: MandateState }>(
      `SELECT state FROM control_mandates
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, mandateId],
    );
    const state = result.rows[0]?.state;
    if (!state) throw new Error("CONTROL_MANDATE_NOT_FOUND");
    if (!["active", "paused", "closing", "exhausted", "tripped"].includes(state)) return;
    await client.query(
      `INSERT INTO mandate_reconciliation_holds
       (organization_id, mandate_id, prior_state, held_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (organization_id, mandate_id) DO NOTHING`,
      [organizationId, mandateId, state],
    );
    await client.query(
      `UPDATE control_mandates SET state = 'reconciliation_hold'
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, mandateId],
    );
  }

  private async createSchema(): Promise<void> {
    await withSchemaBootstrapLock(
      this.pool,
      "policy_schema_migrations",
      7_341_120_001n,
      async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS policy_schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL
          )
        `);
        const initialized = await client.query(
          "SELECT 1 FROM policy_schema_migrations WHERE version = 1",
        );
        if (initialized.rowCount === 0) {
          await this.transactionOnClient(client, async (transactionClient) => {
      const claimed = await client.query(
        `INSERT INTO policy_schema_migrations (version, applied_at)
         VALUES (1, CURRENT_TIMESTAMP)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
      );
      if (claimed.rowCount === 0) return;
      const legacy = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN (
             'policy_versions', 'control_mandates', 'mandate_agent_assignments',
             'policy_decisions', 'inference_executions'
           )`,
      );
      if (legacy.rows.length > 0) throw new Error("POLICY_SCHEMA_MIGRATION_REQUIRED");
      await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_identities (
        id TEXT NOT NULL,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (organization_id, id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        causation_id TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_entity_idx
        ON audit_events (organization_id, entity_type, entity_id, occurred_at, id);
      CREATE TABLE IF NOT EXISTS policy_versions (
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        policy_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'enforce', 'paused')),
        allowed_providers JSONB NOT NULL,
        allowed_models JSONB NOT NULL,
        required_capability TEXT NOT NULL,
        max_per_call_atomic NUMERIC(78, 0) NOT NULL CHECK (max_per_call_atomic >= 0),
        max_hourly_atomic NUMERIC(78, 0) NOT NULL CHECK (max_hourly_atomic >= 0),
        max_daily_atomic NUMERIC(78, 0) NOT NULL CHECK (max_daily_atomic >= 0),
        max_requests_per_minute INTEGER NOT NULL CHECK (max_requests_per_minute >= 0),
        max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens >= 0),
        max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens >= 0),
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (organization_id, policy_id, version)
      );
      CREATE TABLE IF NOT EXISTS control_mandates (
        id TEXT NOT NULL,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        maximum_spend_atomic NUMERIC(78, 0) NOT NULL CHECK (maximum_spend_atomic > 0),
        state TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (organization_id, id),
        FOREIGN KEY (organization_id, policy_id, policy_version)
          REFERENCES policy_versions(organization_id, policy_id, version)
      );
      CREATE TABLE IF NOT EXISTS mandate_agent_assignments (
        organization_id TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        assigned_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (organization_id, mandate_id, agent_id),
        FOREIGN KEY (organization_id, mandate_id)
          REFERENCES control_mandates(organization_id, id),
        FOREIGN KEY (organization_id, agent_id)
          REFERENCES agent_identities(organization_id, id)
      );
      CREATE TABLE IF NOT EXISTS policy_decisions (
        id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('ALLOW', 'DENY', 'REVIEW')),
        would_outcome TEXT NOT NULL CHECK (would_outcome IN ('ALLOW', 'DENY', 'REVIEW')),
        enforced BOOLEAN NOT NULL,
        reason_codes JSONB NOT NULL,
        input_snapshot JSONB NOT NULL,
        decided_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (organization_id, id),
        UNIQUE (organization_id, request_id),
        FOREIGN KEY (organization_id, mandate_id)
          REFERENCES control_mandates(organization_id, id),
        FOREIGN KEY (organization_id, policy_id, policy_version)
          REFERENCES policy_versions(organization_id, policy_id, version),
        FOREIGN KEY (organization_id, agent_id)
          REFERENCES agent_identities(organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS policy_decisions_mandate_idx
        ON policy_decisions (organization_id, mandate_id, decided_at, id);
      CREATE TABLE IF NOT EXISTS inference_executions (
        organization_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'denied', 'executing', 'completed', 'failed', 'reconciliation_hold'
        )),
        reserved_cost_atomic NUMERIC(78, 0) NOT NULL CHECK (reserved_cost_atomic >= 0),
        actual_cost_atomic NUMERIC(78, 0) CHECK (actual_cost_atomic >= 0),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens >= 0),
        response_json JSONB,
        failure_code TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (organization_id, request_id),
        FOREIGN KEY (organization_id, mandate_id)
          REFERENCES control_mandates(organization_id, id),
        FOREIGN KEY (organization_id, decision_id)
          REFERENCES policy_decisions(organization_id, id),
        FOREIGN KEY (organization_id, agent_id)
          REFERENCES agent_identities(organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS inference_executions_budget_idx
        ON inference_executions (organization_id, mandate_id, created_at, status);
      `);
          });
        }
        await this.migrateReconciliationSchema(client);
        await this.migrateMandateReconciliationHoldSchema(client);
        await this.migrateWorkloadShadowSchema(client);
        await this.migrateBranchAuthorityAndShadowQueueSchema(client);
      },
    );
  }

  private async migrateReconciliationSchema(client: PoolClient): Promise<void> {
    await this.transactionOnClient(client, async (client) => {
      const migrated = await client.query(
        "SELECT 1 FROM policy_schema_migrations WHERE version = 2",
      );
      if (migrated.rowCount !== 0) return;
      const claimed = await client.query(
        `INSERT INTO policy_schema_migrations (version, applied_at)
         VALUES (2, CURRENT_TIMESTAMP)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
      );
      if (claimed.rowCount === 0) return;
      const existing = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'reconciliation_resolutions'`,
      );
      if (existing.rowCount !== 0) {
        throw new Error("UNVERSIONED_RECONCILIATION_SCHEMA_UNSUPPORTED");
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS reconciliation_resolutions (
          organization_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          resolution TEXT NOT NULL CHECK (resolution IN ('settle', 'confirm_not_billed')),
          actual_cost_atomic NUMERIC(78, 0) NOT NULL CHECK (actual_cost_atomic >= 0),
          note TEXT NOT NULL,
          external_reference TEXT NOT NULL,
          resolved_by TEXT NOT NULL,
          resolved_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (organization_id, request_id),
          FOREIGN KEY (organization_id, request_id)
            REFERENCES inference_executions(organization_id, request_id)
        );
      `);
    });
  }

  private async migrateMandateReconciliationHoldSchema(client: PoolClient): Promise<void> {
    await this.transactionOnClient(client, async (client) => {
      const migrated = await client.query(
        "SELECT 1 FROM policy_schema_migrations WHERE version = 3",
      );
      if (migrated.rowCount !== 0) return;
      const claimed = await client.query(
        `INSERT INTO policy_schema_migrations (version, applied_at)
         VALUES (3, CURRENT_TIMESTAMP)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
      );
      if (claimed.rowCount === 0) return;
      const existing = await client.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = 'mandate_reconciliation_holds'`,
      );
      if (existing.rowCount !== 0) {
        throw new Error("UNVERSIONED_MANDATE_RECONCILIATION_SCHEMA_UNSUPPORTED");
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS mandate_reconciliation_holds (
          organization_id TEXT NOT NULL,
          mandate_id TEXT NOT NULL,
          prior_state TEXT NOT NULL
            CHECK (prior_state IN ('active', 'paused', 'closing', 'exhausted', 'tripped')),
          held_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (organization_id, mandate_id),
          FOREIGN KEY (organization_id, mandate_id)
            REFERENCES control_mandates(organization_id, id)
        )
      `);
    });
  }

  private async migrateWorkloadShadowSchema(client: PoolClient): Promise<void> {
    await this.transactionOnClient(client, async (client) => {
      const migrated = await client.query(
        "SELECT 1 FROM policy_schema_migrations WHERE version = 4",
      );
      if (migrated.rowCount !== 0) return;
      const existing = await client.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('mandate_branches', 'shadow_evaluations')`,
      );
      if (existing.rowCount !== 0) throw new Error("UNVERSIONED_WORKLOAD_SHADOW_SCHEMA_UNSUPPORTED");
      const claimed = await client.query(
        `INSERT INTO policy_schema_migrations (version, applied_at)
         VALUES (4, CURRENT_TIMESTAMP)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
      );
      if (claimed.rowCount === 0) return;
      await client.query(`
        ALTER TABLE policy_versions
          ADD COLUMN IF NOT EXISTS workload_classes JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE inference_executions
          ADD COLUMN IF NOT EXISTS branch_id TEXT,
          ADD COLUMN IF NOT EXISTS workload_class TEXT;
        CREATE TABLE IF NOT EXISTS mandate_branches (
          organization_id TEXT NOT NULL,
          mandate_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          parent_branch_id TEXT,
          agent_id TEXT NOT NULL,
          policy_id TEXT NOT NULL,
          policy_version INTEGER NOT NULL,
          allowed_workload_classes JSONB NOT NULL,
          delegation_hash TEXT NOT NULL,
          authority_source TEXT NOT NULL CHECK (authority_source = 'fuse_control_plane'),
          created_at TIMESTAMPTZ NOT NULL,
          created_by TEXT NOT NULL,
          PRIMARY KEY (organization_id, mandate_id, branch_id),
          UNIQUE (organization_id, delegation_hash),
          FOREIGN KEY (organization_id, mandate_id)
            REFERENCES control_mandates(organization_id, id),
          FOREIGN KEY (organization_id, agent_id)
            REFERENCES agent_identities(organization_id, id),
          FOREIGN KEY (organization_id, policy_id, policy_version)
            REFERENCES policy_versions(organization_id, policy_id, version),
          FOREIGN KEY (organization_id, mandate_id, parent_branch_id)
            REFERENCES mandate_branches(organization_id, mandate_id, branch_id)
        );
        CREATE INDEX IF NOT EXISTS mandate_branches_parent_idx
          ON mandate_branches (organization_id, mandate_id, parent_branch_id, branch_id);
        CREATE TABLE IF NOT EXISTS shadow_evaluations (
          organization_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          mandate_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          workload_class TEXT NOT NULL,
          evidence JSONB NOT NULL,
          evaluated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (organization_id, request_id),
          FOREIGN KEY (organization_id, request_id)
            REFERENCES inference_executions(organization_id, request_id),
          FOREIGN KEY (organization_id, mandate_id, branch_id)
            REFERENCES mandate_branches(organization_id, mandate_id, branch_id)
        );
        CREATE INDEX IF NOT EXISTS shadow_evaluations_mandate_idx
          ON shadow_evaluations (organization_id, mandate_id, evaluated_at, request_id);
      `);
    });
  }

  private async migrateBranchAuthorityAndShadowQueueSchema(client: PoolClient): Promise<void> {
    await this.transactionOnClient(client, async (client) => {
      const migrated = await client.query(
        "SELECT 1 FROM policy_schema_migrations WHERE version = 5",
      );
      if (migrated.rowCount !== 0) return;
      const legacyBranches = await client.query("SELECT 1 FROM mandate_branches LIMIT 1");
      if (legacyBranches.rowCount !== 0) {
        throw new Error("BRANCH_AUTHORITY_V5_BACKFILL_REQUIRED");
      }
      const claimed = await client.query(
        `INSERT INTO policy_schema_migrations (version, applied_at)
         VALUES (5, CURRENT_TIMESTAMP)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
      );
      if (claimed.rowCount === 0) return;
      await client.query(`
        ALTER TABLE inference_executions
          ADD COLUMN IF NOT EXISTS shadow_cohort_key TEXT,
          ADD COLUMN IF NOT EXISTS shadow_cohort_ordinal NUMERIC(78, 0),
          ADD COLUMN IF NOT EXISTS shadow_completed_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS shadow_order_state TEXT;
        ALTER TABLE mandate_branches
          ADD COLUMN IF NOT EXISTS maximum_spend_atomic NUMERIC(78, 0),
          ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
        ALTER TABLE mandate_branches
          ALTER COLUMN maximum_spend_atomic SET NOT NULL;
        CREATE TABLE IF NOT EXISTS shadow_cohort_counters (
          organization_id TEXT NOT NULL,
          cohort_key TEXT NOT NULL,
          last_ordinal NUMERIC(78, 0) NOT NULL CHECK (last_ordinal > 0),
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (organization_id, cohort_key)
        );
        CREATE TABLE IF NOT EXISTS shadow_evaluation_queue (
          organization_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'failed', 'completed')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          claim_token TEXT,
          lease_expires_at TIMESTAMPTZ,
          last_error TEXT,
          queued_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (organization_id, request_id),
          FOREIGN KEY (organization_id, request_id)
            REFERENCES inference_executions(organization_id, request_id)
        );
        ALTER TABLE shadow_evaluation_queue
          ADD COLUMN IF NOT EXISTS claim_token TEXT;
        ALTER TABLE shadow_evaluation_queue
          ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
        CREATE INDEX IF NOT EXISTS shadow_evaluation_queue_pending_idx
          ON shadow_evaluation_queue (state, queued_at, request_id);
      `);
    });
  }

  private async admissionFromExecution(
    client: PoolClient,
    row: InferenceExecutionRow,
    retriedAt: string,
  ): Promise<AdmissionResult> {
    const decisionResult = await client.query<DecisionRow>(
      "SELECT * FROM policy_decisions WHERE organization_id = $1 AND id = $2",
      [row.organization_id, row.decision_id],
    );
    const stored = decisionResult.rows[0];
    if (!stored) throw new Error("POLICY_DECISION_NOT_FOUND");
    const decision: StoredPolicyDecision = {
      id: stored.id,
      requestId: stored.request_id,
      organizationId: stored.organization_id,
      mandateId: stored.mandate_id,
      agentId: stored.agent_id,
      policyId: stored.policy_id,
      policyVersion: stored.policy_version,
      result: {
        outcome: stored.outcome,
        wouldOutcome: stored.would_outcome,
        enforced: stored.enforced,
        reasonCodes: stored.reason_codes,
      },
      input: this.deserializeDecisionInput(stored.input_snapshot),
    };
    if (row.status === "denied") return { status: "denied", decision };
    if (row.status === "executing") {
      const leaseExpired = Date.parse(retriedAt) - row.updated_at.getTime() >= 5 * 60 * 1000;
      if (!leaseExpired) return { status: "in_progress" };
      await client.query(
        `UPDATE inference_executions
         SET status = 'reconciliation_hold', failure_code = 'EXECUTION_LEASE_EXPIRED', updated_at = $3
         WHERE organization_id = $1 AND request_id = $2 AND status = 'executing'`,
        [row.organization_id, row.request_id, retriedAt],
      );
      await this.holdMandateForReconciliation(client, row.organization_id, row.mandate_id);
      return { status: "failed" };
    }
    if (row.status === "failed" || row.status === "reconciliation_hold") return { status: "failed" };
    if (!row.response_json || row.actual_cost_atomic === null) {
      throw new Error("INFERENCE_EXECUTION_RESPONSE_MISSING");
    }
    const shadowResult = await client.query<ShadowEvaluationRow>(
      `SELECT * FROM shadow_evaluations
       WHERE organization_id = $1 AND request_id = $2`,
      [row.organization_id, row.request_id],
    );
    const shadowEvaluation = shadowResult.rows[0]
      ? this.shadowEvaluationFromRow(shadowResult.rows[0]) : undefined;
    return {
      status: "completed",
      decision,
      reservedCostAtomic: BigInt(row.reserved_cost_atomic),
      actualCostAtomic: BigInt(row.actual_cost_atomic),
      response: row.response_json,
      ...(shadowEvaluation ? { shadowEvaluation } : {}),
    };
  }

  private policyFromRow(row: PolicyRow): PolicyVersion {
    const workloadClasses = this.deserializeWorkloadClasses(row.workload_classes);
    const policy: PolicyVersion = {
      id: row.policy_id,
      organizationId: row.organization_id,
      version: row.version,
      mode: row.mode,
      allowedProviders: [...row.allowed_providers],
      allowedModels: [...row.allowed_models],
      requiredCapability: row.required_capability,
      limits: {
        maxPerCallAtomic: BigInt(row.max_per_call_atomic),
        maxHourlyAtomic: BigInt(row.max_hourly_atomic),
        maxDailyAtomic: BigInt(row.max_daily_atomic),
        maxRequestsPerMinute: row.max_requests_per_minute,
        maxInputTokens: row.max_input_tokens,
        maxOutputTokens: row.max_output_tokens,
      },
      ...(workloadClasses.length > 0 ? { workloadClasses } : {}),
      createdAt: row.created_at.toISOString(),
    };
    validatePolicy(policy);
    return policy;
  }

  private serializeDecisionInput(input: PolicyDecisionInput): Record<string, unknown> {
    return {
      ...input,
      agentCapabilities: [...input.agentCapabilities],
      estimatedCostAtomic: input.estimatedCostAtomic.toString(),
      spentHourAtomic: input.spentHourAtomic.toString(),
      spentDayAtomic: input.spentDayAtomic.toString(),
      mandateSpentAtomic: input.mandateSpentAtomic.toString(),
      mandateMaximumAtomic: input.mandateMaximumAtomic.toString(),
      ...(input.workload ? {
        workload: {
          ...input.workload,
          branchMaximumAtomic: input.workload.branchMaximumAtomic.toString(),
          branchSpentAtomic: input.workload.branchSpentAtomic.toString(),
          classSpentAtomic: input.workload.classSpentAtomic.toString(),
        },
      } : {}),
      ...(input.exposure ? {
        exposure: Object.fromEntries(
          Object.entries(input.exposure).map(([key, value]) => [key, value.toString()]),
        ),
      } : {}),
    };
  }

  private deserializeDecisionInput(snapshot: DecisionSnapshot): PolicyDecisionInput {
    const { workload, exposure, ...rest } = snapshot;
    return {
      ...rest,
      estimatedCostAtomic: BigInt(snapshot.estimatedCostAtomic),
      spentHourAtomic: BigInt(snapshot.spentHourAtomic),
      spentDayAtomic: BigInt(snapshot.spentDayAtomic),
      mandateSpentAtomic: BigInt(snapshot.mandateSpentAtomic),
      mandateMaximumAtomic: BigInt(snapshot.mandateMaximumAtomic),
      ...(workload ? {
        workload: {
          ...workload,
          branchMaximumAtomic: BigInt(workload.branchMaximumAtomic),
          branchSpentAtomic: BigInt(workload.branchSpentAtomic),
          classSpentAtomic: BigInt(workload.classSpentAtomic),
        },
      } : {}),
      ...(exposure ? {
        exposure: {
          branchLimitAtomic: BigInt(exposure.branchLimitAtomic),
          branchCommittedBeforeAtomic: BigInt(exposure.branchCommittedBeforeAtomic),
          requestReservationAtomic: BigInt(exposure.requestReservationAtomic),
          maximumExposureAtomic: BigInt(exposure.maximumExposureAtomic),
          remainingAuthorityAtomic: BigInt(exposure.remainingAuthorityAtomic),
        },
      } : {}),
    };
  }

  private cloneWorkloadClasses(workloadClasses: readonly WorkloadClassPolicy[]): WorkloadClassPolicy[] {
    return workloadClasses.map((workloadClass) => ({
      ...workloadClass,
      shadow: workloadClass.shadow ? { ...workloadClass.shadow } : null,
    }));
  }

  private serializeWorkloadClasses(
    workloadClasses: readonly WorkloadClassPolicy[],
  ): SerializedWorkloadClass[] {
    return workloadClasses.map((workloadClass) => ({
      ...workloadClass,
      maxCostPerCallAtomic: workloadClass.maxCostPerCallAtomic.toString(),
      aggregateBudgetAtomic: workloadClass.aggregateBudgetAtomic.toString(),
      shadow: workloadClass.shadow ? {
        ...workloadClass.shadow,
        classPriorWindowSpendAtomic: workloadClass.shadow.classPriorWindowSpendAtomic.toString(),
      } : null,
    }));
  }

  private deserializeWorkloadClasses(
    workloadClasses: readonly SerializedWorkloadClass[],
  ): WorkloadClassPolicy[] {
    return workloadClasses.map((workloadClass) => ({
      ...workloadClass,
      maxCostPerCallAtomic: BigInt(workloadClass.maxCostPerCallAtomic),
      aggregateBudgetAtomic: BigInt(workloadClass.aggregateBudgetAtomic),
      shadow: workloadClass.shadow ? {
        ...workloadClass.shadow,
        classPriorWindowSpendAtomic: BigInt(workloadClass.shadow.classPriorWindowSpendAtomic),
      } : null,
    }));
  }

  private verifyBranchIntegrity(row: MandateBranchRow): void {
    if (row.authority_source !== "fuse_control_plane") {
      throw new Error("MANDATE_BRANCH_AUTHORITY_SOURCE_INVALID");
    }
    const canonical = {
      authoritySource: row.authority_source,
      organizationId: row.organization_id,
      mandateId: row.mandate_id,
      branchId: row.branch_id,
      parentBranchId: row.parent_branch_id,
      agentId: row.agent_id,
      policyId: row.policy_id,
      policyVersion: row.policy_version,
      allowedWorkloadClasses: row.allowed_workload_classes,
      maximumSpendAtomic: BigInt(row.maximum_spend_atomic).toString(),
      expiresAt: row.expires_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      createdBy: row.created_by,
    } as const;
    const expected = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    if (row.delegation_hash !== expected) {
      throw new Error("MANDATE_BRANCH_DELEGATION_HASH_INVALID");
    }
  }

  private branchFromRow(row: MandateBranchRow): MandateBranch {
    this.verifyBranchIntegrity(row);
    return {
      id: row.branch_id,
      organizationId: row.organization_id,
      mandateId: row.mandate_id,
      parentBranchId: row.parent_branch_id,
      agentId: row.agent_id,
      policyId: row.policy_id,
      policyVersion: row.policy_version,
      allowedWorkloadClasses: [...row.allowed_workload_classes],
      maximumSpendAtomic: BigInt(row.maximum_spend_atomic),
      expiresAt: row.expires_at?.toISOString() ?? null,
      delegationHash: row.delegation_hash,
      authoritySource: row.authority_source,
      createdAt: row.created_at.toISOString(),
      createdBy: row.created_by,
    };
  }

  private shadowEvaluationFromRow(row: ShadowEvaluationRow): ShadowEvaluationRecord {
    return {
      ...row.evidence,
      cohortOrdinal: BigInt(row.evidence.cohortOrdinal),
      siblingAggregateAtomic: BigInt(row.evidence.siblingAggregateAtomic),
      effectiveBaselineAtomic: BigInt(row.evidence.effectiveBaselineAtomic),
    };
  }

  private serializeShadowEvaluation(record: ShadowEvaluationRecord): SerializedShadowEvaluation {
    return {
      ...record,
      cohortOrdinal: record.cohortOrdinal.toString(),
      siblingAggregateAtomic: record.siblingAggregateAtomic.toString(),
      effectiveBaselineAtomic: record.effectiveBaselineAtomic.toString(),
    };
  }

  private validateContext(context: PolicyMutationContext): void {
    if (!context.actorId.trim()) throw new Error("POLICY_ACTOR_REQUIRED");
    if (!context.causationId.trim()) throw new Error("POLICY_CAUSATION_REQUIRED");
    if (Number.isNaN(Date.parse(context.occurredAt))) throw new Error("POLICY_OCCURRED_AT_INVALID");
  }

  private validateDecisionInput(input: PolicyDecisionInput): void {
    if (!input.id.trim()) throw new Error("POLICY_DECISION_ID_REQUIRED");
    if (!input.requestId.trim()) throw new Error("POLICY_DECISION_REQUEST_REQUIRED");
    if (!input.organizationId.trim()) throw new Error("POLICY_DECISION_ORGANIZATION_REQUIRED");
    if (!input.mandateId.trim()) throw new Error("POLICY_DECISION_MANDATE_REQUIRED");
    if (!input.agentId.trim()) throw new Error("POLICY_DECISION_AGENT_REQUIRED");
    if (Number.isNaN(Date.parse(input.decidedAt))) throw new Error("POLICY_DECISION_TIME_INVALID");
  }

  private async appendAudit(client: PoolClient, input: {
    organizationId: string;
    entityType: string;
    entityId: string;
    action: string;
    actorId: string;
    causationId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
       (id, organization_id, entity_type, entity_id, action, actor_id,
        causation_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        randomUUID(), input.organizationId, input.entityType, input.entityId, input.action,
        input.actorId, input.causationId, input.occurredAt, JSON.stringify(input.payload),
      ],
    );
  }

  private async transactionOnClient<T>(
    client: PoolClient,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await this.transactionOnClient(client, operation);
    } finally {
      client.release();
    }
  }
}

interface SerializedWorkloadClass {
  id: string;
  maxCostPerCallAtomic: string;
  maxInvocationsPerBranch: number;
  aggregateBudgetAtomic: string;
  minimumInputTokens: number;
  shadow: null | {
    classPriorWindowSpendAtomic: string;
    windowSeconds: number;
    targetMinimumObservations: number;
    siblingMinimumForScoring: number;
    siblingMinimumForIntervention: number;
    confidenceConstant: number;
    divergenceThresholdBps: number;
  };
}

interface MandateBranchRow {
  organization_id: string;
  mandate_id: string;
  branch_id: string;
  parent_branch_id: string | null;
  agent_id: string;
  policy_id: string;
  policy_version: number;
  allowed_workload_classes: string[];
  maximum_spend_atomic: string;
  expires_at: Date | null;
  delegation_hash: string;
  authority_source: "fuse_control_plane";
  created_at: Date;
  created_by: string;
}

interface WorkloadUsageRow {
  workload_class: string;
  invocation_count: number;
  spent_atomic: string;
}

interface BranchObservationRow {
  branch_id: string;
  observation_count: number;
  spend_atomic: string;
}

type SerializedShadowEvaluation = Omit<
  ShadowEvaluationRecord,
  "cohortOrdinal" | "siblingAggregateAtomic" | "effectiveBaselineAtomic"
> & {
  cohortOrdinal: string;
  siblingAggregateAtomic: string;
  effectiveBaselineAtomic: string;
};

interface ShadowEvaluationRow {
  organization_id: string;
  request_id: string;
  mandate_id: string;
  branch_id: string;
  workload_class: string;
  evidence: SerializedShadowEvaluation;
  evaluated_at: Date;
}

interface InferenceExecutionRow {
  organization_id: string;
  request_id: string;
  mandate_id: string;
  agent_id: string;
  decision_id: string;
  provider: string;
  model: string;
  branch_id: string | null;
  workload_class: string | null;
  shadow_cohort_key: string | null;
  shadow_cohort_ordinal: string | null;
  shadow_completed_at: Date | null;

  request_fingerprint: string;
  status: "denied" | "executing" | "completed" | "failed" | "reconciliation_hold";
  reserved_cost_atomic: string;
  actual_cost_atomic: string | null;
  input_tokens: number;
  max_output_tokens: number;
  response_json: ProviderResult | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PolicyRow {
  organization_id: string;
  policy_id: string;
  version: number;
  mode: PolicyMode;
  allowed_providers: string[];
  allowed_models: string[];
  required_capability: ApiCapability;
  max_per_call_atomic: string;
  max_hourly_atomic: string;
  max_daily_atomic: string;
  max_requests_per_minute: number;
  max_input_tokens: number;
  max_output_tokens: number;
  workload_classes: SerializedWorkloadClass[];
  created_at: Date;
}

interface MandatePolicyRow {
  mandate_state: MandateState;
  mandate_expires_at: Date | null;
  mandate_maximum_spend_atomic: string;
  policy_id: string;
  policy_version: number;
  mode: PolicyMode;
  allowed_providers: string[];
  allowed_models: string[];
  required_capability: ApiCapability;
  max_per_call_atomic: string;
  max_hourly_atomic: string;
  max_daily_atomic: string;
  max_requests_per_minute: number;
  max_input_tokens: number;
  max_output_tokens: number;
  workload_classes: SerializedWorkloadClass[];
  created_at: Date;
}

interface DecisionSnapshot {
  id: string;
  requestId: string;
  organizationId: string;
  mandateId: string;
  agentId: string;
  agentCapabilities: ApiCapability[];
  provider: string;
  model: string;
  estimatedCostAtomic: string;
  inputTokens: number;
  maxOutputTokens: number;
  spentHourAtomic: string;
  spentDayAtomic: string;
  mandateSpentAtomic: string;
  mandateMaximumAtomic: string;
  requestCountLastMinute: number;
  workload?: Omit<NonNullable<PolicyEvaluationInput["workload"]>,
    "branchMaximumAtomic" | "branchSpentAtomic" | "classSpentAtomic"> & {
    branchMaximumAtomic: string;
    branchSpentAtomic: string;
    classSpentAtomic: string;
  };
  exposure?: {
    branchLimitAtomic: string;
    branchCommittedBeforeAtomic: string;
    requestReservationAtomic: string;
    maximumExposureAtomic: string;
    remainingAuthorityAtomic: string;
  };
  decidedAt: string;
}

interface DecisionRow {
  id: string;
  request_id: string;
  organization_id: string;
  mandate_id: string;
  agent_id: string;
  policy_id: string;
  policy_version: number;
  outcome: "ALLOW" | "DENY" | "REVIEW";
  would_outcome: "ALLOW" | "DENY" | "REVIEW";
  enforced: boolean;
  reason_codes: PolicyReasonCode[];
  input_snapshot: DecisionSnapshot;
}
