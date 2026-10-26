import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { removeTestFixture } from "../test-cleanup";

// `failure` names how the first read of one of two Codex files fails: it grows after its parse (a live
// session appending), or it is unreadable. Both stay queued and are read by the retry; only the
// unreadable one leaves the first run partial.
for(const failure of ["growing","unreadable"] as const)
test(`a Codex source ${failure==="growing"?"growing":"unreadable"} after parse stays pending while the other first-fill files publish and retry`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ta-k4b-pending-"));
  const module=(name:string)=>JSON.stringify(pathToFileURL(path.resolve(import.meta.dir,name)).href);
  try{
    const archive=path.join(directory,"archive"),config=path.join(directory,"config"),state=path.join(directory,"state");fs.mkdirSync(config,{recursive:true});
    fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,subscriptions:[],sources:[]}));
    fs.writeFileSync(path.join(config,"projects.json"),JSON.stringify({projects:[]}));
    const worker=path.join(directory,"worker.ts");
    fs.writeFileSync(worker,`
      import assert from "node:assert/strict";import fs from "node:fs";import path from "node:path";
      import {Database} from ${module("../db/sqlite.ts")};import {createTestDatabase,createCodexSchema} from ${module("test-support.ts")};
      import {SyncCoordinator} from ${module("coordinator.ts")};import {SyncFileQueue} from ${module("file-queue.ts")};
      const f=createTestDatabase();createCodexSchema(f.dbPath);
      const folder=path.join(process.env.TOKENATLAS_ARCHIVE!,"codex","PC-fixture","sessions","2026","09","01");fs.mkdirSync(folder,{recursive:true});
      const files=["moving","stable"].map(name=>path.join(folder,name+".jsonl"));
      for(const file of files)fs.writeFileSync(file,[
        {timestamp:"2026-09-01T00:00:00Z",type:"session_meta",payload:{id:"fixture",cwd:"C:/fixture",originator:"codex_cli_rs"}},
        {timestamp:"2026-09-01T00:00:01Z",type:"turn_context",payload:{model:"gpt-fixture"}},
        {timestamp:"2026-09-01T00:00:02Z",type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:7,output_tokens:2,total_tokens:9},total_token_usage:{input_tokens:7,output_tokens:2,total_tokens:9}}}}
      ].map(row=>JSON.stringify(row)).join("\\n")+"\\n");
      const original=SyncFileQueue.prototype.resolveParsedFingerprint;let moved=false;
      SyncFileQueue.prototype.resolveParsedFingerprint=function(row,sha,size){if(!moved&&row.path===files[0]){moved=true;
        if(${JSON.stringify(failure)}==="unreadable")throw new Error("EACCES: permission denied, open '"+row.path+"'");
        fs.appendFileSync(files[0],"{}\\n");}return original.call(this,row,sha,size);};
      const c=new SyncCoordinator({dbPath:f.dbPath,rootDir:process.cwd(),prepareStage:()=>{},refreshDerived:()=>{}});
      const request={mode:"incremental",trigger:"auto",collection:"archive",scope:{kind:"vendor",vendor:"codex"}} as const;
      try{
        const first=await c.enter(request).completion;assert.equal(first.vendors[0].status,"success");
        if(${JSON.stringify(failure)}==="growing"){
          // Still being written is not unread: success, with the file counted as deferred.
          assert.equal(first.status,"success",JSON.stringify(first));assert.equal(first.vendors[0].inputsComplete,true);
          assert.equal(first.vendors[0].diagnostics.pendingInputs,undefined);assert.equal(first.vendors[0].diagnostics.deferredInputsTotal,1);
        }else{
          assert.equal(first.status,"partial_success",JSON.stringify(first));
          assert.equal(first.vendors[0].inputsComplete,false);assert.equal(first.vendors[0].diagnostics.pendingInputsTotal,1);
          assert.equal(first.vendors[0].diagnostics.deferredInputs,undefined);
        }
        const queue=new SyncFileQueue(process.env.TOKENATLAS_ARCHIVE!);try{assert.equal(queue.hasPending("codex",files[0]),true);}finally{queue.close();}
        const read=new Database(f.dbPath,{readonly:true});try{assert.deepEqual(read.query("SELECT path FROM events").all(),[{path:files[1]}]);}finally{read.close();}
        const retry=await c.enter(request).completion;assert.equal(retry.status,"success",JSON.stringify(retry));assert.equal(retry.vendors[0].inputsComplete,true);
        const check=new Database(f.dbPath,{readonly:true});try{assert.equal(check.query("SELECT count(*) n FROM events").get().n,2);}finally{check.close();}
        console.log("pending-source-retry-pass");
      }finally{c.close();SyncFileQueue.prototype.resolveParsedFingerprint=original;fs.rmSync(f.directory,{recursive:true,force:true});}
    `);
    const child=Bun.spawn([process.execPath,worker],{cwd:process.cwd(),env:{...process.env,TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:state,TOKENATLAS_FROZEN_CONFIG:"1",TOKENATLAS_PARSE_WORKERS:"2"},stdout:"pipe",stderr:"pipe"});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(exit,stdout+stderr).toBe(0);expect(stdout).toContain("pending-source-retry-pass");
  }finally{removeTestFixture(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},60_000);

test("a first-fill Claude file takes its queue witness from the parser's read, without a separate hashing read",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ta-claude-witness-"));
  const module=(name:string)=>JSON.stringify(pathToFileURL(path.resolve(import.meta.dir,name)).href);
  try{
    const archive=path.join(directory,"archive"),config=path.join(directory,"config"),state=path.join(directory,"state");fs.mkdirSync(config,{recursive:true});
    fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,subscriptions:[],sources:[]}));
    fs.writeFileSync(path.join(config,"projects.json"),JSON.stringify({projects:[]}));
    const worker=path.join(directory,"worker.ts");
    fs.writeFileSync(worker,`
      import assert from "node:assert/strict";import fs from "node:fs";import path from "node:path";import {createHash} from "node:crypto";
      import {Database} from ${module("../db/sqlite.ts")};import {createTestDatabase} from ${module("test-support.ts")};
      import {SyncCoordinator} from ${module("coordinator.ts")};import {SyncFileQueue} from ${module("file-queue.ts")};
      import {ARCHIVE_ROOT} from ${module("../config/paths.ts")};
      const f=createTestDatabase();
      const file=path.join(process.env.TOKENATLAS_ARCHIVE!,"claude","PC-fixture","project","session.jsonl");fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,JSON.stringify({type:"assistant",sessionId:"s",timestamp:"2026-09-01T12:00:00.000Z",
        message:{id:"m",model:"claude-fixture",stop_reason:"end_turn",usage:{input_tokens:7,output_tokens:2}}})+"\\n");
      const bytes=fs.readFileSync(file),sha=createHash("sha256").update(bytes).digest("hex");
      const resolved:Array<[string,string,number]>=[],hashed:string[][]=[];
      const resolve=SyncFileQueue.prototype.resolveParsedFingerprint,observeAll=SyncFileQueue.prototype.observeAll;
      SyncFileQueue.prototype.resolveParsedFingerprint=function(row,digest,size){resolved.push([row.path,digest,size]);return resolve.call(this,row,digest,size);};
      SyncFileQueue.prototype.observeAll=function(files,vendor,...rest){if(vendor==="claude")hashed.push([...files]);return observeAll.call(this,files,vendor,...rest);};
      const c=new SyncCoordinator({dbPath:f.dbPath,rootDir:process.cwd(),prepareStage:()=>{},refreshDerived:()=>{}});
      const request={mode:"incremental",trigger:"auto",collection:"archive",scope:{kind:"vendor",vendor:"claude"}} as const;
      try{
        const first=await c.enter(request).completion;assert.equal(first.status,"success",JSON.stringify(first));assert.equal(first.vendors[0].inputsComplete,true);
        assert.deepEqual(resolved.filter(([p])=>path.resolve(p)===path.resolve(file)).map(([,d,s])=>[d,s]),[[sha,bytes.length]]);
        const count=()=>{const read=new Database(f.dbPath,{readonly:true});try{return read.query("SELECT count(*) n FROM claude_events").get().n;}finally{read.close();}};
        assert.equal(count(),1);
        assert.deepEqual(hashed,[]);
        const queue=new SyncFileQueue(ARCHIVE_ROOT);try{assert.equal(queue.hasPending("claude",file),false);}finally{queue.close();}
        console.log("claude-witness-pass");
      }finally{c.close();SyncFileQueue.prototype.resolveParsedFingerprint=resolve;SyncFileQueue.prototype.observeAll=observeAll;fs.rmSync(f.directory,{recursive:true,force:true});}
    `);
    const child=Bun.spawn([process.execPath,worker],{cwd:process.cwd(),env:{...process.env,TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:state,TOKENATLAS_FROZEN_CONFIG:"1",TOKENATLAS_PARSE_WORKERS:"2"},stdout:"pipe",stderr:"pipe"});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(exit,stdout+stderr).toBe(0);expect(stdout).toContain("claude-witness-pass");
  }finally{removeTestFixture(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},60_000);
