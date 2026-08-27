import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ProviderCredentialKeyRing } from "../providers/providerCredentials.js";

const VERSION = "v1";

export function sealSecretDelivery(value: unknown, keyRing: ProviderCredentialKeyRing, context: string): string {
  const keyId = keyRing.activeKeyId;
  const key = keyRing.keys.get(keyId);
  if (!key || key.length !== 32) throw new Error("SECRET_DELIVERY_KEY_INVALID");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [VERSION, keyId, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function openSecretDelivery<T>(envelope: string, keyRing: ProviderCredentialKeyRing, context: string): T {
  const [version, keyId, nonceText, tagText, ciphertextText, extra] = envelope.split(".");
  if (version !== VERSION || !keyId || !nonceText || !tagText || !ciphertextText || extra !== undefined) {
    throw new Error("SECRET_DELIVERY_ENVELOPE_INVALID");
  }
  try {
    const key = keyRing.keys.get(keyId);
    if (!key || key.length !== 32) throw new Error("missing key");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceText, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as T;
  } catch {
    throw new Error("SECRET_DELIVERY_DECRYPT_FAILED");
  }
}
