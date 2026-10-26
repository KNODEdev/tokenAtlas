import { canonicalTime, sameReset, segmentationInputs, type ProbeLimitReading, type ProbeLimitWindow, type RawSegment } from "./limit-window-segments";
import { probeWindowPlan } from "./window-plan-periods";
import { segmentLimitReadings } from "./window-lifecycle";
export { RESET_JOIN_MS, segmentReadings, segmentationInputs, type ProbeLimitReading, type ProbeLimitWindow,
  type RawSegment, type SegmentInput, type SegmenterState } from "./limit-window-segments";
export { probeWindowPlan } from "./window-plan-periods";
export { segmentLimitReadings } from "./window-lifecycle";
import type { Database } from "bun:sqlite";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import { effectiveDatedPeriods, planPeriodIndex, type DatedPeriod, type PeriodIndex } from "./account-periods";
import { claudeEventOwnedBySql } from "./claude-event-account";
import type { AccountResolver } from "./account-resolver";
import { readPreparedProbeAccountHistory, readPreparedProbeAccountingRevision, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { probeAccountingTime } from "./current/probe-accounting-time";
import { resolveCadenceForDay, type CyclesConfig } from "./cycles";
import { addLimitHitReadings, type LimitHit, type RailGroup, type RailSample } from "./rail-readings";
import { subscriptionAccountingAdapter, limitHitTableOf } from "./subscription-accounting-adapters";
import type { ClaudeCounterReset } from "../shared/claude-code-capacity";
import { readLimitWindowStarts, readLimitWindowsWhere } from "../db/limit-windows";

export interface ProbeLimitSample extends RailSample {
  provider: string; subject: string; plan: string | null;
  allowance: number | null; used: number | null; remaining: number | null; ok: number | null;
}
export interface ProbeLimitEvidence {
  samples: ProbeLimitSample[];
  /** Account-wide prepared revisions plus owned limit hits, independent of a screen's date range. */
  revision: unknown;
}

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
      source: sample.limitHit ? "limit_hit" : "probe", ...(sample.plan ? { plan: sample.plan } : {}),
      ...(sample.allowance != null ? { allowance: sample.allowance } : {}), ...(sample.used != null ? { used: sample.used } : {}),
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

/** Compatibility descriptor for the drop that began this register segment. */
export function probeWindowCounterReset(window: ProbeLimitWindow, windows: readonly ProbeLimitWindow[]): ClaudeCounterReset | null {
  if (!window.startDrop) return null;
  const previous = windows.find(candidate => candidate.counter === window.counter && candidate.end === window.start);
  const lastBefore = previous?.readings.filter(reading => reading.ts < window.start).at(-1);
  return { reset_at: window.reset,
    last_before: { at: lastBefore?.ts ?? window.start, percent: window.startDrop.before },
    first_after: { at: window.start, percent: window.startDrop.after } };
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
  const plan = segment.activity?.plan != null ? { plan: segment.activity.plan, plan_detail: null, declared_plan_meter_mismatch: false }
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
  return segmentLimitReadings(input.provider, input.account, input.counter, meter, input.periods)
    .map(({ seenReset: _seen, lastInput: _last, ...segment }) => resolveSegment(segment, resolution));
}
