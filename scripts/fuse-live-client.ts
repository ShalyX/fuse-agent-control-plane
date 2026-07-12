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
const apiKey = env["CIRCLE_API_KEY"]?.trim();
const entitySecret = env["CIRCLE_ENTITY_SECRET"]?.trim();
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
const url = "http://127.0.0.1:8787/v1/chat/completions";
const requestId = `live-${Date.now()}`;
const body = {
  model: env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6",
  max_tokens: 64,
  messages: [{ role: "user", content: "Reply with exactly: FUSE LIVE PAID OK" }],
};
const headers = {
  "content-type": "application/json",
  "idempotency-key": requestId,
  "x-fuse-child": "scout",
};

const initial = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
if (initial.status !== 402) throw new Error(`EXPECTED_402_GOT_${initial.status}: ${await initial.text()}`);
const initialBody = await initial.json();
const required = http.getPaymentRequiredResponse((name) => initial.headers.get(name), initialBody);
const payload = await http.createPaymentPayload(required);
const paid = await fetch(url, {
  method: "POST",
  headers: { ...headers, ...http.encodePaymentSignatureHeader(payload) },
  body: JSON.stringify(body),
});
const paidBody = await paid.json();
if (!paid.ok) throw new Error(`PAID_REQUEST_FAILED_${paid.status}: ${JSON.stringify(paidBody)}`);
const settlement = http.getPaymentSettleResponse((name) => paid.headers.get(name));
console.log(JSON.stringify({
  initialStatus: initial.status,
  paidStatus: paid.status,
  model: paidBody.model,
  content: paidBody.choices?.[0]?.message?.content,
  usage: paidBody.usage,
  fuse: paidBody.fuse,
  settlement,
}, null, 2));
