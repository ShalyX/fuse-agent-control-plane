import { expect, it } from "vitest";
import { ProviderAdministration } from "../src/providers/providerAdministration.js";

const adminPrincipal = {
  principalType: "service_account" as const,
  principalId: "admin-1",
  organizationId: "org-1",
  credentialId: "credential-1",
  capabilities: ["providers:read", "providers:write"] as const,
  role: "admin" as const,
};

const configureInput = {
  configId: "primary", provider: "openrouter" as const, model: "anthropic/claude-sonnet-4.6",
  apiKey: "«reda...…»", inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00", requestId: "request-1",
};

it("derives provider configuration tenant and actor from the admin principal", async () => {
  const calls: unknown[] = [];
  const admin = new ProviderAdministration({
    async configure(input) { calls.push(input); return { ...input, credentialVersion: 7 } as never; },
    async markVerificationStatus(input) { calls.push(input); },
    async list(organizationId) { calls.push({ organizationId }); return []; },
  }, () => "2026-07-19T16:00:00.000Z", async () => undefined);
  await admin.configure(adminPrincipal, configureInput);
  await admin.list(adminPrincipal);
  expect(calls).toEqual([{
    id: "primary", organizationId: "org-1", provider: "openrouter", model: "anthropic/claude-sonnet-4.6",
    apiKey: configureInput.apiKey, inputUsdPerMillion: "3.00", outputUsdPerMillion: "15.00",
    actorId: "service_account:admin-1", causationId: "request-1", occurredAt: "2026-07-19T16:00:00.000Z",
    verificationStatus: "pending",
  }, {
    organizationId: "org-1", id: "primary", status: "verified", occurredAt: "2026-07-19T16:00:00.000Z",
    expectedCredentialVersion: 7,
  }, { organizationId: "org-1" }]);
});

it("rejects Anthropic tenant configuration instead of reporting it verified", async () => {
  let persisted = false;
  const admin = new ProviderAdministration({
    async configure(input) { persisted = true; return input as never; },
    async list() { return []; },
  }, undefined, async () => undefined);

  await expect(admin.configure(adminPrincipal, {
    ...configureInput, provider: "anthropic", model: "claude-sonnet-4-6",
  })).rejects.toThrow("PROVIDER_VERIFICATION_UNSUPPORTED");
  expect(persisted).toBe(false);
});

it("rejects non-admin provider configuration even with the capability", async () => {
  const admin = new ProviderAdministration({ async configure() { throw new Error("unexpected"); }, async list() { return []; } });
  await expect(admin.configure({ ...adminPrincipal, role: "operator" }, configureInput)).rejects.toThrow("SERVICE_ACCOUNT_ADMIN_REQUIRED");
});

it("verifies OpenRouter credentials before exposing them as usable", async () => {
  const calls: string[] = [];
  const admin = new ProviderAdministration({
    async configure(input) { calls.push(`persist:${input.provider}:${input.verificationStatus}`); return input as never; },
    async markVerificationStatus(input) { calls.push(`status:${input.status}`); },
    async list() { return []; },
  }, () => "2026-07-19T16:00:00.000Z", async (input) => { calls.push(`verify:${input.provider}:${input.model}`); });
  await admin.configure(adminPrincipal, { ...configureInput, provider: "openrouter", model: "anthropic/claude-sonnet-4.6" });
  expect(calls).toEqual(["persist:openrouter:pending", "verify:openrouter:anthropic/claude-sonnet-4.6", "status:verified"]);
});

it("persists an invalid OpenRouter status when verification fails", async () => {
  const calls: string[] = [];
  const admin = new ProviderAdministration({
    async configure(input) { calls.push(`persist:${input.verificationStatus}`); return input as never; },
    async markVerificationStatus(input) { calls.push(`status:${input.status}`); },
    async list() { return []; },
  }, undefined, async () => { throw new Error("OPENROUTER_CREDENTIAL_INVALID"); });
  await expect(admin.configure(adminPrincipal, { ...configureInput, provider: "openrouter", model: "anthropic/claude-sonnet-4.6" })).rejects.toThrow("OPENROUTER_CREDENTIAL_INVALID");
  expect(calls).toEqual(["persist:pending", "status:invalid"]);
});

it("retries an invalid OpenRouter configuration through pending to verified", async () => {
  const calls: string[] = [];
  const summary = { id: "primary", organizationId: "org-1", provider: "openrouter" as const, model: "anthropic/claude-sonnet-4.6", inputUsdPerMillion: "3", outputUsdPerMillion: "15", credentialVersion: 1, status: "active" as const, updatedAt: "2026-08-16T00:00:00.000Z" };
  const admin = new ProviderAdministration({
    async configure() { return summary; },
    async beginVerificationRetry() { return { record: { ...summary, apiKey: "«redacted:integration-test-provider-token-123456»", requireProviderCost: true, requireProviderModelMatch: true, verificationStatus: "invalid" as const }, claimToken: "claim-1" }; },
    async finishVerificationRetry(input) { calls.push(`${input.status}:${input.expectedCredentialVersion}:${input.claimToken}`); },
    async list() { return [summary]; },
  }, () => "2026-08-16T00:01:00.000Z", async (input) => { calls.push(`verify:${input.apiKey}`); });
  await expect(admin.retry(adminPrincipal, "primary", "retry-1")).resolves.toEqual(summary);
  expect(calls[0]).toMatch(/^verify:.+$/);
  expect(calls.slice(1)).toEqual(["verified:1:claim-1"]);
});

it("replays a completed provider retry without probing again", async () => {
  const summary = { id: "primary", organizationId: "org-1", provider: "openrouter" as const, model: "anthropic/claude-sonnet-4.6", inputUsdPerMillion: "3", outputUsdPerMillion: "15", credentialVersion: 1, status: "active" as const, updatedAt: "2026-08-16T00:00:00.000Z" };
  let probes = 0;
  const admin = new ProviderAdministration({
    async configure() { return summary; },
    async beginVerificationRetry() { return { replay: { status: "verified" as const, summary } }; },
    async finishVerificationRetry() { throw new Error("MUST_NOT_FINISH_REPLAY"); },
    async list() { return [summary]; },
  }, undefined, async () => { probes += 1; });
  await expect(admin.retry(adminPrincipal, "primary", "retry-1")).resolves.toEqual(summary);
  expect(probes).toBe(0);
});
