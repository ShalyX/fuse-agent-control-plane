import { createFuseApp } from "./http/app.js";
import { createCirclePaymentGuard } from "./circle/paymentGuard.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenRouterProvider } from "./providers/openRouter.js";
import type { InferenceProvider } from "./core/service.js";
import { PostgresStateStore, createPostgresPool } from "./persistence/postgres.js";
import { IdentityStore } from "./persistence/identityStore.js";
import { CredentialAdministration } from "./identity/credentialAdministration.js";
import { PolicyStore } from "./persistence/policyStore.js";
import { PolicyAdministration } from "./policy/policyAdministration.js";
import { InferenceExecutionService } from "./inference/inferenceExecution.js";

export function createRuntimeApp(env: NodeJS.ProcessEnv = process.env) {
  const providerName = env["FUSE_PROVIDER"]?.trim().toLowerCase() ?? "anthropic";
  let provider: InferenceProvider;
  let providerModel: string;
  if (providerName === "openrouter") {
    const apiKey = env["OPENROUTER_API_KEY"]?.trim();
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
    providerModel = env["OPENROUTER_MODEL"] ?? "anthropic/claude-sonnet-4.6";
    provider = new OpenRouterProvider({
      apiKey,
      model: providerModel,
      baseUrl: env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1",
      siteUrl: env["OPENROUTER_SITE_URL"] ?? "https://fuse-agent-control-plane.vercel.app",
      appName: env["OPENROUTER_APP_NAME"] ?? "Fuse",
    });
  } else if (providerName === "anthropic") {
    const apiKey = env["ANTHROPIC_API_KEY"]?.trim();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
    providerModel = env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6";
    provider = new AnthropicProvider({
      apiKey,
      model: providerModel,
      baseUrl: env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com/v1",
    });
  } else {
    throw new Error("FUSE_PROVIDER must be anthropic or openrouter");
  }
  const payerWallet = env["FUSE_PAYER_ADDRESS"] ?? "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7";
  const sellerAddress = env["FUSE_SELLER_ADDRESS"] ?? "0xa1984d65d411bb30bfd5fb6148c61fcc3cd3332c";
  const databaseUrl = env["DATABASE_URL"];
  if (providerName === "openrouter" && !databaseUrl) {
    throw new Error("DATABASE_URL is required for OpenRouter controlled inference");
  }
  const databasePool = databaseUrl ? createPostgresPool(databaseUrl) : undefined;
  const identityStore = databasePool ? new IdentityStore(databasePool) : undefined;
  const credentialAdministration = identityStore
    ? new CredentialAdministration(identityStore)
    : undefined;
  const policyStore = databasePool ? new PolicyStore(databasePool) : undefined;
  const policyAdministration = policyStore ? new PolicyAdministration(policyStore) : undefined;
  const price = {
    inputUsdPerMillion: env["FUSE_INPUT_USD_PER_M"] ?? (providerName === "openrouter" ? "3.30" : "3.00"),
    outputUsdPerMillion: env["FUSE_OUTPUT_USD_PER_M"] ?? (providerName === "openrouter" ? "16.50" : "15.00"),
  };
  const inferenceExecution = policyStore ? new InferenceExecutionService({
    provider,
    store: policyStore,
    providerName,
    model: providerModel,
    price,
    requireProviderCost: providerName === "openrouter",
    requireProviderModelMatch: providerName === "openrouter",
  }) : undefined;

  return createFuseApp({
    provider,
    paymentGuard: createCirclePaymentGuard({ sellerAddress }),
    payerWallet,
    stateStore: databasePool ? new PostgresStateStore(databasePool) : undefined,
    credentialAuthenticator: identityStore,
    credentialAdministration,
    policyAdministration,
    inferenceExecution,
    price,
    // Reserve UTF-8 bytes plus fixed provider-envelope overhead. Provider-reported
    // usage remains authoritative for the exact post-inference quote.
    estimateInputTokens: (messages) => 512 + new TextEncoder().encode(
      messages.map((message) => `${message.role}:${message.content}`).join("\n"),
    ).length,
  });
}
