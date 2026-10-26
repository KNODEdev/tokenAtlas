import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database as SqliteDatabase } from "bun:sqlite";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { createClaudeCodeAcceptanceFixture, measureAnalysis, ACCOUNTS, TIMES } from "./claude-code-capacity.fixture";
import { markLimitWindowsDirty } from "../db/limit-windows";
import { WINDOW_END_ESTIMATE_SCHEMA_SQL } from "../db/window-end-estimates";
import { claudeWeeklyRegisterWindows, type ProbeLimitWindow } from "./probe-limit-windows";
import { loadAccountResolver } from "./account-resolver";
import { buildEraIndex } from "./eras";
import { handleWindows, type AppContext } from "./api";
import { readWindowEndEstimates, windowEndEstimate, WINDOW_END_ESTIMATE_RULE, type WindowCalibration } from "./window-end-estimate";
import type { ModelSpend, WindowReadingSums } from "./window-usage";
import type { RailWindow } from "../web/lib/windows";

/* ------------------------------------------------------------------------------------------ */
/* The estimate itself                                                                         */
/* ------------------------------------------------------------------------------------------ */

const spend = (actual: number, tokens = actual * 1_000_000): ModelSpend => ({ model: "m", events: 1, tokens, fresh: tokens,
  standard: actual, standard_unpriced: 0, actual, actual_unpriced: 0 });
/** A window with readings `[ts, percent, actual $ since the previous reading]` and `total` actual $ over its cycle. */
function windowOf(readings: Array<[string, number, number, ("probe" | "limit_hit")?]>, total: number,
  bounds: { start?: string; end?: string; startDrop?: ProbeLimitWindow["startDrop"] } = {}) {
  const window = { id: "w", start: bounds.start ?? "2026-10-01T00:00:00.000Z", end: bounds.end ?? "2026-10-08T00:00:00.000Z",
    startDrop: bounds.startDrop ?? null,
    readings: readings.map(([ts, percent, , source]) => ({ ts, percent, source: source ?? "probe" as const })) };
  const sums = { readings: readings.map(([ts, , actual]) => ({ ts, usage: {} as WindowReadingSums["usage"], homes: [], models: [],
    spend: actual > 0 ? [spend(actual)] : [] })) as WindowReadingSums[], cycle: { spend: [spend(total)] } };
  // One call per reading interval with spend, and one more when the cycle holds spend after the last reading.
  const read = readings.reduce((sum, [, , actual]) => sum + actual, 0);
  sums.cycle.spend[0]!.events = readings.filter(([, , actual]) => actual > 0).length + (total > read ? 1 : 0);
  return { window, sums };
}

test("the estimate adds the usage after the last reading at the window's recent percent-per-usage", () => {
  // 0 % at the reset, 20 % for $200 ($10/pt), then 70 % for $250 more ($5/pt): the recent part (≥ 10 pp) is $5/pt.
  const { window, sums } = windowOf([["2026-10-02T00:00:00.000Z", 20, 200], ["2026-10-04T00:00:00.000Z", 60, 200],
    ["2026-10-05T00:00:00.000Z", 70, 50]], 500);
  const result = windowEndEstimate(window, sums, null)!;
  expect(result.calibration).toMatchObject({ from: { percent: 60 }, to: { percent: 70 }, usd_per_point: 5 });
  // $50 after 70 % at $5/pt: 80 %.
  expect(result.estimate).toMatchObject({ rule: WINDOW_END_ESTIMATE_RULE, basis: "estimate", percent: 80, uncapped: 80,
    last_reading: { ts: "2026-10-05T00:00:00.000Z", percent: 70, source: "probe" },
    after: { api_actual: 50, events: 1 }, calibration: { source: "window", window_id: "w" } });
});

test("the estimate is capped at 100 % and keeps the uncapped value as provenance", () => {
  const { window, sums } = windowOf([["2026-10-02T00:00:00.000Z", 50, 500], ["2026-10-05T00:00:00.000Z", 85, 350]], 1_200);
  const estimate = windowEndEstimate(window, sums, null)!.estimate!;
  // $10/pt over 50→85 %; $350 after is 35 pp: 120 % uncapped.
  expect(estimate).toMatchObject({ percent: 100, uncapped: 120, basis: "estimate" });
});

test("no usage after the last reading, or a last reading at the end, gives no estimate", () => {
  const quiet = windowOf([["2026-10-02T00:00:00.000Z", 50, 500], ["2026-10-05T00:00:00.000Z", 85, 350]], 850);
  expect(windowEndEstimate(quiet.window, quiet.sums, null)).toMatchObject({ estimate: null, calibration: { usd_per_point: 10 } });
  const atEnd = windowOf([["2026-10-02T00:00:00.000Z", 50, 500], ["2026-10-08T00:00:00.000Z", 85, 350]], 1_000);
  expect(windowEndEstimate(atEnd.window, atEnd.sums, null)!.estimate).toBeNull();
});

test("a window without its own calibration takes the account's earlier one; without any there is no estimate", () => {
  // One reading at 3 % right after a mid-window drop: no rise to calibrate on.
  const { window, sums } = windowOf([["2026-10-01T00:00:00.000Z", 3, 0]], 40, { startDrop: { before: 99, after: 3 } });
  expect(windowEndEstimate(window, sums, null)).toEqual({ calibration: null, estimate: null });
  const earlier: WindowCalibration = { window_id: "earlier", from: { ts: "2026-09-28T00:00:00.000Z", percent: 40 },
    to: { ts: "2026-09-29T00:00:00.000Z", percent: 60 }, usage: { events: 1, tokens: 1, api_actual: 200, unpriced_events: 0 },
    usd_per_point: 10, tokens_per_point: 1 };
  expect(windowEndEstimate(window, sums, earlier)!.estimate).toMatchObject({ percent: 7, calibration: { source: "account", window_id: "earlier" } });
});

test("a limit refusal after the last meter reading is the end: basis limit-hit, no calibration needed", () => {
  const { window, sums } = windowOf([["2026-10-02T00:00:00.000Z", 50, 500], ["2026-10-05T00:00:00.000Z", 100, 600, "limit_hit"]], 1_400);
  const result = windowEndEstimate({ ...window, readings: window.readings.map((reading, index) =>
    index === 1 ? { ...reading, limit_hit: { call_id: "refused" } } : reading) }, sums, null)!;
  expect(result.estimate).toMatchObject({ basis: "limit-hit", percent: 100, after: null, limit_hit: { call_id: "refused" } });
  // A calibration never spans a reading at 100 %: it ends at the last reading below it.
  expect(result.calibration).toMatchObject({ to: { percent: 50 }, usd_per_point: 10 });
});

test("sums that do not belong to the readings are not estimated", () => {
  const { window, sums } = windowOf([["2026-10-02T00:00:00.000Z", 50, 500]], 600);
  expect(windowEndEstimate({ ...window, readings: [...window.readings, { ts: "2026-10-03T00:00:00.000Z", percent: 60, source: "probe" }] },
    sums, null)).toBeNull();
});

/* ------------------------------------------------------------------------------------------ */
/* Stored by the window-usage producer, read by the rail                                         */
/* ------------------------------------------------------------------------------------------ */

const fixtureSources = Object.values(ACCOUNTS).map(id => ({ id, vendor: "claude", machine: "synthetic", login: "fixture",
  home: `${ARCHIVE_LOGICAL_ROOT}/claude/${id}`, source_home: `C:/Users/fixture/.claude-${id}` }));
const eventScans = (queries: string[]) => queries.filter(query => /usage_ledger_facts/i.test(query)
  || /claude_events/i.test(query) && /in_uncached|out_total|SUM\(/i.test(query));
type Fixture = ReturnType<typeof createClaudeCodeAcceptanceFixture>;
function claudeEvent(f: Fixture, id: string, ts: string, tokens: number, account: string = ACCOUNTS.a) {
  f.db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total)
    VALUES('fixture-primary',?,?,?,?,'claude-sonnet-fixture','standard',?,'cli','2.1.0',?,?)`)
    .run(id, `session-${id}`, `${ARCHIVE_LOGICAL_ROOT}/claude/${account}/${id}.jsonl`, ts, account, tokens * 0.8, tokens * 0.2);
}
function reading(f: Fixture, ts: string, percent: number) {
  f.db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,
    resets_at,window_minutes,ok,extra,machine) VALUES('claude',?,?,'max','weekly_all','weekly',NULL,'used',?,?,?,10080,1,NULL,'synthetic')`)
    .run(ACCOUNTS.a, ts, percent, percent, TIMES.reset);
}
function refusal(f: Fixture, id: string, ts: string) {
  f.db.query(`INSERT INTO claude_limit_hits(store,call_id,ts,limit_type,status,resets_at,path)
    VALUES('fixture-primary',?,?,'seven_day','rejected',?,?)`).run(id, ts, TIMES.reset, `${ARCHIVE_LOGICAL_ROOT}/claude/${ACCOUNTS.a}/${id}.jsonl`);
  markLimitWindowsDirty(f.db, "claude", "*", Date.parse(ts));
}
const week = (f: Fixture) => claudeWeeklyRegisterWindows(f.db, ACCOUNTS.a).find(window => window.start === TIMES.start)!;
/** Every write of the estimate table, to tell which windows a change recomputed. */
function logEstimateWrites(f: Fixture): () => string[] {
  f.db.exec(`CREATE TABLE estimate_writes(window_id TEXT, op TEXT);
    CREATE TRIGGER estimate_ins AFTER INSERT ON window_end_estimates BEGIN INSERT INTO estimate_writes VALUES(NEW.window_id,'insert'); END;
    CREATE TRIGGER estimate_upd AFTER UPDATE ON window_end_estimates BEGIN INSERT INTO estimate_writes VALUES(NEW.window_id,'update'); END;
    CREATE TRIGGER estimate_del AFTER DELETE ON window_end_estimates BEGIN INSERT INTO estimate_writes VALUES(OLD.window_id,'delete'); END;`);
  return () => (f.db.query("SELECT DISTINCT window_id FROM estimate_writes ORDER BY window_id").all() as Array<{ window_id: string }>)
    .map(row => row.window_id);
}
const railOf = async (f: Fixture) => {
  const ctx = { sqlite: f.db, rateCards: f.rates, resolver: loadAccountResolver(f.db, fixtureSources), claudeGauge: {},
    accounts: { subscriptions: fixtureSources, sources: fixtureSources }, cycles: { windows: [] }, eras: buildEraIndex([]), eraErrors: [],
    homeToSubId: new Map(), subIdToHomes: new Map(), plans: {}, plansCatalog: { provider_groups: [] }, rootDir: "" } as unknown as AppContext;
  const measured = await measureAnalysis(f.db, () => handleWindows(ctx, new URL(`http://local/api/windows?account=${ACCOUNTS.a}`)));
  const body = await (await measured.value).json() as { windows: Array<RailWindow & { endEstimate?: unknown }> };
  return { body, scans: eventScans(measured.rawOrFactQueries) };
};

test("the producer stores the end estimate of a window whose readings stopped early, and the rail shows it as ≈", async () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    // account-a's week [13.09, 20.09): 10 % at 50 000 tokens, 24 % at 161 000; 9 000 tokens after the last reading.
    // Every call costs tokens × 5.4 / 1M: $0.5994 for 14 pp, so the 9 000 tokens ($0.0486) add 1.135 pp.
    const estimate = readWindowEndEstimates(f.db, "claude", ACCOUNTS.a).get(week(f).id)!;
    expect(estimate).toMatchObject({ basis: "estimate", last_reading: { percent: 24, source: "probe" },
      after: { tokens: 9_000 }, calibration: { source: "window", from: { percent: 10 }, to: { percent: 24 } } });
    expect(estimate.percent).toBeCloseTo(24 + 0.0486 / (0.5994 / 14), 2);
    // The rail reads the stored value: the week closed on 20.09, its readings stay as measured.
    const { body, scans } = await railOf(f);
    expect(scans).toEqual([]);
    const row = body.windows.find(window => window.startIso === TIMES.start)!;
    expect(row).toMatchObject({ usedPercent: Math.round(estimate.percent * 100) / 100, percentBasis: "counterfactual",
      endEstimate: estimate, sampledAtIso: week(f).readings.at(-1)!.ts });
    expect(row.note).toContain("Szacunek końca okna: ostatni odczyt konta 24%");
    expect(row.shape ?? week(f).readings.map(r => r.percent)).not.toContain(estimate.percent);
    // Without a stored estimate the rail shows the measured reading: it never computes one.
    f.db.exec("DELETE FROM window_end_estimates");
    const plain = (await railOf(f)).body.windows.find(window => window.startIso === TIMES.start)!;
    expect(plain).toMatchObject({ usedPercent: 24, percentBasis: "measured" });
    expect(plain.endEstimate).toBeUndefined();
  } finally { f.teardown(); }
});

test("only the windows a change touches are estimated again", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const before = readWindowEndEstimates(f.db, "claude", ACCOUNTS.a).get(week(f).id)!;
    const writes = logEstimateWrites(f);
    // A call of account-b changes only account-b's windows.
    claudeEvent(f, "b-later", "2026-09-18T00:00:00.000Z", 50_000, ACCOUNTS.b);
    f.prepareFacts();
    expect(writes().filter(id => id.includes(ACCOUNTS.a))).toEqual([]);
    // A call of account-a after its last reading moves its estimate, and nothing else of account-a.
    claudeEvent(f, "a-later", "2026-09-18T00:00:00.000Z", 50_000);
    f.prepareFacts();
    expect(writes().filter(id => id.includes(ACCOUNTS.a))).toEqual([week(f).id]);
    const after = readWindowEndEstimates(f.db, "claude", ACCOUNTS.a).get(week(f).id)!;
    expect(after.after!.tokens).toBe(before.after!.tokens + 50_000);
    expect(after.percent).toBeGreaterThan(before.percent);
    // A turn without changes writes nothing.
    f.db.exec("DELETE FROM estimate_writes");
    f.publishSums();
    expect(writes()).toEqual([]);
  } finally { f.teardown(); }
});

test("a refusal after the last reading takes precedence: the window ends at the vendor's 100 %", async () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    refusal(f, "refused", "2026-09-18T00:00:00.000Z");
    f.prepareFacts();
    expect(readWindowEndEstimates(f.db, "claude", ACCOUNTS.a).get(week(f).id)).toMatchObject({ basis: "limit-hit", percent: 100,
      last_reading: { source: "limit_hit" }, limit_hit: { call_id: "refused" } });
    // The refusal is a measurement; the rail keeps it as one.
    const row = (await railOf(f)).body.windows.find(window => window.startIso === TIMES.start)!;
    expect(row).toMatchObject({ usedPercent: 100, percentBasis: "measured" });
  } finally { f.teardown(); }
});

test("a vendor reset inside the window splits it: the estimate counts only usage up to the split", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    claudeEvent(f, "climb", "2026-09-17T06:00:00.000Z", 50_000);
    reading(f, "2026-09-17T12:00:00.000Z", 90);
    claudeEvent(f, "unread", "2026-09-18T00:00:00.000Z", 20_000);
    // The vendor reset the meter with the same reset instant: a new segment starts at 5 %.
    reading(f, "2026-09-18T12:00:00.000Z", 5);
    claudeEvent(f, "next-segment", "2026-09-19T00:00:00.000Z", 30_000);
    f.prepareFacts();
    const segments = claudeWeeklyRegisterWindows(f.db, ACCOUNTS.a).filter(window => Date.parse(window.start) >= Date.parse(TIMES.start));
    expect(segments.map(window => [window.start, window.end])).toEqual([[TIMES.start, "2026-09-18T12:00:00.000Z"],
      ["2026-09-18T12:00:00.000Z", TIMES.reset]]);
    const estimates = readWindowEndEstimates(f.db, "claude", ACCOUNTS.a);
    // 24 → 90 % for the 9 000 + 50 000 tokens between them; 20 000 tokens before the split, none of the next segment's.
    expect(estimates.get(segments[0]!.id)).toMatchObject({ basis: "estimate", end: "2026-09-18T12:00:00.000Z",
      last_reading: { percent: 90 }, after: { tokens: 20_000 }, calibration: { from: { percent: 24 }, to: { percent: 90 } } });
    expect(estimates.get(segments[0]!.id)).toMatchObject({ percent: 100 });
    expect(estimates.get(segments[0]!.id)!.uncapped!).toBeCloseTo(90 + 20_000 / (59_000 / 66), 1);
  } finally { f.teardown(); }
});

test("the migration creates the table the producer ensures", () => {
  const migrated = new SqliteDatabase(":memory:"), ensured = new SqliteDatabase(":memory:");
  try {
    migrated.exec(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0075_window_end_estimates.sql"), "utf8"));
    ensured.exec(WINDOW_END_ESTIMATE_SCHEMA_SQL);
    const shape = (db: SqliteDatabase) => ({ columns: db.query("PRAGMA table_xinfo(window_end_estimates)").all(),
      keys: db.query("PRAGMA index_list(window_end_estimates)").all() });
    expect(shape(migrated)).toEqual(shape(ensured));
  } finally { migrated.close(); ensured.close(); }
});

test("a probe-cadence gap or a fraction of a point keeps the window measured", () => {
  // Last reading 20 min before the end: a cadence gap, however much usage follows.
  const near = windowOf([["2026-10-02T00:00:00.000Z", 50, 500], ["2026-10-07T23:40:00.000Z", 85, 350]], 1_200);
  expect(windowEndEstimate(near.window, near.sums, null)!.estimate).toBeNull();
  // A long gap that adds only $5 at $10/pt (0.5 pp): below the least rise.
  const small = windowOf([["2026-10-02T00:00:00.000Z", 50, 500], ["2026-10-05T00:00:00.000Z", 85, 350]], 855);
  expect(windowEndEstimate(small.window, small.sums, null)!.estimate).toBeNull();
});
