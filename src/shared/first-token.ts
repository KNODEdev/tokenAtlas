/** Exact millisecond frequencies: merging periods never averages their percentiles. */
export interface FirstTokenSamples {
  turns: number;
  histogram: Array<[milliseconds: number, turns: number]>;
}
export const emptyFirstToken = (): FirstTokenSamples => ({ turns: 0, histogram: [] });
export function mergeFirstToken(values: readonly (FirstTokenSamples | undefined)[]): FirstTokenSamples {
  const counts = new Map<number, number>();
  let turns = 0;
  for (const value of values) {
    if (!value) continue;
    turns += value.turns;
    for (const [ms, n] of value.histogram) counts.set(ms, (counts.get(ms) ?? 0) + n);
  }
  return { turns, histogram: [...counts].sort(([a], [b]) => a - b) };
}
export function firstTokenSummary(value: FirstTokenSamples | undefined) {
  const measured = value?.histogram.reduce((sum, [, n]) => sum + n, 0) ?? 0;
  const rank = (target: number): number | null => {
    if (!measured) return null;
    let n = 0;
    for (const [ms, count] of value!.histogram) { n += count; if (n >= target) return ms; }
    return null;
  };
  const median = measured ? (rank(Math.floor((measured + 1) / 2))! + rank(Math.ceil((measured + 1) / 2))!) / 2 : null;
  return { turns: value?.turns ?? 0, measured, median_ms: median, p90_ms: rank(Math.ceil(measured * 0.9)),
    coverage: value?.turns ? measured / value.turns : null };
}
