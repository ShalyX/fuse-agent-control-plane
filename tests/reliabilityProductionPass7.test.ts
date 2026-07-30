import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeReliabilityCli } from "../src/evidence/reliabilityCliV2.js";
import { buildResponseCommitment } from "../src/reliability/commitments.js";
import { performReliabilityReplayHttp } from "../src/reliability/replayHttp.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("reliability v2 seventh production pass", () => {
  it("fails doctor closed while restart-resume durable per-call recovery is unavailable", async () => {
    await expect(executeReliabilityCli(["doctor", "--json"], { now: () => "2026-07-23T00:00:00.000Z" })).resolves.toMatchObject({
      ok: false,
      errorCode: "RESTART_RESUME_RECOVERY_UNAVAILABLE",
      providerCalls: 0,
      paymentCalls: 0,
      beaconCalls: 0,
    });
  });

  it("replays the original sealed HTTP projection with the lane credential and verifies the real response commitment", async () => {
    let observed: { authorization?: string; idempotency?: string; operation?: string; mandate?: string; branch?: string; body?: string } = {};
    const stableResponse={id:"generation-1",object:"chat.completion" as const,model:"nousresearch/hermes-4-405b",choices:[{index:0 as const,finish_reason:"stop" as const,message:{role:"assistant" as const,content:"ok"}}] as const,usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3},fuse:{decision:{id:"decision-1",outcome:"ALLOW" as const,wouldOutcome:"ALLOW" as const,enforced:true as const,reasonCodes:[] as const},workloadScope:{branchId:"branch-1",workloadClass:"reliability.normal"},reservationAtomic:"8",actualCostAtomic:"3"}};
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        observed = {
          authorization: request.headers.authorization,
          idempotency: String(request.headers["idempotency-key"] ?? ""),
          operation: String(request.headers["x-fuse-replay-operation"] ?? ""),
          mandate: String(request.headers["x-fuse-mandate"] ?? ""),
          branch: String(request.headers["x-fuse-branch"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(stableResponse));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server");
    const body = { model: "nousresearch/hermes-4-405b", max_tokens: 8, messages: [{ role: "user", content: "hello" }] };
    const result = await performReliabilityReplayHttp({
      baseUrl: `http://127.0.0.1:${address.port}`,
      endpoint: "/v1/chat/completions",
      laneCredential: "lane-secret",
      requestId: "request-1",
      operationId: "replay-00000000-0000-4000-8000-000000000001",
      mandateId: "mandate-1",
      branchId: "branch-1",
      body,
      expectedCommitment: buildResponseCommitment(stableResponse),
      fetch: vi.fn(fetch),
    });
    expect(result.responseCommitment).toBe(result.expectedCommitment);
    expect(observed).toEqual({
      authorization: "Bearer lane-secret",
      idempotency: "request-1",
      operation: "replay-00000000-0000-4000-8000-000000000001",
      mandate: "mandate-1",
      branch: "branch-1",
      body: JSON.stringify(body),
    });
  });

  it("bounds replay responses to one MiB", async () => {
    const fetcher = vi.fn(async () => new Response("x".repeat(1_048_577), { status: 200 }));
    await expect(performReliabilityReplayHttp({
      baseUrl: "http://127.0.0.1", endpoint: "/v1/chat/completions", laneCredential: "lane-secret",
      requestId: "request-1", operationId: "replay-00000000-0000-4000-8000-000000000001", mandateId: "mandate-1", branchId: "branch-1", body: {}, expectedCommitment: "sha256:" + "0".repeat(64), fetch: fetcher,
    })).rejects.toThrow("REPLAY_RESPONSE_OVERSIZED");
  });
});
