import { createHash } from "node:crypto";
import {
  RELIABILITY_V3_PROFILE_CANONICAL_JSON,
  RELIABILITY_V3_PROFILE_GOLDEN_CANONICAL_JSON,
} from "./protocolProfileV3Canonical.js";

export interface ReliabilityProtocolProfile {
  protocolVersion: 2 | 3;
  evidenceType: "held-out-reliability" | "held-out-reliability-v3";
  planSchemaVersion: 2;
  mappingVersion: 2;
  authorizationDecisionDomain: "fuse-reliability-v2-authorization" | "fuse-reliability-v3-authorization";
  replayOperationDomain: "fuse-reliability-v2-replay-operation" | "fuse-reliability-v3-replay-operation";
  artifactRoot: "evidence/held-out-reliability" | "evidence/held-out-reliability-v3";
  claimRoot: "evidence/.run-claims/held-out-reliability" | "evidence/.run-claims/held-out-reliability-v3";
  protocolArtifact: "held-out-reliability-v2.json" | "held-out-reliability-v3.json";
  beaconRound: 6_315_000 | 6_338_040;
  profileFingerprint: string;
  coordinates?: Readonly<Record<string, unknown>>;
}

type ProfileSeed = Omit<ReliabilityProtocolProfile, "profileFingerprint" | "coordinates">;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export const RELIABILITY_V3_PROFILE_GOLDEN_FINGERPRINT = sha256(RELIABILITY_V3_PROFILE_GOLDEN_CANONICAL_JSON);
export const RELIABILITY_V3_PROFILE_FINGERPRINT = sha256(RELIABILITY_V3_PROFILE_CANONICAL_JSON);

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

export function reliabilityProtocolProfileForRunId(runId: string): ReliabilityProtocolProfile {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) throw new Error("RUN_ID_INVALID");
  if (runId.startsWith("hov3-")) {
    if (!/^hov3-[A-Za-z0-9._:-]{1,97}$/.test(runId)) throw new Error("RELIABILITY_V3_RUN_ID_INVALID");
    return RELIABILITY_V3_PROFILE;
  }
  return RELIABILITY_V2_PROFILE;
}
