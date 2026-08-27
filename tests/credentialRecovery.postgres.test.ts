import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createApiCredential } from "../src/identity/apiCredentials.js";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { createPostgresPool } from "../src/persistence/postgres.js";

const enabled = process.env["RUN_CREDENTIAL_RECOVERY_POSTGRES_INTEGRATION"] === "1";
const configuredUrl = process.env["CREDENTIAL_RECOVERY_DATABASE_URL_UNPOOLED"]
  ?? process.env["DATABASE_URL_UNPOOLED"]
  ?? process.env["DATABASE_URL"];

it.runIf(enabled)("rotates one recovery credential atomically across real PostgreSQL connections", async () => {
  if (!configuredUrl) {
    throw new Error("RUN_CREDENTIAL_RECOVERY_POSTGRES_INTEGRATION requires an unpooled database URL");
  }
  const parsed = new URL(configuredUrl);
  if (parsed.hostname.includes("-pooler.") || parsed.hostname.includes(".pooler")) {
    throw new Error("CREDENTIAL_RECOVERY_DATABASE_URL_UNPOOLED points to a pooled hostname");
  }

  const administrationPool = createPostgresPool(configuredUrl);
  const schema = `credential_recovery_${randomUUID().replaceAll("-", "")}`;
  await administrationPool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(configuredUrl);
  isolatedUrl.searchParams.set("options", `-csearch_path=${schema}`);
  const firstPool = createPostgresPool(isolatedUrl.toString());
  const secondPool = createPostgresPool(isolatedUrl.toString());
  const firstIdentity = new IdentityStore(firstPool);
  const secondIdentity = new IdentityStore(secondPool);
  const organizationId = `recovery-integration-${randomUUID()}`;
  const agentId = "recovery-agent";
  const oldCredentialId = "credential-old";
  const occurredAt = new Date().toISOString();
  const setupContext = {
    actorId: "test:credential-recovery",
    causationId: `test:setup:${organizationId}`,
    occurredAt,
  };

  try {
    await firstIdentity.createOrganization({
      id: organizationId,
      name: "Credential recovery integration",
      ...setupContext,
    });
    await firstIdentity.registerAgent({
      id: agentId,
      organizationId,
      name: "Recovery agent",
      ...setupContext,
    });
    const oldCredential = createApiCredential({
      id: oldCredentialId,
      organizationId,
      agentId,
      name: "Old credential",
      capabilities: ["inference:invoke", "receipts:read"],
      createdAt: occurredAt,
    }, () => Buffer.alloc(32, 50));
    const collisionCredential = createApiCredential({
      id: "credential-collision",
      organizationId,
      agentId,
      name: "Collision sentinel",
      capabilities: ["inference:invoke"],
      createdAt: occurredAt,
    }, () => Buffer.alloc(32, 51));
    await firstIdentity.issueCredential(oldCredential.record, setupContext);
    await firstIdentity.issueCredential(collisionCredential.record, setupContext);

    await firstPool.query(`
      CREATE TABLE fuse_workspace_onboarding_operations (
        idempotency_key TEXT PRIMARY KEY,
        recovery_code_hash TEXT,
        recovery_consumed_at TIMESTAMPTZ,
        recovery_consumed_hash TEXT,
        recovery_delivery_envelope TEXT,
        recovery_delivery_id TEXT,
        identifiers JSONB NOT NULL,
        status TEXT NOT NULL
      )
    `);
    const recoveryCodeHash = createHash("sha256")
      .update(`fuse_rc_${randomUUID()}`)
      .digest("hex");
    await firstPool.query(
      `INSERT INTO fuse_workspace_onboarding_operations
       (idempotency_key, recovery_code_hash, identifiers, status)
       VALUES ($1, $2, $3::jsonb, 'completed')`,
      [`onboard-${organizationId}`, recoveryCodeHash, JSON.stringify({
        workspaceId: organizationId,
        agentId,
        agentCredentialId: oldCredentialId,
      })],
    );

    const collisionReplacement = createApiCredential({
      id: "credential-failed-replacement",
      organizationId,
      agentId,
      name: "Failed replacement",
      capabilities: ["inference:invoke", "receipts:read"],
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    }, () => Buffer.alloc(32, 51));
    await expect(firstIdentity.rotateAgentCredentialWithRecovery({
      workspaceId: organizationId,
      recoveryCodeHash,
      recoveryDeliveryEnvelope: "sealed-failed-delivery",
      recoveryDeliveryId: "recovery-failed-1",
      replacement: collisionReplacement.record,
      actorId: "test:credential-recovery",
      causationId: `test:failed:${organizationId}`,
      occurredAt: collisionReplacement.record.createdAt,
    })).rejects.toMatchObject({ code: "23505" });

    const afterFailure = await firstPool.query<{
      recovery_code_hash: string | null;
      recovery_consumed_at: Date | null;
      old_revoked_at: Date | null;
      failed_replacement_count: string;
    }>(
      `SELECT operations.recovery_code_hash, operations.recovery_consumed_at,
              old.revoked_at AS old_revoked_at,
              (SELECT count(*)::text FROM api_credentials
                WHERE organization_id = $1 AND id = 'credential-failed-replacement') AS failed_replacement_count
         FROM fuse_workspace_onboarding_operations operations
         JOIN api_credentials old
           ON old.organization_id = $1 AND old.id = $2`,
      [organizationId, oldCredentialId],
    );
    expect(afterFailure.rows[0]).toEqual({
      recovery_code_hash: recoveryCodeHash,
      recovery_consumed_at: null,
      old_revoked_at: null,
      failed_replacement_count: "0",
    });

    const replacements = [52, 53].map((byte, index) => createApiCredential({
      id: `credential-winner-${index + 1}`,
      organizationId,
      agentId,
      name: `Recovery candidate ${index + 1}`,
      capabilities: ["inference:invoke", "receipts:read"],
      createdAt: new Date(Date.now() + 2_000 + index).toISOString(),
    }, () => Buffer.alloc(32, byte)));
    const causationIds = replacements.map((_replacement, index) => `test:race:${organizationId}:${index + 1}`);
    const outcomes = await Promise.allSettled([
      firstIdentity.rotateAgentCredentialWithRecovery({
        workspaceId: organizationId,
        recoveryCodeHash,
        recoveryDeliveryEnvelope: "sealed-race-delivery-1",
        recoveryDeliveryId: "recovery-race-1",
        replacement: replacements[0]!.record,
        actorId: "test:credential-recovery",
        causationId: causationIds[0]!,
        occurredAt: replacements[0]!.record.createdAt,
      }),
      secondIdentity.rotateAgentCredentialWithRecovery({
        workspaceId: organizationId,
        recoveryCodeHash,
        recoveryDeliveryEnvelope: "sealed-race-delivery-2",
        recoveryDeliveryId: "recovery-race-2",
        replacement: replacements[1]!.record,
        actorId: "test:credential-recovery",
        causationId: causationIds[1]!,
        occurredAt: replacements[1]!.record.createdAt,
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const winnerIndex = outcomes.findIndex(({ status }) => status === "fulfilled");

    const committed = await firstPool.query<{
      recovery_code_hash: string | null;
      recovery_consumed_at: Date | null;
      old_revoked_at: Date | null;
      active_replacements: string;
      replacement_ids: string[];
    }>(
      `SELECT operations.recovery_code_hash, operations.recovery_consumed_at,
              old.revoked_at AS old_revoked_at,
              (SELECT count(*)::text FROM api_credentials
                WHERE organization_id = $1 AND id = ANY($3::text[]) AND revoked_at IS NULL) AS active_replacements,
              (SELECT array_agg(id ORDER BY id) FROM api_credentials
                WHERE organization_id = $1 AND id = ANY($3::text[])) AS replacement_ids
         FROM fuse_workspace_onboarding_operations operations
         JOIN api_credentials old
           ON old.organization_id = $1 AND old.id = $2`,
      [organizationId, oldCredentialId, replacements.map(({ record }) => record.id)],
    );
    expect(committed.rows[0]).toMatchObject({
      recovery_code_hash: null,
      active_replacements: "1",
      replacement_ids: [replacements[winnerIndex]!.record.id],
    });
    expect(committed.rows[0]?.recovery_consumed_at).toBeInstanceOf(Date);
    expect(committed.rows[0]?.old_revoked_at).toBeInstanceOf(Date);
    await expect(firstIdentity.authenticateToken(oldCredential.token, new Date(Date.now() + 10_000).toISOString()))
      .resolves.toBeNull();
    await expect(secondIdentity.authenticateToken(
      replacements[winnerIndex]!.token,
      new Date(Date.now() + 10_000).toISOString(),
    )).resolves.toMatchObject({ credentialId: replacements[winnerIndex]!.record.id });

    const audit = await firstPool.query<{ action: string; entity_id: string; causation_id: string }>(
      `SELECT action, entity_id, causation_id
         FROM audit_events
        WHERE organization_id = $1 AND causation_id = $2
        ORDER BY action`,
      [organizationId, causationIds[winnerIndex]],
    );
    expect(audit.rows).toEqual([
      { action: "credential.issued", entity_id: replacements[winnerIndex]!.record.id, causation_id: causationIds[winnerIndex] },
      { action: "credential.revoked", entity_id: oldCredentialId, causation_id: causationIds[winnerIndex] },
    ]);
  } finally {
    await Promise.all([
      firstPool.end().catch(() => undefined),
      secondPool.end().catch(() => undefined),
    ]);
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const remains = await administrationPool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists",
      [schema],
    );
    expect(remains.rows[0]?.exists).toBe(false);
    await administrationPool.end();
  }
}, 90_000);
