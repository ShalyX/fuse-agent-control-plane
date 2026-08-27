import { DataType, newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { createHumanSession, PostgresHumanSessionStore } from "../src/http/humanSessions.js";

function setup() {
  const db = newDb({ noAstCoverageCheck: true });
  db.public.registerFunction({ name: "hashtext", args: [DataType.text], returns: DataType.bigint, implementation: () => 1 });
  db.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.bigint], returns: DataType.integer, implementation: () => 0 });
  db.public.registerFunction({
    name: "now",
    returns: DataType.timestamptz,
    implementation: () => new Date("2026-08-14T00:00:00.000Z"),
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  return { pool, store: new PostgresHumanSessionStore(pool) };
}

describe("PostgresHumanSessionStore", () => {
  it("persists and resolves a session across store instances", async () => {
    const { pool, store } = setup();
    const created = createHumanSession({
      workspaceId: "workspace-1",
      userId: "invitee-1",
      sourceCredentialId: "credential-source",
      role: "owner",
      createdAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-15T00:00:00.000Z",
    }, () => Buffer.alloc(32, 7));
    await store.put(created.record);
    const createdAudit = await pool.query("SELECT action, actor_id FROM audit_events WHERE entity_id = $1", [created.record.id]);
    expect(createdAudit.rows).toEqual([{
      action: "human_session.created",
      actor_id: "credential:credential-source",
    }]);
    const reloaded = new PostgresHumanSessionStore(pool);
    await expect(reloaded.resolve(created.token, "2026-08-14T01:00:00.000Z")).resolves.toEqual({
      workspaceId: "workspace-1",
      userId: "invitee-1",
      sourceCredentialId: "credential-source",
      sourceCredentialType: "service_account",
      role: "owner",
      sessionId: created.record.id,
      expiresAt: "2026-08-15T00:00:00.000Z",
    });
    await pool.end();
  });

  it("enforces expiry, workspace binding, and revocation", async () => {
    const { pool, store } = setup();
    const created = createHumanSession({
      workspaceId: "workspace-1",
      userId: "invitee-1",
      sourceCredentialId: "credential-source",
      role: "member",
      createdAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-15T00:00:00.000Z",
    }, () => Buffer.alloc(32, 8));
    await store.put(created.record);
    await expect(store.resolveForWorkspace(created.token, "workspace-2", "2026-08-14T01:00:00.000Z")).resolves.toBeNull();
    await expect(store.resolve(created.token, "2026-08-15T00:00:00.000Z")).resolves.toBeNull();
    await store.revoke(created.token, "2026-08-14T02:00:00.000Z");
    await expect(store.resolve(created.token, "2026-08-14T03:00:00.000Z")).resolves.toBeNull();
    await pool.end();
  });

  it("survives concurrent first-use schema initialization", async () => {
    const { pool } = setup();
    const first = createHumanSession({
      workspaceId: "workspace-1", userId: "invitee-1", sourceCredentialId: "credential-source-1", role: "owner",
      createdAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-15T00:00:00.000Z",
    }, () => Buffer.alloc(32, 9));
    const second = createHumanSession({
      workspaceId: "workspace-1", userId: "invitee-2", sourceCredentialId: "credential-source-2", role: "member",
      createdAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-15T00:00:00.000Z",
    }, () => Buffer.alloc(32, 10));
    await Promise.all([
      new PostgresHumanSessionStore(pool).put(first.record),
      new PostgresHumanSessionStore(pool).put(second.record),
    ]);
    await expect(new PostgresHumanSessionStore(pool).resolve(first.token, "2026-08-14T01:00:00.000Z"))
      .resolves.toMatchObject({ userId: "invitee-1" });
    await expect(new PostgresHumanSessionStore(pool).resolve(second.token, "2026-08-14T01:00:00.000Z"))
      .resolves.toMatchObject({ userId: "invitee-2" });
    await pool.end();
  });
});
