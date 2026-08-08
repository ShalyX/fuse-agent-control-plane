import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "./heldOutReliabilityV2.js";
import { OPERATOR_ISSUER, RECONCILIATION_ISSUER } from "../reliability/issuers.js";

export type AuthorizationPayload = {
  kind: "operator" | "reconciliation"; runId: string; planFingerprint: string; executableFingerprint: string;
  actorId: string; issuerCredentialId: string; capability: "evidence:authorize-spend" | "evidence:authorize-reconciliation";
  nonce: string | null; expiresAt: string;
  organizationId?: string; profileFingerprint?: string; serviceAccountId?: string;
  credentialId?: string; credentialOwnerId?: string;
};
export interface AuthorizationArtifact { payload: AuthorizationPayload; signature: string }
export type TrustedAuthorizationIssuers = {
  operator: { id: string; rawPublicKeyHex: string };
  reconciliation: { id: string; rawPublicKeyHex: string };
};
const PINNED_ISSUERS: TrustedAuthorizationIssuers = { operator: OPERATOR_ISSUER, reconciliation: RECONCILIATION_ISSUER };
export function authorizationPayloadBytes(payload: AuthorizationPayload): Buffer {
  return Buffer.from(canonicalJson(payload), "utf8");
}

type OperatorReceiptStatus = "consumed" | "valid_not_consumed_peer_invalid" | "absent_or_invalid" | "readiness_failed";
type ReconciliationReceiptStatus = "validated" | "absent_or_invalid" | "valid_not_activated_peer_invalid" | "readiness_failed";
export interface AuthorizationReceipt {
  kind: "operator" | "reconciliation"; status: OperatorReceiptStatus | ReconciliationReceiptStatus;
  databaseValidationTime: string; expectedSignedFieldFingerprint: string; presentedArtifactSha256: string | null;
  credentialId: string | null; issuerCredentialId: string | null; reasonCode: string;
}
export interface AuthorizationDecision {
  decisionId: string; kind: "authorization_decision" | "readiness_predecision_failed";
  control: "active" | "failed"; nonceDisposition: "consumed" | "unused";
  operatorReceipt: AuthorizationReceipt; reconciliationReceipt: AuthorizationReceipt;
}
type CrashAt = "before-commit" | "after-commit" | "after-operator-receipt" | "after-reconciliation-receipt";

export class AuthorizationDecisionStore {
  committedDecision: AuthorizationDecision | null = null;
  readonly published = new Map<string, AuthorizationReceipt>();
  readonly consumedNonces = new Set<string>();
  providerCalls = 0;
  constructor(private readonly issuers: TrustedAuthorizationIssuers = PINNED_ISSUERS) {}
  get decisionCount(): number { return this.committedDecision ? 1 : 0; }
  nonceConsumed(nonce: string): boolean { return this.consumedNonces.has(nonce); }

  decide(input: {
    now: string; expectedRunId: string; expectedPlanFingerprint: string; expectedExecutableFingerprint: string;
    operator?: AuthorizationArtifact | null; reconciliation?: AuthorizationArtifact | null; crashAt?: CrashAt;
  }): AuthorizationDecision {
    if (this.committedDecision) return this.recoverPublication();
    let operatorValid = verifyAuthorizationArtifact(input.operator, "operator", input, this.issuers);
    let reconciliationValid = verifyAuthorizationArtifact(input.reconciliation, "reconciliation", input, this.issuers);
    if (operatorValid && reconciliationValid && (input.operator!.payload.actorId === input.reconciliation!.payload.actorId
      || input.operator!.payload.issuerCredentialId === input.reconciliation!.payload.issuerCredentialId)) {
      operatorValid = false; reconciliationValid = false;
    }
    if (input.crashAt === "before-commit") throw new Error("INJECTED_AUTHORIZATION_CRASH");
    const active = operatorValid && reconciliationValid;
    const operatorStatus: OperatorReceiptStatus = operatorValid
      ? reconciliationValid ? "consumed" : "valid_not_consumed_peer_invalid"
      : "absent_or_invalid";
    const reconciliationStatus: ReconciliationReceiptStatus = reconciliationValid
      ? operatorValid ? "validated" : "valid_not_activated_peer_invalid"
      : "absent_or_invalid";
    const expected = createHash("sha256").update(canonicalJson({ runId: input.expectedRunId,
      planFingerprint: input.expectedPlanFingerprint, executableFingerprint: input.expectedExecutableFingerprint })).digest("hex");
    const receipt = (kind: "operator" | "reconciliation", status: OperatorReceiptStatus | ReconciliationReceiptStatus,
      artifact: AuthorizationArtifact | null | undefined): AuthorizationReceipt => ({
      kind, status, databaseValidationTime: input.now, expectedSignedFieldFingerprint: `sha256:${expected}`,
      presentedArtifactSha256: artifact ? `sha256:${createHash("sha256").update(canonicalJson(artifact)).digest("hex")}` : null,
      credentialId: artifact?.payload.actorId ?? null, issuerCredentialId: artifact?.payload.issuerCredentialId ?? null,
      reasonCode: active ? "valid_pair" : "absent_or_invalid_pair",
    });
    const decision: AuthorizationDecision = {
      decisionId: `authz-${createHash("sha256").update(canonicalJson({ input: {
        now: input.now, expectedRunId: input.expectedRunId, expectedPlanFingerprint: input.expectedPlanFingerprint,
        expectedExecutableFingerprint: input.expectedExecutableFingerprint }, operatorValid, reconciliationValid })).digest("hex").slice(0, 24)}`,
      kind: "authorization_decision", control: active ? "active" : "failed",
      nonceDisposition: active ? "consumed" : "unused",
      operatorReceipt: receipt("operator", operatorStatus, input.operator),
      reconciliationReceipt: receipt("reconciliation", reconciliationStatus, input.reconciliation),
    };
    this.committedDecision = decision;
    if (active && input.operator?.payload.nonce) this.consumedNonces.add(input.operator.payload.nonce);
    if (input.crashAt === "after-commit") throw new Error("INJECTED_AUTHORIZATION_CRASH");
    this.publish("operator", decision.operatorReceipt);
    if (input.crashAt === "after-operator-receipt") throw new Error("INJECTED_AUTHORIZATION_CRASH");
    this.publish("reconciliation", decision.reconciliationReceipt);
    if (input.crashAt === "after-reconciliation-receipt") throw new Error("INJECTED_AUTHORIZATION_CRASH");
    return decision;
  }

  failPredecision(reasonCode: "validation_phase_deadline" | "decision_phase_deadline", now: string): AuthorizationDecision {
    if (this.committedDecision) return this.recoverPublication();
    const make = (kind: "operator" | "reconciliation"): AuthorizationReceipt => ({ kind, status: "readiness_failed",
      databaseValidationTime: now, expectedSignedFieldFingerprint: "sha256:" + "0".repeat(64),
      presentedArtifactSha256: null, credentialId: null, issuerCredentialId: null, reasonCode });
    this.committedDecision = { decisionId: `readiness-failed-${reasonCode}`, kind: "readiness_predecision_failed",
      control: "failed", nonceDisposition: "unused", operatorReceipt: make("operator"), reconciliationReceipt: make("reconciliation") };
    return this.recoverPublication();
  }

  recoverPublication(): AuthorizationDecision {
    if (!this.committedDecision) throw new Error("AUTHORIZATION_DECISION_ABSENT");
    this.publish("operator", this.committedDecision.operatorReceipt);
    this.publish("reconciliation", this.committedDecision.reconciliationReceipt);
    return this.committedDecision;
  }
  private publish(key: string, receipt: AuthorizationReceipt): void {
    const existing = this.published.get(key);
    if (existing && canonicalJson(existing) !== canonicalJson(receipt)) throw new Error("AUTHORIZATION_RECEIPT_CONFLICT");
    this.published.set(key, structuredClone(receipt));
  }
}

export function verifyAuthorizationArtifact(artifact: AuthorizationArtifact | null | undefined, kind: "operator" | "reconciliation", input: {
  now: string; expectedRunId: string; expectedPlanFingerprint: string; expectedExecutableFingerprint: string;
  expectedV3Identity?: { organizationId:string;profileFingerprint:string;serviceAccountId:string;credentialId:string;credentialOwnerId:string };
  expectedProtocolIdentity?: { organizationId:string;profileFingerprint:string;serviceAccountId:string;credentialId:string;credentialOwnerId:string };
}, issuers: TrustedAuthorizationIssuers = PINNED_ISSUERS): boolean {
  if (!artifact) return false;
  const payload = artifact.payload;
  const v2Keys="actorId,capability,executableFingerprint,expiresAt,issuerCredentialId,kind,nonce,planFingerprint,runId";
  const v3Keys="actorId,capability,credentialId,credentialOwnerId,executableFingerprint,expiresAt,issuerCredentialId,kind,nonce,organizationId,planFingerprint,profileFingerprint,runId,serviceAccountId";
  const expectedIdentity=input.expectedProtocolIdentity??input.expectedV3Identity;
  if (!payload || typeof payload !== "object" || Object.keys(payload).sort().join(",") !== (expectedIdentity?v3Keys:v2Keys)) return false;
  const capability = kind === "operator" ? "evidence:authorize-spend" : "evidence:authorize-reconciliation";
  const issuer = issuers[kind];
  if (payload.kind !== kind || payload.capability !== capability || payload.runId !== input.expectedRunId
    || payload.planFingerprint !== input.expectedPlanFingerprint || payload.executableFingerprint !== input.expectedExecutableFingerprint
    || Date.parse(payload.expiresAt) <= Date.parse(input.now) || (kind === "operator" && !payload.nonce)
    || (kind === "reconciliation" && payload.nonce !== null) || payload.actorId === payload.issuerCredentialId
    || payload.issuerCredentialId !== issuer.id || !/^[a-f0-9]{64}$/.test(issuer.rawPublicKeyHex)
    || (expectedIdentity && (payload.organizationId!==expectedIdentity.organizationId
      ||payload.profileFingerprint!==expectedIdentity.profileFingerprint||payload.serviceAccountId!==expectedIdentity.serviceAccountId
      ||payload.credentialId!==expectedIdentity.credentialId||payload.credentialOwnerId!==expectedIdentity.credentialOwnerId))
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(artifact.signature)) return false;
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(issuer.rawPublicKeyHex, "hex")]);
    return verify(null, authorizationPayloadBytes(payload), createPublicKey({ key: spki, type: "spki", format: "der" }), Buffer.from(artifact.signature, "base64"));
  } catch { return false; }
}

export type OutcomeState = "not_dispatched" | "completed_verified" | "terminal_rejected_not_billed"
  | "reconciled_not_billed" | "reconciled_billed_with_response" | "reconciled_billed_no_response"
  | "unresolved_provider_outcome";
export interface OutcomeEvidence {
  outcome: OutcomeState; executionStatus: "none" | "denied" | "failed" | "completed" | "reconciliation_hold";
  decision: "none" | "DENY" | "ALLOW"; token: 0 | 1; actualCost: "0" | "known" | null;
  shadowOrderState: "queued" | null; queueRows: 0 | 1; evidenceRows: 0 | 1; replayEligible: boolean;
}
export function expectedOutcomeEvidence(outcome: OutcomeState): OutcomeEvidence {
  const base = { outcome, decision: "ALLOW" as const, token: 1 as const, shadowOrderState: null, queueRows: 0 as const, evidenceRows: 0 as const, replayEligible: false };
  switch (outcome) {
    case "not_dispatched": return { ...base, executionStatus: "none", decision: "none", token: 0, actualCost: "0" };
    case "completed_verified": return { ...base, executionStatus: "completed", actualCost: "known", shadowOrderState: "queued", queueRows: 1, evidenceRows: 1, replayEligible: true };
    case "terminal_rejected_not_billed":
    case "reconciled_not_billed": return { ...base, executionStatus: "failed", actualCost: "0" };
    case "reconciled_billed_with_response": return { ...base, executionStatus: "completed", actualCost: "known", shadowOrderState: "queued", queueRows: 1, evidenceRows: 1, replayEligible: true };
    case "reconciled_billed_no_response": return { ...base, executionStatus: "failed", actualCost: "known" };
    case "unresolved_provider_outcome": return { ...base, executionStatus: "reconciliation_hold", actualCost: null };
  }
}

export type ProviderFault = "connect-before-dispatch" | "timeout-after-dispatch" | "http-429" | "http-500" | "http-502"
  | "truncated" | "oversized" | "malformed" | "model-mismatch" | "missing-cost" | "invalid-cost" | "database-after-response";
export function classifyProviderFault(fault: ProviderFault): "not_dispatched" | "reconciliation_pending" {
  return fault === "connect-before-dispatch" ? "not_dispatched" : "reconciliation_pending";
}

export class BurstBarrier {
  private control: "active" | "failed" = "active";
  private readonly tokens = new Set<string>(); private readonly released = new Set<string>();
  private readonly canceled = new Set<string>(); private readonly entered = new Set<string>();
  constructor(private readonly planned: readonly string[]) {}
  commitToken(id: string): void {
    if (this.control !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
    if (!this.planned.includes(id)) throw new Error("UNPLANNED_REQUEST_ID");
    if (this.tokens.has(id)) return;
    this.tokens.add(id);
  }
  release(): void {
    if (this.control !== "active" || this.tokens.size !== this.planned.length) throw new Error("BURST_BARRIER_NOT_READY");
    for (const id of this.planned) this.released.add(id);
  }
  globalFail(): void {
    if (this.control === "failed") return;
    this.control = "failed";
    for (const id of this.tokens) if (!this.released.has(id)) this.canceled.add(id);
  }
  enterAdapter(id: string): void {
    if (!this.released.has(id) || this.canceled.has(id)) throw new Error("BURST_DISPATCH_NOT_RELEASED");
    this.entered.add(id);
  }
  tokenCount(id: string): number { return this.tokens.has(id) ? 1 : 0; }
  eventCount(id: string, event: "barrier_released" | "barrier_canceled_before_dispatch"): number {
    return (event === "barrier_released" ? this.released : this.canceled).has(id) ? 1 : 0;
  }
  adapterEntered(id: string): boolean { return this.entered.has(id); }
}

export class ProtocolRuntime {
  control: "active" | "failed" = "active";
  failureSequence = 0;
  private readonly planned: Set<string>; private readonly tokens = new Set<string>();
  constructor(ids: readonly string[]) { this.planned = new Set(ids); if (this.planned.size !== ids.length) throw new Error("DUPLICATE_PLAN_ID"); }
  authorizeDispatch(id: string): boolean {
    if (!this.planned.has(id)) throw new Error("UNPLANNED_REQUEST_ID");
    if (this.tokens.has(id)) return false;
    if (this.control !== "active") throw new Error("PROTOCOL_CONTROL_FAILED");
    if (this.tokens.size >= 100) throw new Error("DISPATCH_TOKEN_FENCE_EXCEEDED");
    this.tokens.add(id); return true;
  }
  fail(_reason: string): void { if (this.control === "active") { this.control = "failed"; this.failureSequence = 1; } }
}
