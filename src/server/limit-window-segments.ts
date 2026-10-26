import type { WindowActivity } from "../shared/window-activity";

/**
 * Two reset instants of one counter this close are the same window: the vendor reports one reset a second or
 * so apart from reading to reading. The segmenter joins readings into a window by it; every reader that asks
 * "the same reset" uses it.
 */
export const RESET_JOIN_MS = 120_000;
export const sameReset = (left: string | null, right: string | null): boolean => left != null && right != null
  && Math.abs(Date.parse(left) - Date.parse(right)) <= RESET_JOIN_MS;

export interface ProbeLimitReading {
  ts: string;
  used_percent: number;
  resets_at: string;
  window_minutes: number;
  source?: "probe" | "session" | "manual" | "limit_hit";
  /** Plan reported by this meter, independent of the account's paid billing period. */
  plan?: string | null;
  /** Absolute counter values, when the provider reports them in one consistent unit. */
  allowance?: number | null;
  used?: number | null;
  limit_hit?: { call_id: string };
}
export interface ProbeLimitWindow {
  activity?: WindowActivity;
  id: string;
  account: string;
  counter: string;
  start: string;
  end: string;
  reset: string;
  cycle_end_basis: "scheduled" | "reset" | "uncertain" | "plan_change" | "capacity_change";
  window_minutes: number;
  plan: string | null;
  plan_detail: { label: string; multiplier: null; status: "mixed" } | null;
  declared_plan_meter_mismatch: boolean;
  readings: Array<{ ts: string; percent: number; source: "probe" | "session" | "manual" | "limit_hit"; plan?: string | null; limit_hit?: { call_id: string } }>;
  manual_measurement?: { id: string; approximate_time: boolean; note: string };
  manual_measurements?: Array<{ id: string; approximate_time: boolean; note: string }>;
  startDrop: { before: number; after: number } | null;
  endDrop: { before: number; after: number } | null;
}

export const canonicalTime = (value: string): string => /\.\d{4,}Z$/.test(value)
  ? value : new Date(Date.parse(value)).toISOString();
export const subtractMinutes = (value: string, minutes: number): string => {
  const shifted = new Date(Date.parse(value) - minutes * 60_000).toISOString();
  const extra = /\.\d{3}(\d+)Z$/.exec(value)?.[1];
  return extra ? shifted.slice(0, -1) + extra + "Z" : shifted;
};

/** A segmentation input after validation: canonical instants, and its order among equal instants (grp, ord). */
export interface SegmentInput extends ProbeLimitReading { grp?: string; ord: number }
/** A segment before plan and manual resolution, with the segmenter state its creation recorded. */
export interface RawSegment extends Omit<ProbeLimitWindow, "plan" | "plan_detail" | "declared_plan_meter_mismatch"
  | "manual_measurement" | "manual_measurements"> {
  /** Its start entered the set of seen resets (it began with a changed reset). */
  seenReset: boolean;
  /** The last accepted input: the segmenter's `last` once this segment stops receiving readings. */
  lastInput: SegmentInput;
}
/** Everything the segmenter carries from one input to the next. `out` needs only the open (last) segment. */
export interface SegmenterState { last: SegmentInput | null; seenResets: number[]; out: RawSegment[] }

/** Validated, canonical and ordered segmentation input, exactly as the segmenter consumes it. */
export function segmentationInputs(readings: readonly ProbeLimitReading[]): SegmentInput[] {
  const sorted = readings.filter(p => p.resets_at && Number.isFinite(Date.parse(p.ts))
    && Number.isFinite(Date.parse(p.resets_at)) && Number.isFinite(p.used_percent)
    && p.used_percent >= 0 && p.used_percent <= 100 && p.window_minutes > 0)
    .map(p => ({ ...p, ts: canonicalTime(p.ts), resets_at: canonicalTime(p.resets_at) }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const out: SegmentInput[] = [];
  for (const [index, p] of sorted.entries())
    out.push({ ...p, ord: index > 0 && sorted[index - 1]!.ts === p.ts ? out[index - 1]!.ord + 1 : 0 });
  return out;
}

/**
 * The segmentation rules of one account/counter register. It continues `state`, so a register can resume
 * from the state saved with an earlier segment instead of reading the account's whole history again.
 */
export function segmentReadings(account: string, counter: string, meter: readonly SegmentInput[],
  state: SegmenterState = { last: null, seenResets: [], out: [] }): RawSegment[] {
  const { out, seenResets } = state;
  let last = state.last;
  for (const point of meter) {
    const resetMs = Date.parse(point.resets_at);
    const prior = out.at(-1);
    const resetChanged = !last || Math.abs(Date.parse(last.resets_at) - resetMs) > RESET_JOIN_MS;
    if (resetChanged && seenResets.some(value => Math.abs(value - resetMs) <= RESET_JOIN_MS)) continue;
    const capacityChange = !resetChanged && last && Number.isFinite(last.allowance) && Number.isFinite(point.allowance)
      && last.allowance! > 0 && point.allowance! > 0 && last.allowance !== point.allowance
      ? { before: last.allowance!, after: point.allowance! } : null;
    if (!resetChanged && !capacityChange && point.source === "session" && last && point.used_percent < last.used_percent) continue;
    const drop = !resetChanged && !capacityChange && last && point.used_percent < last.used_percent - 1
      ? { before: last.used_percent, after: point.used_percent } : null;
    if (!prior || resetChanged || drop || capacityChange) {
      const scheduled = subtractMinutes(point.resets_at, point.window_minutes);
      const confirmedReset = resetChanged && (!last || Date.parse(scheduled) >= Date.parse(last.ts));
      const start = drop || capacityChange || !confirmedReset ? point.ts : scheduled;
      if (prior) {
        prior.end = drop ? start : new Date(Math.min(Date.parse(prior.reset), Date.parse(start))).toISOString();
        prior.endDrop = drop;
        prior.cycle_end_basis = capacityChange ? "capacity_change" : drop || !confirmedReset ? "uncertain" : "reset";
        if (prior.activity) prior.activity.spans = prior.activity.spans.map(span => ({ ...span,
          end: Date.parse(span.end) > Date.parse(prior.end) ? prior.end : span.end }));
      }
      out.push({ id: JSON.stringify([account, counter, start]), account, counter, start,
        end: point.resets_at, reset: point.resets_at, cycle_end_basis: "scheduled", window_minutes: point.window_minutes,
        readings: [], startDrop: drop, endDrop: null, seenReset: resetChanged, lastInput: point,
        ...(capacityChange ? { activity: { plan: null, spans: [{ start, end: point.resets_at }],
          start_basis: "partial" as const, capacity_change: capacityChange } } : {}) });
      if (resetChanged) seenResets.push(resetMs);
    }
    const open = out.at(-1)!;
    open.readings.push({ ts: point.ts, percent: point.used_percent, source: point.source ?? "probe",
      ...(point.plan ? { plan: point.plan } : {}),
      ...(point.limit_hit ? { limit_hit: point.limit_hit } : {}) });
    open.lastInput = point;
    last = point;
  }
  state.last = last;
  return out;
}

