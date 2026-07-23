import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIntendedAuthoritativeSetup,
  fingerprintAuthoritativeSetup,
  validateAuthoritativeSetup,
  withVerifiedAuthoritativeSetup,
  type AuthoritativeSetup,
} from "../src/evidence/authoritative.js";
import {
  acquireRunClaim,
  atomicReplaceJson,
  recordAttemptDurablyBeforeAssertions,
  writeOnceJson,
} from "../src/evidence/durableArtifacts.js";
import {
  HELD_OUT_BEACON_URL,
  buildHeldOutCallPlan,
  buildHeldOutPlan,
  buildHeldOutSetupPlan,
} from "../src/evidence/heldOut.js";
import {
  buildAuthoritativeRequestFingerprint,
  validateAuthoritativeAttempts,
  type AttemptManifestEntry,
  type AuthoritativeExecution,
} from "../src/evidence/harness.js";

const signature = "22".repeat(96);
const beacon = {
  round: 6311188,
  randomness: createHash("sha256").update(Buffer.from(signature, "hex")).digest("hex"),
  signature,
};
const plan = buildHeldOutPlan(beacon, "openrouter", "nousresearch/hermes-4-405b");
const setupPlan = buildHeldOutSetupPlan(plan, "integrity");
const call = buildHeldOutCallPlan(plan, "integrity")[0]!;
const intendedSetup = buildIntendedAuthoritativeSetup({
  setupPlan,
  provider: plan.provider,
  model: plan.model,
  mandateId: call.mandateId,
  policyId: "heldout-policy-integrity",
  agentId: "heldout-agent-integrity",
});

function attempt(overrides: Partial<AttemptManifestEntry> = {}): AttemptManifestEntry {
  return {
    runId: call.runId,
    fixtureId: call.fixtureId,
    requestId: call.requestId,
    sequence: 1,
    label: call.label,
    outcome: "completed",
    actualCostAtomic: "125",
    occurredAt: "2026-07-22T00:00:00.000Z",
    provider: plan.provider,
    model: call.model,
    branchId: call.branchId,
    workloadClass: call.workloadClass,
    maxOutputTokens: call.maxOutputTokens,
    agentId: "heldout-agent-integrity",
    policyId: "heldout-policy-integrity",
    policyVersion: 1,
    decisionId: "decision-1",
    decisionOutcome: "ALLOW",
    decisionWouldOutcome: "ALLOW",
    decisionEnforced: true,
    ...overrides,
  };
}

function execution(overrides: Partial<AuthoritativeExecution> = {}): AuthoritativeExecution {
  const base: AuthoritativeExecution = {
    requestId: call.requestId,
    status: "completed",
    actualCostAtomic: "125",
    provider: plan.provider,
    model: call.model,
    branchId: call.branchId,
    workloadClass: call.workloadClass,
    maxOutputTokens: call.maxOutputTokens,
    agentId: "heldout-agent-integrity",
    policyId: "heldout-policy-integrity",
    policyVersion: 1,
    decisionId: "decision-1",
    organizationId: "organization-1",
    inputTokens: 700,
    decisionOutcome: "ALLOW",
    decisionWouldOutcome: "ALLOW",
    decisionEnforced: true,
  };
  return {
    ...base,
    requestFingerprint: buildAuthoritativeRequestFingerprint(call, base),
    ...overrides,
  };
}

describe("authoritative setup seal", () => {
  it("uses the exact preregistered endpoint without fetching it", () => {
    expect(HELD_OUT_BEACON_URL).toBe("https://api.drand.sh/public/6311188");
  });

  it("canonicalizes every persisted experiment-defining setup dimension", () => {
    expect(validateAuthoritativeSetup(intendedSetup, structuredClone(intendedSetup))).toEqual({
      fingerprint: fingerprintAuthoritativeSetup(intendedSetup),
      source: "postgres-authoritative-setup-v1",
    });
    const dimensions: Array<(snapshot: AuthoritativeSetup) => void> = [
      (value) => { value.provider.model = "drifted-model"; },
      (value) => { value.policy.mode = "dry_run"; },
      (value) => { value.policy.workloadClasses[0]!.shadow!.divergenceThresholdBps += 1; },
      (value) => { value.mandate.maximumSpendAtomic = "1"; },
      (value) => { value.assignedAgentIds = []; },
      (value) => { value.branches[0]!.parentBranchId = "wrong-parent"; },
      (value) => { value.branches[0]!.allowedWorkloadClasses = ["wrong-class"]; },
    ];
    for (const drift of dimensions) {
      const actual = structuredClone(intendedSetup);
      drift(actual);
      expect(() => validateAuthoritativeSetup(intendedSetup, actual)).toThrow("EVIDENCE_AUTHORITATIVE_SETUP_MISMATCH");
    }
  });

  it("does not begin provider traffic when injected persisted drift is observed", async () => {
    const drifted = structuredClone(intendedSetup);
    drifted.provider.model = "drifted-before-traffic";
    let providerTraffic = 0;
    await expect(withVerifiedAuthoritativeSetup(
      intendedSetup,
      async () => drifted,
      async () => { providerTraffic += 1; },
    )).rejects.toThrow("EVIDENCE_AUTHORITATIVE_SETUP_MISMATCH");
    expect(providerTraffic).toBe(0);
  });
});

describe("authoritative execution dimensions", () => {
  it("requires plan and manifest provider/model equality", () => {
    expect(() => validateAuthoritativeAttempts([attempt({ provider: "anthropic" })], [execution()], [call], {
      provider: plan.provider,
      model: plan.model,
    })).toThrow("REPLAY_MANIFEST_PLAN_BINDING_MISMATCH");
    expect(() => validateAuthoritativeAttempts([attempt({ model: "wrong" })], [execution()], [call], {
      provider: plan.provider,
      model: plan.model,
    })).toThrow("REPLAY_MANIFEST_PLAN_BINDING_MISMATCH");
  });

  it.each([
    ["provider", { provider: "anthropic" }],
    ["model", { model: "wrong" }],
    ["branch", { branchId: "wrong" }],
    ["workload class", { workloadClass: "wrong" }],
    ["max output tokens", { maxOutputTokens: 9 }],
    ["agent", { agentId: "wrong" }],
    ["policy", { policyId: "wrong" }],
    ["policy version", { policyVersion: 2 }],
    ["decision id", { decisionId: "wrong" }],
    ["decision outcome", { decisionOutcome: "DENY" }],
    ["decision would-outcome", { decisionWouldOutcome: "DENY" }],
    ["decision enforcement", { decisionEnforced: false }],
    ["request fingerprint", { requestFingerprint: "b".repeat(64) }],
  ])("rejects authoritative %s mismatch", (_name, drift) => {
    expect(() => validateAuthoritativeAttempts([attempt()], [execution(drift)], [call], {
      provider: plan.provider,
      model: plan.model,
    })).toThrow(/REPLAY_AUTHORITATIVE_/);
  });

  it("rejects duplicate and extra authoritative rows", () => {
    expect(() => validateAuthoritativeAttempts([attempt()], [execution(), execution()], [call], {
      provider: plan.provider, model: plan.model,
    })).toThrow("REPLAY_AUTHORITATIVE_EXECUTION_DUPLICATE");
    expect(() => validateAuthoritativeAttempts([attempt()], [execution(), execution({ requestId: "extra" })], [call], {
      provider: plan.provider, model: plan.model,
    })).toThrow("REPLAY_AUTHORITATIVE_EXECUTION_EXTRA");
  });
});

describe("durable evidence artifacts", () => {
  it("durably records a returned attempt before running post-call assertions", async () => {
    const attempts: AttemptManifestEntry[] = [];
    let persisted: AttemptManifestEntry[] = [];
    await expect(recordAttemptDurablyBeforeAssertions(
      attempts,
      attempt(),
      async () => { persisted = structuredClone(attempts); },
      () => { throw new Error("post-call assertion"); },
    )).rejects.toThrow("post-call assertion");
    expect(attempts).toHaveLength(1);
    expect(persisted).toEqual(attempts);
  });

  it("atomically grants only one durable run claim under a race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-claim-"));
    const claimPath = join(directory, "same-run.claim");
    const results = await Promise.allSettled([
      acquireRunClaim(claimPath, { runId: "same-run" }),
      acquireRunClaim(claimPath, { runId: "same-run" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await stat(claimPath)).mode & 0o777).toBe(0o600);
  });

  it("retains the prior valid manifest when interrupted before rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-atomic-"));
    const path = join(directory, "manifest.json");
    await atomicReplaceJson(path, { phase: "running", attempts: [1] });
    await expect(atomicReplaceJson(path, { phase: "running", attempts: [1, 2] }, {
      beforeRename: () => { throw new Error("injected interruption"); },
    })).rejects.toThrow("injected interruption");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ phase: "running", attempts: [1] });
  });

  it("makes completed manifests immutable and replay output write-once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-immutable-"));
    const manifestPath = join(directory, "manifest.json");
    await atomicReplaceJson(manifestPath, { phase: "complete", attempts: [] }, { immutableWhenComplete: true });
    await expect(atomicReplaceJson(manifestPath, { phase: "running", attempts: [] }, { immutableWhenComplete: true }))
      .rejects.toThrow("EVIDENCE_COMPLETED_ARTIFACT_IMMUTABLE");

    const replayPath = join(directory, "replay.json");
    await writeOnceJson(replayPath, { runId: "first" });
    await expect(writeOnceJson(replayPath, { runId: "second" })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(replayPath, "utf8"))).toEqual({ runId: "first" });
    expect((await stat(replayPath)).mode & 0o777).toBe(0o600);
  });
});
