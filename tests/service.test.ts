import { describe, expect, it } from "vitest";
import { FuseService, type InferenceProvider } from "../src/core/service.js";

class FakeProvider implements InferenceProvider {
  calls = 0;
  async complete() {
    this.calls += 1;
    return {
      id: "provider-response-1",
      content: "verified output",
      usage: { inputTokens: 1000, outputTokens: 100 },
    };
  }
}

describe("FuseService held-response payment flow", () => {
  it("reserves, runs once, quotes exact usage, and releases only after payment", async () => {
    const provider = new FakeProvider();
    const service = FuseService.createDemo(provider);

    const quote = await service.prepareCompletion({
      requestId: "req-1",
      childId: "scout",
      model: "claude-sonnet",
      inputTokens: 1000,
      maxOutputTokens: 1000,
      messages: [{ role: "user", content: "Research this" }],
    });

    expect(quote).toMatchObject({
      status: "payment_required",
      httpStatus: 402,
      exactCostMicros: 4_500n,
    });
    expect(quote.response).toBeUndefined();
    expect(provider.calls).toBe(1);

    const duplicate = await service.prepareCompletion({
      requestId: "req-1",
      childId: "scout",
      model: "claude-sonnet",
      inputTokens: 1000,
      maxOutputTokens: 1000,
      messages: [{ role: "user", content: "Research this" }],
    });
    expect(duplicate.exactCostMicros).toBe(4_500n);
    expect(provider.calls).toBe(1);

    const completed = service.releasePaidCompletion("req-1", {
      authorizationHash: "0xpayment",
      gatewayStatus: "accepted",
    });
    expect(completed.response?.content).toBe("verified output");
    expect(completed.receipt).toMatchObject({
      childId: "scout",
      costUsdc: "0.004500",
      authorizationHash: "0xpayment",
    });
  });
});
