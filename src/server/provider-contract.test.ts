import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { Database } from "../db/sqlite";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { ACCOUNT_PERIODS, loadPeriods } from "../db/period-store";
import { readLimitWindows } from "../db/limit-windows";
import { createTestDatabase } from "../sync/test-support";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { advanceLimitWindows } from "./limit-window-producer";
import { readLedgerSums } from "./ledger-sums";
import { readWindowSums } from "./window-usage";
import { registerSubscriptionAccountingAdapter, type SubscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import type { RateCard } from "./pricing";

/**
 * Plan §7a criterion 8 (docs/provider-contract.md §5): a provider registered only here, with its own
 * fact table in native categories (prompt, cached, completion), its limit readings and its rates,
 * goes through the shared ledger, limit windows, window sums and their readers. Nothing outside this
 * file knows it.
 */
const n = (row: Record<string, unknown>, field: string) => Number(row[field] ?? 0);
const TEST_ADAPTER: SubscriptionAccountingAdapter = {
  id: "testprovider", label: "Test provider", aliases: ["testprovider"], table: "test_events", vendor: "testprovider",
  rateVendor: "testvendor", speed: false,
  defaultCounter: "weekly", counterKinds: ["weekly"], defaultMinutes: { weekly: 10080 }, counterIncludes: () => true,
  quantities: row => ({ in_uncached: n(row, "prompt") - n(row, "cached"), in_cache_read: n(row, "cached"), in_cache_write_5m: 0,
    in_cache_write_1h: 0, in_cache_write_unknown: 0, out_total: n(row, "completion"), out_thinking: 0 }),
  eventIdentity: row => row.call_id == null ? null : String(row.call_id),
};
const CARD: RateCard = { version: 1, currency: "USD", unit: "per 1M",
  vendors: { testvendor: { models: { "test-model": { in_uncached: 2, in_cache_read: 0.5, out_total: 8 } } } } } as unknown as RateCard;

const HOUR = 3_600_000, WEEK = 7 * 24 * HOUR;
const START = Date.parse("2026-03-02T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ACCOUNT = "test-account";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

test("a provider registered only in this test reaches ledger sums, limit windows and window sums with no change to shared code", () => {
  cleanups.push(registerSubscriptionAccountingAdapter(TEST_ADAPTER));
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  cleanups.push(() => { db.close(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  // The provider's own migration: its fact table. The shared triggers track it once installed.
  db.exec(`CREATE TABLE test_events(id INTEGER PRIMARY KEY, store TEXT, path TEXT, call_id TEXT, ts TEXT NOT NULL, model TEXT,
    prompt INTEGER, cached INTEGER, completion INTEGER); CREATE INDEX test_events_ts ON test_events(ts)`);
  installFactDayRevisions(db);

  // Two weeks of weekly limit readings, as the provider's reader records them.
  for (let week = 0; week < 2; week++) for (let step = 1; step < 14; step++)
    db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,
      vendor_percent,resets_at,window_minutes,ok,extra,machine) VALUES('testprovider',?,?,'pro','weekly','weekly',NULL,'used',?,?,?,NULL,1,NULL,'MAIN')`)
      .run(ACCOUNT, iso(START + week * WEEK + step * 12 * HOUR), step * 7, step * 7, iso(START + (week + 1) * WEEK));
  prepareProbeReaderFixture(db, [{ id: ACCOUNT, vendor: "testprovider", machine: "MAIN", login: "fixture" }], row => row.subject, false);
  const source = loadPeriods(db, ACCOUNT_PERIODS).find(period => period.provider === "testprovider")!.subject;

  // Calls in the source folder the account's period names, in native categories.
  const calls = Array.from({ length: 20 }, (_, index) => ({ call_id: `call-${index}`, ts: iso(START + index * 17 * HOUR + 5 * 60_000),
    prompt: 1000 + index * 10, cached: 200 + index, completion: 50 + index }));
  const insert = db.query("INSERT INTO test_events(store,path,call_id,ts,model,prompt,cached,completion) VALUES('main',?,?,?,'test-model',?,?,?)");
  for (const call of calls) insert.run(`${ARCHIVE_LOGICAL_ROOT}/${source}/session.jsonl`, call.call_id, call.ts, call.prompt, call.cached, call.completion);

  // Ledger: day sums equal the rows' own categories, summed by hand.
  fillUsageLedger(db, "testprovider", CARD, ARCHIVE_LOGICAL_ROOT);
  const sums = readLedgerSums(db, { vendors: ["testprovider"], grain: "day" });
  const byDay = new Map<string, { uncached: number; cached: number; out: number; calls: number }>();
  for (const call of calls) {
    const day = byDay.get(call.ts.slice(0, 10)) ?? { uncached: 0, cached: 0, out: 0, calls: 0 };
    byDay.set(call.ts.slice(0, 10), { uncached: day.uncached + call.prompt - call.cached, cached: day.cached + call.cached,
      out: day.out + call.completion, calls: day.calls + 1 });
  }
  const read = new Map<string, { uncached: number; cached: number; out: number; calls: number }>();
  for (const row of sums) {
    const day = read.get(row.day) ?? { uncached: 0, cached: 0, out: 0, calls: 0 };
    read.set(row.day, { uncached: day.uncached + row.uncached, cached: day.cached + row.cache_read, out: day.out + row.out, calls: day.calls + row.calls });
  }
  expect(read).toEqual(byDay);

  // Limit windows from the readings, then their sums from the ledger.
  for (let turn = 0; turn < 1000 && advanceLimitWindows(db, { sources: [], budgetMs: 1e9 }).pending; turn++) {}
  const counter = (db.query("SELECT DISTINCT counter FROM limit_windows WHERE provider='testprovider'").get() as { counter: string }).counter;
  const windows = readLimitWindows(db, "testprovider", ACCOUNT, counter);
  expect(windows.length).toBeGreaterThan(0);
  prepareWindowUsageFixture(db, { rateCards: CARD, subscriptions: [], claudeGauge: {}, manualCapacity: () => [] });
  const stored = readWindowSums(db, "testprovider", ACCOUNT, counter, windows, ["cycle"]);
  for (const window of windows) {
    const inside = calls.filter(call => call.ts >= window.start && call.ts < window.end);
    const usage = stored.get(window.id)!.cycle.cycle_usage;
    expect({ window: window.id, events: usage.events, tokens: usage.tokens })
      .toEqual({ window: window.id, events: inside.length, tokens: inside.reduce((sum, call) => sum + call.prompt + call.completion, 0) });
  }
}, 60_000);
