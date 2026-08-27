const baseUrl = process.env["FUSE_BASE_URL"]?.replace(/\/$/, "");
const token = process.env["FUSE_LIVE_AGENT_TOKEN"];
const mandateId = process.env["FUSE_LIVE_MANDATE_ID"];
const model = process.env["FUSE_LIVE_MODEL"];
const paymentSignature = process.env["FUSE_LIVE_PAYMENT_SIGNATURE"];
const requestId = process.env["FUSE_LIVE_REQUEST_ID"] ?? `live-e2e-${Date.now()}`;

if (!baseUrl || !token || !mandateId || !model) {
  throw new Error("LIVE_E2E_ENV_REQUIRED:FUSE_BASE_URL,FUSE_LIVE_AGENT_TOKEN,FUSE_LIVE_MANDATE_ID,FUSE_LIVE_MODEL");
}

const liveToken = token;
const liveMandateId = mandateId;

const body = {
  model,
  messages: [{ role: "user", content: process.env["FUSE_LIVE_PROMPT"] ?? "Return exactly: live-receipt-ok" }],
  max_tokens: 64,
};
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
  "X-Fuse-Mandate": mandateId,
  "Idempotency-Key": requestId,
};

async function call(extra: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/v1/product/inference`, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const paymentMode = process.env["FUSE_LIVE_PAYMENT_MODE"] ?? "control";
if (paymentMode !== "control" && paymentMode !== "settlement") {
  throw new Error("LIVE_E2E_PAYMENT_MODE_INVALID");
}

async function readReceipt() {
  const receiptResponse = await fetch(`${baseUrl}/api/v1/product/receipts/${encodeURIComponent(requestId)}?mandateId=${encodeURIComponent(liveMandateId)}`, {
    headers: { Authorization: ["Bearer", liveToken].join(" "), "X-Fuse-Mandate": liveMandateId },
    signal: AbortSignal.timeout(20_000),
  });
  if (receiptResponse.status !== 200) {
    throw new Error(`LIVE_E2E_DURABLE_RECEIPT_READ_FAILED:${receiptResponse.status}`);
  }
  const receipt = await receiptResponse.json();
  if ((receipt.receipt?.requestId ?? receipt.requestId) !== requestId) {
    throw new Error("LIVE_E2E_DURABLE_RECEIPT_MISMATCH");
  }
}

const unpaid = await call();
if (paymentMode === "control") {
  if (unpaid.response.status !== 200) {
    throw new Error(`LIVE_E2E_CONTROL_INFERENCE_FAILED:${unpaid.response.status}:${JSON.stringify(unpaid.payload)}`);
  }
  await readReceipt();
  console.log(JSON.stringify({ ok: true, gate: "control-durable-receipt", requestId, baseUrl }, null, 2));
  process.exit(0);
}
if (unpaid.response.status !== 402) {
  throw new Error(`LIVE_E2E_EXPECTED_PAYMENT_CHALLENGE:${unpaid.response.status}`);
}
if (!unpaid.response.headers.get("payment-required") && !unpaid.response.headers.get("x-payment-required")) {
  throw new Error("LIVE_E2E_PAYMENT_CHALLENGE_HEADER_MISSING");
}

if (!paymentSignature) {
  console.log(JSON.stringify({ ok: true, gate: "payment-required", requestId, baseUrl }, null, 2));
  process.exit(0);
}

const paid = await call({ "PAYMENT-SIGNATURE": paymentSignature });
if (paid.response.status !== 200) {
  throw new Error(`LIVE_E2E_PAID_INFERENCE_FAILED:${paid.response.status}:${JSON.stringify(paid.payload)}`);
}
const receiptId = paid.payload.receipt?.requestId ?? paid.payload.requestId;
if (receiptId !== requestId) {
  throw new Error(`LIVE_E2E_RECEIPT_REQUEST_ID_MISMATCH:${String(receiptId)}`);
}
await readReceipt();
console.log(JSON.stringify({ ok: true, gate: "paid-durable-receipt", requestId, baseUrl }, null, 2));
