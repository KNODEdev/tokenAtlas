import { expect, test } from "bun:test";
import { capacityContext } from "./codex-capacity-context";
import type { CodexComparisonWindow } from "../shared/codex-accounting";
import { matchPlanAlias, type PlansCatalog } from "./plans-catalog";

const catalog: PlansCatalog = { provider_groups: [{ id: "openai", label: "OpenAI", aliases: ["codex"], plans: [
  { plan_id: "codex-plus", label: "Plus", aliases: ["plus"], versions: [{ from: null, usd_per_month: 20, limits: { credits_multiplier: 1 } }] },
  { plan_id: "codex-pro-5x", label: "Pro (5x)", aliases: ["prolite"], versions: [{ from: null, usd_per_month: 100, limits: { credits_multiplier: 5 } }] },
  { plan_id: "codex-pro-20x", label: "Pro (20x)", aliases: ["pro"], versions: [{ from: null, usd_per_month: 200, limits: { credits_multiplier: 20 } }] },
] }] };
const window = { account: "codex1", plan: "pro", cycle_start: "2026-09-01T12:00:00Z", cycle_end: "2026-09-08T00:00:00Z" } as CodexComparisonWindow;

test("Free is named without inventing a paid-plan capacity multiplier", () => {
  expect(capacityContext({ ...window, plan: "free" }, {}, catalog).plan_detail)
    .toEqual({ label: "Free", multiplier: null, status: "resolved" });
});

test("recorded plan aliases resolve exact tiers without treating the tier as a promotion", () => {
  for (const [plan, multiplier] of [["plus", 1], ["prolite", 5], ["pro", 20]] as const) {
    const result = capacityContext({ ...window, plan }, {}, catalog);
    expect(result.plan_detail).toMatchObject({ multiplier, status: "resolved" });
    expect(result.promotion_periods).toEqual([]);
  }
  expect(capacityContext({ ...window, plan: "unknown" }, {}, catalog).plan_detail.multiplier).toBeNull();
});

test("retired plans.json stages no longer override the plan the window's readings report", () => {
  const segments = [{ subscription: "codex1", from: "2026-09-01", until: "2026-09-03", plan: "codex-pro-5x" },
    { subscription: "codex1", from: "2026-09-04", plan: "codex-plus" }];
  expect(capacityContext(window, { segments }, catalog).plan_detail).toMatchObject({ status: "resolved", multiplier: 20 });
});

test("promotion overlays preserve exact bounded days and do not invent full-cycle coverage", () => {
  const regime = { id: "offer", subscription: "codex1", factor: 2, from: "2026-09-03", until: "2026-09-04", window_kind: "weekly", source: "user" as const };
  expect(capacityContext(window, { capacity_regimes: [regime] }, catalog).promotion_periods).toEqual([
    { start: "2026-09-03T00:00:00.000Z", end: "2026-09-05T00:00:00.000Z", factor: 2 },
  ]);
  for (const patch of [{ subscription: "codex2" }, { confirmed: false }, { enabled: false }, { window_kind: "5h" }, { until: null }, { factor: 1 }]) {
    expect(capacityContext(window, { capacity_regimes: [{ ...regime, ...patch }] }, catalog).promotion_periods).toEqual([]);
  }
});

test("official Pro 5x launch has bounded overlays and never doubles Pro 20x", () => {
  const base = { account: "codex1", plan: "prolite", start: "2026-05-28T00:00:00Z", reset: "2026-06-04T00:00:00Z",
    cycle_start: "2026-05-28T00:00:00Z", cycle_end: "2026-06-04T00:00:00Z", cycle_end_basis: "reset" } as CodexComparisonWindow;
  expect(capacityContext(base, {}, catalog).promotion_periods).toEqual([{ start: "2026-05-28T00:00:00.000Z", end: "2026-06-01T00:00:00.000Z", factor: 2 }]);
  expect(capacityContext({ ...base, plan: "pro" }, {}, catalog).promotion_periods).toEqual([]);
});

test("a window under a declared \"no subscription\" has no tier, even when a catalog plan is aliased \"none\"", () => {
  const shadow: PlansCatalog = { provider_groups: [{ ...catalog.provider_groups[0]!, plans: [...catalog.provider_groups[0]!.plans,
    { plan_id: "codex-shadow", label: "Shadow", aliases: ["none"], versions: [{ from: null, usd_per_month: 999, limits: { credits_multiplier: 50 } }] }] }] };
  for (const plans of [catalog, shadow]) {
    expect(matchPlanAlias(plans, "codex", "none")).toMatchObject({ kind: "unassigned", reason: "no_match" });
    const result = capacityContext({ ...window, plan: "none" }, {}, plans);
    expect(result.plan_detail).toEqual({ label: "none", multiplier: null, status: "unknown" });
    expect(result.promotion_periods).toEqual([]);
  }
  // A provider the catalog does not know at all still gives no tier, and nothing throws.
  expect(capacityContext({ ...window, plan: "none" }, {}, catalog, "grok").plan_detail.multiplier).toBeNull();
});
