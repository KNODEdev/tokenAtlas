import { readWindowIntervals, WindowUsagePreparing, readSpanSums } from "./window-usage-read";
import { grokRollingId, grokGaugeAccount } from "./grok-gauge-spans";
import { accountUsageSpan } from "./account-usage-span";
import { GROK_TICKS_PER_USD } from "../ingest/grok";
import type { AppContext } from "./app-context-types";
import { accountResolverOf } from "./account-scope";
import { round2 } from "./api-report-values";
import type { GrokGaugeConfig } from "./grok-limit";

interface GrokModelRow {
  model: string;
  turns: number;
  calls: number;
  tokens: number;
  fresh: number;
  usd: number;
}

interface GrokWindow {
  window_hours: number;
  anchored: false;
  since_ts: string;
  until_ts: string;
  spend: {
    turns: number;
    calls: number;
    gross: number;
    fresh: number;
    cached: number;
    out: number;
    reasoning: number;
    usd: number;
  };
  models: GrokModelRow[];
  first_ts: string | null;
  last_ts: string | null;
  age_hours: number | null;
  usd_basis: "vendor";
  ticks_per_usd: number;
}

/**
 * The Grok card's window (plan U1.4): the account's stored rolling fallback of `windowMinutes`, which
 * ends at its newest call (`window_usage`, kept by the window producer), and the account's first and
 * newest call from the usage ledger's stored days. No call is read here. A length the producer does
 * not keep has no window; a missing row is "preparing".
 */
export function storedGrokWindow(ctx: AppContext, account: string, windowMinutes: number): GrokWindow | null {
  const intervals = readWindowIntervals(ctx.sqlite, "grok", account);
  const rolling = intervals.find((interval) => interval.kind === "rolling" && interval.id === grokRollingId(windowMinutes));
  const span = accountUsageSpan(ctx.sqlite, "grok", account, accountResolverOf(ctx), ctx.rateCards);
  if (span && !rolling) {
    // A call exists, so the producer keeps the account's rolling lengths; one it does not keep has no stored window.
    if (intervals.some((interval) => interval.kind === "rolling")) return null;
    throw new WindowUsagePreparing();
  }
  const spend = { turns: 0, calls: 0, gross: 0, fresh: 0, cached: 0, out: 0, reasoning: 0, usd: 0 };
  const models: GrokModelRow[] = [];
  const nowMs = Date.now();
  if (rolling) {
    const rail = readSpanSums(ctx.sqlite, "grok", account, [rolling.id], ["rail"]).get(rolling.id)!.rail;
    for (const row of rail.by_model) {
      if (row.excluded !== null) continue;
      const fresh = row.input - row.cached + row.output;
      spend.turns += row.calls; spend.calls += row.calls; spend.gross += row.input + row.output; spend.fresh += fresh;
      spend.cached += row.cached; spend.out += row.output; spend.reasoning += row.reasoning;
      models.push({ model: row.model || "?", turns: row.calls, calls: row.calls, tokens: row.input + row.output, fresh,
        usd: round2(row.reported_usd ?? 0) });
    }
    spend.usd = round2(rail.reported?.usd ?? 0);
  }
  models.sort((a, b) => b.tokens - a.tokens);
  const lastTs = span?.last_ts ?? null;
  return {
    window_hours: windowMinutes / 60,
    anchored: false,
    since_ts: rolling?.start ?? new Date(nowMs - windowMinutes * 60_000).toISOString(),
    until_ts: rolling?.end ?? new Date(nowMs).toISOString(),
    spend,
    models,
    first_ts: span?.first_ts ?? null,
    last_ts: lastTs,
    age_hours: lastTs ? Math.round(((nowMs - new Date(lastTs).getTime()) / 3_600_000) * 100) / 100 : null,
    usd_basis: "vendor",
    ticks_per_usd: GROK_TICKS_PER_USD,
  };
}

/** The gauge configuration of a Grok account: grok-gauge.json for its account, otherwise the account alone. */
export function grokGaugeFor(ctx: AppContext, account: string): GrokGaugeConfig {
  return grokGaugeAccount(ctx.grokGauge ?? {}) === account.toLowerCase() ? ctx.grokGauge
    : { vendor: "grok", subscription: account, store: account, plan: ctx.vendorDiscovery?.accounts.find(a => a.id === account)?.plan ?? undefined };
}

/** Grok accounts: declared and discovered ones, and the account grok-gauge.json names. */
export function grokAccounts(ctx: AppContext): string[] {
  const out = new Map<string, string>();
  for (const id of [...(ctx.vendorDiscovery?.accounts ?? []).filter(a => a.vendor === "grok").map(a => a.id),
    ...accountResolverOf(ctx).accounts("grok"),
    ...(ctx.grokGauge?.subscription || ctx.grokGauge?.store ? [grokGaugeAccount(ctx.grokGauge)] : [])])
    if (!out.has(id.toLowerCase())) out.set(id.toLowerCase(), id);
  return [...out.values()];
}
