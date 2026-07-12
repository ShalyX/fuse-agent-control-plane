import { keccak256, toHex } from "viem";

export type CommittedReceipt = {
  sequence: number;
  requestId: string;
  childId: string;
  inputTokens: number;
  outputTokens: number;
  costAtomic: string;
  authorizationHash: string;
  circuitState: string;
};

type ReceiptBundle = {
  version: 1;
  mandateId: string;
  receipts: CommittedReceipt[];
};

function validateReceipt(receipt: CommittedReceipt) {
  if (!receipt.requestId || !receipt.childId || !receipt.authorizationHash || !receipt.circuitState) {
    throw new Error("INVALID_RECEIPT_FIELDS");
  }
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
    throw new Error("INVALID_RECEIPT_SEQUENCE");
  }
  if (!/^(0|[1-9]\d*)$/.test(receipt.costAtomic)) throw new Error("INVALID_COST_ATOMIC");
  if (!Number.isSafeInteger(receipt.inputTokens) || receipt.inputTokens < 0) {
    throw new Error("INVALID_INPUT_TOKENS");
  }
  if (!Number.isSafeInteger(receipt.outputTokens) || receipt.outputTokens < 0) {
    throw new Error("INVALID_OUTPUT_TOKENS");
  }
}

export function buildReceiptCommitment(mandateId: string, input: CommittedReceipt[]) {
  if (!mandateId) throw new Error("INVALID_MANDATE_ID");
  const receipts = input.map((receipt) => ({ ...receipt })).sort((a, b) => a.sequence - b.sequence);
  const seenSequences = new Set<number>();
  const seenRequests = new Set<string>();
  for (const receipt of receipts) {
    validateReceipt(receipt);
    if (seenSequences.has(receipt.sequence)) throw new Error("DUPLICATE_RECEIPT_SEQUENCE");
    if (seenRequests.has(receipt.requestId)) throw new Error("DUPLICATE_REQUEST_ID");
    seenSequences.add(receipt.sequence);
    seenRequests.add(receipt.requestId);
  }

  const bundle: ReceiptBundle = { version: 1, mandateId, receipts };
  const canonicalJson = JSON.stringify(bundle);
  const totalPaidAtomic = receipts.reduce((sum, receipt) => sum + BigInt(receipt.costAtomic), 0n);
  return {
    bundle,
    canonicalJson,
    totalPaidAtomic,
    hash: keccak256(toHex(canonicalJson)),
  };
}
