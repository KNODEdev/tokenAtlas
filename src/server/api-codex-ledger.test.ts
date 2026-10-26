import { test, expect, spyOn } from "bun:test";
import { Database } from "../db/sqlite";
import { createCodexLedgerSchema } from "../db/codex-price-ledger";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { apiCodexLedgerRows, ApiCodexMoney } from "./api-codex-ledger";
import { rational } from "../db/price-ledger-exact";
import { handleSummary, handleBreakdown, handleCompare, handleCache, handleEvents, handleAccountHistory, handleUsageSeries, type AppContext } from "./api";
import { buildAccountResolver } from "./account-resolver";
import type { RateCard } from "./pricing";
import type { DatedPeriod } from "./account-periods";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fillCodexLedgerFixture } from "./codex-ledger.fixture";
import { readConversationCourse } from "./conversation-course";

const evidence = { verified_at:"2026-09-01",sources:["https://example.test/price"],confidence:"official" as const };
const card: RateCard = { version:2,currency:"USD",unit:"per 1M",vendors:{},codex_ledger_policy:{
  version:1,tiers:["standard","fast"],mappings:[{id:"default",raw_value:"default",tier:"standard"}],tier_rules:[],base_rules:[
    { id:"api",model:"known",billing_basis:"api_equivalent_usd",valid_from:"2026-01-01",multiplier:"1",...evidence,
      rates:{in_uncached:"0.004",in_cache_read:"0.002",in_cache_write:"0.004",out_total:"0.008"} },
    { id:"credits",model:"known",billing_basis:"chatgpt_credits",valid_from:"2026-01-01",multiplier:"1",...evidence,
      rates:{in_uncached:"1",in_cache_read:"0.5",out_total:"2"} },
  ] } };
const period: DatedPeriod = {provider:"codex",subject:"codex/main",from:"2026-01-01",until:null,value:"owner",origin:"declared",firstSeen:null,lastSeen:null,readings:0,evidence:"fixture"};
function fixture(db: Database, ready=true): AppContext {
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,
    service_tier TEXT,usage_status TEXT,cache_write_status TEXT,project_id INTEGER,project TEXT,repo TEXT,surface TEXT);
    INSERT INTO events VALUES
    (1,'/archive/codex/main','session',100,'2026-09-01T12:00:00Z','known',1000000,0,0,0,0,'default','valid','reported',7,'raw-main','repo-main','cli'),
    (2,'/archive/codex/main','session',200,'2026-09-02T12:00:00Z','known',1000000,0,0,0,0,'default','valid','reported',7,'raw-main','repo-main','cli'),
    (3,'/archive/codex/main','session',300,'2026-09-03T12:00:00Z','known',1000000,0,0,0,0,'default','valid','reported',8,'raw-other','repo-other','cli'),
    (4,'/archive/codex/main','other',400,'2026-09-03T13:00:00Z','absent',500000,0,0,0,0,'default','valid','reported',NULL,NULL,NULL,'cli');`);
  const context = codexLedgerReadContext(card);
  if (ready) {
    createCodexLedgerSchema(db);
    fillCodexLedgerFixture(db,{bands:context.policy.baseBands,rulesRevision:context.rulesRevision!,factsRevision:0,
      policy:context.policy.policy,sourceOf:()=>"codex/main"});
  }
  return { sqlite:db,rateCards:card,homeToSubId:new Map(),subIdToHomes:new Map(),accounts:{version:2,sources:[],subscriptions:[]},
    resolver:buildAccountResolver([period]),rootDir:process.cwd() } as unknown as AppContext;
}
const url = (path:string) => new URL("http://test"+path);

test("conversation references are opt-in, keep default event bytes and survive raw event replacement", async () => {
  const db = new Database(":memory:"), ctx = fixture(db);
  try {
    const plain = await handleEvents(ctx, url("/api/events?vendor=codex")).json() as any;
    const linked = await handleEvents(ctx, url("/api/events?vendor=codex&conversation=1")).json() as any;
    const ref = linked.rows.find((row: any) => row.ts === '2026-09-01T12:00:00Z').conversation;
    expect(ref.vendor).toBe("codex");
    for (const row of linked.rows) delete row.conversation;
    expect(JSON.stringify(linked)).toBe(JSON.stringify(plain));
    const before = readConversationCourse(ctx, ref.vendor, ref.reference_id);
    db.exec("DELETE FROM events");
    expect(readConversationCourse(ctx, ref.vendor, ref.reference_id)).toEqual(before);
  } finally { db.close(); }
});

test("the existing cache API retains exact historical coefficients after equivalent declaration IDs change", async () => {
  const db = new Database(":memory:"), ctx = fixture(db);
  try {
    const before = db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    const original = await handleCache(ctx, url("/api/cache?vendor=codex&project_id=7")).json();
    ctx.rateCards = structuredClone(ctx.rateCards);
    const declaration = ctx.rateCards.codex_ledger_policy as typeof card.codex_ledger_policy;
    declaration!.base_rules[0]!.id = "renamed-api";
    declaration!.base_rules[0]!.rates.in_uncached = "0.0040";
    expect(await handleCache(ctx, url("/api/cache?vendor=codex&project_id=7")).json()).toEqual(original);
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(before);
  } finally { db.close(); }
});

test("summary, breakdown, cache, comparison and account history read stored money without repricing or writing",async()=>{
  const db=new Database(":memory:"),ctx=fixture(db);
  const before=db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
  const queries:string[]=[],original=db.query.bind(db) as (sql:string,...args:any[])=>any;
  const query=spyOn(db,"query").mockImplementation((sql:string,...args:any[])=>{queries.push(sql);return original(sql,...args);});
  try {
    const summary=await handleSummary(ctx,url("/api/summary?vendor=codex")).json() as any;
    expect(summary.totals.codex).toEqual({calls:4,usd:0.01});
    expect(summary.unpriced.tokens).toBe(500000);
    const breakdown=await handleBreakdown(ctx,url("/api/breakdown?vendor=codex&dim=raw_project&project_id=7")).json() as any;
    expect(breakdown.rows).toMatchObject([{name:"raw-main",calls:2,tokens:2000000,usd:0.01}]);
    const cache=await handleCache(ctx,url("/api/cache?vendor=codex&project_id=7")).json() as any;
    expect(cache.codex.tokens.in_tok).toBe(2000000);
    const compare=await handleCompare(ctx,url("/api/compare?vendor=codex&a_since=2026-09-01&a_until=2026-09-03&b_since=2026-09-02&b_until=2026-09-03")).json() as any;
    expect(compare.window_a.codex.usd).toBe(0.01);
    const history=await handleAccountHistory(ctx,url("/api/account-history?group=day")).json() as any;
    expect(JSON.stringify(history)).toContain('owner');
    const events=await handleEvents(ctx,url("/api/events?vendor=codex&project_id=7")).json() as any;
    expect(events.rows).toHaveLength(2);
    expect(events.rows.every((row:any)=>row.usd===0)).toBe(true);
    expect(queries.some(sql=>/analysis_changes|usage_price_events|event:valuation|SUM\(in_tok\).*FROM events/is.test(sql))).toBe(false);
    query.mockRestore();
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(before);
  } finally {query.mockRestore();db.close();}
});

test("unpublished ledger responds with preparation and never falls back to raw historical prices",()=>{
  const db=new Database(":memory:"),ctx=fixture(db,false);
  try {
    ctx.subIdToHomes.set("owner",["/archive/codex/main"]);
    for(const [handler,route] of [[handleSummary,"/api/summary?vendor=codex"],[handleBreakdown,"/api/breakdown?dim=model&vendor=codex"],
      [handleCompare,"/api/compare?vendor=codex"],[handleCache,"/api/cache?vendor=codex"],[handleEvents,"/api/events?vendor=codex"],
      [handleAccountHistory,"/api/account-history"],[handleUsageSeries,"/api/usage-series?account=owner"]] as const) expect(handler(ctx,url(route)).status).toBe(202);
    expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({n:4});
  } finally {db.close();}
});

test("exact response accumulator preserves a priced subtotal after an unpriced group",()=>{
  const money=new ApiCodexMoney(),target={usd:0 as number|null,priced_usd:0};
  money.add(target,rational(1n,3n));target.usd=null;
  money.add(target,rational(2n,3n));money.finish();
  expect(target).toEqual({usd:null,priced_usd:1});
});

test("stored grouped reads survive process connection restart and raw-token mutation without repricing",()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"api-ledger-")),file=path.join(directory,"atlas.sqlite");
  let db=new Database(file),ctx=fixture(db);
  try {
    const rows=apiCodexLedgerRows(ctx,{},undefined,ctx.resolver);
    db.exec("UPDATE events SET in_tok=999999999");db.close();db=new Database(file);ctx={...ctx,sqlite:db};
    expect(apiCodexLedgerRows(ctx,{},undefined,ctx.resolver)).toEqual(rows);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='analysis_changes'").get()).toBeNull();
  } finally {db.close();fs.rmSync(directory,{recursive:true,force:true});}
});


