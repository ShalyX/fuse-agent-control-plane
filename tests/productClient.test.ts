import { describe, expect, it } from "vitest";
import { ProductApiError, ProductClient, type ProductRequestOptions, type ProductTransport, type ProductHttpMethod } from "../src/product/client.js";

function transportRecorder() {
  const calls: Array<{ method: string; path: string; options?: unknown }> = [];
  const transport: ProductTransport = {
    async request<T>(method: ProductHttpMethod, path: string, options?: ProductRequestOptions) {
      calls.push({ method, path, options });
      return {} as T;
    },
  };
  return { calls, transport };
}

describe("ProductClient", () => {
  it("builds typed receipt requests with encoded scopes and opaque cursors", async () => {
    const { calls, transport } = transportRecorder();
    const client = new ProductClient({ baseUrl: "https://fuse.test", token: "credential", transport });
    await client.listReceipts("mandate/one", { limit: 25, cursor: "opaque:v2" });
    await client.getReceipt("mandate/one", "request/one");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/product/mandates/mandate%2Fone/receipts?limit=25&cursor=opaque%3Av2" });
    expect(calls[1]).toMatchObject({ method: "GET", path: "/api/v1/product/receipts/request%2Fone", options: { headers: { "X-Fuse-Mandate": "mandate/one" } } });
  });

  it("builds inference with idempotency and workload scope headers", async () => {
    const { calls, transport } = transportRecorder();
    const client = new ProductClient({ baseUrl: "https://fuse.test", token: "credential", transport });
    await client.infer({ mandateId: "mandate-1", requestId: "request-1", model: "model-1", messages: [{ role: "user", content: "hello" }], maxTokens: 20, branchId: "branch-1", workloadClass: "baseline" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/product/inference",
      options: {
        headers: { "Idempotency-Key": "request-1", "X-Fuse-Mandate": "mandate-1", "X-Fuse-Branch": "branch-1", "X-Fuse-Workload-Class": "baseline" },
        body: { model: "model-1", max_tokens: 20, workload_class: "baseline" },
      },
    });
  });

  it("builds the deterministic sandbox run request", async () => {
    const { calls, transport } = transportRecorder();
    const client = new ProductClient({ baseUrl: "https://fuse.test", token: "credential", transport });
    await client.runSandbox("golden path");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/product/sandbox/runs", options: { body: { seed: "golden path" } } });
  });

  it("exposes stable machine-readable API errors", async () => {
    const transport: ProductTransport = {
      async request() { throw new ProductApiError(404, "RECEIPT_NOT_FOUND", { requestId: "request-1" }); },
    };
    await expect(new ProductClient({ baseUrl: "https://fuse.test", token: "credential", transport }).getReceipt("mandate-1", "request-1"))
      .rejects.toMatchObject({ status: 404, code: "RECEIPT_NOT_FOUND" });
  });
});
