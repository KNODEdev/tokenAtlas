import type { UnpricedModel } from "../shared/missing-rate";
import type { WindowModelTraffic, WindowCycleSums, WindowReadingSums, WindowSums, ContextRunningUsage, ModelSpend, WindowRailSums, ClaudeHourBlock } from "./window-usage-contracts";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import type { CodexComparisonWindow } from "../shared/codex-accounting";
import { registerWindowShell } from "./subscription-window-comparison";
import { emptyRunning, runningKeys, emptySpend, spendList } from "./window-usage-values";

/** The counted traffic's unpriced tokens per model, largest first; empty when every counted call is priced. */
export function unpricedModels(byModel: readonly WindowModelTraffic[]): UnpricedModel[] {
  const tokens = new Map<string, number>();
  for (const row of byModel) if (row.excluded === null && row.unpriced_tokens > 0)
    tokens.set(row.model ?? "?", (tokens.get(row.model ?? "?") ?? 0) + row.unpriced_tokens);
  return [...tokens].map(([model, value]) => ({ model, tokens: value })).sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
}

/** A stored window and its stored cycle sums as the comparison window the accounting screens show. */
export function comparisonWindow(window: ProbeLimitWindow, cycle: WindowCycleSums): CodexComparisonWindow {
  const shell = registerWindowShell(window, window.window_minutes);
  return { ...shell, usage: cycle.usage, cycle_usage: cycle.cycle_usage, unpaired_events: cycle.unpaired_events,
    sources: cycle.sources, models: cycle.models,
    evidence: { ...shell.evidence!, sources: cycle.evidence.sources, excluded_events: cycle.evidence.excluded_events },
    ...(cycle.credit_funded ? { credit_funded: cycle.credit_funded } : {}) };
}

/**
 * Totals of the counted traffic of one window after reading `from` up to and including reading `to`
 * (`(from, to]`), with the sources and models first seen in it. A null `from` is the cycle start and a
 * null `to` the cycle end (the stored cycle total). Both instants are readings of the window; an
 * unknown one returns null.
 */
/** The first index of each reading instant of a window's readings, built once per readings list (a calibration asks for many intervals). */
const readingPositions = new WeakMap<readonly WindowReadingSums[], Map<string, number>>();

function readingPosition(readings: readonly WindowReadingSums[], ts: string): number {
  let positions = readingPositions.get(readings);
  if (!positions) {
    positions = new Map();
    readings.forEach((reading, index) => { if (!positions!.has(reading.ts)) positions!.set(reading.ts, index); });
    readingPositions.set(readings, positions);
  }
  return positions.get(ts) ?? -1;
}

export function intervalSums(window: Pick<WindowSums, "readings"> & { cycle: Pick<WindowCycleSums, "cycle_usage"> },
  from: string | null, to: string | null): { usage: ContextRunningUsage; homes: string[]; models: Array<string | null> } | null {
  const readings = window.readings;
  const first = from === null ? -1 : readingPosition(readings, from);
  const last = to === null ? readings.length : readingPosition(readings, to);
  if (from !== null && first < 0 || to !== null && last < 0 || last < first) return null;
  const base = first < 0 ? emptyRunning() : readings[first]!.usage;
  const end = last >= readings.length ? window.cycle.cycle_usage : readings[last]!.usage;
  const usage = emptyRunning(), homes = new Set<string>(), models = new Set<string | null>();
  for (const key of runningKeys) usage[key] = (end[key] ?? 0) - (base[key] ?? 0);
  // Sources and models first seen after `from`; one seen earlier in the cycle and again inside is not listed.
  for (const reading of readings.slice(first + 1, last + 1)) { reading.homes.forEach(home => homes.add(home)); reading.models.forEach(model => models.add(model)); }
  return { usage, homes: [...homes].sort(), models: [...models] };
}

/** One total of model spends, optionally of the models `pick` accepts. */
export function totalSpend(spends: Iterable<ModelSpend>, pick?: (model: string | null) => boolean): ModelSpend {
  const total = emptySpend(null);
  for (const spend of spends) {
    if (pick && !pick(spend.model)) continue;
    for (const key of ["events", "tokens", "fresh", "standard", "standard_unpriced", "actual", "actual_unpriced"] as const) total[key] += spend[key];
  }
  return total;
}

/** The index of the last stored reading at or before an instant; -1 before the first. */
export function readingIndexAt(readings: readonly WindowReadingSums[], instantMs: number): number {
  let found = -1;
  readings.forEach((reading, index) => { if (Date.parse(reading.ts) <= instantMs) found = index; });
  return found;
}

/**
 * Counted tokens of a stored span per local calendar day (the day axis of the window chart), from its hourly
 * sums; null for a row stored before the hours existed. Days without traffic are left out. Exact in whole-hour
 * time zones, where every local day starts on a UTC hour.
 */
export function tokensByLocalDay(rail: Pick<WindowRailSums, "hours">): Array<{ date: string; tokens: number }> | null {
  if (!rail.hours) return null;
  const byDay = new Map<string, number>();
  for (const [hour, tokens] of rail.hours) {
    const d = new Date(hour);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    byDay.set(date, (byDay.get(date) ?? 0) + tokens);
  }
  return [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, tokens]) => ({ date, tokens }));
}

/**
 * Claude: the window's hourly tokens with a dollar value from the stored sums, never repriced. Each hour takes
 * the dollars per token of the reading interval its start falls in; the interval after the newest reading
 * takes the rest of the cycle total. Null for a row stored before the hours existed.
 */
export function claudeHourBlocks(rail: Pick<WindowRailSums, "hours">, readings: readonly WindowReadingSums[],
  cycle: readonly ModelSpend[]): ClaudeHourBlock[] | null {
  if (!rail.hours) return null;
  const sum = (spends: readonly ModelSpend[]) => spends.reduce((total, spend) => ({ tokens: total.tokens + spend.tokens,
    usd: total.usd + spend.actual, unpriced: total.unpriced + spend.actual_unpriced }), { tokens: 0, usd: 0, unpriced: 0 });
  const intervals: Array<{ end: number; tokens: number; usd: number; unpriced: number }> = [];
  const counted = { tokens: 0, usd: 0, unpriced: 0 };
  for (const reading of [...readings].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const part = sum(reading.spend ?? []);
    counted.tokens += part.tokens; counted.usd += part.usd; counted.unpriced += part.unpriced;
    intervals.push({ end: Date.parse(reading.ts), ...part });
  }
  const total = sum(cycle);
  intervals.push({ end: Infinity, tokens: total.tokens - counted.tokens, usd: total.usd - counted.usd, unpriced: total.unpriced - counted.unpriced });
  return [...rail.hours].sort(([a], [b]) => a.localeCompare(b)).map(([hour, tokens]) => {
    const start = Date.parse(hour);
    const interval = intervals.find(item => start < item.end)!;
    const rate = interval.tokens > 0 ? Math.max(0, interval.usd) / interval.tokens : 0;
    return { start_ts: hour, end_ts: new Date(start + 3_600_000).toISOString(), tokens,
      usd: Math.round(tokens * rate * 10_000) / 10_000, ...(interval.unpriced > 0 ? { usd_partial: true as const } : {}) };
  });
}

/** Claude: counted spend per model from the cycle start through reading `index`, and the days it fell on. */
export function spendThroughReading(readings: readonly WindowReadingSums[], index: number): { spend: ModelSpend[]; days: string[] } {
  const byModel = new Map<string, ModelSpend>(), days: string[] = [];
  for (const reading of readings.slice(0, index + 1)) {
    days.push(...reading.days ?? []);
    for (const spend of reading.spend ?? []) {
      const key = JSON.stringify(spend.model), total = byModel.get(key) ?? emptySpend(spend.model);
      for (const field of ["events", "tokens", "fresh", "standard", "standard_unpriced", "actual", "actual_unpriced"] as const) total[field] += spend[field];
      byModel.set(key, total);
    }
  }
  return { spend: spendList(byModel), days };
}
