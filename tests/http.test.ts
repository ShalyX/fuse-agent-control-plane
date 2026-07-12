import { describe, expect, it } from "vitest";
import request from "supertest";
import type { RequestHandler } from "express";
import { createFuseApp } from "../src/http/app.js";
import type { InferenceProvider } from "../src/core/service.js";

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
