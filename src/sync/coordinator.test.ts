import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import { ingestGeminiTargetsAsync, type VendorAdapter } from "./adapters";
import { SyncCoordinator, enterSyncPipeline, type SyncCoordinatorOptions } from "./coordinator";
import { progressDirectory, readProgress } from "./progress";
import { WriteLease, writeLeaseHolder } from "../db/write-lease";
import { adaptersWith, createCodexSchema, createTestDatabase, noMirror, replaceClaudeRows, successfulNoop, vendorRevision } from "./test-support";
import {installAnalysisTracking} from "../db/analysis";
import {ensureDerivedColumns} from "../db/derived-columns";
import { analysisRebuildStatus, queueAnalysisRebuild, resumeAnalysisRebuild, runAnalysisRebuild, updateAnalysisRebuild } from "../server/analysis-rebuild";

const temporaryDirectories: string[] = [];
const january = "2026-01-10T10:00:00.000Z";
const february = "2026-02-12T11:00:00.000Z";

function testDatabase(): { directory: string; dbPath: string } {
  const created = createTestDatabase();
  temporaryDirectories.push(created.directory);
  return created;
}

function coordinator(
  dbPath: string,
  adapters = adaptersWith({}),
  overrides: Partial<SyncCoordinatorOptions> = {}
): SyncCoordinator {
  return new SyncCoordinator({ archiveInputs: () => undefined,
    dbPath,
    rootDir: process.cwd(),
    adapters,
    mirror: noMirror,
    configFingerprint: () => "fixture-config-v1",
    sourceFingerprint: (vendor) => `fixture-source:${vendor}`,
    prepareStage: () => {},
    refreshDerived: () => {},
    ...overrides,
  });
}

function emptyGeminiConversation(directory: string, name: string): string {
  const file = path.join(directory, "conversations", `${name}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file, { create: true });
  sqlite.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
  sqlite.close();
  return file;
}

test("native row batches preserve int64 rowids and values, and roll back a later failing batch", async () => {
  const {directory,dbPath:seedDbPath}=testDatabase();
  const dataDir=path.join(directory,"data # żółć");
  fs.mkdirSync(dataDir);
  const dbPath=path.join(dataDir,"atlas.sqlite");
  fs.copyFileSync(seedDbPath,dbPath);
  const active=new Database(dbPath);
  let fail=true,version=1;
  const instance=coordinator(dbPath,adaptersWith({opencode:async context=>{
    const stage=new Database(context.stageDbPath);
    try {
      stage.exec("DELETE FROM oc_events");
      const insert=stage.query(`INSERT INTO oc_events(id,store,message_id,ts,in_tok,cost)
        VALUES(?,'pc',?,?,?,1.0000000000000002)`);
      stage.transaction(()=>{
        for(let i=0;i<801;i++)insert.run(9007199254740993n+BigInt(i),`m${String(i).padStart(4,'0')}`,january,i===0?9007199254740993n:BigInt(i));
      })();
    } finally {stage.close();}
    return {...successfulNoop(),processedInputs:1,writtenRows:801,dirtyRange:{from:january,to:january}};
  }}),{
    sourceFingerprint:()=>`batches-${version}`,
    beforeIncrementalPublish:()=>{
      if(fail)active.exec(`CREATE TRIGGER reject_later_batch BEFORE INSERT ON oc_events
        WHEN NEW.message_id='m0400' BEGIN SELECT RAISE(ABORT,'later batch rejected'); END`);
    },
  });
  const request={trigger:"manual",scope:{kind:"vendor",vendor:"opencode"},mode:"incremental"} as const;
  try {
    const failed=await instance.enter(request).completion;
    expect(failed.status).toBe("failure");
    expect(failed.vendors[0]?.error).toContain("later batch rejected");
    expect(active.query("SELECT COUNT(*) AS n FROM oc_events").get()).toEqual({n:0});
    expect(failed.afterRevisions.data).toBe(failed.beforeRevisions.data);
    expect(failed.afterRevisions.vendors).toEqual(failed.beforeRevisions.vendors);
    active.exec("DROP TRIGGER reject_later_batch");fail=false;version++;
    const saved=await instance.enter(request).completion;
    expect({status:saved.status,error:saved.error}).toEqual({status:"success",error:null});
    expect(active.query("SELECT message_id FROM oc_events ORDER BY id").all())
      .toEqual(Array.from({length:801},(_,i)=>({message_id:`m${String(i).padStart(4,'0')}`})));
    expect(active.query(`SELECT CAST(in_tok AS TEXT) AS exact,typeof(in_tok) AS storage,
      cost=1.0000000000000002 AS real_exact FROM oc_events WHERE message_id='m0000'`).get())
      .toEqual({exact:"9007199254740993",storage:"integer",real_exact:1});
    version++;
    const repeated=await instance.enter(request).completion;
    expect(repeated.status).toBe("success");
    expect(repeated.vendors[0]?.dataChanged).toBe(false);
    expect(repeated.afterRevisions).toEqual(repeated.beforeRevisions);
  } finally {instance.close();active.close();}
});

test("validation reports preparation steps in the progress register and ends them with the run", async () => {
  const {dbPath}=testDatabase();
  const observed: unknown[]=[];
  const instance=coordinator(dbPath,adaptersWith({claude:async context=>{
    const stage=new Database(context.stageDbPath);
    try {stage.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','progress','progress.jsonl',?,25)").run(january);}
    finally {stage.close();}
    return {...successfulNoop(),processedInputs:1,writtenRows:1,dirtyRange:{from:january,to:january}};
  }}),{prepareStage:(_stage,report)=>{
    for(const phase of ["repos","gaps","projects"] as const) {
      report?.({phase,phase_index:1,phase_count:4,message:"ignored",item_index:2,item_count:4});
      observed.push(readProgress(progressDirectory(dbPath)).map(({scope,step,done,total,unit})=>({scope,step,done,total,unit})));
    }
  }});
  try {
    const result=await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental"}).completion;
    expect(result.status).toBe("success");
    expect(observed).toEqual(["repos","gaps","projects"].map(step=>
      [{scope:"sync:claude",step:`validate.${step}`,done:2,total:4,unit:"tables"}]));
    expect(readProgress(progressDirectory(dbPath))).toEqual([]);
  } finally {instance.close();}
});

test("file discovery and file counts go to the vendor's register entry, never to the run record", async () => {
  const {dbPath}=testDatabase();
  const snapshots: unknown[] = [];
  const snapshot = () => snapshots.push(readProgress(progressDirectory(dbPath)).map(({scope,step,done,total})=>({scope,step,done,total})));
  const instance=coordinator(dbPath,adaptersWith({claude:async context=>{
    context.onFileDiscovery?.(0);
    snapshot();
    await Bun.sleep(300);
    context.onFileDiscovery?.(7);
    snapshot();
    context.onFileProgress?.(0,4);
    snapshot();
    await Bun.sleep(300);
    context.onFileProgress?.(2,4);
    snapshot();
    return successfulNoop();
  }}));
  try {
    const result=await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"full"}).completion;
    expect(snapshots).toEqual([
      [{scope:"sync:claude",step:"discover",done:0,total:null}],[{scope:"sync:claude",step:"discover",done:7,total:null}],
      [{scope:"sync:claude",step:"parse",done:0,total:4}],[{scope:"sync:claude",step:"parse",done:2,total:4}],
    ]);
    expect(result.status).toBe("success");
    expect(result.progress?.phase).toBe("finalize");
    expect(readProgress(progressDirectory(dbPath))).toEqual([]);
  } finally {instance.close();}
});

test("file progress never waits behind another writer", async () => {
  const {dbPath}=testDatabase();
  const writer=new Database(dbPath);
  let blockedCallMs=Number.NaN,visible:unknown;
  const instance=coordinator(dbPath,adaptersWith({claude:async context=>{
    writer.exec("BEGIN IMMEDIATE");
    try {
      const started=performance.now();
      context.onFileProgress?.(0,4);
      blockedCallMs=performance.now()-started;
      visible=readProgress(progressDirectory(dbPath)).find(entry=>entry.scope==="sync:claude")?.step;
    } finally {writer.exec("ROLLBACK");}
    context.onFileProgress?.(4,4);
    return successfulNoop();
  }}));
  try {
    const result=await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"full"}).completion;
    expect(blockedCallMs).toBeLessThan(1000);
    expect(visible).toBe("parse");
    expect(result.status).toBe("success");
  } finally {instance.close();writer.close();}
});

test("publication and the derived refresh wait for the background writer to hand over the write lease, which is free after the run", async () => {
  const {dbPath}=testDatabase();
  const background=new WriteLease(new Database(dbPath),"background");
  expect(background.tryAcquire()).toBe(true);
  let holderDuringDerived: string | undefined;
  const instance=coordinator(dbPath,adaptersWith({claude:async context=>{
    const stage=new Database(context.stageDbPath);
    try {stage.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','lease','lease.jsonl',?,25)").run(january);}
    finally {stage.close();}
    return {...successfulNoop(),processedInputs:1,writtenRows:1,dirtyRange:{from:january,to:january}};
  }}),{refreshDerived:()=>{ holderDuringDerived=writeLeaseHolder(new Database(dbPath,{readonly:true}))?.kind; }});
  try {
    const completion=instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental"}).completion;
    // The run asks for the lease and says so in the progress register while it waits.
    const deadline=Date.now()+10_000;
    while(!readProgress(progressDirectory(dbPath)).some(entry=>entry.scope==="sync:claude" && entry.step==="write-lease")) {
      if(Date.now()>deadline)throw new Error("The run never waited for the write lease");
      await Bun.sleep(20);
    }
    // The holder sees the request at its next batch boundary (after its minimum slice) and hands over.
    while(background.mayContinue()) { if(Date.now()>deadline)throw new Error("The request never reached the holder"); await Bun.sleep(50); }
    background.release();
    const result=await completion;
    expect(result.status).toBe("success");
    expect(holderDuringDerived).toBe("sync");
    expect(writeLeaseHolder(new Database(dbPath,{readonly:true}))).toBeNull();
  } finally {instance.close();}
}, 30_000);

test("ordinary sync cannot advance revisions during a selected rebuild source phase", async () => {
  const {dbPath}=testDatabase(),db=new Database(dbPath);
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,model TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER)`);
  let ordinaryImports=0,sourceVersion=0;
  const instance=coordinator(dbPath,adaptersWith({claude:async context=>{
    if(!context.reparse)ordinaryImports++;
    if(!sourceVersion)return successfulNoop();
    const stage=new Database(context.stageDbPath);
    try {stage.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','changed','changed.jsonl',?,25)").run(january);}
    finally {stage.close();}
    return {...successfulNoop(),processedInputs:1,skippedInputs:0,writtenRows:1,dirtyRange:{from:january,to:january}};
  }}),{sourceFingerprint:()=>`source-${sourceVersion}`});
  const ordinary={trigger:"auto",scope:{kind:"all"},mode:"incremental"} as const;
  try {
    expect((await instance.enter(ordinary).completion).status).toBe("success");
    ordinaryImports=0;
    const job=queueAnalysisRebuild(db,{scope:"custom",from:"2026-01-10",until:"2026-01-10",vendors:["claude"]},new Date(),true);
    updateAnalysisRebuild(db,job.generation,{state:"running"});
    sourceVersion=1;
    expect(()=>instance.enter(ordinary)).toThrow("deferred until rebuild source verification");
    expect(ordinaryImports).toBe(0);
    expect(db.query("SELECT data_revision FROM sync_revisions WHERE id=1").get()).toEqual({data_revision:0});
    expect(db.query("SELECT COUNT(*) AS n FROM sync_runs").get()).toEqual({n:1});
    const selected=await instance.enter({trigger:"manual",scope:{kind:"vendors",vendors:["claude"]},mode:"incremental",
      reparse:job.range!,rebuildGeneration:job.generation,collection:"archive"}).completion;
    expect(selected.status).toBe("success");
    expect(selected.afterRevisions.data).toBe(1);
    expect(ordinaryImports).toBe(0);
    updateAnalysisRebuild(db,job.generation,{state:"queued",phase:"summaries"});
    expect((await instance.enter(ordinary).completion).status).toBe("success");
  }finally{instance.close();db.close();}
});

test("ordinary syncs wait only for a rebuild's source phase", async () => {
  const {dbPath}=testDatabase();
  const db=new Database(dbPath);
  let imports=0;
  const instance=coordinator(dbPath,adaptersWith({claude:async()=>{imports++;return successfulNoop();}}));
  const ordinary={trigger:"auto",scope:{kind:"all"},mode:"incremental"} as const;
  try {
    const job=queueAnalysisRebuild(db,"all",new Date(),true);
    expect(()=>instance.enter(ordinary)).toThrow("deferred until rebuild source verification");
    expect(imports).toBe(0);
    // Usage sums follow in the ledgers' producers: the summaries phase holds no sync back.
    updateAnalysisRebuild(db,job.generation,{phase:"summaries",state:"running"});
    expect((await instance.enter(ordinary).completion).status).not.toBe("failure");
  } finally {instance.close();db.close();}
});

test("an interrupted rebuild publication rolls back, and the same generation publishes its reread once", async () => {
  const {dbPath,directory}=testDatabase();
  const archiveRoot=path.join(directory,"archive"),file=path.join(archiveRoot,"claude","pc","a.jsonl");
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,"{}\n");
  const db=new Database(dbPath);
  installAnalysisTracking(db);
  db.run("INSERT INTO claude_events(store,call_id,ts,path,in_uncached,model) VALUES('pc','keep',?,?,10,'accepted-model')",[january,file]);
  let interrupt=true,reparses=0;
  const publicationDepths:number[]=[];
  let instance:SyncCoordinator;
  const adapters=adaptersWith({claude:async context=>{
    reparses++;
    expect(context.rebuild).toBe(true);
    const stage=new Database(context.stageDbPath);
    try {stage.run("INSERT INTO claude_events(store,call_id,ts,path,in_uncached,model) VALUES('pc','keep',?,?,10,'reread-model')",[january,file]);}
    finally {stage.close();}
    return {...successfulNoop(),processedInputs:1,writtenRows:1,dirtyRange:{from:january,to:january}};
  }});
  const overrides={afterPublishBeforeRevision:()=>{
    const connection=(instance as unknown as {sqlite:Database}).sqlite;
    publicationDepths.push((connection as unknown as {transactionDepth:number}).transactionDepth);
    if(interrupt)throw new Error("interrupted during publication");
  }};
  const request={trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",
    reparse:{},rebuildGeneration:42,collection:"archive"} as const;
  const facts=()=>db.query("SELECT call_id,in_uncached,model FROM claude_events").all();
  instance=coordinator(dbPath,adapters,overrides);
  try {
    expect((await instance.enter(request).completion).status).toBe("failure");
    // The rolled-back publication leaves the usable prior facts exactly as they were.
    expect(facts()).toEqual([{call_id:"keep",in_uncached:10,model:"accepted-model"}]);
    instance.close();interrupt=false;instance=coordinator(dbPath,adapters,overrides);
    const resumed=await instance.enter(request).completion;
    expect({status:resumed.status,error:resumed.error}).toEqual({status:"success",error:null});
    expect(facts()).toEqual([{call_id:"keep",in_uncached:10,model:"reread-model"}]);
    expect(publicationDepths).toEqual([1,1]);
    expect(reparses).toBe(2);
    // A completed vendor of the generation is not read again.
    expect((await instance.enter(request).completion).status).toBe("success");
    expect(reparses).toBe(2);
  } finally {instance.close();db.close(true);}
});

test("a failed final run receipt rolls back rebuild facts, bookmark, revisions and changed source days", async () => {
  const {dbPath}=testDatabase();
  const db=new Database(dbPath);
  installAnalysisTracking(db);
  db.exec(`CREATE TRIGGER fail_completed_rebuild_receipt BEFORE UPDATE ON sync_runs
    WHEN json_extract(NEW.result_json,'$.vendors[0].status')='success'
    BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`);
  const instance=coordinator(dbPath,adaptersWith({claude:async context=>{
    const stage=new Database(context.stageDbPath);
    try {
      stage.query("INSERT INTO claude_events(store,call_id,ts,path,in_uncached) VALUES('pc','new',?,?,7)").run(january,"new.jsonl");
      stage.query("INSERT INTO claude_files(store,path,size,mtime,calls,ingested_at) VALUES('pc','new.jsonl',10,1,1,?)").run(january);
    }
    finally {stage.close();}
    return {...successfulNoop(),processedInputs:1,writtenRows:1,dirtyRange:{from:january,to:january}};
  }}));
  try {
    const days=()=>db.query("SELECT * FROM fact_day_revisions WHERE source='claude_events' ORDER BY day").all();
    const before=days();
    const revisions=db.query("SELECT data_revision FROM sync_revisions WHERE id=1").get();
    const sourceRevisions=db.query("SELECT * FROM analysis_source_revisions WHERE source IN ('claude_events','claude_files') ORDER BY source,bucket").all();
    const result=await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",
      reparse:{},rebuildGeneration:88,collection:"archive"}).completion;
    expect(result.status).toBe("failure");
    expect(result.vendors[0]?.error).toContain("receipt unavailable");
    expect(db.query("SELECT count(*) AS n FROM claude_events").get()).toEqual({n:0});
    expect(db.query("SELECT count(*) AS n FROM claude_files").get()).toEqual({n:0});
    expect(db.query("SELECT value FROM meta WHERE key='sync_source_fingerprint:claude'").get()).toBeNull();
    expect(db.query("SELECT data_revision FROM sync_revisions WHERE id=1").get()).toEqual(revisions);
    expect(days()).toEqual(before);
    expect(db.query("SELECT * FROM analysis_source_revisions WHERE source IN ('claude_events','claude_files') ORDER BY source,bucket").all()).toEqual(sourceRevisions);
  } finally {instance.close();db.close(true);}
});

test("archive-only reset does not invoke primary collectors", async () => {
  const {dbPath}=testDatabase();
  let mirrors=0,imports=0;
  const instance=coordinator(dbPath,adaptersWith({claude:async()=>{imports++;return successfulNoop();}}),{
    mirror:async()=>{mirrors++;throw new Error("Primary installation unavailable");},
  });
  try {
    const result=await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",reparse:{},rebuildGeneration:51,collection:"archive"}).completion;
    expect(result.status).toBe("success");expect(mirrors).toBe(0);expect(imports).toBe(1);
    const collected=await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",reparse:{},rebuildGeneration:52,collection:"collect-archive"}).completion;
    expect(collected.status).toBe("failure");expect(mirrors).toBe(1);
  } finally {instance.close();}
});

test("bootstrap collection copies without invoking adapters, derived work or configuration acknowledgement", async () => {
  const {dbPath}=testDatabase();let mirrors=0,imports=0,derived=0;
  const instance=coordinator(dbPath,adaptersWith({claude:async()=>{imports++;return successfulNoop();}}),{
    mirror:async()=>{mirrors++;return {copied:1,skipped:0,warnings:[],errors:[]};},
    refreshDerived:()=>{derived++;},
  });
  try {
    const result=await instance.enter({trigger:"auto",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",collection:"mirror-only"}).completion;
    expect(result.status).toBe("success");
    expect([mirrors,imports,derived]).toEqual([1,0,0]);
    expect(result.beforeRevisions).toEqual(result.afterRevisions);
  } finally {instance.close();}
});

test("bootstrap collection is complete despite an unreadable non-transcript file, never despite an unread transcript", async () => {
  const {dbPath}=testDatabase();
  const link=path.join(os.tmpdir(),"claude-home","projects","p","memory"), transcript=path.join(os.tmpdir(),"claude-home","projects","p","s.jsonl");
  let failed=[link];
  const instance=coordinator(dbPath,adaptersWith({}),{
    mirror:async()=>({copied:0,skipped:0,warnings:[],failedFiles:failed,errors:failed.map(file=>`${file}: EACCES: permission denied`)}),
  });
  try {
    const collect=()=>instance.enter({trigger:"auto",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",collection:"mirror-only"}).completion;
    const tolerated=(await collect()).vendors[0]!;
    expect(tolerated.inputsComplete).toBe(true);
    expect(tolerated.diagnostics.pendingInputs).toBeUndefined();
    expect(tolerated.diagnostics.unreadableEvidence).toEqual([{path:link,error:`${link}: EACCES: permission denied`}]);
    failed=[link,transcript];
    const incomplete=(await collect()).vendors[0]!;
    expect(incomplete.inputsComplete).toBe(false);
    expect(incomplete.diagnostics.pendingInputs).toEqual([{path:transcript,error:`${transcript}: EACCES: permission denied`}]);
  } finally {instance.close();}
});

test("archive-only bootstrap isolates adapters from original provider fallback", async () => {
  const {dbPath}=testDatabase();let isolated=false;
  const instance=coordinator(dbPath,adaptersWith({claude:async context=>{
    isolated=context.rebuild===true;return successfulNoop();
  }}),{mirror:async()=>{throw new Error("Original provider tree accessed");}});
  try {
    const result=await instance.enter({trigger:"auto",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",collection:"archive"}).completion;
    expect(result.status).toBe("success");expect(isolated).toBe(true);
  } finally {instance.close();}
});

test("incremental Claude publication retains earlier identity and conflicts without crossing stores", async () => {
  const { dbPath } = testDatabase();
  const active = new Database(dbPath);
  active.run("INSERT INTO claude_events(store,call_id,ts,path,account_key,subscription_id) VALUES('live','call',?,'old.jsonl','owner-a','account-a'),('other-pc','call',?,'other.jsonl','owner-b','account-b')", [january, january]);
  let incomingKey: string | null = null, sourceVersion = 0;
  const instance = coordinator(dbPath, adaptersWith({ claude: async context => {
    const stage = new Database(context.stageDbPath);
    stage.run("INSERT INTO claude_events(store,call_id,ts,path,account_key,subscription_id) VALUES('live','call',?,'new.jsonl',?,'generic')", [january, incomingKey]);
    stage.close();
    return { ...successfulNoop(), processedInputs: 1, writtenRows: 1, dirtyRange: { from: january, to: january } };
  } }), { sourceFingerprint: () => String(++sourceVersion) });
  const request = { trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "incremental" } as const;
  try {
    expect((await instance.enter(request).completion).status).toBe("success");
    expect(active.query("SELECT account_key,subscription_id,subscription_conflict FROM claude_events WHERE store='live'").get()).toEqual({ account_key: "owner-a", subscription_id: "account-a", subscription_conflict: 0 });
    incomingKey = "owner-c";
    expect((await instance.enter(request).completion).status).toBe("success");
    incomingKey = null;
    expect((await instance.enter(request).completion).status).toBe("success");
    expect(active.query("SELECT subscription_id,subscription_conflict FROM claude_events WHERE store='live'").get()).toEqual({ subscription_id: null, subscription_conflict: 1 });
    expect(active.query("SELECT subscription_id FROM claude_events WHERE store='other-pc'").get()).toEqual({ subscription_id: "account-b" });
  } finally { active.close(); instance.close(); }
});

test("rereading a whole archive publishes only changed source facts and preserves unrelated day revisions",async()=>{
  const {dbPath}=testDatabase(),active=new Database(dbPath);
  active.run("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','same','same.jsonl',?,10),('pc','changed','changed.jsonl',?,20)",[january,february]);
  // The schema a synchronization keeps (derived columns) is in place before tracking starts.
  ensureDerivedColumns(active);
  installAnalysisTracking(active);
  const before=active.query("SELECT revision FROM analysis_source_revisions WHERE source='claude_events' AND bucket='2026-01-10'").get();
  const instance=coordinator(dbPath,adaptersWith({claude:async context=>{
    const stage=new Database(context.stageDbPath);
    stage.run("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','same','same.jsonl',?,10),('pc','changed','changed.jsonl',?,25)",[january,february]);
    stage.close();return {...successfulNoop(),processedInputs:2,writtenRows:2,dirtyRange:{from:january,to:february}};
  }}));
  try {
    const result=await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",reparse:{}}).completion;
    expect(result.status).toBe("success");
    expect(result.vendors[0]?.diagnostics).toMatchObject({deltaIdentities:2,changedIdentities:1});
    expect(active.query("SELECT revision FROM analysis_source_revisions WHERE source='claude_events' AND bucket='2026-01-10'").get()).toEqual(before);
    expect(active.query("SELECT in_uncached FROM claude_events WHERE call_id='changed'").get()).toEqual({in_uncached:25});
  }finally{instance.close();active.close();}
});

for (const mode of ["full", "incremental"] as const) {
  for (const numeric of ["int64", "adjacent-real"] as const) {
    test(`${mode} source publication preserves ${numeric} corrections and recognizes an identical forced reread`, async () => {
      const { dbPath } = testDatabase();
      const vendor = numeric === "int64" ? "claude" : "opencode";
      const table = numeric === "int64" ? "claude_events" : "oc_events";
      const column = numeric === "int64" ? "in_uncached" : "cost";
      const original = numeric === "int64" ? "9007199254740992" : "1.0";
      const corrected = numeric === "int64" ? "9007199254740993" : "1.0000000000000002";
      const seed = (db: Database, literal: string) => {
        if (vendor === "opencode") db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
        db.exec(`DELETE FROM ${table}`);
        // SQL literals preserve int64 values before either publication path reads them.
        db.run(numeric === "int64"
          ? `INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','same','same.jsonl',?,${literal})`
          : `INSERT INTO oc_events(store,message_id,ts,cost) VALUES('pc','same',?,${literal})`, [january]);
      };
      const active = new Database(dbPath);
      try { seed(active, original); } finally { active.close(); }
      let adapterCalls = 0, sourceVersion = 1;
      const adapter: VendorAdapter = async context => {
        adapterCalls++;
        const stage = new Database(context.stageDbPath);
        try { seed(stage, corrected); } finally { stage.close(); }
        return { ...successfulNoop(), processedInputs: 1, writtenRows: 1,
          dirtyRange: { from: january, to: january } };
      };
      const adapters = adaptersWith({ [vendor]: adapter });
      const options = { sourceFingerprint: () => `numeric-source:${sourceVersion}` };
      const request = { trigger: "manual", scope: { kind: "vendor", vendor }, mode } as const;
      const verifyStored = () => {
        const reopened = new Database(dbPath, { readonly: true });
        try {
          expect(reopened.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
          expect(reopened.query(`SELECT ${column} = ${corrected} AS exact, typeof(${column}) AS storage FROM ${table}`).get())
            .toEqual({ exact: 1, storage: numeric === "int64" ? "integer" : "real" });
          if (numeric === "int64") {
            expect(reopened.query(`SELECT CAST(${column} AS TEXT) AS value FROM ${table}`).get())
              .toEqual({ value: "9007199254740993" });
          } else {
            expect(reopened.query(`SELECT ${column} AS value FROM ${table}`).get())
              .toEqual({ value: 1.0000000000000002 });
          }
        } finally { reopened.close(); }
      };
      let instance = coordinator(dbPath, adapters, options);
      try {
        const changed = await instance.enter(request).completion;
        expect({ status: changed.status, error: changed.error }).toEqual({ status: "success", error: null });
        expect(changed.vendors[0]).toMatchObject({ dataChanged: true });
        expect(adapterCalls).toBe(1);
        expect(changed.afterRevisions.vendors[vendor]).toBe(changed.beforeRevisions.vendors[vendor] + 1);
        verifyStored();
        instance.close();
        sourceVersion++;
        instance = coordinator(dbPath, adapters, options);
        const unchanged = await instance.enter(request).completion;
        expect({ status: unchanged.status, error: unchanged.error }).toEqual({ status: "success", error: null });
        // A changed source fingerprint forces the adapter and exact fact comparison after reopen.
        expect(adapterCalls).toBe(2);
        expect(unchanged.vendors).toHaveLength(1);
        expect(unchanged.vendors[0]).toMatchObject({ dataChanged: false });
        expect(unchanged.afterRevisions).toEqual(changed.afterRevisions);
        verifyStored();
      } finally { instance.close(); }
    });
  }
}

test("source rebuild resumes completed vendors without reading them again; later arrivals are left to ordinary sync",async()=>{
  const {dbPath}=testDatabase();let fail=true,version=1;
  const raw=new Database(dbPath);raw.exec("CREATE TABLE files(home TEXT,path TEXT,size INTEGER,mtime REAL)");raw.close();
  const codexReads:boolean[]=[],claudeReads:boolean[]=[];
  const adapters=adaptersWith({codex:async context=>{codexReads.push(!!context.reparse);return successfulNoop();},
    claude:async context=>{claudeReads.push(!!context.reparse);if(fail)throw new Error("interrupted input");return successfulNoop();}});
  const overrides={sourceFingerprint:(vendor:string)=>`${vendor}:${vendor==="codex"?version:1}`};
  let instance=coordinator(dbPath,adapters,overrides);
  const request={trigger:"manual",scope:{kind:"all"},mode:"incremental",reparse:{},rebuildGeneration:12} as const;
  try {
    expect((await instance.enter(request).completion).status).toBe("partial_success");
    instance.close();instance=coordinator(dbPath,adapters,overrides);fail=false;version++;
    // The rebuild reads the archive as it is; it does not walk sources for arrivals since codex completed.
    expect((await instance.enter(request).completion).status).toBe("success");
    expect(codexReads).toEqual([true]);expect(claudeReads).toEqual([true,true]);
    expect((await instance.enter(request).completion).status).toBe("success");
    expect(codexReads).toHaveLength(1);expect(claudeReads).toHaveLength(2);
    expect((await instance.enter({...request,rebuildGeneration:13}).completion).status).toBe("success");
    expect(codexReads).toEqual([true,true]);
    // An ordinary sync afterwards picks up what changed since.
    expect((await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"codex"},mode:"incremental"}).completion).status).toBe("success");
    expect(codexReads).toEqual([true,true,false]);
  }finally{instance.close();}
});

test("a failed reread after a configuration change cannot reuse an older configuration's success",async()=>{
  const {dbPath}=testDatabase();let configuration="v1",fail=false;const reads:boolean[]=[];
  const raw=new Database(dbPath);raw.exec("CREATE TABLE files(home TEXT,path TEXT,size INTEGER,mtime REAL)");raw.close();
  const instance=coordinator(dbPath,adaptersWith({codex:async context=>{
    reads.push(!!context.reparse);if(fail)throw new Error("interrupted reread");return successfulNoop();
  }}),{configFingerprint:()=>configuration});
  const request={trigger:"manual",scope:{kind:"all"},mode:"incremental",reparse:{},rebuildGeneration:20} as const;
  try {
    expect((await instance.enter(request).completion).status).toBe("success");
    configuration="v2";fail=true;
    expect((await instance.enter(request).completion).status).toBe("partial_success");
    fail=false;
    expect((await instance.enter(request).completion).status).toBe("success");
    expect(reads).toEqual([true,true,true]);
  }finally{instance.close();}
});

test("resumed source verification retries unavailable inputs after reopen and reuses complete vendors",async()=>{
  const {dbPath,directory}=testDatabase(),offline=path.join(directory,"offline.jsonl");let version=0;
  const raw=new Database(dbPath);
  raw.run("INSERT INTO claude_files(store,path,size,mtime,ingested_at) VALUES('pc',?,10,10,?)",[offline,january]);
  raw.run("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','preserved',?,?,17)",[offline,january]);
  raw.exec("CREATE TABLE files(home TEXT,path TEXT,size INTEGER,mtime REAL)");
  raw.close();
  const reads:boolean[]=[],codexReads:boolean[]=[];
  const adapters=adaptersWith({codex:async context=>{codexReads.push(!!context.reparse);return successfulNoop();},claude:async context=>{
    reads.push(!!context.reparse);
    if(!version)return successfulNoop();
    const source=version===1?path.join(directory,"new.jsonl"):offline;
    const stage=new Database(context.stageDbPath);
    for(const input of context.reparseSources??[])stage.run("UPDATE claude_files SET size=20,mtime=20 WHERE store=? AND path=?",[input.store!,input.path]);
    stage.run("INSERT INTO claude_events(store,call_id,path,ts) VALUES('pc',?,?,?)",[String(version),source,january]);
    stage.run("INSERT OR REPLACE INTO claude_files(store,path,size,mtime,ingested_at) VALUES('pc',?,20,20,?)",[source,january]);
    stage.close();return {...successfulNoop(),processedInputs:1,writtenRows:1};
  }});
  const overrides={sourceFingerprint:(vendor:string)=>vendor==="claude"?String(version):"unchanged"};
  let instance=coordinator(dbPath,adapters,overrides);
  const request={trigger:"manual",scope:{kind:"all"},mode:"incremental",reparse:{},rebuildGeneration:21} as const;
  try {
    for(version=0;version<3;version++) {
      if(version===1)fs.writeFileSync(path.join(directory,"new.jsonl"),"{}");
      if(version===2)fs.writeFileSync(offline,"{}");
      const result=await instance.enter(request).completion;expect(result.status).toBe("success");
      expect(result.vendors.find(v=>v.vendor==="claude")!.diagnostics.reparse).toMatchObject({unavailable:version<2?[{store:"pc",path:offline}]:[]});
      const check=new Database(dbPath,{readonly:true});
      try{expect(check.query("SELECT in_uncached FROM claude_events WHERE call_id='preserved'").get()).toEqual(version<2?{in_uncached:17}:null);}
      finally{check.close();}
      instance.close();instance=coordinator(dbPath,adapters,overrides);
    }
    expect(reads).toEqual([true,true,true]);expect(codexReads).toEqual([true]);
  }finally{instance.close();}
});

function seedGeminiHistory(
  dbPath: string,
  file: string,
  store: string,
  timestamp: string,
  projectId: string,
  bookmarkSizeOffset = 0,
): void {
  const stat = fs.statSync(file);
  const sqlite = new Database(dbPath);
  try {
    sqlite
      .query(
        `INSERT INTO gemini_events
           (store, conversation_id, gen_idx, ts, ts_basis, path, fresh_in, project_id)
         VALUES (?, ?, 0, ?, 'conversation', ?, 123, ?)`,
      )
      .run(store, path.basename(file, ".db"), timestamp, file, projectId);
    sqlite
      .query(
        `INSERT INTO gemini_files (store, path, size, mtime, generations, ingested_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(store, file, stat.size + bookmarkSizeOffset, stat.mtimeMs, timestamp);
  } finally {
    sqlite.close();
  }
}

function geminiIncrementalAdapters(conversations: string) {
  return adaptersWith({
    gemini: async (context) =>
      (await ingestGeminiTargetsAsync(context, [{ profile: "fixture", dir: conversations, store: "agy1" }])),
  });
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await Bun.sleep(10);
  }
}

afterAll(() => {
  const tempRoot = path.resolve(os.tmpdir());
  for (const directory of temporaryDirectories) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith("tokenatlas-sync-test-")) {
      try {
        removeTestFixture(resolved, { recursive: true, force: true });
      } catch {
        // Bun can retain a Windows SQLite handle until process teardown.
      }
    }
  }
});

describe("SyncCoordinator", () => {
  test("an unavailable input keeps the source fingerprint pending until a clean retry", async () => {
    const { dbPath } = testDatabase();
    const seeded = new Database(dbPath);
    seeded.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
    seeded.query("INSERT INTO meta(key,value) VALUES(?,?)").run("sync_source_fingerprint:codex", "same-source");
    seeded.close();
    let calls = 0, unavailable = true;
    const instance = coordinator(dbPath, adaptersWith({ codex: async () => {
      calls++;
      return { ...successfulNoop(), retryRequired: unavailable,
        diagnostics: unavailable ? { warnings: ["cloud placeholder unavailable"] } : {} };
    }}), { sourceFingerprint: () => "same-source" });
    const manual = { trigger: "manual", scope: { kind: "vendor", vendor: "codex" }, mode: "full" } as const;
    const automatic = { trigger: "auto", scope: { kind: "vendor", vendor: "codex" }, mode: "incremental" } as const;
    try {
      expect((await instance.enter(manual).completion).status).toBe("success");
      expect((await instance.enter(automatic).completion).status).toBe("success");
      expect(calls).toBe(2);
      unavailable = false;
      expect((await instance.enter(automatic).completion).status).toBe("success");
      expect((await instance.enter(automatic).completion).vendors).toEqual([]);
      expect(calls).toBe(3);
    } finally { instance.close(); }
  });

  test("unchanged reconciliation creates no staging and one changed source scopes one heavy pass", async () => {
    const { dbPath } = testDatabase();
    const sources = new Map([
      ["codex", "codex-1"],
      ["claude", "claude-1"],
      ["opencode", "opencode-1"],
      ["grok", "grok-1"],
      ["gemini", "gemini-1"],
      ["gauges", "gauges-1"],
    ]);
    let stagingCalls = 0;
    let heavyPasses = 0;
    const instance = coordinator(
      dbPath,
      adaptersWith({
        codex: async () => { heavyPasses += 1; return successfulNoop(); },
        claude: async () => { heavyPasses += 1; return successfulNoop(); },
        opencode: async () => { heavyPasses += 1; return successfulNoop(); },
        grok: async () => { heavyPasses += 1; return successfulNoop(); },
        gemini: async () => { heavyPasses += 1; return successfulNoop(); },
      }),
      {
        sourceFingerprint: (vendor) => sources.get(vendor)!,
        ensureStagingRoot: (directory) => {
          stagingCalls += 1;
          fs.mkdirSync(directory, { recursive: true });
        },
      }
    );
    const request = {
      trigger: "auto" as const,
      scope: { kind: "all" as const },
      mode: "incremental" as const,
    };
    try {
      await instance.enter(request).completion;
      stagingCalls = 0;
      heavyPasses = 0;
      const unchanged = await instance.enter(request).completion;
      expect(unchanged.vendors).toEqual([]);
      expect(stagingCalls).toBe(0);
      expect(heavyPasses).toBe(0);

      sources.set("claude", "claude-2");
      const changed = await instance.enter(request).completion;
      expect(changed.vendors.map((vendor) => vendor.vendor)).toEqual(["claude"]);
      expect(stagingCalls).toBe(1);
      expect(heavyPasses).toBe(1);
    } finally {
      instance.close();
    }
  });

  test("incremental Gemini publishes an unchanged exact-path reassignment by both identities", async () => {
    const { directory, dbPath } = testDatabase();
    const conversation = emptyGeminiConversation(directory, "unchanged");
    seedGeminiHistory(dbPath, conversation, "main", january, "project-unchanged");
    const instance = coordinator(dbPath, geminiIncrementalAdapters(path.dirname(conversation)));
    try {
      const result = await enterSyncPipeline(instance, {
        trigger: "manual",
        scope: { kind: "vendor", vendor: "gemini" },
        mode: "incremental",
      }).completion;
      expect(result.vendors[0]).toMatchObject({
        status: "success",
        processedInputs: 1,
        skippedInputs: 0,
        writtenRows: 0,
        dataChanged: true,
        dirtyRange: { from: january, to: january },
        diagnostics: { deltaIdentities: 2, stores: { fixture: { files: 0, skipped: 1, reassigned: 1 } } },
      });
      expect(result.afterRevisions).toMatchObject({ data: 1, vendors: { gemini: 1 } });
      const check = new Database(dbPath, { readonly: true });
      try {
        expect(
          check.query("SELECT store, path, project_id, fresh_in FROM gemini_events ORDER BY id").all(),
        ).toEqual([{ store: "agy1", path: conversation, project_id: "project-unchanged", fresh_in: 123 }]);
        expect(check.query("SELECT store, path FROM gemini_files ORDER BY store, path").all()).toEqual([
          { store: "agy1", path: conversation },
        ]);
      } finally {
        check.close();
      }
    } finally {
      instance.close();
    }
  });

  test("incremental Gemini keeps reassigned history when another input changed", async () => {
    const { directory, dbPath } = testDatabase();
    const unchanged = emptyGeminiConversation(directory, "unchanged");
    const changed = emptyGeminiConversation(directory, "changed");
    seedGeminiHistory(dbPath, unchanged, "main", january, "project-unchanged");
    seedGeminiHistory(dbPath, changed, "agy1", february, "project-changed", 1);
    const instance = coordinator(dbPath, geminiIncrementalAdapters(path.dirname(unchanged)));
    try {
      const result = await enterSyncPipeline(instance, {
        trigger: "manual",
        scope: { kind: "vendor", vendor: "gemini" },
        mode: "incremental",
      }).completion;
      expect(result.vendors[0]).toMatchObject({
        status: "success",
        processedInputs: 2,
        skippedInputs: 0,
        writtenRows: 0,
        dataChanged: true,
        dirtyRange: { from: january, to: february },
        diagnostics: { deltaIdentities: 3, stores: { fixture: { files: 1, skipped: 1, reassigned: 1 } } },
      });
      const check = new Database(dbPath, { readonly: true });
      try {
        expect(
          check.query("SELECT store, path, project_id, fresh_in FROM gemini_events ORDER BY id").all(),
        ).toEqual([{ store: "agy1", path: unchanged, project_id: "project-unchanged", fresh_in: 123 }]);
        expect(check.query("SELECT store, path FROM gemini_files ORDER BY path, store").all()).toEqual([
          { store: "agy1", path: changed },
          { store: "agy1", path: unchanged },
        ]);
      } finally {
        check.close();
      }
    } finally {
      instance.close();
    }
  });

  for (const mode of ["incremental", "full"] as const) {
    for (const ambiguous of [false, true]) {
      test(`${mode} Gemini repairs ${ambiguous ? "ambiguous" : "stale target"} colliding histories`, async () => {
        const { directory, dbPath } = testDatabase();
        const file = emptyGeminiConversation(directory, "collision");
        const source = new Database(file);
        source.query("INSERT INTO gen_metadata VALUES (0, ?)").run(new Uint8Array([10, 4, 34, 2, 16, 123]));
        source.close();
        seedGeminiHistory(dbPath, file, "agy1", january, "target-project", ambiguous ? 0 : 1);
        seedGeminiHistory(dbPath, file, "main", february, "source-project");
        const seed = new Database(dbPath);
        seed.exec("UPDATE gemini_events SET fresh_in = 10 WHERE store = 'agy1'");
        seed.close();
        const instance = coordinator(dbPath, geminiIncrementalAdapters(path.dirname(file)));
        try {
          const result = await enterSyncPipeline(instance, {
            trigger: "manual", scope: { kind: "vendor", vendor: "gemini" }, mode,
          }).completion;
          expect(result.vendors[0]).toMatchObject({ status: "success", dataChanged: true });
          const check = new Database(dbPath, { readonly: true });
          expect(check.query("SELECT store, fresh_in, project_id FROM gemini_events").all())
            .toEqual([{ store: "agy1", fresh_in: 123, project_id: "target-project" }]);
          expect(check.query("SELECT store, generations FROM gemini_files").all())
            .toEqual([{ store: "agy1", generations: 1 }]);
          check.close();
          const unchanged = await enterSyncPipeline(instance, {
            trigger: "manual", scope: { kind: "vendor", vendor: "gemini" }, mode: "incremental",
          }).completion;
          expect(unchanged.vendors).toEqual([]);
          expect(unchanged.afterRevisions).toEqual(result.afterRevisions);
        } finally {
          instance.close();
        }
      });
    }
  }

  test("incremental Gemini publishes an ambiguous reparse that removes all generations", async () => {
    const { directory, dbPath } = testDatabase();
    const file = emptyGeminiConversation(directory, "empty-collision");
    seedGeminiHistory(dbPath, file, "agy1", january, "target-project");
    seedGeminiHistory(dbPath, file, "main", february, "source-project");
    const instance = coordinator(dbPath, geminiIncrementalAdapters(path.dirname(file)));
    try {
      const result = await enterSyncPipeline(instance, {
        trigger: "manual", scope: { kind: "vendor", vendor: "gemini" }, mode: "incremental",
      }).completion;
      expect(result.vendors[0]).toMatchObject({ status: "success", dataChanged: true,
        diagnostics: { deltaIdentities: 2 } });
      const check = new Database(dbPath, { readonly: true });
      expect(check.query("SELECT store FROM gemini_events").all()).toEqual([]);
      expect(check.query("SELECT store, generations FROM gemini_files").all()).toEqual([{ store: "agy1", generations: 0 }]);
      check.close();
    } finally {
      instance.close();
    }
  });

  test("a second coordinator waits for the claimed run's persisted terminal state", async () => {
    const { dbPath } = testDatabase();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let heavyPasses = 0;
    const first = coordinator(dbPath, adaptersWith({
      claude: async () => {
        heavyPasses += 1;
        await gate;
        return successfulNoop();
      },
    }));
    const second = coordinator(dbPath, adaptersWith({
      claude: async () => {
        heavyPasses += 1;
        return successfulNoop();
      },
    }));
    const request = {
      trigger: "manual" as const,
      scope: { kind: "vendor" as const, vendor: "claude" as const },
      mode: "incremental" as const,
    };
    try {
      const owned = first.enter(request);
      await Bun.sleep(0);
      const external = second.enter(request);
      let settled = false;
      void external.completion.then(() => { settled = true; });
      await Bun.sleep(20);
      expect(external.owned).toBe(false);
      expect(settled).toBe(false);
      expect(heavyPasses).toBe(1);
      release();
      const [firstResult, secondResult] = await Promise.all([owned.completion, external.completion]);
      expect(secondResult.runId).toBe(firstResult.runId);
      expect(secondResult.status).toBe("success");
      expect(heavyPasses).toBe(1);
    } finally {
      release();
      first.close();
      second.close();
    }
  });

  test("global sync continues after a vendor failure and reports partial success", async () => {
    const { dbPath } = testDatabase();
    const instance = coordinator(
      dbPath,
      adaptersWith({
        grok: async () => {
          throw new Error("fixture Grok parser failure");
        },
      })
    );
    try {
      const result = await enterSyncPipeline(instance, {
        trigger: "manual",
        scope: { kind: "all" },
        mode: "incremental",
      }).completion;
      expect(result.status).toBe("partial_success");
      expect(result.vendors).toHaveLength(6);
      expect(result.vendors.find((vendor) => vendor.vendor === "grok")).toMatchObject({
        status: "failure",
        error: "fixture Grok parser failure",
      });
      expect(result.vendors.filter((vendor) => vendor.status === "success")).toHaveLength(5);
    } finally {
      instance.close();
    }
  });

  test("one-vendor full publish leaves every other vendor row and revision untouched", async () => {
    const { dbPath } = testDatabase();
    replaceClaudeRows(dbPath, "old-claude");
    const sqlite = new Database(dbPath);
    sqlite.query("INSERT INTO oc_events (store, message_id, ts) VALUES ('pc-a', 'keep-me', ?)").run(
      "2026-08-30T10:00:00.000Z"
    );
    sqlite
      .query("INSERT INTO vendor_sync_revisions (vendor, data_revision, updated_at) VALUES ('opencode', 7, ?)")
      .run("2026-08-30T10:00:00.000Z");
    sqlite
      .query("UPDATE sync_revisions SET data_revision = 7, updated_at = ? WHERE id = 1")
      .run("2026-08-30T10:00:00.000Z");
    sqlite.close();
    let claudeMode = "";
    let otherCalls = 0;
    const instance = coordinator(
      dbPath,
      adaptersWith({
        claude: async (context) => {
          claudeMode = context.mode;
          replaceClaudeRows(context.stageDbPath, "new-claude");
          return {
            processedInputs: 1,
            skippedInputs: 0,
            writtenRows: 1,
            dirtyRange: { from: "2026-08-31T10:00:00.000Z", to: "2026-08-31T10:00:00.000Z" },
            diagnostics: {},
            validationErrors: [],
          };
        },
        opencode: async () => {
          otherCalls += 1;
          return successfulNoop();
        },
      })
    );
    try {
      const result = await enterSyncPipeline(instance, {
        trigger: "manual",
        scope: { kind: "vendor", vendor: "claude" },
        mode: "full",
      }).completion;
      expect(result.status).toBe("success");
      expect(result.vendors.map((vendor) => vendor.vendor)).toEqual(["claude"]);
      expect(claudeMode).toBe("incremental");
      expect(otherCalls).toBe(0);
      const check = new Database(dbPath, { readonly: true });
      try {
        expect(check.query("SELECT call_id FROM claude_events ORDER BY call_id").all()).toEqual([{ call_id: "new-claude" }, { call_id: "old-claude" }]);
        expect(check.query("SELECT message_id FROM oc_events").get()).toEqual({ message_id: "keep-me" });
      } finally {
        check.close();
      }
      expect(vendorRevision(dbPath, "opencode")).toBe(7);
      expect(vendorRevision(dbPath, "claude")).toBe(1);
    } finally {
      instance.close();
    }
  });

  test("an identical staged result skips the expensive table publication", async () => {
    const { dbPath } = testDatabase();
    replaceClaudeRows(dbPath, "same-claude");
    let publications = 0;
    const instance = coordinator(
      dbPath,
      adaptersWith({
        claude: async (context) => {
          replaceClaudeRows(context.stageDbPath, "same-claude");
          return {
            processedInputs: 1,
            skippedInputs: 12,
            writtenRows: 1,
            dirtyRange: { from: "2026-08-31T10:00:00.000Z", to: "2026-08-31T10:00:00.000Z" },
            diagnostics: {},
            validationErrors: [],
          };
        },
      }),
      { afterPublishBeforeRevision: () => { publications += 1; } }
    );
    try {
      const result = await instance.enter({
        trigger: "manual",
        scope: { kind: "vendor", vendor: "claude" },
        mode: "full",
      }).completion;
      expect(result.status).toBe("success");
      expect(result.vendors[0]).toMatchObject({ status: "success", dataChanged: false });
      expect(result.afterRevisions.data).toBe(result.beforeRevisions.data);
      expect(result.afterRevisions.vendors).toEqual(result.beforeRevisions.vendors);
      expect(publications).toBe(0);
      const check = new Database(dbPath, { readonly: true });
      try {
        expect(check.query("SELECT call_id FROM claude_events").get()).toEqual({ call_id: "same-claude" });
      } finally {
        check.close();
      }
    } finally {
      instance.close();
    }
  });

  test("failed validation preserves the vendor's last good readable state", async () => {
    const { dbPath } = testDatabase();
    replaceClaudeRows(dbPath, "last-good");
    const instance = coordinator(
      dbPath,
      adaptersWith({
        claude: async (context) => {
          replaceClaudeRows(context.stageDbPath, "invalid-new-state");
          return {
            processedInputs: 1,
            skippedInputs: 0,
            writtenRows: 1,
            dirtyRange: { from: "2026-08-31T10:00:00.000Z", to: "2026-08-31T10:00:00.000Z" },
            diagnostics: {},
            validationErrors: ["fixture invariant failed"],
          };
        },
      })
    );
    try {
      const result = await enterSyncPipeline(instance, {
        trigger: "manual",
        scope: { kind: "vendor", vendor: "claude" },
        mode: "full",
      }).completion;
      expect(result.status).toBe("failure");
      expect(result.vendors[0]?.error).toContain("fixture invariant failed");
      const check = new Database(dbPath, { readonly: true });
      try {
        expect(check.query("SELECT call_id FROM claude_events").get()).toEqual({ call_id: "last-good" });
      } finally {
        check.close();
      }
      expect(vendorRevision(dbPath, "claude")).toBe(0);
    } finally {
      instance.close();
    }
  });

  test("data and configuration revisions remain stable across a simulated restart", async () => {
    const { dbPath } = testDatabase();
    const changing = adaptersWith({
      claude: async (context) => {
        replaceClaudeRows(context.stageDbPath, "restart-row");
        return {
          processedInputs: 1,
          skippedInputs: 0,
          writtenRows: 1,
          dirtyRange: { from: "2026-08-31T10:00:00.000Z", to: "2026-08-31T10:00:00.000Z" },
          diagnostics: {},
          validationErrors: [],
        };
      },
    });
    const first = coordinator(dbPath, changing);
    const firstResult = await enterSyncPipeline(first, {
      trigger: "manual",
      scope: { kind: "vendor", vendor: "claude" },
      mode: "incremental",
    }).completion;
    first.close();
    expect(firstResult.afterRevisions).toMatchObject({ data: 1, config: 1 });

    const restarted = coordinator(dbPath);
    try {
      const secondResult = await enterSyncPipeline(restarted, {
        trigger: "auto",
        scope: { kind: "vendor", vendor: "claude" },
        mode: "incremental",
      }).completion;
      expect(secondResult.beforeRevisions).toEqual(firstResult.afterRevisions);
      expect(secondResult.afterRevisions).toEqual(firstResult.afterRevisions);
    } finally {
      restarted.close();
    }
  });

  test("boot recovery never leaves an interrupted run permanently running", () => {
    const { dbPath } = testDatabase();
    const sqlite = new Database(dbPath);
    const revisions = {
      data: 0,
      config: 0,
      vendors: { codex: 0, claude: 0, opencode: 0, grok: 0, gemini: 0, gauges: 0 },
    };
    const interrupted = {
      runId: "interrupted-run",
      ownerPid: 2147480000,
      trigger: "auto",
      scope: { kind: "vendor", vendor: "claude" },
      mode: "incremental",
      startedAt: "2026-08-31T09:00:00.000Z",
      finishedAt: null,
      status: "running",
      beforeRevisions: revisions,
      afterRevisions: revisions,
      aggregateWorkRequested: false,
      vendors: [
        {
          vendor: "claude",
          status: "pending",
          processedInputs: 0,
          skippedInputs: 0,
          writtenRows: 0,
          dirtyRange: null,
          dataChanged: false,
          error: null,
          diagnostics: {},
          startedAt: "2026-08-31T09:00:00.000Z",
          finishedAt: null,
        },
      ],
      error: null,
    };
    sqlite
      .query(
        `INSERT INTO sync_runs (
          run_id, trigger, scope, vendor, mode, status, started_at, finished_at,
          before_data_revision, after_data_revision, before_config_revision,
          after_config_revision, result_json, error
        ) VALUES (?, 'auto', 'vendor', 'claude', 'incremental', 'running', ?, NULL, 0, 0, 0, 0, ?, NULL)`
      )
      .run(interrupted.runId, interrupted.startedAt, JSON.stringify(interrupted));
    sqlite.close();

    const restarted = coordinator(dbPath);
    try {
      expect(restarted.latest()).toMatchObject({
        runId: "interrupted-run",
        status: "failure",
        error: "Sync interrupted by process shutdown",
      });
      const check = new Database(dbPath, { readonly: true });
      try {
        expect(check.query("SELECT count(*) AS n FROM sync_runs WHERE status = 'running'").get()).toEqual({ n: 0 });
      } finally {
        check.close();
      }
    } finally {
      restarted.close();
    }
  });

  test("two synchronized processes receive one database-claimed run", async () => {
    const { directory, dbPath } = testDatabase();
    const startGate = path.join(directory, "start.gate");
    const finishGate = path.join(directory, "finish.gate");
    const fixture = path.join(import.meta.dir, "process-fixture.ts");
    const ready = [path.join(directory, "ready-1"), path.join(directory, "ready-2")];
    const results = [path.join(directory, "result-1.json"), path.join(directory, "result-2.json")];
    const children = ready.map((readyFile, index) =>
      Bun.spawn({
        cmd: [
          process.execPath,
          fixture,
          "claim",
          dbPath,
          startGate,
          finishGate,
          readyFile,
          results[index]!,
        ],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
    );
    try {
      await Promise.all(ready.map(waitForFile));
      fs.writeFileSync(startGate, "start");
      await Promise.all(results.map(waitForFile));
      const claimed = results.map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as { runId: string });
      expect(claimed[0]!.runId).toBe(claimed[1]!.runId);
      const sqlite = new Database(dbPath, { readonly: true });
      try {
        expect(sqlite.query("SELECT count(*) AS n FROM sync_runs WHERE status = 'running'").get()).toEqual({ n: 1 });
      } finally {
        sqlite.close();
      }
    } finally {
      fs.writeFileSync(finishGate, "finish");
      const exitCodes = await Promise.all(children.map((child) => child.exited));
      if (exitCodes.some((code) => code !== 0)) {
        const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
        throw new Error(`claim fixture exits ${exitCodes.join(", ")}: ${errors.join(" | ")}`);
      }
    }
  }, 30_000);

  test("a process crash inside publication rolls back rows and revisions together", async () => {
    const { dbPath } = testDatabase();
    replaceClaudeRows(dbPath, "last-good");
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "process-fixture.ts"), "crash", dbPath],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(86);

    const sqlite = new Database(dbPath, { readonly: true });
    try {
      expect(sqlite.query("SELECT call_id FROM claude_events").get()).toEqual({ call_id: "last-good" });
      expect(sqlite.query("SELECT data_revision FROM sync_revisions WHERE id = 1").get()).toEqual({
        data_revision: 0,
      });
      expect(sqlite.query("SELECT count(*) AS n FROM sync_runs WHERE status = 'running'").get()).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }

    const restarted = coordinator(dbPath);
    try {
      expect(restarted.latest()?.status).toBe("failure");
      expect(vendorRevision(dbPath, "claude")).toBe(0);
    } finally {
      restarted.close();
    }
  }, 30_000);

  test("boot recovery finalizes an all-success pre-finalization run as success", () => {
    const { dbPath } = testDatabase();
    const sqlite = new Database(dbPath);
    const revisions = {
      data: 1,
      config: 1,
      vendors: { codex: 0, claude: 1, opencode: 0, grok: 0, gemini: 0, gauges: 0 },
    };
    const run = {
      runId: "completed-before-finalization",
      ownerPid: 2147480000,
      trigger: "auto",
      scope: { kind: "vendor", vendor: "claude" },
      mode: "incremental",
      startedAt: "2026-08-31T09:00:00.000Z",
      finishedAt: null,
      status: "running",
      beforeRevisions: revisions,
      afterRevisions: revisions,
      aggregateWorkRequested: true,
      vendors: [
        {
          vendor: "claude",
          status: "success",
          processedInputs: 1,
          skippedInputs: 0,
          writtenRows: 1,
          dirtyRange: { from: "2026-08-31T09:00:00.000Z", to: "2026-08-31T09:00:00.000Z" },
          dataChanged: true,
          error: null,
          diagnostics: {},
          startedAt: "2026-08-31T09:00:00.000Z",
          finishedAt: "2026-08-31T09:01:00.000Z",
        },
      ],
      error: null,
    };
    sqlite
      .query(
        `INSERT INTO sync_runs (
          run_id, trigger, scope, vendor, mode, status, started_at, finished_at,
          before_data_revision, after_data_revision, before_config_revision,
          after_config_revision, result_json, error
        ) VALUES (?, 'auto', 'vendor', 'claude', 'incremental', 'running', ?, NULL, 1, 1, 1, 1, ?, NULL)`
      )
      .run(run.runId, run.startedAt, JSON.stringify(run));
    sqlite.close();

    const restarted = coordinator(dbPath);
    try {
      expect(restarted.latest()).toMatchObject({
        runId: run.runId,
        status: "success",
        error: null,
      });
    } finally {
      restarted.close();
    }
  });

  test("setup and pre-adapter persistence failures are durably finalized", async () => {
    for (const overrides of [
      { ensureStagingRoot: () => { throw new Error("staging unavailable"); } },
      { beforeVendorSave: () => { throw new Error("pre-adapter store unavailable"); } },
    ] satisfies Array<Partial<SyncCoordinatorOptions>>) {
      const { dbPath } = testDatabase();
      const instance = coordinator(dbPath, adaptersWith({}), overrides);
      try {
        const result = await instance.enter({
          trigger: "manual",
          scope: { kind: "vendor", vendor: "claude" },
          mode: "incremental",
        }).completion;
        expect(result.status).toBe("failure");
        expect(result.error).toContain("unavailable");
        expect(result.vendors[0]?.sourceImpact?.sourceFactsChanged).toEqual({status:"unavailable",value:null,
          reason:"sync-setup-failed-before-publication"});
        const sqlite = new Database(dbPath, { readonly: true });
        try {
          expect(sqlite.query("SELECT count(*) AS n FROM sync_runs WHERE status = 'running'").get()).toEqual({ n: 0 });
        } finally {
          sqlite.close();
        }
      } finally {
        instance.close();
      }
    }
  });

  test("a failed outer-finalizer write releases its live-PID claim for the next start", async () => {
    const { dbPath } = testDatabase();
    let setupAttempts = 0;
    const instance = coordinator(dbPath, adaptersWith({}), {
      ensureStagingRoot: (directory) => {
        setupAttempts += 1;
        if (setupAttempts === 1) throw new Error("one-shot setup failure");
        fs.mkdirSync(directory, { recursive: true });
      },
    });
    const internal = instance as unknown as {
      store: { saveRunWithBusyRetry: (result: unknown) => void };
    };
    const saveRun = internal.store.saveRunWithBusyRetry.bind(internal.store);
    let finalizerSaveAttempts = 0;
    internal.store.saveRunWithBusyRetry = (result) => {
      finalizerSaveAttempts += 1;
      if (finalizerSaveAttempts === 1) throw new Error("injected finalizer storage failure");
      saveRun(result);
    };

    try {
      const request = {
        trigger: "manual" as const,
        scope: { kind: "vendor" as const, vendor: "claude" as const },
        mode: "incremental" as const,
      };
      const first = await instance.enter(request).completion;
      expect(first.status).toBe("failure");
      expect(first.error).toContain("injected finalizer storage failure");

      const second = await instance.enter(request).completion;
      expect(second.runId).not.toBe(first.runId);
      expect(second.status).toBe("success");
      const sqlite = new Database(dbPath, { readonly: true });
      try {
        expect(sqlite.query("SELECT count(*) AS n FROM sync_runs WHERE status = 'running'").get()).toEqual({ n: 0 });
        expect(
          sqlite.query("SELECT status FROM sync_runs ORDER BY rowid").all()
        ).toEqual([{ status: "failure" }, { status: "success" }]);
      } finally {
        sqlite.close();
      }
    } finally {
      instance.close();
    }
  });

  test("full import publishes readable archive inputs despite a named mirror failure and retries after restart", async () => {
    const { dbPath } = testDatabase();
    replaceClaudeRows(dbPath, "last-good");
    let mirrorFailed = true;
    let adapterCalls = 0;
    const adapters = adaptersWith({ claude: async context => {
      adapterCalls++;
      const stage = new Database(context.stageDbPath);
      try {
        stage.run("INSERT OR IGNORE INTO claude_events(store,call_id,ts,path) VALUES('live','new',?,'new.jsonl')", [january]);
      } finally { stage.close(); }
      return { ...successfulNoop(), processedInputs: 1, writtenRows: 1, dirtyRange: { from: january, to: january } };
    } });
    const overrides = { mirror: async () => ({ copied: 1, skipped: 0, warnings: [],
      errors: mirrorFailed ? ["unreadable.jsonl: archive unavailable"] : [],
      failedFiles: mirrorFailed ? ["unreadable.jsonl"] : [],
      archiveFiles: ["new.jsonl"],
    }) };
    const request = { trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "full" } as const;
    let instance = coordinator(dbPath, adapters, overrides);
    const db = new Database(dbPath, { readonly: true });
    const facts = () => db.query("SELECT call_id FROM claude_events ORDER BY call_id").all();
    try {
      const partial = await instance.enter(request).completion;
      expect(partial.status).toBe("partial_success");
      expect(partial.vendors[0]?.inputsComplete).toBe(false);
      expect(partial.vendors[0]?.diagnostics.pendingInputsTotal).toBe(1);
      expect(facts()).toEqual([{ call_id: "last-good" }, { call_id: "new" }]);
      instance.close();
      mirrorFailed = false;
      instance = coordinator(dbPath, adapters, overrides);
      const retry = await instance.enter({ ...request, mode: "incremental" }).completion;
      expect(retry.status).toBe("success");
      expect(retry.vendors[0]?.inputsComplete).toBe(true);
      expect(adapterCalls).toBe(2);
      const incrementalFacts = facts();
      expect((await instance.enter(request).completion).status).toBe("success");
      expect(facts()).toEqual(incrementalFacts);
    } finally { db.close(); instance.close(); }
  });

  test("an unscoped collector failure still stops import alongside named file failures", async () => {
    const { dbPath } = testDatabase();
    let calls = 0;
    const instance = coordinator(dbPath, adaptersWith({ claude: async () => {
      calls++; return successfulNoop();
    } }), { mirror: async () => ({ copied: 0, skipped: 0, warnings: [],
      errors: ["unreadable.jsonl: access denied", "Cannot enumerate user profiles"],
      failedFiles: ["unreadable.jsonl"],
    }) });
    try {
      const result = await instance.enter({ trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "full" }).completion;
      expect(result.status).toBe("failure");
      expect(result.error).toContain("Cannot enumerate user profiles");
      expect(calls).toBe(0);
    } finally { instance.close(); }
  });

  test("optional mirror absence warns, while acquisition errors fail before the adapter", async () => {
    const warningDb = testDatabase().dbPath;
    let adapterCalls = 0;
    const warning = coordinator(
      warningDb,
      adaptersWith({ claude: async () => { adapterCalls += 1; return successfulNoop(); } }),
      { mirror: async () => ({ copied: 0, skipped: 0, warnings: ["source absent"], errors: [] }) }
    );
    try {
      expect((await warning.enter({
        trigger: "manual",
        scope: { kind: "vendor", vendor: "claude" },
        mode: "incremental",
      }).completion).status).toBe("success");
      expect(adapterCalls).toBe(1);
    } finally {
      warning.close();
    }

    const errorDb = testDatabase().dbPath;
    replaceClaudeRows(errorDb, "last-good");
    const failure = coordinator(
      errorDb,
      adaptersWith({ claude: async () => { adapterCalls += 1; return successfulNoop(); } }),
      { mirror: async () => ({ copied: 0, skipped: 0, warnings: [], errors: ["backup exited 1"] }) }
    );
    try {
      const result = await failure.enter({
        trigger: "manual",
        scope: { kind: "vendor", vendor: "claude" },
        mode: "incremental",
      }).completion;
      expect(result.status).toBe("failure");
      expect(result.vendors[0]?.error).toContain("backup exited 1");
      expect(adapterCalls).toBe(1);
      const sqlite = new Database(errorDb, { readonly: true });
      try {
        expect(sqlite.query("SELECT call_id FROM claude_events").get()).toEqual({ call_id: "last-good" });
      } finally {
        sqlite.close();
      }
    } finally {
      failure.close();
    }
  });
});
test("source publication reserves its snapshot before a concurrent writer", async () => {
  const {dbPath}=testDatabase();
  replaceClaudeRows(dbPath,"old");
  const instance=coordinator(dbPath,adaptersWith({claude:async context=>{
    replaceClaudeRows(context.stageDbPath,"new");
    return {...successfulNoop(),processedInputs:1,writtenRows:1,dirtyRange:{from:january,to:january}};
  }}));
  const active=(instance as unknown as {sqlite:Database}).sqlite;
  const writer=new Database(dbPath);writer.exec("PRAGMA busy_timeout=0;CREATE TABLE race_probe(key TEXT PRIMARY KEY)");
  const query=active.query.bind(active);
  let attempted=false,writeDeferred=false;
  const concurrentWrite=()=>writer.query("INSERT INTO race_probe(key) VALUES('ready')").run();
  active.query=((sql:string,...args:unknown[])=>{
    const statement=query(sql,...args as []);
    if(sql.startsWith("INSERT INTO")&&sql.includes("claude_events"))return new Proxy(statement,{
      get(target,property){
        if(property==="run")return (...bindings:unknown[])=>{
          const result=target.run(...bindings as []);
          if(active.inTransaction&&!attempted){
            attempted=true;
            try{concurrentWrite();}catch(error){if(!/database is locked|SQLITE_BUSY/i.test(String(error)))throw error;writeDeferred=true;}
          }
          return result;
        };
        const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
      },
    });
    return statement;
  }) as typeof active.query;
  try{
    const result=await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"full"}).completion;
    expect(attempted).toBe(true);expect(writeDeferred).toBe(true);
    expect(result.status).toBe("success");
    expect(writer.query("SELECT call_id FROM claude_events WHERE call_id='new'").get()).toEqual({call_id:"new"});
    concurrentWrite();
    expect(writer.query("SELECT key FROM race_probe").get()).toEqual({key:"ready"});
  }finally{active.query=query;writer.close();instance.close();}
});
