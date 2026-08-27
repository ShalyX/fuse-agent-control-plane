import { describe, expect, it } from "vitest";
import { SandboxRunService } from "../src/product/sandboxRuns.js";

describe("SandboxRunService", () => {
  it("runs the deterministic Scout/Reviewer causal sequence", () => {
    const service = new SandboxRunService();
    const run = service.run("workspace-1", "golden-path");

    expect(run.mode).toBe("sandbox");
    expect(run.status).toBe("completed");
    expect(run.scout.circuitState).toBe("TRIPPED");
    expect(BigInt(run.scout.reclaimedAtomic)).toBeGreaterThan(0n);
    expect(run.reviewer.status).toBe("completed");
    expect(run.events.map((event) => event.type)).toEqual([
      "reserved", "usage_reconciled", "reserved", "usage_reconciled", "acceleration_detected",
      "reserved", "usage_reconciled", "branch_tripped", "allowance_reclaimed",
      "reserved", "usage_reconciled", "sibling_completed",
    ]);
    expect(run.ledger.rootSettledAtomic).toBe("115000");
    expect(run.ledger.scoutSettledAtomic).toBe("105000");
    expect(run.ledger.reviewerSettledAtomic).toBe("10000");
  });

  it("is deterministic and idempotent for workspace and seed", () => {
    const service = new SandboxRunService();
    const first = service.run("workspace-1", "same-seed");
    const second = service.run("workspace-1", "same-seed");
    const other = service.run("workspace-1", "other-seed");

    expect(second).toEqual(first);
    expect(other.runId).not.toBe(first.runId);
    expect(service.get("workspace-1", first.runId)).toEqual(first);
    expect(() => service.get("workspace-2", first.runId)).toThrow("SANDBOX_RUN_NOT_FOUND");
  });
});
