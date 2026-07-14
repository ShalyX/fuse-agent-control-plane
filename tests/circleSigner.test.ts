import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createCircleGatewaySigner } from "../src/circle/developerWalletSigner.js";

const account = privateKeyToAccount(`0x${"05".repeat(32)}`);
const wrongAccount = privateKeyToAccount(`0x${"06".repeat(32)}`);

it("adapts Circle Developer-Controlled Wallet typed-data signing to Gateway signer", async () => {
  const calls: unknown[] = [];
  const signer = createCircleGatewaySigner({
    walletId: "wallet-id",
    walletAddress: account.address,
    client: {
      async signTypedData(input) {
        calls.push(input);
        const typedData = JSON.parse(input.data);
        delete typedData.types.EIP712Domain;
        return { data: { signature: await account.signTypedData(typedData) } };
      },
    },
  });

  const signature = await signer.signTypedData({
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId: 5_042_002,
      verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    },
    types: {
      TransferWithAuthorization: [{ name: "value", type: "uint256" }],
    },
    primaryType: "TransferWithAuthorization",
    message: { value: 1_000n },
  });

  expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ walletId: "wallet-id" });
  const submitted = JSON.parse((calls[0] as { data: string }).data);
  expect(submitted.message.value).toBe("1000");
  expect(submitted.types.EIP712Domain).toEqual([
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ]);
});

it("rejects a well-formed Circle signature from the wrong wallet", async () => {
  const signer = createCircleGatewaySigner({
    walletId: "wallet-id", walletAddress: account.address,
    client: { async signTypedData(input) {
      const typedData = JSON.parse(input.data);
      delete typedData.types.EIP712Domain;
      return { data: { signature: await wrongAccount.signTypedData(typedData) } };
    } },
  });
  await expect(signer.signTypedData({
    domain: {
      name: "GatewayWalletBatched", version: "1", chainId: 8453,
      verifyingContract: "0x2222222222222222222222222222222222222222",
    },
    types: { TransferWithAuthorization: [{ name: "value", type: "uint256" }] },
    primaryType: "TransferWithAuthorization", message: { value: 1_000n },
  })).rejects.toThrow("CIRCLE_SIGNATURE_INVALID");
});

it("rejects malformed Circle signatures", async () => {
  const signer = createCircleGatewaySigner({
    walletId: "wallet-id",
    walletAddress: "0x1111111111111111111111111111111111111111",
    client: { async signTypedData() { return { data: { signature: "0x12" } }; } },
  });
  await expect(signer.signTypedData({
    domain: {
      name: "GatewayWalletBatched", version: "1", chainId: 8453,
      verifyingContract: "0x2222222222222222222222222222222222222222",
    },
    types: {}, primaryType: "TransferWithAuthorization", message: {},
  })).rejects.toThrow("CIRCLE_SIGNATURE_MISSING");
});
