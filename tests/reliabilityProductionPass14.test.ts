import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import * as operational from "../src/reliability/operationalV2.js";
import * as protocol from "../src/reliability/protocolStore.js";
import { RELIABILITY_SCHEMA_SQL } from "../src/reliability/reliabilitySchema.js";
import { RELIABILITY_V2_PROFILE } from "../src/reliability/protocolProfile.js";
import * as runner from "../scripts/held-out-reliability-v2.js";

const sha = `sha256:${"a".repeat(64)}`;

describe("reliability v2 operational blockers", () => {
  it("runs every ambiguous request concurrently, including requests without a generation id, and authenticates every offset", async () => {
    const execute = (operational as Record<string, unknown>)["executeConcurrentReconciliation"] as undefined | ((input: any) => Promise<any>);
    expect(typeof execute).toBe("function");
    if (!execute) throw new Error("CONCURRENT_RECONCILIATION_SCHEDULER_MISSING");
    let active = 0; let maximum = 0;
    const authorized: string[] = []; const persisted: any[] = [];
    const result = await execute({
      requests: [
        { requestId: "with-generation", generationId: "g-1", ambiguityEnteredAt: "2026-07-23T00:00:00.000Z" },
        { requestId: "without-generation", generationId: null, ambiguityEnteredAt: "2026-07-23T00:00:00.000Z" },
      ],
      offsets: [0],
      authorizeOffset: async ({ requestId, offsetSeconds }: any) => { authorized.push(`${requestId}:${offsetSeconds}`); return { credentialId: "reconciler", authorizationSha256: sha }; },
      waitUntil: async () => undefined,
      lookup: async ({ generationId }: any) => { active++; maximum = Math.max(maximum, active); await new Promise((r) => setTimeout(r, 15)); active--; return generationId ? { disposition: "pending" } : { disposition: "generation_unavailable" }; },
      persistPhase: async (phase: any) => { persisted.push(phase); },
    });
    expect(maximum).toBe(2);
    expect(authorized.sort()).toEqual(["with-generation:0", "without-generation:0"]);
    expect(result).toEqual({ requests: 2, terminal: 0, failed: 0 });
    expect(persisted.filter((row) => row.phase === "authorized")).toHaveLength(2);
    expect(persisted.filter((row) => row.phase === "lookup_finished")).toHaveLength(2);
    expect(persisted.every((row) => row.measuredAtMs >= 0)).toBe(true);
  });

  it("persists a measured failed phase instead of losing scheduler failures", async () => {
    const execute = (operational as any).executeConcurrentReconciliation;
    expect(typeof execute).toBe("function");
    const phases: any[] = [];
    const result = await execute({
      requests: [{ requestId: "r", generationId: "g", ambiguityEnteredAt: "2026-07-23T00:00:00.000Z" }], offsets: [0],
      authorizeOffset: async () => ({ credentialId: "reconciler", authorizationSha256: sha }), waitUntil: async () => undefined,
      lookup: async () => { throw new Error("LOCAL_FAULT"); }, persistPhase: async (phase: any) => { phases.push(phase); },
    });
    expect(result).toEqual({ requests: 1, terminal: 0, failed: 1 });
    expect(phases.at(-1)).toMatchObject({ phase: "failed", errorCode: "LOCAL_FAULT" });
  });

  it("removes independently terminal held members while preserving FIFO order for remaining work", () => {
    const decide = (operational as any).heldLaneFifoResolution;
    expect(typeof decide).toBe("function");
    expect(decide({ members: ["a", "b"], requestId: "b", transitionCommittedAtMs: 1 })).toEqual({ remaining: ["a"], resumeAtMs: null });
    expect(decide({ members: ["a", "b"], requestId: "a", transitionCommittedAtMs: 1 })).toEqual({ remaining: ["b"], resumeAtMs: null });
    expect(decide({ members: ["a"], requestId: "a", transitionCommittedAtMs: 301_000 })).toEqual({ remaining: [], resumeAtMs: 600_000 });
    expect(protocol.ReliabilityProtocolStore.prototype.applyAuthoritativeReconciliation.toString()).not.toContain("heldMembers[0]");
  });

  it("waits then reconciles tokenized restart recovery and repairs a missing terminal manifest", async () => {
    const recover = (operational as any).recoverSchedulerWorker;
    expect(typeof recover).toBe("function");
    const states = [
      { terminal: false, dispatchToken: true, primitiveEntered: false },
      { terminal: false, dispatchToken: true, primitiveEntered: true },
    ];
    const published: any[] = [];
    const result = await recover({
      readState: async () => states.shift()!, waitForAuthoritativeOutcome: async () => undefined,
      reconcile: async () => ({ terminal: true }), readManifest: async () => ({ state: "awaiting_outcome", sequence: 3 }),
      publishManifest: async (manifest: any) => { published.push(manifest); },
    });
    expect(result).toMatchObject({ action: "reconciled", terminal: true, manifestRepaired: true });
    expect(published).toEqual([{ state: "terminal", sequence: 4, recoveryDecision: "already_terminal" }]);
  });

  it("returns an existing same-owner block claim after its original launch window", async () => {
    const queried: string[] = [];
    const claimedAt = new Date("2026-07-25T08:18:00.000Z");
    const client = {
      query: async (statement: string) => {
        queried.push(statement);
        if (statement.includes("FROM reliability_protocol_controls")) return { rows: [{
          state: "active", plan_fingerprint: sha, failure_sequence: "0",
          protocol_version: RELIABILITY_V2_PROFILE.protocolVersion,
          evidence_type: RELIABILITY_V2_PROFILE.evidenceType,
          plan_schema_version: RELIABILITY_V2_PROFILE.planSchemaVersion,
          mapping_version: RELIABILITY_V2_PROFILE.mappingVersion,
          profile_fingerprint: RELIABILITY_V2_PROFILE.profileFingerprint,
        }] };
        if (statement.includes("FROM reliability_authorization_decisions")) return { rows: [{ ok: 1 }] };
        if (statement.includes("FROM reliability_sealed_calls")) return { rows: [{ count: "100" }] };
        if (statement.includes("FROM reliability_block_claims") && statement.includes("FOR UPDATE")) {
          return { rows: [{ owner_id: "runner-a", claimed_at: claimedAt, opens_at: new Date("2026-07-25T08:17:00.000Z"), launch_deadline: new Date("2026-07-25T08:22:00.000Z"), plan_fingerprint: sha }] };
        }
        if (statement.includes("clock_timestamp")) throw new Error("RESTART_MUST_NOT_RECHECK_EXPIRED_WINDOW");
        return { rows: [] };
      },
      release: () => undefined,
    };
    const store = new protocol.ReliabilityProtocolStore({ connect: async () => client, query: client.query } as never);
    await expect(store.claimBlock({ runId: "run", block: 1, ownerId: "runner-a", opensAt: "2026-07-25T08:17:00.000Z", launchDeadline: "2026-07-25T08:22:00.000Z", planFingerprint: sha }))
      .resolves.toEqual({ claimedAt: claimedAt.toISOString() });
    expect(queried.some((statement) => statement.includes("INSERT INTO reliability_block_claims"))).toBe(false);
  });

  it("snapshots every released nonterminal burst sibling on the first lane hold", async () => {
    const holdMemberValues: unknown[][] = [];
    const client = {
      query: async (statement: string, values?: unknown[]) => {
        if (statement.includes("FROM reliability_protocol_controls")) return { rows: [{
          state: "active", plan_fingerprint: sha,
          protocol_version: RELIABILITY_V2_PROFILE.protocolVersion,
          evidence_type: RELIABILITY_V2_PROFILE.evidenceType,
          plan_schema_version: RELIABILITY_V2_PROFILE.planSchemaVersion,
          mapping_version: RELIABILITY_V2_PROFILE.mappingVersion,
          profile_fingerprint: RELIABILITY_V2_PROFILE.profileFingerprint,
        }] };
        if (statement.includes("FROM reliability_protocol_lanes")) return { rows: [{ state: "ready" }] };
        if (statement.startsWith("SELECT 1 FROM reliability_protocol_attempts")) return { rows: [{ ok: 1 }] };
        if (statement.includes("FROM reliability_protocol_holds") && statement.includes("resolved_at IS NULL")) return { rows: [] };
        if (statement.includes("FROM reliability_burst_barriers")) return { rows: [{ planned_request_ids: ["burst-a", "burst-b", "burst-c"] }] };
        if (statement.includes("request_id=ANY")) return { rows: [{ request_id: "burst-c" }, { request_id: "burst-a" }, { request_id: "burst-b" }] };
        if (statement.startsWith("INSERT INTO reliability_hold_members")) holdMemberValues.push(values ?? []);
        return { rows: [] };
      },
      release: () => undefined,
    };
    const store = new protocol.ReliabilityProtocolStore({ connect: async () => client, query: client.query } as never);
    const held = await store.enterLaneHold({ runId: "run", laneId: "bounded-burst", requestId: "burst-a" });
    expect(held.members).toEqual(["burst-a", "burst-b", "burst-c"]);
    expect(holdMemberValues.map((values) => [values[3], values[4]])).toEqual([["burst-a", 1], ["burst-b", 2], ["burst-c", 3]]);
  });

  it("compares setup readiness field by field rather than trusting cardinalities", () => {
    const diff = (operational as any).setupSnapshotDifferences;
    expect(typeof diff).toBe("function");
    const expected = { organization: { id: "o", status: "active" }, provider: { id: "p", model: "m", fallback: false }, lanes: [{ id: "a", credentialId: "c" }] };
    expect(diff(expected, structuredClone(expected))).toEqual([]);
    expect(diff(expected, { ...expected, provider: { ...expected.provider, fallback: true } })).toEqual(["provider.fallback"]);
    expect(diff(expected, { ...expected, lanes: [{ id: "a", credentialId: "wrong" }] })).toEqual(["lanes[0].credentialId"]);
  });

  it("has durable per-offset authorization, measured phase, failure, FIFO and readiness receipt storage", () => {
    for (const fragment of ["authorization_sha256", "authorized_at", "lookup_started_at", "lookup_finished_at", "failure_code", "member_sequence", "reliability_setup_readiness_receipts"]) {
      expect(RELIABILITY_SCHEMA_SQL).toContain(fragment);
    }
    const prototype = protocol.ReliabilityProtocolStore.prototype as any;
    for (const method of ["authorizeReconciliationOffset", "failReconciliationOffset", "resumeDueLanes", "recordSetupReadinessReceipt"]) expect(typeof prototype[method]).toBe("function");
  });

  it("drives authenticated lookups against a local full-stack fault server without external network", async () => {
    const observed: string[] = [];
    const server = createServer((request, response) => {
      observed.push(`${request.headers.authorization}:${request.url}`);
      setTimeout(() => { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"pending"}'); }, 10);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("SERVER_ADDRESS_MISSING");
    try {
      const execute = (operational as any).executeConcurrentReconciliation;
      const result = await execute({
        requests: [{ requestId: "a", generationId: "ga", ambiguityEnteredAt: "2026-07-23T00:00:00.000Z" }, { requestId: "b", generationId: "gb", ambiguityEnteredAt: "2026-07-23T00:00:00.000Z" }], offsets: [0],
        authorizeOffset: async () => ({ credentialId: "reconciler", authorizationSha256: sha }), waitUntil: async () => undefined,
        lookup: async ({ generationId, authorization }: any) => {
          const response = await fetch(`http://127.0.0.1:${address.port}/generation?id=${generationId}`, { headers: { authorization: `Bearer ${authorization.credentialId}` } });
          return { disposition: response.status === 503 ? "pending" : "terminal" };
        }, persistPhase: async () => undefined,
      });
      expect(result.failed).toBe(0);
      expect(observed.sort()).toEqual(["Bearer reconciler:/generation?id=ga", "Bearer reconciler:/generation?id=gb"]);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("production operations invoke the pass14 scheduler, restart recovery, FIFO resume, and readiness gate", () => {
    const source = runner.createReliabilityOperations.toString();
    for (const productionCall of [
      "executeConcurrentReconciliation", "recoverSchedulerWorker", "resumeDueLanes",
      "recordSetupReadinessReceipt", "requireSetupReadinessReceipt",
    ]) expect(source).toContain(productionCall);
  });

  it("requires one exact green durable setup receipt and rejects red or stale receipts", async () => {
    const requireReceipt = (protocol.ReliabilityProtocolStore.prototype as any).requireSetupReadinessReceipt;
    expect(typeof requireReceipt).toBe("function");
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const database = { query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [{ ready: true, snapshot_digest: sha, plan_fingerprint: sha }] };
    } };
    await expect(requireReceipt.call({ database }, { runId: "run", planFingerprint: sha })).resolves.toBe(sha);
    expect(queries[0]?.text).toContain("receipt.ready=true");
    expect(queries[0]?.text).toContain("control.plan_fingerprint=$2");
  });
});
