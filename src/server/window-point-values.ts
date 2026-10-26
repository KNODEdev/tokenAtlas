import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { limitWindowFromRow, type LimitWindowRow } from "../db/limit-windows";
import { hasBillingCycles, markBillingCyclesDirty } from "../db/billing-cycles";
import { ANSWER_SCOPE_ALL, ANSWER_SCOPE_NONE } from "../db/window-answers";
import {
  POINT_VALUES_ALL, POINT_VALUES_BEGINNING, WINDOW_POINT_VALUE_COLUMNS, hasWindowPointValues, markWindowPointValuesDirty,
  type PointValueStatus, type WindowPointValueRow,
} from "../db/window-point-values";
import type { WindowUsage } from "../shared/codex-accounting";
import { CODEX_PRO_5X_LAUNCH_PROMOTION } from "../shared/codex-promotions";
import { LIMIT_PERCENT } from "../shared/credit-funded";
import { canonicalPeriodPlan } from "../shared/period-end";
import { capacityRegimeFingerprint, capacityRegimesFor, resolveCapacityRegime, type PlansConfig } from "./plans";
import { matchPlanAlias, type PlansCatalog } from "./plans-catalog";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { registerWindowShell } from "./subscription-window-comparison";
import type { RunningUsage } from "./window-usage-contracts";
import { AFTER_PAGE, clearPage, coveredByEntry, longestWindowMs, readPage, writePage, type PageKey } from "./dirty-pages";
import { countersOf, mainCountersOf } from "./main-counter";
import { joinsPrevious, type JoinRow } from "./window-end-causes";

/**
 * The value of one point of each limit window (docs/reset-capacity-plan-2026-10-11.md, step 1): one stored row per
 * window of every provider and counter that has both limit windows and window sums, read by the billing cycles.
 *
 * - Measured points are the pairing of the window sums (`registerWindowShell`): the last counted % minus the % the
 *   paired traffic starts from (0 from a confirmed reset, else the first reading). The plan's "final %" is this value
 *   for the usual window that starts at its reset.
 * - A window that reached the limit (a reading ≥ `LIMIT_PERCENT`) counts 100 points with the traffic up to that reading
 *   (the running sums at it; Codex keeps the same cut as `rail.at_limit`): traffic after it raises no % (golden rules §6).
 *   Running sums have no token categories, so input / cached / output are split like the window's paired usage.
 * - Otherwise the paired usage of the window (`cycle.usage`).
 * - Every row keeps its sums and states why it cannot calibrate (`status`); only `eligible` rows feed a calibration.
 * - Claude's limit also covers traffic this machine never sees: its rows are `observed_partial_traffic`.
 *
 * Work comes from the window marks (`window_answer_marks`, written with every limit-window and window-sum
 * publication) behind its own cursor, from a changed capacity configuration (regimes, catalog, rule), and from open
 * windows the clock has closed. Identical recomputation writes nothing; a changed row marks the billing cycles of its
 * account (a cycle may borrow any window of its account and plan).
 */
export const WINDOW_POINT_VALUES_RULE = "window-point-values-3";
/** A calibration window rose at least this much: below it probe rounding (±1 pp) moves the value by more than 5 %. */
export const MIN_PP = 20;
/**
 * A window whose unpriced calls hold more than this share of its tokens is left out: unpriced calls carry no API value or
 * credits, so its value per point would be low by about that share, beyond the ±10 % tolerance the Codex calibration
 * accepts between windows. Measured by tokens, not calls: Codex's unpriced calls are mostly small ones (11.10: 8–12 % of
 * calls but 3–6 % of tokens in a typical weekly window).
 */
export const MAX_UNPRICED_SHARE = 0.1;
/** Points a cycle's calibration gathers before it stops borrowing windows from outside the cycle. */
export const CALIBRATION_PP = 100;
/**
 * Outlier screening of calibration windows: a window whose value per point is below `OUTLIER_LOW` or above `OUTLIER_HIGH`
 * times the median of the account's windows of the same counter and plan within `OUTLIER_REACH_MS` of the cycle (all of
 * them when fewer than `OUTLIER_MIN` are that near) is left out, and only when at least `OUTLIER_MIN` windows form the
 * median. Traffic this machine never saw only lowers a window's value (codex1 10-07: 91 credits per point beside 330-500).
 */
export const OUTLIER_LOW = 0.5, OUTLIER_HIGH = 2, OUTLIER_MIN = 3;
export const OUTLIER_REACH_MS = 28 * 86_400_000;
const MARKS_KEY = "window_point_values_marks";
const PAGE_KEY = "window_point_values_page";
const CONFIG_KEY = "window_point_values_config";
const CHUNK = 64;
const DAY_MS = 86_400_000;
const OPEN_END = "9999-12-31T23:59:59.999Z";

const iso = (ms: number) => new Date(ms).toISOString();
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

// ---------------------------------------------------------------- one window

/** The capacity-regime window kind of a counter (as `cyclePromotion` callers name it). */
export function regimeWindowKind(provider: string, windowMinutes: number): string {
  return windowMinutes >= 10080 ? "weekly" : provider === "codex" ? "five_hour" : "session";
}

/**
 * The capacity multiplier of a window: the configured regime of each UTC day it covers (the official Codex Pro 5×
 * launch promotion where nothing overrides it, as `cyclePromotion` does), for the plan the window reports; 1 by default.
 * When the days disagree the window measures a blend (`mixed`, it cannot calibrate) and its factor is the mean of its
 * days' factors weighted by the part of the window each covers (what a billing cycle counts it as).
 */
export function windowRegime(window: Pick<ProbeLimitWindow, "account" | "start" | "end" | "plan" | "plan_detail" | "window_minutes">,
  provider: string, plans: PlansConfig, catalog: PlansCatalog): { factor: number | null; mixed: boolean } {
  const kind = regimeWindowKind(provider, window.window_minutes);
  const scoped = { capacity_regimes: capacityRegimesFor(plans, window.account) };
  const match = window.plan ? matchPlanAlias(catalog, provider, window.plan) : null;
  const planId = match?.kind === "ok" ? match.plan_id : null;
  const launch = CODEX_PRO_5X_LAUNCH_PROMOTION;
  const factors = new Set<number>();
  const start = Date.parse(window.start), end = Date.parse(window.end);
  let weighted = 0, covered = 0;
  for (let time = Math.floor(start / DAY_MS) * DAY_MS; time < end; time += DAY_MS) {
    const day = iso(time).slice(0, 10);
    const regime = resolveCapacityRegime(scoped, { subscription: window.account, day, plan_id: planId, window_kind: kind });
    const official = regime.id === null && provider === "codex" && kind === "weekly" && planId === "codex-pro-5x"
      && day >= launch.announced && day <= launch.until;
    const factor = regime.id !== null ? regime.factor : official ? launch.factor : 1;
    if (!(Number.isFinite(factor) && factor > 0)) return { factor: null, mixed: true };
    factors.add(factor);
    const part = Math.min(end, time + DAY_MS) - Math.max(start, time);
    weighted += factor * part; covered += part;
  }
  if (!factors.size) return { factor: 1, mixed: false };
  if (factors.size === 1) return { factor: [...factors][0]!, mixed: false };
  return { factor: Math.round(weighted / covered * 1e6) / 1e6, mixed: true };
}

export interface PointValueInput {
  provider: string;
  window: ProbeLimitWindow;
  /** The window's paired usage (`window_usage.cycle.usage`); null without a window-sums row. */
  usage: WindowUsage | null;
  /** The running sums at the window's `index`-th reading (sorted by instant), null when the stored sums do not hold it. */
  runningAt(index: number, ts: string): RunningUsage | null;
  factor: number | null;
  /** The window's days have different regime factors (`factor` is then their weighted mean). */
  regimeMixed?: boolean;
  /**
   * The window continues the allowance of the one before it (its end was not a reset): the meter's value at this window's
   * start, the previous window's last reading or this one's first if lower. Its points are its rise from there.
   */
  meterStart?: number | null;
  now: number;
}
export type PointValue = Omit<WindowPointValueRow, "inputs_rev" | "computed_at">;

interface Sums { events: number; tokens: number; priced_tokens: number; input: number; cached: number; output: number; api_standard: number;
  api_normalized: number | null; credits_low: number; credits_high: number; unpriced_events: number }

/** Token categories of `tokens` split like the paired usage (input + output = tokens, cached within input). */
function splitTokens(tokens: number, usage: WindowUsage): { input: number; cached: number; output: number } | null {
  if (!(usage.tokens > 0)) return tokens === 0 ? { input: 0, cached: 0, output: 0 } : null;
  const input = Math.round(tokens * usage.input / usage.tokens);
  return { input, cached: Math.min(input, Math.round(tokens * usage.cached / usage.tokens)), output: tokens - input };
}

/** The stored row of one window, from its limit-window row and its window sums. Pure. */
export function windowPointValue(input: PointValueInput): PointValue {
  const { window, usage, provider } = input;
  const readings = [...window.readings].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const base = { provider, account: window.account, counter: window.counter, window_start: window.start, window_end: window.end,
    plan: window.plan, regime_factor: input.factor, scope: provider === "claude" ? "observed_partial_traffic" : null };
  // Credits exist for Codex only, and not for calls from before it billed subscriptions in credits.
  const credits = provider === "codex" && usage !== null && !((usage.credits_unavailable_events ?? 0) > 0);
  const paired: Sums | null = usage && { events: usage.events, tokens: usage.tokens, priced_tokens: usage.priced_tokens, input: usage.input,
    cached: usage.cached, output: usage.output, api_standard: usage.api_standard, api_normalized: usage.api_normalized ?? null, credits_low: usage.credits_low,
    credits_high: usage.credits_high, unpriced_events: usage.unpriced_events };
  let pp: number | null = null, basis: PointValue["basis"] = "final", sums: Sums | null = paired;
  if (readings.length) {
    const shell = registerWindowShell({ ...window, readings }, window.window_minutes);
    // A later fragment of one allowance: paired from its start like a reset, but its meter starts where the previous one left it.
    const start = shell.start_basis === "reset" && input.meterStart != null ? input.meterStart : shell.start_percent;
    const manual = readings.some((reading) => reading.source === "manual");
    const limit = manual ? -1 : readings.findIndex((reading) => reading.percent >= LIMIT_PERCENT);
    if (limit >= 0) {
      basis = "at_limit";
      pp = 100 - start;
      sums = null;
      const cut = input.runningAt(limit, readings[limit]!.ts);
      const from = shell.start_basis === "reset" ? null : input.runningAt(0, readings[0]!.ts);
      const split = cut && usage ? splitTokens(cut.tokens - (from?.tokens ?? 0), usage) : null;
      if (cut && usage && split && (shell.start_basis === "reset" || from)) {
        const minus = (key: keyof RunningUsage) => cut[key] - (from?.[key] ?? 0);
        sums = { events: minus("events"), tokens: minus("tokens"), priced_tokens: minus("priced_tokens"), ...split, api_standard: minus("api_standard"),
          api_normalized: usage.api_normalized === undefined ? null : minus("api_normalized"),
          credits_low: minus("credits_low"), credits_high: minus("credits_high"), unpriced_events: minus("unpriced_events") };
      }
    } else pp = shell.observed_pp + shell.start_percent - start;
  }
  const status: PointValueStatus = Date.parse(window.end) > input.now ? "open"
    : pp === null ? "no_percent"
    : !sums || !(sums.events > 0) ? "sums_missing"
    // A window whose plan changed inside measures a blend of two capacities, like one across a regime change.
    : input.factor === null || input.regimeMixed || window.plan_detail?.status === "mixed" ? "regime_mixed"
    : pp < MIN_PP ? "small_span"
    : sums.tokens - sums.priced_tokens > MAX_UNPRICED_SHARE * sums.tokens ? "unpriced"
    : "eligible";
  return { ...base, pp: pp === null ? null : round(pp, 4), basis,
    events: sums?.events ?? null, tokens_input: sums?.input ?? null, tokens_cached: sums?.cached ?? null, tokens_output: sums?.output ?? null,
    api_standard: sums ? round(sums.api_standard, 6) : null, api_normalized: sums?.api_normalized == null ? null : round(sums.api_normalized, 6),
    credits_low: sums && credits ? round(sums.credits_low, 4) : null, credits_high: sums && credits ? round(sums.credits_high, 4) : null,
    unpriced_events: sums?.unpriced_events ?? null, status };
}

const inputsRev = (value: PointValue) =>
  createHash("sha256").update(JSON.stringify([WINDOW_POINT_VALUES_RULE, ...WINDOW_POINT_VALUE_COLUMNS.slice(0, -2).map((column) => value[column as keyof PointValue])]))
    .digest("hex").slice(0, 16);

// ---------------------------------------------------------------- calibration of a billing cycle

export interface PointCalibration {
  /** Units per point at regime factor 1 (each window's units divided by its factor). */
  per_point: { tokens_input: number; tokens_cached: number; tokens_output: number; api_standard: number; credits_low: number | null; credits_high: number | null };
  windows: number;
  /** Of them inside the cycle; the rest are the nearest windows of the same account, counter and plan. */
  inside: number;
  pp: number;
  /** Points of the windows that carry credits (the credit values' own basis). */
  credits_pp: number;
  from: string;
  until: string;
  scope: string | null;
  /** Windows left out as outliers that the calibration would otherwise have used (inside the cycle or as near as those chosen). */
  outliers: { count: number; starts: string[] };
}

/**
 * A plan's identity for calibration: its catalog plan id, else its canonical name. Codex's meter reports Pro 5× as
 * "prolite" while declarations name it "pro-5x"; the catalog's aliases make them one plan (user decision 21.10).
 */
export function planKeyOf(catalog: PlansCatalog, provider: string): (plan: string) => string {
  const keys = new Map<string, string>();
  return (plan) => {
    let key = keys.get(plan);
    if (key === undefined) {
      const canonical = canonicalPeriodPlan(plan), match = matchPlanAlias(catalog, provider, canonical);
      keys.set(plan, key = match.kind === "ok" ? match.plan_id : canonical);
    }
    return key;
  };
}

const hasCredits = (row: WindowPointValueRow) => row.provider === "codex" && row.credits_low !== null && row.credits_high !== null;
/** A window's value per point at regime factor 1 in credits (mid of low and high) or API Standard dollars. */
function perPoint(row: WindowPointValueRow, unit: "credits" | "api"): number {
  const amount = unit === "credits" ? (row.credits_low! + row.credits_high!) / 2 : row.api_standard ?? 0;
  return amount / row.pp! / row.regime_factor!;
}
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return (sorted[Math.floor(n / 2)]! + sorted[Math.floor((n - 1) / 2)]!) / 2;
};

/**
 * The value of one point for a cycle `[start, end)` of `plan`: Σ units / Σ points of the eligible windows of the account's
 * counter and plan inside the cycle; below `CALIBRATION_PP` points the nearest such windows outside it are added until
 * it is reached or none are left. Outliers (see `OUTLIER_LOW`) are screened out first; this reads the stored rows only,
 * so a row never depends on its neighbours. Null without any eligible window (never 0).
 */
export function cyclePointCalibration(rows: readonly WindowPointValueRow[], cycle: { start: number; end: number; plan: string },
  planKey: (plan: string) => string = canonicalPeriodPlan): PointCalibration | null {
  const plan = planKey(cycle.plan);
  const eligible = rows.filter((row) => row.status === "eligible" && row.plan !== null && planKey(row.plan) === plan && (row.pp ?? 0) > 0 && row.regime_factor);
  const span = (row: WindowPointValueRow) => [Date.parse(row.window_start), Date.parse(row.window_end)] as const;
  const distance = (row: WindowPointValueRow) => { const [s, e] = span(row); return s >= cycle.end ? s - cycle.end : e <= cycle.start ? cycle.start - e : 0; };
  const isInside = (row: WindowPointValueRow) => { const [s, e] = span(row); return s >= cycle.start && e <= cycle.end; };
  const near = eligible.filter((row) => { const [s, e] = span(row); return s >= cycle.start - OUTLIER_REACH_MS && e <= cycle.end + OUTLIER_REACH_MS; });
  const basis = near.length >= OUTLIER_MIN ? near : eligible;
  // One unit over the whole reference set: credits only when every window of it has them, else API dollars for all.
  const unit = basis.every(hasCredits) ? "credits" as const : "api" as const;
  const reference = basis.length >= OUTLIER_MIN ? { credits: unit === "credits" ? median(basis.map((row) => perPoint(row, "credits"))) : null,
    api: median(basis.map((row) => perPoint(row, "api"))) } : null;
  const dropped = !reference ? [] : eligible.filter((row) => {
    // A candidate outside the set without credits is compared in dollars.
    const [value, median] = reference.credits !== null && hasCredits(row) ? [perPoint(row, "credits"), reference.credits] : [perPoint(row, "api"), reference.api];
    return median > 0 && (value < OUTLIER_LOW * median || value > OUTLIER_HIGH * median);
  });
  const candidates = eligible.filter((row) => !dropped.includes(row));
  const inside = candidates.filter(isInside);
  const chosen = [...inside];
  let pp = chosen.reduce((sum, row) => sum + row.pp!, 0);
  if (pp < CALIBRATION_PP) {
    const rest = candidates.filter((row) => !inside.includes(row)).sort((a, b) => distance(a) - distance(b) || a.window_start.localeCompare(b.window_start));
    for (const row of rest) { if (pp >= CALIBRATION_PP) break; chosen.push(row); pp += row.pp!; }
  }
  if (!chosen.length) return null;
  // Listed: dropped windows inside the cycle, and when windows were borrowed, dropped ones as near as the farthest borrowed.
  const borrowed = chosen.filter((row) => !inside.includes(row));
  const reach = borrowed.length ? Math.max(...borrowed.map(distance)) : -1;
  const outliers = dropped.filter((row) => isInside(row) || distance(row) <= reach).map((row) => row.window_start).sort();
  const sum = (key: keyof WindowPointValueRow, list = chosen) => list.reduce((total, row) => total + Number(row[key] ?? 0) / row.regime_factor!, 0);
  const withCredits = chosen.filter((row) => row.credits_low !== null && row.credits_high !== null);
  const creditsPp = withCredits.reduce((total, row) => total + row.pp!, 0);
  const starts = chosen.map((row) => row.window_start).sort(), ends = chosen.map((row) => row.window_end).sort();
  return {
    per_point: { tokens_input: sum("tokens_input") / pp, tokens_cached: sum("tokens_cached") / pp, tokens_output: sum("tokens_output") / pp,
      api_standard: sum("api_standard") / pp,
      credits_low: creditsPp > 0 ? sum("credits_low", withCredits) / creditsPp : null, credits_high: creditsPp > 0 ? sum("credits_high", withCredits) / creditsPp : null },
    windows: chosen.length, inside: inside.length, pp, credits_pp: creditsPp, from: starts[0]!, until: ends.at(-1)!,
    scope: chosen.some((row) => row.scope) ? chosen.find((row) => row.scope)!.scope : null,
    outliers: { count: outliers.length, starts: outliers },
  };
}

/**
 * The regime factor of a cycle's capacity: each window's share of the cycle at its own factor, and each idle gap at the
 * factor of the window before it (1 before any); the effective factor is their weighted mean. Null when a window that
 * holds part of the cycle has no factor.
 */
export function cycleRegimeFactors(rows: readonly WindowPointValueRow[], parts: ReadonlyArray<{ start: number; share: number }>,
  idle: ReadonlyArray<{ after: number | null; idle: number }>): { factor: number | null; weighted: boolean } {
  const factorOf = new Map(rows.map((row) => [Date.parse(row.window_start), row.regime_factor]));
  const factor = (start: number | null) => start === null ? 1 : factorOf.has(start) ? factorOf.get(start)! : 1;
  let weight = 0, total = 0;
  const seen = new Set<number>();
  for (const part of parts) {
    const f = factor(part.start);
    if (f === null) return { factor: null, weighted: false };
    seen.add(f); weight += part.share * f; total += part.share;
  }
  for (const gap of idle) {
    const f = factor(gap.after) ?? 1;
    seen.add(f); weight += gap.idle * f; total += gap.idle;
  }
  return { factor: total > 0 ? weight / total : 1, weighted: seen.size > 1 };
}

// ---------------------------------------------------------------- the producer step

export interface PointValueOptions {
  plans: PlansConfig;
  catalog: PlansCatalog;
  now?: number;
  budgetMs?: number;
  canWrite?: () => boolean;
}
export interface PointValueTurn {
  progressed: boolean;
  pending: boolean;
  /** Rows inserted or changed, and rows of vanished windows removed, this turn. */
  written: number;
  removed: number;
  /** Windows still queued after this turn. */
  backlog: number;
}

/**
 * Everything a row depends on besides the stored windows and sums: the rule, the regimes and the plan aliases (a regime
 * names a plan id; prices do not matter here, so a price edit re-marks nothing).
 */
export function pointValueConfigDigest(plans: PlansConfig, catalog: PlansCatalog): string {
  const aliases = catalog.provider_groups.map((group) => [group.id, group.aliases, group.plans.map((plan) => [plan.plan_id, plan.aliases ?? []])]);
  return createHash("sha256").update(JSON.stringify([WINDOW_POINT_VALUES_RULE, capacityRegimeFingerprint(plans.capacity_regimes ?? []),
    CODEX_PRO_5X_LAUNCH_PROMOTION, aliases])).digest("hex").slice(0, 16);
}

const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const meta = (db: Database, key: string) => tableExists(db, "meta")
  ? (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value ?? null : null;
const setMeta = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);

interface DirtyEntry { provider: string; account: string; from_ms: number; until_ms: number | null; sequence: number }

const COVERED = `EXISTS (SELECT 1 FROM window_usage u WHERE u.provider=l.provider AND u.counter=l.counter)`;
// A window overlapping the range starts at most the longest stored window before it (`longestWindowMs`, read per turn): a
// bound that lets the (start, provider, account, counter) index serve the ordered page read.
const ENTRY_SCOPE = `(?1='*' OR l.provider=?1) AND (?2='*' OR l.account=?2) AND l.end_ts > ?3 AND l.start_ts < ?4 AND l.start_ts >= ?5`;
const entryArgs = (entry: DirtyEntry, longest: number) => [entry.provider, entry.account, iso(Math.max(entry.from_ms, -8.64e15)),
  entry.until_ms === null ? OPEN_END : iso(entry.until_ms), iso(Math.max(entry.from_ms - longest, -8.64e15))] as const;

/** One bounded turn; null on a database without the tables it reads or writes. */
export function advanceWindowPointValues(db: Database, options: PointValueOptions): PointValueTurn | null {
  if (!hasWindowPointValues(db) || !tableExists(db, "limit_windows") || !tableExists(db, "window_usage")) return null;
  const now = options.now ?? Date.now(), started = performance.now(), budget = options.budgetMs ?? 500;
  const canWrite = options.canWrite ?? (() => true);
  const turn: PointValueTurn = { progressed: false, pending: false, written: 0, removed: 0, backlog: 0 };
  if (!canWrite()) return { ...turn, pending: true, backlog: backlogOf(db) };
  queueChanges(db, pointValueConfigDigest(options.plans, options.catalog), now);
  const entries = db.query("SELECT provider, account, from_ms, until_ms, sequence FROM window_point_value_dirty ORDER BY provider, account").all() as DirtyEntry[];
  const usageOf = db.query("SELECT json_extract(cycle,'$.usage') AS usage, json_array_length(readings) AS n FROM window_usage WHERE provider=? AND account=? AND counter=? AND window_id=?");
  const readingOf = db.query("SELECT json_extract(readings, ?5) AS reading FROM window_usage WHERE provider=?1 AND account=?2 AND counter=?3 AND window_id=?4");
  const storedOf = db.query("SELECT * FROM window_point_values WHERE provider=? AND account=? AND counter=? AND window_start=?");
  const previousOf = db.query(`SELECT start_ts, end_ts, reset_ts, plan, plan_detail, cycle_end_basis, json_extract(readings,'$[0].percent') AS first,
    json_extract(readings,'$[#-1].percent') AS last FROM limit_windows WHERE provider=? AND account=? AND counter=? AND seq=?`);
  const longest = longestWindowMs(db);
  const select = db.query(`SELECT l.* FROM limit_windows l WHERE ${ENTRY_SCOPE} AND ${COVERED} AND ${AFTER_PAGE}
    ORDER BY l.start_ts, l.provider, l.account, l.counter LIMIT ?10`);
  outer: for (const entry of entries) {
    for (;;) {
      if (turn.progressed && performance.now() - started > budget || !canWrite()) { turn.pending = true; break outer; }
      const rows = select.all(...entryArgs(entry, longest), ...readPage(db, PAGE_KEY, entry), CHUNK + 1) as LimitWindowRow[];
      const chunk = rows.slice(0, CHUNK), next = rows[CHUNK] ?? null;
      const last = chunk.at(-1);
      const values = chunk.map((row) => {
        const window = limitWindowFromRow(row);
        const stored = usageOf.get(row.provider, row.account, row.counter, row.window_id) as { usage: string | null; n: number } | null;
        const sorted = [...window.readings].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        const regime = windowRegime(window, row.provider, options.plans, options.catalog);
        const previous = row.seq > 0 ? previousOf.get(row.provider, row.account, row.counter, row.seq - 1) as JoinRow | null : null;
        const own: JoinRow = { start_ts: row.start_ts, end_ts: row.end_ts, reset_ts: row.reset_ts, plan: row.plan, plan_detail: row.plan_detail, cycle_end_basis: row.cycle_end_basis,
          first: sorted[0]?.percent ?? null, last: sorted.at(-1)?.percent ?? null };
        const meterStart = previous && typeof previous.last === "number" && Date.parse(row.start_ts) - Date.parse(previous.end_ts) <= 2 * 60_000
          && joinsPrevious(previous, own) ? Math.min(previous.last, own.first ?? previous.last) : null;
        return windowPointValue({ provider: row.provider, window, now, meterStart,
          usage: stored?.usage ? JSON.parse(stored.usage) as WindowUsage : null,
          factor: regime.factor, regimeMixed: regime.mixed,
          runningAt(index, ts) {
            // Sums of other readings than the window's (being recomputed) do not hold this cut.
            if (!stored || stored.n !== sorted.length) return null;
            const text = (readingOf.get(row.provider, row.account, row.counter, row.window_id, `$[${index}]`) as { reading: string | null } | null)?.reading;
            const reading = text ? JSON.parse(text) as { ts: string; usage: RunningUsage } : null;
            return reading && Date.parse(reading.ts) === Date.parse(ts) ? reading.usage : null;
          } });
      });
      if (!canWrite()) { turn.pending = true; break outer; }
      db.transaction(() => {
        const marks = cycleMarks(db, options.catalog);
        // Rows of windows that no longer exist in the entry's range (a window resegmented or removed).
        const gone = db.query(`SELECT * FROM window_point_values l WHERE ${ENTRY_SCOPE.replaceAll("l.end_ts", "l.window_end").replaceAll("l.start_ts", "l.window_start")}
          AND NOT EXISTS (SELECT 1 FROM limit_windows w WHERE w.provider=l.provider AND w.account=l.account AND w.counter=l.counter AND w.start_ts=l.window_start)`)
          .all(...entryArgs(entry, longest)) as WindowPointValueRow[];
        for (const row of gone) {
          db.query("DELETE FROM window_point_values WHERE provider=? AND account=? AND counter=? AND window_start=?").run(row.provider, row.account, row.counter, row.window_start);
          marks.changed(row, null);
          turn.removed++;
        }
        const put = db.query(`INSERT OR REPLACE INTO window_point_values(${WINDOW_POINT_VALUE_COLUMNS.join(",")}) VALUES(${WINDOW_POINT_VALUE_COLUMNS.map(() => "?").join(",")})`);
        for (const value of values) {
          const rev = inputsRev(value);
          const before = storedOf.get(value.provider, value.account, value.counter, value.window_start) as WindowPointValueRow | null;
          if (before?.inputs_rev === rev) continue;
          const row: WindowPointValueRow = { ...value, inputs_rev: rev, computed_at: iso(now) };
          put.run(...WINDOW_POINT_VALUE_COLUMNS.map((column) => row[column]));
          marks.changed(before, row);
          turn.written++;
        }
        // A partly done entry resumes after its last window done (dirty-pages.ts); a merged newer mark restarts it.
        if (next && last) writePage(db, PAGE_KEY, entry, [last.start_ts, last.provider, last.account, last.counter] as PageKey);
        else {
          db.query("DELETE FROM window_point_value_dirty WHERE provider=? AND account=? AND sequence=?").run(entry.provider, entry.account, entry.sequence);
          clearPage(db, PAGE_KEY, entry);
        }
      }).immediate();
      turn.progressed = true;
      if (!next) break;
    }
  }
  turn.backlog = backlogOf(db);
  turn.pending = turn.backlog > 0 || !!db.query("SELECT 1 FROM window_point_value_dirty LIMIT 1").get();
  return turn;
}

/**
 * Inside a chunk's transaction: the billing cycles a changed row can move. Only rows of the account's main counters (of its
 * Free and its paid cycles) feed its cycles; a change of whether a row calibrates moves the cycles of the same plan (a cycle borrows only windows of its
 * account, counter and plan); a changed regime factor moves the cycles holding the window.
 */
function cycleMarks(db: Database, catalog: PlansCatalog) {
  const main = new Map<string, Set<string>>();
  const mainOf = (provider: string, account: string) => {
    const key = `${provider}|${account}`;
    if (!main.has(key)) main.set(key, new Set(mainCountersOf(countersOf(db, provider, account)).map((counter) => counter.id)));
    return main.get(key)!;
  };
  const keys = new Map<string, (plan: string) => string>();
  const keyOf = (provider: string) => keys.get(provider) ?? keys.set(provider, planKeyOf(catalog, provider)).get(provider)!;
  return {
    changed(before: WindowPointValueRow | null, after: WindowPointValueRow | null): void {
      const row = after ?? before;
      const plan = (value: string | null) => value === null || !row ? null : keyOf(row.provider)(value);
      if (!row || !hasBillingCycles(db) || !mainOf(row.provider, row.account).has(row.counter)) return;
      if (before?.status === "eligible" || after?.status === "eligible") {
        const plans = new Set([before?.status === "eligible" ? plan(before.plan) : null, after?.status === "eligible" ? plan(after.plan) : null]
          .filter((value): value is string => value !== null));
        for (const cycle of db.query("SELECT plan, start_ts, end_ts FROM billing_cycles WHERE provider=? AND account=?").all(row.provider, row.account) as
          Array<{ plan: string; start_ts: string; end_ts: string }>)
          if (plans.has(plan(cycle.plan)!)) markBillingCyclesDirty(db, row.provider, row.account, Date.parse(cycle.start_ts), Date.parse(cycle.end_ts));
      }
      // A window's factor also weighs the idle gap after it (counted up to two nominal windows) and its reset bonus, whose time
      // runs to its planned reset: the cycles over that whole extent follow.
      if (String(before ? before.regime_factor : 1) !== String(after ? after.regime_factor : 1)) {
        const limit = db.query("SELECT reset_ts, window_minutes FROM limit_windows WHERE provider=? AND account=? AND counter=? AND start_ts=?")
          .get(row.provider, row.account, row.counter, row.window_start) as { reset_ts: string; window_minutes: number } | null;
        const end = Date.parse(row.window_end), nominal = (limit?.window_minutes ?? 10080) * 60_000;
        markBillingCyclesDirty(db, row.provider, row.account, Date.parse(row.window_start),
          Math.max(end + 2 * nominal, limit ? Date.parse(limit.reset_ts) : end));
      }
    },
  };
}

/** Windows the queued entries still cover. */
function backlogOf(db: Database): number {
  const entries = db.query("SELECT provider, account, from_ms, until_ms, sequence FROM window_point_value_dirty").all() as DirtyEntry[];
  const count = db.query(`SELECT count(*) AS n FROM limit_windows l WHERE ${ENTRY_SCOPE} AND ${COVERED}`);
  const longest = longestWindowMs(db);
  return entries.reduce((total, entry) => total + (count.get(...entryArgs(entry, longest)) as { n: number }).n, 0);
}

/** Clock work that is already held by a queued entry (and not behind its page cursor) is not queued again. */
function coverDue(db: Database, provider: string, account: string, fromMs: number, untilMs: number, window: PageKey): void {
  if (!coveredByEntry(db, "window_point_value_dirty", PAGE_KEY, provider, account, fromMs, untilMs, longestWindowMs(db), window))
    markWindowPointValuesDirty(db, provider, account, fromMs, untilMs);
}

/**
 * What changed since the last turn becomes queue entries, in one short transaction: a new configuration digest or marks
 * folded away before this step saw them (everything), the window marks after the cursor (their accounts and ranges)
 * and open windows whose end the clock has passed.
 */
function queueChanges(db: Database, digest: string, now: number): void {
  const hasMarks = tableExists(db, "window_answer_marks");
  const cursor = Number(meta(db, MARKS_KEY) ?? 0);
  const marks = hasMarks ? db.query("SELECT seq, provider, account, from_ms, until_ms FROM window_answer_marks WHERE seq > ? ORDER BY seq LIMIT 5000")
    .all(cursor) as Array<{ seq: number; provider: string; account: string; from_ms: number; until_ms: number | null }> : [];
  const folded = hasMarks ? (db.query("SELECT folded FROM window_answer_state WHERE id=1").get() as { folded: number } | null)?.folded ?? 0 : 0;
  const full = meta(db, CONFIG_KEY) !== digest || folded > cursor;
  const closed = db.query("SELECT provider, account, counter, window_start, window_end FROM window_point_values WHERE status='open' AND window_end <= ?")
    .all(iso(now)) as Array<{ provider: string; account: string; counter: string; window_start: string; window_end: string }>;
  if (!marks.length && !full && !closed.length) return;
  db.transaction(() => {
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    if (full) markWindowPointValuesDirty(db, POINT_VALUES_ALL, POINT_VALUES_ALL, POINT_VALUES_BEGINNING, null);
    else for (const mark of marks) {
      if (mark.account === ANSWER_SCOPE_NONE) continue;
      // + the chain tolerance: the window after a changed one reads its last reading.
      markWindowPointValuesDirty(db, mark.provider === ANSWER_SCOPE_ALL ? POINT_VALUES_ALL : mark.provider,
        mark.account === ANSWER_SCOPE_ALL ? POINT_VALUES_ALL : mark.account, mark.from_ms, mark.until_ms === null ? null : mark.until_ms + 2 * 60_000 + 1);
    }
    // Clock work stays due until done: queued once, so it never restarts an entry worked page by page.
    for (const row of closed) coverDue(db, row.provider, row.account, Date.parse(row.window_start), Date.parse(row.window_end),
      [row.window_start, row.provider, row.account, row.counter]);
    const last = Math.max(cursor, folded, marks.at(-1)?.seq ?? 0);
    if (last !== cursor) setMeta(db, MARKS_KEY, String(last));
    if (meta(db, CONFIG_KEY) !== digest) setMeta(db, CONFIG_KEY, digest);
  }).immediate();
}

/**
 * Whether the step still has queued or due work for an account (the billing view reports it as `stale`), by the producer's
 * own predicates: never ran, queued entries, marks after the cursor (or folded away before it saw them) and open
 * windows the clock has closed.
 */
export function windowPointValuesStale(db: Database, provider: string, account: string, now = Date.now()): boolean {
  if (!hasWindowPointValues(db)) return true;
  if (meta(db, CONFIG_KEY) === null) return true;
  if (db.query("SELECT 1 FROM window_point_value_dirty WHERE provider IN (?, '*') AND account IN (?, '*') LIMIT 1").get(provider, account)) return true;
  if (db.query("SELECT 1 FROM window_point_values WHERE provider=? AND account=? AND status='open' AND window_end <= ? LIMIT 1").get(provider, account, iso(now))) return true;
  if (!tableExists(db, "window_answer_marks")) return false;
  const cursor = Number(meta(db, MARKS_KEY) ?? 0);
  const folded = (db.query("SELECT folded FROM window_answer_state WHERE id=1").get() as { folded: number } | null)?.folded ?? 0;
  if (folded > cursor) return true;
  return !!db.query(`SELECT 1 FROM window_answer_marks WHERE seq > ? AND (provider=? OR provider='*')
    AND (account=? OR account='*') LIMIT 1`).get(cursor, provider, account);
}
