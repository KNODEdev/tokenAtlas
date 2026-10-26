import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removeTestFixture } from "../test-cleanup";

/**
 * The first import of an empty database lists the archive once and hands that list to the
 * importers: no directory is read twice, no transcript or session folder is checked again
 * after the listing, and no file is hashed outside the parser's own read. The incremental run
 * after it still finds a changed and a new file. Runs in its own process, because the archive,
 * configuration and local-state locations are fixed when the modules load.
 */
test("first import lists each file once and the next run still finds a changed and a new file", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ta-first-import-"));
  const module = (name: string) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, name)).href);
  try {
    const archive = path.join(directory, "archive"), config = path.join(directory, "config"), state = path.join(directory, "state");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
    fs.writeFileSync(path.join(config, "projects.json"), JSON.stringify({ projects: [] }));
    const worker = path.join(directory, "worker.ts");
    fs.writeFileSync(worker, `
      import assert from "node:assert/strict";import fs from "node:fs";import path from "node:path";
      import {Database} from ${module("../db/sqlite.ts")};import {createTestDatabase,createCodexSchema} from ${module("test-support.ts")};
      import {SyncCoordinator} from ${module("coordinator.ts")};import {SyncFileQueue} from ${module("file-queue.ts")};
      import {ProgressRegistry} from ${module("progress.ts")};
      const archive=path.resolve(process.env.TOKENATLAS_ARCHIVE!);
      const f=createTestDatabase();createCodexSchema(f.dbPath);
      const line=(row:unknown)=>JSON.stringify(row)+"\\n";
      const rollout=(id:string,tokens:number)=>[
        {timestamp:"2026-09-01T00:00:00Z",type:"session_meta",payload:{id,cwd:"C:/fixture",originator:"codex_cli_rs"}},
        {timestamp:"2026-09-01T00:00:01Z",type:"turn_context",payload:{model:"gpt-fixture"}},
        {timestamp:"2026-09-01T00:00:02Z",type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:tokens,output_tokens:2,total_tokens:tokens+2},total_token_usage:{input_tokens:tokens,output_tokens:2,total_tokens:tokens+2}}}},
      ].map(line).join("");
      const day=path.join(archive,"codex","PC-fixture","sessions","2026","09","01");fs.mkdirSync(day,{recursive:true});
      const codex=["a","b","c"].map(name=>path.join(day,"rollout-"+name+".jsonl"));
      codex.forEach((file,index)=>fs.writeFileSync(file,rollout("session-"+index,7+index)));
      const project=path.join(archive,"claude","PC-fixture","project");fs.mkdirSync(project,{recursive:true});
      const claude=["one","two"].map(name=>path.join(project,name+".jsonl"));
      claude.forEach((file,index)=>fs.writeFileSync(file,line({type:"assistant",sessionId:"s"+index,timestamp:"2026-09-01T12:00:00.000Z",
        message:{id:"m"+index,model:"claude-fixture",stop_reason:"end_turn",usage:{input_tokens:7,output_tokens:2}}})));

      // Every directory read and every stat of an archive path, by path.
      const inArchive=(file:unknown)=>{const resolved=path.resolve(String(file));return resolved.toLowerCase().startsWith(archive.toLowerCase());};
      const reads=new Map<string,number>(),stats=new Map<string,number>();
      const count=(map:Map<string,number>,file:unknown)=>{if(inArchive(file)){const key=path.resolve(String(file));map.set(key,(map.get(key)??0)+1);}};
      const readdir=fs.readdirSync,lstat=fs.lstatSync,stat=fs.statSync;
      (fs as any).readdirSync=(file:any,...rest:any[])=>{count(reads,file);return Reflect.apply(readdir,fs,[file,...rest]);};
      (fs as any).lstatSync=(file:any,...rest:any[])=>{count(stats,file);return Reflect.apply(lstat,fs,[file,...rest]);};
      (fs as any).statSync=(file:any,...rest:any[])=>{count(stats,file);return Reflect.apply(stat,fs,[file,...rest]);};
      const observeAll=SyncFileQueue.prototype.observeAll;let hashed=0;
      SyncFileQueue.prototype.observeAll=function(files,vendor){hashed+=files.length;return observeAll.call(this,files,vendor);};
      const reports:Array<{scope:string;step:string;done:number;total:number|null}>=[];
      const report=ProgressRegistry.prototype.report;
      ProgressRegistry.prototype.report=function(scope,step,label,unit,done,total){reports.push({scope,step,done,total});return report.call(this,scope,step,label,unit,done,total);};

      const c=new SyncCoordinator({dbPath:f.dbPath,rootDir:process.cwd(),prepareStage:()=>{},refreshDerived:()=>{}});
      const request={mode:"incremental",trigger:"auto",collection:"archive",scope:{kind:"vendors",vendors:["codex","claude"]}} as const;
      const rows=()=>{const read=new Database(f.dbPath,{readonly:true});
        try{return {codex:(read.query("SELECT count(*) n FROM events").get() as {n:number}).n,claude:(read.query("SELECT count(*) n FROM claude_events").get() as {n:number}).n};}
        finally{read.close();}};
      try{
        const first=await c.enter(request).completion;
        assert.equal(first.status,"success",JSON.stringify(first.vendors.map(v=>[v.vendor,v.error,v.diagnostics.pendingInputs])));
        assert.deepEqual(rows(),{codex:3,claude:2});
        // One listing: each archive folder is read once.
        const folders=[...reads.entries()];
        assert.ok(folders.length>0);
        assert.deepEqual(folders.filter(([,n])=>n!==1),[],"a folder was listed more than once");
        // The listing names folders without a stat and nothing stats a session folder later; no file is
        // hashed apart from its parse.
        const sessionFolders=[...stats.keys()].filter(file=>[day,project].some(folder=>file.toLowerCase()===folder.toLowerCase()));
        assert.deepEqual(sessionFolders,[],JSON.stringify([...stats]));
        assert.equal(hashed,0);
        // Per file: the listing, the stat before and after its parsing read, the witness of the
        // parsed digest and the checkpoint. No ancestor or verification pass adds to it.
        assert.deepEqual([...codex,...claude].map(file=>stats.get(path.resolve(file))??0),[5,5,5,5,5]);
        // Both vendors selected their listed files without verification and reported every file read.
        assert.ok(reports.some(r=>r.scope==="sync:codex"&&r.step==="select"));
        assert.ok(!reports.some(r=>r.step==="verify"));
        assert.ok(reports.some(r=>r.scope==="sync:codex"&&r.step==="parse"&&r.done===3&&r.total===3));
        assert.ok(reports.some(r=>r.scope==="sync:claude"&&r.step==="parse"&&r.done===2&&r.total===2));

        // The next run: one transcript grew, one is new; a watcher reports the change.
        fs.appendFileSync(codex[0]!,line({timestamp:"2026-09-01T00:00:03Z",type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:5,output_tokens:1,total_tokens:6},total_token_usage:{input_tokens:12,output_tokens:3,total_tokens:15}}}}));
        const added=path.join(day,"rollout-d.jsonl");fs.writeFileSync(added,rollout("session-new",11));
        const queue=new SyncFileQueue(archive);try{queue.reconcileLater();}finally{queue.close();}
        const second=await c.enter(request).completion;
        assert.equal(second.status,"success",JSON.stringify(second.vendors.map(v=>[v.vendor,v.error])));
        assert.deepEqual(second.vendors.map(v=>[v.vendor,v.diagnostics.selectedInputs]),[["codex",2]]);
        assert.deepEqual(rows(),{codex:5,claude:2});
        console.log("first-import-pass");
      }finally{c.close();fs.rmSync(f.directory,{recursive:true,force:true});}
    `);
    const child = Bun.spawn([process.execPath, worker], { cwd: process.cwd(), env: { ...process.env, TOKENATLAS_ARCHIVE: archive,
      TOKENATLAS_CONFIG: config, TOKENATLAS_LOCAL_STATE: state, TOKENATLAS_FROZEN_CONFIG: "1", TOKENATLAS_PARSE_WORKERS: "2" }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stdout + stderr).toBe(0);
    expect(stdout).toContain("first-import-pass");
  } finally { removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 120_000);
