import type { AppContext } from "./app-context-types";
import type { RateCard } from "./pricing";
import { CodexLedgerNotReady, type LedgerRange } from "../db/codex-price-ledger";
import { codexLedgerPendingReason, codexLedgerReadContext, codexLedgerReadStamp } from "../db/codex-ledger-adapters";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { apiHasCodexHistory, CODEX_API_USD_PRESENTATION_VERSION } from "./api-codex-ledger";
import { codexSourceHomes } from "./capacity-equivalents";
import { accountingOptions } from "./codex-accounting";
import { globalUsageRange } from "./global-usage";
import { isAccountingDay } from "./codex-accounting-pricing";
import { codexProjectReportLedgerRange } from "./codex-ledger-report-dependencies";
import { codexEventOrderIsValid, codexCycleRequest, codexCycleLedgerRanges } from "./codex-ledger-request-validation";

type Context = Pick<AppContext, "sqlite" | "rateCards" | "homeToSubId" | "accounts" | "subIdToHomes" | "codexDiscovery">;
const usdRoutes = new Set(["/api/summary", "/api/breakdown", "/api/compare", "/api/cache", "/api/events",
  "/api/account-history", "/api/repo-history"]);
const sharedRoutes = new Set(["/api/leverage", "/api/global-usage", "/api/codex-accounting", "/api/subscription-accounting",
  "/api/cycle-breakdown", "/api/plan-capacity", "/api/planhealth", "/api/project-cost", "/api/plan-price-coverage"]);
const vendors = new Set(["codex", "claude", "opencode", "grok", "gemini", "both", "all"]);
const vendorRoutes = new Set(["/api/summary", "/api/breakdown", "/api/compare", "/api/cache", "/api/events"]);
/**
 * Views of the ledgers' usage sums (ledger-sums.ts) or stored valuations over the whole history. The project views
 * show calls and tokens only: no price stamp (a whole-ledger read on the HTTP thread after each Codex publication).
 */
const sumRoutes = new Set(["/api/activity", "/api/missing-rates"]);
const accountRoutes = new Set(["/api/breakdown", "/api/events",
  "/api/planhealth", "/api/codex-accounting", "/api/subscription-accounting"]);
const hasCodex = (vendor: string) => ["codex", "both", "all"].includes(vendor);
const commonRange = (params: URLSearchParams, from = "since", to = "until", ordered = true): LedgerRange | undefined => {
  const since = params.get(from) || undefined, until = params.get(to) || undefined;
  if (since && !isAccountingDay(since) || until && !isAccountingDay(until) || ordered && since && until && since > until) return undefined;
  return { ...(since ? { since } : {}), ...(until ? { until } : {}) };
};

/** An invalid request belongs to its handler's existing 400 contract, never to readiness. */
export function codexLedgerRequestRanges(ctx: Context, url: URL): LedgerRange[] {
  const route = url.pathname, params = url.searchParams;
  if (route === "/api/missing-rates") return [{ dependencyProjects: false }];
  if (sumRoutes.has(route)) return route === "/api/activity" && !hasCodex(params.get("vendor") || "both") ? [] : [{}];
  if (!usdRoutes.has(route) && !sharedRoutes.has(route)) return [];
  const vendor = params.get("vendor") || "both";
  if (vendorRoutes.has(route) && (!vendors.has(vendor) || !hasCodex(vendor))) return [];
  if (["/api/summary", "/api/compare", "/api/cache"].includes(route) && !["codex", "claude", "both"].includes(vendor)) return [];
  const provider = params.get("provider")?.toLowerCase();
  if (route === "/api/subscription-accounting" && (!provider || !["codex", "openai"].includes(provider))) return [];
  if (route === "/api/plan-capacity" && (!provider || !["codex", "openai"].includes(provider)
    || !params.get("plan_id")?.trim() || !params.get("window_kind")?.trim())) return [];
  const account = accountRoutes.has(route) ? params.get("account")?.trim().toLowerCase().replace(/::business$/, "") : undefined;
  const subscription = account && ctx.accounts?.subscriptions?.find(row => row.id.toLowerCase() === account);
  if (accountRoutes.has(route) && subscription && !["codex", "openai"].includes(subscription.vendor?.toLowerCase() ?? "codex")) return [];
  const group = params.get("group");
  if (group && ["/api/summary", "/api/account-history"].includes(route) && !["day", "week", "month"].includes(group)) return [];
  if (route === "/api/breakdown" && !["model", "project", "raw_project", "store", "account", "surface"].includes(params.get("dim") ?? "")) return [];
  if (route === "/api/events" && !codexEventOrderIsValid(params.get("order") || "ts_desc")) return [];
  const basis = usdRoutes.has(route) ? { dependencyBases: ["api_equivalent_usd"] as const } : {};
  if (route === "/api/compare") {
    const a = commonRange(params, "a_since", "a_until", false), b = commonRange(params, "b_since", "b_until", false);
    // Compare historically accepts a reversed window as empty. Its other window still matters.
    return a && b ? [a, b].filter(range => !(range.since && range.until && range.since > range.until))
      .map(range => ({ ...range, ...basis })) : [];
  }
  if (["/api/codex-accounting", "/api/subscription-accounting", "/api/global-usage"].includes(route)) {
    try {
      const range = route === "/api/global-usage" ? globalUsageRange(params) : accountingOptions(params);
      if ("vendors" in range && range.vendors && !range.vendors.includes("codex")) return [];
      return [{ fromMs: Date.parse(range.since), toMs: Date.parse(range.until) + 86400000 }];
    } catch { return []; }
  }
  if (route === "/api/cycle-breakdown") {
    const parsed = codexCycleRequest(ctx,url);
    return "error" in parsed ? [] : codexCycleLedgerRanges(parsed,url);
  }
  // These current reports include complete windows or account history beyond a supplied day.
  if (["/api/plan-capacity", "/api/planhealth"].includes(route)) {
    if (account && !ctx.subIdToHomes.has(account) && !subscription) return [];
    const declaredCodex = ctx.accounts?.subscriptions?.some(row => ["codex", "openai"].includes(row.vendor?.toLowerCase() ?? "codex"));
    if (ctx.accounts && !declaredCodex && !ctx.subIdToHomes.size && !ctx.codexDiscovery?.accounts.length) return [];
    return [{}];
  }
  const range = commonRange(params);
  if (!range) return [];
  if (route === "/api/project-cost" || route === "/api/plan-price-coverage") return [codexProjectReportLedgerRange(range)];
  return [{ ...range, ...basis }];
}

/** Resolve native dependencies before any HTTP, prepared-view or direct-reader cache hit. */
export function codexLedgerRequestStamp(ctx: Context, url: URL): string | null {
  const ranges = codexLedgerRequestRanges(ctx, url);
  if (!ranges.length || !apiHasCodexHistory(ctx)) return null;
  if (!ctx.rateCards) throw new SubscriptionFactsPending("Codex price configuration awaits background preparation", "codex");
  const context = { ...codexLedgerReadContext(ctx.rateCards),
    ...(["/api/codex-accounting", "/api/subscription-accounting"].includes(url.pathname) && url.searchParams.get("reference_day")
      ? { referenceDay: url.searchParams.get("reference_day")! } : {}) };
  const stamps = ranges.map(range => {
    const reason = codexLedgerPendingReason(ctx.sqlite, { ...context, range });
    if (reason) throw new SubscriptionFactsPending(`Codex prices await background preparation (${reason})`, "codex");
    try { return codexLedgerReadStamp(ctx.sqlite, context, range); }
    catch (error) {
      if (error instanceof CodexLedgerNotReady) throw new SubscriptionFactsPending("Codex prices await background preparation", "codex");
      throw error;
    }
  });
  return JSON.stringify([CODEX_API_USD_PRESENTATION_VERSION, ...stamps]);
}

export { ratesWithoutAuthoritativeCodexPolicy } from "./codex-ledger-report-dependencies";
