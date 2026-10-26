import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Database } from "../../src/db/sqlite";
import { createTestDatabase } from "../../src/sync/test-support";
import { SyncCoordinator } from "../../src/sync/coordinator";
import { ARCHIVE_ROOT, ARCHIVE_LOGICAL_ROOT, HOME_DIR, toArchiveLogicalPath } from "../../src/config/paths";
import { ensureArchiveIdentity } from "../../src/sync/archive-inventory";
import { SyncFileQueue } from "../../src/sync/file-queue";
import { startArchiveCompression, advanceArchiveCompression } from "../../src/sync/archive-compression";
import { stepUsageLedger } from "../../src/server/usage-ledger-producer";
import type { RateCard } from "../../src/server/pricing";

const root=process.env.TOKENATLAS_JSONL_TRIAL_ROOT;
if(!root||!path.isAbsolute(root)||!fs.existsSync(path.join(root,"fixture-only")))throw new Error("An isolated fixture-only trial root is required");
for(const selected of [ARCHIVE_ROOT,HOME_DIR,process.env.APPDATA!,process.env.LOCALAPPDATA!,process.env.TOKENATLAS_CONFIG!,process.env.TOKENATLAS_LOCAL_STATE!]) {
  const relative=path.relative(root,selected);assert(relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative));
}
fs.mkdirSync(ARCHIVE_ROOT,{recursive:true});ensureArchiveIdentity(ARCHIVE_ROOT);
const rates={version:1,vendors:{anthropic:{models:{"claude-sonnet-fixture":{in_uncached:3,out_total:15}}},xai:{models:{grok:{in_uncached:2,out_total:10}}}}} as unknown as RateCard;
const line=(value:unknown)=>JSON.stringify(value)+"\n";
const claude=(id:string,tokens=100)=>line({type:"assistant",sessionId:"session",timestamp:"2026-09-08T12:00:00Z",
  message:{id,model:"claude-sonnet-fixture",usage:{input_tokens:tokens,output_tokens:10}}});
const grok=(id:string,tokens=100)=>line({params:{sessionId:"session",_meta:{agentTimestampMs:Date.parse("2026-09-08T12:00:00Z")},
  update:{prompt_id:id,usage:{modelUsage:{grok:{inputTokens:tokens,outputTokens:10}}}}}});
const report:Record<string,unknown>={entry:"SyncCoordinator → production mirror/adapters → usage ledger",mode:"isolated fixture copies",
  sample:"two providers, one conversation and 1→2 calls each",excludes:"live data, real OneDrive transport, full startup timing"};
for(const vendor of ["claude","grok"] as const) {
  const fixture=createTestDatabase(), dbPath=path.join(root,vendor+".sqlite");fs.copyFileSync(fixture.dbPath,dbPath);
  const source=vendor==="claude"?path.join(HOME_DIR,".claude","projects","project","session.jsonl")
    :path.join(HOME_DIR,".grok","sessions","repo","session","updates.jsonl");
  const archived=vendor==="claude"?path.join(ARCHIVE_ROOT,vendor,"PC","project","session.jsonl")
    :path.join(ARCHIVE_ROOT,vendor,"PC","sessions","repo","session","updates.jsonl");
  const make=vendor==="claude"?claude:grok, initial=make("r1")+line({padding:"x".repeat(12000)});
  fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,initial);
  let db=new Database(dbPath);
  const drain=()=>{let processed=0;for(let i=0;i<100;i++){const step=stepUsageLedger(db,vendor,rates,ARCHIVE_LOGICAL_ROOT);processed+=step.processed;if(step.complete)return processed;}throw new Error("ledger did not settle");};
  const snapshot=()=>({raw:db.query(`SELECT rowid,* FROM ${vendor}_events ORDER BY rowid`).all(),
    facts:db.query("SELECT * FROM usage_ledger_facts WHERE provider=? ORDER BY row_id").all(vendor),
    days:db.query("SELECT * FROM usage_ledger_days WHERE provider=? ORDER BY day,dim_id").all(vendor)});
  const semantic=()=>db.query("SELECT identity,source_key,ts,model,q_uncached,q_out,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto,copy_state FROM usage_ledger_facts WHERE provider=? ORDER BY identity").all(vendor);
  const request={trigger:"manual" as const,mode:"incremental" as const,scope:{kind:"vendor" as const,vendor}};
  const start=(selected=dbPath)=>new SyncCoordinator({dbPath:selected,rootDir:process.cwd(),configFingerprint:()=>"fixture-only",prepareStage:()=>{},refreshDerived:()=>{}});
  let coordinator=start();
  const run=async(collection?:"archive")=>{const result=await coordinator.enter({...request,...(collection?{collection}:{})}).completion;
    assert.equal(result.status,"success",JSON.stringify(result.vendors));return result;};
  const enqueue=(files:string[])=>{const queue=new SyncFileQueue(ARCHIVE_ROOT);try{for(const file of files)queue.enqueue(file,vendor);}finally{queue.close();}};
  try {
    await run();drain();const baseline=snapshot();assert.equal(baseline.raw.length,1);assert.equal(baseline.facts.length,1);
    fs.utimesSync(archived,new Date("2020-01-01"),new Date("2020-01-01"));
    const options={archiveRoot:ARCHIVE_ROOT,databasePath:dbPath,vendors:[vendor]},job=startArchiveCompression(options);
    const compression=await advanceArchiveCompression(options,job.jobId);assert.equal(compression.status,"complete",JSON.stringify(compression));assert.equal(compression.job.compressed,1);
    const conversion=await run(), conversionWork=drain();assert.deepEqual(snapshot(),baseline);assert.equal(conversionWork,0);
    assert.equal(conversion.vendors[0]!.dataChanged,false);
    enqueue([source]);await run();assert.equal(drain(),0);assert.deepEqual(snapshot(),baseline);assert(!fs.existsSync(archived));
    assert.equal(fs.readFileSync(source,"utf8"),initial);
    coordinator.close();db.close();db=new Database(dbPath);coordinator=start();
    const restart=await run();assert.equal(restart.vendors[0]?.processedInputs??0,0);assert.equal(drain(),0);assert.deepEqual(snapshot(),baseline);
    fs.writeFileSync(source,initial+make("r2",20));enqueue([source]);await run();drain();assert.equal(snapshot().raw.length,2);
    assert.deepEqual(snapshot().facts[0],baseline.facts[0]);assert(!fs.existsSync(archived+".zst"));
    // Compression later in the same conversation must preserve appended facts too.
    fs.utimesSync(archived,new Date("2020-01-01"),new Date("2020-01-01"));
    const next=startArchiveCompression(options);assert.equal((await advanceArchiveCompression(options,next.jobId)).status,"complete");
    await run();assert.equal(drain(),0);const accepted=snapshot(), referenceFacts=semantic();
    // Bad compressed input never deletes accepted facts, and the same queue can retry it.
    const good=fs.readFileSync(archived+".zst");fs.writeFileSync(archived+".zst","bad-frame");enqueue([archived+".zst"]);
    const failed=await coordinator.enter({...request,collection:"archive"}).completion;assert.notEqual(failed.status,"success");assert.deepEqual(snapshot(),accepted);
    fs.writeFileSync(archived+".zst",good);enqueue([archived+".zst"]);await run("archive");assert.equal(drain(),0);assert.deepEqual(snapshot(),accepted);
    // Both cloud names refer to one source; a shorter delayed name cannot remove history.
    fs.writeFileSync(archived,initial);enqueue([archived,archived+".zst"]);await run("archive");assert.equal(drain(),0);assert.deepEqual(snapshot(),accepted);
    assert.equal(toArchiveLogicalPath(archived+".zst"),toArchiveLogicalPath(archived));fs.unlinkSync(archived);
    coordinator.close();db.close();
    const reference=createTestDatabase();
    try {
      db=new Database(reference.dbPath);coordinator=start(reference.dbPath);
      const full=await coordinator.enter({...request,mode:"full",collection:"archive"}).completion;assert.equal(full.status,"success",JSON.stringify(full.vendors));drain();
      assert.deepEqual(semantic(),referenceFacts,"archive-only full rebuild must equal incremental facts/prices");
    }finally{coordinator.close();db.close();fs.rmSync(reference.directory,{recursive:true,force:true});}
    db=new Database(dbPath);coordinator=start();
    report[vendor]={conversionChanged:conversion.vendors[0]!.dataChanged,conversionWork,restartProcessed:restart.vendors[0]?.processedInputs??0,
      reference:"identical",calls:accepted.raw.length,sourceBytes:compression.job.sourceBytes,compressedBytes:compression.job.compressedBytes};
  } finally {coordinator.close();db.close();fs.rmSync(fixture.directory,{recursive:true,force:true});}
}
fs.writeFileSync(path.join(root,"result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
