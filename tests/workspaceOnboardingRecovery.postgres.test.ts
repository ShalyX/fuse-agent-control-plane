import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createPostgresPool } from "../src/persistence/postgres.js";
import { PostgresWorkspaceOnboardingStore } from "../src/product/workspaceOnboardingStore.js";

const enabled = process.env["RUN_WORKSPACE_ONBOARDING_POSTGRES_INTEGRATION"] === "1";
const configuredUrl = process.env["WORKSPACE_ONBOARDING_DATABASE_URL_UNPOOLED"]
  ?? process.env["DATABASE_URL_UNPOOLED"]
  ?? process.env["DATABASE_URL"];

it.runIf(enabled)("reclaims stale workspace onboarding atomically without deleting another tenant", async () => {
  if (!configuredUrl) throw new Error("RUN_WORKSPACE_ONBOARDING_POSTGRES_INTEGRATION requires an unpooled database URL");
  const parsed = new URL(configuredUrl);
  if (parsed.hostname.includes("-pooler.") || parsed.hostname.includes(".pooler")) {
    throw new Error("Workspace onboarding recovery requires an unpooled database URL");
  }
  const administrationPool = createPostgresPool(parsed.toString());
  const schema = `workspace_recovery_${randomUUID().replaceAll("-", "")}`;
  await administrationPool.query(`CREATE SCHEMA "${schema}"`);
  const isolated = new URL(parsed);
  isolated.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = createPostgresPool(isolated.toString());
  const deliveryKeyRing = { activeKeyId: "v1", keys: new Map([["v1", Buffer.alloc(32, 42)]]) };
  const store = new PostgresWorkspaceOnboardingStore(pool, deliveryKeyRing);
  const idempotencyKey = `onboarding-${randomUUID()}`;
  const first = {
    idempotencyKey,
    fingerprint: "same-request",
    recoveryCodeHash: "first-recovery-hash",
    identifiers: { workspaceId: "workspace-partial" },
    now: new Date("2026-08-23T10:00:00.000Z"),
    staleAfterMs: 15 * 60_000,
  };

  try {
    await expect(store.claim(first)).resolves.toEqual({ status: "new" });
    const legacyResult = {
      workspaceId: "workspace-legacy",
      recoveryCode: "fuse_rc_legacy_plaintext",
      adminCredential: { token: "fuse_admin_legacy_plaintext" },
      credential: { token: "fuse_sk_legacy_plaintext", expiresAt: null },
    };
    await pool.query(
      `INSERT INTO fuse_workspace_onboarding_operations
       (idempotency_key, request_fingerprint, recovery_code_hash, identifiers, status,
        result_json, created_at, updated_at, completed_at)
       VALUES ('legacy-completed', 'legacy-fingerprint', 'legacy-recovery-hash',
        '{"workspaceId":"workspace-legacy"}'::jsonb, 'completed', $1::jsonb,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [JSON.stringify(legacyResult)],
    );
    const migrationStore = new PostgresWorkspaceOnboardingStore(pool, deliveryKeyRing);
    await migrationStore.listCompletedWorkspaceIds();
    const scrubbed = await pool.query<{ result_json: typeof legacyResult }>(
      "SELECT result_json FROM fuse_workspace_onboarding_operations WHERE idempotency_key = 'legacy-completed'",
    );
    expect(scrubbed.rows[0]?.result_json).toMatchObject({
      recoveryCode: null,
      adminCredential: { token: null },
      credential: { token: null },
    });
    await expect(migrationStore.claim({
      idempotencyKey: "legacy-completed", fingerprint: "legacy-fingerprint",
      recoveryCodeHash: "unused-on-replay", identifiers: { workspaceId: "workspace-legacy" },
    })).resolves.toMatchObject({
      status: "replay",
      result: {
        recoveryCode: "fuse_rc_legacy_plaintext",
        adminCredential: { token: "fuse_admin_legacy_plaintext" },
        credential: { token: "fuse_sk_legacy_plaintext" },
      },
    });
    await pool.query("CREATE TABLE organizations (id TEXT PRIMARY KEY)");
    await pool.query("CREATE TABLE service_accounts (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id))");
    await pool.query("INSERT INTO organizations(id) VALUES ('workspace-partial'), ('workspace-survivor')");
    await pool.query("INSERT INTO service_accounts(id, organization_id) VALUES ('partial-admin', 'workspace-partial'), ('survivor-admin', 'workspace-survivor')");

    await store.heartbeat(idempotencyKey, "workspace-partial", new Date("2026-08-23T10:14:00.000Z"));
    await expect(store.claim({ ...first, now: new Date("2026-08-23T10:15:00.000Z") }))
      .resolves.toEqual({ status: "in_progress" });
    await expect(store.claim({
      ...first,
      recoveryCodeHash: "replacement-recovery-hash",
      identifiers: { workspaceId: "workspace-replacement" },
      now: new Date("2026-08-23T10:29:00.000Z"),
    })).resolves.toEqual({ status: "new" });

    const operation = await pool.query<{ status: string; workspace_id: string }>(
      `SELECT status, identifiers->>'workspaceId' AS workspace_id
         FROM fuse_workspace_onboarding_operations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    expect(operation.rows).toEqual([{ status: "in_progress", workspace_id: "workspace-replacement" }]);
    expect((await pool.query("SELECT id FROM organizations ORDER BY id")).rows)
      .toEqual([{ id: "workspace-survivor" }]);
    expect((await pool.query("SELECT id FROM service_accounts ORDER BY id")).rows)
      .toEqual([{ id: "survivor-admin" }]);

    await pool.query("INSERT INTO organizations(id) VALUES ('workspace-replacement')");
    const contenders = ["workspace-race-a", "workspace-race-b"];
    const outcomes = await Promise.all(contenders.map((workspaceId) => store.claim({
      ...first,
      recoveryCodeHash: "race-recovery-hash",
      identifiers: { workspaceId },
      now: new Date("2026-08-23T10:44:00.000Z"),
    })));
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["in_progress", "new"]);

    const racedOperation = await pool.query<{ workspace_id: string }>(
      "SELECT identifiers->>'workspaceId' AS workspace_id FROM fuse_workspace_onboarding_operations WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    expect(contenders).toContain(racedOperation.rows[0]?.workspace_id);
    expect((await pool.query("SELECT id FROM organizations ORDER BY id")).rows)
      .toEqual([{ id: "workspace-survivor" }]);
    await expect((store as unknown as {
      readOperationalReadiness(now: Date, staleAfterMs: number): Promise<{
        staleOnboardingOperations: number;
        rollbackFailedOnboardingOperations: number;
        oldestInProgressAt: string | null;
        orphanCapacityReservations: number;
        oldestOrphanReservationAt: string | null;
      }>;
    }).readOperationalReadiness(new Date("2026-08-23T11:00:00.000Z"), 15 * 60_000)).resolves.toEqual({
      staleOnboardingOperations: 1,
      rollbackFailedOnboardingOperations: 0,
      oldestInProgressAt: "2026-08-23T10:44:00.000Z",
      orphanCapacityReservations: 0,
      oldestOrphanReservationAt: null,
    });
    await store.recordRollbackFailure(idempotencyKey, racedOperation.rows[0]!.workspace_id, "ROLLBACK_TEST_FAILURE");
    await expect(store.readOperationalReadiness(new Date("2026-08-23T11:00:00.000Z"), 15 * 60_000)).resolves.toEqual({
      staleOnboardingOperations: 0,
      rollbackFailedOnboardingOperations: 1,
      oldestInProgressAt: null,
      orphanCapacityReservations: 0,
      oldestOrphanReservationAt: null,
    });
  } finally {
    await pool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  }
}, 90_000);
