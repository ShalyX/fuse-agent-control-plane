import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { authorizationPayloadBytes, type AuthorizationArtifact, type AuthorizationPayload } from "../evidence/reliabilityRuntimeV2.js";

export const RECONCILIATION_OFFSETS_SECONDS = [0, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 64800, 86300] as const;

export function blockWindowDisposition(databaseNow: string, opensAt: string, launchDeadline: string): "early" | "open" | "late" {
  const now = Date.parse(databaseNow);
  const opens = Date.parse(opensAt);
  const deadline = Date.parse(launchDeadline);
  if (![now, opens, deadline].every(Number.isFinite) || opens >= deadline) throw new Error("BLOCK_WINDOW_INVALID");
  return now < opens ? "early" : now < deadline ? "open" : "late";
}

export function reconciliationWindow(ambiguityEnteredAt: string, offsetSeconds: number): {
  scheduledAt: string; startsBefore: string; evidenceCutoff: string; classificationDeadline: string;
} {
  if (!RECONCILIATION_OFFSETS_SECONDS.includes(offsetSeconds as never)) throw new Error("RECONCILIATION_OFFSET_INVALID");
  const entered = Date.parse(ambiguityEnteredAt);
  if (!Number.isFinite(entered)) throw new Error("AMBIGUITY_TIME_INVALID");
  return {
    scheduledAt: new Date(entered + offsetSeconds * 1_000).toISOString(),
    startsBefore: new Date(entered + offsetSeconds * 1_000 + 1_000).toISOString(),
    evidenceCutoff: new Date(entered + 86_400_000).toISOString(),
    classificationDeadline: new Date(entered + 86_431_000).toISOString(),
  };
}

export async function signAuthorizationArtifact(payload: AuthorizationPayload, privateKeyPath: string): Promise<AuthorizationArtifact> {
  const privateKeyBytes = await readFile(privateKeyPath);
  const privateKey = createPrivateKey(privateKeyBytes);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("AUTHORIZATION_ED25519_KEY_REQUIRED");
  return { payload, signature: sign(null, authorizationPayloadBytes(payload), privateKey).toString("base64") };
}

export interface ReconciliationSchedulerRequest {
  requestId: string;
  generationId: string | null;
  ambiguityEnteredAt: string;
}
export interface ReconciliationOffsetAuthorization { credentialId: string; authorizationSha256: string }

/** Run ambiguity timelines in parallel; each request keeps its own ordered offsets. */
export async function executeConcurrentReconciliation(input: {
  requests: readonly ReconciliationSchedulerRequest[];
  offsets?: readonly number[];
  authorizeOffset: (input: { requestId: string; offsetSeconds: number }) => Promise<ReconciliationOffsetAuthorization>;
  waitUntil: (scheduledAt: string) => Promise<void>;
  lookup: (input: ReconciliationSchedulerRequest & { offsetSeconds: number; authorization: ReconciliationOffsetAuthorization }) => Promise<{ disposition: string; terminal?: boolean }>;
  persistPhase: (input: { requestId: string; offsetSeconds: number; phase: "authorized" | "lookup_started" | "lookup_finished" | "failed"; measuredAtMs: number; credentialId?: string; authorizationSha256?: string; disposition?: string; errorCode?: string }) => Promise<void>;
  now?: () => number;
}): Promise<{ requests: number; terminal: number; failed: number }> {
  const offsets = input.offsets ?? RECONCILIATION_OFFSETS_SECONDS;
  const now = input.now ?? Date.now;
  let terminal = 0;
  let failed = 0;
  await Promise.all(input.requests.map(async (request) => {
    for (const offsetSeconds of offsets) {
      try {
        if (!RECONCILIATION_OFFSETS_SECONDS.includes(offsetSeconds as never)) throw new Error("RECONCILIATION_OFFSET_INVALID");
        const window = reconciliationWindow(request.ambiguityEnteredAt, offsetSeconds);
        const authorization = await input.authorizeOffset({ requestId: request.requestId, offsetSeconds });
        if (!authorization.credentialId.trim() || !/^sha256:[a-f0-9]{64}$/.test(authorization.authorizationSha256)) throw new Error("RECONCILIATION_OFFSET_AUTHORIZATION_INVALID");
        await input.persistPhase({ requestId: request.requestId, offsetSeconds, phase: "authorized", measuredAtMs: now(), ...authorization });
        await input.waitUntil(window.scheduledAt);
        await input.persistPhase({ requestId: request.requestId, offsetSeconds, phase: "lookup_started", measuredAtMs: now(), ...authorization });
        const outcome = await input.lookup({ ...request, offsetSeconds, authorization });
        await input.persistPhase({ requestId: request.requestId, offsetSeconds, phase: "lookup_finished", measuredAtMs: now(), disposition: outcome.disposition, ...authorization });
        if (outcome.terminal || outcome.disposition === "terminal") { terminal++; return; }
      } catch (error) {
        failed++;
        await input.persistPhase({ requestId: request.requestId, offsetSeconds, phase: "failed", measuredAtMs: now(), errorCode: error instanceof Error ? error.message : "RECONCILIATION_SCHEDULER_FAILURE" });
      }
    }
  }));
  return { requests: input.requests.length, terminal, failed };
}

export function heldLaneFifoResolution(input: { members: readonly string[]; requestId: string; transitionCommittedAtMs: number }): { remaining: string[]; resumeAtMs: number | null } {
  if (!input.members.length || !input.members.includes(input.requestId)) throw new Error("HELD_MEMBER_NOT_FOUND");
  const remaining = input.members.filter((member) => member !== input.requestId);
  if (remaining.length) return { remaining, resumeAtMs: null };
  const boundary = 300_000;
  return { remaining, resumeAtMs: Math.floor(input.transitionCommittedAtMs / boundary + 1) * boundary };
}

export async function recoverSchedulerWorker(input: {
  readState: () => Promise<{ terminal: boolean; dispatchToken: boolean; primitiveEntered: boolean }>;
  waitForAuthoritativeOutcome: () => Promise<void>;
  reconcile: () => Promise<{ terminal: boolean }>;
  readManifest: () => Promise<{ state: string; sequence: number } | null>;
  publishManifest: (manifest: { state: "terminal"; sequence: number; recoveryDecision: "already_terminal" }) => Promise<void>;
}): Promise<{ action: "already_terminal" | "reconciled" | "dispatch_original"; terminal: boolean; manifestRepaired: boolean }> {
  let state = await input.readState();
  if (!state.terminal && state.dispatchToken && !state.primitiveEntered) {
    await input.waitForAuthoritativeOutcome();
    state = await input.readState();
  }
  let action: "already_terminal" | "reconciled" | "dispatch_original";
  let terminal = state.terminal;
  if (state.terminal) action = "already_terminal";
  else if (state.dispatchToken) { const result = await input.reconcile(); terminal = result.terminal; action = "reconciled"; }
  else action = "dispatch_original";
  let manifestRepaired = false;
  if (terminal) {
    const manifest = await input.readManifest();
    if (manifest?.state !== "terminal") {
      await input.publishManifest({ state: "terminal", sequence: (manifest?.sequence ?? 3) + 1, recoveryDecision: "already_terminal" });
      manifestRepaired = true;
    }
  }
  return { action, terminal, manifestRepaired };
}

export function setupSnapshotDifferences(expected: unknown, actual: unknown): string[] {
  const differences: string[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (Array.isArray(left)) {
      if (!Array.isArray(right)) { differences.push(path); return; }
      if (left.length !== right.length) differences.push(path ? `${path}.length` : "length");
      for (let index = 0; index < left.length; index++) walk(left[index], right[index], `${path}[${index}]`);
      return;
    }
    if (left !== null && typeof left === "object") {
      if (right === null || typeof right !== "object" || Array.isArray(right)) { differences.push(path); return; }
      for (const key of Object.keys(left as Record<string, unknown>).sort()) walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      return;
    }
    if (!Object.is(left, right)) differences.push(path);
  };
  walk(expected, actual, "");
  return differences;
}
