import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { WINDOW_POINT_VALUES_SCHEMA_SQL, type WindowPointValueRow } from "../db/window-point-values";
import { markWindowAnswersDirty } from "../db/window-answers";
import { PLAN_PERIODS, recordPeriodReading, replaceDeclaredPeriods } from "../db/period-store";
import type { WindowUsage } from "../shared/codex-accounting";
import { CATALOG, D, FIVE, H, MAIN, NOW, database, iso } from "./billing-cycles.fixture";
import { advanceBillingCycles, resetBillingCycleClock, type CycleDetail, type StoredCycleRow } from "./billing-cycle-producer";
import type { PlansCatalog } from "./plans-catalog";
import type { PlansConfig } from "./plans";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import type { RunningUsage } from "./window-usage";
import {
  advanceWindowPointValues, cyclePointCalibration, cycleRegimeFactors, planKeyOf, windowPointValue, windowPointValuesStale, windowRegime,
  type PointValueInput,
} from "./window-point-values";

const PLANS: PlansConfig = { segments: [], capacity_regimes: [] };

/* ------------------------------------------------------------------------------------------ */
/* Schema                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const tables = (db: Database) => (db.query(`SELECT name, sql FROM sqlite_master WHERE name IN ('window_point_values','window_point_value_dirty',
  'window_point_values_plan') ORDER BY name`).all() as Array<{ name: string; sql: string }>).map((row) => [row.name, row.sql.replace(/\s+/g, " ").replace("IF NOT EXISTS ", "")]);

test("migration 0076 creates the tables and index exactly as the schema module declares them", () => {
  const reference = new Database(":memory:");
  reference.exec(WINDOW_POINT_VALUES_SCHEMA_SQL);
  expect(tables(database())).toEqual(tables(reference));
  expect(tables(reference).map(([name]) => name)).toEqual(["window_point_value_dirty", "window_point_values", "window_point_values_plan"]);
});

/* ------------------------------------------------------------------------------------------ */
/* One window                                                                                  */
/* ------------------------------------------------------------------------------------------ */

const START = "2026-10-01T00:00:00.000Z", END = "2026-10-08T00:00:00.000Z", AFTER = Date.parse("2026-10-09T00:00:00Z");
const usageOf = (extra: Partial<WindowUsage> = {}): WindowUsage => ({ events: 100, tokens: 1_000_000, input: 800_000, cached: 600_000, output: 200_000,
  fast_tokens: 0, unknown_tokens: 0, priced_tokens: 1_000_000, unpriced_events: 0, api_standard: 500, api_normalized: 450, credits_low: 10_000,
  credits_high: 12_000, ...extra });
const running = (share: number): RunningUsage => ({ events: 100 * share, tokens: 1_000_000 * share, priced_tokens: 1_000_000 * share, unpriced_events: 0,
  api_standard: 500 * share, credits_low: 10_000 * share, credits_high: 12_000 * share, api_normalized: 450 * share });
function windowOf(readings: Array<[string, number]>, extra: Partial<ProbeLimitWindow> = {}): ProbeLimitWindow {
  return { id: "w", account: "acc", counter: MAIN, start: START, end: END, reset: END, cycle_end_basis: "scheduled", window_minutes: 10080,
    readings: readings.map(([ts, percent]) => ({ ts, percent, source: "probe" as const })), startDrop: null, endDrop: null,
    plan: "pro", plan_detail: null, declared_plan_meter_mismatch: false, ...extra };
}
const input = (window: ProbeLimitWindow, extra: Partial<PointValueInput> = {}): PointValueInput => ({ provider: "codex", window, usage: usageOf(),
  factor: 1, now: AFTER, runningAt: () => null, ...extra });

test("a window below the limit counts its last % from the reset with its paired usage", () => {
  const value = windowPointValue(input(windowOf([["2026-10-02T00:00:00.000Z", 10], ["2026-10-05T00:00:00.000Z", 45]])));
  expect(value).toMatchObject({ basis: "final", pp: 45, events: 100, tokens_input: 800_000, tokens_cached: 600_000, tokens_output: 200_000,
    api_standard: 500, api_normalized: 450, credits_low: 10_000, credits_high: 12_000, unpriced_events: 0, status: "eligible", scope: null,
    regime_factor: 1, plan: "pro", window_start: START, window_end: END });
});

test("a later fragment of one allowance counts its rise from the meter where the previous fragment left it", () => {
  const value = windowPointValue(input(windowOf([["2026-10-02T00:00:00.000Z", 50], ["2026-10-05T00:00:00.000Z", 80]]), { meterStart: 40 }));
  expect(value).toMatchObject({ basis: "final", pp: 40 });
  // At the limit: the rest up to 100.
  expect(windowPointValue(input(windowOf([["2026-10-02T00:00:00.000Z", 70], ["2026-10-04T00:00:00.000Z", 100]]), { meterStart: 40,
    runningAt: () => running(0.5) }))).toMatchObject({ basis: "at_limit", pp: 60 });
});

test("the producer measures a chained fragment from the previous fragment's last reading", () => {
  const db = database();
  // One weekly allowance split at day 3 without a drop (0 → 40, then 40 → 80, the same planned reset).
  const start = FIRST, split = FIRST + 3 * D, end = FIRST + 7 * D;
  const insert = (seq: number, from: number, until: number, percents: number[]) => {
    const readings = percents.map((percent, i) => ({ ts: iso(from + (i + 1) * (until - from) / (percents.length + 1)), percent, source: "probe" }));
    db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_detail,
      plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input) VALUES('codex','codex1',?,?,?,?,?,?,'reset',10080,'pro',NULL,0,?,NULL,NULL,NULL,1,?)`)
      .run(MAIN, seq, `w${seq}`, iso(from), iso(until), iso(end), JSON.stringify(readings), iso(from));
    const usage = { events: 40, tokens: 800_000, input: 700_000, cached: 400_000, output: 100_000, fast_tokens: 0, unknown_tokens: 0, priced_tokens: 800_000,
      unpriced_events: 0, api_standard: 400, api_normalized: 400, credits_low: 8000, credits_high: 9000 };
    db.query(`INSERT INTO window_usage(provider,account,counter,window_id,start_ts,end_ts,cycle,rail,readings,slices,reference)
      VALUES('codex','codex1',?,?,?,?,?,'{}',?,'[]',NULL)`).run(MAIN, `w${seq}`, iso(from), iso(until), JSON.stringify({ usage }),
      JSON.stringify(readings.map((r) => ({ ts: r.ts, usage: { events: 1, tokens: 1, priced_tokens: 1, unpriced_events: 0, api_standard: 1, credits_low: 1, credits_high: 1, api_normalized: 1 } }))));
  };
  insert(0, start, split, [10, 25, 40]);
  insert(1, split, end, [45, 60, 80]);
  settle(db, end + D);
  expect(stored(db).map((row) => row.pp)).toEqual([40, 40]);
});

test("a window without a confirmed reset counts its rise from the first reading", () => {
  const value = windowPointValue(input(windowOf([["2026-10-02T00:00:00.000Z", 30], ["2026-10-05T00:00:00.000Z", 75]],
    { startDrop: { before: 90, after: 30 } })));
  expect(value).toMatchObject({ basis: "final", pp: 45, status: "eligible" });
});

test("a window that reached the limit counts 100 points with the traffic up to that reading, categories split like its usage", () => {
  const asked: Array<[number, string]> = [];
  const value = windowPointValue(input(windowOf([["2026-10-02T00:00:00.000Z", 40], ["2026-10-04T00:00:00.000Z", 99.6], ["2026-10-05T00:00:00.000Z", 100]]),
    { runningAt: (index, ts) => { asked.push([index, ts]); return running(0.5); } }));
  expect(asked).toEqual([[1, "2026-10-04T00:00:00.000Z"]]);
  expect(value).toMatchObject({ basis: "at_limit", pp: 100, events: 50, tokens_input: 400_000, tokens_cached: 300_000, tokens_output: 100_000,
    api_standard: 250, api_normalized: 225, credits_low: 5_000, credits_high: 6_000, status: "eligible" });
  // Sums that do not hold the reading at the limit (being recomputed) are missing, never the whole window.
  expect(windowPointValue(input(windowOf([["2026-10-02T00:00:00.000Z", 99.9]])))).toMatchObject({ basis: "at_limit", pp: 100, events: null,
    status: "sums_missing" });
});

test("each exclusion is stored with its reason and the sums it has", () => {
  const rising = [["2026-10-02T00:00:00.000Z", 10], ["2026-10-05T00:00:00.000Z", 45]] as Array<[string, number]>;
  expect(windowPointValue(input(windowOf(rising), { now: Date.parse("2026-10-06T00:00:00Z") })).status).toBe("open");
  expect(windowPointValue(input(windowOf([])))).toMatchObject({ status: "no_percent", pp: null, events: 100 });
  expect(windowPointValue(input(windowOf([["2026-10-05T00:00:00.000Z", 15]])))).toMatchObject({ status: "small_span", pp: 15 });
  expect(windowPointValue(input(windowOf(rising), { usage: null }))).toMatchObject({ status: "sums_missing", events: null, api_standard: null });
  expect(windowPointValue(input(windowOf(rising), { usage: usageOf({ events: 0, tokens: 0, input: 0, cached: 0, output: 0, api_standard: 0 }) })).status)
    .toBe("sums_missing");
  // Unpriced calls are judged by their tokens: 11 % of the tokens is out, 30 small calls holding 10 % are in.
  expect(windowPointValue(input(windowOf(rising), { usage: usageOf({ unpriced_events: 5, priced_tokens: 890_000 }) }))).toMatchObject({
    status: "unpriced", unpriced_events: 5 });
  expect(windowPointValue(input(windowOf(rising), { usage: usageOf({ unpriced_events: 30, priced_tokens: 900_000 }) })).status).toBe("eligible");
  expect(windowPointValue(input(windowOf(rising), { factor: null }))).toMatchObject({ status: "regime_mixed", regime_factor: null });
  // A plan change inside the window keeps its factor but cannot calibrate either plan.
  expect(windowPointValue(input(windowOf(rising, { plan_detail: { label: "plus → pro", multiplier: null, status: "mixed" } })))).toMatchObject({
    status: "regime_mixed", regime_factor: 1 });
});

test("Claude rows are scoped to observed traffic; credits exist only for Codex calls billed in credits", () => {
  const rising = windowOf([["2026-10-02T00:00:00.000Z", 10], ["2026-10-05T00:00:00.000Z", 45]]);
  expect(windowPointValue(input(rising, { provider: "claude" }))).toMatchObject({ scope: "observed_partial_traffic", credits_low: null,
    credits_high: null, status: "eligible" });
  expect(windowPointValue(input(rising, { usage: usageOf({ credits_unavailable_events: 3 }) }))).toMatchObject({ credits_low: null, credits_high: null });
});

const REGIME_CATALOG: PlansCatalog = { provider_groups: [{ id: "codex", label: "Codex", aliases: ["codex"], plans: [
  { plan_id: "codex-pro", label: "Pro", aliases: ["pro"], versions: [{ from: null, usd_per_month: 200 }] },
  { plan_id: "codex-pro-5x", label: "Pro 5x", aliases: ["pro-5x"], versions: [{ from: null, usd_per_month: 100 }] }] }] };

test("a window's regime factor: 1 by default, a configured regime, the Pro 5× launch promotion; mixed days weighted by time", () => {
  const window = windowOf([]);
  expect(windowRegime(window, "codex", PLANS, REGIME_CATALOG)).toEqual({ factor: 1, mixed: false });
  const regime = (from: string, until: string): PlansConfig => ({ capacity_regimes: [{ id: "promo", subscription: "acc", factor: 2, from, until, source: "promotion" }] });
  expect(windowRegime(window, "codex", regime("2026-09-01", "2026-10-31"), REGIME_CATALOG)).toEqual({ factor: 2, mixed: false });
  // 10-01..10-04 at 2, 10-05..10-07 at 1: 4 of 7 days doubled.
  expect(windowRegime(window, "codex", regime("2026-09-01", "2026-10-04"), REGIME_CATALOG)).toEqual({ factor: Math.round((4 * 2 + 3) / 7 * 1e6) / 1e6, mixed: true });
  const may = { ...window, plan: "pro-5x", start: "2026-05-10T00:00:00.000Z", end: "2026-05-17T00:00:00.000Z" };
  expect(windowRegime(may, "codex", PLANS, REGIME_CATALOG)).toEqual({ factor: 2, mixed: false });
  // 05-28..05-31 doubled, 06-01..06-03 not; the window starts at noon, so its first day counts half.
  expect(windowRegime({ ...may, start: "2026-05-28T12:00:00.000Z", end: "2026-06-04T00:00:00.000Z" }, "codex", PLANS, REGIME_CATALOG))
    .toEqual({ factor: Math.round((3.5 * 2 + 3) / 6.5 * 1e6) / 1e6, mixed: true });
  // The promotion is weekly only.
  expect(windowRegime({ ...may, window_minutes: 300, end: "2026-05-10T05:00:00.000Z" }, "codex", PLANS, REGIME_CATALOG)).toEqual({ factor: 1, mixed: false });
  // A mixed window keeps its weighted factor but cannot calibrate.
  expect(windowPointValue(input(windowOf([["2026-10-02T00:00:00.000Z", 10], ["2026-10-05T00:00:00.000Z", 45]]), { factor: 1.571429, regimeMixed: true })))
    .toMatchObject({ status: "regime_mixed", regime_factor: 1.571429 });
});

/* ------------------------------------------------------------------------------------------ */
/* Calibration of a cycle                                                                      */
/* ------------------------------------------------------------------------------------------ */

function row(start: string, days: number, pp: number, api: number, extra: Partial<WindowPointValueRow> = {}): WindowPointValueRow {
  const s = Date.parse(start);
  return { provider: "codex", account: "acc", counter: MAIN, window_start: iso(s), window_end: iso(s + days * D), plan: "pro", regime_factor: 1, pp,
    basis: "final", events: 10, tokens_input: api * 1000, tokens_cached: api * 500, tokens_output: api * 100, api_standard: api, api_normalized: api,
    credits_low: api * 20, credits_high: api * 25, unpriced_events: 0, status: "eligible", scope: null, inputs_rev: "x", computed_at: "x", ...extra };
}
const CYCLE = { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2026-10-01T00:00:00Z"), plan: "pro" };

test("a cycle with 100 points of its own windows calibrates from them only", () => {
  const rows = [row("2026-08-20", 7, 80, 4000), row("2026-09-02", 7, 60, 1200), row("2026-09-10", 7, 50, 1000), row("2026-10-02", 7, 90, 9000)];
  const calibration = cyclePointCalibration(rows, CYCLE)!;
  expect(calibration).toMatchObject({ windows: 2, inside: 2, pp: 110, credits_pp: 110, from: rows[1]!.window_start, until: rows[2]!.window_end });
  expect(calibration.per_point.api_standard).toBeCloseTo(2200 / 110, 9);
  expect(calibration.per_point.tokens_input).toBeCloseTo(2_200_000 / 110, 6);
  expect(calibration.per_point.credits_low).toBeCloseTo(44_000 / 110, 6);
});

test("below 100 points the nearest windows of the same plan outside the cycle are added; another plan or an exclusion never", () => {
  const rows = [row("2026-07-01", 7, 90, 900), row("2026-08-20", 7, 50, 500), row("2026-09-05", 7, 40, 400), row("2026-09-27", 7, 30, 330),
    row("2026-10-03", 7, 50, 550), row("2026-10-20", 7, 60, 600),
    row("2026-08-25", 7, 99, 99_000, { plan: "plus" }), row("2026-08-26", 7, 99, 99_000, { status: "small_span" })];
  const calibration = cyclePointCalibration(rows, CYCLE)!;
  // Inside: 40 pp. The window across the end (distance 0), then 10-03 (2 days after) and 08-20 (5 days before): 40 + 30 + 50 = 120.
  expect(calibration).toMatchObject({ windows: 3, inside: 1, pp: 120 });
  expect(calibration.per_point.api_standard).toBeCloseTo(1280 / 120, 9);
  expect(calibration.outliers).toEqual({ count: 0, starts: [] });
  expect(cyclePointCalibration([row("2026-09-05", 7, 40, 400, { plan: "plus" })], CYCLE)).toBeNull();
  // Too few points in the whole account: everything there is, flagged by the caller.
  expect(cyclePointCalibration([row("2026-09-05", 7, 40, 400)], CYCLE)).toMatchObject({ windows: 1, pp: 40 });
});

test("plans match by catalog plan id: the meter's \"prolite\" windows calibrate a declared \"pro-5x\" cycle, another plan still never", () => {
  const key = planKeyOf(CATALOG, "codex");
  expect([key("prolite"), key("pro-5x"), key("pro"), key("free")]).toEqual(["codex-pro-5x", "codex-pro-5x", "codex-pro", "free"]);
  const rows = [row("2026-09-02", 7, 60, 1200, { plan: "prolite" }), row("2026-09-10", 7, 50, 1000, { plan: "prolite" }),
    row("2026-09-18", 7, 99, 99_000, { plan: "pro" })];
  const cycle = { ...CYCLE, plan: "pro-5x" };
  expect(cyclePointCalibration(rows, cycle, key)).toMatchObject({ windows: 2, inside: 2, pp: 110 });
  expect(cyclePointCalibration(rows, cycle, key)!.per_point.api_standard).toBeCloseTo(2200 / 110, 9);
  // By name alone (the former rule) the cycle has no calibration.
  expect(cyclePointCalibration(rows, cycle)).toBeNull();
});

test("an under-observed window is screened out by its credits per point and listed in the provenance", () => {
  // 20–25 credits per $ in every window; the 09-17 window holds a quarter of its neighbours' credits per point.
  const rows = [row("2026-09-02", 7, 100, 1000), row("2026-09-10", 7, 100, 1100), row("2026-09-17", 7, 99, 250), row("2026-09-24", 7, 100, 900),
    row("2026-08-01", 7, 100, 1050)];
  const calibration = cyclePointCalibration(rows, CYCLE)!;
  expect(calibration).toMatchObject({ windows: 3, inside: 3, pp: 300, outliers: { count: 1, starts: [rows[2]!.window_start] } });
  expect(calibration.per_point.api_standard).toBeCloseTo(3000 / 300, 9);
  // A window at 0.55 of the median stays.
  const kept = cyclePointCalibration([...rows.slice(0, 2), row("2026-09-17", 7, 100, 550), rows[3]!], CYCLE)!;
  expect(kept).toMatchObject({ windows: 4, outliers: { count: 0 } });
  // A dropped window far from what the calibration uses is not listed for this cycle.
  const far = cyclePointCalibration([...rows.slice(0, 2), rows[3]!, row("2026-06-01", 7, 100, 100)], CYCLE)!;
  expect(far.outliers).toEqual({ count: 0, starts: [] });
  // Nor one across the cycle's end when the windows inside already hold 100 points.
  const across = cyclePointCalibration([...rows.slice(0, 2), rows[3]!, row("2026-09-28", 7, 100, 200)], CYCLE)!;
  expect(across).toMatchObject({ windows: 3, inside: 3, outliers: { count: 0, starts: [] } });
  // When the cycle borrows, a dropped window as near as the borrowed ones is listed.
  const borrowing = cyclePointCalibration([row("2026-09-10", 7, 60, 660), row("2026-09-28", 7, 100, 200), row("2026-10-03", 7, 50, 500),
    row("2026-08-20", 7, 50, 500)], CYCLE)!;
  expect(borrowing).toMatchObject({ inside: 1, windows: 2, outliers: { count: 1, starts: [iso(Date.parse("2026-09-28"))] } });
});

test("the screening compares one unit: dollars when a window of the reference set has no credits", () => {
  // Plus: two windows of unseen traffic at $0.03–0.13 per point among $0.9–1.5 ones; one normal window carries credits.
  const rows = [row("2026-03-26", 1, 94, 11.4, { credits_low: null, credits_high: null }), row("2026-04-11", 7, 95, 2.9, { credits_low: null, credits_high: null }),
    row("2026-02-05", 7, 80, 96, { credits_low: null, credits_high: null }), row("2026-02-15", 7, 70, 105, { credits_low: null, credits_high: null }),
    row("2026-07-02", 4, 62, 71.6, { credits_low: 1789, credits_high: 4393 })];
  const cycle = { start: Date.parse("2026-07-02T00:00:00Z"), end: Date.parse("2026-07-06T12:00:00Z"), plan: "pro" };
  const calibration = cyclePointCalibration(rows, cycle)!;
  expect(calibration.outliers.count).toBe(2);
  expect(calibration.outliers.starts).toEqual([rows[0]!.window_start, rows[1]!.window_start]);
  // The credit-bearing window is kept and the cycle borrows the normal ones, farther away than the dropped two.
  expect(calibration.inside).toBe(1);
  expect(calibration.per_point.api_standard).toBeGreaterThan(0.9);
  expect(calibration.per_point.api_standard).toBeLessThan(1.6);
  // With credits on every window of the set they decide, as before.
  const credited = rows.map((r) => ({ ...r, credits_low: (r.api_standard ?? 0) * 20, credits_high: (r.api_standard ?? 0) * 25 }));
  expect(cyclePointCalibration(credited, cycle)!.outliers.count).toBe(2);
});

test("with fewer than three windows to compare nothing is screened out", () => {
  const rows = [row("2026-09-02", 7, 100, 1000), row("2026-09-17", 7, 99, 250)];
  expect(cyclePointCalibration(rows, CYCLE)).toMatchObject({ windows: 2, pp: 199, outliers: { count: 0, starts: [] } });
  // Fewer than three near the cycle: the reference falls back to all of the account's windows of the plan.
  const wide = [...rows, row("2026-03-01", 7, 100, 1000), row("2026-04-01", 7, 100, 1000)];
  expect(cyclePointCalibration(wide, CYCLE)).toMatchObject({ outliers: { count: 1, starts: [rows[1]!.window_start] } });
});

test("calibration values are at regime factor 1; windows without credits do not dilute the credit value", () => {
  const rows = [row("2026-09-02", 7, 50, 2000, { regime_factor: 2 }), row("2026-09-10", 7, 50, 1000, { credits_low: null, credits_high: null })];
  const calibration = cyclePointCalibration(rows, CYCLE)!;
  expect(calibration.per_point.api_standard).toBeCloseTo((1000 + 1000) / 100, 9);
  expect(calibration).toMatchObject({ credits_pp: 50 });
  expect(calibration.per_point.credits_low).toBeCloseTo(40_000 / 2 / 50, 9);
});

test("a cycle counts each window's share and each idle gap at that window's factor; the effective factor is their mean", () => {
  const rows = [row("2026-09-02", 7, 50, 2000, { regime_factor: 2 }), row("2026-09-10", 7, 50, 1000), row("2026-09-17", 7, 50, 1000, { regime_factor: null })];
  const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
  // A full window at 2, a full one at 1, a gap of 0.5 after the doubled one and 0.5 before any window (1).
  expect(cycleRegimeFactors(rows, [{ start: at("2026-09-02"), share: 1 }, { start: at("2026-09-10"), share: 1 }],
    [{ after: at("2026-09-02"), idle: 0.5 }, { after: null, idle: 0.5 }])).toEqual({ factor: (2 + 1 + 1 + 0.5) / 3, weighted: true });
  expect(cycleRegimeFactors(rows, [{ start: at("2026-09-10"), share: 1 }], [])).toEqual({ factor: 1, weighted: false });
  // A window of the cycle without any factor leaves the capacity unknown.
  expect(cycleRegimeFactors(rows, [{ start: at("2026-09-17"), share: 0.5 }], []).factor).toBeNull();
  // Windows without a stored row count at 1; no window at all is factor 1.
  expect(cycleRegimeFactors([], [{ start: at("2026-09-24"), share: 1 }], [])).toEqual({ factor: 1, weighted: false });
});

/* ------------------------------------------------------------------------------------------ */
/* The producer step                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** A weekly window ending at `final` % (readings every 12 h) with full window sums: $10 and 20 000 tokens per point. */
function addWindow(db: Database, account: string, startMs: number, final: number, extra: { limitAt?: number; plan?: string; counter?: string } = {}) {
  const counter = extra.counter ?? MAIN, minutes = counter === MAIN ? 10080 : 300;
  const endMs = startMs + minutes * 60_000;
  const last = Math.min(endMs, NOW) - H;
  const steps = 10;
  const readings = Array.from({ length: steps }, (_, i) => ({ ts: iso(startMs + (i + 1) * (last - startMs) / steps),
    percent: extra.limitAt !== undefined && i >= extra.limitAt ? 100 : Math.round(final * (i + 1) / steps), source: "probe" }));
  const id = JSON.stringify([account, counter, iso(startMs)]);
  const seq = (db.query("SELECT COUNT(*) AS n FROM limit_windows WHERE provider='codex' AND account=? AND counter=?").get(account, counter) as { n: number }).n;
  db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_detail,
    plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input) VALUES('codex',?,?,?,?,?,?,?,'reset',?,?,NULL,0,?,NULL,NULL,NULL,1,?)`)
    .run(account, counter, seq, id, iso(startMs), iso(endMs), iso(endMs), minutes, extra.plan ?? "pro", JSON.stringify(readings), iso(startMs));
  const at = (percent: number): RunningUsage => ({ events: percent, tokens: 20_000 * percent, priced_tokens: 20_000 * percent, unpriced_events: 0,
    api_standard: 10 * percent, credits_low: 200 * percent, credits_high: 250 * percent, api_normalized: 9 * percent });
  // Past the limit the traffic keeps growing while the meter stays at 100.
  const spent = readings.map((r, i) => extra.limitAt !== undefined && i > extra.limitAt ? 100 + 10 * (i - extra.limitAt) : r.percent);
  const total = at(spent.at(-1)!);
  const usage: WindowUsage = { events: total.events, tokens: total.tokens, input: total.tokens * 0.9, cached: total.tokens * 0.6, output: total.tokens * 0.1,
    fast_tokens: 0, unknown_tokens: 0, priced_tokens: total.tokens, unpriced_events: 0, api_standard: total.api_standard, api_normalized: total.api_normalized,
    credits_low: total.credits_low, credits_high: total.credits_high };
  db.query(`INSERT OR REPLACE INTO window_usage(provider,account,counter,window_id,start_ts,end_ts,cycle,rail,readings,slices,reference)
    VALUES('codex',?,?,?,?,?,?,'{}',?,'[]',NULL)`).run(account, counter, id, iso(startMs), iso(endMs), JSON.stringify({ usage }),
    JSON.stringify(readings.map((r, i) => ({ ts: r.ts, usage: at(spent[i]!) }))));
  return id;
}
const FIRST = Date.parse("2026-08-31T06:00:00Z");
function seed(db: Database) {
  for (const account of ["codex1", "codex2"]) {
    for (let i = 0; i < 6; i++) addWindow(db, account, FIRST + i * 7.5 * D, 40 + 5 * i, i === 2 ? { limitAt: 6 } : {});
    recordPeriodReading(db, PLAN_PERIODS, { provider: "codex", subject: account, ts: "2026-09-09T15:11:32.698Z", value: "pro" });
    recordPeriodReading(db, PLAN_PERIODS, { provider: "codex", subject: account, ts: "2026-10-08T14:00:00.000Z", value: "pro" });
  }
}
const stored = (db: Database) => db.query("SELECT * FROM window_point_values ORDER BY provider, account, counter, window_start").all() as WindowPointValueRow[];
/** Stores the billing cycles: a changed row marks only cycles that exist. */
function storeCycles(db: Database, now = NOW) {
  resetBillingCycleClock();
  for (let i = 0; i < 20 && advanceBillingCycles(db, { catalog: CATALOG, now, budgetMs: 10_000 })?.pending; i++);
}
const withoutClock = (rows: WindowPointValueRow[]) => rows.map(({ computed_at: _c, ...rest }) => rest);
function settle(db: Database, now = NOW, plans = PLANS) {
  for (let i = 0; i < 20; i++) {
    const turn = advanceWindowPointValues(db, { plans, catalog: CATALOG, now, budgetMs: 10_000 })!;
    if (!turn.pending) return turn;
  }
  throw new Error("point values did not settle");
}
/** The same rows computed from nothing: the reference the incremental step must equal. */
function full(db: Database, now = NOW, plans = PLANS): WindowPointValueRow[] {
  const fresh = database();
  for (const table of ["limit_windows", "window_usage"])
    for (const r of db.query(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
      const columns = Object.keys(r);
      fresh.query(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map((c) => r[c] as string | number | null));
    }
  settle(fresh, now, plans);
  return stored(fresh);
}

test("the first run fills every window in bounded turns; the rows equal a full computation; a repeat writes nothing", () => {
  const db = database();
  seed(db);
  const first = advanceWindowPointValues(db, { plans: PLANS, catalog: CATALOG, now: NOW, budgetMs: 0 })!;
  expect(first).toMatchObject({ progressed: true });
  settle(db);
  const rows = stored(db);
  expect(rows.length).toBe(12);
  expect(rows.filter((r) => r.account === "codex1").map((r) => [r.status, r.basis, r.pp])).toEqual([
    ["eligible", "final", 40], ["eligible", "final", 45], ["eligible", "at_limit", 100], ["eligible", "final", 55], ["eligible", "final", 60],
    ["open", "final", 65]]);
  // At the limit: the traffic up to the first 100 % reading (60 points' worth of growth to 100), not the 30 points after it.
  expect(rows.find((r) => r.basis === "at_limit")).toMatchObject({ api_standard: 1000, events: 100, credits_low: 20_000, tokens_input: 1_800_000 });
  expect(withoutClock(rows)).toEqual(withoutClock(full(db)));
  expect(windowPointValuesStale(db, "codex", "codex1", NOW)).toBe(false);
  const again = settle(db);
  expect(again).toMatchObject({ written: 0, removed: 0, backlog: 0 });
  expect(stored(db)).toEqual(rows);
});

test("a declared \"pro-5x\" cycle is calibrated from the meter's \"prolite\" windows, and their changes mark it", () => {
  const db = database();
  for (let i = 0; i < 6; i++) addWindow(db, "codex1", FIRST + i * 7.5 * D, 40 + 5 * i, { plan: "prolite" });
  replaceDeclaredPeriods(db, PLAN_PERIODS, [{ provider: "codex", subject: "codex1", from: "2026-08-31T06:00:00.000Z", until: null, value: "pro-5x",
    origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "payment", amountMinor: 10000, currency: "USD" }]);
  settle(db);
  storeCycles(db);
  const cycles = db.query("SELECT start_ts, plan, capacity_usd, flags, detail FROM billing_cycles ORDER BY start_ts").all() as
    Array<{ start_ts: string; plan: string; capacity_usd: number | null; flags: string; detail: string }>;
  expect(cycles.map((c) => c.plan)).toEqual(["pro-5x", "pro-5x"]);
  const first = cycles[0]!;
  expect(first.capacity_usd).not.toBeNull();
  expect(JSON.parse(first.flags)).not.toContain("capacity_uncalibrated");
  expect((JSON.parse(first.detail) as CycleDetail).capacity!.calibration.windows).toBeGreaterThan(0);
  // A corrected "prolite" window marks the "pro-5x" cycles holding or borrowing it.
  db.exec("DELETE FROM billing_cycle_dirty");
  const window = db.query("SELECT window_id, start_ts, end_ts, cycle FROM window_usage ORDER BY start_ts LIMIT 1").get() as
    { window_id: string; start_ts: string; end_ts: string; cycle: string };
  const usage = JSON.parse(window.cycle) as { usage: WindowUsage };
  usage.usage.api_standard *= 2;
  db.transaction(() => {
    db.query("UPDATE window_usage SET cycle=? WHERE window_id=?").run(JSON.stringify(usage), window.window_id);
    markWindowAnswersDirty(db, { provider: "codex", account: "codex1", fromMs: Date.parse(window.start_ts), untilMs: Date.parse(window.end_ts) });
  })();
  settle(db, NOW + 60_000);
  expect((db.query("SELECT from_ms, until_ms FROM billing_cycle_dirty WHERE account='codex1'").all() as Array<{ from_ms: number; until_ms: number | null }>)
    .some((row) => row.from_ms <= Date.parse(first.start_ts) && (row.until_ms === null || row.until_ms > Date.parse(first.start_ts)))).toBe(true);
});

test("a changed window recomputes only its account's rows and marks only that account's billing cycles", () => {
  const db = database();
  seed(db);
  settle(db);
  storeCycles(db);
  db.exec("DELETE FROM billing_cycle_dirty");
  const before = stored(db);
  // codex2's second window gets corrected sums; its publication marks codex2's window range.
  const window = db.query("SELECT window_id, start_ts, end_ts, cycle FROM window_usage WHERE account='codex2' ORDER BY start_ts LIMIT 1 OFFSET 1")
    .get() as { window_id: string; start_ts: string; end_ts: string; cycle: string };
  const cycle = JSON.parse(window.cycle) as { usage: WindowUsage };
  cycle.usage.api_standard *= 2;
  db.transaction(() => {
    db.query("UPDATE window_usage SET cycle=? WHERE account='codex2' AND window_id=?").run(JSON.stringify(cycle), window.window_id);
    markWindowAnswersDirty(db, { provider: "codex", account: "codex2", fromMs: Date.parse(window.start_ts), untilMs: Date.parse(window.end_ts) });
  })();
  expect(windowPointValuesStale(db, "codex", "codex2", NOW)).toBe(true);
  expect(windowPointValuesStale(db, "codex", "codex1", NOW)).toBe(false);
  const turn = settle(db, NOW + 60_000);
  expect(turn.written).toBe(1);
  const after = stored(db);
  const changed = after.filter((r, i) => r.computed_at !== before[i]!.computed_at).map((r) => [r.account, r.window_start]);
  expect(changed).toEqual([["codex2", window.start_ts]]);
  expect(db.query("SELECT provider, account FROM billing_cycle_dirty").all()).toEqual([{ provider: "codex", account: "codex2" }]);
  expect(withoutClock(after)).toEqual(withoutClock(full(db, NOW + 60_000)));
});

test("an open window closed by the clock and a new regime are picked up without any new reading", () => {
  const db = database();
  seed(db);
  settle(db);
  const later = Date.parse("2026-10-20T00:00:00Z");
  settle(db, later);
  expect(stored(db).filter((r) => r.account === "codex1").map((r) => r.status)).toEqual(Array(6).fill("eligible"));
  const regime: PlansConfig = { capacity_regimes: [{ id: "promo", subscription: "codex1", factor: 2, from: "2026-08-01", until: "2026-12-31", source: "promotion" }] };
  db.exec("DELETE FROM billing_cycle_dirty");
  settle(db, later, regime);
  expect(stored(db).map((r) => [r.account, r.regime_factor])).toEqual([...Array(6).fill(["codex1", 2]), ...Array(6).fill(["codex2", 1])]);
  expect(db.query("SELECT account FROM billing_cycle_dirty").all()).toEqual([{ account: "codex1" }]);
  // The marked extent runs past the last changed window: its idle gap and bonus time reach the next cycle.
  const extent = db.query("SELECT from_ms, until_ms FROM billing_cycle_dirty WHERE account='codex1'").get() as { from_ms: number; until_ms: number | null };
  const lastEnd = Math.max(...stored(db).filter((r) => r.account === "codex1").map((r) => Date.parse(r.window_end)));
  expect(extent.until_ms === null || extent.until_ms >= lastEnd + 2 * 7 * D).toBe(true);
  expect(withoutClock(stored(db))).toEqual(withoutClock(full(db, later, regime)));
});

test("a month-long window closing is reached through the start bound like a weekly one", () => {
  const db = database();
  const start = Date.parse("2026-09-01T00:00:00Z"), end = start + 30 * D;
  const readings = [{ ts: iso(start + D), percent: 10, source: "probe" }, { ts: iso(end - D), percent: 70, source: "probe" }];
  db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_detail,
    plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input) VALUES('grok','g1','month',0,'m0',?,?,?,'scheduled',43200,'super',NULL,0,?,NULL,NULL,NULL,1,?)`)
    .run(iso(start), iso(end), iso(end), JSON.stringify(readings), iso(start));
  const usage = { events: 70, tokens: 700_000, input: 600_000, cached: 300_000, output: 100_000, fast_tokens: 0, unknown_tokens: 0, priced_tokens: 700_000,
    unpriced_events: 0, api_standard: 70, api_normalized: 70, credits_low: 0, credits_high: 0 };
  db.query(`INSERT INTO window_usage(provider,account,counter,window_id,start_ts,end_ts,cycle,rail,readings,slices,reference)
    VALUES('grok','g1','month','m0',?,?,?,'{}',?,'[]',NULL)`).run(iso(start), iso(end), JSON.stringify({ usage }),
    JSON.stringify(readings.map((r) => ({ ts: r.ts, usage: { events: 1, tokens: 1, priced_tokens: 1, unpriced_events: 0, api_standard: 1, credits_low: 0, credits_high: 0, api_normalized: 1 } }))));
  settle(db, start + 20 * D);
  expect(stored(db).map((row) => row.status)).toEqual(["open"]);
  // The clock closes it: its start lies 30 days before its end.
  expect(settle(db, end + D).pending).toBe(false);
  expect(stored(db).map((row) => [row.status, row.pp])).toEqual([["eligible", 70]]);
});

test("more windows than a chunk overlapping one instant are worked through once, page by page", () => {
  const db = database();
  // 70 accounts, each with one window over the same week: all of them overlap every instant of the entry.
  for (let i = 0; i < 70; i++) addWindow(db, `acc${String(i).padStart(2, "0")}`, FIRST, 50);
  let turns = 0, written = 0;
  for (; turns < 20; turns++) {
    const turn = advanceWindowPointValues(db, { plans: PLANS, catalog: CATALOG, now: NOW, budgetMs: 1 })!;
    written += turn.written;
    if (!turn.pending) break;
  }
  expect(turns).toBeLessThan(3);
  expect(written).toBe(70);
  expect(stored(db).length).toBe(70);
  expect(db.query("SELECT count(*) AS n FROM meta WHERE key LIKE 'window_point_values_page:%'").get()).toEqual({ n: 0 });
});

test("freshness follows the producer: a closed open window and folded marks are stale until the step has run", () => {
  const db = database();
  seed(db);
  settle(db);
  expect(windowPointValuesStale(db, "codex", "codex1", NOW)).toBe(false);
  // The open window of codex1 ends on 10-14: past that the stored row is due.
  const later = Date.parse("2026-10-20T00:00:00Z");
  expect(windowPointValuesStale(db, "codex", "codex1", later)).toBe(true);
  settle(db, later);
  expect(windowPointValuesStale(db, "codex", "codex1", later)).toBe(false);
  // Marks folded away before the step saw them: every account is due.
  db.query("INSERT INTO window_answer_state(id,folded) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET folded=excluded.folded")
    .run(Number((db.query("SELECT value FROM meta WHERE key='window_point_values_marks'").get() as { value: string } | null)?.value ?? 0) + 5);
  expect(windowPointValuesStale(db, "codex", "codex2", later)).toBe(true);
});

test("a 5 h window or a window of another plan never marks the cycles of the main counter's plan", () => {
  const db = database();
  seed(db);
  addWindow(db, "codex1", FIRST, 60, { counter: FIVE });
  addWindow(db, "codex1", FIRST + 45 * D, 55, { plan: "plus" });
  settle(db, Date.parse("2026-10-30T00:00:00Z"));
  storeCycles(db, Date.parse("2026-10-30T00:00:00Z"));
  db.exec("DELETE FROM billing_cycle_dirty");
  const correct = (counter: string, start: number) => {
    const row = db.query("SELECT window_id, start_ts, end_ts, cycle FROM window_usage WHERE account='codex1' AND counter=? AND start_ts=?").get(counter, iso(start)) as
      { window_id: string; start_ts: string; end_ts: string; cycle: string };
    const cycle = JSON.parse(row.cycle) as { usage: WindowUsage };
    cycle.usage.api_standard *= 3;
    db.transaction(() => {
      db.query("UPDATE window_usage SET cycle=? WHERE account='codex1' AND counter=? AND window_id=?").run(JSON.stringify(cycle), counter, row.window_id);
      markWindowAnswersDirty(db, { provider: "codex", account: "codex1", fromMs: Date.parse(row.start_ts), untilMs: Date.parse(row.end_ts) });
    })();
  };
  // The 5 h window changes its own row only.
  correct(FIVE, FIRST);
  expect(settle(db, Date.parse("2026-10-30T00:00:00Z")).written).toBe(1);
  expect(db.query("SELECT count(*) AS n FROM billing_cycle_dirty").get()).toEqual({ n: 0 });
  // A Plus window is no calibration of the Pro cycles.
  correct(MAIN, FIRST + 45 * D);
  expect(settle(db, Date.parse("2026-10-30T00:00:00Z")).written).toBe(1);
  expect(db.query("SELECT count(*) AS n FROM billing_cycle_dirty").get()).toEqual({ n: 0 });
  // A Pro window moves the Pro cycles.
  correct(MAIN, FIRST);
  settle(db, Date.parse("2026-10-30T00:00:00Z"));
  expect(db.query("SELECT account FROM billing_cycle_dirty").all()).toEqual([{ account: "codex1" }]);
});

test("a resegmented window's old row goes and its account's cycles follow", () => {
  const db = database();
  seed(db);
  settle(db);
  storeCycles(db);
  db.exec("DELETE FROM billing_cycle_dirty");
  const gone = db.query("SELECT window_id, start_ts, end_ts FROM limit_windows WHERE account='codex1' ORDER BY start_ts LIMIT 1").get() as { window_id: string; start_ts: string; end_ts: string };
  db.transaction(() => {
    db.query("DELETE FROM limit_windows WHERE account='codex1' AND window_id=?").run(gone.window_id);
    markWindowAnswersDirty(db, { provider: "codex", account: "codex1", fromMs: Date.parse(gone.start_ts), untilMs: Date.parse(gone.end_ts) });
  })();
  expect(settle(db).removed).toBe(1);
  expect(stored(db).filter((r) => r.account === "codex1").length).toBe(5);
  expect(db.query("SELECT account FROM billing_cycle_dirty").all()).toEqual([{ account: "codex1" }]);
});

/* ------------------------------------------------------------------------------------------ */
/* Billing cycles read the stored point values                                                 */
/* ------------------------------------------------------------------------------------------ */

test("billing cycles store a calibrated capacity in every unit with its provenance, and the used amounts", () => {
  const db = database();
  seed(db);
  settle(db);
  resetBillingCycleClock();
  for (let i = 0; i < 20 && advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 })?.pending; i++);
  const cycles = db.query("SELECT * FROM billing_cycles WHERE account='codex1' ORDER BY start_ts").all() as StoredCycleRow[];
  const [closed, current] = cycles as [StoredCycleRow, StoredCycleRow];
  const detail = JSON.parse(closed.detail) as CycleDetail;
  // Every point is worth $10, 20 000 tokens and 200–250 credits in this account.
  const pp = (closed.windows_share + closed.idle_share) * 100;
  expect(detail.capacity!.pp).toBeCloseTo(pp, 9);
  expect(closed.capacity_usd).toBeCloseTo(pp * 10, 6);
  expect(detail.capacity!.api_usd).toBe(closed.capacity_usd!);
  expect(detail.capacity!.tokens.total).toBe(Math.round(pp * 20_000 * 0.9) + Math.round(pp * 20_000 * 0.1));
  expect(detail.capacity!.credits!.low).toBeCloseTo(pp * 200, 4);
  expect(detail.capacity!.calibration).toMatchObject({ counter: MAIN, plan: "pro", scope: null, inside: 4, windows: 4, pp: 240 });
  expect(JSON.parse(closed.flags)).not.toContain("capacity_uncalibrated");
  // Used amounts: the same parts of the windows as the API value.
  expect(detail.used_units!.api_usd).toBeCloseTo(closed.api_usd!, 6);
  expect(detail.used_units!.credits).not.toBeNull();
  // The current cycle holds one closed window of 60 points: it borrows the nearest closed ones.
  const now = JSON.parse(current.detail) as CycleDetail;
  expect(now.capacity!.calibration).toMatchObject({ inside: 1, windows: 2, pp: 115 });
  expect(JSON.parse(current.flags)).toContain("capacity_borrowed_windows");
});

test("a cycle whose windows have different regime factors counts each at its own factor, flagged", () => {
  const db = database();
  seed(db);
  // codex1 doubled from 09-12: its first window at 1, the one across 09-12 mixed, later ones doubled.
  const regime: PlansConfig = { capacity_regimes: [{ id: "promo", subscription: "codex1", factor: 2, from: "2026-09-12", until: "2026-12-31", source: "promotion" }] };
  settle(db, NOW, regime);
  resetBillingCycleClock();
  for (let i = 0; i < 20 && advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 })?.pending; i++);
  const [closed] = db.query("SELECT * FROM billing_cycles WHERE account='codex1' ORDER BY start_ts").all() as StoredCycleRow[];
  const detail = JSON.parse(closed!.detail) as CycleDetail;
  expect(JSON.parse(closed!.flags)).toContain("capacity_regime_weighted");
  expect(JSON.parse(closed!.flags)).not.toContain("capacity_regime_mixed");
  expect(detail.capacity!.factor).toBeGreaterThan(1);
  expect(detail.capacity!.factor).toBeLessThan(2);
  // Capacity = points × the effective factor × the value of a point at factor 1 (each window's value divided by its factor:
  // here every window holds $10 a point, so the doubled ones count $5 at factor 1).
  const doubled = (db.query("SELECT count(*) AS n FROM window_point_values WHERE account='codex1' AND status='eligible' AND regime_factor=2").get() as { n: number }).n;
  expect(doubled).toBeGreaterThan(0);
  const perPoint = closed!.capacity_usd! / detail.capacity!.pp / detail.capacity!.factor;
  expect(perPoint).toBeGreaterThan(5);
  expect(perPoint).toBeLessThan(10);
});

test("a cycle of a plan without eligible windows keeps a null capacity, flagged, never 0", () => {
  const db = database();
  for (let i = 0; i < 3; i++) addWindow(db, "codex3", FIRST + i * 7.5 * D, 50, { plan: "plus" });
  recordPeriodReading(db, PLAN_PERIODS, { provider: "codex", subject: "codex3", ts: "2026-09-09T15:11:32.698Z", value: "pro" });
  recordPeriodReading(db, PLAN_PERIODS, { provider: "codex", subject: "codex3", ts: "2026-10-08T14:00:00.000Z", value: "pro" });
  settle(db);
  resetBillingCycleClock();
  for (let i = 0; i < 20 && advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 })?.pending; i++);
  const cycles = db.query("SELECT * FROM billing_cycles WHERE account='codex3'").all() as StoredCycleRow[];
  expect(cycles.length).toBeGreaterThan(0);
  for (const cycle of cycles) {
    expect(cycle.capacity_usd).toBeNull();
    expect(JSON.parse(cycle.flags)).toContain("capacity_uncalibrated");
    expect((JSON.parse(cycle.detail) as CycleDetail).capacity).toBeNull();
  }
});
