import { reliabilityProtocolProfileForRunId, type ReliabilityProtocolProfile } from "../reliability/protocolProfile.js";

export type ReliabilityArtifactNamespace = Pick<
  ReliabilityProtocolProfile,
  "artifactRoot" | "evidenceType" | "protocolVersion" | "protocolArtifact" | "beaconRound"
> & { root: string };

function namespace(profile: ReliabilityProtocolProfile): ReliabilityArtifactNamespace {
  return Object.freeze({
    root: profile.artifactRoot,
    artifactRoot: profile.artifactRoot,
    evidenceType: profile.evidenceType,
    protocolVersion: profile.protocolVersion,
    protocolArtifact: profile.protocolArtifact,
    beaconRound: profile.beaconRound,
  });
}

export function reliabilityArtifactNamespace(runId: string): ReliabilityArtifactNamespace {
  return namespace(reliabilityProtocolProfileForRunId(runId));
}

export function reliabilityArtifactPath(runId: string, ...parts: string[]): string {
  const profile = reliabilityProtocolProfileForRunId(runId);
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("/") || part.includes("\\"))) {
    throw new Error("ARTIFACT_PATH_SEGMENT_INVALID");
  }
  return [profile.artifactRoot, ...parts].join("/");
}

export function schedulerManifestArtifactPath(runId:string,requestId:string):string{
  return reliabilityArtifactPath(runId,"scheduler-manifests",runId,`${requestId}.json`);
}
