import { expect, test } from "bun:test";
import { resolvePlanFacts, type PlansCatalog } from "./plan-catalog";

const catalog: PlansCatalog = { provider_groups: [
  { id: "openai", label: "OpenAI", aliases: ["codex"], plans: [{ plan_id: "offer", label: "Custom Pro", aliases: ["pro"], versions: [
    { from: "2026-01-01", usd_per_month: 100, usd_per_month_annual: 80, limits: { credits_multiplier: 5 } },
    { from: "2026-09-01", usd_per_month: 200, limits: { credits_multiplier: 20 } },
  ] }] },
  { id: "anthropic", label: "Anthropic", aliases: ["claude"], plans: [{ plan_id: "claude-pro", label: "Pro", aliases: ["pro"],
    versions: [{ from: null, usd_per_month: 20 }] }] },
] };

test("one dated identity binds label, multiplier and monthly/annual prices, with provider-specific aliases", () => {
  expect(resolvePlanFacts(catalog, " CODEX ", " pro ", "2026-08-16T12:00:00Z")).toMatchObject({ provider: "openai", plan_id: "offer",
    version_id: "2026-01-01", display_label: "Custom Pro · ×5", multiplier: 5, usd_per_month: 100, usd_per_month_annual: 80, issue: null });
  expect(resolvePlanFacts(catalog, "openai", "offer", "2026-09-01")).toMatchObject({ display_label: "Custom Pro · ×20",
    multiplier: 20, usd_per_month: 200, usd_per_month_annual: null });
  expect(resolvePlanFacts(catalog, "claude", "default_claude_ai", "2026-09-01")).toMatchObject({ plan_id: "claude-pro",
    display_label: "Pro · ×1", multiplier: 1, usd_per_month: 20 });
});

test("future or invalid dates do not borrow a current price or multiplier", () => {
  for (const day of ["2025-12-31", "2026-02-30", "bad"]) expect(resolvePlanFacts(catalog, "codex", "pro", day))
    .toMatchObject({ plan_id: "offer", usd_per_month: null, multiplier: null, issue: "no_version_for_day" });
});

test("only explicit aliases identify a plan, not its display label or guessed punctuation", () => {
  for (const query of ["Custom Pro", "p-r-o"]) expect(resolvePlanFacts(catalog, "codex", query, "2026-09-01"))
    .toMatchObject({ plan_id: null, usd_per_month: null, multiplier: null, issue: "no_match" });
  const ambiguous = structuredClone(catalog);
  ambiguous.provider_groups[0]!.plans.push({ plan_id: "other", label: "Other", aliases: ["pro"], versions: [{ from: null, usd_per_month: 1 }] });
  expect(resolvePlanFacts(ambiguous, "codex", "pro", "2026-09-01")).toMatchObject({ plan_id: null, usd_per_month: null, issue: "ambiguous_match" });
});

test("Free and no subscription are known zero-cost states; unknown prices are never zero", () => {
  const empty: PlansCatalog = { provider_groups: [] };
  for (const provider of ["codex", "openai"]) expect(resolvePlanFacts(empty, provider, "free", "2026-09-01"))
    .toMatchObject({ plan_id: "codex-free", display_label: "Free", usd_per_month: 0, multiplier: null, source: "builtin", issue: null });
  expect(resolvePlanFacts(empty, "custom", "none", "2026-09-01")).toMatchObject({ usd_per_month: 0, multiplier: null, issue: null });
  expect(resolvePlanFacts(empty, "claude", "free", "2026-09-01")).toMatchObject({ usd_per_month: null, issue: "unknown_provider_alias" });
  const unknown = structuredClone(catalog);
  unknown.provider_groups[0]!.plans[0]!.versions[1]!.usd_per_month = null;
  expect(resolvePlanFacts(unknown, "codex", "pro", "2026-09-01")).toMatchObject({ usd_per_month: null, multiplier: 20 });
});
