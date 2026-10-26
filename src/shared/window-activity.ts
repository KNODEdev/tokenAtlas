/** Disjoint half-open spans when this meter was selected; its scheduled reset does not move. */
export interface WindowActivity {
  plan: string | null;
  spans: Array<{ start: string; end: string }>;
  /** Reset/activation establish zero; partial and resumed spans retain their observed baseline. */
  start_basis?: "reset" | "activation" | "partial";
  /** A changed denominator segments comparisons without resetting cumulative usage. */
  capacity_change?: { before: number; after: number };
}

export const activityHasZeroStart = (activity: WindowActivity | undefined): boolean =>
  activity?.start_basis === "reset" || activity?.start_basis === "activation";

export const activityStartsAt = (activity: WindowActivity | undefined, start: number): boolean =>
  !activity || Date.parse(activity.spans[0]?.start ?? "") === start;

export function windowActiveAt(window: { start: string; end: string; activity?: WindowActivity }, at: number): boolean {
  return at >= Date.parse(window.start) && at < Date.parse(window.end)
    && (!window.activity || window.activity.spans.some(span => at >= Date.parse(span.start) && at < Date.parse(span.end)));
}
