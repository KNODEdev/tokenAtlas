import type { PlanPriceStretch } from "./plans";
import type { PlanPriceGap } from "../shared/plan-price-coverage";

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);

/** Price gaps of the shared pricing result; no second calculation or source read. */
export function planPriceGaps(stretches: readonly PlanPriceStretch[]): PlanPriceGap[] {
  const gaps: Array<{ fromMs: number; untilMs: number; plans: Set<string>; pending: boolean }> = [];
  for (const stretch of stretches) {
    if (stretch.monthly !== null) continue;
    const pending = !!stretch.cycle && stretch.cycle.usd === null && stretch.cycle.fx !== null;
    let gap = gaps.at(-1);
    if (!gap || gap.untilMs !== stretch.fromMs || gap.pending !== pending) gaps.push(gap = { fromMs: stretch.fromMs, untilMs: stretch.untilMs, plans: new Set(), pending });
    gap.untilMs = stretch.untilMs;
    if (stretch.plan && !pending) gap.plans.add(stretch.plan);
  }
  return gaps.map((gap) => ({ from: day(gap.fromMs), until: day(gap.untilMs - 1), days: (gap.untilMs - gap.fromMs) / DAY_MS,
    from_ts: iso(gap.fromMs), until_ts: iso(gap.untilMs), plans: [...gap.plans].sort(), ...(gap.pending ? { rate_pending: true as const } : {}) }));
}
