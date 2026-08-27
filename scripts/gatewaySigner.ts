import { createRequire } from "node:module";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";
import type { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import type { Address } from "viem";
import { createCircleGatewaySigner } from "../src/circle/developerWalletSigner.js";
import { createRemoteGatewaySigner } from "../src/signer/remoteSigner.js";

type BatchEvmSigner = ConstructorParameters<typeof BatchEvmScheme>[0];

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient: typeof InitiateClient;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`GATEWAY_SIGNER_CONFIG_REQUIRED:${name}`);
  return value;
}

function address(env: NodeJS.ProcessEnv, name: string): Address {
  const value = required(env, name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`GATEWAY_SIGNER_ADDRESS_INVALID:${name}`);
  return value as Address;
}

export async function createGatewaySigner(env: NodeJS.ProcessEnv = process.env): Promise<{
  signer: BatchEvmSigner;
  payerAddress: Address;
  mode: "remote" | "circle";
}> {
  const remoteEndpoint = env["SHALY_SIGNER_URL"]?.trim();
  const remoteToken = env["SHALY_SIGNER_AUTH_TOKEN"]?.trim();
  if (remoteEndpoint || remoteToken) {
    const payerAddress = address(env, "FUSE_PAYER_ADDRESS");
    const signer = createRemoteGatewaySigner({
      organizationId: env["SHALY_SIGNER_ORGANIZATION_ID"]?.trim() || "org-shaly",
      endpoint: required(env, "SHALY_SIGNER_URL"),
      authToken: required(env, "SHALY_SIGNER_AUTH_TOKEN"),
      walletAddress: payerAddress,
    });
    return { signer: signer as unknown as BatchEvmSigner, payerAddress, mode: "remote" };
  }

  const apiKey = required(env, "CIRCLE_API_KEY");
  const entitySecret = required(env, "CIRCLE_ENTITY_SECRET");
  const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const wallets = (await circle.listWallets()).data?.wallets ?? [];
  const payerAddress = (env["FUSE_PAYER_ADDRESS"] ?? "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7") as Address;
  const wallet = wallets.find((candidate) => candidate.address?.toLowerCase() === payerAddress.toLowerCase());
  if (!wallet?.address) throw new Error("GATEWAY_SIGNER_PAYER_WALLET_NOT_FOUND");
  const signer = createCircleGatewaySigner({
    client: circle,
    walletId: wallet.id,
    walletAddress: wallet.address as Address,
  });
  return { signer: signer as BatchEvmSigner, payerAddress: wallet.address as Address, mode: "circle" };
}
