import type { AdministrativePrincipal } from "../identity/credentialAdministration.js";
import type { DecisionPage, DecisionPageCursor, ExecutionSettlement, StoredPolicyDecision } from "../persistence/policyStore.js";
import type { PaymentEvidence } from "./paymentEvidence.js";

export interface ProductReceiptPayment {
  verified: boolean;
  transactionId: string | null;
  network: string | null;
  payer: string | null;
}

export interface ProductReceipt {
  decisionId: string;
  requestId: string;
  workspaceId: string;
  mandateId: string;
  agentId: string;
  policyId: string;
  policyVersion: number;
  outcome: StoredPolicyDecision["result"]["outcome"];
  wouldOutcome: StoredPolicyDecision["result"]["wouldOutcome"];
  enforced: boolean;
  reasonCodes: string[];
  estimatedCostAtomic: string;
  reservedCostAtomic: string | null;
  actualCostAtomic: string | null;
  executionStatus: ExecutionSettlement["status"] | null;
  failureCode: string | null;
  reconciliationResolved: boolean;
  payment: ProductReceiptPayment | null;
}

export interface ProductReceiptPage {
  receipts: ProductReceipt[];
  nextCursor: string | null;
}

export interface ProductReceiptPageOptions {
  cursor?: string;
  limit?: number;
}

const DEFAULT_RECEIPT_PAGE_SIZE = 50;
const MAX_RECEIPT_PAGE_SIZE = 100;

export interface ProductReceiptQueryPort {
  listDecisions(organizationId: string, mandateId: string): Promise<StoredPolicyDecision[]>;
  getDecision?(organizationId: string, mandateId: string, requestId: string): Promise<StoredPolicyDecision | null>;
  listExecutionSettlements?(organizationId: string, mandateId: string): Promise<ExecutionSettlement[]>;
  listDecisionsPage?(organizationId: string, mandateId: string, limit: number, cursor: DecisionPageCursor | null, agentId?: string): Promise<DecisionPage>;
  listExecutionSettlementsForRequests?(organizationId: string, mandateId: string, requestIds: string[]): Promise<ExecutionSettlement[]>;
  getPaymentEvidence?(organizationId: string, requestId: string): Promise<PaymentEvidence | null>;
  listPaymentEvidence?(organizationId: string, requestIds: string[]): Promise<PaymentEvidence[]>;
}

export class ProductReceiptService {
  constructor(private readonly query: ProductReceiptQueryPort) {}

  async list(principal: AdministrativePrincipal, mandateId: string): Promise<ProductReceipt[]> {
    if (!mandateId.trim()) throw new Error("MANDATE_REQUIRED");
    const decisions = await this.query.listDecisions(principal.organizationId, mandateId);
    const settlements = this.query.listExecutionSettlements
      ? await this.query.listExecutionSettlements(principal.organizationId, mandateId)
      : [];
    const settlementByRequestId = new Map(settlements.map((settlement) => [settlement.requestId, settlement]));
    const evidence = this.query.listPaymentEvidence
      ? await this.query.listPaymentEvidence(principal.organizationId, decisions.map((decision) => decision.requestId))
      : [];
    const evidenceByRequestId = new Map(evidence.map((entry) => [entry.requestId, entry]));
    const receipts = decisions.map((decision) => this.project(principal.organizationId, decision, settlementByRequestId.get(decision.requestId), evidenceByRequestId.get(decision.requestId)));
    return principal.principalType === "agent"
      ? receipts.filter((receipt) => receipt.agentId === principal.principalId)
      : receipts;
  }

  async listPage(principal: AdministrativePrincipal, mandateId: string, options: ProductReceiptPageOptions = {}): Promise<ProductReceiptPage> {
    const limit = options.limit ?? DEFAULT_RECEIPT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECEIPT_PAGE_SIZE) throw new Error("INVALID_RECEIPT_PAGE_SIZE");
    let cursor: DecisionPageCursor | null = null;
    if (options.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as { v?: number; decidedAt?: string; id?: string };
        if (decoded.v !== 2 || typeof decoded.decidedAt !== "string" || typeof decoded.id !== "string" || !decoded.id) throw new Error();
        if (Number.isNaN(Date.parse(decoded.decidedAt))) throw new Error();
        cursor = { decidedAt: decoded.decidedAt, id: decoded.id };
      } catch {
        throw new Error("INVALID_RECEIPT_CURSOR");
      }
    }
    if (this.query.listDecisionsPage) {
      const decisionPage = await this.query.listDecisionsPage(principal.organizationId, mandateId, limit, cursor,
        principal.principalType === "agent" ? principal.principalId : undefined);
      const requestIds = decisionPage.decisions.map((decision) => decision.requestId);
      const settlements = this.query.listExecutionSettlementsForRequests
        ? await this.query.listExecutionSettlementsForRequests(principal.organizationId, mandateId, requestIds)
        : [];
      const settlementByRequestId = new Map(settlements.map((settlement) => [settlement.requestId, settlement]));
      const evidence = this.query.listPaymentEvidence
        ? await this.query.listPaymentEvidence(principal.organizationId, requestIds)
        : [];
      const evidenceByRequestId = new Map(evidence.map((entry) => [entry.requestId, entry]));
      const pageReceipts = decisionPage.decisions.map((decision) => this.project(principal.organizationId, decision, settlementByRequestId.get(decision.requestId), evidenceByRequestId.get(decision.requestId)));
      return { receipts: pageReceipts, nextCursor: decisionPage.nextCursor
        ? Buffer.from(JSON.stringify({ v: 2, ...decisionPage.nextCursor })).toString("base64url") : null };
    }
    if (cursor) throw new Error("RECEIPT_CURSOR_UNSUPPORTED");
    const receipts = await this.list(principal, mandateId);
    const page = receipts.slice(0, limit);
    const nextOffset = page.length;
    return { receipts: page, nextCursor: null };
  }

  async get(principal: AdministrativePrincipal, mandateId: string, requestId: string): Promise<ProductReceipt> {
    if (!mandateId.trim()) throw new Error("MANDATE_REQUIRED");
    if (!requestId.trim()) throw new Error("REQUEST_ID_REQUIRED");
    if (this.query.getDecision) {
      const decision = await this.query.getDecision(principal.organizationId, mandateId, requestId);
      if (!decision || (principal.principalType === "agent" && decision.agentId !== principal.principalId)) throw new Error("RECEIPT_NOT_FOUND");
      const settlements = this.query.listExecutionSettlementsForRequests
        ? await this.query.listExecutionSettlementsForRequests(principal.organizationId, mandateId, [requestId])
        : [];
      const evidence = this.query.getPaymentEvidence
        ? await this.query.getPaymentEvidence(principal.organizationId, requestId)
        : null;
      return this.project(principal.organizationId, decision, settlements[0], evidence ?? undefined);
    }
    const receipts = await this.list(principal, mandateId);
    const receipt = receipts.find((candidate) => candidate.requestId === requestId);
    if (!receipt) throw new Error("RECEIPT_NOT_FOUND");
    return receipt;
  }

  private project(workspaceId: string, decision: StoredPolicyDecision, settlement?: ExecutionSettlement, evidence?: PaymentEvidence): ProductReceipt {
    const payment = evidence?.payment && typeof evidence.payment === "object"
      ? evidence.payment as Record<string, unknown>
      : undefined;
    return {
      decisionId: decision.id,
      requestId: decision.requestId,
      workspaceId,
      mandateId: decision.mandateId,
      agentId: decision.agentId,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      outcome: decision.result.outcome,
      wouldOutcome: decision.result.wouldOutcome,
      enforced: decision.result.enforced,
      reasonCodes: [...decision.result.reasonCodes],
      estimatedCostAtomic: decision.input.estimatedCostAtomic.toString(),
      reservedCostAtomic: settlement?.reservedCostAtomic.toString() ?? null,
      actualCostAtomic: settlement?.actualCostAtomic?.toString() ?? null,
      executionStatus: settlement?.status ?? null,
      failureCode: settlement?.failureCode ?? null,
      reconciliationResolved: settlement?.resolved ?? false,
      payment: evidence ? {
        verified: payment?.verified === true,
        transactionId: typeof payment?.transaction === "string"
          ? payment.transaction
          : typeof payment?.txHash === "string" ? payment.txHash : null,
        network: typeof payment?.network === "string" ? payment.network : null,
        payer: typeof payment?.payer === "string" ? payment.payer : null,
      } : null,
    };
  }
}
