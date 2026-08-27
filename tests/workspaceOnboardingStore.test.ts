import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newAdvisoryMemoryDb } from "./helpers/pgMemAdvisory.js";
import { MemoryWorkspaceOnboardingStore, PostgresWorkspaceOnboardingStore } from "../src/product/workspaceOnboardingStore.js";
import { openSecretDelivery } from "../src/product/secretDelivery.js";

describe("workspace onboarding idempotency", () => {
  it("fails readiness when a retained delivery envelope key is unavailable", async () => {
    const db = newAdvisoryMemoryDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const store = new PostgresWorkspaceOnboardingStore(pool, {
      activeKeyId: "v2",
      keys: new Map([["v2", Buffer.alloc(32, 42)]]),
    });
    await pool.query(`CREATE TABLE fuse_workspace_onboarding_operations (
      idempotency_key TEXT PRIMARY KEY,
      identifiers JSONB,
      recovery_consumed_hash TEXT,
      recovery_delivery_id TEXT,
      delivery_envelope TEXT,
      recovery_delivery_envelope TEXT
    )`);
    (store as unknown as { schemaReady: Promise<void> }).schemaReady = Promise.resolve();
    await pool.query(
      `INSERT INTO fuse_workspace_onboarding_operations
       (idempotency_key, delivery_envelope, recovery_delivery_envelope)
       VALUES ('missing-onboarding-key', 'v1.v0.AA.AA.AA', NULL)`,
    );

    await expect(store.readiness()).rejects.toThrow("WORKSPACE_DELIVERY_DECRYPTION_KEY_MISSING");
    await pool.end();
  });

  it("fails readiness when a retained delivery envelope cannot be authenticated", async () => {
    const db = newAdvisoryMemoryDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const store = new PostgresWorkspaceOnboardingStore(pool, {
      activeKeyId: "v1",
      keys: new Map([["v1", Buffer.alloc(32, 41)]]),
    });
    await pool.query(`CREATE TABLE fuse_workspace_onboarding_operations (
      idempotency_key TEXT PRIMARY KEY,
      identifiers JSONB,
      recovery_consumed_hash TEXT,
      recovery_delivery_id TEXT,
      delivery_envelope TEXT,
      recovery_delivery_envelope TEXT
    )`);
    (store as unknown as { schemaReady: Promise<void> }).schemaReady = Promise.resolve();
    await pool.query(
      `INSERT INTO fuse_workspace_onboarding_operations
       (idempotency_key, identifiers, delivery_envelope)
       VALUES ('corrupt-onboarding', '{"workspaceId":"workspace-corrupt"}'::jsonb, 'v1.v1.AA.AA.AA')`,
    );

    await expect(store.readiness()).rejects.toThrow("WORKSPACE_DELIVERY_ENVELOPE_UNREADABLE");
    await pool.end();
  });

  it("encrypts replayable one-time workspace secrets in PostgreSQL", async () => {
    const db = newAdvisoryMemoryDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const keyRing = { activeKeyId: "v1", keys: new Map([["v1", Buffer.alloc(32, 41)]]) };
    const store = new PostgresWorkspaceOnboardingStore(pool, keyRing);
    await pool.query(`CREATE TABLE fuse_workspace_onboarding_operations (
      idempotency_key TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL,
      recovery_code_hash TEXT, recovery_consumed_at TIMESTAMPTZ,
      recovery_consumed_hash TEXT, recovery_delivery_envelope TEXT, recovery_delivery_id TEXT,
      identifiers JSONB NOT NULL, status TEXT NOT NULL, result_json JSONB,
      delivery_envelope TEXT, failure_code TEXT, created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ
    )`);
    (store as unknown as { schemaReady: Promise<void> }).schemaReady = Promise.resolve();
    const input = {
      idempotencyKey: "encrypted-replay", fingerprint: "fingerprint-encrypted",
      recoveryCodeHash: "recovery-hash", identifiers: { workspaceId: "workspace-encrypted" },
    };
    await pool.query(
      `INSERT INTO fuse_workspace_onboarding_operations
       (idempotency_key, request_fingerprint, recovery_code_hash, identifiers, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, 'in_progress', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [input.idempotencyKey, input.fingerprint, input.recoveryCodeHash, JSON.stringify(input.identifiers)],
    );
    await store.complete(input.idempotencyKey, {
      workspaceId: "workspace-encrypted", agentId: "agent-encrypted", mandateId: "mandate-encrypted",
      policyId: "policy-encrypted", providerConfigId: "provider-encrypted",
      adminCredential: { credentialId: "admin-encrypted", token: "admin-plaintext", tokenPrefix: "fuse_sk_", capabilities: [], expiresAt: null },
      credential: { credentialId: "agent-credential-encrypted", token: "agent-plaintext", tokenPrefix: "fuse_sk_", capabilities: [], expiresAt: null },
      recoveryCode: "recovery-plaintext",
    });

    const rows = (await pool.query(
      "SELECT result_json, delivery_envelope FROM fuse_workspace_onboarding_operations",
    )).rows as Array<{ result_json: unknown; delivery_envelope: string }>;
    expect(openSecretDelivery(rows[0]!.delivery_envelope, {
      activeKeyId: "v2",
      keys: new Map([["v1", Buffer.alloc(32, 41)], ["v2", Buffer.alloc(32, 42)]]),
    }, "workspace:encrypted-replay"))
      .toMatchObject({
        adminCredential: { token: "admin-plaintext" },
        credential: { token: "agent-plaintext" },
        recoveryCode: "recovery-plaintext",
      });
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain("admin-plaintext");
    expect(raw).not.toContain("agent-plaintext");
    expect(raw).not.toContain("recovery-plaintext");

    const recoveryResult = {
      workspaceId: "workspace-encrypted", agentId: "agent-encrypted",
      credential: { credentialId: "recovered-encrypted", token: "recovered-plaintext", tokenPrefix: "fuse_sk_reco", capabilities: ["inference:invoke" as const], expiresAt: null },
    };
    const recoveryEnvelope = store.sealRecoveryResult(recoveryResult, input.recoveryCodeHash, "recovery-delivery-1");
    await pool.query(
      `UPDATE fuse_workspace_onboarding_operations
          SET recovery_code_hash = NULL, recovery_consumed_hash = $2,
              recovery_consumed_at = CURRENT_TIMESTAMP, recovery_delivery_envelope = $3,
              recovery_delivery_id = 'recovery-delivery-1'
        WHERE idempotency_key = $1`,
      [input.idempotencyKey, input.recoveryCodeHash, recoveryEnvelope],
    );
    await expect(store.getRecovery("workspace-encrypted", input.recoveryCodeHash, "wrong-delivery-id"))
      .resolves.toBeNull();
    await expect(store.getRecovery("workspace-encrypted", input.recoveryCodeHash, "recovery-delivery-1"))
      .resolves.toEqual({ deliveryResult: recoveryResult });
    await expect(store.getRecovery("workspace-encrypted", input.recoveryCodeHash, "recovery-delivery-1"))
      .resolves.toEqual({ deliveryResult: recoveryResult });
    expect(JSON.stringify((await pool.query(
      "SELECT recovery_delivery_envelope FROM fuse_workspace_onboarding_operations",
    )).rows)).not.toContain("recovered-plaintext");
    await pool.end();
  });

  it("accepts concurrent exact PostgreSQL invite replays", async () => {
    const db = newAdvisoryMemoryDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const store = new PostgresWorkspaceOnboardingStore(pool);
    await pool.query(`CREATE TABLE fuse_beta_invite_redemptions (
      invite_hash TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      consumed_at TIMESTAMPTZ NOT NULL
    )`);
    (store as unknown as { schemaReady: Promise<void> }).schemaReady = Promise.resolve();
    const inviteToken = "fuse_invite_concurrent_customer";
    const inviteHash = createHash("sha256").update(inviteToken).digest("hex");
    const input = {
      inviteToken,
      idempotencyKey: "concurrent-onboarding-key",
      allowedInviteHashes: new Set([inviteHash]),
    };

    await expect(Promise.all([store.consumeInvite(input), store.consumeInvite(input)]))
      .resolves.toEqual([true, true]);
    await pool.end();
  });

  it("rejects PostgreSQL idempotency-key reuse across distinct invites without throwing", async () => {
    const db = newAdvisoryMemoryDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const store = new PostgresWorkspaceOnboardingStore(pool);
    await pool.query(`CREATE TABLE fuse_beta_invite_redemptions (
      invite_hash TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      consumed_at TIMESTAMPTZ NOT NULL
    )`);
    (store as unknown as { schemaReady: Promise<void> }).schemaReady = Promise.resolve();
    const firstInvite = "fuse_invite_first";
    const secondInvite = "fuse_invite_second";
    const allowedInviteHashes = new Set([firstInvite, secondInvite]
      .map((value) => createHash("sha256").update(value).digest("hex")));

    await expect(store.consumeInvite({
      inviteToken: firstInvite, idempotencyKey: "shared-key", allowedInviteHashes,
    })).resolves.toBe(true);
    await expect(store.consumeInvite({
      inviteToken: secondInvite, idempotencyKey: "shared-key", allowedInviteHashes,
    })).resolves.toBe(false);
    await pool.end();
  });

  it("does not double-count a completed workspace and its capacity reservation", async () => {
    const store = new MemoryWorkspaceOnboardingStore();
    await expect(store.tryReserveCapacity({
      idempotencyKey: "workspace-one", maxActiveWorkspaces: 2, baselineWorkspaceIds: [],
    })).resolves.toBe(true);
    await store.claim({
      idempotencyKey: "workspace-one", fingerprint: "fingerprint-one", recoveryCodeHash: "recovery-one",
      identifiers: { workspaceId: "workspace-one" },
    });
    await store.complete("workspace-one", {
      workspaceId: "workspace-one", agentId: "agent-one", mandateId: "mandate-one", policyId: "policy-one",
      providerConfigId: "provider-one",
      adminCredential: { credentialId: "admin-one", token: null, tokenPrefix: "fuse_admin_", capabilities: [], expiresAt: null },
      credential: { credentialId: "credential-one", token: null, tokenPrefix: "fuse_sk_", capabilities: [], expiresAt: null },
      recoveryCode: "recovery-code-one",
    });

    await expect(store.tryReserveCapacity({
      idempotencyKey: "workspace-two", maxActiveWorkspaces: 2, baselineWorkspaceIds: [],
    })).resolves.toBe(true);
  });

  it("reclaims an expired capacity reservation that never reached an onboarding claim", async () => {
    const store = new MemoryWorkspaceOnboardingStore();
    await store.tryReserveCapacity({
      idempotencyKey: "orphaned-reservation", maxActiveWorkspaces: 1, baselineWorkspaceIds: [],
      now: new Date("2026-08-27T10:00:00.000Z"),
    });

    await expect(store.tryReserveCapacity({
      idempotencyKey: "replacement-reservation", maxActiveWorkspaces: 1, baselineWorkspaceIds: [],
      now: new Date("2026-08-27T10:15:00.000Z"),
    })).resolves.toBe(true);
  });

  it("reports unresolved capacity reservations that have no onboarding claim", async () => {
    const db = newAdvisoryMemoryDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const store = new PostgresWorkspaceOnboardingStore(pool);
    await pool.query(`
      CREATE TABLE fuse_beta_capacity_reservations (
        idempotency_key TEXT PRIMARY KEY,
        reserved_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE fuse_workspace_onboarding_operations (
        idempotency_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO fuse_beta_capacity_reservations (idempotency_key, reserved_at)
      VALUES ('visible-orphan', '2026-08-27T10:00:00.000Z');
    `);
    (store as unknown as { schemaReady: Promise<void> }).schemaReady = Promise.resolve();

    await expect(store.readOperationalReadiness(
      new Date("2026-08-27T10:05:00.000Z"), 15 * 60_000,
    )).resolves.toMatchObject({
      orphanCapacityReservations: 1,
      oldestOrphanReservationAt: "2026-08-27T10:00:00.000Z",
    });
    await pool.end();
  });

  it("consumes only configured invites and permits exact idempotent replay", async () => {
    const store = new MemoryWorkspaceOnboardingStore();
    const invite = "fuse_invite_customer_one";
    const inviteHash = createHash("sha256").update(invite).digest("hex");

    await expect(store.consumeInvite({
      inviteToken: invite,
      idempotencyKey: "onboarding-key-1",
      allowedInviteHashes: new Set([inviteHash]),
    })).resolves.toBe(true);
    await expect(store.consumeInvite({
      inviteToken: invite,
      idempotencyKey: "onboarding-key-1",
      allowedInviteHashes: new Set([inviteHash]),
    })).resolves.toBe(true);
    await expect(store.consumeInvite({
      inviteToken: invite,
      idempotencyKey: "onboarding-key-2",
      allowedInviteHashes: new Set([inviteHash]),
    })).resolves.toBe(false);
    await expect(store.consumeInvite({
      inviteToken: "unlisted-invite",
      idempotencyKey: "onboarding-key-3",
      allowedInviteHashes: new Set([inviteHash]),
    })).resolves.toBe(false);
  });

  it("suppresses duplicate claims and rejects key reuse with a different request", async () => {
    const store = new MemoryWorkspaceOnboardingStore();
    const input = {
      idempotencyKey: "onboarding-key-1",
      fingerprint: "fingerprint-a",
      recoveryCodeHash: "recovery-hash-1",
      identifiers: { workspaceId: "workspace-1" },
    };

    await expect(store.claim(input)).resolves.toEqual({ status: "new" });
    await expect(store.claim(input)).resolves.toEqual({ status: "in_progress" });
    await store.complete(input.idempotencyKey, {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      mandateId: "mandate-1",
      policyId: "policy-1",
      providerConfigId: "provider-1",
      adminCredential: {
        credentialId: "admin-credential-1",
        token: "fuse_admin_secret",
        tokenPrefix: "fuse_admin_",
        capabilities: ["agents:write"],
        expiresAt: null,
      },
      credential: {
        credentialId: "credential-1",
        token: "fuse_sk_test",
        tokenPrefix: "fuse_sk_",
        capabilities: ["inference:invoke", "receipts:read"],
        expiresAt: null,
      },
      recoveryCode: "recovery-code-1",
    });
    const replay = await store.claim(input);
    expect(replay.status).toBe("replay");
    expect(replay.result?.workspaceId).toBe("workspace-1");
    expect(replay.result?.adminCredential.token).toBe("fuse_admin_secret");
    expect(replay.result?.credential.token).toBe("fuse_sk_test");
    expect(replay.result?.recoveryCode).toBe("recovery-code-1");
    await expect(store.claim({ ...input, fingerprint: "fingerprint-b" })).resolves.toEqual({ status: "conflict" });
  });

  it("atomically marks a failed workspace rolled back so the same request can retry", async () => {
    const store = new MemoryWorkspaceOnboardingStore();
    const input = {
      idempotencyKey: "rollback-key",
      fingerprint: "fingerprint-a",
      recoveryCodeHash: "recovery-hash-1",
      identifiers: { workspaceId: "workspace-rollback" },
    };
    await expect(store.claim(input)).resolves.toEqual({ status: "new" });
    await store.rollback("rollback-key", "workspace-rollback", "PROVIDER_VERIFICATION_FAILED");
    await expect(store.claim({ ...input, recoveryCodeHash: "replacement-hash" }))
      .resolves.toEqual({ status: "new" });
  });

  it("reclaims a stale in-progress operation but not an active one", async () => {
    const store = new MemoryWorkspaceOnboardingStore();
    const first = {
      idempotencyKey: "stale-key",
      fingerprint: "fingerprint-a",
      recoveryCodeHash: "recovery-hash-1",
      identifiers: { workspaceId: "workspace-stale" },
      now: new Date("2026-08-23T10:00:00.000Z"),
      staleAfterMs: 15 * 60_000,
    };

    await expect(store.claim(first)).resolves.toEqual({ status: "new" });
    await expect(store.claim({ ...first, now: new Date("2026-08-23T10:14:59.999Z") }))
      .resolves.toEqual({ status: "in_progress" });
    await expect(store.claim({
      ...first,
      recoveryCodeHash: "recovery-hash-2",
      identifiers: { workspaceId: "workspace-replacement" },
      now: new Date("2026-08-23T10:15:00.000Z"),
    })).resolves.toEqual({ status: "new" });
  });

  it("renews the stale-operation lease while onboarding is making progress", async () => {
    const store = new MemoryWorkspaceOnboardingStore();
    const claim = {
      idempotencyKey: "heartbeat-key",
      fingerprint: "fingerprint-heartbeat",
      recoveryCodeHash: "recovery-heartbeat",
      identifiers: { workspaceId: "workspace-heartbeat" },
      now: new Date("2026-08-23T10:00:00.000Z"),
      staleAfterMs: 15 * 60_000,
    };
    await store.claim(claim);
    await (store as unknown as { heartbeat(idempotencyKey: string, workspaceId: string, now: Date): Promise<void> })
      .heartbeat(claim.idempotencyKey, claim.identifiers.workspaceId, new Date("2026-08-23T10:14:00.000Z"));

    await expect(store.claim({ ...claim, now: new Date("2026-08-23T10:15:00.000Z") }))
      .resolves.toEqual({ status: "in_progress" });
    await expect(store.claim({
      ...claim,
      identifiers: { workspaceId: "workspace-after-heartbeat" },
      now: new Date("2026-08-23T10:29:00.000Z"),
    })).resolves.toEqual({ status: "new" });
  });
});
