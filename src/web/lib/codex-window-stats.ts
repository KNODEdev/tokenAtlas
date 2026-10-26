import type { CycleBreakdownResponse, UsageSeries } from "./api";
import type { CycleView } from "./cycle";
import { buildModel, type AtlasModel } from "./cycle";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { railWindowsFromCycles } from "./windows";
import { sampleCurveAt } from "./window-insights";
import { subscriptionPlan } from "./subscription-plan";
import { translate } from "./i18n";

export const MIN_RATE_SPAN_PP = 5;

export function trafficRangeOf(cycle: CycleView) {
  // A live reset correction can reactivate a cycle whose indexed work range
  // was truncated by a superseded anchor.
  return {
    from: new Date(cycle.startIso).toISOString(),
    until: new Date(cycle.isActive ? cycle.resetIso ?? cycle.raw.work_to_ts : cycle.raw.work_to_ts).toISOString(),
  };
}

/** Gauge endpoints and traffic must describe the same interval. */
export function observationOf(cycle: CycleView) {
  const raw = cycle.raw;
  const live = cycle.live && Date.parse(cycle.live.ts) >= Date.parse(raw.end_ts) ? cycle.live : null;
  const end = live?.ts ?? raw.end_ts;
  const percent = live?.used_percent ?? raw.end_percent;
  const startMs = Date.parse(raw.start_ts), endMs = Date.parse(end);
  const span = percent - raw.first_percent;
  const valid = raw.sample_count >= 2 && raw.plan_types.length === 1
    && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    && startMs >= Date.parse(raw.work_from_ts)
    && endMs <= Date.parse(cycle.isActive ? cycle.resetIso ?? cycle.endIso : raw.work_to_ts)
    && Number.isFinite(span) && span >= MIN_RATE_SPAN_PP && percent <= 100
    && raw.first_percent >= 0 && percent >= raw.peak_percent && raw.lag_fraction < 0.18;
  return {
    end, percent, span,
    // The first observation already includes events at its timestamp.
    from: valid ? new Date(startMs + 1).toISOString() : null,
    until: valid ? end : null,
    hours: valid ? (endMs - startMs) / 3_600_000 : null,
  };
}

export function observedRates(cycle: CycleView, data: CycleBreakdownResponse | null) {
  const observation = observationOf(cycle);
  const valid = observation.from !== null && data !== null && data.totals.calls > 0
    && Date.parse(data.since_ts) === Date.parse(observation.from)
    && Date.parse(data.until_ts) === Date.parse(observation.until!);
  const rate = (value: number | null | undefined) => valid && value != null && Number.isFinite(value) && value >= 0
    ? value / observation.span : null;
  const credit = data?.credit_equivalent;
  return {
    tokens: rate(data?.totals.tokens),
    api: data && (data.totals.usd > 0 || data.unpriced.tokens === 0) ? rate(data.totals.usd) : null,
    credits: rate(credit?.value ?? (credit && credit.priced_credits > 0 ? credit.priced_credits : null)),
    apiPartial: (data?.unpriced.tokens ?? 0) > 0,
    creditsPartial: (credit?.unpriced_calls ?? 0) > 0,
  };
}


/** Descriptive window averages are distinct from paired gauge calibration. */
export function windowRates(cycle: CycleView, data: CycleBreakdownResponse | null) {
  const range = trafficRangeOf(cycle);
  const percent = cycle.usedPercent;
  const matching = data !== null && Date.parse(data.since_ts) === Date.parse(range.from)
    && Date.parse(data.until_ts) === Date.parse(range.until)
    && data.limit_id === (cycle.raw.limit_id ?? "codex");
  const valid = matching && data.totals.calls > 0 && Number.isFinite(percent) && percent > 0 && percent <= 100;
  const divide = (total: number | null | undefined) => valid && total != null && Number.isFinite(total) && total >= 0
    ? total / percent : null;
  const credit = data?.credit_equivalent;
  return {
    tokens: divide(data?.totals.tokens),
    api: data && (data.totals.usd > 0 || data.unpriced.tokens === 0) ? divide(data.totals.usd) : null,
    credits: divide(credit?.value ?? (credit && credit.priced_credits > 0 ? credit.priced_credits : null)),
    apiPartial: (data?.unpriced.tokens ?? 0) > 0,
    creditsPartial: (credit?.unpriced_calls ?? 0) > 0,
    comparable: valid,
  };
}

export function windowForecast(cycle: CycleView, now = Date.now()) {
  const observation = observationOf(cycle);
  const start = Date.parse(cycle.raw.window_start_iso ?? cycle.startIso);
  const at = Date.parse(observation.end), reset = Date.parse(cycle.resetIso ?? "");
  const hours = (at - start) / 3_600_000;
  const age = (now - at) / 3_600_000;
  const fresh = Number.isFinite(age) && age >= 0 && age <= Math.min(6, Math.max(0.5, cycle.windowHours * 0.05));
  const valid = cycle.isActive && fresh && reset > now && reset > at && hours > cycle.windowHours * 0.01
    && observation.percent >= MIN_RATE_SPAN_PP && observation.percent <= 100;
  const perHour = !cycle.isActive && cycle.elapsedHours > 0 && Number.isFinite(cycle.usedPercent)
    ? cycle.usedPercent / cycle.elapsedHours : valid ? observation.percent / hours : null;
  const projected = valid && perHour !== null ? perHour * ((reset - start) / 3_600_000) : null;
  const eta = valid && perHour !== null ? start + 100 / perHour * 3_600_000 : null;
  return { fresh, at: observation.end, hours, perHour, projected,
    exhaustionIso: eta !== null && eta > now && eta < reset ? new Date(eta).toISOString() : null,
    pace: projected !== null ? projected / 100 : null,
    beforeResetHours: eta !== null ? (reset - eta) / 3_600_000 : null,
    remainingPerHour: valid ? Math.max(0, 100 - observation.percent) / ((reset - at) / 3_600_000) : null,
    elapsedPercent: hours / cycle.windowHours * 100,
  };
}

/** Descriptive traffic uses the whole selected window, including idle time. */
export function windowTrafficSummary(cycle: CycleView, data: CycleBreakdownResponse | null, now = Date.now()) {
  const range = trafficRangeOf(cycle);
  const matches = data !== null && data.limit_id === (cycle.raw.limit_id ?? "codex")
    && Date.parse(data.since_ts) === Date.parse(range.from) && Date.parse(data.until_ts) === Date.parse(range.until);
  const end = cycle.isActive ? Math.min(now, Date.parse(range.until)) : Date.parse(range.until);
  const hours = (end - Date.parse(range.from)) / 3_600_000;
  const valid = matches && Number.isFinite(data.totals.tokens) && data.totals.tokens >= 0;
  const peak = valid ? (data.days ?? []).filter(d => Number.isFinite(d.tokens) && d.tokens > 0)
    .reduce<(typeof data.days)[number] | null>((best, day) => !best || day.tokens > best.tokens ? day : best, null) : null;
  return {
    perDay: valid && hours > 0 ? data.totals.tokens / hours * 24 : null,
    peak: peak && data && data.totals.tokens >= peak.tokens ? { date: peak.date, tokens: peak.tokens,
      share: peak.tokens / data.totals.tokens * 100 } : null,
  };
}

export function medianDailyTraffic(values: (number | null)[]) {
  const sorted = values.filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length < 4) return null;
  const middle = Math.floor(sorted.length / 2);
  return (sorted[middle]! + sorted[Math.floor((sorted.length - 1) / 2)]!) / 2;
}

export function accountingWindow(cycle: CycleView, windows: CodexComparisonWindow[]) {
  if (cycle.windowHours !== 168 || cycle.raw.limit_id !== "codex") return null;
  const matches = windows.filter(w => Math.abs(Date.parse(w.reset) - Date.parse(cycle.resetIso ?? "")) <= 120_000);
  // A plan change or counter correction within one reset is not one regime.
  return matches.length === 1 ? matches[0]! : null;
}

export function comparableStatWindows(cycles: CycleView[], selected: CycleView, windows: CodexComparisonWindow[]) {
  const current = accountingWindow(selected, windows);
  const plan = cyclePlanLabel(selected);
  if (!plan || selected.usedPercent < 10) return [];
  const ambiguous = (c: CycleView) => windows.filter(w => Math.abs(Date.parse(w.reset) - Date.parse(c.resetIso ?? "")) <= 120_000).length > 1;
  if (ambiguous(selected)) return [];
  return cycles.filter(c => {
    const other = accountingWindow(c, windows);
    return !c.isActive && !c.isShadow && c.index !== selected.index && c.windowHours === selected.windowHours
      && c.raw.limit_id === selected.raw.limit_id && Date.parse(c.raw.work_to_ts) <= Date.parse(selected.startIso)
      && c.usedPercent >= 10 && cyclePlanLabel(c) === plan && !ambiguous(c)
      && (!other || !current || (other.account === current.account && other.plan === current.plan))
      && (other?.plan_detail?.multiplier == null || current?.plan_detail?.multiplier == null || other.plan_detail.multiplier === current.plan_detail.multiplier)
      // Unknown promotion terms permit an observed comparison, never a claim of equal contractual capacity.
      && (other?.promotion?.status !== "configured" || current?.promotion?.status !== "configured" || other.promotion.factor === current.promotion.factor);
  }).sort((a, b) => Date.parse(b.startIso) - Date.parse(a.startIso)).slice(0, 10);
}

export function cyclePlanLabel(cycle: CycleView): string | null {
  const plans = [...new Set(cycle.raw.plan_types.filter(Boolean))];
  return plans.length === 1 ? subscriptionPlan("codex", plans[0]!, cycle.startIso.slice(0, 10)) : null;
}

export function cyclePlanDescription(cycle: CycleView): string {
  const label = cyclePlanLabel(cycle);
  if (label) return label;
  const plans = [...new Set(cycle.raw.plan_types.filter(Boolean))];
  return plans.length > 1 ? plans.map(plan => subscriptionPlan("codex", plan, cycle.startIso.slice(0, 10))).join(" / ")
    + " · " + translate("plan change", "zmiana planu") : translate("plan unknown", "plan nieznany");
}

export function historyThroughCycle(cycles: CycleView[], selected: CycleView) {
  return cycles.filter(c => !c.isShadow && Date.parse(c.startIso) <= Date.parse(selected.startIso))
    .sort((a, b) => Date.parse(b.startIso) - Date.parse(a.startIso)).slice(0, 10);
}

export function withWindowTraffic(cycle: CycleView, data: CycleBreakdownResponse | null): CycleView {
  if (!data) return cycle;
  const models = new Map<string, CycleView["raw"]["model_usage"][number]>();
  const tokens = { in: 0, cached_in: 0, out: 0, cache_write: 0, reasoning: 0, total: data.totals.tokens };
  for (const row of data.model_detail?.rows ?? []) {
    const item = models.get(row.model) ?? { name: row.model, calls: 0, tokens: 0, fresh: 0, usd: 0 };
    item.calls += row.calls; item.tokens += row.tokens; item.fresh += row.tokens - row.cached; item.usd += row.api?.total ?? 0;
    if (!row.api) item.usd_partial = true;
    models.set(row.model, item);
    tokens.in += row.input; tokens.cached_in += row.cached; tokens.out += row.output; tokens.cache_write += row.cache_write; tokens.reasoning += row.reasoning;
  }
  return { ...cycle, tokensTotal: data.totals.tokens, tokensFresh: data.totals.tokens_fresh,
    calls: data.totals.calls, usd: data.totals.usd, raw: { ...cycle.raw, tokens: data.model_detail ? tokens : cycle.raw.tokens,
      usd: data.totals.usd, usd_per_percent: cycle.usedPercent > 0 && data.unpriced.tokens === 0 ? data.totals.usd / cycle.usedPercent : null,
      model_usage: data.model_detail ? [...models.values()] : cycle.raw.model_usage,
      surface_usage: data.model_detail?.surfaces ?? cycle.raw.surface_usage } };
}

export function modelThroughCycle(model: AtlasModel, selected: CycleView, previous: CycleView[]): AtlasModel {
  const scoped = buildModel({ ...model.series, cycles: previous.map(c => c.raw) });
  return { ...scoped, current: selected, cycles: [selected, ...previous], closed: previous, typical: previous };
}

export function usageAtSameTime(previous: CycleView | undefined, selected: CycleView, series: UsageSeries) {
  if (!previous) return null;
  const forecast = windowForecast(selected);
  const [rail] = railWindowsFromCycles([previous], series.points, series.activity);
  return rail ? sampleCurveAt(rail.shape, forecast.elapsedPercent, rail.activityShape) : null;
}
