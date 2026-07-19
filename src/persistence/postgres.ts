import { Pool, type PoolConfig } from "pg";
import type { FuseServiceState } from "../core/service.js";
import {
  deserializeState,
  serializeState,
  type PersistedReceipt,
  type ServiceStateStore,
} from "./store.js";

export function createPostgresPool(connectionString: string): Pool {
  const parsed = new URL(connectionString);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (!isLocal) parsed.searchParams.set("sslmode", "verify-full");
  const config: PoolConfig = {
    connectionString: parsed.toString(),
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: isLocal ? false : { rejectUnauthorized: true },
  };
  return new Pool(config);
}

export class PostgresStateStore implements ServiceStateStore {
  readonly kind = "postgres" as const;
  private initialized?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly mandateId = "demo-mandate",
  ) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresStateStore(createPostgresPool(connectionString));
  }

  private ensureSchema() {
    this.initialized ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS fuse_service_state (
        mandate_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS fuse_receipts (
        request_id TEXT PRIMARY KEY,
        mandate_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        sequence BIGSERIAL UNIQUE,
        receipt_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).then(() => undefined);
    return this.initialized;
  }

  async read(initial: () => FuseServiceState): Promise<FuseServiceState> {
    await this.ensureSchema();
    const initialJson = serializeState(initial());
    await this.pool.query(
      `INSERT INTO fuse_service_state (mandate_id, state_json)
       VALUES ($1, $2) ON CONFLICT (mandate_id) DO NOTHING`,
      [this.mandateId, initialJson],
    );
    const result = await this.pool.query<{ state_json: string }>(
      "SELECT state_json FROM fuse_service_state WHERE mandate_id = $1",
      [this.mandateId],
    );
    if (!result.rows[0]) throw new Error("PERSISTED_STATE_NOT_FOUND");
    return deserializeState(result.rows[0].state_json);
  }

  async listReceipts(): Promise<PersistedReceipt[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{ receipt_json: PersistedReceipt }>(
      `SELECT receipt_json
       FROM fuse_receipts
       WHERE mandate_id = $1
       ORDER BY sequence`,
      [this.mandateId],
    );
    return result.rows.map(({ receipt_json }) => receipt_json);
  }

  async mutate<T>(initial: () => FuseServiceState, operation: (state: FuseServiceState) => Promise<{
    state: FuseServiceState;
    result: T;
  }>): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO fuse_service_state (mandate_id, state_json)
         VALUES ($1, $2) ON CONFLICT (mandate_id) DO NOTHING`,
        [this.mandateId, serializeState(initial())],
      );
      const locked = await client.query<{ state_json: string }>(
        "SELECT state_json FROM fuse_service_state WHERE mandate_id = $1 FOR UPDATE",
        [this.mandateId],
      );
      if (!locked.rows[0]) throw new Error("PERSISTED_STATE_NOT_FOUND");
      const completed = await operation(deserializeState(locked.rows[0].state_json));
      await client.query(
        `UPDATE fuse_service_state
         SET state_json = $2, version = version + 1, updated_at = now()
         WHERE mandate_id = $1`,
        [this.mandateId, serializeState(completed.state)],
      );

      const receipt = extractNewReceipt(completed.state);
      if (receipt) {
        await client.query(
          `INSERT INTO fuse_receipts (request_id, mandate_id, child_id, receipt_json)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (request_id) DO NOTHING`,
          [receipt.requestId, this.mandateId, receipt.childId, JSON.stringify(receipt)],
        );
      }
      await client.query("COMMIT");
      return completed.result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function extractNewReceipt(state: FuseServiceState) {
  const released = state.pending
    .map(([, pending]) => pending.released?.receipt)
    .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt));
  return released.at(-1);
}
