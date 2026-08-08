import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as profiles from "../src/reliability/protocolProfile.js";

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("held-out reliability protocol v4 profile", () => {
  it("exports the publicly merged v4 profile as a disjoint immutable runtime identity", () => {
    const module = profiles as unknown as Record<string, unknown>;
    expect(module.RELIABILITY_V4_PROFILE).toBeDefined();
    const profile = module.RELIABILITY_V4_PROFILE as Record<string, unknown>;
    const coordinates = profile.coordinates as Record<string, unknown>;

    expect(profile).toMatchObject({
      protocolVersion: 4,
      evidenceType: "held-out-reliability-v4",
      artifactRoot: "evidence/held-out-reliability-v4",
      claimRoot: "evidence/.run-claims/held-out-reliability-v4",
      protocolArtifact: "held-out-reliability-v4.json",
      beaconRound: 6_355_320,
    });
    expect(coordinates.preregistrationCommit).toBe("1055aecef8b0e10eda3af02334fa432fffd564da");
    expect(coordinates.amendmentCommit).toBe("1055aecef8b0e10eda3af02334fa432fffd564da");
    expect(coordinates.inheritedV3Commit).toBe("9a3ba41770e251e15065e14f49c2193f365c3afb");
    expect(coordinates.protocolSources).toHaveLength(3);
    expect((coordinates.protocolSources as Array<Record<string, unknown>>)[2]).toEqual({
      commit: "1055aecef8b0e10eda3af02334fa432fffd564da",
      gitBlob: "fc3207ec0414573ed430d391eb2b012ad1d3110c",
      path: "docs/held-out-reliability-protocol-v4.md",
      sha256: "sha256:089c21170a3550f557522f8aab1a72fcc713507962ee85e1e7c77721c7e5447f",
    });
    expect(profile.profileFingerprint).toBe(sha256(canonical(coordinates)));
    expect(Object.isFrozen(coordinates)).toBe(true);
    expect(Object.isFrozen(coordinates.protocolSources)).toBe(true);
  });

  it("selects v4 only for its exact bounded run-ID grammar while preserving v2 and v3", () => {
    const module = profiles as unknown as Record<string, unknown>;
    const select = module.reliabilityProtocolProfileForRunId as (runId: string) => unknown;
    expect(select(`hov4-${"a".repeat(97)}`)).toBe(module.RELIABILITY_V4_PROFILE);
    expect(() => select(`hov4-${"a".repeat(98)}`)).toThrow("RELIABILITY_V4_RUN_ID_INVALID");
    expect(select("hov3-historical")).toBe(module.RELIABILITY_V3_PROFILE);
    expect(select("historical-v2")).toBe(module.RELIABILITY_V2_PROFILE);
  });
});
