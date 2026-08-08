import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "./heldOutReliabilityV2.js";
import { RELIABILITY_V4_PROFILE } from "../reliability/protocolProfile.js";

export interface BeaconPlanMember { kind:"beacon"|"plan"; destination:string; sha256:string; bytesBase64:string }
export interface BeaconPlanPublicationIntent { schemaVersion:1; evidenceType:"held-out-reliability-v4"; protocolVersion:4; runId:string; profileFingerprint:string; transactionId:string; members:readonly [BeaconPlanMember,BeaconPlanMember] }
export interface BeaconPlanPublicationOptions { afterIntentSync?:()=>void|Promise<void>; afterBeaconPrepareSync?:()=>void|Promise<void>; afterBeaconSync?:()=>void|Promise<void> }

const SHA=/^sha256:[a-f0-9]{64}$/;
const digest=(bytes:Buffer)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const exactKeys=(value:Record<string,unknown>,keys:readonly string[])=>{
  const actual=Object.keys(value).sort();const expected=[...keys].sort();
  return actual.length===expected.length&&actual.every((key,index)=>key===expected[index]);
};
const transactionPreimage=(intent:Omit<BeaconPlanPublicationIntent,"transactionId">)=>canonicalJson(intent);

export function buildBeaconPlanPublicationIntent(input:{runId:string;profileFingerprint:string;planFingerprint:string;beaconBytes:Buffer;planBytes:Buffer}):BeaconPlanPublicationIntent {
  if(!/^hov4-[A-Za-z0-9._:-]{1,97}$/.test(input.runId)||input.profileFingerprint!==RELIABILITY_V4_PROFILE.profileFingerprint||!SHA.test(input.planFingerprint))
    throw new Error("BEACON_PLAN_IDENTITY_INVALID");
  const base:Omit<BeaconPlanPublicationIntent,"transactionId">={
    schemaVersion:1,evidenceType:"held-out-reliability-v4",protocolVersion:4,runId:input.runId,profileFingerprint:input.profileFingerprint,
    members:[
      {kind:"beacon",destination:`evidence/held-out-reliability-v4/beacons/drand-${RELIABILITY_V4_PROFILE.beaconRound}.json`,sha256:digest(input.beaconBytes),bytesBase64:input.beaconBytes.toString("base64")},
      {kind:"plan",destination:`evidence/held-out-reliability-v4/plans/${input.planFingerprint}.json`,sha256:digest(input.planBytes),bytesBase64:input.planBytes.toString("base64")},
    ],
  };
  return {...base,transactionId:digest(Buffer.from(transactionPreimage(base),"utf8"))};
}

function validateIntent(intent:BeaconPlanPublicationIntent):void {
  if(!exactKeys(intent as unknown as Record<string,unknown>,["schemaVersion","evidenceType","protocolVersion","runId","profileFingerprint","transactionId","members"])
    ||intent.schemaVersion!==1||intent.evidenceType!=="held-out-reliability-v4"||intent.protocolVersion!==4
    ||!/^hov4-[A-Za-z0-9._:-]{1,97}$/.test(intent.runId)||intent.profileFingerprint!==RELIABILITY_V4_PROFILE.profileFingerprint
    ||!Array.isArray(intent.members)||intent.members.length!==2)throw new Error("BEACON_PLAN_INTENT_INVALID");
  const [beacon,plan]=intent.members;
  const expectedBeacon=`evidence/held-out-reliability-v4/beacons/drand-${RELIABILITY_V4_PROFILE.beaconRound}.json`;
  if(beacon.kind!=="beacon"||beacon.destination!==expectedBeacon||plan.kind!=="plan"
    ||!/^evidence\/held-out-reliability-v4\/plans\/sha256:[a-f0-9]{64}\.json$/.test(plan.destination))throw new Error("BEACON_PLAN_DESTINATION_INVALID");
  for(const member of intent.members){
    if(!exactKeys(member as unknown as Record<string,unknown>,["kind","destination","sha256","bytesBase64"])||!SHA.test(member.sha256))throw new Error("BEACON_PLAN_MEMBER_INVALID");
    let bytes:Buffer;try{bytes=Buffer.from(member.bytesBase64,"base64");}catch{throw new Error("BEACON_PLAN_MEMBER_INVALID");}
    if(bytes.toString("base64")!==member.bytesBase64||digest(bytes)!==member.sha256)throw new Error("BEACON_PLAN_MEMBER_DIGEST_INVALID");
  }
  const {transactionId,...base}=intent;
  if(transactionId!==digest(Buffer.from(transactionPreimage(base),"utf8")))throw new Error("BEACON_PLAN_TRANSACTION_ID_INVALID");
}

async function syncDirectory(path:string):Promise<void>{const handle=await open(path,"r");try{await handle.sync();}finally{await handle.close();}}
async function publishExact(path:string,bytes:Buffer,conflictCode:string,afterPrepareSync?:()=>void|Promise<void>):Promise<void>{
  const directory=dirname(path);await mkdir(directory,{recursive:true,mode:0o700});
  const lockPath=`${path}.write-lock`;
  const preparedPath=`${path}.prepared-${randomUUID()}`;
  const lock=await open(lockPath,"wx",0o600).catch((error:unknown)=>{
    if(error&&typeof error==="object"&&"code" in error&&error.code==="EEXIST")throw new Error("BEACON_PLAN_WRITE_LOCK_CONFLICT");
    throw error;
  });
  try{
    await lock.writeFile(`${canonicalJson({schemaVersion:1,evidenceType:"held-out-reliability-v4",protocolVersion:4,destination:path,sha256:digest(bytes)})}\n`);
    await lock.sync();
  }finally{await lock.close();}
  await syncDirectory(directory);
  const prepared=await open(preparedPath,"wx",0o600);
  try{await prepared.writeFile(bytes);await prepared.sync();}finally{await prepared.close();}
  await afterPrepareSync?.();
  let published=false;
  try{
    try{await link(preparedPath,path);}
    catch(error){if(!error||typeof error!=="object"||!("code" in error)||error.code!=="EEXIST")throw error;const existing=await readFile(path);if(!existing.equals(bytes))throw new Error(conflictCode);}
    await syncDirectory(directory);
    published=true;
  }finally{
    await rm(preparedPath,{force:true});
    if(published)await rm(lockPath,{force:true});
    await syncDirectory(directory);
  }
}

export async function publishBeaconPlanPair(root:string,intent:BeaconPlanPublicationIntent,options:BeaconPlanPublicationOptions={}):Promise<void>{
  validateIntent(intent);
  const intentPath=join(root,`evidence/held-out-reliability-v4/publication-intents/beacon-plan/${intent.runId}.json`);
  await publishExact(intentPath,Buffer.from(`${canonicalJson(intent)}\n`,"utf8"),"BEACON_PLAN_INTENT_CONFLICT");
  await options.afterIntentSync?.();
  await publishExact(join(root,intent.members[0].destination),Buffer.from(intent.members[0].bytesBase64,"base64"),"BEACON_PLAN_MEMBER_CONFLICT",options.afterBeaconPrepareSync);
  await options.afterBeaconSync?.();
  await publishExact(join(root,intent.members[1].destination),Buffer.from(intent.members[1].bytesBase64,"base64"),"BEACON_PLAN_MEMBER_CONFLICT");
}
