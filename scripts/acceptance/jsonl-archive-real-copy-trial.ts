import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Database } from "../../src/db/sqlite";
import { SyncCoordinator } from "../../src/sync/coordinator";
import { ARCHIVE_ROOT, toArchiveLogicalPath } from "../../src/config/paths";
import { startArchiveCompression, advanceArchiveCompression } from "../../src/sync/archive-compression";

const root=process.env.TOKENATLAS_JSONL_COPY_TRIAL;
if(!root||!path.isAbsolute(root)||!fs.existsSync(path.join(root,"copy-only")))throw new Error("A frozen copy-only trial is required");
const database=process.env.TOKENATLAS_DB!;
assert.equal(path.resolve(database),path.join(root,"copy.sqlite"));assert.equal(path.resolve(ARCHIVE_ROOT),path.join(root,"archive"));
for(const selection of [process.env.TOKENATLAS_CONFIG,process.env.TOKENATLAS_LOCAL_STATE,process.env.TOKENATLAS_TEMP_DIR]) {
  assert(selection);const relative=path.relative(root,selection);assert(relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative));
}
const samples=JSON.parse(fs.readFileSync(path.join(root,"sample.json"),"utf8")) as Record<"claude"|"grok",string[]>;
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value,(_,v)=>typeof v==="bigint"?v.toString():v)).digest("hex");
const db=new Database(database,{readonly:true,safeIntegers:true});
const report:Record<string,unknown>={entry:"archive compression job → SyncCoordinator → production archive adapter/incremental publisher",
  mode:"readonly SQLite backup; copies of archived Claude/Grok JSONL",excludes:"live writes, cloud transport, full startup and whole-history timing"};
try {
  for(const vendor of ["claude","grok"] as const) {
    const files=samples[vendor].map(relative=>path.join(ARCHIVE_ROOT,relative)),logical=files.map(toArchiveLogicalPath);
    assert(files.length>0);const placeholders=logical.map(()=>"?").join(",");
    const snapshot=()=>{
      const raw=db.query(`SELECT rowid AS trial_row_id,* FROM ${vendor}_events WHERE path IN (${placeholders}) ORDER BY rowid`).all(...logical) as Array<{trial_row_id:bigint}>;
      const facts=raw.length?db.query(`SELECT * FROM usage_ledger_facts WHERE provider=? AND row_id IN (${raw.map(()=>"?").join(",")}) ORDER BY row_id`).all(vendor,...raw.map(row=>row.trial_row_id)):[];
      const dirty=db.query("SELECT * FROM usage_ledger_dirty WHERE provider=? ORDER BY kind,value").all(vendor);
      const state=db.query("SELECT * FROM usage_ledger_state WHERE provider=?").all(vendor);
      const days=db.query("SELECT * FROM usage_ledger_days WHERE provider=? ORDER BY day,dim_id").all(vendor);
      return {calls:raw.length,ledgerFacts:facts.length,pricedFacts:(facts as Array<{std_reason:string|null;std_usd:number|bigint|null;act_reason:string|null;act_usd:number|bigint|null;glb_reason:string|null;glb_usd:number|bigint|null}>).filter(row=>(row.std_reason===null&&row.std_usd!==null)||(row.act_reason===null&&row.act_usd!==null)||(row.glb_reason===null&&row.glb_usd!==null)).length,rawHash:hash(raw),factsHash:hash(facts),dirtyHash:hash(dirty),stateHash:hash(state),daysHash:hash(days)};
    };
    const before=snapshot();assert(before.calls>0&&before.ledgerFacts>0);
    const beforeRows=db.query(`SELECT rowid AS trial_row_id,* FROM ${vendor}_events WHERE path IN (${placeholders}) ORDER BY rowid`).all(...logical) as Array<Record<string,unknown>>;
    const options={archiveRoot:ARCHIVE_ROOT,databasePath:database,vendors:[vendor]},job=startArchiveCompression(options);
    let compression;do {compression=await advanceArchiveCompression(options,job.jobId);}while(compression.status==="pending");
    assert.equal(compression.status,"complete",JSON.stringify(compression));assert.equal(compression.job.compressed,files.length);
    for(const file of files){assert(!fs.existsSync(file));assert(fs.existsSync(file+".zst"));}
    const start=()=>new SyncCoordinator({dbPath:database,rootDir:process.cwd(),configFingerprint:()=>"frozen-copy",refreshDerived:()=>{}});
    let coordinator=start();
    const request={trigger:"manual" as const,mode:"incremental" as const,collection:"archive" as const,scope:{kind:"vendor" as const,vendor}};
    try {
      const conversion=await coordinator.enter(request).completion;assert.equal(conversion.status,"success",JSON.stringify(conversion.vendors));
      if(conversion.vendors.some(v=>v.dataChanged)) {
        const afterRows=db.query(`SELECT rowid AS trial_row_id,* FROM ${vendor}_events WHERE path IN (${placeholders}) ORDER BY rowid`).all(...logical) as Array<Record<string,unknown>>;
        const changedColumns=new Set<string>();
        for(let i=0;i<Math.max(beforeRows.length,afterRows.length);i++)for(const key of Object.keys({...beforeRows[i],...afterRows[i]}))
          if(beforeRows[i]?.[key]!==afterRows[i]?.[key])changedColumns.add(key);
        throw new Error(JSON.stringify({vendor,changedColumns:[...changedColumns],before,after:snapshot(),diagnostics:conversion.vendors.map(v=>({changedIdentities:v.diagnostics.changedIdentities}))}));
      }
      assert.deepEqual(snapshot(),before);
      coordinator.close();coordinator=start();const restart=await coordinator.enter(request).completion;
      assert.equal(restart.status,"success",JSON.stringify(restart.vendors));assert(restart.vendors.every(v=>v.processedInputs===0));assert.deepEqual(snapshot(),before);
      report[vendor]={files:files.length,...before,dataChanged:false,newPricingWork:0,restartProcessed:0,sourceBytes:compression.job.sourceBytes,
        compressedBytes:compression.job.compressedBytes,reductionPercent:100*(1-compression.job.compressedBytes/compression.job.sourceBytes)};
    }finally{coordinator.close();}
  }
  fs.writeFileSync(path.join(root,"result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{db.close();}
