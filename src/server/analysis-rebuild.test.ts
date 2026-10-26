import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../db/migrate";
import { installAnalysisTracking } from "../db/analysis";
import { advanceRebuildReadiness, analysisRebuildStatus, queueAnalysisRebuild, REBUILD_REGISTERS, resumeAnalysisRebuild, runAnalysisRebuild, updateAnalysisRebuild } from "./analysis-rebuild";
import { startAnalysisMaintenance } from "./analysis-maintenance";
import {buildEraIndex} from "./eras";
import {type AppContext,advanceAnalysisRebuildSources} from "./api";
import {type SyncRunResult} from "../sync/contracts";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import { writeRebuildStatusJson } from "../db/rebuild-status";

const now=new Date("2026-09-16T12:00:00Z");
function fixture(file=":memory:") {
  const db=new Database(file);applyDrizzleMigrations(drizzle(db));
  const insert=db.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc',?,? ,?,10)");
  for(const day of ["2026-08-17","2026-08-18","2026-09-09","2026-09-10","2026-09-16"])insert.run(day,day,day+"T12:00:00Z");
  db.exec("INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent) VALUES('claude','seat','2026-09-16T11:00:00Z','weekly','used',20)");
  // Every real database has the (here empty) Codex events table: its usage register is then empty, not unavailable.
  db.exec("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,model TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,project_id TEXT)");
  installAnalysisTracking(db);prepareProbeReaderFixture(db, []);
  return db;
}

function context(sqlite:Database,file:string):AppContext {
  return {sqlite,dbPath:file,accounts: { version: 2, subscriptions: [], sources: [] },homeToSubId:new Map(),subIdToHomes:new Map(),eras:buildEraIndex([],"instant"),eraErrors:[],homeConflict:null,
    rateCards:{version:2,currency:"USD",unit:"per 1M",vendors:{}},claudeGauge:{},grokGauge:{},cycles:{},plans:{},plansCatalog:{provider_groups:[]},rootDir:process.cwd(),attribution:null} as AppContext;
}
/** The maintenance worker's turn after the derived registers caught up with the rebuilt facts. */
const caughtUp = { prices: true, limitWindows: true, windowSums: true };
test("custom reset persists inclusive UTC dates, mode and exclusive time boundary",()=>{
  const db=fixture();
  try {
    const job=queueAnalysisRebuild(db,{scope:"custom",from:"2026-09-09",until:"2026-09-10",mode:"collect-archive"},now);
    expect(analysisRebuildStatus(db)).toEqual(job);
    expect(job).toMatchObject({scope:"custom",mode:"collect-archive",requestedAt:now.toISOString(),
      range:{from:"2026-09-09",until:"2026-09-10"},timeBounds:{from:"2026-09-09T00:00:00.000Z",untilExclusive:"2026-09-11T00:00:00.000Z"}});
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
    expect(analysisRebuildStatus(db)).toMatchObject({state:"running",phase:"reports"});
  } finally {db.close();}
});

test("the reports phase completes once the price registers, limit windows and window sums have caught up",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-rebuild-reports-")),file=path.join(root,"test.sqlite");
  let db=fixture(file);
  try {
    queueAnalysisRebuild(db,"week",now);runAnalysisRebuild(db, { subscriptions: [], sources: [] });
    expect(analysisRebuildStatus(db)).toMatchObject({state:"running",phase:"reports",completed:0,total:REBUILD_REGISTERS});
    // Window sums still follow the rebuilt facts: progress is recorded, the job waits.
    expect(advanceRebuildReadiness(db,{...caughtUp,windowSums:false})).toBe(false);
    expect(analysisRebuildStatus(db)).toMatchObject({state:"running",phase:"reports",completed:2,total:3});
    // The progress survives a restart; the next turn with every register caught up completes the job.
    db.close();db=new Database(file);
    expect(analysisRebuildStatus(db)).toMatchObject({state:"running",completed:2});
    expect(advanceRebuildReadiness(db,caughtUp)).toBe(true);
    expect(analysisRebuildStatus(db)).toMatchObject({state:"complete",phase:"reports",completed:3,total:3});
    expect(advanceRebuildReadiness(db,caughtUp)).toBe(false);
  }finally{
    db.close(true);
    try{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
    catch(error){if(process.platform!=="win32" || (error as NodeJS.ErrnoException).code!=="EBUSY")throw error;}
  }
});

for (const failurePhase of ["readings", "runner"] as const) test(`a ${failurePhase} failure retains its rebuild generation and can be resumed`,async()=>{
  const db=fixture(),ctx=context(db,":memory:");
  const job=queueAnalysisRebuild(db,{scope:"7d",mode:"collect-archive"},now,true);
  let fail=true,runnerCalls=0;
  ctx.refreshLiveReadings=async()=>{if(fail && failurePhase==="readings")throw new Error("readings unavailable");};
  ctx.syncRunner=async(_root,_file,request)=>{
    runnerCalls++;
    if(fail && failurePhase==="runner")throw new Error("runner unavailable");
    return {runId:"retry",scope:{kind:"all"},mode:"incremental",status:"success",vendors:[],changedConfigDomains:[],
      rebuildGeneration:request.rebuildGeneration} as unknown as SyncRunResult;
  };
  try {
    await advanceAnalysisRebuildSources(ctx);
    expect(analysisRebuildStatus(db)).toMatchObject({generation:job.generation,state:"error",phase:"sources"});
    expect(analysisRebuildStatus(db)?.error).toContain(`${failurePhase} unavailable`);
    expect(runnerCalls).toBe(failurePhase==="runner"?1:0);
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
    fail=false;
    expect(resumeAnalysisRebuild(db).generation).toBe(job.generation);
    await advanceAnalysisRebuildSources(ctx);
    expect(analysisRebuildStatus(db)).toMatchObject({generation:job.generation,state:"queued",phase:"summaries",error:null});
  }finally{db.close();}
});

test("an unrelated sync surviving restart cannot satisfy source verification",async()=>{
  const db=fixture(),ctx=context(db,":memory:");const job=queueAnalysisRebuild(db,"week",now,true);
  let calls=0;
  ctx.syncRunner=async(_root,_file,request)=>{
    calls++;expect(request.reparse).toEqual(job.range!);
    expect(request.collection).toBe("archive");
    return {runId:"test",scope:{kind:"all"},mode:"incremental",status:"success",vendors:[],changedConfigDomains:[],
      ...(calls>1?{rebuildGeneration:request.rebuildGeneration}:{})} as unknown as SyncRunResult;
  };
  try {
    ctx.refreshLiveReadings=async()=>{throw new Error("Archive rebuild must not poll primary installations");};
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
    await advanceAnalysisRebuildSources(ctx);expect(analysisRebuildStatus(db)).toMatchObject({state:"running",phase:"sources"});
    await advanceAnalysisRebuildSources(ctx);expect(analysisRebuildStatus(db)).toMatchObject({state:"queued",phase:"summaries"});
    expect(calls).toBe(2);
  }finally{db.close();}
});

test("resuming a failed report preserves its generation, completed work and source warnings",()=>{
  const db=fixture();
  try {
    const job=queueAnalysisRebuild(db,"all",now,true);
    updateAnalysisRebuild(db,job.generation,{state:"error",phase:"reports",error:"interrupted",completed:1,total:3,warnings:["offline source"]});
    expect(resumeAnalysisRebuild(db)).toMatchObject({generation:job.generation,state:"running",phase:"reports",error:null,completed:1,total:3,warnings:["offline source"]});
    expect(()=>resumeAnalysisRebuild(db)).toThrow("No failed recalculation");
  }finally{db.close();}
});

test("required offline sources block summaries durably and resume in the same generation",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-rebuild-offline-")),file=path.join(root,"test.sqlite");
  let db=fixture(file),offline=true;
  const runner:NonNullable<AppContext["syncRunner"]>=async(_root,_file,request)=>({
    runId:"source-check",scope:{kind:"all"},mode:"incremental",status:"success",rebuildGeneration:request.rebuildGeneration,
    changedConfigDomains:[],vendors:[{vendor:"claude",status:"success",diagnostics:{
      mirror:{warnings:["optional primary installation absent"]},
      reparse:{unavailable:offline?[{store:"pc",path:"archive/session.jsonl"}]:[]},
    }}],
  } as unknown as SyncRunResult);
  try {
    const facts=db.query("SELECT * FROM claude_events").all();
    const job=queueAnalysisRebuild(db,"all",now,true);
    let ctx=context(db,file);ctx.syncRunner=runner;
    await advanceAnalysisRebuildSources(ctx);
    expect(analysisRebuildStatus(db)).toMatchObject({generation:job.generation,state:"error",phase:"sources"});
    expect(analysisRebuildStatus(db)?.error).toContain("1 required source files unavailable (claude: archive/session.jsonl)");
    expect(analysisRebuildStatus(db)?.warnings).toHaveLength(2);
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
    expect(db.query("SELECT * FROM claude_events").all()).toEqual(facts);
    db.close();db=new Database(file);ctx=context(db,file);ctx.syncRunner=runner;
    expect(analysisRebuildStatus(db)).toMatchObject({generation:job.generation,state:"error",phase:"sources"});
    resumeAnalysisRebuild(db);await advanceAnalysisRebuildSources(ctx);
    expect(analysisRebuildStatus(db)?.state).toBe("error");
    offline=false;resumeAnalysisRebuild(db);await advanceAnalysisRebuildSources(ctx);
    expect(analysisRebuildStatus(db)).toMatchObject({generation:job.generation,state:"queued",phase:"summaries",error:null,
      warnings:["claude: optional primary installation absent"]});
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
    expect(analysisRebuildStatus(db)?.phase).toBe("reports");
    expect(advanceRebuildReadiness(db,caughtUp)).toBe(true);
    expect(analysisRebuildStatus(db)).toMatchObject({generation:job.generation,state:"complete"});
  }finally{
    db.close(true);
    try{await fs.promises.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
    catch(error){if(process.platform!=="win32" || (error as NodeJS.ErrnoException).code!=="EBUSY")throw error;}
  }
});

test("weekly rebuild resumes in the background after reopen and preserves raw facts",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-rebuild-worker-")),file=path.join(root,"test.sqlite");
  let db=fixture(file);let worker:ReturnType<typeof startAnalysisMaintenance>|undefined;
  try {
    const facts=db.query("SELECT * FROM claude_events").all();
    expect(queueAnalysisRebuild(db,"week",now)).toMatchObject({state:"queued",range:{from:"2026-09-10",until:"2026-09-16"}});
    expect(()=>queueAnalysisRebuild(db,"all",now)).toThrow("already queued");
    db.close();db=new Database(file);
    worker=startAnalysisMaintenance(file, () => ({ subscriptions: [], sources: [] }));worker.update();await worker.waitForIdle();
    // Summaries were republished; the reports phase follows the derived registers (complete at once when they are current).
    expect(analysisRebuildStatus(db)?.phase).toBe("reports");
    expect(["running","complete"]).toContain(analysisRebuildStatus(db)!.state);
    expect(db.query("SELECT * FROM claude_events").all()).toEqual(facts);
  } finally {
    await worker?.close();db.close();
    try {fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
    catch(error) {if(process.platform!=="win32" || (error as NodeJS.ErrnoException).code!=="EBUSY")throw error;}
  }
});

test("monthly and full rebuild republish current summaries and run only once",()=>{
  const db=fixture();
  try {
    expect(queueAnalysisRebuild(db,"month",now).range).toEqual({from:"2026-08-18",until:"2026-09-16"});
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
    const probes=db.query("SELECT * FROM probe_windows").all();
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
    updateAnalysisRebuild(db,analysisRebuildStatus(db)!.generation,{state:"complete"});
    db.exec("UPDATE current_probe_subjects SET data='{}'");
    queueAnalysisRebuild(db,"all",now);expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
    expect(db.query("SELECT data FROM current_probe_subjects WHERE data='{}'").get()).toBeNull();
    expect(db.query("SELECT * FROM probe_windows").all()).toEqual(probes);
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
  } finally {db.close();}
});

test("interrupted running job resumes",()=>{
  const db=fixture();
  try {
    const job=queueAnalysisRebuild(db,"all",now);
    writeRebuildStatusJson(db,JSON.stringify({...job,state:"running"}));
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
    expect(analysisRebuildStatus(db)).toMatchObject({generation:job.generation,state:"running",phase:"reports"});
  } finally {db.close();}
});
