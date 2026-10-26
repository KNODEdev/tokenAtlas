import type { CodexComparisonWindow, WindowUsage } from "../../shared/codex-accounting";
import type { CapacityUnit } from "./codex-capacity";

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-9);

/**
 * The context price split of one usage sum. `base` is the normal-context API value and `extra` the long-context
 * uplift; the sum's total is `base + extra` while the provider's premium setting includes it, `base` while not.
 */
function contextSplit(u: WindowUsage): { base: number; extra: number; included: boolean } | null {
  const base = u.context_api_base, extra = u.context_api_extra, total = u.api_normalized ?? u.api_standard;
  if (base === undefined || extra === undefined || u.context_priced_tokens !== u.priced_tokens || !Number.isFinite(base)
    || !Number.isFinite(extra) || base < 0 || extra < 0) return null;
  if (near(base + extra, total)) return { base, extra, included: true };
  return near(base, total) ? { base, extra, included: false } : null;
}

/** A split of the already displayed capacity. Partial context classification never becomes zero. */
export function capacityContextParts(window: CodexComparisonWindow, measure: CapacityUnit, full: number) {
  const u = window.usage;
  const known = u.context_known_tokens, long = u.context_long_tokens;
  if (known === undefined || long === undefined || !Number.isFinite(known) || !Number.isFinite(long)
    || known <= 0 || long < 0 || known > u.tokens || long > known || !(u.tokens > 0) || !Number.isFinite(full) || full < 0) return null;
  const unknown = u.tokens - known;
  if (measure === "tokens") return { base: full * (1 - long / u.tokens), extra: full * long / u.tokens,
    longTokens: long, longEvents: u.context_long_events ?? 0, share: long / u.tokens * 100, unknownTokens: unknown };
  if (measure !== "api_standard") return null;
  const split = contextSplit(u);
  // A value without the uplift has no uplift segment to draw.
  if (!split?.included) return null;
  const total = split.base + split.extra;
  const ratio = total > 0 ? split.extra / total : 0;
  return { base: full * (1 - ratio), extra: full * ratio, longTokens: long, longEvents: u.context_long_events ?? 0,
    share: long / u.tokens * 100, unknownTokens: unknown };
}

/** The usage sum with its API values with or without the uplift, or null when its price split is not complete. */
function withContext<T extends WindowUsage>(u: T, include: boolean): T | null {
  if (u.events <= u.unpriced_events) return u;
  const split = contextSplit(u);
  if (!split) return null;
  if (split.included === include) return u;
  const total = u.api_normalized ?? u.api_standard, target = include ? split.base + split.extra : split.base;
  // The split is in the normalized unit; standard API scales by the same share.
  const ratio = total > 0 ? target / total : 1;
  return { ...u, api_standard: u.api_standard * ratio, ...(u.api_normalized === undefined ? {} : { api_normalized: target }) };
}

/** One usage row at the requested context price; an incomplete split keeps its stored value. */
export function usageWithContext<T extends WindowUsage>(usage: T, include: boolean): T {
  return withContext(usage, include) ?? usage;
}

/**
 * The cycle with its API values with (`include`) or without the long-context uplift, whatever its provider's
 * setting priced. `complete` is false when a sum has no full price split: that sum keeps its stored value.
 */
export function capacityWithContext(window: CodexComparisonWindow, include: boolean): { window: CodexComparisonWindow; complete: boolean } {
  const usage = withContext(window.usage, include);
  const cycle = window.cycle_usage ? withContext(window.cycle_usage, include) : undefined;
  return { window: { ...window, usage: usage ?? window.usage, ...(window.cycle_usage ? { cycle_usage: cycle ?? window.cycle_usage } : {}) },
    complete: usage !== null && cycle !== null };
}

/** The cycle with its API values at normal-context rates. */
export const capacityWithoutContext = (window: CodexComparisonWindow) => capacityWithContext(window, false);

/**
 * How the provider's premium setting priced these cycles: true with the uplift, false without, null when no cycle
 * has long-context traffic with a complete split, so there is no difference to preview.
 */
export function contextPremiumIncluded(windows: readonly CodexComparisonWindow[]): boolean | null {
  let included = 0, excluded = 0;
  for (const w of windows) {
    const split = contextSplit(w.usage);
    if (!split || !(split.extra > 0)) continue;
    if (split.included) included++; else excluded++;
  }
  return included + excluded === 0 ? null : included >= excluded;
}
