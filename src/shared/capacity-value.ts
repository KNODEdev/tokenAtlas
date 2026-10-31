import type { CodexComparisonWindow as Window, WindowUsage } from "./codex-accounting";
import { claudeShareNeverReported } from "./claude-code-capacity";
import { claudeCodeCapacityForWindow, claudeCapacityPerPoint } from "./claude-capacity-result";
import type { CapacityBasis } from "./codex-promotions";

/**
 * The value of one allowance (100% of a meter) of a stored capacity cycle, shared by the Capacity screen, Before / after
 * and the allowance summary read (UR-014) so the server and the browser never compute it two ways.
 */

/** Weekly counter length in minutes. */
export const WEEKLY_MINUTES = 10080;
/** Samples below this meter increase extrapolate too far to compare one week with another. */
export const BEFORE_AFTER_MIN_PP = 40;

export function median(values: readonly number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export type CapacityMetric = "api_standard" | "credits_low" | "credits_high" | "tokens" | "fresh" | "cached" | "output";

export function estimateValue(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const estimate = value as { value?: unknown; absent?: unknown };
  return estimate.absent === null && typeof estimate.value === "number"
    && Number.isFinite(estimate.value) && estimate.value > 0 ? estimate.value : null;
}

/**
 * Return the shared Claude result only when its source is demonstrably this
 * automatic weekly cycle. An explicit null marker is intentional: it prevents
 * consumers from silently falling back to the old local-traffic calibration.
 */
export function metricTotal(window: Window, metric: CapacityMetric): number | null {
  const priced = metric === "api_standard" || metric === "credits_low" || metric === "credits_high";
  if (priced && window.usage.events <= window.usage.unpriced_events) return null;
  if (metric !== "api_standard" && priced && creditsUnavailable(window.usage)) return null;
  const total = metric === "fresh" ? window.usage.input - window.usage.cached
    - (window.usage.cache_write_5m ?? 0) - (window.usage.cache_write_1h ?? 0) - (window.usage.cache_write_unknown ?? 0)
    : metric === "api_standard" ? window.usage.api_normalized ?? window.usage.api_standard : window.usage[metric];
  return Number.isFinite(total) && total >= 0 ? total : null;
}

export function observedCapacityPerPoint(window: Window, metric: CapacityMetric): number | null {
  if (!Number.isFinite(window.observed_pp) || window.observed_pp <= 0 || window.usage.events <= 0) return null;
  const total = metricTotal(window, metric);
  return total === null ? null : total / window.observed_pp;
}

export function promotionFactor(window: Window, basis: CapacityBasis): number | null {
  if (basis === "observed") return 1;
  const factor = window.promotion?.status === "configured" ? window.promotion.factor : null;
  return factor !== null && Number.isFinite(factor) && factor > 0 ? factor : null;
}

export function capacityPerPoint(window: Window, metric: CapacityMetric, basis: CapacityBasis = "observed"): number | null {
  if (window.claude_capacity !== undefined) {
    const result = window.claude_capacity, factor = promotionFactor(window, basis);
    if (result.account !== window.account.toLowerCase() || result.window_id !== window.id
      || result.window_minutes !== (window.window_minutes ?? 10080) || factor === null) return null;
    if (metric === "fresh" || metric === "cached" || metric === "output") {
      const full = result.token_parts?.[metric];
      return full == null ? null : full / 100 / factor;
    }
    if (metric !== "tokens" && metric !== "api_standard") return null;
    const point = claudeCapacityPerPoint(result, metric);
    return point === null ? null : point / factor;
  }
  const shared = claudeCodeCapacityForWindow(window);
  // A window the vendor never sent a share for falls through to local traffic ÷ meter increase.
  if (shared !== undefined && !claudeShareNeverReported(window)) {
    if (!shared || (metric !== "tokens" && metric !== "api_standard")) return null;
    // The shared figure is already a full weekly allowance, so it supplies a
    // per-point rate without dividing the local usage by this window's pp.
    const full = metric === "tokens" ? estimateValue(shared.weekly_capacity_tokens) : estimateValue(shared.weekly_capacity_api_usd);
    const factor = promotionFactor(window, basis);
    return full === null || factor === null ? null : full / 100 / factor;
  }
  const observed = observedCapacityPerPoint(window, metric);
  const factor = promotionFactor(window, basis);
  return observed === null || factor === null ? null : observed / factor;
}
/** The unit of the Capacity screen's switch. */
export type CapacityUnit = "api_standard" | "credits_low" | "tokens";

/** One price-completeness contract for charts and comparisons; tokens do not depend on prices. */
export function capacityIsLowerBound(window: Window, metric: CapacityMetric): boolean {
  if (metric !== "api_standard" && metric !== "credits_low" && metric !== "credits_high") return false;
  if (window.claude_capacity) return window.claude_capacity.capacity_api_usd.relation === "≥";
  const shared = claudeCodeCapacityForWindow(window);
  return shared?.sample_meter
    ? metric === "api_standard" && shared.weekly_capacity_api_usd.relation === "≥"
    : window.usage.unpriced_events > 0;
}

/** Estimated capacity at 100% in one unit; samples of 1 pp or less give no estimate. */
export function capacityFull(window: Window, unit: CapacityUnit, basis: CapacityBasis = "observed"): number | null {
  if (!(window.observed_pp > 1)) return null;
  const perPoint = capacityPerPoint(window, unit, basis);
  return perPoint === null ? null : perPoint * 100;
}

/** Every recorded event predates credit billing, so a credit figure would be an invention. */
export function creditsUnavailable(usage: Pick<WindowUsage, "events" | "credits_unavailable_events">): boolean {
  return usage.events > 0 && (usage.credits_unavailable_events ?? 0) >= usage.events;
}
