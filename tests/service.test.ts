import { describe, expect, it } from "vitest";
import { FuseService, type CompletionRequest, type InferenceProvider } from "../src/core/service.js";

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

class SequencedProvider implements InferenceProvider {
  private scoutOutputs = [100, 400, 1600];

  async complete(request: CompletionRequest) {
    const outputTokens = request.childId === "scout" ? this.scoutOutputs.shift()! : 100;
    return {
      id: request.requestId,
      content: `${request.childId} result`,
      usage: { inputTokens: 0, outputTokens },
    };
  }
}

describe("branch isolation", () => {
  it("trips only the accelerating child while another child continues", async () => {
    const service = FuseService.createDemo(new SequencedProvider());
    const run = async (childId: string, requestId: string) => {
      const quote = await service.prepareCompletion({
        requestId,
        childId,
        model: "demo",
        inputTokens: 0,
        maxOutputTokens: 1600,
        messages: [{ role: "user", content: "work" }],
      });
      return service.releasePaidCompletion(requestId, {
        authorizationHash: `pay-${requestId}`,
        gatewayStatus: "accepted",
      });
    };

    expect((await run("scout", "s1")).receipt.circuitState).toBe("HEALTHY");
    expect((await run("scout", "s2")).receipt.circuitState).toBe("ELEVATED");
    const tripped = await run("scout", "s3");
    expect(tripped.receipt).toMatchObject({
      circuitState: "TRIPPED",
      circuitReason: "REPEATED_COST_ACCELERATION",
    });

    await expect(service.prepareCompletion({
      requestId: "s4",
      childId: "scout",
      model: "demo",
      inputTokens: 0,
      maxOutputTokens: 100,
      messages: [{ role: "user", content: "more" }],
    })).rejects.toThrow("BRANCH_TRIPPED");

    const reviewer = await run("reviewer", "r1");
    expect(reviewer.receipt.circuitState).toBe("HEALTHY");
    expect(service.snapshot().circuits).toMatchObject({
      scout: { state: "TRIPPED" },
      reviewer: { state: "HEALTHY" },
    });
  });
});

describe("held-response exact payment flow", () => {
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
