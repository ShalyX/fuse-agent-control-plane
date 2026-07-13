import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  API_CAPABILITIES,
  hashApiToken,
  tokenMatchesHash,
  serviceAccountRoleAllowsCapabilities,
  type ApiCapability,
  type ApiCredentialRecord,
  type ServiceAccountCredentialRecord,
  type ServiceAccountRole,
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

export type OrganizationRole = "owner" | "admin" | "operator" | "viewer";

export interface AddOrganizationUserInput extends MutationContext {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: OrganizationRole;
}

export interface CreateServiceAccountInput extends MutationContext {
  id: string;
  organizationId: string;
  name: string;
  role: ServiceAccountRole;
}

export interface BootstrapServiceAccountInput extends MutationContext {
  organizationId: string;
  organizationName: string;
  serviceAccountId: string;
  serviceAccountName: string;
  credential: ServiceAccountCredentialRecord;
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
      CREATE TABLE IF NOT EXISTS organization_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        disabled_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS organization_memberships (
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        user_id TEXT NOT NULL REFERENCES organization_users(id),
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (organization_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS service_accounts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        UNIQUE (organization_id, id)
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
      CREATE TABLE IF NOT EXISTS service_account_credentials (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        service_account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        capabilities JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        FOREIGN KEY (organization_id, service_account_id)
          REFERENCES service_accounts(organization_id, id)
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

  async bootstrapServiceAccount(input: BootstrapServiceAccountInput): Promise<void> {
    this.validateContext(input);
    if (!input.organizationId.trim()) throw new Error("ORGANIZATION_ID_REQUIRED");
    if (!input.organizationName.trim()) throw new Error("ORGANIZATION_NAME_REQUIRED");
    if (!input.serviceAccountId.trim()) throw new Error("SERVICE_ACCOUNT_ID_REQUIRED");
    if (!input.serviceAccountName.trim()) throw new Error("SERVICE_ACCOUNT_NAME_REQUIRED");
    if (input.credential.organizationId !== input.organizationId
      || input.credential.serviceAccountId !== input.serviceAccountId) {
      throw new Error("BOOTSTRAP_CREDENTIAL_PRINCIPAL_MISMATCH");
    }
    this.validateCredentialMaterial(input.credential, "SERVICE_CREDENTIAL");
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        "INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)",
        [input.organizationId, input.organizationName, input.occurredAt],
      );
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "organization",
        entityId: input.organizationId,
        action: "organization.created",
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
        payload: { name: input.organizationName },
      });
      await client.query(
        `INSERT INTO service_accounts
         (id, organization_id, name, role, created_at) VALUES ($1, $2, $3, 'admin', $4)`,
        [input.serviceAccountId, input.organizationId, input.serviceAccountName, input.occurredAt],
      );
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "service_account",
        entityId: input.serviceAccountId,
        action: "service_account.created",
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
        payload: { name: input.serviceAccountName, role: "admin" },
      });
      const record = input.credential;
      await client.query(
        `INSERT INTO service_account_credentials
         (id, organization_id, service_account_id, name, token_prefix, token_hash,
          capabilities, created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [
          record.id, record.organizationId, record.serviceAccountId, record.name,
          record.tokenPrefix, record.tokenHash, JSON.stringify(record.capabilities),
          record.createdAt, record.expiresAt, record.revokedAt,
        ],
      );
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "service_account_credential",
        entityId: record.id,
        action: "service_account_credential.issued",
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
        payload: {
          serviceAccountId: record.serviceAccountId,
          tokenPrefix: record.tokenPrefix,
          capabilities: record.capabilities,
          expiresAt: record.expiresAt,
        },
      });
    });
  }

  async addOrganizationUser(input: AddOrganizationUserInput): Promise<void> {
    this.validateContext(input);
    if (!input.id.trim()) throw new Error("ORGANIZATION_USER_ID_REQUIRED");
    if (!input.organizationId.trim()) throw new Error("ORGANIZATION_USER_ORGANIZATION_REQUIRED");
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("ORGANIZATION_USER_EMAIL_INVALID");
    if (!input.name.trim()) throw new Error("ORGANIZATION_USER_NAME_REQUIRED");
    if (!( ["owner", "admin", "operator", "viewer"] as const).includes(input.role)) {
      throw new Error("ORGANIZATION_USER_ROLE_INVALID");
    }
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO organization_users (id, email, name, created_at)
         VALUES ($1, $2, $3, $4)`,
        [input.id, email, input.name, input.occurredAt],
      );
      await client.query(
        `INSERT INTO organization_memberships
         (organization_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)`,
        [input.organizationId, input.id, input.role, input.occurredAt],
      );
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "organization_user",
        entityId: input.id,
        action: "organization_user.added",
        payload: { email, name: input.name, role: input.role },
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
      });
    });
  }

  async createServiceAccount(input: CreateServiceAccountInput): Promise<void> {
    this.validateContext(input);
    if (!input.id.trim()) throw new Error("SERVICE_ACCOUNT_ID_REQUIRED");
    if (!input.organizationId.trim()) throw new Error("SERVICE_ACCOUNT_ORGANIZATION_REQUIRED");
    if (!input.name.trim()) throw new Error("SERVICE_ACCOUNT_NAME_REQUIRED");
    if (!( ["admin", "operator", "viewer"] as const).includes(input.role)) {
      throw new Error("SERVICE_ACCOUNT_ROLE_INVALID");
    }
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO service_accounts
         (id, organization_id, name, role, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [input.id, input.organizationId, input.name, input.role, input.occurredAt],
      );
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "service_account",
        entityId: input.id,
        action: "service_account.created",
        payload: { name: input.name, role: input.role },
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
      });
    });
  }

  async issueServiceAccountCredential(
    record: ServiceAccountCredentialRecord,
    context: MutationContext,
  ): Promise<void> {
    this.validateContext(context);
    if (!record.id.trim()) throw new Error("SERVICE_CREDENTIAL_ID_REQUIRED");
    if (!record.organizationId.trim()) throw new Error("SERVICE_CREDENTIAL_ORGANIZATION_REQUIRED");
    if (!record.serviceAccountId.trim()) throw new Error("SERVICE_CREDENTIAL_ACCOUNT_REQUIRED");
    if (!record.name.trim()) throw new Error("SERVICE_CREDENTIAL_NAME_REQUIRED");
    this.validateCredentialMaterial(record, "SERVICE_CREDENTIAL");
    await this.ensureSchema();
    await this.transaction(async (client) => {
      const accountResult = await client.query<{ role: ServiceAccountRole }>(
        `SELECT role FROM service_accounts
         WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [record.organizationId, record.serviceAccountId],
      );
      const role = accountResult.rows[0]?.role;
      if (!role) throw new Error("SERVICE_ACCOUNT_NOT_ACTIVE");
      if (!serviceAccountRoleAllowsCapabilities(role, record.capabilities)) {
        throw new Error("SERVICE_CREDENTIAL_CAPABILITY_FOR_ROLE");
      }
      await client.query(
        `INSERT INTO service_account_credentials
         (id, organization_id, service_account_id, name, token_prefix, token_hash,
          capabilities, created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [
          record.id,
          record.organizationId,
          record.serviceAccountId,
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
        entityType: "service_account_credential",
        entityId: record.id,
        action: "service_account_credential.issued",
        actorId: context.actorId,
        causationId: context.causationId,
        occurredAt: context.occurredAt,
        payload: {
          serviceAccountId: record.serviceAccountId,
          tokenPrefix: record.tokenPrefix,
          capabilities: record.capabilities,
          expiresAt: record.expiresAt,
        },
      });
    });
  }

  async revokeServiceAccountCredential(
    organizationId: string,
    credentialId: string,
    context: MutationContext,
  ): Promise<void> {
    this.validateContext(context);
    if (!organizationId.trim()) throw new Error("SERVICE_CREDENTIAL_ORGANIZATION_REQUIRED");
    if (!credentialId.trim()) throw new Error("SERVICE_CREDENTIAL_ID_REQUIRED");
    await this.ensureSchema();
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE service_account_credentials SET revoked_at = $3
         WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [organizationId, credentialId, context.occurredAt],
      );
      if (result.rowCount !== 1) throw new Error("SERVICE_CREDENTIAL_NOT_ACTIVE");
      await this.appendAudit(client, {
        organizationId,
        entityType: "service_account_credential",
        entityId: credentialId,
        action: "service_account_credential.revoked",
        payload: {},
        ...context,
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
    principalType: "agent" | "service_account";
    principalId: string;
    organizationId: string;
    credentialId: string;
    capabilities: ApiCapability[];
    role?: ServiceAccountRole;
  } | null> {
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new Error("AUTHENTICATION_TIME_INVALID");
    await this.ensureSchema();
    const tokenHash = hashApiToken(token);
    const agentResult = await this.pool.query<{
      id: string;
      organization_id: string;
      principal_id: string;
      token_hash: string;
      capabilities: ApiCapability[];
      expires_at: Date | null;
      revoked_at: Date | null;
      principal_revoked_at: Date | null;
      principal_status: "active" | "revoked";
    }>(
      `SELECT credentials.id, credentials.organization_id,
              credentials.agent_id AS principal_id, credentials.token_hash,
              credentials.capabilities, credentials.expires_at, credentials.revoked_at,
              agents.revoked_at AS principal_revoked_at, agents.status AS principal_status
       FROM api_credentials credentials
       JOIN agent_identities agents
         ON agents.organization_id = credentials.organization_id
        AND agents.id = credentials.agent_id
       WHERE credentials.token_hash = $1`,
      [tokenHash],
    );
    const agent = agentResult.rows[0];
    if (agent && tokenMatchesHash(token, agent.token_hash)
      && !agent.revoked_at && !agent.principal_revoked_at
      && agent.principal_status === "active"
      && (!agent.expires_at || agent.expires_at.getTime() > nowMs)) {
      return {
        principalType: "agent",
        principalId: agent.principal_id,
        organizationId: agent.organization_id,
        credentialId: agent.id,
        capabilities: agent.capabilities,
      };
    }

    const serviceResult = await this.pool.query<{
      id: string;
      organization_id: string;
      principal_id: string;
      token_hash: string;
      capabilities: ApiCapability[];
      expires_at: Date | null;
      revoked_at: Date | null;
      principal_revoked_at: Date | null;
      principal_role: ServiceAccountRole;
    }>(
      `SELECT credentials.id, credentials.organization_id,
              credentials.service_account_id AS principal_id, credentials.token_hash,
              credentials.capabilities, credentials.expires_at, credentials.revoked_at,
              accounts.revoked_at AS principal_revoked_at, accounts.role AS principal_role
       FROM service_account_credentials credentials
       JOIN service_accounts accounts
         ON accounts.organization_id = credentials.organization_id
        AND accounts.id = credentials.service_account_id
       WHERE credentials.token_hash = $1`,
      [tokenHash],
    );
    const service = serviceResult.rows[0];
    if (!service || !tokenMatchesHash(token, service.token_hash)) return null;
    if (service.revoked_at || service.principal_revoked_at) return null;
    if (service.expires_at && service.expires_at.getTime() <= nowMs) return null;
    if (!serviceAccountRoleAllowsCapabilities(service.principal_role, service.capabilities)) return null;
    return {
      principalType: "service_account",
      principalId: service.principal_id,
      organizationId: service.organization_id,
      credentialId: service.id,
      capabilities: service.capabilities,
      role: service.principal_role,
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

  private validateCredentialMaterial(
    record: {
      tokenPrefix: string;
      tokenHash: string;
      capabilities: ApiCapability[];
      createdAt: string;
      expiresAt: string | null;
      revokedAt: string | null;
    },
    errorPrefix: "SERVICE_CREDENTIAL",
  ): void {
    if (!/^fuse_sk_[A-Za-z0-9_-]{12}$/.test(record.tokenPrefix)) {
      throw new Error(`${errorPrefix}_PREFIX_INVALID`);
    }
    if (!/^[a-f0-9]{64}$/.test(record.tokenHash)) throw new Error(`${errorPrefix}_HASH_INVALID`);
    const createdAt = Date.parse(record.createdAt);
    if (Number.isNaN(createdAt)) throw new Error(`${errorPrefix}_CREATED_AT_INVALID`);
    if (record.expiresAt !== null) {
      const expiresAt = Date.parse(record.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt <= createdAt) {
        throw new Error(`${errorPrefix}_EXPIRY_INVALID`);
      }
    }
    if (record.revokedAt !== null) throw new Error(`${errorPrefix}_ALREADY_REVOKED`);
    if (new Set(record.capabilities).size !== record.capabilities.length) {
      throw new Error(`${errorPrefix}_CAPABILITY_DUPLICATE`);
    }
    if (record.capabilities.length === 0 || record.capabilities.some(
      (capability) => !API_CAPABILITIES.includes(capability),
    )) throw new Error(`${errorPrefix}_CAPABILITY_INVALID`);
  }

  private validateContext(input: MutationContext): void {
    if (!input.actorId.trim()) throw new Error("IDENTITY_ACTOR_REQUIRED");
    if (!input.causationId.trim()) throw new Error("IDENTITY_CAUSATION_REQUIRED");
    if (Number.isNaN(Date.parse(input.occurredAt))) throw new Error("IDENTITY_OCCURRED_AT_INVALID");
  }
}
