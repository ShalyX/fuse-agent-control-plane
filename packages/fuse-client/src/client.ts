import { FuseClientError } from "./errors.js";
import type {
  FuseAgentCredentialInput,
  FuseAgentCredentialResult,
  FuseAgentRegistrationInput,
  FuseAgentRegistrationResult,
  FuseClientOptions,
  FuseWorkspaceCreateInput,
  FuseWorkspaceCreateResult,
  FuseHttpMethod,
  FuseInferenceInput,
  FuseInferenceResult,
  FuseReceipt,
  FuseReceiptPage,
  FuseSandboxRun,
  FuseTransport,
} from "./types.js";

class FetchTransport implements FuseTransport {
  constructor(private readonly baseUrl: string, private readonly credential: string) {}

  async request<T>(method: FuseHttpMethod, path: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credential}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const body = payload as { error?: { code?: string; [key: string]: unknown } };
      throw new FuseClientError(response.status, body.error?.code ?? "FUSE_REQUEST_FAILED", body.error ?? {});
    }
    return payload as T;
  }
}

export class FuseClient {
  private readonly transport: FuseTransport;

  constructor(options: FuseClientOptions) {
    this.transport = options.transport ?? new FetchTransport(options.baseUrl, options.credential);
  }

  readiness(): Promise<Record<string, unknown>> {
    return this.transport.request("GET", "/api/v1/product/readiness");
  }

  registerAgent(input: FuseAgentRegistrationInput): Promise<FuseAgentRegistrationResult> {
    return this.transport.request("POST", "/api/v1/product/agents", {
      headers: { "X-Request-Id": input.requestId },
      body: { agentId: input.agentId, name: input.name },
    });
  }

  issueAgentCredential(input: FuseAgentCredentialInput): Promise<FuseAgentCredentialResult> {
    return this.transport.request("POST", "/api/v1/product/agent-credentials", {
      headers: { "X-Request-Id": input.requestId },
      body: {
        credentialId: input.credentialId,
        agentId: input.agentId,
        name: input.name,
        capabilities: input.capabilities,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      },
    });
  }


  listReceipts(mandateId: string, options: { limit?: number; cursor?: string } = {}): Promise<FuseReceiptPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const suffix = query.toString() ? `?${query}` : "";
    return this.transport.request("GET", `/api/v1/product/mandates/${encodeURIComponent(mandateId)}/receipts${suffix}`);
  }

  getReceipt(mandateId: string, requestId: string): Promise<{ receipt: FuseReceipt }> {
    return this.transport.request("GET", `/api/v1/product/receipts/${encodeURIComponent(requestId)}`, {
      headers: { "X-Fuse-Mandate": mandateId },
    });
  }

  runSandbox(seed?: string): Promise<FuseSandboxRun> {
    return this.transport.request("POST", "/api/v1/product/sandbox/runs", {
      body: seed === undefined ? {} : { seed },
    });
  }

  inference(input: FuseInferenceInput): Promise<FuseInferenceResult> {
    const headers: Record<string, string> = {
      "Idempotency-Key": input.requestId,
      "X-Fuse-Mandate": input.mandateId,
    };
    if (input.branchId) headers["X-Fuse-Branch"] = input.branchId;
    if (input.workloadClass) headers["X-Fuse-Workload-Class"] = input.workloadClass;
    return this.transport.request("POST", "/api/v1/product/inference", {
      headers,
      body: {
        model: input.model,
        messages: input.messages,
        ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
        ...(input.workloadClass === undefined ? {} : { workload_class: input.workloadClass }),
      },
    });
  }
}

export async function createFuseWorkspace(baseUrl: string, input: FuseWorkspaceCreateInput): Promise<FuseWorkspaceCreateResult> {
  const { inviteToken, ...body } = input;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/product/workspaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey ?? `workspace-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
      ...(inviteToken === undefined ? {} : { "X-Fuse-Invite": inviteToken }),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = payload as { error?: { code?: string; [key: string]: unknown } };
    throw new FuseClientError(response.status, body.error?.code ?? "FUSE_WORKSPACE_CREATION_FAILED", body.error ?? {});
  }
  return payload as FuseWorkspaceCreateResult;
}

export async function recoverFuseWorkspaceCredential(baseUrl: string, workspaceId: string, recoveryCode: string, idempotencyKey = globalThis.crypto.randomUUID()): Promise<{ workspaceId: string; agentId: string; credential: FuseWorkspaceCreateResult["credential"] }> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/product/workspaces/${encodeURIComponent(workspaceId)}/credential-recovery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ recoveryCode }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = payload as { error?: { code?: string; [key: string]: unknown } };
    throw new FuseClientError(response.status, body.error?.code ?? "FUSE_CREDENTIAL_RECOVERY_FAILED", body.error ?? {});
  }
  return payload as { workspaceId: string; agentId: string; credential: FuseWorkspaceCreateResult["credential"] };
}


export function createFuseClient(options: FuseClientOptions): FuseClient {
  return new FuseClient(options);
}
