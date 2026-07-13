import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { ProductionFoundationStore, type AuditEvent } from "../src/persistence/productionFoundation.js";
import type { JournalEntry } from "../src/domain/financialLedger.js";

const auditEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "audit-1",
  organizationId: "org-1",
  entityType: "mandate",
  entityId: "mandate-1",
  action: "mandate.activated",
  actorId: "user-1",
  causationId: "command-1",
  occurredAt: "2026-07-13T00:00:00.000Z",
  payload: { from: "draft", to: "active" },
  ...overrides,
});

const journalEntry = (): JournalEntry => ({
  id: "journal-1",
  actorId: "service:fuse",
  causationId: "request:req-1",
  occurredAt: "2026-07-13T00:00:01.000Z",
  description: "Reserve authority",
  postings: [
    { accountId: "available", assetId: "arc-testnet/usdc", side: "credit", amountAtomic: 2500n },
    { accountId: "reserved", assetId: "arc-testnet/usdc", side: "debit", amountAtomic: 2500n },
  ],
});

const createStore = async () => {
  const db = newDb({ noAstCoverageCheck: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const store = new ProductionFoundationStore(pool);
  await store.ensureSchema();
  return { store, pool };
};

describe("ProductionFoundationStore", () => {
  it("persists ordered immutable audit events by organization and entity", async () => {
    const { store, pool } = await createStore();
    await store.appendAuditEvent(auditEvent());
    await store.appendAuditEvent(auditEvent({
      id: "audit-2",
      action: "mandate.paused",
      causationId: "command-2",
      occurredAt: "2026-07-13T00:00:02.000Z",
      payload: { from: "active", to: "paused" },
    }));

    const events = await store.listAuditEvents("org-1", "mandate", "mandate-1");
    expect(events.map((event) => event.action)).toEqual(["mandate.activated", "mandate.paused"]);
    expect(events[0]!.payload).toEqual({ from: "draft", to: "active" });
    await pool.end();
  });

  it("persists a balanced journal entry and round-trips bigint amounts", async () => {
    const { store, pool } = await createStore();
    await store.appendJournalEntry("org-1", journalEntry());
    expect(await store.listJournalEntries("org-1")).toEqual([journalEntry()]);
    await pool.end();
  });

  it("persists the same immutable journal snapshot that was validated", async () => {
    const { store, pool } = await createStore();
    const original = journalEntry();
    const pending = store.appendJournalEntry("org-1", original);
    original.description = "mutated after validation";
    original.postings[1]!.amountAtomic = 1n;
    await pending;

    expect(await store.listJournalEntries("org-1")).toEqual([journalEntry()]);
    await pool.end();
  });

  it("rejects an unbalanced journal before writing any rows", async () => {
    const { store, pool } = await createStore();
    const invalid = journalEntry();
    invalid.postings[1]!.amountAtomic = 2499n;
    await expect(store.appendJournalEntry("org-1", invalid)).rejects.toThrow(
      "JOURNAL_ENTRY_UNBALANCED:arc-testnet/usdc",
    );
    expect(await store.listJournalEntries("org-1")).toEqual([]);
    await pool.end();
  });

  it("rejects incomplete audit metadata before persistence", async () => {
    const { store, pool } = await createStore();
    await expect(store.appendAuditEvent(auditEvent({ entityType: "" }))).rejects.toThrow(
      "AUDIT_EVENT_ENTITY_TYPE_REQUIRED",
    );
    await expect(store.appendAuditEvent(auditEvent({ action: "" }))).rejects.toThrow(
      "AUDIT_EVENT_ACTION_REQUIRED",
    );
    await expect(store.appendAuditEvent(auditEvent({ occurredAt: "invalid" }))).rejects.toThrow(
      "AUDIT_EVENT_OCCURRED_AT_INVALID",
    );
    await pool.end();
  });

  it("rejects a missing journal organization before persistence", async () => {
    const { store, pool } = await createStore();
    await expect(store.appendJournalEntry("", journalEntry())).rejects.toThrow(
      "JOURNAL_ORGANIZATION_REQUIRED",
    );
    await pool.end();
  });

  it("rejects duplicate audit identifiers instead of rewriting history", async () => {
    const { store, pool } = await createStore();
    await store.appendAuditEvent(auditEvent());
    await expect(store.appendAuditEvent(auditEvent({ action: "tampered" }))).rejects.toThrow();
    expect((await store.listAuditEvents("org-1", "mandate", "mandate-1"))[0]!.action)
      .toBe("mandate.activated");
    await pool.end();
  });
});
