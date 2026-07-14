import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { createApiCredential, createServiceAccountCredential } from "../src/identity/apiCredentials.js";
import { ProductionFoundationStore } from "../src/persistence/productionFoundation.js";
import { PolicyStore } from "../src/persistence/policyStore.js";

async function createStores() {
  const db = newDb();
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const audit = new ProductionFoundationStore(pool);
  const identity = new IdentityStore(pool);
  await identity.ensureSchema();
  return { pool, audit, identity };
}

const context = {
  actorId: "user:founder",
  causationId: "request:onboard-1",
  occurredAt: "2026-07-13T17:00:00.000Z",
};

describe("IdentityStore", () => {
  it("initializes a clean identity and audit schema before mutations", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const identity = new IdentityStore(pool);
    const audit = new ProductionFoundationStore(pool);

    await identity.createOrganization({ id: "org-clean", name: "Clean Org", ...context });

    expect((await pool.query("SELECT id FROM organizations")).rows).toEqual([{ id: "org-clean" }]);
    expect((await audit.listAuditEvents("org-clean", "organization", "org-clean"))[0]?.action)
      .toBe("organization.created");
    await pool.end();
  });

  it("serializes concurrent identity schema initialization", async () => {
    const db = newDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    await Promise.all([
      new IdentityStore(pool).ensureSchema(),
      new IdentityStore(pool).ensureSchema(),
    ]);
    expect((await pool.query("SELECT version FROM identity_schema_migrations")).rows)
      .toEqual([{ version: 1 }]);
    await pool.end();
  });

  it("migrates legacy global identity keys before policy initialization", async () => {
    const db = newDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    await pool.query(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE service_accounts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        UNIQUE (organization_id, id)
      );
      CREATE TABLE agent_identities (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        UNIQUE (organization_id, id)
      );
      CREATE TABLE service_account_credentials (
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
      CREATE TABLE api_credentials (
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
      INSERT INTO organizations VALUES ('org-1', 'One', '2026-07-13T17:00:00.000Z');
      INSERT INTO service_accounts VALUES (
        'shared-service', 'org-1', 'First service', 'admin', '2026-07-13T17:00:00.000Z', NULL
      );
      INSERT INTO agent_identities VALUES (
        'shared-agent', 'org-1', 'First agent', 'active', '2026-07-13T17:00:00.000Z', NULL
      );
      INSERT INTO service_account_credentials VALUES (
        'shared-service-credential', 'org-1', 'shared-service', 'First service credential',
        'fsa_old', 'old-service-hash', '["credentials:issue"]',
        '2026-07-13T17:00:00.000Z', NULL, NULL
      );
      INSERT INTO api_credentials VALUES (
        'shared-agent-credential', 'org-1', 'shared-agent', 'First agent credential',
        'fag_old', 'old-agent-hash', '["inference:invoke"]',
        '2026-07-13T17:00:00.000Z', NULL, NULL
      );
    `);

    const identity = new IdentityStore(pool);
    await identity.ensureSchema();
    await new PolicyStore(pool).ensureSchema();
    await identity.createOrganization({ id: "org-2", name: "Two", ...context });
    await identity.createServiceAccount({
      id: "shared-service", organizationId: "org-2", name: "Second service", role: "admin", ...context,
    });
    await identity.registerAgent({
      id: "shared-agent", organizationId: "org-2", name: "Second agent", ...context,
    });
    const serviceCredential = createServiceAccountCredential({
      id: "shared-service-credential",
      organizationId: "org-2",
      serviceAccountId: "shared-service",
      name: "Second service credential",
      capabilities: ["credentials:issue"],
      createdAt: context.occurredAt,
    }, () => Buffer.alloc(32, 21));
    await identity.issueServiceAccountCredential(serviceCredential.record, context);
    const agentCredential = createApiCredential({
      id: "shared-agent-credential",
      organizationId: "org-2",
      agentId: "shared-agent",
      name: "Second agent credential",
      capabilities: ["inference:invoke"],
      createdAt: context.occurredAt,
    }, () => Buffer.alloc(32, 22));
    await identity.issueCredential(agentCredential.record, context);

    expect((await pool.query(
      "SELECT organization_id, id FROM agent_identities WHERE id = 'shared-agent' ORDER BY organization_id",
    )).rows).toEqual([
      { organization_id: "org-1", id: "shared-agent" },
      { organization_id: "org-2", id: "shared-agent" },
    ]);
    expect((await pool.query(
      "SELECT organization_id, id FROM service_accounts WHERE id = 'shared-service' ORDER BY organization_id",
    )).rows).toEqual([
      { organization_id: "org-1", id: "shared-service" },
      { organization_id: "org-2", id: "shared-service" },
    ]);
    expect((await pool.query(
      `SELECT organization_id, id FROM service_account_credentials
       WHERE id = 'shared-service-credential' ORDER BY organization_id`,
    )).rows).toEqual([
      { organization_id: "org-1", id: "shared-service-credential" },
      { organization_id: "org-2", id: "shared-service-credential" },
    ]);
    expect((await pool.query(
      `SELECT organization_id, id FROM api_credentials
       WHERE id = 'shared-agent-credential' ORDER BY organization_id`,
    )).rows).toEqual([
      { organization_id: "org-1", id: "shared-agent-credential" },
      { organization_id: "org-2", id: "shared-agent-credential" },
    ]);
    expect((await pool.query("SELECT version FROM identity_schema_migrations")).rows)
      .toEqual([{ version: 1 }]);
    await pool.end();
  });

  it("bootstraps an organization, admin service account, and credential atomically", async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const identity = new IdentityStore(pool);
    const issued = createServiceAccountCredential({
      id: "bootstrap-cred-1", organizationId: "org-1", serviceAccountId: "service-1",
      name: "bootstrap", capabilities: ["credentials:issue", "credentials:revoke"],
      createdAt: context.occurredAt,
    }, () => Buffer.alloc(32, 15));

    await identity.bootstrapServiceAccount({
      organizationId: "org-1",
      organizationName: "Acme",
      serviceAccountId: "service-1",
      serviceAccountName: "Provisioner",
      credential: issued.record,
      ...context,
    });

    expect((await pool.query("SELECT id FROM organizations")).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM service_accounts")).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM service_account_credentials")).rowCount).toBe(1);
    await pool.end();
  });

  it("creates organization users, memberships, and service accounts with tenant audit events", async () => {
    const { pool, audit, identity } = await createStores();
    await identity.createOrganization({ id: "org-1", name: "Acme", ...context });

    await identity.addOrganizationUser({
      id: "user-1",
      organizationId: "org-1",
      email: " OWNER@Example.com ",
      name: "Owner",
      role: "owner",
      ...context,
    });
    await identity.createServiceAccount({
      id: "service-1",
      organizationId: "org-1",
      name: "Provisioner",
      role: "admin",
      ...context,
    });

    expect((await pool.query("SELECT id, email FROM organization_users")).rows)
      .toEqual([{ id: "user-1", email: "owner@example.com" }]);
    expect((await pool.query("SELECT organization_id, user_id, role FROM organization_memberships")).rows)
      .toEqual([{ organization_id: "org-1", user_id: "user-1", role: "owner" }]);
    expect((await pool.query("SELECT organization_id, id, role FROM service_accounts")).rows)
      .toEqual([{ organization_id: "org-1", id: "service-1", role: "admin" }]);
    expect((await audit.listAuditEvents("org-1", "organization_user", "user-1")).map((event) => event.action))
      .toEqual(["organization_user.added"]);
    expect((await audit.listAuditEvents("org-1", "service_account", "service-1")).map((event) => event.action))
      .toEqual(["service_account.created"]);
    await pool.end();
  });

  it("issues a scoped service-account credential and authenticates its principal context", async () => {
    const { pool, identity } = await createStores();
    await identity.createOrganization({ id: "org-1", name: "Acme", ...context });
    await identity.createServiceAccount({
      id: "service-1",
      organizationId: "org-1",
      name: "Provisioner",
      role: "admin",
      ...context,
    });
    const issued = createServiceAccountCredential({
      id: "service-cred-1",
      organizationId: "org-1",
      serviceAccountId: "service-1",
      name: "provisioning",
      capabilities: ["credentials:issue", "credentials:revoke"],
      createdAt: context.occurredAt,
      expiresAt: "2026-08-13T17:00:00.000Z",
    }, () => Buffer.alloc(32, 11));

    await identity.issueServiceAccountCredential(issued.record, context);

    expect(await identity.authenticateToken(issued.token, "2026-07-14T00:00:00.000Z")).toEqual({
      principalType: "service_account",
      principalId: "service-1",
      organizationId: "org-1",
      credentialId: "service-cred-1",
      capabilities: ["credentials:issue", "credentials:revoke"],
      role: "admin",
    });
    expect((await pool.query("SELECT token_hash FROM service_account_credentials")).rows[0])
      .not.toHaveProperty("token");
    await pool.end();
  });

  it("enforces service-account role ceilings and supports credential revocation", async () => {
    const { pool, identity } = await createStores();
    await identity.createOrganization({ id: "org-1", name: "Acme", ...context });
    await identity.createServiceAccount({
      id: "viewer-1", organizationId: "org-1", name: "Read only", role: "viewer", ...context,
    });
    const excessive = createServiceAccountCredential({
      id: "service-cred-bad", organizationId: "org-1", serviceAccountId: "viewer-1",
      name: "bad", capabilities: ["credentials:issue"], createdAt: context.occurredAt,
    }, () => Buffer.alloc(32, 10));
    await expect(identity.issueServiceAccountCredential(excessive.record, context))
      .rejects.toThrow("SERVICE_CREDENTIAL_CAPABILITY_FOR_ROLE");
    await pool.query(
      `INSERT INTO service_account_credentials
       (id, organization_id, service_account_id, name, token_prefix, token_hash,
        capabilities, created_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [
        excessive.record.id, excessive.record.organizationId, excessive.record.serviceAccountId,
        excessive.record.name, excessive.record.tokenPrefix, excessive.record.tokenHash,
        JSON.stringify(excessive.record.capabilities), excessive.record.createdAt, null, null,
      ],
    );
    expect(await identity.authenticateToken(excessive.token, "2026-07-14T00:00:00.000Z")).toBeNull();

    const allowed = createServiceAccountCredential({
      id: "service-cred-view", organizationId: "org-1", serviceAccountId: "viewer-1",
      name: "viewer", capabilities: ["receipts:read"], createdAt: context.occurredAt,
    }, () => Buffer.alloc(32, 11));
    await identity.issueServiceAccountCredential(allowed.record, context);
    expect(await identity.authenticateToken(allowed.token, "2026-07-14T00:00:00.000Z"))
      .toMatchObject({ principalType: "service_account", role: "viewer" });
    await identity.revokeServiceAccountCredential("org-1", "service-cred-view", {
      ...context, causationId: "request:revoke-service",
    });
    expect(await identity.authenticateToken(allowed.token, "2026-07-14T00:00:00.000Z")).toBeNull();
    await pool.end();
  });

  it("creates an organization and agent identity with durable audit events", async () => {
    const { pool, audit, identity } = await createStores();

    await identity.createOrganization({ id: "org-1", name: "Acme Agents", ...context });
    await identity.registerAgent({
      id: "agent-1",
      organizationId: "org-1",
      name: "Scout",
      ...context,
      causationId: "request:agent-1",
    });

    expect(await identity.getAgent("org-1", "agent-1")).toEqual({
      id: "agent-1",
      organizationId: "org-1",
      name: "Scout",
      status: "active",
      createdAt: context.occurredAt,
      revokedAt: null,
    });
    expect((await audit.listAuditEvents("org-1", "organization", "org-1")).map((event) => event.action))
      .toEqual(["organization.created"]);
    expect((await audit.listAuditEvents("org-1", "agent_identity", "agent-1")).map((event) => event.action))
      .toEqual(["agent.registered"]);

    await pool.end();
  });

  it("issues and authenticates a scoped agent credential without storing the raw token", async () => {
    const { pool, identity } = await createStores();
    await identity.createOrganization({ id: "org-1", name: "Acme Agents", ...context });
    await identity.registerAgent({
      id: "agent-1",
      organizationId: "org-1",
      name: "Scout",
      ...context,
      causationId: "request:agent-1",
    });
    const issued = createApiCredential({
      id: "cred-1",
      organizationId: "org-1",
      agentId: "agent-1",
      name: "Scout runtime",
      capabilities: ["inference:invoke", "receipts:read"],
      createdAt: context.occurredAt,
      expiresAt: "2026-08-13T17:00:00.000Z",
    }, () => Buffer.alloc(32, 9));

    await identity.issueCredential(issued.record, {
      ...context,
      causationId: "request:credential-1",
    });

    expect(await identity.authenticateToken(
      issued.token,
      "2026-07-14T00:00:00.000Z",
    )).toEqual({
      principalType: "agent",
      principalId: "agent-1",
      organizationId: "org-1",
      credentialId: "cred-1",
      capabilities: ["inference:invoke", "receipts:read"],
    });
    const stored = await pool.query("SELECT * FROM api_credentials WHERE id = 'cred-1'");
    expect(stored.rows[0]).not.toHaveProperty("token");

    await pool.end();
  });

  it("rejects tampered credential records at the persistence boundary", async () => {
    const { pool, identity } = await createStores();
    await identity.createOrganization({ id: "org-1", name: "Acme", ...context });
    await identity.registerAgent({ id: "agent-1", organizationId: "org-1", name: "Scout", ...context });
    const issued = createApiCredential({
      id: "cred-1",
      organizationId: "org-1",
      agentId: "agent-1",
      name: "runtime",
      capabilities: ["inference:invoke"],
      createdAt: context.occurredAt,
      expiresAt: "2026-08-13T17:00:00.000Z",
    }, () => Buffer.alloc(32, 7));

    const invalidRecords = [
      [{ ...issued.record, tokenPrefix: "not-a-fuse-key" }, "API_CREDENTIAL_PREFIX_INVALID"],
      [{ ...issued.record, createdAt: "not-a-date" }, "API_CREDENTIAL_CREATED_AT_INVALID"],
      [{ ...issued.record, expiresAt: context.occurredAt }, "API_CREDENTIAL_EXPIRY_INVALID"],
      [{ ...issued.record, revokedAt: context.occurredAt }, "API_CREDENTIAL_ALREADY_REVOKED"],
      [{ ...issued.record, capabilities: ["inference:invoke", "inference:invoke"] }, "API_CREDENTIAL_CAPABILITY_DUPLICATE"],
    ] as const;

    for (const [record, error] of invalidRecords) {
      await expect(identity.issueCredential(record, context)).rejects.toThrow(error);
    }
    expect((await pool.query("SELECT id FROM api_credentials")).rows).toEqual([]);
    await pool.end();
  });

  it("revokes a credential transactionally and records the revocation audit event", async () => {
    const { pool, audit, identity } = await createStores();
    await identity.createOrganization({ id: "org-1", name: "Acme Agents", ...context });
    await identity.registerAgent({
      id: "agent-1",
      organizationId: "org-1",
      name: "Scout",
      ...context,
      causationId: "request:agent-1",
    });
    const issued = createApiCredential({
      id: "cred-1",
      organizationId: "org-1",
      agentId: "agent-1",
      name: "Scout runtime",
      capabilities: ["inference:invoke"],
      createdAt: context.occurredAt,
      expiresAt: null,
    }, () => Buffer.alloc(32, 4));
    await identity.issueCredential(issued.record, context);

    await identity.revokeCredential("org-1", "cred-1", {
      actorId: "user:security",
      causationId: "request:revoke-1",
      occurredAt: "2026-07-14T01:00:00.000Z",
    });

    expect(await identity.authenticateToken(
      issued.token,
      "2026-07-14T02:00:00.000Z",
    )).toBeNull();
    expect((await audit.listAuditEvents("org-1", "api_credential", "cred-1")).map((event) => event.action))
      .toEqual(["credential.issued", "credential.revoked"]);
    await pool.end();
  });
});
