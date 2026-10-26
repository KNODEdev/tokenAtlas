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
function databases(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-reparse-range-"));directories.push(directory);
  const active=new Database(path.join(directory,"active.sqlite"),{create:true});
  const stage=new Database(path.join(directory,"stage.sqlite"),{create:true});
  for(const db of [active,stage])db.exec(`CREATE TABLE claude_events(
    id INTEGER PRIMARY KEY,store TEXT NOT NULL,path TEXT NOT NULL,call_id TEXT NOT NULL,
    ts TEXT,in_uncached INTEGER NOT NULL,UNIQUE(store,call_id));
    CREATE TABLE claude_files(store TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL DEFAULT -1,
      mtime REAL NOT NULL DEFAULT -1,calls INTEGER NOT NULL DEFAULT 0,parser_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(store,path));`);
  return {active,stage};
}
const spec:ReparseSpec={identity:["store","path"],bookmarkTable:"claude_files"};

test("ranged EXCEPT comparisons use the source path index rather than scanning the store in call order",()=>{
  const {active,stage}=databases();
  for(const db of [active,stage])db.exec(`CREATE INDEX claude_events_store_path_idx ON claude_events(store,path);
    INSERT INTO claude_events(store,path,call_id,ts,in_uncached) VALUES('live','source.jsonl','call','2026-09-09T12:00:00Z',10)`);
  const original=active.query.bind(active),plans:string[]=[];
  active.query=((sql:string)=>{
    if(sql.includes(" EXCEPT ")) {
      using explain=active.prepare(`EXPLAIN QUERY PLAN ${sql}`);
      const rows=explain.all("live","source.jsonl","live","source.jsonl") as Array<{detail:string}>;
      plans.push(...rows.filter(row=>row.detail.startsWith("SEARCH r USING INDEX")).map(row=>row.detail));
    }
    return original(sql);
  }) as typeof active.query;
  try {
    preserveReparseOutsideRange(active,stage,spec,["claude_events"],[{store:"live",path:"source.jsonl"}],{
      identities:[],sources:[],unavailable:[],protectedBookmarks:[],partialIdentities:new Set(),
      bounds:{from:"2026-09-09T00:00:00Z",untilExclusive:"2026-09-10T00:00:00Z",candidateFrom:"2026-09-09",candidateUntil:"2026-09-10"},
    });
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every(detail=>detail.includes("store=? AND path=?"))).toBe(true);
  }finally{stage.close(true);active.close(true);}
});

test("bounded discovery finds a source without a bookmark using UTC membership and ignores unrelated malformed timestamps",()=>{
  const {active,stage}=databases();
  try{
    active.exec(`INSERT INTO claude_events(store,path,call_id,ts,in_uncached) VALUES
      ('live','source.jsonl','offset','2026-09-08T23:30:00-01:00',1),
      ('live','broken.jsonl','broken','not-a-timestamp',2)`);
    const plan=prepareReparse(active,stage,spec,["claude_events"],
      {from:"2026-09-09",until:"2026-09-10"},()=>true);
    expect(plan.identities).toEqual([{store:"live",path:"source.jsonl"}]);
    expect(plan.sources).toEqual([{store:"live",path:"source.jsonl"}]);
    expect(plan.bounds).toMatchObject({
      from:"2026-09-09T00:00:00.000Z",untilExclusive:"2026-09-11T00:00:00.000Z",
    });
  }finally{stage.close(true);active.close(true);}
});

test("SQLite-side ranged reconciliation is idempotent, preserves int64 outside facts and publishes deletes, additions and boundary moves",()=>{
  const {active,stage}=databases();
  try{
    active.exec(`INSERT INTO claude_events(store,path,call_id,ts,in_uncached) VALUES
      ('live','source.jsonl','before','2026-09-08T23:59:59.999999Z',999),
      ('live','source.jsonl','start','2026-09-09T00:00:00.000000Z',999),
      ('live','source.jsonl','end','2026-09-10T23:59:59.999500Z',999),
      ('live','source.jsonl','after','2026-09-11T00:00:00.000000Z',999),
      ('live','source.jsonl','move-out','2026-09-09T12:00:00Z',41),
      ('live','source.jsonl','move-in','2026-09-08T12:00:00Z',51),
      ('live','source.jsonl','deleted','2026-09-10T12:00:00Z',61),
      ('live','source.jsonl','malformed','not-a-timestamp',61),
      ('live','source.jsonl','big','2026-09-08T10:00:00Z',9007199254740993)`);
    stage.exec(`INSERT INTO claude_events(store,path,call_id,ts,in_uncached) VALUES
      ('live','source.jsonl','before','2026-09-08T23:59:59.999999Z',7),
      ('live','source.jsonl','start','2026-09-09T00:00:00.000000Z',11),
      ('live','source.jsonl','end','2026-09-10T23:59:59.999500Z',13),
      ('live','source.jsonl','after','2026-09-11T00:00:00.000000Z',17),
      ('live','source.jsonl','move-out','2026-09-11T12:00:00Z',42),
      ('live','source.jsonl','move-in','2026-09-10T12:00:00Z',52),
      ('live','source.jsonl','malformed','also-not-a-timestamp',6),
      ('live','source.jsonl','big','2026-09-08T10:00:00Z',1),
      ('live','source.jsonl','new-inside','2026-09-09T08:00:00Z',71),
      ('live','source.jsonl','new-outside','2026-09-12T08:00:00Z',81)`);
    const plan:ReparsePlan={
      identities:[],sources:[],unavailable:[],protectedBookmarks:[],partialIdentities:new Set(),
      bounds:{from:"2026-09-09T00:00:00.000Z",untilExclusive:"2026-09-11T00:00:00.000Z",
        candidateFrom:"2026-09-08",candidateUntil:"2026-09-12"},
    };
    let identities=preserveReparseOutsideRange(active,stage,spec,["claude_events"],
      [{store:"live",path:"source.jsonl"}],plan);
    const first=stage.query(`SELECT call_id,ts,CAST(in_uncached AS TEXT) AS tokens
      FROM claude_events ORDER BY call_id`).all();
    expect(first).toEqual([
      {call_id:"after",ts:"2026-09-11T00:00:00.000000Z",tokens:"999"},
      {call_id:"before",ts:"2026-09-08T23:59:59.999999Z",tokens:"999"},
      {call_id:"big",ts:"2026-09-08T10:00:00Z",tokens:"9007199254740993"},
      {call_id:"end",ts:"2026-09-10T23:59:59.999500Z",tokens:"13"},
      {call_id:"malformed",ts:"not-a-timestamp",tokens:"61"},
      {call_id:"move-in",ts:"2026-09-10T12:00:00Z",tokens:"52"},
      {call_id:"move-out",ts:"2026-09-11T12:00:00Z",tokens:"42"},
      {call_id:"new-inside",ts:"2026-09-09T08:00:00Z",tokens:"71"},
      {call_id:"start",ts:"2026-09-09T00:00:00.000000Z",tokens:"11"},
    ]);
    expect(plan.partialIdentities.has(JSON.stringify(["live","source.jsonl"]))).toBe(true);
    identities=preserveReparseOutsideRange(active,stage,spec,["claude_events"],identities,plan);
    expect(stage.query(`SELECT call_id,ts,CAST(in_uncached AS TEXT) AS tokens
      FROM claude_events ORDER BY call_id`).all()).toEqual(first);
    expect(identities).toEqual([{store:"live",path:"source.jsonl"}]);
  }finally{stage.close(true);active.close(true);}
});
