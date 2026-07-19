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
      "SELECT version FROM provider_schema_migrations WHERE version = 1",
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
          encrypted_secret, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $10)
         ON CONFLICT (organization_id) DO UPDATE SET
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           input_usd_per_million = EXCLUDED.input_usd_per_million,
           output_usd_per_million = EXCLUDED.output_usd_per_million,
           credential_version = EXCLUDED.credential_version,
           encryption_key_id = EXCLUDED.encryption_key_id,
           encrypted_secret = EXCLUDED.encrypted_secret,
           status = 'active',
           updated_at = EXCLUDED.updated_at
         WHERE provider_configurations.id = EXCLUDED.id
         RETURNING id`,
        [
          input.organizationId, input.id, input.provider, input.model,
          input.inputUsdPerMillion, input.outputUsdPerMillion, credentialVersion,
          this.keyRing.activeKeyId, encryptedSecret, input.occurredAt,
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

  async resolve(organizationId: string): Promise<ResolvedProviderConfiguration> {
    if (!organizationId.trim()) throw new Error("PROVIDER_CONFIGURATION_ORGANIZATION_REQUIRED");
    await this.ensureSchema();
    const result = await this.pool.query<ProviderConfigRow>(
      `SELECT * FROM provider_configurations
       WHERE organization_id = $1 AND status = 'active'`,
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
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
          );
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
