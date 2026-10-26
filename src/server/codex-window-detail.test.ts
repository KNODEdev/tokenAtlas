import fs from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import rateCards from "../../rate-cards.json";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import { readCodexWindowDetail } from "./codex-window-detail";
import type { RateCard } from "./pricing";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { readCodexEventRange, resolveCodexLedgerEventOwner } from "./codex-priced-events";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { loadAccountResolver } from "./account-resolver";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { overrideProjectRules } from "../projects/resolve";

// These cases price the long-context premium, which the shipped card leaves off (owner decision 2026-10-20).
const card = { ...rateCards, codex_accounting: { ...rateCards.codex_accounting, long_context_premium: true } } as RateCard;
const account = "acct";
const databases: Database[] = [];

interface EventValues {
  home: string;
  path: string;
  ts: string;
  model: string | null;
  in_tok: number;
  cached_in: number;
  cache_write: number;
  out_tok: number;
  reasoning_out: number;
  speed: string | null;
  billing_mode: string | null;
  meter_reset: number | null;
  plan_type: string | null;
  account_id: string | null;
}

function database(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  // This follows the shipped Codex event schema. Optional reader fields are
  // present so the fixture also exercises compatibility with older indexes.
  db.exec(`CREATE TABLE events (
    home TEXT NOT NULL, path TEXT NOT NULL, ts TEXT NOT NULL,
    surface TEXT, nested TEXT, model TEXT, effort TEXT, project TEXT, project_id TEXT,
    in_tok INTEGER NOT NULL, cached_in INTEGER NOT NULL, cache_write INTEGER NOT NULL,
    out_tok INTEGER NOT NULL, reasoning_out INTEGER NOT NULL DEFAULT 0,
    speed TEXT, billing_mode TEXT, meter_reset INTEGER, plan_type TEXT, account_id TEXT, source_offset INTEGER
  )`);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function insertEvent(db: Database, patch: Partial<EventValues> = {}): EventValues {
  const event: EventValues = {
    home: "home",
    path: "session.jsonl",
    ts: "2026-09-11T10:00:00Z",
    model: "gpt-6-astra",
    in_tok: 100_000,
    cached_in: 0,
    cache_write: 0,
    out_tok: 0,
    reasoning_out: 0,
    speed: "standard",
    billing_mode: "allowance",
    meter_reset: null,
    plan_type: "pro",
    account_id: null,
    ...patch,
  };
  if (!event.path.includes("/") && !event.path.includes("\\")) event.path = `${event.home}/${event.path}`;
  // A record's offset is its position in its own file, so copies of one file share offsets.
  const offset = (db.query("SELECT COUNT(*) n FROM events WHERE home=? AND path=?").get(event.home, event.path) as { n: number }).n * 100;
  db.query(`INSERT INTO events (
    home,path,ts,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,
    speed,billing_mode,meter_reset,plan_type,account_id,source_offset
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    event.home, event.path, event.ts, event.model, event.in_tok, event.cached_in,
    event.cache_write, event.out_tok, event.reasoning_out, event.speed, event.billing_mode,
    event.meter_reset, event.plan_type, event.account_id, offset,
  );
  return event;
}

type WindowOptions = Parameters<typeof readCodexWindowDetail>[2];

/**
 * Each local home copies an archive folder whose account period names its account (stage 4, W6):
 * the home map of those accounts, with the periods declared in `db`.
 */
function owners(db: Database, homes: Array<[home: string, account: string, folder?: string]>): Map<string, string> {
  const declarations = homes.map(([home, id, folder]) => ({ id, vendor: "codex", source_home: home,
    home: `${ARCHIVE_LOGICAL_ROOT}/codex/${folder ?? home.replace(/[^a-z0-9]+/gi, "-")}` }));
  declareCodexEraPeriods(db, declarations);
  return indexSubscriptionHomes(homes.map(([home, id]) => ({ id, home })), declarations);
}

function readDetail(db: Database, overrides: Partial<WindowOptions> = {}) {
  const defaults: WindowOptions = {
    account,
    homes: ["home"],
    from: "2026-09-11T00:00:00Z",
    until: "2026-09-12T00:00:00Z",
    anchor: null,
    limitId: "codex",
    sessionMinutes: 60,
    homeToSubId: overrides.homeToSubId ?? owners(db, [["home", account]]),
  };
  const options = { ...defaults, ...overrides };
  prepareCodexLedgerFixture(db,card,options.homeToSubId);
  return readCodexWindowDetail(db, card, options);
}

function rowFor(result: ReturnType<typeof readDetail>, model: string, firstDate: string) {
  return result.detail.rows.find((row) => row.model === model && row.first.startsWith(firstDate));
}

test("stored write sums do not claim source completeness for a zero counter", () => {
  const db = database();
  db.exec("ALTER TABLE events ADD COLUMN cache_write_status TEXT DEFAULT 'missing'");
  insertEvent(db, { cached_in: 90_000 });
  const result = readDetail(db);
  expect(result.detail.rows).toHaveLength(1);
  expect(result.detail.rows[0]).toMatchObject({ input: 100_000, cached: 90_000, cache_write: 0, cache_write_complete: false });
});

test("dated Luna and Terra prices change exactly at the 30 July UTC boundary", () => {
  const db = database();
  for (const [model, before, after] of [
    ["gpt-5.6-luna", { api: [1, .1, 6], credits: [25, 2.5, 150] }, { api: [.2, .02, 1.2], credits: [5, .5, 30] }],
    ["gpt-5.6-terra", { api: [2.5, .25, 15], credits: [62.5, 6.25, 375] }, { api: [2, .2, 12], credits: [50, 5, 300] }],
  ] as const) {
    insertEvent(db, { model, ts: "2026-07-29T12:00:00Z", in_tok: 100_000 });
    insertEvent(db, { model, ts: "2026-07-30T12:00:00Z", in_tok: 100_000, path: `${model}-after.jsonl` });
    const result = readDetail(db, {
      from: "2026-07-29T00:00:00Z",
      until: "2026-07-31T00:00:00Z",
    });
    for (const [date, expected] of [["2026-07-29", before], ["2026-07-30", after]] as const) {
      const row = rowFor(result, model, date);
      expect(row).toBeDefined();
      expect([row!.api?.rates.in_uncached, row!.api?.rates.in_cache_read, row!.api?.rates.out_total])
        .toEqual([...expected.api]);
      expect([row!.credits?.rates.in_uncached, row!.credits?.rates.in_cache_read, row!.credits?.rates.out_total])
        .toEqual([...expected.credits]);
      expect(row!.api?.total).toBe(expected.api[0] / 10);
      expect(row!.credits?.total).toBe(expected.credits[0] / 10);
    }
    db.run("DELETE FROM events");
  }
});

test("Astra short and long context are classified per request, not by aggregate input", () => {
  const db = database();
  insertEvent(db, { ts: "2026-09-11T10:00:00Z", in_tok: 200_000 });
  insertEvent(db, { ts: "2026-09-11T11:00:00Z", in_tok: 200_000, path: "short-2.jsonl" });
  insertEvent(db, { ts: "2026-09-11T12:00:00Z", in_tok: 300_000, path: "long.jsonl" });
  const result = readDetail(db);
  const short = result.detail.rows.find((row) => row.model === "gpt-6-astra" && !row.long_context);
  const long = result.detail.rows.find((row) => row.model === "gpt-6-astra" && row.long_context);
  expect(short).toMatchObject({ calls: 2, tokens: 400_000, long_context: false });
  expect(short!.api).toMatchObject({ input: 4, cached: 0, output: 0, total: 4, rates: { in_uncached: 10, in_cache_read: 1, out_total: 50 } });
  expect(long).toMatchObject({ calls: 1, tokens: 300_000, long_context: true });
  expect(long!.api).toMatchObject({ input: 6, cached: 0, output: 0, total: 6, rates: { in_uncached: 20, in_cache_read: 2, out_total: 75 } });
});

test("Standard reference cost stays separate from Fast actual cost; omitted tiers are Standard for API and credits", () => {
  const db = database();
  insertEvent(db, { ts: "2026-09-11T10:00:00Z", path: "standard.jsonl", in_tok: 100_000, out_tok: 100_000, speed: "standard" });
  insertEvent(db, { ts: "2026-09-11T10:01:00Z", path: "fast.jsonl", in_tok: 100_000, out_tok: 100_000, speed: "fast" });
  insertEvent(db, { ts: "2026-09-11T10:02:00Z", path: "unknown.jsonl", in_tok: 100_000, out_tok: 100_000, speed: "priority" });
  const result = readDetail(db);
  const standard = result.detail.rows.find((row) => row.speed === "standard");
  const fast = result.detail.rows.find((row) => row.speed === "fast");
  const unknown = result.detail.rows.find((row) => row.speed === "unknown");
  expect(standard).toMatchObject({ speed: "standard", calls: 2, actual_api: 12 });
  expect(standard!.api?.total).toBe(12);
  expect(standard!.actual_credits).toBeGreaterThan(0);
  expect(fast).toMatchObject({ speed: "fast", actual_api: 12 });
  expect(fast!.api?.total).toBe(6);
  expect(unknown).toBeUndefined();
  expect(result.detail.unknown_speed_tokens).toBe(0);
});

test("cached input is a subset and reasoning output is reported without double charging", () => {
  const db = database();
  insertEvent(db, { in_tok: 100_000, cached_in: 40_000, out_tok: 20_000, reasoning_out: 7_000 });
  const result = readDetail(db);
  const row = result.detail.rows[0]!;
  expect(row).toMatchObject({ calls: 1, input: 100_000, cached: 40_000, output: 20_000, tokens: 120_000, reasoning: 7_000 });
  expect(result.totals).toMatchObject({ calls: 1, tokens: 120_000, tokens_fresh: 80_000 });
  expect(row.api).toMatchObject({ input: .6, cached: .04, output: 1, total: 1.64 });
  expect(row.api!.total).toBeCloseTo(row.api!.input + row.api!.cached + row.api!.output, 12);
});

test("API cache writes are priced once; unknown models and write credits retain missing coverage", () => {
  const db = database();
  const anchor = Date.parse("2026-09-15T00:00:00Z") / 1000;
  insertEvent(db, { path: "valid.jsonl", in_tok: 100_000, out_tok: 20_000 });
  insertEvent(db, { path: "unknown.jsonl", model: "not-shipped-model", in_tok: 100_000, out_tok: 20_000 });
  insertEvent(db, { path: "cache-write.jsonl", in_tok: 200_000, out_tok: 30_000, cache_write: 5 });
  insertEvent(db, { home: "foreign", path: "wrong-owner.jsonl", in_tok: 900_000 });
  insertEvent(db, { path: "spark.jsonl", model: "gpt-5.3-codex-spark", in_tok: 800_000 });
  insertEvent(db, { path: "credits.jsonl", billing_mode: "credits", in_tok: 700_000 });
  insertEvent(db, { path: "meter.jsonl", meter_reset: anchor + 121, in_tok: 600_000 });
  // The reserve tier does not draw on the allowance (the canonical window admission).
  insertEvent(db, { path: "reserve.jsonl", model: "gpt-reserve", in_tok: 500_000 });
  const result = readDetail(db, {
    homes: ["home", "foreign"],
    homeToSubId: owners(db, [["home", account], ["foreign", "someone-else"]]),
    anchor,
  });
  expect(result.totals).toMatchObject({ calls: 3, tokens: 470_000, tokens_fresh: 470_000, usd: 5.5000125 });
  expect(result.unpriced).toEqual({
    tokens: 120_000,
    models: { "not-shipped-model": 120_000 },
  });
  expect(result.detail.excluded_counter_events).toBe(4);
  expect(result.detail.rows).toHaveLength(3);
  expect(result.detail.surfaces).toEqual([{ name: "?", calls: 3, tokens: 470_000, fresh: 470_000, usd: 5.5000125, usd_partial: true }]);
  expect(result.byDate.get("2026-09-11")?.usd_partial).toBe(true);
  expect(result.byBlock.get(10)?.usd_partial).toBe(true);
  const unknown = result.detail.rows.find((row) => row.model === "not-shipped-model")!;
  const cacheWrite = result.detail.rows.find((row) => row.model === "gpt-6-astra" && row.cache_write > 0)!;
  expect(unknown).toMatchObject({ tokens: 120_000, api: null, actual_api: null, unpriced_reason: "missing_rate" });
  expect(cacheWrite).toMatchObject({ tokens: 230_000, cache_write: 5, actual_api: 3.5000125, unpriced_reason: "cache_write_semantics_unknown" });
});

test("model, day and session sums preserve unrounded reference costs", () => {
  const db = database();
  const from = "2026-09-11T10:00:00Z";
  insertEvent(db, { ts: "2026-09-11T10:10:00Z", path: "astra-1.jsonl", in_tok: 123_456, out_tok: 234_567 });
  insertEvent(db, { model: "gpt-5.6-luna", ts: "2026-09-11T11:10:00Z", path: "luna.jsonl", in_tok: 234_567, out_tok: 345_678 });
  insertEvent(db, { ts: "2026-09-11T11:20:00Z", path: "astra-2.jsonl", in_tok: 111_111, out_tok: 222_222 });
  insertEvent(db, { model: "gpt-5.6-terra", ts: "2026-09-11T12:10:00Z", path: "terra.jsonl", in_tok: 145_678, out_tok: 456_789 });
  const result = readDetail(db, { from, until: "2026-09-11T13:00:00Z" });
  const expected = { astra: 25.18512, luna: .461727, terra: 5.772824, total: 31.419671 };
  expect(result.detail.rows.find((row) => row.model === "gpt-6-astra")!.api!.total).toBeCloseTo(expected.astra, 12);
  expect(result.detail.rows.find((row) => row.model === "gpt-5.6-luna")!.api!.total).toBeCloseTo(expected.luna, 12);
  expect(result.detail.rows.find((row) => row.model === "gpt-5.6-terra")!.api!.total).toBeCloseTo(expected.terra, 12);
  expect(result.totals.usd).toBeCloseTo(expected.total, 12);
  expect(result.byDate.get("2026-09-11")!.usd).toBeCloseTo(expected.total, 12);
  expect(result.byBlock.get(0)!.usd).toBeCloseTo(12.96291, 12);
  expect(result.byBlock.get(1)!.usd).toBeCloseTo(12.683937, 12);
  expect(result.byBlock.get(2)!.usd).toBeCloseTo(5.772824, 12);
  expect(result.totals.usd).not.toBe(Math.round(expected.total * 100) / 100);
  expect(result.detail.rows.reduce((sum, row) => sum + (row.api?.total ?? 0), 0)).toBeCloseTo(result.totals.usd, 12);
  expect(result.detail.surfaces!.reduce((sum, row) => sum + row.tokens, 0)).toBe(result.totals.tokens);
  expect(result.detail.surfaces!.reduce((sum, row) => sum + row.usd, 0)).toBeCloseTo(result.totals.usd, 12);
});

test("exclusive end omits the boundary and inclusiveEnd includes exactly that event", () => {
  const db = database();
  insertEvent(db, { ts: "2026-09-11T10:59:59Z", path: "before.jsonl" });
  insertEvent(db, { ts: "2026-09-11T11:00:00Z", path: "boundary.jsonl" });
  const options = { from: "2026-09-11T10:00:00Z", until: "2026-09-11T11:00:00Z" };
  expect(readDetail(db, options).totals.calls).toBe(1);
  expect(readDetail(db, { ...options, inclusiveEnd: true }).totals.calls).toBe(2);
});

test("offset timestamps use exact instants for admission, endpoint policy and burn buckets",()=>{
  const db=database();
  for (const [ts,path,in_tok] of [
    ["2026-09-11T12:00:00+02:00","plus.jsonl",100],
    ["2026-09-11T08:00:00-02:00","minus.jsonl",200],
    ["2026-09-10T23:30:00-11:00","previous-date.jsonl",300],
    ["2026-09-11T11:00:00+02:00","start.jsonl",400],
    ["2026-09-11T13:00:00+02:00","end.jsonl",500],
    ["2026-09-11T14:00:00+02:00","outside.jsonl",600],
  ] as const) insertEvent(db,{ts,path,in_tok});
  const options={from:"2026-09-11T09:00:00Z",until:"2026-09-11T11:00:00Z"};
  const exclusive=readDetail(db,options);
  expect(exclusive.totals).toMatchObject({calls:4,tokens:1000});
  expect(exclusive.byBlock.get(0)).toMatchObject({calls:1,tokens:400});
  expect(exclusive.byBlock.get(1)).toMatchObject({calls:3,tokens:600});
  expect(exclusive.detail.rows[0]).toMatchObject({first:"2026-09-11T11:00:00+02:00",last:"2026-09-10T23:30:00-11:00"});
  expect(exclusive.burn.find(row=>row.label==="1h")).toMatchObject({calls:3,tokens:600});
  expect(readDetail(db,{from:"2026-09-11T11:00:00+02:00",until:"2026-09-11T13:00:00+02:00"}).totals).toEqual(exclusive.totals);
  const inclusive=readDetail(db,{...options,inclusiveEnd:true});
  expect(inclusive.totals).toMatchObject({calls:5,tokens:1500});
  expect(inclusive.detail.rows[0]!.last).toBe("2026-09-11T13:00:00+02:00");
  expect(inclusive.burn.find(row=>row.label==="1h")).toMatchObject({calls:4,tokens:1100});
});

test("a copy written with another zone offset is one call; the project filter sees the canonical copy",()=>{
  const db=database(),sourceHome="c:/source/.codex",archiveHome="c:/archive";
  const declarations=[sourceHome,archiveHome].map(source_home=>({id:account,vendor:"codex",source_home,home:`${ARCHIVE_LOGICAL_ROOT}/codex/main`}));
  declareCodexEraPeriods(db,declarations);
  const homeToSubId=indexSubscriptionHomes([{id:account,home:archiveHome,source_home:sourceHome}],declarations);
  insertEvent(db,{home:sourceHome,path:`${sourceHome}/session.jsonl`,ts:"2026-09-11T12:00:00+02:00",in_tok:100});
  insertEvent(db,{home:sourceHome,path:`${sourceHome}/session.jsonl`,ts:"2026-09-11T12:01:00+02:00",in_tok:200});
  insertEvent(db,{home:archiveHome,path:`${archiveHome}/session.jsonl`,ts:"2026-09-11T08:00:00-02:00",in_tok:100});
  // Each copy's place names another project; the rules map them to projects 7 and 8.
  db.query("UPDATE events SET project=? WHERE home=?").run("p7",archiveHome);
  db.query("UPDATE events SET project=? WHERE home=?").run("p8",sourceHome);
  overrideProjectRules(db,{projects:[{id:"7",name:"Seven",matches:[{project:"p7"}]},{id:"8",name:"Eight",matches:[{project:"p8"}]}]});
  const options={homes:[sourceHome,archiveHome],homeToSubId,from:"2026-09-11T09:00:00Z",until:"2026-09-11T11:00:00Z"};
  expect(readDetail(db,options).totals).toMatchObject({calls:2,tokens:300});
  // The archive copy is canonical (least source key), so the shared call carries its project.
  const selected=readDetail(db,{...options,project:"7"});
  expect(selected.totals.calls).toBe(1);
  expect(selected.detail.excluded_mirror_events).toBe(0);
});

test("an offset event on the previous lexical date is read again in its exact window after a correction",()=>{
  const db=database(),homeToSubId=owners(db,[["home",account]]);
  insertEvent(db,{ts:"2026-09-10T23:30:00-11:00",in_tok:100});
  prepareCodexLedgerFixture(db,card,homeToSubId);
  const options={homeToSubId,from:"2026-09-11T09:00:00Z",until:"2026-09-11T11:00:00Z"};
  expect(readDetail(db,options).totals).toMatchObject({calls:1,tokens:100});
  db.exec("UPDATE events SET in_tok=200");
  expect(readDetail(db,options).totals).toMatchObject({calls:1,tokens:200});
});

test("shared ledger ownership uses accepted instants across an account cut while retaining offset evidence",()=>{
  const db=database(),archiveHome=`${ARCHIVE_LOGICAL_ROOT}/codex/home`;
  const declarations=[{id:"old",vendor:"codex",home:archiveHome,source_home:"home",until:"2026-09-11T10:15:00Z"},
    {id:account,vendor:"codex",home:archiveHome,source_home:"home",from:"2026-09-11T10:15:00Z"}];
  declareCodexEraPeriods(db,declarations);
  const homeToSubId=indexSubscriptionHomes([{id:account,home:"home"}],declarations);
  insertEvent(db,{ts:"2026-09-11T12:00:00+02:00",in_tok:100});
  insertEvent(db,{ts:"2026-09-11T08:30:00-02:00",in_tok:200});
  insertEvent(db,{ts:"2026-09-11T12:15:00+02:00",in_tok:300});
  prepareCodexLedgerFixture(db,card,homeToSubId);
  const resolver=loadAccountResolver(db),ledger=codexLedgerReadContext(card);
  const rows=readCodexEventRange(db,resolveCodexAccountingConfig(card),"2026-09-11T09:00:00Z","2026-09-11T11:00:00Z",
    event=>resolveCodexLedgerEventOwner(resolver,event),ledger);
  expect(rows.map(row=>[row.ts,row.account]).sort()).toEqual([
    ["2026-09-11T08:30:00-02:00",account],["2026-09-11T12:00:00+02:00","old"],["2026-09-11T12:15:00+02:00",account],
  ]);
  expect(readDetail(db,{homeToSubId,from:"2026-09-11T09:00:00Z",until:"2026-09-11T11:00:00Z"}).totals).toMatchObject({calls:2,tokens:500});
  expect(resolveCodexLedgerEventOwner(resolver,{source:null,instant_ms:Date.parse("2026-09-11T10:30:00Z")})).toBeNull();
  expect(resolveCodexLedgerEventOwner(resolver,{source:"codex/home",instant_ms:null})).toBeNull();
});

test("equivalent declaration IDs keep published token coefficients and their original provenance",()=>{
  const db=database(),homeToSubId=owners(db,[["home",account]]);
  insertEvent(db,{in_tok:100_000});
  prepareCodexLedgerFixture(db,card,homeToSubId);
  const options={account,homes:["home"],homeToSubId,from:"2026-09-11T00:00:00Z",until:"2026-09-12T00:00:00Z",anchor:null,limitId:"codex",sessionMinutes:60};
  const before=readCodexWindowDetail(db,card,options),facts=db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
  const policy=structuredClone(codexLedgerReadContext(card).policy.policy);
  policy.base_rules=policy.base_rules.map(rule=>({...rule,id:`renamed-${rule.id}`,sources:["https://example.test/new-declaration"],confidence:"user"}));
  const updated={...card,codex_ledger_policy:policy},context=codexLedgerReadContext(updated);
  db.query("UPDATE usage_ledger_state SET rules_digest=?,rules_json=? WHERE provider='codex'").run(context.rulesRevision!,JSON.stringify(policy));
  const after=readCodexWindowDetail(db,updated,options);
  expect(after.detail.rows[0]!.api).toEqual(before.detail.rows[0]!.api);
  expect(after.detail.rows[0]!.credits).toEqual(before.detail.rows[0]!.credits);
  expect(after.totals).toEqual(before.totals);
  expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(facts);
});

test("mirror duplicates are removed using the existing source/archive winner helper", () => {
  const db = database();
  const sourceHome = "c:/source/.codex";
  const archiveHome = "c:/archive";
  // Both directories copy the same archive folder: one source, so one rollout.
  const declarations = [sourceHome, archiveHome].map(source_home => ({ id: account, vendor: "codex", source_home, home: `${ARCHIVE_LOGICAL_ROOT}/codex/main` }));
  declareCodexEraPeriods(db, declarations);
  const homeToSubId = indexSubscriptionHomes([{ id: account, home: archiveHome, source_home: sourceHome }], declarations);
  insertEvent(db, { home: sourceHome, path: `${sourceHome}/session.jsonl`, ts: "2026-09-11T10:00:00Z", in_tok: 10 });
  insertEvent(db, { home: sourceHome, path: `${sourceHome}/session.jsonl`, ts: "2026-09-11T10:01:00Z", in_tok: 20 });
  insertEvent(db, { home: archiveHome, path: `${archiveHome}/session.jsonl`, ts: "2026-09-11T10:00:00Z", in_tok: 10 });
  const result = readDetail(db, {
    homes: [sourceHome, archiveHome],
    homeToSubId,
  });
  expect(result.detail.excluded_mirror_events).toBe(1);
  expect(result.totals).toMatchObject({ calls: 2, tokens: 30 });
  expect(result.detail.rows).toHaveLength(1);
  expect(result.detail.rows[0]!.first).toBe("2026-09-11T10:00:00Z");
});

test("durable window facts match raw boundaries and a correction reprices only its event",()=>{
  const db=database();
  insertEvent(db,{ts:"2026-09-11T23:59:59Z"});
  insertEvent(db,{ts:"2026-09-12T00:00:00.000Z",path:"day2"});
  const options={from:"2026-09-11T00:00:00Z",until:"2026-09-13T00:00:00Z",inclusiveEnd:true};
  const expected=readDetail(db,options);
  expect(readDetail(db,options)).toEqual(expected);
  const before=db.query("SELECT source_offset,day,api_whole,api_fraction_hi,api_fraction_lo FROM codex_price_ledger_events ORDER BY source_offset").all();
  db.exec("UPDATE events SET in_tok=in_tok+100 WHERE ts='2026-09-12T00:00:00.000Z'");
  readDetail(db,options);
  const after=db.query("SELECT source_offset,day,api_whole,api_fraction_hi,api_fraction_lo FROM codex_price_ledger_events ORDER BY source_offset").all();
  expect(after.length).toBe(2);expect(after.filter((row,i)=>JSON.stringify(row)!==JSON.stringify(before[i])).length).toBe(1);
});

test("burn windows read only the last 168 hours",()=>{
  const db=database();
  const homeToSubId=owners(db,[["home",account]]);
  // `until` is in the past, so the burn clock is pinned to it and the expectation is exact.
  const until="2026-09-12T00:00:00Z",end=Date.parse(until);
  const inserted=[
    {hoursBefore:0.5,in_tok:1_000,cached_in:400,out_tok:100},
    {hoursBefore:3,in_tok:2_000,cached_in:0,out_tok:200},
    {hoursBefore:20,in_tok:3_000,cached_in:1_000,out_tok:300},
    {hoursBefore:100,in_tok:4_000,cached_in:0,out_tok:400},
    {hoursBefore:200,in_tok:5_000,cached_in:0,out_tok:500},           // outside every burn window
    {hoursBefore:2,in_tok:6_000,cached_in:0,out_tok:600,billing_mode:"credits"},   // excluded from the counter
    {hoursBefore:2,in_tok:7_000,cached_in:0,out_tok:700,account_id:"other",model:"gpt-5.3-codex-spark"}, // spark, excluded
  ];
  for(const row of inserted) insertEvent(db,{ts:new Date(end-row.hoursBefore*3600000).toISOString(),
    path:`s-${row.hoursBefore}.jsonl`,in_tok:row.in_tok,cached_in:row.cached_in,out_tok:row.out_tok,
    ...(row.billing_mode?{billing_mode:row.billing_mode}:{}),...(row.model?{model:row.model}:{})});
  const expected=[1,6,24,168].map(hours=>{
    const admitted=inserted.filter(row=>!row.billing_mode&&!row.model&&row.hoursBefore<=hours&&row.hoursBefore<=300);
    return {label:hours===168?"7d":`${hours}h`,hours,calls:admitted.length,
      tokens:admitted.reduce((sum,row)=>sum+row.in_tok+row.out_tok,0),
      tokens_fresh:admitted.reduce((sum,row)=>sum+row.in_tok+row.out_tok-row.cached_in,0)};
  });
  // Guard the reference itself: the windows must actually separate the events.
  expect(expected.map(w=>[w.label,w.calls,w.tokens,w.tokens_fresh])).toEqual(
    [["1h",1,1100,700],["6h",2,3300,2900],["24h",3,6600,5200],["7d",4,11000,9600]]);
  const options={from:"2026-09-01T00:00:00Z",until,homeToSubId};
  expect(readDetail(db,options).burn).toEqual(expected);
});

test("a burn window crossing midnight counts both sides of the day boundary",()=>{
  const db=database();
  const until="2026-09-12T02:00:00Z",end=Date.parse(until);
  insertEvent(db,{ts:"2026-09-11T23:30:00Z",path:"before.jsonl",in_tok:1_000,cached_in:0,out_tok:0});
  insertEvent(db,{ts:"2026-09-12T01:30:00Z",path:"after.jsonl",in_tok:2_000,cached_in:0,out_tok:0});
  const burn=readDetail(db,{from:"2026-09-11T00:00:00Z",until}).burn;
  expect(Date.parse(until)).toBe(end);
  expect(burn.find(w=>w.label==="1h")).toMatchObject({calls:1,tokens:2_000});
  expect(burn.find(w=>w.label==="6h")).toMatchObject({calls:2,tokens:3_000});
});
