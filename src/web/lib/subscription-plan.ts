import { displayPlanCatalog } from "./plan-catalog";
import { canonicalPeriodPlan, isNoPlan } from "../../shared/period-end";
import { resolvePlanFacts } from "../../shared/plan-catalog";
import { noPlanLabel } from "./no-plan";
import { translate } from "./i18n";
import type { SubscriptionSpend } from "./api/project-cost";

/** Resolve provider-specific aliases from the same catalog used by capacity history. */
export function subscriptionPlan(vendor: string, plan: string | null, day = new Date().toISOString().slice(0, 10)): string | null {
  if (!plan) return null;
  if (plan.includes(" → ")) return plan.split(" → ").map(part => subscriptionPlan(vendor, part, day)).join(" → ");
  plan = canonicalPeriodPlan(plan.trim());
  // The built-in "no subscription" value is no catalog plan and has no multiplier.
  if (isNoPlan(plan)) return noPlanLabel();
  const catalog = displayPlanCatalog();
  const facts = resolvePlanFacts(catalog ?? { provider_groups: [] }, vendor, plan, day);
  if (!catalog && facts.source !== "builtin") return translate("Plan not established", "Plan nieustalony");
  return facts.display_label;
}

/** A report's plan names follow its dated pieces, including a multiplier change within one alias. */
export function subscriptionPlanHistory(spend: Pick<SubscriptionSpend, "vendor" | "plan" | "plan_periods"> | null | undefined): string | null {
  if (!spend) return null;
  const names: string[] = [];
  for (const period of spend.plan_periods) {
    const name = subscriptionPlan(spend.vendor, period.plan, period.from);
    if (name && names.at(-1) !== name) names.push(name);
  }
  return names.length ? names.join(" → ") : subscriptionPlan(spend.vendor, spend.plan);
}
