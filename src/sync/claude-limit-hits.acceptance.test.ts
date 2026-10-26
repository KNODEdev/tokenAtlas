import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyAccountsDocument } from "./test-support";

// Parser 5 publishes Claude Code's limit refusals beside the file's events, and a database indexed by
// an earlier parser gets them by revisiting only the files that hold one.
test("Claude limit refusals are published with their file and revisited once in files an older parser read", async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ta-claude-limit-hits-"));
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
    import { CLAUDE_PARSER_VERSION } from ${JSON.stringify(module("../ingest/claude.ts"))};
    import { CLAUDE_LIMIT_TASK } from ${JSON.stringify(module("./claude-limit-backfill.ts"))};
    const archive=process.env.TOKENATLAS_ARCHIVE!,dbPath=process.env.TOKENATLAS_DB!;
    ensureArchiveIdentity(archive);
    const source=(name:string)=>{
      const file=path.join(archive,"claude","PC-ONE","project",name);
      fs.mkdirSync(path.dirname(file),{recursive:true});return file;
    };
    const call=(id:string,ts:string)=>JSON.stringify({type:"assistant",sessionId:"session",timestamp:ts,
      message:{id,model:"claude-sonnet",stop_reason:"end_turn",usage:{input_tokens:10,output_tokens:2}}})+"\\n";
    const refusal=(id:string,ts:string)=>JSON.stringify({type:"assistant",sessionId:"session",timestamp:ts,error:"rate_limit",
      isApiErrorMessage:true,message:{id,model:"<synthetic>",stop_reason:"stop_sequence",usage:{input_tokens:0,output_tokens:0},
      content:[{type:"text",text:"You've hit your weekly limit"}]},
      quotaLimits:{status:"rejected",resetsAt:1790506800,rateLimitType:"seven_day"}})+"\\n";
    const db=new Database(dbPath,{create:true});applyDrizzleMigrations(drizzle(db));
    const coordinator=new SyncCoordinator({dbPath,rootDir:process.cwd(),prepareStage:()=>{},refreshDerived:()=>{}});
    const queue=new SyncFileQueue(archive);
    const signal=(file:string)=>queue.signal(file,syncFileRoots());
    const request={trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental"} as const;
    const run=async(step:string)=>{
      const result=await coordinator.enter(request).completion;
      assert.equal(result.status,"success",step+": "+JSON.stringify(result.vendors.map(v=>({vendor:v.vendor,error:v.error}))));
    };
    const hits=()=>db.query("SELECT id AS rid,store,call_id,ts,limit_type,status,resets_at,path FROM claude_limit_hits ORDER BY call_id").all() as any[];
    const events=()=>db.query("SELECT rowid,* FROM claude_events ORDER BY call_id").all();
    try {
      const limited=source("limited.jsonl"),plain=source("plain.jsonl");
      fs.writeFileSync(limited,call("before","2026-09-23T21:40:00Z")+refusal("refused","2026-09-23T21:46:18.888Z"));
      fs.writeFileSync(plain,call("other","2026-09-23T20:00:00Z"));
      signal(limited);signal(plain);await run("first publication");
      assert.deepEqual(hits().map(({rid,...row})=>row),[{store:"live",call_id:"refused",ts:"2026-09-23T21:46:18.888Z",
        limit_type:"seven_day",status:"rejected",resets_at:"2026-09-27T11:00:00.000Z",path:limited}]);
      // The refusal stays an ordinary (zero-token) event as well.
      assert.deepEqual((events() as any[]).map(row=>row.call_id),["before","other","refused"]);

      // A reread of the file keeps an unchanged refusal row in place.
      const published=hits();
      fs.appendFileSync(limited,call("after","2026-09-23T21:50:00Z"));
      signal(limited);await run("appended file");
      assert.deepEqual(hits(),published);

      // A database indexed by parser 3: the refusal was never recorded and the bookmarks are older.
      db.exec("DELETE FROM claude_limit_hits");
      db.query("UPDATE claude_files SET parser_version=3").run();
      queue.setTaskState(CLAUDE_LIMIT_TASK,JSON.stringify({after:""}));
      const retained=events();
      await run("one-time revisit");
      assert.deepEqual(hits().map(row=>row.call_id),["refused"]);
      // Only the file holding a refusal was read again whole; no event row was rewritten. The other file is then
      // read once by the response-time pass (parser 6), which writes times only (none here: no user records).
      assert.deepEqual(events(),retained);
      assert.deepEqual(db.query("SELECT path,parser_version FROM claude_files ORDER BY path").all(),
        [{path:limited,parser_version:CLAUDE_PARSER_VERSION},{path:plain,parser_version:CLAUDE_PARSER_VERSION}]);
      assert.equal(queue.taskState(CLAUDE_LIMIT_TASK),"done");

      const older=source("older-text.jsonl"),old=JSON.parse(refusal("old-refused","2026-03-07T10:03:23.098Z"));
      delete old.quotaLimits;
      old.message.content[0].text="You've hit your limit · resets 8am (Europe/Warsaw)";
      fs.writeFileSync(older,call("old-before","2026-03-07T10:00:00Z")+JSON.stringify(old)+"\\n");
      signal(older);await run("text publication");
      assert.deepEqual(hits().find(row=>row.call_id==="old-refused")?.resets_at,"2026-03-08T07:00:00.000Z");
      db.query("DELETE FROM claude_limit_hits WHERE call_id='old-refused'").run();
      db.query("UPDATE claude_files SET parser_version=4 WHERE path=?").run(older);
      queue.setTaskState(CLAUDE_LIMIT_TASK,JSON.stringify({after:""}));
      const beforeTextRevisit=events();
      await run("text one-time revisit");
      assert.equal(hits().find(row=>row.call_id==="old-refused")?.limit_type,"seven_day");
      assert.deepEqual(events(),beforeTextRevisit);
      assert.equal((db.query("SELECT parser_version FROM claude_files WHERE path=?").get(older) as any).parser_version,CLAUDE_PARSER_VERSION);
      console.log("CLAUDE_LIMIT_HITS_PASS");
    } finally {coordinator.close();queue.close();db.close();}
  `;
  const child=Bun.spawn([process.execPath,"--eval",script],{cwd:path.resolve(import.meta.dir,"../.."),env:{...process.env,
    TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(root,"state"),TOKENATLAS_DB:path.join(root,"atlas.sqlite"),
    TOKENATLAS_MACHINE:"FIXTURE",TOKENATLAS_LOGIN:"fixture",USERPROFILE:home,HOME:home,APPDATA:path.join(home,"AppData","Roaming")},stdout:"pipe",stderr:"pipe"});
  try {
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,stderr,stdout}).toMatchObject({exit:0,stderr:""});expect(stdout).toContain("CLAUDE_LIMIT_HITS_PASS");
  } finally {
    await child.exited;
    if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith("ta-claude-limit-hits-"))throw new Error("Unsafe fixture cleanup");
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
},90000);
