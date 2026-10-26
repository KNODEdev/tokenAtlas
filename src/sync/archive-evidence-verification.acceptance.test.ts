import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyAccountsDocument } from "./test-support";

// A mirrored working tree carries files no calculation reads: tool results,
// attachments, links inside an agent's outputs. They must stay visible and
// queued without reporting the vendor's facts as incomplete - while an input
// that no calculation could read still does.
test("an unreadable archive file only fails the vendor when a calculation reads it", async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ta-archive-evidence-"));
  const home=path.join(root,"users","fixture"),archive=path.join(root,"archive"),config=path.join(root,"config");
  const external=path.join(root,"external");
  for(const directory of [home,archive,config,external])fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(external,"tool-result.txt"),"attachment bytes");
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
    const archive=process.env.TOKENATLAS_ARCHIVE!,dbPath=process.env.TOKENATLAS_DB!,external=process.env.TA_EXTERNAL!;
    ensureArchiveIdentity(archive);
    const project=path.join(archive,"claude","PC","project");fs.mkdirSync(project,{recursive:true});
    const transcript=path.join(project,"session.jsonl");
    fs.writeFileSync(transcript,JSON.stringify({type:"assistant",sessionId:"session",timestamp:"2026-03-01T10:00:00Z",
      message:{id:"call",model:"claude-sonnet",usage:{input_tokens:19,output_tokens:1}}})+"\\n");
    // A link inside a mirrored agent output tree: never read by a calculation.
    const link=path.join(project,"outputs");
    fs.symlinkSync(external,link,process.platform==="win32"?"junction":"dir");
    const db=new Database(dbPath,{create:true});applyDrizzleMigrations(drizzle(db));
    const coordinator=new SyncCoordinator({dbPath,rootDir:process.cwd(),prepareStage:()=>{},refreshDerived:()=>{}});
    const queue=new SyncFileQueue(archive);
    const request={trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental"} as const;
    try {
      queue.signal(transcript,syncFileRoots());queue.signal(link,syncFileRoots());queue.close();
      const first=await coordinator.enter(request).completion;
      const claude=first.vendors[0]!;
      assert.equal(first.status,"success",JSON.stringify({error:first.error,vendor:claude.error,diagnostics:claude.diagnostics}));
      assert.equal(claude.writtenRows,1);
      assert.equal(db.query("SELECT count(*) AS n FROM claude_events").get().n,1);
      assert.equal(claude.diagnostics.pendingInputs,undefined);
      const evidence=claude.diagnostics.unreadableEvidence as Array<{path:string;error:string}>;
      assert.ok(evidence.some(item=>path.resolve(item.path)===path.resolve(link)&&item.error.includes("symbolic link")),
        JSON.stringify(evidence));
      // The same failure on a calculation input keeps the vendor incomplete.
      const unreadableInput=path.join(project,"unreadable.jsonl");
      fs.symlinkSync(external,unreadableInput,process.platform==="win32"?"junction":"dir");
      const retry=new SyncFileQueue(archive);retry.signal(unreadableInput,syncFileRoots());retry.close();
      const second=await coordinator.enter(request).completion;
      assert.notEqual(second.status,"success");
      const failed=second.vendors[0]!;
      const reported=JSON.stringify({error:failed.error,pending:failed.diagnostics.pendingInputs});
      assert.ok(reported.includes("unreadable.jsonl"),reported);
      assert.equal(db.query("SELECT count(*) AS n FROM claude_events").get().n,1);
      console.log("ARCHIVE_EVIDENCE_PASS");
    } finally {coordinator.close();db.close();}
  `;
  const child=Bun.spawn([process.execPath,"--eval",script],{cwd:path.resolve(import.meta.dir,"../.."),env:{...process.env,
    TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(root,"state"),TOKENATLAS_DB:path.join(root,"atlas.sqlite"),
    TOKENATLAS_MACHINE:"FIXTURE",TOKENATLAS_LOGIN:"fixture",TA_EXTERNAL:external,
    USERPROFILE:home,HOME:home,APPDATA:path.join(home,"AppData","Roaming")},stdout:"pipe",stderr:"pipe"});
  try {
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,stderr,stdout}).toMatchObject({exit:0,stderr:""});expect(stdout).toContain("ARCHIVE_EVIDENCE_PASS");
  } finally {
    await child.exited;
    if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith("ta-archive-evidence-"))throw new Error("Unsafe fixture cleanup");
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
},60000);
