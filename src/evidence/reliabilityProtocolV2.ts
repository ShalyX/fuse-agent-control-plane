import { link, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "./heldOutReliabilityV2.js";
import type { OutcomeState } from "./reliabilityRuntimeV2.js";

export interface ReconciliationContentInput {
  metadataStatus: number; contentStatus: number; finalOffset: boolean; cancelled: boolean;
  totalCostMicros: number; usageCostMicros: number; model: string; finishReason: string | null;
  tokenCountsValid: boolean; inputMatches: boolean; completion?: string | null; reasoning: string | null;
  generationIdBound: boolean; exact404Error?: boolean; networkFailure?: boolean; timeout?: boolean;
  malformed?: boolean; nonJson?: boolean; oversized?: boolean;
}
export type ReconciliationDisposition = "reconciled_not_billed" | "reconciled_billed_with_response"
  | "reconciled_billed_no_response" | "reconciliation_pending" | "global_failure";
export function classifyReconciliationContent(input: ReconciliationContentInput): ReconciliationDisposition {
  if (input.metadataStatus === 401 || input.metadataStatus === 403 || input.contentStatus === 401 || input.contentStatus === 403)
    return "global_failure";
  if (input.networkFailure || input.timeout || input.malformed || input.nonJson || input.oversized
    || !input.generationIdBound || input.model !== "nousresearch/hermes-4-405b") return "reconciliation_pending";
  if (input.cancelled && input.totalCostMicros === 0 && input.usageCostMicros === 0) return "reconciled_not_billed";
  const positiveMetadata = !input.cancelled && input.totalCostMicros > 0
    && input.totalCostMicros === input.usageCostMicros && input.finishReason === "stop" && input.tokenCountsValid;
  if (!positiveMetadata) return "reconciliation_pending";
  if (input.contentStatus === 200 && input.inputMatches && input.reasoning === null && typeof input.completion === "string")
    return "reconciled_billed_with_response";
  const acceptedNoResponse = input.contentStatus === 200 && input.inputMatches && input.reasoning === null && input.completion === null;
  const accepted404 = input.contentStatus === 404 && input.exact404Error === true;
  if (input.finalOffset && (acceptedNoResponse || accepted404)) return "reconciled_billed_no_response";
  return "reconciliation_pending";
}

export function evaluateReconciliationTiming(input: {
  errorAfterMs: number; lookupStartAfterErrorMs: number; httpMs: number; parseMs: number; transactionMs: number; remainingMs: number;
}): "pre_ambiguity_allowed" | "ambiguity_required" | "schedule_failure" {
  if (input.lookupStartAfterErrorMs < 0 || input.lookupStartAfterErrorMs >= 1_000 || input.httpMs > 30_000
    || input.parseMs > 5_000 || input.transactionMs > 15_000 || input.remainingMs > 5_000
    || input.httpMs + input.parseMs + input.transactionMs + input.remainingMs > 55_000) return "schedule_failure";
  return input.errorAfterMs <= 19_000 ? "pre_ambiguity_allowed" : "ambiguity_required";
}

interface Member { id: string; terminal: boolean; state: "ordinary_inflight" | "reconciliation_pending" }
export class HeldLane {
  readonly lane: string; readonly members: Map<string, Member>; holdCreationCount = 0;
  private held: string[] = []; resumeAt: number | null = null; allowanceOwner: string | null = null; globalFailed = false;
  private readonly fifo: Array<{ block: number; callOrdinal: number }> = [];
  constructor(lane: string, ids: readonly string[]) {
    this.lane = lane; this.members = new Map(ids.map((id) => [id, { id, terminal: false, state: "ordinary_inflight" }]));
  }
  enterAmbiguity(id: string, _at: number): void {
    const member = this.require(id); if (member.terminal) throw new Error("MEMBER_ALREADY_TERMINAL");
    if (this.held.length === 0) {
      this.held = [...this.members.values()].filter((item) => !item.terminal).map((item) => item.id).sort();
      this.holdCreationCount++;
    }
    member.state = "reconciliation_pending";
  }
  terminalize(id: string, outcome: "completed_verified" | "terminal_rejected_not_billed", at: number): void {
    void outcome; const member = this.require(id); if (member.terminal) return; member.terminal = true; this.removeHeld(id, at);
  }
  resolve(id: string, outcome: "reconciled_billed_with_response" | "reconciled_not_billed" | "reconciled_billed_no_response" | "unresolved_provider_outcome", at: number): void {
    const member = this.require(id); if (member.state !== "reconciliation_pending" || member.terminal) throw new Error("MEMBER_NOT_RECONCILIATION_PENDING");
    member.terminal = true;
    if (outcome === "reconciled_not_billed" || outcome === "reconciled_billed_no_response") this.claimAllowanceOrFail(id);
    if (outcome === "unresolved_provider_outcome") this.globalFailed = true;
    this.removeHeld(id, at);
  }
  preAmbiguityReject(id: string, at: number): void {
    const member = this.require(id); if (member.terminal) throw new Error("MEMBER_ALREADY_TERMINAL");
    member.terminal = true; this.claimAllowanceOrFail(id); this.removeHeld(id, at);
  }
  heldMembers(): string[] { return [...this.held]; }
  enqueue(item: { block: number; callOrdinal: number }): void { this.fifo.push(item); }
  dequeueAll(): Array<{ block: number; callOrdinal: number }> {
    return this.fifo.splice(0).sort((a, b) => a.block - b.block || a.callOrdinal - b.callOrdinal);
  }
  private claimAllowanceOrFail(id: string): void {
    if (this.allowanceOwner === null) this.allowanceOwner = id; else if (this.allowanceOwner !== id) this.globalFailed = true;
  }
  private removeHeld(id: string, at: number): void {
    const index = this.held.indexOf(id); if (index >= 0) this.held.splice(index, 1);
    if (index >= 0 && this.held.length === 0 && !this.globalFailed) this.resumeAt = resumeEpochSecond(at);
  }
  private require(id: string): Member { const member = this.members.get(id); if (!member) throw new Error("UNPLANNED_REQUEST_ID"); return member; }
}
export function resumeEpochSecond(removalEpochSecond: number): number {
  return 300 * (Math.floor(removalEpochSecond / 300) + 1);
}

export function computeEffectiveExposure(input: {
  completedActual: number[]; billedNoResponse: number[]; otherKnownBilled: number[]; unresolvedReservations: number[];
}, cap = Number.POSITIVE_INFINITY): number {
  const values = [...input.completedActual, ...input.billedNoResponse, ...input.otherKnownBilled, ...input.unresolvedReservations];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("COST_VALUE_INVALID");
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total > cap) throw new Error("COST_EXPOSURE_BREACH");
  return total;
}

export interface SettlementPoll { offset: number; startedAt: number; complete: boolean }
export function exactSettlementOffsets(): number[] {
  return Array.from({ length: 25 }, (_, index) => index * 5);
}
export function evaluateSettlement(startedAt: number, polls: readonly SettlementPoll[]): { passed: boolean; acceptedOffset: number | null; polls: readonly SettlementPoll[] } {
  const offsets = exactSettlementOffsets();
  if (polls.length > offsets.length || polls.some((poll, index) => poll.offset !== offsets[index])) {
    return { passed: false, acceptedOffset: null, polls };
  }
  const deadline = startedAt + 120;
  const timingValid = polls.every((poll) => poll.startedAt >= startedAt + poll.offset && poll.startedAt <= deadline);
  const accepted = timingValid
    ? polls.find((poll) => poll.offset >= 0 && poll.offset <= 120 && poll.startedAt <= deadline && poll.complete)
    : undefined;
  const stoppedAtFirstComplete = accepted === undefined || polls.indexOf(accepted) === polls.length - 1;
  return { passed: accepted !== undefined && stoppedAtFirstComplete, acceptedOffset: accepted !== undefined && stoppedAtFirstComplete ? accepted.offset : null, polls };
}

function logGamma(value: number): number {
  const coefficients = [676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.99999999999980993; const z = value - 1;
  for (let index = 0; index < coefficients.length; index++) x += coefficients[index]! / (z + index + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betaFraction(a: number, b: number, x: number): number {
  const max = 200; const epsilon = 3e-14; const floor = 1e-300;
  const qab=a+b, qap=a+1, qam=a-1; let c=1, d=1-qab*x/qap; if(Math.abs(d)<floor)d=floor; d=1/d; let h=d;
  for(let m=1;m<=max;m++){const m2=2*m; let aa=m*(b-m)*x/((qam+m2)*(a+m2)); d=1+aa*d;if(Math.abs(d)<floor)d=floor;c=1+aa/c;if(Math.abs(c)<floor)c=floor;d=1/d;h*=d*c;
    aa=-(a+m)*(qab+m)*x/((a+m2)*(qap+m2));d=1+aa*d;if(Math.abs(d)<floor)d=floor;c=1+aa/c;if(Math.abs(c)<floor)c=floor;d=1/d;const delta=d*c;h*=delta;if(Math.abs(delta-1)<epsilon)break;}
  return h;
}
function regularizedBeta(x:number,a:number,b:number):number {
  if(x<=0)return 0;if(x>=1)return 1;
  const factor=Math.exp(logGamma(a+b)-logGamma(a)-logGamma(b)+a*Math.log(x)+b*Math.log1p(-x));
  return x<(a+1)/(a+b+2)?factor*betaFraction(a,b,x)/a:1-factor*betaFraction(b,a,1-x)/b;
}
function betaInverse(probability:number,a:number,b:number):number {
  let low=0,high=1; for(let i=0;i<120;i++){const mid=(low+high)/2;if(regularizedBeta(mid,a,b)<probability)low=mid;else high=mid;} return (low+high)/2;
}
export function clopperPearsonDiagnostics(input:{planned:number;admissionStarted:number;canceledAfterGateFailure:number;usable:number;unresolved:number}):{usableLower:number;unresolvedUpper:number}|null {
  if(input.planned!==100||input.admissionStarted!==100||input.canceledAfterGateFailure!==0)return null;
  if(![input.usable,input.unresolved].every((value)=>Number.isInteger(value)&&value>=0&&value<=100))throw new Error("STATISTICAL_COUNT_INVALID");
  return { usableLower:input.usable===0?0:betaInverse(0.05,input.usable,101-input.usable),
    unresolvedUpper:input.unresolved===100?1:betaInverse(0.95,input.unresolved+1,100-input.unresolved) };
}

type ReducerState = "not_dispatched"|"completed_verified"|"terminal_rejected_not_billed"|"reconciled_not_billed"|"reconciled_billed_with_response"|"reconciled_billed_no_response"|"unresolved_provider_outcome";
export function reduceReliabilityEvidence(input:{
  plannedRequestIds:readonly string[];
  attempts:readonly {requestId:string;state:ReducerState;gateClassifications:number;admissionStarted:boolean;actualCostMicros:string|null}[];
  replayPassed:number;
  inventory:{protocolReceipts:number;beacons:number;plans:number;authorizationReceipts:number;laneClaims:number;manifests:number;replayReports:number;extras:readonly string[]};
}):{gate:{passed:boolean;reasons:string[]};diagnostics:{usableLower:number;unresolvedUpper:number}|null;counts:Record<string,number>} {
  const planned=new Set(input.plannedRequestIds); const seen=new Set(input.attempts.map((row)=>row.requestId));
  if(planned.size!==100||seen.size!==100||input.attempts.length!==100||[...planned].some((id)=>!seen.has(id))||[...seen].some((id)=>!planned.has(id)))throw new Error("EVIDENCE_ATTEMPT_INVENTORY_INVALID");
  if(input.attempts.some((row)=>row.gateClassifications!==1))throw new Error("EVIDENCE_GATE_CARDINALITY_INVALID");
  const counts:Record<string,number>={};for(const row of input.attempts)counts[row.state]=(counts[row.state]??0)+1;
  const inventory=input.inventory; const artifactsTerminal=inventory.protocolReceipts===1&&inventory.beacons===1&&inventory.plans===1
    &&inventory.authorizationReceipts===2&&inventory.laneClaims===4&&inventory.manifests===20&&inventory.replayReports===1&&inventory.extras.length===0;
  const usable=(counts.completed_verified??0)+(counts.reconciled_billed_with_response??0); const unresolved=counts.unresolved_provider_outcome??0;
  const exposure=input.attempts.reduce((sum,row)=>sum+(row.actualCostMicros===null?0:Number(row.actualCostMicros)),0);
  const gate=replayGate({planned:100,usable,notDispatched:counts.not_dispatched??0,unresolved,ambiguityEvents:0,gateClassifications:100,
    duplicateIds:0,replayPassed:input.replayPassed,evidenceDurable:true,artifactsTerminal,effectiveExposure:exposure,unresolvedCost:unresolved});
  return {gate,counts,diagnostics:clopperPearsonDiagnostics({planned:100,admissionStarted:input.attempts.filter((row)=>row.admissionStarted).length,
    canceledAfterGateFailure:0,usable,unresolved})};
}
export function assertIdempotencyReplay(input: { originalCommitment: string; replayCommitment: string; auditedWrites: readonly string[] }): void {
  if (input.originalCommitment !== input.replayCommitment) throw new Error("REPLAY_COMMITMENT_MISMATCH");
  if (input.auditedWrites.length !== 0) throw new Error("REPLAY_WRITE_SET_NOT_EMPTY");
}

export function replayGate(input: {
  planned: number; usable: number; notDispatched: number; unresolved: number; ambiguityEvents: number;
  gateClassifications: number; duplicateIds: number; replayPassed: number; evidenceDurable: boolean;
  artifactsTerminal: boolean; effectiveExposure: number; unresolvedCost: number;
}): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.planned !== 100 || input.usable < 99) reasons.push("USABLE_OUTCOMES_BELOW_99");
  if (input.notDispatched !== 0) reasons.push("NOT_DISPATCHED_PRESENT");
  if (input.unresolved !== 0) reasons.push("UNRESOLVED_OUTCOME");
  if (input.gateClassifications !== 100 || input.duplicateIds !== 0) reasons.push("EXACTLY_ONCE_TRUTH_FAILED");
  if (input.replayPassed !== 20) reasons.push("REPLAY_INTEGRITY_FAILED");
  if (!input.evidenceDurable) reasons.push("EVIDENCE_DURABILITY_FAILED");
  if (!input.artifactsTerminal) reasons.push("ARTIFACT_TERMINALIZATION_FAILED");
  if (input.effectiveExposure > 3_000_000) reasons.push("COST_EXPOSURE_BREACH");
  if (input.unresolvedCost !== 0) reasons.push("UNRESOLVED_PROVIDER_COST");
  return { passed: reasons.length === 0, reasons };
}

type DurableManifest = { state: string; sequence: number; [key: string]: unknown };
const manifestStateRank: Readonly<Record<string, number>> = {
  claimed: 0, admission_started: 1, awaiting_outcome: 2, terminal: 3,
};

/** Atomically publishes one fsynced, exact, monotone restart-manifest transition. */
export async function publishManifestDurably(path: string, value: DurableManifest): Promise<void> {
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || manifestStateRank[value.state] === undefined) throw new Error("MANIFEST_INVALID");
  const directory = dirname(path); await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = `${canonicalJson(value)}\n`; const lockPath = `${path}.write-lock`;
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("MANIFEST_PUBLICATION_BUSY");
      throw error;
    }
    const temporaryFile = await open(temporary, "wx", 0o600);
    try { await temporaryFile.writeFile(bytes, "utf8"); await temporaryFile.sync(); } finally { await temporaryFile.close(); }
    let existingBytes: string | null = null;
    try { existingBytes = await readFile(path, "utf8"); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
    if (existingBytes === bytes) return;
    if (existingBytes === null) {
      try { await link(temporary, path); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("MANIFEST_CREATE_CONFLICT");
        throw error;
      }
    } else {
      let existing: DurableManifest;
      try { existing = JSON.parse(existingBytes) as DurableManifest; } catch { throw new Error("MANIFEST_EXISTING_INVALID"); }
      if (existing.state === "terminal") {
        throw new Error(value.state === "terminal" ? "MANIFEST_TERMINAL_CONFLICT" : "MANIFEST_TRANSITION_CONFLICT");
      }
      if (value.sequence !== existing.sequence + 1 || manifestStateRank[value.state]! <= (manifestStateRank[existing.state] ?? Number.POSITIVE_INFINITY)) throw new Error("MANIFEST_TRANSITION_CONFLICT");
      if (await readFile(path, "utf8") !== existingBytes) throw new Error("MANIFEST_REPLACEMENT_CONFLICT");
      await rename(temporary, path);
    }
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await rm(temporary, { force: true });
    if (lock) { await lock.close(); await unlink(lockPath).catch(() => undefined); }
  }
}

export class ReliabilityArtifactStore {
  constructor(private readonly root: string) {}
  async publishOnce(relativePath: string, value: unknown): Promise<void> {
    const path = join(this.root, relativePath); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const bytes = `${canonicalJson(value)}\n`;
    await this.publishExactBytes(path, bytes);
  }
  async publishBytesOnce(relativePath: string, bytes: string): Promise<void> {
    const path = join(this.root, relativePath); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.publishExactBytes(path, bytes);
  }
  private async publishExactBytes(path: string, bytes: string): Promise<void> {
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(bytes, "utf8"); await file.sync(); } finally { await file.close(); }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      const existing = await readFile(path, "utf8");
      if (existing !== bytes) throw new Error("ARTIFACT_CONFLICT");
    }
  }
  async assertNoOrphanLocks(): Promise<void> {
    const walk = async (directory: string): Promise<string[]> => {
      const entries = await readdir(directory, { withFileTypes: true }); const found: string[] = [];
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await walk(path)); else if (entry.name.endsWith(".write-lock")) found.push(path);
      }
      return found;
    };
    const locks = await walk(this.root); if (locks.length) throw new Error(`ARTIFACT_ORPHAN_LOCK:${locks.sort().join(",")}`);
  }
}

export type { OutcomeState };
