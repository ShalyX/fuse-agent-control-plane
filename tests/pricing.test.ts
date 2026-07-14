import { describe, expect, it } from "vitest";
import {
  calculateCostMicros,
  calculateMaximumCostMicros,
  usdToMicros,
} from "../src/core/pricing.js";

describe("pricing", () => {
  const price = { inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00" };

  it("calculates exact micro-USDC cost from actual token usage", () => {
    expect(calculateCostMicros({ inputTokens: 1842, outputTokens: 391 }, price)).toBe(11_391n);
  });

  it("calculates worst-case reservation using input and max output tokens", () => {
    expect(calculateMaximumCostMicros({ inputTokens: 1000, maxOutputTokens: 2000 }, price)).toBe(33_000n);
  });

  it("rounds fractional micro-USDC costs up so usage is never free", () => {
    expect(calculateCostMicros({ inputTokens: 1, outputTokens: 0 }, price)).toBe(3n);
  });

  it("converts provider-reported decimal or scientific USD cost to atomic micro-USDC", () => {
    expect(usdToMicros("0.000624")).toBe(624n);
    expect(usdToMicros("0.0000001")).toBe(1n);
    expect(usdToMicros("1e-7")).toBe(1n);
  });
});
