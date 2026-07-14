import { randomUUID } from "node:crypto";
import { createPostgresPool } from "../src/persistence/postgres.js";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { API_CAPABILITIES, createServiceAccountCredential } from "../src/identity/apiCredentials.js";

const env = process.env;

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const databaseUrl = required("DATABASE_URL");
const organizationId = required("FUSE_BOOTSTRAP_ORG_ID");
const organizationName = required("FUSE_BOOTSTRAP_ORG_NAME");
const serviceAccountId = required("FUSE_BOOTSTRAP_SERVICE_ACCOUNT_ID");
const serviceAccountName = required("FUSE_BOOTSTRAP_SERVICE_ACCOUNT_NAME");
const now = new Date().toISOString();
const defaultExpiry = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
const requestId = `bootstrap:${randomUUID()}`;
const pool = createPostgresPool(databaseUrl);
const store = new IdentityStore(pool);

try {
  const issued = createServiceAccountCredential({
    id: randomUUID(),
    organizationId,
    serviceAccountId,
    name: "bootstrap administration",
    capabilities: API_CAPABILITIES,
    createdAt: now,
    expiresAt: env["FUSE_BOOTSTRAP_EXPIRES_AT"]?.trim() || defaultExpiry,
  });
  await store.bootstrapServiceAccount({
    organizationId,
    organizationName,
    serviceAccountId,
    serviceAccountName,
    credential: issued.record,
    actorId: "system:bootstrap",
    causationId: requestId,
    occurredAt: now,
  });
  process.stdout.write(`${JSON.stringify({
    organizationId,
    serviceAccountId,
    credentialId: issued.record.id,
    token: issued.token,
    tokenPrefix: issued.record.tokenPrefix,
    capabilities: issued.record.capabilities,
    expiresAt: issued.record.expiresAt,
    warning: "Store this token now. Fuse persists only its digest and cannot display it again.",
  }, null, 2)}\n`);
} finally {
  await pool.end();
}
