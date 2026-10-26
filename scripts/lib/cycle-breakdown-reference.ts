// Frozen handler from master 31557cd17dd324acc548e3448f38821e69878884.
import type { SQLQueryBindings } from "bun:sqlite";
import { latestAccountState, type AppContext, type CycleDay, type CycleSession } from "../../src/server/api";
import { getCodexRate } from "../../src/server/pricing";
import { codexEventOwnedBy } from "../../src/server/codex-event-owner";
import { codexAccountSelector } from "../../src/server/codex-source-account";
// Ownership is an input, not part of the frozen calculation: the handler was frozen reading the retired
// `rollout_owner` table, and takes the account of an event from its account period since stage 4, W6.
function ownerCond(ctx: AppContext, account: string, since: string, until: string): { sql: string; params: SQLQueryBindings[] } {
  return codexEventOwnedBy(ctx.sqlite, codexAccountSelector(ctx, "events"), account,
    { within: { from: since, until: new Date(Date.parse(until) + 1).toISOString() } });
}
interface UnpricedResult { tokens: number; models: Record<string, number> }
class UnpricedCollector {
  private counts = new Map<string, number>();
  add(model: string | null | undefined, tokens: number) {
    if (!tokens) return;
    const key = model || "?";
    this.counts.set(key, (this.counts.get(key) || 0) + tokens);
  }
  toJSON(): UnpricedResult {
    let tokens = 0;
    const models: Record<string, number> = {};
    for (const [k, v] of this.counts.entries()) {
      models[k] = v;
      tokens += v;
    }
    return { tokens, models };
  }
}
const PLAN_LIMIT_ID_SERIES = "codex";
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function projectCond(url: URL): { sql: string; params: string[] } | null {
  const v = url.searchParams.get("project_id");
  if (!v) return null;
  if (v === "unassigned") return { sql: "project_id IS NULL", params: [] };
  return { sql: "project_id = ?", params: [v] };
}
function parseInstantParams(
  url: URL
): { since_ts?: string; until_ts?: string; error?: string } {
  const since_ts = url.searchParams.get("since_ts") || undefined;
  const until_ts = url.searchParams.get("until_ts") || undefined;
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/;
  if (since_ts !== undefined && !shape.test(since_ts)) {
    return {
      error: `Invalid 'since_ts' parameter: '${since_ts}'. Expected an ISO-8601 instant, e.g. 2026-08-16T12:28:50.000Z.`,
    };
  }
  if (until_ts !== undefined && !shape.test(until_ts)) {
    return {
      error: `Invalid 'until_ts' parameter: '${until_ts}'. Expected an ISO-8601 instant, e.g. 2026-08-23T12:28:50.000Z.`,
    };
  }
  if (since_ts && until_ts && since_ts > until_ts) {
    return { error: `'since_ts' (${since_ts}) cannot be after 'until_ts' (${until_ts}).` };
  }
  return { since_ts, until_ts };
}
function resolveIndexedHomes(
  ctx: AppContext,
  table: "events" | "ratelimit",
  declared: string[],
  memo?: Map<string, string[]>
): string[] {
  const want = new Set(declared.map(normPath));
  try {
    let indexed = memo?.get(table);
    if (!indexed) {
      indexed = (ctx.sqlite.query(`SELECT DISTINCT home AS h FROM ${table}`).all() as Array<{ h: string }>).map(
        (row) => row.h
      );
      memo?.set(table, indexed);
    }
    return indexed.filter((home) => want.has(normPath(home)));
  } catch {
    return [];
  }
}
interface DayAcc {
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
function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function referenceCycleBreakdown(ctx: AppContext, url: URL): Response {
  const instantParams = parseInstantParams(url);
  if (instantParams.error) {
    return Response.json({ error: instantParams.error }, { status: 400 });
  }
  const { since_ts, until_ts } = instantParams;
  if (!since_ts || !until_ts) {
    return Response.json(
      { error: "Both 'since_ts' and 'until_ts' are required - this endpoint describes one window, not a span." },
      { status: 400 }
    );
  }
  const accountParam = url.searchParams.get("account") || "codex1";
  const declared = ctx.subIdToHomes.get(accountParam.toLowerCase()) || [];
  if (declared.length === 0) {
    return Response.json({ error: `unknown account: ${accountParam}` }, { status: 400 });
  }
  const limitId = url.searchParams.get("limit_id") || "codex";
  const anchorParam = url.searchParams.get("anchor");
  const anchor = anchorParam ? parseInt(anchorParam, 10) : null;
  if (anchorParam && (isNaN(anchor!) || anchor! <= 0)) {
    return Response.json({ error: `Invalid 'anchor' parameter: '${anchorParam}'. Expected unix seconds.` }, { status: 400 });
  }
  const sessionParam = url.searchParams.get("session_window") || "300";
  const sessionMinutes = parseInt(sessionParam, 10);
  if (isNaN(sessionMinutes) || sessionMinutes <= 0) {
    return Response.json({ error: `Invalid 'session_window' parameter: '${sessionParam}'` }, { status: 400 });
  }
  const evHomes = resolveIndexedHomes(ctx, "events", declared);
  const rlHomes = resolveIndexedHomes(ctx, "ratelimit", declared);
  const unpriced = new UnpricedCollector();
  const pc = projectCond(url);
  const fromMs = new Date(since_ts).getTime();
  const toMs = new Date(until_ts).getTime();
  const nowMs = Date.now();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return Response.json({ error: `'since_ts'/'until_ts' do not describe a window` }, { status: 400 });
  }
  const capMs = Math.min(toMs, nowMs);
  const modelCalls = new WeakMap<DayAcc, Map<string | null, number>>();
  function fold(
    into: DayAcc,
    model: string | null,
    calls: number,
    in_tok: number,
    cached_in: number,
    cache_write: number,
    out_tok: number, context_input: number | null, price_day: string
  ): void {
    const fresh_in = in_tok - cached_in;
    into.calls += calls;
    into.tokens += in_tok + out_tok;
    into.tokens_fresh += fresh_in + out_tok;
    const models = modelCalls.get(into) ?? new Map<string | null, number>();
    modelCalls.set(into, models);
    const count = (models.get(model) ?? 0) + calls; models.set(model, count);
    if (count > into.top_calls) {
      into.top_calls = count;
      into.top_model = model;
    }
    const rate = getCodexRate(ctx.rateCards, model, price_day, context_input ?? undefined);
    if (!rate || (cache_write > 0 && rate.in_cache_write == null)
      || ![in_tok, cached_in, cache_write, out_tok].every(n => Number.isSafeInteger(n) && n >= 0)
      || cached_in + cache_write > in_tok) {
      unpriced.add(model, in_tok + out_tok);
      return;
    }
    into.usd +=
      ((fresh_in - cache_write) / 1e6) * rate.in_uncached +
      (cached_in / 1e6) * rate.in_cache_read +
      (cache_write / 1e6) * (rate.in_cache_write ?? 0) +
      (out_tok / 1e6) * rate.out_total;
  }
  interface EventGroupRow {
    model: string | null;
    context_input: number | null; price_day: string;
    calls: number;
    in_tok: number | null;
    cached_in: number | null;
    cache_write: number | null;
    out_tok: number | null;
  }
  const byDate = new Map<string, DayAcc>();
  if (evHomes.length > 0) {
    const where = [`home IN (${evHomes.map(() => "?").join(",")})`, "ts >= ?", "ts <= ?"];
    const params: SQLQueryBindings[] = [...evHomes, since_ts, until_ts];
    const oc = ownerCond(ctx, accountParam.toLowerCase(), since_ts, until_ts);
    where.push(oc.sql);
    params.push(...oc.params);
    if (pc) {
      where.push(pc.sql);
      params.push(...pc.params);
    }
    try {
      const rows = ctx.sqlite
        .query(
          `SELECT date(ts, 'localtime') AS d, model, in_tok AS context_input, substr(ts,1,10) AS price_day, COUNT(*) AS calls,
                  SUM(in_tok) AS in_tok, SUM(cached_in) AS cached_in,
                  SUM(cache_write) AS cache_write, SUM(out_tok) AS out_tok
           FROM events
           WHERE ${where.join(" AND ")}
           GROUP BY d, model, events.in_tok, substr(ts,1,10)`
        )
        .all(...params) as Array<EventGroupRow & { d: string }>;
      for (const r of rows) {
        let acc = byDate.get(r.d);
        if (!acc) {
          acc = emptyDayAcc();
          byDate.set(r.d, acc);
        }
        fold(acc, r.model, r.calls, r.in_tok || 0, r.cached_in || 0, r.cache_write || 0, r.out_tok || 0, r.context_input, r.price_day);
      }
    } catch {
    }
  }
  interface GaugeRow {
    ts: string;
    used_percent: number;
    resets_at: number | null;
    window_minutes: number | null;
  }
  const gaugeByDate = new Map<string, { end: number; samples: number }>();
  let firstGauge: number | null = null;
  if (rlHomes.length > 0) {
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
        usd: round2(acc.usd),
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
    try {
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
  const blockSeconds = sessionMinutes * 60;
  const fromSeconds = Math.floor(fromMs / 1000);
  const byBlock = new Map<number, DayAcc>();
  if (evHomes.length > 0) {
    const where = [`home IN (${evHomes.map(() => "?").join(",")})`, "ts >= ?", "ts <= ?"];
    const params: SQLQueryBindings[] = [...evHomes, since_ts, until_ts];
    const oc = ownerCond(ctx, accountParam.toLowerCase(), since_ts, until_ts);
    where.push(oc.sql);
    params.push(...oc.params);
    if (pc) {
      where.push(pc.sql);
      params.push(...pc.params);
    }
    try {
      const rows = ctx.sqlite
        .query(
          `SELECT CAST((CAST(strftime('%s', ts) AS INTEGER) - ${fromSeconds}) / ${blockSeconds} AS INTEGER) AS blk,
                  model, in_tok AS context_input, substr(ts,1,10) AS price_day, COUNT(*) AS calls, SUM(in_tok) AS in_tok, SUM(cached_in) AS cached_in,
                  SUM(cache_write) AS cache_write, SUM(out_tok) AS out_tok
           FROM events
           WHERE ${where.join(" AND ")}
           GROUP BY blk, model, events.in_tok, substr(ts,1,10)`
        )
        .all(...params) as Array<EventGroupRow & { blk: number }>;
      for (const r of rows) {
        let acc = byBlock.get(r.blk);
        if (!acc) {
          acc = emptyDayAcc();
          byBlock.set(r.blk, acc);
        }
        fold(acc, r.model, r.calls, r.in_tok || 0, r.cached_in || 0, r.cache_write || 0, r.out_tok || 0, r.context_input, r.price_day);
      }
    } catch {
    }
  }
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
      usd: round2(acc.usd),
      top_model: acc.top_model,
      reported_percent: cover ? round2(cover.peak) : null,
      reported_samples: cover?.samples ?? 0,
      reported_reset_ts: cover ? new Date(cover.anchor! * 1000).toISOString() : null,
    });
  }
  const stateRows = latestAccountState(ctx).filter((r) => r.account.toLowerCase() === accountParam.toLowerCase());
  const liveShort = stateRows.find((r) => r.limit_id === limitId && r.window_minutes === sessionMinutes) ?? null;
  const otherShort = stateRows.filter((r) => r.limit_id !== limitId && r.window_minutes === sessionMinutes);
  let lastPlanShortTs: string | null = null;
  if (rlHomes.length > 0) {
    try {
      const row = ctx.sqlite
        .query(
          `SELECT MAX(ts) AS t FROM ratelimit
           WHERE home IN (${rlHomes.map(() => "?").join(",")}) AND limit_id = ? AND window_minutes = ?`
        )
        .get(...rlHomes, limitId, sessionMinutes) as { t: string | null } | null;
      lastPlanShortTs = row?.t ?? null;
    } catch {
      lastPlanShortTs = null;
    }
  }
  const totals = days.reduce(
    (a, d) => ({
      calls: a.calls + d.calls,
      tokens: a.tokens + d.tokens,
      tokens_fresh: a.tokens_fresh + d.tokens_fresh,
      usd: round2(a.usd + d.usd),
    }),
    { calls: 0, tokens: 0, tokens_fresh: 0, usd: 0 }
  );
  const burnWindows: Array<{ label: string; hours: number; calls: number; tokens: number; tokens_fresh: number }> = [];
  if (evHomes.length > 0) {
    const burnStmt = ctx.sqlite.query(
      `SELECT COUNT(*) AS calls, SUM(in_tok) AS in_tok, SUM(cached_in) AS cached_in, SUM(out_tok) AS out_tok
       FROM events
       WHERE home IN (${evHomes.map(() => "?").join(",")}) AND ts >= ?
             ${pc ? `AND ${pc.sql}` : ""}`
    );
    for (const w of [
      { label: "1h", hours: 1 },
      { label: "6h", hours: 6 },
      { label: "24h", hours: 24 },
      { label: "7d", hours: 168 },
    ]) {
      let calls = 0;
      let tokens = 0;
      let fresh = 0;
      try {
        const r = burnStmt.get(
          ...evHomes,
          new Date(nowMs - w.hours * 3_600_000).toISOString(),
          ...(pc ? pc.params : [])
        ) as { calls: number; in_tok: number | null; cached_in: number | null; out_tok: number | null } | null;
        if (r) {
          calls = r.calls;
          tokens = (r.in_tok || 0) + (r.out_tok || 0);
          fresh = (r.in_tok || 0) - (r.cached_in || 0) + (r.out_tok || 0);
        }
      } catch {
      }
      burnWindows.push({ label: w.label, hours: w.hours, calls, tokens, tokens_fresh: fresh });
    }
  }
  return Response.json({
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
    burn_windows: burnWindows,
    totals,
    unpriced: unpriced.toJSON(),
    note:
      evHomes.length === 0
        ? `account '${accountParam}' has no indexed events - day and session rows carry gauge only`
        : null,
  });
}
