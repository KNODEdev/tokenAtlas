import type { Database } from "../db/sqlite";
import { hasFirstTokenSchema } from "../db/first-token";
import { firstTokenAdapters } from "../providers/first-token";
import type { FirstTokenAdapter } from "../providers/first-token/types";
import type { AccountResolver } from "./account-resolver";
import { emptyFirstToken, mergeFirstToken, type FirstTokenSamples } from "../shared/first-token";
import type { ModelSpeedSeries, ModelSpeedPoint } from "./model-speed";

interface Bin { source: string; model: string; billing: string; hour: number; ms: number; turns: number }
const HOUR = 3_600_000;
/** Prepared histograms for whole hours; only account/date boundaries read bounded canonical turns. */
export function readFirstTokenTimes(db: Database, resolver: AccountResolver, provider: string, account: string,
  options: { since?: string; until?: string; grain: "day" | "hour"; adapters?: readonly FirstTokenAdapter[] }) {
  const result = new Map<string, Map<string, FirstTokenSamples>>();
  const bins = new Map<string, Map<string, { turns: number; counts: Map<number, number> }>>();
  if (!hasFirstTokenSchema(db)) return { models: result, pending: false };
  const adapter = (options.adapters ?? firstTokenAdapters).find(a => a.id === provider);
  if (!adapter) return { models: result, pending: false };
  const state = db.query("SELECT version FROM response_time_state WHERE provider=?").get(provider) as { version: number } | null;
  const pending = state?.version !== adapter.version || !!db.query("SELECT 1 FROM response_time_queue WHERE provider=? LIMIT 1").get(provider);
  const fromDate = options.since ? Date.parse(`${options.since}T00:00:00Z`) : -Infinity;
  const untilDate = options.until ? Date.parse(`${options.until}T00:00:00Z`) + 86_400_000 : Infinity;
  const add = (row: Bin, ts: string) => {
    if (adapter.owner(resolver, row.source, ts, row.billing) !== account.toLowerCase()) return;
    const date = new Date(row.hour * HOUR).toISOString(), at = options.grain === "day" ? date.slice(0, 10) : date;
    const points = bins.get(row.model) ?? new Map<string, { turns: number; counts: Map<number, number> }>();
    bins.set(row.model, points);
    const point = points.get(at) ?? { turns: 0, counts: new Map<number, number>() };
    point.turns += row.turns;
    if (row.ms >= 0) point.counts.set(row.ms, (point.counts.get(row.ms) ?? 0) + row.turns);
    points.set(at, point);
  };
  for (const range of resolver.plan(provider, adapter.baseAccount(account)).ranges) {
    const from = Math.max(range.from, fromDate), until = Math.min(range.until, untilDate);
    if (from >= until) continue;
    const first = Math.ceil(from / HOUR), stop = Math.floor(until / HOUR);
    const wholeFrom = Number.isFinite(first) ? first : -Number.MAX_SAFE_INTEGER;
    const wholeUntil = Number.isFinite(stop) ? stop : Number.MAX_SAFE_INTEGER;
    for (const row of db.query(`SELECT source,model,billing,hour,ms,turns FROM response_time_hours
      WHERE provider=? AND source=? AND hour>=? AND hour<?`).all(provider, range.source, wholeFrom, wholeUntil) as Bin[])
      add(row, new Date(row.hour * HOUR).toISOString());
    const edges: Array<[number, number]> = [];
    if (Number.isFinite(from) && from < first * HOUR) edges.push([from, Math.min(until, first * HOUR)]);
    if (Number.isFinite(until) && stop * HOUR < until && stop * HOUR >= first * HOUR) edges.push([Math.max(from, stop * HOUR), until]);
    for (const [a, b] of edges) for (const row of db.query(`SELECT source,model,billing,ts,ms FROM response_time_turns
      WHERE provider=? AND source=? AND ts>=? AND ts<? AND model IS NOT NULL`)
      .all(provider, range.source, new Date(a).toISOString(), new Date(b).toISOString()) as Array<Omit<Bin, "hour" | "turns"> & { ts: string }>)
      add({ ...row, ms: row.ms ?? -1, hour: Math.floor(Date.parse(row.ts) / HOUR), turns: 1 }, row.ts);
  }
  for (const [model, points] of bins) result.set(model, new Map([...points].map(([at, p]) =>
    [at, { turns: p.turns, histogram: [...p.counts].sort(([a], [b]) => a - b) }])));
  return { models: result, pending };
}

const emptyPoint = (at: string): ModelSpeedPoint => ({ at, calls: 0, timed_calls: 0, timed_out: 0, timed_ms: 0, speed: null,
  long_calls: 0, long_out: 0, long_ms: 0, long_speed: null, coverage: null });
/** Timing-only days/models remain visible without inventing usage calls. */
export function attachFirstTokenTimes(series: ModelSpeedSeries[], timing: ReturnType<typeof readFirstTokenTimes>): ModelSpeedSeries[] {
  const models = new Map(series.map(s => [s.model, { ...s, total: { ...s.total }, points: s.points.map(p => ({ ...p })) }]));
  for (const [model, samples] of timing.models) {
    const row = models.get(model) ?? { model, total: emptyPoint("total"), points: [] };
    const points = new Map(row.points.map(p => [p.at, p]));
    for (const [at, first_token] of samples) points.set(at, { ...(points.get(at) ?? emptyPoint(at)), first_token });
    row.points = [...points.values()].sort((a, b) => a.at.localeCompare(b.at));
    row.total.first_token = mergeFirstToken([...samples.values()]);
    models.set(model, row);
  }
  for (const row of models.values()) {
    row.total.first_token ??= emptyFirstToken();
    for (const point of row.points) point.first_token ??= emptyFirstToken();
  }
  return [...models.values()];
}
