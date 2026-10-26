import { readClaudeCapacityResult } from "./claude-capacity-result";
import { claudeCapacityPerPoint, type ClaudeCapacityResult } from "../shared/claude-capacity-result";
import type { Database } from "bun:sqlite";
import type { RateCard } from "./pricing";
import { getClaudeRate } from "./pricing";
import { codexWindowCalibrationModels } from "./codex-accounting";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { loadClaudeGauge, buildClaudeLimit, claudeAccountId, type ClaudeGaugeConfig } from "./claude-limit";
import { claudeCodeCapacitySummaryOrAbsent, type ClaudeCodeCapacityContext } from "./claude-code-capacity";
import { readPreparedProbeAccountReadings } from "./current/probe-account-reader";
import { probeLimitEvidenceOf } from "./probe-limit-windows";
import { eraCovers, normEraVendor, type EraIndex } from "./eras";
import { loadGrokGauge, storedGrokCalibration, type GrokGaugeConfig } from "./grok-limit";
import { buildGlmCalibration } from "./glm-limit";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { archiveFolderOf, codexHomeSource } from "./event-source";
import { codexLedgerPendingReason, codexLedgerReadContext, codexLedgerReadStamp } from "../db/codex-ledger-adapters";
import { codexPeriodsStamp, codexTableHomes } from "./codex-source-account";
import { loadAccountResolver } from "./account-resolver";
import { addDecimalAmounts, subtractDecimalAmounts } from "../shared/decimal-amount";
import { hasSubscriptionCapacity, storedCapacityForPeriod } from "../db/subscription-capacity";
import type { CapacityBasis, PriceBasis, CadenceBasis, SubscriptionCapacity } from "../shared/subscription-capacity";
export type { CapacityBasis, PriceBasis, CadenceBasis, SubscriptionCapacity } from "../shared/subscription-capacity";
export const DAYS_PER_MONTH = 30.44;
const MIN_PP_FOR_RATE = 20;
const MIN_GAUGE_SAMPLES = 20;
const MIN_CALLS = 100;
function tableExists(sqlite: Database, name: string): boolean {
  try {
    return (
      sqlite.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`).get(name) !=
      null
    );
  } catch {
    return false;
  }
}
export interface SeatTime {
  months: number;
  weeks: number;
}
export type CoverageKind = "full" | "partial" | "none";
export interface Provenance {
  capacity: CapacityBasis;
  price: PriceBasis;
  cadence: CadenceBasis;
  calibration_covers_period: boolean;
  coverage: CoverageKind;
  measured_share: number;
}
export const EQUIVALENT_ABSENT_REASONS = [
  "no_capacity",
  "period_uncovered",
  "cadence_uncalibrated",
  "invalid_usage",
] as const;
export type EquivalentAbsentReason = (typeof EQUIVALENT_ABSENT_REASONS)[number];
export type Equivalent =
  | { value: number; absent: null }
  | { value: null; absent: EquivalentAbsentReason };
export const EQUIVALENT_PUBLISHED_KEYS = ["value", "absent"] as const satisfies readonly (keyof Equivalent)[];
type _EquivalentKeyGap = Exclude<keyof Equivalent, (typeof EQUIVALENT_PUBLISHED_KEYS)[number]>;
const _equivalentKeysExhaustive: [_EquivalentKeyGap] extends [never] ? true : never = true;
void _equivalentKeysExhaustive;
export interface CapacityEquivalents {
  full_5h_sessions: Equivalent;
  weekly_cycles: Equivalent;
  monthly_subscriptions: Equivalent;
}
export interface CycleLike {
  usedPercent: number;
  sample_count: number;
  calls: number;
  usd: number;
  usd_per_percent?: number | null;
  start_ts?: string;
  end_ts?: string;
}
export const GAUGE_QUALITY_MIN_SAMPLES = 50;
export const GAUGE_QUALITY_MIN_SPAN_PP = 20;
export const GAUGE_QUALITY_MEDIUM_SPAN_PP = 50;
export const GAUGE_QUALITY_MEDIUM_STEPS = 30;
export const GAUGE_QUALITY_MEDIUM_LAG = 0.18;
export const GAUGE_QUALITY_HIGH_SPAN_PP = 80;
export const GAUGE_QUALITY_HIGH_STEPS = 60;
export const GAUGE_QUALITY_HIGH_LAG = 0.05;
export type GaugeConfidence = "none" | "low" | "medium" | "high";
export interface GaugeQuality {
  accepted: boolean;
  confidence: GaugeConfidence;
  span_percent: number;
  reason: string;
}
export function evaluateGaugeQuality(input: {
  sample_count: number;
  first_percent: number;
  peak_percent: number;
  lag_fraction?: number | null;
  distinct_steps?: number | null;
}): GaugeQuality {
  const span = Math.max(0, input.peak_percent - input.first_percent);
  const rawSamples = input.sample_count;
  const hasQuality = Number.isFinite(input.lag_fraction) && Number.isFinite(input.distinct_steps);
  const lagFraction = hasQuality ? Number(input.lag_fraction) : 0;
  const distinctSteps = hasQuality ? Number(input.distinct_steps) : 0;
  let confidence: GaugeConfidence;
  let reason: string;
  if (!hasQuality) {
    confidence = rawSamples < GAUGE_QUALITY_MIN_SAMPLES || span < GAUGE_QUALITY_MIN_SPAN_PP ? "none" : "low";
    reason =
      `serwer nie zwraca jakości gauge (lag_fraction / distinct_steps) — zrestartuj API, ` +
      `żeby odblokować pełną kalibrację. Zakres ${span.toFixed(0)} pp, ${rawSamples} próbek.`;
  } else if (rawSamples < GAUGE_QUALITY_MIN_SAMPLES || span < GAUGE_QUALITY_MIN_SPAN_PP) {
    confidence = "none";
    reason = `za mało sygnału (${rawSamples} próbek, zakres ${span.toFixed(0)} pp)`;
  } else if (
    span >= GAUGE_QUALITY_HIGH_SPAN_PP &&
    distinctSteps >= GAUGE_QUALITY_HIGH_STEPS &&
    lagFraction < GAUGE_QUALITY_HIGH_LAG
  ) {
    confidence = "high";
    reason = `pełny przebieg ${span.toFixed(0)} pp, ${distinctSteps} stopni, lag ${(lagFraction * 100).toFixed(1)}%`;
  } else if (
    span >= GAUGE_QUALITY_MEDIUM_SPAN_PP &&
    distinctSteps >= GAUGE_QUALITY_MEDIUM_STEPS &&
    lagFraction < GAUGE_QUALITY_MEDIUM_LAG
  ) {
    confidence = "medium";
    reason = `zakres ${span.toFixed(0)} pp, ${distinctSteps} stopni, lag ${(lagFraction * 100).toFixed(1)}%`;
  } else {
    confidence = "low";
    reason = `zakres ${span.toFixed(0)} pp, ${distinctSteps} stopni, lag ${(lagFraction * 100).toFixed(1)}% — gauge się opóźnia`;
  }
  return {
    accepted: confidence !== "none",
    confidence,
    span_percent: span,
    reason,
  };
}
export function medianOf(xs: number[]): number | null {
  const v = [...xs].sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  if (v.length % 2 === 1) return v[mid] ?? null;
  const lo = v[mid - 1];
  const hi = v[mid];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}
function median(xs: number[]): number | null {
  return medianOf(xs);
}
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
export function computeSeatTime(
  billedUsd: number,
  usdPerMonth: number | null | undefined
): SeatTime | null {
  if (usdPerMonth == null || usdPerMonth <= 0 || !Number.isFinite(billedUsd)) return null;
  const months = billedUsd / usdPerMonth;
  const weeks = months * (DAYS_PER_MONTH / 7);
  return {
    months: round4(months),
    weeks: round4(weeks),
  };
}
function normHome(home: string | null): string {
  return (home || "")
    .split(String.fromCharCode(92))
    .join("/")
    .toLowerCase()
    .replace(/\/+$/, "");
}
export class SubscriptionHomeConflictError extends Error {
  readonly normalizedPath: string;
  readonly existingId: string;
  readonly conflictingId: string;
  constructor(normalizedPath: string, existingId: string, conflictingId: string) {
    super(`conflicting subscription home '${normalizedPath}': already ${existingId}, also ${conflictingId}`);
    this.name = "SubscriptionHomeConflictError";
    this.normalizedPath = normalizedPath;
    this.existingId = existingId;
    this.conflictingId = conflictingId;
  }
}
const sourceHomesByMap = new WeakMap<Map<string, string>, Set<string>>();
const declarationsByMap = new WeakMap<Map<string, string>, readonly import("./archive-source").SourceDeclaration[]>();
export function subscriptionDeclarations(homes:Map<string,string>):readonly import("./archive-source").SourceDeclaration[] {
  return declarationsByMap.get(homes) ?? [];
}
let lastDeclaredSourceHomes = new Set<string>();
let lastDeclarations: readonly import("./archive-source").SourceDeclaration[] = [];
function indexSourceHomes(
  subscriptions: Array<{ source_home?: string | null }>
): Set<string> {
  const sources = new Set<string>();
  for (const s of subscriptions) {
    if (s.source_home) sources.add(normHome(s.source_home));
  }
  return sources;
}
function buildHomeToSubId(
  subscriptions: Array<{ id: string; home?: string | null; source_home?: string | null }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of subscriptions) {
    for (const raw of [s.home, s.source_home]) {
      if (!raw) continue;
      const k = normHome(raw);
      const prev = map.get(k);
      if (prev != null && prev !== s.id) {
        throw new SubscriptionHomeConflictError(k, prev, s.id);
      }
      map.set(k, s.id);
    }
  }
  return map;
}
export function assertSubscriptionHomes(
  subscriptions: Array<{ id: string; home?: string | null; source_home?: string | null }>
): void {
  buildHomeToSubId(subscriptions);
}
export function indexSubscriptionHomes(
  subscriptions: Array<{ id: string; home?: string | null; source_home?: string | null }>,
  declarations: readonly import("./archive-source").SourceDeclaration[] = subscriptions,
): Map<string, string> {
  const map = buildHomeToSubId(subscriptions);
  const sources = indexSourceHomes(subscriptions);
  sourceHomesByMap.set(map, sources);
  declarationsByMap.set(map, declarations);
  lastDeclaredSourceHomes = sources;
  lastDeclarations = declarations;
  return map;
}
/**
 * The home mapping a background producer needs, exactly as the server builds it: only the eras
 * covering `now`, because a home legitimately changes subscription between eras, and empty on a
 * declared conflict, which the server reports instead of failing.
 */
export function currentSubscriptionHomes(
  subscriptions: Array<{ id: string; home?: string | null; source_home?: string | null; from?: string; until?: string }>,
  now: string = new Date().toISOString(),
): Map<string, string> {
  try { return indexSubscriptionHomes(subscriptions.filter(era => eraCovers(era, now)),subscriptions); }
  catch (error) {
    if (!(error instanceof SubscriptionHomeConflictError)) throw error;
    return new Map();
  }
}
export function codexSourceHomes(homes:Map<string,string>):string[] { return [...sourceHomesFor(homes)].sort(); }
/** One physical Codex profile set for both report and background price-register stamps. */
export function codexPhysicalSourceHomes(sources: readonly import("./archive-source").SourceDeclaration[]): string[] {
  return [...new Set(sources.filter(source => (source.vendor ?? "codex").toLowerCase() === "codex" && source.source_home)
    .map(source => normHome(source.source_home!)))].sort();
}
export function restoreSubscriptionHomes(entries:Array<[string,string]>,sources:string[],declarations:readonly import("./archive-source").SourceDeclaration[]=[]):Map<string,string> {
  const homes=new Map(entries); sourceHomesByMap.set(homes,new Set(sources)); declarationsByMap.set(homes,declarations); return homes;
}
function sourceHomesFor(homeToSubId: Map<string, string>): Set<string> {
  return sourceHomesByMap.get(homeToSubId) ?? lastDeclaredSourceHomes;
}
function isLiveCodexHome(home: string | null): boolean {
  return /\/\.codex$/i.test(normHome(home));
}
function isSourceCopy(home: string | null, sources: Set<string>): boolean {
  const k = normHome(home);
  if (sources.has(k)) return true;
  if (sources.size > 0) return false;
  return isLiveCodexHome(home);
}
/** A Codex event's subscription in reports: its period-resolved owner, never the home's current account. */
export function resolveCodexSubId(owner: string | null | undefined): string {
  return owner?.trim() || "codex?";
}
function homesForCapacity(
  homeToSubId: Map<string, string>,
  sourceHomes: Set<string>
): Map<string, string[]> {
  const all = new Map<string, string[]>();
  for (const [home, subId] of homeToSubId.entries()) {
    const list = all.get(subId) ?? [];
    list.push(home);
    all.set(subId, list);
  }
  for (const [subId, homes] of all) {
    const archive = homes.filter((h) => !isSourceCopy(h, sourceHomes));
    if (archive.length > 0) all.set(subId, archive);
  }
  return all;
}
function resolveIndexedHomes(
  sqlite: Database,
  table: "events" | "ratelimit",
  declared: string[]
): string[] {
  const want = new Set(declared.map(normHome));
  try {
    return codexTableHomes(sqlite, table).filter((h) => want.has(normHome(h)));
  } catch {
    return [];
  }
}
export function isCalibrationOverlapping(
  calib: {
    calibration_start_ts: string | null;
    calibration_end_ts: string | null;
    capacity_basis?: CapacityBasis;
  },
  since?: string | null,
  until?: string | null
): boolean {
  if (calib.capacity_basis === "none") return false;
  if (!calib.calibration_start_ts || !calib.calibration_end_ts) return false;
  const cStart = calib.calibration_start_ts.slice(0, 10);
  const cEnd = calib.calibration_end_ts.slice(0, 10);
  const qStart = since ? since.slice(0, 10) : null;
  const qEnd = until ? until.slice(0, 10) : null;
  if (!qStart || !qEnd) return false;
  return cStart <= qStart && cEnd >= qEnd;
}
const COVERAGE_DAY_MS = 86_400_000;
function dayIndex(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}
export function calibrationCoverage(
  calib: {
    calibration_start_ts: string | null;
    calibration_end_ts: string | null;
    capacity_basis?: CapacityBasis;
  },
  since?: string | null,
  until?: string | null
): { kind: CoverageKind; share: number } {
  const none = { kind: "none" as const, share: 0 };
  if (calib.capacity_basis === "none") return none;
  if (!calib.calibration_start_ts || !calib.calibration_end_ts) return none;
  const cStart = dayIndex(calib.calibration_start_ts.slice(0, 10));
  const cEnd = dayIndex(calib.calibration_end_ts.slice(0, 10));
  const qStart = since ? dayIndex(since.slice(0, 10)) : NaN;
  const qEnd = until ? dayIndex(until.slice(0, 10)) : NaN;
  if (![cStart, cEnd, qStart, qEnd].every(Number.isFinite)) return none;
  if (qEnd < qStart || cEnd < cStart) return none;
  const oStart = Math.max(cStart, qStart);
  const oEnd = Math.min(cEnd, qEnd);
  if (oEnd < oStart) return none;
  const rangeDays = Math.round((qEnd - qStart) / COVERAGE_DAY_MS) + 1;
  const overlapDays = Math.round((oEnd - oStart) / COVERAGE_DAY_MS) + 1;
  const share = rangeDays > 0 ? Math.min(1, overlapDays / rangeDays) : 0;
  return cStart <= qStart && cEnd >= qEnd
    ? { kind: "full", share: 1 }
    : { kind: "partial", share: round4(share) };
}
export function computeCapacityFromCycles(cycles: CycleLike[]): {
  usd_per_point: number | null;
  window_value_usd: number | null;
  basis: CapacityBasis;
  start_ts: string | null;
  end_ts: string | null;
} {
  const rated = cycles
    .map((c) => {
      if (c.usedPercent < MIN_PP_FOR_RATE || c.sample_count < MIN_GAUGE_SAMPLES || c.calls < MIN_CALLS) {
        return null;
      }
      const rate =
        c.usd_per_percent != null && Number.isFinite(c.usd_per_percent) && c.usd_per_percent > 0
          ? c.usd_per_percent
          : c.usd > 0
          ? c.usd / c.usedPercent
          : null;
      if (rate == null || !Number.isFinite(rate)) return null;
      return { c, rate };
    })
    .filter((r): r is { c: CycleLike; rate: number } => r != null);
  if (rated.length === 0) {
    return {
      usd_per_point: null,
      window_value_usd: null,
      basis: "none",
      start_ts: null,
      end_ts: null,
    };
  }
  const rates = rated.map((r) => r.rate);
  const med = median(rates);
  const starts = rated.map((r) => r.c.start_ts).filter((ts): ts is string => Boolean(ts)).sort();
  const ends = rated.map((r) => r.c.end_ts).filter((ts): ts is string => Boolean(ts)).sort();
  return {
    usd_per_point: med != null ? round4(med) : null,
    window_value_usd: med != null ? round2(med * 100) : null,
    basis: rated.length > 1 ? "measured" : "single",
    start_ts: starts[0] ?? null,
    end_ts: ends[ends.length - 1] ?? null,
  };
}
export interface HourlyCostIndex {
  at: number[];
  cum: number[];
}
export interface SlidingCapacity {
  usd_per_point: number | null;
  window_value_usd: number | null;
  basis: CapacityBasis;
  start_ts: string | null;
  end_ts: string | null;
  sample_count: number;
}
const EMPTY_SLIDING: SlidingCapacity = {
  usd_per_point: null,
  window_value_usd: null,
  basis: "none",
  start_ts: null,
  end_ts: null,
  sample_count: 0,
};
export function buildHourlyCostIndex(
  buckets: Array<{ hour: string; usd: number }>
): HourlyCostIndex {
  const sorted = [...buckets].sort((a, b) => a.hour.localeCompare(b.hour));
  const at: number[] = [];
  const cum: number[] = [0];
  for (const b of sorted) {
    const ms = Date.parse(`${b.hour}:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    at.push(ms);
    cum.push(cum[cum.length - 1]! + b.usd);
  }
  return { at, cum };
}
export function spentBetween(index: HourlyCostIndex, from: number, to: number): number {
  const upper = (ms: number): number => {
    let lo = 0;
    let hi = index.at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (index.at[mid]! < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (index.cum[upper(to)] ?? 0) - (index.cum[upper(from)] ?? 0);
}
export function measureSlidingWindowCapacity(
  cost: HourlyCostIndex,
  samples: Array<{ ts: string; used_percent: number }>,
  windowHours: number,
  period?: { since?: string | null; until?: string | null }
): SlidingCapacity {
  const firstMs = cost.at[0];
  if (firstMs == null || !(windowHours > 0)) return EMPTY_SLIDING;
  const spanMs = windowHours * 3_600_000;
  const rates: number[] = [];
  let firstUsed: string | null = null;
  let lastUsed: string | null = null;
  for (const s of samples) {
    if (!sampleDayInPeriod(s.ts, period)) continue;
    if (!(s.used_percent >= MIN_PP_FOR_RATE)) continue;
    const ms = Date.parse(s.ts);
    if (!Number.isFinite(ms)) continue;
    const from = ms - spanMs;
    if (from < firstMs) continue;
    const usd = spentBetween(cost, from, ms);
    if (!(usd > 0)) continue;
    rates.push(usd / s.used_percent);
    if (firstUsed == null || s.ts < firstUsed) firstUsed = s.ts;
    if (lastUsed == null || s.ts > lastUsed) lastUsed = s.ts;
  }
  if (rates.length === 0) return EMPTY_SLIDING;
  const med = median(rates);
  if (med == null || !(med > 0)) return EMPTY_SLIDING;
  const spread =
    firstUsed != null && lastUsed != null
      ? Date.parse(lastUsed) - Date.parse(firstUsed) >= spanMs
      : false;
  const basis: CapacityBasis = rates.length >= MIN_GAUGE_SAMPLES && spread ? "measured" : "single";
  return {
    usd_per_point: round4(med),
    window_value_usd: round2(med * 100),
    basis,
    start_ts: firstUsed,
    end_ts: lastUsed,
    sample_count: rates.length,
  };
}
function sampleDayInPeriod(
  ts: string,
  period?: { since?: string | null; until?: string | null }
): boolean {
  if (!period) return true;
  const day = ts.slice(0, 10);
  const since = period.since ? period.since.slice(0, 10) : "";
  const until = period.until ? period.until.slice(0, 10) : "";
  if (since && day < since) return false;
  if (until && day > until) return false;
  return true;
}
function periodHasBound(period?: { since?: string | null; until?: string | null }): boolean {
  return Boolean(period && (period.since || period.until));
}
export function measureSlidingWindowForPeriod(
  cost: HourlyCostIndex,
  samples: Array<{ ts: string; used_percent: number }>,
  windowHours: number,
  period?: { since?: string | null; until?: string | null }
): SlidingCapacity & { note: string } {
  const scoped = periodHasBound(period)
    ? measureSlidingWindowCapacity(cost, samples, windowHours, period)
    : null;
  if (scoped && scoped.basis !== "none" && scoped.sample_count >= MIN_GAUGE_SAMPLES) {
    return {
      ...scoped,
      note: `okno przesuwne: mediana z ${scoped.sample_count} odczytów licznika w wybranym okresie (wydatek z ostatnich 168 h wobec procentu)`,
    };
  }
  const all = measureSlidingWindowCapacity(cost, samples, windowHours);
  const note = scoped
    ? `okno przesuwne: mediana z ${all.sample_count} odczytów licznika z całej historii, bo w wybranym okresie za mało próbek (wydatek z ostatnich 168 h wobec procentu)`
    : `okno przesuwne: mediana z ${all.sample_count} odczytów licznika (wydatek z ostatnich 168 h wobec procentu)`;
  return { ...all, note };
}
function makeProvenance(
  capacity: SubscriptionCapacity | null | undefined,
  coverage: { kind: CoverageKind; share: number }
): Provenance {
  return {
    capacity: capacity?.capacity_basis ?? "none",
    price: capacity?.price_basis ?? "none",
    cadence: capacity?.cadence ?? "none",
    calibration_covers_period: coverage.kind === "full",
    coverage: coverage.kind,
    measured_share: coverage.share,
  };
}
function equivalent(value: number, absent?: null): Equivalent;
function equivalent(value: null, absent: EquivalentAbsentReason): Equivalent;
function equivalent(value: number | null, absent: EquivalentAbsentReason | null = null): Equivalent {
  return value == null ? { value: null, absent: absent ?? "no_capacity" } : { value, absent: null };
}
function bothAbsent(reason: EquivalentAbsentReason): CapacityEquivalents {
  return {
    full_5h_sessions: equivalent(null, reason),
    weekly_cycles: equivalent(null, reason),
    monthly_subscriptions: equivalent(null, reason),
  };
}
const DEFAULT_WINDOW_HOURS = 168;
function windowsPerMonth(capacity: SubscriptionCapacity): number {
  const hours = capacity.window_hours != null && capacity.window_hours > 0
    ? capacity.window_hours
    : DEFAULT_WINDOW_HOURS;
  return (DAYS_PER_MONTH * 24) / hours;
}
export function computeEquivalentsAndProvenance(
  apiUsd: number,
  capacity: SubscriptionCapacity | null | undefined,
  period: { since?: string | null; until?: string | null },
  normalizedUsd?: number | null
): {
  equivalents: CapacityEquivalents;
  provenance: Provenance;
} {
  if (!capacity || capacity.capacity_basis === "none") {
    return {
      equivalents: bothAbsent("no_capacity"),
      provenance: makeProvenance(capacity, { kind: "none", share: 0 }),
    };
  }
  if (capacity.value_basis === "standard_normalized") apiUsd = normalizedUsd ?? NaN;
  const coverage = calibrationCoverage(
    {
      calibration_start_ts: capacity.calibration_start_ts,
      calibration_end_ts: capacity.calibration_end_ts,
      capacity_basis: capacity.capacity_basis,
    },
    period.since,
    period.until
  );
  const provenance = makeProvenance(capacity, coverage);
  if (coverage.kind === "none") {
    return { equivalents: bothAbsent("period_uncovered"), provenance };
  }
  if (!Number.isFinite(apiUsd) || apiUsd < 0) {
    return { equivalents: bothAbsent("invalid_usage"), provenance };
  }
  const weekly =
    capacity.weekly_window_value_usd != null && capacity.weekly_window_value_usd > 0
      ? equivalent(round4(apiUsd / capacity.weekly_window_value_usd))
      : equivalent(null, "cadence_uncalibrated");
  const sessions =
    capacity.session_window_value_usd != null && capacity.session_window_value_usd > 0
      ? equivalent(round4(apiUsd / capacity.session_window_value_usd))
      : equivalent(null, "cadence_uncalibrated");
  const perMonth = windowsPerMonth(capacity);
  const monthly =
    capacity.capacity_scope === "code_calibrated_account_equivalent" ? equivalent(null, "cadence_uncalibrated") :
    weekly.absent == null && perMonth > 0
      ? equivalent(round4(weekly.value / perMonth))
      : equivalent(null, weekly.absent ?? "cadence_uncalibrated");
  return {
    equivalents: {
      full_5h_sessions: sessions,
      weekly_cycles: weekly,
      monthly_subscriptions: monthly,
    },
    provenance,
  };
}
const CAPACITY_MEMO_SLOTS = 8;
const codexCapacityMemo = new WeakMap<Database, WeakMap<RateCard, Map<string, Map<string, SubscriptionCapacity>>>>();
function indexStamp(sqlite: Database): string {
  try {
    const row = sqlite.query(`PRAGMA data_version`).get() as { data_version?: number } | null;
    return String(row?.data_version ?? 0);
  } catch {
    return "0";
  }
}
function periodStamp(period?: { since?: string | null; until?: string | null }): string {
  if (!periodHasBound(period)) return "";
  return `|p:${period?.since ?? ""}:${period?.until ?? ""}`;
}
export function resolveCodexCapacities(
  sqlite: Database,
  rateCards: RateCard,
  homeToSubId: Map<string, string>,
  subConfigs: Record<string, { usd_per_month?: number | null }>,
  customCycles?: Record<string, CycleLike[]>,
  period?: { since?: string | null; until?: string | null },
  /** Accounts the caller will actually read. Omitted keeps every configured account. */
  selected?: ReadonlySet<string>
  , calibrationRange?: { from:string; until:string }
): Map<string, SubscriptionCapacity> {
  const priceOnlyConfigs: Record<string, { usd_per_month: number | null }> = {};
  for (const [subId, cfg] of Object.entries(subConfigs)) {
    priceOnlyConfigs[subId] = { usd_per_month: cfg.usd_per_month ?? null };
  }
  const sourceHomes = sourceHomesFor(homeToSubId);
  const subHomes = homesForCapacity(homeToSubId, sourceHomes);
  const readsNative = (!period || periodHasBound(period)) && Object.keys(priceOnlyConfigs).some(subId =>
    (subId.startsWith("codex") || subHomes.has(subId)) && (!selected || selected.has(subId.toLowerCase()))
    && !customCycles?.[subId]);
  let nativePending: string | null = null, nativeDependency: unknown = null;
  if (readsNative) {
    const until = period?.until?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const requestedSince = period?.since?.slice(0, 10) ?? new Date(Date.parse(until) - 30 * 86400000).toISOString().slice(0, 10);
    const earliestRate = resolveCodexAccountingConfig(rateCards).rules.map(rule => rule.valid_from).sort()[0];
    const since = earliestRate && earliestRate > requestedSince && earliestRate <= until ? earliestRate : requestedSince;
    const range = {fromMs:Date.parse(since)-7*86400000,toMs:Date.parse(until)+8*86400000};
    const ledger = codexLedgerReadContext(rateCards);
    nativePending = codexLedgerPendingReason(sqlite,{...ledger,range});
    if (!nativePending) nativeDependency = [codexLedgerReadStamp(sqlite,ledger,range),
      codexPeriodsStamp(loadAccountResolver(sqlite,subscriptionDeclarations(homeToSubId)),
        {from:new Date(range.fromMs).toISOString(),until:new Date(range.toMs).toISOString()})];
  }
  // The durable producer has already selected changed native dependencies. A second memo
  // cannot reuse a model after its meter/sums change without a ledger or ownership revision.
  const memoKey = customCycles || calibrationRange
    ? null
    : `${indexStamp(sqlite)}|${JSON.stringify(priceOnlyConfigs)}|${Array.from(homeToSubId.keys()).sort().join(",")}${periodStamp(period)}` +
      `|native:${JSON.stringify(nativeDependency)}|range:${JSON.stringify(calibrationRange)}` +
      (selected ? `|s:${[...selected].sort().join(",")}` : "");
  if (memoKey != null && !nativePending) {
    const hit = codexCapacityMemo.get(sqlite)?.get(rateCards)?.get(memoKey);
    if (hit) return hit;
  }
  const result = new Map<string, SubscriptionCapacity>();
  const blank = (subId: string, monthly: number | null, note: string): SubscriptionCapacity => ({
    sub_id: subId,
    vendor: "codex",
    plan: null,
    usd_per_month: monthly,
    usd_per_point: null,
    weekly_window_value_usd: null,
    session_window_value_usd: null,
    window_hours: null,
    session_hours: null,
    capacity_basis: "none",
    price_basis: monthly != null ? "rate-card" : "none",
    cadence: "declared",
    calibration_start_ts: null,
    calibration_end_ts: null,
    note,
  });
  for (const [subId, cfg] of Object.entries(priceOnlyConfigs)) {
    if (!subId.startsWith("codex") && !subHomes.has(subId)) continue;
    if (selected && !selected.has(subId.toLowerCase())) continue;
    const monthly = cfg.usd_per_month ?? null;
    if (customCycles && customCycles[subId]) {
      const cap = computeCapacityFromCycles(customCycles[subId]!);
      result.set(subId, {
        sub_id: subId,
        vendor: "codex",
        plan: null,
        usd_per_month: monthly,
        usd_per_point: cap.usd_per_point,
        weekly_window_value_usd: cap.window_value_usd,
        session_window_value_usd: null,
        window_hours: cap.basis !== "none" ? 168 : null,
        session_hours: null,
        capacity_basis: cap.basis,
        price_basis: monthly != null ? "rate-card" : "none",
        cadence: "declared",
        calibration_start_ts: cap.start_ts,
        calibration_end_ts: cap.end_ts,
        note:
          cap.basis === "measured"
            ? "mediana z zamkniętych okien gauge"
            : cap.basis === "single"
            ? "jedno okno w indeksie"
            : "brak zamkniętego okna powyżej progu",
      });
      continue;
    }
    try {
      // A period with no boundary at all describes no measurement interval: that is unknown,
      // not today, and not a licence to scan a month of history so that a report which
      // selected nothing can publish zeros. An open range that does declare a start still
      // reaches the present, exactly as before.
      if (period && !periodHasBound(period)) {
        result.set(subId, blank(subId, monthly, "nieznany zakres pomiaru: okres bez granic"));
        continue;
      }
      const until = period?.until?.slice(0, 10) || new Date().toISOString().slice(0, 10);
      const requestedSince = period?.since?.slice(0, 10) ?? new Date(Date.parse(until) - 30 * 86400000).toISOString().slice(0, 10);
      const earliestRate = resolveCodexAccountingConfig(rateCards).rules.map(r => r.valid_from).sort()[0];
      const since = earliestRate && earliestRate > requestedSince && earliestRate <= until ? earliestRate : requestedSince;
      // The account's weekly calibration only; the rest of the accounting report is not needed here.
      const models = codexWindowCalibrationModels(sqlite, rateCards, { since, until, account: subId, calibrationRange }, homeToSubId);
      const model = models.filter(m => m.window_minutes === 10080)
        .sort((a, b) => b.end_ts.localeCompare(a.end_ts))[0];
      const session = codexWindowCalibrationModels(sqlite,rateCards,{since,until,account:subId,windowMinutes:300,calibrationRange},homeToSubId)
        .sort((a,b)=>b.end_ts.localeCompare(a.end_ts))[0];
      const sessionValue=session?.standard_normalized_usd_per_1pct;
      const measured = model?.status === "validated";
      const value = model?.standard_normalized_usd_per_1pct ?? null;
      result.set(subId, {
        sub_id: subId, vendor: "codex", value_basis: "standard_normalized", plan: model?.plan ?? null, usd_per_month: monthly,
        usd_per_point: value, weekly_window_value_usd: value == null ? null : value * 100,
        session_window_value_usd: sessionValue==null?null:sessionValue*100, window_hours: value == null ? null : 168, session_hours: sessionValue==null?null:5,
        capacity_basis: value == null ? "none" : measured ? "measured" : "single",
        price_basis: monthly != null ? "rate-card" : "none", cadence: "probe",
        calibration_start_ts: model?.start_ts ?? null, calibration_end_ts: model?.end_ts ?? null,
        note: value == null ? "brak pełnych próbek Speed/Standard pomiędzy odczytami limitu"
          : `USD w ekwiwalencie Standard, ważone mnożnikiem limitu Speed; ${measured ? "sprawdzone na osobnym oknie" : "kalibracja robocza"}; kompletność maszyn niepotwierdzona`,
      });
    } catch (e) {
      result.set(subId, blank(subId, monthly, "błąd podczas analizy okien: " + String(e)));
    }
  }
  if (memoKey != null && !nativePending) {
    let byCard = codexCapacityMemo.get(sqlite);
    if (!byCard) { byCard = new WeakMap(); codexCapacityMemo.set(sqlite,byCard); }
    let slots = byCard.get(rateCards);
    if (!slots) {
      slots = new Map();
      byCard.set(rateCards, slots);
    }
    const stamp = memoKey.slice(0, memoKey.indexOf("|"));
    for (const key of slots.keys()) {
      if (!key.startsWith(`${stamp}|`)) slots.delete(key);
    }
    slots.set(memoKey, result);
    while (slots.size > CAPACITY_MEMO_SLOTS) {
      const oldest = slots.keys().next().value;
      if (oldest === undefined) break;
      slots.delete(oldest);
    }
  }
  return result;
}
/**
 * The Claude Code estimate's context for one account: one read of its readings serves both the limit samples (with accepted
 * refusals, as `loadProbeLimitEvidence` gives them) and the observations. Without a prepared index the estimate reads as before.
 */
function claudeCodeContext(sqlite: Database, rateCards: RateCard, account: string, eras: EraIndex | undefined,
  declarations: ReturnType<typeof subscriptionDeclarations>): ClaudeCodeCapacityContext {
  const readings = readPreparedProbeAccountReadings(sqlite, "claude", account);
  if (!readings) return { rateCards, eras, declarations };
  const resolver = loadAccountResolver(sqlite, declarations);
  return { rateCards, eras, declarations, resolver, probeReadings: readings,
    probeEvidence: probeLimitEvidenceOf(sqlite, "claude", account, resolver, readings.rows) };
}
/** Existing non-Claude/Codex calibration is independent of the monthly plan price. */
function otherProviderCapacities(sqlite: Database, rateCards: RateCard,
  opts: { grokGauge?: GrokGaugeConfig; rootDir?: string } | undefined, wanted: (...ids: string[]) => boolean): Map<string, SubscriptionCapacity> {
  const capacities = new Map<string, SubscriptionCapacity>();
  const subConfigs = rateCards.subscriptions || {};
  const grokGauge = opts?.grokGauge ?? loadGrokGauge(opts?.rootDir);
  if (grokGauge && wanted(grokGauge.store || grokGauge.subscription || "grok")) {
    const subId = grokGauge.store || grokGauge.subscription || "grok";
    const cfg = subConfigs[subId] || subConfigs["grok"] || {};
    // Saved observations and the declared/anchored window only. The live probe decides the
    // CURRENT window on the limit card; whether it is still active cannot move the window a
    // historical reading was taken over, and its expiry cannot erase this calibration.
    const measured = storedGrokCalibration(sqlite, grokGauge);
    const usdPerPt = measured.calibration?.usd_per_point ?? null;
    const winVal =
      measured.calibration?.window_value_usd ?? (usdPerPt != null ? usdPerPt * 100 : null);
    const obs = measured.observations;
    const starts = obs.map((o) => o.window_start).filter((ts): ts is string => Boolean(ts)).sort();
    const ends = obs.map((o) => o.ts).filter((ts): ts is string => Boolean(ts)).sort();
    capacities.set(subId, {
      sub_id: subId,
      vendor: "grok",
      plan: null,
      usd_per_month: cfg.usd_per_month ?? null,
      usd_per_point: usdPerPt != null ? round4(usdPerPt) : null,
      weekly_window_value_usd: winVal != null ? round2(winVal) : null,
      session_window_value_usd: null,
      window_hours: measured.window_hours,
      session_hours: null,
      capacity_basis: usdPerPt != null ? "single" : "none",
      price_basis: cfg.usd_per_month != null ? "rate-card" : "none",
      cadence: "declared",
      calibration_start_ts: starts[0] ?? null,
      calibration_end_ts: ends[ends.length - 1] ?? null,
      note: "skala z grok-gauge.json (wycena vendor ticks)",
    });
  }
  try {
    // Each saved percentage is divided by the spending of its own window up to its own
    // timestamp, so neither later traffic nor the minute of this read enters the scale.
    const glmReport = wanted("glm", "opencode")
      ? buildGlmCalibration(sqlite)
      : null;
    if (glmReport) {
      const subId = glmReport.subscription || "opencode";
      const cfg = subConfigs[subId] || subConfigs["opencode"] || subConfigs["glm"] || {};
      const weeklyWin = glmReport.windows.find((w) => w.window_hours === 168 || w.kind === "weekly");
      const sessionWin = glmReport.windows.find(
        (w) => w.window_hours === 5 || w.kind === "session" || w.kind === "five_hour"
      );
      const weeklyRate =
        weeklyWin?.spend_usd != null && weeklyWin.percent >= MIN_PP_FOR_RATE
          ? weeklyWin.spend_usd / weeklyWin.percent
          : null;
      const sessionRate =
        sessionWin?.spend_usd != null && sessionWin.percent >= MIN_PP_FOR_RATE
          ? sessionWin.spend_usd / sessionWin.percent
          : null;
      const weeklyWinVal = weeklyRate != null ? weeklyRate * 100 : null;
      const sessionWinVal = sessionRate != null ? sessionRate * 100 : null;
      const rate = weeklyRate ?? sessionRate;
      // Window kinds carry separate samples, so the capacity is stamped with the reading
      // times of the windows it actually used - never with a newer sample of another counter.
      const usedAt = [
        weeklyRate != null ? weeklyWin?.measured_at : null,
        sessionRate != null ? sessionWin?.measured_at : null,
      ].filter((ts): ts is string => typeof ts === "string" && ts !== "").sort();
      const cap: SubscriptionCapacity = {
        sub_id: subId,
        vendor: "opencode",
        plan: null,
        usd_per_month: cfg.usd_per_month ?? null,
        usd_per_point: rate != null ? round4(rate) : null,
        weekly_window_value_usd: weeklyWinVal != null ? round2(weeklyWinVal) : null,
        session_window_value_usd: sessionWinVal != null ? round2(sessionWinVal) : null,
        window_hours: weeklyWinVal != null ? 168 : null,
        session_hours: sessionWinVal != null ? 5 : null,
        capacity_basis: rate != null ? "single" : "none",
        price_basis: "rate-card",
        cadence: "probe",
        calibration_start_ts: usedAt[0] ?? glmReport.measured_at ?? null,
        calibration_end_ts: usedAt[usedAt.length - 1] ?? glmReport.measured_at ?? null,
        note: "odczyt z konta z.ai",
      };
      for (const alias of new Set([subId, "opencode", "glm"])) {
        if (wanted(alias)) capacities.set(alias, cap);
      }
    }
  } catch {
  }
  return capacities;
}
function appendPriceOnlyCapacities(capacities: Map<string, SubscriptionCapacity>,
  subConfigs: NonNullable<RateCard['subscriptions']>, wanted: (...ids: string[]) => boolean): void {
  for (const [subId, cfg] of Object.entries(subConfigs)) {
    if (!wanted(subId) || capacities.has(subId)) continue;
    capacities.set(subId, {
      sub_id: subId,
      vendor: subId,
      plan: null,
      usd_per_month: cfg.usd_per_month ?? null,
      usd_per_point: null,
      weekly_window_value_usd: null,
      session_window_value_usd: null,
      window_hours: null,
      session_hours: null,
      capacity_basis: "none",
      price_basis: cfg.usd_per_month != null ? "rate-card" : "none",
      cadence: "none",
      calibration_start_ts: null,
      calibration_end_ts: null,
    });
  }
  if (wanted("gemini") && !capacities.has("gemini")) {
    capacities.set("gemini", {
      sub_id: "gemini",
      vendor: "gemini",
      plan: null,
      usd_per_month: null,
      usd_per_point: null,
      weekly_window_value_usd: null,
      session_window_value_usd: null,
      window_hours: null,
      session_hours: null,
      capacity_basis: "none",
      price_basis: "none",
      cadence: "probe",
      calibration_start_ts: null,
      calibration_end_ts: null,
      note: "Antigravity brak cennika API",
    });
  }
}
export function buildSubscriptionCapacities(
  sqlite: Database,
  rateCards: RateCard,
  homeToSubId: Map<string, string>,
  opts?: {
    claudeGauge?: ClaudeGaugeConfig;
    grokGauge?: GrokGaugeConfig;
    codexCycles?: Record<string, CycleLike[]>;
    rootDir?: string;
    period?: { since?: string | null; until?: string | null };
    /** Account mapping used by the shared Claude Code estimate. */
    eras?: EraIndex;
    /** Verified accounts whose project traffic is being compared. An empty list selects none. */
    claudeAccounts?: readonly string[];
    /**
     * Exact subscription ids to return. Omitted - the default for every existing
     * caller - measures every vendor as before. A report that already knows which accounts it
     * accepted passes them here, so no unrelated vendor is measured only to be discarded, and
     * an empty selection measures nothing at all.
     */
    subscriptions?: readonly string[];
    /** Only the background producer may call the existing provider algorithms. */
    fromStored?: boolean;
    calibrationRange?: { from:string; until:string };
  }
): Map<string, SubscriptionCapacity> {
  const capacities = new Map<string, SubscriptionCapacity>();
  // Empty selection must not read gauges, calibration or even the stored register.
  if (opts?.subscriptions?.length === 0) return capacities;
  const selected = opts?.subscriptions == null ? null : new Set(opts.subscriptions.map(id => id.toLowerCase()));
  const wanted = (...ids: string[]): boolean => selected == null || ids.some(id => selected.has(id.toLowerCase()));
  if (opts?.fromStored !== false && hasSubscriptionCapacity(sqlite)) {
    const verifiedClaude=opts?.claudeAccounts===undefined?null:new Set(opts.claudeAccounts.map(claudeAccountId).filter((id):id is string=>id!==null).map(id=>id.toLowerCase()));
    const supported = sqlite.query("SELECT key,value FROM subscription_capacity_state WHERE key LIKE 'account:%'").all() as Array<{key:string;value:string}>;
    const names = new Map(supported.map(row=>[row.key.slice(8),row.value]));
    if (tableExists(sqlite,"limit_windows")) for (const row of sqlite.query("SELECT DISTINCT provider,account FROM limit_windows WHERE provider IN ('claude','codex')").all() as Array<{provider:string;account:string}>) names.set(row.account,row.provider);
    for (const id of opts?.claudeAccounts ?? []) {const account=claudeAccountId(id);if(account)names.set(account.toLowerCase(),"claude");}
    const gaugeAccount = claudeAccountId(opts?.claudeGauge?.subscription)?.toLowerCase();
    if (gaugeAccount && !names.has(gaugeAccount)) names.set(gaugeAccount, 'claude');
    const declarations = subscriptionDeclarations(homeToSubId);
    for (const [home, id] of homeToSubId) {
      const declaration = declarations.find(source => [source.home, source.source_home].some(path => path && normHome(path) === normHome(home)));
      const inferredVendor = declaration?.vendor ?? archiveFolderOf(home, ARCHIVE_LOGICAL_ROOT)?.provider ?? (isLiveCodexHome(home) ? 'codex' : null);
      const vendor = inferredVendor?.trim() ? normEraVendor(inferredVendor) : null;
      if ((vendor === 'codex' || vendor === 'claude') && !names.has(id.toLowerCase())) names.set(id.toLowerCase(), vendor);
    }
    const resolver = loadAccountResolver(sqlite, declarations);
    for (const vendor of ['claude', 'codex']) for (const id of resolver.accounts(vendor)) if (!names.has(id)) names.set(id, vendor);
    for (const id of Object.keys(opts?.codexCycles ?? {})) if (!names.has(id.toLowerCase())) names.set(id.toLowerCase(), 'codex');
    for (const id of Object.keys(rateCards.subscriptions ?? {})) if (id.startsWith("codex")) names.set(id,"codex");
    for (const [id,vendor] of names) {
      if(vendor==='claude'&&(!claudeAccountId(id)||verifiedClaude!==null&&!verifiedClaude.has(id.toLowerCase())))continue;
      if (!wanted(id)) continue;
      const stored = opts?.period && !periodHasBound(opts.period) ? null : storedCapacityForPeriod(sqlite, id, opts?.period);
      capacities.set(id, stored?.capacity ?? { sub_id:id, vendor, plan:null, usd_per_month:rateCards.subscriptions?.[id]?.usd_per_month ?? null,
        usd_per_point:null,weekly_window_value_usd:null,session_window_value_usd:null,window_hours:null,session_hours:null,
        capacity_basis:"none",price_basis:"none",cadence:"none",calibration_start_ts:null,calibration_end_ts:null,note:"capacity preparing" });
    }
    // This helper cannot invoke Claude/Codex calibration, even before durable publication.
    const otherWanted = (...ids: string[]) => ids.some(id => wanted(id) && !names.has(id.toLowerCase()) && id.toLowerCase() !== 'claude');
    for (const [id, value] of otherProviderCapacities(sqlite, rateCards, opts, otherWanted)) if (otherWanted(id)) capacities.set(id, value);
    const otherConfigs = Object.fromEntries(Object.entries(rateCards.subscriptions ?? {}).filter(([id]) => otherWanted(id)));
    appendPriceOnlyCapacities(capacities, otherConfigs, otherWanted);
    return capacities;
  }
  const subConfigs = rateCards.subscriptions || {};
  const claudeGauge = opts?.claudeGauge ?? loadClaudeGauge(opts?.rootDir);
  const projectAccounts = opts?.claudeAccounts;
  const configuredAccount = claudeAccountId(claudeGauge.subscription)?.toLowerCase() ?? null;
  const allClaudeAccounts = projectAccounts === undefined
    ? configuredAccount ? [configuredAccount] : []
    : [...new Set(projectAccounts.map(claudeAccountId).filter((account): account is string => account !== null).map(account => account.toLowerCase()))];
  const claudeAccounts = allClaudeAccounts.filter((account) => wanted(account));
  const untilDay = opts?.period?.until;
  const untilExclusive = opts?.calibrationRange?.until ?? (untilDay && /^\d{4}-\d{2}-\d{2}$/.test(untilDay)
    ? new Date(Date.parse(untilDay) + 86_400_000).toISOString() : undefined);
  for (const subId of claudeAccounts) {
    const cfg = subConfigs[subId] || {};
    const sharedForPeriod = projectAccounts === undefined ? null : claudeCodeCapacitySummaryOrAbsent(sqlite, subId,
      claudeCodeContext(sqlite, rateCards, subId, opts?.eras, subscriptionDeclarations(homeToSubId)), { since: opts?.period?.since ?? undefined,
        until: untilExclusive ? undefined : untilDay ?? undefined, untilExclusive });
    // Only the original account can use its explicit manual observations.
    const needsLegacyReport = subId === configuredAccount && (projectAccounts === undefined
      || sharedForPeriod?.weekly_capacity_api_usd.value == null && !!claudeGauge.observations?.length);
    const report = needsLegacyReport ? buildClaudeLimit(sqlite, { ...claudeGauge, subscription: subId }, (m, d, s) =>
      getClaudeRate(rateCards, m, d, s), undefined, { rateCards, eras: opts?.eras, declarations:subscriptionDeclarations(homeToSubId) }
    ) : null;
    const shared = projectAccounts === undefined ? report?.claude_code_capacity : sharedForPeriod;
    const windowHours = projectAccounts === undefined ? report?.window_hours ?? 168 : 168;
    const periodResult = projectAccounts === undefined ? undefined : shared ? readClaudeCapacityResult(sqlite, shared) : undefined;
    const result = periodResult?.capacity_api_usd.value != null ? periodResult : report?.claude_capacity ?? periodResult;
    const standard = result?.api_value_basis === "standard";
    const applicable = windowHours === 168 || result?.basis === "manual";
    const usdPerPt = applicable && result ? claudeCapacityPerPoint(result, "api_standard") : null;
    const winVal = applicable ? result?.capacity_api_usd.value ?? null : null;
    const manual = result?.basis === "manual";
    // The weekly product share is not evidence for a five-hour allowance.
    const sessionWinVal = null;
    const sessionHours = null;
    capacities.set(subId, {
      sub_id: subId,
      vendor: "claude",
      ...(result ? { claude_capacity: result } : {}),
      // Actual/Fast spending cannot be divided by a Standard capacity.
      value_basis: standard ? "standard_normalized" : undefined,
      plan: null,
      usd_per_month: cfg.usd_per_month ?? null,
      usd_per_point: usdPerPt,
      weekly_window_value_usd: winVal,
      session_window_value_usd: sessionWinVal,
      window_hours: windowHours,
      session_hours: sessionHours,
      capacity_basis: usdPerPt != null ? "single" : "none",
      price_basis: cfg.usd_per_month != null ? "rate-card" : "none",
      cadence: "declared",
      calibration_start_ts: result?.sample?.from ?? null,
      calibration_end_ts: result?.sample?.through ?? null,
      note: result?.basis === "code_share"
        ? "szacunek warunkowy z udziału Claude Code w tygodniowym liczniku konta"
        : manual ? "jawna ręczna kalibracja lokalnego ruchu z claude-gauge.json" : "brak wspólnego szacunku pojemności Claude",
      capacity_scope: result?.basis === "code_share" ? "code_calibrated_account_equivalent" : "observed_partial_traffic",
      capacity_conditional: true,
      capacity_reason: result?.capacity_api_usd.absent ?? result?.reason ?? null,
    });
  }
  for (const [id, cap] of otherProviderCapacities(sqlite, rateCards, opts, wanted)) capacities.set(id, cap);
  const priceOnlySubConfigs: Record<string, { usd_per_month?: number | null }> = {};
  for (const [id, cfg] of Object.entries(subConfigs)) {
    priceOnlySubConfigs[id] = { usd_per_month: cfg.usd_per_month ?? null };
  }
  const codexResolved = resolveCodexCapacities(
    sqlite,
    rateCards,
    homeToSubId,
    priceOnlySubConfigs,
    opts?.codexCycles,
    opts?.period,
    new Set(Object.keys(priceOnlySubConfigs).filter(id => wanted(id) && !capacities.has(id))),
    opts?.calibrationRange
  );
  for (const [subId, cap] of codexResolved.entries()) {
    if (wanted(subId)) capacities.set(subId, cap);
  }
  appendPriceOnlyCapacities(capacities, subConfigs, wanted);
  return capacities;
}
/**
 * The rate-card monthly price a subscription's plan cost falls back to where no plan period names a plan: the
 * same `usd_per_month` `buildSubscriptionCapacities` gives it, without measuring any capacity. The subscription's
 * own rate-card entry decides; without one, the Grok gauge's account takes the `grok` entry and the GLM account
 * (`glm`/`opencode`, when its calibration exists) the `glm`/`opencode` entry, as their capacity rows do.
 */
export function rateCardMonthlyOf(sqlite: Database, rateCards: RateCard, subId: string,
  opts: { grokGauge?: GrokGaugeConfig | null; rootDir?: string } = {}): number | null {
  const subConfigs = rateCards.subscriptions || {};
  const own = subConfigs[subId];
  if (own) return own.usd_per_month ?? null;
  // The GLM row is written after the Grok one, so it wins for the same id.
  if (subId === "glm" || subId === "opencode") {
    try {
      const glm = buildGlmCalibration(sqlite);
      if (glm) {
        const cfg = subConfigs[glm.subscription || "opencode"] || subConfigs["opencode"] || subConfigs["glm"] || {};
        return cfg.usd_per_month ?? null;
      }
    } catch {
    }
  }
  const grokGauge = opts.grokGauge === undefined ? loadGrokGauge(opts.rootDir) : opts.grokGauge;
  if (grokGauge && subId === (grokGauge.store || grokGauge.subscription || "grok")) return subConfigs["grok"]?.usd_per_month ?? null;
  return null;
}
