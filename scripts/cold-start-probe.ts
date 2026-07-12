import { readFileSync, writeFileSync } from "node:fs";
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
const mode = process.argv[2];
const statePath = "/tmp/fuse-cold-start-payment.json";
const endpoint = process.env["FUSE_URL"] ?? "http://127.0.0.1:8787";
const model = process.env["AGENTROUTER_MODEL"] ?? "claude-opus-4-8";
const requestId = process.env["COLD_START_REQUEST_ID"] ?? "cold-start-live-builder-2026-07-12";
const headers = {
  "content-type": "application/json",
  "Idempotency-Key": requestId,
  "X-Fuse-Child": "builder",
};
const body = JSON.stringify({
  model,
  max_tokens: 8,
  messages: [{ role: "user", content: "Reply with exactly: FUSE COLD START OK" }],
});

if (mode === "prepare") {
  const apiKey = process.env["CIRCLE_API_KEY"]?.trim();
  const entitySecret = process.env["CIRCLE_ENTITY_SECRET"]?.trim();
  if (!apiKey || !entitySecret) throw new Error("Missing Circle credentials");
  const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const wallets = (await circle.listWallets()).data?.wallets ?? [];
  const payer = (process.env["FUSE_PAYER_ADDRESS"] ?? "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7").toLowerCase();
  const wallet = wallets.find((candidate) => candidate.address?.toLowerCase() === payer);
  if (!wallet) throw new Error("PAYER_WALLET_NOT_FOUND");
  const signer = createCircleGatewaySigner({
    client: circle,
    walletId: wallet.id,
    walletAddress: wallet.address as `0x${string}`,
  });
  const client = new x402Client();
  registerBatchScheme(client, { signer });
  const http = new x402HTTPClient(client);
  const initial = await fetch(`${endpoint}/v1/chat/completions`, { method: "POST", headers, body });
  if (initial.status !== 402) throw new Error(`EXPECTED_402:${initial.status}:${await initial.text()}`);
  const initialBody = await initial.json();
  const required = http.getPaymentRequiredResponse((name) => initial.headers.get(name), initialBody);
  const payload = await http.createPaymentPayload(required);
  writeFileSync(statePath, JSON.stringify({
    requestId,
    headers: http.encodePaymentSignatureHeader(payload),
  }), { mode: 0o600 });
  console.log(JSON.stringify({ status: "prepared", requestId, httpStatus: initial.status }));
} else if (mode === "pay") {
  const persisted = JSON.parse(readFileSync(statePath, "utf8"));
  if (persisted.requestId !== requestId) throw new Error("COLD_START_REQUEST_MISMATCH");
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { ...headers, ...persisted.headers },
    body,
  });
  const responseBody = await response.json();
  if (!response.ok) throw new Error(`PAID_RETRY_FAILED:${response.status}:${JSON.stringify(responseBody)}`);
  console.log(JSON.stringify({
    status: "released_after_restart",
    requestId,
    httpStatus: response.status,
    usage: responseBody.usage,
    receipt: responseBody.fuse?.receipt,
  }, null, 2));
} else {
  throw new Error("Usage: cold-start-probe.ts prepare|pay");
}
