import type { Database } from "bun:sqlite";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import { effectiveDatedPeriods, periodInstant, planPeriodIndex, type DatedPeriod, type PeriodIndex } from "./account-periods";
import { claudeEventOwnedBySql } from "./claude-event-account";
import type { AccountResolver } from "./account-resolver";
import { readPreparedProbeAccountHistory, readPreparedProbeAccountingRevision, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { probeAccountingTime } from "./current/probe-accounting-time";
import { resolveCadenceForDay, type CyclesConfig } from "./cycles";
import { addLimitHitReadings, type LimitHit, type RailGroup, type RailSample } from "./rail-readings";
import { subscriptionAccountingAdapter, limitHitTableOf } from "./subscription-accounting-adapters";
import type { ClaudeCounterReset } from "../shared/claude-code-capacity";
import { readLimitWindowStarts, readLimitWindowsWhere } from "../db/limit-windows";
import { canonicalPeriodPlan } from "../shared/period-end";
import type { WindowActivity } from "../shared/window-activity";

export interface ProbeLimitSample extends RailSample {
  provider: string; subject: string; plan: string | null;
  allowance: number | null; used: number | null; remaining: number | null; ok: number | null;
}
export interface ProbeLimitEvidence {
  samples: ProbeLimitSample[];
  /** Account-wide prepared revisions plus owned limit hits, independent of a screen's date range. */
  revision: unknown;
}

/**
 * Two reset instants of one counter this close are the same window: the vendor reports one reset a second or
 * so apart from reading to reading. The segmenter joins readings into a window by it; every reader that asks
 * "the same reset" uses it.
 */
export const RESET_JOIN_MS = 120_000;
const sameReset = (left: string | null, right: string | null): boolean => left != null && right != null
  && Math.abs(Date.parse(left) - Date.parse(right)) <= RESET_JOIN_MS;

/** Prepared probe rows as limit samples: successful readings at accounting time, in reading order. */
export function probeLimitSamples(rows: readonly Record<string, unknown>[], provider: string): ProbeLimitSample[] {
  return (rows as unknown as ProbeLimitSample[])
    .filter(row => row.kind !== "error" && (row.ok == null || row.ok === 1))
    .map(row => ({ ...row, ts: probeAccountingTime({ ...row, provider, extra: row.extra ?? null }) }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
}

export interface LimitHitRow { call_id: string; ts: string; limit_type: string; resets_at: string; type_basis: string }
/** The account's refusals in time order, optionally only those whose time string lies in [from, until). */
export function ownedLimitHitRows(sqlite: Database, provider: string, account: string, resolver: AccountResolver,
  range?: { from: string; until: string }): LimitHitRow[] {
  // The refusal table keeps its provider's event ownership columns (Claude's), read by the same predicate.
  const table = limitHitTableOf(provider);
  if (!table || !sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  const owned = claudeEventOwnedBySql(sqlite, resolver, account, { alias: "h" });
  const hasBasis = (sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some(column => column.name === "type_basis");
  return sqlite.query(`SELECT h.call_id, h.ts, h.limit_type, h.resets_at,
    ${hasBasis ? "h.type_basis" : "'vendor' AS type_basis"} FROM ${table} h
    WHERE h.status = 'rejected' AND h.resets_at IS NOT NULL AND ${owned.sql}${range ? " AND h.ts >= ? AND h.ts < ?" : ""}
    ORDER BY h.ts`).all(...owned.params, ...(range ? [range.from, range.until] : [])) as LimitHitRow[];
}

/** Refusals that join (or start) the window of their reset as 100% readings; `samples` in reading order. */
export function acceptLimitHits(provider: string, account: string, samples: readonly ProbeLimitSample[],
  hits: readonly LimitHitRow[]): ProbeLimitSample[] {
  if (limitHitTableOf(provider) === undefined) return [];
  // Retries can emit many refusals for one reset. The first refusal is the useful 100% time.
  const seen = new Set<string>();
  const distinct = hits.filter(row => { if (row.type_basis === "vendor") return true;
    const key = `${row.limit_type}:${row.resets_at}`;
    if (seen.has(key)) return false; seen.add(key); return true; }).map(row =>
    ({ callId: row.call_id, ts: row.ts, limitType: row.limit_type, resetsAt: row.resets_at } satisfies LimitHit));
  const groups: RailGroup<ProbeLimitSample>[] = [];
  for (const sample of samples.filter(s => s.resets_at != null)) {
    const group = groups.find(g => g.kind === sample.kind && g.limitGroup === sample.limit_group && g.scope === sample.scope
      && sameReset(g.resetIso, sample.resets_at));
    if (group) group.samples.push(sample);
    else groups.push({ kind: sample.kind, limitGroup: sample.limit_group, scope: sample.scope,
      resetIso: sample.resets_at, unstarted: false, samples: [sample] });
  }
  addLimitHitReadings(groups, distinct, sameReset, (hit, counter) => ({
    id: -1, provider, subject: account, ts: hit.ts, plan: null, kind: counter.kind, limit_group: counter.limitGroup,
    scope: null, used_percent: 100, remaining_percent: null, vendor_percent: null, window_minutes: counter.minutes,
    allowance: null, used: null, remaining: null, resets_at: hit.resetsAt, machine: null, ok: 1, extra: null,
  }));
  return groups.flatMap(group => group.samples.filter(sample => sample.limitHit));
}

/** Samples and accepted refusals in the order every limit reader consumes them. */
export const withLimitHits = (samples: readonly ProbeLimitSample[], hits: readonly ProbeLimitSample[]): ProbeLimitSample[] =>
  [...samples, ...hits].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);

/** Read one prepared account history and its owned refusals. Both endpoint adapters use this input. */
export function loadProbeLimitEvidence(sqlite: Database, provider: string, account: string, resolver: AccountResolver,
  options: { revision?: boolean } = {}): ProbeLimitEvidence {
  const prepared = readPreparedProbeAccountHistory(sqlite, provider, account);
  if (!prepared) throw new ProbeAccountIndexUnavailable();
  const samples = probeLimitSamples(prepared.rows, provider);
  const acceptedHits = acceptLimitHits(provider, account, samples, ownedLimitHitRows(sqlite, provider, account, resolver));
  const revision = options.revision === false ? null : [readPreparedProbeAccountingRevision(sqlite, provider, account,
    "1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"),
    acceptedHits.map(hit => [hit.limitHit?.callId, hit.ts, hit.kind, hit.limit_group, hit.resets_at])];
  return { samples: withLimitHits(samples, acceptedHits), revision };
}

/**
 * `loadProbeLimitEvidence` from readings already read (`readPreparedProbeAccountReadings`), for a reader
 * that needs the samples and refusals but not the revision stamp, which costs two more history reads.
 */
export function probeLimitEvidenceOf(sqlite: Database, provider: string, account: string, resolver: AccountResolver,
  rows: readonly Record<string, unknown>[]): ProbeLimitEvidence {
  const samples = probeLimitSamples(rows, provider);
  return { samples: withLimitHits(samples, acceptLimitHits(provider, account, samples, ownedLimitHitRows(sqlite, provider, account, resolver))),
    revision: null };
}

/** Segmentation readings of one counter from limit samples (accepted refusals included). */
export function counterReadings(samples: readonly ProbeLimitSample[], account: string, counter: string,
  cycles: CyclesConfig): ProbeLimitReading[] {
  return samples.filter(sample => sample.resets_at && probeLimitCounter(sample, account, cycles) === counter
    && sample.used_percent != null).map(sample => ({ ts: sample.ts, used_percent: sample.used_percent!,
      resets_at: sample.resets_at!, window_minutes: JSON.parse(counter)[2] as number,
      source: sample.limitHit ? "limit_hit" : "probe", ...(sample.provider === "claude" ? { plan: sample.plan } : {}),
      ...(sample.limitHit ? { limit_hit: { call_id: sample.limitHit.callId } } : {}) }));
}

/** Cadence and counter identity are resolved once, equally for Capacity and the rail. */
export function probeLimitCounter(sample: ProbeLimitSample, account: string, cycles: CyclesConfig): string {
  const adapter = subscriptionAccountingAdapter(sample.provider);
  const measured = sample.window_minutes != null && Number.isFinite(sample.window_minutes) && sample.window_minutes > 0;
  const nominal = measured ? sample.window_minutes! : adapter.defaultMinutes[sample.kind]
    ?? (sample.kind === "weekly_scoped" || sample.kind === "seven_day" ? 10080 : sample.kind === "five_hour" ? 300 : 0);
  const cadence = resolveCadenceForDay(cycles, account, sample.kind, sample.ts, {
    periodHours: nominal > 0 ? nominal / 60 : null, anchorIso: sample.resets_at, source: measured ? "probe" : "default",
  });
  return JSON.stringify([sample.kind, sample.limit_group ?? "", (cadence.periodHours ?? 0) * 60]);
}

/** The counter of Codex's main meter of a length (5 h or weekly), as the window producer stores it. */
export const codexLimitCounter = (minutes: 300 | 10080 | 43200) => JSON.stringify(["codex", "codex", minutes]);
/**
 * Whether stored windows of `counter` are the account's cycles: its main weekly counter (Codex's codex
 * meter, Claude's account-wide weekly_all; for other providers every whole-account weekly counter). Idle
 * secondary meters (Codex gpt-reserve or Spark) and model-scoped ones are not cycles.
 */
export function isCycleCounter(provider: string, counter: string): boolean {
  if (provider === "codex") return counter === codexLimitCounter(10080);
  const [kind, , minutes] = JSON.parse(counter) as [string, string, number];
  if (minutes !== 10080) return false;
  return provider === "claude" ? kind === "weekly_all" : kind !== "weekly_scoped";
}
/** The account's cycles: the distinct starts of its stored windows of cycle counters. */
export function cycleStarts(sqlite: Database, provider: string, account: string): string[] {
  const rows = readLimitWindowStarts(sqlite, provider, account, provider === "codex" ? codexLimitCounter(10080) : undefined);
  return [...new Set(rows.filter(row => isCycleCounter(provider, row.counter)).map(row => row.start))];
}

/** The account-wide weekly Claude segments consumed by Code capacity and the Claude card: stored windows. */
export function claudeWeeklyRegisterWindows(sqlite: Database, account: string): ProbeLimitWindow[] {
  return readLimitWindowsWhere(sqlite, "claude", account, counter => {
    const [kind, , minutes] = JSON.parse(counter) as [string, string, number];
    return kind === "weekly_all" && minutes === 10080;
  }).sort((a, b) => a.start.localeCompare(b.start));
}

export interface ProbeLimitReading {
  ts: string;
  used_percent: number;
  resets_at: string;
  window_minutes: number;
  source?: "probe" | "session" | "manual" | "limit_hit";
  /** Plan reported by this meter, independent of the account's paid billing period. */
  plan?: string | null;
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
  cycle_end_basis: "scheduled" | "reset" | "uncertain";
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

/** Compatibility descriptor for the drop that began this register segment. */
export function probeWindowCounterReset(window: ProbeLimitWindow, windows: readonly ProbeLimitWindow[]): ClaudeCounterReset | null {
  if (!window.startDrop) return null;
  const previous = windows.find(candidate => candidate.counter === window.counter && candidate.end === window.start);
  const lastBefore = previous?.readings.filter(reading => reading.ts < window.start).at(-1);
  return { reset_at: window.reset,
    last_before: { at: lastBefore?.ts ?? window.start, percent: window.startDrop.before },
    first_after: { at: window.start, percent: window.startDrop.after } };
}
const canonicalTime = (value: string): string => /\.\d{4,}Z$/.test(value)
  ? value : new Date(Date.parse(value)).toISOString();
const subtractMinutes = (value: string, minutes: number): string => {
  const shifted = new Date(Date.parse(value) - minutes * 60_000).toISOString();
  const extra = /\.\d{3}(\d+)Z$/.exec(value)?.[1];
  return extra ? shifted.slice(0, -1) + extra + "Z" : shifted;
};

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
    if (!resetChanged && point.source === "session" && last && point.used_percent < last.used_percent) continue;
    const drop = !resetChanged && last && point.used_percent < last.used_percent - 1
      ? { before: last.used_percent, after: point.used_percent } : null;
    if (!prior || resetChanged || drop) {
      const scheduled = subtractMinutes(point.resets_at, point.window_minutes);
      const confirmedReset = resetChanged && (!last || Date.parse(scheduled) >= Date.parse(last.ts));
      const start = drop || !confirmedReset ? point.ts : scheduled;
      if (prior) {
        prior.end = drop ? start : new Date(Math.min(Date.parse(prior.reset), Date.parse(start))).toISOString();
        prior.endDrop = drop;
        prior.cycle_end_basis = drop || !confirmedReset ? "uncertain" : "reset";
      }
      out.push({ id: JSON.stringify([account, counter, start]), account, counter, start,
        end: point.resets_at, reset: point.resets_at, cycle_end_basis: "scheduled", window_minutes: point.window_minutes,
        readings: [], startDrop: drop, endDrop: null, seenReset: resetChanged, lastInput: point });
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

const claudeMeterPlan = (plan: string | null | undefined): string | null => {
  const canonical = canonicalPeriodPlan(plan?.trim().toLowerCase() ?? "");
  return /^(pro|max-5x|max-20x)$/.test(canonical) ? canonical : null;
};

/** A plan switch can select another meter with the very same reset, then resume the first. */
export function segmentClaudeReadings(account: string, counter: string, meter: readonly SegmentInput[],
  periods: readonly DatedPeriod[], state?: SegmenterState): RawSegment[] {
  const index = planPeriodIndex(periods);
  const own = effectiveDatedPeriods(periods).filter(p => p.provider === "claude" && p.subject.toLowerCase() === account.toLowerCase());
  const observedPlans = periods.filter(p => p.provider === "claude" && p.subject.toLowerCase() === account.toLowerCase()
    && p.origin === "observed" && claudeMeterPlan(p.value)).sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  const readingKey = (ts: string, percent: number) => `${ts}|${percent}`;
  const rawPlans = new Map(meter.map(row => [readingKey(row.ts, row.used_percent), claudeMeterPlan(row.plan)]));
  const switchAt = (plan: string, previous: string, next: string): string => {
    const bounds = (p: DatedPeriod) => Date.parse(p.from) > Date.parse(previous) && Date.parse(p.from) <= Date.parse(next);
    return own.find(p => p.origin === "declared" && claudeMeterPlan(p.value) === plan && bounds(p))?.from
      ?? observedPlans.find(p => claudeMeterPlan(p.value) === plan && bounds(p))?.from ?? next;
  };
  const withoutUnpaidGaps = (initial: WindowActivity["spans"]): WindowActivity["spans"] => {
    let spans = initial;
    for (const gap of own.filter(p => p.value === "none")) {
      const from = Date.parse(gap.from), until = gap.until ? Date.parse(gap.until) : Infinity;
      spans = spans.flatMap(span => {
        const start = Date.parse(span.start), end = Date.parse(span.end);
        if (end <= from || start >= until) return [span];
        return [...(start < from ? [{ start: span.start, end: new Date(from).toISOString() }] : []),
          ...(end > until ? [{ start: new Date(until).toISOString(), end: span.end }] : [])];
      });
    }
    return spans;
  };
  const rows: SegmentInput[] = [];
  for (const row of meter) {
    const previous = rows.findLast(prior => sameReset(prior.resets_at, row.resets_at));
    const declaredSwitch = previous && own.some(p => p.origin === "declared" && p.value !== "none"
      && Date.parse(p.from) > Date.parse(previous.ts) && Date.parse(p.from) <= Date.parse(row.ts));
    const plan = claudeMeterPlan(row.plan) ?? (!declaredSwitch ? previous?.plan : null)
      ?? claudeMeterPlan(index?.resolve("claude", account, row.ts).value);
    rows.push({ ...row, plan });
  }
  const resolvedPlans = new Map(rows.map(row => [readingKey(row.ts, row.used_percent), row.plan]));
  let result = segmentReadings(account, counter, meter, state);
  const key = (ts: string, percent: number, source: string) => JSON.stringify([ts, percent, source]);
  const accepted = new Set(result.flatMap(window => window.readings.map(row => key(row.ts, row.percent, row.source))));
  const resets: SegmentInput[][] = [];
  for (const row of rows.filter(row => accepted.has(key(row.ts, row.used_percent, row.source ?? "probe")))) {
    const group = resets.find(group => sameReset(group[0]!.resets_at, row.resets_at));
    if (group) group.push(row); else resets.push([row]);
  }
  for (const group of resets) {
    const plans = [...new Set(group.flatMap(row => row.plan ? [row.plan] : []))];
    if (plans.length < 2) continue;
    const directPlans = new Set(group.flatMap(row => {
      const plan = rawPlans.get(readingKey(row.ts, row.used_percent));
      return plan ? [plan] : [];
    }));
    if (directPlans.size < 2) continue;
    // Unknown readings do not establish a switch. They remain with the last known meter.
    let lastPlan: string | null = null;
    const assigned = group.map(row => { lastPlan = row.plan ?? lastPlan; return { ...row, plan: lastPlan }; });
    const runs: Array<{ plan: string; start: string; end: string }> = [];
    for (let i = 0; i < assigned.length; i++) {
      const row = assigned[i]!;
      if (!row.plan || runs.at(-1)?.plan === row.plan) continue;
      const previous = assigned[i - 1];
      const start = previous ? switchAt(row.plan, previous.ts, row.ts) : subtractMinutes(row.resets_at, row.window_minutes);
      if (runs.length) runs.at(-1)!.end = canonicalTime(start);
      runs.push({ plan: row.plan, start: canonicalTime(start), end: canonicalTime(row.resets_at) });
    }
    const original = result.filter(window => sameReset(window.reset, group[0]!.resets_at));
    result = result.filter(window => !sameReset(window.reset, group[0]!.resets_at));
    for (const plan of plans) {
      const selected = assigned.filter(row => row.plan === plan);
      const segments = segmentReadings(account, counter, selected);
      for (const segment of segments) {
        if (segment === segments[0] && plan === assigned.find(row => row.plan)?.plan && original[0]) {
          segment.start = original[0].start;
          segment.startDrop = original[0].startDrop;
        }
        let spans = runs.filter(run => run.plan === plan).map(run => ({
          start: new Date(Math.max(Date.parse(run.start), Date.parse(segment.start))).toISOString(),
          end: new Date(Math.min(Date.parse(run.end), Date.parse(segment.end))).toISOString(),
        })).filter(span => span.start < span.end);
        // A declared unpaid gap is not traffic of either paid meter.
        spans = withoutUnpaidGaps(spans);
        if (!spans.length) continue;
        segment.start = spans[0]!.start;
        segment.id = JSON.stringify([account, counter, segment.start]);
        segment.activity = { plan, spans };
        result.push(segment);
      }
    }
  }
  for (const window of result) {
    if (window.activity) continue;
    const plans = [...new Set(window.readings.flatMap(row => {
      const plan = claudeMeterPlan(row.plan) ?? resolvedPlans.get(readingKey(row.ts, row.percent));
      return plan ? [plan] : [];
    }))];
    if (plans.length !== 1) continue;
    const initial = [{ start: window.start, end: window.end }];
    // Direct meter readings can supersede a lagging account-plan projection.
    const changes = observedPlans.map((period, i) => ({ plan: claudeMeterPlan(period.value)!, priority: 0,
      at: Date.parse(switchAt(claudeMeterPlan(period.value)!, observedPlans[i - 1]?.lastSeen ?? observedPlans[i - 1]?.from ?? window.start, period.from)) }));
    changes.push(...window.readings.flatMap(row => claudeMeterPlan(row.plan)
      ? [{ plan: claudeMeterPlan(row.plan)!, priority: 1, at: Date.parse(row.ts) }] : []));
    changes.sort((a, b) => a.at - b.at || a.priority - b.priority);
    let selected = plans[0]!, cursor = Date.parse(window.start);
    const end = Date.parse(window.end), selectedSpans: WindowActivity["spans"] = [];
    for (const change of changes) {
      if (change.at >= end) break;
      if (change.at <= cursor) { selected = change.plan; continue; }
      if (change.plan === selected) continue;
      if (selected === plans[0]) selectedSpans.push({ start: new Date(cursor).toISOString(), end: new Date(change.at).toISOString() });
      cursor = change.at; selected = change.plan;
    }
    if (selected === plans[0]) selectedSpans.push({ start: new Date(cursor).toISOString(), end: window.end });
    const spans = withoutUnpaidGaps(selectedSpans);
    const witnessed = observedPlans.some(period => claudeMeterPlan(period.value) === plans[0]
      && Date.parse(period.from) <= Date.parse(window.lastInput.ts)
      && (!period.until || Date.parse(period.until) > Date.parse(window.lastInput.ts)));
    const dated = probeWindowPlan(index, own, "claude", account, window.start, window.end).plan;
    if (JSON.stringify(spans) !== JSON.stringify(initial) || witnessed && dated !== plans[0])
      window.activity = { plan: plans[0]!, spans };
  }
  return result.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** Plan periods and manual measurements that resolve a register's segments into windows. */
export interface WindowResolution {
  provider: string; account: string; counter: string;
  index: PeriodIndex | null; periods: readonly DatedPeriod[]; measurements: readonly ManualCapacityMeasurement[];
}
export function windowResolution(provider: string, account: string, counter: string, periods: readonly DatedPeriod[],
  measurements: readonly ManualCapacityMeasurement[] = []): WindowResolution {
  return { provider, account, counter, index: planPeriodIndex(periods),
    periods: effectiveDatedPeriods(periods).filter(p => p.provider === provider && p.subject.toLowerCase() === account.toLowerCase()),
    measurements: measurements.filter(m => m.account.toLowerCase() === account.toLowerCase() && m.counter === counter) };
}

type SegmentShape = Omit<RawSegment, "seenReset" | "lastInput">;
/** Dated plan and the manual readings of measurements wholly inside the segment. */
export function resolveSegment(segment: SegmentShape, resolution: WindowResolution): ProbeLimitWindow {
  const { provider, account } = resolution;
  const startMs = Date.parse(segment.start), endMs = Date.parse(segment.end);
  const manual = resolution.measurements.filter(m => Date.parse(m.start) >= startMs && Date.parse(m.end) <= endMs
    && (!segment.activity || segment.activity.spans.some(span => Date.parse(m.start) >= Date.parse(span.start)
      && Date.parse(m.end) <= Date.parse(span.end))));
  const readings = [...segment.readings, ...manual.flatMap(m => [
    { ts: canonicalTime(m.start), percent: m.start_percent, source: "manual" as const },
    { ts: canonicalTime(m.end), percent: m.end_percent, source: "manual" as const },
  ])].sort((a, b) => a.ts.localeCompare(b.ts));
  const manualMeta = manual.map(m => ({ id: m.id, approximate_time: m.approximate_time, note: m.note }));
  // A paid period cannot rename a parallel Free meter. Keep billing declarations intact;
  // resolve this register from the plans its accepted readings actually report.
  const meterPlans = provider === "codex" ? [...new Set(segment.readings.flatMap(reading =>
    reading.plan?.trim() ? [reading.plan.trim().toLowerCase()] : []))] : [];
  const plan = segment.activity ? { plan: segment.activity.plan, plan_detail: null, declared_plan_meter_mismatch: false }
    : meterPlans.length ? { plan: meterPlans.length === 1 ? meterPlans[0]! : null,
    plan_detail: meterPlans.length > 1 ? { label: meterPlans.join(" → "), multiplier: null, status: "mixed" as const } : null,
    declared_plan_meter_mismatch: meterPlans.length > 1 }
    : probeWindowPlan(resolution.index, resolution.periods, provider, account, segment.start, segment.end);
  return { id: segment.id, account: segment.account, counter: segment.counter, start: segment.start, end: segment.end,
    reset: segment.reset, cycle_end_basis: segment.cycle_end_basis, window_minutes: segment.window_minutes, readings,
    startDrop: segment.startDrop, endDrop: segment.endDrop,
    ...(segment.activity ? { activity: segment.activity } : {}),
    ...plan,
    ...(manual.length ? { manual_measurement: manualMeta[0]!, manual_measurements: manualMeta } : {}) };
}

/**
 * One account/counter register. Its segment ids and boundaries never depend on a view's date range.
 * This is the reference definition; screens read its stored result (`limit_windows`), which the
 * maintenance worker keeps equal to it incrementally.
 */
export function buildProbeLimitWindows(input: {
  provider: string; account: string; counter: string;
  readings: readonly ProbeLimitReading[]; periods: readonly DatedPeriod[];
  measurements?: readonly ManualCapacityMeasurement[];
}): ProbeLimitWindow[] {
  const resolution = windowResolution(input.provider, input.account, input.counter, input.periods, input.measurements);
  const meter = segmentationInputs(input.readings);
  return (input.provider === "claude" ? segmentClaudeReadings(input.account, input.counter, meter, input.periods)
    : segmentReadings(input.account, input.counter, meter))
    .map(({ seenReset: _seen, lastInput: _last, ...segment }) => resolveSegment(segment, resolution));
}
