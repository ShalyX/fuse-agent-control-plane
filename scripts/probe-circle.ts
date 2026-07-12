import { createRequire } from "node:module";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient: typeof InitiateClient;
};

const env = process.env;
const apiKey = env["CIRCLE_API_KEY"];
const entitySecret = env["CIRCLE_ENTITY_SECRET"];
if (!apiKey || !entitySecret) throw new Error("Missing Circle credentials");

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

const [setsResponse, walletsResponse] = await Promise.all([
  client.listWalletSets(),
  client.listWallets(),
]);

const sets = setsResponse.data?.walletSets ?? [];
const wallets = walletsResponse.data?.wallets ?? [];

const walletBalances = await Promise.all(wallets.map(async (wallet) => {
  const response = await client.getWalletTokenBalance({ id: wallet.id });
  return {
    id: wallet.id,
    address: wallet.address,
    blockchain: wallet.blockchain,
    accountType: wallet.accountType,
    state: wallet.state,
    walletSetId: wallet.walletSetId,
    tokenBalances: (response.data?.tokenBalances ?? []).map((balance) => ({
      symbol: balance.token?.symbol,
      amount: balance.amount,
    })),
  };
}));

console.log(JSON.stringify({
  authenticated: true,
  walletSets: sets.map((set) => ({
    id: set.id,
    custodyType: set.custodyType,
  })),
  wallets: walletBalances,
}, null, 2));
