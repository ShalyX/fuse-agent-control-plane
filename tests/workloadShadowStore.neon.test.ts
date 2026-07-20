import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createPostgresPool } from "../src/persistence/postgres.js";
import { IdentityStore } from "../src/persistence/identityStore.js";
import { PolicyStore } from "../src/persistence/policyStore.js";

const runNeon = process.env["RUN_NEON_INTEGRATION"] === "1";

it.runIf(runNeon)("migrates workload shadow schema concurrently and persists cross-instance evidence on Neon", async () => {
  const configuredUrl = process.env["NEON_INTEGRATION_DATABASE_URL_UNPOOLED"]
    ?? process.env["DATABASE_URL_UNPOOLED"] ?? process.env["DATABASE_URL"];
  if (!configuredUrl) throw new Error("DATABASE_URL_REQUIRED");
  const unpooled = new URL(configuredUrl);
  unpooled.hostname = unpooled.hostname.replace("-pooler.", ".");
  const databaseUrl = unpooled.toString();
  const administrationPool = createPostgresPool(databaseUrl);
  const schema = `shadow_${randomUUID().replaceAll("-", "")}`;
  await administrationPool.query(`CREATE SCHEMA "${schema}"`);
  const isolated = new URL(databaseUrl);
  isolated.searchParams.set("options", `-csearch_path=${schema}`);
  const firstPool = createPostgresPool(isolated.toString());
  const secondPool = createPostgresPool(isolated.toString());
  const organizationId = `shadow-integration-${randomUUID()}`;
  const mandateId = `mandate-${randomUUID()}`;
  const policyId = `policy-${randomUUID()}`;
  const actor = "test:workload-shadow-neon";
  const now = new Date();
  const occurredAt = now.toISOString();
  const context = { actorId: actor, causationId: `test:${organizationId}`, occurredAt };
  const first = new PolicyStore(firstPool);
  const second = new PolicyStore(secondPool);

  try {
    const identity = new IdentityStore(firstPool);
    await identity.createOrganization({ id: organizationId, name: "Shadow Neon integration", ...context });
    for (const agentId of ["root", "target", "sib-a", "sib-b"]) {
      await identity.registerAgent({ id: agentId, organizationId, name: agentId, ...context });
    }

    await Promise.all([
      first.getPolicy(organizationId, "missing", 1),
      second.getPolicy(organizationId, "missing", 1),
    ]);

    const migrations = await firstPool.query<{ version: number }>(
      "SELECT version FROM policy_schema_migrations ORDER BY version",
    );
    expect(migrations.rows.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);

    await first.publishPolicy({
      id: policyId, organizationId, version: 1, mode: "enforce",
      allowedProviders: ["anthropic"], allowedModels: ["claude-sonnet-4-6"],
      requiredCapability: "inference:invoke",
      limits: {
        maxPerCallAtomic: 2_000n, maxHourlyAtomic: 100_000n, maxDailyAtomic: 500_000n,
        maxRequestsPerMinute: 100, maxInputTokens: 20_000, maxOutputTokens: 4_000,
      },
      workloadClasses: [{
        id: "lookup", maxCostPerCallAtomic: 1_000n, maxInvocationsPerBranch: 20,
        aggregateBudgetAtomic: 20_000n, minimumInputTokens: 1,
        shadow: {
          classPriorWindowSpendAtomic: 300n, windowSeconds: 900,
          targetMinimumObservations: 3, siblingMinimumForScoring: 2,
          siblingMinimumForIntervention: 3, confidenceConstant: 5,
          divergenceThresholdBps: 30_000,
        },
      }], createdAt: occurredAt,
    }, context);
    await first.createMandate({
      id: mandateId, organizationId, name: "Neon shadow", assetId: "usd-micros",
      maximumSpendAtomic: 100_000n, state: "draft", policyId, policyVersion: 1,
      expiresAt: null, ...context,
    });
    for (const agentId of ["root", "target", "sib-a", "sib-b"]) {
      await first.assignAgent({ organizationId, mandateId, agentId, ...context });
    }
    await first.createBranch({
      id: "root", organizationId, mandateId, parentBranchId: null, agentId: "root",
      allowedWorkloadClasses: ["lookup"], maximumSpendAtomic: 100_000n,
      expiresAt: null, ...context,
    });
    for (const agentId of ["target", "sib-a", "sib-b"]) {
      await first.createBranch({
        id: `branch-${agentId}`, organizationId, mandateId, parentBranchId: "root", agentId,
        allowedWorkloadClasses: ["lookup"], maximumSpendAtomic: 20_000n,
        expiresAt: null, ...context,
        causationId: `test:${organizationId}:${agentId}`,
      });
    }
    await first.transitionMandateState(organizationId, mandateId, "active", context);


    let sequence = 0;
    const run = async (store: PolicyStore, agentId: string, actualCostAtomic: bigint) => {
      sequence += 1;
      const requestId = `${organizationId}:${sequence}`;
      const at = new Date(now.getTime() + sequence * 1_000).toISOString();
      const admitted = await store.admitInference({
        requestId, requestFingerprint: sequence.toString(16).padStart(64, "0"),
        organizationId, mandateId, agentId, agentCapabilities: ["inference:invoke"],
        branchId: `branch-${agentId}`, workloadClass: "lookup", provider: "anthropic",
        model: "claude-sonnet-4-6", estimatedCostAtomic: 1_000n,
        inputTokens: 20, maxOutputTokens: 10, decidedAt: at,
      });
      expect(admitted.status).toBe("execute");
      return store.completeInference({
        requestId, organizationId, actualCostAtomic,
        response: { id: requestId, content: "ok", usage: { inputTokens: 20, outputTokens: 10 } },
        completedAt: at,
      });
    };

    for (const sibling of ["sib-a", "sib-b"]) {
      for (let call = 0; call < 3; call += 1) await run(call % 2 ? first : second, sibling, 100n);
    }
    await run(first, "target", 400n);
    await run(second, "target", 400n);
    const completion = await run(first, "target", 400n);


    expect(completion.shadowEvaluation).toMatchObject({
      status: "scored", targetObservationCount: 3, comparableSiblingCount: 2,
      siblingAggregateAtomic: 300n, siblingWeightBps: 2_857,
      provider: "anthropic", model: "claude-sonnet-4-6",
    });
    const fromSecondConnection = await second.listShadowEvaluations(organizationId, mandateId);
    expect(fromSecondConnection.at(-1)).toEqual(completion.shadowEvaluation);

    const concurrent = await Promise.all([
      run(first, "target", 100n),
      run(second, "sib-a", 100n),
    ]);
    expect(concurrent.every(({ status }) => status === "completed")).toBe(true);
    const concurrentRequestIds = concurrent.map(({ response }) => response.id);
    const ordered = await firstPool.query<{
      request_id: string; shadow_cohort_key: string; shadow_cohort_ordinal: string;
    }>(
      `SELECT request_id, shadow_cohort_key, shadow_cohort_ordinal::text
       FROM inference_executions WHERE organization_id = $1 AND request_id = ANY($2::text[])
       ORDER BY shadow_cohort_ordinal`,
      [organizationId, concurrentRequestIds],
    );
    expect(ordered.rows).toHaveLength(2);
    expect(ordered.rows[0]?.shadow_cohort_key).toBe(ordered.rows[1]?.shadow_cohort_key);
    expect(BigInt(ordered.rows[1]!.shadow_cohort_ordinal)
      - BigInt(ordered.rows[0]!.shadow_cohort_ordinal)).toBe(1n);
    const queued = await firstPool.query<{ state: string }>(
      `SELECT state FROM shadow_evaluation_queue
       WHERE organization_id = $1 ORDER BY queued_at DESC LIMIT 2`,
      [organizationId],
    );
    expect(queued.rows).toHaveLength(2);
    expect(queued.rows.every(({ state }) => state === "completed")).toBe(true);

    const evaluatorInternals = first as unknown as {
      evaluateAndPersistShadow: (...args: unknown[]) => Promise<unknown>;
    };
    const originalEvaluator = evaluatorInternals.evaluateAndPersistShadow;
    evaluatorInternals.evaluateAndPersistShadow = async () => {
      throw new Error("INJECTED_OVERLAPPING_WORKER_FAILURE");
    };
    const originalPoolQuery = firstPool.query.bind(firstPool);
    let releaseFailure!: () => void;
    let failureUpdateReached!: () => void;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const failureReached = new Promise<void>((resolve) => { failureUpdateReached = resolve; });
    (firstPool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
      async (...args: unknown[]) => {
        const sql = String(args[0]);
        if (sql.includes("SET state = 'failed'")) {
          failureUpdateReached();
          await failureGate;
        }
        return originalPoolQuery(...args as Parameters<typeof firstPool.query>);
      };
    const overlappingFailure = run(first, "target", 100n);
    await failureReached;
    evaluatorInternals.evaluateAndPersistShadow = originalEvaluator;
    await secondPool.query(
      `UPDATE shadow_evaluation_queue
       SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE organization_id = $1 AND request_id = $2`,
      [organizationId, `${organizationId}:${sequence}`],
    );
    expect(await second.retryPendingShadowEvaluations()).toBe(1);
    releaseFailure();
    const overlapped = await overlappingFailure;
    expect(overlapped.status).toBe("completed");
    (firstPool as unknown as { query: typeof firstPool.query }).query = originalPoolQuery;
    const overlappedRequestId = overlapped.status === "completed" ? overlapped.response.id : "";
    expect((await secondPool.query(
      `SELECT queue.state, EXISTS (
         SELECT 1 FROM shadow_evaluations evidence
         WHERE evidence.organization_id = queue.organization_id
           AND evidence.request_id = queue.request_id
       ) AS has_evidence
       FROM shadow_evaluation_queue queue
       WHERE queue.organization_id = $1 AND queue.request_id = $2`,
      [organizationId, overlappedRequestId],
    )).rows[0]).toEqual({ state: "completed", has_evidence: true });

    const shadowInternals = first as unknown as {
      assignShadowCohortOrdinal: (...args: unknown[]) => Promise<unknown>;
    };
    const originalOrdinalAssignment = shadowInternals.assignShadowCohortOrdinal;
    shadowInternals.assignShadowCohortOrdinal = async () => {
      throw new Error("INJECTED_NEON_SHADOW_BOOKKEEPING_FAILURE");
    };
    const isolated = await run(first, "target", 100n);
    shadowInternals.assignShadowCohortOrdinal = originalOrdinalAssignment;
    expect(isolated.status).toBe("completed");
    if (isolated.status !== "completed") throw new Error("EXPECTED_COMPLETED");
    const isolatedRow = await firstPool.query<{
      status: string; shadow_order_state: string; shadow_cohort_ordinal: string | null;
    }>(
      `SELECT status, shadow_order_state, shadow_cohort_ordinal::text
       FROM inference_executions WHERE organization_id = $1 AND request_id = $2`,
      [organizationId, isolated.response.id],
    );
    expect(isolatedRow.rows[0]).toEqual({
      status: "completed", shadow_order_state: "failed", shadow_cohort_ordinal: null,
    });

    const lockA = await firstPool.connect();
    const lockB = await secondPool.connect();
    const rollbackCohort = "rollback-probe";
    try {
      await lockA.query("BEGIN");
      await lockB.query("BEGIN");
      await lockA.query(
        `INSERT INTO shadow_cohort_counters
         (organization_id, cohort_key, last_ordinal, updated_at)
         VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (organization_id, cohort_key) DO UPDATE
         SET last_ordinal = shadow_cohort_counters.last_ordinal + 1`,
        [organizationId, rollbackCohort],
      );
      let secondSettled = false;
      const blocked = lockB.query<{ last_ordinal: string }>(
        `INSERT INTO shadow_cohort_counters
         (organization_id, cohort_key, last_ordinal, updated_at)
         VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (organization_id, cohort_key) DO UPDATE
         SET last_ordinal = shadow_cohort_counters.last_ordinal + 1
         RETURNING last_ordinal::text`,
        [organizationId, rollbackCohort],
      ).finally(() => { secondSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(secondSettled).toBe(false);
      await lockA.query("ROLLBACK");
      expect((await blocked).rows[0]?.last_ordinal).toBe("1");
      await lockB.query("ROLLBACK");
      expect((await lockA.query(
        "SELECT 1 FROM shadow_cohort_counters WHERE organization_id = $1 AND cohort_key = $2",
        [organizationId, rollbackCohort],
      )).rowCount).toBe(0);
    } finally {
      lockA.release();
      lockB.release();
    }
  } finally {
    await Promise.all([firstPool.end(), secondPool.end()]);
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  }
}, 90_000);
