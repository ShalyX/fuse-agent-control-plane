import { Pool } from "pg";
import { PolicyStore } from "../src/persistence/policyStore.js";

const databaseUrl = process.env["DATABASE_URL_UNPOOLED"] ?? process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL_UNPOOLED_REQUIRED");
if (new URL(databaseUrl).hostname.includes("-pooler.")) {
  throw new Error("DATABASE_URL_UNPOOLED_REQUIRED");
}

const limitRaw = process.env["FUSE_SHADOW_RETRY_LIMIT"] ?? "20";
const limit = Number(limitRaw);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
  throw new Error("SHADOW_RETRY_LIMIT_INVALID");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const store = new PolicyStore(pool);
  const before = await store.shadowQueueStatus();
  const completedThisRun = await store.retryPendingShadowEvaluations(limit);
  const after = await store.shadowQueueStatus();
  process.stdout.write(`${JSON.stringify({ before, completedThisRun, after })}\n`);
} finally {
  await pool.end();
}
