import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { prepareGlobalFixture } from "./global-usage.fixture";
import { loadAccountResolver } from "./account-resolver";
import { codexFixturePeriods } from "./codex-v8.fixture";
import { test,expect } from "bun:test";
import { Database } from "../db/sqlite";
import { installAnalysisTracking } from "../db/analysis";
import { buildCodexAccountingReport as readCodexReport } from "./codex-accounting";
import { buildGlobalUsage as readGlobalUsage } from "./global-usage";
import { buildEraIndex } from "./eras";
import type { RateCard } from "./pricing";
import { prepareProbeReaderFixture, splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

const card:RateCard={version:2,currency:"USD",unit:"per 1M",vendors:{}};
const options={since:"2026-09-08",until:"2026-09-09",account:"seat"};
const homes=new Map([["/archive","seat"],["/pc/.codex","seat"]]);
const eras=buildEraIndex([{id:"seat",vendor:"codex",home:"/archive",source_home:"/pc/.codex"}]);
const sources=["/archive","/pc/.codex"].map(source_home=>({id:"seat",vendor:"codex",home:`${ARCHIVE_LOGICAL_ROOT}/codex/fixture`,source_home}));
function buildCodexAccountingReport(...args:Parameters<typeof readCodexReport>) {
  enable(args[0],args[1]);
  // The maintenance worker brings window sums up to date between writes and reads.
  prepareWindowUsageFixture(args[0],{rateCards:args[1]});
  args[9]=loadAccountResolver(args[0]);args[10]=sources;
  return readCodexReport(...args);
}
function buildGlobalUsage(ctx:Parameters<typeof readGlobalUsage>[0],range:Parameters<typeof readGlobalUsage>[1]) {
  enable(ctx.sqlite,ctx.rateCards);
  return readGlobalUsage({...ctx,accounts:splitProbeReaderFixtureConfig(sources)},range);
}
function fixture() {
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,model TEXT,speed TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,project_id TEXT,source_offset INTEGER);
    CREATE TABLE probe_windows(provider TEXT,limit_group TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,
      used_percent REAL,resets_at TEXT,window_minutes INTEGER,ok INTEGER);
    INSERT INTO probe_windows VALUES
      ('codex','codex','seat','2026-09-08T00:00:00Z','weekly','pro',0,'2026-09-15T00:00:00Z',10080,1),
      ('codex','codex','seat','2026-09-09T23:00:00Z','weekly','pro',30,'2026-09-15T00:00:00Z',10080,1);`);
  const put=db.query("INSERT INTO events(home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,project_id,source_offset) VALUES(?,?,?,'gpt-6-astra','fast',100000,80000,0,10000,'project',?)");
  // One conversation in two folders: the local profile holds its first two calls (a prefix, same byte
  // offsets); the archive copy holds all three. Copies are resolved per call when the ledger is built.
  for(const [home,day,hour,offset] of [["/archive","08","01",0],["/pc/.codex","08","01",0],["/pc/.codex","09","01",100],
    ["/archive","09","01",100],["/archive","09","02",200]] as const) {
    put.run(home,home+"/sessions/a.jsonl",`2026-09-${day}T${hour}:00:00Z`,offset);
  }
  codexFixturePeriods(db,"seat");
  return db;
}
function enable(db:Database,rates=card) {
  createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
  prepareGlobalFixture(db,rates,sources);
  prepareProbeReaderFixture(db,sources);
}
function rawCopy(db:Database) {
  const copy=Database.deserialize(db.serialize());
  const triggers=copy.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'analysis_%'").all() as {name:string}[];
  for(const {name} of triggers)copy.exec(`DROP TRIGGER "${name}"`);
  for(const table of ["analysis_requests","analysis_attribution_dirty","analysis_results","analysis_source_revisions"])copy.exec(`DROP TABLE IF EXISTS "${table}"`);
  const tables=copy.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'usage_price_%'").all() as {name:string}[];
  for(const {name} of tables)copy.exec(`DROP TABLE "${name}"`);
  return copy;
}
function report(db:Database) {return JSON.parse(JSON.stringify(buildCodexAccountingReport(db,card,options,homes,eras)));}
function expectSame(actual:unknown,expected:unknown) {
  const normalize=(value:any):any=>typeof value==="number" ? Math.round(value*1e8)/1e8
    : Array.isArray(value)?value.map(normalize):value && typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalize(item)])):value;
  expect(normalize(actual)).toEqual(normalize(expected));
}

test("durable days preserve the canonical copy, full cycle and missing values",()=> {
  const db=fixture();
  try {
    const original=report(db);expect(original.events).toBe(3);enable(db);
    expectSame(report(db),original);
    const summary=buildGlobalUsage({sqlite:db,rateCards:card,homeToSubId:homes,eras},options);
    expect(summary.rows.reduce((n,row)=>n+row.calls,0)).toBe(3);
    expect(db.query("SELECT COUNT(DISTINCT day) n FROM codex_price_ledger_aggregates WHERE grain='day'").get()).toEqual({n:2});
  } finally {db.close();}
});

test("late arrivals, a changed copy winner, moved dates, deletes and pricing edits match fresh calculations",()=> {
  const db=fixture();enable(db);
  try {
    report(db);
    for(const mutation of [
      "INSERT INTO events(id,home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,project_id,service_tier) SELECT 6,home,path,'2026-09-08T03:00:00Z',model,speed,in_tok,cached_in,cache_write,out_tok,project_id,service_tier FROM events WHERE id=2",
      "INSERT INTO events(id,home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,project_id,service_tier) SELECT 7,home,path,'2026-09-08T04:00:00Z',model,speed,in_tok,cached_in,cache_write,out_tok,project_id,service_tier FROM events WHERE id=2",
      "UPDATE events SET ts='2026-09-09T12:00:00Z',in_tok=200000 WHERE id=6",
      "DELETE FROM events WHERE id=7",
      "UPDATE events SET speed='unknown',service_tier=NULL WHERE id=6",
    ]) {
      db.exec(mutation);
      const raw=rawCopy(db);
      try {expectSame(report(db),report(raw));}finally{raw.close();}
    }
    const revised={...card,codex_accounting:{version:1 as const,rules:[]}};
    const changed=buildCodexAccountingReport(db,revised,options,homes,eras);
    expect(changed.amounts.api_equivalent_usd.value).toBeNull();
    expect(changed.tokens).toBe(report(db).tokens);
  } finally {db.close();}
});

test("a new probe reuses completed day valuations and only changes its meter calculation",()=> {
  const db=fixture();enable(db);
  try {
    report(db);
    const before=db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    buildGlobalUsage({sqlite:db,rateCards:card,homeToSubId:homes,eras},options);
    const valued=db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    expect(before).toEqual(valued);expect(valued.length).toBeGreaterThan(0);
    db.exec("UPDATE probe_windows SET used_percent=40 WHERE used_percent=30");
    const raw=rawCopy(db);try{expectSame(report(db),report(raw));}finally{raw.close();}
    buildGlobalUsage({sqlite:db,rateCards:card,homeToSubId:homes,eras},options);
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(valued);
  } finally {db.close();}
});

test("one canonical price register is reused across account, counter and date selections",()=>{
  const db=fixture();enable(db);
  const saved=()=>db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all() as Array<Record<string, unknown>>;
  try {
    report(db);const initial=saved();expect(initial).toHaveLength(5);
    buildGlobalUsage({sqlite:db,rateCards:card,homeToSubId:homes,eras},options);
    buildCodexAccountingReport(db,card,{...options,account:undefined,window_minutes:300},homes,eras);
    buildCodexAccountingReport(db,card,{...options,since:"2026-09-09"},homes,eras);
    expect(saved()).toEqual(initial);
    // A late call keeps prior valuations, identities and copy states; it changes its successor's activity gap.
    db.exec("INSERT INTO events(id,home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,project_id,source_offset) SELECT 6,home,path,'2026-09-08T03:00:00Z',model,speed,in_tok,cached_in,cache_write,out_tok,project_id,300 FROM events WHERE id=1");
    report(db);const after=saved();expect(after).toHaveLength(6);
    const withoutActivity = ({ gap_ms: _gap, gap_from_ms: _from, ...row }: Record<string, unknown>) => row;
    expect(after.filter(row=>initial.some(prior=>prior.id===row.id)).map(withoutActivity)).toEqual(initial.map(withoutActivity));
    const successor = initial.find(row=>row.copy_state==="canonical" && row.source_offset===100)!;
    expect(successor).toMatchObject({ gap_ms: 24*60*60*1000, gap_from_ms: Date.parse("2026-09-08T01:00:00Z") });
    const updated = after.find(row=>row.id===successor.id)!;
    expect(updated).toMatchObject({ gap_ms: 22*60*60*1000, gap_from_ms: Date.parse("2026-09-08T03:00:00Z") });
    expect(after.filter(row=>row.id!==successor.id && initial.some(prior=>prior.id===row.id)))
      .toEqual(initial.filter(row=>row.id!==successor.id));
    expect(after.find(row=>row.source_offset===300)).toMatchObject({
      gap_ms: 2*60*60*1000, gap_from_ms: Date.parse("2026-09-08T01:00:00Z"), copy_state: "canonical",
    });
    const raw=rawCopy(db);try{expectSame(report(db),report(raw));}finally{raw.close();}
  }finally{db.close();}
});

test("extending a live traffic period keeps earlier day valuations and closed cycles",()=> {
  const db=fixture();enable(db);
  try {
    report(db);
    const rows=()=>db.query("SELECT day AS key,day,json_object('day',day,'calls',SUM(calls),'tokens',SUM(reported),'api_whole_hi',SUM(api_whole_hi),'api_whole_lo',SUM(api_whole_lo)) AS data FROM codex_price_ledger_aggregates WHERE grain='day' GROUP BY day ORDER BY day").all() as {key:string;data:string}[];
    const earlier=rows().filter(row=>JSON.parse(row.data).day==='2026-09-08');
    expect(earlier).toHaveLength(1);
    for (const ts of ['2026-09-09T23:10:00Z','2026-09-09T23:20:00Z']) {
      db.query("UPDATE probe_windows SET ts=? WHERE used_percent=30").run(ts);
      const raw=rawCopy(db);try{expectSame(report(db),report(raw));}finally{raw.close();}
      expect(rows().filter(row=>earlier.some(saved=>saved.key===row.key))).toEqual(earlier);
    }
  } finally {db.close();}
});

test("global daily projections reject conflicting provider identities across days without losing other usage",()=> {
  const db=fixture();
  db.exec(`CREATE TABLE claude_events(id INTEGER PRIMARY KEY,store TEXT,call_id TEXT,ts TEXT,subscription_id TEXT,
    model TEXT,speed TEXT,in_uncached INTEGER,in_cache_read INTEGER,in_cache_write INTEGER,cache_write_5m INTEGER,cache_write_1h INTEGER,out_total INTEGER);
    INSERT INTO claude_events VALUES(1,'pc1','same','2026-09-08T01:00:00Z','claude','test','standard',100,0,0,0,0,10),
      (2,'pc1','keep','2026-09-08T02:00:00Z','claude','test','standard',50,0,0,0,0,5);`);
  enable(db);
  const run=(sqlite:Database)=>buildGlobalUsage({sqlite,rateCards:card,homeToSubId:homes,eras},options);
  try {
    run(db);
    for(const sql of [
      "INSERT INTO claude_events SELECT 3,'pc2',call_id,'2026-09-09T01:00:00Z',subscription_id,model,speed,in_uncached,in_cache_read,in_cache_write,cache_write_5m,cache_write_1h,out_total FROM claude_events WHERE id=1",
      "INSERT INTO claude_events SELECT 4,'pc3',call_id,ts,subscription_id,model,speed,200,in_cache_read,in_cache_write,cache_write_5m,cache_write_1h,out_total FROM claude_events WHERE id=3",
      "DELETE FROM claude_events WHERE id IN (3,4)",
    ]) {
      db.exec(sql);const raw=rawCopy(db);
      try {expectSame(run(db),run(raw));}finally{raw.close();}
    }
  } finally {db.close();}
});


test("project ownership and Capacity scopes match a fresh calculation", () => {
  const db=fixture();enable(db);
  try {
    const global={...options,account:undefined};
    buildCodexAccountingReport(db,card,global,homes,eras);
    const raw=rawCopy(db);
    try {expectSame(buildCodexAccountingReport(db,card,global,homes,undefined,false),buildCodexAccountingReport(raw,card,global,homes,undefined,false));}
    finally {raw.close();}
  } finally {db.close();}
});
