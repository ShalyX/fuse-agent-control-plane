import { describe, expect, it } from "vitest";
import request from "supertest";
import type { RequestHandler } from "express";
import { createFuseApp } from "../src/http/app.js";
import type { InferenceProvider } from "../src/core/service.js";
import { MemoryStateStore } from "../src/persistence/store.js";
import type { CredentialAuthenticator } from "../src/http/auth.js";
import type { CredentialAdministrationPort } from "../src/identity/credentialAdministration.js";
import type { PolicyAdministrationPort } from "../src/policy/policyAdministration.js";

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

  it("denies authenticated controlled inference before provider or payment side effects", async () => {
    const provider = new FakeProvider();
    let paymentAttempts = 0;
    let executionCalls = 0;
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "agent",
        principalId: "mans-primary",
        organizationId: "org-shaly",
        credentialId: "cred-shaly",
        capabilities: ["inference:invoke"],
      }),
    };
    const app = createFuseApp({
      provider,
      paymentGuard: () => {
        paymentAttempts += 1;
        return (_request, response) => response.status(500).end();
      },
      estimateInputTokens: () => 100,
      credentialAuthenticator,
      inferenceExecution: {
        execute: async () => {
          executionCalls += 1;
          return {
            status: "denied",
            decision: {
              id: "decision-denied",
              result: {
                outcome: "DENY",
                wouldOutcome: "DENY",
                enforced: true,
                reasonCodes: ["MODEL_NOT_ALLOWED"],
              },
            },
          };
        },
      },
    } as Parameters<typeof createFuseApp>[0]);

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer fuse_sk_shaly")
      .set("Idempotency-Key", "req-denied")
      .set("X-Fuse-Mandate", "shaly-main")
      .send({
        model: "client-hint",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: {
        code: "POLICY_DENIED",
        decisionId: "decision-denied",
        reasonCodes: ["MODEL_NOT_ALLOWED"],
      },
    });
    expect(executionCalls).toBe(1);
    expect(provider.calls).toBe(0);
    expect(paymentAttempts).toBe(0);
  });

  it("sanitizes controlled inference failures instead of exposing database details", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "agent",
        principalId: "mans-primary",
        organizationId: "org-shaly",
        credentialId: "cred-shaly",
        capabilities: ["inference:invoke"],
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(),
      paymentGuard: () => (_request, response) => response.status(500).end(),
      estimateInputTokens: () => 100,
      credentialAuthenticator,
      inferenceExecution: {
        execute: async () => {
          throw new Error("password authentication failed for secret-host");
        },
      },
    });

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer fuse_sk_shaly")
      .set("Idempotency-Key", "req-internal")
      .set("X-Fuse-Mandate", "shaly-main")
      .send({
        model: "client-hint",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: "INTERNAL_ERROR" } });
    expect(response.text).not.toContain("secret-host");
    expect(response.text).not.toContain("password");
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
        capabilities: ["credentials:issue", "credentials:revoke", "agents:write"],
      }),
    };
    const calls: unknown[] = [];
    const credentialAdministration: CredentialAdministrationPort = {
      registerAgent: async (principal, input) => {
        calls.push({ action: "register-agent", principal, input });
      },
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

    const registerAgent = await request(app)
      .post("/api/v1/admin/agents")
      .set("Authorization", "Bearer service-key")
      .set("X-Request-Id", "request:register-agent-1")
      .send({ agentId: "agent-1", name: "Scout" });
    expect(registerAgent.status).toBe(201);
    expect(registerAgent.body).toEqual({ agentId: "agent-1" });
    expect(registerAgent.headers["cache-control"]).toContain("no-store");

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
    expect(calls).toHaveLength(5);
  });

  it("provides tenant-scoped policy and mandate administration routes", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "service_account",
        role: "admin",
        principalId: "admin-1",
        organizationId: "org-1",
        credentialId: "admin-cred-1",
        capabilities: ["policies:write", "policies:read", "mandates:admin"],
      }),
    };
    const calls: string[] = [];
    const policyAdministration: PolicyAdministrationPort = {
      publishPolicy: async (_principal, input) => { calls.push(`policy:${input.policyId}`); },
      createMandate: async (_principal, input) => { calls.push(`mandate:${input.mandateId}`); },
      assignAgent: async (_principal, input) => { calls.push(`assign:${input.agentId}`); },
      transitionMandate: async (_principal, input) => { calls.push(`transition:${input.to}`); },
      setMandatePolicy: async (_principal, input) => { calls.push(`policy-bind:${input.policyVersion}`); },
      getPolicy: async (principal, policyId, version) => ({
        id: policyId,
        organizationId: principal.organizationId,
        version,
        mode: "dry_run",
        allowedProviders: ["anthropic"],
        allowedModels: ["claude-sonnet-4-6"],
        requiredCapability: "inference:invoke",
        limits: {
          maxPerCallAtomic: 10_000n, maxHourlyAtomic: 50_000n, maxDailyAtomic: 250_000n,
          maxRequestsPerMinute: 10, maxInputTokens: 20_000, maxOutputTokens: 4_000,
        },
        createdAt: "2026-07-13T21:00:00.000Z",
      }),
      listReconciliationCases: async () => [{
        requestId: "held-request", mandateId: "mandate-1", agentId: "agent-1",
        provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
        reasonCode: "PROVIDER_OUTCOME_AMBIGUOUS", reservedCostAtomic: 1_800n,
        reportedCostAtomic: null, hasProviderResponse: true,
        heldAt: "2026-07-13T21:01:00.000Z",
      }],
      resolveReconciliation: async (_principal, input) => {
        if (input.note === "Conflicting evidence") throw new Error("RECONCILIATION_RESOLUTION_CONFLICT");
        calls.push(`reconcile:${input.executionRequestId}:${input.resolution}`);
      },
      listDecisions: async (principal, mandateId) => [{
        id: "decision-1",
        requestId: "request:inference-1",
        organizationId: principal.organizationId,
        mandateId,
        agentId: "agent-1",
        policyId: "policy-1",
        policyVersion: 1,
        result: { outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] },
        input: {
          id: "decision-1", requestId: "request:inference-1",
          organizationId: principal.organizationId, mandateId, agentId: "agent-1",
          agentCapabilities: ["inference:invoke"], provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6", estimatedCostAtomic: 1800n,
          inputTokens: 100, maxOutputTokens: 100, spentHourAtomic: 0n,
          spentDayAtomic: 0n, mandateSpentAtomic: 0n, mandateMaximumAtomic: 250000n,
          requestCountLastMinute: 0, decidedAt: "2026-07-13T21:00:00.000Z",
        },
      }],
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000, credentialAuthenticator, policyAdministration,
    });
    const auth = { Authorization: "Bearer policy-admin", "X-Request-Id": "request:policy" };
    const publish = await request(app).post("/api/v1/admin/policies").set(auth).send({
      policyId: "policy-1", version: 1, mode: "dry_run",
      allowedProviders: ["anthropic"], allowedModels: ["claude-sonnet-4-6"],
      requiredCapability: "inference:invoke",
      limits: {
        maxPerCallAtomic: "10000", maxHourlyAtomic: "50000", maxDailyAtomic: "250000",
        maxRequestsPerMinute: 10, maxInputTokens: 20000, maxOutputTokens: 4000,
      },
    });
    expect(publish.status).toBe(201);
    expect(publish.headers["cache-control"]).toContain("no-store");
    const mandate = await request(app).post("/api/v1/admin/mandates").set(auth).send({
      mandateId: "mandate-1", name: "Inference allowance", assetId: "arc-testnet/usdc",
      maximumSpendAtomic: "250000", policyId: "policy-1", policyVersion: 1,
      expiresAt: "2026-08-13T21:00:00.000Z",
    });
    expect(mandate.status).toBe(201);
    expect((await request(app).post("/api/v1/admin/mandates/mandate-1/agents").set(auth)
      .send({ agentId: "agent-1" })).status).toBe(204);
    expect((await request(app).post("/api/v1/admin/mandates/mandate-1/transitions").set(auth)
      .send({ to: "active" })).status).toBe(204);
    expect((await request(app).post("/api/v1/admin/mandates/mandate-1/transitions").set(auth)
      .send({ to: "paused" })).status).toBe(204);
    expect((await request(app).post("/api/v1/admin/mandates/mandate-1/policy").set(auth)
      .send({ policyId: "policy-1", policyVersion: 2 })).status).toBe(204);
    const readPolicy = await request(app).get("/api/v1/admin/policies/policy-1/versions/1").set(auth);
    expect(readPolicy.status).toBe(200);
    expect(readPolicy.body.limits.maxPerCallAtomic).toBe("10000");
    const decisions = await request(app).get("/api/v1/admin/mandates/mandate-1/decisions").set(auth);
    expect(decisions.status).toBe(200);
    expect(decisions.body.decisions).toHaveLength(1);
    expect(decisions.body.decisions[0].input).toMatchObject({
      estimatedCostAtomic: "1800",
      mandateSpentAtomic: "0",
      mandateMaximumAtomic: "250000",
    });
    const cases = await request(app).get("/api/v1/admin/reconciliation").set(auth);
    expect(cases.status).toBe(200);
    expect(cases.body.cases[0]).toMatchObject({
      requestId: "held-request", reservedCostAtomic: "1800", reportedCostAtomic: null,
    });
    const resolved = await request(app)
      .post("/api/v1/admin/reconciliation/held-request/resolve")
      .set(auth)
      .send({
        resolution: "settle", actualCostAtomic: "125",
        note: "Confirmed against provider usage ledger",
        externalReference: "provider-ledger:provider-1",
      });
    expect(resolved.status).toBe(204);
    const conflict = await request(app)
      .post("/api/v1/admin/reconciliation/held-request/resolve")
      .set(auth)
      .send({
        resolution: "settle", actualCostAtomic: "126",
        note: "Conflicting evidence", externalReference: "provider-ledger:provider-1",
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: { code: "RECONCILIATION_RESOLUTION_CONFLICT" } });
    expect(calls).toEqual([
      "policy:policy-1", "mandate:mandate-1", "assign:agent-1", "transition:active",
      "transition:paused",
      "policy-bind:2",
      "reconcile:held-request:settle",
    ]);
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
