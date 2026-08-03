import { describe, expect, it, vi } from "vitest";
import { ReliabilityProtocolStore } from "../src/reliability/protocolStore.js";
import * as protocolStoreModule from "../src/reliability/protocolStore.js";
import { RELIABILITY_V3_PROFILE } from "../src/reliability/protocolProfile.js";

const sha=(value:string)=>`sha256:${value.repeat(64)}`;

describe("v3 sequenced report intent authority",()=>{
  it("classifies the half-open publication deadline for pass and failure intents",()=>{
    const classify=(protocolStoreModule as unknown as Record<string,unknown>)["reportPublicationDeadlineDisposition"];
    expect(classify).toBeTypeOf("function");
    const invoke=classify as (input:{reportKind:"pass"|"failure";databaseNowMs:number;deadlineMs:number})=>string;
    expect(invoke({reportKind:"pass",databaseNowMs:999,deadlineMs:1000})).toBe("on_time");
    expect(invoke({reportKind:"pass",databaseNowMs:1000,deadlineMs:1000})).toBe("supersede_pass");
    expect(invoke({reportKind:"failure",databaseNowMs:1000,deadlineMs:1000})).toBe("late_failure");
  });

  it("deduplicates exact bytes but allocates and supersedes for a distinct failure",async()=>{
    const statements:string[]=[];
    const records:Array<Record<string,unknown>>=[];
    let nextIntent=1;
    const client={query:vi.fn(async(sql:string,values:unknown[]=[]):Promise<{rows:any[]}>=>{
      statements.push(sql);
      if(sql.includes("FROM reliability_protocol_controls")&&sql.includes("FOR UPDATE"))return {rows:[{
        state:"failed",durable_stage:"running",plan_fingerprint:sha("a"),failure_sequence:"1",reconciliation_credential_id:null,
        nonusable_allowance_owner:null,protocol_version:3,evidence_type:RELIABILITY_V3_PROFILE.evidenceType,
        plan_schema_version:RELIABILITY_V3_PROFILE.planSchemaVersion,mapping_version:RELIABILITY_V3_PROFILE.mappingVersion,
        profile_fingerprint:RELIABILITY_V3_PROFILE.profileFingerprint,
      }]};
      if(sql.includes("FROM reliability_report_publication_outbox")&&sql.includes("ORDER BY intent_sequence DESC"))
        return {rows:records.length?[records.at(-1)]:[]};
      if(sql.includes("SELECT clock_timestamp() now"))return {rows:[{now:new Date("2026-08-05T09:30:00.250Z")}]};
      if(sql.includes("FROM reliability_artifact_bindings"))return {rows:[{path:"evidence/a.json",digest:sha("b")}]};
      if(sql.includes("next_report_intent_sequence=next_report_intent_sequence+1"))return {rows:[{intent_sequence:String(nextIntent++)}]};
      if(sql.includes("INSERT INTO reliability_report_publication_outbox")){
        records.push({intent_sequence:String(values[1]),profile_fingerprint:values[2],report_kind:values[3],destination:values[4],report_sha256:values[5],
          report_bytes_base64:values[6],intent_path:values[7],intent_sha256:values[8],intent_bytes_base64:values[9],
          artifact_inventory_sha256:values[10],accepted_snapshot_sha256:values[11],committed_at:values[12],
          publication_deadline:values[13],supersedes_intent_sequence:values[14],state:"committed",next_event_sequence:"1"});
        return {rows:[]};
      }
      if(sql.includes("SET state=$3,next_event_sequence=next_event_sequence+1")){
        const record=records.find(row=>Number(row.intent_sequence)===Number(values[1]));
        if(record)record.state=values[2];
        return {rows:[{event_sequence:String(values[2]==="superseded"?2:1)}]};
      }
      return {rows:[]};
    })};
    const store=new ReliabilityProtocolStore({query:client.query} as never);
    const commit=(store as unknown as Record<string,unknown>)["commitReportIntentLocked"] as (client:unknown,input:unknown)=>Promise<number>;
    const base={runId:"hov3-report-sequence",reportKind:"failure",incidentSequence:1,acceptedSnapshotSha256:null};
    await expect(commit.call(store,client,{...base,reasonCode:"FIRST_FAILURE"})).resolves.toBe(1);
    await expect(commit.call(store,client,{...base,reasonCode:"FIRST_FAILURE"})).resolves.toBe(1);
    await expect(commit.call(store,client,{...base,incidentSequence:2,reasonCode:"SECOND_FAILURE"})).resolves.toBe(2);

    expect(records).toHaveLength(2);
    expect(records[0]?.state).toBe("superseded");
    expect(records[1]?.supersedes_intent_sequence).toBe(1);
    expect(statements.filter(sql=>sql.includes("next_report_intent_sequence=next_report_intent_sequence+1"))).toHaveLength(2);
    expect(client.query.mock.calls.some(([,values])=>values?.[2]==="superseded")).toBe(true);
  });
});
