import type { AppContext } from "./app-context-types";
import { withReadSnapshot } from "../db/analysis";
import { codexLedgerReadContext, readCodexLedgerOwnedSeries } from "../db/codex-ledger-adapters";
import { loadAccountResolver } from "./account-resolver";
import { isAccountingDay } from "./codex-accounting-pricing";
import type { CodexModelCacheHistory, CodexModelCacheHour } from "../shared/codex-window-detail";

const DAY = 86_400_000;
/** Requests every model of the account at once (the Models table); "?" stays the unnamed model. */
export const ALL_CACHE_MODELS = "*";
export function modelCacheRequest(url: URL) {
  const account = url.searchParams.get("account")?.trim().toLowerCase(), model = url.searchParams.get("model");
  const since = url.searchParams.get("since") ?? undefined, until = url.searchParams.get("until") ?? "";
  if (!account || ["all", "__all__"].includes(account) || !model || !model.trim() || model.length > 256)
    throw new Error("Choose one account and model");
  if (!isAccountingDay(until) || since !== undefined && (!isAccountingDay(since) || since > until
    || Date.parse(until) - Date.parse(since) > 36_599 * DAY)) throw new Error("Expected ordered YYYY-MM-DD dates");
  return { account, model, since, until };
}

type Context = Pick<AppContext, "sqlite" | "rateCards"> & { accounts: Pick<AppContext["accounts"], "subscriptions"> };
/** Daily input counters from published hour cohorts; ownership stays in the shared period resolver. Each point names its model. */
export function readModelCacheHistory(ctx: Context, request: ReturnType<typeof modelCacheRequest>): CodexModelCacheHistory {
  return withReadSnapshot(ctx.sqlite, () => {
    const { account, model, since, until } = request, end = Date.parse(until) + DAY, every = model === ALL_CACHE_MODELS;
    const stored = model === "?" ? null : model;
    const resolver = loadAccountResolver(ctx.sqlite, ctx.accounts.subscriptions);
    // All has no lower instant bound: read stored hours, never an unbounded event-range fallback.
    const range = { grain: "hour" as const, ...(every ? {} : { models: [stored], dependencyModels: [stored] }), dependencyBases: [] as const,
      ...(since ? { fromMs: Date.parse(since), toMs: end } : {}) };
    const ledger = codexLedgerReadContext(ctx.rateCards);
    const days = new Map<string, CodexModelCacheHour>();
    for (const { group, account: owner } of readCodexLedgerOwnedSeries(ctx.sqlite, range, resolver, ledger, [] as const, { validTokensOnly: true })) {
      const row = group.stored;
      if (owner?.toLowerCase() !== account || !every && row.model !== stored || !group.selected || row.api_reason === "invalid_tokens"
        || row.credit_reason === "invalid_tokens" || group.quality.invalid_token_events > 0n) continue;
      const at = row.hour! * 3_600_000;
      if (at >= end) continue;
      const hour = new Date(Math.floor(at / DAY) * DAY).toISOString(), name = every ? row.model ?? "?" : model;
      const input = group.tokens.in_uncached! + group.tokens.in_cache_read! + group.tokens.in_cache_write_unknown!;
      const key = `${hour}|${name}`, point = days.get(key) ?? { model: name, hour, calls: 0, input: 0, cached: 0 };
      point.calls += Number(group.calls); point.input += Number(input); point.cached += Number(group.tokens.in_cache_read!);
      if (![point.calls, point.input, point.cached].every(Number.isSafeInteger)) throw new Error("Cache counters exceed the safe integer range");
      days.set(key, point);
    }
    const hours = [...days.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.model.localeCompare(b.model));
    if (!["input", "cached", "calls"].every(key => Number.isSafeInteger(hours.reduce((sum, point) =>
      sum + point[key as "input" | "cached" | "calls"], 0)))) throw new Error("Cache history totals exceed the safe integer range");
    return { account, model, grain: "day", from: since ? new Date(since).toISOString() : hours[0]?.hour ?? new Date(until).toISOString(),
      until: new Date(end).toISOString(), hours };
  });
}

export function handleModelCacheHistory(ctx: Context, url: URL): Response {
  let request: ReturnType<typeof modelCacheRequest>;
  try { request = modelCacheRequest(url); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  return Response.json(readModelCacheHistory(ctx, request));
}
