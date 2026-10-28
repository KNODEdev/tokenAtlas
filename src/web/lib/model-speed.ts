/**
 * The Speed screen's arithmetic over /api/model-speed day rows (docs/design/model-speed-mockup.html). Every speed is a
 * ratio of sums (`out * 1000 / ms` over the summed calls), never an average of daily speeds.
 */
import type { TimeRangeDays } from "../../shared/time-range-presets";
import { firstTokenSummary, mergeFirstToken, type FirstTokenSamples } from "../../shared/first-token";
import { executionKey, type ModelExecution } from "../../shared/model-execution";

export interface ModelSpeedPoint {
  first_token?: FirstTokenSamples;
  at: string;
  calls: number; timed_calls: number; timed_out: number; timed_ms: number; speed: number | null;
  long_calls: number; long_out: number; long_ms: number; long_speed: number | null;
  coverage: number | null;
}
export interface ModelSpeedSeries extends Partial<ModelExecution> { model: string | null; total: ModelSpeedPoint; points: ModelSpeedPoint[] }
export const speedSeriesKey = (series: ModelSpeedSeries): string => series.speed === undefined ? series.model ?? "" : executionKey(series.model, series);
export function executionSuffix(series: ModelSpeedSeries, unknown: string, mixed: string, unknownEffort: string): string {
  if (series.speed === undefined) return "";
  const speed = series.speed === "mixed" ? mixed : series.speed.startsWith("unknown:") ? `${unknown} (${series.speed.slice(8)})`
    : series.speed === "unknown" ? unknown : series.speed;
  return ` · ${speed} · ${series.effort ?? unknownEffort}`;
}
export interface ModelSpeedResponse {
  account: string; provider: SpeedProvider; grain: "day" | "hour"; since: string | null; until: string | null;
  first_token_pending?: boolean;
  speed_pending?: boolean;
  long_out_min: number; models: ModelSpeedSeries[];
}
export type SpeedKind = "long" | "all";
export type SpeedGrain = "day" | "week";
export type SpeedChartMetric = "speed" | "first-token-median" | "first-token-p90";
/** The period the whole report covers, in UTC days, or the whole history. */
export type SpeedRange = `${TimeRangeDays}d` | "all";

/** Claude Code's placeholder for a message it wrote itself (0 output tokens): not a model. */
export const SYNTHETIC_MODEL = "<synthetic>";
/** The models the screen shows (tiles, chart, legend, table): named models only, never the placeholder. */
export function speedModels(models: readonly ModelSpeedSeries[]): ModelSpeedSeries[] {
  return models.filter(series => series.model !== null && series.model !== SYNTHETIC_MODEL);
}

/** A chart point needs this many calls of the selected kind in its bucket. */
export const MIN_POINT_CALLS = 5;
/** Only models with this many calls of the selected kind are ranked fastest or slowest. */
export const MIN_RANKED_CALLS = 50;
/** A model whose median is more than this many times the next one's is drawn clipped at the top. */
export const OUTLIER_RATIO = 2.5;
/** Points further apart than this many buckets are not joined by a line. */
export const GAP_BUCKETS = 1.5;
const DAY_MS = 86_400_000;

/** The Monday (UTC) that starts the week of a UTC day. */
export function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export function bucketMs(grain: SpeedGrain): number {
  return grain === "week" ? 7 * DAY_MS : DAY_MS;
}

export interface SpeedBucket {
  at: string;
  /** All calls and those with a known time, whatever their length. */
  calls: number; timed: number;
  /** Timed calls of the selected kind and their sums. */
  n: number; out: number; ms: number;
  speed: number | null;
}
/** Day rows summed into day or week buckets, then one speed per bucket from the sums. */
export function speedBuckets(points: readonly ModelSpeedPoint[], grain: SpeedGrain, kind: SpeedKind): SpeedBucket[] {
  const buckets = new Map<string, SpeedBucket>();
  for (const point of points) {
    const at = grain === "week" ? weekStart(point.at) : point.at;
    const bucket = buckets.get(at) ?? { at, calls: 0, timed: 0, n: 0, out: 0, ms: 0, speed: null };
    bucket.calls += point.calls; bucket.timed += point.timed_calls;
    bucket.n += kind === "long" ? point.long_calls : point.timed_calls;
    bucket.out += kind === "long" ? point.long_out : point.timed_out;
    bucket.ms += kind === "long" ? point.long_ms : point.timed_ms;
    buckets.set(at, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
    .map(bucket => ({ ...bucket, speed: bucket.ms > 0 ? bucket.out * 1000 / bucket.ms : null }));
}
/** The buckets the chart draws: a speed from at least `MIN_POINT_CALLS` calls. */
export function chartBuckets(points: readonly ModelSpeedPoint[], grain: SpeedGrain, kind: SpeedKind): Array<SpeedBucket & { speed: number }> {
  return speedBuckets(points, grain, kind).filter((bucket): bucket is SpeedBucket & { speed: number } =>
    bucket.speed !== null && bucket.n >= MIN_POINT_CALLS);
}
/** The latency chart merges raw frequencies before computing each day's/week's percentile. */
export function modelChartBuckets(points: readonly ModelSpeedPoint[], grain: SpeedGrain, kind: SpeedKind, metric: SpeedChartMetric) {
  if (metric === "speed") return chartBuckets(points, grain, kind).map(p => ({ at: p.at, value: p.speed, n: p.n, measured: p.timed, total: p.calls }));
  const buckets = new Map<string, FirstTokenSamples[]>();
  for (const point of points) {
    if (!point.first_token) continue;
    const at = grain === "week" ? weekStart(point.at) : point.at;
    const list = buckets.get(at) ?? []; list.push(point.first_token); buckets.set(at, list);
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).flatMap(([at, samples]) => {
    const summary = firstTokenSummary(mergeFirstToken(samples));
    const ms = metric === "first-token-median" ? summary.median_ms : summary.p90_ms;
    return ms === null ? [] : [{ at, value: ms / 1000, n: summary.measured, measured: summary.measured, total: summary.turns }];
  });
}
/** Latency keeps every measured value on the scale, including slow turns. */
export function firstTokenChartScale(values: readonly number[]): { max: number; step: number } {
  const top = Math.max(0.1, ...values) * 1.05;
  const power = 10 ** Math.floor(Math.log10(top / 5));
  const step = [1, 2, 5, 10].map(n => n * power).find(n => n >= top / 5)!;
  return { max: Math.ceil(top / step) * step, step };
}
/** Whether two consecutive drawn buckets are joined: gaps without traffic stay open. */
export function joined(previousAt: string, at: string, grain: SpeedGrain): boolean {
  return Date.parse(`${at}T00:00:00Z`) - Date.parse(`${previousAt}T00:00:00Z`) <= bucketMs(grain) * GAP_BUCKETS;
}

export interface ModelTotals {
  firstToken?: ReturnType<typeof firstTokenSummary>;
  calls: number; timed: number; longCalls: number;
  long: number | null; all: number | null;
  first: string | null; last: string | null;
}
export function modelTotals(series: ModelSpeedSeries): ModelTotals {
  const { total } = series;
  return { calls: total.calls, timed: total.timed_calls, longCalls: total.long_calls,
    firstToken: firstTokenSummary(total.first_token),
    long: total.long_ms > 0 ? total.long_out * 1000 / total.long_ms : null,
    all: total.timed_ms > 0 ? total.timed_out * 1000 / total.timed_ms : null,
    first: series.points[0]?.at ?? null, last: series.points.at(-1)?.at ?? null };
}
export function totalSpeed(totals: ModelTotals, kind: SpeedKind): number | null {
  return kind === "long" ? totals.long : totals.all;
}
/** Models with enough calls of the kind, fastest first. */
export function rankedModels<T extends { totals: ModelTotals }>(models: readonly T[], kind: SpeedKind): T[] {
  return models.filter(model => totalSpeed(model.totals, kind) !== null
    && (kind === "long" ? model.totals.longCalls : model.totals.timed) >= MIN_RANKED_CALLS)
    .sort((a, b) => totalSpeed(b.totals, kind)! - totalSpeed(a.totals, kind)!);
}
/** All models together in the week of the newest day with traffic. */
export function latestWeek(models: readonly ModelSpeedSeries[], kind: SpeedKind): { week: string; calls: number; speed: number | null } | null {
  const last = models.reduce<string | null>((latest, model) => {
    const at = model.points.at(-1)?.at ?? null;
    return at !== null && (latest === null || at > latest) ? at : latest;
  }, null);
  if (last === null) return null;
  const week = weekStart(last);
  const points = models.flatMap(model => model.points.filter(point => weekStart(point.at) === week));
  const [bucket] = speedBuckets(points, "week", kind);
  return { week, calls: bucket?.n ?? 0, speed: bucket?.speed ?? null };
}
/** The middle drawn speed, the upper one of an even count. */
export function medianSpeed(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
/** The one model drawn above the scale: its median more than `OUTLIER_RATIO` times the next highest median. */
export function outlierSeries(series: ReadonlyArray<{ key: string; values: readonly number[] }>): { key: string; median: number } | null {
  const medians = series.flatMap(item => { const median = medianSpeed(item.values); return median === null ? [] : [{ key: item.key, median }]; })
    .sort((a, b) => b.median - a.median);
  return medians.length > 1 && medians[0]!.median > OUTLIER_RATIO * medians[1]!.median ? medians[0]! : null;
}
/** The top of the scale: the 98th percentile of the drawn speeds with headroom, in tens, at least 20 tok/s. */
export function speedScaleMax(values: readonly number[]): number {
  if (!values.length) return 20;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.max(20, Math.ceil(sorted[Math.floor(sorted.length * 0.98)]! * 1.15 / 10) * 10);
}
export function speedScaleStep(max: number): number {
  return max > 200 ? 100 : max > 80 ? 20 : 10;
}

/** Line patterns of the palette's cycles: models 1–8 solid, 9–16 dashed, 17–24 dotted, then again. */
export const STROKE_DASHES: ReadonlyArray<string | undefined> = [undefined, "6 4", "1.5 3"];
/** The colour and dash of the model at `index` (ordered by calls): a repeated colour gets another pattern. */
export function seriesStroke(index: number, palette: readonly string[]): { color: string; dash: string | undefined } {
  return { color: palette[index % palette.length]!, dash: STROKE_DASHES[Math.floor(index / palette.length) % STROKE_DASHES.length] };
}

/** A model's key for hiding it; a call without a model name has its own. */
export const modelKey = (model: string | null): string => model ?? "";

/**
 * Records keyed by subscription ID: an ID may be any string ("constructor", "__proto__"), so reads take own properties
 * only and writes rebuild the record from its entries instead of assigning to it.
 */
function ownList(record: Readonly<Record<string, string[]>>, key: string): string[] {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key]! : [];
}
function withList(record: Readonly<Record<string, string[]>>, key: string, list: string[] | null): Record<string, string[]> {
  return Object.fromEntries([...Object.entries(record).filter(([id]) => id !== key), ...(list ? [[key, list] as const] : [])]);
}

export const HIDDEN_MODELS_KEY = "tokenatlas.speed.hidden.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const browserStorage = (): Storage | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
};
function readAll(storage: Storage | null): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(HIDDEN_MODELS_KEY) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([account, models]) => [account, Array.isArray(models) ? models.filter((m): m is string => typeof m === "string") : []]));
  } catch { return {}; }
}
/** The models hidden on the chart of one subscription; nothing when storage is unavailable. */
export function readHiddenModels(account: string, storage: Storage | null = browserStorage()): Set<string> {
  return new Set(ownList(readAll(storage), account));
}
export function writeHiddenModels(account: string, hidden: ReadonlySet<string>, storage: Storage | null = browserStorage()): void {
  try {
    storage?.setItem(HIDDEN_MODELS_KEY, JSON.stringify(withList(readAll(storage), account, hidden.size ? [...hidden].sort() : null)));
  } catch { /* The choice still applies for this visit. */ }
}

/* ---- All subscriptions (approved 2026-10-07): one line per model across the chosen subscriptions, or split. ---- */

export type SpeedProvider = "claude" | "codex" | "grok" | "gemini" | "glm";
export function speedProviderOf(vendor: string | null | undefined): SpeedProvider | null {
  const value = (vendor ?? "").toLowerCase();
  return value === "claude" || value === "anthropic" ? "claude" : value === "codex" || value === "openai" ? "codex"
    : value === "grok" || value === "xai" ? "grok" : value === "gemini" ? "gemini" : value === "glm" ? "glm" : null;
}
export interface SpeedSubscription { id: string; provider: SpeedProvider; name: string; label: string; active: boolean }
/**
 * The subscriptions "All" covers on Speed: the Claude and Codex cards of the app's roster, the active ones (the members of
 * its "All" selection) and then the inactive ones it lists under "+ N inactive", each once whatever the case of its ID. A
 * business pool (`codex1::business`) is its own owned scope: the server gives it only the pool's calls and its account
 * none of them, so listing both counts nothing twice.
 */
export function speedSubscriptions(cards: ReadonlyArray<{ id: string; group: string; active: boolean; vendorAccount: string | null }>,
  allId: string): SpeedSubscription[] {
  const seen = new Set<string>(), out: SpeedSubscription[] = [];
  for (const active of [true, false]) for (const card of cards) {
    const provider = speedProviderOf(card.group), key = card.id.toLowerCase();
    if (card.id === allId || card.active !== active || !provider || seen.has(key)) continue;
    seen.add(key);
    const name = card.vendorAccount || card.id;
    out.push({ id: card.id, provider, name, label: `${card.group} / ${name}`, active });
  }
  return out;
}

export interface SpeedPart { account: string; models: readonly ModelSpeedSeries[] }
export interface SpeedEntry { key: string; model: string; accounts: string[]; series: ModelSpeedSeries }
const ADDITIVE = ["calls", "timed_calls", "timed_out", "timed_ms", "long_calls", "long_out", "long_ms"] as const;
function emptyPoint(at: string): ModelSpeedPoint {
  return { at, calls: 0, timed_calls: 0, timed_out: 0, timed_ms: 0, speed: null, long_calls: 0, long_out: 0, long_ms: 0, long_speed: null, coverage: null };
}
function finish(point: ModelSpeedPoint): ModelSpeedPoint {
  return { ...point, speed: point.timed_ms > 0 ? point.timed_out * 1000 / point.timed_ms : null,
    long_speed: point.long_ms > 0 ? point.long_out * 1000 / point.long_ms : null,
    coverage: point.calls > 0 ? point.timed_calls / point.calls : null };
}
const entryKey = (account: string, model: string, split: boolean) => split ? `${account}\u001f${model}` : model;
/**
 * The models of several subscriptions as screen entries: the same model's day rows summed across subscriptions (speed
 * from the summed tokens and time, never an average of their speeds), or with `split` one entry per subscription and model.
 */
export function mergeSpeedParts(parts: readonly SpeedPart[], split: boolean): SpeedEntry[] {
  const entries = new Map<string, { model: string; speed?: string; effort?: string | null; accounts: Set<string>; total: ModelSpeedPoint; points: Map<string, ModelSpeedPoint> }>();
  for (const part of parts) for (const series of speedModels(part.models)) {
    const key = entryKey(part.account, speedSeriesKey(series), split);
    const entry = entries.get(key) ?? { model: series.model!, ...(series.speed !== undefined ? { speed: series.speed, effort: series.effort ?? null } : {}), accounts: new Set<string>(), total: emptyPoint("total"), points: new Map() };
    entries.set(key, entry);
    if (series.total.calls > 0 || series.total.first_token?.turns) entry.accounts.add(part.account);
    for (const field of ADDITIVE) entry.total[field] += series.total[field];
    entry.total.first_token = mergeFirstToken([entry.total.first_token, series.total.first_token]);
    for (const point of series.points) {
      const sum = entry.points.get(point.at) ?? emptyPoint(point.at);
      for (const field of ADDITIVE) sum[field] += point[field];
      sum.first_token = mergeFirstToken([sum.first_token, point.first_token]);
      entry.points.set(point.at, sum);
    }
  }
  return [...entries].map(([key, entry]) => ({ key, model: entry.model, accounts: [...entry.accounts],
    series: { model: entry.model, ...(entry.speed !== undefined ? { speed: entry.speed, effort: entry.effort } : {}), total: finish(entry.total),
      points: [...entry.points.values()].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).map(finish) } }))
    .sort((a, b) => b.series.total.calls - a.series.total.calls || a.key.localeCompare(b.key));
}

/** The first UTC day of a period ending on `today` (inclusive), or null for the whole history. */
export function rangeStart(range: SpeedRange, today: string): string | null {
  if (range === "all") return null;
  return new Date(Date.parse(`${today}T00:00:00Z`) - (Number.parseInt(range, 10) - 1) * DAY_MS).toISOString().slice(0, 10);
}
/**
 * Entries cut to the days from `since`: each total is summed again from the kept day rows, and a model without calls in
 * the period leaves the report. The whole history keeps the server's totals as they are.
 */
export function entriesSince(entries: readonly SpeedEntry[], since: string | null): SpeedEntry[] {
  if (since === null) return [...entries];
  return entries.flatMap(entry => {
    const points = entry.series.points.filter(point => point.at >= since);
    const total = emptyPoint("total");
    for (const point of points) for (const field of ADDITIVE) total[field] += point[field];
    total.first_token = mergeFirstToken(points.map(point => point.first_token));
    return total.calls > 0 || total.first_token.turns > 0 ? [{ ...entry, series: { ...entry.series, total: finish(total), points } }] : [];
  });
}

/**
 * The drawer's choice. `accounts` and `models` list what was left out, so a subscription or model seen later is chosen;
 * an inactive subscription is off until the user turns it on (`optIn`), and once active again it is on unless the user
 * turned it off. Payload version 2 added `optIn`; a version 1 choice reads with none.
 */
export interface SpeedSelection { accounts: string[]; optIn: string[]; models: Record<string, string[]>; split: boolean }
export const SPEED_SELECTION_KEY = "tokenatlas.speed.all-selection.v1";
export const EMPTY_SELECTION: SpeedSelection = { accounts: [], optIn: [], models: {}, split: false };
const NONE: ReadonlySet<string> = new Set();
/** `key` lets another screen keep its own choice of the same shape (Capacity: subscriptions and their cycles). */
export function readSpeedSelection(storage: Storage | null = browserStorage(), key = SPEED_SELECTION_KEY): SpeedSelection {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return EMPTY_SELECTION;
    const raw = value as Record<string, unknown>;
    const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
    const models = raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)
      ? Object.fromEntries(Object.entries(raw.models as Record<string, unknown>).map(([account, list]) => [account, strings(list)])) : {};
    return { accounts: strings(raw.accounts), optIn: strings(raw.optIn), models, split: raw.split === true };
  } catch { return EMPTY_SELECTION; }
}
export function writeSpeedSelection(selection: SpeedSelection, storage: Storage | null = browserStorage(), key = SPEED_SELECTION_KEY): void {
  try { storage?.setItem(key, JSON.stringify({ v: 2, ...selection })); } catch { /* The selection still applies for this visit. */ }
}
/** Whether a subscription is on; `inactive` names the subscriptions that are off unless turned on. */
export function accountSelected(selection: SpeedSelection, account: string, inactive: ReadonlySet<string> = NONE): boolean {
  if (selection.accounts.includes(account)) return false;
  return !inactive.has(account) || selection.optIn.includes(account);
}
export function modelSelected(selection: SpeedSelection, account: string, model: string, inactive: ReadonlySet<string> = NONE): boolean {
  return accountSelected(selection, account, inactive) && !ownList(selection.models, account).includes(model);
}
/** A subscription's checkbox: all its models, some of them, or none. */
export function accountState(selection: SpeedSelection, account: string, models: readonly string[],
  inactive: ReadonlySet<string> = NONE): "all" | "some" | "none" {
  if (!accountSelected(selection, account, inactive)) return "none";
  const chosen = models.filter(model => modelSelected(selection, account, model, inactive)).length;
  return models.length === 0 || chosen === models.length ? "all" : chosen === 0 ? "none" : "some";
}
/** Turns subscriptions on (an inactive one by opting in) or off (explicitly, so it stays off once active again). */
function switchAccounts(selection: SpeedSelection, accounts: readonly string[], on: boolean, inactive: ReadonlySet<string>): SpeedSelection {
  const models = Object.fromEntries(Object.entries(selection.models).filter(([account]) => !accounts.includes(account)));
  return on
    ? { ...selection, models, accounts: selection.accounts.filter(id => !accounts.includes(id)),
      optIn: [...new Set([...selection.optIn, ...accounts.filter(id => inactive.has(id))])] }
    : { ...selection, models, accounts: [...new Set([...selection.accounts, ...accounts])], optIn: selection.optIn.filter(id => !accounts.includes(id)) };
}
/** Ticking a fully chosen subscription turns it off; any other state chooses all of its models. */
export function toggleAccount(selection: SpeedSelection, account: string, models: readonly string[],
  inactive: ReadonlySet<string> = NONE): SpeedSelection {
  return switchAccounts(selection, [account], accountState(selection, account, models, inactive) !== "all", inactive);
}
/** A model of a subscription that is off becomes that subscription's only chosen model. */
export function toggleModel(selection: SpeedSelection, account: string, model: string, models: readonly string[],
  inactive: ReadonlySet<string> = NONE): SpeedSelection {
  if (!accountSelected(selection, account, inactive)) {
    const on = switchAccounts(selection, [account], true, inactive);
    return { ...on, models: withList(on.models, account, models.filter(m => m !== model)) };
  }
  const excluded = new Set(ownList(selection.models, account));
  if (!excluded.delete(model)) excluded.add(model);
  return { ...selection, models: withList(selection.models, account, [...excluded]) };
}
/** Choose or leave out whole subscriptions (a provider's or every one, inactive ones included). */
export function setAccounts(selection: SpeedSelection, accounts: readonly string[], chosen: boolean,
  inactive: ReadonlySet<string> = NONE): SpeedSelection {
  return switchAccounts(selection, accounts, chosen, inactive);
}
/** The chosen part of each subscription's models. */
export function selectedParts(parts: readonly SpeedPart[], selection: SpeedSelection, inactive: ReadonlySet<string> = NONE): SpeedPart[] {
  return parts.filter(part => accountSelected(selection, part.account, inactive))
    .map(part => ({ account: part.account,
      models: part.models.filter(series => series.model !== null && modelSelected(selection, part.account, series.model, inactive)
        && modelSelected(selection, part.account, speedSeriesKey(series), inactive)) }))
    .filter(part => part.models.length > 0);
}
