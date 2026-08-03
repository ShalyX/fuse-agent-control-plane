import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ReliabilityCliCommand = "doctor" | "dry" | "seal" | "setup" | "worker" | "authorize" | "run" | "reconcile" | "settle" | "replay" | "evidence" | "report";
export interface ReliabilityCliResult {
  ok: boolean;
  command: string;
  prompted: false;
  timestamp: string;
  [key: string]: unknown;
}
export interface ReliabilityCliDependencies {
  cwd?: string;
  now?: () => string;
  network?: (...args: unknown[]) => Promise<unknown>;
  readLocal?: (path: string) => Promise<Buffer>;
  durableRunPredecision?: boolean;
  operations?: Partial<Record<ReliabilityCliCommand, (input: { args: readonly string[]; files: Readonly<Record<string, Buffer>> }) => Promise<Record<string, unknown>>>>;
}

const COMMANDS = new Set<ReliabilityCliCommand>(["doctor", "dry", "seal", "setup", "worker", "authorize", "run", "reconcile", "settle", "replay", "evidence", "report"]);

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function has(args: readonly string[], name: string): boolean { return args.includes(name); }

export async function executeReliabilityCli(args: readonly string[], deps: ReliabilityCliDependencies = {}): Promise<ReliabilityCliResult> {
  const command = args[0] ?? "";
  const base = { command, prompted: false as const, timestamp: (deps.now ?? (() => new Date().toISOString()))() };
  if (!COMMANDS.has(command as ReliabilityCliCommand)) return { ...base, ok: false, errorCode: "INVALID_COMMAND" };
  if (has(args, "--allow-payment")) return { ...base, ok: false, errorCode: "PAYMENT_PATH_PROHIBITED", paymentCalls: 0 };
  if (flag(args, "--http-status") === "402") return { ...base, ok: false, errorCode: "PAYMENT_REQUIRED_FAIL_CLOSED", paymentCalls: 0 };
  if (command === "doctor") {
    const operation = deps.operations?.doctor;
    if (!operation) return { ...base, ok: false, errorCode: "RESTART_RESUME_RECOVERY_UNAVAILABLE", networkDefault: "deny", paymentPath: "absent", providerCalls: 0, paymentCalls: 0, beaconCalls: 0 };
    try { return { ...base, ok: true, networkDefault: "deny", paymentPath: "absent", providerCalls: 0, paymentCalls: 0, beaconCalls: 0, ...await operation({ args, files: {} }) }; }
    catch (error) { return { ...base, ok: false, errorCode: error instanceof Error ? error.message : "RELIABILITY_OPERATION_FAILED", providerCalls: 0, paymentCalls: 0, beaconCalls: 0 }; }
  }
  if (command === "dry") return { ...base, ok: true, simulated: true, providerCalls: 0, paymentCalls: 0, beaconCalls: 0, plannedFresh: 100, plannedReplays: 20 };
  if (command === "setup" || command === "worker") {
    const operation = deps.operations?.[command];
    if (!operation) return { ...base, ok: false, errorCode: "RELIABILITY_SERVICE_REQUIRED", providerCalls: 0, paymentCalls: 0, beaconCalls: 0 };
    try { return { ...base, ok: true, ...await operation({ args, files: {} }) }; }
    catch (error) { return { ...base, ok: false, errorCode: error instanceof Error ? error.message : "RELIABILITY_OPERATION_FAILED", providerCalls: 0, paymentCalls: 0, beaconCalls: 0 }; }
  }
  if (command === "seal") {
    const beacon = flag(args, "--beacon-file");
    if (!beacon) return { ...base, ok: false, errorCode: "LOCAL_BEACON_REQUIRED", beaconCalls: 0 };
    let beaconBytes: Buffer;
    try { beaconBytes = await (deps.readLocal ?? ((path: string) => readFile(resolve(deps.cwd ?? process.cwd(), path))))(beacon); }
    catch { return { ...base, ok: false, errorCode: "LOCAL_INPUT_REQUIRED", beaconCalls: 0 }; }
    const operation = deps.operations?.seal;
    if (!operation) return { ...base, ok: false, errorCode: "RELIABILITY_SERVICE_REQUIRED", beaconCalls: 0 };
    try { return { ...base, ok: true, ...await operation({ args, files: { beacon: beaconBytes } }) }; }
    catch (error) { return { ...base, ok: false, errorCode: error instanceof Error ? error.message : "RELIABILITY_OPERATION_FAILED", beaconCalls: 0 }; }
  }
  if (command === "run" || command === "reconcile" || command === "replay") {
    const purposeFlag = command === "run" ? "--allow-provider-network"
      : command === "reconcile" ? "--allow-reconciliation-network" : "--allow-replay-network";
    if (!has(args, purposeFlag)) return { ...base, ok: false, errorCode: "NETWORK_DEFAULT_DENY", providerCalls: 0 };
    const plan = flag(args, "--plan");
    if (!plan) return { ...base, ok: false, errorCode: "PLAN_REQUIRED", providerCalls: 0 };
    const read = deps.readLocal ?? ((path: string) => readFile(resolve(deps.cwd ?? process.cwd(), path)));
    let planBytes: Buffer;
    try { planBytes = await read(plan); }
    catch { return { ...base, ok: false, errorCode: "PLAN_REQUIRED", providerCalls: 0 }; }
    const authorizationFlag = command === "reconcile" ? "--reconciliation-authorization" : "--operator-authorization";
    const authorization = flag(args, authorizationFlag);
    if (!authorization) {
      if(command==="run"&&deps.durableRunPredecision&&deps.operations?.run){
        try{return {...base,ok:true,...await deps.operations.run({args,files:{plan:planBytes}})};}
        catch(error){return {...base,ok:false,errorCode:error instanceof Error?error.message:"RELIABILITY_OPERATION_FAILED",providerCalls:0};}
      }
      return { ...base, ok: false, errorCode: command === "reconcile" ? "SIGNED_RECONCILIATION_AUTHORIZATION_REQUIRED" : "SIGNED_AUTHORIZATION_REQUIRED", providerCalls: 0 };
    }
    let authorizationBytes: Buffer;
    try { authorizationBytes = await read(authorization); }
    catch {
      if(command==="run"&&deps.durableRunPredecision&&deps.operations?.run){
        try{return {...base,ok:true,...await deps.operations.run({args,files:{plan:planBytes}})};}
        catch(error){return {...base,ok:false,errorCode:error instanceof Error?error.message:"RELIABILITY_OPERATION_FAILED",providerCalls:0};}
      }
      return { ...base, ok: false, errorCode: "SIGNED_AUTHORIZATION_REQUIRED", providerCalls: 0 };
    }
    const files: Record<string, Buffer> = { plan: planBytes, authorization: authorizationBytes };
    if (command === "run") {
      const reconciliation = flag(args, "--reconciliation-authorization");
      if (!reconciliation) {
        if(deps.durableRunPredecision&&deps.operations?.run){
          try{return {...base,ok:true,...await deps.operations.run({args,files})};}
          catch(error){return {...base,ok:false,errorCode:error instanceof Error?error.message:"RELIABILITY_OPERATION_FAILED",providerCalls:0};}
        }
        return { ...base, ok: false, errorCode: "SIGNED_RECONCILIATION_AUTHORIZATION_REQUIRED", providerCalls: 0 };
      }
      try { files.reconciliationAuthorization = await read(reconciliation); }
      catch {
        if(deps.durableRunPredecision&&deps.operations?.run){
          try{return {...base,ok:true,...await deps.operations.run({args,files})};}
          catch(error){return {...base,ok:false,errorCode:error instanceof Error?error.message:"RELIABILITY_OPERATION_FAILED",providerCalls:0};}
        }
        return { ...base, ok: false, errorCode: "SIGNED_RECONCILIATION_AUTHORIZATION_REQUIRED", providerCalls: 0 };
      }
    }
    const operation = deps.operations?.[command];
    if (!operation) return { ...base, ok: false, errorCode: "RELIABILITY_SERVICE_REQUIRED", providerCalls: 0 };
    try {
      const output = await operation({ args, files });
      if(output["passed"]===false)return {...base,...output,ok:false,errorCode:"AUTHORITATIVE_EVIDENCE_FAILED"};
      return { ...base, ok: true, ...output };
    } catch (error) {
      return { ...base, ok: false, errorCode: error instanceof Error ? error.message : "RELIABILITY_OPERATION_FAILED" };
    }
  }
  const operation = deps.operations?.[command as ReliabilityCliCommand];
  if (!operation) return { ...base, ok: false, errorCode: "RELIABILITY_SERVICE_REQUIRED", providerCalls: 0 };
  try { const output=await operation({ args, files: {} }); if(output["passed"]===false)return {...base,...output,ok:false,errorCode:"AUTHORITATIVE_EVIDENCE_FAILED"}; return { ...base, ok: true, ...output }; }
  catch (error) { return { ...base, ok: false, errorCode: error instanceof Error ? error.message : "RELIABILITY_OPERATION_FAILED" }; }
}
