import { expect, test } from "bun:test";
import { duplicateCycles, openWindows, publicCapacityHistory, publicCard, publicProviders, publicWindow, missingCapacityReason, HOWTO_SNAPSHOT_VERSION } from "./export-howto-snapshot";
import type { CapacityCyclesResponse } from "../../src/shared/capacity-cycles";
import type { CodexComparisonWindow } from "../../src/shared/codex-accounting";
import type { PlansCatalog } from "../../src/shared/plan-catalog";
import type { RosterCard } from "../../src/web/lib/roster";

const now = Date.parse("2026-10-22T23:00:00Z");
const secret = "private-person@example.test";
const catalog: PlansCatalog = { provider_groups: [{ id: "codex", label: "Codex", aliases: ["codex", "openai"], plans: [
  { plan_id: "codex-pro", label: "Pro", aliases: ["pro"], versions: [{ from: null, usd_per_month: 200, limits: { credits_multiplier: 20 } }] },
  { plan_id: "codex-plus", label: "Plus", aliases: ["plus"], versions: [{ from: null, usd_per_month: 20, limits: { credits_multiplier: 1 } }] },
] }] };

const usage = (events: number, api: number, unpriced = 0) => ({ events, tokens: events * 1000, input: 0, cached: 0, output: 0, fast_tokens: 0, unknown_tokens: 0,
  priced_tokens: events * 1000, unpriced_events: unpriced, api_standard: api, credits_low: 0, credits_high: 0, context_known_tokens: 0, context_long_tokens: 0,
  context_long_events: 0, context_api_base: api, context_api_extra: 0, context_priced_tokens: 0, api_normalized: api, credits_unavailable_events: events });
function cycle(account: string, start: string, end: string, patch: Partial<CodexComparisonWindow> = {}): CodexComparisonWindow {
  return { id: `["${account}","x","${start}"]`, account, plan: "pro", reset: end, start, end, start_percent: 0, end_percent: 50, observed_pp: 50, probes: 40, max_gap_hours: 0.2,
    plan_detail: { label: "Pro", multiplier: 20, status: "resolved" }, usage: usage(100, 500), sources: [{ name: "C:/Users/PRIVATE/.codex", ...usage(1, 1) } as never], models: [],
    evidence: { archive_completeness: "complete", mode_relevant: false, meter_gaps: [], sources: [{ name: "PRIVATE-MACHINE" }], declared_sources: [], excluded_events: { plan: 0, reset: 0, imprecise_time: 0 },
      imports: { related: [] } } as never, ...patch } as CodexComparisonWindow;
}
const response = (accounts: CapacityCyclesResponse["accounts"]): CapacityCyclesResponse => ({ since: "2026-01-01", until: "2026-10-23", window_minutes: 10080, accounts });
const entry = (account: string, provider: string, windows: CodexComparisonWindow[], extra = {}) => ({ account, provider, counter: "weekly", counter_label: "Weekly", windows, ...extra });

test("capacity history is anonymous, ordered by first cycle, and keeps missing values null with a reason", () => {
  const history = publicCapacityHistory(response([
    entry(secret, "codex", [cycle(secret, "2026-09-01T00:00:00Z", "2026-09-07T00:00:00Z"), cycle(secret, "2026-09-01T00:00:00Z", "2026-09-07T00:00:00Z"),
      cycle(secret, "2026-09-08T00:00:00Z", "2026-09-14T00:00:00Z", { usage: usage(0, 0), observed_pp: 30 })]),
    entry("second@example.test", "codex", [cycle("second@example.test", "2026-08-01T00:00:00Z", "2026-08-07T00:00:00Z")]),
    entry("gemini-secret", "gemini", [], { unavailable: true }),
  ]));
  expect(history.map(item => item.id)).toEqual(["codex-A", "codex-B"]);
  // The earlier first cycle is A, whatever the account's name sorts to.
  expect(history[0]!.cycles).toHaveLength(1);
  expect(history[1]!.cycles).toHaveLength(2);
  const empty = history[1]!.cycles[1]!;
  expect(empty.capacityUsd).toBeNull();
  expect(empty.capacityReason).toBe("no_traffic");
  expect(history[0]!.cycles[0]!.capacityUsd).toBe(1000);
  const text = JSON.stringify(history);
  for (const sentinel of [secret, "second@example.test", "PRIVATE-MACHINE", "PRIVATE", "gemini-secret"]) expect(text).not.toContain(sentinel);
  expect(text).not.toMatch(/"(?:account|machine|path|source|sources|email)":/);
});

test("provider comparison keeps providers without cycles null with a reason, and prices only known plans", () => {
  const providers = publicProviders(response([
    entry("a", "codex", [cycle("a", "2026-09-01T00:00:00Z", "2026-09-07T00:00:00Z"), cycle("a", "2026-09-08T00:00:00Z", "2026-09-14T00:00:00Z", { usage: usage(100, 700) }),
      cycle("a", "2026-06-01T00:00:00Z", "2026-06-07T00:00:00Z", { observed_pp: 8, usage: usage(100, 20) })]),
    entry("b", "grok", [], { unavailable: true }), entry("c", "gemini", [], { preparing: true }),
  ]), catalog, now);
  const codex = providers.find(item => item.provider === "codex")!;
  const pro = codex.plans[0]!;
  expect(pro.plan).toBe("Pro · ×20");
  expect(pro.usdPerMonth).toBe(200);
  // Both cycles ended 30-60 days ago; the 8 pp cycle is below the filter. One rule, so no canonical-vs-measured split.
  expect(pro.d30_60).toMatchObject({ value: 1200, count: 2 });
  expect(pro.cycles).toBe(2);
  // The latest cycle: the newest finished eligible one, with its date and pp.
  expect(pro.latest).toMatchObject({ end: "2026-09-14", pp: 50, lowerBound: false, reason: null });
  // Per $1 comes from the 0-30 d bucket only: nothing there, so a dash with the last measured date, not an older fallback.
  expect(pro.perDollar).toMatchObject({ value: null, reason: "no_cycle_in_period", lastMeasured: "2026-09-14" });
  expect(providers.find(item => item.provider === "grok")).toMatchObject({ plans: [], reason: "no_weekly_window" });
  expect(providers.find(item => item.provider === "gemini")).toMatchObject({ plans: [], reason: "preparing" });
  const unknown = publicProviders(response([entry("a", "codex", [cycle("a", "2026-09-01T00:00:00Z", "2026-09-07T00:00:00Z", { plan: "enterprise", plan_detail: { label: "Enterprise", multiplier: 1, status: "resolved" } }),
    cycle("a", "2026-09-08T00:00:00Z", "2026-09-14T00:00:00Z", { plan: "enterprise", plan_detail: { label: "Enterprise", multiplier: 1, status: "resolved" } })])]), catalog, now);
  expect(unknown[0]!.plans[0]!.usdPerMonth).toBeNull();
  expect(unknown[0]!.plans[0]!.perDollar.value).toBeNull();
  expect(unknown[0]!.plans[0]!.perDollar.reason).not.toBeNull();
});

test("a plan that is not established is neither compared nor given a price", () => {
  const providers = publicProviders(response([entry("a", "codex", [cycle("a", "2026-09-01T00:00:00Z", "2026-09-07T00:00:00Z", { plan: null, plan_detail: { label: "?", multiplier: null, status: "unknown" } })])]), catalog, now);
  expect(providers[0]!.plans).toEqual([]);
  expect(missingCapacityReason(cycle("a", "2026-09-01T00:00:00Z", "2026-09-07T00:00:00Z", { usage: usage(10, 5, 10) }))).toBe("no_prices");
});

test("card publication copies display fields only", () => {
  const card = {
    id: "codex-private-id", vendor: "codex", plan: "pro", active: true, basis: "gauge", usedPercent: 18, elapsedPercent: 3, paceRatio: 5.74, remainingHours: 162.1,
    resetIso: "2026-10-29T17:09:52.000Z", tokensTotal: 522_830_000, usd: 223.5, unpricedModels: [{ model: "PRIVATE-MODEL", tokens: 1000 }], spent: false,
    live: { account: secret, machine: "PRIVATE-MACHINE", age_minutes: 3 }, vendorAccount: secret, accountSources: ["C:/Users/PRIVATE"], note: secret,
    creditBasis: { credits: 31_000, usd: 1240, partial: true, contextUnavailable: false, number: 3 },
    creditPools: { read_at: "2026-10-22T23:00:00Z", pools: [
      { key: "codex:balance", kind: "balance", unit: "credits", granted: null, used: null, remaining: 62_036, remaining_text: "62036", unlimited: false, granted_at: null, expires_at: null, items: null },
      { key: "codex:resets", kind: "balance", unit: "resets", granted: null, used: null, remaining: 2, remaining_text: null, unlimited: false, granted_at: null, expires_at: "2026-10-29T10:00:00Z", items: null }],
      flows: [], timelines: [] },
  } as unknown as RosterCard;
  const result = publicCard(card, catalog, now);
  expect(result).toMatchObject({ provider: "codex", plan: "Pro · ×20", usedPercent: 18, paceRatio: 5.74, tokens: 522_830_000, apiUsd: 223.5, unpricedTokens: 1000, measuredAgeMinutes: 3 });
  expect(result.credits).toMatchObject({ balance: 62_036, windows: 2, windowsIsUpperBound: true, apiUsd: 2481, freeResets: { count: 2, nextExpiry: "2026-10-29" } });
  const text = JSON.stringify(result);
  for (const sentinel of [secret, "PRIVATE", "codex-private-id"]) expect(text).not.toContain(sentinel);
});

test("window publication keeps machines anonymous and the unread future null rather than zero", () => {
  const start = "2026-10-18T10:59:59.563Z", reset = "2026-10-25T10:59:59.563Z";
  const rail = { key: "k", windowId: "w", counterKey: "claude:weekly", parentCounterKey: null, label: "7d", counterLabel: "7d", dateLabel: "x", source: "probe", percentBasis: "measured",
    plan: "pro", isCurrent: true, usedPercent: 72, elapsedPercent: 64, ppAhead: 8, windowHours: 168, startIso: start, resetIso: reset,
    shape: [{ t: 0, pct: 0 }, { t: 10, pct: 10 }, { t: 30, pct: 40 }, { t: 63, pct: 72 }], regimeKey: "r", sampledAtIso: "2026-10-22T22:00:00Z", sampleMachine: "PRIVATE-MACHINE",
    tokensTotal: null, usd: null, scope: null, sublimits: [], activityShape: [], cadenceSegmentFrom: null, cadencePeriodSource: "probe", cadenceAnchorSource: "probe", cadenceSourceWon: "probe",
    note: secret, trafficByMachine: [{ machine: "PRIVATE-MACHINE-1", amount: 700 }, { machine: "PRIVATE-MACHINE-2", amount: 300 }],
    accountMeters: { read_at: "2026-10-22T22:00:00Z", meters: [], extra_usage: { enabled: false, user_disabled: true, spent_minor: 0, currency: "USD", exponent: 2 } }, creditPools: null };
  const current = { window_id: "w", window_start: start, reset_at: reset, elapsed_hours: 108, remaining_hours: 60, elapsed_percent: 64.3, spend: { calls: 10, usd: 12.5, gross: 1000, fresh: 10, unpriced_calls: 0 },
    percent_all_measured: 72, percent_fable_measured: null, measured_at: "2026-10-22T22:00:00Z", measured_age_minutes: 5, percent_all_est: null, percent_fable_est: null, pp_ahead: 8,
    projected_end_percent: 112, eta_100_iso: "2026-10-24T17:00:00Z", remaining_usd: 500, counter_reset: null,
    days: [{ date: "2026-10-18", tokens: 100 }], hours: [] };
  const result = publicWindow({ windows: { account: secret, provider: "claude", source: "probe", windows: [rail] } as never, card: { current } as never }, catalog, now);
  expect(result).not.toBeNull();
  expect(result!.local.machines).toEqual([{ machine: 1, share: 70 }, { machine: 2, share: 30 }]);
  expect(result!.projection).toMatchObject({ currentPace: 112, typical: null, typicalWindowsHave: 0 });
  expect(result!.tempo.ratio).toBeCloseTo(72 / 64.3, 2);
  expect(result!.daily.at(-1)!.percent).toBeNull();
  const text = JSON.stringify(result);
  for (const sentinel of [secret, "PRIVATE"]) expect(text).not.toContain(sentinel);
  expect(HOWTO_SNAPSHOT_VERSION).toBe(1);
});

test("provider trend buckets are non-overlapping, empty ones are null with a reason, per-dollar says its base", () => {
  const day = 86_400_000, iso = (daysAgo: number) => new Date(now - daysAgo * day).toISOString();
  const at = (daysAgo: number, api: number, extra: Partial<CodexComparisonWindow> = {}) =>
    cycle("a", iso(daysAgo + 6), iso(daysAgo), { reset: iso(daysAgo), usage: usage(100, api), ...extra });
  const plan = publicProviders(response([entry("a", "codex", [at(100, 600), at(75, 800), at(10, 400), at(3, 500, { reset: new Date(now + day).toISOString() })])]), catalog, now)[0]!.plans[0]!;
  // The cycle that ended 3 days ago but whose planned reset is ahead and has no successor is open: it is in no bucket.
  expect(plan.d30).toMatchObject({ value: 800, count: 1, reason: null });
  expect(plan.d30_60).toMatchObject({ value: null, count: 0, reason: "no_cycle_in_period" });
  expect(plan.d60_90).toMatchObject({ value: 1600, count: 1 });
  expect(plan.older).toMatchObject({ value: 1200, count: 1 });
  expect(plan.latest.value).toBe(800); // the newest finished eligible cycle; the open one never counts
  expect(plan.max).toMatchObject({ value: 1600 });
  expect(plan.perDollar.value).toBeCloseTo(800 * (30.4375 / 7) / 200, 1);
});

test("promotion cycles stay out of every median and per-dollar figure, and show only as the promo maximum", () => {
  const promo = { status: "configured", factor: 2, regime_ids: [], notes: [], sources: [] } as never;
  const plan = publicProviders(response([entry("a", "codex", [
    cycle("a", "2026-05-01T00:00:00Z", "2026-05-07T00:00:00Z", { usage: usage(100, 1250), promotion: promo }),
    cycle("a", "2026-06-01T00:00:00Z", "2026-06-07T00:00:00Z", { usage: usage(100, 300) }),
    cycle("a", "2026-06-08T00:00:00Z", "2026-06-14T00:00:00Z", { usage: usage(100, 320) }),
  ])]), catalog, Date.parse("2026-06-20T00:00:00Z"))[0]!.plans[0]!;
  expect(plan.promoCycles).toBe(1);
  expect(plan.d30.value).toBe(620);
  expect(plan.months).toEqual([expect.objectContaining({ month: "2026-06", capacity: 620, count: 2 })]);
  expect(plan.max.value).toBe(640);
  expect(plan.maxPromo).toMatchObject({ value: 2500, promotionFactor: 2 });
  expect(plan.perMonth.value).toBeCloseTo(620 * 30.4375 / 7, 0);
});

test("a manual measurement and the probe cycle of one window count once", () => {
  const probe = cycle("a", "2026-09-20T11:00:00.069Z", "2026-09-23T21:46:18.888Z", { id: '["a","x","2026-09-20T11:00:00.069Z"]' });
  const manual = cycle("a", "2026-09-20T11:00:00.000Z", "2026-09-23T21:46:18.888Z", { id: "manual:3d90" });
  const history = publicCapacityHistory(response([entry("a", "codex", [manual, probe])]));
  expect(history[0]!.cycles).toHaveLength(1);
  expect(history[0]!.cycles[0]!.start).toBe("2026-09-20T11:00:00.069Z");
  expect(duplicateCycles(response([entry("a", "codex", [manual, probe])]))).toBe(1);
});

test("a window is open when its reset is ahead and no later window of the subscription has started", () => {
  const hour = 3_600_000, iso = (h: number) => new Date(now + h * hour).toISOString();
  const early = cycle("a", iso(-60), iso(-30), { reset: iso(100) }), next = cycle("a", iso(-29.9), iso(-2), { reset: iso(100) });
  const lastClosed = cycle("a", iso(-300), iso(-250), { reset: iso(-250) });
  const open = openWindows([early, next, lastClosed], now);
  expect([...open]).toEqual([next]);
});
