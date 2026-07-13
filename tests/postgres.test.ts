import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { FuseService, type InferenceProvider } from "../src/core/service.js";
import { PostgresStateStore, createPostgresPool } from "../src/persistence/postgres.js";

class NoopProvider implements InferenceProvider {
  async complete() {
    return { id: "noop", content: "noop", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

describe("PostgresStateStore", () => {
  it("creates a serverless-safe shared pool configuration", async () => {
    const pool = createPostgresPool("postgres://user:pass@localhost:5432/fuse");
    expect(pool.options.max).toBe(5);
    expect(pool.options.ssl).toBe(false);
    await pool.end();
  });

  it("persists bigint service state across store instances", async () => {
    const memoryDb = newDb({ noAstCoverageCheck: true });
    const adapter = memoryDb.adapters.createPg();
    const pool = new adapter.Pool() as unknown as Pool;
    const provider = new NoopProvider();
    const initial = () => FuseService.createDemo(provider).exportState();
    const first = new PostgresStateStore(pool);

    await first.mutate(initial, async (state) => {
      const service = FuseService.fromState(provider, state);
      await service.prepareCompletion({
        requestId: "persisted-request",
        childId: "scout",
        model: "test",
        inputTokens: 1,
        maxOutputTokens: 1,
        messages: [{ role: "user", content: "test" }],
      });
      return { state: service.exportState(), result: undefined };
    });

    const second = new PostgresStateStore(pool);
    const restored = FuseService.fromState(provider, await second.read(initial));
    const quote = await restored.prepareCompletion({
      requestId: "persisted-request",
      childId: "scout",
      model: "test",
      inputTokens: 1,
      maxOutputTokens: 1,
      messages: [{ role: "user", content: "test" }],
    });
    expect(quote.exactCostMicros).toBe(18n);
  });
});
