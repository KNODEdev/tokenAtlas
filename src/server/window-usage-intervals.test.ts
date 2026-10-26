import { expect, test } from "bun:test";
import { createClaudeCodeAcceptanceFixture, ACCOUNTS, TIMES } from "./claude-code-capacity.fixture";
import { advanceWindowUsage, type WindowUsageProducerOptions } from "./window-usage";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import type { Database } from "../db/sqlite";
import { PLAN_PERIODS, PLAN_PERIODS_REVISION, recordPeriodReading, replaceDeclaredPeriods } from "../db/period-store";
import { loadAccountResolver } from "./account-resolver";
import { syncIntervals } from "./window-usage-intervals";
import { computeWindowUsageFull, readWindowIntervals } from "./window-usage";
import type { DatedPeriod } from "./account-periods";

/** The interval list is computed again only when one of its inputs changed; an idle turn compares stamps. */
const measurement = (id: string, end: string): ManualCapacityMeasurement => ({ id, account: ACCOUNTS.a, counter: "weekly_all", start: TIMES.start,
  end, start_percent: 0, end_percent: 20, approximate_time: false, note: "", updated_at: TIMES.start });

/** The SQL a call runs on the connection, and how many rows it changed. */
function observe(db: Database, run: () => void): { sql: string[]; changes: number } {
  const query = db.query.bind(db), sql: string[] = [];
  const changes = () => (query("SELECT total_changes() n").get() as { n: number }).n;
  const before = changes();
  db.query = ((text: string) => { sql.push(text); return query(text); }) as Database["query"];
  try { run(); } finally { db.query = query; }
  return { sql, changes: changes() - before };
}

test("an idle turn reads and writes nothing of the intervals; a changed input republishes only its interval", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    let manual = [measurement("first", TIMES.asOf)];
    const options: WindowUsageProducerOptions = { rateCards: fixture.rates, manualCapacity: provider => provider === "claude" ? manual : [],
      claudeGauge: {}, cycles: { windows: [] }, nowMs: Date.parse(TIMES.reset), budgetMs: 1e9 };
    for (let turn = 0; turn < 20 && advanceWindowUsage(fixture.db, options).pending; turn++) { /* settle */ }
    const intervals = () => fixture.db.query("SELECT provider,account,counter,window_id,start_ts,end_ts,spec FROM window_usage_intervals ORDER BY 1,2,3,4").all();
    const published = intervals();
    expect(published.length).toBeGreaterThan(0);

    const idle = observe(fixture.db, () => advanceWindowUsage(fixture.db, options));
    expect(idle.changes).toBe(0);
    // No interval list, cadence, quota reading or ledger day is read: only the stamps of their inputs.
    expect(idle.sql.filter(text => /(FROM|INTO) window_usage_intervals|probe_sources\b|usage_ledger_(days|hours|facts)/.test(text))).toEqual([]);

    // The measurement's end moves: its interval alone is published again and recomputed.
    manual = [measurement("first", TIMES.afterAsOf)];
    const changed = observe(fixture.db, () => advanceWindowUsage(fixture.db, { ...options, budgetMs: 0, canWrite: () => true }));
    expect(changed.changes).toBeGreaterThan(0);
    const after = intervals() as Array<{ window_id: string; end_ts: string }>;
    expect(after.filter(row => !published.some(old => JSON.stringify(old) === JSON.stringify(row))).map(row => [row.window_id, row.end_ts]))
      .toEqual([["manual:first", TIMES.afterAsOf]]);
    expect(after.length).toBe(published.length);
  } finally { fixture.teardown(); }
}, 60_000);

const plan = (from: string, until: string | null, value = "pro"): DatedPeriod => ({ provider: "claude", subject: ACCOUNTS.a,
  from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });

test("ending a plan removes only reconstructed intervals; measured windows, valid empty weeks and sums survive correction and restart", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const options: WindowUsageProducerOptions = { rateCards: f.rates, manualCapacity: () => [], claudeGauge: {},
      grokGauge: {}, cycles: { windows: [] }, nowMs: Date.parse("2026-10-25"), budgetMs: 1e9 };
    for (let turn = 0; turn < 20 && advanceWindowUsage(f.db, options).pending; turn++) { /* settle */ }
    const sums = () => f.db.query("SELECT * FROM window_usage ORDER BY provider,account,counter,window_id").all() as Array<Record<string, string>>;
    const measured = () => f.db.query("SELECT * FROM limit_windows ORDER BY provider,account,counter,window_id").all();
    const initialSums = sums(), initialMeasured = measured();
    const publish = () => syncIntervals(f.db, options, {}, loadAccountResolver(f.db));
    const starts = () => readWindowIntervals(f.db, "claude", ACCOUNTS.a).filter(i => i.counter === "declared:weekly_all")
      .map(i => i.start.slice(0, 10)).sort();
    const raw = () => f.db.query("SELECT COUNT(*) n FROM claude_events").get();
    const originalRaw = raw();
    recordPeriodReading(f.db, PLAN_PERIODS, { provider: "claude", subject: ACCOUNTS.a, ts: "2026-09-09", value: "default_claude_ai" });
    replaceDeclaredPeriods(f.db, PLAN_PERIODS, [plan("2026-08-30", "2026-09-20")]);
    const updated = observe(f.db, publish);
    expect(updated.sql.some(sql => /usage_ledger_(facts|days|hours)|FROM claude_events/i.test(sql))).toBe(false);
    expect(starts()).toEqual(["2026-08-30", "2026-09-06", "2026-09-13"]);
    expect(measured()).toEqual(initialMeasured);
    // The same valid rows are retained byte for byte, with no pending recalculation.
    expect(sums()).toEqual(initialSums.filter(row => row.account !== ACCOUNTS.a || !row.counter!.startsWith("declared:")
      || ["2026-08-30", "2026-09-06", "2026-09-13"].includes(row.start_ts!.slice(0, 10))));
    expect(f.db.query("SELECT COUNT(*) n FROM window_usage_pending").get()).toEqual({ n: 0 });
    const quiet = sums().find(row => row.account === ACCOUNTS.a && row.counter === "declared:weekly_all" && row.start_ts?.startsWith("2026-08-30"))!;
    expect(JSON.parse(quiet.rail!).tokens).toBe(0);
    const full = computeWindowUsageFull(f.db, options);
    for (const row of sums()) expect(JSON.parse(row.rail!)).toEqual(full.get(JSON.stringify([row.provider, row.account, row.counter, row.window_id]))!.rail);

    // A corrected end excludes even the measured week's synthetic duplicate, never the actual meter.
    replaceDeclaredPeriods(f.db, PLAN_PERIODS, [plan("2026-08-30", "2026-09-13")]);
    publish();
    expect(starts()).toEqual(["2026-08-30", "2026-09-06"]);
    expect(measured()).toEqual(initialMeasured);
    expect(raw()).toEqual(originalRaw);
    const settled = sums();
    expect(observe(f.db, publish).changes).toBe(0);
    f.reopen();
    expect(observe(f.db, publish).changes).toBe(0);
    expect(sums()).toEqual(settled);
    options.nowMs = Date.parse("2027-10-25");
    publish();
    expect(starts()).toEqual(["2026-08-30", "2026-09-06"]);
    expect(sums().filter(row => row.account === ACCOUNTS.a)).toEqual(settled.filter(row => row.account === ACCOUNTS.a));
  } finally { f.teardown(); }
}, 60_000);

test("a future plan resumes reconstruction on the clock; last-seen updates do not invalidate plan spans", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const options: WindowUsageProducerOptions = { rateCards: f.rates, manualCapacity: () => [], claudeGauge: {}, grokGauge: {},
      cycles: { windows: [] }, nowMs: Date.parse("2026-09-19T12:00:00Z") };
    replaceDeclaredPeriods(f.db, PLAN_PERIODS, [plan("2026-09-21", null)]);
    const publish = () => syncIntervals(f.db, options, {}, loadAccountResolver(f.db));
    const starts = () => readWindowIntervals(f.db, "claude", ACCOUNTS.a).map(i => i.start.slice(0, 10));
    publish();
    expect(starts()).toEqual([]);
    options.nowMs = Date.parse("2026-09-21T12:00:00Z");
    publish();
    expect(starts()).toEqual(["2026-09-20"]);
    recordPeriodReading(f.db, PLAN_PERIODS, { provider: "claude", subject: ACCOUNTS.a, ts: "2026-09-21", value: "pro" });
    publish();
    const revision = () => f.db.query("SELECT value FROM meta WHERE key=?").get(`${PLAN_PERIODS_REVISION}:claude`);
    const previous = revision();
    recordPeriodReading(f.db, PLAN_PERIODS, { provider: "claude", subject: ACCOUNTS.a, ts: "2026-09-22", value: "pro" });
    expect(revision()).toEqual(previous);
    const idle = observe(f.db, publish);
    expect(idle.changes).toBe(0);
    expect(idle.sql.filter(sql => /FROM plan_periods|FROM window_usage_intervals/.test(sql))).toEqual([]);
  } finally { f.teardown(); }
}, 60_000);
