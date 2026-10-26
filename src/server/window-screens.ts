import { latestAccountState as apiLatestAccountState } from "./account-probes";
import { handleCycleBreakdown as apiHandleCycleBreakdown } from "./api-cycle-breakdown";
import { serveSubscriptionAccounting as apiServeSubscriptionAccounting, handleUsageSeries as apiHandleUsageSeries } from "./api-usage-series";
import { handleWindows as apiHandleWindows } from "./api-window-rail";
import { handleClaudeLimit as apiHandleClaudeLimit } from "./api-provider-limits";
import type { AppContext } from "./app-context-types";
import { cacheKey } from "./cache";
import { analysisHash } from "../db/analysis";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { codexHomeSource } from "./event-source";
import { projectRulesStamp } from "../projects/rules-now";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-unavailable";
import { currentCodexWindowMinutes, handleCodexAccounting } from "./codex-accounting";
import { ledgerProviderOf, subscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import { ANSWER_SCOPE_ALL, type AnswerScope } from "../db/window-answers";
import { buildModel, type AtlasModel, type CycleView } from "../web/lib/cycle";
import { cyclePlanLabel, observationOf, trafficRangeOf } from "../web/lib/codex-window-stats";
import { previousCapWindows } from "../web/lib/window-caps";
import type { UsageSeries, WindowsResponse } from "../web/lib/api";
import { handleModelCacheHistory, modelCacheRequest } from "./model-cache-history";
import { handleWindowProjects, windowProjectsProvider, windowProjectsRequest } from "./window-projects";

/**
 * Window screens: the one registry of the screens a window or subscription switch reads, for every
 * provider (docs/provider-contract.md, "Window screens"). Each entry declares
 *
 * - `scope`: the provider, account and instants its answer reads (or null: the request keeps its own path);
 *   the request itself (`cacheKey`) is the answer's key, and `family` the same request with its moving end;
 * - `produce`: the provider's builder of one answer from the shared registers (ledgers, limit_windows,
 *   window_usage, probe readings) — the only provider-specific part;
 * - `clock`: whether ages and countdowns are presented at read time.
 *
 * - `prefill`: the requests the screen makes when it is first opened, for every account and window, so the
 *   background prefill stores their answers before anyone asks (data-read.ts): the URLs the web client builds,
 *   derived with its own functions from the stored rail answers.
 *
 * Everything else is shared and provider-blind: storage and staleness (db/window-answers.ts, the marks
 * every writer of window inputs appends), computation off the HTTP thread, publication by the background
 * writer, background recompute, prefill and the read (data-read.ts).
 */
export type StoredScope = AnswerScope & { family: string };
/** A request a screen makes when it is first opened, prefilled in the background (data-read.ts). */
export interface PrefillRequest {
  url: URL;
  /** 0: the rail of a subscription switch; 1: a current window; 2: a closed window (newest `endMs` first); 3: a range screen's default. */
  order: number;
  endMs: number;
  /**
   * The request's end moves with the clock or the readings (its family is the request without that end): it is
   * prefilled only while its family has no answer at all; the read serves that one while the current end is computed.
   */
  moving: boolean;
}
/** The stored answer body of a request (a stale one included), or null. */
export type StoredBody = (url: URL) => unknown;
export interface WindowScreen {
  reason: string;
  scope(url: URL, ctx: AppContext): StoredScope | null;
  produce(ctx: AppContext, url: URL): Response | Promise<Response>;
  clock: boolean;
  /** Dependencies not carried by interval marks; absent means the shared configuration stamp. */
  configuration?(ctx: AppContext, url: URL, latest?: () => ReturnType<typeof apiLatestAccountState>): string;
  /** The window rail a subscription switch waits for before anything else: computed ahead of other screens. */
  first?: true;
  prefill?(ctx: AppContext, stored: StoredBody): PrefillRequest[];
  /**
   * The instant after which the answer no longer changes with the clock (only by marks), when earlier than the end of its
   * scope: an answer whose inputs are all past is not computed again every few minutes.
   */
  clockEnd?(url: URL): number | null;
}

const DAY_MS = 86_400_000;
/** The instants before every recorded one. */
const OPEN_SCOPE = 8_640_000_000_000_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The request without the named parameters (its family). */
function familyOf(url: URL, moving: readonly string[]): string {
  const rest = new URL(url);
  for (const name of moving) rest.searchParams.delete(name);
  return cacheKey(rest);
}
function accountOf(url: URL): string {
  const account = url.searchParams.get("account")?.trim().toLowerCase().replace(/::business$/, "");
  return !account || account === "all" || account === "__all__" ? ANSWER_SCOPE_ALL : account;
}
/** Include the selected meter's boundary context and a local-day offset beyond UTC. */
function daysScope(url: URL, provider: string, ctx?: AppContext): StoredScope | null {
  const since = url.searchParams.get("since"), until = url.searchParams.get("until");
  if (!since || !until || !DAY.test(since) || !DAY.test(until)) return null;
  const minutes = Number(url.searchParams.get("window_minutes") ?? (ctx?.sqlite && provider === "codex"
    ? currentCodexWindowMinutes(ctx.sqlite, accountOf(url)) : 10080));
  const days = provider === "codex" && minutes === 43200 ? 30 : 7;
  return { provider, account: accountOf(url), fromMs: Date.parse(since) - (days + 1) * DAY_MS, untilMs: Date.parse(until) + (days + 2) * DAY_MS,
    family: familyOf(url, ["until"]) };
}
/** The register provider of a declared subscription: Codex or a shared-ledger provider. */
function providerOfSubscription(ctx: AppContext, account: string): string | null {
  const vendor = ctx.accounts.subscriptions.find(subscription => subscription.id.toLowerCase() === account)?.vendor;
  if (vendor === undefined) return null;
  const name = (vendor || "codex").toLowerCase();
  return ["codex", "openai"].includes(name) ? "codex" : ledgerProviderOf(name)?.id ?? null;
}
/** A whole-history screen of one subscription. */
function subscriptionScope(url: URL, provider: string | null): StoredScope | null {
  const account = accountOf(url);
  if (!provider || account === ANSWER_SCOPE_ALL) return null;
  return { provider, account, fromMs: -OPEN_SCOPE, untilMs: null, family: cacheKey(url) };
}

/** A request as the web client sends it: undefined and empty parameters are left out (web/lib/api.ts `get`). */
function request(path: string, params: Record<string, string | number | undefined>): URL {
  const url = new URL(path, "http://local");
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  return url;
}
/** Declared subscriptions with the register provider their screens read. */
const subscriptionsOf = (ctx: AppContext) => (ctx.accounts.subscriptions ?? []).flatMap(subscription => {
  const provider = providerOfSubscription(ctx, subscription.id.toLowerCase());
  return provider ? [{ id: subscription.id, provider }] : [];
});
/** The window lengths of the window selector with a cycle series (Codex). */
const SERIES_WINDOWS = [10080, 300, 43200] as const;
const seriesUrl = (account: string, window: number) => request("/api/usage-series", { account, window, points: 900 });
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Inclusive UTC days, matching the range screen's default 30-day selection. */
function defaultDays(): { since: string; until: string } {
  const until = utcDay(Date.now());
  return { since: utcDay(Date.parse(until) - 29 * DAY_MS), until };
}
/** Every Codex cycle of an account's stored rails, as the Overview models them (no live reading). */
function codexCycles(ctx: AppContext, stored: StoredBody): Array<{ account: string; model: AtlasModel; cycle: CycleView }> {
  return subscriptionsOf(ctx).filter(item => item.provider === "codex").flatMap(({ id }) => SERIES_WINDOWS.flatMap(window => {
    const series = stored(seriesUrl(id, window)) as UsageSeries | null;
    if (!series?.cycles) return [];
    const model = buildModel(series);
    return model.cycles.map(cycle => ({ account: id, model, cycle }));
  }));
}
const cycleOrder = (cycle: CycleView, endIso: string) => ({ order: cycle.isActive ? 1 : 2, endMs: Date.parse(endIso) });

/**
 * Dated breakdowns read the account's selected homes, source mapping, Codex policy and (when filtered)
 * project rules. Other providers' settings, plan labels and capacity configuration do not enter their body.
 * The latest short-counter row is special: a newer sample outside the window can displace one inside it.
 * Include exactly that projected state, without the age presented at read time, alongside the range marks.
 */
function cycleBreakdownConfiguration(ctx: AppContext, url: URL, readLatest = () => apiLatestAccountState(ctx)): string {
  const account = accountOf(url), params = url.searchParams;
  const from = Date.parse(params.get("since_ts") ?? ""), until = Date.parse(params.get("until_ts") ?? "");
  const limit = params.get("limit_id") || "codex", minutes = parseInt(params.get("session_window") || "300", 10);
  const homes = [...ctx.subIdToHomes.get(account) ?? []].sort();
  let latest: unknown;
  try {
    const rows = readLatest().filter(row => row.account.toLowerCase() === account
      && Date.parse(row.ts) >= from && Date.parse(row.ts) < until && row.window_minutes === minutes)
      .map(({ age_minutes: _age, ...row }) => row);
    latest = [rows.find(row => row.limit_id === limit) ?? null, rows.filter(row => row.limit_id !== limit)];
  } catch (error) {
    if (!(error instanceof ProbeAccountIndexUnavailable)) throw error;
    // The real producer returns preparing; becoming available changes this dependency too.
    latest = "probe-account-index-pending";
  }
  return analysisHash([
    "dated-breakdown-v2-cache-timeline", homes,
    homes.map(home => codexHomeSource(home, ctx.accounts.sources, ARCHIVE_LOGICAL_ROOT)),
    ctx.rateCards ? [ctx.rateCards.codex_ledger_policy ?? null, ctx.rateCards.codex_accounting ?? null] : null,
    params.get("project_id") ? projectRulesStamp(ctx.sqlite) : null,
    latest, Intl.DateTimeFormat().resolvedOptions().timeZone,
  ]);
}

export const WINDOW_SCREENS: Readonly<Record<string, WindowScreen>> = {
  "/api/window-projects": {
    reason: "one account's projects and hourly traffic inside exact window bounds, from published registers",
    clock: false,
    produce: handleWindowProjects,
    configuration(ctx, url) {
      const account = accountOf(url), provider = windowProjectsProvider(ctx, account), homes = [...ctx.subIdToHomes.get(account) ?? []].sort();
      const rates = provider === "codex" ? [ctx.rateCards.codex_ledger_policy, ctx.rateCards.codex_accounting]
        : provider ? ctx.rateCards.vendors[subscriptionAccountingAdapter(provider).rateVendor] : null;
      return analysisHash(["window-projects-v2", projectRulesStamp(ctx.sqlite), rates, homes,
        homes.map(home => codexHomeSource(home, ctx.accounts.sources, ARCHIVE_LOGICAL_ROOT)),
        ctx.accounts.subscriptions.filter(row => (row.vendor || "codex") === provider).map(row => [row.id, row.account_key])]);
    },
    scope(url, ctx) {
      try {
        const range = windowProjectsRequest(url), provider = windowProjectsProvider(ctx, range.account);
        return provider ? { provider, account: accountOf(url), fromMs: Date.parse(range.from), untilMs: Date.parse(range.until), family: cacheKey(url) } : null;
      } catch { return null; }
    },
  },
  "/api/model-cache-history": {
    reason: "one account and model's input counters from stored ledger hours, published as UTC days",
    clock: false,
    produce: handleModelCacheHistory,
    configuration(ctx, url) {
      const account = accountOf(url).replace(/::business$/, ""), homes = [...ctx.subIdToHomes.get(account) ?? []].sort();
      return analysisHash(["model-cache-v2", homes, homes.map(home => codexHomeSource(home, ctx.accounts.sources, ARCHIVE_LOGICAL_ROOT))]);
    },
    scope(url) {
      try {
        const range = modelCacheRequest(url);
        return { provider: "codex", account: range.account, fromMs: range.since ? Date.parse(range.since) : -OPEN_SCOPE,
          untilMs: Date.parse(range.until) + DAY_MS, family: cacheKey(url) };
      } catch { return null; }
    },
  },
  // Codex: one window's breakdown (the window rail, its paired observation and the history of earlier windows).
  "/api/cycle-breakdown": {
    reason: "one Codex window's calls, priced call by call, and its meter samples",
    configuration: cycleBreakdownConfiguration,
    clock: true,
    produce: (ctx, url) => apiHandleCycleBreakdown(ctx, url),
    scope(url) {
      const params = url.searchParams;
      if (params.get("valuation") !== "dated" || accountOf(url) === ANSWER_SCOPE_ALL) return null;
      const since = Date.parse(params.get("since_ts") ?? ""), until = Date.parse(params.get("until_ts") ?? "");
      if (!Number.isFinite(since) || !Number.isFinite(until)) return null;
      return { provider: "codex", account: accountOf(url), fromMs: since, untilMs: until + 1, family: familyOf(url, ["until_ts"]) };
    },
    // The selected window's breakdown and paired observation (CodexSections), and each window as a history sample of a later one.
    prefill: (ctx, stored) => codexCycles(ctx, stored).flatMap(({ account, model, cycle }) => {
      const range = trafficRangeOf(cycle), raw = cycle.raw, at = cycleOrder(cycle, range.until);
      const anchor = raw.sample_count > 0 ? raw.anchor ?? undefined : undefined, limitId = raw.limit_id ?? model.series.limit_id;
      const out: PrefillRequest[] = [{ ...at, moving: cycle.isActive && !cycle.resetIso,
        url: request("/api/cycle-breakdown", { account, since_ts: range.from, until_ts: range.until, anchor, limit_id: limitId, valuation: "dated" }) }];
      const observation = observationOf(cycle);
      if (observation.from && observation.until) out.push({ ...at, moving: cycle.isActive, url: request("/api/cycle-breakdown",
        { account, limit_id: limitId, anchor, since_ts: observation.from, until_ts: observation.until, end_inclusive: "true", valuation: "dated" }) });
      if (!cycle.isActive) out.push({ ...at, moving: false, url: request("/api/cycle-breakdown", { account, since_ts: range.from,
        until_ts: range.until, anchor: raw.anchor ?? undefined, limit_id: raw.limit_id ?? undefined, valuation: "dated" }) });
      return out;
    }),
  },
  // Every provider's window accounting over a range of days: Codex's own report, the shared report for the others.
  "/api/codex-accounting": {
    reason: "a Codex account's windows over a range of days with their calibration",
    clock: false,
    produce: (ctx, url) => handleCodexAccounting(ctx, new Request(url)),
    scope: (url, ctx) => daysScope(url, "codex", ctx),
    // A weekly window's history of earlier windows on the Overview (CodexSections), and the Capacity screen's default range.
    prefill: (ctx, stored) => [...codexCycles(ctx, stored).flatMap(({ account, model, cycle }) => {
      const limitId = cycle.raw.limit_id ?? model.series.limit_id;
      if (cycle.windowHours !== 168 || limitId !== "codex") return [];
      const plan = cyclePlanLabel(cycle);
      const candidates = previousCapWindows(model.closed.filter(c => c.usedPercent >= 10 && cyclePlanLabel(c) === plan), cycle);
      const since = candidates.at(-1)?.startIso.slice(0, 10) ?? trafficRangeOf(cycle).from.slice(0, 10);
      const end = Date.parse(cycle.resetIso ?? cycle.endIso), until = utcDay(Math.min(Date.now(), end));
      return [{ ...cycleOrder(cycle, new Date(end).toISOString()), moving: until === utcDay(Date.now()),
        url: request("/api/codex-accounting", { account, since, until }) }];
    }), ...subscriptionsOf(ctx).filter(item => item.provider === "codex")
      .map(({ id }) => ({ order: 3, endMs: Date.now(), moving: true, url: request("/api/codex-accounting", { account: id, ...defaultDays() }) }))],
  },
  "/api/subscription-accounting": {
    reason: "a Claude, Gemini, Grok or GLM account's windows over a range of days",
    clock: true,
    produce: (ctx, url) => apiServeSubscriptionAccounting(ctx, new Request(url)),
    scope(url) {
      const name = url.searchParams.get("provider")?.toLowerCase() ?? "";
      if (["codex", "openai"].includes(name)) return null;
      let provider: string;
      try { provider = subscriptionAccountingAdapter(name).id; } catch { return null; }
      return daysScope(url, provider);
    },
    // The Capacity screen's default range.
    prefill: ctx => subscriptionsOf(ctx).filter(item => item.provider !== "codex").map(({ id, provider }) =>
      ({ order: 3, endMs: Date.now(), moving: true, url: request("/api/subscription-accounting", { since: defaultDays().since,
        until: defaultDays().until, account: id, provider }) })),
  },
  // The window rail of a subscription switch: Codex's series, every other provider's windows.
  "/api/usage-series": {
    reason: "a Codex account's window rail over its whole history (stored windows, readings, meter samples no period owns)",
    clock: true, first: true,
    produce: (ctx, url) => apiHandleUsageSeries(ctx, url),
    scope(url) {
      if (url.searchParams.has("since") || url.searchParams.has("until")) return null;
      const account = url.searchParams.get("account")?.trim().toLowerCase() || "codex1";
      return { provider: "codex", account, fromMs: -OPEN_SCOPE, untilMs: null, family: cacheKey(url) };
    },
    prefill: ctx => subscriptionsOf(ctx).filter(item => item.provider === "codex")
      .flatMap(({ id }) => SERIES_WINDOWS.map(window => ({ order: 0, endMs: Date.now(), moving: false, url: seriesUrl(id, window) }))),
  },
  "/api/windows": {
    reason: "a subscription's limit windows over its whole history with their readings (every provider)",
    clock: true, first: true,
    produce: (ctx, url) => apiHandleWindows(ctx, url),
    scope: (url, ctx) => subscriptionScope(url, providerOfSubscription(ctx, accountOf(url))),
    prefill: ctx => subscriptionsOf(ctx).map(({ id }) => ({ order: 0, endMs: Date.now(), moving: false, url: request("/api/windows", { account: id }) })),
  },
  "/api/claude-limit-card": {
    reason: "a Claude account's selected/current card with prepared scalar calibration metadata",
    clock: true, first: true,
    produce: (ctx, url) => apiHandleClaudeLimit(ctx, url, true),
    scope: (url, ctx) => url.searchParams.has("as_of") ? null : subscriptionScope(url, providerOfSubscription(ctx, accountOf(url)) === "claude" ? "claude" : null),
    // A closed window is reported as of its end (`handleClaudeLimit`); its calibration still follows the marks.
    clockEnd: url => url.searchParams.has("from") && url.searchParams.has("until") ? Date.parse(url.searchParams.get("until")!) : null,
    // The live window, and each closed window or counter segment of the rail with its bounds (App.tsx `vendorOverviewBounds`).
    prefill: (ctx, stored) => subscriptionsOf(ctx).filter(item => item.provider === "claude").flatMap(({ id }) => [
      { order: 0, endMs: Date.now(), moving: false, url: request("/api/claude-limit-card", { account: id }) },
      ...((stored(request("/api/windows", { account: id })) as WindowsResponse | null)?.windows ?? [])
        .flatMap(window => !window.isCurrent && window.startIso && window.resetIso ? [{ order: 2, endMs: Date.parse(window.resetIso),
          moving: false, url: request("/api/claude-limit-card", { account: id, from: window.startIso, until: window.resetIso }) }] : []),
    ]),
  },
  "/api/claude-limit": {
    reason: "the complete Claude calibration observation history, fetched when its tab opens",
    clock: true,
    produce: (ctx, url) => apiHandleClaudeLimit(ctx, url),
    scope: (url, ctx) => url.searchParams.has("as_of") ? null : subscriptionScope(url, providerOfSubscription(ctx, accountOf(url)) === "claude" ? "claude" : null),
    clockEnd: url => url.searchParams.has("from") && url.searchParams.has("until") ? Date.parse(url.searchParams.get("until")!) : null,
  },
};

/**
 * The requests to prefill, each once: the rails first, then current windows, then closed windows newest first,
 * then the range screens' defaults. Only requests a screen stores (`scope`) are listed.
 */
export function prefillRequests(ctx: AppContext, stored: StoredBody): Array<PrefillRequest & { key: string; scope: StoredScope }> {
  const unique = new Map<string, PrefillRequest & { key: string; scope: StoredScope }>();
  for (const screen of Object.values(WINDOW_SCREENS)) for (const item of screen.prefill?.(ctx, stored) ?? []) {
    const key = cacheKey(item.url), scope = screen.scope(item.url, ctx);
    if (!scope || !Number.isFinite(item.endMs)) continue;
    const previous = unique.get(key);
    if (!previous || item.order < previous.order) unique.set(key, { ...item, key, scope });
  }
  return [...unique.values()].sort((a, b) => a.order - b.order || b.endMs - a.endMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The stored scope of a request, when a window screen keeps it. */
export function storedScopeOf(ctx: AppContext, url: URL): StoredScope | null {
  return WINDOW_SCREENS[url.pathname]?.scope(url, ctx) ?? null;
}
