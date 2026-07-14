import type { Pool, PoolClient } from "pg";
import type { Hex } from "viem";
import { withSchemaBootstrapLock } from "../persistence/schemaBootstrap.js";

export type SignerReservation =
  | { status: "reserved" }
  | { status: "completed"; signature: Hex }
  | { status: "in_progress" }
  | { status: "review" }
  | { status: "budget_exceeded" };

export interface SignerAuthorizationStatus {
  reservedCount: number;
  reviewCount: number;
  reservedAtomic: bigint;
  maximumTotalAtomic: bigint;
}

export interface SignerAuthorizationStore {
  getStatus(organizationId: string): Promise<SignerAuthorizationStatus>;
  reserve(input: {
    organizationId: string;
    callerId: string;
    requestId: string;
    fingerprint: string;
    nonce: string;
    amountAtomic: bigint;
    maximumTotalAtomic: bigint;
    now: string;
  }): Promise<SignerReservation>;
  complete(input: {
    organizationId: string;
    requestId: string;
    signature: Hex;
    completedAt: string;
  }): Promise<void>;
  holdForReview(input: {
    organizationId: string;
    requestId: string;
    reasonCode: string;
    heldAt: string;
  }): Promise<void>;
}

type AuthorizationRow = {
  request_id: string;
  caller_id: string;
  fingerprint: string;
  nonce: string;
  amount_atomic: string;
  status: "reserved" | "completed" | "review";
  signature: Hex | null;
};

export class PostgresSignerAuthorizationStore implements SignerAuthorizationStore {
  private initialized?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  async getStatus(organizationId: string): Promise<SignerAuthorizationStatus> {
    if (!organizationId.trim()) throw new Error("SIGNER_ORGANIZATION_REQUIRED");
    await this.ensureSchema();
    const result = await this.pool.query<{
      reserved_count: number;
      review_count: number;
      reserved_atomic: string;
      maximum_total_atomic: string;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN record.status = 'reserved' THEN 1 ELSE 0 END), 0)::int
           AS reserved_count,
         COALESCE(SUM(CASE WHEN record.status = 'review' THEN 1 ELSE 0 END), 0)::int
           AS review_count,
         authority.reserved_atomic::text,
         authority.maximum_total_atomic::text
       FROM signer_authority_limits AS authority
       LEFT JOIN signer_authorizations AS record
         ON record.organization_id = authority.organization_id
       WHERE authority.organization_id = $1
       GROUP BY authority.reserved_atomic, authority.maximum_total_atomic`,
      [organizationId],
    );
    const row = result.rows[0];
    return row ? {
      reservedCount: row.reserved_count,
      reviewCount: row.review_count,
      reservedAtomic: BigInt(row.reserved_atomic),
      maximumTotalAtomic: BigInt(row.maximum_total_atomic),
    } : { reservedCount: 0, reviewCount: 0, reservedAtomic: 0n, maximumTotalAtomic: 0n };
  }

  async reserve(input: {
    organizationId: string;
    callerId: string;
    requestId: string;
    fingerprint: string;
    nonce: string;
    amountAtomic: bigint;
    maximumTotalAtomic: bigint;
    now: string;
  }): Promise<SignerReservation> {
    this.validateReservation(input);
    await this.ensureSchema();
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO signer_authority_limits
         (organization_id, maximum_total_atomic, reserved_atomic, created_at, updated_at)
         VALUES ($1, $2, 0, $3, $3)
         ON CONFLICT (organization_id) DO NOTHING`,
        [input.organizationId, input.maximumTotalAtomic.toString(), input.now],
      );
      const limit = await client.query<{
        maximum_total_atomic: string;
        reserved_atomic: string;
      }>(
        `SELECT maximum_total_atomic::text, reserved_atomic::text
         FROM signer_authority_limits WHERE organization_id = $1 FOR UPDATE`,
        [input.organizationId],
      );
      const currentLimit = limit.rows[0];
      if (!currentLimit) throw new Error("SIGNER_AUTHORITY_LIMIT_MISSING");
      if (BigInt(currentLimit.maximum_total_atomic) !== input.maximumTotalAtomic) {
        throw new Error("SIGNER_AUTHORITY_LIMIT_IMMUTABLE");
      }
      const existing = await client.query<AuthorizationRow>(
        `SELECT request_id, caller_id, fingerprint, nonce, amount_atomic::text, status, signature
         FROM signer_authorizations
         WHERE organization_id = $1 AND request_id = $2 FOR UPDATE`,
        [input.organizationId, input.requestId],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.caller_id !== input.callerId || row.fingerprint !== input.fingerprint
          || row.nonce.toLowerCase() !== input.nonce.toLowerCase()
          || BigInt(row.amount_atomic) !== input.amountAtomic) {
          throw new Error("SIGNER_IDEMPOTENCY_CONFLICT");
        }
        if (row.status === "completed") {
          if (!row.signature) throw new Error("SIGNER_SIGNATURE_MISSING");
          return { status: "completed", signature: row.signature };
        }
        return { status: row.status === "review" ? "review" : "in_progress" };
      }
      const equivalent = await client.query<AuthorizationRow>(
        `SELECT request_id, caller_id, fingerprint, nonce, amount_atomic::text, status, signature
         FROM signer_authorizations
         WHERE organization_id = $1 AND (fingerprint = $2 OR LOWER(nonce) = LOWER($3))
         FOR UPDATE`,
        [input.organizationId, input.fingerprint, input.nonce],
      );
      const equivalentRow = equivalent.rows[0];
      if (equivalentRow) {
        if (equivalentRow.caller_id !== input.callerId
          || equivalentRow.fingerprint !== input.fingerprint
          || BigInt(equivalentRow.amount_atomic) !== input.amountAtomic) {
          throw new Error("SIGNER_NONCE_CONFLICT");
        }
        if (equivalentRow.status === "completed") {
          if (!equivalentRow.signature) throw new Error("SIGNER_SIGNATURE_MISSING");
          return { status: "completed", signature: equivalentRow.signature };
        }
        return { status: equivalentRow.status === "review" ? "review" : "in_progress" };
      }
      const reserved = BigInt(currentLimit.reserved_atomic);
      if (reserved + input.amountAtomic > input.maximumTotalAtomic) {
        return { status: "budget_exceeded" };
      }
      await client.query(
        `INSERT INTO signer_authorizations
         (organization_id, caller_id, request_id, fingerprint, nonce, amount_atomic, status,
          signature, reason_code, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'reserved', NULL, NULL, $7, $7)`,
        [input.organizationId, input.callerId, input.requestId, input.fingerprint,
          input.nonce.toLowerCase(), input.amountAtomic.toString(), input.now],
      );
      await client.query(
        `UPDATE signer_authority_limits
         SET reserved_atomic = reserved_atomic + $2, updated_at = $3
         WHERE organization_id = $1`,
        [input.organizationId, input.amountAtomic.toString(), input.now],
      );
      return { status: "reserved" };
    });
  }

  async complete(input: {
    organizationId: string;
    requestId: string;
    signature: Hex;
    completedAt: string;
  }): Promise<void> {
    this.validateIdentity(input.organizationId, input.requestId);
    if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new Error("SIGNER_SIGNATURE_INVALID");
    this.validateTimestamp(input.completedAt);
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE signer_authorizations
       SET status = 'completed', signature = $3, reason_code = NULL, updated_at = $4
       WHERE organization_id = $1 AND request_id = $2 AND status = 'reserved'`,
      [input.organizationId, input.requestId, input.signature, input.completedAt],
    );
    if (result.rowCount !== 1) throw new Error("SIGNER_AUTHORIZATION_NOT_RESERVED");
  }

  async holdForReview(input: {
    organizationId: string;
    requestId: string;
    reasonCode: string;
    heldAt: string;
  }): Promise<void> {
    this.validateIdentity(input.organizationId, input.requestId);
    if (!input.reasonCode.trim() || input.reasonCode.length > 128) {
      throw new Error("SIGNER_REVIEW_REASON_INVALID");
    }
    this.validateTimestamp(input.heldAt);
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE signer_authorizations
       SET status = 'review', reason_code = $3, updated_at = $4
       WHERE organization_id = $1 AND request_id = $2 AND status = 'reserved'`,
      [input.organizationId, input.requestId, input.reasonCode, input.heldAt],
    );
    if (result.rowCount !== 1) throw new Error("SIGNER_AUTHORIZATION_NOT_RESERVED");
  }

  private ensureSchema(): Promise<void> {
    this.initialized ??= this.initializeSchema();
    return this.initialized;
  }

  private async initializeSchema(): Promise<void> {
    await withSchemaBootstrapLock(
      this.pool,
      "signer_schema_migrations",
      7_341_120_002n,
      async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS signer_schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL
          )
        `);
      },
    );
    await this.transaction(async (client) => {
      const migrated = await client.query(
        "SELECT 1 FROM signer_schema_migrations WHERE version = 1",
      );
      if (migrated.rowCount !== 0) return;
      const claimed = await client.query(
        `INSERT INTO signer_schema_migrations (version, applied_at)
         VALUES (1, CURRENT_TIMESTAMP)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
      );
      if (claimed.rowCount === 0) return;
      const existing = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('signer_authority_limits', 'signer_authorizations')`,
      );
      if (existing.rowCount !== 0) throw new Error("UNVERSIONED_SIGNER_SCHEMA_UNSUPPORTED");
      await client.query(`
        CREATE TABLE signer_authority_limits (
          organization_id TEXT PRIMARY KEY,
          maximum_total_atomic NUMERIC(78, 0) NOT NULL CHECK (maximum_total_atomic > 0),
          reserved_atomic NUMERIC(78, 0) NOT NULL CHECK (reserved_atomic >= 0),
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE signer_authorizations (
          organization_id TEXT NOT NULL,
          caller_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          nonce TEXT NOT NULL,
          amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
          status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'review')),
          signature TEXT,
          reason_code TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (organization_id, request_id),
          UNIQUE (organization_id, fingerprint),
          UNIQUE (organization_id, nonce),
          FOREIGN KEY (organization_id) REFERENCES signer_authority_limits(organization_id)
        );
      `);
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private validateReservation(input: {
    organizationId: string;
    callerId: string;
    requestId: string;
    fingerprint: string;
    nonce: string;
    amountAtomic: bigint;
    maximumTotalAtomic: bigint;
    now: string;
  }): void {
    this.validateIdentity(input.organizationId, input.requestId);
    if (!input.callerId.trim() || input.callerId.length > 128) throw new Error("SIGNER_CALLER_INVALID");
    if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new Error("SIGNER_FINGERPRINT_INVALID");
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.nonce)) throw new Error("SIGNER_NONCE_INVALID");
    if (input.amountAtomic <= 0n || input.maximumTotalAtomic <= 0n) {
      throw new Error("SIGNER_AMOUNT_INVALID");
    }
    this.validateTimestamp(input.now);
  }

  private validateIdentity(organizationId: string, requestId: string): void {
    if (!organizationId.trim()) throw new Error("SIGNER_ORGANIZATION_REQUIRED");
    if (!requestId.trim()) throw new Error("SIGNER_REQUEST_ID_REQUIRED");
  }

  private validateTimestamp(value: string): void {
    if (Number.isNaN(Date.parse(value))) throw new Error("SIGNER_TIMESTAMP_INVALID");
  }
}
