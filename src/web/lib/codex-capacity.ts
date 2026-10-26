import type { CodexComparisonWindow as Window, WindowUsage } from "../../shared/codex-accounting";
import { claudeShareNeverReported } from "../../shared/claude-code-capacity";
import { claudeCodeCapacityForWindow, claudeCapacityPerPoint } from "../../shared/claude-capacity-result";
export { claudeCodeCapacityForWindow } from "../../shared/claude-capacity-result";
import type { CapacityBasis } from "../../shared/codex-promotions";
import { assessWindowQuality, type WindowQuality } from "../../shared/subscription-quality";
import type { MedianConfidence, MedianSample } from "./canonical-median";
import { compact } from "./format";
import { translate } from "./i18n";
import { isNoPlan } from "../../shared/period-end";
import { noPlanLabel, planText } from "./no-plan";
import { formatPlanLabel } from "../../shared/plan-label";

export const DEFAULT_MIN_OBSERVED_PERCENT = 10;

/** Keep the presentation filter inside the valid meter percentage range. */
export function normalizeCapacityMinObservedPercent(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.min(100, Math.max(0, parsed))
    : DEFAULT_MIN_OBSERVED_PERCENT;
}

/** Filter reset-cycle rows by the account meter increase observed in the row. */
export function filterCapacityWindows(windows: Window[], minObservedPercent = DEFAULT_MIN_OBSERVED_PERCENT): Window[] {
  const minimum = normalizeCapacityMinObservedPercent(minObservedPercent);
  return windows.filter(window => Number.isFinite(window.observed_pp) && window.observed_pp >= minimum);
}

/**
 * False when no dated plan period covers the cycle: the server then sends no plan, or a plan
 * detail labelled "?". This is a gap in the declarations, not evidence of another plan.
 */
export function capacityPlanEstablished(window: Window): boolean {
  const detail = window.plan_detail;
  if (!detail) return window.plan !== null;
  return !(detail.status === "unknown" && (!detail.label.trim() || detail.label.trim() === "?"));
}

export function capacityPlanLabel(window: Window): string {
  const detail = window.plan_detail;
  if (!capacityPlanEstablished(window)) return translate("Plan not established", "Plan nieustalony");
  // A declared "no subscription" carries no limits: named, never given a tier.
  if (isNoPlan(window.plan)) return noPlanLabel();
  if (!detail) return window.plan ?? "";
  if (detail.status === "mixed") return `${planText(detail.label)} · ${translate("plan change", "zmiana planu")}`;
  const label = formatPlanLabel(detail.label, detail.multiplier);
  return detail.multiplier !== null || detail.status === "resolved" ? label : `${label} · ${translate("tier unknown", "wariant nieustalony")}`;
}

/** Plan colours identify the plan tier; without a known tier the plan is drawn in neutral grey. */
export function capacityPlanColor(window: Window): string {
  return capacityTierColor(window.plan_detail?.multiplier);
}

export function capacityTierColor(tier: number | null | undefined): string {
  return tier === 1 ? "var(--ok)" : tier === 5 ? "var(--accent)" : tier === 20 ? "var(--violet)" : "var(--muted)";
}

/** Each measure's own series colour (tokens in ui.css), so a bar never reads as a plan. */
export const CAPACITY_MEASURE_COLOR: Record<CapacityUnit, string> = {
  api_standard: "var(--measure-api)", credits_low: "var(--measure-credits)", tokens: "var(--measure-tokens)",
};

/** Token types in the Capacity charts and the cycle drawer. */
export const TOKEN_TYPE_COLOR = { fresh: "var(--accent)", cached: "var(--violet)", cache_write: "var(--warn)", output: "var(--ok)" } as const;

export function capacityMissingReason(window: Window, basis: CapacityBasis): string | null {
  if (window.usage.events <= 0) {
    if (window.evidence?.imports?.related.some(run => run.status === "pending" || run.status === "running")) {
      return translate("Meter available · traffic import in progress", "Licznik dostępny · trwa import ruchu");
    }
    return translate("Meter only · no matched traffic", "Sam licznik · brak dopasowanego ruchu");
  }
  if (window.usage.events <= window.usage.unpriced_events) return translate("Traffic recorded · missing prices", "Ruch zapisany · brak cen");
  if (window.observed_pp <= 0) return translate("No meter increase", "Brak przyrostu licznika");
  const shared = claudeCodeCapacityForWindow(window);
  if (shared === null && !claudeShareNeverReported(window)) {
    const reason = window.claude_code_capacity?.reason;
    return reason === "share_absent"
      ? translate("The provider sent no Claude Code share of the meter", "Dostawca nie podał udziału Claude Code w liczniku")
      : reason === "utilization_saturated"
        ? translate("Meter at 100%: no longer grows with usage", "Licznik na 100%: już nie rośnie z użyciem")
        : translate("The Claude Code estimate does not match this cycle's boundaries", "Szacunek Claude Code nie pasuje do granic tego cyklu");
  }
  if (basis === "regular" && capacityPerPoint(window, "api_standard", basis) === null) return translate("Regular allowance unconfirmed", "Zwykły limit niepotwierdzony");
  return null;
}

/**
 * Local traffic ÷ meter increase for a Claude cycle without a usable shared estimate. Other products
 * may have used part of the meter, so this is only a lower bound of the capacity: it is shown beside
 * the missing reason and never enters an estimate, a bar or a median.
 */
export function capacityLocalLowerBound(window: Window, unit: CapacityUnit): number | null {
  if (claudeCodeCapacityForWindow(window) !== null || claudeShareNeverReported(window) || !(window.observed_pp > 1) || unit === "credits_low") return null;
  const perPoint = observedCapacityPerPoint(window, unit);
  return perPoint === null || perPoint <= 0 ? null : perPoint * 100;
}

export type CapacityMetric = "api_standard" | "credits_low" | "credits_high" | "tokens" | "fresh" | "cached" | "output";

function estimateValue(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const estimate = value as { value?: unknown; absent?: unknown };
  return estimate.absent === null && typeof estimate.value === "number"
    && Number.isFinite(estimate.value) && estimate.value > 0 ? estimate.value : null;
}

/**
 * Return the shared Claude result only when its source is demonstrably this
 * automatic weekly cycle. An explicit null marker is intentional: it prevents
 * consumers from silently falling back to the old local-traffic calibration.
 */
function metricTotal(window: Window, metric: CapacityMetric): number | null {
  const priced = metric === "api_standard" || metric === "credits_low" || metric === "credits_high";
  if (priced && window.usage.events <= window.usage.unpriced_events) return null;
  if (metric !== "api_standard" && priced && creditsUnavailable(window.usage)) return null;
  const total = metric === "fresh" ? window.usage.input - window.usage.cached
    - (window.usage.cache_write_5m ?? 0) - (window.usage.cache_write_1h ?? 0) - (window.usage.cache_write_unknown ?? 0)
    : metric === "api_standard" ? window.usage.api_normalized ?? window.usage.api_standard : window.usage[metric];
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function observedCapacityPerPoint(window: Window, metric: CapacityMetric): number | null {
  if (!Number.isFinite(window.observed_pp) || window.observed_pp <= 0 || window.usage.events <= 0) return null;
  const total = metricTotal(window, metric);
  return total === null ? null : total / window.observed_pp;
}

function promotionFactor(window: Window, basis: CapacityBasis): number | null {
  if (basis === "observed") return 1;
  const factor = window.promotion?.status === "configured" ? window.promotion.factor : null;
  return factor !== null && Number.isFinite(factor) && factor > 0 ? factor : null;
}

export function promotionImpact(window: Window) {
  const factor = window.promotion?.status === "configured" ? window.promotion.factor : null;
  if (factor === null || !Number.isFinite(factor) || factor <= 0 || !Number.isFinite(window.end_percent) || window.end_percent < 0) return null;
  const regularUsedPercent = window.end_percent * factor;
  return { factor, bonusPercent: (factor - 1) * 100, regularUsedPercent, excessPercent: Math.max(0, regularUsedPercent - 100) };
}
export function capacityEstimate(window: Window, metric: CapacityMetric, basis: CapacityBasis = "observed") {
  const perPoint = capacityPerPoint(window, metric, basis);
  // Keep actual usage separate from capacity. A frozen Claude sample quotes its own stored traffic.
  const hasClaudeMarker = window.claude_capacity !== undefined || window.claude_code_capacity !== undefined;
  const observed = hasClaudeMarker ? metricTotal(window, metric) : observedCapacityPerPoint(window, metric);
  const shared = claudeCodeCapacityForWindow(window);
  let total = hasClaudeMarker ? observed : observed === null ? null : observed * window.observed_pp;
  if (window.claude_capacity?.sample) {
    const usage = window.claude_capacity.usage;
    total = metric === "tokens" ? usage.tokens : metric === "api_standard"
      ? usage.events > 0 && usage.unpriced_events >= usage.events ? null : usage.api_usd : null;
  } else if (shared?.sample_meter) {
    total = metric === "tokens" ? shared.observed_code_tokens : metric === "api_standard"
      ? shared.observed_code_api_usd ?? shared.observed_code_api_usd_subtotal ?? null : null;
  }
  const full = perPoint === null ? null : perPoint * 100;
  const remaining = basis === "regular" || perPoint === null ? null : perPoint * Math.max(0, 100 - window.end_percent);
  return { total, perPoint, full, remaining };
}

/** The capacity sample's bounds; whole-cycle meter readings remain on the window itself. */
export function capacityMeasurement(window: Window) {
  const sample = window.claude_capacity?.sample;
  if (sample) return { start: sample.from, end: sample.through, start_percent: sample.start_percent,
    end_percent: sample.end_percent, observed_pp: sample.observed_pp };
  const shared = claudeCodeCapacityForWindow(window);
  return shared?.sample_meter && shared.source_from && shared.source_through
    ? { ...shared.sample_meter, start: shared.source_from, end: shared.source_through }
    : { start: window.start, end: window.end, start_percent: window.start_percent,
      end_percent: window.end_percent, observed_pp: window.observed_pp };
}

export function capacityPeriodLabel(window: Window, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
    ...(window.window_minutes && window.window_minutes < 1440 ? { hour: "2-digit" as const, minute: "2-digit" as const, hourCycle: "h23" as const } : {}) });
  const start = new Date(window.cycle_start ?? window.start), end = new Date(window.cycle_end ?? window.reset);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return "?";
  return format.formatRange(start, end);
}
export function capacityPerPoint(window: Window, metric: CapacityMetric, basis: CapacityBasis = "observed"): number | null {
  if (window.claude_capacity !== undefined) {
    const result = window.claude_capacity, factor = promotionFactor(window, basis);
    if (result.account !== window.account.toLowerCase() || result.window_id !== window.id
      || result.window_minutes !== (window.window_minutes ?? 10080) || factor === null) return null;
    if (metric === "fresh" || metric === "cached" || metric === "output") {
      const full = result.token_parts?.[metric];
      return full == null ? null : full / 100 / factor;
    }
    if (metric !== "tokens" && metric !== "api_standard") return null;
    const point = claudeCapacityPerPoint(result, metric);
    return point === null ? null : point / factor;
  }
  const shared = claudeCodeCapacityForWindow(window);
  // A window the vendor never sent a share for falls through to local traffic ÷ meter increase.
  if (shared !== undefined && !claudeShareNeverReported(window)) {
    if (!shared || (metric !== "tokens" && metric !== "api_standard")) return null;
    // The shared figure is already a full weekly allowance, so it supplies a
    // per-point rate without dividing the local usage by this window's pp.
    const full = metric === "tokens" ? estimateValue(shared.weekly_capacity_tokens) : estimateValue(shared.weekly_capacity_api_usd);
    const factor = promotionFactor(window, basis);
    return full === null || factor === null ? null : full / 100 / factor;
  }
  const observed = observedCapacityPerPoint(window, metric);
  const factor = promotionFactor(window, basis);
  return observed === null || factor === null ? null : observed / factor;
}
/** The unit of the Capacity screen's switch. */
export type CapacityUnit = "api_standard" | "credits_low" | "tokens";

/** One price-completeness contract for charts and comparisons; tokens do not depend on prices. */
export function capacityIsLowerBound(window: Window, metric: CapacityMetric): boolean {
  if (metric !== "api_standard" && metric !== "credits_low" && metric !== "credits_high") return false;
  if (window.claude_capacity) return window.claude_capacity.capacity_api_usd.relation === "≥";
  const shared = claudeCodeCapacityForWindow(window);
  return shared?.sample_meter
    ? metric === "api_standard" && shared.weekly_capacity_api_usd.relation === "≥"
    : window.usage.unpriced_events > 0;
}

/** Estimated capacity at 100% in one unit; samples of 1 pp or less give no estimate. */
export function capacityFull(window: Window, unit: CapacityUnit, basis: CapacityBasis = "observed"): number | null {
  if (!(window.observed_pp > 1)) return null;
  const perPoint = capacityPerPoint(window, unit, basis);
  return perPoint === null ? null : perPoint * 100;
}

/** Usage recorded across the whole cycle in one unit; null when it is unknown or not applicable. */
export function capacityUsed(window: Window, unit: CapacityUnit): number | null {
  const usage = window.cycle_usage ?? window.usage;
  if (unit === "tokens") return usage.events > 0 ? usage.tokens : null;
  if (usage.events <= usage.unpriced_events || (unit === "credits_low" && creditsUnavailable(usage))) return null;
  return usage[unit];
}

/**
 * The filtered project's part of a cycle: its share (%) of the cycle's tokens and API value, and its API value
 * at the cycle's observed per-1% rate as meter points. Null without a project filter.
 */
export function projectCycleShare(window: Window) {
  const project = window.project_usage;
  if (!project) return null;
  const cycle = window.cycle_usage ?? window.usage;
  // The project's sums and the cycle's come from different stored sums; rounding must not show more than all of it.
  const share = (part: number, whole: number) => whole > 0 ? Math.min(100, part / whole * 100) : null;
  const perPoint = window.observed_pp > 1 ? capacityPerPoint(window, "api_standard", "observed") : null;
  // Per 1% uses the credit-normalized value when the cycle has one; the project's matches it.
  const value = window.usage.api_normalized !== undefined ? project.api_normalized : project.api_standard;
  return { project: project.project, tokens: project.tokens, api: project.api_standard, partial: project.unpriced_events > 0,
    tokenShare: share(project.tokens, cycle.tokens), apiShare: share(project.api_standard, cycle.api_standard),
    meterPoints: perPoint ? value / perPoint : null };
}

/** Plan identity for comparisons: only a confirmed plan counts. */
export function capacityPlanKey(window: Window): string | null {
  return window.plan && window.plan_detail?.status === "resolved" ? capacityPlanLabel(window) : null;
}

/** The newest confirmed plan in the list: the plan a median is taken for. */
export function capacityReferencePlan(windows: Window[]): string | null {
  return [...windows].sort((a, b) => Date.parse(b.start) - Date.parse(a.start)).map(capacityPlanKey).find(plan => plan !== null) ?? null;
}

// Evidence quality stands in for confidence: comparable is high, partial medium, insufficient low.
const QUALITY_CONFIDENCE: Record<WindowQuality, MedianConfidence> = { comparable: "high", partial: "medium", insufficient: "low" };

/** One cycle as an input of the canonical median. */
export function capacityMedianSample(window: Window, unit: CapacityUnit, basis: CapacityBasis = "observed"): MedianSample {
  return { value: capacityFull(window, unit, basis), plan: capacityPlanKey(window), samplePp: capacityMeasurement(window).observed_pp,
    confidence: capacityIsLowerBound(window, unit) ? "low" : QUALITY_CONFIDENCE[assessWindowQuality(window).status] };
}

/** Full capacity rounded to whole units; the value of 1% keeps two decimals. */
export function capacityUnitFormat(unit: CapacityUnit, locale: string) {
  const whole = new Intl.NumberFormat(locale, unit === "api_standard" ? { style: "currency", currency: "USD", maximumFractionDigits: 0 } : { maximumFractionDigits: 0 });
  const part = new Intl.NumberFormat(locale, unit === "api_standard" ? { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 1 });
  return {
    full: (value: number) => unit === "tokens" ? compact(value) : whole.format(value),
    per: (value: number) => unit === "tokens" ? compact(value) : part.format(value),
  };
}

/** Keep short-sample extrapolations visible without letting them flatten every other bar. */
export function capacityScaleMaximum(windows: Window[], metric: CapacityMetric, basis: CapacityBasis = "observed"): number {
  let substantialMax = 0, allMax = 0;
  for (const window of windows) {
    const value = capacityPerPoint(window, metric, basis) ?? 0;
    allMax = Math.max(allMax, value);
    if (window.observed_pp >= 20) substantialMax = Math.max(substantialMax, value);
  }
  return substantialMax > 0 ? substantialMax : allMax;
}

export function signedDeviation(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString(locale, { maximumFractionDigits: 0 })}%`;
}
export const deviationColor = (value: number | null) => value === null || Math.abs(value) < 10 ? "var(--muted)" : value > 0 ? "var(--ok)" : "var(--crit)";

export function relativeChange(value: number | null, baseline: number | null): number | null {
  return value !== null && baseline !== null && baseline > 0 ? (value / baseline - 1) * 100 : null;
}
function comparableWindows(baseline: Window, current: Window): boolean {
  const [beforeStart, beforeEnd, afterStart, afterEnd, beforeReset, afterReset] =
    [baseline.start, baseline.end, current.start, current.end, baseline.reset, current.reset].map(Date.parse) as [number, number, number, number, number, number];
  // Match the reset tolerance used to build the server's observation groups.
  return [beforeStart, beforeEnd, afterStart, afterEnd, beforeReset, afterReset].every(Number.isFinite)
    && baseline.plan_detail?.status !== "mixed" && current.plan_detail?.status !== "mixed"
    && baseline.plan_detail?.status !== "unknown" && current.plan_detail?.status !== "unknown"
    && (baseline.window_minutes ?? 10080) === (current.window_minutes ?? 10080)
    && (baseline.plan_detail?.multiplier == null || current.plan_detail?.multiplier == null || baseline.plan_detail.multiplier === current.plan_detail.multiplier)
    && baseline.id !== current.id && baseline.account === current.account && baseline.plan !== null && baseline.plan === current.plan
    && Math.abs(beforeReset - afterReset) > 120000 && beforeStart < beforeEnd && afterStart < afterEnd && beforeEnd <= afterStart;
}
export function defaultCapacityPair(windows: Window[]) {
  const sorted = [...windows].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const current = sorted.at(-1);
  // Start with the earliest substantial observation on the same known account/plan.
  const candidates = current ? sorted.filter(w => comparableWindows(w, current)) : [];
  const baseline = candidates.find(w => w.observed_pp >= 20 && (capacityPerPoint(w, "api_standard") ?? 0) > 0)
    ?? candidates.find(w => (capacityPerPoint(w, "api_standard") ?? 0) > 0);
  return { baseline, current };
}
export function compareCapacity(baseline: Window, current: Window, basis: CapacityBasis = "observed") {
  const compatible = comparableWindows(baseline, current);
  const change = (metric: CapacityMetric) => compatible && !capacityIsLowerBound(baseline, metric) && !capacityIsLowerBound(current, metric)
    ? relativeChange(capacityPerPoint(current, metric, basis), capacityPerPoint(baseline, metric, basis)) : null;
  // These fields represent uniform Standard/Fast assignments, not guaranteed ordering
  // under custom rates. Compare all four combinations of the reported scenarios.
  const creditScenarios = (w: Window) => {
    const standard = capacityPerPoint(w, "credits_low", basis);
    const fast = capacityPerPoint(w, "credits_high", basis);
    return standard === null || fast === null ? null : { min: Math.min(standard, fast), max: Math.max(standard, fast) };
  };
  const before = creditScenarios(baseline), after = creditScenarios(current);
  const low = compatible && before && after ? relativeChange(after.min, before.max) : null;
  const high = compatible && before && after ? relativeChange(after.max, before.min) : null;
  return { compatible, change, low, high,
    scenario: low === null || high === null ? "unavailable" as const : high < 0 ? "lower" as const : low > 0 ? "higher" as const : "overlap" as const };
}
/** Every recorded event predates credit billing, so a credit figure would be an invention. */
export function creditsUnavailable(usage: Pick<WindowUsage, "events" | "credits_unavailable_events">): boolean {
  return usage.events > 0 && (usage.credits_unavailable_events ?? 0) >= usage.events;
}
export interface UsageTokenTypes { fresh: number; cached: number; cache_write: number | null; output: number }
/**
 * Disjoint token types of a window: `input` already holds cache read and cache write, so the parts
 * add up to `tokens`. A cache write the source never reported stays null rather than zero, and
 * inconsistent counters yield no breakdown at all.
 */
export function usageTokenTypes(usage: WindowUsage): UsageTokenTypes | null {
  const writes = [usage.cache_write_5m, usage.cache_write_1h, usage.cache_write_unknown];
  const cacheWrite = writes.every(value => value === undefined) ? null : writes.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const types = { fresh: usage.input - usage.cached - (cacheWrite ?? 0), cached: usage.cached, cache_write: cacheWrite, output: usage.output };
  return [types.fresh, types.cached, cacheWrite ?? 0, types.output].every(value => Number.isFinite(value) && value >= 0) ? types : null;
}
export function usageShare(usage: WindowUsage, key: "priced_tokens" | "fast_tokens" | "unknown_tokens"): number | null {
  return usage.tokens > 0 ? 100 * usage[key] / usage.tokens : null;
}
export function dimensionComparison(baseline: Window, current: Window, dimension: "sources" | "models", basis: CapacityBasis = "observed") {
  return [...new Set([...baseline[dimension], ...current[dimension]].map(r => r.name))].map(name => {
    const before = baseline[dimension].find(r => r.name === name);
    const after = current[dimension].find(r => r.name === name);
    // The account-wide Claude estimate has no model/source denominator. Never
    // copy it into every dimension row; a dimension-specific proof is required.
    const value = (row: WindowUsage | undefined, window: Window) => row && window.claude_code_capacity === undefined && window.claude_capacity === undefined
      ? capacityPerPoint({ ...window, usage: row }, "api_standard", basis) : null;
    return { name, before: value(before, baseline), after: value(after, current),
      beforeShare: before && baseline.usage.tokens > 0 ? before.tokens / baseline.usage.tokens * 100 : null,
      afterShare: after && current.usage.tokens > 0 ? after.tokens / current.usage.tokens * 100 : null };
  });
}
