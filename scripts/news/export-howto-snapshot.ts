import { Database } from "../../src/db/sqlite";
import { activeDatabasePath } from "../../src/db";
import { withReadSnapshotAsync } from "../../src/db/analysis";
import { readAccountsV2 } from "../../src/config/accounts-document";
import { configFile, MACHINE, REPO_ROOT } from "../../src/config/paths";
import { expandAccountPaths } from "../../src/server/app-context";
import type { AppContext } from "../../src/server/app-context-types";
import { loadRateCard } from "../../src/server/rate-cards-file";
import { loadClaudeGauge } from "../../src/server/claude-limit";
import { loadGrokGauge } from "../../src/server/grok-limit";
import { loadCycles } from "../../src/server/cycles";
import { loadPlans } from "../../src/server/plans";
import { loadPlansCatalog } from "../../src/server/plans-catalog";
import { subscriptionMaps, periodEras } from "../../src/server/subscription-maps";
import { buildEraIndex } from "../../src/server/eras";
import { loadAccountResolver } from "../../src/server/account-resolver";
import { resolveCodexDiscovery, rememberedCodexAccounts } from "../../src/server/codex-discovery";
import { resolveVendorDiscovery, rememberedVendorAccounts } from "../../src/server/vendor-discovery";
import { handleRoster } from "../../src/server/api-roster";
import { handleWindows } from "../../src/server/api-window-rail";
import { handleClaudeLimit } from "../../src/server/api-provider-limits";
import { handleCapacityCycles } from "../../src/server/capacity-cycles";
import { resolvePlanFacts, type PlansCatalog } from "../../src/shared/plan-catalog";
import type { CapacityCyclesResponse } from "../../src/shared/capacity-cycles";
import type { CodexComparisonWindow } from "../../src/shared/codex-accounting";
import { codexPoolEvidence, poolUsage } from "../../src/shared/pool-usage";
import { buildRoster } from "../../src/web/lib/roster";
import type { RosterCard } from "../../src/web/lib/roster";
import type { ClaudeLimitResponse, RosterResponse } from "../../src/web/lib/api/accounts";
import type { WindowsResponse } from "../../src/web/lib/api/usage";
import { claudeReading } from "../../src/web/lib/claude";
import { accountCredits } from "../../src/web/lib/credit-pools-view";
import { buildWindowInsights } from "../../src/web/lib/window-insights";
import { windowDays, type CoursePoint } from "../../src/web/lib/window-status";
import { dailyUnitValues, type UnitInput } from "../../src/web/lib/window-units";
import { observedPoolDays, windowPoolSeries } from "../../src/web/lib/pool-series";
import { isCanonicalMedianSample } from "../../src/web/lib/canonical-median";
import { capacityFull, capacityIsLowerBound, capacityMedianSample, capacityPlanKey } from "../../src/web/lib/codex-capacity";
import { handleProjectCost } from "../../src/server/api-projects";
import { publicCompare, publicProjects } from "./howto-home";
import { publicBilling, resetUse, changeEvents } from "./howto-capacity";
import { handleBillingCycles } from "../../src/server/api-projects";
import type { BillingCycle, BillingCyclesAccount } from "../../src/shared/billing-cycles";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * The guide's snapshot (version 1). Every figure is an existing read of the application (roster, window rail,
 * Claude limit card, stored capacity cycles, plan catalog) passed through the presentation functions the screens use;
 * nothing is repriced or recomputed here. The output is a whitelist of anonymous fields: no identity, machine name,
 * project, path, account id or raw event is copied, and a missing value stays null with a reason, never zero.
 */
export const HOWTO_SNAPSHOT_VERSION = 1;
const HOUR = 3_600_000, DAY = 86_400_000;
/** Cycles at or above this meter rise are the application's default for the Capacity comparison. */
export const MIN_OBSERVED_PP = 10;

export const BUCKET_DAYS = [30, 60, 90] as const;
const WEEKS_PER_MONTH = 30.4375 / 7;
const PROVIDER_NAMES: Record<string, string> = { codex: "OpenAI / Codex", claude: "Anthropic / Claude", gemini: "Google / Gemini", grok: "xAI / Grok", glm: "Z.ai / GLM" };

const round = (value: number, digits = 2) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const num = (value: unknown, digits = 2) => finite(value) ? round(value, digits) : null;
const letter = (index: number) => String.fromCharCode(65 + index % 26).repeat(1 + Math.floor(index / 26));
const day = (iso: string | null | undefined) => iso ? iso.slice(0, 10) : null;

export interface HowtoInputs {
  roster: RosterResponse;
  /** The chosen Claude weekly subscription's window rail and card; null when there is none. */
  claude: { windows: WindowsResponse; card: ClaudeLimitResponse } | null;
  weekly: CapacityCyclesResponse;
  fiveHour: CapacityCyclesResponse | null;
  catalog: PlansCatalog;
  /** The example card's account window rail, for the home page's compare instrument. */
  cardWindows: WindowsResponse | null;
  /** Stored billing cycles of every account, and for each calibrated account the same cycles with their main-counter windows. */
  billing: { accounts: BillingCyclesAccount[]; detail: Map<string, BillingCycle[]> } | null;
  /** Project costs of the last 7 and 30 days. */
  projects: { week: { subjects: Array<{ subject: string; kind: string; api_usd: number }> }; month: { subjects: Array<{ subject: string; kind: string; api_usd: number }> } } | null;
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Subscription card                                                                                            */
/* ---------------------------------------------------------------------------------------------------------- */

/** The example card: the active Codex subscription with the most counted tokens in its current window. */
export function pickCardExample(cards: readonly RosterCard[]): RosterCard | null {
  const usable = cards.filter(card => card.vendor === "codex" && card.active && card.usedPercent != null && card.tokensTotal != null && card.plan && card.plan !== "free");
  return usable.sort((a, b) => (b.tokensTotal ?? 0) - (a.tokensTotal ?? 0))[0] ?? null;
}

export function publicCard(card: RosterCard, catalog: PlansCatalog, now: number, subscription: string | null = null) {
  const credits = accountCredits(card.creditPools, card.creditBasis, codexPoolEvidence(card.creditFunded));
  const facts = card.plan ? resolvePlanFacts(catalog, card.vendor, card.plan, new Date(now).toISOString().slice(0, 10)) : null;
  return {
    provider: card.vendor, providerName: PROVIDER_NAMES[card.vendor] ?? card.vendor,
    // The letter the capacity history gives this subscription, so one account carries one label across the page.
    subscription, plan: facts?.display_label ?? null, source: card.basis,
    usedPercent: num(card.usedPercent), elapsedPercent: num(card.elapsedPercent), paceRatio: num(card.paceRatio),
    remainingHours: num(card.remainingHours, 1), resetsAt: card.resetIso, measuredAgeMinutes: num(card.live?.age_minutes, 1),
    tokens: finite(card.tokensTotal) ? Math.round(card.tokensTotal) : null,
    // The screen shows the amount plainly; the tokens of models without a catalog rate are published beside it.
    apiUsd: num(card.usd), unpricedTokens: Math.round((card.unpricedModels ?? []).reduce((sum, model) => sum + (finite(model.tokens) ? model.tokens : 0), 0)),
    exhausted: card.spent === true,
    credits: credits && credits.kind === "credits" ? {
      balance: num(credits.remaining, 0), windows: num(credits.windows, 1), windowsIsUpperBound: credits.basis?.partial === true,
      apiUsd: num(credits.usd, 0), readAt: credits.readAt,
      freeResets: credits.resets ? { count: credits.resets.count, nextExpiry: day(credits.resets.nextExpiry) } : null,
    } : credits?.resets ? { balance: null, windows: null, windowsIsUpperBound: false, apiUsd: null, readAt: credits.readAt,
      freeResets: { count: credits.resets.count, nextExpiry: day(credits.resets.nextExpiry) } } : null,
  };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Weekly window with its chart                                                                                 */
/* ---------------------------------------------------------------------------------------------------------- */

/** Course points that change the value, and the last one; the plot is a step line of readings. */
function compactCourse(points: readonly CoursePoint[]) {
  const out: CoursePoint[] = [];
  points.forEach((point, index) => {
    const previous = out.at(-1);
    if (!previous || point.pct !== previous.pct || index === points.length - 1) out.push({ t: round(point.t, 3), pct: round(point.pct, 2) });
  });
  return out;
}

export function publicWindow(data: { windows: WindowsResponse; card: ClaudeLimitResponse }, catalog: PlansCatalog, now: number, subscription: string | null = null) {
  const cur = data.card.current;
  if (!cur) return null;
  const rail = data.windows.windows.find(window => window.isCurrent && window.windowHours === 168 && window.startIso
    && Math.abs(Date.parse(window.startIso) - Date.parse(cur.window_start)) < 30 * 60_000);
  if (!rail) return null;
  const startMs = Date.parse(cur.window_start), resetMs = Date.parse(cur.reset_at);
  const spanHours = cur.elapsed_hours + cur.remaining_hours, spanMs = spanHours * HOUR;
  const reading = claudeReading(cur);
  const used = reading.percentAll;
  const insights = buildWindowInsights(data.windows.windows, now).filter(item => item.current.isCurrent);
  const weekly = insights.find(item => !item.isSublimit && item.current.windowHours === 168) ?? null;
  const measuredMs = cur.measured_at ? Date.parse(cur.measured_at) : NaN;
  const readingT = Number.isFinite(measuredMs) && spanHours > 0 ? Math.max(0, Math.min(100, (measuredMs - startMs) / spanMs * 100)) : cur.elapsed_percent;
  const meter: CoursePoint[] = [{ t: 0, pct: 0 }, ...(weekly?.current.shape ?? []).filter(p => finite(p.t) && finite(p.pct)).sort((a, b) => a.t - b.t).map(p => ({ t: p.t, pct: p.pct }))];
  if (used != null && readingT > (meter.at(-1)?.t ?? 0)) meter.push({ t: readingT, pct: used });
  const baseline = cur.counter_reset?.first_after.percent ?? 0;
  const etaMs = cur.eta_100_iso ? Date.parse(cur.eta_100_iso) : NaN;

  const input: UnitInput = { startMs, spanMs, pools: rail.creditPools ?? null, blocks: cur.hours ?? null, usedPercent: used, atLimit: null, creditFunded: null,
    windowTokens: cur.spend.gross, counted: { tokens: cur.spend.gross, usd: cur.spend.usd, usd_partial: (cur.spend.unpriced_calls ?? 0) > 0 }, nowMs: now };
  const days = windowDays(startMs, resetMs);
  const poolRows = windowPoolSeries(poolUsage(rail.creditPools ?? null, codexPoolEvidence(null)), "pct", input)
    .filter(row => row.basis === "funded" || !row.pool.funded?.buckets.length);
  const daily = dailyUnitValues("pct", days, input, meter, new Map((cur.days ?? []).map(d => [d.date, d.tokens])));
  const poolDays = observedPoolDays(poolRows, days);
  const flows = rail.creditPools?.flows ?? [];
  const pool = rail.creditPools?.pools.find(item => item.unit === "usd") ?? null;
  const machines = [...(weekly?.current.trafficByMachine ?? [])].filter(m => m.amount > 0).sort((a, b) => b.amount - a.amount);
  const machineTotal = machines.reduce((sum, m) => sum + m.amount, 0);
  const plan = resolvePlanFacts(catalog, "claude", weekly?.current.plan ?? rail.plan ?? "", cur.window_start.slice(0, 10)).display_label;
  const tokens = cur.spend.gross;

  return {
    provider: "claude", providerName: PROVIDER_NAMES.claude!, subscription, plan, startIso: cur.window_start, resetIso: cur.reset_at, active: resetMs > now,
    usedPercent: num(used), usedIsMeasured: reading.measured, elapsedPercent: num(cur.elapsed_percent), elapsedHours: num(cur.elapsed_hours, 1), remainingHours: num(cur.remaining_hours, 1),
    remainingApiUsd: num(cur.remaining_usd), readAt: reading.measured ? cur.measured_at : null,
    projection: { currentPace: num(cur.projected_end_percent, 1), typical: num(weekly?.forecastPercent, 1), typicalWindowsHave: weekly?.baselineCount ?? 0, typicalWindowsNeeded: 2,
      exhaustionIso: etaMs > now && etaMs < resetMs ? cur.eta_100_iso : null },
    tempo: { ratio: num(reading.paceRatio), nowPerHour: used != null && cur.elapsed_hours > 0 ? num(Math.max(0, used - baseline) / cur.elapsed_hours, 3) : null,
      sustainablePerHour: used != null && cur.remaining_hours > 0 ? num(Math.max(0, 100 - used) / cur.remaining_hours, 3) : null },
    course: compactCourse(meter),
    daily: days.map(item => {
      const value = daily.get(item.key), observed = poolDays.get(item.key);
      return { date: item.key, startIso: new Date(item.startMs).toISOString(), endIso: new Date(item.endMs).toISOString(),
        percent: value?.value == null ? null : num(value.value, 2), poolPercent: observed ? num(observed.value, 2) : null, poolIsEstimate: observed?.estimate === true };
    }),
    pool: pool ? { label: pool.kind, unit: pool.unit, granted: num(pool.granted), used: num(pool.used), remaining: num(pool.remaining), expiresAt: day(pool.expires_at),
      spentInWindow: num(flows.find(flow => flow.unit === pool.unit)?.spent),
      series: poolRows.filter(row => row.points.length).map(row => ({ basis: row.basis, estimate: row.estimate, partial: row.partial,
        points: row.points.map(point => ({ t: round((Date.parse(point.at) - startMs) / spanMs * 100, 3), pct: round(point.pct, 2) })) })) } : null,
    counters: insights.map(item => ({
      label: item.isSublimit ? item.label : item.current.windowHours === 5 ? "5h" : item.current.windowHours === 168 ? "7d" : item.label,
      kind: item.isSublimit ? "sublimit" : item.current.windowHours === 5 ? "session" : "week",
      usedPercent: num(item.current.usedPercent), measured: item.current.percentBasis === "measured", elapsedPercent: num(item.current.elapsedPercent),
      // The meter's readings over the window, for the home page's window instrument (short sessions only; the week's course is `course`).
      course: item.current.windowHours === 5 && !item.isSublimit
        ? compactCourse([{ t: 0, pct: 0 }, ...(item.current.shape ?? []).filter(p => finite(p.t) && finite(p.pct)).sort((x, y) => x.t - y.t).map(p => ({ t: p.t, pct: p.pct }))]) : null,
      remainingHours: item.current.resetIso ? num(Math.max(0, Date.parse(item.current.resetIso) - now) / HOUR, 1) : null,
    })),
    extraUsage: rail.accountMeters?.extra_usage ? { enabled: rail.accountMeters.extra_usage.enabled === true } : null,
    local: {
      tokens: finite(tokens) ? Math.round(tokens) : null, freshTokens: finite(cur.spend.fresh) ? Math.round(cur.spend.fresh) : null,
      cacheShare: tokens > 0 ? num(Math.max(0, tokens - cur.spend.fresh) / tokens * 100, 1) : null,
      tokensPerDay: cur.elapsed_hours > 0 ? Math.round(tokens / cur.elapsed_hours * 24) : null,
      calls: cur.spend.calls, apiUsd: num(cur.spend.usd), apiUsdPartial: (cur.spend.unpriced_calls ?? 0) > 0,
      machines: machines.map((machine, index) => ({ machine: index + 1, share: num(machine.amount / machineTotal * 100, 1) })),
    },
  };
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Capacity history and the provider comparison                                                                 */
/* ---------------------------------------------------------------------------------------------------------- */

/** Why a cycle has no capacity figure; the order follows the Capacity screen's own reasons. */
export function missingCapacityReason(window: CodexComparisonWindow): string {
  if (window.usage.events <= 0) return "no_traffic";
  if (window.usage.events <= window.usage.unpriced_events) return "no_prices";
  if (!(window.observed_pp > 0)) return "no_meter_increase";
  if (!(window.observed_pp > 1)) return "small_sample";
  return "not_established";
}

function cycleRecord(window: CodexComparisonWindow) {
  const value = capacityFull(window, "api_standard");
  const factor = window.promotion?.status === "configured" ? window.promotion.factor : null;
  const sample = capacityMedianSample(window, "api_standard");
  const plan = capacityPlanKey(window);
  return {
    start: window.start, end: window.end, plan, planStatus: window.plan_detail?.status ?? "unknown",
    observedPp: num(window.observed_pp, 1), events: window.usage.events, tokens: window.usage.tokens,
    // What the cycle's traffic is worth at API rates (the figure capacity is derived from), not a charge.
    apiUsd: window.usage.events > 0 && window.usage.events > window.usage.unpriced_events ? num(window.usage.api_normalized ?? window.usage.api_standard) : null,
    capacityUsd: value === null ? null : round(value, 2), capacityReason: value === null ? missingCapacityReason(window) : null,
    lowerBound: value !== null && capacityIsLowerBound(window, "api_standard"),
    promotionFactor: finite(factor) ? factor : null,
    medianEligible: plan !== null && isCanonicalMedianSample(sample, plan),
  };
}

type Cycle = ReturnType<typeof cycleRecord>;

/**
 * One real window can be published twice: a manual capacity measurement (id "manual:...", start rounded to the hour) and the
 * probe-derived cycle (start a few ms off) share their end. Cycles of one account with the same end and starts within a minute are one
 * window; the probe-derived one is kept. Cause: stored manual measurements and probe windows are both returned by the capacity-cycles read.
 */
export function dedupeCycles(windows: CodexComparisonWindow[]) {
  const kept: CodexComparisonWindow[] = [];
  const manual = (window: CodexComparisonWindow) => window.id.startsWith("manual:");
  for (const window of [...windows].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Number(manual(a)) - Number(manual(b)))) {
    const same = kept.findIndex(other => other.end === window.end && Math.abs(Date.parse(other.start) - Date.parse(window.start)) <= 60_000);
    if (same < 0) kept.push(window);
    else if (manual(kept[same]!) && !manual(window)) kept[same] = window;
  }
  return { kept, removed: windows.length - kept.length };
}
/** Cycles removed as duplicates across all subscriptions, for the snapshot's method note. */
export function duplicateCycles(response: CapacityCyclesResponse) {
  const unique = new Map<string, CodexComparisonWindow[]>();
  for (const entry of response.accounts) {
    const cycles = unique.get(entry.account) ?? [], seen = new Set(cycles.map(window => `${window.start}|${window.end}`));
    for (const window of entry.windows) if (!seen.has(`${window.start}|${window.end}`)) { cycles.push(window); seen.add(`${window.start}|${window.end}`); }
    unique.set(entry.account, cycles);
  }
  return [...unique.values()].reduce((sum, cycles) => sum + dedupeCycles(cycles).removed, 0);
}

/** Subscriptions with cycles, per provider, labelled A, B... by their first recorded cycle: no identifier or ordering of the application leaks. */
function anonymousSubscriptions(response: CapacityCyclesResponse) {
  const byProvider = new Map<string, Map<string, Map<string, CodexComparisonWindow>>>();
  for (const entry of response.accounts) {
    if (!entry.windows.length) continue;
    const accounts = byProvider.get(entry.provider) ?? new Map(), cycles = accounts.get(entry.account) ?? new Map();
    for (const window of entry.windows) cycles.set(`${window.start}|${window.end}`, window);
    accounts.set(entry.account, cycles); byProvider.set(entry.provider, accounts);
  }
  const out: Array<{ id: string; provider: string; label: string; account: string; windows: CodexComparisonWindow[] }> = [];
  for (const [provider, accounts] of [...byProvider].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...accounts].map(([account, cycles]) => ({ account, windows: dedupeCycles([...cycles.values()]).kept.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) }))
      .sort((a, b) => Date.parse(a.windows[0]!.start) - Date.parse(b.windows[0]!.start));
    ordered.forEach((item, index) => out.push({ id: `${provider}-${letter(index)}`, provider, label: letter(index), ...item }));
  }
  return out;
}

export function publicCapacityHistory(response: CapacityCyclesResponse) {
  return anonymousSubscriptions(response).map(({ id, provider, label, windows }) => ({ id, provider, label, cycles: windows.map(cycleRecord) }));
}

/**
 * The provider comparison. One rule for every figure: cycles of at least MIN_OBSERVED_PP with a capacity value, promotion cycles
 * left out, duplicates removed, a median marked lowerBound when any cycle in it is. Buckets are the same calendar spans for every plan,
 * counted back from the snapshot instant, so a plan is only ever compared within a column. An empty bucket is null with a reason, never 0.
 */
export function publicProviders(response: CapacityCyclesResponse, catalog: PlansCatalog, now: number) {
  const windows = new Map<string, CodexComparisonWindow[]>();
  const reasons = new Map<string, string>();
  for (const entry of response.accounts) {
    windows.set(entry.provider, windows.get(entry.provider) ?? []);
    if (!entry.windows.length) reasons.set(entry.provider, entry.preparing ? "preparing" : entry.error ? "unreadable" : "no_weekly_window");
  }
  for (const subscription of anonymousSubscriptions(response)) windows.get(subscription.provider)!.push(...subscription.windows);
  const med = (values: number[]) => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
  return [...windows].sort(([a], [b]) => a.localeCompare(b)).map(([provider, all]) => {
    const plans = [...new Set(all.map(capacityPlanKey).filter((plan): plan is string => plan !== null))].flatMap(plan => {
      const promoOf = (window: CodexComparisonWindow) => window.promotion?.status === "configured" && finite(window.promotion.factor) ? window.promotion.factor : null;
      const ownAll = all.filter(window => capacityPlanKey(window) === plan).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      // Cycles measured under a declared promotion carry its bonus: they stay out of every median, bucket and per-dollar figure.
      const own = ownAll.filter(window => promoOf(window) === null);
      const toPoints = (list: CodexComparisonWindow[]) => list.map(window => ({ window, value: capacityFull(window, "api_standard") }))
        .filter(item => item.value !== null && item.window.observed_pp >= MIN_OBSERVED_PP)
        .map(item => ({ value: item.value!, end: Date.parse(item.window.end), endIso: item.window.end, done: Date.parse(item.window.reset) <= now,
          lowerBound: capacityIsLowerBound(item.window, "api_standard"), factor: promoOf(item.window) }));
      const points = toPoints(own), allPoints = toPoints(ownAll);
      if (!points.length) return [];
      const promoCycles = allPoints.length - points.length;
      const newestWindow = own.at(-1)!;
      const facts = resolvePlanFacts(catalog, provider, newestWindow.plan ?? "", newestWindow.start.slice(0, 10));
      const price = facts.usd_per_month;
      const priceReason = price === null ? facts.issue ?? "price_unknown" : price <= 0 ? "free_plan" : null;
      const bucket = (items: typeof points) => items.length
        // The spread is published with the median: the individual cycles, so a jump from 1k to 3k is visible and not averaged away.
        ? { value: round(med(items.map(item => item.value)), 2), count: items.length, lowerBound: items.some(item => item.lowerBound), reason: null,
          min: round(Math.min(...items.map(item => item.value)), 0), max: round(Math.max(...items.map(item => item.value)), 0), values: items.map(item => round(item.value, 0)).sort((a, b) => a - b) }
        : { value: null, count: 0, lowerBound: false, reason: "no_cycle_in_period", min: null, max: null, values: [] as number[] };
      const within = (from: number, to: number | null) => points.filter(item => item.end <= now - from * DAY && (to === null || item.end > now - to * DAY));
      const d90 = bucket(within(0, 90)), d30 = bucket(within(0, 30)), d30_60 = bucket(within(30, 60)), d60_90 = bucket(within(60, 90)), older = bucket(within(90, null));
      const newestDone = points.filter(item => item.done).sort((a, b) => b.end - a.end)[0];
      const lastAny = [...points].sort((a, b) => b.end - a.end)[0]!;
      const highest = (list: typeof points) => list.reduce<(typeof points)[number] | null>((best, item) => !best || item.value > best.value ? item : best, null);
      const top = highest(points)!, topAny = highest(allPoints)!;
      const pick = (item: (typeof points)[number]) => ({ value: round(item.value, 2), end: day(item.endIso), lowerBound: item.lowerBound });
      // Per dollar and per month come from the 0-30 d bucket only, for every plan: no fallback to an older period.
      const derived = (factor: number) => d30.value !== null && price !== null && price > 0
        ? { value: round(d30.value * factor, 2), count: d30.count, lowerBound: d30.lowerBound, reason: null, lastMeasured: null }
        : { value: null, count: d30.count, lowerBound: false, reason: d30.value === null ? "no_cycle_in_period" : priceReason, lastMeasured: day(lastAny.endIso) };
      const byMonth = new Map<string, typeof points>();
      for (const item of points) byMonth.set(item.endIso.slice(0, 7), [...byMonth.get(item.endIso.slice(0, 7)) ?? [], item]);
      return [{
        plan, promoCycles, usdPerMonth: price !== null && price > 0 ? price : null, priceReason,
        cycles: points.length, from: day(points.reduce((a, b) => a.end < b.end ? a : b).endIso), to: day(lastAny.endIso),
        latest: newestDone ? { ...pick(newestDone), reason: null } : { value: null, end: null, lowerBound: false, reason: "no_completed_cycle" },
        d30, d30_60, d60_90, older, d90,
        max: pick(top),
        // The highest cycle overall when it was a promotion cycle, shown beside the highest without one.
        maxPromo: topAny.factor !== null && topAny.value > top.value ? { ...pick(topAny), promotionFactor: topAny.factor } : null,
        perDollar: price !== null && price > 0 ? derived(WEEKS_PER_MONTH / price) : { ...derived(0), reason: priceReason },
        perMonth: derived(WEEKS_PER_MONTH),
        // Calendar months on one shared axis; per dollar needs a price.
        months: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, items]) => {
          const m = bucket(items);
          return { month, capacity: m.value, perDollar: price !== null && price > 0 && m.value !== null ? round(m.value * WEEKS_PER_MONTH / price, 2) : null, count: m.count, lowerBound: m.lowerBound };
        }),
      }];
    });
    return { provider, name: PROVIDER_NAMES[provider] ?? provider, plans, reason: plans.length ? null : reasons.get(provider) ?? "no_weekly_window" };
  });
}

/** Monthly capacity with resets by kind, the used % at each early reset, and the change events of the weekly capacity. */
function capacitySection(inputs: HowtoInputs, now: number) {
  if (!inputs.billing) return null;
  const subscriptions = anonymousSubscriptions(inputs.weekly), history = publicCapacityHistory(inputs.weekly);
  const labelOf = (provider: string, account: string) => subscriptions.find(item => item.provider === provider && item.account.toLowerCase() === account.toLowerCase())?.label ?? null;
  // A billing cycle is a promotion cycle when a weekly cycle of the same subscription inside it carried a promotion factor.
  const promoOn = (label: string | null, start: string, end: string) => history.some(item => item.label === label && item.cycles.some(cycle => cycle.promotionFactor !== null && cycle.end > start && cycle.start < end));
  const billing = publicBilling(inputs.billing, labelOf, inputs.catalog, promoOn);
  return { billing, resetUse: resetUse(billing), changes: changeEvents(history.map(item => ({ provider: item.provider, label: item.label, cycles: item.cycles }))),
    method: { shiftMin: 0.15, sideMin: 2, sideMax: 4, minObservedPp: MIN_OBSERVED_PP, note: "Level shifts are observations on these accounts, not provider announcements." } };
}

export function publicHowtoSnapshot(inputs: HowtoInputs, now: number) {
  const cards = buildRoster(inputs.roster, now);
  const example = pickCardExample(cards);
  return {
    version: HOWTO_SNAPSHOT_VERSION, generatedAt: new Date(now).toISOString(),
    method: { duplicateCyclesRemoved: duplicateCycles(inputs.weekly), promotionCyclesExcluded: true, dayBasis: "UTC", minObservedPp: MIN_OBSERVED_PP, bucketDays: BUCKET_DAYS, weeksPerMonth: round(WEEKS_PER_MONTH, 4), unit: "API-equivalent USD per 100% of a weekly window" },
    card: example ? publicCard(example, inputs.catalog, now, anonymousSubscriptions(inputs.weekly)
      .find(item => item.provider === example.vendor && item.account.toLowerCase() === example.id.toLowerCase())?.label ?? null) : null,
    window: inputs.claude ? publicWindow(inputs.claude, inputs.catalog, now, anonymousSubscriptions(inputs.weekly)
      .find(item => item.provider === "claude" && item.account.toLowerCase() === inputs.claude!.windows.account.toLowerCase())?.label ?? null) : null,
    capacityHistory: publicCapacityHistory(inputs.weekly),
    capacityHistory5h: inputs.fiveHour ? publicCapacityHistory(inputs.fiveHour) : null,
    providers: publicProviders(inputs.weekly, inputs.catalog, now),
    capacity: capacitySection(inputs, now),
    // Inputs of the landing's home-page instruments: the compare band and ranked anonymous projects.
    home: {
      compare: inputs.cardWindows && example ? publicCompare(inputs.cardWindows, now, anonymousSubscriptions(inputs.weekly)
        .find(item => item.provider === example.vendor && item.account.toLowerCase() === example.id.toLowerCase())?.label ?? null) : null,
      projects: inputs.projects ? publicProjects(inputs.projects.week, inputs.projects.month) : null,
    },
  };
}
export type HowtoSnapshot = ReturnType<typeof publicHowtoSnapshot>;

/* ---------------------------------------------------------------------------------------------------------- */
/* Reads                                                                                                        */
/* ---------------------------------------------------------------------------------------------------------- */

/** The same read-only context the stored-row screens get in their worker (direct-read-worker.ts). */
export function readonlyContext(db: Database, dbPath: string): AppContext {
  const accounts = expandAccountPaths(readAccountsV2(configFile("accounts.json")) as never);
  const maps = subscriptionMaps(db, accounts), subscriptions = accounts.subscriptions ?? [];
  return {
    sqlite: db, dbPath, rateCards: loadRateCard(configFile("rate-cards.json")), accounts, claudeGauge: loadClaudeGauge(), grokGauge: loadGrokGauge(),
    cycles: loadCycles(), plans: loadPlans(), plansCatalog: loadPlansCatalog(), rootDir: REPO_ROOT,
    homeToSubId: maps.homeToSubId, subIdToHomes: maps.subIdToHomes, homeConflict: null,
    eras: buildEraIndex(periodEras(db, accounts), "instant"), eraErrors: [], resolver: loadAccountResolver(db, subscriptions),
    // Remembered identities only: no profile folder is scanned.
    codexDiscovery: resolveCodexDiscovery([], subscriptions, rememberedCodexAccounts(db), MACHINE),
    vendorDiscovery: resolveVendorDiscovery([], subscriptions, rememberedVendorAccounts(db, subscriptions), MACHINE),
  } as AppContext;
}

const read = async <T>(response: Response | Promise<Response>): Promise<T> => {
  const resolved = await response;
  if (!resolved.ok) throw new Error(`Read failed (${resolved.status}): ${(await resolved.text()).slice(0, 200)}`);
  return await resolved.json() as T;
};

export async function readHowtoInputs(ctx: AppContext, now: number): Promise<HowtoInputs> {
  const url = (path: string) => new URL(path, "http://local");
  const roster = await read<RosterResponse>(handleRoster(ctx, url("/api/roster?window=10080")));
  const claudeAccounts = roster.accounts.filter(account => account.vendor === "claude" && account.active !== false);
  let claude: HowtoInputs["claude"] = null, best = -1;
  for (const account of claudeAccounts) {
    const windows = await read<WindowsResponse>(handleWindows(ctx, url(`/api/windows?account=${encodeURIComponent(account.id)}`)));
    const card = await read<ClaudeLimitResponse>(handleClaudeLimit(ctx, url(`/api/claude-limit-card?account=${encodeURIComponent(account.id)}`), true));
    const tokens = card.current?.spend.gross ?? -1;
    // An account whose newest reading is stale still has its window; only one without a current window is skipped.
    if (card.current && tokens > best && windows.windows.some(window => window.isCurrent && window.windowHours === 168)) { best = tokens; claude = { windows, card }; }
  }
  const since = "2026-01-01", until = new Date(now).toISOString().slice(0, 10);
  const cycles = async (minutes: 300 | 10080) => {
    const response = await read<CapacityCyclesResponse>(handleCapacityCycles(ctx, url(`/api/capacity-cycles?since=${since}&until=${until}&window_minutes=${minutes}`)));
    // A subscription whose stored cycles are being rewritten answers with none; publishing that would read as "no cycles".
    for (const entry of response.accounts) {
      if (entry.preparing) throw new Error(`Capacity cycles are preparing (${minutes} min windows)`);
      if (entry.error) throw new Error(`Capacity cycles are unreadable (${minutes} min windows)`);
    }
    return response;
  };
  const example = pickCardExample(buildRoster(roster, now));
  const cardWindows = example ? await read<WindowsResponse>(handleWindows(ctx, url(`/api/windows?account=${encodeURIComponent(example.id)}`))) : null;
  const dayStr = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString().slice(0, 10);
  const cost = (daysAgo: number) => read<{ subjects: Array<{ subject: string; kind: string; api_usd: number }> }>(handleProjectCost(ctx, url(`/api/project-cost?since=${dayStr(daysAgo)}&until=${until}`)));
  const projects = { week: await cost(7), month: await cost(30) };
  const view = await read<{ accounts: BillingCyclesAccount[] }>(handleBillingCycles(ctx, url("/api/billing-cycles")));
  if (view.accounts.some(account => account.stale)) throw new Error("Billing cycles are preparing (stale rows)");
  const detail = new Map<string, BillingCycle[]>();
  for (const account of view.accounts) {
    if (!account.cycles.some(cycle => cycle.capacity_usd !== null)) continue;
    const one = await read<BillingCyclesAccount>(handleBillingCycles(ctx, url(`/api/billing-cycles?provider=${encodeURIComponent(account.provider)}&account=${encodeURIComponent(account.account)}`)));
    detail.set(`${account.provider}|${account.account}`, one.cycles);
  }
  return { roster, claude, weekly: await cycles(10080), fiveHour: await cycles(300), catalog: ctx.plansCatalog, cardWindows, projects, billing: { accounts: view.accounts, detail } };
}

if (import.meta.main) {
  const outputIndex = process.argv.indexOf("--output");
  const outputArgument = outputIndex < 0 ? null : process.argv[outputIndex + 1];
  if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith("--"))) throw new Error("--output requires a destination JSON file");
  const output = outputArgument ? resolve(outputArgument) : resolve(import.meta.dir, "../../../tokenAtlas-landing/config/howto-snapshot.json");
  const dbPath = activeDatabasePath();
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    // Calendar days of the daily bars are UTC days, whatever the machine's zone.
    process.env.TZ = "UTC";
    const started = performance.now(), now = Date.now();
    const changes = () => (db.query("SELECT total_changes() n").get() as { n: number }).n;
    const before = changes();
    // While the application's background writers refresh a stored answer the read says "preparing"; wait for them instead of publishing a gap.
    const preparing = (error: unknown) => /preparing/i.test(String((error as { code?: string; message?: string })?.code ?? "") + String((error as Error)?.message ?? ""));
    let data: HowtoSnapshot | undefined;
    for (let attempt = 1; !data; attempt++) {
      try { data = await withReadSnapshotAsync(db, async () => publicHowtoSnapshot(await readHowtoInputs(readonlyContext(db, dbPath), now), now)); }
      catch (error) {
        if (!preparing(error) || attempt >= 100) throw error;
        await new Promise(done => setTimeout(done, 3000));
      }
    }
    if (changes() !== before) throw new Error("Readonly export unexpectedly changed the register");
    mkdirSync(dirname(output), { recursive: true });
    const staged = output + ".stage";
    writeFileSync(staged, JSON.stringify(data, null, 1)); renameSync(staged, output);
    console.log(JSON.stringify({ entry: "handleRoster + handleWindows + handleClaudeLimit(card) + handleCapacityCycles (the screens' own reads)",
      mode: "active database, readonly, one consistent snapshot", sample: { card: !!data.card, window: !!data.window, subscriptions: data.capacityHistory.length,
        providers: data.providers.map(p => p.provider), generatedAt: data.generatedAt },
      excludes: "HTTP, browser, archive/import/repricing/rebuild; only anonymous aggregate fields published", ms: Math.round(performance.now() - started), writes: 0 }));
  } finally { db.close(); }
}
