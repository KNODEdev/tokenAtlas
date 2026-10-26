import {test,expect} from "bun:test";
import {Database} from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createDataRead} from "./data-read";
import {buildEraIndex} from "./eras";
import {createFetchHandler, type AppContext} from "./api";
import * as api from "./api";
import {installAnalysisTracking} from "../db/analysis";
import {DATA_VIEWS,DIRECT_DATA_ROUTES} from "./data-views";
import {prepareCodexLedgerFixture} from "./codex-ledger.fixture";
import {prepareProbeReaderFixture} from "./probe-reader.fixture";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";
function fixture(){
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,ts TEXT,home TEXT,path TEXT,model TEXT,in_tok INTEGER);
    CREATE INDEX events_ts ON events(ts);
    INSERT INTO events VALUES(1,'2025-01-01T12:00:00Z','pc1','a','m',10),(2,'2025-01-02T12:00:00Z','pc2','b','m',20);
    CREATE TABLE ratelimit(id INTEGER PRIMARY KEY,ts TEXT,home TEXT,path TEXT);`);
  createAnalysisSourceRevisions(db);
  db.exec(fs.readFileSync(new URL("../../drizzle/0040_account_periods.sql",import.meta.url),"utf8")
    .replaceAll("--> statement-breakpoint", ""));
  installAnalysisTracking(db);return db;
}
async function ready(read:()=>Promise<Response>) {
  for(let attempt=0;attempt<500;attempt++) {
    const response=await read();
    if(response.status!==202 && response.headers.get("X-Analysis")!=="stale")return response;
    await Bun.sleep(10);
  }
  throw new Error("Preparation did not finish");
}
test("analytical handlers in the router require a central data declaration",()=>{
  const analytical=["Summary","Breakdown","Compare","Cache","Leverage","AccountHistory","Activity","Projects","ProjectsRows","RepoHistory",
    "Accounts","CycleBreakdown","ClaudeLimit","Gauge","PlanHealth","PlanCapacity"];
  for(const name of analytical){
    expect(typeof api[`handle${name}` as keyof typeof api]).toBe("function");
    expect(Object.values(DATA_VIEWS).some(view=>view.build.name===`handle${name}`)).toBe(true);
  }
  // Screens that read stored rows bypass report preparation and are declared as such.
  for(const route of ["/api/usage-series","/api/windows","/api/roster"]){
    expect(DATA_VIEWS[route]).toBeUndefined();
    expect(DIRECT_DATA_ROUTES[route]).toContain("stored rows");
  }
  // Codex accounting still reads call evidence of its range: it is computed off the HTTP thread.
  expect(DATA_VIEWS["/api/codex-accounting"]?.direct).toBeUndefined();
  expect(DIRECT_DATA_ROUTES["/api/codex-accounting"]).toBeUndefined();
  for(const view of Object.values(DATA_VIEWS))expect(view.sources.length).toBeGreaterThan(0);
});

test("an exception view is computed off the HTTP thread, kept in memory by data version and never persisted",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-central-worker-")),file=path.join(dir,"data.sqlite");
  const initial=fixture();
  initial.exec(`ALTER TABLE events ADD COLUMN cached_in INTEGER DEFAULT 0;
    ALTER TABLE events ADD COLUMN cache_write INTEGER DEFAULT 0;
    ALTER TABLE events ADD COLUMN out_tok INTEGER DEFAULT 0;
    ALTER TABLE events ADD COLUMN reasoning_out INTEGER DEFAULT 0;
    CREATE TABLE sync_revisions(id INTEGER PRIMARY KEY,data_revision INTEGER,config_revision INTEGER);
    INSERT INTO sync_revisions VALUES(1,1,1);
    CREATE TABLE vendor_sync_revisions(vendor TEXT PRIMARY KEY,data_revision INTEGER);`);
  installAnalysisTracking(initial);fs.writeFileSync(file,initial.serialize());initial.close();
  const sqlite=new Database(file);sqlite.exec("PRAGMA journal_mode=WAL");
  const ctx={sqlite,dbPath:file,accounts: { version: 2, subscriptions: [], sources: [] },homeToSubId:new Map(),subIdToHomes:new Map(),eras:buildEraIndex([]),eraErrors:[],homeConflict:null,
    rateCards:{version:2,currency:"USD",unit:"per 1M",vendors:{}},claudeGauge:{},grokGauge:{},cycles:{},plans:{},plansCatalog:{provider_groups:[]},rootDir:process.cwd(),attribution:null} as AppContext;
  const reader=createDataRead(),url="http://local/api/account-history?group=day";
  prepareCodexLedgerFixture(sqlite,ctx.rateCards);
  prepareProbeReaderFixture(sqlite,[]);
  /** Rows of every table: serving a view writes none of them. */
  const stored=()=>Object.fromEntries((sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[])
    .map(({name})=>[name,(sqlite.query(`SELECT COUNT(*) n FROM "${name}"`).get() as {n:number}).n]));
  const before=stored();
  try{
    const receipt=await reader(ctx,new Request(url));expect(receipt.status).toBe(202);
    expect(receipt.headers.get("X-Analysis")).toBe("preparing");
    const first=await ready(()=>reader(ctx,new Request(url)));expect(first.status).toBe(200);const expected=await first.json();
    expect((expected as any).totals.tokens).toBe(30);
    // The same rows and configuration: the answer kept in memory, with the rows' version.
    const hot=await reader(ctx,new Request(url));
    expect(hot.headers.get("X-Analysis")).toBe("memory");expect(hot.headers.get("X-Data-Version")).toBe(first.headers.get("X-Data-Version"));
    expect(await hot.json()).toEqual(expected);
    // Nothing was remembered in the database: a restart starts with no answer.
    expect(stored()).toEqual(before);
    const restarted=createDataRead();
    try { expect((await restarted(ctx,new Request(url))).status).toBe(202); await restarted.whenIdle(); }
    finally { restarted.close(); }
    // New rows publish a new version: the previous answer is stale until the worker has the current one.
    sqlite.exec("UPDATE events SET in_tok=17 WHERE id=1");
    prepareCodexLedgerFixture(sqlite,ctx.rateCards);
    const previous=await reader(ctx,new Request(url));
    expect(previous.headers.get("X-Analysis")).toBe("stale");
    expect(previous.headers.get("Cache-Control")).toBe("no-store");
    expect(await previous.json()).toEqual(expected);
    const changed=await ready(()=>reader(ctx,new Request(url)));
    expect(((await changed.json()) as any).totals.tokens).toBe(37);
    expect(changed.headers.get("X-Data-Version")).not.toBe(first.headers.get("X-Data-Version"));
    const fetch=createFetchHandler(ctx);
    try {
      expect(await (await fetch(new Request("http://local/api/analysis/rebuild"))).json()).toEqual({job:null});
      expect((await fetch(new Request("http://local/api/analysis/rebuild",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scope:"invalid"})}))).status).toBe(400);
      const rebuild=await fetch(new Request("http://local/api/analysis/rebuild",{method:"POST",headers:{"content-type":"application/json"}}));
      expect(rebuild.status).toBe(200);expect(await rebuild.json()).toMatchObject({ok:true,generation:1,job:{scope:"all",state:"queued"}});
    } finally {await ctx.analysisReader?.close();}
  }finally{await reader.close();await reader.whenIdle();sqlite.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
},30000);

test("every API route is registered or declares why it bypasses report preparation",()=>{
  const router=fs.readFileSync(new URL("./api-router.ts",import.meta.url),"utf8");
  const routes=[...router.matchAll(/url\.pathname === "(\/api\/[^"]+)"/g)].map(match=>match[1]!);
  expect(routes.length).toBeGreaterThan(40);
  for(const route of routes)expect(Boolean(DATA_VIEWS[route]||DIRECT_DATA_ROUTES[route]),route).toBe(true);
});
