import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { CustomerWorkspaceResult, WorkspaceCredentialRecoveryResult, WorkspaceOnboardingStore, WorkspaceRecoveryRecord } from "./customerOnboarding.js";
import { openSecretDelivery, sealSecretDelivery } from "./secretDelivery.js";
import type { ProviderCredentialKeyRing } from "../providers/providerCredentials.js";

export class PostgresWorkspaceOnboardingStore implements WorkspaceOnboardingStore {
  private schemaReady: Promise<void> | undefined;

  constructor(private readonly pool: Pool, private readonly deliveryKeyRing?: ProviderCredentialKeyRing) {}

  async readiness(): Promise<void> {
    await this.ensureSchema();
    if (!this.deliveryKeyRing) throw new Error("WORKSPACE_DELIVERY_KEY_UNAVAILABLE");
    const envelopes = await this.pool.query<{
      idempotency_key: string;
      identifiers: Record<string, string> | null;
      recovery_consumed_hash: string | null;
      recovery_delivery_id: string | null;
      delivery_envelope: string | null;
      recovery_delivery_envelope: string | null;
    }>(
      `SELECT idempotency_key, identifiers, recovery_consumed_hash, recovery_delivery_id,
              delivery_envelope, recovery_delivery_envelope
         FROM fuse_workspace_onboarding_operations
        WHERE delivery_envelope IS NOT NULL OR recovery_delivery_envelope IS NOT NULL`,
    );
    const authenticate = (envelope: string, context: string) => {
      const [version, keyId, nonce, tag, ciphertext, extra] = envelope.split(".");
      if (version !== "v1" || !keyId || !nonce || !tag || !ciphertext || extra !== undefined) {
        throw new Error("WORKSPACE_DELIVERY_ENVELOPE_UNREADABLE");
      }
      if (!this.deliveryKeyRing!.keys.has(keyId)) {
        throw new Error("WORKSPACE_DELIVERY_DECRYPTION_KEY_MISSING");
      }
      try {
        openSecretDelivery<unknown>(envelope, this.deliveryKeyRing!, context);
      } catch {
        throw new Error("WORKSPACE_DELIVERY_ENVELOPE_UNREADABLE");
      }
    };
    for (const row of envelopes.rows) {
      if (row.delivery_envelope) {
        authenticate(row.delivery_envelope, `workspace:${row.idempotency_key}`);
      }
      if (row.recovery_delivery_envelope) {
        const workspaceId = row.identifiers?.workspaceId;
        if (!workspaceId || !row.recovery_consumed_hash || !row.recovery_delivery_id) {
          throw new Error("WORKSPACE_DELIVERY_ENVELOPE_UNREADABLE");
        }
        authenticate(
          row.recovery_delivery_envelope,
          `recovery:${workspaceId}:${row.recovery_consumed_hash}:${row.recovery_delivery_id}`,
        );
      }
    }
  }

  async tryReserveCapacity(input: {
    idempotencyKey: string;
    maxActiveWorkspaces: number;
    baselineWorkspaceIds: readonly string[];
    now?: Date;
  }): Promise<boolean> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fuse-beta-capacity'))");
      await client.query(
        `DELETE FROM fuse_beta_capacity_reservations reservation
          WHERE reservation.reserved_at <= COALESCE($1::timestamptz, CURRENT_TIMESTAMP) - INTERVAL '15 minutes'
            AND NOT EXISTS (
              SELECT 1 FROM fuse_workspace_onboarding_operations operation
               WHERE operation.idempotency_key = reservation.idempotency_key
            )`,
        [input.now?.toISOString() ?? null],
      );
      const existing = await client.query(
        "SELECT 1 FROM fuse_beta_capacity_reservations WHERE idempotency_key = $1",
        [input.idempotencyKey],
      );
      if (existing.rowCount === 1) {
        await client.query("COMMIT");
        return true;
      }
      const active = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM (
           SELECT DISTINCT identifiers->>'workspaceId' AS workspace_id
             FROM fuse_workspace_onboarding_operations WHERE status = 'completed'
           UNION
           SELECT DISTINCT unnest($1::text[]) AS workspace_id
           UNION
           SELECT 'reservation:' || reservation.idempotency_key AS workspace_id
             FROM fuse_beta_capacity_reservations reservation
             LEFT JOIN fuse_workspace_onboarding_operations operation
               ON operation.idempotency_key = reservation.idempotency_key
            WHERE operation.idempotency_key IS NULL OR operation.status = 'in_progress'
         ) active_workspaces`,
        [[...input.baselineWorkspaceIds]],
      );
      if (Number(active.rows[0]?.count ?? input.maxActiveWorkspaces) >= input.maxActiveWorkspaces) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `INSERT INTO fuse_beta_capacity_reservations (idempotency_key, reserved_at)
         VALUES ($1, CURRENT_TIMESTAMP)`,
        [input.idempotencyKey],
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

  async readOperationalReadiness(now: Date, staleAfterMs: number): Promise<{
    staleOnboardingOperations: number;
    rollbackFailedOnboardingOperations: number;
    oldestInProgressAt: string | null;
    orphanCapacityReservations: number;
    oldestOrphanReservationAt: string | null;
  }> {
    await this.ensureSchema();
    const staleBefore = new Date(now.getTime() - staleAfterMs);
    const result = await this.pool.query<{ stale_count: string; rollback_failed_count: string; oldest_in_progress_at: Date | null }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'in_progress' AND updated_at <= $1)::text AS stale_count,
              COUNT(*) FILTER (WHERE status = 'failed')::text AS rollback_failed_count,
              MIN(updated_at) FILTER (WHERE status = 'in_progress') AS oldest_in_progress_at
         FROM fuse_workspace_onboarding_operations`,
      [staleBefore.toISOString()],
    );
    const row = result.rows[0];
    const orphanReservations = await this.pool.query<{
      orphan_count: string;
      oldest_orphan_at: Date | null;
    }>(
      `SELECT COUNT(*)::text AS orphan_count, MIN(reservation.reserved_at) AS oldest_orphan_at
         FROM fuse_beta_capacity_reservations reservation
         LEFT JOIN fuse_workspace_onboarding_operations operation
           ON operation.idempotency_key = reservation.idempotency_key
        WHERE operation.idempotency_key IS NULL`,
    );
    const orphanRow = orphanReservations.rows[0];
    return {
      staleOnboardingOperations: Number(row?.stale_count ?? 0),
      rollbackFailedOnboardingOperations: Number(row?.rollback_failed_count ?? 0),
      oldestInProgressAt: row?.oldest_in_progress_at
        ? new Date(row.oldest_in_progress_at).toISOString()
        : null,
      orphanCapacityReservations: Number(orphanRow?.orphan_count ?? 0),
      oldestOrphanReservationAt: orphanRow?.oldest_orphan_at
        ? new Date(orphanRow.oldest_orphan_at).toISOString()
        : null,
    };
  }

  async consumeInvite(input: {
    inviteToken: string;
    idempotencyKey: string;
    allowedInviteHashes: ReadonlySet<string>;
  }): Promise<boolean> {
    const inviteHash = createHash("sha256").update(input.inviteToken, "utf8").digest("hex");
    if (!input.allowedInviteHashes.has(inviteHash)) return false;
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ idempotency_key: string }>(
        `INSERT INTO fuse_beta_invite_redemptions (invite_hash, idempotency_key, consumed_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING
         RETURNING idempotency_key`,
        [inviteHash, input.idempotencyKey],
      );
      const redemption = inserted.rowCount === 1
        ? inserted
        : await client.query<{ idempotency_key: string }>(
            `SELECT idempotency_key
               FROM fuse_beta_invite_redemptions
              WHERE invite_hash = $1`,
            [inviteHash],
          );
      await client.query("COMMIT");
      return redemption.rows[0]?.idempotency_key === input.idempotencyKey;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(input: {
    idempotencyKey: string;
    fingerprint: string;
    recoveryCodeHash: string;
    identifiers: Record<string, string>;
    now?: Date;
    staleAfterMs?: number;
  }) {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO fuse_workspace_onboarding_operations
         (idempotency_key, request_fingerprint, recovery_code_hash, identifiers, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, 'in_progress', COALESCE($5::timestamptz, CURRENT_TIMESTAMP), COALESCE($5::timestamptz, CURRENT_TIMESTAMP))
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [input.idempotencyKey, input.fingerprint, input.recoveryCodeHash, JSON.stringify(input.identifiers), input.now?.toISOString() ?? null],
      );
      if (inserted.rowCount === 1) {
        await client.query("COMMIT");
        return { status: "new" as const };
      }
      const existing = await client.query<{ request_fingerprint: string; status: string; result_json: CustomerWorkspaceResult | null; delivery_envelope: string | null; identifiers: Record<string, string>; updated_at: Date }>(
        `SELECT request_fingerprint, status, result_json, delivery_envelope, identifiers, updated_at
           FROM fuse_workspace_onboarding_operations
          WHERE idempotency_key = $1
          FOR UPDATE`,
        [input.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row || row.request_fingerprint !== input.fingerprint) {
        await client.query("COMMIT");
        return { status: "conflict" as const };
      }
      if (row.status === "rolled_back") {
        await client.query(
          `UPDATE fuse_workspace_onboarding_operations
              SET recovery_code_hash = $2, identifiers = $3::jsonb, status = 'in_progress',
                  failure_code = NULL, completed_at = NULL
            WHERE idempotency_key = $1 AND status = 'rolled_back'`,
          [input.idempotencyKey, input.recoveryCodeHash, JSON.stringify(input.identifiers)],
        );
        await client.query("COMMIT");
        return { status: "new" as const };
      }
      const staleBefore = input.now && input.staleAfterMs !== undefined
        ? input.now.getTime() - input.staleAfterMs
        : null;
      if (row.status === "in_progress" && staleBefore !== null && row.updated_at.getTime() <= staleBefore) {
        const workspaceId = row.identifiers.workspaceId;
        if (!workspaceId) throw new Error("WORKSPACE_ROLLBACK_SCOPE_MISMATCH");
        const candidateTables = [
          "provider_verification_retries", "provider_configurations",
          "mandate_agent_assignments", "control_mandates", "policy_versions",
          "api_credentials", "agent_identities", "service_account_credentials", "service_accounts",
          "organization_memberships", "audit_events",
        ];
        const existingTablesResult = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
          [candidateTables],
        );
        const existingTables = new Set(existingTablesResult.rows.map((candidate) => candidate.table_name));
        for (const table of candidateTables) {
          if (existingTables.has(table)) await client.query(`DELETE FROM ${table} WHERE organization_id = $1`, [workspaceId]);
        }
        const organizations = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'organizations'`,
        );
        if (organizations.rowCount) await client.query("DELETE FROM organizations WHERE id = $1", [workspaceId]);
        await client.query(
          `UPDATE fuse_workspace_onboarding_operations
              SET recovery_code_hash = $2, identifiers = $3::jsonb, status = 'in_progress',
                  failure_code = NULL, completed_at = NULL, created_at = $4, updated_at = $4
            WHERE idempotency_key = $1 AND status = 'in_progress'`,
          [input.idempotencyKey, input.recoveryCodeHash, JSON.stringify(input.identifiers), input.now!.toISOString()],
        );
        await client.query("COMMIT");
        return { status: "new" as const };
      }
      await client.query("COMMIT");
      if (row.status === "completed") {
        const result = row.delivery_envelope && this.deliveryKeyRing
          ? openSecretDelivery<CustomerWorkspaceResult>(row.delivery_envelope, this.deliveryKeyRing, `workspace:${input.idempotencyKey}`)
          : row.result_json;
        return { status: "replay" as const, result };
      }
      return { status: "in_progress" as const };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(idempotencyKey: string, workspaceId: string, now: Date): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE fuse_workspace_onboarding_operations
          SET updated_at = $3
        WHERE idempotency_key = $1
          AND identifiers->>'workspaceId' = $2
          AND status = 'in_progress'`,
      [idempotencyKey, workspaceId, now.toISOString()],
    );
    if (result.rowCount !== 1) throw new Error("WORKSPACE_ONBOARDING_LEASE_LOST");
  }

  async complete(idempotencyKey: string, result: CustomerWorkspaceResult): Promise<void> {
    await this.ensureSchema();
    if (!this.deliveryKeyRing) throw new Error("WORKSPACE_DELIVERY_KEY_UNAVAILABLE");
    const deliveryEnvelope = sealSecretDelivery(result, this.deliveryKeyRing, `workspace:${idempotencyKey}`);
    const updated = await this.pool.query(
      `UPDATE fuse_workspace_onboarding_operations
          SET status = 'completed', result_json = $2::jsonb, delivery_envelope = $4,
              completed_at = CURRENT_TIMESTAMP
        WHERE idempotency_key = $1
          AND identifiers->>'workspaceId' = $3
          AND status = 'in_progress'`,
      [idempotencyKey, JSON.stringify({
        ...result,
        recoveryCode: null,
        adminCredential: { ...result.adminCredential, token: null },
        credential: { ...result.credential, token: null },
      }), result.workspaceId, deliveryEnvelope],
    );
    if (updated.rowCount !== 1) throw new Error("WORKSPACE_ONBOARDING_LEASE_LOST");
  }

  async rollback(idempotencyKey: string, workspaceId: string, code: string): Promise<void> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const operation = await client.query<{ workspace_id: string }>(
        `SELECT identifiers->>'workspaceId' AS workspace_id
           FROM fuse_workspace_onboarding_operations
          WHERE idempotency_key = $1 AND status = 'in_progress'
          FOR UPDATE`,
        [idempotencyKey],
      );
      if (operation.rows[0]?.workspace_id !== workspaceId) throw new Error("WORKSPACE_ROLLBACK_SCOPE_MISMATCH");
      const candidateTables = [
        "provider_verification_retries", "provider_configurations",
        "mandate_agent_assignments", "control_mandates", "policy_versions",
        "api_credentials", "agent_identities", "service_account_credentials", "service_accounts",
        "organization_memberships", "audit_events",
      ];
      const existing = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
        [candidateTables],
      );
      const existingTables = new Set(existing.rows.map((row) => row.table_name));
      for (const table of candidateTables) {
        if (existingTables.has(table)) await client.query(`DELETE FROM ${table} WHERE organization_id = $1`, [workspaceId]);
      }
      const organizations = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'organizations'`,
      );
      if (organizations.rowCount) await client.query("DELETE FROM organizations WHERE id = $1", [workspaceId]);
      await client.query(
        `UPDATE fuse_workspace_onboarding_operations
            SET status = 'rolled_back', failure_code = $2, completed_at = CURRENT_TIMESTAMP
          WHERE idempotency_key = $1 AND status = 'in_progress'`,
        [idempotencyKey, code.slice(0, 96)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordRollbackFailure(idempotencyKey: string, workspaceId: string, code: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE fuse_workspace_onboarding_operations
          SET status = 'failed', failure_code = $3, completed_at = CURRENT_TIMESTAMP
        WHERE idempotency_key = $1
          AND identifiers->>'workspaceId' = $2
          AND status = 'in_progress'`,
      [idempotencyKey, workspaceId, code.slice(0, 96)],
    );
  }

  async getRecovery(workspaceId: string, recoveryCodeHash: string, deliveryId: string): Promise<WorkspaceRecoveryRecord | null> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ identifiers: Record<string, string>; result_json: CustomerWorkspaceResult; recovery_code_hash: string | null; recovery_delivery_envelope: string | null }>(
        `SELECT identifiers, result_json, recovery_code_hash, recovery_delivery_envelope
           FROM fuse_workspace_onboarding_operations
          WHERE identifiers->>'workspaceId' = $1
            AND status = 'completed'
            AND (recovery_code_hash = $2 OR (recovery_consumed_hash = $2 AND recovery_delivery_id = $3))
          FOR UPDATE`,
        [workspaceId, recoveryCodeHash, deliveryId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      if (row.recovery_delivery_envelope) {
        if (!this.deliveryKeyRing) throw new Error("WORKSPACE_DELIVERY_KEY_UNAVAILABLE");
        const deliveryResult = openSecretDelivery<WorkspaceCredentialRecoveryResult>(
          row.recovery_delivery_envelope, this.deliveryKeyRing,
          `recovery:${workspaceId}:${recoveryCodeHash}:${deliveryId}`,
        );
        await client.query("COMMIT");
        return { deliveryResult };
      }
      if (!row.recovery_code_hash) {
        await client.query("COMMIT");
        return null;
      }
      await client.query("COMMIT");
      return {
        workspaceId,
        serviceAccountId: row.identifiers.serviceAccountId,
        serviceCredentialId: row.identifiers.serviceCredentialId,
        agentId: row.identifiers.agentId,
        agentCredentialId: row.identifiers.agentCredentialId,
        expiresAt: row.result_json?.credential?.expiresAt ?? null,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  sealRecoveryResult(result: WorkspaceCredentialRecoveryResult, recoveryCodeHash: string, deliveryId: string): string {
    if (!this.deliveryKeyRing) throw new Error("WORKSPACE_DELIVERY_KEY_UNAVAILABLE");
    return sealSecretDelivery(
      result, this.deliveryKeyRing, `recovery:${result.workspaceId}:${recoveryCodeHash}:${deliveryId}`,
    );
  }

  async listCompletedWorkspaceIds(): Promise<string[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{ workspace_id: string }>(
      `SELECT identifiers->>'workspaceId' AS workspace_id
         FROM fuse_workspace_onboarding_operations
        WHERE status = 'completed' AND identifiers->>'workspaceId' IS NOT NULL`,
    );
    return result.rows.map((row) => row.workspace_id);
  }

  async consumeRateLimit(input: { key: string; maxPerMinute: number; now?: Date }): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    await this.ensureSchema();
    const result = await this.pool.query<{ count: number; window_started_at: Date }>(
      `INSERT INTO fuse_onboarding_rate_limits (rate_key, window_started_at, request_count)
       VALUES ($1, COALESCE($2::timestamptz, CURRENT_TIMESTAMP), 1)
       ON CONFLICT (rate_key) DO UPDATE SET
         request_count = CASE
           WHEN fuse_onboarding_rate_limits.window_started_at <= COALESCE($2::timestamptz, CURRENT_TIMESTAMP) - INTERVAL '1 minute' THEN 1
           ELSE fuse_onboarding_rate_limits.request_count + 1
         END,
         window_started_at = CASE
           WHEN fuse_onboarding_rate_limits.window_started_at <= COALESCE($2::timestamptz, CURRENT_TIMESTAMP) - INTERVAL '1 minute' THEN COALESCE($2::timestamptz, CURRENT_TIMESTAMP)
           ELSE fuse_onboarding_rate_limits.window_started_at
         END
       RETURNING request_count AS count, window_started_at`,
      [input.key, input.now?.toISOString() ?? null],
    );
    const row = result.rows[0];
    const count = Number(row?.count ?? input.maxPerMinute + 1);
    const retryAfterSeconds = Math.max(1, Math.ceil((new Date(row?.window_started_at ?? Date.now()).getTime() + 60_000 - Date.now()) / 1_000));
    return { allowed: count <= input.maxPerMinute, retryAfterSeconds };
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('fuse-workspace-onboarding'))");
        await client.query(`
          CREATE TABLE IF NOT EXISTS fuse_workspace_onboarding_operations (
            idempotency_key TEXT PRIMARY KEY,
            request_fingerprint TEXT NOT NULL,
            recovery_code_hash TEXT,
            recovery_consumed_at TIMESTAMPTZ,
            recovery_consumed_hash TEXT,
            recovery_delivery_envelope TEXT,
            recovery_delivery_id TEXT,
            identifiers JSONB NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'rolled_back')),
            result_json JSONB,
            delivery_envelope TEXT,
            failure_code TEXT,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            completed_at TIMESTAMPTZ
          );
          ALTER TABLE fuse_workspace_onboarding_operations ADD COLUMN IF NOT EXISTS recovery_code_hash TEXT;
          ALTER TABLE fuse_workspace_onboarding_operations ADD COLUMN IF NOT EXISTS recovery_consumed_at TIMESTAMPTZ;
          ALTER TABLE fuse_workspace_onboarding_operations ADD COLUMN IF NOT EXISTS recovery_consumed_hash TEXT;
          ALTER TABLE fuse_workspace_onboarding_operations ADD COLUMN IF NOT EXISTS recovery_delivery_envelope TEXT;
          ALTER TABLE fuse_workspace_onboarding_operations ADD COLUMN IF NOT EXISTS recovery_delivery_id TEXT;
          ALTER TABLE fuse_workspace_onboarding_operations ADD COLUMN IF NOT EXISTS delivery_envelope TEXT;
          ALTER TABLE fuse_workspace_onboarding_operations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
          UPDATE fuse_workspace_onboarding_operations SET updated_at = COALESCE(completed_at, created_at) WHERE updated_at IS NULL;
          ALTER TABLE fuse_workspace_onboarding_operations ALTER COLUMN updated_at SET NOT NULL;
          ALTER TABLE fuse_workspace_onboarding_operations
            DROP CONSTRAINT IF EXISTS fuse_workspace_onboarding_operations_status_check;
          ALTER TABLE fuse_workspace_onboarding_operations
            ADD CONSTRAINT fuse_workspace_onboarding_operations_status_check
            CHECK (status IN ('in_progress', 'completed', 'failed', 'rolled_back'));
          CREATE TABLE IF NOT EXISTS fuse_onboarding_rate_limits (
            rate_key TEXT PRIMARY KEY,
            window_started_at TIMESTAMPTZ NOT NULL,
            request_count INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS fuse_beta_invite_redemptions (
            invite_hash TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            consumed_at TIMESTAMPTZ NOT NULL
          );
          CREATE TABLE IF NOT EXISTS fuse_beta_capacity_reservations (
            idempotency_key TEXT PRIMARY KEY,
            reserved_at TIMESTAMPTZ NOT NULL
          );
        `);
        const legacy = await client.query<{ idempotency_key: string; result_json: CustomerWorkspaceResult }>(
          `SELECT idempotency_key, result_json
             FROM fuse_workspace_onboarding_operations
            WHERE status = 'completed' AND result_json IS NOT NULL AND delivery_envelope IS NULL
            FOR UPDATE`,
        );
        for (const row of legacy.rows) {
          const result = row.result_json;
          if (!result?.adminCredential?.token && !result?.credential?.token && !result?.recoveryCode) continue;
          if (!this.deliveryKeyRing) throw new Error("WORKSPACE_DELIVERY_KEY_UNAVAILABLE");
          const deliveryEnvelope = sealSecretDelivery(
            result, this.deliveryKeyRing, `workspace:${row.idempotency_key}`,
          );
          await client.query(
            `UPDATE fuse_workspace_onboarding_operations
                SET result_json = $2::jsonb, delivery_envelope = $3
              WHERE idempotency_key = $1 AND delivery_envelope IS NULL`,
            [row.idempotency_key, JSON.stringify({
              ...result,
              recoveryCode: null,
              adminCredential: { ...result.adminCredential, token: null },
              credential: { ...result.credential, token: null },
            }), deliveryEnvelope],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        this.schemaReady = undefined;
        throw error;
      } finally {
        client.release();
      }
    })();
    await this.schemaReady;
  }
}

export class MemoryWorkspaceOnboardingStore implements WorkspaceOnboardingStore {
  private readonly entries = new Map<string, { fingerprint: string; recoveryCodeHash: string; identifiers: Record<string, string>; status: "in_progress" | "completed" | "failed" | "rolled_back"; updatedAt: number; result?: CustomerWorkspaceResult }>();
  private readonly inviteRedemptions = new Map<string, string>();
  private readonly capacityReservations = new Map<string, number>();

  async tryReserveCapacity(input: {
    idempotencyKey: string;
    maxActiveWorkspaces: number;
    baselineWorkspaceIds: readonly string[];
    now?: Date;
  }): Promise<boolean> {
    const now = input.now?.getTime() ?? Date.now();
    for (const [idempotencyKey, reservedAt] of this.capacityReservations) {
      if (reservedAt <= now - 15 * 60_000 && !this.entries.has(idempotencyKey)) {
        this.capacityReservations.delete(idempotencyKey);
      }
    }
    if (this.capacityReservations.has(input.idempotencyKey)) return true;
    const completed = new Set(input.baselineWorkspaceIds);
    for (const entry of this.entries.values()) {
      if (entry.status === "completed" && entry.identifiers.workspaceId) completed.add(entry.identifiers.workspaceId);
    }
    const unresolvedReservations = [...this.capacityReservations.keys()]
      .filter((idempotencyKey) => {
        const entry = this.entries.get(idempotencyKey);
        return !entry || entry.status === "in_progress";
      }).length;
    if (completed.size + unresolvedReservations >= input.maxActiveWorkspaces) return false;
    this.capacityReservations.set(input.idempotencyKey, now);
    return true;
  }

  async consumeInvite(input: {
    inviteToken: string;
    idempotencyKey: string;
    allowedInviteHashes: ReadonlySet<string>;
  }): Promise<boolean> {
    const inviteHash = createHash("sha256").update(input.inviteToken, "utf8").digest("hex");
    if (!input.allowedInviteHashes.has(inviteHash)) return false;
    const existing = this.inviteRedemptions.get(inviteHash);
    if (existing) return existing === input.idempotencyKey;
    if ([...this.inviteRedemptions.values()].includes(input.idempotencyKey)) return false;
    this.inviteRedemptions.set(inviteHash, input.idempotencyKey);
    return true;
  }

  async claim(input: { idempotencyKey: string; fingerprint: string; recoveryCodeHash: string; identifiers: Record<string, string>; now?: Date; staleAfterMs?: number }) {
    const current = this.entries.get(input.idempotencyKey);
    if (!current) {
      this.entries.set(input.idempotencyKey, { fingerprint: input.fingerprint, recoveryCodeHash: input.recoveryCodeHash, identifiers: input.identifiers, status: "in_progress", updatedAt: input.now?.getTime() ?? Date.now() });
      return { status: "new" as const };
    }
    if (current.fingerprint !== input.fingerprint) return { status: "conflict" as const };
    if (current.status === "completed") return { status: "replay" as const, result: current.result ?? null };
    if (current.status === "rolled_back") {
      this.entries.set(input.idempotencyKey, {
        fingerprint: input.fingerprint,
        recoveryCodeHash: input.recoveryCodeHash,
        identifiers: input.identifiers,
        status: "in_progress",
        updatedAt: input.now?.getTime() ?? Date.now(),
      });
      return { status: "new" as const };
    }
    if (current.status === "in_progress" && input.now && input.staleAfterMs !== undefined
      && current.updatedAt <= input.now.getTime() - input.staleAfterMs) {
      this.entries.set(input.idempotencyKey, {
        fingerprint: input.fingerprint,
        recoveryCodeHash: input.recoveryCodeHash,
        identifiers: input.identifiers,
        status: "in_progress",
        updatedAt: input.now.getTime(),
      });
      return { status: "new" as const };
    }
    return { status: "in_progress" as const };
  }

  async heartbeat(idempotencyKey: string, workspaceId: string, now: Date): Promise<void> {
    const current = this.entries.get(idempotencyKey);
    if (!current || current.identifiers.workspaceId !== workspaceId || current.status !== "in_progress") {
      throw new Error("WORKSPACE_ONBOARDING_LEASE_LOST");
    }
    current.updatedAt = now.getTime();
  }

  async complete(idempotencyKey: string, result: CustomerWorkspaceResult): Promise<void> {
    const current = this.entries.get(idempotencyKey);
    if (!current || current.status !== "in_progress" || current.identifiers.workspaceId !== result.workspaceId) {
      throw new Error("WORKSPACE_ONBOARDING_LEASE_LOST");
    }
    this.entries.set(idempotencyKey, {
      ...current,
      status: "completed",
      result: {
        ...structuredClone(result),
      },
    });
  }

  async recordRollbackFailure(idempotencyKey: string, workspaceId: string): Promise<void> {
    const current = this.entries.get(idempotencyKey);
    if (current?.identifiers.workspaceId === workspaceId && current.status === "in_progress") {
      current.status = "failed";
    }
  }

  async getRecovery(workspaceId: string, recoveryCodeHash: string, _recoveryDeliveryId: string): Promise<WorkspaceRecoveryRecord | null> {
    for (const entry of this.entries.values()) {
      if (entry.status !== "completed" || entry.recoveryCodeHash !== recoveryCodeHash || entry.identifiers.workspaceId !== workspaceId) continue;
      return {
        workspaceId,
        serviceAccountId: entry.identifiers.serviceAccountId,
        serviceCredentialId: entry.identifiers.serviceCredentialId,
        agentId: entry.identifiers.agentId,
        agentCredentialId: entry.identifiers.agentCredentialId,
        expiresAt: entry.result?.credential.expiresAt ?? null,
      };
    }
    return null;
  }

  sealRecoveryResult(result: WorkspaceCredentialRecoveryResult, _recoveryCodeHash: string, _recoveryDeliveryId: string): string {
    return JSON.stringify(result);
  }

  async listCompletedWorkspaceIds(): Promise<string[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.status === "completed")
      .map((entry) => entry.identifiers.workspaceId)
      .filter((workspaceId): workspaceId is string => Boolean(workspaceId));
  }

  async rollback(idempotencyKey: string, workspaceId: string, _code: string): Promise<void> {
    const current = this.entries.get(idempotencyKey);
    if (!current || current.identifiers.workspaceId !== workspaceId || current.status !== "in_progress") {
      throw new Error("WORKSPACE_ROLLBACK_SCOPE_MISMATCH");
    }
    current.status = "rolled_back";
  }
}
