import { afterEach, expect, test } from "bun:test";
import type { RosterCard } from "./roster";
import type { SubscriptionSpend, PlansCatalog } from "./api";
import { convert, planUnits } from "./planUnits";
import { displayPlanCatalog, publishDisplayPlanCatalog } from "./plan-catalog";
import { subscriptionPlanHistory } from "./subscription-plan";

const original = displayPlanCatalog();
afterEach(() => publishDisplayPlanCatalog(original));
const catalog: PlansCatalog = { provider_groups: [{ id: "openai", label: "OpenAI", aliases: ["codex"], plans: [{
  plan_id: "offer", label: "Dated Pro", aliases: ["pro"], versions: [
    { from: "2026-01-01", usd_per_month: 100, limits: { credits_multiplier: 5 } },
    { from: "2026-09-01", usd_per_month: 200, limits: { credits_multiplier: 20 } },
  ],
}] }] };
const card = { id: "account", vendor: "codex", group: "codex", plan: "pro", vendorAccount: "owner@example.com", color: "var(--codex)",
  pointBasis: { start: "2026-08-01", end: "2026-08-07", windowStart: "2026-08-01", windowHours: 168, plan: "pro", percent: 50,
    usd: 1000, credits: 25000, tokens: 1e6, partial: false } } as RosterCard;
const spend: SubscriptionSpend = { id: "account", vendor: "codex", plan: "pro", usd_per_month: null, usd_per_month_declared: 999,
  plan_periods: [
    { plan: null, usd_per_month: null, from: "2026-07-01", until: "2026-07-31", days: 31, usd: null, source: "rate-card" },
    { plan: "pro", usd_per_month: 100, from: "2026-08-01", until: "2026-08-31", days: 31, usd: 100, source: "declared" },
  ],
  api_usd: 50, attributed_usd: 50, first_day: "2026-07-01", last_day: "2026-08-31", days: 62, paid_usd: null, basis: "rate-card",
  capacity: { usd_per_point: 10, weekly_window_value_usd: 1000, session_window_value_usd: null, window_hours: 168, session_hours: null } };

test("the what-if uses the dated offer price even when this account's historical bill has gaps", () => {
  publishDisplayPlanCatalog(catalog);
  const before = JSON.stringify(spend), unit = planUnits([card], [spend])[0]!;
  expect(unit.label).toContain("Dated Pro · ×5");
  expect(subscriptionPlanHistory(spend)).toBe("Dated Pro · ×5");
  expect(unit.usdPerMonth).toBe(100);
  expect(convert(2000, unit, 30).usd).toBeCloseTo(2 * 7 / 30.44 * 100, 8);
  expect(JSON.stringify(spend)).toBe(before);
  expect(spend.paid_usd).toBeNull();
});

test("an unknown dated catalog price never borrows the historical or declared account price", () => {
  const unknown = structuredClone(catalog);
  unknown.provider_groups[0]!.plans[0]!.versions[0]!.usd_per_month = null;
  publishDisplayPlanCatalog(unknown);
  expect(planUnits([card], [{ ...spend, usd_per_month: 123 }])[0]!.usdPerMonth).toBeNull();
});

test("editing the one active catalog changes the simulation's offer price as well as its label", () => {
  const edited = structuredClone(catalog);
  edited.provider_groups[0]!.plans[0]!.label = "Edited";
  edited.provider_groups[0]!.plans[0]!.versions[0]!.usd_per_month = 95;
  publishDisplayPlanCatalog(edited);
  const unit = planUnits([card], [spend])[0]!;
  expect(unit.usdPerMonth).toBe(95);
  expect(unit.label).toContain("Edited · ×5");
});
