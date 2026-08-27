import type { Pool } from "pg";
import type { SandboxRun } from "./sandboxRuns.js";

export interface SandboxRunStore {
  get(workspaceId: string, runId: string): Promise<SandboxRun | null>;
  put(run: SandboxRun): Promise<void>;
  readiness?(): Promise<boolean>;
}

export class MemorySandboxRunStore implements SandboxRunStore {
  private readonly runs = new Map<string, SandboxRun>();

  async get(workspaceId: string, runId: string): Promise<SandboxRun | null> {
    const run = this.runs.get(runId);
    return run && run.workspaceId === workspaceId ? structuredClone(run) : null;
  }

  async put(run: SandboxRun): Promise<void> {
    this.runs.set(run.runId, structuredClone(run));
  }

  async readiness(): Promise<boolean> {
    return false;
  }
}

export class PostgresSandboxRunStore implements SandboxRunStore {
  private initialized?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  private ensureSchema(): Promise<void> {
    this.initialized ??= (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('fuse-product-sandbox-runs'))");
        await client.query(`
          CREATE TABLE IF NOT EXISTS fuse_product_sandbox_runs (
            run_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            run_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (workspace_id, run_id)
          );
          CREATE INDEX IF NOT EXISTS fuse_product_sandbox_runs_workspace_idx
            ON fuse_product_sandbox_runs (workspace_id, created_at DESC);
        `);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })();
    return this.initialized;
  }

  async get(workspaceId: string, runId: string): Promise<SandboxRun | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ run_json: SandboxRun }>(
      "SELECT run_json FROM fuse_product_sandbox_runs WHERE workspace_id = $1 AND run_id = $2",
      [workspaceId, runId],
    );
    return result.rows[0]?.run_json ? structuredClone(result.rows[0].run_json) : null;
  }

  async put(run: SandboxRun): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO fuse_product_sandbox_runs (run_id, workspace_id, run_json)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (run_id) DO NOTHING`,
      [run.runId, run.workspaceId, JSON.stringify(run)],
    );
  }

  async readiness(): Promise<boolean> {
    await this.ensureSchema();
    await this.pool.query("SELECT 1 FROM fuse_product_sandbox_runs LIMIT 0");
    return true;
  }
}
