import type { Database } from "bun:sqlite";
import { windowActiveAt } from "../shared/window-activity";
import { preparedClaudeCardMetadata } from "../db/claude-card-metadata";
import { readClaudeCapacityResult } from "./claude-capacity-result";
import { claudeCapacityPerPoint, manualClaudeCapacityResult, type ClaudeCapacityResult } from "../shared/claude-capacity-result";
import type { ClaudeCapacityModelResult as ClaudeModelCost } from "../shared/claude-capacity-result";
import { readClaudeProbe, sameResetWindow, type ClaudeProbeSample, type ClaudeProductBreakdown } from "../providers/adapters/claude";
import { claudeCodeCapacitySummaryOrAbsent, readClaudeCodeObservations, type ClaudeCodeCapacityContext } from "./claude-code-capacity";
import { claudeWeeklyRegisterWindows, probeLimitSamples, probeWindowCounterReset, probeWindowPlan } from "./probe-limit-windows";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import { planPeriodIndex } from "./account-periods";
import { ProbeAccountIndexUnavailable, readPreparedProbeAccountReadings, probeReadContext, selectOwnedProbes,
  preparedProbeAccountIndexReady, preparedProbeOwnedBySql, type ProbeAccountReadings } from "./current/probe-account-reader";
import { readLimitWindowHeaders, readLimitWindowsWhere } from "../db/limit-windows";
import { claudeHourBlocks, readingIndexAt, spendThroughReading, tokensByLocalDay } from "./window-usage-presentation";
import { readSpanSums, readWindowIntervals, readWindowSums } from "./window-usage-read";
import { type ModelSpend, type ClaudeHourBlock, type WindowReadingSums, type WindowCycleSums } from "./window-usage-contracts";
import { claudeAccountId, claudeGaugeObservationId, claudeGaugeObservationSpan, type ClaudeGaugeConfig,
  type ClaudeGaugeObservation } from "./claude-gauge";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import type { UnpricedModel } from "../shared/missing-rate";
import type { CreditFundedSums } from "../shared/credit-funded";
import type { ClaudeCodeCapacitySummary, ClaudeCounterReset } from "../shared/claude-code-capacity";
import {
  HOUR_MS,
  limitPace,
  measuredAgeMinutes,
  type LimitWindowTiming,
  round,
  windowElapsedPercent,
  windowFromReset,
} from "../providers/core/limit";
export { claudeAccountId, loadClaudeGauge, type ClaudeGaugeBoost, type ClaudeGaugeConfig, type ClaudeGaugeLimit,
  type ClaudeGaugeObservation } from "./claude-gauge";
export interface ClaudeRateLike {
  in_uncached: number;
  in_cache_read: number;
  in_cache_write_5m: number;
  in_cache_write_1h: number;
  out_total: number;
}
export type ClaudePricer = (
  model: string | null,
  day: string,
  speed: string | null
) => ClaudeRateLike | null;
export interface ClaudeSpend {
  calls: number;
  usd: number;
  gross: number;
  fresh: number;
  /** Calls with tokens but no catalog rate: their tokens are counted, their dollars are not. */
  unpriced_calls: number;
}
export interface ClaudeObservationReport {
  ts: string;
  reset_ts: string;
  window_start_ts: string;
  measured_through: string;
  window_elapsed_percent: number;
  percent_all: number | null;
  percent_fable: number | null;
  boost_factor: number;
  fable_points: number | null;
  rest_points: number | null;
  spend: ClaudeSpend;
  fable_spend: ClaudeSpend;
  rest_spend: ClaudeSpend;
  usd_per_point: number | null;
  usd_per_point_fable: number | null;
  usd_per_point_rest: number | null;
  agreement_ratio: number | null;
  basis: "manual" | "probe";
  source?: string;
  note?: string;
  days_without_events: number;
}
export type { ClaudeCapacityModelResult as ClaudeModelCost } from "../shared/claude-capacity-result";
export interface ClaudeCurrentWindow {
  window_id: string;
  window_start: string;
  reset_at: string;
  elapsed_hours: number;
  remaining_hours: number;
  elapsed_percent: number;
  spend: ClaudeSpend;
  fable_spend: ClaudeSpend;
  percent_all_measured: number | null;
  percent_fable_measured: number | null;
  measured_at: string | null;
  measured_age_minutes: number | null;
  percent_all_est: number | null;
  percent_fable_est: number | null;
  pp_ahead: number | null;
  projected_end_percent: number | null;
  eta_100_iso: string | null;
  remaining_usd: number | null;
  /**
   * How the account split this window's USED bar across its surfaces (Claude Code, chat,
   * Cowork, rest). Only the Code row is something the local index can also see, so the
   * remainder is the account's own statement of spend this machine cannot account for.
   */
  surface_breakdown: ClaudeProductBreakdown | null;
  /**
   * The meter dropped inside this server window (plan change). `window_start`, spend, elapsed
   * time and pace then describe the counter from the first reading after the drop, and pace
   * runs from that reading's percent to 100% at the unchanged reset.
   */
  counter_reset: ClaudeCounterReset | null;
  /** Models none of whose calls in this window has an actual-mode price; present only when some exist. */
  unpriced_models?: UnpricedModel[];
  /** `spend.gross` per local day with traffic; null while the stored sums predate their hours. */
  days: Array<{ date: string; tokens: number }> | null;
  /** Hourly tokens and dollars of the window for the chart's units; null while the stored sums predate their hours. */
  hours: ClaudeHourBlock[] | null;
  /** Calls billed from a promotional grant instead of the plan, by hour; absent without any. */
  credit_funded?: CreditFundedSums;
}
export interface ClaudeSessionWindow {
  window_start: string;
  reset_at: string;
  remaining_hours: number;
  elapsed_percent: number;
  percent_measured: number | null;
  measured_at: string | null;
  measured_age_minutes: number | null;
  spend: ClaudeSpend;
  pp_ahead: number | null;
}
export interface ClaudeCalibration {
  /**
   * Explicit manual local-traffic calibration or the shared conditional account
   * equivalent. Neither certifies complete source coverage.
   */
  traffic_scope: "observed_local_claude_traffic" | "code_calibrated_account_equivalent";
  basis: "manual" | "code_share" | "local_meter";
  api_value_basis: "actual" | "standard";
  covers_full_account: false;
  source_ts: string;
  usd_per_point: number;
  usd_per_point_fable: number | null;
  usd_per_point_rest: number | null;
  agreement_ratio: number | null;
  newest_reading_usd_per_point: number | null;
  drift_vs_newest_reading: number | null;
  source_percent_all: number | null;
  quantisation_percent: number | null;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
  boost_factor: number;
  usd_per_point_unboosted: number;
  window_value_usd: number;
  fable_window_value_usd: number | null;
  boost_ends: string | null;
}
export interface ClaudeLimitReport {
  claude_capacity?: ClaudeCapacityResult;
  configured: boolean;
  plan: string | null;
  window_hours: number;
  fable_share_of_all: number | null;
  observations: ClaudeObservationReport[];
  calibration: ClaudeCalibration | null;
  models: ClaudeModelCost[];
  current: ClaudeCurrentWindow | null;
  session: ClaudeSessionWindow | null;
  probe: ClaudeProbeState;
  /** The one shared Claude Code estimate; `null` when no context was supplied here. */
  claude_code_capacity: ClaudeCodeCapacitySummary | null;
  caveats: string[];
}
/** History-derived scalars published by the shared background preparation. */
export interface ClaudeLimitCardMetadata {
  observationCount: number;
  probeSampleCount: number;
}
const MIN_CALIBRATION_PERCENT = 5;
const CALIBRATION_REACH_WINDOWS = 4;

/** Exact legacy counts from scalar indexed probe columns; never reads extra payloads or sums into JS. */
export function readClaudeLimitCardMetadata(sqlite: Database, cfg: ClaudeGaugeConfig): ClaudeLimitCardMetadata {
  const account = claudeAccountId(cfg.subscription);
  if (!account) return { observationCount: 0, probeSampleCount: 0 };
  if (!preparedProbeAccountIndexReady(sqlite)) throw new ProbeAccountIndexUnavailable();
  const rows = selectOwnedProbes(sqlite, probeReadContext(sqlite), "claude", account, {
    order: "desc", limit: 20_000, columns: "p.id,p.ts,p.kind,p.scope,p.used_percent,p.resets_at",
  }).map(item => item.row).reverse();
  return claudeLimitMetadataOfRows(sqlite, cfg, rows);
}

/** Shared exact projection for both full-reference backfill and an affected reset component. */
export function claudeLimitMetadataOfRows(sqlite: Database, cfg: ClaudeGaugeConfig,
  rows: ProbeAccountReadings["rows"]): ClaudeLimitCardMetadata {
  const account = claudeAccountId(cfg.subscription)!;
  // Use the original selectors so reset jitter, counter scopes and ordering stay identical.
  const samples = readClaudeProbe(sqlite, account, { rows, observation: new Map() });
  const observations = probeAsObservations(samples, cfg, cfg.window_hours && cfg.window_hours > 0 ? cfg.window_hours : 168);
  const headers = readLimitWindowHeaders(sqlite, "claude", account).filter(row => {
    const [kind, , minutes] = JSON.parse(row.counter);
    return kind === "weekly_all" && minutes === 10080;
  }).sort((a, b) => a.start.localeCompare(b.start));
  let count = 0;
  const exists = sqlite.query(`SELECT EXISTS(SELECT 1 FROM json_each(readings)
    WHERE substr(json_extract(value,'$.ts'),1,23)<=?) AS present
    FROM window_usage WHERE provider='claude' AND account=? AND counter=? AND window_id=?`);
  for (const observation of observations) {
    const window = headers.filter(row => sameResetWindow(row.reset, observation.reset_ts)
      && windowActiveAt(row, Date.parse(observation.ts))).at(-1);
    if (!window) continue;
    const value = exists.get(new Date(Date.parse(observation.ts)).toISOString().slice(0,23), account, window.counter, window.id) as { present: number } | null;
    if (!value) throw new ProbeAccountIndexUnavailable();
    if (value.present) count++;
  }
  count += claudeLimitManualObservationCount(cfg);
  return { observationCount: count, probeSampleCount: samples.length };
}

export function claudeLimitManualObservationCount(cfg: ClaudeGaugeConfig): number {
  return (cfg.observations ?? []).filter(observation => observation?.reset_ts && claudeGaugeObservationSpan(observation,
    cfg.window_hours && cfg.window_hours > 0 ? cfg.window_hours : 168)).length;
}

/** The global fallback skips silent share-less readings, but retains invalid shares and contradictory copies. */
function lastCapacityWitness(sqlite: Database, account: string) {
  const context=probeReadContext(sqlite), sibling=preparedProbeOwnedBySql(sqlite,context,"claude",account,"q");
  let upper = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const candidate = selectOwnedProbes(sqlite,context,"claude",account,{
      key:"observation_at",keyUntil:upper,order:"desc",limit:1,columns:"p.id",
      where:`p.kind='weekly_all' AND p.scope IS NULL AND (
        (json_valid(p.extra) AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.extra) THEN p.extra ELSE '{}' END)
          WHERE key LIKE 'claude.share.%')) OR EXISTS(SELECT 1 FROM probe_windows q
          WHERE q.provider='claude' AND q.kind='weekly_all' AND q.scope IS NULL AND q.ts=p.ts
            AND (q.used_percent IS NOT p.used_percent OR q.resets_at IS NOT p.resets_at) AND ${sibling.sql}))`,params:sibling.params,
    })[0];
    if (!candidate) return null;
    const readings = readPreparedProbeAccountReadings(sqlite,"claude",account,
      {key:"observation_at",keyFrom:candidate.key,keyUntil:candidate.key+1});
    if (!readings) throw new ProbeAccountIndexUnavailable();
    const observation = readClaudeCodeObservations(sqlite,account,{},readings).filter(row=>row.reason!=="share_absent").at(-1);
    if(observation)return {observation,readings};
    // A conflicting row owned by another account can only nominate a candidate, never donate evidence.
    upper=candidate.key;
  }
}

/** Small selected/current report; historical observations are an independent, on-demand read. */
export function buildClaudeLimitCard(sqlite: Database, cfg: ClaudeGaugeConfig, price: ClaudePricer,
  nowIso: string | undefined, context: ClaudeCodeCapacityContext, bounds?: { from: string; until: string },
  metadata?: ClaudeLimitCardMetadata): ClaudeLimitReport {
  const account = claudeAccountId(cfg.subscription);
  if (!account) return buildClaudeLimit(sqlite, cfg, price, nowIso, context, bounds, metadata);
  if (!metadata) {
    const stored = preparedClaudeCardMetadata(sqlite,account);
    metadata = { ...stored, observationCount: stored.observationCount + claudeLimitManualObservationCount(cfg) };
  }
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const headers = readLimitWindowHeaders(sqlite, "claude", account);
  const weekly = headers.filter(row => {
    const [kind, , minutes] = JSON.parse(row.counter);
    return kind === "weekly_all" && minutes === 10080;
  }).sort((a, b) => a.start.localeCompare(b.start));
  const selected = bounds ? weekly.find(row => Date.parse(row.start) === Date.parse(bounds.from) && Date.parse(row.end) === Date.parse(bounds.until))
    : weekly.find(row => windowActiveAt(row, now));
  const previous = weekly.filter(row => Date.parse(row.end) <= now).sort((a,b) => Date.parse(a.end)-Date.parse(b.end)).at(-1);
  const required = new Set([selected?.id, previous?.id].filter((id): id is string => !!id));
  const fallback = !selected ? lastCapacityWitness(sqlite,account) : null;
  if(fallback?.observation.reset_at)for(const row of weekly)if(sameResetWindow(row.reset,fallback.observation.reset_at))required.add(row.id);
  for (const row of [selected, previous]) if (row) {
    const predecessor = weekly.find(candidate => candidate.counter === row.counter && candidate.end === row.start);
    if (predecessor) required.add(predecessor.id);
  }
  const readings: ProbeAccountReadings = { rows: [], observation: new Map() };
  const include = (part: ProbeAccountReadings | null) => {
    if (!part) throw new ProbeAccountIndexUnavailable();
    readings.rows.push(...part.rows);
    for (const [id, at] of part.observation) readings.observation.set(id, at);
  };
  if(fallback)include(fallback.readings);
  for (const row of weekly.filter(row => required.has(row.id))) include(readPreparedProbeAccountReadings(sqlite, "claude", account,
    { key: "accounting_at", keyFrom: Date.parse(row.start), keyUntil: Date.parse(row.end) + 1 }));
  for (const kind of ["weekly_all", "weekly_scoped", "session"]) include(readPreparedProbeAccountReadings(sqlite, "claude", account,
    { where: "p.kind=?", params: [kind], order: "desc", limit: 1 }));
  readings.rows = [...new Map(readings.rows.map(row => [row.id, row])).values()]
    .sort((a,b) => Date.parse(a.ts)-Date.parse(b.ts) || a.id-b.id);
  const windows = readLimitWindowsWhere(sqlite, "claude", account, () => true, [...required]);
  const eligibleIds = new Set((sqlite.query(`SELECT probe_id FROM claude_card_members WHERE account=?
    AND probe_id IN (SELECT value FROM json_each(?))`).all(account,JSON.stringify(readings.rows.map(row=>row.id))) as {probe_id:number}[]).map(row=>row.probe_id));
  const probeReadings = { ...readings,rows:readings.rows.filter(row=>eligibleIds.has(row.id)) };
  return buildClaudeLimit(sqlite, cfg, price, nowIso, { ...context, probeReadings: readings,
    probeEvidence: { samples: probeLimitSamples(readings.rows, "claude"), revision: null }, probeWindows: windows }, bounds, { ...metadata,probeReadings });
}
function emptySpend(): ClaudeSpend {
  return { calls: 0, usd: 0, gross: 0, fresh: 0, unpriced_calls: 0 };
}
function addSpend(target: ClaudeSpend, other: ClaudeSpend): void {
  target.calls += other.calls;
  target.usd += other.usd;
  target.gross += other.gross;
  target.fresh += other.fresh;
  target.unpriced_calls += other.unpriced_calls;
}
function roundSpend(s: ClaudeSpend): ClaudeSpend {
  return { calls: s.calls, usd: round(s.usd, 2), gross: s.gross, fresh: s.fresh, unpriced_calls: s.unpriced_calls };
}
/**
 * Stored spend per model as this report shows it: calls, all tokens, fresh tokens and the stored
 * actual-mode API value; a call without an actual price adds its tokens but no dollars.
 */
function spendByModel(spends: readonly ModelSpend[]): Map<string, ClaudeSpend> {
  const byModel = new Map<string, ClaudeSpend>();
  for (const spend of spends) {
    const model = spend.model || "?", bucket = byModel.get(model) ?? emptySpend();
    addSpend(bucket, { calls: spend.events, usd: spend.actual, gross: spend.tokens, fresh: spend.fresh, unpriced_calls: spend.actual_unpriced });
    byModel.set(model, bucket);
  }
  return byModel;
}
/**
 * Models whose every call lacks an actual-mode price, with all their tokens. A missing rate leaves the whole
 * model unpriced; a model only partly unpriced (unknown mode) is not a missing rate and is left out.
 */
function unpricedSpendModels(byModel: Map<string, ClaudeSpend>): UnpricedModel[] {
  return [...byModel].filter(([, spend]) => spend.calls > 0 && spend.unpriced_calls >= spend.calls && spend.gross > 0)
    .map(([model, spend]) => ({ model, tokens: spend.gross })).sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
}
function totalOf(byModel: Map<string, ClaudeSpend>, pick?: (model: string) => boolean): ClaudeSpend {
  const total = emptySpend();
  for (const [model, spend] of byModel) {
    if (pick && !pick(model)) continue;
    addSpend(total, spend);
  }
  return total;
}
function countMissingDays(start: Date, end: Date, seen: Set<string>): number {
  let missing = 0;
  for (let t = start.getTime(); t < end.getTime(); t += 24 * HOUR_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (!seen.has(day)) missing += 1;
  }
  return missing;
}
function confidenceOf(
  agreement: number | null,
  percentAll: number | null,
  missingDays: number,
  observationCount: number,
  drift: number | null,
  elapsedPercent: number
): { confidence: ClaudeCalibration["confidence"]; reason: string } {
  if (percentAll == null || percentAll <= 0) {
    return { confidence: "none", reason: "obserwacja nie podaje odczytu 'All models'" };
  }
  const parts: string[] = [`odczyt ${percentAll}% przy ${elapsedPercent.toFixed(0)}% okna`];
  if (drift != null && Math.abs(drift) > 0.1) {
    return {
      confidence: "low",
      reason:
        `${parts.join(", ")} — koszt punktu przesunął się o ${(drift * 100).toFixed(0)}% ` +
        `względem poprzedniego odczytu; albo skala nie jest liniowa, albo indeks nie widzi części zużycia`,
    };
  }
  if (agreement != null) parts.push(`zgodność Fable/reszta ${(agreement * 100).toFixed(1)}%`);
  if (missingDays > 0) parts.push(`${missingDays} dni okna bez zdarzeń w indeksie`);
  if (observationCount > 1) parts.push(`${observationCount} obserwacje`);
  if (agreement == null) {
    return {
      confidence: "low",
      reason: `${parts.join(", ")} — brak odczytu Fable, więc koszt punktu opiera się na jednym słupku`,
    };
  }
  if (missingDays > 1) {
    return {
      confidence: "low",
      reason: `${parts.join(", ")} — dziury w indeksie zaniżają koszt punktu`,
    };
  }
  const off = Math.abs(agreement - 1);
  if (off <= 0.05) {
    return {
      confidence: observationCount > 1 ? "high" : "medium",
      reason: `${parts.join(", ")} — dwa niezależne słupki dają ten sam koszt punktu, limit liczony w dolarach API`,
    };
  }
  if (off <= 0.2) {
    return {
      confidence: "low",
      reason: `${parts.join(", ")} — słupki rozjeżdżają się o ${(off * 100).toFixed(0)}%`,
    };
  }
  return {
    confidence: "none",
    reason: `${parts.join(", ")} — rozjazd ${(off * 100).toFixed(0)}% wyklucza wagę dolarową; nie licz z tego kosztu 1% per model`,
  };
}
export interface ClaudeProbeState {
  ok: boolean;
  ts: string | null;
  age_minutes: number | null;
  weekly_percent: number | null;
  weekly_fable_percent: number | null;
  weekly_resets_at: string | null;
  session_percent: number | null;
  session_resets_at: string | null;
  samples: number;
}
export function boostFactorAt(cfg: ClaudeGaugeConfig, iso: string): number {
  for (const b of cfg.boosts || []) {
    if (b.from && iso < b.from) continue;
    if (b.until && iso.slice(0, 10) > b.until) continue;
    return typeof b.factor === "number" && b.factor > 0 ? b.factor : 1;
  }
  return 1;
}
function probeAsObservations(
  samples: ClaudeProbeSample[],
  cfg: ClaudeGaugeConfig,
  windowHours: number
): ClaudeGaugeObservation[] {
  interface Slot {
    ts: string;
    reset: string;
    all?: number;
    fable?: number;
  }
  const byWindow = new Map<string, Slot>();
  for (const s of samples) {
    if (!s.resets_at) continue;
    if (s.kind !== "weekly_all" && s.kind !== "weekly_scoped") continue;
    let key = [...byWindow.keys()].find((k) => sameResetWindow(k, s.resets_at));
    if (!key) key = s.resets_at;
    const slot: Slot = byWindow.get(key) || { ts: s.ts, reset: s.resets_at };
    if (s.ts > slot.ts) slot.ts = s.ts;
    if (s.kind === "weekly_all") slot.all = s.percent;
    else slot.fable = s.percent;
    byWindow.set(key, slot);
  }
  const out: ClaudeGaugeObservation[] = [];
  for (const slot of byWindow.values()) {
    if (typeof slot.all !== "number") continue;
    const resetMs = new Date(slot.reset).getTime();
    if (!Number.isFinite(resetMs)) continue;
    out.push({
      ts: slot.ts,
      reset_ts: new Date(resetMs).toISOString(),
      window_start_ts: new Date(resetMs - windowHours * HOUR_MS).toISOString(),
      percent: { all: slot.all, fable: slot.fable },
      boost_factor: boostFactorAt(cfg, slot.ts),
      source: "GET /api/oauth/usage — odczyt konta",
    });
  }
  return out;
}
function probeStateOf(samples: ClaudeProbeSample[], nowMs: number): ClaudeProbeState {
  const newest = (kind: string, scope?: string | null): ClaudeProbeSample | null => {
    let best: ClaudeProbeSample | null = null;
    for (const s of samples) {
      if (s.kind !== kind) continue;
      if (scope !== undefined && (s.scope_label ?? null) !== scope) continue;
      if (!best || s.ts > best.ts) best = s;
    }
    return best;
  };
  const weekly = newest("weekly_all");
  const fable = newest("weekly_scoped");
  const session = newest("session");
  const ts = [weekly, fable, session].reduce<string | null>(
    (acc, s) => (s && (!acc || s.ts > acc) ? s.ts : acc),
    null
  );
  return {
    ok: weekly != null,
    ts,
    age_minutes: measuredAgeMinutes(ts, nowMs, 1),
    weekly_percent: weekly?.percent ?? null,
    weekly_fable_percent: fable?.percent ?? null,
    weekly_resets_at: weekly?.resets_at ?? null,
    session_percent: session?.percent ?? null,
    session_resets_at: session?.resets_at ?? null,
    samples: samples.length,
  };
}
/**
 * Pace of a counter segment that starts at `baseline` percent: an even pace reaches 100% at the
 * reset, so the segment's own share of the remaining cap is compared with its share of time.
 * With a zero baseline this is exactly `limitPace`.
 */
export function segmentPace(percent: number | null, baseline: number, timing: LimitWindowTiming) {
  const room = 100 - baseline;
  if (percent == null || room <= 0) return limitPace(null, timing, 1);
  const pace = limitPace(((percent - baseline) / room) * 100, timing, 1);
  return {
    ...pace,
    ppAhead: pace.ppAhead == null ? null : (pace.ppAhead * room) / 100,
    projectedEndPercent: pace.projectedEndPercent == null ? null : baseline + (pace.projectedEndPercent * room) / 100,
  };
}
export function buildClaudeLimit(
  sqlite: Database,
  cfg: ClaudeGaugeConfig,
  _price: ClaudePricer,
  nowIso?: string,
  context?: ClaudeCodeCapacityContext,
  /** A closed window or counter segment picked in the rail: `current` covers exactly these bounds. */
  bounds?: { from: string; until: string },
  card?: ClaudeLimitCardMetadata & { probeReadings?: ProbeAccountReadings }
): ClaudeLimitReport {
  const windowHours = cfg.window_hours && cfg.window_hours > 0 ? cfg.window_hours : 168;
  const nowMs = nowIso ? new Date(nowIso).getTime() : Date.now();
  const account = claudeAccountId(cfg.subscription);
  if (!account) return {
    configured: false, plan: null, window_hours: windowHours,
    fable_share_of_all: null, observations: [], calibration: null, models: [],
    current: null, session: null, probe: probeStateOf([], nowMs),
    claude_code_capacity: null, caveats: [],
  };
  let periods = context?.planPeriods;
  if (!periods) try { periods = loadPeriods(sqlite, PLAN_PERIODS); } catch { periods = []; }
  const periodIndex = planPeriodIndex(periods);
  // One read of the account's readings serves the probe samples and the Code estimate's observations and
  // samples; the estimate maps observations to windows by reading samples only, without limit refusals.
  const readings = context?.probeReadings
    ?? (context?.probeEvidence ? undefined : readPreparedProbeAccountReadings(sqlite, "claude", account) ?? undefined);
  if (!context?.probeEvidence && !readings) throw new ProbeAccountIndexUnavailable();
  const evidence = context?.probeEvidence ?? { samples: probeLimitSamples(readings!.rows, "claude"), revision: null };
  const registerWindows = context?.probeWindows ?? claudeWeeklyRegisterWindows(sqlite, account);
  const registerWindow = bounds
    ? registerWindows.find(window => Date.parse(window.start) === Date.parse(bounds.from)
      && Date.parse(window.end) === Date.parse(bounds.until)) ?? null
    : registerWindows.find(window => windowActiveAt(window, nowMs)) ?? null;
  // A week without a meter reading yet has no stored limit window; the window producer's declared week,
  // anchored on the last known reset, is then the current window, as the rail shows it. Its percent is only estimated.
  const declaredWeek = registerWindow || bounds ? null : readWindowIntervals(sqlite, "claude", account).find(interval =>
    interval.kind === "declared" && interval.declared.kind === "weekly_all" && !interval.declared.scope
    && Date.parse(interval.start) <= nowMs && nowMs < Date.parse(interval.end)) ?? null;
  const plan = registerWindow ? registerWindow.plan : bounds
    ? probeWindowPlan(periodIndex, periods, "claude", account, bounds.from, bounds.until).plan
    : periodIndex?.resolve("claude", account, new Date(nowMs).toISOString()).value ?? null;
  const capacityContext = context && { ...context, probeEvidence: evidence, probeWindows: registerWindows, probeReadings: readings };
  const codeCapacity = claudeCodeCapacitySummaryOrAbsent(sqlite, account, capacityContext,
    { now: bounds ? undefined : nowIso, windowId: registerWindow?.id,
      ...(card && registerWindow ? { since: registerWindow.start, untilExclusive: registerWindow.end } : {}) });
  // A week the meter has not reported yet began at a reset (0%): the point cost of the week before it,
  // on the same plan, turns its indexed usage into an estimate until the first reading.
  const previousWeek = declaredWeek ? registerWindows.filter(window => Date.parse(window.end) <= nowMs)
    .sort((a, b) => Date.parse(a.end) - Date.parse(b.end)).at(-1) ?? null : null;
  const previousCapacityUsd = previousWeek && previousWeek.plan === plan
    ? claudeCodeCapacitySummaryOrAbsent(sqlite, account, capacityContext, { windowId: previousWeek.id,
      ...(card ? { since: previousWeek.start, untilExclusive: previousWeek.end } : {}) })?.weekly_capacity_api_usd.value ?? null
    : null;
  const previousUsdPerPoint = previousCapacityUsd != null && previousCapacityUsd > 0 ? previousCapacityUsd / 100 : null;
  const probeSamples = readClaudeProbe(sqlite, account, card?.probeReadings ?? readings);
  const probeObs = card ? [] : probeAsObservations(probeSamples, cfg, windowHours);
  const observationsIn = [
    ...(cfg.observations || [])
      .filter((o) => o && o.reset_ts)
      .map((obs) => ({ obs, basis: "manual" as const })),
    ...probeObs.map((obs) => ({ obs, basis: "probe" as const })),
  ];
  const fableShare = cfg.limits?.fable?.share_of_all ?? null;
  const fableModels = new Set(cfg.limits?.fable?.models || []);
  const isFable = (model: string): boolean => fableModels.has(model);
  const caveats = [...(cfg.caveats || [])];
  const probe = probeStateOf(probeSamples, nowMs);
  if (card) probe.samples = card.probeSampleCount;
  if (observationsIn.length === 0 && !(card?.observationCount) && !registerWindow && !declaredWeek) {
    return {
      configured: false,
      plan,
      window_hours: windowHours,
      fable_share_of_all: fableShare,
      observations: [],
      calibration: null,
      models: [],
      current: null,
      session: null,
      probe,
      claude_code_capacity: codeCapacity,
      caveats,
    };
  }
  // Stored sums (plan U1.4); nothing below reads events. A manual observation is its gauge interval
  // `[start, cutoff)`; a probe observation is the running total at its reading in the stored weekly
  // window of its reset, from the window start through the reading.
  const probeWindowOf = (obs: ClaudeGaugeObservation): ProbeLimitWindow | null => registerWindows.filter(window =>
    sameResetWindow(window.reset, obs.reset_ts) && windowActiveAt(window, Date.parse(obs.ts))).at(-1) ?? null;
  const weekly = readWeeklySums(sqlite, account, [...new Set([...(registerWindow ? [registerWindow] : []),
    ...observationsIn.filter(item => item.basis === "probe").flatMap(item => probeWindowOf(item.obs) ?? [])])]);
  const gaugeSpans = new Map(observationsIn.filter(item => item.basis === "manual").flatMap(({ obs }) => {
    const span = claudeGaugeObservationSpan(obs, windowHours);
    return span ? [[claudeGaugeObservationId(obs), span] as const] : [];
  }));
  const gauge = readSpanSums(sqlite, "claude", account, [...gaugeSpans.keys()], ["cycle", "rail"]);
  type Measured = { byModel: Map<string, ClaudeSpend>; start: string; through: string; days: Set<string> };
  const measuredOf = ({ obs, basis }: { obs: ClaudeGaugeObservation; basis: "manual" | "probe" }): Measured | null => {
    if (basis === "manual") {
      const id = claudeGaugeObservationId(obs), span = gaugeSpans.get(id);
      if (!span) return null;
      const row = gauge.get(id)!;
      return { byModel: spendByModel(row.cycle.spend ?? []), start: span.start, through: span.cutoff, days: new Set(row.rail.days) };
    }
    const window = probeWindowOf(obs), readings = window ? weekly.get(window.id)!.readings : [];
    const index = readingIndexAt(readings, Date.parse(obs.ts));
    // An observation outside the stored windows has no canonical sum to show.
    if (!window || index < 0) return null;
    const through = spendThroughReading(readings, index);
    return { byModel: spendByModel(through.spend), start: window.start, through: new Date(Date.parse(readings[index]!.ts)).toISOString(),
      days: new Set(through.days) };
  };
  const sorted = [...observationsIn].sort(
    (a, b) =>
      a.obs.reset_ts.localeCompare(b.obs.reset_ts) || (a.obs.ts || "").localeCompare(b.obs.ts || "")
  );
  const measuredByReport = new Map<ClaudeObservationReport, Map<string, ClaudeSpend>>();
  const reports: ClaudeObservationReport[] = sorted.flatMap(({ obs, basis }) => {
    const measured = measuredOf({ obs, basis });
    if (!measured) return [];
    const { byModel } = measured;
    const startMs = Date.parse(measured.start), cutoffMs = Date.parse(measured.through);
    const spend = totalOf(byModel);
    const fableSpend = totalOf(byModel, isFable);
    const restSpend: ClaudeSpend = {
      calls: spend.calls - fableSpend.calls,
      usd: spend.usd - fableSpend.usd,
      gross: spend.gross - fableSpend.gross,
      fresh: spend.fresh - fableSpend.fresh,
      unpriced_calls: spend.unpriced_calls - fableSpend.unpriced_calls,
    };
    const percentAll = typeof obs.percent?.all === "number" ? obs.percent.all : null;
    const percentFable = typeof obs.percent?.fable === "number" ? obs.percent.fable : null;
    const fablePoints =
      percentFable != null && fableShare != null ? round(percentFable * fableShare, 3) : null;
    const restPoints =
      percentAll != null && fablePoints != null ? round(percentAll - fablePoints, 3) : null;
    const usdPerPoint = basis === "manual" && percentAll != null && percentAll > 0 && percentAll < 100 ? spend.usd / percentAll : null;
    const usdPerPointFable = basis === "manual" && fablePoints && fablePoints > 0 ? fableSpend.usd / fablePoints : null;
    const usdPerPointRest = basis === "manual" && restPoints && restPoints > 0 ? restSpend.usd / restPoints : null;
    const report: ClaudeObservationReport = {
      ts: obs.ts,
      reset_ts: obs.reset_ts,
      window_start_ts: measured.start,
      measured_through: measured.through,
      window_elapsed_percent: round(windowElapsedPercent(startMs, windowHours, cutoffMs), 2),
      percent_all: percentAll,
      percent_fable: percentFable,
      boost_factor: obs.boost_factor ?? 1,
      fable_points: fablePoints,
      rest_points: restPoints,
      spend: roundSpend(spend),
      fable_spend: roundSpend(fableSpend),
      rest_spend: roundSpend(restSpend),
      usd_per_point: usdPerPoint,
      usd_per_point_fable: usdPerPointFable != null ? round(usdPerPointFable, 3) : null,
      usd_per_point_rest: usdPerPointRest != null ? round(usdPerPointRest, 3) : null,
      agreement_ratio:
        usdPerPointFable != null && usdPerPointRest != null && usdPerPointRest > 0
          ? round(usdPerPointFable / usdPerPointRest, 4)
          : null,
      basis,
      source: obs.source,
      note: obs.note,
      days_without_events: countMissingDays(new Date(startMs), new Date(cutoffMs), measured.days),
    };
    measuredByReport.set(report, byModel);
    return [report];
  });
  const observationCount = card?.observationCount ?? reports.length;
  const priced = reports.filter((r) => r.usd_per_point != null);
  const precise = priced.filter((r) => (r.percent_all ?? 0) >= MIN_CALIBRATION_PERCENT);
  const usable = precise.length > 0 ? precise : priced;
  const newest = usable.length > 0 ? usable[usable.length - 1]! : null;
  const newestReset = newest?.reset_ts ?? null;
  const reach = newestReset
    ? new Date(new Date(newestReset).getTime() - CALIBRATION_REACH_WINDOWS * windowHours * HOUR_MS)
        .toISOString()
    : null;
  const candidates = reach ? usable.filter((r) => r.reset_ts >= reach) : usable;
  const latest =
    candidates.length > 0
      ? candidates.reduce((best, r) =>
          (r.percent_all ?? 0) > (best.percent_all ?? 0) ||
          ((r.percent_all ?? 0) === (best.percent_all ?? 0) && r.ts > best.ts)
            ? r
            : best
        )
      : newest;
  const drift =
    latest?.usd_per_point != null &&
    newest?.usd_per_point != null &&
    newest !== latest &&
    latest.usd_per_point > 0
      ? round(newest.usd_per_point / latest.usd_per_point - 1, 4)
      : null;
  const boost = (cfg.boosts || [])[0] ?? null;
  let calibration: ClaudeCalibration | null = null;
  if (latest && latest.usd_per_point != null) {
    const { confidence, reason } = confidenceOf(
      latest.agreement_ratio,
      latest.percent_all,
      latest.days_without_events,
      observationCount,
      drift,
      latest.window_elapsed_percent
    );
    const factor = latest.boost_factor > 0 ? latest.boost_factor : 1;
    calibration = {
      traffic_scope: "observed_local_claude_traffic",
      basis: "manual",
      api_value_basis: "actual",
      covers_full_account: false,
      source_ts: latest.ts,
      usd_per_point: latest.usd_per_point,
      usd_per_point_fable: latest.usd_per_point_fable,
      usd_per_point_rest: latest.usd_per_point_rest,
      agreement_ratio: latest.agreement_ratio,
      newest_reading_usd_per_point: newest !== latest ? (newest?.usd_per_point ?? null) : null,
      drift_vs_newest_reading: drift,
      source_percent_all: latest.percent_all,
      quantisation_percent:
        latest.percent_all && latest.percent_all > 0
          ? round((0.5 / latest.percent_all) * 100, 1)
          : null,
      confidence,
      reason,
      boost_factor: factor,
      usd_per_point_unboosted: latest.usd_per_point / factor,
      window_value_usd: latest.usd_per_point * 100,
      fable_window_value_usd:
        fableShare != null ? round(latest.usd_per_point * 100 * fableShare, 2) : null,
      boost_ends: boost?.until ?? null,
    };
  }
  const sharedWeeklyUsd = windowHours === 168 && codeCapacity?.account.toLowerCase() === account.toLowerCase()
    ? codeCapacity.weekly_capacity_api_usd.value : null;
  // All consumers project the same result; models use its exact sample and valuation basis.
  let capacityResult: ClaudeCapacityResult | undefined;
  if (latest && calibration?.basis === "manual" && sharedWeeklyUsd == null) {
    capacityResult = manualClaudeCapacityResult({ account, window_id: `gauge:${latest.ts}`,
      from: latest.window_start_ts, through: latest.measured_through, percent: latest.percent_all!, window_minutes: windowHours * 60,
      models: [...measuredByReport.get(latest)!].map(([model, spend]) => ({ model, events: spend.calls,
        tokens: spend.gross, fresh: spend.fresh, api_standard: spend.usd, unpriced_events: spend.unpriced_calls })) });
  } else if (registerWindow && windowHours === 168) {
    capacityResult = codeCapacity ? readClaudeCapacityResult(sqlite, codeCapacity, registerWindows) : undefined;
  } else if (codeCapacity && windowHours === 168 && !bounds) {
    capacityResult = readClaudeCapacityResult(sqlite, codeCapacity, registerWindows);
  }
  const models = capacityResult?.models ?? [];
  if (capacityResult?.capacity_api_usd.value != null) {
    const point = claudeCapacityPerPoint(capacityResult, "api_standard")!;
    if (capacityResult.basis === "manual" && calibration) {
      calibration = { ...calibration, usd_per_point: point, window_value_usd: capacityResult.capacity_api_usd.value };
    } else {
      const share = capacityResult.basis === "code_share";
      calibration = { traffic_scope: share ? "code_calibrated_account_equivalent" : "observed_local_claude_traffic",
        basis: share ? "code_share" : "local_meter", api_value_basis: capacityResult.api_value_basis, covers_full_account: false,
        source_ts: capacityResult.sample!.through, usd_per_point: point,
        usd_per_point_fable: null, usd_per_point_rest: null, agreement_ratio: null,
        newest_reading_usd_per_point: null, drift_vs_newest_reading: null, source_percent_all: capacityResult.sample!.end_percent,
        quantisation_percent: null, confidence: "low", reason: share
          ? "Conditional account equivalent from the shared Claude Code product-share estimate; source completeness is unconfirmed."
          : "Local traffic divided by the same stored meter sample; source completeness is unconfirmed.",
        boost_factor: 1, usd_per_point_unboosted: point, window_value_usd: capacityResult.capacity_api_usd.value, fable_window_value_usd: null, boost_ends: null };
    }
  }
  // readClaudeProbe keeps the newest sample per window, so a window has at most one.
  const breakdownForWindow = (resetIso: string): ClaudeProductBreakdown | null =>
    probeSamples.find((sample) =>
      sample.kind === "weekly_all" && (sample.scope_label ?? null) === null &&
      sample.product_breakdown != null && sameResetWindow(sample.resets_at, resetIso)
    )?.product_breakdown ?? null;
  let current: ClaudeCurrentWindow | null = null;
  const declaredSums = !registerWindow && declaredWeek
    ? readSpanSums(sqlite, "claude", account, [declaredWeek.id], ["cycle", "rail"]).get(declaredWeek.id)! : null;
  const currentWindow = registerWindow
    ? { id: registerWindow.id, start: registerWindow.start, end: registerWindow.end, readings: registerWindow.readings,
      baseline: registerWindow.startDrop?.after ?? 0, counterReset: probeWindowCounterReset(registerWindow, registerWindows),
      spend: weekly.get(registerWindow.id)!.cycle.spend ?? [], sums: weekly.get(registerWindow.id)!.readings,
      rail: readWindowSums(sqlite, "claude", account, registerWindow.counter, [registerWindow], ["rail"]).get(registerWindow.id)!.rail }
    : declaredWeek && declaredSums
      ? { id: declaredWeek.id, start: declaredWeek.start, end: declaredWeek.end, readings: [], baseline: 0, counterReset: null,
        spend: declaredSums.cycle.spend ?? [], sums: [] as WindowReadingSums[], rail: declaredSums.rail }
      : null;
  if (currentWindow) {
    const timing = windowFromReset(currentWindow.end,
      (Date.parse(currentWindow.end) - Date.parse(currentWindow.start)) / HOUR_MS, nowMs)!;
    const counterReset = currentWindow.counterReset;
    const baseline = currentWindow.baseline;
    const startIso = currentWindow.start;
    const resetIso = currentWindow.end;
    const byModel = spendByModel(currentWindow.spend);
    const spend = totalOf(byModel);
    const unpricedModels = unpricedSpendModels(byModel);
    const fableSpend = totalOf(byModel, isFable);
    const elapsedHours = timing.elapsedHours!;
    const elapsedPercent = timing.elapsedPercent!;
    const sharedMatchesWindow = capacityResult?.window_id === currentWindow.id;
    const usdPerPoint = calibration?.basis === "manual" ? calibration.usd_per_point
      : sharedMatchesWindow && capacityResult?.capacity_api_usd.value != null ? capacityResult.capacity_api_usd.value / 100 : null;
    const manualPoint = calibration?.basis === "manual" ? usdPerPoint : null;
    const estimatePoint = manualPoint ?? (registerWindow ? null : previousUsdPerPoint);
    const percentAllEst = estimatePoint ? round(baseline + spend.usd / estimatePoint, 2) : null;
    const fablePointBudget =
      manualPoint && fableShare != null && fableShare > 0 ? manualPoint * fableShare : null;
    const percentFableEst = fablePointBudget ? round(fableSpend.usd / fablePointBudget, 2) : null;
    const meterReading = [...currentWindow.readings].reverse().find(reading => reading.source === "probe" || reading.source === "limit_hit");
    const percentAllLive = meterReading?.percent ?? percentAllEst;
    const pace = segmentPace(percentAllLive, baseline, timing);
    const sameWindow = meterReading != null && sameResetWindow(probe.weekly_resets_at, resetIso)
      && probe.ts === meterReading.ts;
    current = {
      window_id: currentWindow.id,
      window_start: startIso,
      reset_at: resetIso,
      elapsed_hours: round(elapsedHours, 2),
      remaining_hours: round(Math.max(0, timing.remainingHours), 2),
      elapsed_percent: round(elapsedPercent, 2),
      spend: roundSpend(spend),
      fable_spend: roundSpend(fableSpend),
      percent_all_measured: meterReading?.percent ?? null,
      percent_fable_measured: sameWindow ? probe.weekly_fable_percent : null,
      measured_at: meterReading?.ts ?? null,
      measured_age_minutes: meterReading ? measuredAgeMinutes(meterReading.ts, nowMs, 1) : null,
      percent_all_est: percentAllEst,
      percent_fable_est: percentFableEst,
      pp_ahead: pace.ppAhead != null ? round(pace.ppAhead, 2) : null,
      projected_end_percent:
        pace.projectedEndPercent != null ? round(pace.projectedEndPercent, 1) : null,
      eta_100_iso: pace.eta100Iso,
      remaining_usd:
        (usdPerPoint ?? estimatePoint) && percentAllLive != null
          ? Math.max(0, 100 - percentAllLive) * (usdPerPoint ?? estimatePoint)!
          : null,
      surface_breakdown: breakdownForWindow(resetIso),
      counter_reset: counterReset,
      ...(unpricedModels.length ? { unpriced_models: unpricedModels } : {}),
      days: tokensByLocalDay(currentWindow.rail),
      hours: claudeHourBlocks(currentWindow.rail, currentWindow.sums, currentWindow.spend),
      ...(currentWindow.rail?.credit_funded ? { credit_funded: currentWindow.rail.credit_funded } : {}),
    };
  }
  // The session window is the stored limit window of the newest session reading's reset, as the rail segments it.
  let session: ClaudeSessionWindow | null = null;
  const sessionIds = card && probe.session_resets_at ? readLimitWindowHeaders(sqlite, "claude", account)
    .filter(row => JSON.parse(row.counter)[0] === "session" && sameResetWindow(row.reset, probe.session_resets_at)).map(row => row.id) : undefined;
  const sessionWindow = probe.session_percent != null && probe.session_resets_at
    ? readLimitWindowsWhere(sqlite, "claude", account, counter => JSON.parse(counter)[0] === "session", sessionIds)
      .filter(window => sameResetWindow(window.reset, probe.session_resets_at) && windowActiveAt(window, probe.ts ? Date.parse(probe.ts) : nowMs))
      .sort((a, b) => a.start.localeCompare(b.start)).at(-1) ?? null
    : null;
  if (sessionWindow && probe.session_percent != null) {
    const timing = windowFromReset(sessionWindow.end, (Date.parse(sessionWindow.end) - Date.parse(sessionWindow.start)) / HOUR_MS, nowMs);
    if (timing?.windowStart && timing.elapsedPercent != null) {
      const startIso = sessionWindow.start;
      const resetIso = sessionWindow.end;
      const stored = readWindowSums(sqlite, "claude", account, sessionWindow.counter, [sessionWindow], ["cycle"]).get(sessionWindow.id)!;
      const spend = totalOf(spendByModel(stored.cycle.spend ?? []));
      const pace = limitPace(probe.session_percent, timing);
      session = {
        window_start: startIso,
        reset_at: resetIso,
        remaining_hours: round(Math.max(0, timing.remainingHours), 2),
        elapsed_percent: round(timing.elapsedPercent, 2),
        percent_measured: probe.session_percent,
        measured_at: probe.ts,
        measured_age_minutes: probe.age_minutes,
        spend: roundSpend(spend),
        pp_ahead: pace.ppAhead != null ? round(pace.ppAhead, 2) : null,
      };
    }
  }
  if (!probe.ok) {
    caveats.push(
      "Brak odczytu z konta — procenty poniżej są policzone z kosztu punktu, nie zmierzone. " +
        "Probe (`GET /api/oauth/usage`) albo nie chodzi, albo token OAuth wygasł."
    );
  } else if (probe.age_minutes != null && probe.age_minutes > 60) {
    caveats.push(
      `Ostatni odczyt z konta ma ${Math.round(probe.age_minutes)} min — słupek mógł się od tego czasu ruszyć.`
    );
  }
  if (
    current?.percent_all_measured != null &&
    current.percent_all_est != null &&
    Math.abs(current.percent_all_measured - current.percent_all_est) > 2
  ) {
    const gap = round(current.percent_all_est - current.percent_all_measured, 1);
    caveats.push(
      `Konto mówi ${current.percent_all_measured}%, indeks liczy ${current.percent_all_est}% (${gap > 0 ? "+" : ""}${gap} pp). ` +
        "Różnica to albo zużycie spoza indeksu, albo nieaktualny koszt punktu — pokazywana jest liczba z konta."
    );
  }
  if (calibration && observationCount < 2) {
    caveats.push(
      "Kalibracja opiera się na pojedynczym odczycie — koszt punktu jest ustalony, ale liniowość skali nie została sprawdzona."
    );
  }
  if (calibration?.drift_vs_newest_reading != null && Math.abs(calibration.drift_vs_newest_reading) > 0.05) {
    const pct = (calibration.drift_vs_newest_reading * 100).toFixed(0);
    caveats.push(
      `Skalę ustawia odczyt przy ${calibration.source_percent_all}% ($${calibration.usd_per_point}/pkt), ` +
        `a najnowszy odczyt wyceniałby punkt na $${calibration.newest_reading_usd_per_point} (${pct}%). ` +
        "Kalibruje głębszy, bo płytki wchłonąłby zużycie spoza indeksu w cenę punktu i różnica przestałaby być widoczna."
    );
  }
  if (calibration?.quantisation_percent != null && calibration.quantisation_percent > 1) {
    caveats.push(
      `Słupek czytany jest w pełnych procentach, więc odczyt przy ${latest?.percent_all}% niesie ok. ±${calibration.quantisation_percent}% niepewności kosztu punktu.`
    );
  }
  if (calibration?.boost_ends) {
    caveats.push(
      `Okno było boostowane x${calibration.boost_factor}; po ${calibration.boost_ends} ten sam punkt ma kosztować ok. $${calibration.usd_per_point_unboosted} zamiast $${calibration.usd_per_point}.`
    );
  }
  // Manual observations retain their explicitly declared, partial provenance.
  if (calibration?.basis === "manual") {
    caveats.push(
      "Manual calibration uses explicitly recorded observations of local traffic; it is partial and does not confirm whole-account capacity."
    );
  }
  return {
    configured: true,
    plan,
    window_hours: windowHours,
    fable_share_of_all: fableShare,
    observations: card ? [] : reports,
    calibration,
    models,
    current,
    session,
    probe,
    claude_code_capacity: codeCapacity,
    ...(capacityResult ? { claude_capacity: capacityResult } : {}),
    caveats,
  };
}

/** Stored cycle sums and readings of Claude weekly windows, by window id; a missing row is "preparing". */
function readWeeklySums(sqlite: Database, account: string, windows: readonly ProbeLimitWindow[],
  parts: ReadonlyArray<"cycle" | "readings"> = ["cycle", "readings"]) {
  const out = new Map<string, { cycle: WindowCycleSums; readings: WindowReadingSums[] }>();
  for (const counter of new Set(windows.map(window => window.counter)))
    for (const [id, sums] of readWindowSums(sqlite, "claude", account, counter, windows.filter(window => window.counter === counter), parts))
      out.set(id, Object.assign({ readings: [] as WindowReadingSums[] }, sums) as { cycle: WindowCycleSums; readings: WindowReadingSums[] });
  return out;
}
