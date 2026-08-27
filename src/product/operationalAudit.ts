import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface OperationalAuditEvent {
  eventType: string;
  scopeId: string;
  outcome: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export interface OperationalAuditStore {
  record(event: OperationalAuditEvent): Promise<void>;
}

function validate(event: OperationalAuditEvent): void {
  if (!/^[a-z][a-z0-9_.-]{2,95}$/.test(event.eventType)) throw new Error("AUDIT_EVENT_TYPE_INVALID");
  if (!event.scopeId.trim() || event.scopeId.length > 256) throw new Error("AUDIT_SCOPE_INVALID");
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(event.outcome)) throw new Error("AUDIT_OUTCOME_INVALID");
  if (Number.isNaN(Date.parse(event.occurredAt))) throw new Error("AUDIT_TIME_INVALID");
}

export class PostgresOperationalAuditStore implements OperationalAuditStore {
  private initialized?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  async record(event: OperationalAuditEvent): Promise<void> {
    validate(event);
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO fuse_operational_audit_events
       (id, event_type, scope_id, outcome, occurred_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [randomUUID(), event.eventType, event.scopeId, event.outcome, event.occurredAt, JSON.stringify(event.metadata)],
    );
  }

  private async ensureSchema(): Promise<void> {
    this.initialized ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS fuse_operational_audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        metadata JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fuse_operational_audit_scope_idx
        ON fuse_operational_audit_events (scope_id, occurred_at, id)
    `).then(() => undefined).catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    await this.initialized;
  }
}

export class MemoryOperationalAuditStore implements OperationalAuditStore {
  readonly events: OperationalAuditEvent[] = [];

  async record(event: OperationalAuditEvent): Promise<void> {
    validate(event);
    this.events.push(structuredClone(event));
  }
}
