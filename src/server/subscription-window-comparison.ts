import type { SubscriptionComparisonWindow as CodexComparisonWindow } from "../shared/subscription-accounting";
import type { CapacityCycleModel, CapacityCycleSource, CapacityUsagePoint } from "../shared/capacity-cycle";
import { emptyWindowEvidence } from "./subscription-evidence";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { activityStartsAt, activityHasZeroStart } from "../shared/window-activity";

export const emptyWindowUsage = (): WindowUsage => ({ events: 0, tokens: 0, input: 0, cached: 0, output: 0, fast_tokens: 0, unknown_tokens: 0,
  priced_tokens: 0, unpriced_events: 0, api_standard: 0, credits_low: 0, credits_high: 0 });
const empty = emptyWindowUsage;
export type { WindowUsage } from "../shared/codex-accounting";
import type { WindowUsage } from "../shared/codex-accounting";
import { CONTEXT_USAGE_KEYS } from "../shared/codex-accounting";
import { firstSaturatedReading } from "../shared/capacity-cycle";

export interface MeterEvent {
  account: string | null; ts: string; model: string | null; home?: string | null;
  meter_reset?: number | null; plan_type?: string | null;
  /**
   * A cohort of this many calls (default one) that every rule of the window treats alike: `ts` is its first call's
   * instant and `last_ts` its last's, and it spans no bound the window distinguishes (`meterWindowCuts`).
   */
  calls?: number; last_ts?: string;
}
export interface WindowAccountingAdapter<Event extends MeterEvent> {
  windowMinutes: number;
  meterReset?(event: Event): number | null | undefined;
  include(event: Event): boolean;
  exclusionReason?(event: Event): "counter" | "imprecise_time" | "funding";
  usage(event: Event): WindowUsage;
  detail?(event: Event): { cache_write: number | null; cache_write_in_input: boolean; pricing_issue: string | null };
}

/**
 * Event instants have millisecond resolution, a vendor bound may not (a Claude share's window start).
 * `t >= B` and `t < B` compare with the bound rounded up; `t > B` and `t <= B` with it rounded down.
 */
const ceilInstant = (iso: string): number => {
  const ms = Date.parse(iso), fraction = iso.match(/\.(\d+)/)?.[1] ?? "";
  return /[1-9]/.test(fraction.slice(3)) ? ms + 1 : ms;
};
/** A cycle is never clipped to a screen's range: its bounds are the window's own. */
const cycleBounds = (w: CodexComparisonWindow) => ({ start: Date.parse(w.start), end: Date.parse(w.end), startCeil: ceilInstant(w.start),
  cycleStart: Date.parse(w.cycle_start ?? w.start), cycleStartCeil: ceilInstant(w.cycle_start ?? w.start),
  cycleEnd: Date.parse(w.cycle_end ?? w.reset), cycleEndCeil: ceilInstant(w.cycle_end ?? w.reset) });
const inCycle = (w: CodexComparisonWindow, bound: ReturnType<typeof cycleBounds>, time: number): boolean =>
  (w.id.startsWith("manual:") ? time > bound.cycleStart : time >= bound.cycleStartCeil)
  && (w.id.startsWith("manual:") ? time <= bound.cycleEnd : time < bound.cycleEndCeil)
  && (!w.activity || w.activity.spans.some(span => time >= Date.parse(span.start) && time < Date.parse(span.end)));
const isPaired = (w: CodexComparisonWindow, bound: ReturnType<typeof cycleBounds>, time: number): boolean =>
  (w.start_basis === "reset" ? time >= bound.startCeil : time > bound.start) && time <= bound.end;
/**
 * The instants at which a window's placement and pairing of a call can change (cycle bounds, pairing bounds):
 * a cohort of calls that spans none of them is placed and paired like each of its calls.
 */
export function meterWindowCuts(w: CodexComparisonWindow): number[] {
  const bound = cycleBounds(w);
  return [bound.start, bound.startCeil, bound.cycleStart, bound.cycleStartCeil, bound.cycleEnd, bound.cycleEndCeil, Date.parse(w.end),
    ...(w.activity?.spans.flatMap(span => [Date.parse(span.start), Date.parse(span.end)]) ?? [])]
    .flatMap(at => [at, at + 1]);
}
/**
 * Where a window's traffic is paired with its meter (the one contract `registerWindowShell` and the billing cuts use):
 * from its start after a confirmed reset, else from its first reading (the first manual reading when it has manual
 * ones), to its last manual reading, else its first reading at 100 %, else its last reading.
 */
export function pairingBounds(window: Pick<ProbeLimitWindow, "start" | "readings" | "startDrop"> & Partial<Pick<ProbeLimitWindow, "activity" | "reset" | "window_minutes">>) {
  const readings = window.readings;
  const manual = readings.filter(reading => reading.source === "manual");
  const first = manual[0] ?? readings[0]!;
  const last = manual.at(-1) ?? firstSaturatedReading(readings, reading => reading.percent) ?? readings.at(-1)!;
  const fromReset = manual.length === 0 && !window.startDrop && Date.parse(window.start) < Date.parse(first.ts)
    && activityStartsAt(window.activity, Date.parse(window.start))
    && (!window.activity || activityHasZeroStart(window.activity)
      || window.activity.start_basis !== "partial" && Math.abs(Date.parse(window.start) - (Date.parse(window.reset!) - window.window_minutes! * 60_000)) < 120_000);
  return { manual, first, last, fromReset, start: fromReset ? window.start : first.ts, startPercent: fromReset ? 0 : first.percent };
}

/** Pair cumulative traffic with the cumulative meter whenever the cycle start is known. */
export function registerWindowShell(window: ProbeLimitWindow, minutes: number, detailCycleId?: string): CodexComparisonWindow {
  const readings = window.readings;
  const { manual, first, last, fromReset, start, startPercent } = pairingBounds(window);
  const gaps = readings.flatMap((reading, index) => {
    const prior = index ? readings[index - 1]! : fromReset ? { ts: window.start } : null;
    const minutes = prior ? (Date.parse(reading.ts) - Date.parse(prior.ts)) / 60_000 : 0;
    return prior && minutes > 5 ? [{ from: prior.ts, to: reading.ts, minutes }] : [];
  });
  const evidence = emptyWindowEvidence();
  evidence.meter_gaps.push(...gaps);
  return {
    id: window.id, account: window.account, plan: window.plan, plan_detail: window.plan_detail ?? undefined,
    declared_plan_meter_mismatch: window.declared_plan_meter_mismatch,
    window_minutes: minutes, reset: window.reset, start, end: last.ts,
    start_percent: startPercent, end_percent: last.percent, observed_pp: last.percent - startPercent,
    probes: readings.length, max_gap_hours: Math.max(0, ...gaps.map(gap => gap.minutes / 60)),
    start_basis: fromReset ? "reset" : first.percent === 0 ? "zero_reading" : "partial",
    first_probe: { ts: first.ts, percent: first.percent },
    cycle_start: window.start, cycle_end: window.end, cycle_end_basis: window.cycle_end_basis,
    ...(window.activity ? { activity: window.activity } : {}),
    meter_sources: [...new Set(readings.map(reading => reading.source))],
    ...(window.manual_measurement ? { manual_measurement: window.manual_measurement } : {}),
    ...(window.manual_measurements?.length ? { manual_measurements: window.manual_measurements } : {}),
    usage: empty(), cycle_usage: empty(), unpaired_events: 0, sources: [], models: [], evidence,
    ...(window.id === detailCycleId ? { timeline: { readings: readings.map(reading => ({
      ts: Date.parse(reading.ts), percent: reading.percent, source: reading.source,
      ...(reading.limit_hit ? { limit_hit: reading.limit_hit } : {}) })), usage: [] } } : {}),
  };
}

/** An explicit pair of readings needs no inferred reset or synthetic zero. */
export function compareManualMeterInterval<Event extends MeterEvent>(measurement: ManualCapacityMeasurement, events: Event[],
  adapter: WindowAccountingAdapter<Event>, detailCycleId?: string): CodexComparisonWindow {
  const id = `manual:${measurement.id}`;
  const window: CodexComparisonWindow = {
    id, account: measurement.account, plan: null, window_minutes: adapter.windowMinutes,
    start: measurement.start, end: measurement.end, reset: measurement.end,
    cycle_start: measurement.start, cycle_end: measurement.end, cycle_end_basis: "uncertain",
    start_percent: measurement.start_percent, end_percent: measurement.end_percent,
    observed_pp: measurement.end_percent - measurement.start_percent, probes: 2,
    max_gap_hours: (Date.parse(measurement.end) - Date.parse(measurement.start)) / 3600000,
    start_basis: measurement.start_percent === 0 ? "zero_reading" : "partial",
    first_probe: { ts: measurement.start, percent: measurement.start_percent },
    usage: empty(), cycle_usage: empty(), sources: [], models: [], meter_sources: ["manual"], unpaired_events: 0,
    evidence: emptyWindowEvidence(),
    manual_measurement: { id: measurement.id, approximate_time: measurement.approximate_time, note: measurement.note },
  };
  if (id === detailCycleId) window.timeline = { readings: [
    { ts: Date.parse(measurement.start), percent: measurement.start_percent, source: "manual" },
    { ts: Date.parse(measurement.end), percent: measurement.end_percent, source: "manual" },
  ], usage: [] };
  return populateMeterWindows([window], events, adapter)[0]!;
}

/** Sees each event a window counts, and each event it leaves out with the reason, with its usage. */
export interface MeterWindowObserver<Event extends MeterEvent> {
  counted(window: CodexComparisonWindow, event: Event, usage: WindowUsage, paired: boolean): void;
  excluded(window: CodexComparisonWindow, event: Event, reason: MeterExclusion, usage: WindowUsage): void;
}
/** Why a window leaves an event out: the adapter's reason, or a recorded meter reset other than the window's. */
export type MeterExclusion = "counter" | "imprecise_time" | "funding" | "reset";

/**
 * Places each event in the first window (in the given order) whose cycle contains it, admits it with
 * the adapter, and sums the counted usage of every window: paired, whole cycle, sources and models.
 */
export function populateMeterWindows<Event extends MeterEvent>(windows: CodexComparisonWindow[], events: Event[],
  adapter: WindowAccountingAdapter<Event>, observer?: MeterWindowObserver<Event>): CodexComparisonWindow[] {
  const byAccount = new Map<string, CodexComparisonWindow[]>();
  const dimensions = new Map(windows.map(w => [w.id, { sources: new Map<string, WindowUsage>(), models: new Map<string, WindowUsage>() }]));
  for (const w of windows) { const rows = byAccount.get(w.account) ?? []; rows.push(w); byAccount.set(w.account, rows); }
  const bounds = new Map(windows.map(w => [w, cycleBounds(w)]));
  const usageKeys = [...Object.keys(empty()), ...CONTEXT_USAGE_KEYS, "api_normalized", "credits_unavailable_events", "cache_write_5m", "cache_write_1h", "cache_write_unknown", "reference_api_standard", "reference_priced_tokens", "reference_unpriced_events", "paired_historical_api", "paired_reference_api", "revaluation_events", "revaluation_tokens"] as Array<keyof WindowUsage>;
  const timelineUsage = new Map<number, CapacityUsagePoint>();
  const cycleModels = new Map<string, CapacityCycleModel>();
  const cycleSources = new Map<string, CapacityCycleSource>();
  for (const event of events) {
    if (!event.account) continue;
    const time = Date.parse(event.ts);
    const w = byAccount.get(event.account)?.find(w => inCycle(w, bounds.get(w)!, time));
    if (!w) continue;
    const excluded = adapter.include(event) ? null : adapter.exclusionReason?.(event) ?? "counter";
    // Pair traffic with its own recorded meter, not a parallel counter on one profile.
    const meterReset = adapter.meterReset ? adapter.meterReset(event) : event.meter_reset;
    const reason = exclusion(w, excluded, meterReset), calls = event.calls ?? 1;
    if (!counted(w, reason, calls)) {
      if (observer) observer.excluded(w, event, reason!, adapter.usage(event));
      continue;
    }
    const paired = isPaired(w, bounds.get(w)!, time);
    const item = adapter.usage(event);
    observer?.counted(w, event, item, paired);
    if (w.timeline) {
      const point = timelineUsage.get(time) ?? { ts: time, events: 0, tokens: 0, api_standard: 0, credits_low: 0, credits_high: 0, unpriced_events: 0, unknown_tokens: 0 };
      for (const key of ["events", "tokens", "api_standard", "credits_low", "credits_high", "unpriced_events", "unknown_tokens"] as const) point[key] += item[key];
      point.credits_unavailable_events = (point.credits_unavailable_events ?? 0) + (item.credits_unavailable_events ?? 0);
      if (item.api_normalized !== undefined) point.api_normalized = (point.api_normalized ?? 0) + item.api_normalized;
      timelineUsage.set(time, point);
      const modelName = event.model ?? "?";
      const model = cycleModels.get(modelName) ?? { ...empty(), name: modelName, cache_write: 0, cache_write_in_input: true, pricing_issues: {} };
      for (const key of usageKeys) if (item[key] !== undefined) model[key] = (model[key] ?? 0) + item[key]!;
      const detail = adapter.detail?.(event);
      model.cache_write = model.cache_write === null || detail?.cache_write == null ? null : model.cache_write + detail.cache_write;
      model.cache_write_in_input = model.cache_write_in_input && detail?.cache_write_in_input === true;
      if (item.unpriced_events) {
        const reason = detail?.pricing_issue ?? "missing_rate";
        const issue = model.pricing_issues[reason] ?? { events: 0, tokens: 0 };
        issue.events += item.unpriced_events; issue.tokens += item.tokens;
        model.pricing_issues[reason] = issue;
      }
      cycleModels.set(modelName, model);
      // The rail's naming: a ledger fact's source, else its home. The computer is resolved by the caller.
      const sourceName = (event as { source?: string | null }).source ?? event.home ?? "nieznane źródło";
      const last = event.last_ts ?? event.ts;
      const source = cycleSources.get(sourceName) ?? { ...empty(), name: sourceName, machine: null, first: event.ts, last };
      for (const key of usageKeys) if (item[key] !== undefined) source[key] = (source[key] ?? 0) + item[key]!;
      if (Date.parse(event.ts) < Date.parse(source.first)) source.first = event.ts;
      if (Date.parse(last) > Date.parse(source.last)) source.last = last;
      cycleSources.set(sourceName, source);
    }
    add(w, event.home, event.model, item, paired, event.ts, event.last_ts ?? event.ts, calls);
  }
  /** False, and counted as left out, when the window does not pair these events with its meter. */
  // A plan is never read from an event: the window's plan comes from plan periods, and the
  // event belongs to the window by its time. `excluded_events.plan` stays for compatibility at 0.
  /** Why the window leaves these events out: the adapter's reason, or a meter reset other than the window's. */
  function exclusion(w: CodexComparisonWindow, excluded: Exclude<MeterExclusion, "reset"> | null, meterReset: number | null | undefined): MeterExclusion | null {
    return excluded ?? (meterReset != null && Math.abs(meterReset * 1000 - Date.parse(w.reset)) > 120000 ? "reset" : null);
  }
  function counted(w: CodexComparisonWindow, reason: ReturnType<typeof exclusion>, events: number): boolean {
    if (!reason) return true;
    const left = w.evidence!.excluded_events;
    left[reason] = (left[reason] ?? 0) + events;
    return false;
  }
  function add(w: CodexComparisonWindow, home: string | null | undefined, modelName: string | null, item: WindowUsage,
    paired: boolean, first: string, last: string, events: number): void {
    const name = home ?? "nieznane źródło";
    let sourceEvidence = w.evidence!.sources.find(s => s.name === name);
    if (!sourceEvidence) { sourceEvidence = { name, first, last, events: 0, tokens: 0, paired_events: 0, paired_tokens: 0 }; w.evidence!.sources.push(sourceEvidence); }
    sourceEvidence.events += item.events; sourceEvidence.tokens += item.tokens;
    if (Date.parse(first) < Date.parse(sourceEvidence.first)) sourceEvidence.first = first;
    if (Date.parse(last) > Date.parse(sourceEvidence.last)) sourceEvidence.last = last;
    if (paired) { sourceEvidence.paired_events += item.events; sourceEvidence.paired_tokens += item.tokens; }
    for (const key of usageKeys) if (item[key] !== undefined) w.cycle_usage![key] = (w.cycle_usage![key] ?? 0) + item[key]!;
    if (!paired) { w.unpaired_events! += events; return; }
    const dims = dimensions.get(w.id)!;
    const model = modelName ?? "nieznany model";
    const sourceUsage = dims.sources.get(name) ?? empty(), modelUsage = dims.models.get(model) ?? empty();
    for (const target of [w.usage, sourceUsage, modelUsage]) {
      for (const key of usageKeys) if (item[key] !== undefined) target[key] = (target[key] ?? 0) + item[key]!;
    }
    dims.sources.set(name, sourceUsage); dims.models.set(model, modelUsage);
  }
  for (const w of windows) {
    if (w.timeline) {
      w.timeline.usage = [...timelineUsage.values()].sort((a, b) => a.ts - b.ts);
      w.timeline.models = [...cycleModels.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
      w.timeline.sources = [...cycleSources.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
      const bound = bounds.get(w)!;
      w.timeline.readings = w.timeline.readings.filter(p => p.ts >= bound.cycleStart
        && (w.id.startsWith("manual:") ? p.ts <= bound.cycleEnd : p.ts < bound.cycleEnd));
    }
    // First seen first, whatever order the events or sums arrived in.
    w.evidence!.sources.sort((a, b) => Date.parse(a.first) - Date.parse(b.first) || a.name.localeCompare(b.name));
    const dims = dimensions.get(w.id)!;
    w.sources = [...dims.sources].map(([name, usage]) => ({ name, ...usage })).sort((a, b) => b.tokens - a.tokens);
    w.models = [...dims.models].map(([name, usage]) => ({ name, ...usage })).sort((a, b) => b.tokens - a.tokens);
  }
  return windows.sort((a, b) => a.start.localeCompare(b.start));
}
