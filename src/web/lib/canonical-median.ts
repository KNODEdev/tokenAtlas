/**
 * The one median every screen compares against (UI audit decision 6, 2026-09-26): cycles of the same
 * plan, with a sample of at least 20 percentage points and medium or high confidence. Capacity,
 * Analytics, Patterns and the cycle drawer map their own cycles to `MedianSample` and call this.
 */
export type MedianConfidence = "high" | "medium" | "low" | "none";

export interface MedianSample {
  /** The measured value of one cycle; null when it has none. */
  value: number | null;
  /** Plan identity and label, e.g. "Pro ×20"; null when the plan is not confirmed. */
  plan: string | null;
  /** Meter increase the value rests on, in percentage points. */
  samplePp: number;
  confidence: MedianConfidence;
}

export const CANONICAL_MEDIAN_MIN_PP = 20;
export const CANONICAL_MEDIAN_MIN_COUNT = 2;

export type CanonicalMedian =
  | { value: number; plan: string; count: number; values: number[] }
  | { value: null; plan: string | null; count: number; reason: "no_plan" | "too_few" };

export function isCanonicalMedianSample(sample: MedianSample, plan: string): boolean {
  return sample.plan === plan && sample.samplePp >= CANONICAL_MEDIAN_MIN_PP
    && (sample.confidence === "high" || sample.confidence === "medium")
    && sample.value !== null && Number.isFinite(sample.value);
}

/** Median of the eligible samples of `plan`, or the reason there is none; `values` are sorted ascending. */
export function canonicalMedian(samples: readonly MedianSample[], plan: string | null): CanonicalMedian {
  if (plan === null) return { value: null, plan, count: 0, reason: "no_plan" };
  const values = samples.filter(sample => isCanonicalMedianSample(sample, plan)).map(sample => sample.value!).sort((a, b) => a - b);
  if (values.length < CANONICAL_MEDIAN_MIN_COUNT) return { value: null, plan, count: values.length, reason: "too_few" };
  const middle = values.length >> 1;
  const value = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  return { value, plan, count: values.length, values };
}
