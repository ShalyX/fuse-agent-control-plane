import { describe, expect, it } from "vitest";
import { CustomerOnboardingService } from "../src/product/customerOnboarding.js";
import type { AdministrativePrincipal } from "../src/identity/credentialAdministration.js";
import { MemoryWorkspaceOnboardingStore } from "../src/product/workspaceOnboardingStore.js";

const adminPrincipal: AdministrativePrincipal = {
  principalType: "service_account",
  principalId: "service-admin",
  organizationId: "workspace-test",
  credentialId: "credential-admin",
  capabilities: [
    "agents:write", "credentials:issue", "providers:write", "policies:write", "mandates:admin",
  ],
  role: "admin",
};

describe("CustomerOnboardingService", () => {
  it("replays a durably committed recovery delivery without rotating again", async () => {
    let rotations = 0;
    const replay = {
      workspaceId: "workspace-replay", agentId: "agent-replay",
      credential: { credentialId: "credential-replay", token: "fuse_sk_replayed_token", tokenPrefix: "fuse_sk_repla", capabilities: ["inference:invoke" as const], expiresAt: null },
    };
    const service = new CustomerOnboardingService({
      onboardingStore: {
        tryReserveCapacity: async () => true,
        claim: async () => ({ status: "new" as const }), heartbeat: async () => undefined,
        complete: async () => undefined, rollback: async () => undefined,
        getRecovery: async () => ({ deliveryResult: replay }),
        sealRecoveryResult: () => { throw new Error("SHOULD_NOT_SEAL"); },
        listCompletedWorkspaceIds: async () => [],
      },
      identityStore: {
        bootstrapServiceAccount: async () => undefined,
        rotateAgentCredentialWithRecovery: async () => { rotations += 1; return { agentId: "agent-replay", previousCredentialId: "old" }; },
      },
      credentialAdministration: { registerAgent: async () => undefined, issueAgentCredential: async () => ({}) as never, revokeAgentCredential: async () => undefined },
      providerConnectionService: { connect: async () => ({}) as never },
      policyPublishingService: { publish: async () => undefined },
      mandateManagementService: { createMandate: async () => undefined, assignAgent: async () => undefined, transitionMandate: async () => undefined },
    });

    await expect(service.recoverWorkspaceCredential({ workspaceId: "workspace-replay", recoveryCode: "fuse_rc_abcdefghijklmnop", idempotencyKey: "recovery-replay-1" }))
      .resolves.toEqual(replay);
    expect(rotations).toBe(0);
  });

  it("supplies a bounded stale-operation lease to the durable claim", async () => {
    const ids = ["workspace-lease", "service-lease", "service-key-lease", "agent-lease", "agent-key-lease", "policy-lease", "mandate-lease", "provider-lease"];
    let heartbeats = 0;
    const service = new CustomerOnboardingService({
      now: () => "2026-08-23T11:00:00.000Z",
      ids: () => ids.shift()!,
      onboardingStore: {
        claim: async (input) => {
          expect(input.now).toEqual(new Date("2026-08-23T11:00:00.000Z"));
          expect(input.staleAfterMs).toBe(15 * 60_000);
          return { status: "new" as const };
        },
        heartbeat: async (idempotencyKey, workspaceId, now) => {
          expect(idempotencyKey).toBe("lease-onboarding");
          expect(workspaceId).toBe("workspace-lease");
          expect(now).toEqual(new Date("2026-08-23T11:00:00.000Z"));
          heartbeats += 1;
        },
        complete: async () => undefined,
        rollback: async () => undefined,
        getRecovery: async () => null,
        listCompletedWorkspaceIds: async () => [],
      },
      identityStore: {
        bootstrapServiceAccount: async () => undefined,
        rotateAgentCredentialWithRecovery: async () => ({ agentId: "agent-lease", previousCredentialId: "agent-key-lease" }),
      },
      credentialAdministration: {
        registerAgent: async () => undefined,
        issueAgentCredential: async (_principal, input) => ({
          credentialId: input.credentialId,
          token: "fuse_sk_lease_token",
          tokenPrefix: "fuse_sk_lease_",
          capabilities: [...input.capabilities],
          expiresAt: input.expiresAt ?? null,
        }),
        revokeAgentCredential: async () => undefined,
      },
      providerConnectionService: { connect: async () => ({}) as never },
      policyPublishingService: { publish: async () => undefined },
      mandateManagementService: {
        createMandate: async () => undefined,
        assignAgent: async () => undefined,
        transitionMandate: async () => undefined,
      },
    });

    await expect(service.createWorkspace({
      name: "Lease workspace",
      agentName: "lease-agent",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "provi...et",
      inputUsdPerMillion: "3.00",
      outputUsdPerMillion: "15.00",
      maximumSpendAtomic: "100000",
      idempotencyKey: "lease-onboarding",
    })).resolves.toMatchObject({ workspaceId: "workspace-lease" });
    expect(heartbeats).toBe(8);
  });

  it("creates a ready workspace with provider, agent credential, policy, and active mandate", async () => {
    const calls: string[] = [];
    let recoveryConsumed = false;
    const onboardingStore = new MemoryWorkspaceOnboardingStore();
    const service = new CustomerOnboardingService({
      now: () => "2026-08-12T02:00:00.000Z",
      onboardingStore,
      ids: (() => {
        const values = [
          "workspace-1", "service-1", "credential-1", "agent-1", "agent-key-1", "policy-1",
          "mandate-1", "provider-config-1", "recovered-key-1", "recovery-request-1",
          "recovered-key-2", "recovery-request-2",
        ];
        return () => values.shift()!;
      })(),
      identityStore: {
        bootstrapServiceAccount: async (input) => {
          expect(input.organizationId).toBe("workspace-1");
          expect(input.credential.serviceAccountId).toBe("service-1");
          calls.push("workspace");
        },
        rotateAgentCredentialWithRecovery: async (input) => {
          if (recoveryConsumed) throw new Error("CREDENTIAL_RECOVERY_INVALID");
          recoveryConsumed = true;
          expect(input.workspaceId).toBe("workspace-1");
          expect(input.replacement.agentId).toBe("agent-1");
          calls.push("atomic-recovery");
          return { agentId: "agent-1", previousCredentialId: "agent-key-1" };
        },
      },
      credentialAdministration: {
        registerAgent: async (_principal, input) => {
          expect(input.agentId).toBe("agent-1");
          calls.push("agent");
        },
        issueAgentCredential: async (_principal, input) => {
          expect(input.agentId).toBe("agent-1");
          calls.push("credential");
          return {
            credentialId: input.credentialId,
            token: "fuse_sk_agent_token",
            tokenPrefix: "fuse_sk_agent_",
            capabilities: [...input.capabilities],
            expiresAt: input.expiresAt ?? null,
          };
        },
        revokeAgentCredential: async (_principal, credentialId, _requestId) => {
          expect(credentialId).toBe("agent-key-1");
          calls.push("revoke");
        },
      },
      providerConnectionService: {
        connect: async (_principal, input) => {
          expect(input.provider).toBe("anthropic");
          expect(input.apiKey).toBe("provider-secret");
          calls.push("provider");
          return { configId: input.configId, provider: input.provider, model: input.model } as never;
        },
      },
      policyPublishingService: {
        publish: async (_principal, input) => {
          expect(input.mode).toBe("enforce");
          expect(input.allowedModels).toEqual(["claude-sonnet-4-6"]);
          calls.push("policy");
        },
      },
      mandateManagementService: {
        createMandate: async (_principal, input) => {
          expect(input.maximumSpendAtomic).toBe("100000");
          calls.push("mandate");
        },
        assignAgent: async (_principal, input) => {
          expect(input.agentId).toBe("agent-1");
          calls.push("assignment");
        },
        transitionMandate: async (_principal, input) => {
          expect(input.to).toBe("active");
          calls.push("activation");
        },
      },
    });

    const result = await service.createWorkspace({
      name: "Acme Agents",
      agentName: "researcher",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "provider-secret",
      inputUsdPerMillion: "3.00",
      outputUsdPerMillion: "15.00",
      maximumSpendAtomic: "100000", idempotencyKey: "onboard-test-1"
    });

    expect(result).toMatchObject({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      mandateId: "mandate-1",
      credential: { token: "fuse_sk_agent_token" },
    });
    expect(calls).toEqual(["workspace", "agent", "credential", "provider", "policy", "mandate", "assignment", "activation"]);

    const recovered = await service.recoverWorkspaceCredential({ workspaceId: result.workspaceId, recoveryCode: result.recoveryCode, idempotencyKey: "recovery-request-1" });
    expect(recovered.credential.token).toMatch(/^fuse_sk_/);
    expect(calls.at(-1)).toBe("atomic-recovery");
    await expect(service.recoverWorkspaceCredential({ workspaceId: result.workspaceId, recoveryCode: result.recoveryCode, idempotencyKey: "recovery-request-2" }))
      .rejects.toThrow("CREDENTIAL_RECOVERY_INVALID");
  });
});
