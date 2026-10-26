import { expect, test } from "bun:test";
import type { ApiCycle, CycleBreakdownResponse, RosterResponse } from "./api";
import type { BillingCycle } from "../../shared/billing-cycles";
import type { RateWindow } from "../../shared/subscription-rate";
import { storedContextPrice, previewContextAmount } from "../../shared/context-price";
import { billingAccountWithContextPreview, billingCycleWithContextPreview, breakdownWithContextPreview,
  cyclesWithContextPreview, railWithContextPreview, rateWithContextPreview, rosterWithContextPreview, seriesWithContextPreview } from "./window-context-preview";
import { buildModel, emptySeries } from "./cycle";
import { railWindowsFromCycles } from "./windows";
import { buildAllCard, buildRoster } from "./roster";
import { observedRates, observationOf } from "./codex-window-stats";
import { liveWindowApiCost } from "../components/CodexSections";
import { windowCapacity } from "./window-units";

const price = { base: 100, extra: 40, stored: 100 };
const start = "2026-10-01T00:00:00.000Z", end = "2026-10-08T00:00:00.000Z";
function cycle(index = 0): ApiCycle {
  return { index, label: "2026-10-01", limit_id: "codex", anchor: Date.parse(end) / 1000, resets_at_iso: end,
    window_start_iso: start, is_active: false, shadow: false, status: "closed", start_ts: start, end_ts: "2026-10-07T00:00:00.000Z",
    work_from_ts: start, work_to_ts: end, sample_count: 100, lag_fraction: 0, distinct_steps: 50,
    first_percent: 10, peak_percent: 50, end_percent: 50, hit_100: false, window_hours: 168, elapsed_hours: 168,
    observed_hours: 144, remaining_hours: null, pace_percent_per_day: 10, projected_end_percent: null, eta_100_iso: null,
    calls: 10, usd: 100, usd_per_percent: 2, usd_at_100_percent: 200, context_price: price,
    at_limit_context_price: { base: 80, extra: 8, stored: 80 },
    at_limit: { ts: end, percent: 100, events: 5, api_standard: 80, api_unpriced: 0, tokens: 100,
      credits: 10, credits_unpriced: 0, joint_api_standard: 80, joint_credits: 10 },
    tokens: { in: 100, cached_in: 20, cache_write: 0, out: 10, reasoning: 0, total: 110 }, top_model: "gpt",
    source_models: [], model_usage: [{ name: "gpt", calls: 10, tokens: 110, fresh: 90, usd: 100 }], surface_usage: [],
    plan_types: ["pro"], limit_names: [], delta_peak_percent: null, delta_usd: null, delta_calls: null,
    pct_of_prev_peak: null, pct_of_prev_usd: null };
}

test("preview off preserves the original values and objects, including legacy and incomplete splits", () => {
  const cycles = [cycle()], series = emptySeries("codex1", 10080, cycles);
  expect(cyclesWithContextPreview(cycles, false)).toBe(cycles);
  expect(seriesWithContextPreview(series, false)).toBe(series);
  expect(previewContextAmount(100, price, false)).toBe(100);
  expect(previewContextAmount(100, undefined, true)).toBe(100);
  expect(previewContextAmount(140, { ...price, stored: 140 }, true)).toBe(140);
  expect(previewContextAmount(null, price, true)).toBeNull();
  const usage = { api_standard: 100, api_normalized: 10, priced_tokens: 100, context_priced_tokens: 99,
    context_api_base: 10, context_api_extra: 4 };
  expect(storedContextPrice(usage)).toBeUndefined();
  expect(storedContextPrice({ ...usage, context_priced_tokens: 100 })).toEqual(price);
});

test("window cards, rail, drawer and history share the previewed model and exact at-limit split", () => {
  const original = cycle(), result = cyclesWithContextPreview([original], true)[0]!;
  expect([result.usd, result.usd_per_percent, result.usd_at_100_percent, result.at_limit!.api_standard]).toEqual([140, 2.8, 280, 88]);
  expect(result.model_usage).toBe(original.model_usage); // No model-scope split in this response.
  const model = buildModel(seriesWithContextPreview(emptySeries("codex1", 10080, [original]), true));
  expect(model.cycles[0]!.usd).toBe(140);
  expect(railWindowsFromCycles(model.cycles, [], [])[0]!.usd).toBe(140);
  const input = { startMs: Date.parse(start), spanMs: 168 * 3_600_000, blocks: [], usedPercent: 100,
    atLimit: result.at_limit, creditFunded: null, windowTokens: 110 };
  expect(windowCapacity("usd", input)?.value).toBe(88);
  expect(original.usd).toBe(100);
  const fallback = railWindowsFromCycles(buildModel(emptySeries("codex1", 10080, [original])).cycles, [], [])
    .map(window => ({ ...window, context_price: price }));
  expect(railWithContextPreview(fallback, false)).toBe(fallback);
  expect(railWithContextPreview(fallback, true)[0]!.usd).toBe(140);
});

test("subscription cards and their aggregate sum previewed Codex cycles only", () => {
  const account = { id: "codex1", vendor: "codex", plan: "pro", basis: "gauge", live: null, live_other: [],
    gauge_age_hours: null, cycles: [{ ...cycle(), is_active: true, point_basis: {
      start, end, windowStart: start, windowHours: 168, plan: "pro", percent: 50,
      usd: 200, credits: 50, tokens: 220, partial: false, contextPrice: { base: 200, extra: 80, stored: 200 },
    } }], probe: null, active: true };
  const roster = { accounts: [account], window_minutes: 10080 } as unknown as RosterResponse;
  expect(rosterWithContextPreview(roster, false)).toBe(roster);
  const cards = buildRoster(rosterWithContextPreview(roster, true));
  expect(cards[0]!.usd).toBe(140);
  expect(cards[0]!.usdAt100).toBe(280);
  expect(buildAllCard(cards).usd).toBe(140);
  const claude = { ...roster, accounts: [{ ...roster.accounts[0]!, vendor: "claude" }] } as RosterResponse;
  expect(rosterWithContextPreview(claude, true).accounts[0]!.cycles[0]!.usd).toBe(100);
});

test("breakdown totals feed budget and paired rates; day/session/model buckets retain their own scope", () => {
  const current = buildModel(emptySeries("codex1", 10080, [cycle()])).cycles[0]!;
  const observation = observationOf(current);
  const data = { since_ts: observation.from!, until_ts: observation.until!, limit_id: "codex", totals: {
    calls: 10, tokens: 110, tokens_fresh: 90, usd: 100, context_price: price }, unpriced: { tokens: 0, models: {} },
    days: [{ usd: 100 }], sessions: [{ usd: 100 }] } as CycleBreakdownResponse;
  expect(breakdownWithContextPreview(data, false)).toBe(data);
  const preview = breakdownWithContextPreview(data, true);
  expect(liveWindowApiCost(preview)).toBe(140);
  expect(observedRates(current, preview).api).toBe(3.5);
  expect(preview.days).toBe(data.days);
  expect(preview.sessions).toBe(data.sessions);
  expect(data.totals.usd).toBe(100);
});

test("billing changes used dollars only; capacities and reset bonuses remain stored", () => {
  const cycle = { api_usd: 100, context_price: price, used_units: { api_usd: 100 }, capacity_usd: 200,
    capacity: { api_usd: 200 }, resets: { provider: { api_usd: 10 } } } as BillingCycle;
  expect(billingCycleWithContextPreview(cycle, false)).toBe(cycle);
  const preview = billingCycleWithContextPreview(cycle, true);
  expect([preview.api_usd, preview.used_units!.api_usd]).toEqual([140, 140]);
  expect(preview.capacity).toBe(cycle.capacity);
  expect(preview.capacity_usd).toBe(200);
  expect(preview.resets).toBe(cycle.resets);
  const account = { provider: "claude", account: "one", counter: null, stale: false, cycles: [cycle] };
  expect(billingAccountWithContextPreview(account, true)).toBe(account);
});

test("saved comparisons change whole-window API work only for Codex", () => {
  const window = { provider: "codex", api_usd: 100, context_price: price, value_100_usd: 200, rate: 10, fixed_api_usd: 90 } as RateWindow;
  expect(rateWithContextPreview(window, false)).toBe(window);
  expect(rateWithContextPreview(window, true)).toEqual({ ...window, api_usd: 140 });
  const claude = { ...window, provider: "claude" } as RateWindow;
  expect(rateWithContextPreview(claude, true)).toBe(claude);
});


test("the exact detail companion is selected once; pending companions retain the stored totals", async () => {
  const {responseWithContextPreview}=await import("../../shared/context-preview");
  const {registerContextCompanion}=await import("./context-companion");
  const data={totals:{usd:100,context_price:price},days:[{usd:100}],sessions:[{usd:100}]} as CycleBreakdownResponse;
  registerContextCompanion(data,new URL("http://test/api/cycle-breakdown"),async()=>data);
  expect(breakdownWithContextPreview(data,true)).toBe(data);
  const preview={...data,totals:{...data.totals,usd:140},days:[{usd:140}],sessions:[{usd:140}]} as CycleBreakdownResponse;
  const chosen=responseWithContextPreview<CycleBreakdownResponse>({...data,context_preview:preview,context_preview_status:{ready:true,revision:1,missing_groups:0}},true);
  expect(breakdownWithContextPreview(chosen,true)).toBe(preview);
  expect(breakdownWithContextPreview(chosen,true)!.totals.usd).toBe(140);
});

test("final billing/rate companions replace prepared money once and retain their pending/default amounts",async()=>{
 const {responseWithContextPreview}=await import("../../shared/context-preview");
 const {registerContextCompanion}=await import("./context-companion");
 const base={api_usd:100,capacity_usd:200,context_price:price,capacity:{api_usd:200}} as BillingCycle;
 const defaultBody={cycles:[base]};registerContextCompanion(defaultBody,new URL("http://test/api/billing-cycles"),async()=>defaultBody);
 expect(billingCycleWithContextPreview(base,false)).toBe(base);expect(billingCycleWithContextPreview(base,true)).toBe(base);
 const next={...base,api_usd:140,capacity_usd:280,capacity:{...base.capacity!,api_usd:280}},selected=responseWithContextPreview({...defaultBody,context_preview:{cycles:[next]},context_preview_status:{ready:true,revision:1,missing_groups:0}},true);
 expect(billingCycleWithContextPreview(selected.cycles[0]!,true)).toBe(next);expect(selected.cycles[0]!.capacity_usd).toBe(280);
 const rate={provider:"codex",api_usd:100,value_100_usd:200,context_price:price} as RateWindow;
 const rateBody={windows:[rate]};registerContextCompanion(rateBody,new URL("http://test/api/subscription-rate"),async()=>rateBody);
 expect(rateWithContextPreview(rate,true)).toBe(rate);
 const chosen=responseWithContextPreview({...rateBody,context_preview:{windows:[{...rate,api_usd:140,value_100_usd:280}]},context_preview_status:{ready:true,revision:1,missing_groups:0}},true);
 expect(rateWithContextPreview(chosen.windows[0]!,true).value_100_usd).toBe(280);expect(rateWithContextPreview(chosen.windows[0]!,true).api_usd).toBe(140);
});

test("Return and Potential per paid dollar follow the selected API capacity without changing payment",async()=>{
 const {perDollar}=await import("./subscription-month"),{responseWithContextPreview}=await import("../../shared/context-preview");
 const cycle={api_usd:100,capacity_usd:200,capacity:{api_usd:200},used_units:{api_usd:100},windows:{touched:1,share:1,idle:0},flags:[],resets:{},price:{amount:20,usd:20,currency:"USD"}} as unknown as BillingCycle;
 const body={cycles:[cycle]},preview={cycles:[{...cycle,api_usd:140,capacity_usd:280,capacity:{...cycle.capacity!,api_usd:280},used_units:{...cycle.used_units!,api_usd:140}}]};
 const on=responseWithContextPreview({...body,context_preview:preview,context_preview_status:{ready:true,revision:1,missing_groups:0}},true);
 expect(perDollar(body.cycles,"api",new Set()).used).toBe(5);expect(perDollar(body.cycles,"api",new Set()).capacity).toBe(10);
 expect(perDollar(on.cycles,"api",new Set()).used).toBe(7);expect(perDollar(on.cycles,"api",new Set()).capacity).toBe(14);expect(on.cycles[0]!.price).toBe(cycle.price);
});
