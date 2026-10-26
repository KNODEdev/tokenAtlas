import type { AccountResolver, IdentityDeclaration } from "./account-resolver";
/**
 * The one shared Claude Code usage-share estimate (plan section 3.2.1, P4/P5).
 *
 * Subscription accounting, the Claude limit report and capacity equivalents all call
 * `buildClaudeCodeCapacityReport`; none of them recomputes the proportion itself.
 *
 * Numeric traffic sums are the running totals the window producer stores at every reading
 * of a weekly window (`window_usage`, plan U1.4): canonical ledger events, product classes
 * and stored Standard valuations. A new share or utilization reading over the same
 * boundaries reads zero events and revalues nothing. Observations come from the probe
 * journal and are deliberately *not* a dependency of the traffic sums.
 */
import type { Database } from "bun:sqlite";
import { windowActiveAt } from "../shared/window-activity";
import { readWindowSums } from "./window-usage-read";
import { type ProductTotals, type WindowReadingSums } from "./window-usage-contracts";
import { ProbeAccountIndexUnavailable, readPreparedProbeAccountHistory, readPreparedProbeAccountRange, readingsByObservation,
  type ProbeAccountReadings } from "./current/probe-account-reader";
import {
  CLAUDE_CODE_SHARE_EXTRA, CLAUDE_CODE_SHARE_KEY, CLAUDE_CODE_SHARE_SCHEMA,
  claudeCodeProductShareFromExtra, claudeProductBreakdownFromExtra, sameResetWindow, RESET_TOLERANCE_MS,
} from "../providers/adapters/claude";
import {
  CLAUDE_CODE_ASSUMPTIONS, CLAUDE_CODE_CAPACITY_ALGORITHM, CLAUDE_CODE_PRODUCT_RULE,
  cumulativeClaudeCodeEstimate, intervalClaudeCodeCapacity, unavailable,
  type ClaudeCodeCapacitySummary, type ClaudeCodeCoverage, type ClaudeCodeEstimate, type ClaudeCounterReset,
  type ClaudeCodeObservedUsage, type ClaudeCodeUnavailableReason, type ClaudeProductRow, shareOnlyProductRows,
} from "../shared/claude-code-capacity";
import type { EraIndex } from "./eras";
import type { RateCard } from "./pricing";
import { probeLimitSamples, claudeWeeklyRegisterWindows, probeLimitCounter, probeWindowCounterReset,
  type ProbeLimitEvidence, type ProbeLimitWindow } from "./probe-limit-windows";
import type { DatedPeriod } from "./account-periods";
import type { CyclesConfig } from "./cycles";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import { firstSaturatedReading } from "../shared/capacity-cycle";
import type { ClaudeCapacityModelUsage } from "../shared/claude-capacity-result";

const DAY_MS = 86_400_000;
/** Timestamps are stored with millisecond resolution, so this makes an inclusive end exact. */
const MS = 1;
const nextInstant = (iso: string) => new Date(Date.parse(iso) + MS).toISOString();

export interface ClaudeCodeCapacityContext {
  rateCards: RateCard;
  eras?: EraIndex; resolver?: AccountResolver; declarations?: readonly IdentityDeclaration[];
  cycles?: CyclesConfig; planPeriods?: readonly DatedPeriod[]; manualCapacity?: readonly ManualCapacityMeasurement[];
  probeEvidence?: ProbeLimitEvidence; probeWindows?: readonly ProbeLimitWindow[];
  /** The account's readings already read once (`readPreparedProbeAccountReadings`): observations come from them. */
  probeReadings?: ProbeAccountReadings;
}
export interface ClaudeCodeCapacityOptions {
  since?: string;
  until?: string;
  untilExclusive?: string;
  now?: string;
  windowId?: string;
}

/**
 * One weekly account observation. `collected_at` is our probe row; `as_of` is the
 * vendor's own time. A scoped, model or session counter never reaches this list, so it
 * can never donate a timestamp or a share.
 */
export interface ClaudeCodeObservation {
  account: string;
  counter: "weekly_all";
  window_id: string | null;
  collected_at: string;
  as_of: string | null;
  window_started_at: string | null;
  reset_at: string | null;
  utilization_percent: number | null;
  share_percent: number | null;
  share_schema: number | null;
  share_key: string | null;
  /** Surface rows read together with the share; they travel with it and never alone. */
  product_rows: ClaudeProductRow[] | null;
  copies: number;
  conflict: null | "utilization" | "reset" | "share" | "multiple";
  usable: boolean;
  reason: ClaudeCodeUnavailableReason | null;
}

/** Cumulative snapshot: everything from the window start through `as_of`, inclusive. */
export interface ClaudeCodeCumulativeSample {
  models?: ClaudeCapacityModelUsage[];
  kind: "cumulative";
  window_id: string;
  observation: ClaudeCodeObservation;
  from: string;
  through: string;
  usage: ClaudeCodeObservedUsage;
  coverage: ClaudeCodeCoverage;
  account_total_tokens: ClaudeCodeEstimate;
  weekly_capacity_tokens: ClaudeCodeEstimate;
  account_total_api_usd: ClaudeCodeEstimate;
  weekly_capacity_api_usd: ClaudeCodeEstimate;
}
/** Interval between two compatible readings: exclusive start, inclusive end. */
export interface ClaudeCodeIntervalSample {
  models?: ClaudeCapacityModelUsage[];
  kind: "interval";
  window_id: string;
  first: ClaudeCodeObservation;
  second: ClaudeCodeObservation;
  after: string;
  through: string;
  usage: ClaudeCodeObservedUsage;
  coverage: ClaudeCodeCoverage;
  delta_product_percent: number | null;
  delta_floor_percent: number | null;
  weekly_capacity_tokens: ClaudeCodeEstimate;
  weekly_capacity_api_usd: ClaudeCodeEstimate;
}
export type ClaudeCodeSample = ClaudeCodeCumulativeSample | ClaudeCodeIntervalSample;

export interface ClaudeCodeCapacityReport {
  schema_version: 1;
  algorithm: number;
  api_value_basis: "standard";
  account: string;
  counter: "weekly_all";
  rule: string;
  observations: ClaudeCodeObservation[];
  samples: ClaudeCodeSample[];
  /** The one sample every consumer must quote; `null` with a reason when none qualifies. */
  selected: ClaudeCodeSample | null;
  reason: ClaudeCodeUnavailableReason | null;
  coverage: ClaudeCodeCoverage;
  /** Conditional, never written back into facts. */
  weekly_capacity_tokens: ClaudeCodeEstimate;
  weekly_capacity_api_usd: ClaudeCodeEstimate;
  account_total_tokens: ClaudeCodeEstimate;
  account_total_api_usd: ClaudeCodeEstimate;
  /** Actual measured Code traffic of the selected source interval; not an estimate. */
  observed: ClaudeCodeObservedUsage | null;
  /** Every in-window meter drop among the observations, oldest first. */
  counter_resets: ClaudeCounterReset[];
}

export type { ClaudeCodeCapacitySummary } from "../shared/claude-code-capacity";

export function claudeCodeCapacitySummary(report: ClaudeCodeCapacityReport): ClaudeCodeCapacitySummary {
  const selected = report.selected;
  const observation = selected == null ? report.observations.at(-1) ?? null : selected.kind === "cumulative" ? selected.observation : selected.second;
  return {
    algorithm: report.algorithm, rule: report.rule, account: report.account,
    window_id: selected?.window_id ?? observation?.window_id ?? null,
    api_value_basis: "standard",
    basis: selected?.kind ?? null,
    source_from: selected == null ? null : selected.kind === "cumulative" ? selected.from : selected.after,
    source_through: selected?.through ?? null,
    sample_meter: selected && observation ? {
      start_percent: selected.kind === "interval" ? selected.first.utilization_percent! : 0,
      end_percent: observation.utilization_percent!,
      observed_pp: observation.utilization_percent! - (selected.kind === "interval" ? selected.first.utilization_percent! : 0),
    } : null,
    as_of: observation?.as_of ?? null,
    meter_read_at: observation ? observedAt(observation) : null,
    reset_at: observation?.reset_at ?? null,
    window_started_at: observation?.window_started_at ?? null,
    share_percent: observation?.share_percent ?? null,
    utilization_percent: observation?.utilization_percent ?? null,
    conditional: true,
    reason: report.reason,
    weekly_capacity_tokens: report.weekly_capacity_tokens,
    weekly_capacity_api_usd: report.weekly_capacity_api_usd,
    account_total_tokens: report.account_total_tokens,
    account_total_api_usd: report.account_total_api_usd,
    observed_code_tokens: report.observed?.code_tokens ?? null,
    observed_code_api_usd: report.observed?.code_api_usd ?? null,
    observed_models: selected?.models ?? [],
    ...(report.observed?.code_api_priced_subtotal !== undefined
      ? { observed_code_api_usd_subtotal: report.observed.code_api_priced_subtotal } : {}),
    product_rows: observation?.product_rows ?? null,
    coverage: report.coverage,
    counter_reset: observation?.reset_at == null ? null : report.counter_resets
      .filter(reset => sameResetWindow(reset.reset_at, observation.reset_at)
        && compareInstant(reset.first_after.at, observation.as_of ?? observation.collected_at) <= 0).at(-1) ?? null,
  };
}

type ProbeRow = { ts: string; used_percent: number | null; resets_at: string | null; extra: string | null };
function instant(value: unknown): string | null {
  if (typeof value!=="string" || !Number.isFinite(Date.parse(value))) return null;
  const utc=new Date(value).toISOString();
  // Keep vendor sub-millisecond evidence even though local events have millisecond resolution.
  const fraction=value.match(/T\d{2}:\d{2}:\d{2}\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i)?.[1] ?? "";
  const remainder=fraction.slice(3).replace(/0+$/,"");
  return remainder ? utc.slice(0,-1)+remainder+"Z" : utc;
}
function compareInstant(left:string,right:string):number {
  const a=instant(left),b=instant(right);
  if(!a||!b)return left.localeCompare(right);
  const milliseconds=Date.parse(a)-Date.parse(b);
  if(milliseconds)return milliseconds;
  const af=a.split(".")[1]!.slice(0,-1),bf=b.split(".")[1]!.slice(0,-1),width=Math.max(af.length,bf.length);
  return af.padEnd(width,"0").localeCompare(bf.padEnd(width,"0"));
}
/** Breakdown rows of the same vendor reading as the share (same `as_of`), else none. */
function breakdownRows(extra: Record<string, unknown>, asOf: string): ClaudeProductRow[] | null {
  const breakdown = claudeProductBreakdownFromExtra(extra as Record<string, string | number | boolean | null>);
  return breakdown && compareInstant(breakdown.as_of, asOf) === 0 ? breakdown.rows : null;
}
function rawShare(extra: string | null): Record<string, unknown> {
  if (!extra) return {};
  try { const value: unknown = JSON.parse(extra); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}

/**
 * Account-wide weekly readings only. Copies of the same vendor reading must agree on
 * utilization, reset *and* share metadata; a genuine zero share stays a zero, and an
 * absent one stays absent.
 */
export function readClaudeCodeObservations(sqlite: Database, account: string,
  options: Pick<ClaudeCodeCapacityOptions,"since"|"until"|"untilExclusive"> = {}, readings?: ProbeAccountReadings): ClaudeCodeObservation[] {
  const until = options.until && /^\d{4}-\d{2}-\d{2}$/.test(options.until)
    ? `${options.until}T23:59:59.999Z` : options.until;
  const upper = [until, options.untilExclusive].filter((value): value is string =>
    !!value && Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  const lower = options.since && Number.isFinite(Date.parse(options.since)) ? options.since : null;
  const prepared = readings ? readingsByObservation(readings, lower, upper)
    : readPreparedProbeAccountRange(sqlite, "claude", account, lower, upper, 20_000, "claude-observation");
  if (!prepared) throw new ProbeAccountIndexUnavailable();
  // Preserve the original collection-order choice of the representative copy.
  const rows = (prepared.rows as unknown as ProbeRow[]).sort((a, b) => a.ts.localeCompare(b.ts));
  // Copies of one vendor reading share its `as_of`; rows without share metadata can only
  // be identified by their own collection time and never donate a timestamp or a share.
  // Each reading's metadata is parsed once; an unreadable or absent one reads as no fields, as before.
  const parsed = new Map<ProbeRow, Record<string, unknown>>();
  const fieldsOf = (row: ProbeRow) => { let fields = parsed.get(row); if (!fields) parsed.set(row, fields = rawShare(row.extra)); return fields; };
  const shareOf = (row: ProbeRow) => claudeCodeProductShareFromExtra(fieldsOf(row) as Record<string, string | number | boolean | null>);
  const groups = new Map<string, ProbeRow[]>();
  for (const row of rows) {
    const asOf = instant(fieldsOf(row)[CLAUDE_CODE_SHARE_EXTRA.asOf]);
    const key = asOf ? `as_of:${asOf}` : `ts:${row.ts}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const observations: ClaudeCodeObservation[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0]!;
    const share = shareOf(first);
    const evidence = (value: ReturnType<typeof claudeCodeProductShareFromExtra>) => value == null ? null
      : [value.schema,value.key,value.percent,instant(value.as_of),instant(value.window_started_at)];
    const fields = fieldsOf(first);
    const asOf = instant(fields[CLAUDE_CODE_SHARE_EXTRA.asOf]);
    const windowStart = instant(fields[CLAUDE_CODE_SHARE_EXTRA.windowStartedAt]);
    const reset = instant(first.resets_at);
    const conflicts = new Set<"utilization" | "reset" | "share">();
    for (const row of bucket.slice(1)) {
      if (row.used_percent !== first.used_percent) conflicts.add("utilization");
      if (instant(row.resets_at) !== reset) conflicts.add("reset");
      const other = shareOf(row);
      // Comparing share metadata, not only utilization and reset: two copies that differ
      // only in the product share are still incompatible evidence.
      if (JSON.stringify(evidence(other)) !== JSON.stringify(evidence(share))) conflicts.add("share");
    }
    const conflict = conflicts.size === 0 ? null : conflicts.size > 1 ? "multiple" : [...conflicts][0]!;
    const utilization = typeof first.used_percent === "number" && Number.isFinite(first.used_percent) ? first.used_percent : null;
    const reason: ClaudeCodeUnavailableReason | null = conflict ? "observation_conflict"
      : share == null ? (Object.keys(fields).some(key => key.startsWith("claude.share.")) ? "share_invalid" : "share_absent")
      : utilization == null ? "utilization_absent"
      : !asOf || !windowStart || !reset || Date.parse(reset)-Date.parse(windowStart)!==7*DAY_MS
        || reset.split(".")[1]!==windowStart.split(".")[1]
        || compareInstant(asOf,windowStart)<0 || compareInstant(asOf,reset)>=0 ? "window_mismatch"
      : share.percent===0 ? "share_zero"
      : utilization<=0 || utilization>100 ? "utilization_nonpositive"
      : null;
    const effective = asOf ?? instant(first.ts);
    if (effective && (options.since && compareInstant(effective,options.since)<0
      || until && compareInstant(effective,until)>0
      || options.untilExclusive && compareInstant(effective,options.untilExclusive)>=0)) continue;
    observations.push({
      account, counter: "weekly_all",
      window_id: null,
      collected_at: first.ts,
      as_of: asOf,
      window_started_at: windowStart,
      reset_at: reset,
      utilization_percent: utilization,
      share_percent: share?.percent ?? null,
      share_schema: share ? CLAUDE_CODE_SHARE_SCHEMA : null,
      share_key: share ? CLAUDE_CODE_SHARE_KEY : null,
      product_rows: share ? breakdownRows(fieldsOf(first), share.as_of) ?? shareOnlyProductRows(share.percent) : null,
      copies: bucket.length,
      conflict,
      usable: reason == null,
      reason,
    });
  }
  return observations.sort((a, b) => compareInstant(a.as_of ?? a.collected_at,b.as_of ?? b.collected_at)
    || a.collected_at.localeCompare(b.collected_at));
}

type Totals = ClaudeCodeObservedUsage & { code_api_complete: boolean; coverage: Omit<ClaudeCodeCoverage, "product_rule" | "cross_machine" | "complete_from_window_start" | "assumptions"> };

const emptyTotals = (): Totals => ({
  code_tokens: 0, code_events: 0, code_api_usd: 0, code_api_complete: true,
  account_tokens: 0, account_events: 0,
  coverage: { code_events: 0, other_product_events: 0, unknown_events: 0, conflicting_product_events: 0,
    duplicate_copies: 0, conflicting_usage_identities: 0 },
});

/**
 * Running totals of the counted traffic of a stored weekly window at one of its readings (plan U1.4):
 * everything from the window start through the reading, inclusive, as `window_usage` stores it. Null
 * when the instant is not a reading of the stored window.
 */
type Running = { products: ProductTotals; events: number; tokens: number };
/** The last reading of a window at each instant, built once per window's readings. */
const readingsByInstant = new WeakMap<readonly WindowReadingSums[], Map<number, WindowReadingSums>>();
function runningAt(readings: readonly WindowReadingSums[], at: string): Running | null {
  let byInstant = readingsByInstant.get(readings);
  if (!byInstant) {
    byInstant = new Map();
    for (const candidate of readings) {
      const instant = Date.parse(candidate.ts);
      if (Number.isFinite(instant)) byInstant.set(instant, candidate);
    }
    readingsByInstant.set(readings, byInstant);
  }
  const reading = byInstant.get(Date.parse(at));
  return reading?.products ? { products: reading.products, events: reading.usage.events, tokens: reading.usage.tokens } : null;
}
/** The report's totals of a running total, or null when they are not exact. */
function totalsOf({ products, events, tokens }: Running): Totals | null {
  const totals: Totals = {
    code_tokens: products.code_tokens, code_events: products.code_events, code_api_usd: products.code_api_usd,
    code_api_complete: products.code_unpriced_events === 0, account_tokens: tokens, account_events: events,
    coverage: { code_events: products.code_events, other_product_events: products.other_product_events,
      unknown_events: products.unknown_events, conflicting_product_events: products.conflicting_product_events,
      duplicate_copies: products.duplicate_copies, conflicting_usage_identities: products.conflicting_usage_identities },
  };
  return Number.isSafeInteger(totals.code_tokens) && Number.isSafeInteger(totals.account_tokens) && Number.isFinite(totals.code_api_usd)
    ? totals : null;
}
type TotalsOrReason = Totals | "window_mismatch" | "unsafe_total";
/** Through `at`, from the window start. */
function totalsThrough(readings: readonly WindowReadingSums[], at: string): TotalsOrReason {
  const running = runningAt(readings, at);
  return running ? totalsOf(running) ?? "unsafe_total" : "window_mismatch";
}
/** `(after, through]`: the difference of the running totals at two readings of one window. */
function totalsBetween(readings: readonly WindowReadingSums[], after: string, through: string): TotalsOrReason {
  const first = runningAt(readings, after), second = runningAt(readings, through);
  if (!first || !second) return "window_mismatch";
  const products = { ...second.products };
  for (const key of Object.keys(products) as Array<keyof ProductTotals>) products[key] -= first.products[key];
  return totalsOf({ products, events: second.events - first.events, tokens: second.tokens - first.tokens }) ?? "unsafe_total";
}

function coverageOf(totals: Totals, _completeFromWindowStart: boolean): ClaudeCodeCoverage {
  return {
    product_rule: CLAUDE_CODE_PRODUCT_RULE,
    ...totals.coverage,
    cross_machine: "unconfirmed",
    complete_from_window_start: false,
    assumptions: [...CLAUDE_CODE_ASSUMPTIONS],
  };
}
const usageOf = (totals: Totals): ClaudeCodeObservedUsage => ({
  code_tokens: totals.code_tokens, code_events: totals.code_events,
  code_api_usd: totals.code_api_complete ? totals.code_api_usd : null,
  ...(!totals.code_api_complete && totals.code_api_usd !== null ? { code_api_priced_subtotal: totals.code_api_usd } : {}),
  account_tokens: totals.account_tokens, account_events: totals.account_events,
});

function partialApiCapacity(estimate: ClaudeCodeEstimate, usage: ClaudeCodeObservedUsage): ClaudeCodeEstimate {
  return usage.code_api_usd === null && estimate.value !== null ? { ...estimate, relation: "≥" } : estimate;
}
const capacityApiQuantity = (usage: ClaudeCodeObservedUsage): number | null =>
  usage.code_api_usd ?? (usage.code_api_priced_subtotal && usage.code_api_priced_subtotal > 0 ? usage.code_api_priced_subtotal : null);

/** Same account, same counter and the same weekly window on both sides. */
function compatible(first: ClaudeCodeObservation, second: ClaudeCodeObservation): ClaudeCodeUnavailableReason | null {
  if (first.account !== second.account) return "account_mismatch";
  if (first.window_id == null || first.window_id !== second.window_id) return "window_mismatch";
  if (first.reset_at == null || second.reset_at == null || Date.parse(first.reset_at) !== Date.parse(second.reset_at)) return "window_mismatch";
  if (first.as_of == null || second.as_of == null || Date.parse(second.as_of) <= Date.parse(first.as_of)) return "window_mismatch";
  return null;
}

const observedAt = (observation: ClaudeCodeObservation) => observation.as_of ?? observation.collected_at;

/** Preserve the legacy drop descriptor from register evidence, without detecting drops again. */
function registerDrops(windows: readonly ProbeLimitWindow[]): ClaudeCounterReset[] {
  return windows.flatMap(window => probeWindowCounterReset(window, windows) ?? []);
}

/** Match the exact old first-sample/first-window rules without scanning history per observation. */
export function mapClaudeCodeObservationsToWindows(observations: readonly ClaudeCodeObservation[],
  evidence: ProbeLimitEvidence, windows: readonly ProbeLimitWindow[], account: string, cycles: CyclesConfig): ClaudeCodeObservation[] {
  const samplesByInstant = new Map<string, typeof evidence.samples>();
  for (const sample of evidence.samples) {
    if (sample.kind !== "weekly_all" || sample.scope != null || sample.limitHit) continue;
    const key = instant(sample.ts) ?? sample.ts;
    const bucket = samplesByInstant.get(key) ?? [];
    bucket.push(sample);
    samplesByInstant.set(key, bucket);
  }
  type IndexedWindow = { window: ProbeLimitWindow; index: number };
  const byReset = new Map<number, Map<string, IndexedWindow[]>>();
  windows.forEach((window, index) => {
    const reset = Date.parse(window.reset);
    if (!Number.isFinite(reset)) return;
    const counters = byReset.get(reset) ?? new Map<string, IndexedWindow[]>();
    const group = counters.get(window.counter) ?? [];
    group.push({ window, index });
    counters.set(window.counter, group);
    byReset.set(reset, counters);
  });
  for (const counters of byReset.values()) for (const group of counters.values())
    group.sort((a, b) => compareInstant(a.window.start, b.window.start) || b.index - a.index);
  const resets = [...byReset.keys()].sort((a, b) => a - b);
  return observations.map(observation => {
    const at = observedAt(observation), key = instant(at) ?? at;
    const source = samplesByInstant.get(key)?.find(sample => sameResetWindow(sample.resets_at, observation.reset_at));
    const counter = source ? probeLimitCounter(source, account, cycles) : null;
    const reset = observation.reset_at == null ? NaN : Date.parse(observation.reset_at);
    let found: IndexedWindow | null = null;
    if (Number.isFinite(reset)) {
      let lower = 0, upper = resets.length;
      while (lower < upper) {
        const middle = (lower + upper) >>> 1;
        if (resets[middle]! < reset - RESET_TOLERANCE_MS) lower = middle + 1;
        else upper = middle;
      }
      for (let i = lower; i < resets.length && resets[i]! <= reset + RESET_TOLERANCE_MS; i++) {
        const counters = byReset.get(resets[i]!)!;
        for (const [kind, group] of counters) {
          if (counter !== null && kind !== counter) continue;
          let lo = 0, hi = group.length;
          while (lo < hi) {
            const middle = (lo + hi) >>> 1;
            if (compareInstant(group[middle]!.window.start, at) <= 0) lo = middle + 1;
            else hi = middle;
          }
          const candidate = group.slice(0, lo).reverse().find(item => windowActiveAt(item.window, Date.parse(at)));
          if (candidate && compareInstant(at, candidate.window.end) < 0
            && sameResetWindow(candidate.window.reset, observation.reset_at)
            && (found === null || candidate.index < found.index)) found = candidate;
        }
      }
    }
    return { ...observation, window_id: found?.window.id ?? null };
  });
}

export function buildClaudeCodeCapacityReport(sqlite: Database, account: string, ctx: ClaudeCodeCapacityContext,
  options: ClaudeCodeCapacityOptions = {}): ClaudeCodeCapacityReport {
  const normalized = account.toLowerCase();
  const sourceObservations = readClaudeCodeObservations(sqlite, normalized, options, ctx.probeReadings);
  // Mapping only consumes readings at an observation's exact instant and ignores refusals.
  // Read every witness inside those bounds, including copies whose collection time is outside them.
  let evidence = ctx.probeEvidence;
  if (!evidence) {
    const instants = sourceObservations.map(observation => Date.parse(observedAt(observation))).filter(Number.isFinite);
    const lower = instants.length ? Math.min(...instants) : null;
    const upper = instants.length ? Math.max(...instants) + MS : null;
    const rows = lower === null || upper === null ? [] : readPreparedProbeAccountHistory(sqlite, "claude", normalized,
      new Date(lower).toISOString(), new Date(upper).toISOString(), "accounting")?.rows;
    if (!rows) throw new ProbeAccountIndexUnavailable();
    evidence = { samples: probeLimitSamples(rows, "claude"), revision: null };
  }
  const windows = ctx.probeWindows ?? claudeWeeklyRegisterWindows(sqlite, normalized);
  const byId = new Map(windows.map(window => [window.id, window]));
  // Keep all mapping witnesses, but read sums and build samples only for the selected window.
  // Filtering after sample assembly made one window wait for unrelated historical sums.
  const observations = mapClaudeCodeObservationsToWindows(sourceObservations,
    evidence, windows, normalized, ctx.cycles ?? {}).filter(observation =>
      !options.windowId || observation.window_id === options.windowId);
  const anchors = new Map<string, ClaudeCodeObservation>();
  for (const observation of observations) {
    const window = observation.window_id ? byId.get(observation.window_id) : undefined;
    // The register keeps the drop at milliseconds while the vendor's as_of carries microseconds.
    if (window?.startDrop && !anchors.has(window.id) && Date.parse(observedAt(observation)) === Date.parse(window.start))
      anchors.set(window.id, observation);
  }
  const empty = emptyTotals();
  const base: ClaudeCodeCapacityReport = {
    schema_version: 1, algorithm: CLAUDE_CODE_CAPACITY_ALGORITHM, api_value_basis: "standard", account: normalized, counter: "weekly_all",
    rule: CLAUDE_CODE_PRODUCT_RULE, observations, samples: [], selected: null, reason: "no_observation",
    coverage: coverageOf(empty, false),
    weekly_capacity_tokens: unavailable("no_observation"), weekly_capacity_api_usd: unavailable("no_observation"),
    account_total_tokens: unavailable("no_observation"), account_total_api_usd: unavailable("no_observation"),
    observed: null, counter_resets: registerDrops(windows),
  };
  const ceilings = new Map<string, ClaudeCodeObservation>();
  for (const observation of observations) {
    if (observation.window_id && (observation.utilization_percent ?? 0) >= 100 && !ceilings.has(observation.window_id))
      ceilings.set(observation.window_id, observation);
  }
  const usable = observations.filter(observation => observation.usable
    && (!observation.window_id || !ceilings.has(observation.window_id)
      || compareInstant(observedAt(observation), observedAt(ceilings.get(observation.window_id)!)) <= 0));
  if (!usable.length) {
    // A silent newer reading must not hide a contradictory share just because no sample was usable.
    return selectClaudeCodeCapacityReport(base, options);
  }
  const samples: ClaudeCodeSample[] = [];
  // Running totals at the readings of every window an observation names, stored by the window producer.
  const named = [...new Set(usable.flatMap(observation => observation.window_id && byId.has(observation.window_id) ? [observation.window_id] : []))]
    .map(id => byId.get(id)!);
  const readings = new Map<string, WindowReadingSums[]>();
  for (const counter of new Set(named.map(window => window.counter)))
    for (const [id, sums] of readWindowSums(sqlite, "claude", normalized, counter, named.filter(window => window.counter === counter), ["readings"]))
      readings.set(id, sums.readings);
  // Prefixes are built once per window using stored model deltas, without reading individual events.
  const modelPrefixes = new Map<string, Map<number, Map<string, ClaudeCapacityModelUsage>>>();
  function modelsBetween(id: string, through: string, after?: string): ClaudeCapacityModelUsage[] {
    let prefixes = modelPrefixes.get(id);
    if (!prefixes) {
      prefixes = new Map();
      const running = new Map<string, ClaudeCapacityModelUsage>();
      for (const reading of readings.get(id) ?? []) {
        for (const row of reading.spend ?? []) {
          const model = row.model ?? "?", previous = running.get(model);
          running.set(model, { model, events: (previous?.events ?? 0) + row.events,
            tokens: (previous?.tokens ?? 0) + row.tokens, fresh: (previous?.fresh ?? 0) + row.fresh,
            api_standard: (previous?.api_standard ?? 0) + row.standard,
            unpriced_events: (previous?.unpriced_events ?? 0) + row.standard_unpriced });
        }
        prefixes.set(Date.parse(reading.ts), new Map(running));
      }
      modelPrefixes.set(id, prefixes);
    }
    const first = after ? prefixes.get(Date.parse(after)) : null;
    return [...(prefixes.get(Date.parse(through))?.values() ?? [])].map(row => {
      const before = first?.get(row.model);
      return { model: row.model, events: row.events - (before?.events ?? 0), tokens: row.tokens - (before?.tokens ?? 0),
        fresh: row.fresh - (before?.fresh ?? 0), api_standard: row.api_standard - (before?.api_standard ?? 0),
        unpriced_events: row.unpriced_events - (before?.unpriced_events ?? 0) };
    }).filter(row => row.events > 0 || row.tokens > 0);
  }
  for (const observation of usable) {
    const window = observation.window_id ? byId.get(observation.window_id) : null;
    if (!window) { observation.reason = "window_mismatch"; observation.usable = false; continue; }
    const anchor = anchors.get(window.id);
    // The drop reading starts the segment; from the window start it would mix two counters.
    if (anchor === observation) continue;
    const through = observation.as_of!;
    if (anchor && anchor.utilization_percent! > 0) {
      samples.push(...intervalSample(anchor, observation));
      continue;
    }
    // From the window start inclusive, or after a drop to zero from the reading that showed it,
    // through the vendor's own `as_of` inclusive.
    const from = anchor ? nextInstant(window.start) : window.start;
    const totals = anchor ? totalsBetween(readings.get(window.id)!, observedAt(anchor), through) : totalsThrough(readings.get(window.id)!, through);
    if (typeof totals === "string") { observation.reason = totals; observation.usable = false; continue; }
    const usage = usageOf(totals);
    const tokens = cumulativeClaudeCodeEstimate({ quantity: usage.code_tokens,
      sharePercent: observation.share_percent, utilizationPercent: observation.utilization_percent });
    const priced = cumulativeClaudeCodeEstimate({ quantity: capacityApiQuantity(usage),
      sharePercent: observation.share_percent, utilizationPercent: observation.utilization_percent });
    const sample: ClaudeCodeSample = { kind: "cumulative", window_id: window.id, observation, from, through, usage,
      models: modelsBetween(window.id, through, anchor ? observedAt(anchor) : undefined), coverage:coverageOf(totals,false),
      account_total_tokens: usage.code_tokens > 0 ? tokens.account_total : unavailable("no_code_tokens"),
      weekly_capacity_tokens: usage.code_tokens > 0 ? tokens.weekly_capacity : unavailable("no_code_tokens"),
      account_total_api_usd: usage.code_api_usd === null ? unavailable("unpriced") : priced.account_total,
      weekly_capacity_api_usd: partialApiCapacity(priced.weekly_capacity, usage) };
    samples.push(sample);
  }
  function intervalSample(first: ClaudeCodeObservation, second: ClaudeCodeObservation): ClaudeCodeSample[] {
    // Exclusive start, inclusive end: the union with the cumulative window stays exact.
    const after = observedAt(first), through = second.as_of!;
    const stored = readings.get(second.window_id!);
    const totals = stored ? totalsBetween(stored, after, through) : "window_mismatch";
    if (typeof totals === "string") return [];
    const usage = usageOf(totals);
    const tokens = intervalClaudeCodeCapacity({ quantity: usage.code_tokens,
      first: { sharePercent: first.share_percent, utilizationPercent: first.utilization_percent },
      second: { sharePercent: second.share_percent, utilizationPercent: second.utilization_percent } });
    const priced = intervalClaudeCodeCapacity({ quantity: capacityApiQuantity(usage),
      first: { sharePercent: first.share_percent, utilizationPercent: first.utilization_percent },
      second: { sharePercent: second.share_percent, utilizationPercent: second.utilization_percent } });
    return [{ kind: "interval", window_id: second.window_id!, first, second, after, through, usage,
      models: modelsBetween(second.window_id!, through, after), coverage:coverageOf(totals,false),
      delta_product_percent: tokens.delta_product_percent, delta_floor_percent: tokens.delta_floor_percent,
      weekly_capacity_tokens: tokens.weekly_capacity, weekly_capacity_api_usd: partialApiCapacity(priced.weekly_capacity, usage) }];
  }
  for (let index = 1; index < usable.length; index++) {
    const first = usable[index - 1]!, second = usable[index]!;
    if (!first.usable || !second.usable || compatible(first, second)) continue;
    // Two readings on either side of a drop belong to different counters.
    if (first.window_id !== second.window_id) continue;
    // The anchor interval above already measures this pair.
    if (second.window_id && anchors.get(second.window_id) === first) continue;
    samples.push(...intervalSample(first, second));
  }
  return selectClaudeCodeCapacityReport({...base,samples},options);
}

/** Select from prepared samples only; no database access or valuation. */
export function selectClaudeCodeCapacityReport(report: ClaudeCodeCapacityReport,
  options: ClaudeCodeCapacityOptions & {resetAt?:string; windowId?: string} = {}): ClaudeCodeCapacityReport {
  const upper = options.until && /^\d{4}-\d{2}-\d{2}$/.test(options.until) ? `${options.until}T23:59:59.999Z` : options.until;
  const inside = (at:string|null) => at != null && (!options.since || compareInstant(at,options.since)>=0)
    && (!upper || compareInstant(at,upper)<=0)
    && (!options.untilExclusive || compareInstant(at,options.untilExclusive)<0);
  // The vendor reports one week's reset a second either side of the hour (10:59:59 / 11:00:00);
  // like every other reader, a window is matched within the shared reset tolerance.
  const sameReset = (reset: string | null) => !options.resetAt || sameResetWindow(reset, options.resetAt);
  const observations = report.observations.filter(observation=>inside(observation.as_of??observation.collected_at)
    && sameReset(observation.reset_at) && (!options.windowId || observation.window_id === options.windowId));
  const samples = report.samples.filter(sample=>inside(sample.through)
    && (!options.windowId || sample.window_id === options.windowId)
    // A cumulative sample of the matched week starts at its own reset, which may precede the
    // displayed window start by that jitter; the reset match already ties it to the window.
    && (!options.since || (options.resetAt && sample.kind==="cumulative")
      || Date.parse(sample.kind==="cumulative"?sample.from:sample.after)>=Date.parse(options.since))
    && sameReset((sample.kind==="cumulative"?sample.observation:sample.second).reset_at));
  // An interval measures the meter's own movement, so it outranks a cumulative window
  // whose completeness from the window start is never proven. Newest first within a kind.
  const rank = (sample: ClaudeCodeSample) => sample.kind === "interval" ? 0 : 1;
  // A newer reading that carries no share (another machine, older collector) is silent, not a
  // contradiction: it must not hide the latest reading that does carry one.
  const newest = [...observations].reverse().find(observation => observation.reason !== "share_absent") ?? observations.at(-1);
  const timeIssue = options.now && (!instant(options.now)
    || newest?.as_of && Date.parse(newest.as_of)>Date.parse(options.now)
    || newest?.reset_at && Date.parse(newest.reset_at)<=Date.parse(options.now)) ? "window_mismatch" : null;
  let currentIssue = !newest ? "no_observation" : timeIssue ?? newest.reason;
  let ordered = samples.filter(sample=>sample.through===newest?.as_of).sort((a, b) => rank(a) - rank(b));
  if (newest && currentIssue === null && newest.utilization_percent === 100 && newest.window_id) {
    const sameWindow = observations.filter(observation => observation.window_id === newest.window_id
      && sameResetWindow(observation.reset_at, newest.reset_at));
    const ceiling = firstSaturatedReading(sameWindow, observation => observation.utilization_percent);
    const before = ceiling ? sameWindow.filter(observation => compareInstant(observedAt(observation), observedAt(ceiling)) < 0) : [];
    const last = [...before].reverse().find(observation => observation.reason !== "share_absent");
    // The first 100% closes calibration; later flat readings never add traffic or imply credit funding.
    if (ceiling && (ceiling.reason === null || ceiling.reason === "share_absent") && (!last || last.reason === null)) {
      ordered = samples.filter(sample => sample.window_id === newest.window_id
        && sameResetWindow((sample.kind === "cumulative" ? sample.observation : sample.second).reset_at, newest.reset_at)
        && compareInstant(sample.through, observedAt(ceiling)) <= 0)
        .sort((a, b) => compareInstant(b.through, a.through) || rank(a) - rank(b));
      if (!ordered.length) currentIssue = "utilization_saturated";
    } else currentIssue = ceiling?.reason ?? last?.reason ?? "utilization_saturated";
  }
  const selected = currentIssue ? null : ordered.find(sample => sample.weekly_capacity_tokens.value != null)
    ?? ordered.find(sample => sample.kind === "cumulative" && sample.account_total_tokens.value != null) ?? null;
  const reason = currentIssue ?? (selected ? selected.weekly_capacity_tokens.absent
    : ordered[0]?.weekly_capacity_tokens.absent ?? "no_observation");
  const cumulative = selected?.kind === "cumulative" ? selected : null;
  // Coverage describes the selected source interval, so its duplicate, conflict and
  // unknown-product counts are the ones that produced the published numbers.
  const coverage = selected?.coverage ?? coverageOf(emptyTotals(),false);
  return {
    ...report, observations, samples, selected, reason, coverage, observed: selected?.usage ?? null,
    weekly_capacity_tokens: selected?.weekly_capacity_tokens ?? unavailable(reason ?? "no_observation"),
    weekly_capacity_api_usd: selected?.weekly_capacity_api_usd ?? unavailable(reason ?? "no_observation"),
    // An account total is only meaningful for the same cumulative window that was selected.
    account_total_tokens: cumulative?.account_total_tokens ?? unavailable(selected ? "not_cumulative" : reason ?? "no_observation"),
    account_total_api_usd: cumulative?.account_total_api_usd ?? unavailable(selected ? "not_cumulative" : reason ?? "no_observation"),
  };
}

/** Consumers that may run without a prepared index get an explicit unavailable report. */
export function claudeCodeCapacitySummaryOrAbsent(sqlite: Database, account: string,
  ctx: ClaudeCodeCapacityContext | null | undefined, options: ClaudeCodeCapacityOptions = {}): ClaudeCodeCapacitySummary | null {
  if (!ctx) return null;
  return claudeCodeCapacitySummary(buildClaudeCodeCapacityReport(sqlite, account, ctx, options));
}
