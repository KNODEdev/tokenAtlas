import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { LIMIT_WINDOW_SCHEMA_SQL } from "../db/limit-windows";
import { markWindowUsageDirty } from "../db/window-usage";
import { buildProbeLimitWindows, type ProbeLimitWindow } from "./probe-limit-windows";
import { codexLimitCounter } from "./codex-limit-windows";
import { fixtureCodexRateCard, prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import type { RateCard } from "./pricing";
import { advanceWindowUsage, emptyWindowUsageStats } from "./window-usage";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";

/**
 * A Codex account with three weekly windows (the last one open), ledger calls in each, and the
 * excluded kinds of traffic: Spark, the reserve tier, credit funding and a contradicting reset.
 * Windows are published as the limit-window producer publishes them: rows, ready state, then the
 * window-usage entry.
 */
export const COUNTER = codexLimitCounter(10080);
export const sources = ["/archive", "/laptop"].map(source_home => ({ id: "codex1", vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/fixture`, source_home }));
export const card: RateCard = fixtureCodexRateCard({ version: 2, currency: "USD", unit: "per 1M", vendors: { openai: { models: {
  "gpt-6-astra": { in_uncached: 3, in_cache_read: 0.3, out_total: 15 },
  "gpt-5.3-codex-spark": { in_uncached: 1, in_cache_read: 0.1, out_total: 5 },
  "gpt-reserve": { in_uncached: 1, in_cache_read: 0.1, out_total: 5 },
} } } });
/** Databases the tests opened; their afterEach closes them. */
export const opened: Database[] = [];

/** Three weekly windows of codex1; the last one is open. */
export const READINGS: Array<[string, number, string]> = [
  ["2026-09-01T02:00:00.000Z", 5, "2026-09-08T00:00:00.000Z"], ["2026-09-03T00:00:00.000Z", 30, "2026-09-08T00:00:00.000Z"],
  ["2026-09-07T00:00:00.000Z", 60, "2026-09-08T00:00:00.000Z"],
  ["2026-09-08T03:00:00.000Z", 2, "2026-09-15T00:00:00.000Z"], ["2026-09-10T00:00:00.000Z", 40, "2026-09-15T00:00:00.000Z"],
  ["2026-09-14T00:00:00.000Z", 80, "2026-09-15T00:00:00.000Z"],
  ["2026-09-15T05:00:00.000Z", 1, "2026-09-22T00:00:00.000Z"], ["2026-09-16T00:00:00.000Z", 10, "2026-09-22T00:00:00.000Z"],
];
export type Event = { ts: string; model?: string; billing?: string | null; reset?: number | null; home?: string; input?: number };
export const EVENTS: Event[] = [
  { ts: "2026-09-02T00:00:00.000Z" }, { ts: "2026-09-06T00:00:00.000Z" },
  { ts: "2026-09-09T00:00:00.000Z" }, { ts: "2026-09-12T00:00:00.000Z", home: "/laptop" },
  { ts: "2026-09-12T01:00:00.000Z", model: "gpt-5.3-codex-spark" }, { ts: "2026-09-12T02:00:00.000Z", model: "gpt-reserve" },
  { ts: "2026-09-12T03:00:00.000Z", billing: "credits" },
  // Recorded under the previous week's reset: it contradicts this window's meter.
  { ts: "2026-09-13T00:00:00.000Z", reset: Date.parse("2026-09-08T00:00:00.000Z") / 1000 },
  { ts: "2026-09-15T12:00:00.000Z" },
];

export function database(): Database {
  const db = new Database(":memory:");
  opened.push(db);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,in_tok INTEGER,cached_in INTEGER,
      cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,speed TEXT,billing_mode TEXT,meter_reset INTEGER,plan_type TEXT)`);
  db.exec(LIMIT_WINDOW_SCHEMA_SQL);
  db.exec("ALTER TABLE limit_windows ADD COLUMN activity TEXT");
  db.exec(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0040_account_periods.sql"), "utf8"));
  db.query("INSERT INTO account_periods(provider,source,account,from_ts,origin,evidence) VALUES('codex','codex/fixture','codex1','2000-01-01T00:00:00Z','declared','fixture')").run();
  for (const event of EVENTS) addEvent(db, event);
  publishLedger(db, card);
  storeWindows(db, READINGS);
  return db;
}
export function addEvent(db: Database, event: Event): void {
  db.query(`INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,speed,billing_mode,meter_reset)
    VALUES(?,?,?,?,?,?,0,?,0,'standard',?,?)`).run(event.home ?? "/archive",
    `${event.home ?? "/archive"}/rollout-${event.ts}.jsonl`, event.ts, event.model ?? "gpt-6-astra", event.input ?? 100_000, 20_000, 10_000,
    event.billing ?? null, event.reset ?? null);
}
export function publishLedger(db: Database, rates: RateCard): void {
  prepareCodexLedgerFixture(db, rates, indexSubscriptionHomes([], sources), sources);
}
/** Publishes the windows of the readings as the limit-window producer does: rows, then the window-usage entry. */
export function storeWindows(db: Database, readings: typeof READINGS): ProbeLimitWindow[] {
  const windows = buildProbeLimitWindows({ provider: "codex", account: "codex1", counter: COUNTER, periods: [],
    readings: readings.map(([ts, used_percent, resets_at]) => ({ ts, used_percent, resets_at, window_minutes: 10080 })) });
  db.transaction(() => {
    db.query("DELETE FROM limit_windows").run();
    const insert = db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,
      window_minutes,plan,plan_detail,plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input)
      VALUES('codex','codex1',?,?,?,?,?,?,?,10080,NULL,NULL,0,?,NULL,NULL,NULL,1,'{}')`);
    windows.forEach((window, seq) => insert.run(COUNTER, seq, window.id, window.start, window.end, window.reset, window.cycle_end_basis,
      JSON.stringify(window.readings)));
    db.query(`INSERT OR REPLACE INTO limit_window_state(provider,account,scope,version,status) VALUES('codex','codex1',?,1,'ready')`).run(COUNTER);
    markWindowUsageDirty(db, { provider: "codex", account: "codex1", counter: COUNTER, fromMs: Date.parse(windows[0]!.start) });
  }).immediate();
  return windows;
}
export function settle(db: Database, rates = card) {
  const stats = emptyWindowUsageStats();
  // Two idle turns in a row are a block.
  for (let turn = 0, idle = 0; turn < 1000; turn++) {
    const result = advanceWindowUsage(db, { rateCards: rates, budgetMs: 1e9, stats });
    if (!result.pending) return stats;
    idle = result.progressed ? 0 : idle + 1;
    if (idle > 1) throw new Error("Window usage producer is blocked");
  }
  throw new Error("Window usage producer did not settle");
}
