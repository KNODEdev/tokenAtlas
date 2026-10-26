import { isCodexWindowMinutes } from "../shared/codex-counters";
import { readCodexLimitWindows, codexLimitCounter } from "./codex-limit-windows";
import { readWindowSums } from "./window-usage-read";
import type { AppContext } from "./app-context-types";
import { nextDay, parseCommonDateParams } from "./api-request-params";
import type { ReservePool } from "./codex-cycle-series";
import { codexAccountSelector, codexOwnershipGaps } from "./codex-source-account";
import { WhereClause, queryRows } from "./data-groups";
import { CODEX_RESERVE_LIMIT_ID } from "./codex-window-comparison";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { preparingDataResponse, preparingRows } from "./preparing-response";
import { codexCycles, codexCycleCharts, codexCycleStats } from "./codex-cycle-series";
import { resolveIndexedHomes } from "./account-scope";
import { windowCreditPools } from "./api-window-rail";
import { machineForActivitySource } from "./account-identity";
import { round2 } from "./api-report-values";
import { subscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import { handleSubscriptionAccounting } from "./subscription-accounting";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import type { GlobalUsageRange } from "./global-usage";
import { globalUsageRange, buildGlobalUsage } from "./global-usage";
import { CodexLedgerNotReady } from "../db/codex-price-ledger";

export const PLAN_LIMIT_ID_SERIES = "codex";

export function cycleElapsedMs(
  isActive: boolean,
  startMs: number,
  nowMs: number,
  historicalEndMs: number
): number {
  return Math.max(0, (isActive ? nowMs : historicalEndMs) - startMs);
}

/**
 * The stored Codex windows of an account and counter with their stored sums, those whose cycles overlap
 * the requested days (all of them without a range). Throws the preparing errors of either register.
 */
function storedCodexCycles(ctx: AppContext, account: string, minutes: 300 | 10080 | 43200, range: { since?: string; until?: string } = {}) {
  const register = readCodexLimitWindows(ctx.sqlite, account, minutes);
  const from = range.since ? Date.parse(`${range.since}T00:00:00.000Z`) : -Infinity;
  const to = range.until ? Date.parse(`${nextDay(range.until)}T00:00:00.000Z`) : Infinity;
  const windows = register.filter(window => Date.parse(window.end) > from && Date.parse(window.start) < to);
  return { register, windows, sums: readWindowSums(ctx.sqlite, "codex", account, codexLimitCounter(minutes), windows, ["cycle", "rail", "readings"]) };
}

/** Readings of the reserve pool (its own counter in session transcripts), grouped by reset anchor. */
function readReservePools(ctx: AppContext, account: string, homes: string[], minutes: number,
  range: { since?: string; until?: string }): ReservePool[] {
  const selector = codexAccountSelector(ctx);
  const window = new WhereClause();
  window.add(`home IN (${homes.map(() => "?").join(",")})`, homes);
  window.add("window_minutes = ?", [minutes]);
  window.add("limit_id = ?", [CODEX_RESERVE_LIMIT_ID]);
  if (range.since) window.add("ts >= ?", [`${range.since}T00:00:00.000Z`]);
  if (range.until) window.add("ts < ?", [`${nextDay(range.until)}T00:00:00.000Z`]);
  const own = selector.ownedBy(account, {});
  const rows = queryRows<{ ts: string; used_percent: number; resets_at: number | null }>(ctx.sqlite,
    `SELECT ts, used_percent, resets_at FROM ratelimit ${window.clause()} AND ${own.sql} ORDER BY ts ASC`, [...window.params, ...own.params]);
  const pools: ReservePool[] = [];
  for (const row of rows) {
    const anchor = row.resets_at != null && !isNaN(row.resets_at) ? Math.floor(row.resets_at) : null;
    let pool = pools.findLast(p => p.anchor === anchor || (p.anchor != null && anchor != null && Math.abs(p.anchor - anchor) <= 120));
    if (!pool) pools.push(pool = { anchor, start_ts: row.ts, peak_ts: row.ts, peak_percent: row.used_percent });
    if (row.used_percent > pool.peak_percent) Object.assign(pool, { peak_percent: row.used_percent, peak_ts: row.ts });
    if (row.ts < pool.start_ts) pool.start_ts = row.ts;
  }
  return pools;
}

/**
 * Codex cycles for Overview: the stored windows of the account's counter and their stored sums
 * (window_usage); a cycle is never clipped to the requested days. Nothing here reads events.
 */
export function handleUsageSeries(ctx: AppContext, url: URL): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return Response.json({ error: dateParams.error }, { status: 400 });
  }
  const { since, until } = dateParams;
  const accountParam = url.searchParams.get("account") || "codex1";
  const declared = ctx.subIdToHomes.get(accountParam.toLowerCase()) || [];
  const discovered = ctx.codexDiscovery?.accounts.some(a => a.id.toLowerCase() === accountParam.toLowerCase());
  if (declared.length === 0 && !discovered) {
    return Response.json({ error: `unknown account: ${accountParam}` }, { status: 400 });
  }
  const windowParam = url.searchParams.get("window") || "10080";
  const windowMinutes = parseInt(windowParam, 10);
  if (isNaN(windowMinutes) || windowMinutes <= 0) {
    return Response.json({ error: `Invalid 'window' parameter: '${windowParam}'` }, { status: 400 });
  }
  const limitId = url.searchParams.get("limit_id") || "codex";
  const pointsParam = url.searchParams.get("points");
  let maxPoints = pointsParam ? parseInt(pointsParam, 10) : 500;
  if (isNaN(maxPoints) || maxPoints <= 0) maxPoints = 500;
  maxPoints = Math.max(50, Math.min(2000, maxPoints));
  const range = { ...(since ? { since } : {}), ...(until ? { until } : {}) };
  const rlHomes = resolveIndexedHomes(ctx, "ratelimit", declared);
  const ownership = limitId === PLAN_LIMIT_ID_SERIES && rlHomes.length
    ? codexOwnershipGaps(ctx.sqlite, codexAccountSelector(ctx), rlHomes, { windowMinutes, limitId, ...range })
    : { unowned_samples: 0, reasons: [] };
  const emptyPayload = {
    account: accountParam, window_minutes: windowMinutes, limit_id: limitId, sample_count: 0, bucket_minutes: 0,
    first_ts: null, last_ts: null, points: [], activity: [], traffic: [], cycles: [], latest: null, stats: null,
    ownership, unpriced: { tokens: 0, models: {} },
  };
  // Stored windows exist for the account's main counter, weekly and 5h.
  if (limitId !== PLAN_LIMIT_ID_SERIES || !isCodexWindowMinutes(windowMinutes)) {
    return Response.json({ ...emptyPayload, note: `no stored windows for window=${windowMinutes} limit_id=${limitId}` });
  }
  let stored: ReturnType<typeof storedCodexCycles>;
  try { stored = storedCodexCycles(ctx, accountParam, windowMinutes, range); }
  catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable) return preparingDataResponse();
    throw error;
  }
  const { windows, sums } = stored;
  if (!windows.length) {
    return Response.json({ ...emptyPayload, note: `no samples for window=${windowMinutes} limit_id=${limitId} in the selected range` });
  }
  const nowMs = Date.now();
  const cycles = codexCycles(windows, sums, nowMs, rlHomes.length ? readReservePools(ctx, accountParam, rlHomes, windowMinutes, range) : [],
    windowCreditPools(ctx, "codex", accountParam, windows));
  const charts = codexCycleCharts(windows, sums, maxPoints,
    (home, ts) => machineForActivitySource(ctx, "codex", home, ts, accountParam));
  const { stats, unpriced } = codexCycleStats(cycles, windows, sums);
  const last = charts.readings.at(-1)!;
  return Response.json({
    account: accountParam,
    window_minutes: windowMinutes,
    limit_id: limitId,
    sample_count: charts.readings.length,
    bucket_minutes: charts.bucket_minutes,
    first_ts: charts.readings[0]!.ts,
    last_ts: last.ts,
    points: charts.points,
    activity: charts.activity,
    traffic: charts.traffic,
    cycles,
    latest: {
      ts: last.ts,
      percent: round2(last.percent),
      cycle: last.cycle,
      resets_at_iso: cycles[last.cycle]!.resets_at_iso,
      age_hours: round2((nowMs - Date.parse(last.ts)) / 3_600_000),
    },
    stats,
    ownership,
    unpriced,
  });
}

/** A provider's accounting report, read from stored rows on each request (plan U4.4). */
export function serveSubscriptionAccounting(ctx: AppContext, req: Request): Response {
  const provider = new URL(req.url).searchParams.get("provider");
  if (!provider) return Response.json({ error: "A provider is required" }, { status: 400 });
  try { subscriptionAccountingAdapter(provider); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  try { return handleSubscriptionAccounting({ ...ctx, declarations: ctx.accounts.subscriptions }, req); }
  catch (error) {
    if (error instanceof SubscriptionFactsPending || error instanceof ProbeAccountIndexUnavailable) return preparingRows();
    throw error;
  }
}

/** Global usage, read from the register days of both ledgers on each request (plan U4.4). */
export function serveGlobalUsage(ctx: AppContext, url: URL): Response {
  let range: GlobalUsageRange;
  try { range = globalUsageRange(url.searchParams); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  try {
    return Response.json(buildGlobalUsage(ctx, range));
  } catch (error) {
    if (error instanceof SubscriptionFactsPending || error instanceof ProbeAccountIndexUnavailable || error instanceof CodexLedgerNotReady) return preparingRows();
    throw error;
  }
}
