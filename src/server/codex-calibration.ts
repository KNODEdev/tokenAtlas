import type { CalibrationInterval } from "../shared/codex-accounting";
export type { CalibrationInterval } from "../shared/codex-accounting";
import type { Database } from "bun:sqlite";
import { isCodexWindowMinutes } from "../shared/codex-counters";
import type { AccountResolver } from "./account-resolver";
import { preparedProbeAccountIndexReady, readPreparedProbeAccountRange, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import type { CodexAccountingConfig, CodexAccountingEvent } from "./codex-accounting-pricing";
import type { MeterEvent } from "./subscription-window-comparison";
import { sortByInstant } from "./instant-order";

export interface CodexProbe {
  subject: string; ts: string; kind: string; plan: string | null;
  used_percent: number; resets_at: string | null; window_minutes: number;
  home?: string | null; path?: string | null;
}
export type CalibrationEvent = CodexAccountingEvent & Pick<MeterEvent, "calls" | "last_ts"> & { account: string | null; home?: string | null };
export function loadCodexProbes(sqlite: Database, since: string, toExclusive: string,
  resolver: AccountResolver, account?: string): CodexProbe[] {
  const accounts = account ? [account.toLowerCase()] : resolver.accounts("codex");
  if (!account && !preparedProbeAccountIndexReady(sqlite)) throw new ProbeAccountIndexUnavailable();
  const from = Date.parse(since), until = Date.parse(toExclusive);
  const result: CodexProbe[] = [];
  for (const wanted of accounts) {
    const prepared = readPreparedProbeAccountRange(sqlite, "codex", wanted, since, toExclusive, 20_000, "accounting");
    if (!prepared) throw new ProbeAccountIndexUnavailable();
    for (const row of prepared.rows) {
      if (row.limit_group !== "codex" || (row.ok !== null && row.ok !== 1) || !isCodexWindowMinutes(Number(row.window_minutes))
        || typeof row.used_percent !== "number" || row.used_percent < 0 || row.used_percent > 100
        || Date.parse(row.ts) < from || Date.parse(row.ts) >= until) continue;
      result.push({ subject: wanted, ts: row.ts, kind: row.kind, plan: row.plan as string | null,
        used_percent: row.used_percent, resets_at: row.resets_at as string | null,
        window_minutes: Number(row.window_minutes) });
    }
  }
  return sortByInstant(result, p => p.ts);
}
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y), n = a.length;
  return n ? (a[Math.floor(n / 2)]! + a[Math.floor((n - 1) / 2)]!) / 2 : null;
};

/**
 * The counted traffic of an interval `(start, end]`: actual credits and normalized Standard dollars of
 * the events both prices exist for, the count of the others, and the sources and models it saw.
 */
export interface CalibrationIntervalUsage { credits: number; normalized: number; missing: number; events: number; sources: string[]; models: Array<string | null> }

/**
 * Calibration of 1% from percentage readings. Each holdout is an entire reset window; actual
 * percentages are never multiplied. `intervalUsage` answers from the stored window sums: the same
 * windows, owner and admitted traffic as the window comparison (Spark, reserve and credit funding
 * left out). `separateCounterEvents` is reported beside, never added.
 */
export function calibrateCodex(config: CodexAccountingConfig, probes: CodexProbe[],
  intervalUsage: (start: CodexProbe, end: CodexProbe) => CalibrationIntervalUsage, separateCounterEvents: number) {
  const streams = new Map<string, CodexProbe[]>();
  for (const p of probes) {
    const key = JSON.stringify([p.subject, p.window_minutes]);
    const list = streams.get(key) ?? []; list.push({ ...p }); streams.set(key, list);
  }
  const intervals: CalibrationInterval[] = [];
  for (const stream of streams.values()) {
    sortByInstant(stream, p => p.ts);
    const anchors: string[] = [], anchorTimes: number[] = [];
    for (const p of stream) {
      if (!p.resets_at) continue;
      const time = Date.parse(p.resets_at), index = anchorTimes.findIndex(anchor => Math.abs(anchor - time) <= 120000);
      if (index >= 0) p.resets_at = anchors[index]!;
      else { anchors.push(p.resets_at); anchorTimes.push(time); }
    }
    let start = stream[0], previous = start;
    for (const end of stream.slice(1)) {
      if (!start || !previous) break;
      if (Date.parse(end.ts) <= Date.parse(previous.ts)) {
        if (end.used_percent !== previous.used_percent) start = end;
        previous = end; continue;
      }
      const resetChanged = !start.resets_at || !end.resets_at || !Number.isFinite(Date.parse(start.resets_at)) || !Number.isFinite(Date.parse(end.resets_at))
        || Math.abs(Date.parse(start.resets_at) - Date.parse(end.resets_at)) > 120000;
      const drop = end.used_percent < previous.used_percent;
      const planChanged = start.plan !== end.plan || !start.plan;
      const stale = Date.parse(end.ts) - Date.parse(previous.ts) > 2 * 3600000;
      const delta = end.used_percent - start.used_percent;
      const boundary = resetChanged || drop || planChanged || stale;
      if (!boundary && end !== stream.at(-1) && (delta < 5 || Date.parse(end.ts) - Date.parse(start.ts) < 120000)) { previous = end; continue; }
      const usage = intervalUsage(start, end);
      const { credits, normalized, missing, sources } = usage;
      const models = new Set(usage.models), from = start;
      const priceBoundary = config.rules.some(r => models.has(r.model)
        && [r.valid_from, r.valid_until].some(d => d && Date.parse(d) > Date.parse(from.ts) && Date.parse(d) <= Date.parse(end.ts)));
      const reason = resetChanged ? "reset_boundary" : drop ? "counter_decreased" : planChanged ? "plan_unknown_or_changed"
        : stale ? "probe_gap_over_2h" : priceBoundary ? "pricing_boundary" : missing ? "incomplete_pricing_or_speed"
        : !usage.events || credits <= 0 ? "no_indexed_usage" : delta < 5 ? "percent_span_too_small" : "eligible";
      intervals.push({ account: start.subject, kind: end.kind, plan: start.plan, window_minutes: end.window_minutes,
        start_ts: start.ts, end_ts: end.ts, reset: start.resets_at, observed_pp: delta,
        credits, normalized_usd: normalized, events: usage.events, unpriced_events: missing, source_homes: sources,
        accepted: reason === "eligible", reason, role: reason === "eligible" ? "training" : "excluded",
        predicted_pp: null, error_pp: null });
      start = end; previous = end;
    }
  }
  const cohorts = new Map<string, CalibrationInterval[]>();
  for (const row of intervals.filter(r => r.accepted)) {
    // Rule periods and plan identities cannot borrow calibration from each other.
    const epoch = [...new Set(config.rules.flatMap(r => [r.valid_from, r.valid_until].filter((d): d is string => !!d)))]
      .filter(d => d <= row.start_ts.slice(0, 10)).sort().at(-1);
    const key = JSON.stringify([row.account, row.window_minutes, row.plan, epoch]);
    const list = cohorts.get(key) ?? []; list.push(row); cohorts.set(key, list);
  }
  const models = [...cohorts.entries()].map(([key, rows]) => {
    const resets = [...new Set(rows.map(r => r.reset!))].sort();
    const held = resets.length >= 3 ? resets.at(-1) : null;
    const training = rows.filter(r => r.reset !== held), validation = rows.filter(r => r.reset === held);
    const creditsPerPoint = median(training.map(r => r.credits / r.observed_pp));
    const usdPerPoint = median(training.map(r => r.normalized_usd / r.observed_pp));
    for (const row of validation) {
      row.role = "validation";
      row.predicted_pp = creditsPerPoint && row.credits / creditsPerPoint;
      row.error_pp = row.predicted_pp == null ? null : row.predicted_pp - row.observed_pp;
    }
    const mae = validation.length ? validation.reduce((s, r) => s + Math.abs(r.error_pp!), 0) / validation.length : null;
    const consistent = creditsPerPoint != null && training.every(r => Math.abs(r.credits / r.observed_pp / creditsPerPoint - 1) <= .1);
    const passed = consistent && validation.length > 0 && validation.every(r => Math.abs(r.error_pp!) <= Math.max(2, r.observed_pp * .1));
    return { key, account: rows[0]!.account, window_minutes: rows[0]!.window_minutes, plan: rows[0]!.plan,
      status: passed ? "validated" : "working", credits_per_1pct: creditsPerPoint,
      standard_normalized_usd_per_1pct: usdPerPoint, training_intervals: training.length,
      training_windows: resets.length - (held ? 1 : 0), validation_intervals: validation.length,
      validation_mae_pp: mae, start_ts: rows[0]!.start_ts, end_ts: rows.at(-1)!.end_ts,
      reason: !held ? "need_three_independent_reset_windows" : !consistent ? "inconsistent_training" : passed ? "holdout_within_tolerance" : "holdout_mismatch" };
  });
  return { basis: "standard_normalized", quota_verified: false, machine_coverage: "not_certified",
    excluded_separate_counter_events: separateCounterEvents,
    tolerance: "max(2 percentage points, 10% observed delta)",
    models, intervals, excluded_intervals: intervals.filter(r => !r.accepted).length,
    limitations: ["Indexed traffic may omit another machine or a shared service.",
      "Probe rounding, billing lag and late logs can change calibration; recomputed from current facts.",
      "Validation compares independent reset windows, not a provider invoice."] };
}
