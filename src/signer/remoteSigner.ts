import { createHash } from "node:crypto";
import { getAddress, recoverTypedDataAddress } from "viem";
import type { Address, Hex, TypedDataDefinition } from "viem";
import { z } from "zod";

const responseSchema = z.object({
  organizationId: z.string().min(1),
  requestId: z.string().regex(/^[a-f0-9]{64}$/),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
}).strict();

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function amountFrom(parameters: TypedDataDefinition): bigint {
  const message = parameters.message as Record<string, unknown>;
  const value = message["value"];
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error("REMOTE_SIGNER_AMOUNT_INVALID");
}

export function createRemoteGatewaySigner(config: {
  organizationId: string;
  endpoint: string;
  authToken: string;
  walletAddress: Address;
  fetch?: typeof fetch;
}) {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search) {
    throw new Error("REMOTE_SIGNER_ENDPOINT_INVALID");
  }
  if (!config.organizationId.trim()) throw new Error("REMOTE_SIGNER_ORGANIZATION_REQUIRED");
  if (config.authToken.length < 32) throw new Error("REMOTE_SIGNER_TOKEN_INVALID");
  const request = config.fetch ?? fetch;
  return {
    address: config.walletAddress,
    async signTypedData(parameters: TypedDataDefinition): Promise<Hex> {
      const amountAtomic = amountFrom(parameters).toString();
      const serializable = JSON.parse(canonical(parameters)) as Record<string, unknown>;
      const requestId = createHash("sha256").update(canonical({
        organizationId: config.organizationId,
        walletAddress: config.walletAddress.toLowerCase(),
        typedData: serializable,
      })).digest("hex");
      const response = await request(new URL("/v1/sign", endpoint), {
        method: "POST",
        headers: {
          Authorization: ["Bearer", config.authToken].join(" "),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationId: config.organizationId,
          requestId,
          amountAtomic,
          typedData: serializable,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`REMOTE_SIGNER_REJECTED:${response.status}`);
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("REMOTE_SIGNER_RESPONSE_INVALID");
      if (parsed.data.organizationId !== config.organizationId
        || parsed.data.requestId !== requestId
        || parsed.data.walletAddress.toLowerCase() !== config.walletAddress.toLowerCase()) {
        throw new Error("REMOTE_SIGNER_IDENTITY_MISMATCH");
      }
      const signature = parsed.data.signature as Hex;
      const recoveredAddress = await recoverTypedDataAddress({ ...parameters, signature });
      if (getAddress(recoveredAddress) !== getAddress(config.walletAddress)) {
        throw new Error("REMOTE_SIGNER_SIGNATURE_INVALID");
      }
      return signature;
    },
  };
}
