import type { Database } from "../db/sqlite";
import type { TimedSums } from "../db/usage-ledger";
import type { AccountReadPlan } from "./account-resolver";
import { readOwnedLedgerHours, type SumVendor } from "./ledger-sums";
import type { FirstTokenSamples } from "../shared/first-token";
import { executionKey, type ModelExecution } from "../shared/model-execution";

/**
 * Shapes stored owned hours into model/speed/effort series. The API reads the canonical timing projection
 * through model-speed-read.ts; readModelSpeed remains the legacy aggregate/reference helper.
 *
 * Speed is `out * 1000 / ms` over the summed calls, never an average of per-call speeds. `long_*` counts only
 * calls with at least `LONG_CALL_OUT` output tokens, where generation rather than latency dominates the time.
 * `coverage` is the share of the bucket's calls with a known response time: a call without one (no request
 * start in its transcript, a retried request, a file not yet read by Claude parser 6 or Codex parser 7) is counted, never timed as 0.
 */
export interface ModelSpeedPoint {
  first_token?: FirstTokenSamples;
  /** UTC day (`YYYY-MM-DD`) or the ISO instant an hour starts. */
  at: string;
  calls: number; timed_calls: number; timed_out: number; timed_ms: number; speed: number | null;
  long_calls: number; long_out: number; long_ms: number; long_speed: number | null;
  coverage: number | null;
}
export interface ModelSpeedSeries extends Partial<ModelExecution> { model: string | null; total: ModelSpeedPoint; points: ModelSpeedPoint[] }

type Sums = { calls: number } & TimedSums;
const empty = (): Sums => ({ calls: 0, timed_calls: 0, timed_out: 0, timed_ms: 0, timed_long_calls: 0, timed_long_out: 0, timed_long_ms: 0 });
function point(at: string, sums: Sums): ModelSpeedPoint {
  return { at, calls: sums.calls, timed_calls: sums.timed_calls, timed_out: sums.timed_out, timed_ms: sums.timed_ms,
    speed: sums.timed_ms > 0 ? sums.timed_out * 1000 / sums.timed_ms : null,
    long_calls: sums.timed_long_calls, long_out: sums.timed_long_out, long_ms: sums.timed_long_ms,
    long_speed: sums.timed_long_ms > 0 ? sums.timed_long_out * 1000 / sums.timed_long_ms : null,
    coverage: sums.calls > 0 ? sums.timed_calls / sums.calls : null };
}
function add(into: Sums, row: Sums): void {
  for (const key of Object.keys(into) as Array<keyof Sums>) into[key] += row[key];
}

export function readModelSpeed(db: Database, vendor: SumVendor, plan: AccountReadPlan,
  query: { grain: "hour" | "day"; since?: string; until?: string }): ModelSpeedSeries[] {
  const range = { ...(query.since ? { since: query.since } : {}), ...(query.until ? { until: query.until } : {}) };
  return modelSpeedSeries(readOwnedLedgerHours(db, vendor, plan, range).map(row => ({ ...row, speed: row.speed ?? "unknown" })), query.grain);
}

/** Owned calendar-hour sums of one account (any ledger), as series per model on the hour or UTC day grain. */
export function modelSpeedSeries(hours: Iterable<{ hour: number | null; model: string | null } & Sums & Partial<ModelExecution>>, grain: "hour" | "day"): ModelSpeedSeries[] {
  const query = { grain };
  const models = new Map<string, { model: string | null; speed?: string; effort?: string | null; total: Sums; buckets: Map<string, Sums> }>();
  for (const row of hours) {
    const instant = new Date(row.hour! * 3_600_000).toISOString();
    const at = query.grain === "hour" ? instant : instant.slice(0, 10);
    const key = executionKey(row.model, row);
    const entry = models.get(key) ?? { model: row.model, ...(row.speed !== undefined ? { speed: row.speed, effort: row.effort ?? null } : {}), total: empty(), buckets: new Map<string, Sums>() };
    models.set(key, entry);
    const bucket = entry.buckets.get(at) ?? empty();
    entry.buckets.set(at, bucket);
    add(bucket, row); add(entry.total, row);
  }
  return [...models.values()].sort((a, b) => b.total.calls - a.total.calls || String(a.model).localeCompare(String(b.model)))
    .map(entry => ({ model: entry.model, ...(entry.speed !== undefined ? { speed: entry.speed, effort: entry.effort } : {}), total: point("total", entry.total),
      points: [...entry.buckets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([at, sums]) => point(at, sums)) }));
}
