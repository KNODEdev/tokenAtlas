/** The probe sample fields a reading from outside the account probe has to fill. */
export interface RailSample {
  id: number;
  ts: string;
  kind: string;
  limit_group: string | null;
  scope: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  vendor_percent: number | null;
  window_minutes: number | null;
  resets_at: string | null;
  machine: string | null;
  extra?: string | null;
  /** A reading from a manual measurement (Capacity → manual readings), not from the vendor. */
  manual?: { id: string; note: string };
  /** The vendor's refusal at the reached limit, recorded by Claude Code (claude_limit_hits). */
  limitHit?: { callId: string };
}

export interface RailGroup<S extends RailSample> {
  kind: string;
  limitGroup: string | null;
  scope: string | null;
  resetIso: string | null;
  unstarted: boolean;
  samples: S[];
}

/**
 * Whether `percent` at `iso` fits the account readings of its window: not below an earlier one, and
 * not above a later one unless that later one is already a drop on record (a plan change). A reading
 * that fails would invent a meter drop, so it is left out.
 */
function agrees(group: RailGroup<RailSample>, iso: string, percent: number): boolean {
  const own = group.samples.filter((sample) => !sample.manual && !sample.limitHit && sample.used_percent != null);
  const before = [...own].reverse().find((sample) => sample.ts <= iso);
  const after = own.find((sample) => sample.ts > iso);
  return (before == null || percent >= before.used_percent!)
    && (after == null || after.used_percent! >= percent || (before != null && after.used_percent! < before.used_percent!));
}

function add<S extends RailSample>(group: RailGroup<S>, template: S, sample: Partial<RailSample>): void {
  group.samples.push({ ...template, id: -1, remaining_percent: null, vendor_percent: null, machine: null, extra: null,
    manual: undefined, limitHit: undefined, ...sample });
  group.samples.sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface LimitHit { callId: string; ts: string; limitType: string; resetsAt: string }

/** The account counter a Claude `rateLimitType` refuses; other types have no rail counter. */
const LIMIT_COUNTERS: Record<string, { kind: string; limitGroup: string; minutes: number }> = {
  seven_day: { kind: "weekly_all", limitGroup: "weekly", minutes: 10080 },
  five_hour: { kind: "session", limitGroup: "session", minutes: 300 },
};

/**
 * Adds each refusal as a 100% reading of the counter and reset the vendor named. It joins the window
 * with that reset (`sameReset`), or starts one when no account reading of that window exists (the probe
 * was down all along). Like a manual reading it must agree with the window's account readings.
 */
export function addLimitHitReadings<S extends RailSample>(
  groups: RailGroup<S>[],
  hits: readonly LimitHit[],
  sameReset: (left: string | null, right: string | null) => boolean,
  template: (hit: LimitHit, counter: { kind: string; limitGroup: string; minutes: number }) => S,
): void {
  for (const hit of hits) {
    const counter = LIMIT_COUNTERS[hit.limitType];
    if (!counter || !Number.isFinite(Date.parse(hit.ts)) || !Number.isFinite(Date.parse(hit.resetsAt))) continue;
    if (Date.parse(hit.ts) >= Date.parse(hit.resetsAt)) continue;
    // Readings from before limit groups were recorded carry none; the kind alone names the counter then.
    const group = groups.find((candidate) => !candidate.unstarted && candidate.scope == null && candidate.kind === counter.kind
      && (candidate.limitGroup === counter.limitGroup || candidate.limitGroup == null) && sameReset(candidate.resetIso, hit.resetsAt));
    const reading = { ts: new Date(Date.parse(hit.ts)).toISOString(), used_percent: 100, limitHit: { callId: hit.callId } };
    if (!group) {
      groups.push({ kind: counter.kind, limitGroup: counter.limitGroup, scope: null, resetIso: hit.resetsAt, unstarted: false,
        samples: [{ ...template(hit, counter), ...reading }] });
      continue;
    }
    if (!agrees(group, reading.ts, 100) || group.samples.some((sample) => sample.limitHit?.callId === hit.callId)) continue;
    add(group, group.samples[0]!, reading);
  }
}
