import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  evaluatePolicy,
  validatePolicy,
  type PolicyDecisionResult,
  type PolicyEvaluationInput,
  type PolicyMode,
  type PolicyReasonCode,
  type PolicyVersion,
} from "../domain/policy.js";
import type { ApiCapability } from "../identity/apiCredentials.js";
import type { ProviderResult } from "../core/service.js";
import type {
  AdmissionResult,
  CompletionPersistenceResult,
  InferenceExecutionStore,
} from "../inference/inferenceExecution.js";
import type { MandateState } from "../domain/lifecycles.js";

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

export interface PolicyDecisionInput {
  id: string;
  requestId: string;
  organizationId: string;
  mandateId: string;
  agentId: string;
  agentCapabilities: ApiCapability[];
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

export class PolicyStore implements InferenceExecutionStore {
  private schemaReady?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  ensureSchema(): Promise<void> {
    this.schemaReady ??= this.createSchema().catch((error) => {
      this.schemaReady = undefined;
      throw error;
    });
    return this.schemaReady;
  }

  async publishPolicy(policy: PolicyVersion, context: PolicyMutationContext): Promise<void> {
    context = { ...context };
    policy = {
      ...policy,
      allowedProviders: [...policy.allowedProviders],
      allowedModels: [...policy.allowedModels],
      limits: { ...policy.limits },
    };
    validatePolicy(policy);
    this.validateContext(context);
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO policy_versions
         (organization_id, policy_id, version, mode, allowed_providers, allowed_models,
          required_capability, max_per_call_atomic, max_hourly_atomic, max_daily_atomic,
          max_requests_per_minute, max_input_tokens, max_output_tokens, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          policy.organizationId, policy.id, policy.version, policy.mode,
          JSON.stringify(policy.allowedProviders), JSON.stringify(policy.allowedModels),
          policy.requiredCapability, policy.limits.maxPerCallAtomic.toString(),
          policy.limits.maxHourlyAtomic.toString(), policy.limits.maxDailyAtomic.toString(),
          policy.limits.maxRequestsPerMinute, policy.limits.maxInputTokens,
          policy.limits.maxOutputTokens, policy.createdAt, context.actorId,
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
                policies.max_output_tokens, policies.created_at
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
                policies.max_output_tokens, policies.created_at
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
           COALESCE(SUM(CASE WHEN created_at >= $3 AND status IN ('executing','completed','reconciliation_hold')
             THEN CASE WHEN status = 'completed' THEN actual_cost_atomic ELSE reserved_cost_atomic END
             ELSE 0 END), 0)::text AS spent_hour_atomic,
           COALESCE(SUM(CASE WHEN created_at >= $4 AND status IN ('executing','completed','reconciliation_hold')
             THEN CASE WHEN status = 'completed' THEN actual_cost_atomic ELSE reserved_cost_atomic END
             ELSE 0 END), 0)::text AS spent_day_atomic,
           COALESCE(SUM(CASE WHEN status IN ('executing','completed','reconciliation_hold')
             THEN CASE WHEN status = 'completed' THEN actual_cost_atomic ELSE reserved_cost_atomic END
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
      });
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
          request_fingerprint, status, reserved_cost_atomic, input_tokens, max_output_tokens,
          created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        [
          input.organizationId, input.requestId, input.mandateId, input.agentId,
          decision.id, input.provider, input.model, input.requestFingerprint, status,
          reservation.toString(), input.inputTokens, input.maxOutputTokens, input.decidedAt,
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
    return this.transaction(async (client) => {
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
          status: "reconciliation_hold",
          reservedCostAtomic,
          actualCostAtomic: input.actualCostAtomic,
          response: input.response,
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
      return {
        status: "completed",
        reservedCostAtomic,
        actualCostAtomic: input.actualCostAtomic,
        response: input.response,
      };
    });
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
      `UPDATE control_mandates SET state = 'reconciliation_hold'
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, mandateId],
    );
  }

  private async createSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS policy_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.transaction(async (client) => {
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
    return {
      status: "completed",
      decision,
      reservedCostAtomic: BigInt(row.reserved_cost_atomic),
      actualCostAtomic: BigInt(row.actual_cost_atomic),
      response: row.response_json,
    };
  }

  private policyFromRow(row: PolicyRow): PolicyVersion {
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
    };
  }

  private deserializeDecisionInput(snapshot: DecisionSnapshot): PolicyDecisionInput {
    return {
      ...snapshot,
      estimatedCostAtomic: BigInt(snapshot.estimatedCostAtomic),
      spentHourAtomic: BigInt(snapshot.spentHourAtomic),
      spentDayAtomic: BigInt(snapshot.spentDayAtomic),
      mandateSpentAtomic: BigInt(snapshot.mandateSpentAtomic),
      mandateMaximumAtomic: BigInt(snapshot.mandateMaximumAtomic),
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

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface InferenceExecutionRow {
  organization_id: string;
  request_id: string;
  mandate_id: string;
  agent_id: string;
  decision_id: string;
  provider: string;
  model: string;
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
