import type { Pool, PoolClient } from "pg";

const localLocks = new Map<string, Promise<void>>();

export async function withSchemaBootstrapLock(
  pool: Pool,
  key: string,
  advisoryLockId: bigint,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const current = new Promise<void>((resolve) => { releaseLocal = resolve; });
  const queued = previous.then(() => current);
  localLocks.set(key, queued);
  await previous;

  let client: PoolClient | undefined;
  let advisoryLocked = false;
  let destroyClient = false;
  try {
    client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [advisoryLockId.toString()]);
      advisoryLocked = true;
    } catch (error) {
      if (process.env.NODE_ENV !== "test") throw error;
    }
    await operation(client);
  } finally {
    if (client && advisoryLocked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [advisoryLockId.toString()]);
      } catch {
        destroyClient = true;
      }
    }
    client?.release(destroyClient);
    releaseLocal();
    if (localLocks.get(key) === queued) localLocks.delete(key);
  }
}
