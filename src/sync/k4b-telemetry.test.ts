import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createTestDatabase,adaptersWith,noMirror,successfulNoop } from "./test-support";
import { removeTestFixture } from "../test-cleanup";
import { inspectJsonl, validateArchivedJsonl } from "./jsonl-inspection";
import { SyncCoordinator } from "./coordinator";
import { liveProgressPath, withLiveProgress } from "./live-progress";
import { progressDirectory, readProgress } from "./progress";
import { SyncStore } from "./store";
import { IngestTimer } from "../ingest/ingest-timings";
import { Database } from "../db/sqlite";

test("validation retains JSONL validity and byte errors without the redundant digest pass",()=>{
  const f=createTestDatabase(),file=path.join(f.directory,"source.jsonl");
  try {
    for(const content of ["",'{"text":"ą\u2028\u2029"}\r\n',"{}", "{}\n{broken}\n", "{}\n{torn", JSON.stringify({text:"ą".repeat(600000)})+"\n"]){
      fs.writeFileSync(file,content);
      const error=(work:()=>unknown)=>{try{work();return null;}catch(error){return String(error);}};
      expect(error(()=>validateArchivedJsonl(file))).toBe(error(()=>inspectJsonl(file,true)));
    }
    const line=JSON.stringify({timestamp:"2026-09-01T00:00:00Z",message:"x".repeat(4096)})+"\n";
    const chunk=line.repeat(256),fd=fs.openSync(file,"w");try{for(let i=0;i<64;i++)fs.writeSync(fd,chunk);}finally{fs.closeSync(fd);}
    let started=performance.now();inspectJsonl(file,true);const referenceMs=performance.now()-started;
    started=performance.now();validateArchivedJsonl(file);const validationMs=performance.now()-started;
    console.info(JSON.stringify({entryPoint:"validateArchivedJsonl (queued validator worker entry) versus inspectJsonl",mode:"complete archived JSONL",sample:`16384 records / ${fs.statSync(file).size} bytes`,excludes:["worker startup","ingest","publication"],referenceMs,validationMs}));
  }finally{removeTestFixture(f.directory,{recursive:true,force:true});}
});

test("ongoing importer steps are attributed before completion",async()=>{
  const timer=new IngestTimer(),end=timer.begin("journalReadMs","parseMs");
  await Bun.sleep(10);
  const active=timer.snapshot();expect(active.parseMs).toBeGreaterThan(0);expect(active.steps!.journalReadMs).toBe(active.parseMs);
  end();timer.stop();expect(timer.snapshot().restMs).toBeLessThan(5);
});

test("run progress stays visible while another writer holds the database (live progress file)",async()=>{
  const f=createTestDatabase();let ready!:()=>void,locked!:()=>void,reported!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>ready=resolve),lockTaken=new Promise<void>(resolve=>locked=resolve);
  const progressed=new Promise<void>(resolve=>reported=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const c=new SyncCoordinator({dbPath:f.dbPath,rootDir:process.cwd(),mirror:noMirror,configFingerprint:()=>"fixture",sourceFingerprint:()=>"fixture",prepareStage:()=>{},refreshDerived:()=>{},
    adapters:adaptersWith({claude:async context=>{ready();await lockTaken;context.onFileProgress?.(5,10);reported();await gate;return successfulNoop();}})});
  const run=c.enter({mode:"incremental",trigger:"auto",scope:{kind:"vendor",vendor:"claude"}});
  const writer=new Database(f.dbPath),reader=new Database(f.dbPath,{readonly:true});
  const persisted=()=>new SyncStore(reader).activeRun();
  try{
    await started;
    writer.exec("BEGIN IMMEDIATE");locked();await progressed;
    await Bun.sleep(300); // a counter inside the 250 ms write interval is written when it ends
    // The run record cannot change while another writer holds the database; the file counter
    // is in the progress register, which needs no database.
    const live=withLiveProgress(f.dbPath,persisted())!;
    expect(live.progress).toMatchObject({phase:"ingest",vendor:"claude"});
    expect(readProgress(progressDirectory(f.dbPath)).map(({scope,step,done,total})=>({scope,step,done,total})))
      .toEqual([{scope:"sync:claude",step:"parse",done:5,total:10}]);
    writer.exec("ROLLBACK");release();
    const finished=await run.completion;expect(finished.status).toBe("success");
    expect(liveProgressPath(f.dbPath,finished.runId)&&fs.existsSync(liveProgressPath(f.dbPath,finished.runId)!)).toBe(false);
  }finally{if(writer.inTransaction)writer.exec("ROLLBACK");release();await run.completion;writer.close();reader.close();c.close();removeTestFixture(f.directory,{recursive:true,force:true});}
});
