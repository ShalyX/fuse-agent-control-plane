import { describe, expect, it } from "vitest";
import { SandboxRunService } from "../src/product/sandboxRuns.js";
import { MemorySandboxRunStore, PostgresSandboxRunStore } from "../src/product/sandboxRunStore.js";
import { newAdvisoryMemoryDb } from "./helpers/pgMemAdvisory.js";

describe("durable sandbox run store", () => {
  it("reuses a persisted run after the service instance is replaced", async () => {
    const store = new MemorySandboxRunStore();
    const first = await new SandboxRunService().runDurable(store, "workspace-1", "golden-path");
    const second = await new SandboxRunService().runDurable(store, "workspace-1", "golden-path");
    expect(second).toEqual(first);
    expect(second.runId).toBe(first.runId);
  });

  it("is idempotent for the same workspace and seed", async () => {
    const store = new MemorySandboxRunStore();
    const service = new SandboxRunService();
    const first = await service.runDurable(store, "workspace-1", "same-seed");
    const second = await service.runDurable(store, "workspace-1", "same-seed");
    expect(second).toEqual(first);
  });

  it("does not allow another workspace to read the persisted run", async () => {
    const store = new MemorySandboxRunStore();
    const service = new SandboxRunService();
    const run = await service.runDurable(store, "workspace-1", "private-seed");
    expect(await store.get("workspace-2", run.runId)).toBeNull();
  });

  it("reads the same record through a fresh Postgres store instance", async () => {
    const db = newAdvisoryMemoryDb();
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    const first = await new SandboxRunService().runDurable(
      new PostgresSandboxRunStore(pool), "workspace-pg", "restart-seed",
    );
    const second = await new SandboxRunService().runDurable(
      new PostgresSandboxRunStore(pool), "workspace-pg", "restart-seed",
    );
    expect(second).toEqual(first);
    expect(await new PostgresSandboxRunStore(pool).readiness()).toBe(true);
    await pool.end();
  });

  it("does not call an in-memory sandbox durable", async () => {
    expect(await new MemorySandboxRunStore().readiness()).toBe(false);
  });
});
