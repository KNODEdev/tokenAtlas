import { effectivePlanPeriods, planPeriodIndex, type DatedPeriod } from "./account-periods";
import { subscriptionAccountingAdapters } from "./subscription-accounting-adapters";
import { probeWindowPlan } from "./window-plan-periods";
import { canonicalTime, subtractMinutes, sameReset, RESET_JOIN_MS, segmentReadings,
  type SegmentInput, type SegmenterState, type RawSegment } from "./limit-window-segments";
import type { WindowActivity } from "../shared/window-activity";

/** A plan switch can select another meter with the very same reset, then resume the first. */
export function segmentLimitReadings(provider: string, account: string, counter: string, meter: readonly SegmentInput[],
  periods: readonly DatedPeriod[], state?: SegmenterState): RawSegment[] {
  const meterPlan = subscriptionAccountingAdapters().find(adapter => adapter.aliases.includes(provider.toLowerCase()))?.windowMeterPlan ?? (() => null);
  const index = planPeriodIndex(periods);
  const own = effectivePlanPeriods(periods).filter(p => p.provider === provider && p.subject.toLowerCase() === account.toLowerCase());
  const observedPlans = periods.filter(p => p.provider === provider && p.subject.toLowerCase() === account.toLowerCase()
    && p.origin === "observed" && meterPlan(p.value)).sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  const readingKey = (ts: string, percent: number) => `${ts}|${percent}`;
  const rawPlans = new Map(meter.map(row => [readingKey(row.ts, row.used_percent), meterPlan(row.plan)]));
  const switchAt = (plan: string, previous: string, next: string): string => {
    const bounds = (p: DatedPeriod) => Date.parse(p.from) > Date.parse(previous) && Date.parse(p.from) <= Date.parse(next);
    return own.find(p => p.origin === "declared" && meterPlan(p.value) === plan && bounds(p))?.from
      ?? observedPlans.find(p => meterPlan(p.value) === plan && bounds(p))?.from ?? next;
  };
  const withoutUnpaidGaps = (initial: WindowActivity["spans"]): WindowActivity["spans"] => {
    let spans = initial;
    for (const gap of own.filter(p => p.value === "none")) {
      const from = Date.parse(gap.from), until = gap.until ? Date.parse(gap.until) : Infinity;
      spans = spans.flatMap(span => {
        const start = Date.parse(span.start), end = Date.parse(span.end);
        if (end <= from || start >= until) return [span];
        return [...(start < from ? [{ start: span.start, end: new Date(from).toISOString() }] : []),
          ...(end > until ? [{ start: new Date(until).toISOString(), end: span.end }] : [])];
      });
    }
    return spans;
  };
  const rows: SegmentInput[] = [];
  for (const row of meter) {
    const previous = rows.findLast(prior => sameReset(prior.resets_at, row.resets_at));
    const declaredSwitch = previous && own.some(p => p.origin === "declared" && p.value !== "none"
      && Date.parse(p.from) > Date.parse(previous.ts) && Date.parse(p.from) <= Date.parse(row.ts));
    const plan = meterPlan(row.plan) ?? (!declaredSwitch ? previous?.plan : null)
      ?? meterPlan(index?.resolve(provider, account, row.ts).value);
    rows.push({ ...row, plan });
  }
  const resolvedPlans = new Map(rows.map(row => [readingKey(row.ts, row.used_percent), row.plan]));
  let result = segmentReadings(account, counter, meter, state);
  const key = (ts: string, percent: number, source: string) => JSON.stringify([ts, percent, source]);
  const accepted = new Set(result.flatMap(window => window.readings.map(row => key(row.ts, row.percent, row.source))));
  const resets: SegmentInput[][] = [];
  for (const row of rows.filter(row => accepted.has(key(row.ts, row.used_percent, row.source ?? "probe")))) {
    const group = resets.find(group => sameReset(group[0]!.resets_at, row.resets_at));
    if (group) group.push(row); else resets.push([row]);
  }
  for (const group of resets) {
    const plans = [...new Set(group.flatMap(row => row.plan ? [row.plan] : []))];
    if (plans.length < 2) continue;
    const directPlans = new Set(group.flatMap(row => {
      const plan = rawPlans.get(readingKey(row.ts, row.used_percent));
      return plan ? [plan] : [];
    }));
    if (directPlans.size < 2) continue;
    // Unknown readings do not establish a switch. They remain with the last known meter.
    let lastPlan: string | null = null;
    const assigned = group.map(row => { lastPlan = row.plan ?? lastPlan; return { ...row, plan: lastPlan }; });
    const runs: Array<{ plan: string; start: string; end: string }> = [];
    for (let i = 0; i < assigned.length; i++) {
      const row = assigned[i]!;
      if (!row.plan || runs.at(-1)?.plan === row.plan) continue;
      const previous = assigned[i - 1];
      const start = previous ? switchAt(row.plan, previous.ts, row.ts) : subtractMinutes(row.resets_at, row.window_minutes);
      if (runs.length) runs.at(-1)!.end = canonicalTime(start);
      runs.push({ plan: row.plan, start: canonicalTime(start), end: canonicalTime(row.resets_at) });
    }
    const original = result.filter(window => sameReset(window.reset, group[0]!.resets_at));
    result = result.filter(window => !sameReset(window.reset, group[0]!.resets_at));
    for (const plan of plans) {
      const selected = assigned.filter(row => row.plan === plan);
      const segments = segmentReadings(account, counter, selected);
      for (const segment of segments) {
        if (segment === segments[0] && plan === assigned.find(row => row.plan)?.plan && original[0]) {
          segment.start = original[0].start;
          segment.startDrop = original[0].startDrop;
        }
        let spans = runs.filter(run => run.plan === plan).map(run => ({
          start: new Date(Math.max(Date.parse(run.start), Date.parse(segment.start))).toISOString(),
          end: new Date(Math.min(Date.parse(run.end), Date.parse(segment.end))).toISOString(),
        })).filter(span => span.start < span.end);
        // A declared unpaid gap is not traffic of either paid meter.
        spans = withoutUnpaidGaps(spans);
        if (!spans.length) continue;
        segment.start = spans[0]!.start;
        segment.id = JSON.stringify([account, counter, segment.start]);
        segment.activity = { ...segment.activity, plan, spans };
        result.push(segment);
      }
    }
  }
  for (const window of result) {
    if (window.activity) continue;
    const plans = [...new Set(window.readings.flatMap(row => {
      const plan = meterPlan(row.plan) ?? resolvedPlans.get(readingKey(row.ts, row.percent));
      return plan ? [plan] : [];
    }))];
    if (plans.length !== 1) continue;
    const initial = [{ start: window.start, end: window.end }];
    // Direct meter readings can supersede a lagging account-plan projection.
    const changes = observedPlans.map((period, i) => ({ plan: meterPlan(period.value)!, priority: 0,
      at: Date.parse(switchAt(meterPlan(period.value)!, observedPlans[i - 1]?.lastSeen ?? observedPlans[i - 1]?.from ?? window.start, period.from)) }));
    changes.push(...window.readings.flatMap(row => meterPlan(row.plan)
      ? [{ plan: meterPlan(row.plan)!, priority: 1, at: Date.parse(row.ts) }] : []));
    changes.sort((a, b) => a.at - b.at || a.priority - b.priority);
    let selected = plans[0]!, cursor = Date.parse(window.start);
    const end = Date.parse(window.end), selectedSpans: WindowActivity["spans"] = [];
    for (const change of changes) {
      if (change.at >= end) break;
      if (change.at <= cursor) { selected = change.plan; continue; }
      if (change.plan === selected) continue;
      if (selected === plans[0]) selectedSpans.push({ start: new Date(cursor).toISOString(), end: new Date(change.at).toISOString() });
      cursor = change.at; selected = change.plan;
    }
    if (selected === plans[0]) selectedSpans.push({ start: new Date(cursor).toISOString(), end: window.end });
    const spans = withoutUnpaidGaps(selectedSpans);
    const witnessed = observedPlans.some(period => meterPlan(period.value) === plans[0]
      && Date.parse(period.from) <= Date.parse(window.lastInput.ts)
      && (!period.until || Date.parse(period.until) > Date.parse(window.lastInput.ts)));
    const dated = probeWindowPlan(index, own, provider, account, window.start, window.end).plan;
    if (JSON.stringify(spans) !== JSON.stringify(initial) || witnessed && dated !== plans[0])
      window.activity = { plan: plans[0]!, spans };
  }
  for (const window of result) {
    // A declared cancellation ends the remaining unobserved part, never erases a later real reading.
    const initial = window.activity?.spans ?? [{ start: window.start, end: window.end }];
    let spans = withoutUnpaidGaps(initial);
    const lastAt = Date.parse(window.readings.at(-1)!.ts);
    const ending = own.filter(period => period.origin === "declared" && period.until !== null
      && Date.parse(period.from) <= lastAt && Date.parse(period.until) > lastAt && Date.parse(period.until) < Date.parse(window.end)
      && [null, "none"].includes(index?.resolve(provider, account, period.until).value ?? null))
      .map(period => Date.parse(period.until!)).sort((a, b) => a - b)[0];
    if (ending !== undefined) spans = spans.map(span => ({ ...span, end: new Date(Math.min(Date.parse(span.end), ending)).toISOString() }))
      .filter(span => Date.parse(span.start) < Date.parse(span.end));
    if (JSON.stringify(spans) !== JSON.stringify(initial)) window.activity = { ...window.activity,
      plan: window.activity?.plan ?? probeWindowPlan(index, own, provider, account, window.start, window.end).plan, spans };
    const activity = window.activity;
    if (!activity?.spans.length) continue;
    const start = Date.parse(window.start), nominalStart = Date.parse(window.reset) - window.window_minutes * 60_000;
    const first = window.readings[0];
    if (activity.start_basis !== "partial" && !window.startDrop && first && start < Date.parse(first.ts) && Date.parse(activity.spans[0]!.start) === start) {
      if (Math.abs(start - nominalStart) < RESET_JOIN_MS) activity.start_basis = "reset";
      else if (activity.plan !== null && own.some(period => period.origin === "declared" && meterPlan(period.value) === activity.plan
        && Date.parse(period.from) === start)) activity.start_basis = "activation";
    }
    // Keep the provider reset for meter identity, but end this window when its plan stopped being selected.
    const lastEnd = activity.spans.at(-1)!.end;
    if (Date.parse(lastEnd) < Date.parse(window.end)) {
      window.end = lastEnd;
      window.cycle_end_basis = "plan_change";
    }
  }
  return result.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

