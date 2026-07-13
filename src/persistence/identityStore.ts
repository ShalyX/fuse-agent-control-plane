import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  API_CAPABILITIES,
  hashApiToken,
  tokenMatchesHash,
  type ApiCapability,
  type ApiCredentialRecord,
} from "../identity/apiCredentials.js";

interface MutationContext {
  actorId: string;
  causationId: string;
  occurredAt: string;
}

export interface CreateOrganizationInput extends MutationContext {
  id: string;
  name: string;
}

export interface RegisterAgentInput extends MutationContext {
  id: string;
  organizationId: string;
  name: string;
}

export interface AgentIdentity {
  id: string;
  organizationId: string;
  name: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
}

export class IdentityStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.createSchema();
    await this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    await this.pool.query(`
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
      CREATE INDEX IF NOT EXISTS audit_events_entity_idx
        ON audit_events (organization_id, entity_type, entity_id, occurred_at, id);

      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_identities (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        UNIQUE (organization_id, id)
      );
      CREATE TABLE IF NOT EXISTS api_credentials (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        capabilities JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        FOREIGN KEY (organization_id, agent_id)
          REFERENCES agent_identities(organization_id, id)
      );
    `);
  }

  async createOrganization(input: CreateOrganizationInput): Promise<void> {
    this.validateContext(input);
    if (!input.id.trim()) throw new Error("ORGANIZATION_ID_REQUIRED");
    if (!input.name.trim()) throw new Error("ORGANIZATION_NAME_REQUIRED");
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        "INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)",
        [input.id, input.name, input.occurredAt],
      );
      await this.appendAudit(client, {
        organizationId: input.id,
        entityType: "organization",
        entityId: input.id,
        action: "organization.created",
        payload: { name: input.name },
        ...input,
      });
    });
  }

  async registerAgent(input: RegisterAgentInput): Promise<void> {
    this.validateContext(input);
    if (!input.id.trim()) throw new Error("AGENT_ID_REQUIRED");
    if (!input.organizationId.trim()) throw new Error("AGENT_ORGANIZATION_REQUIRED");
    if (!input.name.trim()) throw new Error("AGENT_NAME_REQUIRED");
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO agent_identities
         (id, organization_id, name, status, created_at)
         VALUES ($1, $2, $3, 'active', $4)`,
        [input.id, input.organizationId, input.name, input.occurredAt],
      );
      await this.appendAudit(client, {
        entityType: "agent_identity",
        entityId: input.id,
        action: "agent.registered",
        payload: { name: input.name },
        ...input,
      });
    });
  }

  async issueCredential(record: ApiCredentialRecord, context: MutationContext): Promise<void> {
    this.validateContext(context);
    if (!record.id.trim()) throw new Error("API_CREDENTIAL_ID_REQUIRED");
    if (!record.organizationId.trim()) throw new Error("API_CREDENTIAL_ORGANIZATION_REQUIRED");
    if (!record.agentId.trim()) throw new Error("API_CREDENTIAL_AGENT_REQUIRED");
    if (!record.name.trim()) throw new Error("API_CREDENTIAL_NAME_REQUIRED");
    if (!/^fuse_sk_[A-Za-z0-9_-]{12}$/.test(record.tokenPrefix)) {
      throw new Error("API_CREDENTIAL_PREFIX_INVALID");
    }
    if (!/^[a-f0-9]{64}$/.test(record.tokenHash)) throw new Error("API_CREDENTIAL_HASH_INVALID");
    const createdAt = Date.parse(record.createdAt);
    if (Number.isNaN(createdAt)) throw new Error("API_CREDENTIAL_CREATED_AT_INVALID");
    if (record.expiresAt !== null) {
      const expiresAt = Date.parse(record.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt <= createdAt) {
        throw new Error("API_CREDENTIAL_EXPIRY_INVALID");
      }
    }
    if (record.revokedAt !== null) throw new Error("API_CREDENTIAL_ALREADY_REVOKED");
    if (new Set(record.capabilities).size !== record.capabilities.length) {
      throw new Error("API_CREDENTIAL_CAPABILITY_DUPLICATE");
    }
    if (record.capabilities.length === 0 || record.capabilities.some(
      (capability) => !API_CAPABILITIES.includes(capability),
    )) throw new Error("API_CREDENTIAL_CAPABILITY_INVALID");
    await this.ensureSchema();

    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO api_credentials
         (id, organization_id, agent_id, name, token_prefix, token_hash, capabilities,
          created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [
          record.id,
          record.organizationId,
          record.agentId,
          record.name,
          record.tokenPrefix,
          record.tokenHash,
          JSON.stringify(record.capabilities),
          record.createdAt,
          record.expiresAt,
          record.revokedAt,
        ],
      );
      await this.appendAudit(client, {
        organizationId: record.organizationId,
        entityType: "api_credential",
        entityId: record.id,
        action: "credential.issued",
        payload: {
          agentId: record.agentId,
          tokenPrefix: record.tokenPrefix,
          capabilities: record.capabilities,
          expiresAt: record.expiresAt,
        },
        ...context,
      });
    });
  }

  async revokeCredential(
    organizationId: string,
    credentialId: string,
    context: MutationContext,
  ): Promise<void> {
    this.validateContext(context);
    if (!organizationId.trim()) throw new Error("API_CREDENTIAL_ORGANIZATION_REQUIRED");
    if (!credentialId.trim()) throw new Error("API_CREDENTIAL_ID_REQUIRED");
    await this.ensureSchema();
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE api_credentials SET revoked_at = $3
         WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [organizationId, credentialId, context.occurredAt],
      );
      if (result.rowCount !== 1) throw new Error("API_CREDENTIAL_NOT_ACTIVE");
      await this.appendAudit(client, {
        organizationId,
        entityType: "api_credential",
        entityId: credentialId,
        action: "credential.revoked",
        payload: {},
        ...context,
      });
    });
  }

  async authenticateToken(token: string, now: string): Promise<{
    organizationId: string;
    agentId: string;
    credentialId: string;
    capabilities: ApiCapability[];
  } | null> {
    if (Number.isNaN(Date.parse(now))) throw new Error("AUTHENTICATION_TIME_INVALID");
    await this.ensureSchema();
    const tokenHash = hashApiToken(token);
    const result = await this.pool.query<{
      id: string;
      organization_id: string;
      agent_id: string;
      token_hash: string;
      capabilities: ApiCapability[];
      expires_at: Date | null;
      revoked_at: Date | null;
      agent_status: "active" | "revoked";
    }>(
      `SELECT credentials.id, credentials.organization_id, credentials.agent_id,
              credentials.token_hash, credentials.capabilities, credentials.expires_at,
              credentials.revoked_at, agents.status AS agent_status
       FROM api_credentials credentials
       JOIN agent_identities agents
         ON agents.organization_id = credentials.organization_id
        AND agents.id = credentials.agent_id
       WHERE credentials.token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row || !tokenMatchesHash(token, row.token_hash)) return null;
    if (row.revoked_at || row.agent_status !== "active") return null;
    if (row.expires_at && row.expires_at.getTime() <= Date.parse(now)) return null;
    return {
      organizationId: row.organization_id,
      agentId: row.agent_id,
      credentialId: row.id,
      capabilities: row.capabilities,
    };
  }

  async getAgent(organizationId: string, agentId: string): Promise<AgentIdentity | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      id: string;
      organization_id: string;
      name: string;
      status: "active" | "revoked";
      created_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, organization_id, name, status, created_at, revoked_at
       FROM agent_identities WHERE organization_id = $1 AND id = $2`,
      [organizationId, agentId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
    } : null;
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

  private async appendAudit(client: PoolClient, input: {
    organizationId: string;
    entityType: string;
    entityId: string;
    action: string;
    actorId: string;
    causationId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
       (id, organization_id, entity_type, entity_id, action, actor_id, causation_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        randomUUID(),
        input.organizationId,
        input.entityType,
        input.entityId,
        input.action,
        input.actorId,
        input.causationId,
        input.occurredAt,
        JSON.stringify(input.payload),
      ],
    );
  }

  private validateContext(input: MutationContext): void {
    if (!input.actorId.trim()) throw new Error("IDENTITY_ACTOR_REQUIRED");
    if (!input.causationId.trim()) throw new Error("IDENTITY_CAUSATION_REQUIRED");
    if (Number.isNaN(Date.parse(input.occurredAt))) throw new Error("IDENTITY_OCCURRED_AT_INVALID");
  }
}
