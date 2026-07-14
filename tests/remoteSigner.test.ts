import { expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createRemoteGatewaySigner } from "../src/signer/remoteSigner.js";

const account = privateKeyToAccount(`0x${"03".repeat(32)}`);
const wrongAccount = privateKeyToAccount(`0x${"04".repeat(32)}`);
const address = account.address;
const authToken = "remote-signer-token-with-32-characters";
const typedData = {
  domain: {
    name: "GatewayWalletBatched",
    version: "1",
    chainId: 8453,
    verifyingContract: "0x2222222222222222222222222222222222222222",
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
    from: address,
    to: "0x4444444444444444444444444444444444444444",
    value: 42n,
    validAfter: "0",
    validBefore: "9999999999",
    nonce: `0x${"11".repeat(32)}`,
  },
} as const;

it("routes Gateway signatures through the tenant signer without exposing Circle authority", async () => {
  let body: Record<string, unknown> | undefined;
  let authorization = "";
  const signer = createRemoteGatewaySigner({
    organizationId: "org-shaly", endpoint: "https://signer.shaly.example",
    authToken, walletAddress: address,
    fetch: async (_url, init) => {
      authorization = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      body = JSON.parse(String(init?.body));
      const signature = await account.signTypedData(body?.["typedData"] as typeof typedData);
      return new Response(JSON.stringify({
        organizationId: "org-shaly", requestId: body?.["requestId"],
        walletAddress: address, signature,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  expect(await signer.signTypedData(typedData)).toMatch(/^0x[0-9a-f]{130}$/);
  expect(authorization).toBe(["Bearer", authToken].join(" "));
  expect(body).toMatchObject({ organizationId: "org-shaly", amountAtomic: "42" });
  expect(body?.["requestId"]).toMatch(/^[a-f0-9]{64}$/);
});

it("fails closed on signer identity mismatches", async () => {
  const signer = createRemoteGatewaySigner({
    organizationId: "org-shaly", endpoint: "https://signer.shaly.example",
    authToken, walletAddress: address,
    fetch: async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        organizationId: "org-fuse-internal", requestId: requestBody.requestId,
        walletAddress: address, signature: `0x${"ab".repeat(65)}`,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await expect(signer.signTypedData(typedData)).rejects.toThrow("REMOTE_SIGNER_IDENTITY_MISMATCH");
});

it("rejects a remote signature from the wrong wallet", async () => {
  const signer = createRemoteGatewaySigner({
    organizationId: "org-shaly", endpoint: "https://signer.shaly.example",
    authToken, walletAddress: address,
    fetch: async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body));
      const signature = await wrongAccount.signTypedData(requestBody.typedData as typeof typedData);
      return new Response(JSON.stringify({
        organizationId: "org-shaly", requestId: requestBody.requestId,
        walletAddress: address, signature,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await expect(signer.signTypedData(typedData)).rejects.toThrow("REMOTE_SIGNER_SIGNATURE_INVALID");
});

it("rejects short remote signer transport tokens", () => {
  expect(() => createRemoteGatewaySigner({
    organizationId: "org-shaly", endpoint: "https://signer.shaly.example",
    authToken: "sixteen-char-key", walletAddress: address,
  })).toThrow("REMOTE_SIGNER_TOKEN_INVALID");
});
