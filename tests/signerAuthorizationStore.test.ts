import { newDb } from "pg-mem";
import { expect, it } from "vitest";
import { PostgresSignerAuthorizationStore } from "../src/signer/authorizationStore.js";

function setup() {
  const db = newDb({ noAstCoverageCheck: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  return { pool, store: new PostgresSignerAuthorizationStore(pool) };
}

it("durably binds signer idempotency keys to payloads and replays completed signatures", async () => {
  const { pool, store } = setup();
  const input = {
    organizationId: "org-shaly", callerId: "fuse-control-plane", requestId: "request-1",
    fingerprint: "a".repeat(64), nonce: `0x${"01".repeat(32)}`,
    amountAtomic: 60n, maximumTotalAtomic: 100n, now: "2026-07-14T09:00:00.000Z",
  };
  expect(await store.reserve(input)).toEqual({ status: "reserved" });
  await store.complete({
    organizationId: "org-shaly", requestId: "request-1",
    signature: `0x${"ab".repeat(65)}`, completedAt: "2026-07-14T09:00:01.000Z",
  });
  expect(await store.reserve(input)).toEqual({
    status: "completed", signature: `0x${"ab".repeat(65)}`,
  });
  expect(await store.reserve({ ...input, requestId: "alternate-request" })).toEqual({
    status: "completed", signature: `0x${"ab".repeat(65)}`,
  });
  await expect(store.reserve({
    ...input, requestId: "nonce-conflict", fingerprint: "c".repeat(64),
  })).rejects.toThrow("SIGNER_NONCE_CONFLICT");
  await expect(store.reserve({ ...input, fingerprint: "b".repeat(64) }))
    .rejects.toThrow("SIGNER_IDEMPOTENCY_CONFLICT");
  expect((await pool.query("SELECT version FROM signer_schema_migrations")).rows)
    .toEqual([{ version: 1 }]);
  await pool.end();
});

it("reserves cumulative authority transactionally and holds ambiguous signing attempts", async () => {
  const { pool, store } = setup();
  const base = {
    organizationId: "org-shaly", callerId: "fuse-control-plane", fingerprint: "a".repeat(64),
    nonce: `0x${"01".repeat(32)}`,
    maximumTotalAtomic: 100n, now: "2026-07-14T09:00:00.000Z",
  };
  expect(await store.reserve({ ...base, requestId: "request-1", amountAtomic: 60n }))
    .toEqual({ status: "reserved" });
  expect(await store.reserve({
    ...base, requestId: "request-2", fingerprint: "b".repeat(64),
    nonce: `0x${"02".repeat(32)}`, amountAtomic: 50n,
  })).toEqual({ status: "budget_exceeded" });
  await store.holdForReview({
    organizationId: "org-shaly", requestId: "request-1",
    reasonCode: "CIRCLE_SIGNING_OUTCOME_AMBIGUOUS", heldAt: "2026-07-14T09:00:01.000Z",
  });
  expect(await store.reserve({ ...base, requestId: "request-1", amountAtomic: 60n }))
    .toEqual({ status: "review" });
  expect((await pool.query(
    "SELECT reserved_atomic::text FROM signer_authority_limits WHERE organization_id = 'org-shaly'",
  )).rows[0]).toEqual({ reserved_atomic: "60" });
  expect(await store.getStatus("org-shaly")).toEqual({
    reservedCount: 0, reviewCount: 1, reservedAtomic: 60n, maximumTotalAtomic: 100n,
  });
  await pool.end();
});

it("fails closed on unversioned signer authority tables", async () => {
  const db = newDb({ noAstCoverageCheck: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await pool.query("CREATE TABLE signer_authority_limits (organization_id TEXT PRIMARY KEY)");
  const store = new PostgresSignerAuthorizationStore(pool);
  await expect(store.reserve({
    organizationId: "org-shaly", callerId: "fuse-control-plane", requestId: "request-1",
    fingerprint: "a".repeat(64), nonce: `0x${"01".repeat(32)}`,
    amountAtomic: 1n, maximumTotalAtomic: 1n, now: "2026-07-14T09:00:00.000Z",
  })).rejects.toThrow("UNVERSIONED_SIGNER_SCHEMA_UNSUPPORTED");
  await pool.end();
});
