import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { PostgresOperationalAuditStore } from "../src/product/operationalAudit.js";

describe("PostgresOperationalAuditStore", () => {
  it("persists structured events without secret material", async () => {
    const db = newDb({ noAstCoverageCheck: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const store = new PostgresOperationalAuditStore(pool);

    await store.record({
      eventType: "invite.rejected",
      scopeId: "onboarding-key-1",
      outcome: "denied",
      occurredAt: "2026-08-23T00:00:00.000Z",
      metadata: { reason: "invalid_or_consumed" },
    });

    const result = await pool.query(
      "SELECT event_type, scope_id, outcome, metadata FROM fuse_operational_audit_events",
    );
    expect(result.rows).toEqual([{
      event_type: "invite.rejected",
      scope_id: "onboarding-key-1",
      outcome: "denied",
      metadata: { reason: "invalid_or_consumed" },
    }]);
    expect(JSON.stringify(result.rows)).not.toContain("fuse_invite_");
    await pool.end();
  });
});
