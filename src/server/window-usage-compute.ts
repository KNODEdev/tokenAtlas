import type { WindowUsage, CodexComparisonWindow } from "../shared/codex-accounting";
import type { MeterEvent, MeterExclusion, MeterWindowObserver } from "./subscription-window-comparison";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { registerWindowShell, meterWindowCuts, emptyWindowUsage, populateMeterWindows } from "./subscription-window-comparison";
import type { WindowTraffic, WindowSums, WindowCuts, WindowModelTraffic, WindowEventFacts, WindowRailSums, ActivityCurve, ModelSpend, ProductTotals, WindowSlice, WindowReadingSums } from "./window-usage-contracts";
import type { WindowCreditSums, WindowAtLimit, CreditFundedSums, CreditFundedHour } from "../shared/credit-funded";
import { LIMIT_PERCENT } from "../shared/credit-funded";
import { emptySpend, emptyTokens, emptyRunning, runningKeys, spendList } from "./window-usage-values";
import type { TokenVector } from "./plans-catalog";
import type { ModelCapacityReading, ModelCapacityUsage } from "../shared/model-capacity";
import { modelCapacitySamples } from "../shared/model-capacity";

function addUsage(target: WindowUsage, item: WindowUsage): void {
  for (const [key, value] of Object.entries(item) as Array<[keyof WindowUsage, number | undefined]>)
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
}

/**
 * The canonical sums of one window. `earlier` are the windows of the same account and counter that
 * precede it; the first chronological cycle owns traffic they share. `events` are the account's
 * canonical events of the window's cycle. With `timeline` the comparison window also carries the
 * cycle's time axis (a bounded detail read).
 */
export function computeWindowSums<Event extends MeterEvent>(window: ProbeLimitWindow, earlier: readonly ProbeLimitWindow[],
  events: readonly Event[], traffic: WindowTraffic<Event>, timeline = false): { comparison: CodexComparisonWindow; sums: WindowSums } {
  const minutes = window.window_minutes;
  const shell = registerWindowShell(window, minutes, timeline ? window.id : undefined);
  const start = Date.parse(window.start), end = Date.parse(window.end);
  const overlapping = earlier.filter(other => Date.parse(other.end) > start && Date.parse(other.start) < end)
    .map(other => registerWindowShell(other, minutes));
  // Earlier windows come first: an event goes to the first window whose cycle contains it.
  const placed = placeEvents(shell, [...overlapping, shell], events, traffic);
  const sums = summarizeSpan(shell, placed, traffic, start, end, window.readings);
  return { comparison: sums.cycle.credit_funded ? { ...shell, credit_funded: sums.cycle.credit_funded } : shell, sums };
}

export function windowCuts(window: ProbeLimitWindow, earlier: readonly ProbeLimitWindow[]): WindowCuts {
  const start = Date.parse(window.start), end = Date.parse(window.end), minutes = window.window_minutes;
  const shells = [...earlier.filter(other => Date.parse(other.end) > start && Date.parse(other.start) < end), window]
    .map(other => registerWindowShell(other, minutes));
  return { instants: [start, end, ...shells.flatMap(meterWindowCuts), ...window.readings.map(reading => Date.parse(reading.ts) + 1)]
    .sort((a, b) => a - b), activity: { start, end } };
}

type Counted<Event> = { time: number; event: Event; item: WindowUsage; paired: boolean };

type Excluded = Map<string, { reason: MeterExclusion; model: string | null; usage: WindowUsage }>;

/** Adds one call (counted when `reason` is null) to the cycle's traffic by model. */
function addModel(byModel: Map<string, WindowModelTraffic>, reason: MeterExclusion | null, item: WindowUsage, facts: WindowEventFacts): void {
  const key = JSON.stringify([reason, facts.model]);
  const row = byModel.get(key) ?? { model: facts.model, excluded: reason, calls: 0, input: 0, cached: 0, cache_write: 0, output: 0,
    reasoning: 0, api_standard: 0, unpriced_tokens: 0 };
  row.calls += item.events; row.input += item.input; row.cached += item.cached; row.output += item.output;
  row.cache_write += facts.tokens.in_cache_write_5m + facts.tokens.in_cache_write_1h; row.reasoning += facts.reasoning;
  if (facts.api_standard === null) row.unpriced_tokens += item.tokens; else row.api_standard += facts.api_standard;
  if (facts.reported !== undefined) {
    row.reported_usd = (row.reported_usd ?? 0) + (facts.reported ?? 0);
    row.reported_missing = (row.reported_missing ?? 0) + (facts.reported === null ? 1 : 0);
  }
  byModel.set(key, row);
}

/** Places the events among the shells and keeps what `shell` counts and leaves out, in time order. */
type Funded<Event> = { time: number; event: Event; item: WindowUsage; fact: WindowEventFacts };

export function placeEvents<Event extends MeterEvent>(shell: CodexComparisonWindow, shells: CodexComparisonWindow[], events: readonly Event[],
  traffic: WindowTraffic<Event>): { counted: Array<Counted<Event>>; excluded: Excluded; byModel: Map<string, WindowModelTraffic>;
    funded: Array<Funded<Event>> } {
  const counted: Array<Counted<Event>> = [];
  const excluded: Excluded = new Map();
  const byModel = new Map<string, WindowModelTraffic>();
  const funded: Array<Funded<Event>> = [];
  const observer: MeterWindowObserver<Event> = {
    counted: (target, event, item, paired) => { if (target === shell) counted.push({ time: Date.parse(event.ts), event, item, paired }); },
    excluded: (target, event, reason, item) => {
      if (target !== shell) return;
      const key = JSON.stringify([reason, event.model]);
      const bucket = excluded.get(key) ?? { reason, model: event.model, usage: emptyWindowUsage() };
      addUsage(bucket.usage, item); excluded.set(key, bucket);
      const fact = traffic.facts(event);
      addModel(byModel, reason, item, fact);
      if (reason === "funding" && fact.credit_funded) funded.push({ time: Date.parse(event.ts), event, item, fact });
    },
  };
  populateMeterWindows(shells, [...events], traffic.adapter, observer);
  counted.sort((a, b) => a.time - b.time);
  funded.sort((a, b) => a.time - b.time);
  return { counted, excluded, byModel, funded };
}

/** Credits, the sums at the limit and the credit-funded calls of a Codex cycle (`WindowRailSums`). */
function unitSums<Event extends MeterEvent>(counted: ReadonlyArray<Counted<Event>>, facts: readonly WindowEventFacts[],
  funded: ReadonlyArray<Funded<Event>>, spanReadings: ProbeLimitWindow["readings"]): Pick<WindowRailSums, "credits" | "at_limit" | "credit_funded"> {
  const credits: WindowCreditSums = { standard: 0, unpriced_calls: 0 };
  counted.forEach(({ item }, index) => {
    const value = facts[index]!.credits_standard;
    if (value == null) credits.unpriced_calls += item.events; else credits.standard += value;
  });
  // The first reading at the limit; counted calls at its instant belong to it, as in the running sums.
  const limit = [...spanReadings].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).find(reading => reading.percent >= LIMIT_PERCENT);
  let atLimit: WindowAtLimit | null = null;
  if (limit) {
    const at = Date.parse(limit.ts);
    atLimit = { ts: limit.ts, percent: limit.percent, events: 0, tokens: 0, api_standard: 0, api_unpriced: 0, credits: 0, credits_unpriced: 0,
      joint_api_standard: 0, joint_credits: 0 };
    counted.forEach(({ time, item }, index) => {
      if (time > at) return;
      const fact = facts[index]!;
      atLimit!.events += item.events; atLimit!.tokens += item.tokens;
      if (fact.api_standard === null) atLimit!.api_unpriced += item.events; else atLimit!.api_standard += fact.api_standard;
      if (fact.credits_standard == null) atLimit!.credits_unpriced += item.events; else atLimit!.credits += fact.credits_standard;
      // Calls priced in both units: their ratio is the window's dollars per credit, whatever the rest leaves unpriced.
      if (fact.api_standard !== null && fact.credits_standard != null) { atLimit!.joint_api_standard += fact.api_standard; atLimit!.joint_credits += fact.credits_standard; }
    });
  }
  return { credits, at_limit: atLimit, credit_funded: creditFundedSums(funded) };
}

/** The calls a provider billed from credits rather than the plan (Codex credits, a Claude promotional grant), by hour. */
function creditFundedSums<Event extends MeterEvent>(funded: ReadonlyArray<Funded<Event>>): CreditFundedSums | null {
  let creditFunded: CreditFundedSums | null = null;
  if (funded.length) {
    const sums: CreditFundedSums = { calls: 0, tokens: 0, credits: 0, credits_unpriced: 0, api_standard: 0, api_unpriced: 0,
      first: funded[0]!.event.ts, last: funded[0]!.event.last_ts ?? funded[0]!.event.ts, hours: [] };
    const hours = new Map<string, CreditFundedHour>();
    for (const { time, event, item, fact } of funded) {
      sums.calls += item.events; sums.tokens += item.tokens;
      if (fact.credits_standard == null) sums.credits_unpriced += item.events; else sums.credits += fact.credits_standard;
      if (fact.api_standard === null) sums.api_unpriced += item.events; else sums.api_standard += fact.api_standard;
      const last = event.last_ts ?? event.ts;
      if (Date.parse(last) > Date.parse(sums.last)) sums.last = last;
      const hour = new Date(Math.floor(time / 3_600_000) * 3_600_000).toISOString();
      const row = hours.get(hour) ?? [hour, 0, 0, 0, 0];
      row[1] += item.events; row[2] += item.tokens; row[3] += fact.credits_standard ?? 0; row[4] += fact.api_standard ?? 0;
      hours.set(hour, row);
    }
    sums.hours = [...hours.values()].sort((a, b) => a[0].localeCompare(b[0]));
    creditFunded = sums;
  }
  return creditFunded;
}

/** Cumulative amounts at quarter percents of `[start, end]`, as the rail draws them; empty without traffic. */
function activityCurve(points: ReadonlyArray<readonly [number, number]>, start: number, end: number): ActivityCurve {
  if (!points.length || !(end > start)) return [];
  const curve = new Map<number, number>([[0, 0]]);
  for (const [time, amount] of points) curve.set(Math.max(0, Math.min(100, Math.floor((time - start) / (end - start) * 400) / 4)), amount);
  curve.set(100, points.at(-1)![1]);
  return [...curve].sort((a, b) => a[0] - b[0]).map(([t, amount]) => ({ t, amount }));
}

function addSpend(target: Map<string, ModelSpend>, facts: WindowEventFacts, tokens: number): void {
  const key = JSON.stringify(facts.model);
  const spend = target.get(key) ?? emptySpend(facts.model);
  spend.events++; spend.tokens += tokens; spend.fresh += facts.tokens.in_uncached + facts.tokens.out_total;
  if (facts.api_standard === null) spend.standard_unpriced++; else spend.standard += facts.api_standard;
  if (facts.api_actual == null) spend.actual_unpriced++; else spend.actual += facts.api_actual;
  target.set(key, spend);
}

export const emptyProductTotals = (): ProductTotals => ({ code_events: 0, code_tokens: 0, code_api_usd: 0, code_unpriced_events: 0,
  other_product_events: 0, unknown_events: 0, conflicting_product_events: 0, duplicate_copies: 0, conflicting_usage_identities: 0 });

function addProduct(target: ProductTotals, facts: WindowEventFacts, tokens: number): void {
  const product = facts.product ?? "unknown";
  if (product === "other_product") target.other_product_events++;
  else if (product === "conflict") target.conflicting_product_events++;
  else if (product !== "code_cli") target.unknown_events++;
  if (product !== "code_cli") return;
  target.code_events++; target.code_tokens += tokens;
  if (facts.api_standard === null) target.code_unpriced_events++; else target.code_api_usd += facts.api_standard;
}

/** The stored sums of a span from what it counts: rail fields, running sums at the readings, hourly slices. */
export function summarizeSpan<Event extends MeterEvent>(shell: CodexComparisonWindow, placed: ReturnType<typeof placeEvents<Event>>,
  traffic: WindowTraffic<Event>, start: number, end: number, spanReadings: ProbeLimitWindow["readings"]): WindowSums {
  const { counted, excluded } = placed, claude = traffic.claude;
  const facts = counted.map(entry => traffic.facts(entry.event));
  let tokens = 0, api = 0, unpriced = 0, scopedTokens = 0;
  const unpricedGroups = new Map<string, { model: string | null; day: string; tokens: number }>();
  const points: Array<[number, number]> = [], scopedPoints: Array<[number, number]> = [];
  const scopedSources = new Map<string, { name: string; first: string; tokens: number }>();
  const railSources = new Map<string, { name: string; first: string; tokens: number }>();
  const addSource = (target: typeof railSources, event: Event, tokens: number) => {
    const name = (event as { source?: string | null }).source ?? event.home ?? "nieznane źródło";
    const source = target.get(name) ?? { name, first: event.ts, tokens: 0 };
    source.tokens += tokens; target.set(name, source);
  };
  const days = new Set<string>();
  const hours = new Map<string, number>();
  const slices = new Map<string, WindowSlice>();
  const cycleSpend = new Map<string, ModelSpend>();
  const bySurface = new Map<string, WindowRailSums["by_surface"][number]>();
  let reported: WindowRailSums["reported"];
  let sessions: Set<string> | undefined;
  counted.forEach(({ time, event, item, paired }, index) => {
    const fact = facts[index]!;
    tokens += item.tokens;
    if (fact.session !== undefined) {
      sessions ??= new Set();
      if (fact.session !== null) sessions.add(fact.session);
    }
    if (fact.reported !== undefined) {
      reported ??= { usd: 0, missing: 0 };
      if (fact.reported === null) reported.missing++; else reported.usd += fact.reported;
    }
    addModel(placed.byModel, null, item, fact);
    const surface = bySurface.get(fact.surface ?? "") ?? { surface: fact.surface, calls: 0, tokens: 0, fresh: 0, api_standard: 0 };
    surface.calls += item.events; surface.tokens += item.tokens; surface.fresh += item.tokens - item.cached;
    surface.api_standard += fact.api_standard ?? 0; bySurface.set(fact.surface ?? "", surface);
    const day = new Date(time).toISOString().slice(0, 10);
    days.add(day);
    if (fact.api_standard === null) {
      unpriced += item.tokens;
      const key = JSON.stringify([event.model, event.ts.slice(0, 10)]);
      const group = unpricedGroups.get(key) ?? { model: event.model, day: event.ts.slice(0, 10), tokens: 0 };
      group.tokens += item.tokens; unpricedGroups.set(key, group);
    } else api += fact.api_standard;
    points.push([time, tokens]);
    addSource(railSources, event, item.tokens);
    if (claude) {
      addSpend(cycleSpend, fact, item.tokens);
      if (claude.scoped(event.model)) {
        scopedTokens += item.tokens; scopedPoints.push([time, scopedTokens]);
        addSource(scopedSources, event, item.tokens);
      }
    }
    const hour = new Date(Math.floor(time / 3_600_000) * 3_600_000).toISOString(), key = JSON.stringify([fact.model, fact.speed, hour, paired]);
    hours.set(hour, (hours.get(hour) ?? 0) + item.tokens);
    const slice = slices.get(key) ?? { model: fact.model, speed: fact.speed, hour, paired, tokens: emptyTokens(),
      ...(claude ? { code: emptyTokens() } : {}) };
    for (const type of Object.keys(slice.tokens) as Array<keyof TokenVector>) {
      slice.tokens[type] += fact.tokens[type];
      if (slice.code && fact.product === "code_cli") slice.code[type] += fact.tokens[type];
    }
    slices.set(key, slice);
  });

  const readings: WindowReadingSums[] = [];
  const running = emptyRunning(), seenHomes = new Set<string>(), seenModels = new Set<string | null>(), seenDays = new Set<string>();
  const products = emptyProductTotals();
  const copies = claude ? claude.copies.map(copy => ({ ...copy, time: Date.parse(copy.ts) }))
    .filter(copy => copy.time >= start && copy.time < end && (!shell.activity
      || shell.activity.spans.some(span => copy.time >= Date.parse(span.start) && copy.time < Date.parse(span.end))))
    .sort((a, b) => a.time - b.time) : [];
  const modelReadings: ModelCapacityReading[] = [];
  let next = 0, nextCopy = 0;
  for (const reading of [...spanReadings].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const at = Date.parse(reading.ts), homes: string[] = [], models: Array<string | null> = [];
    const spend = new Map<string, ModelSpend>(), newDays: string[] = [];
    const measuredModels = new Map<string | null, ModelCapacityUsage>();
    for (; next < counted.length && counted[next]!.time <= at; next++) {
      const { event, item, time } = counted[next]!;
      const measured = measuredModels.get(event.model) ?? { model: event.model, events: 0, tokens: 0, api_usd: 0,
        unpriced_events: 0, unknown_mode_tokens: 0, fast_tokens: 0 };
      measured.events += item.events; measured.tokens += item.tokens; measured.api_usd += item.api_standard;
      measured.unpriced_events += item.unpriced_events; measured.unknown_mode_tokens += item.unknown_tokens;
      measured.fast_tokens += item.fast_tokens; measuredModels.set(event.model, measured);
      for (const key of runningKeys) if (item[key] !== undefined) running[key] = (running[key] ?? 0) + item[key]!;
      if (event.home && !seenHomes.has(event.home)) { seenHomes.add(event.home); homes.push(event.home); }
      if (!seenModels.has(event.model)) { seenModels.add(event.model); models.push(event.model); }
      if (!claude) continue;
      addSpend(spend, facts[next]!, item.tokens);
      addProduct(products, facts[next]!, item.tokens);
      const day = new Date(time).toISOString().slice(0, 10);
      if (!seenDays.has(day)) { seenDays.add(day); newDays.push(day); }
    }
    for (; nextCopy < copies.length && copies[nextCopy]!.time <= at; nextCopy++) {
      products.duplicate_copies += copies[nextCopy]!.duplicates;
      if (copies[nextCopy]!.conflict) products.conflicting_usage_identities++;
    }
    readings.push({ ts: reading.ts, usage: { ...running }, homes, models,
      ...(claude ? { spend: spendList(spend), days: newDays, products: { ...products } } : {}) });
    modelReadings.push({ ts: reading.ts, percent: reading.percent, models: [...measuredModels.values()] });
  }
  // Codex keeps its credit-funded calls on the rail (`unitSums`); elsewhere they are a promotional credit the list names.
  const funded = traffic.units ? null : creditFundedSums(placed.funded);
  return {
    cycle: { usage: shell.usage, cycle_usage: shell.cycle_usage!, unpaired_events: shell.unpaired_events ?? 0,
      ...(funded ? { credit_funded: { calls: funded.calls, tokens: funded.tokens, api_standard: funded.api_standard,
        api_unpriced: funded.api_unpriced, first: funded.first, last: funded.last } } : {}),
      ...(traffic.units || claude ? { model_capacity: { ...modelCapacitySamples(modelReadings),
        uncertain_events: [...excluded.values()].filter(row => row.reason === "imprecise_time").reduce((sum, row) => sum + row.usage.events, 0) } } : {}),
      sources: shell.sources, models: shell.models,
      evidence: { sources: shell.evidence!.sources, excluded_events: shell.evidence!.excluded_events },
      excluded: [...excluded.values()].sort((a, b) => a.reason.localeCompare(b.reason) || (a.model ?? "").localeCompare(b.model ?? "")),
      ...(claude ? { spend: spendList(cycleSpend) } : {}) },
    rail: { tokens, api_standard: api, unpriced_tokens: unpriced,
      unpriced_groups: [...unpricedGroups.values()].sort((a, b) => a.day.localeCompare(b.day) || (a.model ?? "").localeCompare(b.model ?? "")),
      activity: activityCurve(points, start, end),
      by_model: [...placed.byModel.values()].sort((a, b) => (a.excluded ?? "").localeCompare(b.excluded ?? "") || b.calls - a.calls
        || (a.model ?? "").localeCompare(b.model ?? "")),
      by_surface: [...bySurface.values()].sort((a, b) => b.tokens - a.tokens || (a.surface ?? "").localeCompare(b.surface ?? "")),
      days: [...days].sort(),
      hours: [...hours].sort(([a], [b]) => a.localeCompare(b)),
      sources: [...railSources.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)),
      ...(claude ? { scoped: { tokens: scopedTokens, activity: activityCurve(scopedPoints, start, end),
        sources: [...scopedSources.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)) } } : {}),
      ...(reported ? { reported } : {}), ...(sessions ? { sessions: sessions.size } : {}),
      ...(claude?.unowned ? { unowned: claude.unowned() } : {}),
      ...(traffic.units ? unitSums(counted, facts, placed.funded, spanReadings)
        : placed.funded.length ? { credit_funded: creditFundedSums(placed.funded) } : {}) },
    readings,
    slices: [...slices.values()].sort((a, b) => a.hour.localeCompare(b.hour) || (a.model ?? "").localeCompare(b.model ?? "")
      || a.speed.localeCompare(b.speed) || Number(a.paired) - Number(b.paired)),
  };
}
