import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import {
  captureTimestampEvidence,
  compareTimestampEvidence,
  dropTimestampEvidence,
  measureTimestampDifference,
  measureTimestampDifferences,
  type TimestampEvidence,
} from "./timestamp-difference";

const directories:string[]=[];
afterEach(()=>{
  for(const directory of directories.splice(0))
    removeTestFixture(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});

const SPEC={identity:["home","path"],tables:["events"]};
const IDENTITY={home:"pc",path:"selected.jsonl"};
const FIRST="2026-09-10T01:00:00.000000Z";
const LAST="2026-09-10T22:00:00.999999Z";
const LARGE_ROWS=6000;
const LARGE_PAYLOAD="x".repeat(2048);

function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-timestamp-difference-"));
  directories.push(directory);
  const active=new Database(path.join(directory,"active.sqlite"),{create:true});
  const stage=new Database(path.join(directory,"stage.sqlite"),{create:true});
  const schema=`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,value INTEGER,payload TEXT);
    CREATE INDEX events_source ON events(home,path);
    CREATE TABLE analysis_source_revisions(source TEXT,bucket TEXT,revision INTEGER);`;
  active.exec(schema);stage.exec(schema);

  const fill=(db:Database)=>db.transaction(()=>{
    const selected=db.query("INSERT INTO events(home,path,ts,value,payload) VALUES('pc','selected.jsonl',?,?,?)");
    for(let index=0;index<LARGE_ROWS;index++)selected.run(
      `2026-09-${String(index%8+1).padStart(2,"0")}T12:00:00.${String(index).padStart(6,"0")}Z`,
      index,`${LARGE_PAYLOAD}:${index}`);
    const outside=db.query("INSERT INTO events(home,path,ts,value,payload) VALUES('pc','outside.jsonl',?,?,?)");
    for(let index=0;index<1000;index++)outside.run(
      `2025-01-${String(index%28+1).padStart(2,"0")}T12:00:00Z`,index,`outside-${index}`);
  })();
  fill(active);fill(stage);

  active.exec(`INSERT INTO events VALUES
    ('pc','selected.jsonl','${FIRST}',5,'duplicate'),
    ('pc','selected.jsonl','${FIRST}',5,'duplicate'),
    ('pc','selected.jsonl','${LAST}',9007199254740992,'adjacent-int64');
    INSERT INTO analysis_source_revisions VALUES('events','2025-01-01',77)`);
  stage.exec(`INSERT INTO events VALUES
    ('pc','selected.jsonl','${FIRST}',5,'duplicate'),
    ('pc','selected.jsonl','${LAST}',9007199254740993,'adjacent-int64');`);
  return {active,stage};
}

function quote(value:string):string {
  return `"${value.replaceAll('"','""')}"`;
}

function scratchTables(db:Database):unknown[] {
  return db.query(`SELECT name FROM sqlite_master
    WHERE type='table' AND name LIKE '__tokenatlas_timestamp_%' ORDER BY name`).all();
}

function evidenceCounts(db:Database,evidence:TimestampEvidence):{sourceRows:number;distinctRows:number} {
  return db.query(`SELECT COALESCE(SUM(copies),0) AS sourceRows,COUNT(*) AS distinctRows
    FROM ${quote(evidence.table)}`).get() as {sourceRows:number;distinctRows:number};
}

function sourceSummary(db:Database,pathValue:string):unknown {
  return db.query(`SELECT COUNT(*) AS rows,MIN(rowid) AS firstRow,MAX(rowid) AS lastRow,
    SUM(length(payload)) AS payloadBytes FROM events WHERE path=?`).get(pathValue);
}

test("disk-backed timestamp evidence streams a large selected source with exact multiplicity and int64 values",()=>{
  const {active,stage}=fixture();
  try {
    // Event assertions use aggregates or iteration-backed production helpers; no
    // test path materializes the thousands of selected payload rows with .all().
    const selectedBefore=sourceSummary(active,"selected.jsonl");
    const outsideBefore=sourceSummary(active,"outside.jsonl");
    const revisionBefore=active.query("SELECT source,bucket,revision FROM analysis_source_revisions").get();

    // The stage differs by one duplicate and by adjacent int64 values which a JS
    // Number cannot distinguish. Raw fractional timestamps must survive unchanged.
    expect(measureTimestampDifference(active,stage,SPEC,[IDENTITY])).toEqual({from:FIRST,to:LAST});
    expect(scratchTables(stage)).toEqual([]);
    expect(sourceSummary(active,"selected.jsonl")).toEqual(selectedBefore);
    expect(sourceSummary(active,"outside.jsonl")).toEqual(outsideBefore);

    const baseline=captureTimestampEvidence(active,stage,SPEC,[IDENTITY]);
    expect(evidenceCounts(stage,baseline)).toEqual({
      sourceRows:LARGE_ROWS+3,
      distinctRows:LARGE_ROWS+2,
    });
    // The one evidence table contains the requested identity only; unrelated
    // history is not copied even though it shares the source table.
    expect(stage.query(`SELECT COUNT(DISTINCT identity_key) AS identities,
      COUNT(DISTINCT source_table) AS sourceTables FROM ${quote(baseline.table)}`).get())
      .toEqual({identities:1,sourceTables:1});

    const unchanged=captureTimestampEvidence(active,stage,SPEC,[IDENTITY]);
    try {
      expect(compareTimestampEvidence(stage,baseline,unchanged)).toBeNull();
    } finally {dropTimestampEvidence(stage,unchanged);}

    // This models the final post-replay state: only one adjacent int64 value
    // remains changed relative to the locked baseline.
    active.exec(`UPDATE events SET value=9007199254740993
      WHERE home='pc' AND path='selected.jsonl' AND ts='${LAST}'`);
    const finalEvidence=captureTimestampEvidence(active,stage,SPEC,[IDENTITY]);
    try {
      expect(evidenceCounts(stage,finalEvidence)).toEqual({
        sourceRows:LARGE_ROWS+3,
        distinctRows:LARGE_ROWS+2,
      });
      expect(compareTimestampEvidence(stage,baseline,finalEvidence)).toEqual({from:LAST,to:LAST});
    } finally {
      dropTimestampEvidence(stage,finalEvidence);
      dropTimestampEvidence(stage,baseline);
    }

    expect(scratchTables(stage)).toEqual([]);
    expect(sourceSummary(active,"outside.jsonl")).toEqual(outsideBefore);
    expect(active.query("SELECT source,bucket,revision FROM analysis_source_revisions").get())
      .toEqual(revisionBefore);
  } finally {
    stage.close(true);active.close(true);
  }
},120000);

test("1000 source identities use constant evidence DDL and retain exact per-source differences",()=>{
  const active=new Database(":memory:"),stage=new Database(":memory:");
  const schema="CREATE TABLE events(home TEXT,path TEXT,ts TEXT,value INTEGER,payload TEXT); CREATE INDEX source ON events(home,path)";
  active.exec(schema);stage.exec(schema);
  const identities=Array.from({length:1000},(_,index)=>({home:"pc",path:`file-${index}`}));
  try{
    for(const db of [active,stage])db.transaction(()=>{
      const insert=db.query("INSERT INTO events VALUES('pc',?,'2026-09-19T12:00:00Z',1,'same')");
      for(const identity of identities)insert.run(identity.path);
    })();
    active.exec("INSERT INTO events VALUES('pc','file-0','2026-01-01T00:00:00.000001Z',9007199254740992,'precise'); INSERT INTO events VALUES('pc','file-1','2026-02-01T00:00:00Z',1,'duplicate'),('pc','file-1','2026-02-01T00:00:00Z',1,'duplicate'); INSERT INTO events VALUES('pc','file-2','2026-03-01T00:00:00Z',1,'moved')");
    stage.exec("INSERT INTO events VALUES('pc','file-0','2026-01-01T00:00:00.000001Z',9007199254740993,'precise'); INSERT INTO events VALUES('pc','file-1','2026-02-01T00:00:00Z',1,'duplicate'); INSERT INTO events VALUES('pc','file-3','2026-04-01T00:00:00Z',1,'moved'); INSERT INTO events VALUES('pc','outside','1900-01-01',1,'excluded')");
    const exec=stage.exec.bind(stage),transaction=stage.transaction.bind(stage);
    let creates=0,drops=0,transactions=0;
    stage.exec=((sql:string)=>{if(/^CREATE TABLE "__tokenatlas_timestamp_/.test(sql))creates++;if(/^DROP TABLE IF EXISTS "__tokenatlas_timestamp_/.test(sql))drops++;return exec(sql);}) as typeof stage.exec;
    stage.transaction=((...args:any[])=>{transactions++;return (transaction as any)(...args);}) as typeof stage.transaction;
    const timestamps:string[]=[];
    const batch=measureTimestampDifferences(active,stage,SPEC,identities,ts=>timestamps.push(ts));
    expect({creates,drops,transactions}).toEqual({creates:2,drops:2,transactions:2});
    expect(batch.size).toBe(1000);expect(scratchTables(stage)).toEqual([]);
    stage.exec=exec;stage.transaction=transaction;
    const referenceTimestamps:string[]=[];
    const reference=new Map(identities.map(identity=>[JSON.stringify([identity.home,identity.path]),measureTimestampDifference(active,stage,SPEC,[identity],ts=>referenceTimestamps.push(ts))]));
    expect(batch).toEqual(reference);expect(timestamps.sort()).toEqual(referenceTimestamps.sort());
    expect(new Set(timestamps)).toEqual(new Set(['2026-01-01T00:00:00.000001Z','2026-02-01T00:00:00Z','2026-03-01T00:00:00Z','2026-04-01T00:00:00Z']));
    expect(()=>measureTimestampDifferences(active,stage,SPEC,identities,()=>{throw new Error('callback failure');})).toThrow('callback failure');
    expect(scratchTables(stage)).toEqual([]);expect(active.inTransaction).toBe(false);
  }finally{stage.close();active.close();}
},30000);
