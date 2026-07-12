import type { Address, Hex } from "viem";

type TypedDataParameters = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

type CircleSignTypedDataInput = {
  walletId: string;
  data: string;
  memo?: string;
};

type CircleSigningClient = {
  signTypedData(input: CircleSignTypedDataInput): Promise<{
    data?: { signature?: string };
  }>;
};

function stringifyTypedData(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

export function createCircleGatewaySigner(config: {
  walletId: string;
  walletAddress: Address;
  client: CircleSigningClient;
}) {
  return {
    address: config.walletAddress,
    async signTypedData(parameters: TypedDataParameters): Promise<Hex> {
      if (parameters.domain.name !== "GatewayWalletBatched") {
        throw new Error("UNEXPECTED_TYPED_DATA_DOMAIN");
      }

      const circleTypedData = {
        ...parameters,
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...parameters.types,
        },
      };
      const response = await config.client.signTypedData({
        walletId: config.walletId,
        data: stringifyTypedData(circleTypedData),
        memo: "Fuse x402 Gateway Nanopayment",
      });
      const signature = response.data?.signature;
      if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        throw new Error("CIRCLE_SIGNATURE_MISSING");
      }
      return signature as Hex;
    },
  };
}
