import { GatewayClient } from "@circle-fin/x402-batching/client";
import type { Address, Hex } from "viem";

const address = process.argv[2] as Address | undefined;
if (!address) throw new Error("Usage: probe-gateway-balance <address>");

// A throwaway local key is used only because GatewayClient currently requires one
// at construction. getBalances(address) queries the supplied address and never signs.
const queryOnlyKey = `0x${"11".repeat(32)}` as Hex;
const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: queryOnlyKey });
const balances = await gateway.getBalances(address);
console.log(JSON.stringify({
  address,
  wallet: {
    formatted: balances.wallet.formatted,
  },
  gateway: {
    formattedTotal: balances.gateway.formattedTotal,
    formattedAvailable: balances.gateway.formattedAvailable,
    withdrawing: balances.gateway.withdrawing.toString(),
  },
}, null, 2));
