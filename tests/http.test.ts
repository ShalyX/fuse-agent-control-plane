import { describe, expect, it } from "vitest";
import request from "supertest";
import type { RequestHandler } from "express";
import { createFuseApp } from "../src/http/app.js";
import type { InferenceProvider } from "../src/core/service.js";
import { MemoryStateStore } from "../src/persistence/store.js";
import type { CredentialAuthenticator } from "../src/http/auth.js";
import type { CredentialAdministrationPort } from "../src/identity/credentialAdministration.js";

class FakeProvider implements InferenceProvider {
  calls = 0;
  async complete() {
    this.calls += 1;
    return {
      id: "msg-1",
      content: "Fuse response",
      usage: { inputTokens: 1000, outputTokens: 100 },
    };
  }
}

function fakePaymentGuard(price: string): RequestHandler {
  return (req, res, next) => {
    if (!req.header("PAYMENT-SIGNATURE")) {
      res.status(402).json({
        x402Version: 2,
        accepts: [{ scheme: "exact", amount: price, network: "eip155:5042002" }],
      });
      return;
    }
    res.locals.fusePayment = {
      authorizationHash: "0xlive-payment",
      gatewayStatus: "accepted",
    };
    next();
  };
}

describe("POST /v1/chat/completions", () => {
  it("holds provider output behind an exact x402 quote and reuses it on paid retry", async () => {
    const provider = new FakeProvider();
    const app = createFuseApp({
      provider,
      paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000,
    });
    const body = {
      model: "claude-sonnet",
      max_tokens: 1000,
      messages: [{ role: "user", content: "Research Arc" }],
    };

    const unpaid = await request(app)
      .post("/v1/chat/completions")
      .set("Idempotency-Key", "req-1")
      .set("X-Fuse-Child", "scout")
      .send(body);

    expect(unpaid.status).toBe(402);
    expect(unpaid.body.accepts[0].amount).toBe("0.004500");
    expect(provider.calls).toBe(1);

    const paid = await request(app)
      .post("/v1/chat/completions")
      .set("Idempotency-Key", "req-1")
      .set("X-Fuse-Child", "scout")
      .set("PAYMENT-SIGNATURE", "signed-eip3009")
      .send(body);

    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({
      id: "msg-1",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "Fuse response" } }],
      fuse: {
        receipt: {
          childId: "scout",
          costUsdc: "0.004500",
          gatewayStatus: "accepted",
        },
      },
    });
    expect(provider.calls).toBe(1);
  });

  it("survives a cold start between the unpaid quote and paid retry", async () => {
    const provider = new FakeProvider();
    const stateStore = new MemoryStateStore();
    const dependencies = {
      provider,
      paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000,
      stateStore,
    };
    const body = {
      model: "claude-sonnet",
      max_tokens: 1000,
      messages: [{ role: "user", content: "Research Arc" }],
    };
    const unpaid = await request(createFuseApp(dependencies))
      .post("/v1/chat/completions")
      .set("Idempotency-Key", "cold-start-1")
      .set("X-Fuse-Child", "scout")
      .send(body);
    expect(unpaid.status).toBe(402);

    const paid = await request(createFuseApp(dependencies))
      .post("/v1/chat/completions")
      .set("Idempotency-Key", "cold-start-1")
      .set("X-Fuse-Child", "scout")
      .set("PAYMENT-SIGNATURE", "signed-eip3009")
      .send(body);
    expect(paid.status).toBe(200);
    expect(paid.body.fuse.receipt.costUsdc).toBe("0.004500");
    expect(provider.calls).toBe(1);

    const state = await request(createFuseApp(dependencies)).get("/api/state");
    expect(state.body.root.settledUsdc).toBe("0.004500");
    expect(state.headers["cache-control"]).toContain("no-store");

    const run = await request(createFuseApp(dependencies)).get("/api/runs/demo-mandate");
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({
      recordId: "demo-mandate",
      persistence: "memory",
      state: { root: { settledUsdc: "0.004500" } },
      receipts: [{ requestId: "cold-start-1", childId: "scout" }],
    });
    expect(run.headers["cache-control"]).toContain("no-store");
  });

  it("serves a proof-forward landing page with direct verification links", async () => {
    const app = createFuseApp({
      provider: new FakeProvider(),
      paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000,
    });
    const landing = await request(app).get("/");
    expect(landing.status).toBe(200);
    expect(landing.text).toContain("Programmable spend control for autonomous agents");
    expect(landing.text).toContain("/api/runs/demo-mandate");
    expect(landing.text).toContain("testnet.arcscan.app/address/0xf736609aa15b255322df4d5dfe6ea66b59b7c663");
    expect(landing.text).toContain("Historical paid run");
    expect(landing.text).not.toContain("fake");
  });

  it("serves the control desk and machine-readable budget tree", async () => {
    const app = createFuseApp({
      provider: new FakeProvider(),
      paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000,
    });
    const desk = await request(app).get("/desk");
    expect(desk.status).toBe(200);
    expect(desk.text).toContain("Fuse Control Desk");
    expect(desk.text).toContain("Deterministic isolation scenario");
    expect(desk.text).toContain("LIVE INSTANCE STATE");
    expect(desk.text).not.toContain("<span>$0.009</span>");
    expect(desk.text).not.toContain("<span id=\"review-spend\">$0.004</span>");

    const state = await request(app).get("/api/state");
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      mandateId: "demo-mandate",
      parentUnallocatedUsdc: "0.020000",
      root: { authorizedUsdc: "0.250000" },
      children: {
        scout: { circuitState: "HEALTHY", authorizedUsdc: "0.060000" },
        reviewer: { circuitState: "HEALTHY", authorizedUsdc: "0.050000" },
      },
    });
  });

  it("exposes authenticated principal context without changing public evidence routes", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "agent",
        principalId: "agent-1",
        organizationId: "org-1",
        credentialId: "cred-1",
        capabilities: ["mandates:read"],
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(),
      paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000,
      credentialAuthenticator,
    });

    const response = await request(app)
      .get("/api/v1/identity")
      .set("Authorization", "Bearer fuse_sk_valid");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      principalType: "agent",
      principalId: "agent-1",
      organizationId: "org-1",
      credentialId: "cred-1",
      capabilities: ["mandates:read"],
    });
    expect(response.headers["cache-control"]).toContain("no-store");
    expect((await request(app).get("/api/state")).status).toBe(200);
  });

  it("provides tenant-scoped service-account credential administration routes", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "service_account",
        role: "admin",
        principalId: "service-1",
        organizationId: "org-1",
        credentialId: "service-cred-1",
        capabilities: ["credentials:issue", "credentials:revoke"],
      }),
    };
    const calls: unknown[] = [];
    const credentialAdministration: CredentialAdministrationPort = {
      issueAgentCredential: async (principal, input) => {
        calls.push({ action: "issue", principal, input });
        return {
          credentialId: input.credentialId,
          token: "fuse_sk_once",
          tokenPrefix: "fuse_sk_once",
          capabilities: [...input.capabilities],
          expiresAt: input.expiresAt ?? null,
        };
      },
      revokeAgentCredential: async (principal, credentialId, requestId) => {
        calls.push({ action: "revoke", principal, credentialId, requestId });
      },
      issueServiceAccountCredential: async (principal, input) => {
        calls.push({ action: "issue-service", principal, input });
        return {
          credentialId: input.credentialId,
          token: "fuse_sk_service_once",
          tokenPrefix: "fuse_sk_service_once".slice(0, 20),
          capabilities: [...input.capabilities],
          expiresAt: input.expiresAt ?? null,
        };
      },
      revokeServiceAccountCredential: async (principal, credentialId, requestId) => {
        calls.push({ action: "revoke-service", principal, credentialId, requestId });
      },
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000, credentialAuthenticator, credentialAdministration,
    });

    const issue = await request(app)
      .post("/api/v1/admin/agent-credentials")
      .set("Authorization", "Bearer service-key")
      .set("X-Request-Id", "request:issue-1")
      .send({
        credentialId: "agent-cred-1",
        agentId: "agent-1",
        name: "Scout runtime",
        capabilities: ["inference:invoke"],
        expiresAt: "2026-08-13T18:00:00.000Z",
      });
    expect(issue.status).toBe(201);
    expect(issue.body).toMatchObject({ credentialId: "agent-cred-1", token: "fuse_sk_once" });
    expect(issue.headers["cache-control"]).toContain("no-store");

    const revoke = await request(app)
      .post("/api/v1/admin/agent-credentials/agent-cred-1/revoke")
      .set("Authorization", "Bearer service-key")
      .set("X-Request-Id", "request:revoke-1");
    expect(revoke.status).toBe(204);

    const rotateService = await request(app)
      .post("/api/v1/admin/service-account-credentials")
      .set("Authorization", "Bearer service-key")
      .set("X-Request-Id", "request:rotate-service-1")
      .send({
        credentialId: "service-cred-2",
        serviceAccountId: "service-1",
        name: "rotated admin",
        capabilities: ["credentials:issue", "credentials:revoke"],
        expiresAt: "2026-07-14T18:00:00.000Z",
      });
    expect(rotateService.status).toBe(201);
    expect(rotateService.headers["cache-control"]).toContain("no-store");
    const revokeService = await request(app)
      .post("/api/v1/admin/service-account-credentials/service-cred-1/revoke")
      .set("Authorization", "Bearer service-key")
      .set("X-Request-Id", "request:revoke-service-1");
    expect(revokeService.status).toBe(204);
    expect(calls).toHaveLength(4);
  });

  it("requires idempotency and child capability headers", async () => {
    const app = createFuseApp({
      provider: new FakeProvider(),
      paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000,
    });
    const response = await request(app).post("/v1/chat/completions").send({});
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });
});
