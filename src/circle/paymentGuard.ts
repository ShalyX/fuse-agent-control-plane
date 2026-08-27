import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

export function createCirclePaymentGuard(config: {
  sellerAddress: string;
  facilitatorUrl?: string;
  networks?: string[];
}) {
  const gateway = createGatewayMiddleware({
    sellerAddress: config.sellerAddress,
    facilitatorUrl: config.facilitatorUrl ?? "https://gateway-api-testnet.circle.com",
    networks: config.networks ?? ["eip155:5042002"],
  });
  return (priceUsdc: string) => gateway.require(`$${priceUsdc}`);
}
