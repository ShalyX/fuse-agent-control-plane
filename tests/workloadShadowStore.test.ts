import { DataType, newDb } from "pg-mem";
import { expect, it } from "vitest";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { PolicyStore } from "../src/persistence/policyStore.js";

const context = {
  actorId: "service_account:admin-1",
  causationId: "request:workload-setup",
  occurredAt: "2026-07-20T00:00:00.000Z",
};

function providerResult(id: string) {
  return { id, content: "ok", usage: { inputTokens: 20, outputTokens: 10 } };
}

it("binds workload classes to immutable branches and enforces the class envelope at admission", async () => {
  const db = newDb({ noAstCoverageCheck: true });
  db.public.registerFunction({
    name: "clock_timestamp", returns: DataType.timestamptz,
    implementation: () => new Date(), impure: true,
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const identity = new IdentityStore(pool);
  await identity.createOrganization({ id: "org-1", name: "Acme", ...context });
  for (const [id, name] of [["root-agent", "Root"], ["scout", "Scout"], ["analyst", "Analyst"]]) {
    await identity.registerAgent({ id, organizationId: "org-1", name, ...context });
  }
  const policies = new PolicyStore(pool, { supportsSavepoints: false });
  await policies.publishPolicy({
    id: "policy-workload", organizationId: "org-1", version: 1, mode: "enforce",
    allowedProviders: ["anthropic"], allowedModels: ["claude-sonnet-4-6"],
    requiredCapability: "inference:invoke",
    limits: {
      maxPerCallAtomic: 10_000n, maxHourlyAtomic: 100_000n, maxDailyAtomic: 500_000n,
      maxRequestsPerMinute: 100, maxInputTokens: 20_000, maxOutputTokens: 4_000,
    },
    workloadClasses: [{
      id: "lookup", maxCostPerCallAtomic: 2_000n, maxInvocationsPerBranch: 2,
      aggregateBudgetAtomic: 3_000n, minimumInputTokens: 10,
      shadow: {
        classPriorWindowSpendAtomic: 1_000n, windowSeconds: 900,
        targetMinimumObservations: 3, siblingMinimumForScoring: 2,
        siblingMinimumForIntervention: 3, confidenceConstant: 5,
        divergenceThresholdBps: 30_000,
      },
    }, {
      id: "plain", maxCostPerCallAtomic: 2_000n, maxInvocationsPerBranch: 2,
      aggregateBudgetAtomic: 3_000n, minimumInputTokens: 10, shadow: null,
    }],
    createdAt: context.occurredAt,
  }, context);
  await policies.createMandate({
    id: "mandate-1", organizationId: "org-1", name: "Research",
    assetId: "usd-micros", maximumSpendAtomic: 100_000n, state: "draft",
    policyId: "policy-workload", policyVersion: 1, expiresAt: null, ...context,
  });
  for (const agentId of ["root-agent", "scout", "analyst"]) {
    await policies.assignAgent({ organizationId: "org-1", mandateId: "mandate-1", agentId, ...context });
  }
  const root = await policies.createBranch({
    id: "branch-root", organizationId: "org-1", mandateId: "mandate-1",
    parentBranchId: null, agentId: "root-agent", allowedWorkloadClasses: ["lookup", "plain"],
    maximumSpendAtomic: 3_000n, expiresAt: "2026-08-01T00:00:00.000Z", ...context,
  });
  await expect(policies.createBranch({
    id: "branch-unbounded-child", organizationId: "org-1", mandateId: "mandate-1",
    parentBranchId: "branch-root", agentId: "scout", allowedWorkloadClasses: ["lookup"],
    maximumSpendAtomic: 1_000n, expiresAt: null,
    ...context, causationId: "request:unbounded-child",
  })).rejects.toThrow("MANDATE_BRANCH_PARENT_EXPIRY_EXCEEDED");
  const scout = await policies.createBranch({
    id: "branch-scout", organizationId: "org-1", mandateId: "mandate-1",
    parentBranchId: "branch-root", agentId: "scout", allowedWorkloadClasses: ["lookup", "plain"],
    maximumSpendAtomic: 3_000n, expiresAt: "2026-08-01T00:00:00.000Z",
    ...context, causationId: "request:branch-scout",
  });
  await expect(policies.createBranch({
    id: "branch-overallocated", organizationId: "org-1", mandateId: "mandate-1",
    parentBranchId: "branch-root", agentId: "analyst", allowedWorkloadClasses: ["lookup"],
    maximumSpendAtomic: 1n, expiresAt: "2026-08-01T00:00:00.000Z",
    ...context, causationId: "request:overallocated-child",
  })).rejects.toThrow("MANDATE_BRANCH_PARENT_BUDGET_EXCEEDED");

  expect(root.authoritySource).toBe("fuse_control_plane");
  expect(scout).toMatchObject({
    id: "branch-scout", parentBranchId: "branch-root", agentId: "scout",
    policyId: "policy-workload", policyVersion: 1,
    allowedWorkloadClasses: ["lookup", "plain"], authoritySource: "fuse_control_plane",
  });
  expect(scout.delegationHash).toMatch(/^[a-f0-9]{64}$/);
  expect(await policies.getBranch("org-1", "mandate-1", "branch-scout")).toEqual(scout);

  await policies.transitionMandateState("org-1", "mandate-1", "active", context);
  const parentReservedForChild = await policies.admitInference({
    requestId: "request-parent-reserved", requestFingerprint: "d".repeat(64),
    organizationId: "org-1", mandateId: "mandate-1", agentId: "root-agent",
    agentCapabilities: ["inference:invoke"], branchId: "branch-root", workloadClass: "lookup",
    provider: "anthropic", model: "claude-sonnet-4-6", estimatedCostAtomic: 100n,
    inputTokens: 20, maxOutputTokens: 10, decidedAt: "2026-07-20T00:00:30.000Z",
  });
  expect(parentReservedForChild).toMatchObject({
    status: "denied", decision: { result: { reasonCodes: ["BRANCH_BUDGET_EXCEEDED"] } },
  });
  const allowed = await policies.admitInference({
    requestId: "request-allowed", requestFingerprint: "a".repeat(64), organizationId: "org-1",
    mandateId: "mandate-1", agentId: "scout", agentCapabilities: ["inference:invoke"],
    branchId: "branch-scout", workloadClass: "lookup",
    provider: "anthropic", model: "claude-sonnet-4-6", estimatedCostAtomic: 1_500n,
    inputTokens: 20, maxOutputTokens: 10, decidedAt: "2026-07-20T00:01:00.000Z",
  });
  expect(allowed.status).toBe("execute");
  if (allowed.status === "execute") {
    expect(allowed.decision.input.exposure).toEqual({
      branchLimitAtomic: 3_000n,
      branchCommittedBeforeAtomic: 0n,
      requestReservationAtomic: 1_500n,
      maximumExposureAtomic: 3_000n,
      remainingAuthorityAtomic: 1_500n,
    });
  }
  const plain = await policies.admitInference({
    requestId: "request-plain", requestFingerprint: "e".repeat(64), organizationId: "org-1",
    mandateId: "mandate-1", agentId: "scout", agentCapabilities: ["inference:invoke"],
    branchId: "branch-scout", workloadClass: "plain", provider: "anthropic",
    model: "claude-sonnet-4-6", estimatedCostAtomic: 100n, inputTokens: 20,
    maxOutputTokens: 10, decidedAt: "2026-07-20T00:01:30.000Z",
  });
  expect(plain.status).toBe("execute");
  if (plain.status === "execute") {
    expect((await policies.completeInference({
      organizationId: "org-1", requestId: "request-plain", actualCostAtomic: 100n,
      response: { id: "plain", content: "ok", usage: { inputTokens: 20, outputTokens: 10 } },
      completedAt: "2026-07-20T00:01:31.000Z",
    })).status).toBe("completed");
  }
  expect((await pool.query(
    "SELECT shadow_order_state FROM inference_executions WHERE organization_id = 'org-1' AND request_id = 'request-plain'",
  )).rows[0]?.shadow_order_state).toBe("not_applicable");
  expect((await pool.query(
    "SELECT 1 FROM shadow_evaluation_queue WHERE organization_id = 'org-1' AND request_id = 'request-plain'",
  )).rowCount).toBe(0);

  const denied = await policies.admitInference({
    requestId: "request-denied", requestFingerprint: "b".repeat(64), organizationId: "org-1",
    mandateId: "mandate-1", agentId: "scout", agentCapabilities: ["inference:invoke"],
    branchId: "branch-scout", workloadClass: "lookup",
    provider: "anthropic", model: "claude-sonnet-4-6", estimatedCostAtomic: 2_500n,
    inputTokens: 20, maxOutputTokens: 10, decidedAt: "2026-07-20T00:02:00.000Z",
  });
  expect(denied).toMatchObject({
    status: "denied",
    decision: { result: { reasonCodes: [
      "BRANCH_BUDGET_EXCEEDED",
      "WORKLOAD_CLASS_PER_CALL_LIMIT_EXCEEDED",
      "WORKLOAD_CLASS_BUDGET_EXCEEDED",
    ] } },
  });
  await pool.query(
    "UPDATE mandate_branches SET maximum_spend_atomic = 999999 WHERE organization_id = 'org-1' AND branch_id = 'branch-scout'",
  );
  await expect(policies.getBranch("org-1", "mandate-1", "branch-scout"))
    .rejects.toThrow("MANDATE_BRANCH_DELEGATION_HASH_INVALID");
  await expect(policies.admitInference({
    requestId: "request-tampered", requestFingerprint: "c".repeat(64), organizationId: "org-1",
    mandateId: "mandate-1", agentId: "scout", agentCapabilities: ["inference:invoke"],
    branchId: "branch-scout", workloadClass: "lookup", provider: "anthropic",
    model: "claude-sonnet-4-6", estimatedCostAtomic: 100n, inputTokens: 20,
    maxOutputTokens: 10, decidedAt: "2026-07-20T00:03:00.000Z",
  })).rejects.toThrow("MANDATE_BRANCH_DELEGATION_HASH_INVALID");
  await pool.end();
});

it("persists a scored sibling-divergence evaluation after the target has enough observations", async () => {
  const db = newDb({ noAstCoverageCheck: true });
  db.public.registerFunction({
    name: "clock_timestamp", returns: DataType.timestamptz,
    implementation: () => new Date(), impure: true,
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const identity = new IdentityStore(pool);
  await identity.createOrganization({ id: "org-shadow", name: "Shadow", ...context });
  const agents = ["root", "target", "sib-a", "sib-b", "sib-c", "sib-other-model"];
  for (const id of agents) {
    await identity.registerAgent({ id, organizationId: "org-shadow", name: id, ...context });
  }
  const policies = new PolicyStore(pool, { supportsSavepoints: false });
  await policies.publishPolicy({
    id: "policy-shadow", organizationId: "org-shadow", version: 1, mode: "enforce",
    allowedProviders: ["anthropic"],
    allowedModels: ["claude-sonnet-4-6", "claude-haiku-3-5"],
    requiredCapability: "inference:invoke",
    limits: {
      maxPerCallAtomic: 2_000n, maxHourlyAtomic: 100_000n, maxDailyAtomic: 500_000n,
      maxRequestsPerMinute: 100, maxInputTokens: 20_000, maxOutputTokens: 4_000,
    },
    workloadClasses: [{
      id: "lookup", maxCostPerCallAtomic: 1_000n, maxInvocationsPerBranch: 10,
      aggregateBudgetAtomic: 10_000n, minimumInputTokens: 1,
      shadow: {
        classPriorWindowSpendAtomic: 300n, windowSeconds: 900,
        targetMinimumObservations: 3, siblingMinimumForScoring: 2,
        siblingMinimumForIntervention: 3, confidenceConstant: 5,
        divergenceThresholdBps: 30_000,
      },
    }], createdAt: context.occurredAt,
  }, context);
  await policies.createMandate({
    id: "mandate-shadow", organizationId: "org-shadow", name: "Shadow research",
    assetId: "usd-micros", maximumSpendAtomic: 100_000n, state: "draft",
    policyId: "policy-shadow", policyVersion: 1, expiresAt: null, ...context,
  });
  for (const agentId of agents) {
    await policies.assignAgent({ organizationId: "org-shadow", mandateId: "mandate-shadow", agentId, ...context });
  }
  await policies.createBranch({
    id: "root", organizationId: "org-shadow", mandateId: "mandate-shadow",
    parentBranchId: null, agentId: "root", allowedWorkloadClasses: ["lookup"],
    maximumSpendAtomic: 100_000n, expiresAt: null, ...context,
  });
  for (const agentId of agents.slice(1)) {
    await policies.createBranch({
      id: `branch-${agentId}`, organizationId: "org-shadow", mandateId: "mandate-shadow",
      parentBranchId: "root", agentId, allowedWorkloadClasses: ["lookup"],
      maximumSpendAtomic: 10_000n, expiresAt: null,
      ...context, causationId: `request:branch-${agentId}`,
    });
  }
  await policies.transitionMandateState("org-shadow", "mandate-shadow", "active", context);

  let sequence = 0;
  const run = async (
    agentId: string,
    actualCostAtomic: bigint,
    model = "claude-sonnet-4-6",
  ) => {
    sequence += 1;
    const requestId = `shadow-${sequence}`;
    const at = `2026-07-20T00:${String(sequence).padStart(2, "0")}:00.000Z`;
    const admission = await policies.admitInference({
      requestId, requestFingerprint: sequence.toString(16).padStart(64, "0"),
      organizationId: "org-shadow", mandateId: "mandate-shadow", agentId,
      agentCapabilities: ["inference:invoke"], branchId: `branch-${agentId}`,
      workloadClass: "lookup", provider: "anthropic", model,
      estimatedCostAtomic: 1_000n, inputTokens: 20, maxOutputTokens: 10, decidedAt: at,
    });
    expect(admission.status).toBe("execute");
    return policies.completeInference({
      requestId, organizationId: "org-shadow", actualCostAtomic,
      response: providerResult(requestId), completedAt: at,
    });
  };

  for (const sibling of ["sib-a", "sib-b", "sib-c"]) {
    for (let call = 0; call < 3; call += 1) await run(sibling, 100n);
  }
  for (let call = 0; call < 3; call += 1) {
    await run("sib-other-model", 900n, "claude-haiku-3-5");
  }
  await run("target", 400n);
  await run("target", 400n);
  const completion = await run("target", 400n);

  expect(completion.shadowEvaluation).toMatchObject({
    requestId: "shadow-15", status: "scored", workloadClass: "lookup",
    cohortOrdinal: 12n,
    targetObservationCount: 3, comparableSiblingCount: 3,
    siblingAggregate: "mean", siblingAggregateAtomic: 300n,
    siblingWeightBps: 3_750, effectiveBaselineAtomic: 300n,
    divergenceRatioBps: 40_000, eligibleForIntervention: true,
    signals: ["SIBLING_DIVERGENCE", "CLASS_PRIOR_EXCEEDED"],
    wouldSignal: true,
  });
  const evidence = await policies.listShadowEvaluations("org-shadow", "mandate-shadow");
  expect(evidence.at(-1)).toEqual(completion.shadowEvaluation);
  const replay = await policies.admitInference({
    requestId: "shadow-15", requestFingerprint: "f".padStart(64, "0"),
    organizationId: "org-shadow", mandateId: "mandate-shadow", agentId: "target",
    agentCapabilities: ["inference:invoke"], branchId: "branch-target",
    workloadClass: "lookup", provider: "anthropic", model: "claude-sonnet-4-6",
    estimatedCostAtomic: 1_000n, inputTokens: 20, maxOutputTokens: 10,
    decidedAt: "2026-07-20T00:13:00.000Z",
  });
  expect(replay.status).toBe("completed");
  if (replay.status === "completed") {
    expect(replay.shadowEvaluation).toEqual(completion.shadowEvaluation);
  }

  const shadowInternals = policies as unknown as {
    evaluateAndPersistShadow: (...args: unknown[]) => Promise<unknown>;
  };
  const originalEvaluator = shadowInternals.evaluateAndPersistShadow;
  shadowInternals.evaluateAndPersistShadow = async () => {
    throw new Error("injected shadow failure");
  };
  const isolatedCompletion = await run("target", 400n);
  expect(isolatedCompletion).toMatchObject({ status: "completed", response: { id: "shadow-16" } });
  expect(isolatedCompletion.shadowEvaluation).toBeUndefined();
  const afterFailure = await pool.query(
    "SELECT status FROM inference_executions WHERE organization_id = 'org-shadow' AND request_id = 'shadow-16'",
  );
  expect(afterFailure.rows[0]?.status).toBe("completed");
  const queue = await pool.query(
    "SELECT state, last_error FROM shadow_evaluation_queue WHERE organization_id = 'org-shadow' AND request_id = 'shadow-16'",
  );
  expect(queue.rows[0]).toMatchObject({ state: "failed", last_error: "SHADOW_EVALUATION_FAILED" });
  shadowInternals.evaluateAndPersistShadow = originalEvaluator;
  const laterCompletion = await run("target", 400n);
  expect(laterCompletion.shadowEvaluation).toMatchObject({
    requestId: "shadow-17", cohortOrdinal: 14n, targetObservationCount: 5,
  });
  const stillFailed = await pool.query(
    "SELECT state FROM shadow_evaluation_queue WHERE organization_id = 'org-shadow' AND request_id = 'shadow-16'",
  );
  expect(stillFailed.rows[0]?.state).toBe("failed");
  expect(await policies.retryPendingShadowEvaluations()).toBe(1);
  const afterRetry = (await policies.listShadowEvaluations("org-shadow", "mandate-shadow"))
    .find(({ requestId }) => requestId === "shadow-16");
  expect(afterRetry).toMatchObject({ cohortOrdinal: 13n, targetObservationCount: 4 });

  const held = await run("target", 1_500n);
  expect(held.status).toBe("reconciliation_hold");
  await policies.resolveReconciliation({
    organizationId: "org-shadow", requestId: "shadow-18", resolution: "settle",
    actualCostAtomic: 1_500n, note: "Confirmed provider usage",
    externalReference: "provider-ledger:shadow-18", actorId: context.actorId,
    causationId: "request:resolve-shadow-18", occurredAt: "2026-07-20T00:19:00.000Z",
  });
  const reconciledEvidence = (await policies.listShadowEvaluations("org-shadow", "mandate-shadow"))
    .find(({ requestId }) => requestId === "shadow-18");
  expect(reconciledEvidence).toMatchObject({ cohortOrdinal: 15n, targetObservationCount: 6 });
  const reconciledReplay = await policies.admitInference({
    requestId: "shadow-18", requestFingerprint: "12".padStart(64, "0"),
    organizationId: "org-shadow", mandateId: "mandate-shadow", agentId: "target",
    agentCapabilities: ["inference:invoke"], branchId: "branch-target",
    workloadClass: "lookup", provider: "anthropic", model: "claude-sonnet-4-6",
    estimatedCostAtomic: 1_000n, inputTokens: 20, maxOutputTokens: 10,
    decidedAt: "2026-07-20T00:18:00.000Z",
  });
  expect(reconciledReplay.status).toBe("completed");
  if (reconciledReplay.status === "completed") {
    expect(reconciledReplay.shadowEvaluation).toEqual(reconciledEvidence);
  }
  await policies.transitionMandateState("org-shadow", "mandate-shadow", "active", {
    ...context, causationId: "request:resume-after-reconciliation",
    occurredAt: "2026-07-20T00:20:00.000Z",
  });
  const orderingInternals = policies as unknown as {
    assignShadowCohortOrdinal: (...args: unknown[]) => Promise<unknown>;
  };
  const originalOrdinalAssignment = orderingInternals.assignShadowCohortOrdinal;
  orderingInternals.assignShadowCohortOrdinal = async () => {
    throw new Error("INJECTED_SHADOW_BOOKKEEPING_FAILURE");
  };
  const bookkeepingFailure = await run("target", 100n);
  orderingInternals.assignShadowCohortOrdinal = originalOrdinalAssignment;
  expect(bookkeepingFailure.status).toBe("completed");
  expect((await pool.query(
    "SELECT status, shadow_order_state FROM inference_executions WHERE organization_id = 'org-shadow' AND request_id = 'shadow-19'",
  )).rows[0]).toMatchObject({ status: "completed", shadow_order_state: "failed" });
  shadowInternals.evaluateAndPersistShadow = async () => {
    throw new Error("persistent poison shadow job");
  };
  const poisonCompletion = await run("target", 100n);
  expect(poisonCompletion.status).toBe("completed");
  expect(await policies.retryPendingShadowEvaluations()).toBe(0);
  expect(await policies.retryPendingShadowEvaluations()).toBe(0);
  shadowInternals.evaluateAndPersistShadow = originalEvaluator;
  expect(await policies.retryPendingShadowEvaluations()).toBe(0);
  const cappedInternals = policies as unknown as {
    processShadowEvaluationBestEffort: (
      organizationId: string, requestId: string, evaluatedAt: string,
    ) => Promise<unknown>;
  };
  expect(await cappedInternals.processShadowEvaluationBestEffort(
    "org-shadow", "shadow-20", "2026-07-20T00:30:00.000Z",
  )).toBeUndefined();
  expect((await pool.query(
    "SELECT state, attempts FROM shadow_evaluation_queue WHERE organization_id = 'org-shadow' AND request_id = 'shadow-20'",
  )).rows[0]).toMatchObject({ state: "failed", attempts: 3 });
  expect((await policies.shadowQueueStatus()).exhausted).toBe(1);
  await pool.query(
    "UPDATE mandate_branches SET maximum_spend_atomic = 999999 WHERE organization_id = 'org-shadow' AND branch_id = 'branch-target'",
  );
  await expect(policies.listShadowEvaluations("org-shadow", "mandate-shadow"))
    .rejects.toThrow("MANDATE_BRANCH_DELEGATION_HASH_INVALID");
  await pool.end();
});
