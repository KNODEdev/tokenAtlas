import type { CodexComparisonWindow } from "../shared/codex-accounting";
import { CODEX_PRO_5X_LAUNCH_PROMOTION, type CyclePromotion } from "../shared/codex-promotions";
import { capacityRegimesFor, resolveCapacityRegime, validatePlans, type PlansConfig } from "./plans";
import { matchPlanAlias, type PlansCatalog } from "./plans-catalog";

/** Full reset cycles only; never time-average multipliers or alter vendor readings. */
export function cyclePromotion(window: CodexComparisonWindow, plans: PlansConfig, catalog: PlansCatalog, provider = "codex", windowKind = "weekly"): CyclePromotion {
  return capacityPromotionForSpan({ account: window.account, plan: window.plan,
    start: window.cycle_start ?? window.start, end: window.cycle_end ?? window.reset,
    uncertain: window.cycle_start === null || window.cycle_end_basis === "uncertain" }, plans, catalog, provider, windowKind);
}

/** One interval uses the same dated terms as a cycle; changing terms never yield an averaged factor. */
export function capacityPromotionForSpan(span: { account: string; plan: string | null; start: string; end: string; uncertain?: boolean },
  plans: PlansConfig, catalog: PlansCatalog, provider = "codex", windowKind = "weekly"): CyclePromotion {
  const result: CyclePromotion = { status: "unknown", factor: null, regime_ids: [], notes: [], sources: [] };
  const start = Date.parse(span.start), end = Date.parse(span.end);
  if (span.uncertain || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ...result, status: "uncertain" };
  }
  const regimes = capacityRegimesFor(plans, span.account);
  if (validatePlans({ capacity_regimes: regimes }).length) return { ...result, status: "invalid" };
  const scoped = { capacity_regimes: regimes };
  // The plan the window's own readings report; the event's value outranks any period.
  const plan = matchPlanAlias(catalog, provider, span.plan ?? "");
  const resolved: Array<number | null> = [];
  // Regimes have inclusive UTC-day precision.
  for (let time = Math.floor(start / 86400000) * 86400000; time < end; time += 86400000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const regime = resolveCapacityRegime(scoped, { subscription: span.account, day,
      plan_id: plan.kind === "ok" ? plan.plan_id : null, window_kind: windowKind });
    const declared = regimes.find(r => r.id === regime.id);
    const launch = CODEX_PRO_5X_LAUNCH_PROMOTION;
    const hasOverride = regimes.some(r => (!r.from || r.from <= day) && (!r.until || r.until >= day)
      && (!r.plan_id || (plan.kind === "ok" && r.plan_id === plan.plan_id)) && (!r.window_kind || r.window_kind === windowKind));
    const official = provider === "codex" && windowKind === "weekly" && !hasOverride && plan.kind === "ok" && plan.plan_id === "codex-pro-5x"
      && day >= launch.announced && day <= launch.until;
    const entry = declared ?? (official ? { id: launch.id, from: launch.announced, until: launch.until,
      source: "official", factor: launch.factor, note: launch.detail.en, source_url: launch.source } : undefined);
    // Missing coverage is unknown, not evidence for 1×. Inferred/unbounded periods
    // cannot establish promotion-free capacity, even if other estimates use them.
    const factor = entry?.from && entry.until && entry.source !== "inferred" ? (official ? launch.factor : regime.factor) : null;
    resolved.push(factor);
    if (entry && !result.regime_ids.includes(entry.id)) {
      result.regime_ids.push(entry.id);
      if (entry.note) result.notes.push(entry.note);
      if (entry.source_url && !result.sources.includes(entry.source_url)) result.sources.push(entry.source_url);
    }
  }
  const unique = new Set(resolved);
  if (unique.size > 1) return { ...result, status: "mixed" };
  const factor = resolved[0];
  return factor != null && Number.isFinite(factor) && factor > 0 ? { ...result, status: "configured", factor } : result;
}
