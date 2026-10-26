import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import {
  preserveReparseOutsideRange,
  type ReparseBounds,
  type ReparseIdentity,
  type ReparsePlan,
  type ReparseSelection,
  type ReparseSpec,
} from "./reparse";

const temporary:string[]=[];
afterEach(()=>{
  Bun.gc(true);
  for(const directory of temporary.splice(0))
    removeTestFixture(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});

const spec:ReparseSpec={identity:["source"],bookmarkTable:null};
const identity:ReparseIdentity={source:"same-file"};

function fixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"tokenatlas-account-reparse-"));
  temporary.push(directory);
  const active=new Database(path.join(directory,"active.sqlite"),{create:true});
  const stage=new Database(path.join(directory,"stage.sqlite"),{create:true});
  for(const database of [active,stage])database.exec(`CREATE TABLE facts(
    source TEXT NOT NULL,
    row_key TEXT NOT NULL,
    ts TEXT,
    owner TEXT,
    value INTEGER NOT NULL,
    PRIMARY KEY(source,row_key)
  )`);
  return {active,stage};
}

function databaseName(database:string):string {
  return database==="main"?"main":`"${database.replaceAll('"','""')}"`;
}

function accountSelection(active:Database):ReparseSelection {
  return {
    predicate:(_database,_table,alias)=>({sql:`${alias}."owner"=?`,params:["A"]}),
    assertKnown:(database,table,alias,current)=>{
      const unknown=active.query(`SELECT 1 FROM ${databaseName(database)}."${table}" ${alias}
        WHERE ${alias}."source"=? AND ${alias}."owner" IS NULL LIMIT 1`).get(current.source!);
      if(unknown)throw new Error(`Unknown semantic owner in ${table}`);
    },
  };
}

function plan(active:Database,bounds?:ReparseBounds):ReparsePlan {
  return {
    identities:[identity],
    sources:[],
    unavailable:[],
    protectedBookmarks:[],
    bounds,
    selection:accountSelection(active),
    partialIdentities:new Set(),
  };
}

function insert(database:Database,rowKey:string,ts:string|null,owner:string,value:number):void {
  database.query("INSERT INTO facts(source,row_key,ts,owner,value) VALUES('same-file',?,?,?,?)")
    .run(rowKey,ts,owner,value);
}

function rows(database:Database) {
  return database.query(`SELECT row_key,ts,owner,CAST(value AS TEXT) AS value
    FROM facts ORDER BY row_key`).all();
}

test("same-file account update publishes A while unchanged B remains accepted",()=>{
  const {active,stage}=fixture();
  try {
    insert(active,"a","2026-01-10T10:00:00.000Z","A",1);
    insert(active,"b","2026-01-10T11:00:00.000Z","B",2);
    insert(stage,"a","2026-01-10T10:00:00.000Z","A",10);
    insert(stage,"b","2026-01-10T11:00:00.000Z","B",2);
    const selected=plan(active);

    expect(preserveReparseOutsideRange(active,stage,spec,["facts"],[identity],selected))
      .toEqual([identity]);
    expect(rows(stage)).toEqual([
      {row_key:"a",ts:"2026-01-10T10:00:00.000Z",owner:"A",value:"10"},
      {row_key:"b",ts:"2026-01-10T11:00:00.000Z",owner:"B",value:"2"},
    ]);
    expect(selected.partialIdentities.size).toBe(0);
  } finally { active.close(true);stage.close(true); }
});

test("account repair refuses a selected correction combined with a different unselected remainder",()=>{
  const {active,stage}=fixture();
  try {
    insert(active,"a","2026-01-10T10:00:00.000Z","A",1);
    insert(active,"b","2026-01-10T11:00:00.000Z","B",2);
    insert(stage,"a","2026-01-10T10:00:00.000Z","A",10);
    insert(stage,"b","2026-01-10T11:00:00.000Z","B",20);
    const accepted=rows(active),staged=rows(stage);

    expect(()=>preserveReparseOutsideRange(active,stage,spec,["facts"],[identity],plan(active)))
      .toThrow("hybrid source identity");
    expect(rows(active)).toEqual(accepted);
    expect(rows(stage)).toEqual(staged);
  } finally { active.close(true);stage.close(true); }
});

test("unchanged selected account restores changed B, drops new unselected context and preserves int64",()=>{
  const {active,stage}=fixture();
  try {
    insert(active,"a","2026-01-10T10:00:00.000Z","A",1);
    active.exec(`INSERT INTO facts VALUES('same-file','b','2026-01-10T11:00:00.000Z','B',9007199254740993)`);
    insert(stage,"a","2026-01-10T10:00:00.000Z","A",1);
    insert(stage,"b","2026-01-10T11:00:00.000Z","B",20);
    insert(stage,"new-context",null,"B",30);
    const selected=plan(active);

    preserveReparseOutsideRange(active,stage,spec,["facts"],[identity],selected);
    expect(rows(stage)).toEqual([
      {row_key:"a",ts:"2026-01-10T10:00:00.000Z",owner:"A",value:"1"},
      {row_key:"b",ts:"2026-01-10T11:00:00.000Z",owner:"B",value:"9007199254740993"},
    ]);
    expect(selected.partialIdentities).toEqual(new Set([JSON.stringify(["same-file"])]));
  } finally { active.close(true);stage.close(true); }
});

test("range and account selection follows semantic keys across owner and date moves on both sides",()=>{
  const {active,stage}=fixture();
  const bounds:ReparseBounds={
    from:"2026-01-01T00:00:00.000Z",
    untilExclusive:"2026-02-01T00:00:00.000Z",
    candidateFrom:"2025-12-31",
    candidateUntil:"2026-02-02",
  };
  try {
    insert(active,"move-out","2026-01-10T10:00:00.000Z","A",1);
    insert(active,"move-in","2026-02-10T10:00:00.000Z","B",2);
    insert(active,"stable-b","2026-01-15T10:00:00.000Z","B",3);
    insert(stage,"move-out","2026-02-10T10:00:00.000Z","B",10);
    insert(stage,"move-in","2026-01-10T10:00:00.000Z","A",20);
    insert(stage,"stable-b","2026-01-15T10:00:00.000Z","B",3);

    preserveReparseOutsideRange(active,stage,spec,["facts"],[identity],plan(active,bounds));
    expect(rows(stage)).toEqual([
      {row_key:"move-in",ts:"2026-01-10T10:00:00.000Z",owner:"A",value:"20"},
      {row_key:"move-out",ts:"2026-02-10T10:00:00.000Z",owner:"B",value:"10"},
      {row_key:"stable-b",ts:"2026-01-15T10:00:00.000Z",owner:"B",value:"3"},
    ]);
  } finally { active.close(true);stage.close(true); }
});
