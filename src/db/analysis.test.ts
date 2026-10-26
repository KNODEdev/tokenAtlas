import { test, expect } from "bun:test";
import { Database } from "./sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAnalysisTracking } from "./analysis";
import { createAnalysisSourceRevisions } from "./analysis-source-revisions.fixture";

function setup(db:Database) {
  db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,in_tok INTEGER)");
  createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
}
/** The change clock of one source bucket ('*' is the whole source), or null when never recorded. */
const revision=(db:Database,source:string,bucket="*")=>
  (db.query("SELECT revision FROM analysis_source_revisions WHERE source=? AND bucket=?").get(source,bucket) as {revision:number}|null)?.revision ?? null;
const revisions=(db:Database)=>db.query("SELECT * FROM analysis_source_revisions ORDER BY source,bucket").all();
const sourceRevisions=(db:Database,source:string)=>
  db.query("SELECT * FROM analysis_source_revisions WHERE source=? ORDER BY bucket").all(source);
const dayClocks=(db:Database)=>(db.query("SELECT COUNT(*) n FROM analysis_source_revisions WHERE bucket<>'*'").get() as {n:number}).n;
const triggerSql=(db:Database,name:string)=>(db.query("SELECT sql FROM sqlite_master WHERE name=?").get(name) as {sql:string}).sql;
/** Frozen former tracking: a clock per stored day besides the whole-table one, optionally with the W6 dirty queue. */
function formerTrigger(db:Database,table:string,operation:"insert"|"update"|"delete",dirtyQueue:boolean):string {
  const columns=(db.query(`PRAGMA table_info("${table}")`).all() as {name:string}[]).map(column=>column.name);
  const bump=(side:string)=>`INSERT INTO analysis_source_revisions(source,bucket,revision)
      VALUES ('${table}',COALESCE(substr(${side}."ts",1,10),''),1)
      ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1;
      INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('${table}','*',1)
      ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1;`;
  const dirty=(side:string)=>dirtyQueue?`INSERT OR IGNORE INTO analysis_attribution_dirty(home,path)
      VALUES (COALESCE(${side}.home,''),COALESCE(${side}.path,''));`:"";
  const when=operation==="update"?`WHEN ${columns.map(c=>`OLD."${c}" IS NOT NEW."${c}"`).join(" OR ")}`:"";
  const side=operation==="insert"?"NEW":"OLD";
  const body=operation==="update"?`${bump("OLD")} ${bump("NEW")} ${dirty("OLD")} ${dirty("NEW")}`:`${bump(side)} ${dirty(side)}`;
  return `CREATE TRIGGER analysis_${table}_${operation} AFTER ${operation.toUpperCase()} ON "${table}" ${when} BEGIN ${body} END`;
}

test("current writer progress leaves the meta clock alone while real meta changes advance it", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)");
  setup(db);
  try {
    const initial = revision(db, "meta")!;
    for (let i = 0; i < 8; i++) db.query("INSERT INTO meta(key,value) VALUES('current_v2_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(i));
    expect(revision(db, "meta")).toBe(initial);
    installAnalysisTracking(db);
    expect(revision(db, "meta")).toBe(initial);
    db.query("INSERT INTO meta(key,value) VALUES('account_periods_revision','1')").run();
    const inserted = revision(db, "meta")!;
    expect(inserted).toBeGreaterThan(initial);
    db.query("UPDATE meta SET value='2' WHERE key='account_periods_revision'").run();
    expect(revision(db, "meta")!).toBeGreaterThan(inserted);
  } finally { db.close(); }
});

test("unrelated schema changes and restart keep the change clocks while corrections still advance them",()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-analysis-ddl-")),file=path.join(dir,"data.sqlite");
  let db=new Database(file);setup(db);
  try {
    db.exec("INSERT INTO events VALUES(1,'pc','session','2025-01-04',12)");
    const saved=revisions(db);
    db.exec("CREATE INDEX events_tokens ON events(in_tok); CREATE TABLE unrelated_settings(label TEXT)");
    installAnalysisTracking(db);
    db.close();db=new Database(file);installAnalysisTracking(db);
    expect(revisions(db)).toEqual(saved);
    db.exec("UPDATE events SET in_tok=in_tok");
    expect(revisions(db)).toEqual(saved);
    const events=revision(db,"events")!;
    db.exec("UPDATE events SET in_tok=20");
    expect(revision(db,"events")).toBe(events+1);
  } finally {db.close();Bun.gc(true);fs.rmSync(dir,{recursive:true,force:true});}
});

test("recreated source tracking advances the replaced source's clock without touching other sources",()=> {
  const db=new Database(":memory:");setup(db);
  db.exec("CREATE TABLE probe_windows(ts TEXT,used_percent REAL); INSERT INTO probe_windows VALUES('2025-01-04',20)");
  installAnalysisTracking(db);
  try {
    db.exec("INSERT INTO events VALUES(1,'pc','session','2025-01-04',12)");
    const events=revision(db,"events")!, probe=sourceRevisions(db,"probe_windows");
    db.exec("DROP TABLE events; CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,in_tok INTEGER); INSERT INTO events VALUES(1,'pc','session','2025-01-05',25)");
    installAnalysisTracking(db);
    expect(revision(db,"events")!).toBeGreaterThan(events);
    expect(sourceRevisions(db,"probe_windows")).toEqual(probe);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'analysis_events_%' ORDER BY name").all())
      .toEqual([{name:"analysis_events_delete"},{name:"analysis_events_insert"},{name:"analysis_events_update"}]);
    const reinstalled=revision(db,"events")!;
    db.exec("UPDATE events SET in_tok=30");
    expect(revision(db,"events")).toBe(reinstalled+1);
    expect(dayClocks(db)).toBe(0);
  } finally {db.close();}
});

test("the exact former dirty-queue trigger is replaced without invalidating its source, then the queue is dropped",()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-w6-tracking-")),file=path.join(dir,"data.sqlite");
  let db=new Database(file);setup(db);
  try {
    db.exec("INSERT INTO events VALUES(1,'pc','session','2025-01-04',12)");
    // An older database carries this side effect until W9 tracking replaces it.
    db.exec("CREATE TABLE analysis_attribution_dirty(home TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(home,path))");
    const canonical=new Map<string,string>();
    for(const operation of ["insert","update","delete"] as const) {
      const name=`analysis_events_${operation}`;
      canonical.set(name,triggerSql(db,name));
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(formerTrigger(db,"events",operation,true));
    }
    const saved=revisions(db);
    db.close();db=new Database(file);
    installAnalysisTracking(db);
    expect(revisions(db)).toEqual(saved);
    for(const [name,current] of canonical)expect(triggerSql(db,name)).toBe(current);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='analysis_attribution_dirty'").get()).toBeNull();
    const events=revision(db,"events")!;
    db.exec("UPDATE events SET in_tok=20 WHERE id=1");
    expect(revision(db,"events")).toBe(events+1);
    expect(dayClocks(db)).toBe(0);
  } finally {db.close();Bun.gc(true);fs.rmSync(dir,{recursive:true,force:true});}
});

test("incomplete old tracking advances its source's clock without touching unrelated sources",()=> {
  const db=new Database(":memory:");setup(db);
  try {
    db.exec("CREATE TABLE probe_windows(ts TEXT,used_percent REAL); INSERT INTO probe_windows VALUES('2025-01-04',20)");
    installAnalysisTracking(db);
    db.exec("INSERT INTO events VALUES(1,'pc','session','2025-01-04',12)");
    const current=(db.query("SELECT sql FROM sqlite_master WHERE name='analysis_events_update'").get() as {sql:string}).sql;
    db.exec("DROP TRIGGER analysis_events_update");
    db.exec(current.replace(/WHEN .*? BEGIN/,"WHEN OLD.ts IS NOT NEW.ts BEGIN"));
    const events=revision(db,"events")!, probe=sourceRevisions(db,"probe_windows");
    // The incomplete predicate misses this correction.
    db.exec("UPDATE events SET in_tok=20");
    expect(revision(db,"events")).toBe(events);
    installAnalysisTracking(db);
    expect(revision(db,"events")!).toBeGreaterThan(events);
    expect(sourceRevisions(db,"probe_windows")).toEqual(probe);
    expect((db.query("SELECT sql FROM sqlite_master WHERE name='analysis_events_update'").get() as {sql:string}).sql).toBe(current);
  } finally {db.close();}
});

test("tracking installation never recreates removed owner tables or the dirty queue", () => {
  const db = new Database(":memory:"); setup(db);
  try {
    db.exec(`CREATE TABLE rollout_owner(home TEXT, path TEXT, account TEXT);
      CREATE TABLE ratelimit_owner(ratelimit_rowid INTEGER, account TEXT);
      CREATE TRIGGER analysis_rollout_owner_insert AFTER INSERT ON rollout_owner BEGIN
        INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('rollout_owner','*',1); END;`);
    db.exec("DROP TABLE rollout_owner; DROP TABLE ratelimit_owner");
    installAnalysisTracking(db);
    expect(db.query(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name IN ('analysis_rollout_owner_insert')`).all()).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rollout_owner','ratelimit_owner','analysis_attribution_dirty')").all()).toEqual([]);
    db.exec("INSERT INTO events VALUES (1,'home','path','2025-01-04',12)");
    expect(db.query("SELECT COUNT(*) n FROM analysis_source_revisions WHERE source='events' AND bucket='*'").get()).toEqual({n:1});
  } finally { db.close(); }
});

test("former per-day tracking is replaced without invalidating its source and its day clocks stop growing",()=> {
  const db=new Database(":memory:");setup(db);
  try {
    const canonical=new Map<string,string>();
    for(const operation of ["insert","update","delete"] as const) {
      const name=`analysis_events_${operation}`;
      canonical.set(name,triggerSql(db,name));
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(formerTrigger(db,"events",operation,false));
    }
    db.exec("INSERT INTO events VALUES(1,'pc','session','2025-01-04',12)");
    expect(revision(db,"events","2025-01-04")).toBe(1);
    const saved=revisions(db);
    installAnalysisTracking(db);
    expect(revisions(db)).toEqual(saved);
    for(const [name,current] of canonical)expect(triggerSql(db,name)).toBe(current);
    db.exec("UPDATE events SET in_tok=20");
    expect(revision(db,"events","2025-01-04")).toBe(1);
  } finally {db.close();}
});

test("installation registers only the whole-table clock, without a clock per stored day",()=> {
  const db=new Database(":memory:");
  try {
    db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,in_tok INTEGER)");
    db.exec("INSERT INTO events VALUES(1,'pc','a','2025-01-04',1),(2,'pc','b','2025-01-05',2)");
    createAnalysisSourceRevisions(db);
    installAnalysisTracking(db);
    expect(sourceRevisions(db,"events")).toEqual([{source:"events",bucket:"*",revision:1}]);
  } finally {db.close();}
});

test("the whole-table clock follows historical inserts, corrections, deletions and transaction rollback",()=> {
  const db=new Database(":memory:"); setup(db);
  try {
    const clock=()=>revision(db,"events");
    const empty=clock()!;
    db.exec("INSERT INTO events VALUES(1,'pc2','old','2025-01-04T12:00:00Z',12)");
    expect(clock()).toBe(empty+1);
    db.exec("UPDATE events SET in_tok=in_tok WHERE id=1");
    expect(clock()).toBe(empty+1);
    db.exec("UPDATE events SET ts='2025-02-09T12:00:00Z',in_tok=20 WHERE id=1");
    expect(clock()).toBe(empty+2);
    expect(()=>db.transaction(()=>{db.exec("DELETE FROM events");throw Error("interrupted");})()).toThrow("interrupted");
    expect(clock()).toBe(empty+2);
    db.exec("DELETE FROM events");
    expect(clock()).toBe(empty+3);
    expect(dayClocks(db)).toBe(0);
  } finally {db.close();}
});
