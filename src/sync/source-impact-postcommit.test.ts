import {expect,test} from "bun:test";
import {Database} from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import {SyncCoordinator} from "./coordinator";
import {adaptersWith,createTestDatabase,noMirror,successfulNoop} from "./test-support";

test.each(["full","incremental"] as const)("a %s publication survives a stage cleanup failure with derived work and truthful receipt",async(mode)=>{
  const {directory,dbPath}=createTestDatabase();
  let derived=false;
  const coordinator=new SyncCoordinator({ archiveInputs: () => undefined,dbPath,rootDir:process.cwd(),mirror:noMirror,
    configFingerprint:()=>"postcommit-fixture",sourceFingerprint:()=>"postcommit-source",
    adapters:adaptersWith({claude:async({stageDbPath})=>{
      const stage=new Database(stageDbPath);
      try {stage.exec("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','new','new.jsonl','2026-09-01T00:00:00Z',10)");}
      finally {stage.close(true);}
      return {...successfulNoop(),processedInputs:1,writtenRows:1,
        dirtyRange:{from:"2026-09-01T00:00:00Z",to:"2026-09-01T00:00:00Z"}};
    }}),
    prepareStage:(stage)=>{
      const close=stage.close.bind(stage);
      stage.close=(...args:Parameters<Database["close"]>)=>{
        close(...args);
        const observer=new Database(dbPath,{readonly:true});
        let published=false;
        try {
          const row=observer.query("SELECT result_json FROM sync_runs ORDER BY rowid DESC LIMIT 1").get() as {result_json:string}|null;
          published=!!row&&JSON.parse(row.result_json).vendors[0]?.status==="success";
        } finally {observer.close(true);}
        if(published)throw new Error("synthetic post-commit cleanup failure");
      };
    },
    refreshDerived:(_db,result,_domains,affected)=>{
      derived=result.vendors[0]?.dataChanged===true;
      if(mode==="incremental")expect(affected.has("claude")).toBe(true);
    },
  });
  try {
    const result=await coordinator.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode}).completion;
    expect({status:result.status,error:result.error,vendorError:result.vendors[0]?.error}).toEqual({status:"success",error:null,vendorError:null});
    expect(derived).toBe(true);
    expect(result.afterRevisions.data).toBeGreaterThan(result.beforeRevisions.data);
    expect(result.vendors[0]).toMatchObject({status:"success",dataChanged:true,
      sourceImpact:{sourceFactsChanged:{status:"available",value:"1"}},
      diagnostics:{postPublicationError:"synthetic post-commit cleanup failure"}});
    const db=new Database(dbPath,{readonly:true});
    try {
      expect(db.query("SELECT in_uncached FROM claude_events WHERE call_id='new'").get()).toEqual({in_uncached:10});
      const persisted=JSON.parse((db.query("SELECT result_json FROM sync_runs WHERE run_id=?").get(result.runId) as {result_json:string}).result_json);
      expect(persisted.vendors[0]).toEqual(result.vendors[0]);
    } finally {db.close(true);}
  } finally {
    coordinator.close();Bun.gc(true);
    if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith("tokenatlas-sync-test-"))throw new Error("Unexpected synthetic fixture directory");
    removeTestFixture(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
