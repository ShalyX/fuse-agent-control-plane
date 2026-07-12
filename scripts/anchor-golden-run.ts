import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";
import { keccak256, toHex } from "viem";
import { buildReceiptCommitment, type CommittedReceipt } from "../src/core/receiptCommitment.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient: typeof InitiateClient;
};
const apiKey = process.env["CIRCLE_API_KEY"]?.trim();
const entitySecret = process.env["CIRCLE_ENTITY_SECRET"]?.trim();
if (!apiKey || !entitySecret) throw new Error("Missing Circle credentials");
const contractAddress = "0xf736609aa15b255322df4d5dfe6ea66b59b7c663";
const controllerAddress = "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7";
const runId = "golden-run-2026-07-12-v2";
const mandateId = keccak256(toHex(runId));

const evidence = JSON.parse(readFileSync(new URL("../evidence/golden-run-2026-07-12.json", import.meta.url), "utf8"));
const rawReceipts = [...evidence.scout, evidence.reviewer];
const receipts: CommittedReceipt[] = rawReceipts.map((entry: any, index: number) => {
  const childId = index < evidence.scout.length ? "scout" : "reviewer";
  return {
    sequence: index + 1,
    requestId: `${runId}-${childId}-${index + 1}`,
    childId,
    inputTokens: entry.usage.prompt_tokens,
    outputTokens: entry.usage.completion_tokens,
    costAtomic: entry.costUsdc.replace(".", "").replace(/^0+/, "") || "0",
    authorizationHash: entry.authorizationHash,
    circuitState: entry.circuitState,
  };
});
const commitment = buildReceiptCommitment(mandateId, receipts);
if (commitment.totalPaidAtomic !== 5_778n) throw new Error("UNEXPECTED_GOLDEN_TOTAL");

const circle = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const wallets = (await circle.listWallets()).data?.wallets ?? [];
const wallet = wallets.find((candidate) => candidate.address?.toLowerCase() === controllerAddress);
if (!wallet) throw new Error("ARC_CONTROLLER_WALLET_NOT_FOUND");
const fee = { type: "level" as const, config: { feeLevel: "LOW" as const } };

async function submitAndWait(label: string, abiFunctionSignature: string, abiParameters: string[]) {
  const response = await circle.createContractExecutionTransaction({
    walletId: wallet!.id,
    contractAddress,
    abiFunctionSignature,
    abiParameters,
    fee,
  });
  const id = response.data?.id;
  if (!id) throw new Error(`${label.toUpperCase()}_TRANSACTION_ID_MISSING`);
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const transaction = (await circle.getTransaction({ id })).data?.transaction;
    if (["COMPLETE", "CONFIRMED"].includes(transaction?.state ?? "")) return transaction;
    if (["FAILED", "DENIED", "CANCELLED"].includes(transaction?.state ?? "")) {
      throw new Error(`${label.toUpperCase()}_${transaction?.state}:${transaction?.errorReason ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label.toUpperCase()}_TIMEOUT`);
}

const open = await submitAndWait(
  "openMandate",
  "openMandate(bytes32,uint256,address)",
  [mandateId, "250000", controllerAddress],
);
const close = await submitAndWait(
  "closeMandate",
  "closeMandate(bytes32,uint256,bytes32)",
  [mandateId, commitment.totalPaidAtomic.toString(), commitment.hash],
);

console.log(JSON.stringify({
  status: "mandate_closed",
  network: "ARC-TESTNET",
  contractAddress,
  mandateId,
  maximumSpendAtomic: "250000",
  totalPaidAtomic: commitment.totalPaidAtomic.toString(),
  receiptHash: commitment.hash,
  canonicalReceiptBundle: commitment.bundle,
  openTxHash: open?.txHash,
  closeTxHash: close?.txHash,
}, null, 2));
