import type { Database } from "bun:sqlite";
import { limitWindowFromRow, type LimitWindowRow } from "../db/limit-windows";
import { ensureWindowEndEstimateSchema, hasWindowEndEstimates } from "../db/window-end-estimates";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import type { ModelSpend, WindowReadingSums } from "./window-usage-contracts";
import { pairingBounds } from "./subscription-window-comparison";

/**
 * End estimate of a closed limit window (user decision 2026-10-10, "rób szacunek z tokenów").
 *
 * When the meter readings of a window stop before its end (a vendor reset or a mid-window drop) and the account
 * still has counted traffic after its last reading, the last measured percent under-reports the window. The
 * estimate is: last measured % + (usage after the last reading) ÷ (usage per 1 %), capped at 100. Usage is the
 * stored actual-mode API value of the counted calls (`ModelSpend.actual`), the same weight the Claude limit
 * calibration uses (cache reads weigh less than fresh tokens). Usage per 1 % comes from the window's own readings,
 * preferably its recent part (the shortest span ending at its last reading below 100 % that rose `RECENT_PP`), else
 * from the newest earlier window of the same counter that has a calibration (`REACH_WINDOWS` back).
 *
 * A limit refusal after the last meter reading is the vendor's own 100 % (basis "limit-hit"); the segmenter
 * already joins it to the window as its last reading. Measured readings are never changed: the estimate is a
 * separate, labelled value with its provenance.
 *
 * Stored per window in `window_end_estimates` by the window-usage producer from stored rows only (the window's
 * `limit_windows` row and `window_usage` row, and the stored calibration of earlier windows); never at read time.
 * The producer drops a window's row when its sums become pending or change (ledger, limit window, period changes),
 * and a window whose own calibration changes drops the rows of the windows that may fall back to it.
 */
export const WINDOW_END_ESTIMATE_RULE = "window-end-estimate-2";
/** A calibration span rises at least this much when the window has it; the quantisation error is then ≤ ±10 %. */
export const RECENT_PP = 10;
/** The least rise a calibration span may have. */
export const MIN_PP = 5;
/** Earlier windows of the same counter a window may take its calibration from. */
export const REACH_WINDOWS = 4;
/**
 * Only a material gap is estimated: readings missing for at least `MIN_GAP_MS` before the end and an estimate at
 * least `MIN_RISE_PP` above the last reading. A probe cadence gap (~10 min) or a fraction of a point keeps the
 * window measured, so screens that use measured windows only still see it.
 */
export const MIN_GAP_MS = 30 * 60_000;
export const MIN_RISE_PP = 1;
/** Counter kinds that get estimates: Claude's account-wide weekly meter and its 5 h session. */
const ESTIMATED_KINDS = ["weekly_all", "session"] as const;

export interface UsageAmount { events: number; tokens: number; api_actual: number; unpriced_events: number }
export interface WindowCalibration {
  window_id: string;
  from: { ts: string; percent: number }; to: { ts: string; percent: number };
  usage: UsageAmount;
  /** Actual-mode API dollars and tokens per 1 % over the span. */
  usd_per_point: number; tokens_per_point: number;
}
export interface WindowEndEstimate {
  rule: string;
  basis: "estimate" | "limit-hit";
  /** Estimated end percent, capped at 100. */
  percent: number;
  /** Before the cap; null for a limit hit. */
  uncapped: number | null;
  end: string;
  last_reading: { ts: string; percent: number; source: string };
  /** Counted usage after the last reading up to the window end; null for a limit hit. */
  after: UsageAmount | null;
  /** "window": the window's own readings; "account": an earlier window of the same counter. */
  calibration: (WindowCalibration & { source: "window" | "account" }) | null;
  limit_hit?: { call_id: string | null };
}

type EstimateWindow = Pick<ProbeLimitWindow, "id" | "start" | "end" | "readings" | "startDrop">
  & Partial<Pick<ProbeLimitWindow, "activity" | "reset" | "window_minutes">>;
type EstimateSums = { readings: readonly WindowReadingSums[]; cycle: { spend?: readonly ModelSpend[] } };

const zero = (): UsageAmount => ({ events: 0, tokens: 0, api_actual: 0, unpriced_events: 0 });
function add(target: UsageAmount, spends: readonly ModelSpend[] | undefined): void {
  for (const spend of spends ?? []) {
    target.events += spend.events; target.tokens += spend.tokens;
    target.api_actual += spend.actual; target.unpriced_events += spend.actual_unpriced;
  }
}
const minus = (a: UsageAmount, b: UsageAmount): UsageAmount => ({ events: a.events - b.events, tokens: a.tokens - b.tokens,
  api_actual: a.api_actual - b.api_actual, unpriced_events: a.unpriced_events - b.unpriced_events });
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * The window's own calibration and its end estimate, from its stored readings and sums. Null when the stored
 * sums do not belong to these readings (the sums are being recomputed): nothing is stored then.
 */
export function windowEndEstimate(window: EstimateWindow, sums: EstimateSums, fallback: WindowCalibration | null):
  { calibration: WindowCalibration | null; estimate: WindowEndEstimate | null } | null {
  const readings = [...window.readings].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (readings.length !== sums.readings.length || readings.some((reading, index) => Date.parse(reading.ts) !== Date.parse(sums.readings[index]!.ts)))
    return null;
  if (!readings.length) return { calibration: null, estimate: null };
  // Running usage at each reading; a confirmed reset before the first reading is 0 % with no usage.
  const points: Array<{ ts: string; percent: number; usage: UsageAmount }> = [];
  if (pairingBounds(window).fromReset)
    points.push({ ts: window.start, percent: 0, usage: zero() });
  const running = zero();
  readings.forEach((reading, index) => {
    add(running, sums.readings[index]!.spend);
    points.push({ ts: reading.ts, percent: reading.percent, usage: { ...running } });
  });
  const calibration = ownCalibration(window.id, points);
  const last = readings.at(-1)!, lastPoint = points.at(-1)!;
  const lastReading = { ts: last.ts, percent: last.percent, source: last.source };
  if (last.percent >= 100) {
    // The vendor's own refusal is the end; a probe at 100 % needs no estimate.
    const estimate: WindowEndEstimate | null = last.source === "limit_hit" ? { rule: WINDOW_END_ESTIMATE_RULE, basis: "limit-hit", percent: 100,
      uncapped: null, end: window.end, last_reading: lastReading, after: null, calibration: null,
      limit_hit: { call_id: last.limit_hit?.call_id ?? null } } : null;
    return { calibration, estimate };
  }
  const total = zero();
  add(total, sums.cycle.spend);
  const after = minus(total, lastPoint.usage);
  const used = calibration ? { ...calibration, source: "window" as const } : fallback ? { ...fallback, source: "account" as const } : null;
  if (after.events <= 0 || after.api_actual <= 0 || Date.parse(last.ts) >= Date.parse(window.end) || !used) return { calibration, estimate: null };
  if (Date.parse(window.end) - Date.parse(last.ts) < MIN_GAP_MS) return { calibration, estimate: null };
  const uncapped = last.percent + after.api_actual / used.usd_per_point;
  if (uncapped - last.percent < MIN_RISE_PP) return { calibration, estimate: null };
  return { calibration, estimate: { rule: WINDOW_END_ESTIMATE_RULE, basis: "estimate", percent: round(Math.min(100, uncapped), 2),
    uncapped: round(uncapped, 2), end: window.end, last_reading: lastReading,
    after: { ...after, api_actual: round(after.api_actual, 4) }, calibration: used } };
}

/**
 * Usage per 1 % over the shortest span ending at the last point below 100 % that rose `RECENT_PP`, else over the
 * whole window when it rose at least `MIN_PP`. A point at 100 % may already hold usage the meter no longer counts.
 */
function ownCalibration(windowId: string, points: ReadonlyArray<{ ts: string; percent: number; usage: UsageAmount }>): WindowCalibration | null {
  let toIndex = points.length - 1;
  while (toIndex >= 0 && points[toIndex]!.percent >= 100) toIndex--;
  if (toIndex <= 0) return null;
  const to = points[toIndex]!;
  const span = (from: (typeof points)[number]) => {
    const rise = to.percent - from.percent, usage = minus(to.usage, from.usage);
    return rise > 0 && usage.api_actual > 0 ? { from, rise, usage } : null;
  };
  let chosen: ReturnType<typeof span> = null;
  for (let index = toIndex - 1; index >= 0 && !chosen; index--)
    if (to.percent - points[index]!.percent >= RECENT_PP) chosen = span(points[index]!);
  if (!chosen && to.percent - points[0]!.percent >= MIN_PP) chosen = span(points[0]!);
  if (!chosen) return null;
  return { window_id: windowId, from: { ts: chosen.from.ts, percent: chosen.from.percent }, to: { ts: to.ts, percent: to.percent },
    usage: { ...chosen.usage, api_actual: round(chosen.usage.api_actual, 4) },
    usd_per_point: chosen.usage.api_actual / chosen.rise, tokens_per_point: Math.round(chosen.usage.tokens / chosen.rise) };
}

/* ------------------------------------------------------------------------------------------ */
/* Producer step and reader                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface EndEstimateStepOptions {
  budgetMs?: number;
  canWrite?: () => boolean;
  /** Inside the write transaction: a window's stored estimate changed (screens that show it follow). */
  changed: (provider: string, account: string, fromMs: number, untilMs: number) => void;
}

const ELIGIBLE = `w.provider='claude' AND json_extract(w.counter,'$[0]') IN (${ESTIMATED_KINDS.map(kind => `'${kind}'`).join(",")})`;
const BACKLOG = `SELECT w.* FROM limit_windows w
  LEFT JOIN window_end_estimates e ON e.provider=w.provider AND e.account=w.account AND e.counter=w.counter AND e.window_id=w.window_id
  WHERE ${ELIGIBLE} AND (e.window_id IS NULL OR e.rule<>?)
    AND EXISTS (SELECT 1 FROM window_usage u WHERE u.provider=w.provider AND u.account=w.account AND u.counter=w.counter AND u.window_id=w.window_id)
    AND NOT EXISTS (SELECT 1 FROM window_usage_pending p WHERE p.provider=w.provider AND p.account=w.account AND p.counter=w.counter AND p.window_id=w.window_id)
  ORDER BY w.provider, w.account, w.counter, w.seq LIMIT ?`;
const CHUNK = 64;

/**
 * One bounded pass over windows without a current stored estimate, oldest first within each counter so that a
 * window's fallback calibration is stored before it. Reads stored rows only.
 */
export function advanceWindowEndEstimates(db: Database, options: EndEstimateStepOptions): { progressed: boolean; pending: boolean } {
  if (!["limit_windows", "window_usage", "window_usage_pending"].every(name =>
    db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))) return { progressed: false, pending: false };
  if (!hasWindowEndEstimates(db)) {
    // Without windows to estimate there is nothing to create (and no writer to ask for).
    if (!db.query(`SELECT 1 FROM limit_windows w WHERE ${ELIGIBLE} LIMIT 1`).get()) return { progressed: false, pending: false };
    if (options.canWrite && !options.canWrite()) return { progressed: false, pending: true };
    ensureWindowEndEstimateSchema(db);
  }
  const started = performance.now(), budget = options.budgetMs ?? 250;
  let progressed = false;
  const usageOf = db.query("SELECT readings, cycle FROM window_usage WHERE provider=? AND account=? AND counter=? AND window_id=?");
  const stored = db.query("SELECT rule, calibration, estimate FROM window_end_estimates WHERE provider=? AND account=? AND counter=? AND window_id=?");
  const earlier = db.query(`SELECT w.seq, e.rule, e.calibration FROM limit_windows w LEFT JOIN window_end_estimates e
    ON e.provider=w.provider AND e.account=w.account AND e.counter=w.counter AND e.window_id=w.window_id
    WHERE w.provider=? AND w.account=? AND w.counter=? AND w.seq<? AND w.seq>=? ORDER BY w.seq DESC`);
  for (;;) {
    if (progressed && performance.now() - started >= budget) break;
    const rows = db.query(BACKLOG).all(WINDOW_END_ESTIMATE_RULE, CHUNK) as LimitWindowRow[];
    if (!rows.length) break;
    // Calibrations computed in this chunk, by register and seq: a later window of the chunk falls back to them.
    const fresh = new Map<string, string | null>();
    const writes: Array<{ row: LimitWindowRow; calibration: string | null; estimate: string | null }> = [];
    const stale: LimitWindowRow[] = [];
    for (const row of rows) {
      const usage = usageOf.get(row.provider, row.account, row.counter, row.window_id) as { readings: string; cycle: string } | null;
      if (!usage) continue;
      const register = JSON.stringify([row.provider, row.account, row.counter]);
      let fallback: WindowCalibration | null = null;
      for (const prior of earlier.all(row.provider, row.account, row.counter, row.seq, row.seq - REACH_WINDOWS) as
        Array<{ seq: number; rule: string | null; calibration: string | null }>) {
        const key = `${register}\u0000${prior.seq}`;
        const text = fresh.has(key) ? fresh.get(key)! : prior.rule === WINDOW_END_ESTIMATE_RULE ? prior.calibration : null;
        if (text) { fallback = JSON.parse(text) as WindowCalibration; break; }
      }
      const result = windowEndEstimate(limitWindowFromRow(row), { readings: JSON.parse(usage.readings), cycle: JSON.parse(usage.cycle) }, fallback);
      // Sums that do not belong to these readings are recomputed first; their producer then drops this row again.
      if (!result) { stale.push(row); continue; }
      const calibration = result.calibration ? JSON.stringify(result.calibration) : null;
      fresh.set(`${register}\u0000${row.seq}`, calibration);
      writes.push({ row, calibration, estimate: result.estimate ? JSON.stringify(result.estimate) : null });
    }
    if (options.canWrite && !options.canWrite()) break;
    db.transaction(() => {
      for (const row of stale) db.query("INSERT OR IGNORE INTO window_usage_pending(provider,account,counter,window_id) VALUES(?,?,?,?)")
        .run(row.provider, row.account, row.counter, row.window_id);
      for (const { row, calibration, estimate } of writes) {
        const before = stored.get(row.provider, row.account, row.counter, row.window_id) as { rule: string; calibration: string | null; estimate: string | null } | null;
        db.query(`INSERT INTO window_end_estimates(provider,account,counter,window_id,rule,calibration,estimate) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(provider,account,counter,window_id) DO UPDATE SET rule=excluded.rule, calibration=excluded.calibration, estimate=excluded.estimate`)
          .run(row.provider, row.account, row.counter, row.window_id, WINDOW_END_ESTIMATE_RULE, calibration, estimate);
        if ((before?.estimate ?? null) !== estimate) options.changed(row.provider, row.account, Date.parse(row.start_ts), Date.parse(row.end_ts));
        // Later windows of the counter may fall back to this calibration: they are work again.
        if (before?.rule !== WINDOW_END_ESTIMATE_RULE || before.calibration !== calibration)
          db.query(`DELETE FROM window_end_estimates WHERE provider=? AND account=? AND counter=? AND window_id IN
            (SELECT window_id FROM limit_windows WHERE provider=? AND account=? AND counter=? AND seq>? AND seq<=?)`)
            .run(row.provider, row.account, row.counter, row.provider, row.account, row.counter, row.seq, row.seq + REACH_WINDOWS);
      }
    }).immediate();
    progressed = true;
  }
  const pending = !!db.query(BACKLOG).get(WINDOW_END_ESTIMATE_RULE, 1);
  return { progressed, pending };
}

/** The stored end estimates of an account's windows by window id. Never computes; a database without them has none. */
export function readWindowEndEstimates(db: Database, provider: string, account: string): Map<string, WindowEndEstimate> {
  const out = new Map<string, WindowEndEstimate>();
  if (!hasWindowEndEstimates(db)) return out;
  for (const row of db.query(`SELECT window_id, estimate FROM window_end_estimates WHERE provider=? AND account=? AND rule=?
    AND estimate IS NOT NULL`).all(provider.toLowerCase(), account.toLowerCase(), WINDOW_END_ESTIMATE_RULE) as Array<{ window_id: string; estimate: string }>)
    out.set(row.window_id, JSON.parse(row.estimate) as WindowEndEstimate);
  return out;
}
