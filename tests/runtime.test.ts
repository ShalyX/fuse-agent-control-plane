import { expect, it } from "vitest";
import { createRuntimeApp } from "../src/runtime.js";

const databaseUrl = "postgres://localhost:5432/fuse";

it("creates a tenant-provider runtime without a deployment-wide provider credential", () => {
  expect(() => createRuntimeApp({
    DATABASE_URL: databaseUrl,
    FUSE_PROVIDER_MODE: "tenant",
    FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID: "v1",
    FUSE_PROVIDER_CREDENTIAL_KEY_V1: Buffer.alloc(32, 8).toString("base64"),
  })).not.toThrow();
});

it("requires an explicit boolean workload-shadow rollout flag", () => {
  const base = {
    DATABASE_URL: databaseUrl,
    FUSE_PROVIDER_MODE: "tenant",
    FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID: "v1",
    FUSE_PROVIDER_CREDENTIAL_KEY_V1: Buffer.alloc(32, 8).toString("base64"),
  };
  expect(() => createRuntimeApp({ ...base, FUSE_WORKLOAD_SHADOW_ENABLED: "yes" }))
    .toThrow("FUSE_WORKLOAD_SHADOW_ENABLED_INVALID");
  expect(() => createRuntimeApp({ ...base, FUSE_WORKLOAD_SHADOW_ENABLED: "true" }))
    .not.toThrow();
});

it("requires an unpooled database connection for schema bootstrap", () => {
  const base = {
    FUSE_PROVIDER_MODE: "tenant",
    FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID: "v1",
    FUSE_PROVIDER_CREDENTIAL_KEY_V1: Buffer.alloc(32, 7).toString("base64"),
  };
  expect(() => createRuntimeApp({
    ...base, DATABASE_URL: "postgres://u:p@ep-example-pooler.us-east-2.aws.neon.tech/db",
  })).toThrow("DATABASE_URL_UNPOOLED_REQUIRED");
  expect(() => createRuntimeApp({
    ...base,
    DATABASE_URL: "postgres://u:p@ep-example-pooler.us-east-2.aws.neon.tech/db",
    DATABASE_URL_UNPOOLED: databaseUrl,
  })).not.toThrow();
});

it("fails closed in production when tenant provider mode is not configured", () => {
  expect(() => createRuntimeApp({
    NODE_ENV: "production",
    DATABASE_URL: databaseUrl,
    ANTHROPIC_API_KEY: "legacy-key",
  })).toThrow("PROVIDER_CREDENTIAL_ACTIVE_KEY_ID_INVALID");
});

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
