import type { ExecutionSettlement, StoredPolicyDecision } from "../persistence/policyStore.js";

export type ProductExecutionMode = "sandbox" | "live";
export type ProductExecutionStatus = "admitted" | "denied" | "executing" | "completed" | "held" | "failed";
export type ProductPaymentStatus = "not_applicable" | "pending_batch" | "settled" | "failed" | "unknown";
export type ProductArcEvidenceStatus = "not_applicable" | "pending" | "verified" | "unavailable";

export interface ProductExecutionEvidence {
  provider?: string | null;
  model?: string | null;
  branchId?: string | null;
  workloadClass?: string | null;
  circuitState?: string | null;
  circuitReason?: string | null;
  payment?: {
    status: ProductPaymentStatus;
    facilitatorReference?: string | null;
  };
  arc?: {
    status: ProductArcEvidenceStatus;
    commitmentReference?: string | null;
  };
}

export interface ProductExecutionProjectionInput {
  organizationId: string;
  decision: StoredPolicyDecision;
  mode?: ProductExecutionMode;
  status?: ProductExecutionStatus;
  settlement?: ExecutionSettlement | null;
  evidence?: ProductExecutionEvidence;
}

export interface ProductExecution {
  executionId: string;
  requestId: string;
  workspaceId: string;
  mandateId: string;
  agentId: string;
  mode: ProductExecutionMode;
  status: ProductExecutionStatus;
  branchId: string | null;
  workloadClass: string | null;
  provider: string | null;
  model: string | null;
  costs: {
    requestedAtomic: string;
    reservedAtomic: string | null;
    reportedAtomic: string | null;
    settledAtomic: string | null;
  };
  circuit: {
    state: string | null;
    reason: string | null;
  };
  payment: {
    status: ProductPaymentStatus;
    facilitatorReference: string | null;
  };
  arc: {
    status: ProductArcEvidenceStatus;
    commitmentReference: string | null;
  };
}

function atomic(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

export function projectProductExecution(input: ProductExecutionProjectionInput): ProductExecution {
  const mode = input.mode ?? "live";
  const settlement = input.settlement ?? null;
  const evidence = input.evidence ?? {};
  const payment = mode === "sandbox"
    ? { status: "not_applicable" as const, facilitatorReference: null }
    : {
      status: evidence.payment?.status ?? "unknown" as const,
      facilitatorReference: evidence.payment?.facilitatorReference ?? null,
    };
  const arc = mode === "sandbox"
    ? { status: "not_applicable" as const, commitmentReference: null }
    : {
      status: evidence.arc?.status ?? "unavailable" as const,
      commitmentReference: evidence.arc?.commitmentReference ?? null,
    };
  return {
    executionId: input.decision.requestId,
    requestId: input.decision.requestId,
    workspaceId: input.organizationId,
    mandateId: input.decision.mandateId,
    agentId: input.decision.agentId,
    mode,
    status: input.status ?? (settlement?.status === "completed" ? "completed" : input.decision.result.enforced ? "admitted" : "denied"),
    branchId: evidence.branchId ?? null,
    workloadClass: evidence.workloadClass ?? null,
    provider: evidence.provider ?? null,
    model: evidence.model ?? null,
    costs: {
      requestedAtomic: input.decision.input.estimatedCostAtomic.toString(),
      reservedAtomic: atomic(settlement?.reservedCostAtomic),
      reportedAtomic: atomic(settlement?.actualCostAtomic),
      settledAtomic: settlement?.status === "completed" ? atomic(settlement.actualCostAtomic) : null,
    },
    circuit: { state: evidence.circuitState ?? null, reason: evidence.circuitReason ?? null },
    payment,
    arc,
  };
}
