import { createFuseApp } from "./http/app.js";
import { createCirclePaymentGuard } from "./circle/paymentGuard.js";
import { AnthropicProvider } from "./providers/anthropic.js";

const env = process.env;
const anthropicApiKey = env["ANTHROPIC_API_KEY"];
const sellerAddress = env["FUSE_SELLER_ADDRESS"];
if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");
if (!sellerAddress) throw new Error("FUSE_SELLER_ADDRESS is required");

const app = createFuseApp({
  provider: new AnthropicProvider(anthropicApiKey),
  paymentGuard: createCirclePaymentGuard({ sellerAddress }),
  // UTF-8 bytes are used as a conservative reservation bound. The provider's
  // reported usage is authoritative for the exact post-inference quote.
  estimateInputTokens: (messages) => new TextEncoder().encode(
    messages.map((message) => `${message.role}:${message.content}`).join("\n"),
  ).length,
});

const port = Number(env["PORT"] ?? "8787");
app.listen(port, "0.0.0.0", () => {
  console.log(`Fuse API listening on :${port}`);
});
