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
const payerAddress = (env["FUSE_PAYER_ADDRESS"] ?? "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7").toLowerCase();
const wallet = wallets.find((candidate) => candidate.address?.toLowerCase() === payerAddress);
if (!wallet) throw new Error("NO_LIVE_ARC_EOA");

const signer = createCircleGatewaySigner({
  client: circle,
  walletId: wallet.id,
  walletAddress: wallet.address as `0x${string}`,
});
const client = new x402Client();
registerBatchScheme(client, { signer });
const http = new x402HTTPClient(client);
const endpoint = env["FUSE_URL"] ?? "http://127.0.0.1:8787";
const model = env["AGENTROUTER_MODEL"] ?? "claude-opus-4-8";

type FuseResponse = {
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  fuse: { receipt: {
    requestId: string;
    childId: string;
    costUsdc: string;
    authorizationHash: string;
    circuitState: string;
    circuitReason: string;
    reclaimedUsdc?: string;
  } };
};

async function call(childId: string, requestId: string, contextUnits: number): Promise<FuseResponse> {
  const headers = {
    "content-type": "application/json",
    "Idempotency-Key": requestId,
    "X-Fuse-Child": childId,
  };
  const body = JSON.stringify({
    model,
    max_tokens: 8,
    messages: [{
      role: "user",
      content: `${"context ".repeat(contextUnits)}\nReply with exactly: FUSE`,
    }],
  });
  const initial = await fetch(`${endpoint}/v1/chat/completions`, { method: "POST", headers, body });
  if (initial.status !== 402) throw new Error(`EXPECTED_402_${childId}_${initial.status}:${await initial.text()}`);
  const initialBody = await initial.json();
  const required = http.getPaymentRequiredResponse((name) => initial.headers.get(name), initialBody);
  const payload = await http.createPaymentPayload(required);
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { ...headers, ...http.encodePaymentSignatureHeader(payload) },
    body,
  });
  const responseBody = await response.json() as FuseResponse | { error?: { code?: string } };
  if (!response.ok) throw new Error(`CALL_${childId}_${response.status}:${JSON.stringify(responseBody)}`);
  return responseBody as FuseResponse;
}

const runId = Date.now();
const scoutContextUnits = [10, 300, 1_400];
const scout: FuseResponse[] = [];
for (const [index, contextUnits] of scoutContextUnits.entries()) {
  scout.push(await call("scout", `golden-${runId}-scout-${index + 1}`, contextUnits));
}

if (scout[0].fuse.receipt.circuitState !== "HEALTHY") throw new Error("BASELINE_NOT_HEALTHY");
if (scout[1].fuse.receipt.circuitState !== "ELEVATED") throw new Error("FIRST_SPIKE_NOT_ELEVATED");
if (scout[2].fuse.receipt.circuitState !== "TRIPPED") throw new Error("SECOND_SPIKE_NOT_TRIPPED");
if (!scout[2].fuse.receipt.reclaimedUsdc) throw new Error("TRIP_DID_NOT_RECLAIM");

const blocked = await fetch(`${endpoint}/v1/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "Idempotency-Key": `golden-${runId}-scout-blocked`,
    "X-Fuse-Child": "scout",
  },
  body: JSON.stringify({
    model,
    max_tokens: 8,
    messages: [{ role: "user", content: "This must be blocked before inference." }],
  }),
});
const blockedBody = await blocked.json() as { error?: { code?: string } };
if (blocked.status !== 409 || blockedBody.error?.code !== "BRANCH_TRIPPED") {
  throw new Error(`SCOUT_NOT_BLOCKED:${blocked.status}:${JSON.stringify(blockedBody)}`);
}

const reviewer = await call("reviewer", `golden-${runId}-reviewer-1`, 16);
if (reviewer.fuse.receipt.circuitState !== "HEALTHY") throw new Error("REVIEWER_NOT_HEALTHY");
const stateResponse = await fetch(`${endpoint}/api/state`);
const state = await stateResponse.json();

console.log(JSON.stringify({
  status: "golden_run_complete",
  network: "eip155:5042002",
  payer: wallet.address,
  scout: scout.map((result) => ({
    usage: result.usage,
    costUsdc: result.fuse.receipt.costUsdc,
    circuitState: result.fuse.receipt.circuitState,
    circuitReason: result.fuse.receipt.circuitReason,
    authorizationHash: result.fuse.receipt.authorizationHash,
    reclaimedUsdc: result.fuse.receipt.reclaimedUsdc,
  })),
  blockedScout: { httpStatus: blocked.status, code: blockedBody.error?.code },
  reviewer: {
    usage: reviewer.usage,
    costUsdc: reviewer.fuse.receipt.costUsdc,
    circuitState: reviewer.fuse.receipt.circuitState,
    authorizationHash: reviewer.fuse.receipt.authorizationHash,
  },
  state,
}, null, 2));
