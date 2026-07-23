import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createPostgresPool } from "../src/persistence/postgres.js";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { ProviderConfigStore } from "../src/persistence/providerConfigStore.js";
import { providerCredentialKeyRingFromEnv } from "../src/providers/providerCredentials.js";

const runNeon = process.env["RUN_NEON_INTEGRATION"] === "1";

async function withOrganization(
  operation: (
    stores: readonly [ProviderConfigStore, ProviderConfigStore],
    organizationId: string,
    now: string,
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
    );
  } finally {
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
