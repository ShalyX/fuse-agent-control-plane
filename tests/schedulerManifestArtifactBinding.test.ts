import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { reconstructSchedulerManifestArtifacts } from "../src/evidence/artifactReconstruction.js";

const roots:string[]=[];
afterEach(async()=>Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))));
const sha=(bytes:string)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("v3 scheduler manifest artifact authority",()=>{
  it("accepts only the exact fsynced scheduler bytes named by the durable claim",async()=>{
    const root=await mkdtemp(join(tmpdir(),"scheduler-artifact-"));roots.push(root);
    const runId="hov3-scheduler-binding",requestId="request-1";
    const path=`evidence/held-out-reliability-v3/scheduler-manifests/${runId}/${requestId}.json`;
    const artifact={evidenceType:"held-out-reliability-v3",protocolVersion:3,planFingerprint:`sha256:${"a".repeat(64)}`,
      artifactKind:"scheduler_manifest",state:"terminal",sequence:4,runId,requestId,laneId:"restart-resume",block:2,ownerId:"owner",generation:1};
    const bytes=`${JSON.stringify(artifact)}\n`;await mkdir(join(root,path,".."),{recursive:true});await writeFile(join(root,path),bytes);
    const claims=[{requestId,lane:"restart-resume",block:2,state:"terminal",generation:1,manifestPath:path,manifestDigest:sha(bytes),manifestFsynced:true}];
    await expect(reconstructSchedulerManifestArtifacts({root,runId,planFingerprint:artifact.planFingerprint,claims})).resolves.toMatchObject([{path,digest:sha(bytes)}]);
    await writeFile(join(root,path),`${JSON.stringify({...artifact,state:"claimed",sequence:1})}\n`);
    await expect(reconstructSchedulerManifestArtifacts({root,runId,planFingerprint:artifact.planFingerprint,claims})).rejects.toThrow("SCHEDULER_MANIFEST_AUTHORITY_CONFLICT");
  });
});
