import { describe, expect, it } from "vitest";
import {
  decryptProviderSecret,
  encryptProviderSecret,
  providerCredentialKeyRingFromEnv,
  type ProviderCredentialKeyRing,
} from "../src/providers/providerCredentials.js";

const v1Key = Buffer.alloc(32, 7);
const v2Key = Buffer.alloc(32, 8);
const v1Ring: ProviderCredentialKeyRing = {
  activeKeyId: "v1",
  keys: new Map([["v1", v1Key]]),
};
const context = {
  organizationId: "org-1",
  provider: "anthropic" as const,
  credentialVersion: 1,
};

describe("provider credential encryption", () => {
  it("encrypts a provider secret with tenant, provider, version, and key identity bound", () => {
    const encrypted = encryptProviderSecret(
      "sk-ant-customer-zero",
      v1Ring,
      context,
      () => Buffer.alloc(12, 3),
    );

    expect(encrypted).toMatch(/^v1\.v1\./);
    expect(encrypted).not.toContain("sk-ant-customer-zero");
    expect(decryptProviderSecret(encrypted, v1Ring, context)).toBe("sk-ant-customer-zero");
  });

  it("rejects ciphertext substitution across tenants, providers, or credential versions", () => {
    const encrypted = encryptProviderSecret(
      "sk-ant-customer-zero", v1Ring, context, () => Buffer.alloc(12, 4),
    );

    expect(() => decryptProviderSecret(encrypted, v1Ring, { ...context, organizationId: "org-2" }))
      .toThrow("PROVIDER_CREDENTIAL_DECRYPT_FAILED");
    expect(() => decryptProviderSecret(encrypted, v1Ring, { ...context, provider: "openrouter" }))
      .toThrow("PROVIDER_CREDENTIAL_DECRYPT_FAILED");
    expect(() => decryptProviderSecret(encrypted, v1Ring, { ...context, credentialVersion: 2 }))
      .toThrow("PROVIDER_CREDENTIAL_DECRYPT_FAILED");
  });

  it("reads old ciphertext from a key ring while new writes use the active key", () => {
    const encryptedV1 = encryptProviderSecret(
      "sk-ant-old", v1Ring, context, () => Buffer.alloc(12, 5),
    );
    const rotatingRing: ProviderCredentialKeyRing = {
      activeKeyId: "v2",
      keys: new Map([["v1", v1Key], ["v2", v2Key]]),
    };
    const encryptedV2 = encryptProviderSecret(
      "sk-ant-new", rotatingRing, { ...context, credentialVersion: 2 }, () => Buffer.alloc(12, 6),
    );

    expect(decryptProviderSecret(encryptedV1, rotatingRing, context)).toBe("sk-ant-old");
    expect(encryptedV2).toMatch(/^v1\.v2\./);
    expect(decryptProviderSecret(
      encryptedV2, rotatingRing, { ...context, credentialVersion: 2 },
    )).toBe("sk-ant-new");
  });

  it("requires an active 32-byte deployment key", () => {
    expect(providerCredentialKeyRingFromEnv({
      FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID: "v1",
      FUSE_PROVIDER_CREDENTIAL_KEY_V1: v1Key.toString("base64"),
    })).toMatchObject({ activeKeyId: "v1" });
    expect(() => providerCredentialKeyRingFromEnv({
      FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID: "v1",
      FUSE_PROVIDER_CREDENTIAL_KEY_V1: Buffer.alloc(16).toString("base64"),
    })).toThrow("PROVIDER_CREDENTIAL_KEY_INVALID");
    expect(() => providerCredentialKeyRingFromEnv({
      FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID: "v2",
      FUSE_PROVIDER_CREDENTIAL_KEY_V1: v1Key.toString("base64"),
    })).toThrow("PROVIDER_CREDENTIAL_ACTIVE_KEY_MISSING");
  });
});
