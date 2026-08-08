import { createHash } from "node:crypto";
import {
  RELIABILITY_V3_PROFILE_CANONICAL_JSON,
  RELIABILITY_V3_PROFILE_GOLDEN_CANONICAL_JSON,
} from "./protocolProfileV3Canonical.js";
import {
  RELIABILITY_V4_PROFILE_CANONICAL_JSON,
  RELIABILITY_V4_PROFILE_GOLDEN_CANONICAL_JSON,
} from "./protocolProfileV4Canonical.js";

export interface ReliabilityProtocolProfile {
  protocolVersion: 2 | 3 | 4;
  evidenceType: "held-out-reliability" | "held-out-reliability-v3" | "held-out-reliability-v4";
  planSchemaVersion: 2;
  mappingVersion: 2;
  authorizationDecisionDomain: "fuse-reliability-v2-authorization" | "fuse-reliability-v3-authorization" | "fuse-reliability-v4-authorization";
  replayOperationDomain: "fuse-reliability-v2-replay-operation" | "fuse-reliability-v3-replay-operation" | "fuse-reliability-v4-replay-operation";
  artifactRoot: "evidence/held-out-reliability" | "evidence/held-out-reliability-v3" | "evidence/held-out-reliability-v4";
  claimRoot: "evidence/.run-claims/held-out-reliability" | "evidence/.run-claims/held-out-reliability-v3" | "evidence/.run-claims/held-out-reliability-v4";
  protocolArtifact: "held-out-reliability-v2.json" | "held-out-reliability-v3.json" | "held-out-reliability-v4.json";
  beaconRound: 6_315_000 | 6_338_040 | 6_355_320;
  profileFingerprint: string;
  coordinates?: Readonly<Record<string, unknown>>;
}

type ProfileSeed = Omit<ReliabilityProtocolProfile, "profileFingerprint" | "coordinates">;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export const RELIABILITY_V3_PROFILE_GOLDEN_FINGERPRINT = sha256(RELIABILITY_V3_PROFILE_GOLDEN_CANONICAL_JSON);
export const RELIABILITY_V3_PROFILE_FINGERPRINT = sha256(RELIABILITY_V3_PROFILE_CANONICAL_JSON);
export const RELIABILITY_V4_PROFILE_GOLDEN_FINGERPRINT = sha256(RELIABILITY_V4_PROFILE_GOLDEN_CANONICAL_JSON);
export const RELIABILITY_V4_PROFILE_FINGERPRINT = sha256(RELIABILITY_V4_PROFILE_CANONICAL_JSON);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function freezeProfile(seed: ProfileSeed, canonicalCoordinates?: string): ReliabilityProtocolProfile {
  if (!canonicalCoordinates) {
    return Object.freeze({ ...seed, profileFingerprint: sha256(JSON.stringify(seed)) });
  }
  const coordinates = deepFreeze(JSON.parse(canonicalCoordinates) as Record<string, unknown>);
  return Object.freeze({ ...seed, profileFingerprint: sha256(canonicalCoordinates), coordinates });
}

export const RELIABILITY_V2_PROFILE = freezeProfile({
  protocolVersion: 2,
  evidenceType: "held-out-reliability",
  planSchemaVersion: 2,
  mappingVersion: 2,
  authorizationDecisionDomain: "fuse-reliability-v2-authorization",
  replayOperationDomain: "fuse-reliability-v2-replay-operation",
  artifactRoot: "evidence/held-out-reliability",
  claimRoot: "evidence/.run-claims/held-out-reliability",
  protocolArtifact: "held-out-reliability-v2.json",
  beaconRound: 6_315_000,
});

export const RELIABILITY_V3_PROFILE = freezeProfile({
  protocolVersion: 3,
  evidenceType: "held-out-reliability-v3",
  planSchemaVersion: 2,
  mappingVersion: 2,
  authorizationDecisionDomain: "fuse-reliability-v3-authorization",
  replayOperationDomain: "fuse-reliability-v3-replay-operation",
  artifactRoot: "evidence/held-out-reliability-v3",
  claimRoot: "evidence/.run-claims/held-out-reliability-v3",
  protocolArtifact: "held-out-reliability-v3.json",
  beaconRound: 6_338_040,
}, RELIABILITY_V3_PROFILE_CANONICAL_JSON);

export const RELIABILITY_V4_PROFILE = freezeProfile({
  protocolVersion: 4,
  evidenceType: "held-out-reliability-v4",
  planSchemaVersion: 2,
  mappingVersion: 2,
  authorizationDecisionDomain: "fuse-reliability-v4-authorization",
  replayOperationDomain: "fuse-reliability-v4-replay-operation",
  artifactRoot: "evidence/held-out-reliability-v4",
  claimRoot: "evidence/.run-claims/held-out-reliability-v4",
  protocolArtifact: "held-out-reliability-v4.json",
  beaconRound: 6_355_320,
}, RELIABILITY_V4_PROFILE_CANONICAL_JSON);

export function usesCanonicalAuthorizationIds(profile: ReliabilityProtocolProfile | { protocolVersion:number }):boolean {
  return profile.protocolVersion === 3 || profile.protocolVersion === 4;
}

export function requiresExactSealedRequestCommitment(profile: ReliabilityProtocolProfile | { protocolVersion:number }):boolean {
  return profile.protocolVersion === 3 || profile.protocolVersion === 4;
}

export function requiresStrictArtifactBinding(profile: ReliabilityProtocolProfile | { protocolVersion:number }):boolean {
  return profile.protocolVersion === 3 || profile.protocolVersion === 4;
}

export function usesSequencedReportIntents(profile: ReliabilityProtocolProfile | { protocolVersion:number }):boolean {
  return profile.protocolVersion === 3 || profile.protocolVersion === 4;
}

export function reliabilityProtocolProfileForRunId(runId: string): ReliabilityProtocolProfile {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) throw new Error("RUN_ID_INVALID");
  if (runId.startsWith("hov3-")) {
    if (!/^hov3-[A-Za-z0-9._:-]{1,97}$/.test(runId)) throw new Error("RELIABILITY_V3_RUN_ID_INVALID");
    return RELIABILITY_V3_PROFILE;
  }
  if (runId.startsWith("hov4-")) {
    if (!/^hov4-[A-Za-z0-9._:-]{1,97}$/.test(runId)) throw new Error("RELIABILITY_V4_RUN_ID_INVALID");
    return RELIABILITY_V4_PROFILE;
  }
  return RELIABILITY_V2_PROFILE;
}
