import { expect, it } from "vitest";
import { createRuntimeApp } from "../src/runtime.js";

const databaseUrl = "postgres://localhost:5432/fuse";

it("creates the runtime with OpenRouter without requiring an Anthropic key", () => {
  expect(() => createRuntimeApp({
    FUSE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "openrouter-key",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
    DATABASE_URL: databaseUrl,
  })).not.toThrow();
});

it("fails closed instead of accepting signer secrets in the control-plane runtime", () => {
  expect(() => createRuntimeApp({
    FUSE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "openrouter-key",
    DATABASE_URL: databaseUrl,
    CIRCLE_API_KEY: "must-not-be-here",
  })).toThrow("CONTROL_PLANE_SIGNER_SECRET_FORBIDDEN:CIRCLE_API_KEY");
});

it("fails closed instead of exposing paid OpenRouter without the controlled database path", () => {
  expect(() => createRuntimeApp({
    FUSE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "openrouter-key",
  })).toThrow("DATABASE_URL is required for OpenRouter controlled inference");
});
