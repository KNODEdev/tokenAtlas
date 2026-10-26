import { prepareProbeReaderFixture, splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rebaseArchivePaths } from "../db/rebase";
import { applyDrizzleMigrations } from "../db/migrate";
import { ledgerRevision } from "../db/ledger-revision";
import { createFetchHandler, handleEraTimelines, type AppContext } from "./api";
import { buildEraIndex } from "./eras";
import type { RateCard } from "./pricing";
import { subscriptionDailyUsage, SubscriptionUsageUnavailable } from "./subscription-usage";
import { handleHistoryCoverage } from "./history-coverage";
import { declareClaudeLabelPeriods } from "./subscription-reader.fixture";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { prepareUsageRegisters } from "./usage-register.fixture";

/** The Codex archive folder whose account period names codex1 (stage 4, W6). */
const CODEX = `${ARCHIVE_LOGICAL_ROOT}/codex/c`;

const dbs: Database[] = [];
const dirs: string[] = [];
const cards: RateCard = {
  version: 1, currency: "USD", unit: "per 1M",
  vendors: {
    openai: { models: { test: { in_uncached: 2, in_cache_read: 1, in_cache_write: 3, out_total: 8 } } },
    anthropic: { models: { test: { in_uncached: 2, in_cache_read: 1, in_cache_write_5m: 3, in_cache_write_1h: 4, out_total: 8 } } },
  },
};

function open(file = ":memory:"): Database {
  const db = new Database(file);
  dbs.push(db);
  return db;
}

function fixture(file = ":memory:"): Database {
  const db = open(file);
  applyDrizzleMigrations(drizzle(db));
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT, model TEXT,
      in_tok INTEGER DEFAULT 0, cached_in INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
      out_tok INTEGER DEFAULT 0, reasoning_out INTEGER DEFAULT 0
    );

    INSERT INTO claude_events (store, call_id, ts, path, subscription_id, model, in_uncached, in_cache_read,
                               in_cache_write, cache_write_5m, cache_write_1h, out_total)
      VALUES ('C:/claude', '1', '2026-08-10T10:00:00.000Z', 'C:/claude/a.jsonl', 'claude1', 'test', 100, 20, 30, 10, 20, 50),
             ('C:/claude', '2', '2026-08-11T10:00:00.000Z', 'C:/claude/a.jsonl', 'claude2', 'unknown', 200, 10, 5, 5, 0, 30),
             ('C:/other', '3', '2026-08-10T10:00:00.000Z', 'C:/other/b.jsonl', 'claude1', 'test', 7, 2, 0, 0, 0, 1),
             ('C:/unassigned', '4', '2026-08-10T10:00:00.000Z', 'C:/unassigned/a.jsonl', NULL, 'test', 999, 0, 0, 0, 0, 0);
    INSERT INTO gemini_events (store, conversation_id, gen_idx, ts, ts_basis, path, fresh_in, cached_in, out_total, usd)
      VALUES ('source:gemini:profile', '1', 0, '2026-08-10T10:00:00.000Z', 'event', '${ARCHIVE_LOGICAL_ROOT}/gemini/profile/a', 11, 22, 33, 1.25);
    INSERT INTO grok_events (store, session_id, prompt_id, ts, path, model, in_tok, cached_in, cache_write, out_tok, cost_ticks)
      VALUES ('source:grok:profile', 's', 'p', '2026-08-10T10:00:00.000Z', '${ARCHIVE_LOGICAL_ROOT}/grok/profile/a', 'grok-4', 44, 5, 6, 7, 10000);
    INSERT INTO oc_events (store, message_id, ts, in_tok, out_tok, cache_read, cache_write, cost)
      VALUES ('oc1', 'a', '2026-08-10T10:00:00.000Z', 10, 20, 30, 40, 0.75),
             ('oc2', 'b', '2026-08-10T10:00:00.000Z', 1, 2, 3, 4, 0.25);
    UPDATE oc_events SET provider='zai';
  `);
  const codex = db.query("INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  // Codex is priced by the dated accounting rules (the register's standard API variant), not the card's test model.
  codex.run(CODEX, `${CODEX}/a.jsonl`, "2026-08-10T10:00:00.000Z", "gpt-5.6-luna", 100, 20, 5, 40);
  codex.run(CODEX, `${CODEX}/a.jsonl`, "2026-08-11T10:00:00.000Z", "unknown", 90, 30, 4, 12);
  // Claude's account comes from the period of each session's archive folder (stage 4, W4), Codex's from
  // the period of its home's folder (W6).
  declareClaudeLabelPeriods(db);
  declareCodexEraPeriods(db, [{ id: "codex1", vendor: "codex", home: CODEX }]);
  replaceDeclaredPeriods(db,ACCOUNT_PERIODS,[...loadPeriods(db,ACCOUNT_PERIODS).filter(row => row.origin === "declared"),
    ...[{provider:"gemini",subject:"gemini/profile",value:"agy1"},
      {provider:"grok",subject:"grok/profile",value:"grok1"},
      {provider:"glm",subject:"glm/oc1",value:"opencode"},
      {provider:"glm",subject:"glm/oc2",value:"opencode"}].map(row => ({...row,from:"2000-01-01",until:null,
        origin:"declared" as const,firstSeen:null,lastSeen:null,readings:0,evidence:"fixture"}))]);
  prepareUsageRegisters(db, cards);
  return db;
}

function normalized(value: ReturnType<typeof subscriptionDailyUsage>) {
  return [...value].sort(([a], [b]) => a.localeCompare(b)).map(([id, rows]) => [id,
    [...rows].sort((a, b) => `${a.day}:${a.source}`.localeCompare(`${b.day}:${b.source}`)),
  ]);
}

afterEach(() => {
  // Finalize prepared statements too, so Windows can release fixture file handles.
  for (const db of dbs.splice(0)) db.close(true);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable subscription usage", () => {
  test.each(["", "_01a090b3-5dbf-72b3-8d70-0826afb55979"])("session and archive copies contribute once to the subscription totals: %s", (fork) => {
    const sqlite = fixture();
    sqlite.exec("DELETE FROM events");
    const filename = `rollout-2026-08-10T10-00-00-01a0859f-796c-7052-9ea9-36c9a7c7caad${fork}.jsonl`;
    for (const folder of ["sessions/2026/08/10", "archived_sessions"]) {
      sqlite.query("INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES (?,?,'2026-08-10T10:00:00Z','test',100,20,5,40)").run(CODEX, `${CODEX}/${folder}/${filename}`);
    }
    prepareUsageRegisters(sqlite, cards);
    const ctx = { sqlite, rateCards: cards };
    const days = subscriptionDailyUsage(ctx).get("codex1")!;
    expect(days.reduce((n, day) => n + day.calls, 0)).toBe(1);
    expect(days.reduce((n, day) => n + day.tokens, 0)).toBe(140);
  });
  test("migration prepares five provider registers with period-owned physical sources", () => {
    const sqlite = fixture();
    const ctx = { sqlite, rateCards: cards };
    const registered = subscriptionDailyUsage(ctx);
    expect([...registered.keys()].sort()).toEqual(["agy1","claude1","claude2","codex1","grok1","opencode"]);
    expect(registered.get("agy1")?.[0]).toMatchObject({tokens:66,calls:1,unpriced_calls:1,
      source:`${ARCHIVE_LOGICAL_ROOT}/gemini/profile`});
    expect(registered.get("grok1")?.[0]).toMatchObject({tokens:57,calls:1,unpriced_calls:1,
      source:`${ARCHIVE_LOGICAL_ROOT}/grok/profile`});
    expect(registered.get("opencode")?.reduce((sum,row)=>sum+row.tokens,0)).toBe(110);
    // Both claude1 sessions of 10.08 are in one archive folder: one source, one row.
    expect(subscriptionDailyUsage(ctx).get("claude1")).toHaveLength(1);
    expect(registered.get("opencode")).toHaveLength(2);
  });

  test("late data replaces only affected days and agrees with a full refill", () => {
    const sqlite = fixture();
    sqlite.exec("UPDATE claude_events SET in_uncached = 123 WHERE call_id = '1'");
    prepareUsageRegisters(sqlite, cards);
    const incremental = normalized(subscriptionDailyUsage({ sqlite, rateCards: cards }));
    expect(subscriptionDailyUsage({sqlite,rateCards:cards}).get("claude1")?.[0]?.tokens).toBe(233);
    for (const table of ["usage_ledger_facts","usage_ledger_days","usage_ledger_hours","usage_ledger_day_reasons","usage_ledger_dirty",
      "usage_ledger_dims","usage_ledger_keys","usage_ledger_state"]) sqlite.exec("DELETE FROM " + table + " WHERE provider<>'codex'");
    prepareUsageRegisters(sqlite, cards);
    expect(normalized(subscriptionDailyUsage({ sqlite, rateCards: cards }))).toEqual(incremental);
  });

  test("Gemini physical store follows a corrected period without touching raw events or valuations", () => {
    const sqlite = fixture();
    const before = subscriptionDailyUsage({sqlite,rateCards:cards});
    expect(before.get("agy1")?.[0]).toMatchObject({tokens:66,calls:1});
    const raw = sqlite.query("SELECT store,path,fresh_in,cached_in,out_total FROM gemini_events").all();
    const contributions = sqlite.query("SELECT * FROM usage_ledger_facts WHERE provider='gemini' ORDER BY row_id").all();
    replaceDeclaredPeriods(sqlite,ACCOUNT_PERIODS,loadPeriods(sqlite,ACCOUNT_PERIODS).filter(row=>row.origin==="declared")
      .map(row=>row.provider==="gemini"?{...row,value:"agy2"}:row));
    const after = subscriptionDailyUsage({sqlite,rateCards:cards});
    expect(after.has("agy1")).toBe(false);
    expect(after.get("agy2")?.[0]).toMatchObject({tokens:66,calls:1,
      source:`${ARCHIVE_LOGICAL_ROOT}/gemini/profile`});
    expect(sqlite.query("SELECT store,path,fresh_in,cached_in,out_total FROM gemini_events").all()).toEqual(raw);
    expect(sqlite.query("SELECT * FROM usage_ledger_facts WHERE provider='gemini' ORDER BY row_id").all()).toEqual(contributions);
  });

  test("reopen and GET need no raw tables of the projected vendors and do not rebuild", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-subscription-projection-"));
    dirs.push(dir);
    const file = path.join(dir, "atlas.sqlite");
    const original = fixture(file);
    const expected = normalized(subscriptionDailyUsage({ sqlite: original, rateCards: cards }));
    original.close(true);
    dbs.splice(dbs.indexOf(original), 1);
    const sqlite = open(file);
    const stamp = ledgerRevision(sqlite);
    // Claude and Codex are not in the projection: their accounts are resolved at read time from their own events.
    sqlite.exec("DROP TABLE gemini_events; DROP TABLE grok_events; DROP TABLE oc_events;");
    expect(normalized(subscriptionDailyUsage({ sqlite, rateCards: cards }))).toEqual(expected);
    const subscriptions = [{ id: "claude1", vendor: "claude", home: "C:/claude", account: "same@example.test" }];
    prepareProbeReaderFixture(sqlite,[]);
    const ctx = {
      sqlite, rateCards: cards, accounts: splitProbeReaderFixtureConfig(subscriptions), homeToSubId: new Map(), subIdToHomes: new Map(),
      eras: buildEraIndex(subscriptions), eraErrors: [], claudeGauge: {}, grokGauge: {},
    } as unknown as AppContext;
    const response = await createFetchHandler(ctx)(new Request("http://test/api/era-timelines"));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Usage-Source")).toBe("register-v8");
    expect((await response.json()).subscriptions[0].segments[0].stats.tokens).toBeGreaterThan(0);
    expect(ledgerRevision(sqlite)).toBe(stamp);
  });

  test("missing pricing retains tokens and current rate-card edits require no fact rebuild", () => {
    const sqlite = fixture();
    const facts = sqlite.query("SELECT * FROM usage_ledger_facts ORDER BY provider,row_id").all().length;
    const withoutPrices: RateCard = { ...cards, vendors: {}, codex_accounting: { version: 1, rules: [] } };
    // A rate-card edit re-prices the register in the background; until then the view is preparing.
    expect(() => subscriptionDailyUsage({ sqlite, rateCards: withoutPrices })).toThrow("awaiting background preparation");
    prepareUsageRegisters(sqlite, withoutPrices);
    const unpriced = subscriptionDailyUsage({ sqlite, rateCards: withoutPrices }).get("codex1")![0]!;
    expect(unpriced.tokens).toBe(140);
    expect(unpriced.unpriced_tokens).toBe(140);
    expect(unpriced.unpriced_calls).toBe(1);
    prepareUsageRegisters(sqlite, cards);
    const priced = subscriptionDailyUsage({ sqlite, rateCards: cards }).get("codex1")![0]!;
    expect(priced.usd).toBeGreaterThan(0);
    expect(priced.unpriced_calls).toBe(0);
    expect(sqlite.query("SELECT * FROM usage_ledger_facts ORDER BY provider,row_id").all().length).toBe(facts);
  });

  test("a Claude account follows the period of its source, not a stamp", () => {
    const sqlite = fixture();
    const ctx = { sqlite, rateCards: cards };
    expect(subscriptionDailyUsage(ctx).has("claude1")).toBe(true);
    expect(subscriptionDailyUsage(ctx).has("claude2")).toBe(true);
    expect(subscriptionDailyUsage(ctx).has("c:/unassigned")).toBe(false);
    // A label on the event names nothing; the period of its folder does, with no rebuild.
    sqlite.exec("UPDATE claude_events SET subscription_id = 'claude3' WHERE call_id = '2'");
    prepareUsageRegisters(sqlite, cards);
    expect(subscriptionDailyUsage(ctx).has("claude2")).toBe(true);
    replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, loadPeriods(sqlite, ACCOUNT_PERIODS)
      .map(period => period.value === "claude2" ? { ...period, value: "claude3" } : period));
    expect(subscriptionDailyUsage(ctx).has("claude2")).toBe(false);
    expect(subscriptionDailyUsage(ctx).get("claude3")![0]!.day).toBe("2026-08-11");
  });

});


test("snapshot path rebasing preserves the source provenance of resolved and projected usage", () => {
  const sqlite = fixture();
  const moved = `${ARCHIVE_LOGICAL_ROOT}/codex/d`;
  declareCodexEraPeriods(sqlite, [{ id: "codex1", vendor: "codex", home: moved }]);
  rebaseArchivePaths(sqlite, CODEX, moved);
  prepareUsageRegisters(sqlite, cards);
  const ctx = { sqlite, rateCards: cards };
  const before = subscriptionDailyUsage(ctx);
  expect(before.get("codex1")?.[0]?.source).toBe(moved);
  expect(subscriptionDailyUsage(ctx).get("codex1")![0]!.source).toBe(moved);
  expect(before.get("agy1")![0]!.source).toBe(`${ARCHIVE_LOGICAL_ROOT}/gemini/profile`);
});

test("a populated schema-0019 index upgrades once and never advertises an empty current projection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-projection-migration-"));
  dirs.push(dir);
  const migrations = path.resolve(import.meta.dir, "../../drizzle");
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  journal.entries = journal.entries.filter(entry => entry.idx < 20);
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) fs.copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  const sqlite = open();
  const db = drizzle(sqlite);
  applyDrizzleMigrations(db, dir);
  sqlite.exec(`INSERT INTO claude_events (store,call_id,ts,path,subscription_id,in_uncached)
    VALUES ('test','1','2026-08-01T00:00:00.000Z','archive/claude/a','claude1',100)`);
  applyDrizzleMigrations(db);
  declareClaudeLabelPeriods(sqlite);
  prepareUsageRegisters(sqlite, cards);
  expect(subscriptionDailyUsage({ sqlite, rateCards: cards }).get("claude1")![0]!.tokens).toBe(100);
  const stamp = ledgerRevision(sqlite);
  applyDrizzleMigrations(db);
  expect(ledgerRevision(sqlite)).toBe(stamp);
});

test("many grouped calls retain exact counters and pricing within floating-point precision", () => {
  const sqlite = fixture();
  const rateCards: RateCard = {
    ...cards,
    vendors: {
      ...cards.vendors,
      anthropic: { models: { test: {
        in_uncached: 2, in_cache_read: 1, in_cache_write_5m: 3, in_cache_write_1h: 4, out_total: 8,
        fast: { in_uncached: 12, in_cache_read: 6, in_cache_write_5m: 18, in_cache_write_1h: 24, out_total: 48 },
      } } },
    },
  };
  const insert = sqlite.query(`INSERT INTO claude_events (store,call_id,ts,path,subscription_id,model,speed,
    in_uncached,in_cache_read,in_cache_write,cache_write_5m,cache_write_1h,out_total)
    VALUES ('C:/claude',?,?,?,?,?,?,?,?,?,?,?,?)`);
  // Only these calls, each in its account's archive folder (whose period the fixture declared).
  sqlite.exec("DELETE FROM claude_events");
  sqlite.transaction(() => {
    for (let i = 1; i <= 700; i++) {
      const day = String(1 + i % 28).padStart(2, "0"), account = i % 2 ? "claude1" : "claude2";
      insert.run(`grouped-${i}`, `2026-08-${day}T10:00:00.000Z`, `${ARCHIVE_LOGICAL_ROOT}/claude/${account}/${i % 3}.jsonl`,
        account, i % 5 ? "test" : "unknown", i % 4 ? "standard" : "fast",
        i * 3, i * 2, i % 5 + i % 7, i % 5, i % 7, i % 17);
    }
  })();
  prepareUsageRegisters(sqlite, rateCards);
  const ctx = { sqlite, rateCards };
  const actual = subscriptionDailyUsage(ctx);
  expect([...actual.keys()].sort()).toEqual(["agy1","claude1","claude2","codex1","grok1","opencode"]);
  // Hand-computed from the inserted calls: tokens of every bucket, dollars of the priced model at its speed.
  type Day = { calls: number; tokens: number; usd: number; unpriced_calls: number; unpriced_tokens: number };
  const expected = new Map<string, Day>();
  const rates = { standard: [2, 1, 3, 4, 8], fast: [12, 6, 18, 24, 48] };
  for (let i = 1; i <= 700; i++) {
    const key = `${i % 2 ? "claude1" : "claude2"} 2026-08-${String(1 + i % 28).padStart(2, "0")}`;
    const quantities = [i * 3, i * 2, i % 5, i % 7, i % 17];
    const tokens = quantities.reduce((n, value) => n + value, 0), priced = i % 5 !== 0;
    const price = rates[i % 4 ? "standard" : "fast"].reduce((n, rate, index) => n + rate * quantities[index]!, 0) / 1_000_000;
    const day = expected.get(key) ?? { calls: 0, tokens: 0, usd: 0, unpriced_calls: 0, unpriced_tokens: 0 };
    day.calls++; day.tokens += tokens;
    if (priced) day.usd += price; else { day.unpriced_calls++; day.unpriced_tokens += tokens; }
    expected.set(key, day);
  }
  const read = new Map<string, Day>();
  for (const id of ["claude1", "claude2"]) for (const row of actual.get(id)!) {
    const key = `${id} ${row.day}`, day = read.get(key) ?? { calls: 0, tokens: 0, usd: 0, unpriced_calls: 0, unpriced_tokens: 0 };
    day.calls += row.calls; day.tokens += row.tokens; day.usd += row.usd;
    day.unpriced_calls += row.unpriced_calls; day.unpriced_tokens += row.unpriced_tokens;
    read.set(key, day);
  }
  expect([...read.keys()].sort()).toEqual([...expected.keys()].sort());
  const differing = [...expected].filter(([key, day]) => {
    const got = read.get(key)!;
    return JSON.stringify({ ...got, usd: 0 }) !== JSON.stringify({ ...day, usd: 0 }) || Math.abs(got.usd - day.usd) > 1e-10;
  }).map(([key, day]) => ({ key, expected: day, read: read.get(key) }));
  expect(differing).toEqual([]);
});

test("Codex and Claude usage is never a silent zero: an unprepared register is pending, missing inputs are unavailable", async () => {
  const pending = open();
  applyDrizzleMigrations(drizzle(pending));
  pending.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT, model TEXT, in_tok INTEGER, out_tok INTEGER)");
  pending.query("INSERT INTO events(home,path,ts,model,in_tok,out_tok) VALUES (?,?,'2026-08-10T10:00:00.000Z','gpt-5.6-luna',10,1)").run(CODEX, `${CODEX}/a.jsonl`);
  declareCodexEraPeriods(pending, [{ id: "codex1", vendor: "codex", home: CODEX }]);
  expect(() => subscriptionDailyUsage({ sqlite: pending, rateCards: cards })).toThrow("awaiting background preparation");
  // Registers that can never be prepared (no Codex table; a card the Claude register cannot price with)
  // make the answer unavailable instead of zero.
  const missing = open();
  applyDrizzleMigrations(drizzle(missing));
  const unsupported = { ...cards, unit: "per_million_tokens" };
  let raised: unknown;
  try { subscriptionDailyUsage({ sqlite: missing, rateCards: unsupported }); } catch (error) { raised = error; }
  expect(raised).toBeInstanceOf(SubscriptionUsageUnavailable);
  expect((raised as SubscriptionUsageUnavailable).providers).toEqual([{ provider: "codex", reason: "usage-price-inputs-unavailable" },
    ...(["claude","gemini","grok","glm"] as const).map(provider => ({provider,reason:"usage-price-unsupported-currency-or-unit"}))]);
  // The views answer with their existing failed state, not a timeline of zeros.
  const subscriptions = [{ id: "codex1", vendor: "codex", home: CODEX }];
  const ctx = { sqlite: missing, rateCards: unsupported, accounts: splitProbeReaderFixtureConfig(subscriptions), homeToSubId: new Map(), subIdToHomes: new Map(),
    eras: buildEraIndex(subscriptions), eraErrors: [], claudeGauge: {}, grokGauge: {}, plans: { segments: [] },
    plansCatalog: { provider_groups: [] } } as unknown as AppContext;
  for (const response of [handleEraTimelines(ctx), handleHistoryCoverage(ctx, new URL("http://test/api/history-coverage"))]) {
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ usage_unavailable: ["codex","claude","gemini","grok","glm"]
      .map(provider => ({provider})) });
  }
});
