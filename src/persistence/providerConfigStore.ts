import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  decryptProviderSecret,
  encryptProviderSecret,
  type ProviderCredentialKeyRing,
} from "../providers/providerCredentials.js";
import { withSchemaBootstrapLock } from "./schemaBootstrap.js";

export type ProviderName = "anthropic" | "openrouter";

export interface ConfigureProviderInput {
  id: string;
  organizationId: string;
  provider: ProviderName;
  model: string;
  apiKey: string;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  actorId: string;
  causationId: string;
  occurredAt: string;
  verificationStatus?: "pending" | "verified" | "invalid";
}

export interface ProviderConfigurationSummary {
  id: string;
  organizationId: string;
  provider: ProviderName;
  model: string;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  credentialVersion: number;
  status: "active" | "revoked";
  updatedAt: string;
}

export interface ResolvedProviderConfiguration extends ProviderConfigurationSummary {
  apiKey: string;
  requireProviderCost: boolean;
  requireProviderModelMatch: boolean;
}

export interface ProviderVerificationRecord extends ResolvedProviderConfiguration {
  verificationStatus: "pending" | "verified" | "invalid";
}

export interface ProviderRetryReplay {
  status: "verified" | "invalid";
  summary: ProviderConfigurationSummary;
  errorCode?: string;
}

interface ProviderConfigRow {
  id: string;
  organization_id: string;
  provider: ProviderName;
  model: string;
  input_usd_per_million: string;
  output_usd_per_million: string;
  credential_version: number;
  encryption_key_id: string;
  encrypted_secret: string;
  status: "active" | "revoked";
  verification_status: "pending" | "verified" | "invalid";
  updated_at: Date;
}

export class ProviderConfigStore {
  private schemaReady?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly keyRing: ProviderCredentialKeyRing,
  ) {
    if (!keyRing.keys.has(keyRing.activeKeyId)) {
      throw new Error("PROVIDER_CREDENTIAL_ACTIVE_KEY_MISSING");
    }
  }

  ensureSchema(): Promise<void> {
    this.schemaReady ??= this.createSchema().catch((error) => {
      this.schemaReady = undefined;
      throw error;
    });
    return this.schemaReady;
  }

  async readiness(): Promise<void> {
    const migration = await this.pool.query<{ version: number }>(
      "SELECT version FROM provider_schema_migrations WHERE version = 2",
    );
    if (!migration.rows[0]) throw new Error("PROVIDER_SCHEMA_MIGRATION_REQUIRED");
    const keyIds = await this.pool.query<{ encryption_key_id: string }>(
      "SELECT DISTINCT encryption_key_id FROM provider_configurations",
    );
    if (keyIds.rows.some(({ encryption_key_id: keyId }) => !this.keyRing.keys.has(keyId))) {
      throw new Error("PROVIDER_CREDENTIAL_DECRYPTION_KEY_MISSING");
    }
  }

  async configure(input: ConfigureProviderInput): Promise<ProviderConfigurationSummary> {
    input = { ...input };
    this.validateInput(input);
    const verificationStatus = input.verificationStatus ?? "verified";
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const organization = await client.query<{ id: string }>(
        "SELECT id FROM organizations WHERE id = $1 FOR UPDATE",
        [input.organizationId],
      );
      if (!organization.rows[0]) throw new Error("PROVIDER_CONFIGURATION_ORGANIZATION_NOT_FOUND");
      const current = await client.query<{ id: string; credential_version: number }>(
        `SELECT id, credential_version FROM provider_configurations
         WHERE organization_id = $1 FOR UPDATE`,
        [input.organizationId],
      );
      const existing = current.rows[0];
      if (existing && existing.id !== input.id) throw new Error("PROVIDER_CONFIGURATION_ID_CONFLICT");
      const credentialVersion = (existing?.credential_version ?? 0) + 1;
      const encryptedSecret = encryptProviderSecret(input.apiKey, this.keyRing, {
        organizationId: input.organizationId,
        provider: input.provider,
        credentialVersion,
      });
      const upserted = await client.query<{ id: string }>(
        `INSERT INTO provider_configurations
         (organization_id, id, provider, model, input_usd_per_million,
          output_usd_per_million, credential_version, encryption_key_id,
          encrypted_secret, status, verification_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $11)
         ON CONFLICT (organization_id) DO UPDATE SET
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           input_usd_per_million = EXCLUDED.input_usd_per_million,
           output_usd_per_million = EXCLUDED.output_usd_per_million,
           credential_version = EXCLUDED.credential_version,
           encryption_key_id = EXCLUDED.encryption_key_id,
           encrypted_secret = EXCLUDED.encrypted_secret,
           status = 'active',
           verification_status = EXCLUDED.verification_status,
           updated_at = EXCLUDED.updated_at
         WHERE provider_configurations.id = EXCLUDED.id
         RETURNING id`,
        [
          input.organizationId, input.id, input.provider, input.model,
          input.inputUsdPerMillion, input.outputUsdPerMillion, credentialVersion,
          this.keyRing.activeKeyId, encryptedSecret, verificationStatus, input.occurredAt,
        ],
      );
      if (upserted.rowCount !== 1) throw new Error("PROVIDER_CONFIGURATION_ID_CONFLICT");
      await client.query(
        `INSERT INTO audit_events
         (id, organization_id, entity_type, entity_id, action, actor_id, causation_id, occurred_at, payload)
         VALUES ($1, $2, 'provider_configuration', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          randomUUID(), input.organizationId, input.id,
          credentialVersion === 1 ? "provider_configuration.created" : "provider_credential.rotated",
          input.actorId, input.causationId, input.occurredAt,
          JSON.stringify({
            provider: input.provider,
            model: input.model,
            credentialVersion,
          }),
        ],
      );
      return this.getSummary(client, input.organizationId);
    });
  }

  async list(organizationId: string): Promise<ProviderConfigurationSummary[]> {
    if (!organizationId.trim()) throw new Error("PROVIDER_CONFIGURATION_ORGANIZATION_REQUIRED");
    await this.ensureSchema();
    const result = await this.pool.query<Omit<ProviderConfigRow, "encrypted_secret" | "encryption_key_id">>(
      `SELECT id, organization_id, provider, model, input_usd_per_million,
              output_usd_per_million, credential_version, status, updated_at
       FROM provider_configurations WHERE organization_id = $1`,
      [organizationId],
    );
    return result.rows.map((row) => this.summaryFromRow(row));
  }

  async hasVerifiedConfiguration(organizationId: string): Promise<boolean> {
    return (await this.getVerifiedConfigurationSummary(organizationId)) !== null;
  }

  async getVerifiedConfigurationSummary(
    organizationId: string,
  ): Promise<ProviderConfigurationSummary | null> {
    try {
      const resolved = await this.resolve(organizationId);
      return {
        id: resolved.id,
        organizationId: resolved.organizationId,
        provider: resolved.provider,
        model: resolved.model,
        inputUsdPerMillion: resolved.inputUsdPerMillion,
        outputUsdPerMillion: resolved.outputUsdPerMillion,
        credentialVersion: resolved.credentialVersion,
        status: resolved.status,
        updatedAt: resolved.updatedAt,
      };
    } catch (error) {
      if (error instanceof Error && [
        "PROVIDER_CONFIGURATION_NOT_FOUND",
        "PROVIDER_CREDENTIAL_DECRYPT_FAILED",
      ].includes(error.message)) return null;
      throw error;
    }
  }

  async markVerificationStatus(input: {
    organizationId: string;
    id: string;
    status: "pending" | "verified" | "invalid";
    expectedCredentialVersion: number;
    occurredAt: string;
  }): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE provider_configurations
       SET verification_status = $3, updated_at = $4
       WHERE organization_id = $1 AND id = $2 AND credential_version = $5`,
      [input.organizationId, input.id, input.status, input.occurredAt, input.expectedCredentialVersion],
    );
    if (result.rowCount !== 1) throw new Error("PROVIDER_VERIFICATION_STALE");
  }

  async getForVerification(organizationId: string, id: string): Promise<ProviderVerificationRecord> {
    if (!organizationId.trim() || !id.trim()) throw new Error("PROVIDER_CONFIGURATION_NOT_FOUND");
    await this.ensureSchema();
    const result = await this.pool.query<ProviderConfigRow>(
      "SELECT * FROM provider_configurations WHERE organization_id = $1 AND id = $2",
      [organizationId, id],
    );
    const row = result.rows[0];
    if (!row) throw new Error("PROVIDER_CONFIGURATION_NOT_FOUND");
    if (row.encrypted_secret.split(".")[1] !== row.encryption_key_id) {
      throw new Error("PROVIDER_CREDENTIAL_DECRYPT_FAILED");
    }
    return {
      ...this.summaryFromRow(row),
      verificationStatus: row.verification_status,
      apiKey: decryptProviderSecret(row.encrypted_secret, this.keyRing, {
        organizationId,
        provider: row.provider,
        credentialVersion: row.credential_version,
      }),
      requireProviderCost: row.provider === "openrouter",
      requireProviderModelMatch: row.provider === "openrouter",
    };
  }


  async beginVerificationRetry(input: {
    organizationId: string;
    id: string;
    requestId: string;
    occurredAt: string;
  }): Promise<{ record?: ProviderVerificationRecord; replay?: ProviderRetryReplay; claimToken?: string }> {
    await this.ensureSchema();
    const occurredAt = new Date(input.occurredAt);
    if (!Number.isFinite(occurredAt.getTime())) throw new Error("PROVIDER_VERIFICATION_OCCURRED_AT_INVALID");
    const staleBefore = new Date(occurredAt.getTime() - 15 * 60_000);
    const claimToken = randomUUID();
    const claim = await this.transaction(async (client) => {
      const result = await client.query<ProviderConfigRow>(
        "SELECT * FROM provider_configurations WHERE organization_id = $1 AND id = $2 FOR UPDATE",
        [input.organizationId, input.id],
      );
      const row = result.rows[0];
      if (!row) throw new Error("PROVIDER_CONFIGURATION_NOT_FOUND");
      if (row.status !== "active") throw new Error("PROVIDER_CONFIGURATION_NOT_ACTIVE");
      const prior = await client.query<{ status: "pending" | "verified" | "invalid"; summary: ProviderConfigurationSummary; error_code: string | null }>(
        "SELECT status, summary, error_code FROM provider_verification_retries WHERE organization_id = $1 AND config_id = $2 AND request_id = $3 FOR UPDATE",
        [input.organizationId, input.id, input.requestId],
      );
      const existing = prior.rows[0];
      if (existing && existing.status !== "pending") {
        if (existing.summary.credentialVersion !== row.credential_version) {
          throw new Error("PROVIDER_VERIFICATION_STALE");
        }
        return { replay: { status: existing.status, summary: existing.summary, ...(existing.error_code ? { errorCode: existing.error_code } : {}) } };
      }
      if (row.verification_status === "verified") throw new Error("PROVIDER_ALREADY_VERIFIED");
      const pending = await client.query<{ updated_at: Date }>(
        `SELECT updated_at FROM provider_verification_retries
          WHERE organization_id = $1 AND config_id = $2 AND status = 'pending'
          FOR UPDATE`,
        [input.organizationId, input.id],
      );
      const leaseUpdatedAt = [
        ...(row.verification_status === "pending" ? [row.updated_at] : []),
        ...pending.rows.map(({ updated_at }) => updated_at),
      ].sort((left, right) => right.getTime() - left.getTime())[0];
      if (leaseUpdatedAt && leaseUpdatedAt.getTime() > staleBefore.getTime()) {
        throw new Error("PROVIDER_VERIFICATION_IN_PROGRESS");
      }
      if (pending.rowCount) {
        await client.query(
          `UPDATE provider_verification_retries
              SET status = 'invalid', summary = $3::jsonb,
                  error_code = 'PROVIDER_VERIFICATION_RETRY_LEASE_EXPIRED', updated_at = $4
            WHERE organization_id = $1 AND config_id = $2 AND status = 'pending'`,
          [input.organizationId, input.id, JSON.stringify(this.summaryFromRow(row)), input.occurredAt],
        );
      }
      await client.query(
        `INSERT INTO provider_verification_retries
         (organization_id, config_id, request_id, claim_token, status, created_at, updated_at)
         VALUES ($1, $2, $3, $5, 'pending', $4, $4)
         ON CONFLICT (organization_id, config_id, request_id) DO UPDATE SET
           status = 'pending', summary = NULL, error_code = NULL,
           claim_token = EXCLUDED.claim_token,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
         WHERE provider_verification_retries.status = 'invalid'`,
        [input.organizationId, input.id, input.requestId, input.occurredAt, claimToken],
      );
      await client.query(
        "UPDATE provider_configurations SET verification_status = 'pending', updated_at = $3 WHERE organization_id = $1 AND id = $2",
        [input.organizationId, input.id, input.occurredAt],
      );
      return {};
    });
    if (claim.replay) return claim;
    return { record: await this.getForVerification(input.organizationId, input.id), claimToken };
  }

  async finishVerificationRetry(input: {
    organizationId: string;
    id: string;
    requestId: string;
    claimToken: string;
    expectedCredentialVersion: number;
    status: "verified" | "invalid";
    summary: ProviderConfigurationSummary;
    errorCode?: string;
    occurredAt: string;
  }): Promise<void> {
    await this.ensureSchema();
    await this.transaction(async (client) => {
      const configuration = await client.query(
        "UPDATE provider_configurations SET verification_status = $3, updated_at = $4 WHERE organization_id = $1 AND id = $2 AND credential_version = $5",
        [input.organizationId, input.id, input.status, input.occurredAt, input.expectedCredentialVersion],
      );
      if (configuration.rowCount !== 1) throw new Error("PROVIDER_VERIFICATION_STALE");
      const result = await client.query(
        "UPDATE provider_verification_retries SET status = $5, summary = $6, error_code = $7, updated_at = $8 WHERE organization_id = $1 AND config_id = $2 AND request_id = $3 AND claim_token = $4 AND status = 'pending'",
        [input.organizationId, input.id, input.requestId, input.claimToken, input.status, JSON.stringify(input.summary), input.errorCode ?? null, input.occurredAt],
      );
      if (result.rowCount !== 1) throw new Error("PROVIDER_VERIFICATION_RETRY_NOT_FOUND");
    });
  }

  async resolve(organizationId: string): Promise<ResolvedProviderConfiguration> {
    if (!organizationId.trim()) throw new Error("PROVIDER_CONFIGURATION_ORGANIZATION_REQUIRED");
    await this.ensureSchema();
    const result = await this.pool.query<ProviderConfigRow>(
      `SELECT * FROM provider_configurations
       WHERE organization_id = $1 AND status = 'active' AND verification_status = 'verified'`,
      [organizationId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("PROVIDER_CONFIGURATION_NOT_FOUND");
    const summary = this.summaryFromRow(row);
    if (row.encrypted_secret.split(".")[1] !== row.encryption_key_id) {
      throw new Error("PROVIDER_CREDENTIAL_DECRYPT_FAILED");
    }
    return {
      ...summary,
      apiKey: decryptProviderSecret(row.encrypted_secret, this.keyRing, {
        organizationId,
        provider: row.provider,
        credentialVersion: row.credential_version,
      }),
      requireProviderCost: row.provider === "openrouter",
      requireProviderModelMatch: row.provider === "openrouter",
    };
  }

  private async createSchema(): Promise<void> {
    await withSchemaBootstrapLock(
      this.pool,
      "provider-config-schema",
      779435021n,
      async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS provider_schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL
          );
          CREATE TABLE IF NOT EXISTS provider_configurations (
            organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
            id TEXT NOT NULL,
            provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openrouter')),
            model TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 256),
            input_usd_per_million NUMERIC(30, 12) NOT NULL CHECK (input_usd_per_million > 0),
            output_usd_per_million NUMERIC(30, 12) NOT NULL CHECK (output_usd_per_million > 0),
            credential_version INTEGER NOT NULL CHECK (credential_version > 0),
            encryption_key_id TEXT NOT NULL,
            encrypted_secret TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
            verification_status TEXT NOT NULL DEFAULT 'verified'
              CHECK (verification_status IN ('pending', 'verified', 'invalid')),
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
          );
          CREATE TABLE IF NOT EXISTS provider_verification_retries (
            organization_id TEXT NOT NULL REFERENCES organizations(id),
            config_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            claim_token TEXT,
            status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'invalid')),
            summary JSONB,
            error_code TEXT,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (organization_id, config_id, request_id)
          );
          ALTER TABLE provider_verification_retries ADD COLUMN IF NOT EXISTS claim_token TEXT;
          ALTER TABLE provider_configurations
            ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'verified';
          UPDATE provider_configurations
            SET verification_status = 'verified' WHERE verification_status IS NULL;
          INSERT INTO provider_schema_migrations (version, applied_at)
          VALUES (2, CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING;
          INSERT INTO provider_schema_migrations (version, applied_at)
          VALUES (1, CURRENT_TIMESTAMP) ON CONFLICT (version) DO NOTHING;
        `);
      },
    );
  }

  private validateInput(input: ConfigureProviderInput): void {
    if (!input.id.trim()) throw new Error("PROVIDER_CONFIGURATION_ID_REQUIRED");
    if (!input.organizationId.trim()) throw new Error("PROVIDER_CONFIGURATION_ORGANIZATION_REQUIRED");
    if (!(["anthropic", "openrouter"] as const).includes(input.provider)) {
      throw new Error("PROVIDER_CONFIGURATION_PROVIDER_INVALID");
    }
    if (!input.model.trim() || input.model.length > 256) throw new Error("PROVIDER_CONFIGURATION_MODEL_INVALID");
    if (!input.apiKey.trim() || input.apiKey.length > 4096) throw new Error("PROVIDER_CREDENTIAL_SECRET_INVALID");
    for (const value of [input.inputUsdPerMillion, input.outputUsdPerMillion]) {
      if (!/^\d+(?:\.\d{1,12})?$/.test(value) || Number(value) <= 0) {
        throw new Error("PROVIDER_CONFIGURATION_PRICE_INVALID");
      }
    }
    if (!input.actorId.trim() || !input.causationId.trim() || Number.isNaN(Date.parse(input.occurredAt))) {
      throw new Error("PROVIDER_CONFIGURATION_CONTEXT_INVALID");
    }
  }

  private async getSummary(
    client: PoolClient,
    organizationId: string,
  ): Promise<ProviderConfigurationSummary> {
    const result = await client.query<ProviderConfigRow>(
      "SELECT * FROM provider_configurations WHERE organization_id = $1",
      [organizationId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("PROVIDER_CONFIGURATION_NOT_FOUND");
    return this.summaryFromRow(row);
  }

  private summaryFromRow(
    row: Omit<ProviderConfigRow, "encrypted_secret" | "encryption_key_id">,
  ): ProviderConfigurationSummary {
    return {
      id: row.id,
      organizationId: row.organization_id,
      provider: row.provider,
      model: row.model,
      inputUsdPerMillion: this.normalizeDecimal(row.input_usd_per_million),
      outputUsdPerMillion: this.normalizeDecimal(row.output_usd_per_million),
      credentialVersion: row.credential_version,
      status: row.status,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private normalizeDecimal(value: string | number): string {
    const text = String(value);
    const [whole, fraction = ""] = text.split(".");
    const trimmed = fraction.replace(/0+$/, "");
    return trimmed ? `${whole}.${trimmed}` : whole;
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
}
