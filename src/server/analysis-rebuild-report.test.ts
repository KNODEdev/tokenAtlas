import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../db/migrate";
import { installAnalysisTracking } from "../db/analysis";
import { writeRebuildStatusJson } from "../db/rebuild-status";
import { prepareUsageRegisters } from "./usage-register.fixture";
import type { RateCard } from "./pricing";
import type { SyncRunResult } from "../sync/contracts";
import { recordSourceAttemptInReport } from "./analysis-rebuild-report";
import { unchangedSourceImpact } from "../sync/source-impact";
import {
  analysisRebuildStatus,
  completeAnalysisRebuild,
  queueAnalysisRebuild,
  recordAnalysisRebuildSources,
  resumeAnalysisRebuild,
  runAnalysisRebuild,
  updateAnalysisRebuild,
} from "./analysis-rebuild";

const now=new Date("2026-09-16T12:00:00.000Z");
const CARD=JSON.parse(fs.readFileSync(path.resolve(import.meta.dir,"../../rate-cards.json"),"utf8")) as RateCard;
/** The maintenance worker's part: the ledgers follow the facts before a report captures their sums. */
const prepare=(db:Database)=>prepareUsageRegisters(db,CARD);
function fixture(file=":memory:") {
  const db=new Database(file);applyDrizzleMigrations(drizzle(db));
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  db.exec(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES
    ('pc','large','large','2026-09-09T12:00:00.000Z',9007199254740991),
    ('pc','two','two','2026-09-10T12:00:00.000Z',2)`);
  installAnalysisTracking(db);prepare(db);
  return db;
}
function revisions(data:number,config:number) {
  return {data,config,vendors:{codex:0,claude:data,opencode:0,grok:0,gemini:0,gauges:0}};
}

test("selected reset report keeps both aggregate boundaries inside the declared vendors",()=>{
  const db=fixture();
  try {
    db.exec(`INSERT INTO gemini_events(store,conversation_id,gen_idx,ts,ts_basis,path,fresh_in,out_total)
      VALUES('other','outside',1,'2026-09-10T12:00:00Z','source','other.json',777,0)`);
    prepare(db);
    const job=queueAnalysisRebuild(db,{scope:"all",vendors:["claude"]},now);
    expect(job.report!.requested.vendors).toEqual(["claude"]);
    expect(job.report!.aggregates.before.vendors.map(row=>row.vendor)).toEqual(["claude"]);
    expect(job.report!.aggregates.before.vendors[0]!.metrics.uncached!.value).toBe("9007199254740993");
    runAnalysisRebuild(db, { subscriptions: [], sources: [] });
    updateAnalysisRebuild(db,job.generation,{completed:3,total:3});
    completeAnalysisRebuild(db,job.generation);
    const report=analysisRebuildStatus(db)!.report!;
    expect(report.aggregates.after!.vendors.map(row=>row.vendor)).toEqual(["claude"]);
    expect(report.aggregates.delta!.vendors[0]!.metrics.uncached!.value).toBe("0");
  } finally {db.close();}
});

test("report reads Gemini and OpenCode in the ledgers' token buckets",()=>{
  const db=fixture();
  try {
    db.exec(`INSERT INTO gemini_events(store,conversation_id,gen_idx,ts,ts_basis,path,fresh_in,cached_in,out_total,out_thinking)
      VALUES('gemini','conversation',1,'2026-09-10T12:00:00Z','source','gemini.json',101,23,47,11);
      INSERT INTO oc_events(store,message_id,ts,in_tok,cache_read,cache_write,out_tok,reasoning)
      VALUES('oc','message','2026-09-10T12:00:00Z',109,29,7,53,13)`);
    prepare(db);
    const job=queueAnalysisRebuild(db,{scope:"custom",from:"2026-09-09",until:"2026-09-10"},now);
    const values=(vendor:string)=>Object.fromEntries(
      Object.entries(job.report!.aggregates.before.vendors.find(row=>row.vendor===vendor)!.metrics)
        .map(([key,value])=>[key,value.value]));
    const zero={write_5m:"0",write_1h:"0"};
    expect(values("gemini")).toEqual({calls:"1",uncached:"101",cache_read:"23",out:"47",thinking:"11",write_unknown:"0",...zero});
    // OpenCode output includes its reasoning; the write's duration is unknown.
    expect(values("opencode")).toEqual({calls:"1",uncached:"109",cache_read:"29",write_unknown:"7",out:"66",thinking:"13",...zero});
  } finally {db.close();}
});

test("source report retains unknown influence and compares actual UTC instants across timestamp formats",()=>{
  const db=fixture();
  try {
    const job=queueAnalysisRebuild(db,{scope:"custom",from:"2026-09-09",until:"2026-09-10",mode:"archive"},now,true);
    const result=syncResult(job.generation,1,true);
    result.vendors[0]!.dirtyRange={from:"2026-09-09T00:00:00.000000Z",to:"2026-09-11T01:00:00+02:00"};
    const report=recordSourceAttemptInReport(db,job.report!,result,[],0,now);
    expect(report.dependencyExpansion.outsideRequested).toEqual([]);
    result.runId="unknown-window";result.vendors[0]!.dirtyRange=null;
    const unknown=recordSourceAttemptInReport(db,report,result,[],0,now);
    expect(unknown.unresolvedDirtyVendors).toEqual(["claude"]);
    expect(unknown.resolvedDirtyRanges).toEqual(report.resolvedDirtyRanges);
    updateAnalysisRebuild(db,job.generation,{phase:"summaries"});
    expect(recordAnalysisRebuildSources(db,job.generation,result,[],0)).toBe(false);
  } finally {db.close();}
});
function syncResult(generation:number,attempt:number,success:boolean):SyncRunResult {
  return {runId:`attempt-${attempt}`,trigger:"manual",scope:{kind:"all"},mode:"incremental",rebuildGeneration:generation,
    rebuildConfiguration:`config-${attempt}`,startedAt:`2026-09-1${attempt}T01:00:00.000Z`,finishedAt:`2026-09-1${attempt}T01:01:00.000Z`,
    status:success?"success":"partial_success",beforeRevisions:revisions(attempt,7),afterRevisions:revisions(attempt+1,7),
    changedConfigDomains:[],aggregateWorkRequested:success,vendors:[{vendor:"claude",status:success?"success":"failure",
      processedInputs:success?2:1,skippedInputs:success?3:0,writtenRows:success?4:0,dataChanged:success,
      dirtyRange:attempt===1?{from:"2026-09-08T23:59:59.500Z",to:"2026-09-09T00:00:00.250Z"}
        :{from:"2026-09-10T23:59:59.750Z",to:"2026-09-11T00:00:00.500Z"},
      error:success?null:"source unavailable",startedAt:`2026-09-1${attempt}T01:00:00.000Z`,finishedAt:`2026-09-1${attempt}T01:01:00.000Z`,
      diagnostics:success?{warnings:["partial archive warning"]}:{warnings:["partial archive warning"],reparse:{unavailable:[{store:"pc",path:"missing.jsonl"}]}}}],
    error:success?null:"source unavailable"};
}

test("source impact stays attached to its attempt without inventing canonical counts or summing retries",()=>{
  const db=fixture();
  try {
    const job=queueAnalysisRebuild(db,{scope:"all"},now);
    const first=syncResult(job.generation,1,true);
    const impact=unchangedSourceImpact();
    impact.scope="published-source-identities";
    impact.sourceFactsChanged={status:"available",value:"9007199254740993",reason:null};
    impact.sourceCorrections={status:"available",value:"1",reason:null};
    first.vendors[0]!.sourceImpact=impact;
    const recorded=recordSourceAttemptInReport(db,job.report!,first,[],0,now);
    impact.sourceFactsChanged.value="altered-after-capture";
    expect(recorded.sources[0]!.sourceImpact.sourceFactsChanged.value).toBe("9007199254740993");
    expect(recorded.sources[0]!.counters.corrections).toEqual({value:"1",reason:null,meaning:"source-record-semantic-corrections"});
    expect(recorded.unknownSourceMetrics.basis).toBe("cross-copy-canonical-impact");
    const retry=syncResult(job.generation,2,true);retry.vendors[0]!.sourceImpact=unchangedSourceImpact();
    const replayed=recordSourceAttemptInReport(db,recorded,retry,[],0,now);
    expect(replayed.sources[0]!.sourceImpact.sourceFactsChanged.value).toBe("0");
    expect(replayed.sourceAttempts[0]!.sourceImpacts![0]!.impact.sourceFactsChanged.value).toBe("9007199254740993");
    expect(replayed.sources[0]!.sourceImpact.canonicalFacts.status).toBe("unavailable");
    expect(recordSourceAttemptInReport(db,replayed,retry,[],0,now)).toEqual(replayed);
    const legacy=syncResult(job.generation,3,true);
    expect(recordSourceAttemptInReport(db,replayed,legacy,[],0,now).sources[0]!.sourceImpact.sourceFactsChanged)
      .toEqual({status:"unavailable",value:null,reason:"legacy-sync-result-without-source-impact"});
  } finally {db.close();}
});

test("selected aggregate report adds exactly past 2^53 and completes only at the durable readiness gate",()=>{
  const db=fixture();
  try {
    const job=queueAnalysisRebuild(db,{scope:"custom",from:"2026-09-09",until:"2026-09-10"},now);
    const before=analysisRebuildStatus(db)!.report!.aggregates.before;
    expect(before).toMatchObject({status:"captured",verification:"verified-current",
      source:{table:"ledgers",scope:"declared-selected-scope"}});
    const claude=before.vendors.find(row=>row.vendor==="claude")!;
    expect(claude.metrics.uncached).toEqual({status:"available",value:"9007199254740993",unit:"integer-count"});
    expect(Object.hasOwn(claude.metrics,"in_tok")).toBe(false);
    expect(analysisRebuildStatus(db)!.report!.aggregates.pricing).toEqual({status:"unavailable",reason:"no-shared-durable-price-aggregate"});
    expect(()=>completeAnalysisRebuild(db,job.generation)).toThrow("not in the running readiness phase");
    expect(analysisRebuildStatus(db)!.report!.ready.status).toBe("pending");

    db.exec("UPDATE claude_events SET in_uncached=CASE call_id WHEN 'large' THEN 4 ELSE 6 END");
    prepare(db);
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
    updateAnalysisRebuild(db,job.generation,{completed:2,total:3});
    expect(()=>completeAnalysisRebuild(db,job.generation)).toThrow("not complete");
    expect(analysisRebuildStatus(db)!.report!.ready.status).toBe("pending");
    updateAnalysisRebuild(db,job.generation,{completed:3});
    expect(completeAnalysisRebuild(db,job.generation)).toBe(true);
    const completed=analysisRebuildStatus(db)!;
    expect(completed.report!.aggregates.after!.vendors.find(row=>row.vendor==="claude")!.metrics.uncached!.value).toBe("10");
    expect(completed.report!.aggregates.delta!.vendors.find(row=>row.vendor==="claude")!.metrics.uncached!.value).toBe("-9007199254740983");
    expect(completed.report!.ready).toMatchObject({status:"ready",gate:"derived-registers-current",completed:3,total:3});

  } finally {db.close();}
});

test("source retries retain their first baseline, cumulative dirty influence and failed evidence across reopen without accepting stale generations",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-rebuild-report-")),file=path.join(root,"atlas.sqlite");
  let db=fixture(file);
  try {
    const job=queueAnalysisRebuild(db,{scope:"custom",from:"2026-09-09",until:"2026-09-10",mode:"archive"},now,true);
    updateAnalysisRebuild(db,job.generation,{state:"running"});
    const first=syncResult(job.generation,1,false);
    expect(recordAnalysisRebuildSources(db,job.generation,first,["claude: partial archive warning","claude: 1 source files unavailable"],1)).toBe(true);
    expect(recordAnalysisRebuildSources(db,job.generation,{...first,rebuildGeneration:job.generation+1,runId:"wrong-generation"},[],0)).toBe(false);
    updateAnalysisRebuild(db,job.generation,{state:"error",error:"source unavailable"});
    expect(analysisRebuildStatus(db)!.report).toMatchObject({
      inputs:{firstAttemptBeforeRevisions:revisions(1,7)},
      sources:[{vendor:"claude",gaps:{count:1,provenance:"diagnostics.reparse.unavailable"}}],
      sourceAttemptTotals:{attempts:1,failures:1,gapOccurrences:1},
      ready:{status:"pending"},
    });

    db.close();db=new Database(file);
    expect(analysisRebuildStatus(db)!.report!.sources[0]!.gaps.count).toBe(1);
    resumeAnalysisRebuild(db);updateAnalysisRebuild(db,job.generation,{state:"running"});
    const second=syncResult(job.generation,2,true);
    expect(recordAnalysisRebuildSources(db,job.generation,second,["claude: partial archive warning"],0)).toBe(true);
    updateAnalysisRebuild(db,job.generation,{state:"queued",phase:"summaries",error:null});
    const report=analysisRebuildStatus(db)!.report!;
    expect(report.inputs).toEqual({firstAttemptBeforeRevisions:revisions(1,7),latestAfterRevisions:revisions(3,7),
      latestRebuildConfiguration:"config-2"});
    expect(report.sources[0]).toMatchObject({vendor:"claude",status:"success",
      counters:{processedInputs:{value:2},skippedInputs:{value:3},adapterWrittenRows:{value:4},canonicalFacts:{value:null},duplicates:{value:null},corrections:{value:null}}});
    expect(report.sourceAttemptTotals).toMatchObject({attempts:2,successes:1,failures:1,gapOccurrences:1});
    expect(report.resolvedDirtyRanges).toEqual([
      {vendor:"claude",from:"2026-09-08T23:59:59.500Z",to:"2026-09-09T00:00:00.250Z"},
      {vendor:"claude",from:"2026-09-10T23:59:59.750Z",to:"2026-09-11T00:00:00.500Z"},
    ]);
    expect(report.dependencyExpansion).toEqual({basis:"actual-source-dirty-ranges",outsideRequested:[
      {vendor:"claude",from:"2026-09-08T23:59:59.500Z",to:"2026-09-09T00:00:00.250Z",outside:"before"},
      {vendor:"claude",from:"2026-09-10T23:59:59.750Z",to:"2026-09-11T00:00:00.500Z",outside:"after"},
    ]});
    // No report is prepared any more, so no revision inventory of prepared reports is recorded.
    expect(report.preparedRevisionCoverage).toBeNull();
    expect(report.phases.sources.totals).toEqual({attempts:2,successes:1,failures:1});
    expect(report.phases.sources.attempts.every(attempt=>attempt.timingSemantics==="wall-clock-including-process-downtime")).toBe(true);

    const legacy={generation:999,scope:job.scope,range:job.range,timeBounds:job.timeBounds,requestedAt:"2000-01-01T00:00:00.000Z",
      state:"queued",phase:"summaries",error:null};
    writeRebuildStatusJson(db,JSON.stringify(legacy));
    updateAnalysisRebuild(db,999,{state:"running"});
    const adopted=analysisRebuildStatus(db)!.report!;
    expect(adopted.adoptedLegacy).toBe(true);
    expect(adopted.requested.requestedAt).toBe("2000-01-01T00:00:00.000Z");
    expect(adopted.aggregates.before).toMatchObject({status:"unavailable",capturedAt:null,verification:"unavailable",reason:"legacy-job-adopted-after-queue-boundary"});
  } finally {
    db.close(true);
    try {fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
    catch(error) {if(process.platform!=="win32" || (error as NodeJS.ErrnoException).code!=="EBUSY")throw error;}
  }
});
