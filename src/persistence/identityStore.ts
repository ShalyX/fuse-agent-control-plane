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
export type WorkspaceInviteRole = "admin" | "operator" | "viewer";

export interface AddOrganizationUserInput extends MutationContext {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: OrganizationRole;
}

export interface CreateWorkspaceInviteInput extends MutationContext {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: WorkspaceInviteRole;
  sourceCredentialId: string;
  sourceCredentialType: "service_account";
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceInviteSummary {
  inviteId: string;
  workspaceId: string;
  email: string;
  name: string;
  role: WorkspaceInviteRole;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface ConsumedWorkspaceInvite {
  workspaceId: string;
  userId: string;
  role: WorkspaceInviteRole;
  sourceCredentialId: string;
  sourceCredentialType: "service_account";
  expiresAt: string;
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

export interface RotateAgentCredentialWithRecoveryInput extends MutationContext {
  workspaceId: string;
  recoveryCodeHash: string;
  recoveryDeliveryId: string;
  recoveryDeliveryEnvelope: string;
  replacement: ApiCredentialRecord;
}

export interface AgentIdentity {
  id: string;
  organizationId: string;
  name: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
}

export interface AgentCredentialSummary {
  id: string;
  organizationId: string;
  agentId: string;
  name: string;
  tokenPrefix: string;
  capabilities: ApiCapability[];
  createdAt: string;
  expiresAt: string | null;
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
    const existingTables = await this.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN (
         'service_accounts', 'agent_identities', 'service_account_credentials', 'api_credentials'
       )`,
    );
    const legacyTables = new Set(existingTables.rows.map((row) => row.table_name));
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS identity_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      )
    `);
    const schemaSql = `
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
      CREATE TABLE IF NOT EXISTS workspace_invites (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        source_credential_id TEXT NOT NULL,
        source_credential_type TEXT NOT NULL DEFAULT 'service_account'
          CHECK (source_credential_type = 'service_account'),
        token_hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        user_id TEXT REFERENCES organization_users(id),
        accepted_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS workspace_invites_organization_idx
        ON workspace_invites (organization_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS service_accounts (
        id TEXT NOT NULL,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (organization_id, id)
      );
      CREATE TABLE IF NOT EXISTS agent_identities (
        id TEXT NOT NULL,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (organization_id, id)
      );
      CREATE TABLE IF NOT EXISTS service_account_credentials (
        id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        service_account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        capabilities JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (organization_id, id),
        FOREIGN KEY (organization_id, service_account_id)
          REFERENCES service_accounts(organization_id, id)
      );
      CREATE TABLE IF NOT EXISTS api_credentials (
        id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        capabilities JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        PRIMARY KEY (organization_id, id),
        FOREIGN KEY (organization_id, agent_id)
          REFERENCES agent_identities(organization_id, id)
      );
    `;
    await this.migrateTenantLocalKeys(legacyTables, schemaSql);
    await this.migrateWorkspaceInvites();
  }

  private async migrateWorkspaceInvites(): Promise<void> {
    await this.transaction(async (client) => {
      const claimed = await client.query(
        `INSERT INTO identity_schema_migrations (version, applied_at)
         VALUES (2, CURRENT_TIMESTAMP)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
      );
      if (claimed.rowCount === 0) return;
      const existingInviteTable = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'workspace_invites'`,
      );
      if (existingInviteTable.rows.length > 0) return;
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_invites (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          email TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
          source_credential_id TEXT NOT NULL,
          source_credential_type TEXT NOT NULL DEFAULT 'service_account'
            CHECK (source_credential_type = 'service_account'),
          token_hash TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          user_id TEXT REFERENCES organization_users(id),
          accepted_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS workspace_invites_organization_idx
          ON workspace_invites (organization_id, created_at DESC);
      `);
    });
  }

  private async migrateTenantLocalKeys(
    legacyTables: ReadonlySet<string>,
    schemaSql: string,
  ): Promise<void> {
    const tables = [
      "service_accounts",
      "agent_identities",
      "service_account_credentials",
      "api_credentials",
    ] as const;
    await this.transaction(async (client) => {
      const claimed = await client.query(
        `INSERT INTO identity_schema_migrations (version, applied_at)
         VALUES (1, CURRENT_TIMESTAMP)
         ON CONFLICT (version) DO NOTHING
         RETURNING version`,
      );
      if (claimed.rowCount === 0) return;
      await client.query(schemaSql);
      for (const table of tables) {
        if (!legacyTables.has(table)) continue;
        await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);
        await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (organization_id, id)`);
      }
    });
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

  async createWorkspaceInvite(input: CreateWorkspaceInviteInput): Promise<void> {
    this.validateContext(input);
    if (!input.id.trim()) throw new Error("WORKSPACE_INVITE_ID_REQUIRED");
    if (!input.organizationId.trim()) throw new Error("WORKSPACE_INVITE_ORGANIZATION_REQUIRED");
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("WORKSPACE_INVITE_EMAIL_INVALID");
    if (!input.name.trim()) throw new Error("WORKSPACE_INVITE_NAME_REQUIRED");
    if (!( ["admin", "operator", "viewer"] as const).includes(input.role)) {
      throw new Error("WORKSPACE_INVITE_ROLE_INVALID");
    }
    if (!input.sourceCredentialId.trim()) throw new Error("WORKSPACE_INVITE_SOURCE_REQUIRED");
    if (!/^[a-f0-9]{64}$/.test(input.tokenHash)) throw new Error("WORKSPACE_INVITE_HASH_INVALID");
    const createdAt = Date.parse(input.createdAt);
    const expiresAt = Date.parse(input.expiresAt);
    if (Number.isNaN(createdAt) || Number.isNaN(expiresAt) || expiresAt <= createdAt) {
      throw new Error("WORKSPACE_INVITE_TIME_INVALID");
    }
    await this.ensureSchema();
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO workspace_invites
         (id, organization_id, email, name, role, source_credential_id,
          source_credential_type, token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [input.id, input.organizationId, email, input.name.trim(), input.role,
          input.sourceCredentialId, input.sourceCredentialType, input.tokenHash,
          input.createdAt, input.expiresAt],
      );
      await this.appendAudit(client, {
        organizationId: input.organizationId,
        entityType: "workspace_invite",
        entityId: input.id,
        action: "workspace_invite.created",
        payload: { email, name: input.name.trim(), role: input.role, expiresAt: input.expiresAt },
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
      });
    });
  }

  async listWorkspaceInvites(organizationId: string): Promise<WorkspaceInviteSummary[]> {
    if (!organizationId.trim()) throw new Error("WORKSPACE_INVITE_ORGANIZATION_REQUIRED");
    await this.ensureSchema();
    const result = await this.pool.query<{
      id: string;
      organization_id: string;
      email: string;
      name: string;
      role: WorkspaceInviteRole;
      created_at: Date;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, organization_id, email, name, role, created_at, expires_at,
              accepted_at, revoked_at
         FROM workspace_invites
        WHERE organization_id = $1
        ORDER BY created_at DESC, id DESC`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      inviteId: row.id,
      workspaceId: row.organization_id,
      email: row.email,
      name: row.name,
      role: row.role,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      acceptedAt: row.accepted_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
    }));
  }

  async revokeWorkspaceInvite(
    organizationId: string,
    inviteId: string,
    context: MutationContext,
  ): Promise<boolean> {
    this.validateContext(context);
    if (!organizationId.trim()) throw new Error("WORKSPACE_INVITE_ORGANIZATION_REQUIRED");
    if (!inviteId.trim()) throw new Error("WORKSPACE_INVITE_ID_REQUIRED");
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const revoked = await client.query<{ id: string }>(
        `UPDATE workspace_invites
            SET revoked_at = $3
          WHERE organization_id = $1 AND id = $2
            AND accepted_at IS NULL AND revoked_at IS NULL
          RETURNING id`,
        [organizationId, inviteId, context.occurredAt],
      );
      if (!revoked.rows[0]) return false;
      await this.appendAudit(client, {
        organizationId,
        entityType: "workspace_invite",
        entityId: inviteId,
        action: "workspace_invite.revoked",
        payload: {},
        ...context,
      });
      return true;
    });
  }

  async consumeWorkspaceInvite(tokenHash: string, now: string): Promise<ConsumedWorkspaceInvite | null> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error("WORKSPACE_INVITE_HASH_INVALID");
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new Error("WORKSPACE_INVITE_TIME_INVALID");
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const inviteResult = await client.query<{
        id: string;
        organization_id: string;
        email: string;
        name: string;
        role: WorkspaceInviteRole;
        source_credential_id: string;
        source_credential_type: "service_account";
        expires_at: Date;
      }>(
        `SELECT id, organization_id, email, name, role, source_credential_id,
                source_credential_type, expires_at
           FROM workspace_invites
          WHERE token_hash = $1
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > $2
          FOR UPDATE`,
        [tokenHash, new Date(nowMs)],
      );
      const invite = inviteResult.rows[0];
      if (!invite) return null;

      const existingUser = await client.query<{ id: string }>(
        "SELECT id FROM organization_users WHERE email = $1",
        [invite.email],
      );
      const userId = existingUser.rows[0]?.id ?? `usr_${randomUUID().replaceAll("-", "")}`;
      if (!existingUser.rows[0]) {
        await client.query(
          `INSERT INTO organization_users (id, email, name, created_at)
           VALUES ($1, $2, $3, $4)`,
          [userId, invite.email, invite.name, now],
        );
      }
      await client.query(
        `INSERT INTO organization_memberships
         (organization_id, user_id, role, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, user_id) DO UPDATE SET
           role = EXCLUDED.role, revoked_at = NULL`,
        [invite.organization_id, userId, invite.role, now],
      );
      await client.query(
        `UPDATE workspace_invites SET user_id = $2, accepted_at = $3
          WHERE id = $1`,
        [invite.id, userId, now],
      );
      await this.appendAudit(client, {
        organizationId: invite.organization_id,
        entityType: "workspace_invite",
        entityId: invite.id,
        action: "workspace_invite.accepted",
        payload: { userId, email: invite.email, role: invite.role },
        actorId: `organization_user:${userId}`,
        causationId: invite.id,
        occurredAt: now,
      });
      return {
        workspaceId: invite.organization_id,
        userId,
        role: invite.role,
        sourceCredentialId: invite.source_credential_id,
        sourceCredentialType: invite.source_credential_type,
        expiresAt: new Date(invite.expires_at).toISOString(),
      };
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

  async rotateAgentCredentialWithRecovery(
    input: RotateAgentCredentialWithRecoveryInput,
  ): Promise<{ agentId: string; previousCredentialId: string }> {
    this.validateContext(input);
    if (!input.workspaceId.trim()) throw new Error("WORKSPACE_ID_REQUIRED");
    if (!/^[a-f0-9]{64}$/.test(input.recoveryCodeHash)) throw new Error("RECOVERY_CODE_HASH_INVALID");
    const record = input.replacement;
    if (record.organizationId !== input.workspaceId) throw new Error("RECOVERY_CREDENTIAL_WORKSPACE_MISMATCH");
    if (!record.id.trim()) throw new Error("API_CREDENTIAL_ID_REQUIRED");
    if (!record.agentId.trim()) throw new Error("API_CREDENTIAL_AGENT_REQUIRED");
    if (!record.name.trim()) throw new Error("API_CREDENTIAL_NAME_REQUIRED");
    if (!/^fuse_sk_[A-Za-z0-9_-]{12}$/.test(record.tokenPrefix)) throw new Error("API_CREDENTIAL_PREFIX_INVALID");
    if (!/^[a-f0-9]{64}$/.test(record.tokenHash)) throw new Error("API_CREDENTIAL_HASH_INVALID");
    const createdAt = Date.parse(record.createdAt);
    if (Number.isNaN(createdAt)) throw new Error("API_CREDENTIAL_CREATED_AT_INVALID");
    if (record.expiresAt !== null) {
      const expiresAt = Date.parse(record.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt <= createdAt) throw new Error("API_CREDENTIAL_EXPIRY_INVALID");
    }
    if (record.revokedAt !== null) throw new Error("API_CREDENTIAL_ALREADY_REVOKED");
    if (new Set(record.capabilities).size !== record.capabilities.length) {
      throw new Error("API_CREDENTIAL_CAPABILITY_DUPLICATE");
    }
    if (record.capabilities.length === 0 || record.capabilities.some(
      (capability) => !API_CAPABILITIES.includes(capability),
    )) throw new Error("API_CREDENTIAL_CAPABILITY_INVALID");
    await this.ensureSchema();

    return this.transaction(async (client) => {
      const recovery = await client.query<{ identifiers: Record<string, string> }>(
        `SELECT identifiers
           FROM fuse_workspace_onboarding_operations
          WHERE identifiers->>'workspaceId' = $1
            AND recovery_code_hash = $2
            AND status = 'completed'
            AND recovery_consumed_at IS NULL
          FOR UPDATE`,
        [input.workspaceId, input.recoveryCodeHash],
      );
      const identifiers = recovery.rows[0]?.identifiers;
      const agentId = identifiers?.agentId;
      const previousCredentialId = identifiers?.agentCredentialId;
      if (!agentId || !previousCredentialId) throw new Error("CREDENTIAL_RECOVERY_INVALID");
      if (record.agentId !== agentId) throw new Error("RECOVERY_CREDENTIAL_AGENT_MISMATCH");
      if (record.id === previousCredentialId) throw new Error("RECOVERY_CREDENTIAL_ID_CONFLICT");

      const consumed = await client.query(
        `UPDATE fuse_workspace_onboarding_operations
            SET recovery_code_hash = NULL, recovery_consumed_hash = $2,
                recovery_consumed_at = $3, recovery_delivery_envelope = $4,
                recovery_delivery_id = $5
          WHERE identifiers->>'workspaceId' = $1
            AND recovery_code_hash = $2
            AND status = 'completed'
            AND recovery_consumed_at IS NULL`,
        [input.workspaceId, input.recoveryCodeHash, input.occurredAt,
          input.recoveryDeliveryEnvelope, input.recoveryDeliveryId],
      );
      if (consumed.rowCount !== 1) throw new Error("CREDENTIAL_RECOVERY_INVALID");

      await client.query(
        `INSERT INTO api_credentials
         (id, organization_id, agent_id, name, token_prefix, token_hash, capabilities,
          created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NULL)`,
        [record.id, record.organizationId, record.agentId, record.name, record.tokenPrefix,
          record.tokenHash, JSON.stringify(record.capabilities), record.createdAt, record.expiresAt],
      );
      await this.appendAudit(client, {
        organizationId: record.organizationId,
        entityType: "api_credential",
        entityId: record.id,
        action: "credential.issued",
        payload: {
          agentId: record.agentId, tokenPrefix: record.tokenPrefix,
          capabilities: record.capabilities, expiresAt: record.expiresAt, recovery: true,
        },
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
      });
      const revoked = await client.query(
        `UPDATE api_credentials SET revoked_at = $3
          WHERE organization_id = $1 AND id = $2 AND agent_id = $4 AND revoked_at IS NULL`,
        [input.workspaceId, previousCredentialId, input.occurredAt, agentId],
      );
      if (revoked.rowCount !== 1) throw new Error("API_CREDENTIAL_NOT_ACTIVE");
      await this.appendAudit(client, {
        organizationId: input.workspaceId,
        entityType: "api_credential",
        entityId: previousCredentialId,
        action: "credential.revoked",
        payload: { recovery: true, replacementCredentialId: record.id },
        actorId: input.actorId,
        causationId: input.causationId,
        occurredAt: input.occurredAt,
      });
      return { agentId, previousCredentialId };
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

  async isCredentialActive(
    organizationId: string,
    credentialId: string,
    credentialType: "agent" | "service_account",
    now: string,
  ): Promise<boolean> {
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new Error("AUTHENTICATION_TIME_INVALID");
    await this.ensureSchema();
    const query = credentialType === "agent"
      ? `SELECT 1
         FROM api_credentials credentials
         JOIN agent_identities principals
           ON principals.organization_id = credentials.organization_id
          AND principals.id = credentials.agent_id
         WHERE credentials.organization_id = $1 AND credentials.id = $2
           AND credentials.revoked_at IS NULL AND principals.revoked_at IS NULL
           AND principals.status = 'active'
           AND (credentials.expires_at IS NULL OR credentials.expires_at > $3)
         LIMIT 1`
      : `SELECT 1
         FROM service_account_credentials credentials
         JOIN service_accounts principals
           ON principals.organization_id = credentials.organization_id
          AND principals.id = credentials.service_account_id
         WHERE credentials.organization_id = $1 AND credentials.id = $2
           AND credentials.revoked_at IS NULL AND principals.revoked_at IS NULL
           AND (credentials.expires_at IS NULL OR credentials.expires_at > $3)
         LIMIT 1`;
    const result = await this.pool.query(
      query,
      [organizationId, credentialId, new Date(nowMs)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async hasExecutableAgentCredential(organizationId: string, now: string): Promise<boolean> {
    if (!organizationId.trim()) throw new Error("ORGANIZATION_ID_REQUIRED");
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new Error("CREDENTIAL_CHECK_TIME_INVALID");
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT 1
       FROM agent_identities agents
       JOIN api_credentials credentials
         ON credentials.organization_id = agents.organization_id
        AND credentials.agent_id = agents.id
       WHERE agents.organization_id = $1
         AND agents.status = 'active'
         AND agents.revoked_at IS NULL
         AND credentials.revoked_at IS NULL
         AND (credentials.expires_at IS NULL OR credentials.expires_at > $2)
         AND credentials.capabilities @> '["inference:invoke"]'::jsonb
       LIMIT 1`,
      [organizationId, new Date(nowMs)],
    );
    return (result.rowCount ?? 0) > 0;
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

  async listAgentDirectory(organizationId: string): Promise<{
    agents: AgentIdentity[];
    credentials: AgentCredentialSummary[];
  }> {
    if (!organizationId.trim()) throw new Error("ORGANIZATION_ID_REQUIRED");
    await this.ensureSchema();
    const [agentsResult, credentialsResult] = await Promise.all([
      this.pool.query<{
        id: string;
        organization_id: string;
        name: string;
        status: "active" | "revoked";
        created_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT id, organization_id, name, status, created_at, revoked_at
           FROM agent_identities
          WHERE organization_id = $1
          ORDER BY created_at DESC, id DESC`,
        [organizationId],
      ),
      this.pool.query<{
        id: string;
        organization_id: string;
        agent_id: string;
        name: string;
        token_prefix: string;
        capabilities: ApiCapability[];
        created_at: Date;
        expires_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT id, organization_id, agent_id, name, token_prefix, capabilities,
                created_at, expires_at, revoked_at
           FROM api_credentials
          WHERE organization_id = $1
          ORDER BY created_at DESC, id DESC`,
        [organizationId],
      ),
    ]);
    return {
      agents: agentsResult.rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        name: row.name,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
      })),
      credentials: credentialsResult.rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        agentId: row.agent_id,
        name: row.name,
        tokenPrefix: row.token_prefix,
        capabilities: row.capabilities,
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: row.expires_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
      })),
    };
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
