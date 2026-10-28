import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { prepareGlobalFixture } from "./global-usage.fixture";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods,loadPeriods } from "../db/period-store";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { buildGlobalUsage as readGlobalUsage, globalUsageRange, handleGlobalUsage } from "./global-usage";
import { buildEraIndex } from "./eras";
import type { RateCard } from "./pricing";
import { createDataRead } from "./data-read";
import { installAnalysisTracking } from "../db/analysis";
import { createFetchHandler, type AppContext } from "./api";
import { priceCodexEvent, resolveCodexAccountingConfig } from "./codex-accounting-pricing";

const dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const range = { since: "2026-09-08", until: "2026-09-09" };
const rates = { in_uncached: 2, in_cache_read: 1, in_cache_write: 3, in_cache_write_5m: 3, in_cache_write_1h: 4, out_total: 8 };
const card: RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: Object.fromEntries(["openai", "anthropic", "zai", "google", "xai"].map(vendor => [vendor, { models: { test: rates } }])) };
const sources=["C:/codex","archive"].map(source_home=>({id:"old-account",vendor:"codex",home:`${ARCHIVE_LOGICAL_ROOT}/codex/test`,source_home}));
const period=(provider:string,source:string,account:string,from="2020-01-01T00:00:00Z",until:string|null=null)=>({provider,subject:source,value:account,from,until,origin:"declared" as const,firstSeen:null,lastSeen:null,readings:0,evidence:"test"});
function buildGlobalUsage(ctx:Parameters<typeof readGlobalUsage>[0], range:Parameters<typeof readGlobalUsage>[1]) {
  prepareGlobalFixture(ctx.sqlite,ctx.rateCards,sources);
  return readGlobalUsage({...ctx,accounts:splitProbeReaderFixtureConfig(sources)},range);
}
function fixture() {
  const sqlite = new Database(":memory:"); dbs.push(sqlite);
  applyDrizzleMigrations(drizzle(sqlite));
  sqlite.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT, path TEXT, ts TEXT, model TEXT, speed TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER, billing_mode TEXT);
    INSERT INTO events(home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,billing_mode) VALUES ('C:/codex','C:/codex/sessions/test.jsonl','2026-09-08T12:00:00Z','gpt-6-astra','standard',100000,80000,0,10000,NULL);
    INSERT INTO claude_events(store,call_id,ts,path,subscription_id,model,speed,in_uncached,in_cache_read,in_cache_write,cache_write_5m,cache_write_1h,out_total,out_thinking)
      VALUES ('claude-source','call','2026-09-08T23:59:59Z','a','expired-claude','test','standard',100,20,30,10,20,50,10);
    INSERT INTO oc_events(store,message_id,ts,provider,model,in_tok,out_tok,reasoning,cache_read,cache_write,cost)
      VALUES ('oc-source','a','2026-09-09T00:00:00Z','zai-coding-plan','test',10,20,7,30,40,999),
             ('oc-source','b','2026-09-09T00:00:00Z','anthropic','test',15,25,8,35,45,0);
    INSERT INTO gemini_events(store,conversation_id,gen_idx,ts,ts_basis,path,model,fresh_in,cached_in,out_total,out_thinking,usd)
      VALUES ('agy','conv',0,'2026-09-09T23:59:59Z','conversation','gemini/a','test',11,22,33,5,999);
    INSERT INTO grok_events(store,session_id,prompt_id,ts,path,model,in_tok,cached_in,cache_write,out_tok,cost_ticks)
      VALUES ('grok','session','prompt','2026-09-09T12:00:00Z','grok/a','test',44,5,6,7,999);`);
  sqlite.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  sqlite.query("UPDATE claude_events SET path=?").run(`${ARCHIVE_LOGICAL_ROOT}/claude/main/a`);
  sqlite.query("UPDATE gemini_events SET path=?").run(`${ARCHIVE_LOGICAL_ROOT}/gemini/agy/a`);
  replaceDeclaredPeriods(sqlite,ACCOUNT_PERIODS,[period("codex","codex/test","old-account"),period("claude","claude/main","expired-claude")]);
  prepareGlobalFixture(sqlite,card,sources);
  return { sqlite, rateCards: card, homeToSubId: indexSubscriptionHomes(sources),accounts:splitProbeReaderFixtureConfig(sources) };
}

describe("global usage", () => {
  test("a selected Global is unchanged by a full Global read", () => {
    const ctx=fixture();
    installAnalysisTracking(ctx.sqlite);
    const scoped={...ctx,eras:buildEraIndex([])};
    const partial=buildGlobalUsage(scoped,{...range,vendors:["claude"]});
    expect(buildGlobalUsage(scoped,range).sources).toHaveLength(5);
    expect(buildGlobalUsage(scoped,{...range,vendors:["claude"]})).toEqual(partial);
  });
  test("selected source preparation neither reads malformed unrelated usage nor widens its cached result", () => {
    const ctx=fixture();
    ctx.sqlite.exec("UPDATE events SET in_tok=-1; UPDATE grok_events SET in_tok=-1");
    installAnalysisTracking(ctx.sqlite);
    const selected={...range,vendors:["claude" as const]};
    const scoped={...ctx,eras:buildEraIndex([])};
    const report=buildGlobalUsage(scoped,selected);
    expect(report.sources).toEqual([{id:"claude",available:true,events:1}]);
    expect(report.rows.map(row=>row.tokens)).toEqual([200]);
    expect(buildGlobalUsage(scoped,selected)).toEqual(report);
    expect(buildGlobalUsage(scoped,range).sources.some(source=>source.id==="codex")).toBe(true);
    for (const vendors of ["","unknown","gauges","claude,","claude,codex,unknown"])
      expect(()=>globalUsageRange(new URLSearchParams({...range,vendors}))).toThrow();
    expect(globalUsageRange(new URLSearchParams({...range,vendors:"claude,codex"})).vendors).toEqual(["codex","claude"]);
  });
  test("internal review retains recorded quantities and separate identity without valuation", () => {
    const ctx = fixture();
    ctx.sqlite.exec("INSERT INTO events(home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,billing_mode) VALUES ('C:/codex','C:/codex/sessions/review.jsonl','2026-09-08T13:00:00Z','codex-auto-review','standard',30000,20000,0,100,NULL)");
    const report = buildGlobalUsage(ctx, range);
    const review = report.rows.find(row => row.model === "codex-auto-review")!;
    expect(review).toMatchObject({ tokens: 30100, internal_tokens: 30100, input: 10000, cache_read: 20000, output: 100,
      api_usd: { subtotal: 0, priced_calls: 0, unpriced_calls: 1 }, credits: { subtotal: 0, priced_calls: 0, unpriced_calls: 1 } });
    expect(report.rows.find(row => row.model === "gpt-6-astra")!.tokens).toBe(110000);
  });
  test("HTTP reads answer from the register days at once, read-only, preserve totals and cache results", async () => {
    const original = fixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-global-usage-"));
    const dbPath = path.join(directory, "fixture.sqlite");
    original.sqlite.query("VACUUM INTO ?").run(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.exec("PRAGMA journal_mode=WAL");
    installAnalysisTracking(sqlite);
    const ctx = { ...original, sqlite, dbPath, subIdToHomes: new Map(), accounts: splitProbeReaderFixtureConfig(sources), plans: {}, plansCatalog: { provider_groups: [] } } as unknown as AppContext;
    const expected = buildGlobalUsage(original, range);
    try {
      const handler = createFetchHandler(ctx);
      const url = `http://127.0.0.1/api/global-usage?${new URLSearchParams(range)}`;
      const changes = sqlite.query("SELECT total_changes() n").get();
      const first = await handler(new Request(url));
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Data-Version")).toBeString();
      expect(await first.json()).toEqual(expected);
      const second = await handler(new Request(url));
      expect(second.headers.get("X-Cache")).toBe("hit");
      expect(await second.json()).toEqual(expected);
      expect(sqlite.query("SELECT total_changes() n").get()).toEqual(changes);
      expect((await handler(new Request(`http://127.0.0.1/api/global-usage?since=not-a-day`))).status).toBe(400);
    } finally {
      ctx.analysisReader?.close(); await Bun.sleep(0); sqlite.close();
      await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});
    }
  });
  test("includes every collector and expired/unassigned accounts without double-counting cached or thinking tokens", () => {
    const ctx = fixture();
    readGlobalUsage(ctx, range);
    const before = ctx.sqlite.query("SELECT total_changes() AS n").get();
    const report = readGlobalUsage(ctx, range);
    expect(report.sources.every(source => source.available)).toBe(true);
    expect(report.rows).toHaveLength(6);
    const source = (id: string) => report.rows.find(row => row.source === id)!;
    expect(source("codex")).toMatchObject({ tokens: 110000, input: 20000, cache_read: 80000, output: 10000, account: "old-account" });
    expect(source("codex").api_usd.subtotal).toBeCloseTo(.78, 9);
    expect(source("codex").credits).toEqual({ subtotal: 19.5, priced_calls: 1, unpriced_calls: 0 });
    expect(source("claude")).toMatchObject({ tokens: 200, input: 100, cache_read: 20, cache_write: 30, output: 50, account: "expired-claude" });
    expect(report.rows.find(row => row.provider === "zai")).toMatchObject({ source: "opencode", tokens: 107, output: 27, account: null });
    expect(report.rows.filter(row => row.provider === "anthropic").map(row => row.source).sort()).toEqual(["claude", "opencode"]);
    expect(source("gemini")).toMatchObject({ tokens: 66, output: 33 });
    expect(source("grok")).toMatchObject({ tokens: 57, input: 39, output: 7 });
    expect(report.actual_cost_available).toBe(false);
    expect(source("opencode").api_usd.subtotal).toBeLessThan(1);
    expect(report.approximate_time_events).toBe(1);
    expect(ctx.sqlite.query("SELECT total_changes() AS n").get()).toEqual(before);
  });

  test("prices each request independently before daily aggregation", () => {
    const ctx = fixture();
    ctx.sqlite.exec("DELETE FROM events; INSERT INTO events(home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,billing_mode) VALUES ('C:/codex','C:/codex/sessions/test.jsonl','2026-09-08T12:00:00Z','gpt-6-astra','standard',200000,0,0,0,NULL), ('C:/codex','C:/codex/sessions/test.jsonl','2026-09-08T13:00:00Z','gpt-6-astra','standard',200000,0,0,0,NULL)");
    const row = buildGlobalUsage(ctx, range).rows.find(row => row.source === "codex")!;
    expect(row.tokens).toBe(400000);
    expect(row.api_usd.subtotal).toBe(4);
  });

  test("chooses one Codex mirror before account filters and preserves separate business billing identity", () => {
    const ctx = fixture();
    ctx.sqlite.exec("UPDATE events SET billing_mode='business_credits'");
    ctx.sqlite.exec(`INSERT INTO events(home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,billing_mode) SELECT 'archive', 'archive/sessions/test.jsonl',ts,model,speed,in_tok,cached_in,cache_write,out_tok,'business_credits' FROM events;`);
    const report = buildGlobalUsage(ctx, range);
    expect(report.excluded_duplicates).toBe(1);
    expect(report.rows.filter(row => row.source === "codex")).toHaveLength(1);
    expect(report.rows.find(row => row.source === "codex")!.account).toBe("old-account::business");
  });

  test("Antigravity resolves the model publisher and documented variants independently from source account", () => {
    const ctx = fixture();
    const rateCards = structuredClone(card);
    rateCards.vendors.anthropic!.models!["claude-test"] = rates;
    rateCards.vendors.google!.models!["gemini-test"] = rates;
    ctx.sqlite.exec("UPDATE gemini_events SET model='claude-test-thinking'; INSERT INTO gemini_events(store,conversation_id,gen_idx,ts,ts_basis,path,model,fresh_in,out_total) VALUES ('agy','conv2',0,'2026-09-09T12:00:00Z','event','b','gemini-test-control',100,20)");
    ctx.sqlite.query("UPDATE gemini_events SET path=? WHERE conversation_id='conv2'").run(`${ARCHIVE_LOGICAL_ROOT}/gemini/agy/b`);
    replaceDeclaredPeriods(ctx.sqlite,ACCOUNT_PERIODS,[...loadPeriods(ctx.sqlite,ACCOUNT_PERIODS),period("gemini","gemini/agy","agy-seat")]);
    const eras = buildEraIndex([]);
    const report = buildGlobalUsage({ ...ctx, rateCards, eras }, range);
    const rows = report.rows.filter(row => row.source === "gemini");
    expect(rows.map(row => row.provider).sort()).toEqual(["anthropic", "google"]);
    expect(rows.every(row => row.api_usd.priced_calls === 1 && row.account === "agy-seat")).toBe(true);
  });

  test("OpenCode OpenAI uses dated per-request API rules and receives no ChatGPT credits", () => {
    const ctx = fixture();
    ctx.sqlite.exec("INSERT INTO oc_events(store,message_id,ts,provider,model,in_tok,out_tok) VALUES ('oc','old-sol','2026-08-01T12:00:00Z','openai','gpt-5.6-sol',1000000,0)");
    const report = buildGlobalUsage(ctx, { since: "2026-08-01", until: "2026-08-01" });
    const row = report.rows[0]!;
    // This input also crosses the request-size boundary in the historical rule.
    const expected = priceCodexEvent(resolveCodexAccountingConfig(card), { model: "gpt-5.6-sol", speed: "standard", ts: "2026-08-01T12:00:00Z", in_tok: 1000000, cached_in: 0, cache_write: 0, out_tok: 0 }, "api_equivalent_usd").amount;
    expect(expected).not.toBeNull();
    expect(row.api_usd.subtotal).toBe(expected!);
    expect(row.credits).toEqual({ subtotal: 0, priced_calls: 0, unpriced_calls: 1 });
  });

  test("deduplicates Claude copies by verified owner and event identity; conflicting values remain excluded", () => {
    const ctx = fixture();
    ctx.sqlite.exec(`INSERT INTO claude_events(store,call_id,ts,path,subscription_id,model,speed,in_uncached,in_cache_read,in_cache_write,cache_write_5m,cache_write_1h,out_total,out_thinking)
      SELECT 'mirror',call_id,ts,path,subscription_id,model,speed,in_uncached,in_cache_read,in_cache_write,cache_write_5m,cache_write_1h,out_total,out_thinking FROM claude_events;`);
    expect(buildGlobalUsage(ctx, range).rows.find(row => row.source === "claude")!.calls).toBe(1);
    ctx.sqlite.exec("UPDATE claude_events SET out_total=999 WHERE store='mirror'");
    const report = buildGlobalUsage(ctx, range);
    expect(report.rows.some(row => row.source === "claude")).toBe(false);
    expect(report.conflicting_events).toBe(1);
  });

  test("uses dated account periods, including old subscriptions, and keeps unassigned traffic", () => {
    const ctx = fixture();
    const eras = buildEraIndex([
      { id: "old", vendor: "codex", home: "C:/codex", until: "2026-09-09" },
      { id: "new", vendor: "codex", home: "C:/codex", from: "2026-09-09" },
      { id: "glm-seat", vendor: "glm", home: "oc-source" },
    ]);
    ctx.sqlite.exec("INSERT INTO events(home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,billing_mode) SELECT home,path,'2026-09-09T12:00:00Z',model,speed,in_tok,cached_in,cache_write,out_tok,billing_mode FROM events");
    replaceDeclaredPeriods(ctx.sqlite,ACCOUNT_PERIODS,[period("codex","codex/test","old","2020-01-01T00:00:00Z","2026-09-09T00:00:00Z"),period("codex","codex/test","new","2026-09-09T00:00:00Z"),period("glm","glm/oc-source","glm-seat")]);
    const report = buildGlobalUsage({ ...ctx, eras }, range);
    expect(report.rows.filter(row => row.source === "codex").map(row => row.account)).toEqual(["old", "new"]);
    expect(report.rows.find(row => row.provider === "zai")!.account).toBe("glm-seat");
    expect(report.rows.find(row => row.source === "opencode" && row.provider === "anthropic")!.account).toBeNull();
  });

  test("retains unpriced calls and distinguishes absent tables from empty available sources", () => {
    const ctx = fixture();
    ctx.sqlite.exec("UPDATE events SET speed=NULL; UPDATE oc_events SET model='unpriced'; DROP TABLE grok_events; DELETE FROM gemini_events");
    const report = buildGlobalUsage(ctx, range);
    // An omitted Codex tier is known Standard for both API and credit valuation (25 October policy).
    const codex = report.rows.find(row => row.source === "codex")!;
    expect(codex.api_usd).toEqual({ subtotal: 0.78, priced_calls: 1, unpriced_calls: 0 });
    expect(codex.credits).toMatchObject({ priced_calls: 1, unpriced_calls: 0 });
    expect(report.rows.filter(row => row.source === "opencode").every(row => row.tokens > 0 && row.api_usd.unpriced_calls === 1)).toBe(true);
    expect(report.sources.find(source => source.id === "grok")).toEqual({ id: "grok", available: false, events: 0 });
    expect(report.sources.find(source => source.id === "gemini")).toEqual({ id: "gemini", available: true, events: 0 });
  });

  test("date boundaries include the full last day and reject malformed/reversed/excessive ranges", () => {
    const ctx = fixture();
    const day = buildGlobalUsage(ctx, { since: range.until, until: range.until });
    expect(day.rows).toHaveLength(4);
    for (const query of ["since=2026-02-30", "since=2026-09-10&until=2026-09-09", "since=1900-01-01&until=2026-09-09"]) {
      expect(handleGlobalUsage(ctx, new URL(`http://localhost/api/global-usage?${query}`)).status).toBe(400);
    }
    expect(globalUsageRange(new URLSearchParams(), new Date("2026-09-09T00:00:00Z"))).toEqual({ since: "2026-08-11", until: "2026-09-09" });
  });
});
