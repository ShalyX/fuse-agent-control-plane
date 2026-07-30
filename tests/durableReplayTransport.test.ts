import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "pg";
import { buildResponseCommitment, type StableSuccessfulResponseProjection } from "../src/reliability/commitments.js";
import { ReliabilityProtocolStore } from "../src/reliability/protocolStore.js";

const body = {
  model: "nousresearch/hermes-4-405b",
  max_tokens: 8,
  workload_class: "reliability.normal",
  messages: [{ role: "user", content: "hello" }],
};

const projection: StableSuccessfulResponseProjection = {
  id: "generation-1", object: "chat.completion", model: body.model,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  fuse: {
    decision: { id: "decision-1", outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] },
    workloadScope: { branchId: "branch-1", workloadClass: "reliability.normal" },
    reservationAtomic: "12", actualCostAtomic: "10",
  },
};

function replayInput(transport: () => Promise<{ id: string; content: string; usage: { inputTokens: number; outputTokens: number } }>) {
  return {
    operationId: "replay-1234567890abcdef", organizationId: "org-1", credentialId: "credential-1",
    agentId: "agent-1", mandateId: "mandate-1", branchId: "branch-1", workloadClass: "reliability.normal",
    requestId: "request-1", body, ownerId: "agent-1", transport: async () => transport(),
  };
}

function replayDatabase(events: string[]) {
  let state = "authorized";
  const client = {
    query: vi.fn(async (sql: string): Promise<QueryResult<any>> => {
      events.push(sql);
      if (sql.includes("FROM reliability_sealed_calls sealed")) return { rows: [{
        run_id: "run-1", provider: "openrouter", model: body.model, max_output_tokens: 8,
        response_commitment: buildResponseCommitment(projection), reservation_cost_micros: "12",
        actual_cost_micros: "10", decision_id: "decision-1", replay_ordinal: 1,
        replay_state: state, durable_stage: "fresh_terminal", response_projection: null,
        response_json: { id: "generation-1", content: "ok", usage: { inputTokens: 2, outputTokens: 1 } },
      }], rowCount: 1 } as QueryResult<any>;
      if (sql.includes("FROM reliability_replay_mutex") && sql.includes("FOR UPDATE")) return { rows: [{ one: 1 }], rowCount: 1 } as QueryResult<any>;
      if (sql.includes("UPDATE reliability_replay_authorizations SET state='transport_started'")) {
        if (state !== "authorized") return { rows: [], rowCount: 0 } as QueryResult<any>;
        state = "transport_started";
        return { rows: [{ one: 1 }], rowCount: 1 } as QueryResult<any>;
      }
      if (sql.includes("SELECT table_name,operation,row_identity")) return { rows: [], rowCount: 0 } as QueryResult<any>;
      if (sql.includes("UPDATE reliability_replay_authorizations SET state='passed'")) {
        state = "passed";
        return { rows: [{ one: 1 }], rowCount: 1 } as QueryResult<any>;
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }], rowCount: 1 } as QueryResult<any>;
      return { rows: [], rowCount: 0 } as QueryResult<any>;
    }),
    release: vi.fn(),
  };
  return { database: { query: client.query, connect: vi.fn(async () => client) }, client, getState: () => state };
}

describe("remaining protocol writers", () => {
  it("routes reconciliation, readiness, replay audit, and settlement writes through shared exclusion", async () => {
    const sql: string[] = [];
    const client = { query: vi.fn(async (statement: string) => { sql.push(statement); return { rows: [] }; }), release: vi.fn() };
    const store = new ReliabilityProtocolStore({ query: client.query, connect: vi.fn(async () => client) } as never);
    const operations = [
      () => store.failReconciliationOffset({ runId: "run-1", requestId: "request-1", offsetSeconds: 30, failureCode: "FAILED" }),
      () => store.recordSetupReadinessReceipt({ runId: "run-1", expectedSnapshot: {}, actualSnapshot: {} }),
      () => store.scheduleReconciliation({ runId: "run-1", requestId: "request-1", offsetSeconds: 0,
        scheduledAt: "2026-01-01T00:00:00.000Z", evidenceCutoff: "2026-01-02T00:00:00.000Z", classificationDeadline: "2026-01-02T00:00:31.000Z" }),
      () => store.recordReplayAudit({ runId: "run-1", requestId: "request-1", replayNo: 1,
        originalResponseCommitment: "same", replayResponseCommitment: "same", writeSet: [] }),
      () => store.appendSettlementPoll({ runId: "run-1", pollNo: 1, offsetSeconds: 0, snapshotDigest: "sha256:x", complete: false }),
    ];
    for (const operation of operations) {
      sql.length = 0;
      await operation();
      expect(sql[0]).toBe("BEGIN");
      expect(sql.some((statement) => statement.includes("pg_advisory_xact_lock_shared"))).toBe(true);
      expect(sql.at(-1)).toBe("COMMIT");
    }
  });
});

describe("durable replay run completion", () => {
  it("atomically verifies exactly twenty passed ordinals and advances the durable stage", async () => {
    const sql: string[] = [];
    const rows = Array.from({ length: 20 }, (_, index) => ({ replay_ordinal: index + 1, request_id: `request-${index + 1}`, state: "passed", audited: true }));
    const client = { query: vi.fn(async (statement: string) => {
      sql.push(statement);
      if (statement.includes("FROM reliability_protocol_controls") && statement.includes("FOR UPDATE")) return { rows: [{ durable_stage: "fresh_terminal" }] };
      if (statement.includes("FROM reliability_replay_authorizations") && statement.includes("ORDER BY")) return { rows };
      return { rows: [] };
    }), release: vi.fn() };
    const store = new ReliabilityProtocolStore({ query: client.query, connect: vi.fn(async () => client) } as never) as ReliabilityProtocolStore & {
      completeReplayRun?: (runId: string) => Promise<void>;
    };

    expect(typeof store.completeReplayRun).toBe("function");
    await store.completeReplayRun!("run-1");
    expect(sql.some((statement) => statement.includes("replay_passed_count=20") && statement.includes("durable_stage='replay_terminal'"))).toBe(true);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.some((statement) => statement.includes("pg_advisory_xact_lock_shared"))).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
  });
});

describe("durable deterministic replay return", () => {
  it("returns the original persisted response and commits one audit without provider transport", async () => {
    const events: string[] = [];
    const fake = replayDatabase(events);
    const transport = vi.fn(async () => {
      events.push("PROVIDER_TRANSPORT");
      return { id: "rogue-generation", content: "rogue", usage: { inputTokens: 99, outputTokens: 99 } };
    });
    const store = new ReliabilityProtocolStore(fake.database as never);

    await expect(store.executeAuthenticatedSealedReplay(replayInput(transport))).resolves.toEqual(projection);

    expect(transport).not.toHaveBeenCalled();
    expect(events).not.toContain("PROVIDER_TRANSPORT");
    expect(events.some((event) => event.includes("INSERT INTO reliability_replay_audits"))).toBe(true);
    expect(events.some((event) => event.includes("SET state='passed'"))).toBe(true);
    expect(events.some((event) => event.includes("transport_started"))).toBe(false);
    expect(fake.getState()).toBe("passed");
  });
});
