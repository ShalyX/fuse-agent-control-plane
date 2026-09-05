import { createFuseApp } from "./http/app.js";

import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenRouterProvider } from "./providers/openRouter.js";
import type { InferenceProvider } from "./core/service.js";
import { PostgresStateStore, createPostgresPool } from "./persistence/postgres.js";
import { PostgresSandboxRunStore } from "./product/sandboxRunStore.js";
import { SandboxRunService } from "./product/sandboxRuns.js";

import { IdentityStore } from "./persistence/identityStore.js";
import { CredentialAdministration } from "./identity/credentialAdministration.js";
import { PolicyStore } from "./persistence/policyStore.js";
import { PolicyAdministration } from "./policy/policyAdministration.js";
import { InferenceExecutionService } from "./inference/inferenceExecution.js";
import { providerCredentialKeyRingFromEnv } from "./providers/providerCredentials.js";
import { ProviderConfigStore } from "./persistence/providerConfigStore.js";
import { ProviderAdministration } from "./providers/providerAdministration.js";
import { verifyOpenRouterCredential } from "./providers/openRouterCredentialVerifier.js";
import { ProviderConnectionService } from "./product/providerConnections.js";
import { MandateManagementService } from "./product/mandateManagement.js";
import { PolicyPublishingService } from "./product/policyPublishing.js";
import { AgentIdentityService } from "./product/agentIdentity.js";
import { ProductInferenceService } from "./product/inference.js";
import { ProductReceiptService } from "./product/receipts.js";
import { CustomerOnboardingService } from "./product/customerOnboarding.js";
import { PostgresWorkspaceOnboardingStore } from "./product/workspaceOnboardingStore.js";
import { TenantProviderResolver } from "./providers/tenantProviderResolver.js";
import { ReliabilityProtocolStore } from "./reliability/protocolStore.js";
import { ReliabilityInferenceExecutionStore } from "./reliability/inferenceStore.js";
import { PostgresHumanSessionStore } from "./http/humanSessions.js";
import { createSessionAwareAuthenticator } from "./http/auth.js";
import { PostgresOperationalAuditStore } from "./product/operationalAudit.js";
import { WorkspaceInviteService } from "./identity/workspaceInvites.js";

const unavailableLegacyProvider: InferenceProvider = {
  async complete() {
    throw new Error("TENANT_PROVIDER_CONFIGURATION_REQUIRED");
  },
};

export function reliabilityProtocolEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env["FUSE_RELIABILITY_PROTOCOL_ENABLED"]?.trim().toLowerCase();
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("FUSE_RELIABILITY_PROTOCOL_ENABLED_INVALID");
}

export function operationalReadinessFlagsFromEnv(env: NodeJS.ProcessEnv) {
  const databaseAvailable = Boolean((env["DATABASE_URL_UNPOOLED"] ?? env["DATABASE_URL"])?.trim());
  const inviteHashes = (env["FUSE_BETA_INVITE_TOKEN_HASHES"] ?? "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return {
    controlMode: true,
    settlementDisabled: true,
    durableInviteGate: databaseAvailable && inviteHashes.length > 0
      && inviteHashes.every((value) => /^[a-f0-9]{64}$/.test(value)),
    durableAdminRateLimit: databaseAvailable,
    sourceCredentialRevocationEnforced: databaseAvailable,
  };
}

export function createRuntimeApp(env: NodeJS.ProcessEnv = process.env) {
  const signerOnlySecrets = [
    "CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "CIRCLE_WALLET_ID", "CIRCLE_WALLET_SET_ID",
    "SIGNER_DATABASE_URL", "SIGNER_AUTH_TOKEN",
  ];
  const misplacedSecret = signerOnlySecrets.find((name) => Boolean(env[name]?.trim()));
  if (misplacedSecret) throw new Error(`CONTROL_PLANE_SIGNER_SECRET_FORBIDDEN:${misplacedSecret}`);
  const paymentConfiguration = [
    "FUSE_PAYER_ADDRESS", "FUSE_SELLER_ADDRESS", "FUSE_PAYMENT_NETWORK", "FUSE_PAYMENT_FACILITATOR_URL",
  ].find((name) => Boolean(env[name]?.trim()));
  if (paymentConfiguration) {
    throw new Error(`CONTROL_MODE_PAYMENT_CONFIGURATION_FORBIDDEN:${paymentConfiguration}`);
  }

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
  const providerKeyRing = tenantProviderRequested ? providerCredentialKeyRingFromEnv(env) : undefined;

  const identityStore = databasePool ? new IdentityStore(databasePool) : undefined;
  const sandboxRunStore = databasePool ? new PostgresSandboxRunStore(databasePool) : undefined;
  const humanSessionStore = databasePool ? new PostgresHumanSessionStore(databasePool) : undefined;
  const workspaceInviteService = identityStore && humanSessionStore
    ? new WorkspaceInviteService(identityStore, humanSessionStore)
    : undefined;
  const workspaceOnboardingStore = databasePool && providerKeyRing
    ? new PostgresWorkspaceOnboardingStore(databasePool, providerKeyRing)
    : undefined;
  const operationalAudit = databasePool ? new PostgresOperationalAuditStore(databasePool) : undefined;
  const credentialAdministration = identityStore
    ? new CredentialAdministration(identityStore)
    : undefined;
  const reliabilityProtocolEnabled = reliabilityProtocolEnabledFromEnv(env);
  if (reliabilityProtocolEnabled && !databasePool) {
    throw new Error("DATABASE_URL is required for the optional reliability protocol");
  }
  const policyStore = databasePool ? new PolicyStore(databasePool, {
    protocolMutationExclusionEnabled: reliabilityProtocolEnabled,
    protocolMutationLockTimeoutMs: 5_000,
  }) : undefined;
  const reliabilityStore = reliabilityProtocolEnabled && databasePool
    ? new ReliabilityProtocolStore(databasePool)
    : undefined;
  const executionStore = databasePool && policyStore
    ? reliabilityStore
      ? new ReliabilityInferenceExecutionStore(policyStore, reliabilityStore)
      : policyStore
    : policyStore;
  const policyAdministration = policyStore ? new PolicyAdministration(policyStore) : undefined;

  let provider: InferenceProvider;
  let price: { inputUsdPerMillion: string; outputUsdPerMillion: string };
  let inferenceExecution: InferenceExecutionService | undefined;
  let providerAdministration: ProviderAdministration | undefined;
  let providerConfigStore: ProviderConfigStore | undefined;


  if (tenantProviderRequested && databasePool && policyStore) {
    providerConfigStore = new ProviderConfigStore(
      databasePool,
      providerKeyRing!,
    );
    providerAdministration = new ProviderAdministration(
      providerConfigStore,
      undefined,
      async ({ provider, model, apiKey }) => {
        if (provider !== "openrouter") return;
        await verifyOpenRouterCredential({ apiKey, model });
      },
    );
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
      store: executionStore!,
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
      store: executionStore!,
      providerName,
      model: providerModel,
      price,
      requireProviderCost: providerName === "openrouter",
      requireProviderModelMatch: providerName === "openrouter",
    }) : undefined;

  }


  const workloadShadowFlag = env["FUSE_WORKLOAD_SHADOW_ENABLED"]?.trim().toLowerCase();
  if (workloadShadowFlag && workloadShadowFlag !== "true" && workloadShadowFlag !== "false") {
    throw new Error("FUSE_WORKLOAD_SHADOW_ENABLED_INVALID");
  }
  const workloadShadowEnabled = workloadShadowFlag === "true";
  const betaMaxActiveWorkspaces = Number(env["FUSE_BETA_MAX_ACTIVE_WORKSPACES"] ?? "3");
  if (!Number.isSafeInteger(betaMaxActiveWorkspaces) || betaMaxActiveWorkspaces < 1) {
    throw new Error("FUSE_BETA_MAX_ACTIVE_WORKSPACES_INVALID");
  }
  const betaActiveWorkspaceIds = new Set((env["FUSE_BETA_ACTIVE_WORKSPACE_IDS"] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean));
  const betaInviteTokenHashes = new Set((env["FUSE_BETA_INVITE_TOKEN_HASHES"] ?? "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  if ([...betaInviteTokenHashes].some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("FUSE_BETA_INVITE_TOKEN_HASHES_INVALID");
  }
  const betaRecoveryTokenHashes = new Set((env["FUSE_BETA_RECOVERY_TOKEN_HASHES"] ?? "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  if ([...betaRecoveryTokenHashes].some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("FUSE_BETA_RECOVERY_TOKEN_HASHES_INVALID");
  }

  const providerConnectionService = providerAdministration
    ? new ProviderConnectionService(providerAdministration)
    : undefined;
  const customerOnboardingService = identityStore && credentialAdministration && providerConnectionService
    && policyAdministration
    ? new CustomerOnboardingService({
        identityStore,
        credentialAdministration,
        providerConnectionService,
        policyPublishingService: new PolicyPublishingService(policyAdministration),
        mandateManagementService: new MandateManagementService(policyAdministration),
        onboardingStore: workspaceOnboardingStore,
      })
    : undefined;

  const credentialAuthenticator = identityStore && humanSessionStore
    ? createSessionAwareAuthenticator(identityStore, humanSessionStore)
    : identityStore;
  const operationalReadinessFlags = operationalReadinessFlagsFromEnv(env);
  return createFuseApp({
    provider,
    paymentMode: "control",
    stateStore: databasePool ? new PostgresStateStore(databasePool) : undefined,
    sandboxRunStore,
    sandboxRunService: new SandboxRunService(),

    credentialAuthenticator,
    humanSessionStore,
    identityStore,
    workspaceInviteService,
    credentialAdministration,
    agentIdentityService: credentialAdministration
      ? new AgentIdentityService(credentialAdministration)
      : undefined,
    policyAdministration,
    policyPublishingService: policyAdministration
      ? new PolicyPublishingService(policyAdministration)
      : undefined,
    mandateManagementService: policyAdministration
      ? new MandateManagementService(policyAdministration)
      : undefined,
    providerAdministration,
    providerConnectionService,
    customerOnboardingService,
    operationalAudit,
    inferenceExecution,
    productInferenceService: inferenceExecution
      ? new ProductInferenceService(inferenceExecution)
      : undefined,
    productReceiptService: policyStore
      ? new ProductReceiptService({
          listDecisions: (organizationId, mandateId) => policyStore.listDecisions(organizationId, mandateId),
          getDecision: (organizationId, mandateId, requestId) => policyStore.getDecision(organizationId, mandateId, requestId),
          listDecisionsPage: (organizationId, mandateId, limit, offset, agentId) => policyStore.listDecisionsPage(organizationId, mandateId, limit, offset, agentId),
          listExecutionSettlementsForRequests: (organizationId, mandateId, requestIds) => policyStore.listExecutionSettlementsForRequests(organizationId, mandateId, requestIds),
          listExecutionSettlements: (organizationId, mandateId) => policyStore.listExecutionSettlements(organizationId, mandateId),
          getPaymentEvidence: () => Promise.resolve(null),
          listPaymentEvidence: () => Promise.resolve([]),
        })
      : undefined,
    reliabilityContextIssuer: reliabilityStore ? (input) => reliabilityStore.authorizeHttpReliabilityContext(input) : undefined,
    sealedReplayExecution: reliabilityStore
      ? { execute: (input) => reliabilityStore.executeAuthenticatedSealedReplay(input) }
      : undefined,
    onboardingRateLimit: workspaceOnboardingStore
      ? {
          maxPerMinute: 5,
          consume: async (key, maxPerMinute, now) => workspaceOnboardingStore.consumeRateLimit({ key, maxPerMinute, now: new Date(now) }),
        }
      : undefined,
    betaOnboardingGuard: workspaceOnboardingStore
      ? {
          maxActiveWorkspaces: betaMaxActiveWorkspaces,
          reserveCapacity: (idempotencyKey) => workspaceOnboardingStore.tryReserveCapacity({
            idempotencyKey,
            maxActiveWorkspaces: betaMaxActiveWorkspaces,
            baselineWorkspaceIds: [...betaActiveWorkspaceIds],
          }),
          authorizeInvite: (inviteToken, idempotencyKey) => workspaceOnboardingStore.consumeInvite({
            inviteToken, idempotencyKey, allowedInviteHashes: betaInviteTokenHashes,
          }),
          authorizeRecoveryInvite: (inviteToken, idempotencyKey) => workspaceOnboardingStore.consumeInvite({
            inviteToken, idempotencyKey, allowedInviteHashes: betaRecoveryTokenHashes,
          }),
        }
      : undefined,
    workloadShadowEnabled,
    readiness: async () => {
      if (!databasePool || !policyStore || !sandboxRunStore) {
        return {
          database: false, providerConfiguration: false,
          workloadShadowSchema: false, durableSandbox: false,
        };
      }
      await databasePool.query("SELECT 1");
      if (tenantProviderRequested) await providerConfigStore!.readiness();
      if (workspaceOnboardingStore) await workspaceOnboardingStore.readiness();
      return {
        database: true,
        providerConfiguration: true,
        workloadShadowSchema: await policyStore.workloadShadowSchemaReady(),
        durableSandbox: await sandboxRunStore.readiness(),
      };
    },
    operationalReadiness: async () => ({
      ...operationalReadinessFlags,
      ...(workspaceOnboardingStore
        ? await workspaceOnboardingStore.readOperationalReadiness(new Date(), 15 * 60_000)
        : {
            staleOnboardingOperations: 0, rollbackFailedOnboardingOperations: 0,
            oldestInProgressAt: null, orphanCapacityReservations: 0, oldestOrphanReservationAt: null,
          }),
    }),
    productReadiness: async (principal) => {
      if (!databasePool || !policyStore || !providerConfigStore || !identityStore || !sandboxRunStore) {
        return {
          paymentMode: "control" as const,
          database: false, providerConfiguration: false, policyConfiguration: false,
          agentCredential: false, mandate: false, signerConfiguration: false,
          walletChain: false, gatewayEnvironment: false, sandbox: false,
        };
      }
      const organizationId = principal.organizationId;
      await databasePool.query("SELECT 1");
      const checkedAt = new Date().toISOString();
      const provider = await providerConfigStore.getVerifiedConfigurationSummary(organizationId);
      const [policyConfiguration, agentCredential, mandate, sandbox] = await Promise.all([
        provider
          ? policyStore.hasUsablePolicy(organizationId, provider.provider, provider.model)
          : false,
        identityStore.hasExecutableAgentCredential(organizationId, checkedAt),
        provider
          ? policyStore.hasExecutableMandate(
              organizationId, checkedAt, provider.provider, provider.model,
            )
          : false,
        sandboxRunStore.readiness(),
      ]);
      return {
        paymentMode: "control" as const,
        database: true,
        providerConfiguration: provider !== null,
        policyConfiguration,
        agentCredential,
        mandate,
        signerConfiguration: false,
        walletChain: false,
        gatewayEnvironment: false,
        sandbox,
      };
    },
    adminRateLimit: {
      maxPerMinute: Number(env["FUSE_ADMIN_RATE_LIMIT_PER_MINUTE"] ?? "120"),
      consume: workspaceOnboardingStore
        ? (key, maxPerMinute, now) => workspaceOnboardingStore.consumeRateLimit({ key: `admin:${key}`, maxPerMinute, now: new Date(now) })
        : undefined,
    },
    productRateLimit: {
      maxPerMinute: Number(env["FUSE_PRODUCT_RATE_LIMIT_PER_MINUTE"] ?? "120"),
      consume: workspaceOnboardingStore
        ? (key, maxPerMinute, now) => workspaceOnboardingStore.consumeRateLimit({ key: `product:${key}`, maxPerMinute, now: new Date(now) })
        : undefined,
    },
    sessionRateLimit: {
      maxPerMinute: Number(env["FUSE_SESSION_RATE_LIMIT_PER_MINUTE"] ?? "30"),
      consume: workspaceOnboardingStore
        ? (key, maxPerMinute, now) => workspaceOnboardingStore.consumeRateLimit({ key: `session:${key}`, maxPerMinute, now: new Date(now) })
        : undefined,
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
