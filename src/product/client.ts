import type { ProductReceipt, ProductReceiptPage } from "./receipts.js";
import type { SandboxRun } from "./sandboxRuns.js";

export type ProductHttpMethod = "GET" | "POST";

export interface ProductRequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ProductTransport {
  request<T>(method: ProductHttpMethod, path: string, options?: ProductRequestOptions): Promise<T>;
}

export interface ProductClientOptions {
  baseUrl: string;
  token: string;
  transport?: ProductTransport;
}

export interface ProductReadiness {
  [key: string]: unknown;
}

export interface ProductInferenceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProductInferenceRequest {
  mandateId: string;
  requestId: string;
  model: string;
  messages: ProductInferenceMessage[];
  maxTokens: number;
  branchId?: string;
  workloadClass?: string;
}

export interface ProductInferenceResponse {
  status: "completed";
  response: unknown;
  decisionId: string;
  reservedCostAtomic: string;
  actualCostAtomic: string;
}

export interface ProductApiErrorBody {
  error?: {
    code?: string;
    [key: string]: unknown;
  };
}

export class ProductApiError extends Error {
  readonly name = "ProductApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

class FetchProductTransport implements ProductTransport {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async request<T>(method: ProductHttpMethod, path: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const body = payload as ProductApiErrorBody;
      throw new ProductApiError(response.status, body.error?.code ?? "PRODUCT_REQUEST_FAILED", body.error ?? {});
    }
    return payload as T;
  }
}

export class ProductClient {
  private readonly transport: ProductTransport;

  constructor(options: ProductClientOptions) {
    this.transport = options.transport ?? new FetchProductTransport(options.baseUrl, options.token);
  }

  readiness(): Promise<ProductReadiness> {
    return this.transport.request<ProductReadiness>("GET", "/api/v1/product/readiness");
  }

  listReceipts(mandateId: string, options: { limit?: number; cursor?: string } = {}): Promise<ProductReceiptPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.transport.request<ProductReceiptPage>("GET", `/api/v1/product/mandates/${encodeURIComponent(mandateId)}/receipts${suffix}`);
  }

  getReceipt(mandateId: string, requestId: string): Promise<{ receipt: ProductReceipt }> {
    return this.transport.request<{ receipt: ProductReceipt }>("GET", `/api/v1/product/receipts/${encodeURIComponent(requestId)}`, {
      headers: { "X-Fuse-Mandate": mandateId },
    });
  }

  runSandbox(seed?: string): Promise<SandboxRun> {
    return this.transport.request<SandboxRun>("POST", "/api/v1/product/sandbox/runs", {
      body: seed === undefined ? {} : { seed },
    });
  }

  infer(input: ProductInferenceRequest): Promise<ProductInferenceResponse> {
    const headers: Record<string, string> = {
      "Idempotency-Key": input.requestId,
      "X-Fuse-Mandate": input.mandateId,
    };
    if (input.branchId) headers["X-Fuse-Branch"] = input.branchId;
    if (input.workloadClass) headers["X-Fuse-Workload-Class"] = input.workloadClass;
    return this.transport.request<ProductInferenceResponse>("POST", "/api/v1/product/inference", {
      headers,
      body: {
        model: input.model,
        messages: input.messages,
        max_tokens: input.maxTokens,
        ...(input.workloadClass === undefined ? {} : { workload_class: input.workloadClass }),
      },
    });
  }
}
