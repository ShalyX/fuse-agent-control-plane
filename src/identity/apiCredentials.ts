import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const API_CAPABILITIES = [
  "inference:invoke",
  "mandates:read",
  "mandates:write",
  "receipts:read",
  "credentials:issue",
  "credentials:revoke",
  "agents:write",
] as const;

export type ApiCapability = typeof API_CAPABILITIES[number];
export type ServiceAccountRole = "admin" | "operator" | "viewer";

const SERVICE_ACCOUNT_ROLE_CAPABILITIES: Record<ServiceAccountRole, readonly ApiCapability[]> = {
  admin: API_CAPABILITIES,
  operator: ["inference:invoke", "mandates:read", "mandates:write", "receipts:read"],
  viewer: ["mandates:read", "receipts:read"],
};

export function serviceAccountRoleAllowsCapabilities(
  role: ServiceAccountRole,
  capabilities: readonly ApiCapability[],
): boolean {
  const allowed = new Set(SERVICE_ACCOUNT_ROLE_CAPABILITIES[role]);
  return capabilities.every((capability) => allowed.has(capability));
}

export interface ApiCredentialRecord {
  id: string;
  organizationId: string;
  agentId: string;
  name: string;
  capabilities: ApiCapability[];
  tokenPrefix: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreateApiCredentialInput {
  id: string;
  organizationId: string;
  agentId: string;
  name: string;
  capabilities: readonly ApiCapability[];
  createdAt: string;
  expiresAt?: string | null;
}

export interface ServiceAccountCredentialRecord {
  id: string;
  organizationId: string;
  serviceAccountId: string;
  name: string;
  capabilities: ApiCapability[];
  tokenPrefix: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreateServiceAccountCredentialInput {
  id: string;
  organizationId: string;
  serviceAccountId: string;
  name: string;
  capabilities: readonly ApiCapability[];
  createdAt: string;
  expiresAt?: string | null;
}

const allowedCapabilities = new Set<string>(API_CAPABILITIES);

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenMatchesHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApiCredential(
  input: CreateApiCredentialInput,
  entropy: (size: number) => Buffer = randomBytes,
): { token: string; record: ApiCredentialRecord } {
  if (!input.id.trim()) throw new Error("API_CREDENTIAL_ID_REQUIRED");
  if (!input.organizationId.trim()) throw new Error("API_CREDENTIAL_ORGANIZATION_REQUIRED");
  if (!input.agentId.trim()) throw new Error("API_CREDENTIAL_AGENT_REQUIRED");
  if (!input.name.trim()) throw new Error("API_CREDENTIAL_NAME_REQUIRED");
  if (Number.isNaN(Date.parse(input.createdAt))) throw new Error("API_CREDENTIAL_CREATED_AT_INVALID");
  if (input.capabilities.length === 0 || input.capabilities.some((item) => !allowedCapabilities.has(item))) {
    throw new Error("API_CREDENTIAL_CAPABILITY_INVALID");
  }
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (
    Number.isNaN(Date.parse(expiresAt))
    || Date.parse(expiresAt) <= Date.parse(input.createdAt)
  )) {
    throw new Error("API_CREDENTIAL_EXPIRY_INVALID");
  }

  const secret = entropy(32);
  if (secret.length < 32) throw new Error("API_CREDENTIAL_ENTROPY_INSUFFICIENT");
  const token = `fuse_sk_${secret.toString("base64url")}`;
  const capabilities = [...new Set(input.capabilities)];

  return {
    token,
    record: {
      ...input,
      capabilities,
      expiresAt,
      tokenPrefix: token.slice(0, 20),
      tokenHash: hashApiToken(token),
      revokedAt: null,
    },
  };
}

export function createServiceAccountCredential(
  input: CreateServiceAccountCredentialInput,
  entropy: (size: number) => Buffer = randomBytes,
): { token: string; record: ServiceAccountCredentialRecord } {
  if (!input.id.trim()) throw new Error("SERVICE_CREDENTIAL_ID_REQUIRED");
  if (!input.organizationId.trim()) throw new Error("SERVICE_CREDENTIAL_ORGANIZATION_REQUIRED");
  if (!input.serviceAccountId.trim()) throw new Error("SERVICE_CREDENTIAL_ACCOUNT_REQUIRED");
  if (!input.name.trim()) throw new Error("SERVICE_CREDENTIAL_NAME_REQUIRED");
  const createdAt = Date.parse(input.createdAt);
  if (Number.isNaN(createdAt)) throw new Error("SERVICE_CREDENTIAL_CREATED_AT_INVALID");
  if (input.capabilities.length === 0 || input.capabilities.some((item) => !allowedCapabilities.has(item))) {
    throw new Error("SERVICE_CREDENTIAL_CAPABILITY_INVALID");
  }
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= createdAt)) {
    throw new Error("SERVICE_CREDENTIAL_EXPIRY_INVALID");
  }
  const secret = entropy(32);
  if (secret.length < 32) throw new Error("SERVICE_CREDENTIAL_ENTROPY_INSUFFICIENT");
  const token = `fuse_sk_${secret.toString("base64url")}`;
  return {
    token,
    record: {
      ...input,
      capabilities: [...new Set(input.capabilities)],
      expiresAt,
      tokenPrefix: token.slice(0, 20),
      tokenHash: hashApiToken(token),
      revokedAt: null,
    },
  };
}
