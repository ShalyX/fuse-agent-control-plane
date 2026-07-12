import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import solc from "solc";

function compile() {
  const source = readFileSync(new URL("../contracts/FuseSpendMandate.sol", import.meta.url), "utf8");
  const input = {
    language: "Solidity",
    sources: { "FuseSpendMandate.sol": { content: source } },
    settings: {
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  return JSON.parse(solc.compile(JSON.stringify(input)));
}

describe("FuseSpendMandate", () => {
  it("compiles without Solidity errors and exposes only open/close lifecycle methods", () => {
    const output = compile();
    const errors = (output.errors ?? []).filter((entry: { severity: string }) => entry.severity === "error");
    expect(errors).toEqual([]);

    const artifact = output.contracts["FuseSpendMandate.sol"].FuseSpendMandate;
    expect(artifact.evm.bytecode.object.length).toBeGreaterThan(0);
    const functions = artifact.abi
      .filter((entry: { type: string }) => entry.type === "function")
      .map((entry: { name: string }) => entry.name)
      .sort();
    expect(functions).toEqual(["closeMandate", "mandates", "openMandate"]);
    expect(functions).not.toContain("recordSettlement");
  });

  it("includes the cap, controller, final total, and receipt hash checks", () => {
    const source = readFileSync(new URL("../contracts/FuseSpendMandate.sol", import.meta.url), "utf8");
    expect(source).toContain("msg.sender != mandate.controller");
    expect(source).toContain("totalPaidAtomic > mandate.maximumSpendAtomic");
    expect(source).toContain("receiptHash == bytes32(0)");
    expect(source).toContain("mandate.closedAt != 0");
  });
});
