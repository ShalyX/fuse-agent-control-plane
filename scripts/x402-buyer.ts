import { createRequire } from "node:module";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";
import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { createCircleGatewaySigner } from "../src/circle/developerWalletSigner.js";

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
const payer = wallets.find((wallet) =>
  wallet.address?.toLowerCase() === "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7");
if (!payer?.address) throw new Error("FUSE_PAYER_WALLET_NOT_FOUND");

const signer = createCircleGatewaySigner({
  walletId: payer.id,
  walletAddress: payer.address as `0x${string}`,
  client: circle,
});
const core = new x402Client();
registerBatchScheme(core, { signer });
const http = new x402HTTPClient(core);
const url = "http://127.0.0.1:4021/fuse/phase-zero";

const initial = await fetch(url);
if (initial.status !== 402) throw new Error(`EXPECTED_402_GOT_${initial.status}`);
const body = await initial.json();
const required = http.getPaymentRequiredResponse(
  (name) => initial.headers.get(name),
  body,
);
const payload = await http.createPaymentPayload(required);
const paid = await fetch(url, {
  headers: http.encodePaymentSignatureHeader(payload),
});
const responseBody = await paid.json();
if (!paid.ok) throw new Error(`PAID_REQUEST_FAILED_${paid.status}: ${JSON.stringify(responseBody)}`);
const settlement = http.getPaymentSettleResponse((name) => paid.headers.get(name));

console.log(JSON.stringify({
  initialStatus: initial.status,
  paidStatus: paid.status,
  payer: payer.address,
  resource: responseBody,
  settlement,
}, null, 2));
