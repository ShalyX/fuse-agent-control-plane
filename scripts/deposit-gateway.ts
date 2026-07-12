import { createRequire } from "node:module";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import type { Hex } from "viem";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient: typeof InitiateClient;
};
const env = process.env;
const apiKey = env["CIRCLE_API_KEY"];
const entitySecret = env["CIRCLE_ENTITY_SECRET"];
if (!apiKey || !entitySecret) throw new Error("Missing Circle credentials");

const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const wallets = (await circle.listWallets()).data?.wallets ?? [];
const candidates = wallets.filter((wallet) =>
  wallet.blockchain === "ARC-TESTNET" && wallet.accountType === "EOA" && wallet.state === "LIVE");

let selected: typeof candidates[number] | undefined;
for (const wallet of candidates) {
  const balances = (await circle.getWalletTokenBalance({ id: wallet.id })).data?.tokenBalances ?? [];
  if (balances.some((balance) => balance.token?.symbol === "USDC" && Number(balance.amount) >= 0.001)) {
    selected = wallet;
    break;
  }
}
if (!selected) throw new Error("NO_FUNDED_ARC_TESTNET_EOA");

const queryKey = `0x${"11".repeat(32)}` as Hex;
const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: queryKey });
const before = await gateway.getBalances(selected.address as `0x${string}`);
if (before.gateway.available >= 1_000n) {
  console.log(JSON.stringify({
    status: "already_deposited",
    walletId: selected.id,
    address: selected.address,
    gatewayAvailable: before.gateway.formattedAvailable,
  }, null, 2));
  process.exit(0);
}

const amountAtomic = "1000"; // 0.001 USDC at 6 decimals
const fee = { type: "level" as const, config: { feeLevel: "LOW" as const } };

async function submitAndWait(label: string, input: Parameters<typeof circle.createContractExecutionTransaction>[0]) {
  const response = await circle.createContractExecutionTransaction(input);
  const id = response.data?.id;
  if (!id) throw new Error(`${label.toUpperCase()}_TRANSACTION_ID_MISSING`);
  console.log(`${label} submitted: ${id}`);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const transaction = (await circle.getTransaction({ id })).data?.transaction;
    const state = transaction?.state;
    if (["COMPLETE", "CONFIRMED"].includes(state ?? "")) {
      console.log(`${label} complete: ${transaction?.txHash ?? id}`);
      return transaction;
    }
    if (["FAILED", "DENIED", "CANCELLED"].includes(state ?? "")) {
      throw new Error(`${label.toUpperCase()}_${state}: ${transaction?.errorReason ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label.toUpperCase()}_TIMEOUT`);
}

const allowance = await gateway.publicClient.readContract({
  address: gateway.chainConfig.usdc,
  abi: [{
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  }],
  functionName: "allowance",
  args: [selected.address as `0x${string}`, gateway.chainConfig.gatewayWallet],
});

if (allowance < BigInt(amountAtomic)) {
  await submitAndWait("approve", {
    walletId: selected.id,
    contractAddress: gateway.chainConfig.usdc,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [gateway.chainConfig.gatewayWallet, amountAtomic],
    fee,
  });
} else {
  console.log(`approve skipped: allowance ${allowance}`);
}

await submitAndWait("deposit", {
  walletId: selected.id,
  contractAddress: gateway.chainConfig.gatewayWallet,
  abiFunctionSignature: "deposit(address,uint256)",
  abiParameters: [gateway.chainConfig.usdc, amountAtomic],
  fee,
});

const after = await gateway.getBalances(selected.address as `0x${string}`);
console.log(JSON.stringify({
  status: "deposited",
  walletId: selected.id,
  address: selected.address,
  walletBalance: after.wallet.formatted,
  gatewayTotal: after.gateway.formattedTotal,
  gatewayAvailable: after.gateway.formattedAvailable,
}, null, 2));
