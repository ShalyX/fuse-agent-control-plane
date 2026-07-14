import { expect, it } from "vitest";
import type { Pool } from "pg";
import { withSchemaBootstrapLock } from "../src/persistence/schemaBootstrap.js";

it("releases the local schema lock when acquiring a database connection fails", async () => {
  let attempts = 0;
  const client = {
    async query() { return { rows: [], rowCount: 1 }; },
    release() {},
  };
  const pool = {
    async connect() {
      attempts += 1;
      if (attempts === 1) throw new Error("CONNECTION_FAILED");
      return client;
    },
  } as unknown as Pool;

  await expect(withSchemaBootstrapLock(pool, "connection-recovery", 1n, async () => undefined))
    .rejects.toThrow("CONNECTION_FAILED");
  const recovered = withSchemaBootstrapLock(pool, "connection-recovery", 1n, async () => undefined);
  const completed = await Promise.race([
    recovered.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  expect(completed).toBe(true);
});
