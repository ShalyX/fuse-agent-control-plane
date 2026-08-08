import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RELIABILITY_SCHEMA_SQL, REPLAY_AUDITED_TABLES } from "../src/reliability/reliabilitySchema.js";
import { schedulerRecoveryDecision } from "../src/reliability/protocolStore.js";
import { publishManifestDurably } from "../src/evidence/reliabilityProtocolV2.js";
import { executeReliabilityCli } from "../src/evidence/reliabilityCliV2.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("reliability v2 eighth production closure", () => {
  it("installs durable per-call scheduler claims and protocol-wide replay audit triggers", () => {
    expect(RELIABILITY_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS reliability_scheduler_claims");
    expect(RELIABILITY_SCHEMA_SQL).toContain("lease_expires_at");
    expect(RELIABILITY_SCHEMA_SQL).toContain("manifest_fsynced_at");
    expect(RELIABILITY_SCHEMA_SQL).toContain("current_setting('fuse.replay_operation_id', true)");
    expect(REPLAY_AUDITED_TABLES).toEqual(expect.arrayContaining([
      "inference_executions", "policy_decisions", "control_mandates", "mandate_branches",
      "reconciliation_resolutions", "mandate_reconciliation_holds", "shadow_evaluation_queue",
      "reliability_protocol_attempts", "reliability_dispatch_tokens", "reliability_reconciliation_evidence",
    ]));
    for (const table of REPLAY_AUDITED_TABLES) expect(RELIABILITY_SCHEMA_SQL).toContain(`reliability_replay_audit_${table}`);
  });

  it("never redispatches a recovered call once a token or primitive entry exists", () => {
    expect(schedulerRecoveryDecision({ terminal: true, dispatchToken: true, primitiveEntered: true })).toBe("already_terminal");
    expect(schedulerRecoveryDecision({ terminal: false, dispatchToken: true, primitiveEntered: false })).toBe("await_authoritative_outcome");
    expect(schedulerRecoveryDecision({ terminal: false, dispatchToken: true, primitiveEntered: true })).toBe("reconcile_without_redispatch");
    expect(schedulerRecoveryDecision({ terminal: false, dispatchToken: false, primitiveEntered: false })).toBe("dispatch_original");
  });

  it("fsyncs a restart manifest and permits only exact durable replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "fuse-manifest-")); roots.push(root);
    const path = join(root, "manifest.json");
    await publishManifestDurably(path, { state: "claimed", sequence: 1 });
    await publishManifestDurably(path, { state: "terminal", sequence: 2 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ sequence: 2, state: "terminal" });
    await publishManifestDurably(path, { state: "terminal", sequence: 2 });
    await expect(publishManifestDurably(path, { state: "claimed", sequence: 1 })).rejects.toThrow("MANIFEST_TRANSITION_CONFLICT");
    await expect(publishManifestDurably(path, { state: "terminal", sequence: 3 })).rejects.toThrow("MANIFEST_PUBLICATION_BUSY");
    expect(await readFile(`${path}.write-lock`, "utf8")).toContain('"destination"');
  });

  it("exposes setup and one-call worker as fail-closed CLI operations", async () => {
    await expect(executeReliabilityCli(["setup", "--json"])).resolves.toMatchObject({ ok: false, errorCode: "RELIABILITY_SERVICE_REQUIRED" });
    await expect(executeReliabilityCli(["worker", "--json"])).resolves.toMatchObject({ ok: false, errorCode: "RELIABILITY_SERVICE_REQUIRED" });
    const calls: string[] = [];
    const operations = {
      setup: async () => { calls.push("setup"); return { setupFingerprint: "sha256:setup", exactReadback: true }; },
      worker: async () => { calls.push("worker"); return { requestId: "r1", recoveryDecision: "dispatch_original", terminal: true }; },
    };
    await expect(executeReliabilityCli(["setup", "--json"], { operations })).resolves.toMatchObject({ ok: true, exactReadback: true });
    await expect(executeReliabilityCli(["worker", "--json"], { operations })).resolves.toMatchObject({ ok: true, requestId: "r1", terminal: true });
    expect(calls).toEqual(["setup", "worker"]);
  });
});
