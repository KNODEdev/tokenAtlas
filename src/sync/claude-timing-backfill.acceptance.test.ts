import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyAccountsDocument } from "./test-support";

// Parser 6 records each call's response time. A database indexed by parser 5 gets the times in place:
// the files are read again, only `resp_ms` is written, every row keeps its id, and the pass resumes from
// the files' own parser versions.
test("Claude response times are imported with parser 6 and filled in place for files an older parser read", async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ta-claude-timing-"));
  const home=path.join(root,"users","fixture"),archive=path.join(root,"archive"),config=path.join(root,"config");
  for(const directory of [home,archive,config])fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify(emptyAccountsDocument()));
  const module=(relative:string)=>new URL(relative,import.meta.url).href;
  const script=`
    import assert from "node:assert/strict";
    import fs from "node:fs"; import path from "node:path";
    import { Database } from ${JSON.stringify(module("../db/sqlite.ts"))};
    import { drizzle } from "drizzle-orm/bun-sqlite";
    import { applyDrizzleMigrations } from ${JSON.stringify(module("../db/migrate.ts"))};
    import { SyncCoordinator } from ${JSON.stringify(module("./coordinator.ts"))};
    import { SyncFileQueue } from ${JSON.stringify(module("./file-queue.ts"))};
    import { syncFileRoots } from ${JSON.stringify(module("./mirror.ts"))};
    import { ensureArchiveIdentity } from ${JSON.stringify(module("./archive-inventory.ts"))};
    import { backfillClaudeTiming } from ${JSON.stringify(module("./claude-timing-backfill.ts"))};
    import { ParsePool } from ${JSON.stringify(module("../ingest/parse-pool.ts"))};
    import { CLAUDE_PARSER_VERSION } from ${JSON.stringify(module("../ingest/claude.ts"))};
    const archive=process.env.TOKENATLAS_ARCHIVE!,dbPath=process.env.TOKENATLAS_DB!;
    ensureArchiveIdentity(archive);
    const source=(name:string)=>{
      const file=path.join(archive,"claude","PC-ONE","project",name);
      fs.mkdirSync(path.dirname(file),{recursive:true});return file;
    };
    const line=(value:object)=>JSON.stringify(value)+"\\n";
    const session=(prefix:string,start:number)=>{
      const at=(ms:number)=>new Date(Date.parse("2026-10-01T10:00:00Z")+start+ms).toISOString();
      return line({type:"user",uuid:prefix+"-u",parentUuid:null,sessionId:prefix,timestamp:at(0),message:{role:"user",content:"go"}})
        +line({type:"assistant",uuid:prefix+"-a1",parentUuid:prefix+"-u",sessionId:prefix,timestamp:at(1500),
          message:{id:prefix+"-call",model:"claude-sonnet",usage:{input_tokens:10,output_tokens:1}}})
        +line({type:"assistant",uuid:prefix+"-a2",parentUuid:prefix+"-a1",sessionId:prefix,timestamp:at(4000),
          message:{id:prefix+"-call",model:"claude-sonnet",stop_reason:"end_turn",usage:{input_tokens:10,output_tokens:400}}})
        +line({type:"assistant",uuid:prefix+"-x",parentUuid:"elsewhere",sessionId:prefix,timestamp:at(9000),
          message:{id:prefix+"-orphan",model:"claude-sonnet",stop_reason:"end_turn",usage:{input_tokens:10,output_tokens:5}}});
    };
    const db=new Database(dbPath,{create:true});applyDrizzleMigrations(drizzle(db));
    const coordinator=new SyncCoordinator({dbPath,rootDir:process.cwd(),prepareStage:()=>{},refreshDerived:()=>{}});
    const queue=new SyncFileQueue(archive);
    const signal=(file:string)=>queue.signal(file,syncFileRoots());
    const request={trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental"} as const;
    const run=async(step:string)=>{
      const result=await coordinator.enter(request).completion;
      assert.equal(result.status,"success",step+": "+JSON.stringify(result.vendors.map(v=>({vendor:v.vendor,error:v.error}))));
    };
    const events=()=>db.query("SELECT rowid,call_id,path,out_total,resp_ms FROM claude_events ORDER BY call_id").all() as any[];
    const versions=()=>db.query("SELECT path,parser_version FROM claude_files ORDER BY path").all() as any[];
    try {
      const one=source("one.jsonl"),two=source("two.jsonl");
      fs.writeFileSync(one,session("one",0));fs.writeFileSync(two,session("two",60_000));
      signal(one);signal(two);await run("first publication");
      const imported=events();
      // Last block minus the user record of the first block's parent; a call without its start stays unknown.
      assert.deepEqual(imported.map(row=>[row.call_id,row.resp_ms]),[["one-call",4000],["one-orphan",null],["two-call",4000],["two-orphan",null]]);
      assert.deepEqual(versions().map(row=>row.parser_version),[CLAUDE_PARSER_VERSION,CLAUDE_PARSER_VERSION]);

      // A database indexed by parser 5: no times. One cycle fills them in place.
      db.exec("UPDATE claude_events SET resp_ms=NULL");db.query("UPDATE claude_files SET parser_version=5").run();
      await run("timing pass");
      assert.deepEqual(events(),imported);
      assert.deepEqual(versions().map(row=>row.parser_version),[CLAUDE_PARSER_VERSION,CLAUDE_PARSER_VERSION]);

      // Interrupted after the batch of file one: its times are written and its version moved; file two waits.
      db.exec("UPDATE claude_events SET resp_ms=NULL");db.query("UPDATE claude_files SET parser_version=5").run();
      db.query("UPDATE claude_events SET resp_ms=4000 WHERE call_id='one-call'").run();
      db.query("UPDATE claude_files SET parser_version=? WHERE path=?").run(CLAUDE_PARSER_VERSION,one);
      const pool=new ParsePool(1);
      try {
        const write=async<T,>(apply:()=>T)=>apply();
        const resumed=await backfillClaudeTiming(db,pool,write);
        assert.deepEqual({files:resumed.files,updated:resumed.updated,done:resumed.done},{files:1,updated:1,done:true});
        assert.deepEqual(events(),imported);
        const idle=await backfillClaudeTiming(db,pool,write);
        assert.deepEqual({files:idle.files,updated:idle.updated,done:idle.done},{files:0,updated:0,done:true});
        // A file changed since its import is left to the import, which reads it whole.
        db.query("UPDATE claude_files SET parser_version=5 WHERE path=?").run(one);
        fs.appendFileSync(one,"\\n");
        const changed=await backfillClaudeTiming(db,pool,write);
        assert.deepEqual({files:changed.files,skipped:changed.skipped},{files:0,skipped:1});
      } finally { await pool.close(); }
      console.log("CLAUDE_TIMING_PASS");
    } finally {coordinator.close();queue.close();db.close();}
  `;
  const child=Bun.spawn([process.execPath,"--eval",script],{cwd:path.resolve(import.meta.dir,"../.."),env:{...process.env,
    TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(root,"state"),TOKENATLAS_DB:path.join(root,"atlas.sqlite"),
    TOKENATLAS_MACHINE:"FIXTURE",TOKENATLAS_LOGIN:"fixture",USERPROFILE:home,HOME:home,APPDATA:path.join(home,"AppData","Roaming")},stdout:"pipe",stderr:"pipe"});
  try {
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,stderr,stdout}).toMatchObject({exit:0,stderr:""});expect(stdout).toContain("CLAUDE_TIMING_PASS");
  } finally {
    await child.exited;
    if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith("ta-claude-timing-"))throw new Error("Unsafe fixture cleanup");
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
},90000);
