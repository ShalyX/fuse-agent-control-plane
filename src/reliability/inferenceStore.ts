import type { InferenceExecutionStore } from "../inference/inferenceExecution.js";
import { buildRequestCommitment } from "./commitments.js";
import type { ReliabilityProtocolStore } from "./protocolStore.js";

/** Composes the ordinary policy ledger with the reliability protocol kernel. */
export class ReliabilityInferenceExecutionStore implements InferenceExecutionStore {
  constructor(
    private readonly policy: InferenceExecutionStore,
    private readonly protocol: Pick<ReliabilityProtocolStore,
      "recordAttempt" | "readSealedReservation" | "recordAttemptOnClient" | "authorizeReliabilityDispatch" | "awaitReliabilityDispatchRelease"
      | "markReliabilityDispatchPrimitiveEntered" | "completeReliabilityAttempt" | "completeReliabilityAttemptOnClient"
      | "classifyReliabilityNotDispatched" | "classifyReliabilityNotDispatchedOnClient" | "recoverPreEntryDispatchOnClient"
      | "holdReliabilityAttempt" | "failProtocol">,
  ) {}
  admitInference: InferenceExecutionStore["admitInference"] = async (input) => {
    const reliability=input.reliabilityAdmission;
    if(!reliability)return this.policy.admitInference(input);
    const reservedCostMicros=await this.protocol.readSealedReservation({runId:reliability.runId,requestId:reliability.requestId,laneId:reliability.laneId,block:reliability.block});
    const atomic=(this.policy as InferenceExecutionStore&{admitInferenceAtomically?:(input:Parameters<InferenceExecutionStore["admitInference"]>[0],hook:(client:unknown,result:Awaited<ReturnType<InferenceExecutionStore["admitInference"]>>)=>Promise<void>)=>ReturnType<InferenceExecutionStore["admitInference"]>}).admitInferenceAtomically;
    if(!atomic)throw new Error("ATOMIC_RELIABILITY_ADMISSION_REQUIRED");
    const result=await atomic.call(this.policy,{...input,estimatedCostAtomic:reservedCostMicros},async(client,admission)=>{
      if(admission.status!=="execute")return;
      if(admission.reservedCostAtomic!==reservedCostMicros)throw new Error("SEALED_RESERVATION_CONFLICT");
      await this.protocol.recordAttemptOnClient(client as never,{runId:reliability.runId,requestId:reliability.requestId,laneId:reliability.laneId,block:reliability.block,reservedCostMicros,requestCommitment:reliability.requestCommitment??buildRequestCommitment(reliability.request)});
    });
    return result.status==="execute"?{...result,protocolAdmissionCommitted:true}:result;
  };
  completeInference: InferenceExecutionStore["completeInference"] = (input) => this.policy.completeInference(input);
  completeReliabilityInference: NonNullable<InferenceExecutionStore["completeReliabilityInference"]> = async (input) => {
    const atomic=(this.policy as InferenceExecutionStore&{completeInferenceAtomically?:(ordinary:Parameters<InferenceExecutionStore["completeInference"]>[0],hook:(client:unknown,result:Awaited<ReturnType<InferenceExecutionStore["completeInference"]>>)=>Promise<void>)=>ReturnType<InferenceExecutionStore["completeInference"]>}).completeInferenceAtomically;
    if(!atomic)throw new Error("ATOMIC_RELIABILITY_COMPLETION_REQUIRED");
    return atomic.call(this.policy,input.ordinary,async(client,result)=>{
      if(result.status!=="completed")throw new Error("RELIABILITY_COMPLETION_REQUIRES_ORDINARY_SUCCESS");
      await this.protocol.completeReliabilityAttemptOnClient(client as never,input.protocol);
    });
  };
  holdInference: InferenceExecutionStore["holdInference"] = (input) => this.policy.holdInference(input);
  failInference: InferenceExecutionStore["failInference"] = (input) => this.policy.failInference(input);
  async recordReliabilityAttempt(input: Parameters<NonNullable<InferenceExecutionStore["recordReliabilityAttempt"]>>[0]): Promise<void> {
    await this.protocol.recordAttempt({
      runId: input.runId, requestId: input.requestId, laneId: input.laneId, block: input.block,
      reservedCostMicros: input.reservedCostMicros,
      requestCommitment: input.requestCommitment??buildRequestCommitment(input.request),
    });
  }
  authorizeReliabilityDispatch: NonNullable<InferenceExecutionStore["authorizeReliabilityDispatch"]> = (input) =>
    this.protocol.authorizeReliabilityDispatch(input);
  markReliabilityDispatchPrimitiveEntered: NonNullable<InferenceExecutionStore["markReliabilityDispatchPrimitiveEntered"]> = (input) =>
    this.protocol.markReliabilityDispatchPrimitiveEntered(input);
  awaitReliabilityDispatchRelease: NonNullable<InferenceExecutionStore["awaitReliabilityDispatchRelease"]> = (input) =>
    this.protocol.awaitReliabilityDispatchRelease(input);
  completeReliabilityAttempt: NonNullable<InferenceExecutionStore["completeReliabilityAttempt"]> = (input) =>
    this.protocol.completeReliabilityAttempt(input);
  classifyReliabilityNotDispatched: NonNullable<InferenceExecutionStore["classifyReliabilityNotDispatched"]> = (input) =>
    this.protocol.classifyReliabilityNotDispatched(input);
  classifyReliabilityNotDispatchedAtomically: NonNullable<InferenceExecutionStore["classifyReliabilityNotDispatchedAtomically"]> = async (input) => {
    const atomic = (this.policy as InferenceExecutionStore & {
      failInferenceAtomically?: (
        ordinary: Parameters<InferenceExecutionStore["failInference"]>[0],
        hook: (client: unknown) => Promise<void>,
      ) => Promise<void>;
    }).failInferenceAtomically;
    if (!atomic) throw new Error("ATOMIC_RELIABILITY_NOT_DISPATCHED_REQUIRED");
    await atomic.call(this.policy, input.ordinary, (client) =>
      this.protocol.classifyReliabilityNotDispatchedOnClient(client as never, input.protocol));
  };
  async recoverPreEntryDispatchAtomically(input: {
    ordinary: Parameters<InferenceExecutionStore["failInference"]>[0];
    protocol: { runId: string; laneId: string; requestId: string; reasonCode?: string };
  }): Promise<"already_terminal" | "not_dispatched"> {
    const atomic = (this.policy as InferenceExecutionStore & {
      failInferenceAtomically?: (
        ordinary: Parameters<InferenceExecutionStore["failInference"]>[0],
        hook: (client: unknown) => Promise<void>,
      ) => Promise<void>;
    }).failInferenceAtomically;
    if (!atomic) throw new Error("ATOMIC_PRE_ENTRY_RECOVERY_REQUIRED");
    let recovered: "already_terminal" | "not_dispatched" | undefined;
    await atomic.call(this.policy, input.ordinary, async (client) => {
      recovered = await this.protocol.recoverPreEntryDispatchOnClient(client as never, input.protocol);
    });
    if (!recovered) throw new Error("PRE_ENTRY_RECOVERY_RESULT_MISSING");
    return recovered;
  }
  holdReliabilityAttempt: NonNullable<InferenceExecutionStore["holdReliabilityAttempt"]> = (input) =>
    this.protocol.holdReliabilityAttempt(input);
  failReliabilityProtocol: NonNullable<InferenceExecutionStore["failReliabilityProtocol"]> = (runId, reasonCode) =>
    this.protocol.failProtocol(runId, reasonCode);
}