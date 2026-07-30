import { describe, expect, it } from "vitest";
import { executeReliabilityCli } from "../src/evidence/reliabilityCliV2.js";
import * as storeModule from "../src/reliability/protocolStore.js";

const methods = [
  "beginReconciliationLookup",
  "applyAuthoritativeReconciliation",
  "runAndPersistAuthoritativeSettlement",
  "loadAuthoritativeEvidenceInventory",
] as const;

describe("reliability v2 ninth production integration", () => {
  it("exposes production store boundaries for reconciliation, settlement, and evidence", () => {
    const prototype = storeModule.ReliabilityProtocolStore.prototype as unknown as Record<string, unknown>;
    for (const method of methods) expect(typeof prototype[method]).toBe("function");
  });

  it("keeps doctor red with the exact provisioning blocker", async () => {
    await expect(executeReliabilityCli(["doctor", "--json"], {
      operations: { doctor: async () => { throw new Error("SETUP_PROVISIONING_UNAVAILABLE"); } },
    })).resolves.toMatchObject({ ok: false, errorCode: "SETUP_PROVISIONING_UNAVAILABLE", providerCalls: 0, paymentCalls: 0, beaconCalls: 0 });
  });
});
