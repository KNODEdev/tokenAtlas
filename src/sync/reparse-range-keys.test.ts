import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import {
  prepareReparse,
  preserveReparseOutsideRange,
  type ReparsePlan,
  type ReparseSpec,
} from "./reparse";

const directories:string[]=[];
afterEach(()=>{
  for(const directory of directories.splice(0))removeTestFixture(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});

// Exactly what the Codex import (ensureCodexSchema) creates: no PRIMARY KEY and no UNIQUE
// index on events or ratelimit, one ratelimit row per rate-limit slot of a source
// line, and columns that legacy rows predate.
const CODEX_SCHEMA=`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,model TEXT,in_tok INTEGER,source_offset INTEGER);
  CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,window_minutes INTEGER,used_percent REAL,
    limit_id TEXT,source_offset INTEGER,source_slot TEXT);
  CREATE TABLE files(home TEXT,path TEXT,size INTEGER,mtime REAL,PRIMARY KEY(home,path));`;
const CODEX_TABLES=["events","ratelimit"];
const codex:ReparseSpec={identity:["home","path"],bookmarkTable:"files"};

test("equal outside rows retain their stage rowids without firing restore triggers", () => {
  const {active,stage}=databases(CODEX_SCHEMA);
  try {
    for(const db of [active,stage])db.exec(`INSERT INTO events(rowid,home,path,ts,model,in_tok,source_offset) VALUES
      (7,'pc','a.jsonl','2026-09-08T10:00:00Z','accepted',20,50),
      (9,'pc','a.jsonl','2026-09-09T10:00:00Z','accepted',10,100)`);
    stage.exec(`UPDATE events SET in_tok=11 WHERE source_offset=100;
      CREATE TRIGGER keep_outside BEFORE DELETE ON events WHEN OLD.source_offset=50
      BEGIN SELECT RAISE(ABORT,'outside row was rewritten'); END`);
    preserveReparseOutsideRange(active,stage,codex,CODEX_TABLES,[{home:'pc',path:'a.jsonl'}],bounded('2026-09-09','2026-09-10'));
    expect(stage.query("SELECT rowid,in_tok FROM events ORDER BY rowid").all())
      .toEqual([{rowid:7,in_tok:20},{rowid:9,in_tok:11}]);
  } finally {active.close();stage.close();}
});

function databases(schema:string) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-reparse-keys-"));directories.push(directory);
  const active=new Database(path.join(directory,"active.sqlite"),{create:true});
  const stage=new Database(path.join(directory,"stage.sqlite"),{create:true});
  for(const db of [active,stage])db.exec(schema);
  return {active,stage,directory};
}
function bounded(from:string,untilExclusive:string):ReparsePlan {
  return {identities:[],sources:[],unavailable:[],protectedBookmarks:[],partialIdentities:new Set(),
    bounds:{from:`${from}T00:00:00.000Z`,untilExclusive:`${untilExclusive}T00:00:00.000Z`,
      candidateFrom:from,candidateUntil:untilExclusive}};
}

test("codex tables without a declared key reconcile on a proven one and keep every rate-limit slot",()=>{
  const {active,stage}=databases(CODEX_SCHEMA);
  try{
    active.exec(`INSERT INTO events(home,path,ts,model,in_tok,source_offset) VALUES
      ('pc','a.jsonl','2026-09-09T10:00:00Z','accepted',10,100),
      ('pc','a.jsonl','2026-09-08T10:00:00Z','accepted',20,50);
      INSERT INTO ratelimit(home,path,ts,window_minutes,used_percent,limit_id,source_offset,source_slot) VALUES
      ('pc','a.jsonl','2026-09-09T10:00:00Z',10080,50.0,'codex',100,'primary'),
      ('pc','a.jsonl','2026-09-09T10:00:00Z',300,20.0,'codex',100,'secondary'),
      ('pc','a.jsonl','2026-09-07T10:00:00Z',10080,10.0,'codex',10,'primary')`);
    stage.exec(`INSERT INTO events(home,path,ts,model,in_tok,source_offset) VALUES
      ('pc','a.jsonl','2026-09-09T10:00:00Z','reparsed',11,100),
      ('pc','a.jsonl','2026-09-08T10:00:00Z','reparsed',21,50);
      INSERT INTO ratelimit(home,path,ts,window_minutes,used_percent,limit_id,source_offset,source_slot) VALUES
      ('pc','a.jsonl','2026-09-09T10:00:00Z',10080,55.0,'codex',100,'primary'),
      ('pc','a.jsonl','2026-09-09T10:00:00Z',300,25.0,'codex',100,'secondary'),
      ('pc','a.jsonl','2026-09-07T10:00:00Z',10080,15.0,'codex',10,'primary')`);
    const plan=bounded("2026-09-09","2026-09-10");
    const identities=preserveReparseOutsideRange(active,stage,codex,CODEX_TABLES,[{home:"pc",path:"a.jsonl"}],plan);
    expect(identities).toEqual([{home:"pc",path:"a.jsonl"}]);
    expect(plan.ambiguous??[]).toEqual([]);
    expect(stage.query("SELECT ts,model,in_tok FROM events ORDER BY source_offset").all()).toEqual([
      {ts:"2026-09-08T10:00:00Z",model:"accepted",in_tok:20},
      {ts:"2026-09-09T10:00:00Z",model:"reparsed",in_tok:11},
    ]);
    // Two slots of one source line are two facts; neither may absorb the other.
    expect(stage.query(`SELECT source_offset,source_slot,used_percent FROM ratelimit
      ORDER BY source_offset,source_slot`).all()).toEqual([
      {source_offset:10,source_slot:"primary",used_percent:10},
      {source_offset:100,source_slot:"primary",used_percent:55},
      {source_offset:100,source_slot:"secondary",used_percent:25},
    ]);
    expect(plan.partialIdentities.has(JSON.stringify(["pc","a.jsonl"]))).toBe(true);
    const first=stage.query("SELECT * FROM events ORDER BY source_offset").all();
    preserveReparseOutsideRange(active,stage,codex,CODEX_TABLES,identities,plan);
    expect(stage.query("SELECT * FROM events ORDER BY source_offset").all()).toEqual(first);
  }finally{stage.close(true);active.close(true);}
});

test("an empty ranged codex stage reconciles instead of refusing for want of a declared key",()=>{
  const {active,stage}=databases(CODEX_SCHEMA);
  try{
    const plan=bounded("2026-09-09","2026-09-10");
    expect(preserveReparseOutsideRange(active,stage,codex,CODEX_TABLES,[{home:"pc",path:"a.jsonl"}],plan))
      .toEqual([{home:"pc",path:"a.jsonl"}]);
    expect(plan.ambiguous??[]).toEqual([]);
  }finally{stage.close(true);active.close(true);}
});

test("a source whose rows prove no key keeps its accepted facts and is reported, not rewritten",()=>{
  const {active,stage}=databases(CODEX_SCHEMA);
  try{
    active.exec(`INSERT INTO events(home,path,ts,model,in_tok,source_offset) VALUES
      ('pc','legacy.jsonl','2026-09-09T10:00:00Z','accepted',1,NULL),
      ('pc','legacy.jsonl','2026-09-01T10:00:00Z','accepted',2,NULL),
      ('pc','modern.jsonl','2026-09-09T10:00:00Z','accepted',3,10)`);
    stage.exec(`INSERT INTO events(home,path,ts,model,in_tok,source_offset) VALUES
      ('pc','legacy.jsonl','2026-09-09T10:00:00Z','reparsed',9,NULL),
      ('pc','modern.jsonl','2026-09-09T10:00:00Z','reparsed',30,10)`);
    const accepted=active.query("SELECT * FROM events ORDER BY path,ts").all();
    const plan=bounded("2026-09-09","2026-09-10");
    const identities=preserveReparseOutsideRange(active,stage,codex,CODEX_TABLES,
      [{home:"pc",path:"legacy.jsonl"},{home:"pc",path:"modern.jsonl"}],plan);
    expect(identities).toEqual([{home:"pc",path:"modern.jsonl"}]);
    expect(plan.ambiguous).toEqual([{home:"pc",path:"legacy.jsonl"}]);
    expect(active.query("SELECT * FROM events ORDER BY path,ts").all()).toEqual(accepted);
    expect(stage.query("SELECT model,in_tok FROM events WHERE path='modern.jsonl'").all())
      .toEqual([{model:"reparsed",in_tok:30}]);
  }finally{stage.close(true);active.close(true);}
});

test("a rate-limit coordinate is taken from what the selected rows actually carry",()=>{
  const {active,stage}=databases(CODEX_SCHEMA);
  try{
    active.exec(`INSERT INTO ratelimit(home,path,ts,window_minutes,used_percent,limit_id,source_offset,source_slot) VALUES
      ('pc','legacy.jsonl','2026-09-09T10:00:00Z',10080,40.0,'codex',NULL,'primary'),
      ('pc','legacy.jsonl','2026-09-09T10:00:00Z',300,20.0,'codex',NULL,'secondary'),
      ('pc','legacy.jsonl','2026-09-01T10:00:00Z',10080,5.0,'codex',NULL,'primary')`);
    stage.exec(`INSERT INTO ratelimit(home,path,ts,window_minutes,used_percent,limit_id,source_offset,source_slot) VALUES
      ('pc','legacy.jsonl','2026-09-09T10:00:00Z',10080,41.0,'codex',NULL,'primary'),
      ('pc','legacy.jsonl','2026-09-09T10:00:00Z',300,21.0,'codex',NULL,'secondary'),
      ('pc','legacy.jsonl','2026-09-01T10:00:00Z',10080,6.0,'codex',NULL,'primary')`);
    const plan=bounded("2026-09-09","2026-09-10");
    expect(preserveReparseOutsideRange(active,stage,codex,CODEX_TABLES,[{home:"pc",path:"legacy.jsonl"}],plan))
      .toEqual([{home:"pc",path:"legacy.jsonl"}]);
    expect(plan.ambiguous??[]).toEqual([]);
    expect(stage.query("SELECT ts,window_minutes,used_percent FROM ratelimit ORDER BY ts,window_minutes").all()).toEqual([
      {ts:"2026-09-01T10:00:00Z",window_minutes:10080,used_percent:5},
      {ts:"2026-09-09T10:00:00Z",window_minutes:300,used_percent:21},
      {ts:"2026-09-09T10:00:00Z",window_minutes:10080,used_percent:41},
    ]);
  }finally{stage.close(true);active.close(true);}
});

test("UTC-day membership survives mixed sub-second precision and timezone offsets",()=>{
  const {active,stage}=databases(CODEX_SCHEMA);
  try{
    const rows:Array<[string,number,boolean]>=[
      ["2026-09-08T23:59:59.999999Z",1,false],
      ["2026-09-09T00:00:00Z",2,true],
      ["2026-09-08T19:00:00.500-05:00",3,true],
      ["2026-09-09T02:00:00+03:00",4,false],
      ["2026-09-09T23:59:59.999999Z",5,true],
      ["2026-09-10T00:00:00.000001Z",6,false],
    ];
    const acceptedRow=active.query("INSERT INTO events(home,path,ts,model,in_tok,source_offset) VALUES('pc','a.jsonl',?,'accepted',?,?)");
    const stagedRow=stage.query("INSERT INTO events(home,path,ts,model,in_tok,source_offset) VALUES('pc','a.jsonl',?,'reparsed',?,?)");
    for(const [ts,offset] of rows){acceptedRow.run(ts,offset,offset);stagedRow.run(ts,offset*10,offset);}
    preserveReparseOutsideRange(active,stage,codex,CODEX_TABLES,[{home:"pc",path:"a.jsonl"}],
      bounded("2026-09-09","2026-09-10"));
    expect(stage.query("SELECT source_offset,model FROM events ORDER BY source_offset").all())
      .toEqual(rows.map(([,offset,inside])=>({source_offset:offset,model:inside?"reparsed":"accepted"})));
  }finally{stage.close(true);active.close(true);}
});

test("a bookmarked OpenCode store keyed only by store stays a readable source",()=>{
  const {active,stage,directory}=databases(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE oc_events(store TEXT NOT NULL,message_id TEXT NOT NULL,ts TEXT);`);
  const file=path.join(directory,"opencode.sqlite");fs.writeFileSync(file,"source");
  try{
    active.exec(`INSERT INTO oc_events(store,message_id,ts) VALUES
      ('pc','m1','2026-09-09T10:00:00Z'),('stranger','m2','2026-09-09T11:00:00Z')`);
    stage.query("INSERT INTO meta(key,value) VALUES('opencode_snapshot:pc',?)")
      .run(JSON.stringify({path:file,size:6,mtime:1}));
    const spec:ReparseSpec={identity:["store"],bookmarkTable:null};
    const plan=prepareReparse(active,stage,spec,["oc_events"],{from:"2026-09-09",until:"2026-09-09"},
      ()=>true);
    expect(plan.identities).toEqual([{store:"pc"}]);
    expect(plan.sources).toEqual([{store:"pc",path:file}]);
    // Nothing locates a store that never had a snapshot, and that is reported, not guessed.
    expect(plan.unavailable).toEqual([{store:"stranger"}]);
    expect(stage.query("SELECT key FROM meta").all()).toEqual([]);
  }finally{stage.close(true);active.close(true);}
});
