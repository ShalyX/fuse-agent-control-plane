import { createRequire } from "node:module";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";
import type { Address } from "viem";
import { createCircleGatewaySigner } from "../circle/developerWalletSigner.js";
import { createPostgresPool } from "../persistence/postgres.js";
import { createSignerBoundaryApp } from "./app.js";
import { PostgresSignerAuthorizationStore } from "./authorizationStore.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient: typeof InitiateClient;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`SIGNER_CONFIG_REQUIRED:${name}`);
  return value;
}

function address(env: NodeJS.ProcessEnv, name: string): Address {
  const value = required(env, name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`SIGNER_ADDRESS_INVALID:${name}`);
  return value as Address;
}

export function assertLiveCircleApiKey(value: string): void {
  if (!value.startsWith("LIVE_API_KEY:")) {
    throw new Error("SIGNER_CIRCLE_LIVE_API_KEY_REQUIRED");
  }
}

export function assertBaseChainId(value: string): void {
  if (value !== "8453") throw new Error("SIGNER_CHAIN_ID_NOT_BASE_MAINNET");
}

export function assertCircleSignerWallet(wallet: {
  address?: string;
  blockchain?: string;
  custodyType?: string;
  state?: string;
}, expectedAddress: Address): void {
  if (wallet.address?.toLowerCase() !== expectedAddress.toLowerCase()
    || wallet.blockchain !== "BASE"
    || wallet.custodyType !== "DEVELOPER"
    || wallet.state !== "LIVE") {
    throw new Error("SIGNER_WALLET_NOT_LIVE_BASE_DEVELOPER");
  }
}

export async function createSignerRuntimeApp(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = required(env, "CIRCLE_API_KEY");
  assertLiveCircleApiKey(apiKey);
  const entitySecret = required(env, "CIRCLE_ENTITY_SECRET");
  const walletId = required(env, "SIGNER_WALLET_ID");
  const walletAddress = address(env, "SIGNER_WALLET_ADDRESS");
  const maximumAtomicText = required(env, "SIGNER_MAXIMUM_ATOMIC");
  const maximumTotalAtomicText = required(env, "SIGNER_MAXIMUM_TOTAL_ATOMIC");
  const chainIdText = required(env, "SIGNER_CHAIN_ID");
  if (!/^\d+$/.test(maximumAtomicText) || !/^\d+$/.test(maximumTotalAtomicText)
    || BigInt(maximumAtomicText) <= 0n
    || BigInt(maximumTotalAtomicText) < BigInt(maximumAtomicText)) {
    throw new Error("SIGNER_MAXIMUM_INVALID");
  }
  assertBaseChainId(chainIdText);
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const wallet = (await client.getWallet({ id: walletId })).data?.wallet;
  if (!wallet) throw new Error("SIGNER_WALLET_NOT_FOUND");
  assertCircleSignerWallet(wallet, walletAddress);
  const signer = createCircleGatewaySigner({ walletId, walletAddress, client });
  const authorizationStore = new PostgresSignerAuthorizationStore(
    createPostgresPool(required(env, "SIGNER_DATABASE_URL")),
  );
  return createSignerBoundaryApp({
    organizationId: required(env, "SIGNER_ORGANIZATION_ID"),
    callerId: required(env, "SIGNER_CALLER_ID"),
    authToken: required(env, "SIGNER_AUTH_TOKEN"),
    walletAddress,
    gatewayWalletAddress: address(env, "SIGNER_GATEWAY_WALLET_ADDRESS"),
    allowedPayToAddress: address(env, "SIGNER_ALLOWED_PAY_TO_ADDRESS"),
    chainId: Number(chainIdText),
    verifiedWallet: { blockchain: "BASE", custodyType: "DEVELOPER", state: "LIVE" } as const,
    maximumAtomic: BigInt(maximumAtomicText),
    maximumTotalAtomic: BigInt(maximumTotalAtomicText),
    signer,
    authorizationStore,
  });
}
