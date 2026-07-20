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
import { providerCredentialKeyRingFromEnv } from "./providers/providerCredentials.js";
import { ProviderConfigStore } from "./persistence/providerConfigStore.js";
import { ProviderAdministration } from "./providers/providerAdministration.js";
import { TenantProviderResolver } from "./providers/tenantProviderResolver.js";

const unavailableLegacyProvider: InferenceProvider = {
  async complete() {
    throw new Error("TENANT_PROVIDER_CONFIGURATION_REQUIRED");
  },
};

export function createRuntimeApp(env: NodeJS.ProcessEnv = process.env) {
  const signerOnlySecrets = [
    "CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "CIRCLE_WALLET_ID", "CIRCLE_WALLET_SET_ID",
    "SIGNER_DATABASE_URL", "SIGNER_AUTH_TOKEN",
  ];
  const misplacedSecret = signerOnlySecrets.find((name) => Boolean(env[name]?.trim()));
  if (misplacedSecret) throw new Error(`CONTROL_PLANE_SIGNER_SECRET_FORBIDDEN:${misplacedSecret}`);

  const databaseUrl = env["DATABASE_URL_UNPOOLED"] ?? env["DATABASE_URL"];
  if (databaseUrl && new URL(databaseUrl).hostname.includes("-pooler.")) {
    throw new Error("DATABASE_URL_UNPOOLED_REQUIRED");
  }
  const databasePool = databaseUrl ? createPostgresPool(databaseUrl) : undefined;
  const configuredMode = env["FUSE_PROVIDER_MODE"]?.trim().toLowerCase();
  if (configuredMode && configuredMode !== "tenant" && configuredMode !== "legacy") {
    throw new Error("FUSE_PROVIDER_MODE_INVALID");
  }
  const providerMode = configuredMode
    ?? (env["NODE_ENV"] === "production" ? "tenant" : "legacy");
  const tenantProviderRequested = providerMode === "tenant";
  if (tenantProviderRequested && !databasePool) {
    throw new Error("DATABASE_URL is required for tenant provider configurations");
  }
  if (providerMode === "legacy" && env["NODE_ENV"] === "production"
    && env["FUSE_ALLOW_LEGACY_PROVIDER_MODE"] !== "true") {
    throw new Error("LEGACY_PROVIDER_MODE_FORBIDDEN");
  }

  const identityStore = databasePool ? new IdentityStore(databasePool) : undefined;
  const credentialAdministration = identityStore
    ? new CredentialAdministration(identityStore)
    : undefined;
  const policyStore = databasePool ? new PolicyStore(databasePool) : undefined;
  const policyAdministration = policyStore ? new PolicyAdministration(policyStore) : undefined;

  let provider: InferenceProvider;
  let price: { inputUsdPerMillion: string; outputUsdPerMillion: string };
  let inferenceExecution: InferenceExecutionService | undefined;
  let providerAdministration: ProviderAdministration | undefined;
  let providerConfigStore: ProviderConfigStore | undefined;

  if (tenantProviderRequested && databasePool && policyStore) {
    providerConfigStore = new ProviderConfigStore(
      databasePool,
      providerCredentialKeyRingFromEnv(env),
    );
    providerAdministration = new ProviderAdministration(providerConfigStore);
    const resolver = new TenantProviderResolver(
      providerConfigStore,
      undefined,
      env["FUSE_PUBLIC_URL"] ?? "https://fuse-agent-control-plane.vercel.app",
    );
    provider = unavailableLegacyProvider;
    price = {
      inputUsdPerMillion: env["FUSE_INPUT_USD_PER_M"] ?? "3.00",
      outputUsdPerMillion: env["FUSE_OUTPUT_USD_PER_M"] ?? "15.00",
    };
    inferenceExecution = new InferenceExecutionService({
      store: policyStore,
      resolveProvider: (organizationId) => resolver.resolve(organizationId),
    });
  } else {
    const providerName = env["FUSE_PROVIDER"]?.trim().toLowerCase() ?? "anthropic";
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
    if (providerName === "openrouter" && !databaseUrl) {
      throw new Error("DATABASE_URL is required for OpenRouter controlled inference");
    }
    price = {
      inputUsdPerMillion: env["FUSE_INPUT_USD_PER_M"]
        ?? (providerName === "openrouter" ? "3.30" : "3.00"),
      outputUsdPerMillion: env["FUSE_OUTPUT_USD_PER_M"]
        ?? (providerName === "openrouter" ? "16.50" : "15.00"),
    };
    inferenceExecution = policyStore ? new InferenceExecutionService({
      provider,
      store: policyStore,
      providerName,
      model: providerModel,
      price,
      requireProviderCost: providerName === "openrouter",
      requireProviderModelMatch: providerName === "openrouter",
    }) : undefined;
  }

  const payerWallet = env["FUSE_PAYER_ADDRESS"] ?? "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7";
  const sellerAddress = env["FUSE_SELLER_ADDRESS"] ?? "0xa1984d65d411bb30bfd5fb6148c61fcc3cd3332c";
  const workloadShadowFlag = env["FUSE_WORKLOAD_SHADOW_ENABLED"]?.trim().toLowerCase();
  if (workloadShadowFlag && workloadShadowFlag !== "true" && workloadShadowFlag !== "false") {
    throw new Error("FUSE_WORKLOAD_SHADOW_ENABLED_INVALID");
  }
  const workloadShadowEnabled = workloadShadowFlag === "true";

  return createFuseApp({
    provider,
    paymentGuard: createCirclePaymentGuard({ sellerAddress }),
    payerWallet,
    stateStore: databasePool ? new PostgresStateStore(databasePool) : undefined,
    credentialAuthenticator: identityStore,
    credentialAdministration,
    policyAdministration,
    providerAdministration,
    inferenceExecution,
    workloadShadowEnabled,
    readiness: async () => {
      if (!databasePool || !policyStore) {
        return { database: false, providerConfiguration: false, workloadShadowSchema: false };
      }
      await databasePool.query("SELECT 1");
      if (tenantProviderRequested) await providerConfigStore!.readiness();
      return {
        database: true,
        providerConfiguration: true,
        workloadShadowSchema: await policyStore.workloadShadowSchemaReady(),
      };
    },
    adminRateLimit: {
      maxPerMinute: Number(env["FUSE_ADMIN_RATE_LIMIT_PER_MINUTE"] ?? "120"),
    },
    requestLogger: (event) => {
      console.info(JSON.stringify({ event: "http_request", ...event }));
    },
    price,
    // Reserve UTF-8 bytes plus fixed provider-envelope overhead. Provider-reported
    // usage remains authoritative for the exact post-inference quote.
    estimateInputTokens: (messages) => 512 + new TextEncoder().encode(
      messages.map((message) => `${message.role}:${message.content}`).join("\n"),
    ).length,
  });
}
