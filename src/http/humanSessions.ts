import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export type HumanSessionRole = "owner" | "member" | "viewer";
export type HumanSessionSourceCredentialType = "agent" | "service_account";

export interface HumanSessionRecord {
  id: string;
  workspaceId: string;
  userId: string;
  sourceCredentialId: string;
  sourceCredentialType: HumanSessionSourceCredentialType;
  role: HumanSessionRole;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CreateHumanSessionInput {
  workspaceId: string;
  userId: string;
  sourceCredentialId: string;
  sourceCredentialType?: HumanSessionSourceCredentialType;
  role: HumanSessionRole;
  createdAt: string;
  expiresAt: string;
}

export interface ResolvedHumanSession {
  workspaceId: string;
  userId: string;
  sourceCredentialId: string;
  sourceCredentialType: HumanSessionSourceCredentialType;
  role: HumanSessionRole;
  sessionId: string;
  expiresAt: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function matchesToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateInput(input: CreateHumanSessionInput): void {
  if (!input.workspaceId.trim()) throw new Error("HUMAN_SESSION_WORKSPACE_REQUIRED");
  if (!input.userId.trim()) throw new Error("HUMAN_SESSION_USER_REQUIRED");
  if (!input.sourceCredentialId.trim()) throw new Error("HUMAN_SESSION_SOURCE_CREDENTIAL_REQUIRED");
  if (Number.isNaN(Date.parse(input.createdAt)) || Number.isNaN(Date.parse(input.expiresAt))) {
    throw new Error("HUMAN_SESSION_TIME_INVALID");
  }
  if (Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) {
    throw new Error("HUMAN_SESSION_EXPIRY_INVALID");
  }
}

export function createHumanSession(
  input: CreateHumanSessionInput,
  entropy: (size: number) => Buffer = randomBytes,
): { token: string; record: HumanSessionRecord } {
  validateInput(input);
  const secret = entropy(32);
  if (secret.length < 32) throw new Error("HUMAN_SESSION_ENTROPY_INSUFFICIENT");
  const token = `fuse_hs_${secret.toString("base64url")}`;
  return {
    token,
    record: {
      id: `hs_${hashToken(token).slice(0, 24)}`,
      workspaceId: input.workspaceId.trim(),
      userId: input.userId.trim(),
      sourceCredentialId: input.sourceCredentialId.trim(),
      sourceCredentialType: input.sourceCredentialType ?? "service_account",
      role: input.role,
      tokenHash: hashToken(token),
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
    },
  };
}

export interface HumanSessionStore {
  put(record: HumanSessionRecord): Promise<void>;
  resolve(token: string, now: string): Promise<ResolvedHumanSession | null>;
  resolveForWorkspace(token: string, workspaceId: string, now: string): Promise<ResolvedHumanSession | null>;
  revoke(token: string, revokedAt: string): Promise<void>;
  revokeById?(sessionId: string, workspaceId: string, revokedAt: string): Promise<boolean>;
}

export class MemoryHumanSessionStore implements HumanSessionStore {
  private readonly records = new Map<string, HumanSessionRecord>();

  async put(record: HumanSessionRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async resolve(token: string, now: string): Promise<ResolvedHumanSession | null> {
    for (const record of this.records.values()) {
      if (!matchesToken(token, record.tokenHash)) continue;
      if (record.revokedAt || Date.parse(now) >= Date.parse(record.expiresAt)) return null;
      return {
        workspaceId: record.workspaceId,
        userId: record.userId,
        sourceCredentialId: record.sourceCredentialId,
        sourceCredentialType: record.sourceCredentialType,
        role: record.role,
        sessionId: record.id,
        expiresAt: record.expiresAt,
      };
    }
    return null;
  }

  async resolveForWorkspace(token: string, workspaceId: string, now: string): Promise<ResolvedHumanSession | null> {
    const session = await this.resolve(token, now);
    return session?.workspaceId === workspaceId ? session : null;
  }

  async revoke(token: string, revokedAt: string): Promise<void> {
    for (const [id, record] of this.records.entries()) {
      if (matchesToken(token, record.tokenHash)) {
        this.records.set(id, { ...record, revokedAt });
        return;
      }
    }
  }

  async revokeById(sessionId: string, workspaceId: string, revokedAt: string): Promise<boolean> {
    const record = this.records.get(sessionId);
    if (!record || record.workspaceId !== workspaceId || record.revokedAt) return false;
    this.records.set(sessionId, { ...record, revokedAt });
    return true;
  }
}

export class PostgresHumanSessionStore implements HumanSessionStore {
  private initialized?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  private ensureSchema(): Promise<void> {
    this.initialized ??= (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('fuse-human-sessions'))");
        await client.query(`
          CREATE TABLE IF NOT EXISTS human_sessions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            source_credential_id TEXT,
            source_credential_type TEXT NOT NULL DEFAULT 'service_account'
              CHECK (source_credential_type IN ('agent', 'service_account')),
            role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
            token_hash TEXT NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS human_sessions_workspace_idx
            ON human_sessions (workspace_id);
          ALTER TABLE human_sessions ADD COLUMN IF NOT EXISTS source_credential_id TEXT;
          ALTER TABLE human_sessions ADD COLUMN IF NOT EXISTS source_credential_type TEXT NOT NULL DEFAULT 'service_account';
          CREATE TABLE IF NOT EXISTS audit_events (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            causation_id TEXT NOT NULL,
            occurred_at TIMESTAMPTZ NOT NULL,
            payload JSONB NOT NULL
          );
        `);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  async put(record: HumanSessionRecord): Promise<void> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO human_sessions
         (id, workspace_id, user_id, source_credential_id, source_credential_type, role, token_hash, created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           workspace_id = EXCLUDED.workspace_id,
           user_id = EXCLUDED.user_id,
           source_credential_id = EXCLUDED.source_credential_id,
           source_credential_type = EXCLUDED.source_credential_type,
           role = EXCLUDED.role,
           token_hash = EXCLUDED.token_hash,
           created_at = EXCLUDED.created_at,
           expires_at = EXCLUDED.expires_at,
           revoked_at = EXCLUDED.revoked_at`,
        [record.id, record.workspaceId, record.userId, record.sourceCredentialId, record.sourceCredentialType,
          record.role, record.tokenHash, record.createdAt, record.expiresAt, record.revokedAt],
      );
      await client.query(
        `INSERT INTO audit_events
         (id, organization_id, entity_type, entity_id, action, actor_id, causation_id, occurred_at, payload)
         VALUES ($1, $2, 'human_session', $3, 'human_session.created', $4, $3, $5, $6::jsonb)`,
        [randomUUID(), record.workspaceId, record.id, `credential:${record.sourceCredentialId}`, record.createdAt,
          JSON.stringify({ userId: record.userId, role: record.role, expiresAt: record.expiresAt })],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolve(token: string, now: string): Promise<ResolvedHumanSession | null> {
    await this.ensureSchema();
    const result = await this.pool.query<HumanSessionRecord>(
      `SELECT workspace_id AS "workspaceId", user_id AS "userId",
              source_credential_id AS "sourceCredentialId",
              source_credential_type AS "sourceCredentialType", role,
              id, expires_at AS "expiresAt", revoked_at AS "revokedAt", token_hash AS "tokenHash"
       FROM human_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [hashToken(token), now],
    );
    const record = result.rows[0];
    if (!record?.sourceCredentialId || !matchesToken(token, record.tokenHash)) return null;
    return {
      workspaceId: record.workspaceId,
      userId: record.userId,
      sourceCredentialId: record.sourceCredentialId,
      sourceCredentialType: record.sourceCredentialType,
      role: record.role,
      sessionId: record.id,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  async resolveForWorkspace(token: string, workspaceId: string, now: string): Promise<ResolvedHumanSession | null> {
    const session = await this.resolve(token, now);
    return session?.workspaceId === workspaceId ? session : null;
  }

  async revoke(token: string, revokedAt: string): Promise<void> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const revoked = await client.query<{ id: string; workspace_id: string }>(
        `UPDATE human_sessions SET revoked_at = $2
          WHERE token_hash = $1 AND revoked_at IS NULL
          RETURNING id, workspace_id`,
        [hashToken(token), revokedAt],
      );
      const record = revoked.rows[0];
      if (record) {
        await client.query(
          `INSERT INTO audit_events
           (id, organization_id, entity_type, entity_id, action, actor_id, causation_id, occurred_at, payload)
           VALUES ($1, $2, 'human_session', $3, 'human_session.revoked', $4, $3, $5, '{}'::jsonb)`,
          [randomUUID(), record.workspace_id, record.id, `session:${record.id}`, revokedAt],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeById(sessionId: string, workspaceId: string, revokedAt: string): Promise<boolean> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const revoked = await client.query<{ id: string; workspace_id: string }>(
        `UPDATE human_sessions SET revoked_at = $3
          WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
          RETURNING id, workspace_id`,
        [sessionId, workspaceId, revokedAt],
      );
      const record = revoked.rows[0];
      if (!record) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `INSERT INTO audit_events
         (id, organization_id, entity_type, entity_id, action, actor_id, causation_id, occurred_at, payload)
         VALUES ($1, $2, 'human_session', $3, 'human_session.revoked', $4, $3, $5, '{}'::jsonb)`,
        [randomUUID(), workspaceId, record.id, `admin:${workspaceId}`, revokedAt],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
