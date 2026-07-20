import { createPostgresPool } from "../src/persistence/postgres.js";
import { ProviderConfigStore } from "../src/persistence/providerConfigStore.js";
import { providerCredentialKeyRingFromEnv } from "../src/providers/providerCredentials.js";

const databaseUrl = (process.env["DATABASE_URL_UNPOOLED"]
  ?? process.env["DATABASE_URL"])?.trim();
if (!databaseUrl || new URL(databaseUrl).hostname.includes("-pooler.")) {
  throw new Error("DATABASE_URL_UNPOOLED_REQUIRED");
}

const pool = createPostgresPool(databaseUrl);
try {
  const store = new ProviderConfigStore(pool, providerCredentialKeyRingFromEnv(process.env));
  await store.ensureSchema();
  console.log(JSON.stringify({ ok: true, migration: "provider-config-v1" }));
} finally {
  await pool.end();
}
