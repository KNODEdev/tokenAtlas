import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyAccountsDocument } from "./test-support";

// A resumed Claude session repeats earlier messages, and every archive profile
// that is not a desktop export shares the `live` store, so one call can be
// present in several files while `claude_events` keeps one row per call.
test("Claude publication merges a call shared by several archive files without losing the more complete fact", async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ta-claude-call-identity-"));
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
    const archive=process.env.TOKENATLAS_ARCHIVE!,dbPath=process.env.TOKENATLAS_DB!;
    ensureArchiveIdentity(archive);
    const source=(profile:string,name:string)=>{
      const file=path.join(archive,"claude",profile,"project",name);
      fs.mkdirSync(path.dirname(file),{recursive:true});return file;
    };
    const line=(id:string,ts:string,input:number,output:number)=>JSON.stringify({type:"assistant",sessionId:"session",
      timestamp:ts,message:{id,model:"claude-sonnet",usage:{input_tokens:input,output_tokens:output}}})+"\\n";
    const db=new Database(dbPath,{create:true});applyDrizzleMigrations(drizzle(db));
    const coordinator=new SyncCoordinator({dbPath,rootDir:process.cwd(),prepareStage:()=>{},refreshDerived:()=>{}});
    const queue=new SyncFileQueue(archive);
    const signal=(file:string)=>queue.signal(file,syncFileRoots());
    const request={trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental"} as const;
    const run=async(step:string)=>{
      const result=await coordinator.enter(request).completion;
      assert.equal(result.status,"success",step+": "+JSON.stringify(result.vendors.map(v=>({vendor:v.vendor,error:v.error}))));
      return result;
    };
    const facts=()=>db.query("SELECT store,call_id,path,in_uncached,out_total,account_key,subscription_id,subscription_conflict FROM claude_events ORDER BY call_id").all() as any[];
    const fact=(call:string)=>facts().find(row=>row.call_id===call);
    const revision=()=>Number((db.query("SELECT data_revision FROM sync_revisions").get() as any).data_revision);
    try {
      const first=source("PC-ONE","first.jsonl"),second=source("PC-TWO","second.jsonl");
      fs.writeFileSync(first,line("solo","2026-03-01T10:00:00Z",11,1)+line("shared","2026-03-01T11:00:00Z",40,5));
      signal(first);await run("first publication");
      assert.deepEqual(facts().map(row=>row.call_id),["shared","solo"]);
      assert.ok(facts().every(row=>row.store==="live"),"every non-desktop profile publishes into the live store");
      // A second machine's resumed copy repeats the call with a shorter reading.
      const retained=db.query("SELECT rowid,* FROM claude_events ORDER BY call_id").all();
      db.exec("CREATE TABLE writes(call_id TEXT); CREATE TRIGGER audit_delete AFTER DELETE ON claude_events BEGIN INSERT INTO writes VALUES(old.call_id); END; CREATE TRIGGER audit_update AFTER UPDATE ON claude_events BEGIN INSERT INTO writes VALUES(old.call_id); END;");
      fs.writeFileSync(second,line("fresh","2026-03-02T10:00:00Z",23,1)+line("shared","2026-03-01T11:00:00Z",40,3));
      signal(second);await run("resumed copy of the same call");
      // The weaker duplicate adds its own call and leaves the retained rows untouched.
      assert.deepEqual(db.query("SELECT * FROM writes").all(),[]);
      assert.deepEqual(db.query("SELECT rowid,* FROM claude_events WHERE call_id IN ('shared','solo') ORDER BY call_id").all(),retained);
      assert.deepEqual(facts().map(row=>row.call_id),["fresh","shared","solo"]);
      assert.deepEqual(fact("shared"),{store:"live",call_id:"shared",path:first,in_uncached:40,out_total:5,
        account_key:null,subscription_id:null,subscription_conflict:0});
      // The same call read more completely from the changed file wins.
      fs.writeFileSync(second,line("fresh","2026-03-02T10:00:00Z",23,1)+line("shared","2026-03-01T11:00:00Z",70,9));
      signal(second);await run("more complete reading of the changed file");
      assert.deepEqual(facts().map(row=>row.call_id),["fresh","shared","solo"]);
      assert.deepEqual(fact("shared"),{store:"live",call_id:"shared",path:second,in_uncached:70,out_total:9,
        account_key:null,subscription_id:null,subscription_conflict:0});
      // An accepted attribution conflict must survive a reread of another file.
      db.query("UPDATE claude_events SET account_key=?,subscription_id=NULL,subscription_conflict=1 WHERE call_id=?")
        .run("ACC-A","shared");
      fs.appendFileSync(first,line("later","2026-03-03T10:00:00Z",13,1));
      signal(first);await run("reread beside a retained conflict");
      assert.deepEqual(facts().map(row=>row.call_id),["fresh","later","shared","solo"]);
      assert.deepEqual(fact("shared"),{store:"live",call_id:"shared",path:second,in_uncached:70,out_total:9,
        account_key:"ACC-A",subscription_id:null,subscription_conflict:1});
      // An unchanged source must not reprice or rewrite a published call.
      const published=db.query("SELECT rowid,* FROM claude_events ORDER BY call_id").all();
      const stable=revision();signal(second);await run("unchanged source");
      assert.equal(revision(),stable);
      assert.deepEqual(db.query("SELECT rowid,* FROM claude_events ORDER BY call_id").all(),published);
      console.log("CLAUDE_CALL_IDENTITY_PASS");
    } finally {coordinator.close();queue.close();db.close();}
  `;
  const child=Bun.spawn([process.execPath,"--eval",script],{cwd:path.resolve(import.meta.dir,"../.."),env:{...process.env,
    TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(root,"state"),TOKENATLAS_DB:path.join(root,"atlas.sqlite"),
    TOKENATLAS_MACHINE:"FIXTURE",TOKENATLAS_LOGIN:"fixture",USERPROFILE:home,HOME:home,APPDATA:path.join(home,"AppData","Roaming")},stdout:"pipe",stderr:"pipe"});
  try {
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,stderr,stdout}).toMatchObject({exit:0,stderr:""});expect(stdout).toContain("CLAUDE_CALL_IDENTITY_PASS");
  } finally {
    await child.exited;
    if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith("ta-claude-call-identity-"))throw new Error("Unsafe fixture cleanup");
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
},60000);
