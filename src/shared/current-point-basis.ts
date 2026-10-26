import type { CodexComparisonWindow } from "./codex-accounting";
import { previewContextAmount, type ContextPrice } from "./context-price";
import type { CreditWindowBasis } from "./credit-funded";

/** One prepared meter sample, expressed at 100%; never a whole-history calibration. */
export interface CurrentPointBasis {
  start: string;
  end: string;
  windowStart: string;
  windowHours: number;
  plan: string;
  percent: number;
  usd: number;
  credits: number | null;
  tokens: number;
  partial: boolean;
  contextPrice?: ContextPrice;
  contextUnavailable?: boolean;
}

export const MIN_POINT_BASIS_PP = 10;

/** Uses the same paired, jointly priced facts and meter span as Capacity. */
export function preparedPointBasis(window: CodexComparisonWindow): CurrentPointBasis | null {
  const usage = window.usage;
  const value = usage.api_normalized ?? usage.api_standard;
  if (!window.plan || window.plan_detail?.status === "mixed" || window.declared_plan_meter_mismatch
    || !(window.observed_pp >= MIN_POINT_BASIS_PP && window.observed_pp <= 100)
    || window.probes < 2 || !(usage.events > usage.unpriced_events) || !(value > 0)
    || !Number.isFinite(window.window_minutes) || !(window.window_minutes! > 0)
    || !Number.isFinite(value) || !(Date.parse(window.end) > Date.parse(window.start))) return null;
  const scale = 100 / window.observed_pp;
  const base = usage.context_api_base, extra = usage.context_api_extra;
  const contextPrice = base !== undefined && extra !== undefined && base >= 0 && extra >= 0
    && usage.context_priced_tokens === usage.priced_tokens
    && [base, extra].every(Number.isFinite)
    && (Math.abs(value - base) < 1e-7 || Math.abs(value - base - extra) < 1e-7)
    ? { base: base * scale, extra: extra * scale, stored: value * scale } : undefined;
  return {
    start: window.start, end: window.end, windowStart: window.cycle_start ?? window.start,
    windowHours: window.window_minutes! / 60, plan: window.plan, percent: window.observed_pp,
    usd: value * scale,
    credits: !usage.credits_unavailable_events && Number.isFinite(usage.credits_low) && usage.credits_low > 0
      ? usage.credits_low * scale : null,
    tokens: usage.tokens * scale,
    partial: usage.unpriced_events > 0 || usage.unknown_tokens > 0,
    ...(contextPrice ? { contextPrice } : {}),
  };
}

export interface PointBasisCycle {
  window_start_iso: string | null;
  work_from_ts: string;
  window_hours: number;
  plan_types: string[];
  shadow: boolean;
  point_basis?: CurrentPointBasis | null;
}

/** Latest usable sample within the newest cycle's plan and counter, independent of input order. */
export function currentPointBasis(cycles: readonly PointBasisCycle[]): CurrentPointBasis | null {
  const ordered = cycles.filter(cycle => !cycle.shadow).sort((a, b) =>
    Date.parse(b.window_start_iso ?? b.work_from_ts) - Date.parse(a.window_start_iso ?? a.work_from_ts));
  const latest = ordered[0];
  if (!latest || latest.plan_types.length !== 1) return null;
  for (const cycle of ordered) {
    // Never reach across a plan/counter change, including an intervening unknown plan.
    if (cycle.window_hours !== latest.window_hours || cycle.plan_types.length !== 1
      || cycle.plan_types[0] !== latest.plan_types[0]) break;
    if (cycle.point_basis) return cycle.point_basis;
  }
  return null;
}

export function pointBasisWithContext(basis: CurrentPointBasis | null | undefined, on: boolean): CurrentPointBasis | null | undefined {
  return !basis || !on ? basis : { ...basis,
    usd: previewContextAmount(basis.contextPrice?.stored ?? basis.usd, basis.contextPrice, true),
    contextUnavailable: !basis.contextPrice };
}

export function creditBasisOf(basis: CurrentPointBasis | null): CreditWindowBasis | null {
  return basis?.credits && basis.credits > 0 ? {
    start: basis.windowStart, end: basis.end, credits: basis.credits, usd: basis.usd,
    tokens: basis.tokens, partial: basis.partial,
    sample: { start: basis.start, end: basis.end, percent: basis.percent },
    contextUnavailable: basis.contextUnavailable,
  } : null;
}
