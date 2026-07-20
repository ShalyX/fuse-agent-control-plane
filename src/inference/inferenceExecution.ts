import { createHash } from "node:crypto";
import type { ApiCapability } from "../identity/apiCredentials.js";
import type { CompletionRequest, InferenceProvider, ProviderResult } from "../core/service.js";
import {
  calculateCostMicros,
  calculateMaximumCostMicros,
  usdToMicros,
  type TokenPrice,
} from "../core/pricing.js";
import type { ShadowEvaluationRecord, StoredPolicyDecision } from "../persistence/policyStore.js";

export interface ControlledInferenceInput {
  requestId: string;
  organizationId: string;
  mandateId: string;
  agentId: string;
  agentCapabilities: ApiCapability[];
  branchId?: string;
  workloadClass?: string;
  requestedModel?: string;
  inputTokens: number;
  maxOutputTokens: number;
  messages: CompletionRequest["messages"];
}

export type AdmissionResult =
  | { status: "execute"; decision: StoredPolicyDecision; reservedCostAtomic: bigint }
  | { status: "denied"; decision: StoredPolicyDecision }
  | { status: "in_progress" }
  | { status: "failed" }
  | {
      status: "completed";
      decision: StoredPolicyDecision;
      reservedCostAtomic: bigint;
      actualCostAtomic: bigint;
      response: ProviderResult;
      shadowEvaluation?: ShadowEvaluationRecord;
    };

export type CompletionPersistenceResult = {
  status: "completed" | "reconciliation_hold";
  reservedCostAtomic: bigint;
  actualCostAtomic: bigint;
  response: ProviderResult;
  shadowEvaluation?: ShadowEvaluationRecord;
};

export interface InferenceExecutionStore {
  admitInference(input: {
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
  }): Promise<AdmissionResult>;
  completeInference(input: {
    requestId: string;
    organizationId: string;
    actualCostAtomic: bigint;
    response: ProviderResult;
    completedAt: string;
  }): Promise<CompletionPersistenceResult>;
  holdInference(input: {
    requestId: string;
    organizationId: string;
    reasonCode: string;
    response?: ProviderResult;
    heldAt: string;
  }): Promise<void>;
}

export interface ProviderExecutionBinding {
  provider: InferenceProvider;
  providerName: string;
  model: string;
  price: TokenPrice;
  requireProviderCost?: boolean;
  requireProviderModelMatch?: boolean;
}

type InferenceExecutionConfig = {
  store: InferenceExecutionStore;
  now?: () => string;
} & (
  | ProviderExecutionBinding
  | { resolveProvider: (organizationId: string) => Promise<ProviderExecutionBinding> }
);

export class InferenceExecutionService {
  constructor(private readonly config: InferenceExecutionConfig) {}

  async execute(input: ControlledInferenceInput): Promise<AdmissionResult> {
    const binding = await this.providerBinding(input.organizationId);
    if (input.requestedModel !== undefined && input.requestedModel !== binding.model) {
      throw new Error("REQUESTED_MODEL_MISMATCH");
    }
    const estimatedCostAtomic = calculateMaximumCostMicros({
      inputTokens: input.inputTokens,
      maxOutputTokens: input.maxOutputTokens,
    }, binding.price);
    const admission = await this.config.store.admitInference({
      ...input,
      provider: binding.providerName,
      model: binding.model,
      estimatedCostAtomic,
      requestFingerprint: this.requestFingerprint(input, binding),
      decidedAt: this.now(),
    });
    if (admission.status !== "execute") return admission;

    let response: ProviderResult;
    try {
      response = await binding.provider.complete({
        requestId: input.requestId,
        childId: input.agentId,
        model: binding.model,
        inputTokens: input.inputTokens,
        maxOutputTokens: input.maxOutputTokens,
        messages: input.messages,
      });
    } catch (error) {
      await this.config.store.holdInference({
        requestId: input.requestId,
        organizationId: input.organizationId,
        reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS",
        heldAt: this.now(),
      });
      throw error;
    }

    let completed: CompletionPersistenceResult;
    try {
      if (binding.requireProviderModelMatch && response.providerModel !== binding.model) {
        throw new Error("PROVIDER_MODEL_MISMATCH");
      }
      if (binding.requireProviderCost && response.providerCostUsd === undefined) {
        throw new Error("PROVIDER_COST_MISSING");
      }
      const actualCostAtomic = response.providerCostUsd === undefined
        ? calculateCostMicros(response.usage, binding.price)
        : usdToMicros(response.providerCostUsd);
      completed = await this.config.store.completeInference({
        requestId: input.requestId,
        organizationId: input.organizationId,
        actualCostAtomic,
        response,
        completedAt: this.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reasonCode = ["PROVIDER_MODEL_MISMATCH", "PROVIDER_COST_MISSING"].includes(message)
        ? message
        : "POST_PROVIDER_RECONCILIATION_FAILED";
      await this.config.store.holdInference({
        requestId: input.requestId,
        organizationId: input.organizationId,
        reasonCode,
        response,
        heldAt: this.now(),
      });
      throw error;
    }
    if (completed.status === "reconciliation_hold") {
      throw new Error("ACTUAL_COST_EXCEEDS_RESERVATION");
    }
    const { status: _status, ...persisted } = completed;
    return { status: "completed", decision: admission.decision, ...persisted };
  }

  private requestFingerprint(
    input: ControlledInferenceInput,
    binding: ProviderExecutionBinding,
  ): string {
    return createHash("sha256").update(JSON.stringify({
      organizationId: input.organizationId,
      mandateId: input.mandateId,
      agentId: input.agentId,
      branchId: input.branchId ?? null,
      workloadClass: input.workloadClass ?? null,
      provider: binding.providerName,
      model: binding.model,
      requestedModel: input.requestedModel ?? binding.model,
      inputTokens: input.inputTokens,
      maxOutputTokens: input.maxOutputTokens,
      messages: input.messages,
    })).digest("hex");
  }

  private providerBinding(organizationId: string): Promise<ProviderExecutionBinding> {
    if ("resolveProvider" in this.config) return this.config.resolveProvider(organizationId);
    return Promise.resolve(this.config);
  }

  private now(): string {
    return (this.config.now ?? (() => new Date().toISOString()))();
  }
}
