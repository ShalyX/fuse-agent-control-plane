import { describe, expect, it } from "vitest";
import { BranchCircuit } from "../src/core/circuit.js";

describe("BranchCircuit", () => {
  it("moves healthy to elevated to tripped after two consecutive 4x spikes", () => {
    const circuit = new BranchCircuit({ perCallCeilingMicros: 100_000n, minimumSpikeDeltaMicros: 1_000n });
    expect(circuit.evaluate(2_000n).state).toBe("HEALTHY");
    expect(circuit.evaluate(8_000n)).toMatchObject({ state: "ELEVATED", consecutiveViolations: 1 });
    expect(circuit.evaluate(32_000n)).toMatchObject({
      state: "TRIPPED",
      decision: "trip",
      reason: "REPEATED_COST_ACCELERATION",
      consecutiveViolations: 2,
    });
  });

  it("trips immediately when the absolute per-call limit is exceeded", () => {
    const circuit = new BranchCircuit({ perCallCeilingMicros: 20_000n, minimumSpikeDeltaMicros: 1_000n });
    expect(circuit.evaluate(20_001n)).toMatchObject({
      state: "TRIPPED",
      decision: "trip",
      reason: "ABSOLUTE_CALL_LIMIT",
    });
  });

  it("resets a relative strike after a normal successful call", () => {
    const circuit = new BranchCircuit({ perCallCeilingMicros: 100_000n, minimumSpikeDeltaMicros: 1_000n });
    circuit.evaluate(2_000n);
    expect(circuit.evaluate(8_000n).state).toBe("ELEVATED");
    expect(circuit.evaluate(9_000n)).toMatchObject({ state: "HEALTHY", consecutiveViolations: 0 });
  });
});
