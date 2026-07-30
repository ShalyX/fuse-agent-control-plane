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
import type { StableSuccessfulResponseProjection } from "../reliability/commitments.js";

export type ReliabilityProtocolCoordinates = { runId: string; laneId: string; block: number; callOrdinal: number };
const issuedReliabilityContexts = new WeakSet<object>();
export type ReliabilityProtocolContext = Readonly<ReliabilityProtocolCoordinates> & { readonly __serverReliabilityContext: true };
/** Server/orchestrator capability. HTTP JSON cannot manufacture an accepted context. */
export function issueReliabilityProtocolContext(input: ReliabilityProtocolCoordinates): ReliabilityProtocolContext {
  if (!input.runId || !input.laneId || !Number.isInteger(input.block) || input.block < 1 || input.block > 5
    || !Number.isInteger(input.callOrdinal) || input.callOrdinal < 1 || input.callOrdinal > 5) {
    throw new Error("RELIABILITY_PROTOCOL_CONTEXT_INVALID");
  }
  const context = Object.freeze({ ...input, __serverReliabilityContext: true as const });
  issuedReliabilityContexts.add(context);
  return context;
}

export interface ControlledInferenceInput {
  requestId: string;
  organizationId: string;
  credentialId?: string;
  mandateId: string;
  agentId: string;
  agentCapabilities: ApiCapability[];
  branchId?: string;
  workloadClass?: string;
  requestedModel?: string;
  inputTokens: number;
  maxOutputTokens: number;
  messages: CompletionRequest["messages"];
  reliabilityContext?: ReliabilityProtocolContext;
}

export type AdmissionResult =
  | { status: "execute"; decision: StoredPolicyDecision; reservedCostAtomic: bigint; protocolAdmissionCommitted?: true }
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
  recordReliabilityAttempt?(input: {
    runId: string; laneId: string; block: number; requestId: string;
    reservedCostMicros: bigint; request: {
      method: "POST"; route: "/v1/chat/completions"; organizationId: string;
      credentialId: string; mandateId: string; branchId: string | null;
      workloadClass: string | null; idempotencyKey: string; body: unknown;
    };
  }): Promise<void>;
  authorizeReliabilityDispatch?(input: {
    runId: string; laneId: string; block: number; requestId: string; ownerId: string;
  }): Promise<{ tokenId: string }>;
  markReliabilityDispatchPrimitiveEntered?(input: {
    runId: string; requestId: string; tokenId: string;
  }): Promise<void>;
  awaitReliabilityDispatchRelease?(input: {
    runId: string; laneId: string; block: number; requestId: string; tokenId: string;
  }): Promise<void>;
  completeReliabilityAttempt?(input: {
    runId: string; laneId: string; requestId: string; response: ProviderResult;
    responseProjection: StableSuccessfulResponseProjection; actualCostMicros: bigint;
  }): Promise<void>;
  classifyReliabilityNotDispatched?(input: {
    runId: string; laneId: string; requestId: string; reasonCode: string;
  }): Promise<void>;
  classifyReliabilityNotDispatchedAtomically?(input: {
    ordinary: {
      requestId: string; organizationId: string; failureCode: string; failedAt: string;
    };
    protocol: {
      runId: string; laneId: string; requestId: string; reasonCode: string;
    };
  }): Promise<void>;
  holdReliabilityAttempt?(input: {
    runId: string; laneId: string; requestId: string; reasonCode: string; generationId?: string; response?: ProviderResult;
  }): Promise<void>;
  failReliabilityProtocol?(runId: string, reasonCode: string): Promise<void>;
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
    reliabilityAdmission?: {
      runId: string; laneId: string; block: number; requestId: string;
      request: {
        method: "POST"; route: "/v1/chat/completions"; organizationId: string;
        credentialId: string; mandateId: string; branchId: string | null;
        workloadClass: string | null; idempotencyKey: string; body: unknown;
      };
    };
  }): Promise<AdmissionResult>;
  completeInference(input: {
    requestId: string;
    organizationId: string;
    actualCostAtomic: bigint;
    response: ProviderResult;
    completedAt: string;
  }): Promise<CompletionPersistenceResult>;
  completeReliabilityInference?(input: {
    ordinary: Parameters<InferenceExecutionStore["completeInference"]>[0];
    protocol: {
      runId: string; laneId: string; requestId: string; response: ProviderResult;
      responseProjection: StableSuccessfulResponseProjection; actualCostMicros: bigint;
    };
  }): Promise<CompletionPersistenceResult>;
  holdInference(input: {
    requestId: string;
    organizationId: string;
    reasonCode: string;
    response?: ProviderResult;
    heldAt: string;
  }): Promise<void>;
  failInference(input: {
    requestId: string;
    organizationId: string;
    failureCode: string;
    failedAt: string;
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
    if (input.reliabilityContext && !issuedReliabilityContexts.has(input.reliabilityContext)) {
      throw new Error("RELIABILITY_PROTOCOL_CONTEXT_INVALID");
    }
    const binding = await this.providerBinding(input.organizationId);
    if (input.requestedModel !== undefined && input.requestedModel !== binding.model) {
      throw new Error("REQUESTED_MODEL_MISMATCH");
    }
    const estimatedCostAtomic = calculateMaximumCostMicros({
      inputTokens: input.inputTokens,
      maxOutputTokens: input.maxOutputTokens,
    }, binding.price);
    const reliabilityAdmission = input.reliabilityContext && input.credentialId ? {
      ...input.reliabilityContext, requestId: input.requestId,
      request: {
        method: "POST" as const, route: "/v1/chat/completions" as const,
        organizationId: input.organizationId, credentialId: input.credentialId,
        mandateId: input.mandateId, branchId: input.branchId ?? null,
        workloadClass: input.workloadClass ?? null, idempotencyKey: input.requestId,
        body: { model: binding.model, max_tokens: input.maxOutputTokens,
          ...(input.workloadClass ? { workload_class: input.workloadClass } : {}), messages: input.messages },
      },
    } : undefined;
    const admission = await this.config.store.admitInference({
      ...input,
      provider: binding.providerName,
      model: binding.model,
      estimatedCostAtomic,
      requestFingerprint: this.requestFingerprint(input, binding),
      decidedAt: this.now(),
      ...(reliabilityAdmission ? { reliabilityAdmission } : {}),
    });
    if (admission.status !== "execute") return admission;

    let reliabilityToken: { tokenId: string } | undefined;
    if (input.reliabilityContext) {
      if (!input.credentialId) throw new Error("RELIABILITY_CREDENTIAL_ID_REQUIRED");
      if (!this.config.store.recordReliabilityAttempt || !this.config.store.authorizeReliabilityDispatch
        || !this.config.store.markReliabilityDispatchPrimitiveEntered || !this.config.store.awaitReliabilityDispatchRelease) {
        throw new Error("RELIABILITY_DISPATCH_STORE_REQUIRED");
      }
      if (admission.protocolAdmissionCommitted !== true) await this.config.store.recordReliabilityAttempt({
        ...input.reliabilityContext,
        requestId: input.requestId,
        reservedCostMicros: admission.reservedCostAtomic,
        request: {
          method: "POST",
          route: "/v1/chat/completions",
          organizationId: input.organizationId,
          credentialId: input.credentialId,
          mandateId: input.mandateId,
          branchId: input.branchId ?? null,
          workloadClass: input.workloadClass ?? null,
          idempotencyKey: input.requestId,
          body: {
            model: binding.model,
            max_tokens: input.maxOutputTokens,
            ...(input.workloadClass ? { workload_class: input.workloadClass } : {}),
            messages: input.messages,
          },
        },
      });
      reliabilityToken = await this.config.store.authorizeReliabilityDispatch({
        ...input.reliabilityContext, requestId: input.requestId, ownerId: input.agentId,
      });
      await this.config.store.awaitReliabilityDispatchRelease({
        ...input.reliabilityContext, requestId: input.requestId, tokenId: reliabilityToken.tokenId,
      });
    }

    let response: ProviderResult;
    try {
      response = await binding.provider.complete({
        requestId: input.requestId,
        childId: input.agentId,
        model: binding.model,
        inputTokens: input.inputTokens,
        maxOutputTokens: input.maxOutputTokens,
        messages: input.messages,
        ...(input.reliabilityContext && reliabilityToken ? {
          onDispatchPrimitiveEntered: () => this.config.store.markReliabilityDispatchPrimitiveEntered!({
            runId: input.reliabilityContext!.runId, requestId: input.requestId, tokenId: reliabilityToken!.tokenId,
          }),
        } : {}),
      });
    } catch (error) {
      const transport = error as { primitiveEntered?: unknown; generationId?: unknown; code?: unknown };
      const provablyNotDispatched = transport.primitiveEntered === false;
      if (input.reliabilityContext) {
        if (!provablyNotDispatched && this.config.store.holdReliabilityAttempt) {
          await this.config.store.holdReliabilityAttempt({
            runId: input.reliabilityContext.runId, laneId: input.reliabilityContext.laneId,
            requestId: input.requestId, reasonCode: String(transport.code ?? "PROVIDER_OUTCOME_AMBIGUOUS"),
            ...(typeof transport.generationId === "string" ? { generationId: transport.generationId } : {}),
          });
        }
      }
      if (provablyNotDispatched) {
        const ordinaryFailure = {
          requestId: input.requestId,
          organizationId: input.organizationId,
          failureCode: "PROVIDER_NOT_DISPATCHED",
          failedAt: this.now(),
        };
        if (input.reliabilityContext) {
          if (!this.config.store.classifyReliabilityNotDispatchedAtomically) {
            throw new Error("ATOMIC_RELIABILITY_NOT_DISPATCHED_REQUIRED");
          }
          await this.config.store.classifyReliabilityNotDispatchedAtomically({
            ordinary: ordinaryFailure,
            protocol: {
              runId: input.reliabilityContext.runId,
              laneId: input.reliabilityContext.laneId,
              requestId: input.requestId,
              reasonCode: String(transport.code ?? "PRE_ENTRY_FAILURE"),
            },
          });
        } else {
          await this.config.store.failInference(ordinaryFailure);
        }
      } else {
        await this.config.store.holdInference({
          requestId: input.requestId,
          organizationId: input.organizationId,
          reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS",
          heldAt: this.now(),
        });
      }
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
      const ordinaryCompletion = {
        requestId: input.requestId,
        organizationId: input.organizationId,
        actualCostAtomic,
        response,
        completedAt: this.now(),
      };
      const responseProjection = input.reliabilityContext ? this.stableResponseProjection(
        admission.decision, admission.reservedCostAtomic, actualCostAtomic, response,
      ) : undefined;
      completed = input.reliabilityContext && this.config.store.completeReliabilityInference
        ? await this.config.store.completeReliabilityInference({ ordinary: ordinaryCompletion, protocol: {
          runId: input.reliabilityContext.runId, laneId: input.reliabilityContext.laneId,
          requestId: input.requestId, response, responseProjection: responseProjection!, actualCostMicros: actualCostAtomic,
        } })
        : await this.config.store.completeInference(ordinaryCompletion);
      if (input.reliabilityContext && !this.config.store.completeReliabilityInference && this.config.store.completeReliabilityAttempt) {
        await this.config.store.completeReliabilityAttempt({
          runId: input.reliabilityContext.runId, laneId: input.reliabilityContext.laneId,
          requestId: input.requestId, response, responseProjection: responseProjection!,
          actualCostMicros: actualCostAtomic,
        });
      }
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
      if (input.reliabilityContext && this.config.store.holdReliabilityAttempt) {
        await this.config.store.holdReliabilityAttempt({
          runId: input.reliabilityContext.runId, laneId: input.reliabilityContext.laneId,
          requestId: input.requestId, reasonCode, response, generationId: response.id,
        });
      }
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

  private stableResponseProjection(
    decision: StoredPolicyDecision,
    reservationAtomic: bigint,
    actualCostAtomic: bigint,
    response: ProviderResult,
  ): StableSuccessfulResponseProjection {
    if (decision.result.outcome !== "ALLOW" || decision.result.wouldOutcome !== "ALLOW"
      || decision.result.enforced !== true || decision.result.reasonCodes.length !== 0) {
      throw new Error("RELIABILITY_RESPONSE_DECISION_INVALID");
    }
    return {
      id: response.id,
      object: "chat.completion",
      model: decision.input.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: response.content } }],
      usage: {
        prompt_tokens: response.usage.inputTokens,
        completion_tokens: response.usage.outputTokens,
        total_tokens: response.usage.inputTokens + response.usage.outputTokens,
      },
      fuse: {
        decision: {
          id: decision.id, outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [],
        },
        ...(decision.input.branchId && decision.input.workloadClass ? { workloadScope: {
          branchId: decision.input.branchId,
          workloadClass: decision.input.workloadClass,
        } } : {}),
        reservationAtomic: reservationAtomic.toString(),
        actualCostAtomic: actualCostAtomic.toString(),
      },
    };
  }

  private providerBinding(organizationId: string): Promise<ProviderExecutionBinding> {
    if ("resolveProvider" in this.config) return this.config.resolveProvider(organizationId);
    return Promise.resolve(this.config);
  }

  private now(): string {
    return (this.config.now ?? (() => new Date().toISOString()))();
  }
}
