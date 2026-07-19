import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ProviderName } from "../persistence/providerConfigStore.js";

export interface ProviderCredentialContext {
  organizationId: string;
  provider: ProviderName;
  credentialVersion: number;
}

export interface ProviderCredentialKeyRing {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

function aad(context: ProviderCredentialContext, keyId: string): Buffer {
  if (!context.organizationId.trim()
    || !(["anthropic", "openrouter"] as const).includes(context.provider)
    || !Number.isSafeInteger(context.credentialVersion) || context.credentialVersion < 1
    || !/^[a-z0-9_-]{1,32}$/.test(keyId)) {
    throw new Error("PROVIDER_CREDENTIAL_CONTEXT_INVALID");
  }
  return Buffer.from([
    "fuse-provider-credential", "v1", context.organizationId, context.provider,
    String(context.credentialVersion), keyId,
  ].join(":"), "utf8");
}

function parseKey(value: string): Buffer {
  try {
    if (!value.trim() || !/^[A-Za-z0-9+/_=-]+$/.test(value)) throw new Error("invalid encoding");
    const key = Buffer.from(value, value.includes("-") || value.includes("_") ? "base64url" : "base64");
    if (key.length !== 32) throw new Error("invalid length");
    return key;
  } catch {
    throw new Error("PROVIDER_CREDENTIAL_KEY_INVALID");
  }
}

export function providerCredentialKeyRingFromEnv(env: NodeJS.ProcessEnv): ProviderCredentialKeyRing {
  const activeKeyId = env["FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID"]?.trim().toLowerCase();
  if (!activeKeyId || !/^[a-z0-9_-]{1,32}$/.test(activeKeyId)) {
    throw new Error("PROVIDER_CREDENTIAL_ACTIVE_KEY_ID_INVALID");
  }
  const keys = new Map<string, Buffer>();
  const prefix = "FUSE_PROVIDER_CREDENTIAL_KEY_";
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix) || !value?.trim()) continue;
    const keyId = name.slice(prefix.length).toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(keyId)) throw new Error("PROVIDER_CREDENTIAL_KEY_ID_INVALID");
    keys.set(keyId, parseKey(value));
  }
  if (!keys.has(activeKeyId)) throw new Error("PROVIDER_CREDENTIAL_ACTIVE_KEY_MISSING");
  return { activeKeyId, keys };
}

export function encryptProviderSecret(
  secret: string,
  keyRing: ProviderCredentialKeyRing,
  context: ProviderCredentialContext,
  entropy: (size: number) => Buffer = randomBytes,
): string {
  if (!secret.trim()) throw new Error("PROVIDER_CREDENTIAL_SECRET_REQUIRED");
  const keyId = keyRing.activeKeyId;
  const key = keyRing.keys.get(keyId);
  if (!key || key.length !== 32) throw new Error("PROVIDER_CREDENTIAL_ACTIVE_KEY_MISSING");
  const iv = entropy(12);
  if (iv.length !== 12) throw new Error("PROVIDER_CREDENTIAL_NONCE_INVALID");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context, keyId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1", keyId, iv.toString("base64url"), tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptProviderSecret(
  envelope: string,
  keyRing: ProviderCredentialKeyRing,
  context: ProviderCredentialContext,
): string {
  try {
    const [version, keyId, ivValue, tagValue, ciphertextValue, extra] = envelope.split(".");
    if (version !== "v1" || !keyId || !ivValue || !tagValue || !ciphertextValue || extra !== undefined) {
      throw new Error("invalid envelope");
    }
    const key = keyRing.keys.get(keyId);
    if (!key || key.length !== 32) throw new Error("missing key");
    const iv = Buffer.from(ivValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    const ciphertext = Buffer.from(ciphertextValue, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(context, keyId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("PROVIDER_CREDENTIAL_DECRYPT_FAILED");
  }
}
