import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyAccountsDocument } from "./test-support";

test("production queued Claude sync preserves unchanged facts through append, correction, restart and missing archive", async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ta-queued-acceptance-"));
  const home=path.join(root,"users","fixture"),archive=path.join(root,"archive"),config=path.join(root,"config");
  for(const directory of [home,archive,config])fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify(emptyAccountsDocument()));
  const module=(relative:string)=>new URL(relative,import.meta.url).href;
  const script=`
    import assert from "node:assert/strict";
    import fs from "node:fs"; import path from "node:path";
    import { spyOn } from "bun:test";
    import { Database } from ${JSON.stringify(module("../db/sqlite.ts"))};
    import { drizzle } from "drizzle-orm/bun-sqlite";
    import { applyDrizzleMigrations } from ${JSON.stringify(module("../db/migrate.ts"))};
    import { SyncCoordinator } from ${JSON.stringify(module("./coordinator.ts"))};
    import { SyncFileQueue } from ${JSON.stringify(module("./file-queue.ts"))};
    import { syncFileRoots } from ${JSON.stringify(module("./mirror.ts"))};
    import { ensureArchiveIdentity } from ${JSON.stringify(module("./archive-inventory.ts"))};
    const archive=process.env.TOKENATLAS_ARCHIVE!,home=process.env.USERPROFILE!,dbPath=process.env.TOKENATLAS_DB!;
    ensureArchiveIdentity(archive);
    const source=path.join(home,".claude","projects","project","conversation.jsonl");
    const retained=path.join(archive,"claude","FIXTURE","project","conversation.jsonl");
    fs.mkdirSync(path.dirname(source),{recursive:true});
    const line=(id:string,ts:string,tokens:number)=>JSON.stringify({type:"assistant",sessionId:"session",timestamp:ts,
      message:{id,model:"claude-sonnet",usage:{input_tokens:tokens,output_tokens:1}}})+"\\n";
    const old=line("old","2026-03-01T10:00:00Z",11);
    fs.writeFileSync(source,old);
    const db=new Database(dbPath,{create:true});applyDrizzleMigrations(drizzle(db));
    let stages=0;
    const open=()=>new SyncCoordinator({dbPath,rootDir:process.cwd(),prepareStage:()=>{stages++;},
      ensureStagingRoot:(directory:string)=>{stages++;fs.mkdirSync(directory,{recursive:true});},refreshDerived:()=>{}});
    let coordinator=open();
    const queue=new SyncFileQueue(archive);
    const signal=(file:string)=>queue.signal(file,syncFileRoots());
    const request={trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental"} as const;
    const run=async()=>{const result=await coordinator.enter(request).completion;assert.equal(result.status,"success",JSON.stringify({error:result.error,vendors:result.vendors.map(v=>({vendor:v.vendor,error:v.error,diagnostics:v.diagnostics}))}));return result;};
    const revision=()=>Number((db.query("SELECT data_revision FROM sync_revisions").get() as any).data_revision);
    const rows=()=>db.query("SELECT rowid,* FROM claude_events ORDER BY call_id").all();
    try {
      const first=await run();assert.equal(first.vendors[0]!.writtenRows,1);assert.equal(fs.readFileSync(retained,"utf8"),old);
      for(const phase of ["queueListingMs","queueRecoveryMs","queueSelectionMs"])
        assert.ok(Number.isInteger(first.vendors[0]!.timings?.steps?.[phase]),phase);
      const original=rows()[0];const firstRevision=revision();
      db.exec("CREATE TABLE writes(call_id TEXT); CREATE TRIGGER audit_claude_delete AFTER DELETE ON claude_events BEGIN INSERT INTO writes VALUES(old.call_id); END; CREATE TRIGGER audit_claude_update AFTER UPDATE ON claude_events BEGIN INSERT INTO writes VALUES(old.call_id); END;");
      fs.appendFileSync(source,line("today","2026-09-19T12:00:00Z",17));signal(source);
      const appended=await run();assert.equal(revision(),firstRevision+1);assert.deepEqual(rows().find((row:any)=>row.call_id==="old"),original);
      assert.deepEqual(db.query("SELECT * FROM writes").all(),[]);
      assert.deepEqual(appended.vendors[0]!.dirtyRanges,[{from:"2026-09-19T12:00:00.000Z",to:"2026-09-19T12:00:00.000Z"}]);
      const stageCount=stages;const stableRevision=revision();
      const originalRead=fs.readdirSync;
      const scan=spyOn(fs,"readdirSync").mockImplementation(((file:any,...args:any[])=>{
        const name=path.resolve(String(file));
        if(name.startsWith(archive+path.sep)||name.startsWith(path.join(home,".claude")))throw new Error("Unexpected source/archive scan: "+name);
        return Reflect.apply(originalRead,fs,[file,...args]);
      }) as typeof fs.readdirSync);
      try{await run();assert.equal(stages,stageCount);assert.equal(revision(),stableRevision);}finally{scan.mockRestore();}
      // Queue replay after publication must not publish identical facts again.
      signal(retained);coordinator.close();coordinator=open();await run();assert.equal(revision(),stableRevision);
      const unchangedToday=rows().find((row:any)=>row.call_id==="today");db.exec("DELETE FROM writes");
      fs.writeFileSync(retained,line("old","2026-03-02T10:00:00Z",23)+line("today","2026-09-19T12:00:00Z",17));signal(retained);
      const correction=await run();assert.deepEqual(correction.vendors[0]!.dirtyRanges,[
        {from:"2026-03-01T10:00:00.000Z",to:"2026-03-01T10:00:00.000Z"},
        {from:"2026-03-02T10:00:00.000Z",to:"2026-03-02T10:00:00.000Z"}]);
      assert.equal((rows().find((row:any)=>row.call_id==="old") as any).in_uncached,23);
      assert.deepEqual(rows().find((row:any)=>row.call_id==="today"),unchangedToday);
      assert.ok(db.query("SELECT call_id FROM writes").all().every((row:any)=>row.call_id==="old"));
      const remote=path.join(archive,"claude","SECOND-PC","remote.jsonl");fs.mkdirSync(path.dirname(remote),{recursive:true});
      fs.writeFileSync(remote,line("remote","2026-09-18T12:00:00Z",29));signal(remote);
      const ack=spyOn(SyncFileQueue.prototype,"acknowledge").mockImplementation(()=>{throw new Error("Crash before queue acknowledgment");});
      let crashed;try{crashed=await coordinator.enter(request).completion;}finally{ack.mockRestore();}
      assert.equal(crashed.vendors[0]!.diagnostics.postPublicationError,"Crash before queue acknowledgment");assert.equal(rows().length,3);
      assert.ok(Number.isInteger(crashed.vendors[0]!.timings?.publicationMs));
      const committedRun=JSON.parse((db.query("SELECT result_json FROM sync_runs WHERE run_id=?").get(crashed.runId) as any).result_json);
      assert.deepEqual(committedRun.vendors[0].timings,crashed.vendors[0]!.timings);
      assert.ok(queue.take("claude",syncFileRoots()).some(row=>row.path===remote));
      const committedRevision=revision();coordinator.close();coordinator=open();await run();assert.equal(revision(),committedRevision);
      let accepted=rows();fs.unlinkSync(remote);signal(remote);
      const missing=await coordinator.enter(request).completion;assert.equal(missing.status,"failure");assert.deepEqual(rows(),accepted);
      assert.ok(queue.take("claude",syncFileRoots()).some(row=>row.path===remote&&row.fingerprint==="missing"));
      const peer=path.join(path.dirname(remote),"valid-peer.jsonl");fs.writeFileSync(peer,line("remote-peer","2026-09-18T13:00:00Z",31));signal(peer);
      const partial=await coordinator.enter(request).completion;assert.equal(partial.status,"partial_success",JSON.stringify(partial));
      assert.ok((partial.vendors[0]!.diagnostics.pendingInputs as any[]).some(item=>item.path===remote));
      assert.deepEqual(rows().filter((row:any)=>row.call_id!=="remote-peer"),accepted);
      assert.equal((rows().find((row:any)=>row.call_id==="remote-peer") as any).in_uncached,31);
      assert.ok(queue.take("claude",syncFileRoots()).some(row=>row.path===remote&&row.fingerprint==="missing"));accepted=rows();
      fs.writeFileSync(remote,line("remote","2026-09-18T12:00:00Z",29));signal(remote);await run();
      const beforeOriginalDeletion=revision(),retainedBytes=fs.readFileSync(retained,"utf8");fs.unlinkSync(source);signal(source);
      await run();assert.equal(revision(),beforeOriginalDeletion);assert.equal(fs.readFileSync(retained,"utf8"),retainedBytes);assert.deepEqual(rows(),accepted);
      // A malformed complete record must neither disappear silently nor block its peer.
      fs.writeFileSync(remote,"{ malformed complete record }\\n");signal(remote);
      fs.appendFileSync(peer,line("remote-after-malformed","2026-09-18T14:00:00Z",43));signal(peer);
      const malformed=await coordinator.enter(request).completion;assert.equal(malformed.status,"partial_success",JSON.stringify(malformed));
      assert.ok((malformed.vendors[0]!.diagnostics.pendingInputs as any[]).some(item=>item.path===remote&&item.error.includes("JSONL")));
      assert.deepEqual(rows().filter((row:any)=>row.call_id!=="remote-after-malformed"),accepted);
      assert.equal((rows().find((row:any)=>row.call_id==="remote-after-malformed") as any).in_uncached,43);
      assert.ok(queue.take("claude",syncFileRoots()).some(row=>row.path===remote));
      fs.writeFileSync(remote,line("remote","2026-09-18T12:00:00Z",29));signal(remote);await run();
      // One conflicting original must not block another original's valid append.
      const goodSource=path.join(path.dirname(source),"good-source.jsonl");fs.writeFileSync(goodSource,line("local-good","2026-09-19T13:00:00Z",37));signal(goodSource);await run();
      accepted=rows();
      const divergent=line("old","2026-03-01T10:00:00Z",71)+line("today","2026-09-19T12:00:00Z",17);
      fs.writeFileSync(source,divergent);signal(source);
      fs.appendFileSync(goodSource,line("local-appended","2026-09-19T14:00:00Z",41));signal(goodSource);
      const conflict=await coordinator.enter(request).completion;assert.equal(conflict.status,"partial_success",JSON.stringify(conflict));
      assert.ok((conflict.vendors[0]!.diagnostics.pendingInputs as any[]).some(item=>item.path===source&&item.error.includes("conflict")));
      assert.deepEqual(rows().filter((row:any)=>row.call_id!=="local-appended"),accepted);
      assert.equal((rows().find((row:any)=>row.call_id==="local-appended") as any).in_uncached,41);
      assert.equal(fs.readFileSync(retained,"utf8"),retainedBytes);
      const conflictFiles=fs.readdirSync(path.dirname(retained)).filter(name=>name.startsWith(path.basename(retained)+".conflict-"));
      assert.equal(conflictFiles.length,1);assert.equal(fs.readFileSync(path.join(path.dirname(retained),conflictFiles[0]!),"utf8"),divergent);
      const pending=queue.take("claude",syncFileRoots());assert.ok(pending.some(row=>row.path===source));assert.ok(!pending.some(row=>row.path===goodSource));
      // The SQLite parser must isolate both corrupt databases and a valid database with an invalid provider schema.
      const makeSnapshot=(profile:string,id:string,tokens:number)=>{
        const file=path.join(archive,"opencode",profile,"opencode.sqlite");fs.mkdirSync(path.dirname(file),{recursive:true});
        const snapshot=new Database(file,{create:true});
        try {snapshot.exec("CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT); INSERT INTO session VALUES('s','C:/fixture');");
          snapshot.query("INSERT INTO message VALUES(?,'s',?)").run(id,JSON.stringify({role:"assistant",modelID:"model",time:{created:Date.parse("2026-09-19T10:00:00Z")},tokens:{input:tokens,output:1}}));
        } finally {snapshot.close();}
        signal(file);return file;
      };
      const badDb=makeSnapshot("BAD","bad-accepted",5),goodDb=makeSnapshot("GOOD","good-accepted",7);
      const dbRequest={...request,scope:{kind:"vendor",vendor:"opencode"}} as const;
      let databaseRun=await coordinator.enter(dbRequest).completion;assert.equal(databaseRun.status,"success",JSON.stringify(databaseRun));
      const acceptedDatabase=db.query("SELECT rowid,* FROM oc_events WHERE store='BAD'").all(),originalDatabase=fs.readFileSync(badDb);
      for(const [index,kind] of ["corrupt","schema"].entries()) {
        if(kind==="corrupt")fs.writeFileSync(badDb,"not a SQLite database");
        else {fs.writeFileSync(badDb,originalDatabase);const broken=new Database(badDb);try{broken.exec("DROP TABLE session");}finally{broken.close();}}
        signal(badDb);const good=new Database(goodDb);
        try {good.query("INSERT INTO message VALUES(?,'s',?)").run("new-"+index,JSON.stringify({role:"assistant",modelID:"model",time:{created:Date.parse("2026-09-19T11:00:00Z")},tokens:{input:47+index,output:1}}));}finally{good.close();}
        signal(goodDb);databaseRun=await coordinator.enter(dbRequest).completion;
        assert.equal(databaseRun.status,"partial_success",JSON.stringify(databaseRun));
        assert.ok((databaseRun.vendors[0]!.diagnostics.pendingInputs as any[]).some(item=>item.path===badDb));
        assert.deepEqual(db.query("SELECT rowid,* FROM oc_events WHERE store='BAD'").all(),acceptedDatabase);
        assert.equal((db.query("SELECT in_tok FROM oc_events WHERE store='GOOD' AND message_id=?").get("new-"+index) as any).in_tok,47+index);
        assert.ok(queue.take("opencode",syncFileRoots()).some(row=>row.path===badDb));
      }
      console.log("QUEUED_ACCEPTANCE_PASS");
    } finally {coordinator.close();queue.close();db.close();}
  `;
  const child=Bun.spawn([process.execPath,"--eval",script],{cwd:path.resolve(import.meta.dir,"../.."),env:{...process.env,
    TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(root,"state"),TOKENATLAS_DB:path.join(root,"atlas.sqlite"),
    TOKENATLAS_MACHINE:"FIXTURE",TOKENATLAS_LOGIN:"fixture",USERPROFILE:home,HOME:home,APPDATA:path.join(home,"AppData","Roaming")},stdout:"pipe",stderr:"pipe"});
  try {
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,stderr,stdout}).toMatchObject({exit:0,stderr:""});expect(stdout).toContain("QUEUED_ACCEPTANCE_PASS");
  } finally {
    await child.exited;
    if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith("ta-queued-acceptance-"))throw new Error("Unsafe fixture cleanup");
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
},60000);
