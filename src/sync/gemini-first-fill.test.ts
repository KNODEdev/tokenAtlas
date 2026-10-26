import {expect,test} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {removeTestFixture} from "../test-cleanup";

test("701-file Gemini first fill amortizes setup, preserves facts/bookmarks/digests and isolates a bad file",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ta-gemini-first-fill-"));
  const config=path.join(directory,"config"),archive=path.join(directory,"archive");
  fs.mkdirSync(config);fs.mkdirSync(archive);
  fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,subscriptions:[],sources:[]}));
  const module=(relative:string)=>new URL(relative,import.meta.url).href;
  const script=`
    import assert from "node:assert/strict";import fs from "node:fs";import path from "node:path";
    import {Database} from ${JSON.stringify(module("../db/sqlite.ts"))};
    import {createTestDatabase} from ${JSON.stringify(module("./test-support.ts"))};
    import {createProductionAdapters} from ${JSON.stringify(module("./adapters.ts"))};
    import {createIncrementalStage} from ${JSON.stringify(module("./coordinator.ts"))};
    import {identityFacts} from ${JSON.stringify(module("./accepted-facts.ts"))};
    import {removeTestFixture} from ${JSON.stringify(module("../test-cleanup.ts"))};
    const dir=path.join(process.env.TOKENATLAS_ARCHIVE!,"gemini","fixture","conversations");fs.mkdirSync(dir,{recursive:true});
    const template=path.join(process.env.TOKENATLAS_CONFIG!,"template.db"),source=new Database(template);
    source.exec("CREATE TABLE gen_metadata(idx INTEGER,data BLOB)");source.query("INSERT INTO gen_metadata VALUES(0,?)").run(new Uint8Array([10,4,34,2,16,123]));source.close();
    const files=Array.from({length:701},(_,i)=>path.join(dir,String(i).padStart(4,"0")+".db"));
    for(const file of files)fs.copyFileSync(template,file);
    const active=createTestDatabase(),db=new Database(active.dbPath),adapter=createProductionAdapters().gemini;
    const run=async(firstFill:boolean,label:string)=>{
      const stage=path.join(active.directory,label+".sqlite");createIncrementalStage(db,stage,"gemini",files);
      const started=performance.now();const progress:unknown[]=[];
      const result=await adapter({activeDbPath:active.dbPath,stageDbPath:stage,rootDir:process.cwd(),mode:"incremental",rebuild:true,
        changedFiles:files,firstFill,onIngestTimings:t=>progress.push(t)});
      assert.equal(result.processedInputs,701);assert.deepEqual(result.failedInputs,[]);assert.ok(progress.length);
      const elapsedMs=performance.now()-started,stored=new Database(stage);
      try {
        const facts=stored.query("SELECT store,conversation_id,gen_idx,ts,ts_basis,model,path,fresh_in,cached_in,out_total,usd FROM gemini_events ORDER BY conversation_id,gen_idx").all();
        const bookmarks=stored.query("SELECT store,path,size,mtime,generations FROM gemini_files ORDER BY path").all();
        const proof=identityFacts(stored,"gemini",{identity:["store","path"],tables:[{table:"gemini_events",order:["store","conversation_id","gen_idx"]}]},
          bookmarks.map((row:any)=>({store:row.store,path:row.path}))).fingerprint;
        return {result,elapsedMs,facts,bookmarks,proof,stage};
      }finally{stored.close();}
    };
    try {
      const baseline=await run(false,"baseline"),batched=await run(true,"batched");
      assert.deepEqual(batched.facts,baseline.facts);assert.deepEqual(batched.bookmarks,baseline.bookmarks);assert.equal(batched.proof,baseline.proof);
      assert.equal(batched.result.diagnostics.batchedInputs,701);
      assert.equal((batched.result.diagnostics.stores as any).fixture.files,701);
      console.log(JSON.stringify({entryPoint:"createProductionAdapters().gemini (production queue adapter)",mode:"incremental",sample:"701 archived SQLite files / 701 facts",
        excludes:["fixture/schema creation","active publication","real archive/cloud hydration"],order:"per-file then batched; warm-file timing is diagnostic, operation counts are the regression gate",
        baselineMs:baseline.elapsedMs,batchedMs:batched.elapsedMs,baseline:baseline.result.diagnostics.ingestTimings,batched:batched.result.diagnostics.ingestTimings}));
      fs.writeFileSync(files[350]!,"invalid SQLite");
      const stage=path.join(active.directory,"failed.sqlite");createIncrementalStage(db,stage,"gemini",files);
      const failed=await adapter({activeDbPath:active.dbPath,stageDbPath:stage,rootDir:process.cwd(),mode:"incremental",rebuild:true,changedFiles:files,firstFill:true});
      assert.equal(failed.processedInputs,700);assert.equal(failed.failedInputs!.length,1);assert.equal(failed.failedInputs![0]!.path,files[350]);
      const check=new Database(stage);try{assert.equal((check.query("SELECT count(*) n FROM gemini_events").get() as any).n,700);}finally{check.close();}
    }finally{db.close();removeTestFixture(active.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
  `;
  const child=Bun.spawn([process.execPath,"--eval",script],{cwd:process.cwd(),env:{...process.env,TOKENATLAS_CONFIG:config,TOKENATLAS_ARCHIVE:archive,
    TOKENATLAS_LOCAL_STATE:path.join(directory,"state"),TOKENATLAS_FROZEN_CONFIG:"1"},stdout:"pipe",stderr:"pipe"});
  const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
  try {const code=await child.exited;const output=await stdout,errors=await stderr;expect(code,errors+output).toBe(0);console.info(output.trim());}
  finally {removeTestFixture(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},240000);
