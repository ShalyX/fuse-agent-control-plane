import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const RELIABILITY_LANES = ["normal-paced", "high-envelope", "bounded-burst", "restart-resume"] as const;
export type ReliabilityLane = typeof RELIABILITY_LANES[number];
const SHA256 = /^sha256:[a-f0-9]{64}$/;

export interface ReconstructedArtifact {
  path: string;
  digest: string;
  bytes: Buffer;
  parsed: Record<string, unknown>;
}
export interface ReconstructedReliabilityArtifacts {
  claims: Array<{ lane: ReliabilityLane; terminal: true; path: string; digest: string }>;
  manifests: Array<{ lane: ReliabilityLane; block: number; terminal: true; path: string; digest: string }>;
  authorizationReceipts: Array<{ kind: "operator" | "reconciliation"; status: string; path: string; digest: string; presentedArtifactSha256: string }>;
  signedAuthorizations: Array<{ kind: "operator" | "reconciliation"; path: string; digest: string; signatureVerified: true }>;
  artifacts: ReconstructedArtifact[];
  artifactPaths: string[];
  artifactDigests: Record<string, string>;
  claimInventoryAuthority: {
    source: "docs/held-out-reliability-protocol-v2.md:420,426";
    claims: "four_lane_claims";
    contradictionDetected: true;
    contradictedLegacyShape: "five_block_claims";
  };
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function asObject(bytes: Buffer, path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`ARTIFACT_JSON_INVALID:${path}`);
  }
}
function validateCommon(parsed: Record<string, unknown>, path: string, runId: string, planFingerprint: string): void {
  if (parsed.evidenceType !== "held-out-reliability" || parsed.protocolVersion !== 2 || parsed.runId !== runId
    || parsed.planFingerprint !== planFingerprint) throw new Error(`ARTIFACT_IDENTITY_MISMATCH:${path}`);
}
async function readArtifact(root: string, path: string, runId: string, planFingerprint: string): Promise<ReconstructedArtifact> {
  let bytes: Buffer;
  try { bytes = await readFile(join(root, path)); }
  catch { throw new Error(`ARTIFACT_REQUIRED:${path}`); }
  const parsed = asObject(bytes, path);
  validateCommon(parsed, path, runId, planFingerprint);
  return { path, bytes, parsed, digest: digest(bytes) };
}
async function listFiles(root: string, directory: string): Promise<string[]> {
  const absolute = join(root, directory);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); }
  catch { return []; }
  const found: string[] = [];
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      const rel = relative(root, child).split(sep).join("/");
      found.push(...await listFiles(root, rel));
    } else if (entry.isFile()) found.push(relative(root, child).split(sep).join("/"));
  }
  return found;
}

/**
 * Reconstructs every artifact assertion from exact file bytes. Callers provide only
 * immutable run identity and the authoritative incident-log coordinates.
 */
export async function reconstructReliabilityArtifacts(input: {
  root: string;
  runId: string;
  planFingerprint: string;
  incidents: readonly { sequence: number; eventType: string }[];
  verifyAuthorization(args: { kind: "operator" | "reconciliation"; bytes: Buffer; parsed: Record<string, unknown>; digest: string }): boolean | Promise<boolean>;
}): Promise<ReconstructedReliabilityArtifacts> {
  if (!input.runId || !SHA256.test(input.planFingerprint)) throw new Error("ARTIFACT_IDENTITY_INVALID");
  const fixed = [
    "evidence/held-out-reliability/protocols/held-out-reliability-v2.json",
    "evidence/held-out-reliability/beacons/drand-6315000.json",
    `evidence/held-out-reliability/plans/${input.planFingerprint}.json`,
    `evidence/held-out-reliability/replay-preliminary/${input.runId}.json`,
  ];
  const claimPaths = RELIABILITY_LANES.map((lane) => `evidence/.run-claims/held-out-reliability/${input.runId}/${lane}.claim`);
  const manifestPaths = RELIABILITY_LANES.flatMap((lane) => Array.from({ length: 5 }, (_, index) =>
    `evidence/held-out-reliability/manifests/${input.runId}/${lane}-${index + 1}.json`));
  const authorizationPaths = (["operator", "reconciliation"] as const).flatMap((kind) => [
    `evidence/held-out-reliability/authorizations/${kind}/${input.runId}.json`,
    `evidence/held-out-reliability/authorization-receipts/${kind}/${input.runId}.json`,
  ]);
  const incidentPaths = input.incidents.map(({ sequence, eventType }) => {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !/^[a-z0-9_]+$/.test(eventType)) throw new Error("ARTIFACT_INCIDENT_COORDINATE_INVALID");
    return `evidence/held-out-reliability/incidents/${input.runId}/${sequence}-${eventType}.json`;
  });
  if (new Set(incidentPaths).size !== incidentPaths.length
    || [...input.incidents].sort((a, b) => a.sequence - b.sequence).some((row, index) => row.sequence !== index + 1)) {
    throw new Error("ARTIFACT_INCIDENT_INVENTORY_INVALID");
  }
  const expectedPaths = [...fixed, ...claimPaths, ...manifestPaths, ...authorizationPaths, ...incidentPaths].sort();
  const artifacts = await Promise.all(expectedPaths.map((path) => readArtifact(input.root, path, input.runId, input.planFingerprint)));
  const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const preliminary = byPath.get(`evidence/held-out-reliability/replay-preliminary/${input.runId}.json`)!;
  if (preliminary.parsed.artifactKind !== "replay_report" || preliminary.parsed.passed !== true
    || preliminary.parsed.replayAudits !== 20) throw new Error("ARTIFACT_PRELIMINARY_REPLAY_INVALID");

  const claims = RELIABILITY_LANES.map((lane) => {
    const path = `evidence/.run-claims/held-out-reliability/${input.runId}/${lane}.claim`;
    const artifact = byPath.get(path)!;
    if (artifact.parsed.artifactKind !== "lane_claim" || artifact.parsed.lane !== lane || artifact.parsed.state !== "terminal")
      throw new Error(`ARTIFACT_CLAIM_INVALID:${path}`);
    return { lane, terminal: true as const, path, digest: artifact.digest };
  });
  const manifests = RELIABILITY_LANES.flatMap((lane) => Array.from({ length: 5 }, (_, index) => {
    const block = index + 1;
    const path = `evidence/held-out-reliability/manifests/${input.runId}/${lane}-${block}.json`;
    const artifact = byPath.get(path)!;
    if (artifact.parsed.artifactKind !== "manifest" || artifact.parsed.lane !== lane || artifact.parsed.block !== block || artifact.parsed.state !== "terminal")
      throw new Error(`ARTIFACT_MANIFEST_INVALID:${path}`);
    return { lane, block, terminal: true as const, path, digest: artifact.digest };
  }));

  const signedAuthorizations: ReconstructedReliabilityArtifacts["signedAuthorizations"] = [];
  const authorizationReceipts: ReconstructedReliabilityArtifacts["authorizationReceipts"] = [];
  for (const kind of ["operator", "reconciliation"] as const) {
    const signedPath = `evidence/held-out-reliability/authorizations/${kind}/${input.runId}.json`;
    const signed = byPath.get(signedPath)!;
    if (signed.parsed.artifactKind !== "authorization" || signed.parsed.kind !== kind || typeof signed.parsed.signature !== "string"
      || !await input.verifyAuthorization({ kind, bytes: signed.bytes, parsed: signed.parsed, digest: signed.digest })) {
      throw new Error(`ARTIFACT_AUTHORIZATION_SIGNATURE_INVALID:${kind}`);
    }
    signedAuthorizations.push({ kind, path: signedPath, digest: signed.digest, signatureVerified: true });
    const receiptPath = `evidence/held-out-reliability/authorization-receipts/${kind}/${input.runId}.json`;
    const receipt = byPath.get(receiptPath)!;
    if (receipt.parsed.artifactKind !== "authorization_receipt" || receipt.parsed.kind !== kind || typeof receipt.parsed.status !== "string"
      || !SHA256.test(String(receipt.parsed.presentedArtifactSha256))) throw new Error(`ARTIFACT_RECEIPT_INVALID:${kind}`);
    if (receipt.parsed.presentedArtifactSha256 !== signed.digest) throw new Error("ARTIFACT_RECEIPT_PRESENTED_DIGEST_MISMATCH");
    authorizationReceipts.push({ kind, status: receipt.parsed.status, path: receiptPath, digest: receipt.digest, presentedArtifactSha256: signed.digest });
  }

  const runScoped = [
    ...await listFiles(input.root, `evidence/.run-claims/held-out-reliability/${input.runId}`),
    ...await listFiles(input.root, `evidence/held-out-reliability/manifests/${input.runId}`),
    ...await listFiles(input.root, `evidence/held-out-reliability/incidents/${input.runId}`),
  ].sort();
  const expectedRunScoped = [...claimPaths, ...manifestPaths, ...incidentPaths].sort();
  if (runScoped.length !== expectedRunScoped.length || runScoped.some((path, index) => path !== expectedRunScoped[index]))
    throw new Error("ARTIFACT_RUN_SCOPED_INVENTORY_INVALID");

  return {
    claims, manifests, authorizationReceipts, signedAuthorizations, artifacts,
    artifactPaths: expectedPaths,
    artifactDigests: Object.fromEntries(artifacts.map((artifact) => [artifact.path, artifact.digest])),
    claimInventoryAuthority: {
      source: "docs/held-out-reliability-protocol-v2.md:420,426",
      claims: "four_lane_claims",
      contradictionDetected: true,
      contradictedLegacyShape: "five_block_claims",
    },
  };
}
