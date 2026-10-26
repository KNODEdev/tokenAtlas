import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import * as schema from "../db/schema";
import { createTestDatabase } from "../sync/test-support";
import { removeTestFixture } from "../test-cleanup";
import { replaceClaudeFileEvents } from "./claude";
import { ClaudeFirstFill } from "./claude-first-fill";
import { ingestGaugesAsync } from "./gauges";
import { createProbeCollection, PROBE_FACT_TABLES, backfillProbeFacts, mergeProbeFacts, linkPublishedProbeFacts } from "../db/probe-facts";
import { compactProbeLine } from "../providers/core/journal-compact";
import { PROBE_JOURNAL_FILE } from "../providers/core/journal-files";
import { digest } from "../config/canonical-json";

test("Claude bulk first fill equals ordered file replacement, including ties, conflicts, defaults and row IDs", () => {
  const fixture=createTestDatabase(),a=new Database(fixture.dbPath),b=new Database(":memory:");
  try {
    b.exec((a.query("SELECT sql FROM sqlite_master WHERE name='claude_events'").get() as {sql:string}).sql);
    b.exec("CREATE UNIQUE INDEX claude_events_store_call_id_unique ON claude_events(store,call_id)");
    const db=drizzle(a,{schema}),bulk=new ClaudeFirstFill(b),count=Number(process.env.TOKENATLAS_K4B_FIXTURE_ROWS??30000);
    const files:Array<schema.NewClaudeEvent[]>=[];
    for(let file=0;file<3;file++)files.push(Array.from({length:count},(_,index)=>({
      store:index%7===0?"desktop":"live",call_id:`call-${index}`,ts:`2026-09-01T00:00:00Z`,path:`file-${file}.jsonl`,
      out_total:file===1?index%13:index%11,in_uncached:file*100+index,in_cache_read:file,
      model:`model-${file}`,account_key:index%5===0?null:index%3===0?`key-${file}`:"one-key",
      subscription_id:`sub-${file}`,subscription_conflict:index%17===0&&file===1?1:0,
    })));
    const before=performance.now();
    for(const events of files)a.transaction(()=>replaceClaudeFileEvents(db,a,"live",events[0]!.path,events))();
    const referenceMs=performance.now()-before,started=performance.now();
    b.transaction(()=>{for(const events of files)bulk.append(events);bulk.finish();})();
    const bulkMs=performance.now()-started;
    expect(b.query("SELECT * FROM claude_events ORDER BY id").all()).toEqual(a.query("SELECT * FROM claude_events ORDER BY id").all());
    expect(b.query("SELECT seq FROM sqlite_sequence WHERE name='claude_events'").get()).toEqual(a.query("SELECT seq FROM sqlite_sequence WHERE name='claude_events'").get());
    console.info(JSON.stringify({entryPoint:"ClaudeFirstFill versus replaceClaudeFileEvents stage writer",mode:"empty stage",sample:`${count*3} rows / three files`,excludes:["discovery","parser","publication"],referenceMs,bulkMs}));
    bulk.close();
  }finally{a.close();b.close();removeTestFixture(fixture.directory,{recursive:true,force:true});}
});

test("gauges bulk conflicts roll back facts, receipts and bookmarks with identical quarantine evidence",async ()=>{
  for(const kind of ["receipt","header","counter"]){
    const f=createTestDatabase(),copy=path.join(f.directory,"copy.sqlite"),archive=path.join(f.directory,"archive");
    const seed=new Database(f.dbPath);try{backfillProbeFacts(seed);}finally{seed.close();}fs.copyFileSync(f.dbPath,copy);
    const c=createProbeCollection([{provider:"codex",subject:"one",ts:"2026-09-01T00:00:00Z",kind:"primary",reported_percent_side:"used",used_percent:10}])[0]!;
    const payload={...c.payload,used_percent:99},id=randomUUID();
    const altered=kind==="header"?{...c,header:{...c.header,recorded_at:"2026-09-02T00:00:00Z"}}:{...c,payload,payload_digest:digest(payload)};
    const line=(fact:typeof c,entry:string)=>JSON.stringify({...fact.payload,canonical_probe:fact,journal_version:2,journal_entry_id:entry});
    const folder=path.join(archive,"gauges","sender");fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,PROBE_JOURNAL_FILE),line(c,id)+"\n"+line(altered,kind==="receipt"?id:randomUUID())+"\n");
    const options={archiveRoot:archive,ownStore:"receiver",force:false,now:()=>"2026-09-03T00:00:00Z"};
    const message=async(work:()=>Promise<unknown>)=>{try{await work();return null;}catch(error){return String(error);}};
    try{
      const reference=await message(()=>ingestGaugesAsync({...options,atlasPath:f.dbPath})),fast=await message(()=>ingestGaugesAsync({...options,atlasPath:copy,firstFill:true}));
      expect(reference).not.toBeNull();expect(fast).toBe(reference);
      const a=new Database(f.dbPath),b=new Database(copy);
      try{for(const table of [...PROBE_FACT_TABLES,"gauge_journal_receipts","gauge_files","probe_windows"])expect(b.query(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(a.query(`SELECT * FROM ${table} ORDER BY 1`).all());}
      finally{a.close();b.close();}
    }finally{removeTestFixture(f.directory,{recursive:true,force:true});}
  }
});

test("gauges bulk acceptance, merge and projection links equal the row path for canonical and compact duplicates",async ()=>{
  const fixture=createTestDatabase(),copy=path.join(fixture.directory,"copy.sqlite"),archive=path.join(fixture.directory,"archive");
  const seed=new Database(fixture.dbPath);
  try{backfillProbeFacts(seed);seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");}finally{seed.close();}
  fs.copyFileSync(fixture.dbPath,copy);
  const empty=path.join(fixture.directory,"empty.sqlite");fs.copyFileSync(copy,empty);
  const directory=path.join(archive,"gauges","producer");fs.mkdirSync(directory,{recursive:true});
  const count=Number(process.env.TOKENATLAS_K4B_GAUGE_ROWS??3000),lines:string[]=[];
  let previous:ReturnType<typeof createProbeCollection>[number]|null=null;
  for(let i=0;i<count;i++){
    const fact=createProbeCollection([{provider:"codex",subject:"one",ts:new Date(Date.UTC(2026,8,1)+i*1000).toISOString(),kind:"primary",reported_percent_side:"used",used_percent:i%100,machine:"producer",login:"fixture",extra:JSON.stringify({home:"C:/fixture/"+"long-source-context".repeat(10)})}])[0]!;
    const line=i%2===0?JSON.stringify({...fact.payload,canonical_probe:fact,journal_version:2,journal_entry_id:randomUUID()}):compactProbeLine(randomUUID(),fact,previous).line;
    previous=fact;
    lines.push(line);if(i%11===0)lines.push(line);
  }
  fs.writeFileSync(path.join(directory,PROBE_JOURNAL_FILE),lines.join("\n")+"\n");
  const options={archiveRoot:archive,ownStore:"receiver",force:false,now:()=>"2026-09-02T00:00:00Z"};
  const started=performance.now(),reference=(await ingestGaugesAsync({...options,atlasPath:fixture.dbPath})),referenceMs=performance.now()-started;
  const query=Database.prototype.query;let receiptLookups=0;
  const spy=spyOn(Database.prototype,"query").mockImplementation(function(this:Database,sql:string){if(sql.startsWith("SELECT payload_hash FROM gauge_journal_receipts WHERE entry_id"))receiptLookups++;return query.call(this,sql);} as typeof Database.prototype.query);
  let fast:Awaited<ReturnType<typeof ingestGaugesAsync>>,bulkMs:number;
  try{const startBulk=performance.now();fast=(await ingestGaugesAsync({...options,atlasPath:copy,firstFill:true}));bulkMs=performance.now()-startBulk;}finally{spy.mockRestore();}
  expect(receiptLookups).toBe(0);
  const stage=path.join(fixture.directory,"stage.sqlite");fs.copyFileSync(copy,stage);
  const a=new Database(fixture.dbPath),b=new Database(copy);
  const dump=(db:Database,table:string)=>db.query(`SELECT * FROM ${table} ORDER BY ${table==="probe_windows"?"id":"1"}`).all();
  try{
    expect(fast.rows).toBe(reference.rows);
    expect(fast.rows).toBe(count);
    for(const table of [...PROBE_FACT_TABLES,"gauge_journal_receipts","probe_windows","gauge_files"])expect(dump(b,table)).toEqual(dump(a,table));
  }finally{a.close();b.close();}
  const published=path.join(fixture.directory,"published.sqlite");fs.copyFileSync(empty,published);
  const c=new Database(empty),d=new Database(published);
  try{
    for(const db of [c,d]){db.query("ATTACH DATABASE ? AS sync_stage").run(stage);db.exec("INSERT INTO probe_windows SELECT * FROM sync_stage.probe_windows");}
    c.exec("CREATE TRIGGER force_row_acceptance AFTER INSERT ON probe_counters BEGIN SELECT 1; END");
    expect(d.transaction(()=>mergeProbeFacts(d))()).toBe(c.transaction(()=>mergeProbeFacts(c))());
    c.transaction(()=>linkPublishedProbeFacts(c))();d.transaction(()=>linkPublishedProbeFacts(d,false,true))();
    for(const table of PROBE_FACT_TABLES)expect(dump(d,table)).toEqual(dump(c,table));
    c.exec("DETACH DATABASE sync_stage");d.exec("DETACH DATABASE sync_stage");
  }finally{c.close();d.close();}
  console.info(JSON.stringify({entryPoint:"ingestGaugesAsync",mode:"empty target",sample:`${lines.length} canonical/compact lines`,excludes:["archive discovery outside fixture","coordinator publication"],referenceMs,bulkMs}));
  removeTestFixture(fixture.directory,{recursive:true,force:true});
});
