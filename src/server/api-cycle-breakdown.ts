import { contextPreviewResponse, contextRequested, type JsonResponse } from "./codex-context-preview";
import { roundApiCodexUsd, apiHasCodexHistory, apiCodexLedgerIsPending } from "./api-codex-ledger";
import { rational } from "../db/price-ledger-exact";
import { round2, UnpricedCollector } from "./api-report-values";
import { readCodexSourceBurn } from "../db/codex-price-ledger";
import type { AppContext } from "./app-context-types";
import { codexCycleRequest, codexCycleLedgerRanges } from "./codex-ledger-request-validation";
import { preparingDataResponse } from "./preparing-response";
import { readCodexWindowDetail } from "./codex-window-detail";
import { codexAccountSelector } from "./codex-source-account";
import { resolveIndexedHomes } from "./account-scope";
import { projectCond } from "./api-request-params";
import { latestAccountState } from "./account-probes";

export interface CycleDay {
  usd_partial?: boolean;
  /** Standard credits of the counted calls; `credits_partial` when some had no credit price. */
  credits?: number;
  credits_partial?: boolean;
  date: string;
  dow: number;
  from_ts: string;
  to_ts: string;
  hours: number;
  calls: number;
  tokens: number;
  tokens_fresh: number;
  usd: number;
  top_model: string | null;
  gauge_end: number | null;
  gauge_delta: number | null;
  gauge_samples: number;
  is_today: boolean;
}

export interface CycleSession {
  usd_partial?: boolean;
  credits?: number;
  credits_partial?: boolean;
  index: number;
  start_ts: string;
  end_ts: string;
  active: boolean;
  calls: number;
  tokens: number;
  tokens_fresh: number;
  usd: number;
  top_model: string | null;
  reported_percent: number | null;
  reported_samples: number;
  reported_reset_ts: string | null;
}

interface DayAcc {
  usd_partial?: boolean;
  credits?: number;
  credits_partial?: boolean;
  usd_exact?: { n: string; d: string };
  calls: number;
  tokens: number;
  tokens_fresh: number;
  usd: number;
  top_model: string | null;
  top_calls: number;
}

function emptyDayAcc(): DayAcc {
  return { calls: 0, tokens: 0, tokens_fresh: 0, usd: 0, top_model: null, top_calls: 0 };
}

function cycleBucketUsd(value: DayAcc): number {
  return value.usd_exact ? roundApiCodexUsd(rational(BigInt(value.usd_exact.n),BigInt(value.usd_exact.d))) : round2(value.usd);
}

/** A bucket's credits as the unit switch reads them; nothing for a bucket without calls. */
function cycleBucketCredits(value: DayAcc): { credits?: number; credits_partial?: boolean } {
  if (value.credits === undefined) return {};
  return { credits: round2(value.credits), ...(value.credits_partial ? { credits_partial: true } : {}) };
}

function storedCycleSourceBurn(ctx: AppContext, homes: string[], nowMs: number, url: URL) {
  const project = url.searchParams.get("project_id");
  const burn = readCodexSourceBurn(ctx.sqlite, homes, nowMs, [1, 6, 24, 168],
    project ? project === "unassigned" ? null : project : undefined);
  const windows = burn.windows.map(window => ({ label: window.hours === 168 ? "7d" : `${window.hours}h`, hours: window.hours,
    calls: window.calls, tokens: Number(window.input + window.output), tokens_fresh: Number(window.input - window.cached + window.output) }));
  return { windows, unplacedCalls: burn.unplaced };
}

function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function handleCycleBreakdown(ctx: AppContext, url: URL): Response {
  return contextPreviewResponse(ctx.sqlite, json => handleCycleBreakdownBody(ctx, url, json), contextRequested(url), "details");
}
function handleCycleBreakdownBody(ctx: AppContext, url: URL, json: JsonResponse): Response {
  const dated = url.searchParams.get("valuation") === "dated";
  const creditCard = ctx.rateCards?.codex_credits;
  const parsed = codexCycleRequest(ctx,url);
  if ("error" in parsed) return json({ error: parsed.error }, { status: 400 });
  if (!ctx.rateCards && apiHasCodexHistory(ctx)) return preparingDataResponse();
  const { since_ts, until_ts, accountParam, declared, anchor, sessionMinutes, fromMs, toMs } = parsed;
  const limitId = url.searchParams.get("limit_id") || "codex";
  const evHomes = resolveIndexedHomes(ctx, "events", declared);
  const rlHomes = resolveIndexedHomes(ctx, "ratelimit", declared);
  const unpriced = new UnpricedCollector();
  const pc = projectCond(url);
  const nowMs = Date.now();
  const capMs = Math.min(toMs, nowMs);
  if (codexCycleLedgerRanges(parsed,url,nowMs).some(range=>apiCodexLedgerIsPending(ctx,range))) return preparingDataResponse();
  const detailed = readCodexWindowDetail(ctx.sqlite, ctx.rateCards, {
    account: accountParam, homes: evHomes, from: since_ts, until: until_ts, anchor, limitId,
    sessionMinutes, inclusiveEnd:!dated || url.searchParams.get("end_inclusive") === "true", project: pc, includeBurn:dated, filterCounter:dated,
    ...(!dated ? {sessionOrigin:Math.floor(fromMs/1000)*1000} : {}),
    homeToSubId: ctx.homeToSubId,
  });
  const byDate = detailed.byDate, byBlock = detailed.byBlock;
  const blockSeconds = sessionMinutes * 60;
  interface GaugeRow {
    ts: string;
    used_percent: number;
    resets_at: number | null;
    window_minutes: number | null;
  }
  // A dated window reads only the account's own samples (its periods on each sample's source): the window's samples are read
  // once, by time, and each is kept when the period covering its source and instant names the account.
  type WindowSample = { id: number; d: string; ts: string; used_percent: number; resets_at: number | null; window_minutes: number | null; limit_id: string };
  let windowSamples: WindowSample[] | null = null;
  if (dated && rlHomes.length > 0) {
    const selector = codexAccountSelector(ctx), owner = accountParam.toLowerCase();
    windowSamples = (ctx.sqlite.query(`SELECT rowid AS id, home, date(ts, 'localtime') AS d, ts, used_percent, resets_at, window_minutes, limit_id
      FROM ratelimit INDEXED BY ratelimit_range_sources WHERE ts >= ? AND ts <= ? AND home IN (${rlHomes.map(() => "?").join(",")})`)
      .all(since_ts, until_ts, ...rlHomes) as Array<WindowSample & { home: string }>)
      .filter(row => selector.accountAt(row.home, row.ts) === owner)
      .sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id);
  }
  const gaugeByDate = new Map<string, { end: number; samples: number }>();
  let firstGauge: number | null = null;
  if (windowSamples) {
    const rows = windowSamples.filter(row => row.limit_id === limitId && row.window_minutes !== null && row.window_minutes >= sessionMinutes + 1
      && (anchor == null || row.resets_at !== null && Math.abs(row.resets_at - anchor) <= 120));
    if (rows.length > 0) firstGauge = rows[0]!.used_percent;
    for (const r of rows) gaugeByDate.set(r.d, { end: r.used_percent, samples: (gaugeByDate.get(r.d)?.samples ?? 0) + 1 });
  } else if (rlHomes.length > 0) {
    try {
      const rows = ctx.sqlite
        .query(
          `SELECT date(ts, 'localtime') AS d, ts, used_percent FROM ratelimit
           WHERE home IN (${rlHomes.map(() => "?").join(",")})
             AND limit_id = ? AND ts >= ? AND ts <= ?
             AND window_minutes >= ?
             ${anchor != null ? "AND resets_at IS NOT NULL AND ABS(resets_at - ?) <= 120" : ""}
           ORDER BY ts ASC`
        )
        .all(
          ...rlHomes,
          limitId,
          since_ts,
          until_ts,
          sessionMinutes + 1,
          ...(anchor != null ? [anchor] : [])
        ) as Array<{
          d: string;
          ts: string;
          used_percent: number;
        }>;
      if (rows.length > 0) firstGauge = rows[0]!.used_percent;
      for (const r of rows) {
        const key = r.d;
        const cur = gaugeByDate.get(key);
        gaugeByDate.set(key, { end: r.used_percent, samples: (cur?.samples ?? 0) + 1 });
      }
    } catch {
    }
  }
  const days: CycleDay[] = [];
  const todayKey = localDateKey(new Date(nowMs));
  let prevGauge: number | null = firstGauge;
  const cursor = new Date(fromMs);
  cursor.setHours(0, 0, 0, 0);
  for (let guard = 0; guard < 400 && cursor.getTime() < capMs; guard++) {
    const dayStart = cursor.getTime();
    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    const dayEnd = next.getTime();
    const from = Math.max(dayStart, fromMs);
    const to = Math.min(dayEnd, capMs);
    if (to > from) {
      const key = localDateKey(cursor);
      const acc = byDate.get(key) ?? emptyDayAcc();
      const g = gaugeByDate.get(key) ?? null;
      const delta = g != null && prevGauge != null ? round2(g.end - prevGauge) : null;
      days.push({
        date: key,
        dow: (cursor.getDay() + 6) % 7,
        from_ts: new Date(from).toISOString(),
        to_ts: new Date(to).toISOString(),
        hours: round2((to - from) / 3_600_000),
        calls: acc.calls,
        tokens: acc.tokens,
        tokens_fresh: acc.tokens_fresh,
        usd: cycleBucketUsd(acc),
        ...(acc.usd_partial ? { usd_partial: true } : {}),
        ...cycleBucketCredits(acc),
        top_model: acc.top_model,
        gauge_end: g ? round2(g.end) : null,
        gauge_delta: delta,
        gauge_samples: g?.samples ?? 0,
        is_today: key === todayKey,
      });
      if (g) prevGauge = g.end;
    }
    cursor.setTime(dayEnd);
  }
  interface RlCluster {
    limit_id: string;
    anchor: number | null;
    peak: number;
    first: string;
    last: string;
    samples: number;
  }
  const clusters: RlCluster[] = [];
  if (rlHomes.length > 0) {
    let rows: Array<GaugeRow & { limit_id: string }> = [];
    if (windowSamples) rows = windowSamples.filter(row => row.window_minutes === sessionMinutes);
    else try {
      rows = ctx.sqlite
        .query(
          `SELECT ts, used_percent, resets_at, window_minutes, limit_id FROM ratelimit
           WHERE home IN (${rlHomes.map(() => "?").join(",")})
             AND window_minutes = ? AND ts >= ? AND ts <= ?
           ORDER BY ts ASC`
        )
        .all(...rlHomes, sessionMinutes, since_ts, until_ts) as typeof rows;
    } catch {
      rows = [];
    }
    for (const r of rows) {
      const anchor = r.resets_at != null && !isNaN(r.resets_at) ? Math.floor(r.resets_at) : null;
      let idx = -1;
      for (let i = clusters.length - 1; i >= 0; i--) {
        const c = clusters[i];
        if (!c || c.limit_id !== r.limit_id) continue;
        if (anchor != null && c.anchor != null && Math.abs(c.anchor - anchor) <= 120) {
          idx = i;
          break;
        }
        if (anchor == null && c.anchor == null) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        clusters.push({ limit_id: r.limit_id, anchor, peak: r.used_percent, first: r.ts, last: r.ts, samples: 1 });
      } else {
        const c = clusters[idx]!;
        c.peak = Math.max(c.peak, r.used_percent);
        c.last = r.ts;
        c.samples += 1;
      }
    }
  }
  const planClusters = clusters.filter((c) => c.limit_id === limitId && c.anchor != null);
  const sessions: CycleSession[] = [];
  const blockCount = Math.ceil((capMs - fromMs) / (blockSeconds * 1000));
  for (let i = 0; i < Math.min(blockCount, 400); i++) {
    const startMs = fromMs + i * blockSeconds * 1000;
    const endMs = Math.min(startMs + blockSeconds * 1000, toMs);
    const acc = byBlock.get(i) ?? emptyDayAcc();
    const cover = planClusters.find((c) => {
      const reset = c.anchor! * 1000;
      return reset > startMs && reset <= startMs + blockSeconds * 1000;
    });
    sessions.push({
      index: i,
      start_ts: new Date(startMs).toISOString(),
      end_ts: new Date(endMs).toISOString(),
      active: startMs <= nowMs && nowMs < startMs + blockSeconds * 1000,
      calls: acc.calls,
      tokens: acc.tokens,
      tokens_fresh: acc.tokens_fresh,
      usd: cycleBucketUsd(acc),
      ...(acc.usd_partial ? { usd_partial: true } : {}),
      ...cycleBucketCredits(acc),
      top_model: acc.top_model,
      reported_percent: cover ? round2(cover.peak) : null,
      reported_samples: cover?.samples ?? 0,
      reported_reset_ts: cover ? new Date(cover.anchor! * 1000).toISOString() : null,
    });
  }
  const stateRows = latestAccountState(ctx).filter((r) => r.account.toLowerCase() === accountParam.toLowerCase()
    && (!dated || (Date.parse(r.ts) >= fromMs && Date.parse(r.ts) < toMs)));
  const liveShort = stateRows.find((r) => r.limit_id === limitId && r.window_minutes === sessionMinutes) ?? null;
  const otherShort = stateRows.filter((r) => r.limit_id !== limitId && r.window_minutes === sessionMinutes);
  let lastPlanShortTs: string | null = null;
  if (windowSamples) {
    for (const row of windowSamples) if (row.limit_id === limitId && row.window_minutes === sessionMinutes && row.ts >= since_ts && row.ts < until_ts
      && (lastPlanShortTs === null || row.ts > lastPlanShortTs)) lastPlanShortTs = row.ts;
  } else if (rlHomes.length > 0) {
    try {
      const row = ctx.sqlite
        .query(
          `SELECT MAX(ts) AS t FROM ratelimit
           WHERE home IN (${rlHomes.map(() => "?").join(",")}) AND limit_id = ? AND window_minutes = ?
             ${dated ? "AND ts >= ? AND ts < ?" : ""}`
        )
        .get(...rlHomes, limitId, sessionMinutes, ...(dated ? [since_ts, until_ts] : [])) as { t: string | null } | null;
      lastPlanShortTs = row?.t ?? null;
    } catch {
      lastPlanShortTs = null;
    }
  }
  const totals = { calls: detailed.totals.calls, tokens: detailed.totals.tokens,
    tokens_fresh: detailed.totals.tokens_fresh, usd: cycleBucketUsd(detailed.totals),
    ...(detailed.totals.context_price ? { context_price: detailed.totals.context_price } : {}) };
  const sourceBurn = dated ? null : storedCycleSourceBurn(ctx,evHomes,nowMs,url);
  return json({
    account: accountParam,
    since_ts,
    until_ts,
    limit_id: limitId,
    session_window_minutes: sessionMinutes,
    bucketing: "local time",
    dow_origin: "monday",
    days,
    sessions,
    short_counter: {
      reported: planClusters.length > 0,
      last_reported_ts: lastPlanShortTs,
      live: liveShort,
      other: otherShort,
    },
    credit_equivalent: detailed.credits,
    ...(detailed.creditFunded !== undefined ? { credit_funded: detailed.creditFunded } : {}),
    ...(dated ? { model_detail: detailed.detail } : {}),
    burn_windows:sourceBurn?.windows ?? detailed.burn,
    totals,
    unpriced: {...detailed.unpriced,...(sourceBurn?.unplacedCalls ? {time_quality:{scope:"declared-source",unplaced_calls:sourceBurn.unplacedCalls}} : {})},
    note:
      evHomes.length === 0
        ? `account '${accountParam}' has no indexed events - day and session rows carry gauge only`
        : null,
  });
}
