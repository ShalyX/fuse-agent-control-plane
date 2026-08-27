import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { createGatewaySigner } from "./gatewaySigner.js";

const { signer, payerAddress, mode: signerMode } = await createGatewaySigner(process.env);
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
  payer: payerAddress,
  signerMode,
  resource: responseBody,
  settlement,
}, null, 2));
