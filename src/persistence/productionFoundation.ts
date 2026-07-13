import type { Pool } from "pg";
import { FinancialLedger, type JournalEntry, type JournalPosting } from "../domain/financialLedger.js";

export interface AuditEvent {
  id: string;
  organizationId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  causationId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export class ProductionFoundationStore {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
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

      CREATE TABLE IF NOT EXISTS journal_entries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        causation_id TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        description TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_entries_org_idx
        ON journal_entries (organization_id, occurred_at, id);

      CREATE TABLE IF NOT EXISTS journal_postings (
        entry_id TEXT NOT NULL REFERENCES journal_entries(id),
        line_number INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
        amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
        PRIMARY KEY (entry_id, line_number)
      );
    `);
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    this.validateAuditEvent(event);
    await this.pool.query(
      `INSERT INTO audit_events
       (id, organization_id, entity_type, entity_id, action, actor_id, causation_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        event.id,
        event.organizationId,
        event.entityType,
        event.entityId,
        event.action,
        event.actorId,
        event.causationId,
        event.occurredAt,
        JSON.stringify(event.payload),
      ],
    );
  }

  async listAuditEvents(
    organizationId: string,
    entityType: string,
    entityId: string,
  ): Promise<AuditEvent[]> {
    const result = await this.pool.query<{
      id: string;
      organization_id: string;
      entity_type: string;
      entity_id: string;
      action: string;
      actor_id: string;
      causation_id: string;
      occurred_at: Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, organization_id, entity_type, entity_id, action, actor_id,
              causation_id, occurred_at, payload
       FROM audit_events
       WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3
       ORDER BY occurred_at ASC, id ASC`,
      [organizationId, entityType, entityId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      actorId: row.actor_id,
      causationId: row.causation_id,
      occurredAt: row.occurred_at.toISOString(),
      payload: { ...row.payload },
    }));
  }

  async appendJournalEntry(organizationId: string, entry: JournalEntry): Promise<void> {
    if (!organizationId.trim()) throw new Error("JOURNAL_ORGANIZATION_REQUIRED");
    const snapshot: JournalEntry = {
      ...entry,
      postings: entry.postings.map((posting) => ({ ...posting })),
    };
    new FinancialLedger().append(snapshot);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO journal_entries
         (id, organization_id, actor_id, causation_id, occurred_at, description)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [snapshot.id, organizationId, snapshot.actorId, snapshot.causationId, snapshot.occurredAt, snapshot.description],
      );
      for (const [index, posting] of snapshot.postings.entries()) {
        await client.query(
          `INSERT INTO journal_postings
           (entry_id, line_number, account_id, asset_id, side, amount_atomic)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [snapshot.id, index, posting.accountId, posting.assetId, posting.side, posting.amountAtomic.toString()],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listJournalEntries(organizationId: string): Promise<JournalEntry[]> {
    const result = await this.pool.query<{
      id: string;
      actor_id: string;
      causation_id: string;
      occurred_at: Date;
      description: string;
      line_number: number;
      account_id: string;
      asset_id: string;
      side: "debit" | "credit";
      amount_atomic: string;
    }>(
      `SELECT e.id, e.actor_id, e.causation_id, e.occurred_at, e.description,
              p.line_number, p.account_id, p.asset_id, p.side, p.amount_atomic
       FROM journal_entries e
       JOIN journal_postings p ON p.entry_id = e.id
       WHERE e.organization_id = $1
       ORDER BY e.occurred_at ASC, e.id ASC, p.line_number ASC`,
      [organizationId],
    );

    const entries = new Map<string, JournalEntry>();
    for (const row of result.rows) {
      let entry = entries.get(row.id);
      if (!entry) {
        entry = {
          id: row.id,
          actorId: row.actor_id,
          causationId: row.causation_id,
          occurredAt: row.occurred_at.toISOString(),
          description: row.description,
          postings: [],
        };
        entries.set(row.id, entry);
      }
      const posting: JournalPosting = {
        accountId: row.account_id,
        assetId: row.asset_id,
        side: row.side,
        amountAtomic: BigInt(row.amount_atomic),
      };
      entry.postings.push(posting);
    }
    return [...entries.values()];
  }

  private validateAuditEvent(event: AuditEvent): void {
    if (!event.id.trim()) throw new Error("AUDIT_EVENT_ID_REQUIRED");
    if (!event.organizationId.trim()) throw new Error("AUDIT_EVENT_ORGANIZATION_REQUIRED");
    if (!event.entityType.trim()) throw new Error("AUDIT_EVENT_ENTITY_TYPE_REQUIRED");
    if (!event.entityId.trim()) throw new Error("AUDIT_EVENT_ENTITY_ID_REQUIRED");
    if (!event.action.trim()) throw new Error("AUDIT_EVENT_ACTION_REQUIRED");
    if (!event.actorId.trim()) throw new Error("AUDIT_EVENT_ACTOR_REQUIRED");
    if (!event.causationId.trim()) throw new Error("AUDIT_EVENT_CAUSATION_REQUIRED");
    if (Number.isNaN(Date.parse(event.occurredAt))) throw new Error("AUDIT_EVENT_OCCURRED_AT_INVALID");
  }
}
