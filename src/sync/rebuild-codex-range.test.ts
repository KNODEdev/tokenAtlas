import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { createCodexSchema, createTestDatabase } from "./test-support";
import type { SyncRunResult } from "./contracts";

const temporary:string[]=[];
afterEach(()=>{
  Bun.gc(true);
  for(const directory of temporary.splice(0))
    removeTestFixture(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});

const SELECTED_DAY="2026-09-10";
const SELECTED_FROM="2026-09-10T00:00:00.000Z";
const SELECTED_UNTIL="2026-09-11T00:00:00.000Z";
const BEFORE_TS="2026-09-09T23:59:59.999999Z";
const EARLY_TS="2026-09-10T01:00:00.000000Z";
const REPAIRED_TS="2026-09-10T22:00:00.999999Z";
const AFTER_TS="2026-09-11T00:00:00.000000Z";
// The rollout keeps what was written; ingest stores each instant as toISOString() writes it
// (microseconds truncated, never across a day), the form readers compare as text.
const stored=(ts:string)=>new Date(ts).toISOString();
const OUTSIDE_BIG="9007199254740993";
const OUTSIDE_AFTER="9007199254740995";

function initializeEngineSchema(dbPath:string):void {
  createCodexSchema(dbPath);
}

function tokenRow(timestamp:string,input:number,primary:number,secondary:number):unknown {
  return {
    timestamp,type:"event_msg",payload:{type:"token_count",info:{
      last_token_usage:{input_tokens:input,output_tokens:1,cached_input_tokens:0,reasoning_output_tokens:0,total_tokens:input+1},
      total_token_usage:{input_tokens:input,output_tokens:1,cached_input_tokens:0,reasoning_output_tokens:0,total_tokens:input+1},
      model_context_window:200000,
    },rate_limits:{
      primary:{used_percent:primary,window_minutes:300,resets_at:Date.parse(timestamp)/1000+300},
      secondary:{used_percent:secondary,window_minutes:10080,resets_at:Date.parse(timestamp)/1000+10080},
    }},
  };
}

function writeRollout(file:string,rows:Array<{ts:string;tokens:number}>):void {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const content=[
    {timestamp:"2026-09-09T20:00:00Z",type:"session_meta",payload:{originator:"codex-tui",thread_source:"user",cwd:"C:/fixture"}},
    {timestamp:"2026-09-09T20:00:01Z",type:"turn_context",payload:{model:"gpt-test",effort:"high",cwd:"C:/fixture"}},
    ...rows.map((row,index)=>tokenRow(row.ts,row.tokens,10+index,20+index)),
  ];
  fs.writeFileSync(file,content.map(row=>JSON.stringify(row)).join("\n")+"\n");
}

function writeConfiguration(directory:string,codexHome:string):void {
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,"accounts.json"),JSON.stringify({version:2,subscriptions:[{id:"codex-fixture",vendor:"codex"}],
    sources:[{vendor:"codex",home:codexHome}]}));
  fs.writeFileSync(path.join(directory,"projects.json"),JSON.stringify({projects:[]}));
  fs.writeFileSync(path.join(directory,"rate-cards.json"),JSON.stringify({vendors:{}}));
}

function fixture(){
  const created=createTestDatabase();temporary.push(created.directory);initializeEngineSchema(created.dbPath);
  const archiveRoot=path.join(created.directory,"archive");
  const codexHome=path.join(archiveRoot,"codex","PC-user");
  const rollout=path.join(codexHome,"sessions","rollout.jsonl");
  writeRollout(rollout,[
    {ts:BEFORE_TS,tokens:7},
    {ts:EARLY_TS,tokens:11},
    {ts:REPAIRED_TS,tokens:22},
    {ts:AFTER_TS,tokens:17},
  ]);
  const config=path.join(created.directory,"config");
  writeConfiguration(config,codexHome);
  const env={
    TOKENATLAS_ARCHIVE:archiveRoot,
    TOKENATLAS_CONFIG:config,
    TOKENATLAS_LOCAL_STATE:path.join(created.directory,"local-state"),
    USERPROFILE:path.join(created.directory,"absent-home"),
    HOME:path.join(created.directory,"absent-home"),
    APPDATA:path.join(created.directory,"absent-appdata"),
    LOCALAPPDATA:path.join(created.directory,"absent-localappdata"),
  };
  return {...created,archiveRoot,codexHome,rollout,config,env};
}

async function child(cmd:string[],env:Record<string,string>,timeout=120000):Promise<string> {
  const processHandle=Bun.spawn({cmd,cwd:process.cwd(),env:{...process.env,...env},stdout:"pipe",stderr:"pipe"});
  const watchdog=setTimeout(()=>processHandle.kill(),timeout);
  const [exit,stdout,stderr]=await Promise.all([
    processHandle.exited,new Response(processHandle.stdout).text(),new Response(processHandle.stderr).text(),
  ]).finally(()=>clearTimeout(watchdog));
  if(exit!==0)throw new Error(`child exited ${exit}: ${stderr}`);
  return stdout;
}

function resultLine(stdout:string,prefix:string):SyncRunResult {
  const line=stdout.split(/\r?\n/).find(value=>value.startsWith(prefix));
  if(!line)throw new Error(`Missing ${prefix} result`);
  return JSON.parse(line.slice(prefix.length)) as SyncRunResult;
}

function ordinaryScript(directory:string):string {
  const script=path.join(directory,"ordinary-codex.ts");
  fs.writeFileSync(script,`
    import {SyncCoordinator} from ${JSON.stringify(path.join(import.meta.dir,"coordinator.ts"))};
    import {noMirror} from ${JSON.stringify(path.join(import.meta.dir,"test-support.ts"))};
    const coordinator=new SyncCoordinator({dbPath:process.argv[2]!,rootDir:process.cwd(),mirror:noMirror});
    try{const result=await coordinator.enter({trigger:"manual",scope:{kind:"vendor",vendor:"codex"},mode:"incremental"}).completion;
      console.log("TOKENATLAS_ORDINARY:"+JSON.stringify(result));}finally{coordinator.close();}
  `);
  return script;
}

async function ordinary(f:ReturnType<typeof fixture>,script=ordinaryScript(f.directory)):Promise<SyncRunResult> {
  return resultLine(await child([process.execPath,script,f.dbPath],f.env),"TOKENATLAS_ORDINARY:");
}

/** The production runner with a one-day Codex rebuild request, as the server starts its source phase. */
async function rebuildDay(f:ReturnType<typeof fixture>,generation:number):Promise<SyncRunResult> {
  const request={trigger:"manual",scope:{kind:"vendor",vendor:"codex"},mode:"incremental",
    reparse:{from:SELECTED_DAY,until:SELECTED_DAY},rebuildGeneration:generation,collection:"archive"} as const;
  const stdout=await child([process.execPath,path.join(import.meta.dir,"runner.ts"),JSON.stringify({
    dbPath:f.dbPath,rootDir:process.cwd(),request,
  })],f.env);
  return resultLine(stdout,"TOKENATLAS_SYNC_RESULT:");
}

function encodedRows(db:Database,table:string,where="",params:unknown[]=[]):unknown[] {
  const columns=(db.query(`PRAGMA table_info("${table}")`).all() as Array<{name:string}>).map(row=>row.name);
  const encoded=columns.map(column=>`CASE typeof("${column}")
    WHEN 'integer' THEN 'i:'||CAST("${column}" AS TEXT)
    WHEN 'real' THEN 'r:'||printf('%!.26g',"${column}")
    WHEN 'text' THEN 't:'||"${column}"
    WHEN 'blob' THEN 'b:'||hex("${column}") ELSE 'n:' END AS "${column}"`).join(",");
  return db.query(`SELECT 'i:'||CAST(rowid AS TEXT) AS __rowid,${encoded} FROM "${table}" ${where}
    ORDER BY rowid`).all(...params as never[]);
}

function outsideRaw(db:Database,home:string,file:string):Record<string,unknown[]> {
  const predicate="WHERE home=? AND path=? AND (ts IS NULL OR ts<? OR ts>=?)";
  const params=[home,file,SELECTED_FROM,SELECTED_UNTIL];
  return Object.fromEntries(["events","ratelimit"].map(table=>
    [table,encodedRows(db,table,predicate,params)]));
}

function outsideRevisions(db:Database):unknown[] {
  return db.query(`SELECT source,bucket,CAST(revision AS TEXT) AS revision
    FROM analysis_source_revisions
    WHERE source IN ('events','ratelimit')
      AND bucket<>'*' AND bucket<>?
    ORDER BY source,bucket`).all(SELECTED_DAY);
}

function completeState(db:Database):Record<string,unknown> {
  return {
    events:encodedRows(db,"events"),ratelimit:encodedRows(db,"ratelimit"),
    files:encodedRows(db,"files"),
    vendorRevisions:encodedRows(db,"vendor_sync_revisions"),
    // Logging a new sync run changes its own clock even when source publication fails.
    sourceRevisions:encodedRows(db,"analysis_source_revisions","WHERE source<>'sync_runs'"),
  };
}

test("a Codex day rebuild repairs the selected day from the archive, preserves outside rows and clocks, survives restart and leaves an honest full-file reread",async()=>{
  const f=fixture();const ordinaryRunner=ordinaryScript(f.directory);
  const baseline=await ordinary(f,ordinaryRunner);
  expect({status:baseline.status,error:baseline.error}).toEqual({status:"success",error:null});
  let db=new Database(f.dbPath);
  try {
    installAnalysisTracking(db);
    db.exec(`UPDATE events SET in_tok=999 WHERE ts>='${SELECTED_FROM}' AND ts<'${SELECTED_UNTIL}';
      UPDATE events SET in_tok=9007199254740993 WHERE ts='${stored(BEFORE_TS)}';
      UPDATE events SET in_tok=9007199254740995 WHERE ts='${stored(AFTER_TS)}'`);
  } finally {db.close(true);}

  const generation=51001;

  db=new Database(f.dbPath,{readonly:true});
  const outsideBefore=outsideRaw(db,f.codexHome,f.rollout);
  const revisionsBefore=outsideRevisions(db);
  db.close(true);

  const first=await rebuildDay(f,generation);
  expect({status:first.status,error:first.error}).toEqual({status:"success",error:null});
  const codex=first.vendors.find(vendor=>vendor.vendor==="codex")!;
  // Both damaged rows of the selected day are repaired from the archive file as it is now.
  expect(codex).toMatchObject({status:"success",dataChanged:true,
    dirtyRange:{from:stored(EARLY_TS),to:stored(REPAIRED_TS)}});

  db=new Database(f.dbPath,{readonly:true});
  try {
    expect(outsideRaw(db,f.codexHome,f.rollout)).toEqual(outsideBefore);
    expect(outsideRevisions(db)).toEqual(revisionsBefore);
    expect(db.query(`SELECT ts,CAST(in_tok AS TEXT) AS in_tok FROM events
      WHERE home=? AND path=? ORDER BY ts`).all(f.codexHome,f.rollout)).toEqual([
      {ts:stored(BEFORE_TS),in_tok:OUTSIDE_BIG},
      {ts:stored(EARLY_TS),in_tok:"11"},
      {ts:stored(REPAIRED_TS),in_tok:"22"},
      {ts:stored(AFTER_TS),in_tok:OUTSIDE_AFTER},
    ]);
    const limits=db.query(`SELECT source_offset,source_slot,window_minutes,limit_id
      FROM ratelimit WHERE home=? AND path=? AND ts=? ORDER BY window_minutes`).all(
        f.codexHome,f.rollout,stored(REPAIRED_TS)) as Array<{source_offset:number;source_slot:string;window_minutes:number;limit_id:string|null}>;
    expect(limits.map(row=>row.window_minutes)).toEqual([300,10080]);
    expect(new Set(limits.map(row=>row.source_offset)).size).toBe(1);
    expect(new Set(limits.map(row=>row.source_slot)).size).toBe(2);
    expect(limits.map(row=>row.source_slot)).toEqual(["primary","secondary"]);
    expect(db.query("SELECT size,mtime,offset,events,parser_state FROM files WHERE home=? AND path=?")
      .get(f.codexHome,f.rollout)).toMatchObject({size:-1,mtime:-1});
  } finally {db.close(true);}

  // A second fresh runner resumes the completed generation without touching raw
  // rows, bookmarks, or any source revision.
  db=new Database(f.dbPath,{readonly:true});const afterFirst=completeState(db);db.close(true);
  const second=await rebuildDay(f,generation);
  expect({status:second.status,error:second.error}).toEqual({status:"success",error:null});
  db=new Database(f.dbPath,{readonly:true});expect(completeState(db)).toEqual(afterFirst);db.close(true);

  // The unread bookmark is intentional. The next ordinary process rereads the
  // complete live file, catches the excluded outside rows and establishes one
  // truthful whole-file position instead of looping forever.
  const ordinaryCorrection=await ordinary(f,ordinaryRunner);
  expect({status:ordinaryCorrection.status,error:ordinaryCorrection.error}).toEqual({status:"success",error:null});
  expect(ordinaryCorrection.vendors.find(vendor=>vendor.vendor==="codex")).toMatchObject({status:"success",processedInputs:1});
  db=new Database(f.dbPath,{readonly:true});
  try {
    expect(db.query(`SELECT ts,CAST(in_tok AS TEXT) AS in_tok FROM events
      WHERE home=? AND path=? ORDER BY ts`).all(f.codexHome,f.rollout)).toEqual([
      {ts:stored(BEFORE_TS),in_tok:"7"},{ts:stored(EARLY_TS),in_tok:"11"},
      {ts:stored(REPAIRED_TS),in_tok:"22"},{ts:stored(AFTER_TS),in_tok:"17"},
    ]);
    const bookmark=db.query("SELECT size,offset,events,parser_state FROM files WHERE home=? AND path=?")
      .get(f.codexHome,f.rollout) as {size:number;offset:number;events:number;parser_state:string};
    expect(bookmark.size).toBe(fs.statSync(f.rollout).size);
    expect(bookmark.offset).toBe(bookmark.size);
    expect(JSON.parse(bookmark.parser_state).offset).toBe(bookmark.offset);
  } finally {db.close(true);}
  const corrected=new Database(f.dbPath,{readonly:true});const correctedState=completeState(corrected);corrected.close(true);
  const ordinaryAgain=await ordinary(f,ordinaryRunner);
  expect({status:ordinaryAgain.status,error:ordinaryAgain.error}).toEqual({status:"success",error:null});
  db=new Database(f.dbPath,{readonly:true});expect(completeState(db)).toEqual(correctedState);db.close(true);
},180000);

test("a ranged Codex rebuild rejects one legacy source without coordinates beside a modern source and retains every accepted fact",async()=>{
  const f=fixture();const ordinaryRunner=ordinaryScript(f.directory);
  const baseline=await ordinary(f,ordinaryRunner);
  expect({status:baseline.status,error:baseline.error}).toEqual({status:"success",error:null});
  const legacy=path.join(path.dirname(f.rollout),"legacy.jsonl");
  writeRollout(legacy,[{ts:REPAIRED_TS,tokens:33}]);
  let db=new Database(f.dbPath);
  try {
    installAnalysisTracking(db);
    db.query(`INSERT INTO events(home,path,ts,surface,model,effort,in_tok,out_tok,source_offset)
      SELECT home,?,? ,surface,model,effort,333,out_tok,NULL
      FROM events WHERE home=? AND path=? LIMIT 1`).run(legacy,REPAIRED_TS,f.codexHome,f.rollout);
  } finally {db.close(true);}

  db=new Database(f.dbPath,{readonly:true});const accepted=completeState(db);db.close(true);

  const result=await rebuildDay(f,51002);
  expect(result.status).toBe("failure");
  const codex=result.vendors.find(vendor=>vendor.vendor==="codex")!;
  expect(codex.status).toBe("failure");
  expect(codex.error).toContain("cannot prove source coordinates");
  expect(codex.error).toContain("no source facts were published");
  expect(codex.processedInputs).toBeGreaterThan(0);

  db=new Database(f.dbPath,{readonly:true});
  try {
    expect(completeState(db)).toEqual(accepted);
    expect(db.query("SELECT CAST(in_tok AS TEXT) AS in_tok,source_offset FROM events WHERE path=?")
      .get(legacy)).toEqual({in_tok:"333",source_offset:null});
  } finally {db.close(true);}
},180000);
