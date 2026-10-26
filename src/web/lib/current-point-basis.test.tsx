import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { preparedPointBasis, currentPointBasis, pointBasisWithContext, creditBasisOf } from "../../shared/current-point-basis";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { emptyWindowUsage } from "../../server/subscription-window-comparison";
import type { ApiCycle, RosterResponse, SubscriptionSpend } from "./api";
import { buildRoster } from "./roster";
import { buildModel, emptySeries } from "./cycle";
import { rosterWithContextPreview, seriesWithContextPreview } from "./window-context-preview";
import { accountCredits, accountCreditsOfCycles, creditCardView } from "./credit-pools-view";
import { planValue, usdPerPoint } from "./planValue";
import { planUnits } from "./planUnits";
import { CycleRail } from "../components/CycleRail";
import { setLanguage } from "./i18n";

const start = "2026-10-20T06:32:12Z", end = "2026-10-22T06:32:12Z";
const sample = (): CodexComparisonWindow => ({ id: "current", account: "codex1", plan: "pro", window_minutes: 10080,
  start, end, reset: "2026-10-27T06:32:12Z", cycle_start: start, start_percent: 0, end_percent: 50, observed_pp: 50,
  probes: 200, max_gap_hours: 1, sources: [], models: [], usage: { ...emptyWindowUsage(), events: 1000,
    tokens: 1e6, priced_tokens: 1e6, api_standard: 700, api_normalized: 525, credits_low: 13125, credits_high: 13125,
    context_priced_tokens: 1e6, context_api_base: 525, context_api_extra: 105 } });
const basis = preparedPointBasis(sample())!;
const pools = { read_at: end, flows: [], pools: [{ key: "codex:credits", kind: "balance" as const, unit: "credits" as const,
  granted: null, used: null, remaining: 58859.744802, remaining_text: "58859.744802", unlimited: false,
  granted_at: null, expires_at: null, items: null }] };
const cycle = (changes: Partial<ApiCycle> = {}): ApiCycle => ({ index: 1, label: start.slice(0, 10), limit_id: "codex",
  anchor: null, resets_at_iso: sample().reset, window_start_iso: start, is_active: true, shadow: false, status: "active",
  start_ts: start, end_ts: end, work_from_ts: start, work_to_ts: sample().reset, sample_count: 200, lag_fraction: 0,
  distinct_steps: 50, first_percent: 0, peak_percent: 50, end_percent: 50, hit_100: false, window_hours: 168,
  elapsed_hours: 48, observed_hours: 48, remaining_hours: 120, pace_percent_per_day: 25, projected_end_percent: null,
  eta_100_iso: null, calls: 1000, usd: 700, usd_per_percent: 14, usd_at_100_percent: 1400,
  tokens: { in: 9e5, cached_in: 8e5, out: 1e5, cache_write: 0, reasoning: 0, total: 1e6 },
  top_model: "gpt", source_models: [], model_usage: [], surface_usage: [], plan_types: ["pro"], limit_names: [],
  delta_peak_percent: null, delta_usd: null, delta_calls: null, pct_of_prev_peak: null, pct_of_prev_usd: null,
  point_basis: basis, credit_pools: pools, ...changes });
afterEach(() => setLanguage("en"));

test("paired normalized sample gives 10.5 per point, 1050 per window and over two windows for the reported balance", () => {
  expect(basis).toMatchObject({ usd: 1050, credits: 26250, percent: 50, partial: false });
  const credit = accountCredits(pools, creditBasisOf(basis))!;
  expect(credit.usd).toBeCloseTo(2354.38979208, 8);
  expect(credit.windows).toBeCloseTo(2.242275992457, 10);
  expect(credit.usd! / credit.windows!).toBeCloseTo(basis.usd, 10);
});

test("current sample wins over an older expensive full window; small fresh samples borrow only within the same plan and counter", () => {
  const old = cycle({ index: 0, window_start_iso: "2026-10-13T00:00:00Z", is_active: false,
    point_basis: { ...basis, usd: 1298, credits: 32444 } });
  expect(currentPointBasis([old, cycle()])).toBe(basis);
  expect(currentPointBasis([cycle(), old])).toBe(basis);
  expect(currentPointBasis([old, cycle({ point_basis: null })])).toBe(old.point_basis!);
  expect(currentPointBasis([old, cycle({ point_basis: null, plan_types: ["free"] })])).toBeNull();
  expect(currentPointBasis([old, cycle({ point_basis: null, window_hours: 5 })])).toBeNull();
  expect(currentPointBasis([old, cycle({ point_basis: null, plan_types: [] })])).toBeNull();
  expect(currentPointBasis([old, cycle({ point_basis: null, plan_types: ["pro", "free"] })])).toBeNull();
});

test("context preview is reversible and idempotent; both dollar values change, native credits and window equivalence do not", () => {
  const original = JSON.stringify(basis), on = pointBasisWithContext(basis, true)!;
  expect(on.usd).toBe(1260);
  expect(pointBasisWithContext(on, true)).toEqual(on);
  expect(pointBasisWithContext(basis, false)).toBe(basis);
  const offCredits = accountCredits(pools, creditBasisOf(basis))!, onCredits = accountCredits(pools, creditBasisOf(on))!;
  expect(onCredits.windows).toBe(offCredits.windows);
  expect(onCredits.usd).toBeCloseTo(offCredits.usd! * 1.2, 8);
  expect(onCredits.usd! / onCredits.windows!).toBeCloseTo(on.usd, 8);
  expect(JSON.stringify(basis)).toBe(original);
});

test("roster, rail, account credit strip and plan conversion use the same current basis in both context modes", () => {
  const roster = { accounts: [{ id: "codex1", vendor: "codex", plan: "pro", basis: "gauge", live: null, live_other: [],
    gauge_age_hours: null, cycles: [cycle()], probe: null, active: true }], window_minutes: 10080 } as unknown as RosterResponse;
  for (const on of [false, true, false]) {
    const card = buildRoster(rosterWithContextPreview(roster, on))[0]!;
    const model = buildModel(seriesWithContextPreview(emptySeries("codex1", 10080, [cycle()]), on));
    const value = planValue(card), credit = accountCreditsOfCycles(model.cycles, card.pointBasis)!.account!;
    expect(value.windowValue).toBe(on ? 1260 : 1050);
    expect(value.tokens).not.toBeNull();
    expect(value.best?.rate).toBe(on ? 12.6 : 10.5);
    expect(usdPerPoint(model.cycles[0]!)).toBe(value.rate);
    expect(credit.usd! / credit.windows!).toBeCloseTo(value.windowValue!, 8);
    const units = planUnits([card], [{ id: "codex1", vendor: "codex", plan_periods: [],
      capacity: { weekly_window_value_usd: 9999 } } as unknown as SubscriptionSpend]);
    expect(units[0]!.windowValue).toBe(value.windowValue);
    const html = renderToStaticMarkup(<CycleRail cycles={model.cycles} pointBasis={card.pointBasis} points={[]}
      activeIndex={1} onSelect={() => {}} onInfo={() => {}} medianPercent={null} medianTokens={null} />);
    expect(html).toContain(on ? "$12.60" : "$10.50");
    expect(html).not.toContain("$14.00");
    expect(creditCardView(card.creditPools, card.creditBasis)!.pools[0]!.aside).toContain("2.2 windows");
  }
});

test("missing, partial and unavailable prices stay explicit instead of becoming zero or an old 100% conversion", () => {
  for (const patch of [{ observed_pp: 0 }, { observed_pp: 9 }, { probes: 1 }, { plan: null }, { declared_plan_meter_mismatch: true }, { window_minutes: undefined }]) {
    expect(preparedPointBasis({ ...sample(), ...patch })).toBeNull();
  }
  const partial = preparedPointBasis({ ...sample(), usage: { ...sample().usage, unpriced_events: 10, priced_tokens: 8e5 } })!;
  expect(partial.partial).toBe(true);
  expect(creditCardView(pools, creditBasisOf(partial))!.pools[0]!.aside).toContain("≤ ≈ 2.2 windows");
  expect(pointBasisWithContext(partial, true)?.contextUnavailable).toBe(true);
  const unavailable = preparedPointBasis({ ...sample(), usage: { ...sample().usage, credits_unavailable_events: 1 } })!;
  expect(unavailable.credits).toBeNull();
  expect(creditBasisOf(unavailable)).toBeNull();
  expect(currentPointBasis([cycle({ point_basis: undefined })])).toBeNull();
});

test("a historical range keeps the account's current balance and conversion, even when it has no current cycle", () => {
  const historical = buildModel(emptySeries("codex1", 10080, [cycle({ credit_pools: { ...pools,
    pools: [{ ...pools.pools[0]!, remaining: 999 }] } })])).cycles;
  expect(accountCreditsOfCycles(historical, basis, pools)?.account?.remaining).toBe(58859.744802);
  expect(accountCreditsOfCycles(historical, basis, null)).toBeNull();
  expect(accountCreditsOfCycles([], basis, pools)?.account?.basis?.usd).toBe(1050);
});
