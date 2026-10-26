import type { CapacityCycleMetric, CapacityCycleTimeline, CapacityUsagePoint } from "../../shared/capacity-cycle";
import { firstSaturatedReading } from "../../shared/capacity-cycle";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import type { CapacityBasis } from "../../shared/codex-promotions";
import type { SubscriptionAccountingOptions } from "../../shared/subscription-accounting";
import { subscriptionAnalysisAdapter } from "./subscription-analysis";
import { claudeShareNeverReported } from "../../shared/claude-code-capacity";
import { capacityIsLowerBound, capacityPerPoint, claudeCodeCapacityForWindow } from "./codex-capacity";
import { translate } from "./i18n";

export type TimeRange = { from: number; to: number };
export type CycleAnalysisScope = { provider: string; options: SubscriptionAccountingOptions };
export type DetailedCapacityCycle = CodexComparisonWindow & { timeline: CapacityCycleTimeline };
export type CycleResolution = "auto" | 30 | 60 | 120;

export async function loadCapacityCycle(scope: CycleAnalysisScope | undefined, id: string): Promise<DetailedCapacityCycle> {
  if (!scope) throw new Error(translate("Cycle analysis context is unavailable.", "Brak kontekstu analizy cyklu."));
  // A cycle and its meter are the account's, so its detail is read without the screen's project filter.
  const { project: _project, ...options } = scope.options;
  const report = await subscriptionAnalysisAdapter(scope.provider).read({ ...options, detail_cycle: id });
  const cycle = report.windows?.find(w => w.id === id);
  if (!cycle?.timeline) throw new Error(translate("This cycle has changed or is no longer available. Refresh the cycle list.", "Cykl zmienił się lub jest niedostępny. Odśwież listę cykli."));
  return cycle as DetailedCapacityCycle;
}

export const emptyCycleUsage = (): CapacityUsagePoint => ({ ts: 0, events: 0, tokens: 0, api_standard: 0, credits_low: 0,
  credits_high: 0, unpriced_events: 0, unknown_tokens: 0 });

function addUsage(total: CapacityUsagePoint, point: CapacityUsagePoint) {
  if (point.api_normalized !== undefined || total.api_normalized !== undefined)
    total.api_normalized = (total.api_normalized ?? total.api_standard) + (point.api_normalized ?? point.api_standard);
  for (const key of ["events", "tokens", "api_standard", "credits_low", "credits_high", "unpriced_events", "unknown_tokens"] as const) total[key] += point[key];
  total.credits_unavailable_events = (total.credits_unavailable_events ?? 0) + (point.credits_unavailable_events ?? 0);
}

/** A normal selection is [from,to); cumulative meter deltas match (from,to]. */
export function sumCycleUsage(points: CapacityUsagePoint[], range: TimeRange, meterAligned = false) {
  const total = emptyCycleUsage();
  for (const p of points) if (meterAligned ? p.ts > range.from && p.ts <= range.to : p.ts >= range.from && p.ts < range.to) addUsage(total, p);
  return total;
}

export function cycleMetricValue(usage: CapacityUsagePoint, metric: CapacityCycleMetric): number | null {
  if (metric !== "tokens" && usage.events > 0 && usage.events <= usage.unpriced_events) return null;
  return usage[metric];
}

export function cycleBounds(cycle: DetailedCapacityCycle): TimeRange {
  return { from: Date.parse(cycle.cycle_start ?? cycle.start), to: Date.parse(cycle.cycle_end ?? cycle.reset) };
}

export function resolutionMinutes(range: TimeRange, resolution: CycleResolution): number {
  if (resolution !== "auto") return resolution;
  const minutes = (range.to - range.from) / 60000;
  return [30, 60, 120, 240, 720, 1440].find(step => minutes / step <= 60) ?? 1440;
}

export function bucketCycleUsage(points: CapacityUsagePoint[], range: TimeRange, minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from >= range.to) return [];
  const step = minutes * 60000;
  // UTC clock boundaries keep a 10:00–10:30 bar stable as the selection moves.
  const origin = Math.floor(range.from / step) * step;
  const buckets = Array.from({ length: Math.ceil((range.to - origin) / step) }, (_, i) => ({
    from: Math.max(range.from, origin + i * step), to: Math.min(range.to, origin + (i + 1) * step), usage: emptyCycleUsage(),
  }));
  for (const point of points) {
    if (point.ts < range.from || point.ts >= range.to) continue;
    const bucket = buckets[Math.floor((point.ts - origin) / step)];
    if (bucket) addUsage(bucket.usage, point);
  }
  return buckets;
}

export function analyseCycleSelection(cycle: DetailedCapacityCycle, range: TimeRange, metric: CapacityCycleMetric,
  basis: CapacityBasis = "observed") {
  const selected = sumCycleUsage(cycle.timeline.usage, range);
  const readings = cycle.timeline.readings.filter(p => p.ts >= range.from && p.ts <= range.to);
  // Once saturated, additional traffic no longer has a measurable denominator.
  const ceiling = firstSaturatedReading(readings, p => p.percent);
  const saturated = ceiling ? readings.indexOf(ceiling) : -1;
  const usable = saturated < 0 ? readings : readings.slice(0, saturated + 1);
  const first = usable[0], last = usable.at(-1);
  const matched = first && last && last.ts > first.ts ? { from: first.ts, to: last.ts,
    startPercent: first.percent, endPercent: last.percent, pp: last.percent - first.percent,
    maxGapMinutes: usable.slice(1).reduce((max, p, i) => Math.max(max, (p.ts - usable[i]!.ts) / 60000), 0),
    readings: usable.length } : null;
  const matchedUsage = matched ? sumCycleUsage(cycle.timeline.usage, matched, true) : emptyCycleUsage();
  const decreased = usable.some((p, i) => i > 0 && p.percent < usable[i - 1]!.percent);
  const reason: "missing_readings" | "decreased" | "plan_changed" | "small_sample" | "no_traffic" | "unpriced" | null = !matched ? "missing_readings" : decreased ? "decreased"
    : cycle.plan_detail?.status === "mixed" ? "plan_changed"
      : matched.pp <= 1 ? "small_sample" : !matchedUsage.events ? "no_traffic"
        : cycleMetricValue(matchedUsage, metric) === null ? "unpriced" : null;
  const capacityValue = metric === "api_standard" ? matchedUsage.api_normalized ?? matchedUsage.api_standard : matchedUsage[metric];
  // A window without any vendor share is measured like any other cycle: selected traffic ÷ its meter increase.
  const shared = claudeShareNeverReported(cycle) ? undefined : claudeCodeCapacityForWindow(cycle);
  const result = cycle.claude_capacity;
  const sharedRangeMatches = matched !== null && (result !== undefined
    ? Date.parse(result.sample?.from ?? "") === matched.from && Date.parse(result.sample?.through ?? "") === matched.to
    : shared !== undefined && Date.parse(shared?.source_from ?? "") === matched.from && Date.parse(shared?.source_through ?? "") === matched.to);
  // The account-wide Claude result is valid for a cycle-detail selection only
  // when the selected meter interval is exactly its prepared source interval.
  // Arbitrary model/session subranges retain actual usage but have no capacity rate.
  const perPoint = reason === null && matched
    ? result !== undefined || shared !== undefined
      ? sharedRangeMatches ? capacityPerPoint(cycle, metric, basis) : null
      : capacityValue / matched.pp
    : null;
  return { selected, matched, matchedUsage, reason, perPoint, full: perPoint === null ? null : perPoint * 100,
    conditional: sharedRangeMatches && (result?.conditional === true || shared?.conditional === true),
    partial: sharedRangeMatches ? capacityIsLowerBound(cycle, metric) : metric !== "tokens" && matchedUsage.unpriced_events > 0 };
}

export function utcDateTimeInput(time: number): string { return new Date(time).toISOString().slice(0, -1).replace(/\.000$/, ""); }
export function parseUtcDateTimeInput(value: string): number {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(value) ? Date.parse(value + "Z") : NaN;
}
