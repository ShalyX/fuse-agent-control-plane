import { expect, it } from "vitest";
import request from "supertest";
import { privateKeyToAccount } from "viem/accounts";
import { createSignerBoundaryApp } from "../src/signer/app.js";
import type { SignerAuthorizationStore } from "../src/signer/authorizationStore.js";

const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const wrongAccount = privateKeyToAccount(`0x${"02".repeat(32)}`);
const walletAddress = account.address;
const gatewayWalletAddress = "0x2222222222222222222222222222222222222222";
const allowedPayToAddress = "0x4444444444444444444444444444444444444444";
const authToken = "signer-token-with-at-least-32-characters";
const authorizationHeader = ["Bearer", authToken].join(" ");
const typedData = (value: string, from = walletAddress) => ({
  domain: {
    name: "GatewayWalletBatched",
    version: "1",
    chainId: 8453,
    verifyingContract: gatewayWalletAddress,
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from,
    to: allowedPayToAddress,
    value,
    validAfter: String(Math.floor(Date.now() / 1_000) - 600),
    validBefore: String(Math.floor(Date.now() / 1_000) + 7 * 24 * 60 * 60 + 100),
    nonce: `0x${"11".repeat(32)}`,
  },
});

function memoryAuthorizationStore(storedSignature?: `0x${string}`): SignerAuthorizationStore {
  const records = new Map<string, {
    fingerprint: string;
    status: "reserved" | "completed" | "review";
    signature?: `0x${string}`;
  }>();
  return {
    async getStatus() {
      let reservedCount = 0;
      let reviewCount = 0;
      for (const record of records.values()) {
        if (record.status === "reserved") reservedCount += 1;
        if (record.status === "review") reviewCount += 1;
      }
      return { reservedCount, reviewCount, reservedAtomic: 0n, maximumTotalAtomic: 100n };
    },
    async reserve(input) {
      const record = records.get(input.requestId);
      if (!record) {
        records.set(input.requestId, { fingerprint: input.fingerprint, status: "reserved" });
        return { status: "reserved" };
      }
      if (record.fingerprint !== input.fingerprint) throw new Error("SIGNER_IDEMPOTENCY_CONFLICT");
      if (record.status === "completed" && record.signature) {
        return { status: "completed", signature: record.signature };
      }
      return { status: record.status === "review" ? "review" : "in_progress" };
    },
    async complete(input) {
      const record = records.get(input.requestId);
      if (!record) throw new Error("SIGNER_AUTHORIZATION_NOT_RESERVED");
      records.set(input.requestId, {
        ...record, status: "completed", signature: storedSignature ?? input.signature,
      });
    },
    async holdForReview(input) {
      const record = records.get(input.requestId);
      if (!record) throw new Error("SIGNER_AUTHORIZATION_NOT_RESERVED");
      records.set(input.requestId, { ...record, status: "review" });
    },
  };
}

function appWithSigner(
  onSign: (input: unknown) => void = () => undefined,
  signingAccount = account,
  storedSignature?: `0x${string}`,
) {
  return createSignerBoundaryApp({
    organizationId: "org-shaly",
    callerId: "fuse-control-plane",
    authToken,
    walletAddress,
    gatewayWalletAddress,
    allowedPayToAddress,
    chainId: 8453,
    verifiedWallet: { blockchain: "BASE", custodyType: "DEVELOPER", state: "LIVE" } as const,
    maximumAtomic: 100n,
    maximumTotalAtomic: 100n,
    authorizationStore: memoryAuthorizationStore(storedSignature),
    signer: {
      address: walletAddress,
      async signTypedData(input) {
        onSign(input);
        return signingAccount.signTypedData(input);
      },
    },
  });
}

it("keeps Shaly signer authority behind a tenant-bound capped service", async () => {
  const calls: unknown[] = [];
  const app = appWithSigner((input) => calls.push(input));

  expect((await request(app).get("/health")).body).toEqual({ ok: true, service: "fuse-signer" });
  expect((await request(app).get("/v1/status")).status).toBe(401);
  const status = await request(app).get("/v1/status").set("Authorization", authorizationHeader);
  expect(status.body).toEqual({
    ok: true, service: "fuse-signer", organizationId: "org-shaly", maximumAtomic: "100",
    identity: {
      walletAddress, chainId: 8453, gatewayWalletAddress, allowedPayToAddress,
      wallet: { blockchain: "BASE", custodyType: "DEVELOPER", state: "LIVE" },
    },
    authorization: {
      reservedCount: 0, reviewCount: 0, reservedAtomic: "0", maximumTotalAtomic: "100",
    },
  });
  expect((await request(app).post("/v1/sign").send({})).status).toBe(401);
  expect((await request(app).post("/v1/sign").set("Authorization", authorizationHeader).send({
    organizationId: "org-fuse-internal", requestId: "a".repeat(64),
    amountAtomic: "100", typedData: typedData("100"),
  })).status).toBe(403);
  expect((await request(app).post("/v1/sign").set("Authorization", authorizationHeader).send({
    organizationId: "org-shaly", requestId: "0".repeat(64),
    amountAtomic: "0", typedData: typedData("0"),
  })).status).toBe(400);
  expect((await request(app).post("/v1/sign").set("Authorization", authorizationHeader).send({
    organizationId: "org-shaly", requestId: "b".repeat(64),
    amountAtomic: "101", typedData: typedData("101"),
  })).status).toBe(403);
  expect(calls).toHaveLength(0);

  const replayPayload = {
    organizationId: "org-shaly", requestId: "c".repeat(64),
    amountAtomic: "100", typedData: typedData("100"),
  };
  const signed = await request(app).post("/v1/sign").set("Authorization", authorizationHeader)
    .send(replayPayload);
  expect(signed.status).toBe(200);
  expect(signed.body).toEqual({
    organizationId: "org-shaly", requestId: "c".repeat(64),
    walletAddress, signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
  });
  expect(calls).toHaveLength(1);
  const replay = await request(app).post("/v1/sign").set("Authorization", authorizationHeader)
    .send(replayPayload);
  expect(replay.status).toBe(200);
  expect(replay.body.signature).toBe(signed.body.signature);
  expect(calls).toHaveLength(1);
});

it("refuses to persist a structurally valid signature from the wrong wallet", async () => {
  const app = appWithSigner(() => undefined, wrongAccount);
  const response = await request(app).post("/v1/sign").set("Authorization", authorizationHeader).send({
    organizationId: "org-shaly", requestId: "d".repeat(64),
    amountAtomic: "100", typedData: typedData("100"),
  });
  expect(response.status).toBe(502);
  expect(response.body).toEqual({ error: { code: "SIGNER_SIGNATURE_INVALID" } });
});

it("rejects an invalid completed signature instead of replaying it", async () => {
  const app = appWithSigner(() => undefined, account, `0x${"ab".repeat(65)}`);
  const payload = {
    organizationId: "org-shaly", requestId: "e".repeat(64),
    amountAtomic: "100", typedData: typedData("100"),
  };
  expect((await request(app).post("/v1/sign").set("Authorization", authorizationHeader).send(payload)).status)
    .toBe(200);
  const replay = await request(app).post("/v1/sign").set("Authorization", authorizationHeader).send(payload);
  expect(replay.status).toBe(502);
  expect(replay.body).toEqual({ error: { code: "SIGNER_STORED_SIGNATURE_INVALID" } });
});

it("rejects changes to authorization identity, recipient, value, validity, nonce, or type shape", async () => {
  let calls = 0;
  const app = appWithSigner(() => { calls += 1; });
  const base = typedData("100");
  const variants = [
    typedData("99"),
    typedData("100", "0x3333333333333333333333333333333333333333"),
    { ...base, domain: { ...base.domain, chainId: 1 } },
    { ...base, domain: { ...base.domain, name: "USDC" } },
    { ...base, domain: { ...base.domain, version: "2" } },
    { ...base, message: { ...base.message, to: walletAddress } },
    { ...base, message: { ...base.message, validAfter: "1" } },
    { ...base, message: { ...base.message, validBefore: "1" } },
    { ...base, message: { ...base.message, nonce: "0x12" } },
    { ...base, message: { ...base.message, memo: "not-authorized" } },
    { ...base, message: { ...base.message, value: "0100" } },
    { ...base, types: { TransferWithAuthorization: base.types.TransferWithAuthorization.slice(0, 2) } },
  ];
  for (const [index, candidate] of variants.entries()) {
    const response = await request(app).post("/v1/sign").set("Authorization", authorizationHeader).send({
      organizationId: "org-shaly", requestId: index.toString(16).padStart(64, "0"),
      amountAtomic: "100", typedData: candidate,
    });
    expect(response.status).toBe(400);
  }
  expect(calls).toBe(0);
});
