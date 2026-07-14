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

export function usdToMicros(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error("INVALID_PROVIDER_COST");
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new Error("INVALID_PROVIDER_COST");
  }
  const digits = BigInt(`${whole}${fraction}`);
  const power = 6 + exponent - fraction.length;
  return power >= 0
    ? digits * (10n ** BigInt(power))
    : ceilDiv(digits, 10n ** BigInt(-power));
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
