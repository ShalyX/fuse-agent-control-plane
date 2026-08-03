import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/evidence/heldOutReliabilityV2.js";
import { buildReplayAuthorizationInventory, deterministicAuthorizationDecisionId } from "../src/reliability/protocolStore.js";
import * as protocolStore from "../src/reliability/protocolStore.js";
import {
  RELIABILITY_V2_PROFILE,
  RELIABILITY_V3_PROFILE,
  RELIABILITY_V3_PROFILE_FINGERPRINT,
  RELIABILITY_V3_PROFILE_GOLDEN_FINGERPRINT,
  reliabilityProtocolProfileForRunId,
} from "../src/reliability/protocolProfile.js";

describe("versioned reliability protocol profiles", () => {
  it("permits only normative authorization predecision deadline reasons", () => {
    const valid=(protocolStore as unknown as Record<string,unknown>)["authorizationPredecisionReasonValid"];
    expect(valid).toBeTypeOf("function");
    for(const reason of ["validation_phase_deadline","decision_phase_deadline"])
      expect((valid as (reason:string)=>boolean)(reason)).toBe(true);
    for(const reason of ["AUTHORIZATION_WINDOW_MISSED","AUTHORIZATION_PARSE_DEADLINE_MISSED","AUTHORIZATION_DECISION_DEADLINE_MISSED","AUTHORIZATION_PUBLICATION_DEADLINE_MISSED","AUTHORIZATION_TRANSITION_DEADLINE_MISSED","authorization_publication_deadline","authorization_transition_deadline","SIGNED_AUTHORIZATION_PAIR_INVALID","OTHER"])
      expect((valid as (reason:string)=>boolean)(reason)).toBe(false);
  });

  it("binds v3 to the exact publicly merged profile and source identities", () => {
    const profile = RELIABILITY_V3_PROFILE as unknown as Record<string, unknown>;
    const coordinates = profile.coordinates as Record<string, unknown>;

    expect(profile.profileFingerprint).toBe(
      "sha256:618fa81c9a6587a5e5eda113d2a45a896f839cc2a7965068efc36bd87dedbea8",
    );
    expect(coordinates.amendmentCommit).toBe("a8001d519c108f7cc55efeb4d1e6cc032bbf98a9");
    expect(coordinates.protocolSources).toEqual([
      {
        path: "docs/held-out-reliability-protocol-v2.md",
        commit: "6c6ef80f909998af45576baa07e03733cd5d0950",
        gitBlob: "a0c750c4826cf838ad338e7f135a0622d34f4cca",
        sha256: "sha256:841909a2a99ba29eb6b80179cd2bf267ef1f73dab4f1af1870680e6cc20d4c96",
      },
      {
        path: "docs/held-out-reliability-protocol-v3.md",
        commit: "a8001d519c108f7cc55efeb4d1e6cc032bbf98a9",
        gitBlob: "562f516e55304e9befe40b811ce1fc1eafd01789",
        sha256: "sha256:7572ce3364859cba49bb0e2f725a61309f4435acac53a282c0882c1f56f0d631",
      },
    ]);
  });

  it("exposes the exact 31-key canonical projection and both amendment fingerprints", () => {
    const coordinates = RELIABILITY_V3_PROFILE.coordinates!;
    expect(Object.keys(coordinates).sort()).toEqual([
      "adapterRetryCount", "amendmentCommit", "artifactCoordinates", "artifactNamespaceVersion",
      "authorizationDecisionDomain", "authorizationIssuers", "authorizationWindow", "beacon", "costCaps",
      "domain", "evidenceType", "expiries", "finalizationRules", "finalizationRulesVersion",
      "inheritedV2Commit", "mappingVersion", "model", "operationAndPhaseDeadlines", "planSchemaVersion",
      "preregistrationCommit", "protocolSources", "protocolVersion", "provider", "randomnessDomain",
      "reconciliationOffsetsSeconds", "replayOperationDomain", "requestIdDomain", "requestRecipeFingerprint",
      "requestRecipeVersion", "schedule", "setupIdentityRecipe",
    ]);
    expect(RELIABILITY_V3_PROFILE_GOLDEN_FINGERPRINT)
      .toBe("sha256:d3d63847f08f7d9dec19de48037314375f329473e523747799bfab8c0b15b214");
    expect(RELIABILITY_V3_PROFILE_FINGERPRINT)
      .toBe("sha256:618fa81c9a6587a5e5eda113d2a45a896f839cc2a7965068efc36bd87dedbea8");
    expect(Object.isFrozen(coordinates)).toBe(true);
    expect(Object.isFrozen(coordinates.setupIdentityRecipe)).toBe(true);
    expect(Object.isFrozen(coordinates.protocolSources)).toBe(true);
    expect(Object.isFrozen((coordinates.protocolSources as readonly object[])[0])).toBe(true);
  });

  it("selects v3 only for its exact bounded run-ID grammar", () => {
    expect(reliabilityProtocolProfileForRunId(`hov3-${"a".repeat(97)}`)).toBe(RELIABILITY_V3_PROFILE);
    expect(() => reliabilityProtocolProfileForRunId(`hov3-${"a".repeat(98)}`))
      .toThrow("RELIABILITY_V3_RUN_ID_INVALID");
    expect(reliabilityProtocolProfileForRunId("historical-v2")).toBe(RELIABILITY_V2_PROFILE);
  });

  it("preserves the historical v2 runtime profile identity", () => {
    expect(RELIABILITY_V2_PROFILE).toMatchObject({
      protocolVersion: 2,
      evidenceType: "held-out-reliability",
      artifactRoot: "evidence/held-out-reliability",
      beaconRound: 6_315_000,
    });
  });

  it("derives the golden total v3 authorization decision ID from the normative canonical preimage", () => {
    const input = {
      runId: "hov3-golden",
      planFingerprint: `sha256:${"0".repeat(64)}`,
      profileFingerprint: `sha256:${"0".repeat(64)}`,
      decisionKind: "readiness_predecision_failed" as const,
      reasonCode: "READINESS_PREDECISION_FAILED",
      operatorArtifactSha256: "absent" as const,
      reconciliationArtifactSha256: "absent" as const,
    };
    expect(deterministicAuthorizationDecisionId(input)).toBe("b1b76322-a365-548d-ac1c-a0dd5e54d199");
    expect(deterministicAuthorizationDecisionId({ ...input, reasonCode: "OTHER" })).not.toBe("b1b76322-a365-548d-ac1c-a0dd5e54d199");
  });

  it("derives the golden v3 replay operation ID from the committed active decision", () => {
    const requestIds = [
      `hov3_${"0".repeat(48)}`,
      ...Array.from({ length: 19 }, (_, index) => `hov3_${String(index + 1).padStart(48, "0")}`),
    ];
    const input = {
      runId: "hov3-golden",
      planFingerprint: `sha256:${"0".repeat(64)}`,
      profileFingerprint: `sha256:${"0".repeat(64)}`,
      authorizationDecisionId: "b1b76322-a365-548d-ac1c-a0dd5e54d199",
      requestIds,
    };
    const inventory = buildReplayAuthorizationInventory(input);
    expect(inventory[0]).toEqual({
      ordinal: 1,
      requestId: requestIds[0],
      operationId: "replay-c24e271aff281245e389c1f69ce19012c8ce8eeac0cc703122782c0d9bd2edfe",
    });
    expect(buildReplayAuthorizationInventory({ ...input, authorizationDecisionId: "b1b76322-a365-548d-ac1c-a0dd5e54d198" })[0]?.operationId)
      .not.toBe(inventory[0]?.operationId);
  });
});
