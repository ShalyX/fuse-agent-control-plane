import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_WINDOW,
  EXPECTED_V2_PLAN_FINGERPRINT_TEST_BEACON,
  V2_LANES,
  buildReliabilityPlan,
  canonicalJson,
  deriveReliabilityRequestId,
  fingerprint,
  validateReliabilityPlan,
  verifyChainedBeacon,
  verifyPinnedDrandChainedBeaconAtRound,
} from "../src/evidence/heldOutReliabilityV2.js";

const randomness = "11".repeat(32);
const verifiedBeacon = {
  round: 6_315_000,
  randomness,
  signature: "22".repeat(96),
  previousSignature: "33".repeat(96),
  chainHash: "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce",
  verified: true as const,
};
const identity = {
  preregistrationCommit: "6c6ef80",
  implementationCommit: "a".repeat(40),
  implementationTree: "b".repeat(40),
  reviewDigest: `sha256:${"c".repeat(64)}`,
  buildDigest: `sha256:${"d".repeat(64)}`,
  runtimeImageDigest: `sha256:${"e".repeat(64)}`,
  schemaFingerprint: `sha256:${"1".repeat(64)}`,
  runnerDigest: `sha256:${"2".repeat(64)}`,
  adapterDigest: `sha256:${"3".repeat(64)}`,
};

describe("held-out reliability v2 sealed plan", () => {
  it("verifies the chained beacon through a pinned BLS verifier rather than a signature hash", async () => {
    let observed: unknown;
    const result = await verifyChainedBeacon({
      round: verifiedBeacon.round,
      randomness: verifiedBeacon.randomness,
      signature: verifiedBeacon.signature,
      previous_signature: verifiedBeacon.previousSignature,
    }, async (input) => {
      observed = input;
      return true;
    });
    expect(result).toEqual(verifiedBeacon);
    expect(observed).toMatchObject({ round: 6_315_000, previousSignature: verifiedBeacon.previousSignature });
    await expect(verifyChainedBeacon({
      round: verifiedBeacon.round,
      randomness: createHash("sha256").update(Buffer.from(verifiedBeacon.signature, "hex")).digest("hex"),
      signature: verifiedBeacon.signature,
      previous_signature: verifiedBeacon.previousSignature,
    }, async () => false)).rejects.toThrow("RELIABILITY_V2_BEACON_BLS_INVALID");
  });

  it("cryptographically verifies a pinned-chain historical golden beacon and rejects tampering", async () => {
    const fixture = JSON.parse(await readFile(new URL(
      "../evidence/held-out/beacons/drand-6311188.json",
      import.meta.url,
    ), "utf8")) as { response: { round: number; randomness: string; signature: string; previous_signature: string } };
    await expect(verifyPinnedDrandChainedBeaconAtRound(fixture.response, 6_311_188)).resolves.toBe(true);
    await expect(verifyPinnedDrandChainedBeaconAtRound({
      ...fixture.response,
      signature: `${fixture.response.signature.slice(0, -2)}00`,
    }, 6_311_188)).resolves.toBe(false);
  });

  it("uses rejection sampling in exact consumer order and seals 100 calls plus 20 replay targets", () => {
    const plan = buildReliabilityPlan(verifiedBeacon, "run-v2-test", identity);
    expect(plan.evidenceType).toBe("held-out-reliability");
    expect(plan.protocolVersion).toBe(2);
    expect(plan.calls).toHaveLength(100);
    expect(plan.replayTargets).toHaveLength(20);
    expect(plan.calls.map((call) => [call.block, call.lane, call.callOrdinal]).slice(0, 7)).toEqual([
      [1, "normal-paced", 1], [1, "normal-paced", 2], [1, "normal-paced", 3],
      [1, "normal-paced", 4], [1, "normal-paced", 5], [1, "high-envelope", 1],
      [1, "high-envelope", 2],
    ]);
    for (const call of plan.calls) {
      const lane = V2_LANES.find((item) => item.id === call.lane)!;
      expect(call.contextUnits).toBeGreaterThanOrEqual(lane.contextMin);
      expect(call.contextUnits).toBeLessThanOrEqual(lane.contextMax);
      expect(call.requestId).toBe(deriveReliabilityRequestId("run-v2-test", call.block, call.lane, call.callOrdinal));
      expect(call.maxOutputTokens).toBe(8);
    }
    expect(new Set(plan.calls.map(({ requestId }) => requestId)).size).toBe(100);
    expect(plan.planFingerprint).toBe(EXPECTED_V2_PLAN_FINGERPRINT_TEST_BEACON);
    expect(() => validateReliabilityPlan(plan)).not.toThrow();
  });

  it("derives disjoint fixed-length request IDs from immutable run identity", () => {
    const first = Array.from({ length: 100 }, (_, index) => {
      const block = Math.floor(index / 20) + 1;
      const lane = V2_LANES[Math.floor((index % 20) / 5)]!.id;
      return deriveReliabilityRequestId("run-one", block, lane, (index % 5) + 1);
    });
    const second = first.map((_, index) => {
      const block = Math.floor(index / 20) + 1;
      const lane = V2_LANES[Math.floor((index % 20) / 5)]!.id;
      return deriveReliabilityRequestId("run-two", block, lane, (index % 5) + 1);
    });
    expect(first.every((id) => /^hov2_[a-f0-9]{48}$/.test(id))).toBe(true);
    expect(new Set([...first, ...second]).size).toBe(200);
  });

  it("rejects unknown fields, tampering, provider/model/fallback/schedule drift, and unreviewed identities", () => {
    const plan = buildReliabilityPlan(verifiedBeacon, "run-v2-test", identity);
    expect(() => validateReliabilityPlan({ ...plan, extra: true } as never)).toThrow("RELIABILITY_V2_PLAN_UNKNOWN_FIELD");
    expect(() => validateReliabilityPlan({ ...plan, model: "other" } as never)).toThrow("RELIABILITY_V2_PLAN_DRIFT");
    expect(() => validateReliabilityPlan({ ...plan, allowFallbacks: true } as never)).toThrow("RELIABILITY_V2_PLAN_DRIFT");
    expect(() => validateReliabilityPlan({ ...plan, planFingerprint: fingerprint({ broken: true }) })).toThrow("RELIABILITY_V2_PLAN_FINGERPRINT_MISMATCH");
    expect(() => buildReliabilityPlan(verifiedBeacon, "run-v2-test", { ...identity, implementationCommit: "WORKTREE" }))
      .toThrow("RELIABILITY_V2_IDENTITY_UNREVIEWED");
  });

  it("keeps canonical JSON key sorted and pins authorization readiness timing", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(AUTHORIZATION_WINDOW).toEqual({
      startsAt: "2026-07-25T08:16:00.000Z",
      startsBefore: "2026-07-25T08:16:01.000Z",
      operationDeadlineMs: 55_000,
    });
  });
});
