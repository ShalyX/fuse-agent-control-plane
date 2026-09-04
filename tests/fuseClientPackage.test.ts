import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFuseWorkspace,
  createFuseClient,
  FuseClientError,
  type FuseTransport,
  type FuseWorkspaceCreateResult,
} from "../packages/fuse-client/src/index.js";

function recorder() {
  const calls: Array<{ method: string; path: string; options?: unknown }> = [];
  const transport: FuseTransport = {
    async request<T>(method, path, options) {
      calls.push({ method, path, options });
      return {} as T;
    },
  };
  return { calls, transport };
}

describe("@fuse/fuse-client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends beta invites outside the strict onboarding request body", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ workspaceId: "workspace-1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    await createFuseWorkspace("https://fuse.test", {
      name: "Workspace", agentName: "Agent", provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6", apiKey: "provider-secret",
      inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      maximumSpendAtomic: "100000", idempotencyKey: "workspace-request-1",
      inviteToken: "invite-secret",
    });

    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      "Idempotency-Key": "workspace-request-1",
      "X-Fuse-Invite": "invite-secret",
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("inviteToken");
  });

  it("types the one-time workspace administrator credential returned by onboarding", () => {
    const readAdminToken = (result: FuseWorkspaceCreateResult) => result.adminCredential.token;
    expect(readAdminToken).toBeTypeOf("function");
  });

  it("builds the documented sandbox and receipt requests", async () => {
    const { calls, transport } = recorder();
    const fuse = createFuseClient({ baseUrl: "https://fuse.test", credential: "credential", transport });
    await fuse.runSandbox("golden path");
    await fuse.getReceipt("mandate/1", "request/1");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/product/sandbox/runs", options: { body: { seed: "golden path" } } });
    expect(calls[1]).toMatchObject({ method: "GET", path: "/api/v1/product/receipts/request%2F1", options: { headers: { "X-Fuse-Mandate": "mandate/1" } } });
  });

  it("loads workspace context and reads a receipt after inference", async () => {
    const calls: string[] = [];
    const transport: FuseTransport = {
      async request<T>(method, path) {
        calls.push(`${method} ${path}`);
        if (path === "/api/v1/product/workspace-context") {
          return { workspaceId: "workspace-1", agentId: "agent-1", policyId: "policy-1", mandateId: "mandate-1", providerConfigId: "primary", provider: "openrouter", model: "anthropic/claude-sonnet-4.6" } as T;
        }
        if (path === "/api/v1/product/inference") {
          return { status: "completed", response: { ok: true }, decisionId: "decision-1", reservedCostAtomic: "100", actualCostAtomic: "9" } as T;
        }
        return { receipt: { requestId: "request-1", actualCostAtomic: "9" } } as T;
      },
    };
    const fuse = createFuseClient({ baseUrl: "https://fuse.test", credential: "credential", transport });
    await expect(fuse.workspaceContext()).resolves.toMatchObject({ mandateId: "mandate-1", provider: "openrouter" });
    await expect(fuse.inferenceWithReceipt({ mandateId: "mandate-1", requestId: "request-1", model: "anthropic/claude-sonnet-4.6", maxTokens: 32, messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({ receipt: { requestId: "request-1" } });
    expect(calls).toEqual([
      "GET /api/v1/product/workspace-context",
      "POST /api/v1/product/inference",
      "GET /api/v1/product/receipts/request-1",
    ]);
  });

  it("preserves idempotency and workload scope for inference", async () => {
    const { calls, transport } = recorder();
    const fuse = createFuseClient({ baseUrl: "https://fuse.test", credential: "credential", transport });
    await fuse.inference({ mandateId: "mandate-1", requestId: "request-1", model: "model-1", maxTokens: 32, messages: [{ role: "user", content: "hello" }], branchId: "reviewer", workloadClass: "baseline" });
    expect(calls[0]).toMatchObject({ options: { headers: { "Idempotency-Key": "request-1", "X-Fuse-Mandate": "mandate-1", "X-Fuse-Branch": "reviewer", "X-Fuse-Workload-Class": "baseline" } } });
  });

  it("builds workspace-scoped agent registration and credential issuance requests", async () => {
    const { calls, transport } = recorder();
    const fuse = createFuseClient({ baseUrl: "https://fuse.test", credential: "credential", transport });
    await fuse.registerAgent({ agentId: "agent-1", name: "Builder", requestId: "request-agent" });
    await fuse.issueAgentCredential({
      credentialId: "credential-1", agentId: "agent-1", name: "Runtime",
      capabilities: ["inference:invoke"], requestId: "request-credential",
    });
    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/product/agents", options: {
        headers: { "X-Request-Id": "request-agent" }, body: { agentId: "agent-1", name: "Builder" },
      } },
      { method: "POST", path: "/api/v1/product/agent-credentials", options: {
        headers: { "X-Request-Id": "request-credential" }, body: {
          credentialId: "credential-1", agentId: "agent-1", name: "Runtime",
          capabilities: ["inference:invoke"],
        },
      } },
    ]);
  });

  it("exposes stable API errors", async () => {
    const transport: FuseTransport = { async request() { throw new FuseClientError(409, "REQUEST_IN_PROGRESS"); } };
    await expect(createFuseClient({ baseUrl: "https://fuse.test", credential: "credential", transport }).runSandbox())
      .rejects.toMatchObject({ status: 409, code: "REQUEST_IN_PROGRESS" });
  });
});
