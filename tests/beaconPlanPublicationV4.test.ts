import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as publication from "../src/evidence/beaconPlanPublicationV4.js";

const roots:string[]=[];
const makeRoot=async()=>{const root=await mkdtemp(join(tmpdir(),"fuse-v4-publication-"));roots.push(root);return root;};
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

const input={
  runId:"hov4-publication-test",
  profileFingerprint:"sha256:fbb455b9faa778aef5b00bce3422fbcef3dcef74e25526132fcda04c6dd2f434",
  planFingerprint:`sha256:${"a".repeat(64)}`,
  beaconBytes:Buffer.from('{"round":6355320}\n'),
  planBytes:Buffer.from('{"protocolVersion":4}\n'),
};

describe("v4 beacon-plan publication intent",()=>{
  it("commits the exact intent before either member and recovers byte-identically",async()=>{
    expect(publication.buildBeaconPlanPublicationIntent).toBeTypeOf("function");
    expect(publication.publishBeaconPlanPair).toBeTypeOf("function");
    const root=await makeRoot();
    const intent=publication.buildBeaconPlanPublicationIntent!(input);
    await expect(publication.publishBeaconPlanPair!(root,intent,{afterIntentSync:()=>{throw new Error("crash-after-intent");}})).rejects.toThrow("crash-after-intent");
    const intentPath=join(root,"evidence/held-out-reliability-v4/publication-intents/beacon-plan/hov4-publication-test.json");
    expect(JSON.parse(await readFile(intentPath,"utf8"))).toEqual(intent);
    await publication.publishBeaconPlanPair!(root,intent);
    expect(await readFile(join(root,intent.members[0].destination))).toEqual(input.beaconBytes);
    expect(await readFile(join(root,intent.members[1].destination))).toEqual(input.planBytes);
  });

  it("recovers when a crash leaves only a fully synced member preparation",async()=>{
    const root=await makeRoot();
    const intent=publication.buildBeaconPlanPublicationIntent!(input);
    await expect(publication.publishBeaconPlanPair!(root,intent,{afterBeaconPrepareSync:()=>{throw new Error("crash-before-beacon-commit");}} as never))
      .rejects.toThrow("crash-before-beacon-commit");
    await expect(readFile(join(root,intent.members[0].destination))).rejects.toMatchObject({code:"ENOENT"});
    const lockPath=join(root,`${intent.members[0].destination}.write-lock`);
    await expect(publication.publishBeaconPlanPair!(root,intent)).rejects.toThrow("BEACON_PLAN_WRITE_LOCK_CONFLICT");
    await rm(lockPath);
    await publication.publishBeaconPlanPair!(root,intent);
    expect(await readFile(join(root,intent.members[0].destination))).toEqual(input.beaconBytes);
    expect(await readFile(join(root,intent.members[1].destination))).toEqual(input.planBytes);
  });

  it("fails closed on an orphaned adjacent write lock",async()=>{
    const root=await makeRoot();
    const intent=publication.buildBeaconPlanPublicationIntent!(input);
    const beaconPath=join(root,intent.members[0].destination);
    const {mkdir}=await import("node:fs/promises");
    await mkdir(join(beaconPath,".."),{recursive:true});
    await writeFile(`${beaconPath}.write-lock`,"orphan");
    await expect(publication.publishBeaconPlanPair!(root,intent)).rejects.toThrow("BEACON_PLAN_WRITE_LOCK_CONFLICT");
  });

  it("rejects a wrong transaction ID and conflicting existing member bytes",async()=>{
    const root=await makeRoot();
    const intent=publication.buildBeaconPlanPublicationIntent!(input);
    await expect(publication.publishBeaconPlanPair!(root,{...intent,transactionId:`sha256:${"0".repeat(64)}`})).rejects.toThrow("BEACON_PLAN_TRANSACTION_ID_INVALID");
    const beaconPath=join(root,intent.members[0].destination);
    await writeFile(beaconPath,"conflict",{recursive:false} as never).catch(async()=>{
      const {mkdir}=await import("node:fs/promises");await mkdir(join(beaconPath,".."),{recursive:true});
    });
    const {mkdir}=await import("node:fs/promises");await mkdir(join(root,"evidence/held-out-reliability-v4/beacons"),{recursive:true});
    await writeFile(beaconPath,"conflict");
    await expect(publication.publishBeaconPlanPair!(root,intent)).rejects.toThrow("BEACON_PLAN_MEMBER_CONFLICT");
    await expect(readFile(`${beaconPath}.write-lock`)).resolves.toBeDefined();
  });
});
