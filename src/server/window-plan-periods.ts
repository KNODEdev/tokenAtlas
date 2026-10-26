import { periodInstant, type DatedPeriod, type PeriodIndex } from "./account-periods";
import type { ProbeLimitWindow } from "./limit-window-segments";
import { isFreePlan, isNoPlan } from "../shared/period-end";

/** Known entitlement spans for synthetic windows; absent history keeps existing traffic coverage. */
export function planReconstructionSpans(index: PeriodIndex | null, provider: string, account: string, paidOnly = false):
  Array<{ from: number; until: number }> | null {
  const periods = index?.periodsOf(provider, account) ?? [];
  if (!periods.length) return null;
  const edges = [...new Set(periods.flatMap(period => [Date.parse(period.from),
    ...(period.until === null ? [] : [Date.parse(period.until)])]))].sort((a, b) => a - b);
  return edges.flatMap((from, i) => {
    const plan = index!.resolve(provider, account, new Date(from).toISOString()).value;
    return plan !== null && !isNoPlan(plan) && (!paidOnly || !isFreePlan(plan)) && plan !== "unknown"
      ? [{ from, until: edges[i + 1] ?? Infinity }] : [];
  });
}

/** The same dated plan resolution for measured and cadence-only windows. */
export function probeWindowPlan(index: PeriodIndex | null, periods: readonly DatedPeriod[],
  provider: string, account: string, start: string, end: string):
  Pick<ProbeLimitWindow, "plan" | "plan_detail" | "declared_plan_meter_mismatch"> {
  const startMs = Date.parse(start), endMs = Date.parse(end);
  const instants = [startMs];
  for (const period of periods) {
    if (period.provider !== provider || period.subject.toLowerCase() !== account.toLowerCase()) continue;
    for (const edge of [period.from, period.until]) {
      if (!edge) continue;
      const at = periodInstant(edge, "plan period edge");
      if (at > startMs && at < endMs) instants.push(at);
    }
  }
  // A stretch no period covers is an unknown plan, not a plan change: it adds nothing.
  const plans = [...new Set(instants.sort((a, b) => a - b)
    .map(at => index?.resolve(provider, account, new Date(at).toISOString()).value ?? null)
    .filter((plan): plan is string => plan !== null))];
  const mixed = plans.length > 1;
  return { plan: mixed ? null : plans[0] ?? null,
    plan_detail: mixed ? { label: plans.join(" → "), multiplier: null, status: "mixed" } : null,
    declared_plan_meter_mismatch: mixed };
}


