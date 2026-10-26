import { afterEach, expect, test } from "bun:test";
import { subscriptionPlan } from "./subscription-plan";
import { planText } from "./no-plan";
import { capacityPlanLabel } from "./codex-capacity";
import { formatPlanLabel } from "../../shared/plan-label";
import { displayPlanCatalog, publishDisplayPlanCatalog, subscribeDisplayPlanCatalog } from "./plan-catalog";
import { catalogTiers } from "./capacity-battle";
import type { PlansCatalog } from "./api/settings";

const original = displayPlanCatalog();
afterEach(() => publishDisplayPlanCatalog(original));

test("plan multiples stay provider-specific and respect the catalog's exact aliases", () => {
  expect(subscriptionPlan("codex", "plus")).toBe("Plus · ×1");
  expect(subscriptionPlan("codex", "pro-5x")).toBe("Pro · ×5");
  expect(subscriptionPlan("codex", "pro-20x")).toBe("Pro · ×20");
  expect(subscriptionPlan("codex", "pro")).toBe("Pro · ×20");
  expect(subscriptionPlan("openai", "pro")).toBe("Pro · ×20");
  expect(subscriptionPlan("codex", "prolite")).toBe("Pro · ×5");
  expect(subscriptionPlan("claude", "pro")).toBe("Pro · ×1");
  expect(subscriptionPlan("claude", "max-20x")).toBe("Max · ×20");
  // Undeclared spellings cannot resolve only in the browser while pricing rejects them.
  expect(subscriptionPlan("claude", "max20x")).toBe("max20x");
  expect(subscriptionPlan("claude", "max-5x")).toBe("Max · ×5");
  expect(subscriptionPlan("grok", "custom-plan")).toBe("custom-plan");
  expect(subscriptionPlan("codex", null)).toBeNull();
});

test("periods, cards and measured windows use the same full plan label", () => {
  for (const [provider, alias, label, multiplier] of [
    ["codex", "prolite", "Pro (5x)", 5], ["codex", "pro", "Pro (20x)", 20],
    ["claude", "default_claude_ai", "Pro", 1], ["claude", "default_claude_max_20x", "Max 20x", 20],
  ] as const) {
    expect(subscriptionPlan(provider, alias)).toBe(capacityPlanLabel({ plan: alias,
      plan_detail: { label, multiplier, status: "resolved" } } as Parameters<typeof capacityPlanLabel>[0]));
  }
  for (const name of ["Pro (5x)", "Pro ×5", "Pro (x5)", "Pro · ×5"]) expect(formatPlanLabel(name, 5)).toBe("Pro · ×5");
  expect(subscriptionPlan("claude", "pro → max-5x → none")).toBe("Pro · ×1 → Max · ×5 → No subscription");
});

test("the active server catalog replaces shipped labels and uses the version on the period's date", () => {
  const catalog: PlansCatalog = { provider_groups: [{ id: "openai", label: "OpenAI", aliases: ["codex"], plans: [{
    plan_id: "codex-pro-20x", label: "Custom Pro", aliases: ["pro"], versions: [
      { from: "2026-01-01", usd_per_month: 100, limits: { credits_multiplier: 5 } },
      { from: "2026-09-01", usd_per_month: 200, limits: { credits_multiplier: 20 } },
    ],
  }] }] };
  let updates = 0;
  const unsubscribe = subscribeDisplayPlanCatalog(() => updates++);
  try {
    publishDisplayPlanCatalog(catalog);
    publishDisplayPlanCatalog(structuredClone(catalog));
    expect(updates).toBe(1);
    expect(subscriptionPlan("codex", "pro", "2026-08-16")).toBe("Custom Pro · ×5");
    expect(subscriptionPlan("codex", "pro", "2026-09-16")).toBe("Custom Pro · ×20");
    expect(catalogTiers("codex", "2026-08-16")).toEqual([{ tier: 5, label: "Custom Pro", usdPerMonth: 100 }]);
    expect(subscriptionPlan("claude", "pro")).toBe("pro");
    publishDisplayPlanCatalog(null);
    expect(subscriptionPlan("codex", "pro")).toBe("Plan not established");
    expect(catalogTiers("codex")).toEqual([]);
    expect(subscriptionPlan("codex", "free")).toBe("Free");
  } finally { unsubscribe(); }
});

test("the reserved \"none\" reads as words and never gets a multiplier, alone or in a plan chain", () => {
  for (const vendor of ["claude", "codex", "grok"]) expect(subscriptionPlan(vendor, "none")).toBe("No subscription");
  expect(planText("max-20x → none → max-20x")).toBe("max-20x → No subscription → max-20x");
  expect(planText("nonexistent-plan")).toBe("nonexistent-plan");
  expect(planText(null)).toBeNull();
  expect(capacityPlanLabel({ plan: "none", plan_detail: { label: "none", multiplier: null, status: "unknown" } } as Parameters<typeof capacityPlanLabel>[0]))
    .toBe("No subscription");
});
