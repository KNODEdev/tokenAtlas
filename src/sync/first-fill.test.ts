import {afterEach,expect,spyOn,test} from "bun:test";
import path from "node:path";
import {Database} from "../db/sqlite";
import {createTestDatabase,adaptersWith,noMirror,successfulNoop} from "./test-support";
import {SyncCoordinator} from "./coordinator";
import {FirstFillPublication,publishFirstFill,recoverFirstFills,tablesAreEmpty} from "./first-fill";
import {identityFacts} from "./accepted-facts";
import {removeTestFixture} from "../test-cleanup";
import * as remapModule from "../projects/remap";
import { advanceModelTimelines, readModelTimeline } from "../db/model-timeline";
const remapReal=remapModule.remap;

const fixtures:string[]=[];
afterEach(()=>{
  Bun.gc(true);for(const dir of fixtures.splice(0))removeTestFixture(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});
const fixture=()=>{const f=createTestDatabase();fixtures.push(f.directory);return f;};
const TS="2026-02-01T12:34:56.000Z";
const spec={identity:["store","path"],tables:[{table:"claude_events",order:["store","call_id"]},{table:"claude_limit_hits",order:["store","call_id"]}]};

test("first fill suspends only owned timeline triggers and hands changed source days back to the prepared register",()=>{
  const f=fixture(),db=new Database(f.dbPath);
  try {
    advanceModelTimelines(db,{budgetMs:10000});
    db.transaction(()=>publishFirstFill(db,["claude_events"],()=>{
      expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name='model_timeline_claude_insert'").get()).toBeNull();
      db.exec("INSERT INTO claude_events(store,call_id,path,ts,model) VALUES('p','a','p','2026-01-01','m'),('p','b','p','2026-02-01','m')");
    })).immediate();
    expect(db.query("SELECT day FROM model_timeline_dirty WHERE provider='claude' ORDER BY day").all())
      .toEqual([{day:'2026-01-01'},{day:'2026-02-01'}]);
    while(advanceModelTimelines(db,{budgetMs:10000}).pending){}
    expect(readModelTimeline(db,'claude').models).toEqual([{model:'m',first_ts:'2026-01-01'}]);
  } finally {db.close();}
});

test("bulk first fill equals ordinary typed facts, bookmarks, digests, analysis day clocks and changed source days",()=>{
  const a=fixture(),b=fixture(),ordinary=new Database(a.dbPath),bulk=new Database(b.dbPath);
  const write=(db:Database)=>{
    db.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','a','a.jsonl',?,?)")
      .run(TS,9007199254740993n);
    db.query("INSERT INTO claude_files(store,path,parser_version,size,mtime,calls,ingested_at) VALUES('pc','a.jsonl',5,123,?,1,?)").run(1.0000000000000002,TS);
  };
  try {
    ordinary.transaction(()=>write(ordinary)).immediate();
    bulk.transaction(()=>publishFirstFill(bulk,["claude_events","claude_limit_hits","claude_files"],()=>write(bulk))).immediate();
    for(const table of ["claude_events","claude_limit_hits","claude_files"])
      expect(bulk.query(`SELECT * FROM ${table}`).all()).toEqual(ordinary.query(`SELECT * FROM ${table}`).all());
    expect(identityFacts(bulk,"claude",spec,[{store:"pc",path:"a.jsonl"}])).toEqual(identityFacts(ordinary,"claude",spec,[{store:"pc",path:"a.jsonl"}]));
    const clocks="SELECT * FROM analysis_source_revisions WHERE source IN ('claude_events','claude_limit_hits','claude_files') ORDER BY source,bucket";
    expect(bulk.query(clocks).all()).toEqual(ordinary.query(clocks).all());
    const days="SELECT * FROM fact_day_revisions ORDER BY source,day";
    expect(bulk.query(days).all()).toEqual(ordinary.query(days).all());
    expect(bulk.query(days).all()).toEqual([{source:"claude_events",day:"*",revision:1},{source:"claude_events",day:TS.slice(0,10),revision:1}]);
  } finally {ordinary.close();bulk.close();}
});

test("failed bulk publication restores indexes, trackers, clocks and facts atomically",()=>{
  const f=fixture(),db=new Database(f.dbPath);
  const schema=()=>db.query("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY type,name").all();
  try {
    const before=schema();
    expect(()=>db.transaction(()=>publishFirstFill(db,["claude_events"],()=>{
      db.query("INSERT INTO claude_events(store,call_id,path,ts) VALUES('pc','a','a.jsonl',?)").run(TS);
      throw new Error("interrupted");
    })).immediate()).toThrow("interrupted");
    expect(tablesAreEmpty(db,["claude_events"])).toBe(true);
    expect(schema()).toEqual(before);expect(db.query("SELECT * FROM fact_day_revisions").all()).toEqual([]);
    db.query("INSERT INTO claude_events(store,call_id,path,ts) VALUES('pc','a','a.jsonl',?)").run(TS);
    expect(()=>db.transaction(()=>publishFirstFill(db,["claude_events"],()=>{})).immediate()).toThrow("destination changed");
  } finally {db.close();}
});

test("coordinator first fill rolls back, resumes on restart and publishes zero changes on retry",async()=>{
  const f=fixture();let fail=true,version=0;
  const options={dbPath:f.dbPath,rootDir:process.cwd(),mirror:noMirror,
    configFingerprint:()=>"fixture",sourceFingerprint:()=>String(version),prepareStage:()=>{},refreshDerived:()=>{},
    afterPublishBeforeRevision:()=>{if(fail)throw new Error("interrupt before receipt");},
    adapters:adaptersWith({claude:async context=>{
      const stage=new Database(context.stageDbPath);
      try {stage.transaction(()=>{const insert=stage.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc',?,'a.jsonl',?,?)");
        for(let i=0;i<1001;i++)insert.run(String(i),TS,i);
      })();} finally {stage.close();}
      return {...successfulNoop(),processedInputs:1,writtenRows:1001};
    }})};
  const request={mode:"incremental",trigger:"auto",scope:{kind:"vendor",vendor:"claude"}} as const;
  let c=new SyncCoordinator(options);
  try {
    const failed=await c.enter(request).completion;
    expect(failed.status).toBe("failure");
    expect(failed.vendors[0]!.timings!.comparisonMs).toBe(0);
    expect(failed.vendors[0]!.diagnostics.firstFill).toBe(true);
    expect(c.latest()!.vendors[0]!.timings).toEqual(failed.vendors[0]!.timings);
    c.close();
    const check=new Database(f.dbPath);try {expect(check.query("SELECT count(*) n FROM claude_events").get()).toEqual({n:0});}finally{check.close();}
    fail=false;c=new SyncCoordinator(options);
    const started=performance.now(),first=await c.enter(request).completion;
    expect({status:first.status,error:first.error}).toEqual({status:"success",error:null});
    expect(first.vendors[0]!.diagnostics.firstFill).toBe(true);
    expect(first.vendors[0]!.timings!.comparisonMs).toBe(0);
    console.info(JSON.stringify({entryPoint:"SyncCoordinator.enter with injected fixture adapter",mode:"incremental",sample:"1001 Claude rows / one identity",excludes:["archive bytes and production parsing","derived preparation"],elapsedMs:performance.now()-started,timings:first.vendors[0]!.timings}));
    c.close();version++;c=new SyncCoordinator(options);
    const repeated=await c.enter(request).completion;
    expect({status:repeated.status,error:repeated.error}).toEqual({status:"success",error:null});
    expect(repeated.vendors[0]!.dataChanged).toBe(false);expect(repeated.afterRevisions).toEqual(repeated.beforeRevisions);
    const check2=new Database(f.dbPath);try {expect(check2.query("SELECT count(*) n FROM claude_events").get()).toEqual({n:1001});
      // The bulk fill recorded its rows' days once; the repeated run changed none.
      expect(check2.query("SELECT revision FROM fact_day_revisions WHERE source='claude_events' AND day='*'").get()).toEqual({revision:1001});
    }finally{check2.close();}
  }finally{c.close();}
});

test("vendors of a first import form a queue: one vendor at a time, readings first",async()=>{
  const f=fixture();let running=0,peak=0;const order:string[]=[];
  const enter=(vendor:string)=>async()=>{order.push(vendor);peak=Math.max(peak,++running);await Bun.sleep(20);running--;return successfulNoop();};
  const c=new SyncCoordinator({dbPath:f.dbPath,rootDir:process.cwd(),mirror:noMirror,archiveInputs:()=>undefined,
    adapters:adaptersWith({claude:enter("claude"),grok:enter("grok"),gauges:enter("gauges")}),configFingerprint:()=>"fixture",sourceFingerprint:()=>"fixture",prepareStage:()=>{},refreshDerived:()=>{}});
  try {const result=await c.enter({mode:"incremental",trigger:"auto",collection:"archive",scope:{kind:"vendors",vendors:["claude","grok","gauges"]}}).completion;
    expect({status:result.status,error:result.error}).toEqual({status:"success",error:null});
    expect({peak,order}).toEqual({peak:1,order:["gauges","claude","grok"]});
  } finally {c.close();}
});

/** Rows of `count` Claude files with `rows` calls each, staged in their own database the way an import stages them. */
function stageClaude(directory:string,count:number,rows:number):string {
  const file=path.join(directory,"stage.sqlite"),stage=new Database(file,{create:true});
  try {
    stage.exec("CREATE TABLE claude_events(store TEXT,call_id TEXT,path TEXT,ts TEXT,in_uncached INTEGER)");
    const insert=stage.query("INSERT INTO claude_events VALUES('pc',?,?,?,?)");
    stage.transaction(()=>{for(let f=count-1;f>=0;f--)for(let r=0;r<rows;r++)insert.run(`c${f}-${r}`,`f${f}.jsonl`,`2026-02-0${1+r%3}T10:00:00.000Z`,r);})();
  } finally {stage.close();}
  return file;
}

/** The coordinator's batch step: one window of identities per transaction, in identity order. */
function batchedClaudeFill(db:Database,stagePath:string,files:number):void {
  db.query("ATTACH DATABASE ? AS stage").run(stagePath);
  try {
    const transact=(work:()=>void)=>db.transaction(work).immediate();
    const fill=FirstFillPublication.begin(db,"claude",["claude_events"],transact);
    db.exec("CREATE TEMP TABLE ids(seq INTEGER PRIMARY KEY,store TEXT,path TEXT)");
    db.transaction(()=>{for(let f=0;f<files;f++)db.query("INSERT INTO temp.ids(store,path) VALUES('pc',?)").run(`f${f}.jsonl`);})();
    using move=db.prepare(`INSERT INTO main.claude_events(store,call_id,path,ts,in_uncached) SELECT s.store,s.call_id,s.path,s.ts,s.in_uncached
      FROM temp.ids i CROSS JOIN stage.claude_events s ON s.store=i.store AND s.path=i.path WHERE i.seq BETWEEN ? AND ? ORDER BY i.seq,+s.call_id`);
    let from=1;
    fill.move(size=>{const to=Math.min(files,from+size-1);move.run(from,to);from=to+1;return from>files;});
    fill.restore();
    fill.commit(()=>{});
  } finally {db.exec("DROP TABLE IF EXISTS temp.ids");db.exec("DETACH DATABASE stage");}
}

test("a batched first fill keeps every write transaction short and ends with the rows, clocks and schema of one transaction",()=>{
  const a=fixture(),b=fixture(),ordinary=new Database(a.dbPath),batched=new Database(b.dbPath);
  const stagePath=stageClaude(b.directory,20,30);
  const schema=(db:Database)=>db.query("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY type,name").all();
  // Virtual time: every changed row costs 20 ms, so a transaction moving more than 250 rows
  // is one the long-transaction reporter names; the batches size themselves by the same clock.
  let clockDb:Database=batched;
  const clock=spyOn(performance,"now").mockImplementation(()=>(clockDb.query("SELECT total_changes() n").get() as {n:number}).n*20);
  const warn=spyOn(console,"warn").mockImplementation(()=>{});
  try {
    const before=schema(batched);
    batchedClaudeFill(batched,stagePath,20);
    expect(warn.mock.calls.filter(call=>/write transaction held/.test(String(call[0])))).toEqual([]);
    expect(schema(batched)).toEqual(before);
    expect(batched.query("SELECT key FROM meta WHERE key LIKE 'first_fill:%'").all()).toEqual([]);
    // The same rows in one ordinary transaction: what the batches must equal, and what the reporter names.
    clockDb=ordinary;
    ordinary.query("ATTACH DATABASE ? AS stage").run(stagePath);
    ordinary.transaction(()=>{for(let f=0;f<20;f++)ordinary.query(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached)
      SELECT store,call_id,path,ts,in_uncached FROM stage.claude_events WHERE path=? ORDER BY call_id`).run(`f${f}.jsonl`);}).immediate();
    ordinary.exec("DETACH DATABASE stage");
    expect(warn.mock.calls.filter(call=>/write transaction held/.test(String(call[0])))).toHaveLength(1);
    const rows="SELECT id,store,call_id,path,ts,in_uncached FROM claude_events ORDER BY id";
    expect(batched.query(rows).all()).toEqual(ordinary.query(rows).all());
    const clocks="SELECT * FROM analysis_source_revisions WHERE source='claude_events' ORDER BY bucket";
    expect(batched.query(clocks).all()).toEqual(ordinary.query(clocks).all());
  } finally {clock.mockRestore();warn.mockRestore();ordinary.close();batched.close();}
});

test("a first fill a stopped run left unfinished is undone: empty tables, original schema, no marker",()=>{
  const f=fixture(),db=new Database(f.dbPath),stagePath=stageClaude(f.directory,4,5);
  const schema=()=>db.query("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY type,name").all();
  try {
    const before=schema();
    db.query("ATTACH DATABASE ? AS stage").run(stagePath);
    const fill=FirstFillPublication.begin(db,"claude",["claude_events"],work=>db.transaction(work).immediate());
    let moved=0;
    fill.move(()=>{db.exec("INSERT INTO claude_events(store,call_id,path,ts) SELECT store,call_id,path,ts FROM stage.claude_events WHERE path='f0.jsonl'");return ++moved===1;});
    db.exec("DETACH DATABASE stage");
    // The process stops here: rows moved, objects dropped, marker left.
    expect(db.query("SELECT count(*) n FROM claude_events").get()).toEqual({n:5});
    expect(schema()).not.toEqual(before);
    expect(recoverFirstFills(db)).toEqual(["claude"]);
    expect(tablesAreEmpty(db,["claude_events"])).toBe(true);
    expect(schema()).toEqual(before);
    expect(recoverFirstFills(db)).toEqual([]);
    expect(db.query("SELECT * FROM fact_day_revisions WHERE source='claude_events' AND day='*' AND revision>0").all()).toEqual([]);
  } finally {db.close();}
});

test("a first import maps rows once, in the stages: the main database is not remapped and keeps their rules",async()=>{
  const f=fixture();
  const rows=(stagePath:string)=>{const stage=new Database(stagePath);
    try{stage.run("INSERT INTO claude_events(store,call_id,path,ts,in_uncached,cwd,session_id) VALUES('pc','a','a.jsonl',?,1,'C:/repos/internal/atlas','s')",[TS]);}finally{stage.close();}
    return {...successfulNoop(),processedInputs:1,writtenRows:1};};
  const mainRemaps:string[]=[];
  const spy=spyOn(remapModule,"remap");
  try {
    const c=new SyncCoordinator({dbPath:f.dbPath,rootDir:process.cwd(),mirror:noMirror,configFingerprint:()=>"fixture",sourceFingerprint:()=>"fixture",
      prepareStage:(stage,report,tables)=>{remapModule.remap(stage,{projects:[]},report,tables);},
      adapters:adaptersWith({claude:async context=>rows(context.stageDbPath)})});
    spy.mockImplementation(((sqlite:Database,...rest:unknown[])=>{if(sqlite.filename===f.dbPath)mainRemaps.push(sqlite.filename);
      return (remapReal as (...a:unknown[])=>unknown)(sqlite,...rest);}) as typeof remapModule.remap);
    try{expect((await c.enter({mode:"incremental",trigger:"auto",scope:{kind:"vendor",vendor:"claude"}}).completion).status).toBe("success");}finally{c.close();}
    expect(mainRemaps).toEqual([]);
    const db=new Database(f.dbPath);
    try{
      expect(remapModule.storedFingerprint(db)).toBe(remapModule.rulesFingerprint());
      expect(db.query("SELECT repo FROM claude_events").get()).toEqual({repo:"atlas"});
    }finally{db.close();}
  } finally {spy.mockRestore();}
});
