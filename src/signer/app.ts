import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import { getAddress, recoverTypedDataAddress } from "viem";
import type { Address, Hex } from "viem";
import { z } from "zod";
import type { SignerAuthorizationStore } from "./authorizationStore.js";

export interface SignerTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignerBoundary {
  address: Address;
  signTypedData(input: SignerTypedData): Promise<Hex>;
}

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint256Schema = z.string().regex(/^(0|[1-9]\d*)$/).max(78);
const positiveAtomicSchema = uint256Schema.refine((value) => value !== "0");
const typedDataSchema = z.object({
  domain: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    chainId: z.number().int().positive(),
    verifyingContract: addressSchema,
  }).strict(),
  types: z.record(z.array(z.object({ name: z.string().min(1), type: z.string().min(1) }).strict())),
  primaryType: z.string().min(1),
  message: z.object({
    from: addressSchema,
    to: addressSchema,
    value: uint256Schema,
    validAfter: uint256Schema,
    validBefore: uint256Schema,
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }).strict(),
}).strict();
const signRequestSchema = z.object({
  organizationId: z.string().min(1).max(128),
  requestId: z.string().regex(/^[a-f0-9]{64}$/),
  amountAtomic: positiveAtomicSchema,
  typedData: typedDataSchema,
}).strict();

function fingerprint(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") {
      return `{${Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export function createSignerBoundaryApp(config: {
  organizationId: string;
  callerId: string;
  authToken: string;
  walletAddress: Address;
  gatewayWalletAddress: Address;
  allowedPayToAddress: Address;
  chainId: number;
  verifiedWallet: { blockchain: "BASE"; custodyType: "DEVELOPER"; state: "LIVE" };
  maximumAtomic: bigint;
  maximumTotalAtomic: bigint;
  signer: SignerBoundary;
  authorizationStore: SignerAuthorizationStore;
}) {
  if (!config.organizationId.trim()) throw new Error("SIGNER_ORGANIZATION_REQUIRED");
  if (!config.callerId.trim() || config.callerId.length > 128) throw new Error("SIGNER_CALLER_INVALID");
  if (config.authToken.length < 32) throw new Error("SIGNER_AUTH_TOKEN_INVALID");
  if (config.chainId !== 8453 || config.verifiedWallet.blockchain !== "BASE"
    || config.verifiedWallet.custodyType !== "DEVELOPER" || config.verifiedWallet.state !== "LIVE") {
    throw new Error("SIGNER_WALLET_NOT_LIVE_BASE_DEVELOPER");
  }
  if (config.maximumAtomic <= 0n || config.maximumTotalAtomic < config.maximumAtomic) {
    throw new Error("SIGNER_MAXIMUM_INVALID");
  }
  if (config.signer.address.toLowerCase() !== config.walletAddress.toLowerCase()) {
    throw new Error("SIGNER_WALLET_MISMATCH");
  }
  const app = express();
  app.use(express.json({ limit: "128kb" }));
  app.get("/health", (_request, response) => {
    response.json({ ok: true, service: "fuse-signer" });
  });
  app.get("/v1/status", async (request, response) => {
    response.set({ "Cache-Control": "no-store", "CDN-Cache-Control": "no-store" });
    if (!authorized(request.header("Authorization"), config.authToken)) {
      response.status(401).json({ error: { code: "SIGNER_UNAUTHORIZED" } });
      return;
    }
    try {
      const authorization = await config.authorizationStore.getStatus(config.organizationId);
      response.json({
        ok: true,
        service: "fuse-signer",
        organizationId: config.organizationId,
        maximumAtomic: config.maximumAtomic.toString(),
        identity: {
          walletAddress: config.walletAddress,
          chainId: config.chainId,
          gatewayWalletAddress: config.gatewayWalletAddress,
          allowedPayToAddress: config.allowedPayToAddress,
          wallet: config.verifiedWallet,
        },
        authorization: {
          reservedCount: authorization.reservedCount,
          reviewCount: authorization.reviewCount,
          reservedAtomic: authorization.reservedAtomic.toString(),
          maximumTotalAtomic: (authorization.maximumTotalAtomic === 0n
            ? config.maximumTotalAtomic : authorization.maximumTotalAtomic).toString(),
        },
      });
    } catch {
      response.status(503).json({ error: { code: "SIGNER_STATUS_UNAVAILABLE" } });
    }
  });
  app.post("/v1/sign", async (request, response) => {
    response.set({ "Cache-Control": "no-store", "CDN-Cache-Control": "no-store" });
    if (!authorized(request.header("Authorization"), config.authToken)) {
      response.status(401).json({ error: { code: "SIGNER_UNAUTHORIZED" } });
      return;
    }
    const parsed = signRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: { code: "SIGNER_REQUEST_INVALID" } });
      return;
    }
    const input = parsed.data;
    if (input.organizationId !== config.organizationId) {
      response.status(403).json({ error: { code: "SIGNER_TENANT_FORBIDDEN" } });
      return;
    }
    const amountAtomic = BigInt(input.amountAtomic);
    if (amountAtomic > config.maximumAtomic) {
      response.status(403).json({ error: { code: "SIGNER_AMOUNT_EXCEEDS_CAP" } });
      return;
    }
    const from = input.typedData.message["from"];
    const to = input.typedData.message["to"];
    const value = input.typedData.message["value"];
    const validAfterText = input.typedData.message["validAfter"];
    const validBeforeText = input.typedData.message["validBefore"];
    const nonce = input.typedData.message["nonce"];
    const authorizationTypes = input.typedData.types["TransferWithAuthorization"];
    const expectedAuthorizationTypes = [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ];
    const exactTypes = Object.keys(input.typedData.types).length === 1
      && JSON.stringify(authorizationTypes) === JSON.stringify(expectedAuthorizationTypes);
    const validAfter = typeof validAfterText === "string" && /^\d+$/.test(validAfterText)
      ? BigInt(validAfterText) : null;
    const validBefore = typeof validBeforeText === "string" && /^\d+$/.test(validBeforeText)
      ? BigInt(validBeforeText) : null;
    const now = BigInt(Math.floor(Date.now() / 1_000));
    const earliestAllowed = now - 3_600n;
    const latestAllowed = now + 8n * 24n * 60n * 60n;
    const validTypedData = input.typedData.domain.name === "GatewayWalletBatched"
      && input.typedData.domain.version === "1"
      && input.typedData.domain.chainId === config.chainId
      && input.typedData.domain.verifyingContract.toLowerCase()
        === config.gatewayWalletAddress.toLowerCase()
      && input.typedData.primaryType === "TransferWithAuthorization"
      && exactTypes
      && typeof from === "string"
      && from.toLowerCase() === config.walletAddress.toLowerCase()
      && typeof to === "string"
      && to.toLowerCase() === config.allowedPayToAddress.toLowerCase()
      && String(value) === input.amountAtomic
      && validAfter !== null && validAfter >= earliestAllowed && validAfter <= now
      && validBefore !== null && validBefore > now && validBefore <= latestAllowed
      && typeof nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(nonce);
    if (!validTypedData) {
      response.status(400).json({ error: { code: "SIGNER_TYPED_DATA_REJECTED" } });
      return;
    }
    const requestFingerprint = fingerprint({
      organizationId: input.organizationId,
      amountAtomic: input.amountAtomic,
      typedData: input.typedData,
    });
    let reservation;
    try {
      reservation = await config.authorizationStore.reserve({
        organizationId: config.organizationId,
        callerId: config.callerId,
        requestId: input.requestId,
        fingerprint: requestFingerprint,
        nonce,
        amountAtomic,
        maximumTotalAtomic: config.maximumTotalAtomic,
        now: new Date().toISOString(),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const conflict = code === "SIGNER_IDEMPOTENCY_CONFLICT" || code === "SIGNER_NONCE_CONFLICT";
      response.status(conflict ? 409 : 500).json({
        error: { code: conflict ? code : "SIGNER_AUTHORIZATION_FAILED" },
      });
      return;
    }
    if (reservation.status === "completed") {
      try {
        const recoveredAddress = await recoverTypedDataAddress({
          ...(input.typedData as SignerTypedData), signature: reservation.signature,
        });
        if (getAddress(recoveredAddress) !== getAddress(config.walletAddress)) throw new Error();
      } catch {
        response.status(502).json({ error: { code: "SIGNER_STORED_SIGNATURE_INVALID" } });
        return;
      }
      response.json({
        organizationId: config.organizationId,
        requestId: input.requestId,
        walletAddress: config.walletAddress,
        signature: reservation.signature,
      });
      return;
    }
    if (reservation.status !== "reserved") {
      const code = reservation.status === "budget_exceeded"
        ? "SIGNER_TOTAL_AUTHORITY_EXCEEDED"
        : reservation.status === "review"
          ? "SIGNER_AUTHORIZATION_REVIEW"
          : "SIGNER_AUTHORIZATION_IN_PROGRESS";
      response.status(reservation.status === "budget_exceeded" ? 403 : 409)
        .json({ error: { code } });
      return;
    }
    try {
      const typedData = input.typedData as SignerTypedData;
      const signature = await config.signer.signTypedData(typedData);
      const recoveredAddress = await recoverTypedDataAddress({ ...typedData, signature });
      if (getAddress(recoveredAddress) !== getAddress(config.walletAddress)) {
        throw new Error("SIGNER_SIGNATURE_INVALID");
      }
      await config.authorizationStore.complete({
        organizationId: config.organizationId,
        requestId: input.requestId,
        signature,
        completedAt: new Date().toISOString(),
      });
      response.json({
        organizationId: config.organizationId,
        requestId: input.requestId,
        walletAddress: config.walletAddress,
        signature,
      });
    } catch (error) {
      try {
        await config.authorizationStore.holdForReview({
          organizationId: config.organizationId,
          requestId: input.requestId,
          reasonCode: error instanceof Error && error.message === "SIGNER_SIGNATURE_INVALID"
            ? "SIGNER_SIGNATURE_INVALID" : "CIRCLE_SIGNING_OUTCOME_AMBIGUOUS",
          heldAt: new Date().toISOString(),
        });
      } catch {
        // The committed reservation remains the durable fail-closed fallback.
      }
      const invalidSignature = error instanceof Error && error.message === "SIGNER_SIGNATURE_INVALID";
      response.status(invalidSignature ? 502 : 503).json({
        error: { code: invalidSignature ? "SIGNER_SIGNATURE_INVALID" : "SIGNER_UNAVAILABLE" },
      });
    }
  });
  return app;
}
