import type { Database } from "bun:sqlite";
import type { WindowCycleSums, WindowReadingSums } from "./window-usage-contracts";
import { matchingContextPrice, storedContextPrice, sumContextPrices, type ContextPrice } from "../shared/context-price";
import { pairedRunning } from "./billing-cycle-usage";
import { pairingBounds } from "./subscription-window-comparison";
import type { ProbeLimitWindow } from "./probe-limit-windows";

interface ContextRow {
  start_ts: string; end_ts: string; reset_ts: string; cycle: string | null; readings: string | null;
  meter: string; start_drop: string | null; activity?: string | null; window_minutes?: number;
}

type ContextUsage = Parameters<typeof storedContextPrice>[0];
const zero: ContextUsage = { api_standard: 0, api_normalized: 0, priced_tokens: 0, context_priced_tokens: 0,
  context_api_base: 0, context_api_extra: 0 };
const lastAt = <T>(rows: ReadonlyArray<readonly [number, T]>, at: number): T | undefined => rows.findLast(([ts]) => ts <= at)?.[1];

/** Subtract in the stored normalized unit before scaling Standard dollars, as Capacity scales an aggregate. */
function subtractUsage(high: ContextUsage, low: ContextUsage): ContextUsage | undefined {
  if (!storedContextPrice(high) || !storedContextPrice(low)) return;
  const delta = { api_standard: high.api_standard - low.api_standard,
    api_normalized: (high.api_normalized ?? high.api_standard) - (low.api_normalized ?? low.api_standard),
    priced_tokens: high.priced_tokens - low.priced_tokens,
    context_priced_tokens: high.context_priced_tokens! - low.context_priced_tokens!,
    context_api_base: high.context_api_base! - low.context_api_base!,
    context_api_extra: high.context_api_extra! - low.context_api_extra! };
  if (Object.values(delta).some(value => value < -1e-8)) return;
  return Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, Math.max(0, value)])) as typeof delta;
}

/** Only stored window rows, scoped by account/counter and time; no ledger or event access. */
export function readContextRows(db: Database, account: string, counter: string | null, from: string, until: string): ContextRow[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_usage'").get()) return [];
  return db.query(`SELECT w.start_ts,w.end_ts,w.reset_ts,u.cycle,u.readings,w.readings meter,w.start_drop,w.activity,w.window_minutes
    FROM limit_windows w LEFT JOIN window_usage u ON u.provider=w.provider AND u.account=w.account
      AND u.counter=w.counter AND u.window_id=w.window_id
    WHERE w.provider='codex' AND w.account=? AND (? IS NULL OR w.counter=?) AND w.start_ts<? AND w.end_ts>?
    ORDER BY w.start_ts`).all(account.toLowerCase(), counter, counter, until, from) as ContextRow[];
}

/** Exact whole-window or reading-to-reading traffic. Arbitrary boundaries have no stored split. */
export function contextPriceOfSpan(rows: readonly ContextRow[], from: string, until: string, inclusiveEnd: boolean): ContextPrice | undefined {
  const start = Date.parse(from), end = Date.parse(until);
  const parts: Array<ContextPrice | undefined> = [];
  for (const row of rows) {
    const first = Date.parse(row.start_ts), last = Date.parse(row.end_ts);
    if (start >= last || end < first) continue;
    const cycle = row.cycle ? JSON.parse(row.cycle) as WindowCycleSums : null;
    const readings = row.readings ? JSON.parse(row.readings) as WindowReadingSums[] : [];
    const at = (ms: number) => readings.find(reading => Date.parse(reading.ts) === ms)?.usage;
    const high = end >= last ? cycle?.cycle_usage : at(inclusiveEnd ? end : end - 1);
    const low = start <= first ? zero : at(start - 1);
    const delta = high && low && subtractUsage(high, low);
    parts.push(delta ? storedContextPrice(delta) : undefined);
  }
  return sumContextPrices(parts);
}

/**
 * Billing uses paired usage, with the same held running sums and boundary conventions as its producer.
 * Boundary differences stay in normalized units until the part is scaled to Standard dollars.
 */
export function billingContextPrice(rows: readonly ContextRow[], from: string, until: string, amount: number | null): ContextPrice | undefined {
  const start = Date.parse(from), end = Date.parse(until);
  const parts: Array<ContextPrice | undefined> = [];
  for (const row of rows) {
    const first = Date.parse(row.start_ts), last = Date.parse(row.end_ts);
    if (Math.min(last, end) <= Math.max(first, start)) continue;
    const cycle = row.cycle ? JSON.parse(row.cycle) as WindowCycleSums : null;
    const whole = cycle && storedContextPrice(cycle.usage);
    if (!whole) { parts.push(undefined); continue; }
    if (first >= start && last <= end) { parts.push(whole); continue; }
    const meter = (JSON.parse(row.meter) as ProbeLimitWindow["readings"]).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const pairing = meter.length ? pairingBounds({ start: row.start_ts, readings: meter,
      startDrop: row.start_drop ? { before: 0, after: 0 } : null, reset: row.reset_ts, window_minutes: row.window_minutes,
      ...(row.activity ? { activity: JSON.parse(row.activity) as ProbeLimitWindow["activity"] } : {}) }) : null;
    const bounds = pairing ? { fromReset: pairing.fromReset, start: Date.parse(pairing.start), end: Date.parse(pairing.last.ts) }
      : { fromReset: true, start: first, end: Infinity };
    const readings = (row.readings ? JSON.parse(row.readings) as WindowReadingSums[] : [])
      .map(reading => [Date.parse(reading.ts), reading.usage as ContextUsage | undefined] as const).sort((a, b) => a[0] - b[0]);
    const paired = pairedRunning(readings, bounds, (value, base) => value && base ? subtractUsage(value, base) : undefined);
    const high = last <= end ? cycle!.usage : lastAt(paired, end);
    const low = first < start ? lastAt(paired, start) ?? (readings.some(([ts]) => ts <= start) ? undefined : zero) : zero;
    const delta = high && low && subtractUsage(high, low);
    parts.push(delta ? storedContextPrice(delta) : undefined);
  }
  return matchingContextPrice(sumContextPrices(parts), amount);
}
