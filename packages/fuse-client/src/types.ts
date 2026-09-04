export type FuseHttpMethod = "GET" | "POST";

export interface FuseTransport {
  request<T>(method: FuseHttpMethod, path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<T>;
}

export interface FuseAgentRegistrationInput {
  agentId: string;
  name: string;
  requestId: string;
}

export interface FuseAgentRegistrationResult {
  agentId: string;
}

export interface FuseAgentCredentialInput {
  credentialId: string;
  agentId: string;
  name: string;
  capabilities: string[];
  requestId: string;
  expiresAt?: string | null;
}

export interface FuseAgentCredentialResult {
  credentialId: string;
  token: string;
  tokenPrefix: string;
  capabilities: string[];
  expiresAt: string | null;
}
export interface FuseWorkspaceCreateInput {
  name: string;
  agentName: string;
  provider: "openrouter";
  model: string;
  apiKey: string;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  maximumSpendAtomic: string;
  idempotencyKey?: string;
  inviteToken?: string;
  expiresAt?: string | null;
}


export interface FuseWorkspaceCreateResult {
  workspaceId: string;
  agentId: string;
  mandateId: string;
  policyId: string;
  providerConfigId: string;
  adminCredential: { credentialId: string; token: string; tokenPrefix: string; capabilities: string[]; expiresAt: string | null };
  credential: { credentialId: string; token: string; tokenPrefix: string; capabilities: string[]; expiresAt: string | null };
  recoveryCode: string;
  next: { method: "POST"; path: "/api/v1/product/inference"; headers: Record<string, string> };
}

export interface FuseClientOptions {
  baseUrl: string;
  credential: string;
  transport?: FuseTransport;
}

export interface FuseWorkspaceContext {
  workspaceId: string;
  agentId: string;
  policyId: string;
  mandateId: string;
  providerConfigId: string;
  provider: "openrouter" | null;
  model: string | null;
}

export interface FuseReceipt {
  decisionId: string;
  requestId: string;
  workspaceId: string;
  mandateId: string;
  agentId: string;
  policyId: string;
  policyVersion: number;
  outcome: string;
  wouldOutcome: string;
  enforced: boolean;
  reasonCodes: string[];
  estimatedCostAtomic: string;
  reservedCostAtomic: string | null;
  actualCostAtomic: string | null;
  executionStatus: string | null;
  failureCode: string | null;
  reconciliationResolved: boolean;
}

export interface FuseReceiptPage {
  receipts: FuseReceipt[];
  nextCursor: string | null;
}

export interface FuseSandboxRun {
  runId: string;
  workspaceId: string;
  seed: string;
  mode: "sandbox";
  status: "completed";
  scout: { branchId: "scout"; circuitState: "TRIPPED"; reclaimedAtomic: string };
  reviewer: { branchId: "reviewer"; status: "completed"; actualCostAtomic: string };
  events: Array<{ sequence: number; branchId: string; type: string; requestId: string; amountAtomic?: string; circuitState?: string; reason?: string }>;
}

export interface FuseInferenceInput {
  mandateId: string;
  requestId: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens: number;
  branchId?: string;
  workloadClass?: string;
}

export interface FuseInferenceResult {
  status: "completed";
  response: unknown;
  decisionId: string;
  reservedCostAtomic: string;
  actualCostAtomic: string;
}

export interface FuseInferenceWithReceiptResult {
  result: FuseInferenceResult;
  receipt: FuseReceipt;
}

export class FuseClientError extends Error {
  readonly name = "FuseClientError";
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}
