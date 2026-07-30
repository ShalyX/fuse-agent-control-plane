import type { ProviderResult } from "../core/service.js";
import { buildResponseCommitment, type StableSuccessfulResponseProjection } from "./commitments.js";
import type { ReconciliationEvidence } from "./reconciliationStateMachine.js";

export interface OrdinarySettlementClient {
  query<R = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface AuthoritativeResponseFields {
  decisionId: string;
  outcome: "ALLOW";
  wouldOutcome: "ALLOW";
  enforced: true;
  reasonCodes: readonly [];
  branchId: string | null;
  workloadClass: string | null;
  reservationAtomic: string;
  actualCostAtomic: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function exactProviderCostMicros(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("RECOVERED_RESPONSE_COST_INVALID");
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("RECOVERED_RESPONSE_COST_INVALID");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) throw new Error("RECOVERED_RESPONSE_COST_INVALID");
  return (BigInt(whole!) * 1_000_000n + BigInt((fraction.slice(0, 6) + "000000").slice(0, 6))).toString();
}

export function reconstructStableResponseFromEvidence(
  evidence: ReconciliationEvidence,
  authority: AuthoritativeResponseFields,
): { providerResult: ProviderResult; projection: StableSuccessfulResponseProjection; commitment: string } {
  if (!authority.decisionId || authority.outcome !== "ALLOW" || authority.wouldOutcome !== "ALLOW"
    || authority.enforced !== true || authority.reasonCodes.length !== 0
    || !/^\d+$/.test(authority.reservationAtomic) || !/^\d+$/.test(authority.actualCostAtomic)
    || Boolean(authority.branchId) !== Boolean(authority.workloadClass)) {
    throw new Error("RECOVERED_RESPONSE_AUTHORITY_INVALID");
  }
  const metadata = evidence.metadata.data;
  const root = object(evidence.content.body);
  const data = object(root?.data);
  const output = object(data?.output);
  const completion = output?.completion;
  const prompt = metadata?.tokens_prompt;
  const completionTokens = metadata?.tokens_completion;
  if (evidence.metadata.status !== 200 || evidence.content.status !== 200 || !metadata
    || metadata.id !== evidence.generationId || typeof metadata.model !== "string" || !metadata.model
    || metadata.finish_reason !== "stop" || typeof completion !== "string"
    || !Number.isSafeInteger(prompt) || Number(prompt) < 0
    || !Number.isSafeInteger(completionTokens) || Number(completionTokens) < 0
    || (typeof metadata.total_cost !== "string" && typeof metadata.total_cost !== "number")) {
    throw new Error("RECOVERED_RESPONSE_EVIDENCE_INVALID");
  }
  const providerResult: ProviderResult = {
    id: evidence.generationId,
    content: completion,
    usage: { inputTokens: Number(prompt), outputTokens: Number(completionTokens) },
    providerCostUsd: String(metadata.total_cost),
    providerModel: metadata.model,
  };
  const projection: StableSuccessfulResponseProjection = {
    id: providerResult.id,
    object: "chat.completion",
    model: metadata.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: providerResult.content } }],
    usage: {
      prompt_tokens: providerResult.usage.inputTokens,
      completion_tokens: providerResult.usage.outputTokens,
      total_tokens: providerResult.usage.inputTokens + providerResult.usage.outputTokens,
    },
    fuse: {
      decision: { id: authority.decisionId, outcome: "ALLOW", wouldOutcome: "ALLOW", enforced: true, reasonCodes: [] },
      ...(authority.branchId && authority.workloadClass
        ? { workloadScope: { branchId: authority.branchId, workloadClass: authority.workloadClass } } : {}),
      reservationAtomic: authority.reservationAtomic,
      actualCostAtomic: authority.actualCostAtomic,
    },
  };
  return { providerResult, projection, commitment: buildResponseCommitment(projection) };
}

interface OrdinaryExecutionRow {
  organization_id: string; request_id: string; mandate_id: string; provider: string; model: string;
  branch_id: string | null; workload_class: string | null; status: string; reserved_cost_atomic: string;
  response_json: ProviderResult | null; decision_id: string; outcome: string; would_outcome: string;
  enforced: boolean; reason_codes: unknown;
}

export async function loadAuthoritativeResponseFields(
  client: OrdinarySettlementClient,
  organizationId: string,
  requestId: string,
  actualCostAtomic: string,
): Promise<{ execution: OrdinaryExecutionRow; authority: AuthoritativeResponseFields }> {
  const result = await client.query<OrdinaryExecutionRow>(`SELECT execution.organization_id,execution.request_id,
    execution.mandate_id,execution.provider,execution.model,execution.branch_id,execution.workload_class,
    execution.status,execution.reserved_cost_atomic::text,execution.response_json,decision.id decision_id,
    decision.outcome,decision.would_outcome,decision.enforced,decision.reason_codes
    FROM inference_executions execution JOIN policy_decisions decision
      ON decision.organization_id=execution.organization_id AND decision.id=execution.decision_id
    WHERE execution.organization_id=$1 AND execution.request_id=$2 FOR UPDATE OF execution`,
  [organizationId, requestId]);
  const execution = result.rows[0];
  if (!execution) throw new Error("AUTHORITATIVE_ORDINARY_EXECUTION_MISSING");
  const reasons = Array.isArray(execution.reason_codes) ? execution.reason_codes : null;
  const authority = {
    decisionId: execution.decision_id,
    outcome: execution.outcome,
    wouldOutcome: execution.would_outcome,
    enforced: execution.enforced,
    reasonCodes: reasons,
    branchId: execution.branch_id,
    workloadClass: execution.workload_class,
    reservationAtomic: execution.reserved_cost_atomic,
    actualCostAtomic,
  } as unknown as AuthoritativeResponseFields;
  // Validate ordinary authority even for terminal states that do not reconstruct a response.
  if (authority.outcome !== "ALLOW" || authority.wouldOutcome !== "ALLOW" || authority.enforced !== true
    || authority.reasonCodes?.length !== 0) throw new Error("RECOVERED_RESPONSE_AUTHORITY_INVALID");
  return { execution, authority };
}

async function queueAuthoritativeShadow(
  client: OrdinarySettlementClient, execution: OrdinaryExecutionRow, occurredAt: string,
): Promise<void> {
  if (!execution.branch_id || !execution.workload_class) throw new Error("AUTHORITATIVE_SHADOW_SCOPE_MISSING");
  const branch = await client.query<{ parent_branch_id: string | null; policy_id: string; policy_version: number }>(
    `SELECT parent_branch_id,policy_id,policy_version FROM mandate_branches
     WHERE organization_id=$1 AND mandate_id=$2 AND branch_id=$3`,
    [execution.organization_id, execution.mandate_id, execution.branch_id],
  );
  const row = branch.rows[0];
  if (!row?.parent_branch_id) throw new Error("AUTHORITATIVE_SHADOW_BRANCH_INVALID");
  const policy = await client.query<{ workload_classes: Array<{ id?: unknown; shadow?: unknown }> }>(
    `SELECT workload_classes FROM policy_versions WHERE organization_id=$1 AND policy_id=$2 AND version=$3`,
    [execution.organization_id, row.policy_id, row.policy_version],
  );
  if (!policy.rows[0]?.workload_classes.some((item) => item.id === execution.workload_class && item.shadow === true)) {
    throw new Error("AUTHORITATIVE_SHADOW_POLICY_INVALID");
  }
  const envelope = { organizationId: execution.organization_id, mandateId: execution.mandate_id,
    parentBranchId: row.parent_branch_id, workloadClass: execution.workload_class, provider: execution.provider,
    model: execution.model, policyId: row.policy_id, policyVersion: row.policy_version };
  const { createHash } = await import("node:crypto");
  const cohortKey = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
  const ordinal = await client.query<{ last_ordinal: string }>(`INSERT INTO shadow_cohort_counters
    (organization_id,cohort_key,last_ordinal,updated_at) VALUES($1,$2,1,$3)
    ON CONFLICT(organization_id,cohort_key) DO UPDATE SET last_ordinal=shadow_cohort_counters.last_ordinal+1,
      updated_at=EXCLUDED.updated_at RETURNING last_ordinal::text`,
  [execution.organization_id,cohortKey,occurredAt]);
  if (!ordinal.rows[0]) throw new Error("AUTHORITATIVE_SHADOW_ORDINAL_FAILED");
  await client.query(`UPDATE inference_executions SET shadow_cohort_key=$3,shadow_cohort_ordinal=$4,
    shadow_completed_at=$5,shadow_order_state='queued' WHERE organization_id=$1 AND request_id=$2`,
  [execution.organization_id,execution.request_id,cohortKey,ordinal.rows[0].last_ordinal,occurredAt]);
  await client.query(`INSERT INTO shadow_evaluation_queue(organization_id,request_id,state,attempts,queued_at,updated_at)
    VALUES($1,$2,'pending',0,$3,$3) ON CONFLICT(organization_id,request_id) DO NOTHING`,
  [execution.organization_id,execution.request_id,occurredAt]);
}

async function releaseMandateHoldIfSettled(
  client: OrdinarySettlementClient, execution: OrdinaryExecutionRow,
): Promise<void> {
  const open = await client.query(`SELECT 1 FROM inference_executions candidate
    LEFT JOIN reconciliation_resolutions resolution ON resolution.organization_id=candidate.organization_id
      AND resolution.request_id=candidate.request_id
    WHERE candidate.organization_id=$1 AND candidate.mandate_id=$2 AND candidate.status='reconciliation_hold'
      AND resolution.request_id IS NULL LIMIT 1`, [execution.organization_id,execution.mandate_id]);
  if (open.rows.length) return;
  const hold = await client.query<{ prior_state: string }>(`SELECT prior_state FROM mandate_reconciliation_holds
    WHERE organization_id=$1 AND mandate_id=$2 FOR UPDATE`,[execution.organization_id,execution.mandate_id]);
  if (!hold.rows[0]) return;
  await client.query(`UPDATE control_mandates SET state=CASE WHEN $3='active' THEN 'paused' ELSE $3 END
    WHERE organization_id=$1 AND id=$2 AND state='reconciliation_hold'`,
  [execution.organization_id,execution.mandate_id,hold.rows[0].prior_state]);
  await client.query("DELETE FROM mandate_reconciliation_holds WHERE organization_id=$1 AND mandate_id=$2",
    [execution.organization_id,execution.mandate_id]);
}

/** Applies the ordinary execution/accounting/shadow/mandate side of a protocol terminal under the caller's transaction. */
export async function settleOrdinaryReconciliationOnClient(input: {
  client: OrdinarySettlementClient; requestId: string; organizationId: string; terminalState: 3 | 4 | 5 | 6 | 7;
  actualCostAtomic: string | null; evidence: ReconciliationEvidence | null; occurredAt: string;
}): Promise<{ response: ProviderResult | null; responseCommitment: string | null }> {
  const actual = input.actualCostAtomic ?? "0";
  const { execution, authority } = await loadAuthoritativeResponseFields(
    input.client,input.organizationId,input.requestId,actual,
  );
  if (input.terminalState === 7) {
    await input.client.query(`UPDATE inference_executions SET status='reconciliation_hold',failure_code='UNRESOLVED_PROVIDER_OUTCOME',
      updated_at=$3 WHERE organization_id=$1 AND request_id=$2`,[input.organizationId,input.requestId,input.occurredAt]);
    return { response: null, responseCommitment: null };
  }
  let recovered: ReturnType<typeof reconstructStableResponseFromEvidence> | null = null;
  if (input.terminalState === 5) {
    if (!input.evidence) throw new Error("RECOVERED_RESPONSE_EVIDENCE_INVALID");
    recovered = reconstructStableResponseFromEvidence(input.evidence,authority);
  }
  const resolution = input.terminalState === 3 || input.terminalState === 4 ? "confirm_not_billed" : "settle";
  await input.client.query(`INSERT INTO reconciliation_resolutions
    (organization_id,request_id,resolution,actual_cost_atomic,note,external_reference,resolved_by,resolved_at)
    VALUES($1,$2,$3,$4,$5,$6,'reliability-v2-reconciler',$7) ON CONFLICT(organization_id,request_id) DO NOTHING`,
  [input.organizationId,input.requestId,resolution,actual,`Reliability state ${input.terminalState}`,
    `reliability-v2:${input.requestId}:state-${input.terminalState}`,input.occurredAt]);
  const status = input.terminalState === 5 ? "completed" : "failed";
  const failure = input.terminalState === 3 ? "TERMINAL_REJECTED_NOT_BILLED"
    : input.terminalState === 4 ? "RECONCILED_NOT_BILLED" : "RECONCILED_BILLED_NO_RESPONSE";
  await input.client.query(`UPDATE inference_executions SET status=$3,actual_cost_atomic=$4,response_json=$5::jsonb,
    failure_code=$6,updated_at=$7 WHERE organization_id=$1 AND request_id=$2`,
  [input.organizationId,input.requestId,status,actual,recovered ? JSON.stringify(recovered.providerResult) : null,
    input.terminalState === 5 ? null : failure,input.occurredAt]);
  if (input.terminalState === 5) await queueAuthoritativeShadow(input.client,execution,input.occurredAt);
  await releaseMandateHoldIfSettled(input.client,execution);
  return { response: recovered?.providerResult ?? null, responseCommitment: recovered?.commitment ?? null };
}
