export type CircuitState = "HEALTHY" | "ELEVATED" | "TRIPPED";
export type CircuitReason = "ALLOW" | "ABSOLUTE_CALL_LIMIT" | "REPEATED_COST_ACCELERATION";

export type CircuitResult = {
  state: CircuitState;
  decision: "allow" | "trip";
  reason: CircuitReason;
  currentCostMicros: bigint;
  baselineCostMicros?: bigint;
  ratio?: number;
  consecutiveViolations: number;
};

export class BranchCircuit {
  private state: CircuitState = "HEALTHY";
  private previousCostMicros?: bigint;
  private consecutiveViolations = 0;

  constructor(private readonly config: {
    perCallCeilingMicros: bigint;
    minimumSpikeDeltaMicros: bigint;
  }) {}

  evaluate(currentCostMicros: bigint): CircuitResult {
    if (this.state === "TRIPPED") throw new Error("BRANCH_TRIPPED");
    if (currentCostMicros > this.config.perCallCeilingMicros) {
      this.state = "TRIPPED";
      return this.result(currentCostMicros, "trip", "ABSOLUTE_CALL_LIMIT");
    }

    const baseline = this.previousCostMicros;
    const isSpike = baseline !== undefined
      && currentCostMicros >= baseline * 4n
      && currentCostMicros - baseline >= this.config.minimumSpikeDeltaMicros;

    if (isSpike) {
      this.consecutiveViolations += 1;
      this.state = this.consecutiveViolations >= 2 ? "TRIPPED" : "ELEVATED";
    } else {
      this.consecutiveViolations = 0;
      this.state = "HEALTHY";
    }
    this.previousCostMicros = currentCostMicros;

    return this.result(
      currentCostMicros,
      this.state === "TRIPPED" ? "trip" : "allow",
      this.state === "TRIPPED" ? "REPEATED_COST_ACCELERATION" : "ALLOW",
      baseline,
    );
  }

  snapshot() {
    return {
      state: this.state,
      consecutiveViolations: this.consecutiveViolations,
      previousCostMicros: this.previousCostMicros,
    };
  }

  assertOpen() {
    if (this.state === "TRIPPED") throw new Error("BRANCH_TRIPPED");
  }

  private result(
    currentCostMicros: bigint,
    decision: "allow" | "trip",
    reason: CircuitReason,
    baselineCostMicros = this.previousCostMicros,
  ): CircuitResult {
    return {
      state: this.state,
      decision,
      reason,
      currentCostMicros,
      baselineCostMicros,
      ratio: baselineCostMicros && baselineCostMicros > 0n
        ? Number(currentCostMicros) / Number(baselineCostMicros)
        : undefined,
      consecutiveViolations: this.consecutiveViolations,
    };
  }
}
