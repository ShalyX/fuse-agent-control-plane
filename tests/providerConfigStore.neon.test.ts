import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { Pool } from "pg";
import { createPostgresPool } from "../src/persistence/postgres.js";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { PolicyStore } from "../src/persistence/policyStore.js";
import { ProviderConfigStore } from "../src/persistence/providerConfigStore.js";
import { createApiCredential } from "../src/identity/apiCredentials.js";
import { providerCredentialKeyRingFromEnv } from "../src/providers/providerCredentials.js";
import { ProviderAdministration } from "../src/providers/providerAdministration.js";

const runNeon = process.env["RUN_NEON_INTEGRATION"] === "1";

async function withOrganization(
  operation: (
    stores: readonly [ProviderConfigStore, ProviderConfigStore],
    organizationId: string,
    now: string,
    pool: Pool,
  ) => Promise<void>,
) {
  const configuredUrl = process.env["NEON_INTEGRATION_DATABASE_URL_UNPOOLED"]
    ?? process.env["DATABASE_URL_UNPOOLED"] ?? process.env["DATABASE_URL"];
  if (!configuredUrl) throw new Error("DATABASE_URL_REQUIRED");
  // Schema bootstrap uses session-level advisory locks, which require backend affinity.
  const unpooled = new URL(configuredUrl);
  unpooled.hostname = unpooled.hostname.replace("-pooler.", ".");
  const databaseUrl = unpooled.toString();
  const firstPool = createPostgresPool(databaseUrl);
  const secondPool = createPostgresPool(databaseUrl);
  const organizationId = `provider-integration-${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    const identity = new IdentityStore(firstPool);
    await identity.createOrganization({
      id: organizationId,
      name: "Provider integration test",
      actorId: "test:provider-integration",
      causationId: `test:${organizationId}`,
      occurredAt: now,
    });
    const keyRing = providerCredentialKeyRingFromEnv(process.env);
    await operation(
      [
        new ProviderConfigStore(firstPool, keyRing),
        new ProviderConfigStore(secondPool, keyRing),
      ],
      organizationId,
      now,
      firstPool,
    );
  } finally {
    await firstPool.query("DELETE FROM provider_verification_retries WHERE organization_id = $1", [organizationId]);
    await firstPool.query("DELETE FROM provider_configurations WHERE organization_id = $1", [organizationId]);
    await firstPool.query("DELETE FROM audit_events WHERE organization_id = $1", [organizationId]);
    await firstPool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
    await Promise.all([firstPool.end(), secondPool.end()]);
  }
}

it.runIf(runNeon)("serializes concurrent first provider writes on Neon", async () => {
  await withOrganization(async ([firstStore, secondStore], organizationId, now) => {
    const base = {
      id: "primary", organizationId, provider: "anthropic" as const,
      model: "claude-sonnet-4-6", inputUsdPerMillion: "3.00",
      outputUsdPerMillion: "15.00", actorId: "test:provider-integration", occurredAt: now,
    };
    await Promise.all([
      firstStore.configure({ ...base, apiKey: "integration-secret-a", causationId: "test:concurrent-a" }),
      secondStore.configure({ ...base, apiKey: "integration-secret-b", causationId: "test:concurrent-b" }),
    ]);
    const resolved = await firstStore.resolve(organizationId);
    expect(resolved.credentialVersion).toBe(2);
    expect(resolved.inputUsdPerMillion).toBe("3");
    expect(resolved.outputUsdPerMillion).toBe("15");
    expect(["integration-secret-a", "integration-secret-b"]).toContain(resolved.apiKey);
  });
}, 90_000);

it.runIf(runNeon)("rejects a conflicting configuration id under concurrent first writes", async () => {
  await withOrganization(async ([firstStore, secondStore], organizationId, now) => {
    const base = {
      organizationId, provider: "anthropic" as const, model: "claude-sonnet-4-6",
      apiKey: "integration-secret", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "test:provider-integration", occurredAt: now,
    };
    const outcomes = await Promise.allSettled([
      firstStore.configure({ ...base, id: "primary-a", causationId: "test:conflict-a" }),
      secondStore.configure({ ...base, id: "primary-b", causationId: "test:conflict-b" }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected?.status === "rejected") {
      expect(String(rejected.reason)).toContain("PROVIDER_CONFIGURATION_ID_CONFLICT");
    }
    const listed = await firstStore.list(organizationId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.credentialVersion).toBe(1);
  });
}, 90_000);

it.runIf(runNeon)("allows exactly one concurrent provider verification retry", async () => {
  await withOrganization(async ([firstStore, secondStore], organizationId, now) => {
    await firstStore.configure({
      id: "primary", organizationId, provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "integ...et", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "test:provider-integration", causationId: "test:retry-config", occurredAt: now,
      verificationStatus: "invalid",
    });
    let probes = 0;
    const principal = {
      principalType: "service_account" as const, principalId: "test-admin", credentialId: "test-credential",
      organizationId, capabilities: ["providers:write" as const], role: "admin" as const,
    };
    const verify = async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    const firstAdmin = new ProviderAdministration(firstStore, () => now, verify);
    const secondAdmin = new ProviderAdministration(secondStore, () => now, verify);
    const outcomes = await Promise.allSettled([
      firstAdmin.retry(principal, "primary", "test:retry-a"),
      secondAdmin.retry(principal, "primary", "test:retry-b"),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(probes).toBe(1);
  });
}, 90_000);

it.runIf(runNeon)("replays a completed verification retry across Postgres instances", async () => {
  await withOrganization(async ([firstStore, secondStore], organizationId, now) => {
    await firstStore.configure({
      id: "primary", organizationId, provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "integ...et", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "test:provider-integration", causationId: "test:replay-config", occurredAt: now,
      verificationStatus: "invalid",
    });
    const principal = {
      principalType: "service_account" as const, principalId: "test-admin", credentialId: "test-credential",
      organizationId, capabilities: ["providers:write" as const], role: "admin" as const,
    };
    let probes = 0;
    const firstAdmin = new ProviderAdministration(firstStore, () => now, async () => { probes += 1; });
    const secondAdmin = new ProviderAdministration(secondStore, () => now, async () => {
      throw new Error("REPLAY_MUST_NOT_PROBE");
    });
    const first = await firstAdmin.retry(principal, "primary", "test:replay-request");
    const replay = await secondAdmin.retry(principal, "primary", "test:replay-request");
    expect(replay).toEqual(first);
    expect(probes).toBe(1);
  });
}, 90_000);

it.runIf(runNeon)("rejects a completed verification replay after the credential rotates", async () => {
  await withOrganization(async ([firstStore, secondStore], organizationId, now) => {
    await firstStore.configure({
      id: "primary", organizationId, provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "provider-replay-version-1", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "test:provider-integration", causationId: "test:replay-version-1", occurredAt: now,
      verificationStatus: "invalid",
    });
    const principal = {
      principalType: "service_account" as const, principalId: "test-admin", credentialId: "test-credential",
      organizationId, capabilities: ["providers:write" as const], role: "admin" as const,
    };
    const firstAdmin = new ProviderAdministration(firstStore, () => now, async () => undefined);
    await firstAdmin.retry(principal, "primary", "test:completed-old-version");
    const rotatedAt = new Date(new Date(now).getTime() + 1_000).toISOString();
    await secondStore.configure({
      id: "primary", organizationId, provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "provider-replay-version-2", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "test:provider-integration", causationId: "test:replay-version-2", occurredAt: rotatedAt,
      verificationStatus: "pending",
    });
    const secondAdmin = new ProviderAdministration(secondStore, () => rotatedAt, async () => {
      throw new Error("STALE_REPLAY_MUST_NOT_PROBE");
    });

    await expect(secondAdmin.retry(principal, "primary", "test:completed-old-version"))
      .rejects.toThrow("PROVIDER_VERIFICATION_STALE");
  });
}, 90_000);

it.runIf(runNeon)("reclaims a stale provider verification retry lease", async () => {
  await withOrganization(async ([firstStore, secondStore], organizationId, now, pool) => {
    await firstStore.configure({
      id: "primary", organizationId, provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "provider-test-token", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "test:provider-integration", causationId: "test:stale-config", occurredAt: now,
      verificationStatus: "invalid",
    });
    await firstStore.beginVerificationRetry({
      organizationId, id: "primary", requestId: "test:stale-original", occurredAt: now,
    });
    const retryAt = new Date(new Date(now).getTime() + 16 * 60_000).toISOString();
    const principal = {
      principalType: "service_account" as const, principalId: "test-admin", credentialId: "test-credential",
      organizationId, capabilities: ["providers:write" as const], role: "admin" as const,
    };
    const admin = new ProviderAdministration(secondStore, () => retryAt, async () => undefined);

    await expect(admin.retry(principal, "primary", "test:stale-replacement"))
      .resolves.toMatchObject({ id: "primary", organizationId });
    const stale = await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM provider_verification_retries
        WHERE organization_id = $1 AND config_id = 'primary' AND request_id = 'test:stale-original'`,
      [organizationId],
    );
    expect(stale.rows).toEqual([{
      status: "invalid",
      error_code: "PROVIDER_VERIFICATION_RETRY_LEASE_EXPIRED",
    }]);
  });
}, 90_000);

it.runIf(runNeon)("rejects completion after the credential version changes", async () => {
  await withOrganization(async ([firstStore, secondStore], organizationId, now, pool) => {
    const first = await firstStore.configure({
      id: "primary", organizationId, provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "provi...-1", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "test:provider-integration", causationId: "test:version-1", occurredAt: now,
      verificationStatus: "invalid",
    });
    const claim = await firstStore.beginVerificationRetry({
      organizationId, id: "primary", requestId: "test:version-fence", occurredAt: now,
    });
    const rotatedAt = new Date(new Date(now).getTime() + 1_000).toISOString();
    await secondStore.configure({
      id: "primary", organizationId, provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "provi...-2", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "test:provider-integration", causationId: "test:version-2", occurredAt: rotatedAt,
      verificationStatus: "pending",
    });

    await expect(firstStore.finishVerificationRetry({
      organizationId, id: "primary", requestId: "test:version-fence", claimToken: claim.claimToken!,
      expectedCredentialVersion: first.credentialVersion, status: "verified", summary: first, occurredAt: rotatedAt,
    })).rejects.toThrow("PROVIDER_VERIFICATION_STALE");
    await expect(secondStore.list(organizationId)).resolves.toMatchObject([{ credentialVersion: 2 }]);
    await expect(pool.query<{ verification_status: string }>(
      "SELECT verification_status FROM provider_configurations WHERE organization_id = $1",
      [organizationId],
    )).resolves.toMatchObject({ rows: [{ verification_status: "pending" }] });
  });
}, 90_000);

it.runIf(runNeon)("rejects a stale worker after retry lease reclamation", async () => {
  await withOrganization(async ([firstStore, secondStore], organizationId, now, pool) => {
    const summary = await firstStore.configure({
      id: "primary", organizationId, provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
      apiKey: "provi...en", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
      actorId: "test:provider-integration", causationId: "test:claim-fence", occurredAt: now,
      verificationStatus: "invalid",
    });
    const staleClaim = await firstStore.beginVerificationRetry({
      organizationId, id: "primary", requestId: "test:same-request", occurredAt: now,
    });
    const reclaimedAt = new Date(new Date(now).getTime() + 16 * 60_000).toISOString();
    const replacementClaim = await secondStore.beginVerificationRetry({
      organizationId, id: "primary", requestId: "test:same-request", occurredAt: reclaimedAt,
    });
    expect(replacementClaim.claimToken).not.toBe(staleClaim.claimToken);

    await expect(firstStore.finishVerificationRetry({
      organizationId, id: "primary", requestId: "test:same-request", claimToken: staleClaim.claimToken!,
      expectedCredentialVersion: summary.credentialVersion, status: "verified", summary, occurredAt: reclaimedAt,
    })).rejects.toThrow("PROVIDER_VERIFICATION_RETRY_NOT_FOUND");
  });
}, 90_000);

it.runIf(runNeon)("projects executable tenant readiness on real PostgreSQL", async () => {
  const configuredUrl = process.env["NEON_INTEGRATION_DATABASE_URL_UNPOOLED"]
    ?? process.env["DATABASE_URL_UNPOOLED"] ?? process.env["DATABASE_URL"];
  if (!configuredUrl) throw new Error("DATABASE_URL_REQUIRED");
  const unpooled = new URL(configuredUrl);
  unpooled.hostname = unpooled.hostname.replace("-pooler.", ".");
  const administrationPool = createPostgresPool(unpooled.toString());
  const schema = `product_readiness_${randomUUID().replaceAll("-", "")}`;
  await administrationPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(unpooled);
  isolatedUrl.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = createPostgresPool(isolatedUrl.toString());
  const identity = new IdentityStore(pool);
  const policies = new PolicyStore(pool);
  const providers = new ProviderConfigStore(pool, providerCredentialKeyRingFromEnv(process.env));
  const organizationId = `readiness-integration-${randomUUID()}`;
  const checkedAt = new Date();
  const expiresAt = new Date(checkedAt.getTime() + 60_000).toISOString();
  const context = {
    actorId: "test:product-readiness",
    causationId: `test:${organizationId}`,
    occurredAt: checkedAt.toISOString(),
  };

  try {
    await identity.createOrganization({
      id: organizationId, name: "Product readiness integration", ...context,
    });
    await identity.registerAgent({
      id: "agent-ready", organizationId, name: "Ready agent", ...context,
    });
    const credential = createApiCredential({
      id: "credential-ready", organizationId, agentId: "agent-ready",
      name: "Execution credential", capabilities: ["inference:invoke"],
      createdAt: context.occurredAt, expiresAt,
    }, () => Buffer.alloc(32, 61));
    await identity.issueCredential(credential.record, context);
    await providers.configure({
      id: "primary", organizationId, provider: "anthropic", model: "claude-sonnet-4-6",
      apiKey: "integration-provider-secret", inputUsdPerMillion: "3.00",
      outputUsdPerMillion: "15.00", ...context,
    });
    await policies.publishPolicy({
      id: "policy-ready", organizationId, version: 1, mode: "enforce",
      allowedProviders: ["anthropic"], allowedModels: ["claude-sonnet-4-6"],
      requiredCapability: "inference:invoke",
      limits: {
        maxPerCallAtomic: 1_000n, maxHourlyAtomic: 10_000n, maxDailyAtomic: 50_000n,
        maxRequestsPerMinute: 10, maxInputTokens: 2_000, maxOutputTokens: 500,
      },
      createdAt: context.occurredAt,
    }, context);
    await policies.createMandate({
      id: "mandate-ready", organizationId, name: "Ready mandate", assetId: "usd-micros",
      maximumSpendAtomic: 10_000n, state: "draft", policyId: "policy-ready",
      policyVersion: 1, expiresAt, ...context,
    });
    await policies.assignAgent({
      organizationId, mandateId: "mandate-ready", agentId: "agent-ready", ...context,
    });
    await policies.transitionMandateState(organizationId, "mandate-ready", "active", context);

    await expect(providers.getVerifiedConfigurationSummary(organizationId))
      .resolves.toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
    await expect(policies.hasUsablePolicy(
      organizationId, "anthropic", "claude-sonnet-4-6",
    )).resolves.toBe(true);
    await expect(identity.hasExecutableAgentCredential(organizationId, context.occurredAt))
      .resolves.toBe(true);
    await expect(policies.hasExecutableMandate(
      organizationId, context.occurredAt, "anthropic", "claude-sonnet-4-6",
    )).resolves.toBe(true);
    await expect(policies.hasExecutableMandate(
      organizationId, context.occurredAt, "anthropic", "model-not-allowed",
    )).resolves.toBe(false);
    await expect(policies.hasExecutableMandate(
      "another-tenant", context.occurredAt, "anthropic", "claude-sonnet-4-6",
    )).resolves.toBe(false);

    await pool.query(
      "UPDATE agent_identities SET revoked_at = $2 WHERE organization_id = $1 AND id = 'agent-ready'",
      [organizationId, context.occurredAt],
    );
    await expect(identity.hasExecutableAgentCredential(organizationId, context.occurredAt))
      .resolves.toBe(false);
    await expect(policies.hasExecutableMandate(
      organizationId, context.occurredAt, "anthropic", "claude-sonnet-4-6",
    )).resolves.toBe(false);

    await pool.query(
      "UPDATE provider_configurations SET encryption_key_id = 'missing-key' WHERE organization_id = $1",
      [organizationId],
    );
    await expect(providers.getVerifiedConfigurationSummary(organizationId)).resolves.toBeNull();
  } finally {
    await pool.end().catch(() => undefined);
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  }
}, 90_000);
