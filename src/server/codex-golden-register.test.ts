import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { loadAccountResolver } from "./account-resolver";
const ARCHIVE_HOME = `${ARCHIVE_LOGICAL_ROOT}/codex/test`;
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { installAnalysisTracking } from "../db/analysis";
import { buildEraIndex } from "./eras";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { buildCodexAccountingReport } from "./codex-accounting";
import { readCodexLimitWindows } from "./codex-limit-windows";
import rateCards from "../../rate-cards.json";
import type { RateCard } from "./pricing";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";

const card = rateCards as unknown as RateCard;
const declarations = [{ id: "acct", vendor: "codex", home: ARCHIVE_HOME, source_home: "live", from: "2025-01-01" }];
const UNTIL = "2026-09-20";
const day = (offset: number) => new Date(Date.parse(UNTIL) - offset * 86400000).toISOString().slice(0, 10);

/** One event shape per pricing outcome the report can reach, spread over the year. */
interface Shape {
  model: string; speed: string | null; in_tok: number; cached_in: number; cache_write: number; out_tok: number;
  usage_status?: string; billing_mode?: string; nested?: string;
}
const SHAPES: Shape[] = [
  { model: "gpt-6-astra", speed: "standard", in_tok: 100_000, cached_in: 80_000, cache_write: 0, out_tok: 10_000 },
  { model: "gpt-6-astra", speed: "fast", in_tok: 90_000, cached_in: 0, cache_write: 0, out_tok: 9_000 },
  // A positive write counter: the API price exists, the credit price refuses it.
  { model: "gpt-5.3-codex", speed: "standard", in_tok: 60_000, cached_in: 1_000, cache_write: 5_000, out_tok: 4_000 },
  // Credits only, and API only: the two one-sided models of the shipped card.
  { model: "gpt-5.4-mini", speed: "standard", in_tok: 40_000, cached_in: 0, cache_write: 0, out_tok: 3_000 },
  { model: "gpt-5-codex", speed: "standard", in_tok: 30_000, cached_in: 0, cache_write: 0, out_tok: 2_000 },
  // An unusable speed, on a model that is priced and on one that is not.
  { model: "gpt-5.3-codex", speed: null, in_tok: 20_000, cached_in: 0, cache_write: 0, out_tok: 1_500 },
  { model: "gpt-5.4-mini", speed: null, in_tok: 10_000, cached_in: 0, cache_write: 0, out_tok: 800 },
  // Unusable counters and an incomplete record.
  { model: "gpt-5.3-codex", speed: "standard", in_tok: 10, cached_in: 900, cache_write: 0, out_tok: 5 },
  { model: "gpt-6-astra", speed: "standard", in_tok: 12_000, cached_in: 0, cache_write: 0, out_tok: 900, usage_status: "incomplete" },
  // Spark, the internal reviewer and the business credit pool.
  { model: "gpt-5.3-codex-spark", speed: "standard", in_tok: 5_000, cached_in: 0, cache_write: 0, out_tok: 400 },
  { model: "codex-auto-review", speed: "standard", in_tok: 7_000, cached_in: 0, cache_write: 0, out_tok: 500, nested: "guardian_review" },
  { model: "gpt-5.5", speed: "fast", in_tok: 25_000, cached_in: 0, cache_write: 0, out_tok: 2_000, billing_mode: "business_credits" },
];

function seed(db: Database): void {
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,source_offset INTEGER,home TEXT NOT NULL,
    path TEXT NOT NULL,ts TEXT NOT NULL,model TEXT,speed TEXT,billing_mode TEXT,project_id TEXT,repo TEXT,
    surface TEXT,nested TEXT,meter_reset INTEGER,plan_type TEXT,account_id TEXT,in_tok INTEGER NOT NULL,
    cached_in INTEGER NOT NULL,cache_write INTEGER NOT NULL,out_tok INTEGER NOT NULL,reasoning_out INTEGER,
    cache_write_status TEXT,usage_status TEXT);
    CREATE INDEX events_ts ON events(ts);
    CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,used_percent REAL,resets_at INTEGER,window_minutes INTEGER,limit_id TEXT,plan_type TEXT);`);
  const insert = db.prepare(`INSERT INTO events(source_offset,home,path,ts,model,speed,billing_mode,project_id,
    surface,nested,meter_reset,in_tok,cached_in,cache_write,out_tok,reasoning_out,cache_write_status,usage_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'known',?)`);
  let offset = 0;
  // Data on every sixth day of the year, so a 365-day range is exercised without 365 days of rows.
  for (let back = 0; back < 366; back += 6) {
    const date = day(back);
    const reset = 1_700_000_000 + back * 86_400;
    SHAPES.forEach((shape, index) => {
      const mirrored = index % 4 === 0;
      const homes = mirrored ? ["live", ARCHIVE_HOME] : [index % 3 === 0 ? ARCHIVE_HOME : "live"];
      for (const home of homes) {
        const file = `${home}/sessions/${date}-${mirrored ? "shared" : `s${index}`}.jsonl`;
        insert.run(offset++, home, file, `${date}T${String(2 + index).padStart(2, "0")}:15:00Z`,
          shape.model, shape.speed, shape.billing_mode ?? "subscription", index % 2 ? "p1" : "p2",
          "chat", shape.nested ?? null, index % 5 === 0 ? reset : null,
          shape.in_tok, shape.cached_in, shape.cache_write, shape.out_tok, 11, shape.usage_status ?? "complete");
      }
    });
  }
  // Weekly meter readings, which give the report its cycles, calibration and traffic periods.
  const meter = db.prepare("INSERT INTO ratelimit VALUES('live','live/meter',?,?,?,10080,'codex','pro')");
  for (let back = 366; back >= 0; back -= 3) {
    const cycle = Math.floor(back / 7);
    meter.run(`${day(back)}T09:30:00Z`, (back % 7) * 12, Math.floor(Date.parse(day(cycle * 7 - 7)) / 1000));
  }
  // Weekly counter readings: each cycle is observed from near zero to near full, so the
  // report matches it and can calibrate it.
  const probe = db.prepare(`INSERT INTO probe_windows(provider,limit_group,subject,ts,kind,plan,
    reported_percent_side,used_percent,resets_at,window_minutes)
    VALUES('codex','codex','acct',?,'weekly','pro','used',?,?,10080)`);
  for (let back = 366; back >= 0; back -= 1) {
    const cycle = Math.floor(back / 7);
    probe.run(`${day(back)}T10:30:00Z`, (6 - (back % 7)) * 14, `${day(cycle * 7 - 7)}T00:00:00Z`);
  }
}

function fixture(): Database {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  seed(db);
  db.exec("INSERT INTO account_periods(provider,source,account,from_ts,until_ts,origin,readings,evidence) VALUES('codex','codex/test','acct','2024-01-01T00:00:00Z',NULL,'declared',0,'test')");
  installAnalysisTracking(db);
  prepareProbeReaderFixture(db,declarations);
  installAnalysisTracking(db);
  prepareCodexLedgerFixture(db, card, indexSubscriptionHomes(declarations));
  prepareWindowUsageFixture(db, { rateCards: card, subscriptions: declarations });
  return db;
}

const report = (db: Database, since: string, project?: string) =>
  buildCodexAccountingReport(db, card, { since, until: UNTIL, ...(project ? { project } : {}) },
    indexSubscriptionHomes(declarations), buildEraIndex(declarations), true,undefined,undefined,undefined,loadAccountResolver(db),declarations);

test("direct Codex accounting preserves source declarations carried only by its home map", () => {
  const db = fixture();
  try {
    const homes = indexSubscriptionHomes(declarations,declarations);
    const options = {since:day(6),until:UNTIL,account:"acct"};
    const direct = buildCodexAccountingReport(db,card,options,homes);
    const explicit = buildCodexAccountingReport(db,card,options,homes,undefined,true,undefined,undefined,undefined,
      loadAccountResolver(db,declarations),declarations);
    expect(direct.events).toBeGreaterThan(0);
    expect(direct).toEqual(explicit);
  } finally { db.close(); }
});

const RANGES = [{ label: "7 days", since: day(6) }, { label: "31 days", since: day(30) }, { label: "365 days", since: day(364) }];

/**
 * Distinct seeded instants in `[from, to)`: each shape has its own hour on a data day and a
 * mirrored shape's two copies share one instant, so this counts the events left after copy
 * selection, independently of the price ledger and the report.
 */
/** Tokens (input and output) of the seeded calls in `[from, to)`, one per instant as `seededEvents` counts them. */
function seededTokens(db: Database, from: number, to: number, where = "1"): number {
  const byInstant = new Map<number, number>();
  for (const row of db.query(`SELECT ts,in_tok,out_tok FROM events WHERE ${where}`).all() as Array<{ ts: string; in_tok: number; out_tok: number }>) {
    const at = Date.parse(row.ts);
    if (at >= from && at < to) byInstant.set(at, row.in_tok + row.out_tok);
  }
  return [...byInstant.values()].reduce((sum, tokens) => sum + tokens, 0);
}
function seededEvents(db: Database, from: number, to: number, where = "1"): number {
  const instants = (db.query(`SELECT ts FROM events WHERE ${where}`).all() as Array<{ ts: string }>).map(row => Date.parse(row.ts));
  return new Set(instants.filter(ts => ts >= from && ts < to)).size;
}

// The pre-register event path these reports were compared with is gone (Codex money is served
// from the price ledger only), so the reference here is the seeded events themselves.
test("the ledger-backed Codex accounting report covers every selected event for 7, 31 and 365 days", () => {
  const db = fixture();
  try {
    const until = Date.parse(UNTIL) + 86_400_000;
    for (const range of RANGES) {
      const result = report(db, range.since);
      // Guard the sample: an empty report would agree on everything.
      expect({ range: range.label, events: result.events, subjects: result.subjects.length > 0,
        windows: range.label === "7 days" || (result.windows?.length ?? 0) > 0 })
        .toEqual({ range: range.label, events: seededEvents(db, Date.parse(range.since), until), subjects: true, windows: true });
      expect(result.events).toBeGreaterThan(0);
    }
    // A project filter takes the subject dimension: the two projects split the events exactly.
    const all = report(db, day(30)), p1 = report(db, day(30), "p1"), p2 = report(db, day(30), "p2");
    expect(p1.events).toBeGreaterThan(0);
    expect(p2.events).toBeGreaterThan(0);
    expect(p1.events + p2.events).toBe(all.events);
    expect(p1.tokens + p2.tokens).toBe(all.tokens);
  } finally { db.close(); }
}, 240_000);

test("a traffic period that a counter boundary cuts at midday counts both sides of the boundary", () => {
  const db = fixture();
  try {
    // The subhour boundary must be published evidence, rather than an unqualified raw anchor.
    const observed = Date.parse(`${day(7)}T10:30:00Z`);
    expect(readCodexLimitWindows(db, "acct", 10080).some(window =>
      window.readings.some(reading => Date.parse(reading.ts) === observed))).toBe(true);
    const cut = report(db, day(30)).traffic_periods
      .filter(period => Date.parse(period.start) !== Date.parse(period.start.slice(0, 10))
        || Date.parse(period.end) !== Date.parse(period.end.slice(0, 10)));
    expect(cut.length).toBeGreaterThan(0);
    // A period counts the account's own pool without Spark: business credits are another account. Whole hours
    // come from the hour sums and the boundary's hour call by call; together they are the seeded calls.
    expect(cut.some(period => Date.parse(period.start) % 3_600_000 !== 0 || Date.parse(period.end) % 3_600_000 !== 0)).toBe(true);
    const own = "model<>'gpt-5.3-codex-spark' AND billing_mode<>'business_credits'";
    for (const period of cut) {
      const from = Math.max(Date.parse(period.start), Date.parse(day(30))), to = Date.parse(period.end);
      expect({ start: period.start, events: period.events, tokens: period.tokens })
        .toEqual({ start: period.start, events: seededEvents(db, from, to, own), tokens: seededTokens(db, from, to, own) });
    }
  } finally { db.close(); }
});
