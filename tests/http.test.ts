import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import request from "supertest";
import type { RequestHandler, Request } from "express";
import { createFuseApp } from "../src/http/app.js";
import type { InferenceProvider } from "../src/core/service.js";
import { MemoryStateStore } from "../src/persistence/store.js";
import { createSessionAwareAuthenticator, type CredentialAuthenticator } from "../src/http/auth.js";
import type { CredentialAdministrationPort } from "../src/identity/credentialAdministration.js";
import type { PolicyAdministrationPort } from "../src/policy/policyAdministration.js";
import type { ProviderAdministrationPort } from "../src/providers/providerAdministration.js";
import type { ControlledInferenceInput } from "../src/inference/inferenceExecution.js";
import { SandboxRunService } from "../src/product/sandboxRuns.js";
import type { SandboxRunStore } from "../src/product/sandboxRunStore.js";
import { MemoryPaymentEvidenceStore } from "../src/product/paymentEvidence.js";
import { ProductInferenceService } from "../src/product/inference.js";
import { newAdvisoryMemoryDb } from "./helpers/pgMemAdvisory.js";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { API_CAPABILITIES, createApiCredential } from "../src/identity/apiCredentials.js";
import { CustomerOnboardingService } from "../src/product/customerOnboarding.js";
import { MemoryHumanSessionStore } from "../src/http/humanSessions.js";

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
    (req as Request & { payment?: unknown }).payment = {
      authorizationHash: "0xlive-payment",
      gatewayStatus: "accepted",
    };
    next();
  };
}

describe("POST /v1/chat/completions", () => {
  it("executes in control mode without invoking payment middleware", async () => {
    const provider = new FakeProvider();
    let paymentAttempts = 0;
    const app = createFuseApp({
      provider,
      paymentMode: "control",
      paymentGuard: () => (_request, response) => {
        paymentAttempts += 1;
        response.status(402).json({ error: "payment must be disabled" });
      },
      estimateInputTokens: () => 1000,
    });

    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Idempotency-Key", "control-mode-1")
      .set("X-Fuse-Child", "scout")
      .send({
        model: "claude-sonnet",
        max_tokens: 100,
        messages: [{ role: "user", content: "Research Arc" }],
      });

    expect(response.status).toBe(200);
    expect(paymentAttempts).toBe(0);
    expect(provider.calls).toBe(1);
  });

  it("holds provider output behind an exact x402 quote and reuses it on paid retry", async () => {
    const provider = new FakeProvider();
    const app = createFuseApp({
      provider,
      paymentMode: "settlement",
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
    expect(unpaid.body.accepts[0].amount).toBe("0.018000");
    expect(provider.calls).toBe(0);

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
      paymentMode: "settlement" as const,
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
      paymentGuard: fakePaymentGuard,
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
      .set("PAYMENT-SIGNATURE", "signed-eip3009")
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

  it("maps product idempotency conflicts to a client conflict without payment", async () => {
    let paymentAttempts = 0;
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "agent", principalId: "agent-1", organizationId: "org-1",
        credentialId: "cred-1", capabilities: ["inference:invoke"],
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(),
      paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 20,
      credentialAuthenticator,
      productInferenceService: new ProductInferenceService({
        execute: async () => { throw new Error("IDEMPOTENCY_CONFLICT"); },
      }),
    } as Parameters<typeof createFuseApp>[0]);

    const response = await request(app)
      .post("/api/v1/product/inference")
      .set("Authorization", "Bearer fuse_sk_product")
      .set("Idempotency-Key", "product-conflict-1")
      .set("X-Fuse-Mandate", "mandate-1")
      .set("PAYMENT-SIGNATURE", "signed-eip3009")
      .send({
        model: "claude-sonnet-4-6",
        max_tokens: 1,
        messages: [{ role: "user", content: "conflict" }],
      });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(paymentAttempts).toBe(0);
  });

  it("returns an actionable code when the provider rejects the tenant credential", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "agent", principalId: "agent-provider-error", organizationId: "org-provider-error",
        credentialId: "cred-provider-error", capabilities: ["inference:invoke"],
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(),
      estimateInputTokens: () => 20,
      credentialAuthenticator,
      productInferenceService: new ProductInferenceService({
        execute: async () => { throw new Error("OPENROUTER_401"); },
      }),
    } as Parameters<typeof createFuseApp>[0]);

    const response = await request(app)
      .post("/api/v1/product/inference")
      .set("Authorization", "Bearer provider-error")
      .set("Idempotency-Key", "provider-error-1")
      .set("X-Fuse-Mandate", "mandate-provider-error")
      .send({ model: "anthropic/claude-sonnet-4.6", max_tokens: 1,
        messages: [{ role: "user", content: "credential check" }] });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: { code: "PROVIDER_CREDENTIAL_REJECTED" } });
  });

  it("rejects a policy-denied product request before payment settlement", async () => {
    let paymentAttempts = 0;
    let executionCalls = 0;
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "agent", principalId: "agent-denied", organizationId: "org-denied",
        credentialId: "cred-denied", capabilities: ["inference:invoke"],
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(),
      paymentGuard: () => {
        paymentAttempts += 1;
        return (_request, _response, next) => next();
      },
      estimateInputTokens: () => 10,
      credentialAuthenticator,
      productInferenceService: new ProductInferenceService({
        preview: async () => ({
          status: "denied" as const,
          decision: { id: "decision-denied", result: { reasonCodes: ["MODEL_NOT_ALLOWED"] } },
        } as never),
        execute: async () => {
          executionCalls += 1;
          throw new Error("PROVIDER_MUST_NOT_RUN");
        },
      }),
    });

    const response = await request(app)
      .post("/api/v1/product/inference")
      .set("Authorization", "Bearer denied-agent")
      .set("Idempotency-Key", "denied-product-1")
      .set("X-Fuse-Mandate", "mandate-denied")
      .send({ model: "blocked-model", max_tokens: 10, messages: [{ role: "user", content: "no" }] });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("POLICY_DENIED");
    expect(paymentAttempts).toBe(0);
    expect(executionCalls).toBe(0);
  });

  it("holds controlled inference output behind the Arc x402 quote", async () => {
    let executionCalls = 0;
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "agent", principalId: "scout", organizationId: "org-1",
        credentialId: "cred-scout", capabilities: ["inference:invoke"],
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentMode: "settlement", paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 20, credentialAuthenticator,
      inferenceExecution: {
        execute: async (input) => {
          executionCalls += 1;
          return {
            status: "completed" as const,
            decision: {
              id: "decision-paid", requestId: input.requestId,
              organizationId: input.organizationId, mandateId: input.mandateId,
              agentId: input.agentId, policyId: "policy-paid", policyVersion: 1,
              result: { outcome: "ALLOW" as const, wouldOutcome: "ALLOW" as const, enforced: true, reasonCodes: [] },
              input: { model: "claude-sonnet-4-6" },
            },
            reservedCostAtomic: 370n, actualCostAtomic: 370n,
            response: { id: "response-paid", content: "ok", usage: { inputTokens: 20, outputTokens: 1 } },
          };
        },
      },
    } as Parameters<typeof createFuseApp>[0]);
    const body = { model: "claude-sonnet-4-6", max_tokens: 1, messages: [{ role: "user", content: "Hello" }] };
    const unpaid = await request(app).post("/v1/chat/completions")
      .set("Authorization", "Bearer fuse_sk_controlled")
      .set("Idempotency-Key", "controlled-paid-1")
      .set("X-Fuse-Mandate", "mandate-1")
      .send(body);
    expect(unpaid.status).toBe(402);
    expect(unpaid.body.accepts[0].amount).toBe("0.000075");
    const paid = await request(app).post("/v1/chat/completions")
      .set("Authorization", "Bearer fuse_sk_controlled")
      .set("Idempotency-Key", "controlled-paid-1")
      .set("X-Fuse-Mandate", "mandate-1")
      .set("PAYMENT-SIGNATURE", "signed-eip3009")
      .send(body);
    expect(paid.status).toBe(200);
    expect(paid.body.choices[0].message.content).toBe("ok");
    expect(executionCalls).toBe(1);
  });

  it("binds workload scope to controlled inference and surfaces exposure plus shadow evidence", async () => {
    let observed: ControlledInferenceInput | undefined;
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "agent", principalId: "scout", organizationId: "org-1",
        credentialId: "cred-scout", capabilities: ["inference:invoke"],
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 20, credentialAuthenticator,
      workloadShadowEnabled: true,
      inferenceExecution: {
        execute: async (input) => {
          observed = input;
          return {
            status: "completed",
            decision: {
              id: "decision-shadow", requestId: input.requestId,
              organizationId: input.organizationId, mandateId: input.mandateId,
              agentId: input.agentId, policyId: "policy-shadow", policyVersion: 1,
              result: { outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] },
              input: {
                id: "decision-shadow", requestId: input.requestId,
                organizationId: input.organizationId, mandateId: input.mandateId,
                agentId: input.agentId, agentCapabilities: input.agentCapabilities,
                provider: "anthropic", model: "claude-sonnet-4-6",
                branchId: input.branchId, workloadClass: input.workloadClass,
                estimatedCostAtomic: 1_000n, inputTokens: input.inputTokens,
                maxOutputTokens: input.maxOutputTokens, spentHourAtomic: 0n,
                spentDayAtomic: 0n, mandateSpentAtomic: 0n, mandateMaximumAtomic: 100_000n,
                requestCountLastMinute: 0,
                exposure: {
                  branchLimitAtomic: 10_000n, branchCommittedBeforeAtomic: 300n,
                  requestReservationAtomic: 1_000n, maximumExposureAtomic: 9_700n,
                  remainingAuthorityAtomic: 8_700n,
                },
                decidedAt: "2026-07-20T00:12:00.000Z",
              },
            },
            reservedCostAtomic: 1_000n, actualCostAtomic: 400n,
            response: {
              id: "response-shadow", content: "ok",
              usage: { inputTokens: 20, outputTokens: 10 },
            },
            shadowEvaluation: {
              requestId: input.requestId, organizationId: input.organizationId,
              mandateId: input.mandateId, branchId: input.branchId!,
              workloadClass: input.workloadClass!, provider: "anthropic",
              model: "claude-sonnet-4-6", cohortKey: "c".repeat(64), cohortOrdinal: 15n,
              status: "scored",
              targetObservationCount: 3, comparableSiblingCount: 3,
              siblingAggregate: "mean", siblingAggregateAtomic: 300n,
              siblingWeightBps: 3_750, effectiveBaselineAtomic: 300n,
              divergenceRatioBps: 40_000, targetPriorRatioBps: 40_000,
              cohortPriorRatioBps: 10_000, eligibleForIntervention: true,
              signals: ["SIBLING_DIVERGENCE", "CLASS_PRIOR_EXCEEDED"],
              wouldEmitAnySignal: true, wouldSignalTarget: true, cohortShift: false,
              wouldSignal: true, evaluatedAt: "2026-07-20T00:12:00.000Z",
            },
          };
        },
      },
    });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer agent")
      .set("Idempotency-Key", "request-shadow")
      .set("X-Fuse-Mandate", "mandate-shadow")
      .set("X-Fuse-Branch", "branch-scout")
      .set("PAYMENT-SIGNATURE", "signed-eip3009")
      .send({
        model: "claude-sonnet-4-6", max_tokens: 10, workload_class: "lookup",
        messages: [{ role: "user", content: "Find the source" }],
      });
    expect(response.status).toBe(200);
    expect(observed).toMatchObject({ branchId: "branch-scout", workloadClass: "lookup" });
    expect(response.body.fuse).toMatchObject({
      workloadScope: { branchId: "branch-scout", workloadClass: "lookup" },
      exposure: { maximumExposureAtomic: "9700", remainingAuthorityAtomic: "8700" },
      shadowEvaluation: {
        status: "scored", cohortOrdinal: "15", siblingAggregateAtomic: "300",
        effectiveBaselineAtomic: "300", wouldSignal: true,
      },
    });
    const incomplete = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer agent")
      .set("Idempotency-Key", "request-incomplete")
      .set("X-Fuse-Mandate", "mandate-shadow")
      .set("X-Fuse-Branch", "branch-scout")
      .send({
        model: "claude-sonnet-4-6", max_tokens: 10,
        messages: [{ role: "user", content: "Find the source" }],
      });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body).toEqual({ error: { code: "INCOMPLETE_WORKLOAD_SCOPE" } });

    const rolloutDisabled = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 20, credentialAuthenticator,
      workloadShadowEnabled: false,
      inferenceExecution: {
        execute: async (input) => ({
          status: "completed" as const, decision: {
            id: "decision-legacy",
            requestId: input.requestId, organizationId: input.organizationId,
            mandateId: input.mandateId, agentId: input.agentId,
            policyId: "policy-1", policyVersion: 1,
            result: { outcome: "ALLOW" as const, wouldOutcome: "ALLOW" as const,
              enforced: true, reasonCodes: [] },
            input: { branchId: input.branchId, workloadClass: input.workloadClass },
          },
          reservedCostAtomic: 1n, actualCostAtomic: 1n,
          response: { id: "legacy", content: "ok", usage: { inputTokens: 1, outputTokens: 1 } },
        }),
      },
    });
    const disabledScope = await request(rolloutDisabled).post("/v1/chat/completions")
      .set("Authorization", "Bearer agent").set("Idempotency-Key", "disabled-scope")
      .set("X-Fuse-Mandate", "mandate-shadow").set("X-Fuse-Branch", "branch-scout")
      .send({ model: "claude-sonnet-4-6", max_tokens: 10, workload_class: "lookup",
        messages: [{ role: "user", content: "Find the source" }] });
    expect(disabledScope.status).toBe(409);
    expect(disabledScope.body).toEqual({ error: { code: "WORKLOAD_SHADOW_ROLLOUT_DISABLED" } });
    const legacyUnscoped = await request(rolloutDisabled).post("/v1/chat/completions")
      .set("Authorization", "Bearer agent").set("Idempotency-Key", "legacy-unscoped")
      .set("X-Fuse-Mandate", "mandate-shadow")
      .set("PAYMENT-SIGNATURE", "signed-eip3009")
      .send({ model: "claude-sonnet-4-6", max_tokens: 10,
        messages: [{ role: "user", content: "Find the source" }] });
    expect(legacyUnscoped.status).toBe(200);
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
      paymentGuard: fakePaymentGuard,
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
      .set("PAYMENT-SIGNATURE", "signed-eip3009")
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
    expect(landing.text).toContain("Fuse admits or denies agent inference");
    expect(landing.text).toContain("/api/runs/demo-mandate");
    expect(landing.text).toContain("testnet.arcscan.app/address/0xf736609aa15b255322df4d5dfe6ea66b59b7c663");
    expect(landing.text).toContain("Historical paid run");
    expect(landing.text).toContain('href="/console"');
    expect(landing.text).toContain("Settlement signer remains closed");
    expect(landing.text).not.toContain("awaiting API access");
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
      publishPolicy: async (_principal, input) => {
        calls.push(`policy:${input.policyId}:${input.workloadClasses?.[0]?.maxCostPerCallAtomic}`);
      },
      createMandate: async (_principal, input) => { calls.push(`mandate:${input.mandateId}`); },
      assignAgent: async (_principal, input) => { calls.push(`assign:${input.agentId}`); },
      createBranch: async (principal, input) => {
        if (input.branchId === "active-conflict") {
          throw new Error("MANDATE_BRANCH_CHANGE_REQUIRES_PAUSE");
        }
        if (input.branchId === "missing-parent") {
          throw new Error("MANDATE_PARENT_BRANCH_NOT_FOUND");
        }
        calls.push(`branch:${input.branchId}:${input.allowedWorkloadClasses.join(",")}`);
        return {
          id: input.branchId, organizationId: principal.organizationId,
          mandateId: input.mandateId, parentBranchId: input.parentBranchId,
          agentId: input.agentId, policyId: "policy-1", policyVersion: 1,
          allowedWorkloadClasses: input.allowedWorkloadClasses,
          maximumSpendAtomic: input.maximumSpendAtomic, expiresAt: input.expiresAt,
          delegationHash: "a".repeat(64), authoritySource: "fuse_control_plane",
          createdAt: "2026-07-13T21:00:00.000Z", createdBy: "service_account:admin-1",
        };
      },
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
        workloadClasses: [{
          id: "lookup", maxCostPerCallAtomic: 2_000n, maxInvocationsPerBranch: 10,
          aggregateBudgetAtomic: 10_000n, minimumInputTokens: 1,
          shadow: {
            classPriorWindowSpendAtomic: 300n, windowSeconds: 900,
            targetMinimumObservations: 3, siblingMinimumForScoring: 2,
            siblingMinimumForIntervention: 3, confidenceConstant: 5,
            divergenceThresholdBps: 30_000,
          },
        }],
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
      listShadowEvaluations: async (principal, mandateId) => [{
        requestId: "request:inference-1", organizationId: principal.organizationId,
        mandateId, branchId: "branch-scout", workloadClass: "lookup",
        provider: "anthropic", model: "claude-sonnet-4-6",
        cohortKey: "c".repeat(64), cohortOrdinal: 15n, status: "scored",
        targetObservationCount: 3, comparableSiblingCount: 3, siblingAggregate: "mean",
        siblingAggregateAtomic: 300n, siblingWeightBps: 3750,
        effectiveBaselineAtomic: 300n, divergenceRatioBps: 40_000,
        targetPriorRatioBps: 40_000, cohortPriorRatioBps: 10_000,
        eligibleForIntervention: true,
        signals: ["SIBLING_DIVERGENCE", "CLASS_PRIOR_EXCEEDED"],
        wouldEmitAnySignal: true, wouldSignalTarget: true, cohortShift: false,
        wouldSignal: true, evaluatedAt: "2026-07-13T21:02:00.000Z",
      }],
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000, credentialAuthenticator, policyAdministration,
      workloadShadowEnabled: true,
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
      workloadClasses: [{
        id: "lookup", maxCostPerCallAtomic: "2000", maxInvocationsPerBranch: 10,
        aggregateBudgetAtomic: "10000", minimumInputTokens: 1,
        shadow: {
          classPriorWindowSpendAtomic: "300", windowSeconds: 900,
          targetMinimumObservations: 3, siblingMinimumForScoring: 2,
          siblingMinimumForIntervention: 3, confidenceConstant: 5,
          divergenceThresholdBps: 30000,
        },
      }],
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
    const branch = await request(app)
      .post("/api/v1/admin/mandates/mandate-1/branches")
      .set(auth)
      .send({
        branchId: "branch-scout", parentBranchId: null, agentId: "agent-1",
        allowedWorkloadClasses: ["lookup"], maximumSpendAtomic: "10000", expiresAt: null,
      });
    expect(branch.status).toBe(201);
    expect(branch.body.branch).toMatchObject({
      id: "branch-scout", authoritySource: "fuse_control_plane",
      delegationHash: "a".repeat(64), maximumSpendAtomic: "10000", expiresAt: null,
    });
    const branchBody = {
      parentBranchId: null, agentId: "agent-1", allowedWorkloadClasses: ["lookup"],
      maximumSpendAtomic: "10000", expiresAt: null,
    };
    const stateConflict = await request(app)
      .post("/api/v1/admin/mandates/mandate-1/branches").set(auth)
      .send({ ...branchBody, branchId: "active-conflict" });
    expect(stateConflict.status).toBe(409);
    expect(stateConflict.body).toEqual({ error: { code: "MANDATE_BRANCH_CHANGE_REQUIRES_PAUSE" } });
    const missingParent = await request(app)
      .post("/api/v1/admin/mandates/mandate-1/branches").set(auth)
      .send({ ...branchBody, branchId: "missing-parent" });
    expect(missingParent.status).toBe(404);
    expect((await request(app).post("/api/v1/admin/mandates/mandate-1/transitions").set(auth)
      .send({ to: "active" })).status).toBe(204);
    expect((await request(app).post("/api/v1/admin/mandates/mandate-1/transitions").set(auth)
      .send({ to: "paused" })).status).toBe(204);
    expect((await request(app).post("/api/v1/admin/mandates/mandate-1/policy").set(auth)
      .send({ policyId: "policy-1", policyVersion: 2 })).status).toBe(204);
    const readPolicy = await request(app).get("/api/v1/admin/policies/policy-1/versions/1").set(auth);
    expect(readPolicy.status).toBe(200);
    expect(readPolicy.body.limits.maxPerCallAtomic).toBe("10000");
    expect(readPolicy.body.workloadClasses[0]).toMatchObject({
      id: "lookup", maxCostPerCallAtomic: "2000", aggregateBudgetAtomic: "10000",
      shadow: { classPriorWindowSpendAtomic: "300" },
    });
    const decisions = await request(app).get("/api/v1/admin/mandates/mandate-1/decisions").set(auth);
    expect(decisions.status).toBe(200);
    expect(decisions.body.decisions).toHaveLength(1);
    expect(decisions.body.decisions[0].input).toMatchObject({
      estimatedCostAtomic: "1800",
      mandateSpentAtomic: "0",
      mandateMaximumAtomic: "250000",
    });
    const shadow = await request(app)
      .get("/api/v1/admin/mandates/mandate-1/shadow-evaluations")
      .set(auth);
    expect(shadow.status).toBe(200);
    expect(shadow.body.evaluations[0]).toMatchObject({
      requestId: "request:inference-1", cohortOrdinal: "15", siblingAggregateAtomic: "300",
      effectiveBaselineAtomic: "300", wouldSignal: true,
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
    const rolloutDisabledApp = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1000, credentialAuthenticator, policyAdministration,
      workloadShadowEnabled: false,
    });
    const disabledPolicy = await request(rolloutDisabledApp)
      .post("/api/v1/admin/policies").set(auth).send({
        policyId: "disabled-policy", version: 1, mode: "enforce",
        allowedProviders: ["anthropic"], allowedModels: ["claude-sonnet-4-6"],
        requiredCapability: "inference:invoke",
        limits: {
          maxPerCallAtomic: "10000", maxHourlyAtomic: "50000", maxDailyAtomic: "250000",
          maxRequestsPerMinute: 10, maxInputTokens: 20000, maxOutputTokens: 4000,
        },
        workloadClasses: [{
          id: "lookup", maxCostPerCallAtomic: "2000", maxInvocationsPerBranch: 10,
          aggregateBudgetAtomic: "10000", minimumInputTokens: 1, shadow: null,
        }],
      });
    expect(disabledPolicy.status).toBe(409);
    expect(disabledPolicy.body).toEqual({ error: { code: "WORKLOAD_SHADOW_ROLLOUT_DISABLED" } });
    const disabledBranch = await request(rolloutDisabledApp)
      .post("/api/v1/admin/mandates/mandate-1/branches").set(auth).send({
        branchId: "disabled", parentBranchId: null, agentId: "agent-1",
        allowedWorkloadClasses: ["lookup"], maximumSpendAtomic: "10000", expiresAt: null,
      });
    expect(disabledBranch.status).toBe(409);
    expect(disabledBranch.body).toEqual({ error: { code: "WORKLOAD_SHADOW_ROLLOUT_DISABLED" } });
    expect(calls).toEqual([
      "policy:policy-1:2000", "mandate:mandate-1", "assign:agent-1",
      "branch:branch-scout:lookup", "transition:active", "transition:paused",
      "policy-bind:2",
      "reconcile:held-request:settle",
    ]);
  });

  it("configures and lists tenant provider metadata without returning the API key", async () => {
    const calls: string[] = [];
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "service_account", principalId: "admin-1", organizationId: "org-customer-zero",
        credentialId: "credential-1", capabilities: ["providers:read", "providers:write"], role: "admin",
      }),
    };
    const summary = {
      id: "primary", organizationId: "org-customer-zero", provider: "openrouter" as const,
      model: "anthropic/claude-sonnet-4.6", inputUsdPerMillion: "3.00",
      outputUsdPerMillion: "15.00", credentialVersion: 1, status: "active" as const,
      updatedAt: "2026-07-19T16:00:00.000Z",
    };
    const providerAdministration: ProviderAdministrationPort = {
      async configure(principal, input) {
        calls.push(`${principal.organizationId}:${input.configId}:${input.apiKey}:${input.requestId}`);
        return summary;
      },
      async list(principal) {
        calls.push(`list:${principal.organizationId}`);
        return [summary];
      },
      async retry(principal, configId, requestId) {
        calls.push(`retry:${principal.organizationId}:${configId}:${requestId}`);
        return summary;
      },
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1000,
      credentialAuthenticator, providerAdministration,
    });
    const headers = { Authorization: "Bearer provider-admin", "X-Request-Id": "request:provider" };

    const unsupported = await request(app).post("/api/v1/admin/providers").set(headers).send({
      configId: "primary", provider: "anthropic", model: "claude-sonnet-4-6",
      apiKey: "provider-secret",
      inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toEqual({ error: { code: "INVALID_PROVIDER_CONFIGURATION" } });
    expect(calls).toEqual([]);

    const created = await request(app).post("/api/v1/admin/providers").set(headers).send({
      configId: "primary", provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "sk-ant-customer-zero",
      inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ provider: summary });
    expect(created.text).not.toContain("sk-ant-customer-zero");
    const customEndpoint = await request(app).post("/api/v1/admin/providers").set(headers).send({
      configId: "primary", provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "sk-ant-customer-zero", baseUrl: "https://attacker.example",
      inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
    });
    expect(customEndpoint.status).toBe(400);
    expect(customEndpoint.body).toEqual({ error: { code: "INVALID_PROVIDER_CONFIGURATION" } });
    const listed = await request(app).get("/api/v1/admin/providers").set("Authorization", "Bearer provider-admin");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ providers: [summary] });
    const retried = await request(app).post("/api/v1/admin/providers/primary/retry")
      .set(headers);
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ provider: summary });
    expect(retried.text).not.toContain("«redacted:sk-…»");
    const missingRequestId = await request(app).post("/api/v1/admin/providers/primary/retry")
      .set("Authorization", headers.Authorization);
    expect(missingRequestId.status).toBe(400);
    expect(missingRequestId.body).toEqual({ error: { code: "REQUEST_ID_REQUIRED" } });
    expect(calls[0]).toMatch(/^org-customer-zero:primary:.+:request:provider$/);
    expect(calls.slice(1)).toEqual([
      "list:org-customer-zero",
      "retry:org-customer-zero:primary:request:provider",
    ]);
  });

  it("maps an in-flight provider retry to a conflict", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-provider-admin", principalType: "service_account",
        principalId: "provider-admin", organizationId: "org-customer-zero",
        capabilities: ["providers:write"], role: "admin",
      }),
    };
    const providerAdministration: ProviderAdministrationPort = {
      async configure() { return summary; },
      async list() { return [summary]; },
      async retry() { throw new Error("PROVIDER_VERIFICATION_IN_PROGRESS"); },
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator, providerAdministration,
    });
    const failed = await request(app).post("/api/v1/admin/providers/primary/retry")
      .set("Authorization", "Bearer provider-admin")
      .set("X-Request-Id", "request-provider-in-flight");
    expect(failed.status).toBe(409);
    expect(failed.body).toEqual({ error: { code: "PROVIDER_VERIFICATION_IN_PROGRESS" } });
  });

  it("sanitizes provider administration storage failures", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-provider-admin", principalType: "service_account",
        principalId: "provider-admin", organizationId: "org-customer-zero",
        capabilities: ["providers:read", "providers:write"], role: "admin",
      }),
    };
    const providerAdministration: ProviderAdministrationPort = {
      async configure() { throw new Error("postgres://user:password@private-host/fuse"); },
      async list() { throw new Error("postgres://user:password@private-host/fuse"); },
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator, providerAdministration,
    });
    const failed = await request(app).post("/api/v1/admin/providers")
      .set("Authorization", "Bearer provider-admin")
      .set("X-Request-Id", "request-provider-failure")
      .send({
        configId: "primary", provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
        apiKey: "sk-ant-customer-zero", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: { code: "PROVIDER_ADMINISTRATION_UNAVAILABLE" } });
    expect(failed.text).not.toContain("postgres");
    expect(failed.text).not.toContain("password");
  });

  it("serves workspace-scoped product readiness without exposing secrets", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-readiness", principalType: "service_account",
        principalId: "operator-readiness", organizationId: "org-readiness",
        capabilities: ["mandates:read"], role: "operator",
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator,
      productReadiness: async ({ organizationId }) => ({
        paymentMode: "control",
        database: true, providerConfiguration: false, policyConfiguration: false,
        agentCredential: false, mandate: false, signerConfiguration: false,
        walletChain: false, gatewayEnvironment: false, sandbox: true,
      }),
    });
    const response = await request(app).get("/api/v1/product/readiness")
      .set("Authorization", "Bearer readiness");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      workspaceId: "org-readiness",
      status: "incomplete",
      checks: {
        database: "verified", provider: "unavailable", policy: "unavailable",
        agentCredential: "unavailable", mandate: "unavailable", signer: "not_applicable",
        wallet: "not_applicable", gateway: "not_applicable", sandbox: "verified",
      },
      missingSteps: [
        "Connect a provider", "Publish a policy", "Issue an agent credential", "Create a mandate",
      ],
    });
    expect(response.text).not.toContain("secret");
  });

  it("serves workspace-scoped provider connections through the product API", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-provider-product", principalType: "service_account",
        principalId: "operator-provider", organizationId: "workspace-provider",
        capabilities: ["providers:read", "providers:write"], role: "admin",
      }),
    };
    const calls: unknown[] = [];
    const providerConnectionService = {
      async connect(principal: { organizationId: string }, input: unknown) {
        calls.push({ principal, input });
        return {
          id: "primary", organizationId: principal.organizationId, provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
          credentialVersion: 1, status: "active", updatedAt: "2026-08-11T00:00:00.000Z",
        };
      },
      async list(principal: { organizationId: string }) {
        return [{
          id: "primary", organizationId: principal.organizationId, provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
          credentialVersion: 1, status: "active", updatedAt: "2026-08-11T00:00:00.000Z",
        }];
      },
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator, providerConnectionService: providerConnectionService as never,
    });
    const headers = { Authorization: "Bearer provider-product", "X-Request-Id": "request-product-provider" };
    const created = await request(app).post("/api/v1/product/provider-connections").set(headers).send({
      configId: "primary", provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "provider-secret", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
    });
    expect(created.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(created.text).not.toContain("provider-secret");

    const listed = await request(app).get("/api/v1/product/provider-connections")
      .set("Authorization", headers.Authorization);
    expect(listed.status).toBe(200);
    expect(listed.body.providers[0]).toMatchObject({ organizationId: "workspace-provider" });
  });

  it("serves the product mandate lifecycle through workspace-scoped routes", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-mandate-product", principalType: "service_account",
        principalId: "operator-mandate", organizationId: "workspace-mandate",
        capabilities: ["mandates:admin"], role: "admin",
      }),
    };
    const calls: unknown[] = [];
    const mandateManagementService = {
      async createMandate(_principal: unknown, input: unknown) { calls.push({ kind: "create", input }); },
      async assignAgent(_principal: unknown, input: unknown) { calls.push({ kind: "assign", input }); },
      async createBranch(_principal: unknown, input: unknown) {
        calls.push({ kind: "branch", input });
        return { id: "branch-1", mandateId: "mandate-1", organizationId: "workspace-mandate",
          parentBranchId: null, agentId: "agent-1", allowedWorkloadClasses: ["lookup"],
          maximumSpendAtomic: 60000n, expiresAt: null, delegationHash: "hash-1" };
      },
      async transitionMandate(_principal: unknown, input: unknown) { calls.push({ kind: "transition", input }); },
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator, mandateManagementService: mandateManagementService as never,
      workloadShadowEnabled: true,
    });
    const headers = { Authorization: "Bearer mandate-product", "X-Request-Id": "request-mandate-product" };
    const created = await request(app).post("/api/v1/product/mandates").set(headers).send({
      mandateId: "mandate-1", name: "Primary", assetId: "usd-micros", maximumSpendAtomic: "250000",
      policyId: "policy-1", policyVersion: 1, expiresAt: null,
    });
    expect(created.status).toBe(201);
    const assigned = await request(app).post("/api/v1/product/mandates/mandate-1/agents")
      .set(headers).send({ agentId: "agent-1" });
    expect(assigned.status).toBe(204);
    const branch = await request(app).post("/api/v1/product/mandates/mandate-1/branches")
      .set(headers).send({ branchId: "branch-1", parentBranchId: null, agentId: "agent-1",
        allowedWorkloadClasses: ["lookup"], maximumSpendAtomic: "60000", expiresAt: null });
    expect(branch.status).toBe(201);
    expect(branch.body.branch.maximumSpendAtomic).toBe("60000");
    const transition = await request(app).post("/api/v1/product/mandates/mandate-1/transitions")
      .set(headers).send({ to: "active" });
    expect(transition.status).toBe(204);
    expect(calls.map((call) => (call as { kind: string }).kind)).toEqual(["create", "assign", "branch", "transition"]);
  });

  it("publishes policies through the product API and preserves the shadow rollout gate", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-policy-product", principalType: "service_account",
        principalId: "operator-policy", organizationId: "workspace-policy",
        capabilities: ["policies:write"], role: "admin",
      }),
    };
    const calls: unknown[] = [];
    const policyPublishingService = { async publish(_principal: unknown, input: unknown) { calls.push(input); } };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator, policyPublishingService: policyPublishingService as never,
      workloadShadowEnabled: false,
    });
    const headers = { Authorization: "Bearer policy-product", "X-Request-Id": "request-policy-product" };
    const body = { policyId: "policy-1", version: 1, mode: "enforce", allowedProviders: ["anthropic"],
      allowedModels: ["claude-sonnet-4-6"], requiredCapability: "inference:invoke",
      limits: { maxPerCallAtomic: "10000", maxHourlyAtomic: "50000", maxDailyAtomic: "250000",
        maxRequestsPerMinute: 30, maxInputTokens: 20000, maxOutputTokens: 4000 }, workloadClasses: [] };
    const published = await request(app).post("/api/v1/product/policies").set(headers).send(body);
    expect(published.status).toBe(201);
    expect(calls).toHaveLength(1);
    const blocked = await request(app).post("/api/v1/product/policies").set(headers).send({ ...body,
      workloadClasses: [{ id: "lookup", maxCostPerCallAtomic: "10000", maxInvocationsPerBranch: 20,
        aggregateBudgetAtomic: "60000", minimumInputTokens: 1, shadow: null }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("WORKLOAD_SHADOW_ROLLOUT_DISABLED");
  });

  it("serves product agent registration and one-time credential issuance", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-identity-product", principalType: "service_account",
        principalId: "operator-identity", organizationId: "workspace-identity",
        capabilities: ["agents:write", "credentials:issue"], role: "admin",
      }),
    };
    const calls: unknown[] = [];
    const agentIdentityService = {
      async registerAgent(_principal: unknown, input: unknown) { calls.push({ kind: "agent", input }); },
      async issueCredential(_principal: unknown, input: unknown) {
        calls.push({ kind: "credential", input });
        return { credentialId: "credential-2", token: "fuse_sk_once", tokenPrefix: "fuse_sk_",
          capabilities: ["inference:invoke"], expiresAt: null };
      },
    };
    const app = createFuseApp({ provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, credentialAuthenticator, agentIdentityService: agentIdentityService as never });
    const headers = { Authorization: "Bearer identity-product", "X-Request-Id": "request-identity-product" };
    const registered = await request(app).post("/api/v1/product/agents").set(headers).send({ agentId: "agent-1", name: "Builder" });
    expect(registered.status).toBe(201);
    const issued = await request(app).post("/api/v1/product/agent-credentials").set(headers).send({
      credentialId: "credential-2", agentId: "agent-1", name: "Runtime",
      capabilities: ["inference:invoke"], expiresAt: null,
    });
    expect(issued.status).toBe(201);
    expect(issued.body.token).toBe("fuse_sk_once");
    expect(calls.map((call) => (call as { kind: string }).kind)).toEqual(["agent", "credential"]);
  });

  it("serves workspace-scoped product receipts without raw decision inputs", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-receipts-product", principalType: "agent",
        principalId: "agent-receipts", organizationId: "workspace-receipts",
        capabilities: ["receipts:read"],
      }),
    };
    const productReceiptService = {
      async list(principal: { organizationId: string }, mandateId: string) {
        return [{ decisionId: "decision-1", requestId: "request-1", workspaceId: principal.organizationId,
          mandateId, agentId: "agent-receipts", policyId: "policy-1", policyVersion: 1,
          outcome: "allow", wouldOutcome: "allow", enforced: true, reasonCodes: [],
          estimatedCostAtomic: "123", reservedCostAtomic: null, actualCostAtomic: null,
          executionStatus: null, failureCode: null, reconciliationResolved: false }];
      },
      async listPage(principal: { organizationId: string }, mandateId: string) {
        return { receipts: await this.list(principal, mandateId), nextCursor: null };
      },
    };
    const app = createFuseApp({ provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, credentialAuthenticator,
      productReceiptService: productReceiptService as never });
    const response = await request(app).get("/api/v1/product/mandates/mandate-1/receipts")
      .set("Authorization", "Bearer receipts-product");
    expect(response.status).toBe(200);
    expect(response.body.receipts[0]).toMatchObject({ workspaceId: "workspace-receipts", mandateId: "mandate-1", estimatedCostAtomic: "123" });
    expect(response.text).not.toMatch(/prompt|secret|token/i);
  });

  it("forwards receipt cursors and rejects malformed cursor input", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({ credentialId: "credential-page", principalType: "service_account", principalId: "operator-page", organizationId: "workspace-page", capabilities: ["receipts:read"] }),
    };
    let receivedCursor: string | undefined;
    const productReceiptService = {
      async listPage(_principal: unknown, _mandateId: string, options: { cursor?: string }) {
        receivedCursor = options.cursor;
        if (options.cursor === "bad") throw new Error("INVALID_RECEIPT_CURSOR");
        return { receipts: [], nextCursor: "opaque-v2" };
      },
    };
    const app = createFuseApp({ provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, credentialAuthenticator, productReceiptService: productReceiptService as never });
    const ok = await request(app).get("/api/v1/product/mandates/mandate-page/receipts?limit=2&cursor=opaque-v2")
      .set("Authorization", "Bearer page");
    expect(ok.status).toBe(200);
    expect(receivedCursor).toBe("opaque-v2");
    const bad = await request(app).get("/api/v1/product/mandates/mandate-page/receipts?cursor=bad")
      .set("Authorization", "Bearer page");
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: { code: "INVALID_RECEIPT_CURSOR" } });
  });

  it("serves a single product receipt and returns 404 for a missing request", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({ credentialId: "credential-single-receipt", principalType: "agent", principalId: "agent-single", organizationId: "workspace-single", capabilities: ["receipts:read"] }),
    };
    const productReceiptService = {
      async get(principal: { organizationId: string }, mandateId: string, requestId: string) {
        if (requestId === "missing") throw new Error("RECEIPT_NOT_FOUND");
        return { decisionId: "decision-single", requestId, workspaceId: principal.organizationId, mandateId,
          agentId: "agent-single", policyId: "policy-1", policyVersion: 1, outcome: "allow",
          wouldOutcome: "allow", enforced: true, reasonCodes: [], estimatedCostAtomic: "10",
          reservedCostAtomic: "10", actualCostAtomic: "9", executionStatus: "completed",
          failureCode: null, reconciliationResolved: false };
      },
    };
    const app = createFuseApp({ provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, credentialAuthenticator, productReceiptService: productReceiptService as never });
    const headers = { Authorization: "Bearer single-receipt", "X-Fuse-Mandate": "mandate-single" };
    const found = await request(app).get("/api/v1/product/receipts/request-single").set(headers);
    expect(found.status).toBe(200);
    expect(found.body.receipt).toMatchObject({ requestId: "request-single", workspaceId: "workspace-single", actualCostAtomic: "9" });
    const missing = await request(app).get("/api/v1/product/receipts/missing").set(headers);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: "RECEIPT_NOT_FOUND" } });
  });

  it("serves bounded product inference from the authenticated agent principal", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-inference-product", principalType: "agent",
        principalId: "agent-inference", organizationId: "workspace-inference",
        capabilities: ["inference:invoke"],
      }),
    };
    let captured: unknown;
    const productInferenceService = {
      async execute(_principal: unknown, input: unknown) {
        captured = input;
        return { status: "in_progress" as const };
      },
    };
    const app = createFuseApp({ provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 7, credentialAuthenticator,
      productInferenceService: productInferenceService as never });
    const response = await request(app).post("/api/v1/product/inference")
      .set("Authorization", "Bearer inference-product")
      .set("X-Request-Id", "request-inference-product")
      .set("X-Fuse-Mandate", "mandate-1")
      .set("PAYMENT-SIGNATURE", "signed-eip3009")
      .send({ model: "claude-sonnet-4-6", max_tokens: 32, messages: [{ role: "user", content: "hello" }] });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: "REQUEST_IN_PROGRESS" } });
    expect(captured).toMatchObject({ requestId: "request-inference-product", mandateId: "mandate-1", inputTokens: 7,
      maxOutputTokens: 32 });
  });

  it("holds completed product inference behind the payment guard", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        credentialId: "credential-inference-paid", principalType: "agent",
        principalId: "agent-inference", organizationId: "workspace-inference",
        capabilities: ["inference:invoke"],
      }),
    };
    const productInferenceService = {
      async execute() {
        return {
          status: "completed" as const,
          decision: { id: "decision-paid" },
          reservedCostAtomic: 20n,
          actualCostAtomic: 10n,
          response: { id: "response-paid", content: "paid response", usage: { inputTokens: 7, outputTokens: 3 } },
        };
      },
    };
    const app = createFuseApp({ provider: new FakeProvider(), paymentMode: "settlement", paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 7, credentialAuthenticator,
      productInferenceService: productInferenceService as never });
    const base = request(app).post("/api/v1/product/inference")
      .set("Authorization", "Bearer inference-paid")
      .set("Idempotency-Key", "request-inference-paid")
      .set("X-Fuse-Mandate", "mandate-1")
      .send({ model: "claude-sonnet-4-6", max_tokens: 32, messages: [{ role: "user", content: "hello" }] });
    const unpaid = await base;
    expect(unpaid.status).toBe(402);
    const paid = await request(app).post("/api/v1/product/inference")
      .set("Authorization", "Bearer inference-paid")
      .set("Idempotency-Key", "request-inference-paid-2")
      .set("X-Fuse-Mandate", "mandate-1")
      .set("PAYMENT-SIGNATURE", "test-payment")
      .send({ model: "claude-sonnet-4-6", max_tokens: 32, messages: [{ role: "user", content: "hello" }] });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "completed", decisionId: "decision-paid", actualCostAtomic: "10" });
  });

  it("creates a ready workspace through the customer onboarding route", async () => {
    const app = createFuseApp({ provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1,
      credentialAuthenticator: { authenticateToken: async () => null },
      customerOnboardingService: {
        createWorkspace: async (input: unknown) => ({
          workspaceId: "workspace-customer", agentId: "agent-customer", mandateId: "mandate-customer",
          policyId: "policy-customer", providerConfigId: "provider-customer",
          credential: { credentialId: "credential-customer", token: "fuse_sk_once", tokenPrefix: "fuse_sk_", capabilities: ["inference:invoke", "receipts:read"], expiresAt: null },
        }),
      },
    });
    const response = await request(app).post("/api/v1/product/workspaces").set("Idempotency-Key", "http-onboard-1").send({
      name: "Customer workspace", agentName: "researcher", provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "provider-secret", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00", maximumSpendAtomic: "100000",
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ workspaceId: "workspace-customer", mandateId: "mandate-customer", credential: { token: "fuse_sk_once" } });
    expect(JSON.stringify(response.body)).not.toContain("provider-secret");
  });

  it("revokes the current human session through the HTTP boundary", async () => {
    const sessions = new MemoryHumanSessionStore();
    const sourceAuthenticator = {
      authenticateToken: async (token: string) => token === "service-token" ? {
        principalType: "service_account" as const,
        principalId: "service-1",
        organizationId: "org-session",
        credentialId: "source-credential",
        capabilities: [...API_CAPABILITIES],
        role: "admin" as const,
      } : null,
      isCredentialActive: async () => true,
    };
    const authenticator = createSessionAwareAuthenticator(sourceAuthenticator, sessions);
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator: authenticator,
      humanSessionStore: sessions,
    });
    const created = await request(app).post("/api/v1/session")
      .set("Authorization", "Bearer service-token")
      .send({ userId: "caller-controlled-user", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(created.status).toBe(201);
    const identity = await request(app).get("/api/v1/identity")
      .set("Authorization", `Bearer ${created.body.token}`);
    expect(identity.body.principalId).toBe("service-1");

    const revoked = await request(app).delete("/api/v1/session")
      .set("Authorization", `Bearer ${created.body.token}`);
    expect(revoked.status).toBe(204);
    expect((await request(app).get("/api/v1/identity")
      .set("Authorization", `Bearer ${created.body.token}`)).status).toBe(401);
  });

  it("revokes the current human session through the HTTP boundary", async () => {
    const sessions = new MemoryHumanSessionStore();
    const sourceAuthenticator = {
      authenticateToken: async (token: string) => token === "service-token" ? {
        principalType: "service_account" as const,
        principalId: "service-1",
        organizationId: "org-session",
        credentialId: "source-credential",
        capabilities: [...API_CAPABILITIES],
        role: "admin" as const,
      } : null,
      isCredentialActive: async () => true,
    };
    const authenticator = createSessionAwareAuthenticator(sourceAuthenticator, sessions);
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator: authenticator,
      humanSessionStore: sessions,
    });
    const created = await request(app).post("/api/v1/session")
      .set("Authorization", "Bearer service-token")
      .send({ userId: "caller-controlled-user", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(created.status).toBe(201);
    const identity = await request(app).get("/api/v1/identity")
      .set("Authorization", `Bearer ${created.body.token}`);
    expect(identity.body.principalId).toBe("service-1");

    const revoked = await request(app).delete("/api/v1/session")
      .set("Authorization", `Bearer ${created.body.token}`);
    expect(revoked.status).toBe(204);
    expect((await request(app).get("/api/v1/identity")
      .set("Authorization", `Bearer ${created.body.token}`)).status).toBe(401);
  });

  it("rate-limits session issuance and permits scoped administrator revocation", async () => {
    const sessions = new MemoryHumanSessionStore();
    const sourceAuthenticator = {
      authenticateToken: async (token: string) => token === "service-token" ? {
        principalType: "service_account" as const, principalId: "service-1", organizationId: "org-session",
        credentialId: "source-credential", capabilities: [...API_CAPABILITIES], role: "admin" as const,
      } : null,
      isCredentialActive: async () => true,
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator: sourceAuthenticator, humanSessionStore: sessions,
      sessionRateLimit: { maxPerMinute: 1, now: () => 1_000 },
    });
    const body = { userId: "user-1", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const first = await request(app).post("/api/v1/session").set("Authorization", "Bearer service-token").send(body);
    expect(first.status).toBe(201);
    const second = await request(app).post("/api/v1/session").set("Authorization", "Bearer service-token").send(body);
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: { code: "RATE_LIMIT_EXCEEDED" } });

    const revoked = await request(app).delete(`/api/v1/admin/sessions/${first.body.sessionId}`)
      .set("Authorization", "Bearer service-token");
    expect(revoked.status).toBe(204);
    expect((await request(app).get("/api/v1/identity").set("Authorization", `Bearer ${first.body.token}`)).status).toBe(401);
  });

  it("does not expose database errors from credential recovery", async () => {
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      customerOnboardingService: {
        createWorkspace: async () => { throw new Error("unused"); },
        recoverWorkspaceCredential: async () => {
          throw new Error("duplicate key value violates unique constraint api_credentials_token_hash_key");
        },
      },
    });

    const response = await request(app)
      .post("/api/v1/product/workspaces/workspace-customer/credential-recovery")
      .set("Idempotency-Key", "recovery-error-1")
      .send({ recoveryCode: "fuse_rc_abcdefghijklmnop" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: { code: "CREDENTIAL_RECOVERY_FAILED" } });
    expect(response.text).not.toContain("api_credentials");
    expect(response.text).not.toContain("duplicate");
  });

  it("allows one recovery winner and rejects the old credential at the HTTP boundary", async () => {
    const db = newAdvisoryMemoryDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const identityStore = new IdentityStore(pool);
    const occurredAt = "2026-08-23T14:00:00.000Z";
    await identityStore.createOrganization({
      id: "org-http", name: "HTTP Recovery", actorId: "test", causationId: "setup-org", occurredAt,
    });
    await identityStore.registerAgent({
      id: "agent-http", organizationId: "org-http", name: "HTTP Agent",
      actorId: "test", causationId: "setup-agent", occurredAt,
    });
    const oldCredential = createApiCredential({
      id: "credential-http-old", organizationId: "org-http", agentId: "agent-http",
      name: "Old HTTP credential", capabilities: ["inference:invoke", "receipts:read"], createdAt: occurredAt,
    }, () => Buffer.alloc(32, 40));
    await identityStore.issueCredential(oldCredential.record, {
      actorId: "test", causationId: "setup-credential", occurredAt,
    });
    const recoveryCode = "fuse_rc_http_recovery_123456";
    const recoveryCodeHash = createHash("sha256").update(recoveryCode).digest("hex");
    await pool.query(`
      CREATE TABLE fuse_workspace_onboarding_operations (
        idempotency_key TEXT PRIMARY KEY,
        recovery_code_hash TEXT,
        recovery_consumed_at TIMESTAMPTZ,
        recovery_consumed_hash TEXT,
        recovery_delivery_envelope TEXT,
        recovery_delivery_id TEXT,
        identifiers JSONB NOT NULL,
        status TEXT NOT NULL
      )
    `);
    await pool.query(
      `INSERT INTO fuse_workspace_onboarding_operations
       (idempotency_key, recovery_code_hash, identifiers, status)
       VALUES ('http-recovery-onboard', $1, $2::jsonb, 'completed')`,
      [recoveryCodeHash, JSON.stringify({
        workspaceId: "org-http", serviceAccountId: "service-http",
        serviceCredentialId: "service-credential-http", agentId: "agent-http",
        agentCredentialId: "credential-http-old",
      })],
    );
    const onboardingStore = {
      sealRecoveryResult: (result: unknown) => JSON.stringify(result),
      getRecovery: async (workspaceId: string, requestedHash: string) => {
        const result = await pool.query(
          `SELECT 1 FROM fuse_workspace_onboarding_operations
            WHERE identifiers->>'workspaceId' = $1 AND recovery_code_hash = $2
              AND status = 'completed' AND recovery_consumed_at IS NULL`,
          [workspaceId, requestedHash],
        );
        return result.rowCount === 1 ? {
          workspaceId: "org-http", serviceAccountId: "service-http",
          serviceCredentialId: "service-credential-http", agentId: "agent-http",
          agentCredentialId: "credential-http-old", expiresAt: null,
        } : null;
      },
    } as never;
    const ids = ["credential-http-new-1", "recovery-http-1", "credential-http-new-2", "recovery-http-2"];
    const customerOnboardingService = new CustomerOnboardingService({
      identityStore,
      onboardingStore,
      now: () => "2026-08-23T14:01:00.000Z",
      ids: () => ids.shift()!,
      credentialAdministration: {} as never,
      providerConnectionService: {} as never,
      policyPublishingService: {} as never,
      mandateManagementService: {} as never,
    });
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator: identityStore,
      customerOnboardingService,
      productInferenceService: {
        execute: async () => ({
          status: "completed", decision: { id: "decision-http" }, reservedCostAtomic: 1n,
          actualCostAtomic: 1n, response: { id: "response-http", content: "accepted", usage: { inputTokens: 1, outputTokens: 1 } },
        }),
      } as never,
    });

    const attempts = await Promise.all([
      request(app).post("/api/v1/product/workspaces/org-http/credential-recovery").set("Idempotency-Key", "recovery-http-1").send({ recoveryCode }),
      request(app).post("/api/v1/product/workspaces/org-http/credential-recovery").set("Idempotency-Key", "recovery-http-2").send({ recoveryCode }),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 401]);
    const replacementToken = attempts.find((response) => response.status === 200)!.body.credential.token as string;
    const inferenceBody = { model: "model-http", max_tokens: 8, messages: [{ role: "user", content: "verify" }] };
    const oldResponse = await request(app).post("/api/v1/product/inference")
      .set("Authorization", `Bearer ${oldCredential.token}`).set("Idempotency-Key", "old-http")
      .set("X-Fuse-Mandate", "mandate-http").send(inferenceBody);
    const replacementResponse = await request(app).post("/api/v1/product/inference")
      .set("Authorization", `Bearer ${replacementToken}`).set("Idempotency-Key", "new-http")
      .set("X-Fuse-Mandate", "mandate-http").send(inferenceBody);
    expect(oldResponse.status).toBe(401);
    expect(replacementResponse.status).toBe(200);
    await pool.end();
  });

  it("requires and durably consumes a configured onboarding invite", async () => {
    let creations = 0;
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator: { authenticateToken: async () => null },
      betaOnboardingGuard: {
        maxActiveWorkspaces: 3,
        reserveCapacity: async () => true,
        authorizeInvite: async (inviteToken, idempotencyKey) => inviteToken === "valid-invite"
          && idempotencyKey === "http-invite-1",
      },
      customerOnboardingService: {
        createWorkspace: async () => {
          creations += 1;
          return {
            workspaceId: "workspace-invited", agentId: "agent-invited", mandateId: "mandate-invited",
            policyId: "policy-invited", providerConfigId: "provider-invited",
            adminCredential: { credentialId: "admin-invited", token: "one-time", tokenPrefix: "fuse_sk_", capabilities: [], expiresAt: null },
            credential: { credentialId: "credential-invited", token: "one-time", tokenPrefix: "fuse_sk_", capabilities: [], expiresAt: null },
            recoveryCode: "fuse_rc_recovery",
          };
        },
        recoverWorkspaceCredential: async () => { throw new Error("unused"); },
      },
    });
    const body = {
      name: "Invited workspace", agentName: "researcher", provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "provider-secret", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00", maximumSpendAtomic: "100000",
    };

    const missing = await request(app).post("/api/v1/product/workspaces")
      .set("Idempotency-Key", "http-invite-1").send(body);
    expect(missing.status).toBe(403);
    expect(missing.body).toEqual({ error: { code: "BETA_INVITE_REQUIRED" } });
    expect(creations).toBe(0);

    const accepted = await request(app).post("/api/v1/product/workspaces")
      .set("Idempotency-Key", "http-invite-1").set("X-Fuse-Invite", "valid-invite").send(body);
    expect(accepted.status).toBe(201);
    expect(creations).toBe(1);
  });

  it("rate-limits authenticated product routes by principal", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({ credentialId: "credential-rate", principalType: "agent",
        principalId: "agent-rate", organizationId: "workspace-rate", capabilities: ["sandbox:run"] }),
    };
    const app = createFuseApp({ provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, credentialAuthenticator,
      productRateLimit: { maxPerMinute: 1, now: () => 1_000 }, sandboxRunService: new SandboxRunService() });
    const first = await request(app).post("/api/v1/product/sandbox/runs").set("Authorization", "Bearer rate").send({ seed: "one" });
    expect(first.status).toBe(201);
    const second = await request(app).post("/api/v1/product/sandbox/runs").set("Authorization", "Bearer rate").send({ seed: "two" });
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: { code: "RATE_LIMIT_EXCEEDED" } });
  });

  it("records authenticated product payment evidence before returning paid output", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({ credentialId: "credential-evidence", principalType: "agent",
        principalId: "agent-evidence", organizationId: "workspace-evidence", capabilities: ["inference:invoke"] }),
    };
    const evidence = new MemoryPaymentEvidenceStore();
    const productInferenceService = { async execute() { return {
      status: "completed" as const, decision: { id: "decision-evidence" }, reservedCostAtomic: 20n,
      actualCostAtomic: 10n, response: { id: "response-evidence", content: "paid", usage: { inputTokens: 1, outputTokens: 1 } },
    }; } };
    const app = createFuseApp({ provider: new FakeProvider(), paymentMode: "settlement", paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, credentialAuthenticator, paymentEvidenceStore: evidence,
      productInferenceService: productInferenceService as never });
    const response = await request(app).post("/api/v1/product/inference")
      .set("Authorization", "Bearer evidence").set("Idempotency-Key", "request-evidence")
      .set("X-Fuse-Mandate", "mandate-1").set("PAYMENT-SIGNATURE", "paid")
      .send({ model: "model", max_tokens: 32, messages: [{ role: "user", content: "hello" }] });
    expect(response.status).toBe(200);
    expect(evidence.records.get("workspace-evidence:request-evidence")).toMatchObject({
      requestId: "request-evidence", organizationId: "workspace-evidence", actualCostAtomic: "10",
      payment: { authorizationHash: "0xlive-payment", gatewayStatus: "accepted" },
    });
  });

  it("serves an authenticated operator console without demo metrics or fake actions", async () => {
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1000,
    });
    const consolePage = await request(app).get("/console");
    expect(consolePage.status).toBe(200);
    expect(consolePage.text).toContain("Fuse Operator Console");
    expect(consolePage.text).toContain("Workspace readiness");
    expect(consolePage.text).toContain("Branch containment");
    expect(consolePage.text).toContain('id="readinessStrip"');
    expect(consolePage.text).toContain("Provider boundary");
    expect(consolePage.text).toContain("Your session is scoped to this tab and clears when you sign out or close it.");
    expect(consolePage.text).toContain('name="inviteToken"');
    expect(consolePage.text).toContain("'X-Fuse-Invite':inviteToken");
    expect(consolePage.text).toContain('value="openrouter" selected');
    expect(consolePage.text).not.toContain('value="anthropic"');
    expect(consolePage.text).toContain("sessionStorage");
    expect(consolePage.text).toContain("ensureQuickInference");
    expect(consolePage.text).toContain("restoreStoredSession");
    expect(consolePage.text).toContain("/api/v1/product/provider-connections");
    expect(consolePage.text).toContain("/api/v1/product/mandates");
    expect(consolePage.text).toContain("/api/v1/product/policies");
    expect(consolePage.text).toContain("/api/v1/product/agents");
    expect(consolePage.text).toContain("/api/v1/product/agent-credentials");
    expect(consolePage.text).toContain("Enable workload-shadow capability");
    expect(consolePage.text).toContain("Run bounded inference");
    expect(consolePage.text).toContain("result.className='notice show error'");
    expect(consolePage.text).toContain("result.scrollIntoView({behavior:'smooth',block:'center'})");
    expect(consolePage.text).toContain("Receipt read back:");
    expect(consolePage.text).toContain("Save these one-time credentials before leaving this tab.");
    expect(consolePage.text).toContain("onboardingServiceCredential");
    expect(consolePage.text).toContain("onboardingAgentCredential");
    expect(consolePage.text).toContain("onboardingRecoveryCode");
    expect(consolePage.text).not.toContain("fuse_agent_…");
    expect(consolePage.text).toContain("Resolve a reconciliation hold");
    expect(consolePage.text).toContain("CONTROL_MODE_PAYMENT_UNEXPECTED");
    expect(consolePage.text).not.toContain("Run paid inference");
    expect(consolePage.text).toContain("workloadClasses:v.includeWorkload?");
    expect(consolePage.text).not.toContain('name="includeWorkload" type="checkbox" value="yes" checked');
    expect(consolePage.text).toContain('id="createMandate"');
    expect(consolePage.text).toContain('id="assignMandateAgent"');
    expect(consolePage.text).toContain('id="activateMandate"');
    expect(consolePage.text).not.toContain("Create and activate");
    expect(consolePage.text).not.toContain("Simulate");
    expect(consolePage.text).not.toContain("fake");
  });

  it("sets defensive browser headers on public and operator surfaces", async () => {
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1000,
    });
    for (const path of ["/", "/desk", "/console", "/health"]) {
      const response = await request(app).get(path);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["permissions-policy"]).toContain("camera=()");
    }
    const health = await request(app).get("/health");
    expect(health.headers["cache-control"]).toContain("no-store");
  });

  it("emits structured request metadata without logging credentials or query values", async () => {
    const events: Array<Record<string, unknown>> = [];
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      requestLogger: (event) => events.push(event),
      nowMs: () => 10_000,
    });
    const response = await request(app).get("/health?token=sensitive-query")
      .set("Authorization", "Bearer sensitive-credential")
      .set("X-Request-Id", "request-log-test");
    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBe("request-log-test");
    expect(events).toEqual([{
      requestId: "request-log-test", method: "GET", path: "/health", status: 200, durationMs: 0,
    }]);
    expect(JSON.stringify(events)).not.toContain("sensitive");
    expect(JSON.stringify(events)).not.toContain("Authorization");
  });

  it("reports dependency readiness without exposing database errors", async () => {
    const readyApp = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, readiness: async () => ({ database: true }),
    });
    const ready = await request(readyApp).get("/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ok: true, service: "fuse", checks: { database: true } });
    expect(ready.headers["cache-control"]).toContain("no-store");

    const incompleteApp = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, readiness: async () => ({ database: false }),
    });
    const incomplete = await request(incompleteApp).get("/ready");
    expect(incomplete.status).toBe(503);
    expect(incomplete.body).toEqual({ ok: false, service: "fuse", checks: { database: false } });

    const empty = await request(createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, readiness: async () => ({}),
    })).get("/ready");
    expect(empty.status).toBe(503);
    expect(empty.body).toEqual({ ok: false, service: "fuse", checks: {} });

    const unavailableApp = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1, readiness: async () => { throw new Error("postgres://secret"); },
    });
    const unavailable = await request(unavailableApp).get("/ready");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ ok: false, service: "fuse", error: "DEPENDENCY_UNAVAILABLE" });
    expect(unavailable.text).not.toContain("postgres");

    const unconfigured = await request(createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1,
    })).get("/ready");
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body).toEqual({
      ok: false, service: "fuse", error: "READINESS_NOT_CONFIGURED",
    });
  });

  it("rate limits administrative traffic per authenticated principal without cross-tenant denial", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async (token) => token === "tenant-a" || token === "tenant-b" ? ({
        principalType: "service_account",
        principalId: `admin-${token}`,
        organizationId: `org-${token}`,
        credentialId: `credential-${token}`,
        capabilities: ["providers:read"],
        role: "admin",
      }) : null,
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard,
      estimateInputTokens: () => 1,
      credentialAuthenticator,
      adminRateLimit: { maxPerMinute: 2, now: () => 1_000 },
    });
    expect((await request(app).get("/api/v1/admin/providers")).status).toBe(401);
    expect((await request(app).get("/api/v1/admin/providers")).status).toBe(401);
    expect((await request(app).get("/api/v1/admin/providers").set("Authorization", "Bearer tenant-a")).status).toBe(404);
    expect((await request(app).get("/api/v1/admin/providers").set("Authorization", "Bearer tenant-a")).status).toBe(404);
    const limited = await request(app).get("/api/v1/admin/providers")
      .set("Authorization", "Bearer tenant-a");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: "RATE_LIMIT_EXCEEDED" } });
    expect(limited.text).not.toContain("tenant-a");
    expect(limited.headers["retry-after"]).toBe("60");
    expect((await request(app).get("/api/v1/admin/providers")
      .set("Authorization", "Bearer tenant-b")).status).toBe(404);
  });

  it("uses the durable admin limiter across application instances", async () => {
    let count = 0;
    const dependencies = {
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator: {
        authenticateToken: async () => ({
          principalType: "service_account" as const, principalId: "admin-1", organizationId: "org-1",
          credentialId: "credential-1", capabilities: ["providers:read" as const], role: "admin" as const,
        }),
      },
      adminRateLimit: {
        maxPerMinute: 1,
        now: () => 1_000,
        consume: async () => ({ allowed: ++count <= 1, retryAfterSeconds: 60 }),
      },
    };

    expect((await request(createFuseApp(dependencies)).get("/api/v1/admin/providers")
      .set("Authorization", "Bearer admin")).status).toBe(404);
    const limited = await request(createFuseApp(dependencies)).get("/api/v1/admin/providers")
      .set("Authorization", "Bearer admin");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
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

describe("POST /api/v1/product/sandbox/runs", () => {
  it("requires sandbox capability and returns an idempotent causal run", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "service_account", principalId: "operator-1", organizationId: "workspace-1",
        credentialId: "cred-operator", capabilities: ["sandbox:run"], role: "operator",
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1000,
      credentialAuthenticator, sandboxRunService: new SandboxRunService(),
    });
    const first = await request(app).post("/api/v1/product/sandbox/runs")
      .set("Authorization", "Bearer operator-token").send({ seed: "golden-path" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ mode: "sandbox", status: "completed", scout: { circuitState: "TRIPPED" }, reviewer: { status: "completed" } });
    expect(first.body.events.some((event: { type: string }) => event.type === "allowance_reclaimed")).toBe(true);

    const second = await request(app).post("/api/v1/product/sandbox/runs")
      .set("Authorization", "Bearer operator-token").send({ seed: "golden-path" });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("rejects malformed sandbox input", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "service_account", principalId: "operator-1", organizationId: "workspace-1",
        credentialId: "cred-operator", capabilities: ["sandbox:run"], role: "operator",
      }),
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1000,
      credentialAuthenticator, sandboxRunService: new SandboxRunService(),
    });
    const response = await request(app).post("/api/v1/product/sandbox/runs")
      .set("Authorization", "Bearer operator-token").send({ seed: "ok", unexpected: true });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "INVALID_SANDBOX_REQUEST" } });
  });

  it("uses the configured durable store for sandbox runs", async () => {
    const credentialAuthenticator: CredentialAuthenticator = {
      authenticateToken: async () => ({
        principalType: "service_account", principalId: "operator-durable", organizationId: "workspace-durable",
        credentialId: "cred-durable", capabilities: ["sandbox:run"], role: "operator",
      }),
    };
    let reads = 0;
    let writes = 0;
    const durableStore: SandboxRunStore = {
      async get() { reads += 1; return null; },
      async put() { writes += 1; },
    };
    const app = createFuseApp({
      provider: new FakeProvider(), paymentGuard: fakePaymentGuard, estimateInputTokens: () => 1,
      credentialAuthenticator, sandboxRunService: new SandboxRunService(), sandboxRunStore: durableStore,
    });
    const response = await request(app).post("/api/v1/product/sandbox/runs")
      .set("Authorization", "Bearer operator-durable").send({ seed: "durable-path" });
    expect(response.status).toBe(201);
    expect(reads).toBe(1);
    expect(writes).toBe(1);
  });
});
