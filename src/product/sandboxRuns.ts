import { createHash } from "node:crypto";
import { BranchCircuit } from "../core/circuit.js";
import { FuseLedger } from "../core/ledger.js";
import type { SandboxRunStore } from "./sandboxRunStore.js";

export type SandboxEvent = {
  sequence: number;
  branchId: "scout" | "reviewer";
  type: "reserved" | "usage_reconciled" | "acceleration_detected" | "branch_tripped" | "allowance_reclaimed" | "sibling_completed";
  requestId: string;
  amountAtomic?: string;
  circuitState?: "HEALTHY" | "ELEVATED" | "TRIPPED";
  reason?: string;
};

export type SandboxRun = {
  runId: string;
  workspaceId: string;
  seed: string;
  mode: "sandbox";
  status: "completed";
  scout: { branchId: "scout"; circuitState: "TRIPPED"; reclaimedAtomic: string };
  reviewer: { branchId: "reviewer"; status: "completed"; actualCostAtomic: string };
  events: SandboxEvent[];
  ledger: {
    rootSettledAtomic: string;
    scoutSettledAtomic: string;
    reviewerSettledAtomic: string;
  };
};

const ROOT = 300_000n;
const SCOUT = 150_000n;
const REVIEWER = 100_000n;
const CEILING = 50_000n;

export function sandboxRunId(workspaceId: string, seed: string): string {
  return `sandbox_${createHash("sha256").update(`${workspaceId}:${seed}`).digest("hex").slice(0, 24)}`;
}

function amount(value: bigint): string { return value.toString(); }

export class SandboxRunService {
  private readonly runs = new Map<string, SandboxRun>();

  run(workspaceId: string, seed = "default"): SandboxRun {
    const normalizedWorkspace = workspaceId.trim();
    const normalizedSeed = seed.trim() || "default";
    if (!normalizedWorkspace) throw new Error("WORKSPACE_REQUIRED");
    if (normalizedWorkspace.length > 128 || normalizedSeed.length > 128) throw new Error("INVALID_SANDBOX_REFERENCE");
    const id = sandboxRunId(normalizedWorkspace, normalizedSeed);
    const existing = this.runs.get(id);
    if (existing) return structuredClone(existing);

    const ledger = new FuseLedger({
      mandateId: `${id}_mandate`,
      maximumSpendMicros: ROOT,
      children: { scout: SCOUT, reviewer: REVIEWER },
    });
    const scoutCircuit = new BranchCircuit({ perCallCeilingMicros: CEILING, minimumSpikeDeltaMicros: 1n });
    const reviewerBranchCircuit = new BranchCircuit({ perCallCeilingMicros: CEILING, minimumSpikeDeltaMicros: 1n });
    const events: SandboxEvent[] = [];
    let sequence = 0;
    const event = (entry: Omit<SandboxEvent, "sequence">) => events.push({ sequence: ++sequence, ...entry });

    const scoutCosts = [5_000n, 20_000n, 80_000n];
    for (const [index, cost] of scoutCosts.entries()) {
      const requestId = `${id}_scout_${index + 1}`;
      ledger.reserve("scout", cost, requestId);
      event({ branchId: "scout", type: "reserved", requestId, amountAtomic: amount(cost) });
      const circuit = scoutCircuit.evaluate(cost);
      ledger.reconcile(requestId, cost);
      event({ branchId: "scout", type: "usage_reconciled", requestId, amountAtomic: amount(cost), circuitState: circuit.state });
      if (circuit.state === "ELEVATED") event({ branchId: "scout", type: "acceleration_detected", requestId, circuitState: circuit.state, reason: "REPEATED_COST_ACCELERATION" });
      if (circuit.state === "TRIPPED") {
        event({ branchId: "scout", type: "branch_tripped", requestId, circuitState: circuit.state, reason: circuit.reason });
        const reclaimed = ledger.reclaimAvailable("scout");
        event({ branchId: "scout", type: "allowance_reclaimed", requestId, amountAtomic: amount(reclaimed) });
        break;
      }
    }

    const reviewerRequest = `${id}_reviewer_1`;
    const reviewerCost = 10_000n;
    ledger.reserve("reviewer", reviewerCost, reviewerRequest);
    event({ branchId: "reviewer", type: "reserved", requestId: reviewerRequest, amountAtomic: amount(reviewerCost) });
    const reviewerResult = reviewerBranchCircuit.evaluate(reviewerCost);
    ledger.reconcile(reviewerRequest, reviewerCost);
    const reviewerState = reviewerBranchCircuit.snapshot().state;
    event({ branchId: "reviewer", type: "usage_reconciled", requestId: reviewerRequest, amountAtomic: amount(reviewerCost), circuitState: reviewerState });
    event({ branchId: "reviewer", type: "sibling_completed", requestId: reviewerRequest, amountAtomic: amount(reviewerCost), circuitState: reviewerState });

    const snapshot = ledger.snapshot();
    const result: SandboxRun = {
      runId: id, workspaceId: normalizedWorkspace, seed: normalizedSeed, mode: "sandbox", status: "completed",
      scout: { branchId: "scout", circuitState: "TRIPPED", reclaimedAtomic: events.find((item) => item.type === "allowance_reclaimed")?.amountAtomic ?? "0" },
      reviewer: { branchId: "reviewer", status: "completed", actualCostAtomic: amount(reviewerCost) },
      events,
      ledger: {
        rootSettledAtomic: amount(snapshot.root.settledMicros),
        scoutSettledAtomic: amount(snapshot.children.scout.settledMicros),
        reviewerSettledAtomic: amount(snapshot.children.reviewer.settledMicros),
      },
    };
    this.runs.set(id, result);
    return structuredClone(result);
  }

  async runDurable(store: SandboxRunStore, workspaceId: string, seed = "default"): Promise<SandboxRun> {
    const normalizedWorkspace = workspaceId.trim();
    const normalizedSeed = seed.trim() || "default";
    if (!normalizedWorkspace) throw new Error("WORKSPACE_REQUIRED");
    if (normalizedWorkspace.length > 128 || normalizedSeed.length > 128) throw new Error("INVALID_SANDBOX_REFERENCE");
    const id = sandboxRunId(normalizedWorkspace, normalizedSeed);
    const existing = await store.get(normalizedWorkspace, id);
    if (existing) return existing;
    const created = this.run(normalizedWorkspace, normalizedSeed);
    await store.put(created);
    return created;
  }
  get(workspaceId: string, id: string): SandboxRun {
    const result = this.runs.get(id);
    if (!result || result.workspaceId !== workspaceId) throw new Error("SANDBOX_RUN_NOT_FOUND");
    return structuredClone(result);
  }
}