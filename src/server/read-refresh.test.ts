import { expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import { ensureWindowAnswersSchema, foldWindowAnswerMarks, markWindowAnswersDirty, MARK_FOLD_AGE_MS } from "../db/window-answers";
import type { AppContext } from "./api";
import { readRefreshCheck } from "./read-refresh";
import { readRefreshDecision } from "../shared/read-refresh";
import { WINDOW_SCREENS } from "./window-screens";
import * as api from "./api";

function fixture() {
  const sqlite=new Database(":memory:");
  sqlite.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE sync_revisions(id INTEGER PRIMARY KEY,data_revision INTEGER,config_revision INTEGER);
    INSERT INTO sync_revisions VALUES(1,1,1);`);
  ensureWindowAnswersSchema(sqlite);
  const ctx={sqlite,accounts:{version:2,subscriptions:[{id:"claude-seat",vendor:"claude"}],sources:[]},
    homeToSubId:new Map(),subIdToHomes:new Map(),rateCards:{version:2,currency:"USD",unit:"per 1M",vendors:{}},
    plans:{},plansCatalog:{provider_groups:[]},cycles:{},rootDir:process.cwd()} as unknown as AppContext;
  const paths=[
    "/api/codex-accounting?account=seat-a&since=2026-09-01&until=2026-09-07",
    "/api/codex-accounting?account=seat-b&since=2026-09-01&until=2026-09-07",
    "/api/codex-accounting?account=seat-a&since=2026-07-01&until=2026-07-07",
    "/api/windows?account=claude-seat",
    "/api/global-usage?since=2026-09-01&until=2026-09-07",
  ];
  const check=(cursor?:number,reads=paths)=>{
    const url=new URL("http://local/api/sync");url.searchParams.set("read_paths",JSON.stringify(reads));
    if(cursor!==undefined)url.searchParams.set("read_cursor",String(cursor));
    return readRefreshCheck(ctx,url)!;
  };
  const change=(provider="codex",account="seat-a",from="2026-09-03",until="2026-09-04")=>
    markWindowAnswersDirty(sqlite,{provider,account,fromMs:Date.parse(from),untilMs:Date.parse(until)});
  return {sqlite,ctx,paths,check,change};
}

test("refresh follows the registered provider, account and expanded historical dependency range",()=>{
  const f=fixture();
  try{
    const baseline=f.check();expect(baseline.reset).toBe(true);
    f.change();const next=f.check(baseline.cursor);
    expect(next.unchanged).toEqual([f.paths[1]!,f.paths[2]!,f.paths[3]!]);
    expect(readRefreshDecision(baseline,next).refresh?.unchanged).toEqual(next.unchanged);
    f.change("claude","claude-seat");const claude=f.check(next.cursor);
    expect(claude.unchanged).toEqual(f.paths.slice(0,3));
    f.change("codex","*","2026-06-01","2026-06-02");
    expect(f.check(claude.cursor).unchanged).toEqual(f.paths.slice(0,4));
    f.change("*","*");expect(f.check(claude.cursor).unchanged).toEqual([f.paths[2]!]);
    // A reading just beyond the displayed range can change its crossing cycle.
    const at=f.check();f.change("codex","seat-a","2026-09-10","2026-09-11");
    expect(f.check(at.cursor).unchanged).not.toContain(f.paths[0]!);
  }finally{f.sqlite.close();}
});

test("folded, reversed or missing cursors and configuration changes fall back to a full refresh",()=>{
  const f=fixture();
  try{
    const initial=f.check();f.change();
    const prior=f.check(initial.cursor);expect(readRefreshDecision(initial,prior).refresh).toBeDefined();
    foldWindowAnswerMarks(f.sqlite,Date.now()+MARK_FOLD_AGE_MS+1000);
    const folded=f.check(initial.cursor);expect(folded.reset).toBe(true);
    expect(readRefreshDecision(initial,folded).refresh).toBeUndefined();
    expect(f.check(10000).reset).toBe(true);
    const first=f.check(prior.cursor);
    f.sqlite.query("INSERT INTO meta VALUES('account_periods_revision','2')").run();
    const periods=f.check(first.cursor);expect(readRefreshDecision(first,periods).refresh).toBeUndefined();
    f.ctx.rateCards={...f.ctx.rateCards,version:3};
    const rates=f.check(periods.cursor);expect(readRefreshDecision(periods,rates).refresh).toBeUndefined();
    f.sqlite.query("UPDATE sync_revisions SET config_revision=config_revision+1").run();
    expect(readRefreshDecision(rates,f.check(rates.cursor)).refresh).toBeUndefined();
    expect(readRefreshDecision(rates,undefined).refresh).toBeUndefined();
    expect(readRefreshDecision(rates,{...rates,from:0} ).refresh).toBeUndefined();
  }finally{f.sqlite.close();}
});

test("a no-op check does not schedule refreshes and malformed or unregistered paths are never certified",()=>{
  const f=fixture();
  try{
    const first=f.check(),next=f.check(first.cursor);
    expect(readRefreshDecision(first,next).changed).toBe(false);
    expect(f.check(next.cursor,["https://example.com/api/windows?account=claude-seat","/api/windows?account=unknown",
      "/api/codex-accounting?since=2026-99-99&until=2026-99-99"]).unchanged).toEqual([]);
    const url=new URL("http://local/api/sync?read_paths=broken");expect(readRefreshCheck(f.ctx,url)).toBeUndefined();
    url.searchParams.set("read_paths",JSON.stringify(Array.from({length:129},()=>"/api/windows")));
    expect(readRefreshCheck(f.ctx,url)).toBeUndefined();
    const changes=f.sqlite.query("SELECT total_changes() n").get();f.check(next.cursor);
    expect(f.sqlite.query("SELECT total_changes() n").get()).toEqual(changes);
  }finally{f.sqlite.close();}
});

test("a screen's extra dependencies invalidate it even when the changed input is outside its interval",()=>{
  const f=fixture(),screen=WINDOW_SCREENS["/api/codex-accounting"]!,original=screen.configuration;
  let state="old-latest-reading";
  screen.configuration=()=>state;
  try{
    const first=f.check();f.change("codex","seat-a","2026-10-01","2026-10-02");state="new-latest-reading";
    const next=f.check(first.cursor),decision=readRefreshDecision(first,next);
    expect(next.unchanged).toContain(f.paths[0]!);
    expect(decision.refresh?.unchanged).not.toContain(f.paths[0]!);
    expect(decision.changed).toBe(true);
    expect(readRefreshDecision(next,{...next,from:next.cursor,dependencies:{...next.dependencies,[f.paths[0]!]:"third"}}).changed).toBe(true);
  }finally{screen.configuration=original;f.sqlite.close();}
});

test("a batch of window configuration checks reads the latest account state once",()=>{
  const f=fixture(),latest=spyOn(api,"latestAccountState").mockReturnValue([]);
  try{
    const paths=Array.from({length:6},(_,i)=>`/api/cycle-breakdown?account=seat-a&since_ts=2026-09-0${i+1}T00:00:00Z&until_ts=2026-09-0${i+2}T00:00:00Z&valuation=dated`);
    const first=f.check(undefined,paths);expect(Object.keys(first.dependencies)).toHaveLength(6);
    expect(latest).toHaveBeenCalledTimes(1);
    const second=f.check(first.cursor,paths);expect(readRefreshDecision(first,second).refresh?.unchanged).toEqual(paths);
    expect(latest).toHaveBeenCalledTimes(2);
  }finally{latest.mockRestore();f.sqlite.close();}
});
