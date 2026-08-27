import { readFileSync, writeFileSync } from "node:fs";
import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { createGatewaySigner } from "./gatewaySigner.js";
const mode = process.argv[2];
const statePath = "/tmp/fuse-cold-start-payment.json";
const endpoint = process.env["FUSE_URL"] ?? "http://127.0.0.1:8787";
const model = process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6";
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
  const { signer, mode: signerMode } = await createGatewaySigner(process.env);
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
  console.log(JSON.stringify({ status: "prepared", requestId, httpStatus: initial.status, signerMode }));
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
