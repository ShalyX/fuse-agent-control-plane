import { createHash } from "node:crypto";
import { verifyBeacon as verifyDrandBeacon } from "drand-client/beacon-verification.js";
import type { ChainInfo, G2ChainedBeacon } from "drand-client";

export const RELIABILITY_V2_CHAIN_HASH = "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce";
export const RELIABILITY_V2_CHAIN_PUBLIC_KEY = "868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31";
export const RELIABILITY_V2_ROUND = 6_315_000;
export const RELIABILITY_V2_PROVIDER = "openrouter" as const;
export const RELIABILITY_V2_MODEL = "nousresearch/hermes-4-405b" as const;
export const EXPECTED_V2_PLAN_FINGERPRINT_TEST_BEACON = "sha256:937a7b644077810644d8d478ac85a8bdbdc38d9a727c0a6f8f5722f65c86ecba";
export const AUTHORIZATION_WINDOW = {
  startsAt: "2026-07-25T08:16:00.000Z",
  startsBefore: "2026-07-25T08:16:01.000Z",
  operationDeadlineMs: 55_000,
} as const;

export const V2_LANES = [
  { id: "normal-paced", workloadClass: "baseline-lookup", contextMin: 30, contextMax: 120, mode: "sequential", mandateMaximum: "250002", children: ["130001", "120001"] },
  { id: "high-envelope", workloadClass: "spike-burst", contextMin: 450, contextMax: 850, mode: "sequential", mandateMaximum: "1250002", children: ["600001", "650001"] },
  { id: "bounded-burst", workloadClass: "spike-burst", contextMin: 30, contextMax: 120, mode: "bounded-burst", mandateMaximum: "1250002", children: ["650001", "600001"] },
  { id: "restart-resume", workloadClass: "baseline-lookup", contextMin: 30, contextMax: 120, mode: "restart-resume", mandateMaximum: "250002", children: ["120001", "130001"] },
] as const;
export type ReliabilityLaneId = typeof V2_LANES[number]["id"];

export const V2_SCHEDULE = [
  { block: 1, opensAt: "2026-07-25T08:17:00.000Z", launchDeadline: "2026-07-25T08:22:00.000Z" },
  { block: 2, opensAt: "2026-07-25T20:17:00.000Z", launchDeadline: "2026-07-25T20:22:00.000Z" },
  { block: 3, opensAt: "2026-07-26T08:17:00.000Z", launchDeadline: "2026-07-26T08:22:00.000Z" },
  { block: 4, opensAt: "2026-07-26T20:17:00.000Z", launchDeadline: "2026-07-26T20:22:00.000Z" },
  { block: 5, opensAt: "2026-07-27T08:17:00.000Z", launchDeadline: "2026-07-27T08:22:00.000Z" },
] as const;

export interface VerifiedReliabilityBeacon {
  round: 6315000;
  randomness: string;
  signature: string;
  previousSignature: string;
  chainHash: typeof RELIABILITY_V2_CHAIN_HASH;
  verified: true;
}

export type ChainedBlsVerifier = (input: {
  round: number; randomness: string; signature: string; previousSignature: string;
  chainHash: string; publicKey: string; scheme: "pedersen-bls-chained";
}) => boolean | Promise<boolean>;

const PINNED_DRAND_CHAIN_INFO: ChainInfo = Object.freeze({
  public_key: RELIABILITY_V2_CHAIN_PUBLIC_KEY,
  period: 30,
  genesis_time: 1_595_431_050,
  hash: RELIABILITY_V2_CHAIN_HASH,
  groupHash: "",
  schemeID: "pedersen-bls-chained",
  metadata: { beaconID: "default" },
});

export async function verifyPinnedDrandChainedBeaconAtRound(value: unknown, expectedRound: number): Promise<boolean> {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(expectedRound) || expectedRound < 1) return false;
  const item = value as Record<string, unknown>;
  if (item.round !== expectedRound || typeof item.randomness !== "string"
    || typeof item.signature !== "string" || typeof item.previous_signature !== "string"
    || !/^[a-f0-9]{64}$/.test(item.randomness) || !/^[a-f0-9]{192}$/.test(item.signature)
    || !/^[a-f0-9]{192}$/.test(item.previous_signature)) return false;
  const expectedRandomness = createHash("sha256").update(Buffer.from(item.signature, "hex")).digest("hex");
  if (item.randomness !== expectedRandomness) return false;
  try {
    return await verifyDrandBeacon(PINNED_DRAND_CHAIN_INFO, item as G2ChainedBeacon, expectedRound);
  } catch {
    return false;
  }
}

export async function verifyPinnedReliabilityBeacon(value: unknown): Promise<VerifiedReliabilityBeacon> {
  if (!await verifyPinnedDrandChainedBeaconAtRound(value, RELIABILITY_V2_ROUND)) {
    throw new Error("RELIABILITY_V2_BEACON_BLS_INVALID");
  }
  const item = value as G2ChainedBeacon;
  return {
    round: RELIABILITY_V2_ROUND,
    randomness: item.randomness,
    signature: item.signature,
    previousSignature: item.previous_signature,
    chainHash: RELIABILITY_V2_CHAIN_HASH,
    verified: true,
  };
}

export async function verifyChainedBeacon(value: unknown, verifier: ChainedBlsVerifier): Promise<VerifiedReliabilityBeacon> {
  if (!value || typeof value !== "object") throw new Error("RELIABILITY_V2_BEACON_INVALID");
  const item = value as Record<string, unknown>;
  if (item.round !== RELIABILITY_V2_ROUND || typeof item.randomness !== "string"
    || typeof item.signature !== "string" || typeof item.previous_signature !== "string"
    || !/^[a-f0-9]{64}$/.test(item.randomness) || !/^[a-f0-9]{192}$/.test(item.signature)
    || !/^[a-f0-9]{192}$/.test(item.previous_signature)) throw new Error("RELIABILITY_V2_BEACON_INVALID");
  const ok = await verifier({
    round: item.round, randomness: item.randomness, signature: item.signature,
    previousSignature: item.previous_signature, chainHash: RELIABILITY_V2_CHAIN_HASH,
    publicKey: RELIABILITY_V2_CHAIN_PUBLIC_KEY, scheme: "pedersen-bls-chained",
  });
  if (!ok) throw new Error("RELIABILITY_V2_BEACON_BLS_INVALID");
  return {
    round: RELIABILITY_V2_ROUND, randomness: item.randomness, signature: item.signature,
    previousSignature: item.previous_signature, chainHash: RELIABILITY_V2_CHAIN_HASH, verified: true,
  };
}

export interface ExecutableIdentity {
  preregistrationCommit: string; implementationCommit: string; implementationTree: string;
  reviewDigest: string; buildDigest: string; runtimeImageDigest: string; schemaFingerprint: string;
  runnerDigest: string; adapterDigest: string;
}

export interface ReliabilityCall {
  block: number; lane: ReliabilityLaneId; laneOrdinal: number; callOrdinal: number;
  laneCallOrdinal: number; requestId: string; branch: 1 | 2; workloadClass: "baseline-lookup" | "spike-burst";
  contextUnits: number; maxOutputTokens: 8; reservationUsdMicros: "10000" | "50000";
}

export interface ReliabilityLaneAuthority {
  lane: ReliabilityLaneId; agentId: string; credentialId: string;
  policy: { id: string; version: 1; mode: "enforce"; workloadClass: "baseline-lookup" | "spike-burst";
    perCallUsdMicros: "10000" | "50000"; aggregateUsdMicros: string; hourlyUsdMicros: string;
    dailyUsdMicros: string; maxRequestsPerMinute: 5; maxInputTokens: 850; maxOutputTokens: 8;
    expiresAt: "2026-07-28T10:30:00.000Z" };
  mandate: { id: string; maximumUsdMicros: string; expiresAt: "2026-07-28T10:30:00.000Z" };
  root: { id: string; maximumUsdMicros: string; expiresAt: "2026-07-28T10:30:00.000Z" };
  children: readonly [
    { id: string; branch: 1; maximumUsdMicros: string; expiresAt: "2026-07-28T10:30:00.000Z" },
    { id: string; branch: 2; maximumUsdMicros: string; expiresAt: "2026-07-28T10:30:00.000Z" },
  ];
}
export interface ReliabilitySetup {
  organizationId: string; providerConfigurationId: string; runnerServiceAccountId: string;
  reconcilerServiceAccountId: string; reconcilerCredentialId: string;
  endpoints: { inference: "/v1/chat/completions"; generation: "/api/v1/generation"; generationContent: "/api/v1/generation/content"; mappingVersion: 2 };
  hardFinalizationAt: "2026-07-28T09:30:00.000Z"; authority: ReliabilityLaneAuthority[];
  configurationFingerprint: string; setupFingerprint: string;
}

export interface ReliabilityPlan {
  schemaVersion: 2; evidenceType: "held-out-reliability"; protocolVersion: 2; runId: string;
  provider: "openrouter"; model: "nousresearch/hermes-4-405b"; allowFallbacks: false; adapterRetryCount: 0;
  beacon: VerifiedReliabilityBeacon; identity: ExecutableIdentity; schedule: typeof V2_SCHEDULE;
  lanes: typeof V2_LANES; setup: ReliabilitySetup; calls: ReliabilityCall[];
  replayTargets: Array<{ block: number; lane: ReliabilityLaneId; callOrdinal: number; requestId: string }>;
  cost: { knownCostCapUsdMicros: "3000000"; unresolvedExposureCapUsdMicros: "320000" };
  planFingerprint: string;
}

class RejectionWordStream {
  private counter = 0;
  private words: number[] = [];
  constructor(private readonly randomness: string) {}
  draw(min: number, max: number): number {
    const m = max - min + 1;
    const limit = Math.floor(0x1_0000_0000 / m) * m;
    let word: number;
    do word = this.next(); while (word >= limit);
    return min + (word % m);
  }
  private next(): number {
    if (this.words.length === 0) {
      const index = Buffer.alloc(4); index.writeUInt32BE(this.counter++);
      const digest = createHash("sha256").update("fuse-held-out-reliability-v2")
        .update(Buffer.from(this.randomness, "hex")).update(index).digest();
      this.words = Array.from({ length: 8 }, (_, offset) => digest.readUInt32BE(offset * 4));
    }
    return this.words.shift()!;
  }
}

export function deriveReliabilityRequestId(runId: string, block: number, lane: ReliabilityLaneId, callOrdinal: number): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId) || !Number.isInteger(block) || block < 1 || block > 5
    || !V2_LANES.some((item) => item.id === lane) || !Number.isInteger(callOrdinal) || callOrdinal < 1 || callOrdinal > 5) {
    throw new Error("RELIABILITY_V2_REQUEST_ID_INPUT_INVALID");
  }
  const digest = createHash("sha256").update(canonicalJson({
    domain: "fuse-held-out-reliability-v2-request", protocolVersion: 2, runId, block, lane, callOrdinal,
  })).digest("hex");
  return `hov2_${digest.slice(0, 48)}`;
}

export function buildReliabilityPlan(
  beacon: VerifiedReliabilityBeacon,
  runId: string,
  identity: ExecutableIdentity,
  internalSkipValidation = false,
): ReliabilityPlan {
  validateIdentity(identity);
  if (beacon.verified !== true || beacon.round !== RELIABILITY_V2_ROUND || beacon.chainHash !== RELIABILITY_V2_CHAIN_HASH
    || !/^[a-f0-9]{64}$/.test(beacon.randomness)) throw new Error("RELIABILITY_V2_BEACON_INVALID");
  const random = new RejectionWordStream(beacon.randomness);
  const setupId = runId.replace(/[^A-Za-z0-9._:-]/g, "-");
  const organizationId = `hov2-${setupId}`;
  const expiry = "2026-07-28T10:30:00.000Z" as const;
  const authority: ReliabilityLaneAuthority[] = V2_LANES.map((lane) => {
    const maximum = lane.mandateMaximum;
    const perCall = lane.workloadClass === "baseline-lookup" ? "10000" as const : "50000" as const;
    return { lane: lane.id, agentId: `${organizationId}-agent-${lane.id}`, credentialId: `${organizationId}-credential-${lane.id}`,
      policy: { id: `${organizationId}-policy-${lane.id}`, version: 1, mode: "enforce", workloadClass: lane.workloadClass,
        perCallUsdMicros: perCall, aggregateUsdMicros: maximum, hourlyUsdMicros: maximum, dailyUsdMicros: maximum,
        maxRequestsPerMinute: 5, maxInputTokens: 850, maxOutputTokens: 8, expiresAt: expiry },
      mandate: { id: `${organizationId}-mandate-${lane.id}`, maximumUsdMicros: maximum, expiresAt: expiry },
      root: { id: `${organizationId}-root-${lane.id}`, maximumUsdMicros: maximum, expiresAt: expiry },
      children: [
        { id: `${organizationId}-child-${lane.id}-1`, branch: 1, maximumUsdMicros: lane.children[0], expiresAt: expiry },
        { id: `${organizationId}-child-${lane.id}-2`, branch: 2, maximumUsdMicros: lane.children[1], expiresAt: expiry },
      ] };
  });
  const setupConfiguration = { organizationId, providerConfigurationId: `${organizationId}-openrouter`,
    runnerServiceAccountId: `${organizationId}-runner`, reconcilerServiceAccountId: `${organizationId}-reconciler`,
    reconcilerCredentialId: `${organizationId}-reconciler-credential`,
    endpoints: { inference: "/v1/chat/completions" as const, generation: "/api/v1/generation" as const,
      generationContent: "/api/v1/generation/content" as const, mappingVersion: 2 as const },
    hardFinalizationAt: "2026-07-28T09:30:00.000Z" as const };
  const setup: ReliabilitySetup = { ...setupConfiguration, authority,
    configurationFingerprint: fingerprint({ ...setupConfiguration, provider: RELIABILITY_V2_PROVIDER, model: RELIABILITY_V2_MODEL, allowFallbacks: false }),
    setupFingerprint: fingerprint(authority) };
  const calls: ReliabilityCall[] = [];
  for (let block = 1; block <= 5; block++) {
    for (const [laneIndex, lane] of V2_LANES.entries()) {
      for (let callOrdinal = 1; callOrdinal <= 5; callOrdinal++) {
        const laneCallOrdinal = (block - 1) * 5 + callOrdinal;
        const oddLane = (laneIndex + 1) % 2 === 1;
        const branch = ((laneCallOrdinal % 2 === 1) === oddLane ? 1 : 2) as 1 | 2;
        calls.push({ block, lane: lane.id, laneOrdinal: laneIndex + 1, callOrdinal, laneCallOrdinal,
          requestId: deriveReliabilityRequestId(runId, block, lane.id, callOrdinal), branch,
          workloadClass: lane.workloadClass, contextUnits: random.draw(lane.contextMin, lane.contextMax),
          maxOutputTokens: 8, reservationUsdMicros: lane.workloadClass === "baseline-lookup" ? "10000" : "50000" });
      }
    }
  }
  const replayTargets: ReliabilityPlan["replayTargets"] = [];
  for (let block = 1; block <= 5; block++) for (const lane of V2_LANES) {
    const callOrdinal = random.draw(1, 5);
    replayTargets.push({ block, lane: lane.id, callOrdinal,
      requestId: deriveReliabilityRequestId(runId, block, lane.id, callOrdinal) });
  }
  const payload = {
    schemaVersion: 2 as const, evidenceType: "held-out-reliability" as const, protocolVersion: 2 as const,
    runId, provider: RELIABILITY_V2_PROVIDER, model: RELIABILITY_V2_MODEL, allowFallbacks: false as const,
    adapterRetryCount: 0 as const, beacon, identity, schedule: V2_SCHEDULE, lanes: V2_LANES, setup, calls, replayTargets,
    cost: { knownCostCapUsdMicros: "3000000" as const, unresolvedExposureCapUsdMicros: "320000" as const },
  };
  const plan = { ...payload, planFingerprint: fingerprint(payload) };
  if (!internalSkipValidation) validateReliabilityPlan(plan, false);
  return plan;
}

const PLAN_KEYS = ["adapterRetryCount", "allowFallbacks", "beacon", "calls", "cost", "evidenceType", "identity", "lanes", "model", "planFingerprint", "protocolVersion", "provider", "replayTargets", "runId", "schedule", "schemaVersion", "setup"];
export function validateReliabilityPlan(plan: ReliabilityPlan, enforceTestGolden = true): void {
  if (!plan || typeof plan !== "object" || JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(PLAN_KEYS))
    throw new Error("RELIABILITY_V2_PLAN_UNKNOWN_FIELD");
  if (plan.schemaVersion !== 2 || plan.evidenceType !== "held-out-reliability" || plan.protocolVersion !== 2
    || plan.provider !== RELIABILITY_V2_PROVIDER || plan.model !== RELIABILITY_V2_MODEL || plan.allowFallbacks !== false
    || plan.adapterRetryCount !== 0 || canonicalJson(plan.schedule) !== canonicalJson(V2_SCHEDULE)
    || canonicalJson(plan.lanes) !== canonicalJson(V2_LANES)) throw new Error("RELIABILITY_V2_PLAN_DRIFT");
  validateIdentity(plan.identity);
  const { planFingerprint, ...payload } = plan;
  if (planFingerprint !== fingerprint(payload)) throw new Error("RELIABILITY_V2_PLAN_FINGERPRINT_MISMATCH");
  const expected = buildReliabilityPlan(plan.beacon, plan.runId, plan.identity, true);
  if (canonicalJson(expected) !== canonicalJson(plan)) throw new Error("RELIABILITY_V2_PLAN_RECIPE_MISMATCH");
  if (enforceTestGolden && plan.beacon.randomness === "11".repeat(32)
    && plan.planFingerprint !== EXPECTED_V2_PLAN_FINGERPRINT_TEST_BEACON) throw new Error("RELIABILITY_V2_PLAN_GOLDEN_MISMATCH");
}

function validateIdentity(identity: ExecutableIdentity): void {
  const sha = /^sha256:[a-f0-9]{64}$/;
  if (identity.preregistrationCommit !== "6c6ef80" || !/^[a-f0-9]{40}$/.test(identity.implementationCommit)
    || !/^[a-f0-9]{40}$/.test(identity.implementationTree) || !sha.test(identity.reviewDigest)
    || !sha.test(identity.buildDigest) || !sha.test(identity.runtimeImageDigest) || !sha.test(identity.schemaFingerprint)
    || !sha.test(identity.runnerDigest) || !sha.test(identity.adapterDigest)) throw new Error("RELIABILITY_V2_IDENTITY_UNREVIEWED");
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
