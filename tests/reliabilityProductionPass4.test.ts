import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import { executeReliabilityCli } from "../src/evidence/reliabilityCliV2.js";
import { RELIABILITY_SCHEMA_SQL } from "../src/reliability/reliabilitySchema.js";
import {
  RECONCILIATION_OFFSETS_SECONDS,
  blockWindowDisposition,
  reconciliationWindow,
  signAuthorizationArtifact,
} from "../src/reliability/operationalV2.js";

describe("reliability v2 production pass 4", () => {
  it("installs executable commands for every operation", () => {
    for (const command of ["doctor", "dry", "seal", "authorize", "run", "reconcile", "replay", "evidence"]) {
      expect(packageJson.scripts[`evidence:held-out:v2:${command}` as keyof typeof packageJson.scripts])
        .toBe(`tsx scripts/held-out-reliability-v2.ts ${command}`);
    }
  });

  it("migrates old Neon table shapes and uses run-global protocol ownership", () => {
    expect(RELIABILITY_SCHEMA_SQL).toContain("ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS nonusable_allowance_owner TEXT");
    expect(RELIABILITY_SCHEMA_SQL).toContain("ALTER TABLE reliability_protocol_controls ADD COLUMN IF NOT EXISTS dispatch_token_count INTEGER");
    expect(RELIABILITY_SCHEMA_SQL).toContain("ALTER TABLE reliability_block_claims ADD COLUMN IF NOT EXISTS plan_fingerprint TEXT");
    expect(RELIABILITY_SCHEMA_SQL).toContain("reliability_one_block_claim_per_run_block");
    expect(RELIABILITY_SCHEMA_SQL).toContain("reliability_one_replay_mutex_per_run");
  });

  it("uses database-clock half-open block windows and exact reconciliation windows", () => {
    const opens = "2026-07-25T08:17:00.000Z";
    const deadline = "2026-07-25T08:22:00.000Z";
    expect(blockWindowDisposition(opens, opens, deadline)).toBe("open");
    expect(blockWindowDisposition("2026-07-25T08:21:59.999Z", opens, deadline)).toBe("open");
    expect(blockWindowDisposition(deadline, opens, deadline)).toBe("late");
    expect(blockWindowDisposition("2026-07-25T08:16:59.999Z", opens, deadline)).toBe("early");
    expect(RECONCILIATION_OFFSETS_SECONDS).toEqual([0, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 64800, 86300]);
    expect(reconciliationWindow("2026-07-25T00:00:00.000Z", 60)).toEqual({
      scheduledAt: "2026-07-25T00:01:00.000Z",
      startsBefore: "2026-07-25T00:01:01.000Z",
      evidenceCutoff: "2026-07-26T00:00:00.000Z",
      classificationDeadline: "2026-07-26T00:00:31.000Z",
    });
  });

  it("seal reads one local beacon, invokes real verifier operation, and requires no external proof file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hov2-pass4-seal-"));
    await writeFile(join(root, "beacon.json"), "{\"round\":6315000}");
    const seal = vi.fn(async ({ files }: any) => ({ sealed: true, bytes: files.beacon.length }));
    const result = await executeReliabilityCli(["seal", "--beacon-file", "beacon.json", "--identity", "identity.json", "--run-id", "run", "--output", "plan.json"], {
      cwd: root, operations: { seal }, readLocal: async (name) => readFile(join(root, name)),
    });
    expect(result).toMatchObject({ ok: true, sealed: true });
    expect(seal).toHaveBeenCalledOnce();
  });

  it("signs canonical authorization from a private key file without returning key bytes", async () => {
    const keys = generateKeyPairSync("ed25519");
    const root = await mkdtemp(join(tmpdir(), "hov2-pass4-auth-"));
    const keyPath = join(root, "key.pem");
    await writeFile(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const artifact = await signAuthorizationArtifact({ kind: "operator", runId: "r", planFingerprint: `sha256:${"a".repeat(64)}`, executableFingerprint: `sha256:${"b".repeat(64)}`, actorId: "actor", issuerCredentialId: "issuer", capability: "evidence:authorize-spend", nonce: "n", expiresAt: "2026-07-25T08:22:00.000Z" }, keyPath);
    expect(artifact.signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(JSON.stringify(artifact)).not.toContain("PRIVATE KEY");
  });

  it.each(["doctor", "dry", "seal", "authorize", "run", "reconcile", "replay", "evidence"])("keeps %s no-spend when prerequisites are absent", async (command) => {
    const network = vi.fn(async () => { throw new Error("must not call"); });
    await executeReliabilityCli([command], { cwd: "/missing", network });
    expect(network).not.toHaveBeenCalled();
  });
});
