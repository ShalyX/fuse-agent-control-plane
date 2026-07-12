import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

const sellerAddress = "0xa1984d65d411bb30bfd5fb6148c61fcc3cd3332c";
const gateway = createGatewayMiddleware({
  sellerAddress,
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  networks: ["eip155:5042002"],
});

const app = express();
app.get("/fuse/phase-zero", gateway.require("$0.000001"), (_request, response) => {
  response.json({
    ok: true,
    resource: "Fuse Circle Gateway Phase 0",
    settledBy: "Circle Gateway Nanopayments",
  });
});

const port = 4021;
app.listen(port, "127.0.0.1", () => {
  console.log(`Fuse x402 seller listening on http://127.0.0.1:${port}`);
});
