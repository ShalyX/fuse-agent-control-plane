import { createHash } from "node:crypto";
import { canonicalJson } from "../evidence/heldOutReliabilityV2.js";

function commitment(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson({ domain, version: 2, value })).digest("hex")}`;
}

export function buildHttpBodyCommitment(value: unknown): string {
  return commitment("fuse-reliability-v2-http-body", value);
}

export interface RequestCommitmentProjection {
  method: "POST";
  route: "/v1/chat/completions";
  organizationId: string;
  credentialId: string;
  mandateId: string;
  branchId: string | null;
  workloadClass: string | null;
  idempotencyKey: string;
  body: unknown;
}

export function buildRequestCommitment(value: RequestCommitmentProjection): string {
  return commitment("fuse-reliability-v2-request", {
    method: value.method,
    route: value.route,
    organizationId: value.organizationId,
    credentialId: value.credentialId,
    mandateId: value.mandateId,
    branchId: value.branchId,
    workloadClass: value.workloadClass,
    idempotencyKey: value.idempotencyKey,
    body: value.body,
  });
}

export function buildSealedRequestCommitment(input: {
  body: unknown;
  organizationId: string;
  credentialId: string;
  mandateId: string;
  branchId: string | null;
  workloadClass: string | null;
  requestId: string;
}): string {
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new Error("SEALED_REQUEST_BODY_INVALID");
  }
  return buildRequestCommitment({
    method: "POST",
    route: "/v1/chat/completions",
    organizationId: input.organizationId,
    credentialId: input.credentialId,
    mandateId: input.mandateId,
    branchId: input.branchId,
    workloadClass: input.workloadClass,
    idempotencyKey: input.requestId,
    body: input.body,
  });
}

export interface StableSuccessfulResponseProjection {
  id: string;
  object: "chat.completion";
  model: string;
  choices: readonly [{
    index: 0;
    finish_reason: "stop";
    message: { role: "assistant"; content: string };
  }];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  fuse: {
    decision: {
      id: string;
      outcome: "ALLOW";
      wouldOutcome: "ALLOW";
      enforced: true;
      reasonCodes: readonly [];
    };
    workloadScope?: { branchId: string; workloadClass: string };
    reservationAtomic: string;
    actualCostAtomic: string;
    shadowEvaluation?: unknown;
  };
}

/** Select exactly the protocol's stable API projection; asynchronous shadow data is excluded. */
export function projectStableSuccessfulResponse(value: StableSuccessfulResponseProjection): StableSuccessfulResponseProjection {
  const projection: StableSuccessfulResponseProjection = {
    id: value.id,
    object: value.object,
    model: value.model,
    choices: [{
      index: value.choices[0].index,
      finish_reason: value.choices[0].finish_reason,
      message: {
        role: value.choices[0].message.role,
        content: value.choices[0].message.content,
      },
    }],
    usage: {
      prompt_tokens: value.usage.prompt_tokens,
      completion_tokens: value.usage.completion_tokens,
      total_tokens: value.usage.total_tokens,
    },
    fuse: {
      decision: {
        id: value.fuse.decision.id,
        outcome: value.fuse.decision.outcome,
        wouldOutcome: value.fuse.decision.wouldOutcome,
        enforced: value.fuse.decision.enforced,
        reasonCodes: [],
      },
      ...(value.fuse.workloadScope ? { workloadScope: {
        branchId: value.fuse.workloadScope.branchId,
        workloadClass: value.fuse.workloadScope.workloadClass,
      } } : {}),
      reservationAtomic: value.fuse.reservationAtomic,
      actualCostAtomic: value.fuse.actualCostAtomic,
    },
  };
  return projection;
}

export function buildResponseCommitment(value: StableSuccessfulResponseProjection): string {
  return commitment("fuse-reliability-v2-response", projectStableSuccessfulResponse(value));
}
