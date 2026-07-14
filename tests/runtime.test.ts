import { expect, it } from "vitest";
import { createRuntimeApp } from "../src/runtime.js";

it("creates the runtime with OpenRouter without requiring an Anthropic key", () => {
  expect(() => createRuntimeApp({
    FUSE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "openrouter-key",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
    DATABASE_URL: "postgres://user:pass@localhost:5432/fuse",
  })).not.toThrow();
});

it("fails closed instead of exposing paid OpenRouter without the controlled database path", () => {
  expect(() => createRuntimeApp({
    FUSE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "openrouter-key",
  })).toThrow("DATABASE_URL is required for OpenRouter controlled inference");
});
