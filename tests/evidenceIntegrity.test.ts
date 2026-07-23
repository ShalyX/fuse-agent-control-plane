import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
  assertReplayableEvidenceManifestLifecycle,
  runWithIncompleteEvidenceCapture,
  type EvidenceRunFailure,
} from "../src/evidence/runLifecycle.js";
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

  it("captures a terminal incomplete failure before rethrowing the original error", async () => {
    const original = new Error("FIXTURE_EXPECTATION_FAILED:held-out-request");
    let persisted: EvidenceRunFailure | undefined;
    await expect(runWithIncompleteEvidenceCapture(
      async () => { throw original; },
      async (failure) => { persisted = failure; },
      () => ({
        stage: "post-call-validation",
        requestId: "held-out-request",
        attemptSequence: 14,
        attemptsPersisted: 14,
        plannedAttempts: 224,
      }),
      () => "2026-07-23T01:22:51.928Z",
    )).rejects.toBe(original);
    expect(persisted).toEqual({
      code: "FIXTURE_EXPECTATION_FAILED",
      stage: "post-call-validation",
      occurredAt: "2026-07-23T01:22:51.928Z",
      requestId: "held-out-request",
      attemptSequence: 14,
      attemptsPersisted: 14,
      plannedAttempts: 224,
    });
  });

  it("does not persist secret-like exception messages as failure codes", async () => {
    let persisted: EvidenceRunFailure | undefined;
    await expect(runWithIncompleteEvidenceCapture(
      async () => { throw new Error("TOPSECRET_ADMIN_TOKEN"); },
      async (failure) => { persisted = failure; },
      () => ({
        stage: "setup",
        requestId: null,
        attemptSequence: null,
        attemptsPersisted: 0,
        plannedAttempts: 92,
      }),
    )).rejects.toThrow("TOPSECRET_ADMIN_TOKEN");
    expect(persisted?.code).toBe("EVIDENCE_RUN_FAILED");
  });

  it("terminalizes when interrupted during a partial HTTP response body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-body-interrupt-"));
    const sockets = new Set<import("node:net").Socket>();
    let requestSeen!: () => void;
    const sawRequest = new Promise<void>((resolve) => { requestSeen = resolve; });
    const server = createServer((_request, response) => {
      const socket = response.socket;
      if (!socket) throw new Error("EXPECTED_TEST_RESPONSE_SOCKET");
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{\"token\":");
      requestSeen();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("EXPECTED_TEST_SERVER_ADDRESS");
    const env = { ...process.env };
    for (const name of [
      "FUSE_HELD_OUT_PLAN", "FUSE_EVIDENCE_BASELINE_MANIFEST",
      "FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC",
    ]) delete env[name];
    Object.assign(env, {
      FUSE_URL: `http://127.0.0.1:${address.port}`,
      FUSE_ADMIN_TOKEN: "test-admin-token",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:1/test",
      FUSE_EVIDENCE_RUN_ID: "body-interrupt",
      FUSE_PROVIDER: "anthropic",
    });
    const repository = process.cwd();
    const child = spawn(process.execPath, [
      "--import", join(repository, "node_modules/tsx/dist/loader.mjs"),
      join(repository, "scripts/generate-evidence-fixtures.ts"),
    ], { cwd: directory, env, stdio: "ignore" });
    try {
      await Promise.race([
        sawRequest,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("BODY_RESPONSE_NOT_REACHED")), 2_000,
        )),
      ]);
      child.kill("SIGTERM");
      child.kill("SIGTERM");
      const [code] = await Promise.race([
        once(child, "exit"),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("INTERRUPTED_RUN_DID_NOT_EXIT")), 2_000,
        )),
      ]);
      expect(code).not.toBe(0);
      const manifest = JSON.parse(await readFile(
        join(directory, "evidence/fixtures/body-interrupt.json"), "utf8",
      ));
      expect(manifest).toMatchObject({
        schemaVersion: 3,
        phase: "incomplete",
        attempts: [],
        failure: {
          code: "EVIDENCE_RUN_INTERRUPTED",
          stage: "interrupted",
          attemptsPersisted: 0,
          plannedAttempts: 92,
        },
      });
    } finally {
      child.kill("SIGKILL");
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  });

  it("cancels an oversized streaming response before terminalizing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-body-limit-"));
    let socketClosed!: () => void;
    const closed = new Promise<void>((resolve) => { socketClosed = resolve; });
    const server = createServer((_request, response) => {
      response.socket?.once("close", socketClosed);
      response.writeHead(200, { "content-type": "application/json" });
      response.write(`{"padding":"${"x".repeat(1_048_576)}`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("EXPECTED_TEST_SERVER_ADDRESS");
    const repository = process.cwd();
    const env = { ...process.env };
    for (const name of [
      "FUSE_HELD_OUT_PLAN", "FUSE_EVIDENCE_BASELINE_MANIFEST",
      "FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC", "DATABASE_URL_UNPOOLED",
    ]) delete env[name];
    Object.assign(env, {
      FUSE_URL: `http://127.0.0.1:${address.port}`,
      FUSE_ADMIN_TOKEN: "test-admin-token",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:1/test",
      FUSE_EVIDENCE_RUN_ID: "body-limit",
      FUSE_PROVIDER: "anthropic",
    });
    const child = spawn(process.execPath, [
      "--import", join(repository, "node_modules/tsx/dist/loader.mjs"),
      join(repository, "scripts/generate-evidence-fixtures.ts"),
    ], { cwd: directory, env, stdio: "ignore" });
    try {
      const [[code]] = await Promise.all([
        Promise.race([
          once(child, "exit"),
          new Promise<never>((_resolve, reject) => setTimeout(
            () => reject(new Error("OVERSIZED_RUN_DID_NOT_EXIT")), 2_000,
          )),
        ]),
        Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => setTimeout(
            () => reject(new Error("OVERSIZED_RESPONSE_NOT_CANCELLED")), 2_000,
          )),
        ]),
      ]);
      expect(code).not.toBe(0);
      const manifest = JSON.parse(await readFile(
        join(directory, "evidence/fixtures/body-limit.json"), "utf8",
      ));
      expect(manifest).toMatchObject({
        phase: "incomplete",
        attempts: [],
        failure: { code: "EVIDENCE_RESPONSE_BODY_TOO_LARGE", stage: "setup" },
      });
    } finally {
      child.kill("SIGKILL");
      server.close();
    }
  });

  it("does not persist an untrusted HTTP error code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-error-code-"));
    const server = createServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "TOPSECRET_PROVIDER_TOKEN_ABC123" } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("EXPECTED_TEST_SERVER_ADDRESS");
    const repository = process.cwd();
    const env = { ...process.env };
    for (const name of [
      "FUSE_HELD_OUT_PLAN", "FUSE_EVIDENCE_BASELINE_MANIFEST",
      "FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC", "DATABASE_URL_UNPOOLED",
    ]) delete env[name];
    Object.assign(env, {
      FUSE_URL: `http://127.0.0.1:${address.port}`,
      FUSE_ADMIN_TOKEN: "test-admin-token",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:1/test",
      FUSE_EVIDENCE_RUN_ID: "untrusted-error-code",
      FUSE_PROVIDER: "anthropic",
    });
    const child = spawn(process.execPath, [
      "--import", join(repository, "node_modules/tsx/dist/loader.mjs"),
      join(repository, "scripts/generate-evidence-fixtures.ts"),
    ], { cwd: directory, env, stdio: "ignore" });
    try {
      const [code] = await Promise.race([
        once(child, "exit"),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("UNTRUSTED_ERROR_RUN_DID_NOT_EXIT")), 2_000,
        )),
      ]);
      expect(code).not.toBe(0);
      const serialized = await readFile(
        join(directory, "evidence/fixtures/untrusted-error-code.json"), "utf8",
      );
      expect(serialized).not.toContain("TOPSECRET_PROVIDER_TOKEN_ABC123");
      expect(JSON.parse(serialized)).toMatchObject({
        phase: "incomplete",
        attempts: [],
        failure: { code: "FIXTURE_SETUP_FAILED", stage: "setup" },
      });
    } finally {
      child.kill("SIGKILL");
      server.close();
    }
  });

  it("claims and terminalizes missing runtime setup configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-missing-admin-"));
    const repository = process.cwd();
    const env = { ...process.env };
    for (const name of [
      "FUSE_ADMIN_TOKEN", "FUSE_HELD_OUT_PLAN", "FUSE_EVIDENCE_BASELINE_MANIFEST",
      "FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC", "DATABASE_URL_UNPOOLED",
    ]) delete env[name];
    Object.assign(env, {
      DATABASE_URL: "postgres://user:pass@127.0.0.1:1/test",
      FUSE_EVIDENCE_RUN_ID: "missing-admin",
      FUSE_PROVIDER: "anthropic",
    });
    const child = spawn(process.execPath, [
      "--import", join(repository, "node_modules/tsx/dist/loader.mjs"),
      join(repository, "scripts/generate-evidence-fixtures.ts"),
    ], { cwd: directory, env, stdio: "ignore" });
    const [code] = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("MISSING_ADMIN_RUN_DID_NOT_EXIT")), 2_000,
      )),
    ]);
    expect(code).not.toBe(0);
    await expect(stat(join(
      directory, "evidence/.run-claims/fixed-fixtures/missing-admin.claim",
    ))).resolves.toBeDefined();
    const manifest = JSON.parse(await readFile(
      join(directory, "evidence/fixtures/missing-admin.json"), "utf8",
    ));
    expect(manifest).toMatchObject({
      phase: "incomplete",
      attempts: [],
      failure: { code: "FUSE_ADMIN_TOKEN_REQUIRED", stage: "setup" },
    });
  });

  it("claims and terminalizes invalid attributable configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-invalid-provider-"));
    const repository = process.cwd();
    const env = { ...process.env };
    for (const name of [
      "FUSE_ADMIN_TOKEN", "FUSE_HELD_OUT_PLAN", "FUSE_EVIDENCE_BASELINE_MANIFEST",
      "FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC", "DATABASE_URL_UNPOOLED", "DATABASE_URL",
    ]) delete env[name];
    Object.assign(env, {
      FUSE_EVIDENCE_RUN_ID: "invalid-provider",
      FUSE_PROVIDER: "secret-shaped-provider-value",
    });
    const child = spawn(process.execPath, [
      "--import", join(repository, "node_modules/tsx/dist/loader.mjs"),
      join(repository, "scripts/generate-evidence-fixtures.ts"),
    ], { cwd: directory, env, stdio: "ignore" });
    const [code] = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("INVALID_PROVIDER_RUN_DID_NOT_EXIT")), 2_000,
      )),
    ]);
    expect(code).not.toBe(0);
    await expect(stat(join(
      directory, "evidence/.run-claims/fixed-fixtures/invalid-provider.claim",
    ))).resolves.toBeDefined();
    const manifestText = await readFile(
      join(directory, "evidence/fixtures/invalid-provider.json"), "utf8",
    );
    expect(manifestText).not.toContain("secret-shaped-provider-value");
    expect(JSON.parse(manifestText)).toMatchObject({
      phase: "incomplete",
      configurationStatus: "pending",
      provider: null,
      model: null,
      attempts: [],
      failure: {
        code: "FUSE_PROVIDER_INVALID",
        stage: "setup",
        plannedAttempts: 0,
      },
    });
  });

  it("advances a committed held-out plan from pending to ready configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-held-out-ready-"));
    const repository = process.cwd();
    const planPath = join(directory, "held-out-plan.json");
    await writeFile(planPath, await readFile(join(
      repository,
      "evidence/held-out/plans/sha256:32c55311f3f7f66398ac4b5effbbfc9dd50c50f0cce585764e0aa9534df8734d.json",
    )));
    const runGit = async (args: string[]): Promise<void> => {
      const child = spawn("git", args, { cwd: directory, stdio: "ignore" });
      const [code] = await once(child, "exit");
      if (code !== 0) throw new Error(`TEST_GIT_FAILED:${args.join(" ")}`);
    };
    await runGit(["init", "--quiet"]);
    await runGit(["add", "held-out-plan.json"]);
    await runGit([
      "-c", "user.name=Fuse Test", "-c", "user.email=fuse@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "held-out plan",
    ]);

    const env = { ...process.env };
    for (const name of [
      "FUSE_ADMIN_TOKEN", "FUSE_PROVIDER", "FUSE_EVIDENCE_MODEL",
      "FUSE_EVIDENCE_BASELINE_MANIFEST", "DATABASE_URL_UNPOOLED", "DATABASE_URL",
    ]) delete env[name];
    Object.assign(env, {
      FUSE_EVIDENCE_RUN_ID: "held-out-ready",
      FUSE_HELD_OUT_PLAN: planPath,
      FUSE_EVIDENCE_PROVIDER_COST_CAP_ATOMIC: "999999999999",
    });
    const child = spawn(process.execPath, [
      "--import", join(repository, "node_modules/tsx/dist/loader.mjs"),
      join(repository, "scripts/generate-evidence-fixtures.ts"),
    ], { cwd: directory, env, stdio: "ignore" });
    const [code] = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("HELD_OUT_READY_RUN_DID_NOT_EXIT")), 3_000,
      )),
    ]);
    expect(code).not.toBe(0);
    const manifest = JSON.parse(await readFile(
      join(directory, "evidence/held-out/manifests/held-out-ready.json"), "utf8",
    ));
    expect(manifest).toMatchObject({
      phase: "incomplete",
      evidenceType: "held-out",
      configurationStatus: "ready",
      failure: {
        code: "FUSE_ADMIN_TOKEN_REQUIRED",
        stage: "setup",
        plannedAttempts: 224,
      },
      attempts: [],
    });
    expect(manifest.configurationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.provider).toMatch(/^(anthropic|openrouter)$/);
  });

  it("recognizes complete, incomplete, and nonterminal manifest lifecycles", () => {
    const failure = {
      code: "FIXTURE_EXPECTATION_FAILED",
      stage: "post-call-validation",
      occurredAt: "2026-07-23T01:22:51.928Z",
      requestId: "held-out-request",
      attemptSequence: 14,
      attemptsPersisted: 14,
      plannedAttempts: 224,
    };
    expect(() => assertReplayableEvidenceManifestLifecycle({
      schemaVersion: 3, phase: "incomplete", failure,
    })).toThrow("EVIDENCE_MANIFEST_INCOMPLETE");
    expect(() => assertReplayableEvidenceManifestLifecycle({
      schemaVersion: 3,
      phase: "incomplete",
      failure: {
        ...failure,
        stage: "setup",
        requestId: null,
        attemptSequence: null,
        attemptsPersisted: 0,
        plannedAttempts: 0,
      },
    })).toThrow("EVIDENCE_MANIFEST_INCOMPLETE");
    expect(() => assertReplayableEvidenceManifestLifecycle({
      schemaVersion: 2, phase: "running",
    })).toThrow("EVIDENCE_MANIFEST_NOT_TERMINAL");
    expect(() => assertReplayableEvidenceManifestLifecycle({
      schemaVersion: 3, phase: "incomplete", failure: null,
    })).toThrow("EVIDENCE_MANIFEST_INVALID");
    expect(() => assertReplayableEvidenceManifestLifecycle({
      schemaVersion: 3, phase: "incomplete", failure: { ...failure, extra: "forbidden" },
    })).toThrow("EVIDENCE_MANIFEST_INVALID");
    expect(() => assertReplayableEvidenceManifestLifecycle({
      schemaVersion: 3, phase: "incomplete", failure: { ...failure, occurredAt: "July 23, 2026" },
    })).toThrow("EVIDENCE_MANIFEST_INVALID");
    expect(() => assertReplayableEvidenceManifestLifecycle({
      schemaVersion: 2, phase: "complete",
    })).not.toThrow();
    expect(() => assertReplayableEvidenceManifestLifecycle({
      schemaVersion: 3, phase: "complete", failure: null,
    })).not.toThrow();
  });

  it("surfaces both failures when incomplete persistence fails", async () => {
    const original = new Error("FIXTURE_CALL_FAILED");
    const persistence = new Error("disk unavailable");
    const result = runWithIncompleteEvidenceCapture(
      async () => { throw original; },
      async () => { throw persistence; },
      () => ({
        stage: "provider-call",
        requestId: "request-2",
        attemptSequence: 2,
        attemptsPersisted: 1,
        plannedAttempts: 224,
      }),
    );
    await expect(result).rejects.toMatchObject({
      message: "EVIDENCE_INCOMPLETE_MANIFEST_PERSIST_FAILED",
      errors: [original, persistence],
    });
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

  it.each(["complete", "incomplete"] as const)("makes %s manifests immutable", async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-immutable-"));
    const manifestPath = join(directory, "manifest.json");
    await atomicReplaceJson(manifestPath, { phase, attempts: [] }, { immutableWhenTerminal: true });
    await expect(atomicReplaceJson(manifestPath, { phase: "running", attempts: [] }, {
      immutableWhenTerminal: true,
    })).rejects.toThrow("EVIDENCE_TERMINAL_ARTIFACT_IMMUTABLE");
  });

  it("allows exactly one concurrent terminal transition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-terminal-race-"));
    const manifestPath = join(directory, "manifest.json");
    await atomicReplaceJson(manifestPath, { phase: "running", attempts: [] }, {
      immutableWhenTerminal: true,
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstReachedRename!: () => void;
    const firstAtRename = new Promise<void>((resolve) => { firstReachedRename = resolve; });
    const first = atomicReplaceJson(manifestPath, { phase: "complete", attempts: [] }, {
      immutableWhenTerminal: true,
      beforeRename: async () => {
        firstReachedRename();
        await firstCanFinish;
      },
    });
    await firstAtRename;
    let secondStarted!: () => void;
    const secondAtLock = new Promise<void>((resolve) => { secondStarted = resolve; });
    const second = atomicReplaceJson(manifestPath, { phase: "incomplete", attempts: [] }, {
      immutableWhenTerminal: true,
      beforeLock: () => { secondStarted(); },
    });
    await secondAtLock;
    releaseFirst();
    const results = await Promise.allSettled([first, second]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "EVIDENCE_TERMINAL_ARTIFACT_IMMUTABLE" }),
    });
    expect(JSON.parse(await readFile(manifestPath, "utf8")).phase).toBe("complete");
  });

  it("keeps replay output write-once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fuse-replay-"));
    const replayPath = join(directory, "replay.json");
    await writeOnceJson(replayPath, { runId: "first" });
    await expect(writeOnceJson(replayPath, { runId: "second" })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(replayPath, "utf8"))).toEqual({ runId: "first" });
    expect((await stat(replayPath)).mode & 0o777).toBe(0o600);
  });
});
