import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as runtime from "../src/runtime.js";

const { createRuntimeApp, reliabilityProtocolEnabledFromEnv } = runtime;

const databaseUrl = "postgres://localhost:5432/fuse";

it("keeps the optional held-out reliability protocol disabled unless explicitly enabled", () => {
  expect(reliabilityProtocolEnabledFromEnv({})).toBe(false);
  expect(reliabilityProtocolEnabledFromEnv({ FUSE_RELIABILITY_PROTOCOL_ENABLED: "false" })).toBe(false);
  expect(reliabilityProtocolEnabledFromEnv({ FUSE_RELIABILITY_PROTOCOL_ENABLED: "true" })).toBe(true);
  expect(() => reliabilityProtocolEnabledFromEnv({ FUSE_RELIABILITY_PROTOCOL_ENABLED: "yes" }))
    .toThrow("FUSE_RELIABILITY_PROTOCOL_ENABLED_INVALID");
});

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

it("rejects executable payment configuration in the control-mode runtime", () => {
  const base = {
    DATABASE_URL: databaseUrl,
    FUSE_PROVIDER_MODE: "tenant",
    FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID: "v1",
    FUSE_PROVIDER_CREDENTIAL_KEY_V1: Buffer.alloc(32, 8).toString("base64"),
  };
  expect(() => createRuntimeApp({
    ...base,
    FUSE_PAYMENT_NETWORK: "eip155:8453",
  })).toThrow("CONTROL_MODE_PAYMENT_CONFIGURATION_FORBIDDEN:FUSE_PAYMENT_NETWORK");
});

it("keeps the shipped control-plane environment template free of executable payment configuration", () => {
  const template = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const name of ["FUSE_PAYER_ADDRESS", "FUSE_SELLER_ADDRESS", "FUSE_PAYMENT_NETWORK", "FUSE_PAYMENT_FACILITATOR_URL"]) {
    expect(template).not.toMatch(new RegExp(`^${name}=\\S+`, "m"));
  }
  for (const name of [
    "FUSE_BETA_INVITE_TOKEN_HASHES",
    "FUSE_BETA_MAX_ACTIVE_WORKSPACES",
    "FUSE_BETA_ACTIVE_WORKSPACE_IDS",
  ]) {
    expect(template).toMatch(new RegExp(`^${name}=`, "m"));
  }
  expect(template).toContain("sha256sum");
});

it("does not infer operational durability from database configuration alone", () => {
  const readFlags = (runtime as unknown as {
    operationalReadinessFlagsFromEnv(env: NodeJS.ProcessEnv): {
      controlMode: boolean;
      settlementDisabled: boolean;
      durableInviteGate: boolean;
      durableAdminRateLimit: boolean;
      sourceCredentialRevocationEnforced: boolean;
    };
  }).operationalReadinessFlagsFromEnv;
  expect(readFlags({})).toEqual({
    controlMode: true,
    settlementDisabled: true,
    durableInviteGate: false,
    durableAdminRateLimit: false,
    sourceCredentialRevocationEnforced: false,
  });
  expect(readFlags({
    DATABASE_URL_UNPOOLED: databaseUrl,
    FUSE_BETA_INVITE_TOKEN_HASHES: "a".repeat(64),
  })).toEqual({
    controlMode: true,
    settlementDisabled: true,
    durableInviteGate: true,
    durableAdminRateLimit: true,
    sourceCredentialRevocationEnforced: true,
  });
});
