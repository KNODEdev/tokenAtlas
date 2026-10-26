import type { SumVendor } from "./ledger-sums";
import { projectMatcher, readLedgerSums, localHour, sumTokens, ledgerLastCall, readOwnedLedgerHours, readCodexOwnedTimedHours } from "./ledger-sums";
import type { AppContext } from "./app-context-types";
import { HOUR_MS, round2 } from "./api-report-values";
import { apiCodexLedgerRows, apiHasCodexHistory, apiCodexLedgerContext } from "./api-codex-ledger";
import type { AccountScope } from "./account-scope";
import { accountResolverOf, resolveAccountScope, knownAccountIds } from "./account-scope";
import { parseCommonDateParams } from "./api-request-params";
import { eventAccountScope } from "./api-events";
import { modelSpeedSeries, readModelSpeed } from "./model-speed";
import { LONG_CALL_OUT } from "../db/usage-ledger";

interface ActivityCell {
  dow: number;
  hour: number;
  calls: number;
  tokens: number;
  tokens_fresh: number;
}

interface BurnWindow {
  label: string;
  hours: number;
  calls: number;
  tokens: number;
  tokens_fresh: number;
  tokens_per_hour: number;
  fresh_per_hour: number;
}

/**
 * Activity of every account by local weekday and hour, from the ledgers' calendar-hour sums. Hours
 * are UTC instants, so their local day, weekday and hour follow the time zone (and its DST) here.
 */
function handleActivityFromLedgers(ctx: AppContext, url: URL, vendor: string, since: string | undefined, until: string | undefined): Response {
  const selected: SumVendor[] = vendor === "both" ? ["codex", "claude"] : vendor === "all" ? ["codex", "claude", "opencode", "grok", "gemini"]
    : [vendor as SumVendor];
  const project = projectMatcher(url);
  const shift = (day: string, days: number) => new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);
  const rows = readLedgerSums(ctx.sqlite, { vendors: selected, grain: "hour",
    ...(since ? { since: shift(since, -1) } : {}), ...(until ? { until: shift(until, 1) } : {}) });
  const cells = new Map<string, ActivityCell>();
  for (const row of rows) {
    if (project && !project(row)) continue;
    const local = localHour(row.hour!);
    if (since && local.day < since || until && local.day > until) continue;
    const dow = (local.dow + 6) % 7, key = `${dow}:${local.hour}`, tokens = sumTokens(row);
    const cell = cells.get(key) ?? { dow, hour: local.hour, calls: 0, tokens: 0, tokens_fresh: 0 };
    cell.calls += row.calls; cell.tokens += tokens.gross; cell.tokens_fresh += tokens.fresh;
    cells.set(key, cell);
  }
  // Burn rates follow the last call of Codex and Claude, over whole hours ending at it.
  const anchorIso = ledgerLastCall(ctx.sqlite, ["codex", "claude"]);
  const burn: BurnWindow[] = [];
  if (anchorIso) {
    const anchorMs = Date.parse(anchorIso);
    const burnVendors = vendor === "all" ? [] : selected;
    const recent = burnVendors.length ? readLedgerSums(ctx.sqlite, { vendors: burnVendors, grain: "hour",
      since: new Date(anchorMs - 8 * 86_400_000).toISOString().slice(0, 10) }).filter(row => !project || project(row)) : [];
    for (const [label, hours] of BURN_WINDOWS) {
      const fromIso = new Date(anchorMs - hours * HOUR_MS).toISOString();
      const facts = { calls: 0, tokens: 0, tokens_fresh: 0 };
      for (const row of recent) {
        if (row.first_ts < fromIso || row.last_ts > anchorIso) continue;
        const tokens = sumTokens(row);
        facts.calls += row.calls; facts.tokens += tokens.gross; facts.tokens_fresh += tokens.fresh;
      }
      burn.push({ label, hours, ...facts, tokens_per_hour: round2(facts.tokens / hours), fresh_per_hour: round2(facts.tokens_fresh / hours) });
    }
  }
  return Response.json({
    vendor,
    since: since ?? null,
    until: until ?? null,
    bucketing: "local time",
    dow_origin: "monday",
    ...activitySummary([...cells.values()]),
    burn: { anchor_ts: anchorIso, windows: burn },
  });
}

/** Cells (Monday = 0) with their hour and weekday sums, totals and peaks: the body both prepared paths share. */
function activitySummary(unsorted: ActivityCell[]) {
  const cells = [...unsorted].sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, tokens: 0, tokens_fresh: 0 }));
  const byDow = Array.from({ length: 7 }, (_, dow) => ({ dow, calls: 0, tokens: 0, tokens_fresh: 0 }));
  for (const cell of cells) {
    const hour = byHour[cell.hour];
    const dow = byDow[cell.dow];
    if (hour) {
      hour.calls += cell.calls;
      hour.tokens += cell.tokens;
      hour.tokens_fresh += cell.tokens_fresh;
    }
    if (dow) {
      dow.calls += cell.calls;
      dow.tokens += cell.tokens;
      dow.tokens_fresh += cell.tokens_fresh;
    }
  }
  const totals = cells.reduce(
    (sum, cell) => ({
      calls: sum.calls + cell.calls,
      tokens: sum.tokens + cell.tokens,
      tokens_fresh: sum.tokens_fresh + cell.tokens_fresh,
    }),
    { calls: 0, tokens: 0, tokens_fresh: 0 }
  );
  const peakCell = cells.reduce<ActivityCell | null>((best, cell) => (!best || cell.tokens > best.tokens ? cell : best), null);
  const peakHour = byHour.reduce((best, row) => (row.tokens > best.tokens ? row : best), byHour[0]!);
  const peakDow = byDow.reduce((best, row) => (row.tokens > best.tokens ? row : best), byDow[0]!);
  return { cells, by_hour: byHour, by_dow: byDow, totals, peak: { cell: peakCell, hour: peakHour, dow: peakDow } };
}

const BURN_WINDOWS: ReadonlyArray<readonly [string, number]> = [["1h", 1], ["6h", 6], ["24h", 24], ["7d", 168]];

/**
 * One subscription's activity. The ledgers' hour sums describe physical sources and carry no account,
 * so the account's own events are read as /api/breakdown reads them: owned at read time through
 * the account periods (nothing stamped), grouped per day so a prepared day is not read again and a
 * period change reads only the days it covers. Burn windows use whole hours, as the shared view does.
 */
function handleAccountActivity(
  ctx: AppContext,
  url: URL,
  scope: AccountScope,
  since: string | undefined,
  until: string | undefined
): Response {
  // Days are local, as in the shared view; the UTC days read are widened by one on each side.
  const shift = (day: string, days: number) => new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);
  const range = { ...(since ? { since: shift(since, -1) } : {}), ...(until ? { until: shift(until, 1) } : {}) };
  // Calendar-hour sums the account owns, each call once (its canonical copy), from the ledgers.
  const rows: Array<{ hour: number; calls: number; tokens: number; tokens_fresh: number; first_ts: string; last_ts: string }> = [];
  if (scope.vendor === "codex") {
    for (const row of apiCodexLedgerRows(ctx, { ...range, grain: "hour" }, url, accountResolverOf(ctx))) {
      if (row.account?.toLowerCase() !== scope.id.toLowerCase() || row.group.stored.hour == null) continue;
      rows.push({ hour: Number(row.group.stored.hour), calls: row.calls, tokens: row.in_tok + row.out_tok,
        tokens_fresh: Math.max(0, row.in_tok - row.cached_in) + row.out_tok,
        first_ts: row.group.stored.first_ts, last_ts: row.group.stored.last_ts });
    }
  } else {
    const project = projectMatcher(url);
    for (const row of readOwnedLedgerHours(ctx.sqlite, "claude", accountResolverOf(ctx).plan("claude", scope.id), range)) {
      if (project && !project(row)) continue;
      const tokens = sumTokens(row);
      rows.push({ hour: row.hour!, calls: row.calls, tokens: tokens.gross, tokens_fresh: tokens.fresh, first_ts: row.first_ts, last_ts: row.last_ts });
    }
  }
  const cells = new Map<string, ActivityCell>();
  let anchorIso: string | null = null;
  const counted: typeof rows = [];
  for (const row of rows) {
    const local = localHour(row.hour);
    if (since && local.day < since || until && local.day > until) continue;
    counted.push(row);
    const dow = (local.dow + 6) % 7, key = `${dow}:${local.hour}`;
    const cell = cells.get(key) ?? { dow, hour: local.hour, calls: 0, tokens: 0, tokens_fresh: 0 };
    cell.calls += row.calls;
    cell.tokens += row.tokens;
    cell.tokens_fresh += row.tokens_fresh;
    cells.set(key, cell);
    if (!anchorIso || row.last_ts > anchorIso) anchorIso = row.last_ts;
  }
  const burn: BurnWindow[] = [];
  if (anchorIso) {
    const anchorMs = Date.parse(anchorIso);
    for (const [label, hours] of BURN_WINDOWS) {
      const fromIso = new Date(anchorMs - hours * HOUR_MS).toISOString();
      const facts = { calls: 0, tokens: 0, tokens_fresh: 0 };
      for (const row of counted) {
        if (row.first_ts < fromIso || row.last_ts > anchorIso) continue;
        facts.calls += row.calls;
        facts.tokens += row.tokens;
        facts.tokens_fresh += row.tokens_fresh;
      }
      burn.push({ label, hours, ...facts,
        tokens_per_hour: round2(facts.tokens / hours), fresh_per_hour: round2(facts.tokens_fresh / hours) });
    }
  }
  return Response.json({
    vendor: scope.vendor,
    account: scope.id,
    since: since ?? null,
    until: until ?? null,
    bucketing: "local time",
    dow_origin: "monday",
    ...activitySummary([...cells.values()]),
    burn: { anchor_ts: anchorIso, windows: burn },
  });
}

export function handleActivity(ctx: AppContext, url: URL): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return Response.json({ error: dateParams.error }, { status: 400 });
  }
  const { since, until } = dateParams;
  const vendor = url.searchParams.get("vendor") || "both";
  if (!["claude", "codex", "both", "all"].includes(vendor)) {
    return Response.json(
      { error: `Invalid 'vendor' parameter: '${vendor}'. Allowed: claude, codex, both, all.` },
      { status: 400 }
    );
  }
  const scope = eventAccountScope(ctx, url, vendor);
  if (scope instanceof Response) return scope;
  if (scope) return handleAccountActivity(ctx, url, scope, since, until);
  return handleActivityFromLedgers(ctx, url, vendor, since, until);
}

/**
 * Output speed per model over time for one Claude subscription (model-speed.ts): `account` (required), `since`/`until`
 * (UTC days, inclusive) and `grain` (`day`, default, or `hour`). Stored ledger rows only; no parsing, no event scan.
 */
export function handleModelSpeed(ctx: AppContext, url: URL): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) return Response.json({ error: dateParams.error }, { status: 400 });
  const grain = url.searchParams.get("grain") || "day";
  if (grain !== "day" && grain !== "hour")
    return Response.json({ error: `Invalid 'grain' parameter: '${grain}'. Allowed: day, hour.` }, { status: 400 });
  const accountParam = url.searchParams.get("account")?.trim();
  if (!accountParam) return Response.json({ error: "Missing 'account' parameter." }, { status: 400 });
  const scope = resolveAccountScope(ctx, accountParam);
  if (!scope) return Response.json({ error: `Unknown 'account' parameter: '${accountParam}'. Known: ${knownAccountIds(ctx).join(", ")}.` }, { status: 400 });
  if (scope.vendor !== "claude" && scope.vendor !== "codex")
    return Response.json({ error: `'account=${scope.id}' is a ${scope.vendor} subscription; response times are recorded for Claude and Codex calls.` }, { status: 400 });
  const { since, until } = dateParams;
  const range = { ...(since ? { since } : {}), ...(until ? { until } : {}) };
  let models: ReturnType<typeof modelSpeedSeries> = [];
  if (scope.vendor === "claude") models = readModelSpeed(ctx.sqlite, "claude", accountResolverOf(ctx).plan("claude", scope.id), { grain, ...range });
  else if (apiHasCodexHistory(ctx)) {
    // The readiness of the ledger's priced readers (a preparing ledger answers "preparing"), then the account's canonical
    // Codex calls by hour, owned through the periods as /api/activity owns them, read without valuing them.
    const dependencyBases = ["api_equivalent_usd"] as const;
    apiCodexLedgerContext(ctx, { grain: "hour", ...range, dependencyBases });
    models = modelSpeedSeries(readCodexOwnedTimedHours(ctx.sqlite, accountResolverOf(ctx), scope.id, { ...range, dependencyBases }), grain);
  }
  return Response.json({ account: scope.id, provider: scope.vendor, grain, since: since ?? null, until: until ?? null,
    long_out_min: LONG_CALL_OUT, models });
}
