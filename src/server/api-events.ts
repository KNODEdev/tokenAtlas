import { contextPreviewResponse, contextRequested, type JsonResponse } from "./codex-context-preview";
import { currentProjectRules } from "../projects/rules-now";
import type { AppContext } from "./app-context-types";
import type { AccountScope } from "./account-scope";
import { resolveAccountScope, knownAccountIds, accountResolverOf } from "./account-scope";
import { codexEventOrderIsValid } from "./codex-ledger-request-validation";
import { parseCommonDateParams } from "./api-request-params";
import { codexAccountSelector } from "./codex-source-account";
import { apiCodexLedgerIsPending, apiHasCodexHistory, apiCodexAuditReader, roundApiCodexUsd } from "./api-codex-ledger";
import { preparingDataResponse } from "./preparing-response";
import type { SQLQueryBindings } from "../db/sqlite";
import { codexEventOwnedBy, codexEventOwnerOf } from "./codex-event-owner";
import { claudeEventOwnedBySql, claudeEventAccountSql } from "./claude-event-account";
import { getClaudeGroupRate } from "./pricing";
import { GROK_TICKS_PER_USD } from "../ingest/grok";
import { UnpricedCollector, round2 } from "./api-report-values";

/** The project of a raw table's row by the rules at read time (projects/resolve.ts), as SQL over its own columns. */
function rawProjectSql(ctx: AppContext, table: "claude_events" | "oc_events" | "events" | "grok_events" | null): string {
  if (!table) return "NULL";
  return currentProjectRules(ctx.sqlite).sql(table, { store: table === "events" ? "home" : "store", cwd: table === "oc_events" ? "directory" : "cwd",
    project: "project", repo: "repo", day: "substr(ts,1,10)" });
}

interface UsageEvent {
  conversation?: import("../shared/conversation-course").ConversationRef;
  ts: string;
  vendor: string;
  /** Codex and Claude: the account the row's period or session identity names; null when none does or for other providers. */
  account: string | null;
  model: string | null;
  surface: string | null;
  project: string | null;
  tokens: number;
  tokens_fresh: number;
  in_uncached: number;
  in_cached: number;
  cache_write: number;
  out: number;
  reasoning: number;
  usd: number;
  context_price?: import("../shared/context-price").ContextPrice;
  ledger_event_id?: number;
}

/**
 * The Codex or Claude subscription an `account` filter names (null without one), or the 400 that
 * refuses it. Only those two providers resolve an event's account from periods at read time.
 */
export function eventAccountScope(ctx: AppContext, url: URL, vendor: string): AccountScope | Response | null {
  const accountParam = url.searchParams.get("account")?.trim();
  if (!accountParam) return null;
  const scope = resolveAccountScope(ctx, accountParam);
  if (!scope) {
    return Response.json(
      { error: `Unknown 'account' parameter: '${accountParam}'. Known: ${knownAccountIds(ctx).join(", ")}.` },
      { status: 400 }
    );
  }
  if (scope.vendor !== "codex" && scope.vendor !== "claude") {
    return Response.json(
      { error: `'account=${scope.id}' is a ${scope.vendor} subscription; the account filter covers Codex and Claude.` },
      { status: 400 }
    );
  }
  if (!["both", "all", scope.vendor].includes(vendor)) {
    return Response.json(
      { error: `'vendor=${vendor}' contradicts 'account=${scope.id}', which is a ${scope.vendor} subscription.` },
      { status: 400 }
    );
  }
  return scope;
}

/** Exact event bounds `[from_ts, until_ts)` (IA-2026-10-19 v1.1, IA-30): UTC instants, end exclusive. */
export interface EventInstantBounds { from?: string; until?: string }
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?Z$/;
/**
 * The exact bounds of a request, or the 400 that refuses them. They never mix with the whole-day
 * `since`/`until` dates, whose meaning stays unchanged for existing callers.
 */
export function eventInstantBounds(url: URL): EventInstantBounds | Response {
  const from = url.searchParams.get("from_ts")?.trim() || undefined;
  const until = url.searchParams.get("until_ts")?.trim() || undefined;
  if (!from && !until) return {};
  if (url.searchParams.get("since") || url.searchParams.get("until")) {
    return Response.json({ error: "'from_ts'/'until_ts' cannot be combined with 'since'/'until'." }, { status: 400 });
  }
  for (const [name, value] of [["from_ts", from], ["until_ts", until]] as const) {
    if (value && (!INSTANT.test(value) || !Number.isFinite(Date.parse(value)))) {
      return Response.json({ error: `Invalid '${name}' parameter: '${value}'. Expected a UTC instant such as 2026-10-12T13:05:00.000Z.` }, { status: 400 });
    }
  }
  if (from && until && Date.parse(until) <= Date.parse(from)) {
    return Response.json({ error: "'until_ts' must be later than 'from_ts'." }, { status: 400 });
  }
  return { from: from && new Date(Date.parse(from)).toISOString(), until: until && new Date(Date.parse(until)).toISOString() };
}
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function eventRequest(ctx: AppContext, url: URL): Response | { since?: string; until?: string; exact: EventInstantBounds; vendor: string; order: string; scope: AccountScope | null } {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return Response.json({ error: dateParams.error }, { status: 400 });
  }
  const exact = eventInstantBounds(url);
  if (exact instanceof Response) return exact;
  // Exact bounds read the whole UTC days they touch for the ledger state; rows are cut to the instants below.
  const since = exact.from ? utcDay(Date.parse(exact.from)) : dateParams.since;
  const until = exact.until ? utcDay(Date.parse(exact.until) - 1) : dateParams.until;
  const vendor = url.searchParams.get("vendor") || "both";
  if (!["claude", "codex", "opencode", "grok", "gemini", "both", "all"].includes(vendor)) {
    return Response.json(
      { error: `Invalid 'vendor' parameter: '${vendor}'. Allowed: claude, codex, opencode, grok, gemini, both, all.` },
      { status: 400 }
    );
  }
  const order = url.searchParams.get("order") || "ts_desc";
  if (!codexEventOrderIsValid(order)) {
    return Response.json(
      { error: `Invalid 'order' parameter: '${order}'. Allowed: ts_desc, ts_asc, tokens_desc.` },
      { status: 400 }
    );
  }
  const scope = eventAccountScope(ctx, url, vendor);
  return scope instanceof Response ? scope : { since, until, exact, vendor, order, scope };
}

export function handleEvents(ctx: AppContext, url: URL): Response {
  return contextPreviewResponse(ctx.sqlite, json => handleEventsBody(ctx, url, json), contextRequested(url));
}
function handleEventsBody(ctx: AppContext, url: URL, json: JsonResponse): Response {
  const conversation = (vendor: string, row: object) => url.searchParams.get("conversation") === "1" && (row as { id?: number }).id != null
    ? { conversation: { vendor, reference_id: (row as { id: number }).id } } : {};
  const parsed = eventRequest(ctx,url);
  if (parsed instanceof Response) return parsed;
  const { since, until, exact, vendor, order, scope } = parsed;
  const modelFilter = url.searchParams.get("model");
  const projectFilter = url.searchParams.get("project");
  const projectIdFilter = url.searchParams.get("project_id");
  let limit = parseInt(url.searchParams.get("limit") || "100", 10);
  if (isNaN(limit) || limit <= 0) limit = 100;
  limit = Math.min(500, limit);
  let offset = parseInt(url.searchParams.get("offset") || "0", 10);
  if (isNaN(offset) || offset < 0) offset = 0;
  const effVendor = scope ? scope.vendor : vendor;
  // Each Codex and Claude row names the account its periods give it at read time; with an
  // `account` filter only that account's rows are listed. Periods are clipped to the range.
  const within = since || until ? { within: {
    from: exact.from ?? since ?? "0000-01-01",
    until: exact.until ?? (until ? new Date(Date.parse(until) + 86_400_000).toISOString() : "9999-12-31"),
  } } : {};
  const codexSelector = effVendor === "codex" || effVendor === "both" || effVendor === "all" ? codexAccountSelector(ctx, "events") : null;
  const claudeResolver = effVendor === "claude" || effVendor === "both" || effVendor === "all" ? accountResolverOf(ctx) : null;
  if (["codex","both","all"].includes(effVendor) && apiCodexLedgerIsPending(ctx, { since, until, dependencyBases: ["api_equivalent_usd"] })) return preparingDataResponse();
  const conds = (extraModelCol: string, projectCol: string, owned?: { sql: string; params: SQLQueryBindings[] },
    table: "claude_events" | "oc_events" | "events" | "grok_events" | null = null): { clause: string; params: SQLQueryBindings[] } => {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (owned) {
      where.push(owned.sql);
      params.push(...owned.params);
    }
    if (since) {
      where.push("ts >= ?");
      params.push(since);
    }
    if (until) {
      where.push("ts <= ?");
      params.push(until + "T23:59:59.999Z");
    }
    // The whole-day range above keeps the indexed read; the instants then cut it exactly, whatever
    // the provider's timestamp precision, so a boundary row is neither lost nor counted twice.
    if (exact.from) {
      where.push("julianday(ts) >= julianday(?)");
      params.push(exact.from);
    }
    if (exact.until) {
      where.push("julianday(ts) < julianday(?)");
      params.push(exact.until);
    }
    if (modelFilter) {
      where.push(`${extraModelCol} = ?`);
      params.push(modelFilter);
    }
    if (projectFilter) {
      where.push(`${projectCol} = ?`);
      params.push(projectFilter);
    }
    if (projectIdFilter === "unassigned") {
      where.push(`${rawProjectSql(ctx, table)} IS NULL`);
    } else if (projectIdFilter) {
      where.push(`${rawProjectSql(ctx, table)} IS ?`);
      params.push(projectIdFilter);
    }
    return { clause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", params };
  };
  const take = limit + offset;
  const rows: UsageEvent[] = [];
  const unpriced = new UnpricedCollector();
  if (codexSelector && apiHasCodexHistory(ctx)) {
    const readAuditAmount = apiCodexAuditReader(ctx, { since, until, dependencyBases: ["api_equivalent_usd"] }, contextRequested(url));
    const { clause, params } = conds("model", "project",
      scope ? codexEventOwnedBy(ctx.sqlite, codexSelector, scope.id, within) : undefined, "events");
    const owner = codexEventOwnerOf(ctx.sqlite, codexSelector, within);
    const orderSql =
      order === "tokens_desc" ? "(in_tok + out_tok) DESC" : order === "ts_asc" ? "ts ASC" : "ts DESC";
    // With an account the planner picks the home index and sorts every row of the account (2.1 s
    // for codex1 on the live database); walking time from the newest row stops after one page (≤ 73 ms
    // for every account). Ascending order keeps the planner's choice, which the newest-first walk is not.
    const walk = scope && order === "ts_desc"
      && ctx.sqlite.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='events_global_ts'").get()
      ? " INDEXED BY events_global_ts" : "";
    const got = ctx.sqlite
      .query(
        `SELECT ${url.searchParams.get("conversation") === "1" ? "(SELECT c.id FROM codex_price_ledger_copies c WHERE c.home IS events.home AND c.path IS events.path) AS id," : ""}
                home, path, source_offset, ts, model, surface, project, in_tok, cached_in, cache_write, out_tok, reasoning_out,
                ${owner.sql} AS account
         FROM events${walk} ${clause} ORDER BY ${orderSql} LIMIT ?`
      )
      .all(...owner.params, ...params, take) as Array<{
        ts: string;
        account: string | null;
        model: string | null;
        surface: string | null;
        project: string | null;
        price_day?: string; context_input?: number; cache_write_status?: string | null; usage_status?: string | null;
        in_tok: number | null;
        cached_in: number | null;
        cache_write: number | null;
        out_tok: number | null;
        reasoning_out: number | null;
      }>;
    for (const r of got) {
      const inTok = r.in_tok || 0;
      const cached = r.cached_in || 0;
      const cw = r.cache_write || 0;
      const out = r.out_tok || 0;
      const fresh_in = inTok - cached - cw;
      const event = r as typeof r & { home: string; path: string; source_offset: number };
      const amount = readAuditAmount(event.home,event.path,event.source_offset);
      if (amount.unpricedTokens) unpriced.add(r.model,Number(amount.unpricedTokens));
      rows.push({
        ts: r.ts,
        vendor: "codex",
        ...conversation("codex", r),
        account: r.account,
        model: r.model,
        surface: r.surface,
        project: r.project,
        tokens: inTok + out,
        tokens_fresh: fresh_in + out,
        in_uncached: fresh_in,
        in_cached: cached,
        cache_write: cw,
        out,
        reasoning: r.reasoning_out || 0,
        usd: roundApiCodexUsd(amount.pricedSubtotal),
        ...(amount.context_price ? { context_price: amount.context_price } : {}),
        ...(amount.ledger_event_id === undefined ? {} : { ledger_event_id: amount.ledger_event_id }),
      });
    }
  }
  if (claudeResolver) {
    const { clause, params } = conds("model", "project",
      scope ? claudeEventOwnedBySql(ctx.sqlite, claudeResolver, scope.id, within) : undefined, "claude_events");
    const owner = claudeEventAccountSql(ctx.sqlite, claudeResolver, within);
    const orderSql =
      order === "tokens_desc"
        ? "(in_uncached + in_cache_read + in_cache_write + out_total) DESC"
        : order === "ts_asc"
          ? "ts ASC"
          : "ts DESC";
    const got = ctx.sqlite
      .query(
        `SELECT id, ts, model, entrypoint, project, speed, in_uncached, in_cache_read, in_cache_write,
                cache_write_5m, cache_write_1h, out_total, out_thinking, ${owner.sql} AS account
         FROM claude_events ${clause} ORDER BY ${orderSql} LIMIT ?`
      )
      .all(...owner.params, ...params, take) as Array<{
        ts: string;
        account: string | null;
        model: string | null;
        entrypoint: string | null;
        project: string | null;
        speed: string | null;
        in_uncached: number | null;
        in_cache_read: number | null;
        in_cache_write: number | null;
        cache_write_5m: number | null;
        cache_write_1h: number | null;
        out_total: number | null;
        out_thinking: number | null;
      }>;
    for (const r of got) {
      const inU = r.in_uncached || 0;
      const inR = r.in_cache_read || 0;
      const inW = r.in_cache_write || 0;
      const out = r.out_total || 0;
      const rate = getClaudeGroupRate(ctx.rateCards, r.model, r.ts.slice(0, 10), r.speed, r);
      let usd = 0;
      if (rate) {
        usd =
          (inU / 1e6) * rate.in_uncached +
          (inR / 1e6) * rate.in_cache_read +
          ((r.cache_write_5m || 0) / 1e6) * rate.in_cache_write_5m +
          ((r.cache_write_1h || 0) / 1e6) * rate.in_cache_write_1h +
          (out / 1e6) * rate.out_total;
      } else {
        unpriced.add(r.model, inU + inR + inW + out);
      }
      rows.push({
        ts: r.ts,
        vendor: "claude",
        ...conversation("claude", r),
        account: r.account,
        model: r.model,
        surface: r.entrypoint,
        project: r.project,
        tokens: inU + inR + inW + out,
        tokens_fresh: inU + out,
        in_uncached: inU,
        in_cached: inR,
        cache_write: inW,
        out,
        reasoning: r.out_thinking || 0,
        usd: round2(usd),
      });
    }
  }
  if (effVendor === "opencode" || effVendor === "all") {
    const { clause, params } = conds("model", "project", undefined, "oc_events");
    const orderSql =
      order === "tokens_desc"
        ? "(in_tok + cache_read + cache_write + out_tok) DESC"
        : order === "ts_asc"
          ? "ts ASC"
          : "ts DESC";
    try {
      const got = ctx.sqlite
        .query(
          `SELECT id, ts, model, provider, project, in_tok, out_tok, reasoning, cache_read, cache_write, cost
           FROM oc_events ${clause} ORDER BY ${orderSql} LIMIT ?`
        )
        .all(...params, take) as Array<{
          ts: string;
          model: string | null;
          provider: string | null;
          project: string | null;
          price_day?: string; context_input?: number; cache_write_status?: string | null; usage_status?: string | null;
          in_tok: number | null;
          out_tok: number | null;
          reasoning: number | null;
          cache_read: number | null;
          cache_write: number | null;
          cost: number | null;
        }>;
      for (const r of got) {
        const inT = r.in_tok || 0;
        const out = r.out_tok || 0;
        const cr = r.cache_read || 0;
        const cw = r.cache_write || 0;
        rows.push({
          ts: r.ts,
          vendor: "opencode",
          ...conversation("opencode", r),
          account: null,
          model: r.model,
          surface: r.provider,
          project: r.project,
          tokens: inT + cr + cw + out,
          tokens_fresh: inT + out,
          in_uncached: inT,
          in_cached: cr,
          cache_write: cw,
          out,
          reasoning: r.reasoning || 0,
          usd: round2(r.cost || 0),
        });
      }
    } catch {
    }
  }
  if (effVendor === "grok" || effVendor === "all") {
    const { clause, params } = conds("model", "project", undefined, "grok_events");
    const orderSql =
      order === "tokens_desc"
        ? "(in_tok + out_tok) DESC"
        : order === "ts_asc"
          ? "ts ASC"
          : "ts DESC";
    try {
      const got = ctx.sqlite
        .query(
          `SELECT id, ts, model, project, cwd, in_tok, cached_in, cache_write, out_tok,
                  reasoning, model_calls, cost_ticks
           FROM grok_events ${clause} ORDER BY ${orderSql} LIMIT ?`
        )
        .all(...params, take) as Array<{
          ts: string;
          model: string | null;
          project: string | null;
          cwd: string | null;
          price_day?: string; context_input?: number; cache_write_status?: string | null; usage_status?: string | null;
          in_tok: number | null;
          cached_in: number | null;
          cache_write: number | null;
          out_tok: number | null;
          reasoning: number | null;
          model_calls: number | null;
          cost_ticks: number | null;
        }>;
      for (const r of got) {
        const inT = r.in_tok || 0;
        const cached = r.cached_in || 0;
        const out = r.out_tok || 0;
        rows.push({
          ts: r.ts,
          vendor: "grok",
          ...conversation("grok", r),
          account: null,
          model: r.model,
          surface: `turn (${r.model_calls || 0} wywołań)`,
          project: r.project,
          tokens: inT + out,
          tokens_fresh: Math.max(0, inT - cached) + out,
          in_uncached: Math.max(0, inT - cached),
          in_cached: cached,
          cache_write: r.cache_write || 0,
          out,
          reasoning: r.reasoning || 0,
          usd: round2((r.cost_ticks || 0) / GROK_TICKS_PER_USD),
        });
      }
    } catch {
    }
  }
  if (effVendor === "gemini" || effVendor === "all") {
    const { clause, params } = conds("model", "workspace");
    const orderSql =
      order === "tokens_desc"
        ? "(fresh_in + cached_in + out_total) DESC"
        : order === "ts_asc"
          ? "ts ASC"
          : "ts DESC";
    try {
      const got = ctx.sqlite
        .query(
          `SELECT id, ts, ts_basis, model, workspace, conversation_id, gen_idx,
                  fresh_in, cached_in, out_total, out_thinking, usd
           FROM gemini_events ${clause} ORDER BY ${orderSql} LIMIT ?`
        )
        .all(...params, take) as Array<{
          ts: string;
          ts_basis: string;
          model: string | null;
          workspace: string | null;
          conversation_id: string;
          gen_idx: number;
          fresh_in: number | null;
          cached_in: number | null;
          out_total: number | null;
          out_thinking: number | null;
          usd: number | null;
        }>;
      for (const r of got) {
        const fresh = r.fresh_in || 0;
        const cached = r.cached_in || 0;
        const outTok = r.out_total || 0;
        rows.push({
          ts: r.ts,
          vendor: "gemini",
          ...conversation("gemini", r),
          account: null,
          model: r.model,
          surface: `gen #${r.gen_idx} · czas rozmowy`,
          project: r.workspace,
          tokens: fresh + cached + outTok,
          tokens_fresh: fresh + outTok,
          in_uncached: fresh,
          in_cached: cached,
          cache_write: 0,
          out: outTok,
          reasoning: r.out_thinking || 0,
          usd: round2(r.usd || 0),
        });
      }
    } catch {
    }
  }
  rows.sort((a, b) => {
    if (order === "tokens_desc") return b.tokens - a.tokens;
    if (order === "ts_asc") return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
    return a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0;
  });
  const page = rows.slice(offset, offset + limit);
  return json({
    vendor: effVendor,
    account: scope?.id ?? null,
    order,
    since: since ?? null,
    until: until ?? null,
    from_ts: exact.from ?? null,
    until_ts: exact.until ?? null,
    limit,
    offset,
    returned: page.length,
    has_more: rows.length >= take && page.length === limit,
    rows: page,
    unpriced: unpriced.toJSON(),
  });
}
