import { createFuseApp } from "./http/app.js";
import { createCirclePaymentGuard } from "./circle/paymentGuard.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { PostgresStateStore, createPostgresPool } from "./persistence/postgres.js";
import { IdentityStore } from "./persistence/identityStore.js";
import { CredentialAdministration } from "./identity/credentialAdministration.js";

export function createRuntimeApp(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env["ANTHROPIC_API_KEY"]?.trim();
  const anthropicModel = env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6";
  const anthropicBaseUrl = env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com/v1";
  const payerWallet = env["FUSE_PAYER_ADDRESS"] ?? "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7";
  const sellerAddress = env["FUSE_SELLER_ADDRESS"] ?? "0xa1984d65d411bb30bfd5fb6148c61fcc3cd3332c";
  const databaseUrl = env["DATABASE_URL"];
  const databasePool = databaseUrl ? createPostgresPool(databaseUrl) : undefined;
  const identityStore = databasePool ? new IdentityStore(databasePool) : undefined;
  const credentialAdministration = identityStore
    ? new CredentialAdministration(identityStore)
    : undefined;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  return createFuseApp({
    provider: new AnthropicProvider({
      apiKey,
      model: anthropicModel,
      baseUrl: anthropicBaseUrl,
    }),
    paymentGuard: createCirclePaymentGuard({ sellerAddress }),
    payerWallet,
    stateStore: databasePool ? new PostgresStateStore(databasePool) : undefined,
    credentialAuthenticator: identityStore,
    credentialAdministration,
    price: {
      inputUsdPerMillion: env["FUSE_INPUT_USD_PER_M"] ?? "3.00",
      outputUsdPerMillion: env["FUSE_OUTPUT_USD_PER_M"] ?? "15.00",
    },
    // Reserve UTF-8 bytes plus fixed provider-envelope overhead. Provider-reported
    // usage remains authoritative for the exact post-inference quote.
    estimateInputTokens: (messages) => 512 + new TextEncoder().encode(
      messages.map((message) => `${message.role}:${message.content}`).join("\n"),
    ).length,
  });
}
