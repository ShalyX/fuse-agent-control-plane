import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReliabilityPlan,
  fingerprint,
  type ExecutableIdentity,
  type VerifiedReliabilityBeacon,
} from "../src/evidence/heldOutReliabilityV2.js";
import {
  clopperPearsonDiagnostics,
  evaluateSettlement,
  reduceReliabilityEvidence,
} from "../src/evidence/reliabilityProtocolV2.js";
import {
  OpenRouterReconciler,
  decimalUsdToMicros,
} from "../src/reliability/openRouterReconciler.js";

const beacon: VerifiedReliabilityBeacon = {
  round: 6315000,
  randomness: "11".repeat(32),
  signature: "22".repeat(96),
  previousSignature: "33".repeat(96),
  chainHash: "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce",
  verified: true,
};
const identity: ExecutableIdentity = {
  preregistrationCommit: "6c6ef80",
  implementationCommit: "a".repeat(40), implementationTree: "b".repeat(40),
  reviewDigest: `sha256:${"c".repeat(64)}`, buildDigest: `sha256:${"d".repeat(64)}`,
  runtimeImageDigest: `sha256:${"e".repeat(64)}`, schemaFingerprint: `sha256:${"f".repeat(64)}`,
  runnerDigest: `sha256:${"1".repeat(64)}`, adapterDigest: `sha256:${"2".repeat(64)}`,
};

describe("reliability v2 sixth production pass", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

  it("seals complete least-authority setup and four distinct lane credentials", () => {
    const plan = buildReliabilityPlan(beacon, "run-six", identity);
    expect(plan.setup.organizationId).toBe("hov2-run-six");
    expect(plan.setup.configurationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.setup.setupFingerprint).toBe(fingerprint(plan.setup.authority));
    expect(plan.setup.endpoints).toEqual({
      inference: "/v1/chat/completions",
      generation: "/api/v1/generation",
      generationContent: "/api/v1/generation/content",
      mappingVersion: 2,
    });
    expect(plan.setup.hardFinalizationAt).toBe("2026-07-28T09:30:00.000Z");
    expect(plan.setup.authority).toHaveLength(4);
    expect(new Set(plan.setup.authority.map((lane) => lane.credentialId)).size).toBe(4);
    for (const lane of plan.setup.authority) {
      expect(lane.policy.maxRequestsPerMinute).toBe(5);
      expect(lane.policy.expiresAt).toBe("2026-07-28T10:30:00.000Z");
      expect(lane.root.maximumUsdMicros).toBe(lane.mandate.maximumUsdMicros);
      expect(lane.children.map((child) => child.maximumUsdMicros)).toHaveLength(2);
    }
    expect(plan.cost).toEqual({ knownCostCapUsdMicros: "3000000", unresolvedExposureCapUsdMicros: "320000" });
  });

  it("converts provider decimal costs to micros exactly without binary floating point", () => {
    expect(decimalUsdToMicros("0.000001")).toBe(1n);
    expect(decimalUsdToMicros(0.000001)).toBe(1n);
    expect(decimalUsdToMicros("1.234567")).toBe(1_234_567n);
    expect(() => decimalUsdToMicros("0.0000001")).toThrow("PROVIDER_COST_PRECISION_INVALID");
    expect(() => decimalUsdToMicros("NaN")).toThrow("PROVIDER_COST_DECIMAL_INVALID");
  });

  it("performs both authenticated reconciliation GETs concurrently and validates exact schema", async () => {
    let active = 0; let peak = 0; const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? ""); active++; peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        response.setHeader("content-type", "application/json");
        if (request.url?.startsWith("/api/v1/generation/content")) response.end(JSON.stringify({ data: { input: { messages: [{ role: "user", content: "hello" }] }, output: { completion: "ok", reasoning: null } } }));
        else response.end(JSON.stringify({ data: {
          id: "gen-1", request_id: "req-1", model: "nousresearch/hermes-4-405b", provider_name: "provider",
          created_at: "2026-07-25T08:17:01.000Z", cancelled: false, finish_reason: "stop", native_finish_reason: "stop",
          native_tokens_prompt: 1, native_tokens_completion: 1, tokens_prompt: 1, tokens_completion: 1,
          total_cost: "0.000002", usage: "0.000002", upstream_id: "up-1", router: null, provider_responses: null,
        } }));
      }, 25);
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("test server");
    const result = await new OpenRouterReconciler({ apiKey: "local-test", baseUrl: `http://127.0.0.1:${address.port}/api/v1`, timeoutMs: 1_000 }).reconcile({
      generationId: "gen-1", openRouterRequestId: "req-1", model: "nousresearch/hermes-4-405b",
      messages: [{ role: "user", content: "hello" }], dispatchTokenAt: "2026-07-25T08:17:00.000Z",
      ambiguityEnteredAt: "2026-07-25T08:17:02.000Z", finalOffset: false,
    });
    expect(peak).toBe(2);
    expect(paths.sort()).toEqual(["/api/v1/generation/content?id=gen-1", "/api/v1/generation?id=gen-1"].sort());
    expect(result.disposition).toBe("reconciled_billed_with_response");
    expect((result.metadata as any).status).toBe(200);
    expect((result.metadata as any).sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires authoritative settlement start timing and emits fixed-n diagnostics only without early stop", () => {
    expect(evaluateSettlement(1_000, [{ offset: 0, startedAt: 999, complete: true }]).passed).toBe(false);
    expect(evaluateSettlement(1_000, Array.from({ length: 25 }, (_, i) => ({ offset: i * 5, startedAt: 1_000 + i * 5, complete: i === 24 }))))
      .toMatchObject({ passed: true, acceptedOffset: 120 });
    const diagnostics = clopperPearsonDiagnostics({ planned: 100, admissionStarted: 100, canceledAfterGateFailure: 0, usable: 99, unresolved: 0 });
    expect(diagnostics?.usableLower).toBeCloseTo(0.953438, 5);
    expect(diagnostics?.unresolvedUpper).toBeCloseTo(0.029513, 5);
    expect(clopperPearsonDiagnostics({ planned: 100, admissionStarted: 99, canceledAfterGateFailure: 1, usable: 99, unresolved: 0 })).toBeNull();
  });

  it("reduces complete authoritative inventory and rejects missing or extra sealed IDs", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `r-${i}`);
    const rows = ids.map((requestId) => ({ requestId, state: "completed_verified" as const, gateClassifications: 1, admissionStarted: true, actualCostMicros: "1" }));
    const report = reduceReliabilityEvidence({ plannedRequestIds: ids, attempts: rows, replayPassed: 20, inventory: { protocolReceipts: 1, beacons: 1, plans: 1, authorizationReceipts: 2, laneClaims: 4, manifests: 20, replayReports: 1, extras: [] } });
    expect(report.gate.passed).toBe(true);
    expect(report.diagnostics).not.toBeNull();
    expect(() => reduceReliabilityEvidence({ plannedRequestIds: ids, attempts: rows.slice(1), replayPassed: 20, inventory: { protocolReceipts: 1, beacons: 1, plans: 1, authorizationReceipts: 2, laneClaims: 4, manifests: 20, replayReports: 1, extras: [] } })).toThrow("EVIDENCE_ATTEMPT_INVENTORY_INVALID");
  });
});
