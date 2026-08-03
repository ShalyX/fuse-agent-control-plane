import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeReliabilityCli } from "../src/evidence/reliabilityCliV2.js";

describe("held-out reliability v2 noninteractive CLI and mandatory no-spend boundary", () => {
  it.each(["doctor", "dry", "seal", "authorize", "run", "reconcile", "replay", "evidence"])("supports %s without prompts", async (command) => {
    const result = await executeReliabilityCli([command, "--json"], { cwd: "/nonexistent", now: () => "2026-07-23T00:00:00.000Z" });
    expect(result.command).toBe(command);
    expect(typeof result.ok).toBe("boolean");
    expect(result.prompted).toBe(false);
  });

  it("doctor and dry prove zero provider/payment/beacon calls", async () => {
    let networkCalls = 0;
    const deps = { cwd: "/nonexistent", now: () => "2026-07-23T00:00:00.000Z", network: async () => { networkCalls++; throw new Error("network forbidden"); } };
    expect(await executeReliabilityCli(["doctor", "--json"], deps)).toMatchObject({
      ok: false, errorCode: "RESTART_RESUME_RECOVERY_UNAVAILABLE", networkDefault: "deny",
      paymentPath: "absent", providerCalls: 0, paymentCalls: 0, beaconCalls: 0,
    });
    expect(await executeReliabilityCli(["dry", "--json"], deps)).toMatchObject({
      ok: true, simulated: true, providerCalls: 0, paymentCalls: 0, beaconCalls: 0,
      plannedFresh: 100, plannedReplays: 20,
    });
    expect(networkCalls).toBe(0);
  });

  it.each(["run", "reconcile"])("denies %s network path unless explicit purpose flag is present", async (command) => {
    expect(await executeReliabilityCli([command, "--json"], { cwd: "/nonexistent" })).toMatchObject({
      ok: false, errorCode: "NETWORK_DEFAULT_DENY", providerCalls: 0,
    });
  });

  it("denies replay unless its dedicated network flag, plan, and signed run authorization are explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "hov2-replay-cli-"));
    await writeFile(join(root, "plan.json"), "{}\n");
    await writeFile(join(root, "authorization.json"), "{}\n");
    expect(await executeReliabilityCli(["replay", "--plan", "plan.json"], { cwd: root }))
      .toMatchObject({ ok: false, errorCode: "NETWORK_DEFAULT_DENY", providerCalls: 0 });
    expect(await executeReliabilityCli(["replay", "--allow-replay-network", "--plan", "plan.json"], { cwd: root }))
      .toMatchObject({ ok: false, errorCode: "SIGNED_AUTHORIZATION_REQUIRED", providerCalls: 0 });
    let receivedFiles: Readonly<Record<string, Buffer>> = {};
    const accepted = await executeReliabilityCli([
      "replay", "--allow-replay-network", "--plan", "plan.json",
      "--operator-authorization", "authorization.json",
    ], { cwd: root, operations: { replay: async ({ files }) => { receivedFiles = files; return { replayPassed: 20 }; } } });
    expect(accepted).toMatchObject({ ok: true, replayPassed: 20 });
    expect(Object.keys(receivedFiles).sort()).toEqual(["authorization", "plan"]);
  });

  it("requires separate dispatch and reconciliation flags plus signed authorization and committed reviewed identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "hov2-cli-"));
    await writeFile(join(root, "plan.json"), "{}\n");
    expect(await executeReliabilityCli(["run", "--allow-provider-network", "--plan", "plan.json", "--json"], { cwd: root }))
      .toMatchObject({ ok: false, errorCode: "SIGNED_AUTHORIZATION_REQUIRED", providerCalls: 0 });
    expect(await executeReliabilityCli(["reconcile", "--allow-reconciliation-network", "--plan", "plan.json", "--json"], { cwd: root }))
      .toMatchObject({ ok: false, errorCode: "SIGNED_RECONCILIATION_AUTHORIZATION_REQUIRED", providerCalls: 0 });
    expect(await executeReliabilityCli(["run", "--allow-provider-network", "--plan", "plan.json", "--operator-authorization", "auth.json", "--json"], { cwd: root }))
      .toMatchObject({ ok: false, errorCode: "SIGNED_AUTHORIZATION_REQUIRED", providerCalls: 0 });
  });

  it("routes missing run authorizations into the durable predecision handler when explicitly enabled", async()=>{
    const root=await mkdtemp(join(tmpdir(),"hov3-predecision-cli-"));
    await writeFile(join(root,"plan.json"),"{}\n");
    let receivedFiles:Readonly<Record<string,Buffer>>={};
    const result=await executeReliabilityCli(["run","--allow-provider-network","--plan","plan.json"],{
      cwd:root,durableRunPredecision:true,operations:{run:async({files})=>{receivedFiles=files;throw new Error("READINESS_PREDECISION_FAILED");}},
    });
    expect(result).toMatchObject({ok:false,errorCode:"READINESS_PREDECISION_FAILED"});
    expect(Object.keys(receivedFiles)).toEqual(["plan"]);
  });

  it("never exposes a payment execution flag or treats HTTP 402 as payable", async () => {
    expect(await executeReliabilityCli(["run", "--allow-payment", "--json"], { cwd: "/nonexistent" }))
      .toMatchObject({ ok: false, errorCode: "PAYMENT_PATH_PROHIBITED", paymentCalls: 0 });
    expect(await executeReliabilityCli(["run", "--http-status", "402", "--json"], { cwd: "/nonexistent" }))
      .toMatchObject({ ok: false, errorCode: "PAYMENT_REQUIRED_FAIL_CLOSED", paymentCalls: 0 });
  });

  it("seal consumes one local beacon and never accepts an external proof substitute", async () => {
    const root = await mkdtemp(join(tmpdir(), "hov2-seal-"));
    await writeFile(join(root, "beacon.json"), JSON.stringify({ round: 6315000 }));
    const result = await executeReliabilityCli(["seal", "--beacon-file", "beacon.json", "--json"], { cwd: root });
    expect(result).toMatchObject({ ok: false, errorCode: "RELIABILITY_SERVICE_REQUIRED", beaconCalls: 0 });
  });
});
