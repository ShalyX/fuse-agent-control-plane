import type { StoredPolicyDecision } from "../persistence/policyStore.js";
import {
  projectProductExecution,
  type ProductExecution,
  type ProductExecutionEvidence,
  type ProductExecutionMode,
  type ProductExecutionStatus,
} from "./executionReadModel.js";

export interface ProductReceiptReadModel {
  decisionId: string;
  requestId: string;
  workspaceId: string;
  mandateId: string;
  agentId: string;
  policy: {
    id: string;
    version: number;
    outcome: StoredPolicyDecision["result"]["outcome"];
    wouldOutcome: StoredPolicyDecision["result"]["wouldOutcome"];
    enforced: boolean;
    reasonCodes: string[];
  };
  execution: ProductExecution;
}

export interface ProductReceiptProjectionInput {
  organizationId: string;
  decision: StoredPolicyDecision;
  mode?: ProductExecutionMode;
  status?: ProductExecutionStatus;
  settlement?: import("../persistence/policyStore.js").ExecutionSettlement | null;
  evidence?: ProductExecutionEvidence;
}

export function projectProductReceipt(input: ProductReceiptProjectionInput): ProductReceiptReadModel {
  const execution = projectProductExecution(input);
  return {
    decisionId: input.decision.id,
    requestId: input.decision.requestId,
    workspaceId: input.organizationId,
    mandateId: input.decision.mandateId,
    agentId: input.decision.agentId,
    policy: {
      id: input.decision.policyId,
      version: input.decision.policyVersion,
      outcome: input.decision.result.outcome,
      wouldOutcome: input.decision.result.wouldOutcome,
      enforced: input.decision.result.enforced,
      reasonCodes: [...input.decision.result.reasonCodes],
    },
    execution,
  };
}
