import { createFuseApp } from "./http/app.js";
import { createCirclePaymentGuard } from "./circle/paymentGuard.js";
import { AgentRouterProvider } from "./providers/agentRouter.js";

export function createRuntimeApp(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env["ANTHROPIC_API_KEY"]?.trim();
  const baseUrl = env["AGENTROUTER_BASE_URL"] ?? "https://agentrouter.org/v1";
  const userAgent = env["AGENTROUTER_USER_AGENT"] ?? "claude-cli/2.0.0 (external, cli)";
  const payerWallet = env["FUSE_PAYER_ADDRESS"] ?? "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7";
  const sellerAddress = env["FUSE_SELLER_ADDRESS"] ?? "0xa1984d65d411bb30bfd5fb6148c61fcc3cd3332c";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  return createFuseApp({
    provider: new AgentRouterProvider({ apiKey, baseUrl, userAgent }),
    paymentGuard: createCirclePaymentGuard({ sellerAddress }),
    payerWallet,
    price: {
      inputUsdPerMillion: env["FUSE_INPUT_USD_PER_M"] ?? "3.00",
      outputUsdPerMillion: env["FUSE_OUTPUT_USD_PER_M"] ?? "15.00",
    },
    // UTF-8 bytes are a conservative reservation bound. Provider-reported
    // usage remains authoritative for the exact post-inference quote.
    estimateInputTokens: (messages) => new TextEncoder().encode(
      messages.map((message) => `${message.role}:${message.content}`).join("\n"),
    ).length,
  });
}
