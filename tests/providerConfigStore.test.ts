import { DataType, newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { ProviderConfigStore } from "../src/persistence/providerConfigStore.js";
import type { ProviderCredentialKeyRing } from "../src/providers/providerCredentials.js";

const keyRing: ProviderCredentialKeyRing = {
  activeKeyId: "v1",
  keys: new Map([["v1", Buffer.alloc(32, 9)]]),
};

const context = {
  actorId: "service:admin",
  causationId: "request:provider-config",
  occurredAt: "2026-07-19T16:00:00.000Z",
};

async function createStores() {
  const memoryDb = newDb({ noAstCoverageCheck: true });
  memoryDb.public.registerFunction({
    name: "char_length",
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  });
  const adapter = memoryDb.adapters.createPg();
  const pool = new adapter.Pool();
  const identity = new IdentityStore(pool);
  await identity.createOrganization({ id: "org-1", name: "Customer Zero", ...context });
  await identity.createOrganization({ id: "org-2", name: "Fuse Internal", ...context });
  return { pool, store: new ProviderConfigStore(pool, keyRing) };
}

describe("ProviderConfigStore", () => {
  it("stores provider credentials as tenant-scoped encrypted versions", async () => {
    const { pool, store } = await createStores();

    await store.configure({
      id: "primary",
      organizationId: "org-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "sk-ant-org-one",
      inputUsdPerMillion: "3.00",
      outputUsdPerMillion: "15.00",
      ...context,
    });
    await store.configure({
      id: "primary",
      organizationId: "org-2",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      apiKey: "sk-or-org-two",
      inputUsdPerMillion: "3.30",
      outputUsdPerMillion: "16.50",
      ...context,
    });

    const first = await store.resolve("org-1");
    const second = await store.resolve("org-2");
    expect(first).toMatchObject({ provider: "anthropic", apiKey: "sk-ant-org-one", credentialVersion: 1 });
    expect(second).toMatchObject({ provider: "openrouter", apiKey: "sk-or-org-two", credentialVersion: 1 });
    const persisted = JSON.stringify((await pool.query(
      "SELECT encrypted_secret FROM provider_configurations",
    )).rows);
    expect(persisted).not.toContain("sk-ant-org-one");
    expect(persisted).not.toContain("sk-or-org-two");
    await pool.end();
  });

  it("rotates a credential atomically without retaining the prior encrypted secret", async () => {
    const { pool, store } = await createStores();
    const input = {
      id: "primary",
      organizationId: "org-1",
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      apiKey: "sk-ant-first",
      inputUsdPerMillion: "3.00",
      outputUsdPerMillion: "15.00",
      ...context,
    };
    await store.configure(input);
    const firstCiphertext = (await pool.query(
      "SELECT encrypted_secret FROM provider_configurations WHERE organization_id = 'org-1'",
    )).rows[0]?.encrypted_secret;
    await store.configure({
      ...input,
      apiKey: "sk-ant-second",
      causationId: "request:rotate-provider",
      occurredAt: "2026-07-19T16:05:00.000Z",
    });

    expect(await store.resolve("org-1")).toMatchObject({ apiKey: "sk-ant-second", credentialVersion: 2 });
    const persisted = (await pool.query(
      "SELECT encrypted_secret, credential_version FROM provider_configurations WHERE organization_id = 'org-1'",
    )).rows;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.credential_version).toBe(2);
    expect(persisted[0]?.encrypted_secret).not.toBe(firstCiphertext);
    expect(JSON.stringify(persisted)).not.toContain("sk-ant-first");
    const listed = await store.list("org-1");
    expect(listed).toEqual([expect.objectContaining({ id: "primary", credentialVersion: 2 })]);
    expect(JSON.stringify(listed)).not.toContain("sk-ant");
    await pool.end();
  });

  it("permits only one active provider configuration per organization", async () => {
    const { pool, store } = await createStores();
    await store.configure({
      id: "primary", organizationId: "org-1", provider: "anthropic",
      model: "claude-sonnet-4-6", apiKey: "sk-ant-one",
      inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00", ...context,
    });
    await expect(store.configure({
      id: "secondary", organizationId: "org-1", provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6", apiKey: "sk-or-two",
      inputUsdPerMillion: "3.30", outputUsdPerMillion: "16.50",
      ...context, causationId: "request:second-config",
    })).rejects.toThrow("PROVIDER_CONFIGURATION_ID_CONFLICT");
    expect(await store.list("org-1")).toHaveLength(1);
    await pool.end();
  });

  it("rejects stored key-id and ciphertext-envelope mismatch", async () => {
    const { pool, store } = await createStores();
    await store.configure({
      id: "primary", organizationId: "org-1", provider: "anthropic",
      model: "claude-sonnet-4-6", apiKey: "sk-ant-integrity",
      inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00", ...context,
    });
    await pool.query(
      "UPDATE provider_configurations SET encryption_key_id = 'v2' WHERE organization_id = 'org-1'",
    );
    await expect(store.resolve("org-1")).rejects.toThrow("PROVIDER_CREDENTIAL_DECRYPT_FAILED");
    await pool.end();
  });

  it("does not resolve another tenant's configuration", async () => {
    const { pool, store } = await createStores();
    await store.configure({
      id: "primary", organizationId: "org-1", provider: "anthropic",
      model: "claude-sonnet-4-6", apiKey: "sk-ant-one",
      inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00", ...context,
    });

    await expect(store.resolve("org-2")).rejects.toThrow("PROVIDER_CONFIGURATION_NOT_FOUND");
    await pool.end();
  });
});
