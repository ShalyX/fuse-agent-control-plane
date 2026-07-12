import { BranchCircuit } from "../src/core/circuit.js";
import { FuseLedger } from "../src/core/ledger.js";

const ledger = new FuseLedger({
  mandateId: "fuse-demo-root",
  maximumSpendMicros: 250_000n,
  children: { scout: 60_000n, builder: 120_000n, reviewer: 50_000n },
});

const circuits = {
  scout: new BranchCircuit({ perCallCeilingMicros: 50_000n, minimumSpikeDeltaMicros: 1_000n }),
  builder: new BranchCircuit({ perCallCeilingMicros: 80_000n, minimumSpikeDeltaMicros: 1_000n }),
  reviewer: new BranchCircuit({ perCallCeilingMicros: 40_000n, minimumSpikeDeltaMicros: 1_000n }),
};

function pay(childId: keyof typeof circuits, requestId: string, maximum: bigint, actual: bigint) {
  ledger.reserve(childId, maximum, requestId);
  const policy = circuits[childId].evaluate(actual);
  ledger.reconcile(requestId, actual);
  console.log(`${childId.padEnd(8)} ${requestId.padEnd(16)} $${Number(actual) / 1_000_000} ${policy.state}`);
  return policy;
}

console.log("\nFUSE · hierarchical budget / isolated circuit demo\n");
pay("scout", "scout-baseline", 3_000n, 2_000n);
pay("builder", "builder-call", 15_000n, 9_000n);
pay("reviewer", "reviewer-call", 8_000n, 4_000n);
pay("scout", "scout-spike-1", 10_000n, 8_000n);
const trip = pay("scout", "scout-spike-2", 35_000n, 32_000n);

if (trip.state !== "TRIPPED") throw new Error("DEMO_EXPECTED_SCOUT_TO_TRIP");

pay("reviewer", "reviewer-finish", 7_000n, 5_000n);

const snapshot = ledger.snapshot();
console.log("\nScout isolated:", trip.reason);
console.log("Reviewer continued: yes");
console.log("Root settled:", `$${Number(snapshot.root.settledMicros) / 1_000_000}`);
console.log("Root available:", `$${Number(snapshot.root.availableMicros) / 1_000_000}`);
console.log("\nDEMO PASS\n");
