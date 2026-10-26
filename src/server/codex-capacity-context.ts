import type { CodexComparisonWindow } from "../shared/codex-accounting";
import { cyclePromotion } from "./codex-promotions";
import type { PlansConfig } from "./plans";
import { resolvePlanFacts, type PlansCatalog } from "../shared/plan-catalog";
import { isNoPlan, NO_PLAN } from "../shared/period-end";

/**
 * Resolve historical plan tiers and bounded boosts independently of the measured capacity. The
 * tier is the plan resolved by the shared limit register, including the meter's own plan evidence.
 */
export function capacityContext(window: CodexComparisonWindow, plans: PlansConfig, catalog: PlansCatalog, provider = "codex", windowKind = "weekly") {
  const start = Date.parse(window.cycle_start ?? window.start), end = Date.parse(window.cycle_end ?? window.reset);
  const tiers = new Map<string, NonNullable<CodexComparisonWindow["plan_detail"]>>();
  const promotion_periods: NonNullable<CodexComparisonWindow["promotion_periods"]> = [];
  for (let time = Math.floor(start / 86400000) * 86400000; time < end; time += 86400000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const facts = resolvePlanFacts(catalog, provider, window.plan ?? "", day);
    const detail = isNoPlan(facts.plan_id)
      ? { label: window.plan ?? NO_PLAN, multiplier: null, status: "unknown" as const }
      : { label: facts.label || "?", multiplier: facts.multiplier,
          status: facts.issue === null ? "resolved" as const : "unknown" as const };
    tiers.set(JSON.stringify(detail), detail);
    const partStart = new Date(Math.max(start, time)).toISOString();
    const partEnd = new Date(Math.min(end, time + 86400000)).toISOString();
    // A declared period may cover only part of a cycle. It must not normalize the whole cycle.
    const promotion = cyclePromotion({ ...window, cycle_start: partStart, cycle_end: partEnd, cycle_end_basis: "reset" }, plans, catalog, provider, windowKind);
    if (promotion.status === "configured" && promotion.factor !== null && promotion.factor > 1) {
      const previous = promotion_periods.at(-1);
      if (previous?.end === partStart && previous.factor === promotion.factor) previous.end = partEnd;
      else promotion_periods.push({ start: partStart, end: partEnd, factor: promotion.factor });
    }
  }
  const plan_detail = tiers.size === 1 ? [...tiers.values()][0]!
    : { label: [...new Set([...tiers.values()].map(t => t.label))].join(" → ") || window.plan || "?", multiplier: null, status: tiers.size > 1 ? "mixed" as const : "unknown" as const };
  return { plan_detail, promotion_periods };
}
