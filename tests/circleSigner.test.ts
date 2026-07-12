import { describe, expect, it } from "vitest";
import { createCircleGatewaySigner } from "../src/circle/developerWalletSigner.js";

it("adapts Circle Developer-Controlled Wallet typed-data signing to Gateway signer", async () => {
  const calls: unknown[] = [];
  const signer = createCircleGatewaySigner({
    walletId: "wallet-id",
    walletAddress: "0x1111111111111111111111111111111111111111",
    client: {
      async signTypedData(input) {
        calls.push(input);
        return { data: { signature: `0x${"ab".repeat(65)}` } };
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

  expect(signature).toBe(`0x${"ab".repeat(65)}`);
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
