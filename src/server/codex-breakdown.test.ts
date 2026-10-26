import { prepareProbeReaderFixture, splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { test, expect } from "bun:test";
import { Database } from "../db/sqlite";
import { handleBreakdown, handleWindows, type AppContext } from "./api";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";

function fixture(): AppContext {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,model TEXT,surface TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,billing_mode TEXT);
    INSERT INTO events VALUES
      ('C:/source','a','2026-06-02T00:00:00Z','test','cli',100,0,0,10,0,'allowance'),
      ('C:/source','a','2026-06-03T00:00:00Z','test','cli',200,0,0,20,0,'business_credits'),
      ('C:/other','b','2026-06-03T00:00:00Z','test','cli',900,0,0,90,0,'allowance');`);
  // Each local profile copies an archive folder whose account period names its account (stage 4, W6).
  const subscriptions=[{id:"main",vendor:"codex",home:`${ARCHIVE_LOGICAL_ROOT}/codex/source`,source_home:"C:/source"},
    {id:"other",vendor:"codex",home:`${ARCHIVE_LOGICAL_ROOT}/codex/other`,source_home:"C:/other"},{id:"empty",vendor:"codex",home:""}];
  declareCodexEraPeriods(sqlite,subscriptions);
  const ctx = { sqlite, accounts: splitProbeReaderFixtureConfig(subscriptions), subIdToHomes:new Map([["main",["C:/source"]]]),
    homeToSubId:new Map([["c:/source","main"],["c:/other","other"]]),
    rateCards:{version:1,currency:"USD",unit:"per_million_tokens",vendors:{openai:{models:{test:{
      in_uncached:2,in_cache_read:1,in_cache_write:2,out_total:8}}}}} } as unknown as AppContext;
  prepareCodexLedgerFixture(sqlite,ctx.rateCards,ctx.homeToSubId,subscriptions);
  prepareProbeReaderFixture(sqlite,subscriptions);
  return ctx;
}

test("Business without a dedicated home resolves automatically and excludes personal traffic",async()=>{
  const ctx=fixture();
  try {
    const business=await handleBreakdown(ctx,new URL("http://local/api/breakdown?dim=model&account=main::business")).json();
    expect(business.totals.tokens).toBe(220);
    const personal=await handleBreakdown(ctx,new URL("http://local/api/breakdown?dim=model&account=main")).json();
    expect(personal.totals.tokens).toBe(110);
    const empty=await handleBreakdown(ctx,new URL("http://local/api/breakdown?dim=model&account=empty")).json();
    expect(empty.totals.tokens).toBe(0);
    const windows=await (await handleWindows(ctx,new URL("http://local/api/windows?account=main::business"))).json();
    expect(windows.windows).toEqual([]);
    expect(windows.source).toBe("billing");
  } finally {ctx.sqlite.close();}
});

test("account breakdown preserves separate billing pools",async()=>{
  const ctx=fixture();
  try {
    const result=await handleBreakdown(ctx,new URL("http://local/api/breakdown?dim=account&vendor=codex")).json();
    expect(result.rows.find((r:any)=>r.name==="main::business")?.tokens).toBe(220);
    expect(result.rows.find((r:any)=>r.name==="main")?.tokens).toBe(110);
    expect(result.totals.tokens).toBe(1320);
  } finally {ctx.sqlite.close();}
});

test("breakdown counts a conversation once after it moves into archived sessions",async()=>{
  const ctx=fixture();
  try {
    const file="rollout-2026-06-02T00-00-00-01900000-0000-7000-8000-000000000001.jsonl";
    const active=`C:/source/sessions/2026/06/02/${file}`;
    const archived=`C:/source/archived_sessions/${file}`;
    ctx.sqlite.query("UPDATE events SET path=? WHERE path='a'").run(active);
    ctx.sqlite.query(`INSERT INTO events SELECT home,?,ts,model,surface,in_tok,cached_in,cache_write,
      out_tok,reasoning_out,billing_mode,source_offset,service_tier FROM events WHERE path=?`).run(archived,active);
    prepareCodexLedgerFixture(ctx.sqlite,ctx.rateCards,ctx.homeToSubId,ctx.accounts.sources);
    const result=await handleBreakdown(ctx,new URL("http://local/api/breakdown?dim=model&account=main::business")).json();
    expect(result.totals.tokens).toBe(220);
    expect(result.totals.calls).toBe(1);
  } finally {ctx.sqlite.close();}
});
