import { createRequire } from "node:module";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient: typeof InitiateClient;
};
const env = process.env;
const apiKey = env["CIRCLE_API_KEY"];
const entitySecret = env["CIRCLE_ENTITY_SECRET"];
const address = process.argv[2];
if (!apiKey || !entitySecret || !address) throw new Error("Missing credentials or address");

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const response = await client.requestTestnetTokens({
  address,
  blockchain: "ARC-TESTNET",
  usdc: true,
});
console.log(JSON.stringify({ status: response.status, requested: true }));
