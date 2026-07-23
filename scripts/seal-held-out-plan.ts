import { resolve } from "node:path";
import {
  HELD_OUT_DRAND_CHAIN_HASH,
  HELD_OUT_DRAND_ROUND,
  HELD_OUT_BEACON_URL,
  buildHeldOutPlan,
  parseHeldOutBeaconResponse,
} from "../src/evidence/heldOut.js";
import { writeOnceJsonPair } from "../src/evidence/writeOnce.js";

const PROVIDER = "openrouter";
const MODEL = "nousresearch/hermes-4-405b";
const beaconPath = resolve(`evidence/held-out/beacons/drand-${HELD_OUT_DRAND_ROUND}.json`);
const beaconUrl = HELD_OUT_BEACON_URL;

async function fetchBeacon(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) return response;
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw new Error("HELD_OUT_BEACON_FETCH_FAILED:NETWORK", { cause: error });
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
  }
  throw new Error("HELD_OUT_BEACON_FETCH_FAILED:NETWORK", { cause: lastError });
}

const response = await fetchBeacon(beaconUrl);
if (!response.ok) {
  throw new Error(`HELD_OUT_BEACON_FETCH_FAILED:${response.status}`);
}
const rawBeaconResponse: unknown = await response.json();
const beacon = parseHeldOutBeaconResponse(rawBeaconResponse);
const plan = buildHeldOutPlan(beacon, PROVIDER, MODEL);
const outputPath = resolve(`evidence/held-out/plans/${plan.planFingerprint}.json`);
await writeOnceJsonPair(
  beaconPath,
  {
    schemaVersion: 1,
    evidenceType: "held-out",
    protocolVersion: 1,
    chainHash: HELD_OUT_DRAND_CHAIN_HASH,
    source: beaconUrl,
    response: rawBeaconResponse,
  },
  outputPath,
  plan,
);
console.log(JSON.stringify({
  beaconPath,
  planPath: outputPath,
  planFingerprint: plan.planFingerprint,
  callCount: plan.calls.length,
  cohortCount: plan.cohorts.length,
}, null, 2));
