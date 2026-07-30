import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as runner from "../scripts/held-out-reliability-v2.js";
import * as protocol from "../src/reliability/protocolStore.js";
import { OpenRouterProvider, OpenRouterTransportError } from "../src/providers/openRouter.js";

const apiKey = ["local", "fixture"].join("-");

describe("reliability v2 P0 runtime closure", () => {
  it("enforces known-cost and unresolved-exposure caps at dispatch, accepting equality", () => {
    const disposition = (protocol as Record<string, unknown>)["reliabilityDispatchCapDisposition"] as ((input: { knownCostMicros: bigint; unresolvedExposureMicros: bigint }) => string) | undefined;
    expect(typeof disposition).toBe("function");
    if (!disposition) throw new Error("DISPATCH_CAP_DISPOSITION_MISSING");
    expect(disposition({ knownCostMicros: 3_000_000n, unresolvedExposureMicros: 320_000n })).toBe("allow");
    expect(disposition({ knownCostMicros: 3_000_001n, unresolvedExposureMicros: 0n })).toBe("known_cost_cap_exceeded");
    expect(disposition({ knownCostMicros: 0n, unresolvedExposureMicros: 320_001n })).toBe("unresolved_exposure_cap_exceeded");
  });

  it("treats only bounded-burst ambiguities as a lane-local stop", () => {
    const disposition = (runner as Record<string, unknown>)["boundedBurstFailureDisposition"] as ((states: Array<string | null>) => string) | undefined;
    expect(typeof disposition).toBe("function");
    if (!disposition) throw new Error("BOUNDED_BURST_DISPOSITION_MISSING");
    expect(disposition(["completed_verified", "reconciliation_pending", "completed_verified"])).toBe("hold_lane");
    expect(disposition(["completed_verified", "dispatch_authorized"])).toBe("fail_protocol");
    expect(disposition(["completed_verified", null])).toBe("fail_protocol");
  });

  it("executes a worker entrypoint in a separate operating-system process", async () => {
    const runWorkerProcess = (runner as Record<string, unknown>)["runWorkerProcess"] as ((input: { executable: string; argv: string[]; cwd: string }) => Promise<Record<string, any>>) | undefined;
    expect(typeof runWorkerProcess).toBe("function");
    if (!runWorkerProcess) throw new Error("WORKER_PROCESS_RUNNER_MISSING");
    const directory = await mkdtemp(join(tmpdir(), "fuse-worker-process-"));
    const fixture = join(directory, "worker.mjs");
    await writeFile(fixture, "process.stdout.write(JSON.stringify({ok:true,pid:process.pid,args:process.argv.slice(2)})+'\\n')\n");
    const result = await runWorkerProcess({ executable: process.execPath, argv: [fixture, "sealed-request"], cwd: directory });
    expect(result).toMatchObject({ ok: true, args: ["sealed-request"] });
    expect(result.pid).not.toBe(process.pid);
  });

  it("classifies an interrupted local HTTP response as post-entry ambiguity", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"id":"generation"');
      response.socket?.destroy();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("LOCAL_FAULT_SERVER_FAILED");
    const provider = new OpenRouterProvider({ apiKey, model: "model", baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2_000 });
    let entered = false;
    try {
      await provider.complete({ requestId: "r", childId: "child", model: "model", inputTokens: 1, maxOutputTokens: 1, messages: [{ role: "user", content: "x" }], onDispatchPrimitiveEntered: async () => { entered = true; } });
      throw new Error("EXPECTED_FAULT");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenRouterTransportError);
      expect(error).toMatchObject({ primitiveEntered: true, phase: "http_dispatch" });
      expect(entered).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
