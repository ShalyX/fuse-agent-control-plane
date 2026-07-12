export type TokenPrice = {
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
};

type ActualUsage = { inputTokens: number; outputTokens: number };
type MaximumUsage = { inputTokens: number; maxOutputTokens: number };

const SCALE = 1_000_000n;

function decimalToScaled(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error("INVALID_PRICE");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function tokenCostMicros(tokens: number, usdPerMillion: string): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("INVALID_TOKEN_COUNT");
  return ceilDiv(BigInt(tokens) * decimalToScaled(usdPerMillion), SCALE);
}

export function calculateCostMicros(usage: ActualUsage, price: TokenPrice): bigint {
  return tokenCostMicros(usage.inputTokens, price.inputUsdPerMillion)
    + tokenCostMicros(usage.outputTokens, price.outputUsdPerMillion);
}

export function calculateMaximumCostMicros(usage: MaximumUsage, price: TokenPrice): bigint {
  return calculateCostMicros(
    { inputTokens: usage.inputTokens, outputTokens: usage.maxOutputTokens },
    price,
  );
}
