import { readClaudeCapacityResult } from "./claude-capacity-result";
import { claudeCapacityResult } from "../shared/claude-capacity-result";
import { assignSourceMachines } from "./source-machines";
import { loadAccountResolver, type AccountResolver, type IdentityDeclaration } from "./account-resolver";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { usageLedgerEventsFor, type LedgerEvent, type StoredPrice } from "../db/usage-ledger-events";
import { buildClaudeCodeCapacityReport, claudeCodeCapacitySummary, selectClaudeCodeCapacityReport } from "./claude-code-capacity";
import { probeAccountingTime } from "./current/probe-accounting-time";
import { analysisHash } from "../db/analysis";
import type { Database } from "bun:sqlite";

import { attachWindowEvidence } from "./subscription-evidence";
import type { AmountCoverage } from "../shared/codex-accounting";
import { SELECT_ONE_SUBSCRIPTION, type SubscriptionAccountingOptions, type SubscriptionAccountingReport, type SubscriptionModelDetail } from "../shared/subscription-accounting";
import type { RateCard } from "./pricing";
import type { EraIndex } from "./eras";
import type { PlansConfig } from "./plans";
import { planPeriodIndex, planPeriodsShape, type DatedPeriod, type PeriodIndex } from "./account-periods";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import type { PlansCatalog } from "./plans-catalog";
import type { CodexProbe } from "./codex-calibration";
import { resolveCadenceForDay, type CyclesConfig, type CadenceSource } from "./cycles";
import { accountingOptions } from "./codex-accounting";
import { capacityContext } from "./codex-capacity-context";
import { cyclePromotion } from "./codex-promotions";
import { compareManualMeterInterval } from "./subscription-window-comparison";
import { comparisonWindow } from "./window-usage-presentation";
import { intervalSumsFromLedgers, windowSumsFromLedgers } from "./window-usage-ledger-sums";
import { readSpanSums, readWindowSums, WindowUsagePreparing } from "./window-usage-read";
import { referenceFingerprint } from "./window-usage-reference";
import { subscriptionWindowTraffic } from "./window-usage-traffic";
import { windowEventReader } from "./window-usage-events";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { claudeWeeklyRegisterWindows, loadProbeLimitEvidence, probeLimitCounter,
  type ProbeLimitEvidence } from "./probe-limit-windows";
import { readLimitWindows } from "../db/limit-windows";
import { readManualCapacity } from "./manual-capacity";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import { parseCapacityCounter } from "../shared/manual-capacity";
import { TOKEN_BUCKETS, subscriptionAccountingAdapter, priceSubscriptionEvent, type SubscriptionEvent, type SubscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import { readSubscriptionUsagePriceDays, subscriptionUsagePriceReadiness,
  sumUsagePriceAmounts, USAGE_PRICE_SUBJECT_PROVIDERS,
  type UsagePriceAmount, type UsagePriceDay } from "../db/usage-price-read-subscription";
import { preparedProbeAccountIndexReady, readPreparedProbeAccountCatalogue, readPreparedProbeAccountRange,
  ProbeAccountIndexUnavailable, ProbeAccountReadLimitExceeded } from "./current/probe-account-reader";

interface Context {
  accounts?: { subscriptions?: IdentityDeclaration[] };
  sqlite: Database; rateCards: RateCard; eras?: EraIndex; resolver?: AccountResolver; declarations?: readonly IdentityDeclaration[]; plans: PlansConfig; plansCatalog: PlansCatalog; cycles?: CyclesConfig;
  manualCapacity?: ManualCapacityMeasurement[];
  probeEvidence?: ProbeLimitEvidence;
  /** Plan history of every account; loaded once per report when the caller does not pass it. */
  planPeriods?: readonly DatedPeriod[];
}
const DAY = 86400000;
/** A damaged or missing table leaves every window without a plan rather than failing the report. */
function readPlanPeriods(sqlite: Database): DatedPeriod[] {
  try { return loadPeriods(sqlite, PLAN_PERIODS); }
  catch (error) { console.warn("[subscription-accounting] plan periods unreadable:", error instanceof Error ? error.message : error); return []; }
}
const emptyAmount = (): AmountCoverage => ({ value: null, priced_subtotal: 0, status: "empty", priced_events: 0, unpriced_events: 0, priced_tokens: 0, unpriced_tokens: 0, reasons: {} });
const emptyAmounts = () => ({ api_equivalent_usd: emptyAmount(), chatgpt_credits: emptyAmount() });
const emptyNormalization = () => ({ standard_api_usd: emptyAmount(), normalized_usd: emptyAmount(), standard_credits: emptyAmount(), extra_credits: emptyAmount() });
function amount(target: AmountCoverage, value: number | null, tokens: number, reason: string) {
  if (value === null) {
    target.unpriced_events++; target.unpriced_tokens += tokens;
    const gap = target.reasons[reason] ??= { events: 0, tokens: 0 }; gap.events++; gap.tokens += tokens;
  } else { target.priced_events++; target.priced_tokens += tokens; target.priced_subtotal += value; }
  target.status = target.unpriced_events ? target.priced_events ? "partial" : "unpriced" : "complete";
  target.value = target.status === "complete" ? target.priced_subtotal : null;
}

type Probe = CodexProbe & { limit_group: string | null; counter: string; cadence_source: CadenceSource };
export class SelectedCounterUnavailable extends Error {}
/** Successful meter readings of the adapter's counters, as SQL (alias p); the row filter below still decides. */
function usableProbeFilter(adapter: SubscriptionAccountingAdapter) {
  return { where: `(p.ok IS NULL OR p.ok=1) AND p.used_percent BETWEEN 0 AND 100 AND p.kind IN (${adapter.counterKinds.map(() => "?").join(",")})`
      + (adapter.id === "claude" ? " AND NOT (p.kind='weekly_all' AND COALESCE(p.scope,'')<>'')" : ""),
    params: [...adapter.counterKinds] as Array<string | number | null> };
}
type CounterFields = { kind: string; ts: string; resets_at: string | null; extra: string | null; limit_group: string | null;
  window_minutes: number; ok: number | null; used_percent: number | null; scope: string | null };
/** A reading's accounting time and counter (kind, group, resolved duration); null when unusable or outside `[since, until)`. */
function probeCounter<T extends CounterFields>(adapter: SubscriptionAccountingAdapter, account: string, since: string, until: string,
  cycles: CyclesConfig, row: T) {
  if (!((row.ok === null || row.ok === 1) && row.used_percent != null && row.used_percent >= 0 && row.used_percent <= 100
    && adapter.counterKinds.includes(row.kind) && !(adapter.id === "claude" && row.kind === "weekly_all" && row.scope))) return null;
  const ts = probeAccountingTime({ ...row, provider: adapter.id });
  if (!(Date.parse(ts) >= Date.parse(since) && Date.parse(ts) < Date.parse(until))) return null;
  const measured = Number.isFinite(row.window_minutes) && row.window_minutes > 0;
  const nominalMinutes = measured ? row.window_minutes : adapter.defaultMinutes[row.kind];
  const cadence = resolveCadenceForDay(cycles, account, row.kind, ts, {
    periodHours: nominalMinutes ? nominalMinutes / 60 : null, anchorIso: row.resets_at, source: measured ? "probe" : "default",
  });
  const minutes = (cadence.periodHours ?? 0) * 60;
  // A declared duration may fill a missing duration, but cannot invent a reset reading.
  return { ...row, ts, window_minutes: minutes, cadence_source: cadence.periodSource, counter: JSON.stringify([row.kind, row.limit_group ?? "", minutes]) };
}
/**
 * The counters of the range in reading order, from a narrow read: the full readings of the other
 * counters never enter the bounded read. Only Claude's weekly share metadata moves accounting time.
 */
function probeCounterCatalogue(sqlite: Database, adapter: SubscriptionAccountingAdapter, account: string, since: string, until: string,
  cycles: CyclesConfig) {
  const rows = readPreparedProbeAccountCatalogue(sqlite, adapter.id, account, since, until, "accounting", { ...usableProbeFilter(adapter),
    columns: "p.id,p.ts,p.kind,p.limit_group,p.scope,p.ok,p.used_percent,p.window_minutes,p.resets_at,CASE WHEN p.kind='weekly_all' THEN p.extra END AS extra" });
  if (!rows) throw new ProbeAccountIndexUnavailable();
  return (rows as unknown as CounterFields[]).flatMap(row => probeCounter(adapter, account, since, until, cycles, row) ?? []);
}
/** The readings of a catalogued counter; overflow of the bounded read stays unavailable. */
function loadProbes(sqlite: Database, adapter: SubscriptionAccountingAdapter, account: string, since: string, until: string, cycles: CyclesConfig,
  plans: PeriodIndex | null, selected: { counter: string; kind: string; limit_group: string | null } | undefined): Probe[] {
  if (!selected) return [];
  const { counter } = selected, usable = usableProbeFilter(adapter);
  const prepared = readPreparedProbeAccountRange(sqlite, adapter.id, account, since, until, 20_000, "accounting",
    { where: `${usable.where} AND p.kind=? AND COALESCE(p.limit_group,'')=?`, params: [...usable.params, selected.kind, selected.limit_group ?? ""] });
  if (!prepared) throw new ProbeAccountIndexUnavailable();
  return (prepared.rows as unknown as Array<CodexProbe & CounterFields>).flatMap(row => {
    const probe = probeCounter(adapter, account, since, until, cycles, row);
    if (!probe || probe.counter !== counter) return [];
    // The plan is the account's plan period at the reading, never the label the reading carried:
    // readings only feed the periods (Claude's token label is not even a plan).
    return [{ ...probe, plan: plans?.resolve(adapter.id, account, probe.ts).value ?? null }];
  });
}

/** One register variant total as the report's coverage block. */
function coverageOf(source: UsagePriceAmount): AmountCoverage {
  const priced_events = Number(source.pricedEvents), unpriced_events = Number(source.unpricedEvents);
  const reasons: AmountCoverage["reasons"] = {};
  for (const [reason, counted] of Object.entries(source.reasons))
    reasons[reason] = { events: Number(counted.events), tokens: Number(counted.tokens) };
  const status = unpriced_events ? priced_events ? "partial" : "unpriced" : priced_events ? "complete" : "empty";
  const priced_subtotal = Number(source.pricedSubtotal);
  return { value: status === "complete" ? priced_subtotal : null, priced_subtotal, status,
    priced_events, unpriced_events, priced_tokens: Number(source.pricedTokens),
    unpriced_tokens: Number(source.unpricedTokens), reasons };
}
/** Variants this provider cannot express: recorded as missing, never as zero cost (§8). */
function unavailableCoverage(events: number, tokens: number): AmountCoverage {
  return { value: null, priced_subtotal: 0, status: events ? "unpriced" : "empty", priced_events: 0,
    unpriced_events: events, priced_tokens: 0, unpriced_tokens: tokens,
    reasons: events ? { provider_conversion_unavailable: { events, tokens } } : {} };
}

function eventInstant(ts: string): string { return new Date(ts).toISOString(); }
/** Keep only one copy of a provider event identity within the verified subscription. */
function uniqueEvents<E extends SubscriptionEvent>(events: E[]) {
  const selected = new Map<string, E>();
  const rejected = new Set<string>();
  let duplicates = 0, conflicts = 0;
  for (const event of events) {
    const key = JSON.stringify([event.account, event.identity]);
    const previous = selected.get(key);
    if (!previous) { selected.set(key, event); continue; }
    duplicates++;
    if (eventInstant(previous.ts) !== eventInstant(event.ts) || previous.model !== event.model || JSON.stringify(previous.quantities) !== JSON.stringify(event.quantities)) {
      conflicts++;
      // Conflicting copies cannot determine either quantities or their timing.
      selected.delete(key);
      rejected.add(key);
    }
  }
  function isKept(event: SubscriptionEvent) { return !rejected.has(JSON.stringify([event.account, event.identity])); }
  return { events: [...selected.values()].filter(isKept), duplicates, conflicts };
}

type ProviderAccountingReport = SubscriptionAccountingReport & {
  model_details: SubscriptionModelDetail[];
  traffic_periods: NonNullable<SubscriptionAccountingReport["traffic_periods"]>;
};
function scanBounds(options: SubscriptionAccountingOptions, measurements: ManualCapacityMeasurement[]) {
  return {
    scanStart: new Date(Math.min(Date.parse(options.since) - 14 * DAY, ...measurements.map(m => Date.parse(m.start)))).toISOString(),
    // Daily prepared reads need the full final day; interval matching trims exact instants later.
    scanEnd: new Date(Math.max(Date.parse(options.until) + 15 * DAY, ...measurements.map(m => Date.parse(m.end.slice(0, 10)) + DAY))).toISOString(),
  };
}
/** Inputs that can make an explicitly selected counter appear for one account and interval. */
export function selectedCounterFailureStamp(ctx: Context, provider: string, options: SubscriptionAccountingOptions): string {
  const adapter = subscriptionAccountingAdapter(provider);
  const account = options.account?.toLowerCase() ?? "";
  const measurements = readManualCapacity(adapter.id).measurements.filter(m => m.account === account
    && Date.parse(m.end) >= Date.parse(options.since) && Date.parse(m.start) < Date.parse(options.until) + DAY);
  const bounds = scanBounds(options, measurements);
  const plan = loadAccountResolver(ctx.sqlite, ctx.declarations ?? ctx.accounts?.subscriptions).plan(adapter.id, account);
  const rangeStart = Date.parse(bounds.scanStart), rangeEnd = Date.parse(bounds.scanEnd);
  const ownership = plan && [plan.identityKeys, plan.ranges.flatMap(range => {
    const start = Math.max(rangeStart, range.from), end = Math.min(rangeEnd, range.until);
    return start < end ? [[range.source, start, end]] : [];
  })];
  const evidence = account && preparedProbeAccountIndexReady(ctx.sqlite, adapter.id, account)
    ? loadProbeLimitEvidence(ctx.sqlite, adapter.id, account, loadAccountResolver(ctx.sqlite, ctx.declarations ?? ctx.accounts?.subscriptions)) : null;
  return analysisHash([adapter.id, account, options.since, options.until, options.counter,
    measurements, bounds, evidence?.revision ?? null,
    ownership, planPeriodsShape(readPlanPeriods(ctx.sqlite), adapter.id, account), ctx.cycles]);
}

export { subscriptionWindowAdapter } from "./subscription-window-adapter";

type ReportWindow = NonNullable<SubscriptionAccountingReport["windows"]>[number];
/**
 * The report's meter windows from their stored rows (plan U1.4); a missing row is "preparing". A
 * reference-day valuation is the stored variant when the day's rates are the stored ones (the configured
 * day, today by default). Two bounded exceptions read the events of their own window only, never the
 * history: one window's time axis, and a reference day with other rates.
 */
function storedWindows(ctx: Context, provider: string, account: string, counter: string, register: readonly ProbeLimitWindow[],
  options: SubscriptionAccountingOptions, windows: readonly ProbeLimitWindow[], storedOnly = false): ReportWindow[] {
  const detail = (w: ProbeLimitWindow) => options.detail_cycle === w.id
    || (!!w.manual_measurement && options.detail_cycle === `manual:${w.manual_measurement.id}`);
  const fingerprint = options.reference_day !== undefined ? referenceFingerprint(ctx.rateCards, provider, options.reference_day) : null;
  const stored = readWindowSums(ctx.sqlite, provider, account, counter, windows.filter(w => !detail(w)),
    (fingerprint === null ? ["cycle"] : ["cycle", "reference"]) as Array<"cycle" | "reference">);
  const variant = (w: ProbeLimitWindow) => { const row = stored.get(w.id); return fingerprint === null ? row?.cycle ?? null
    : row?.reference?.fingerprint === fingerprint ? row.reference.cycle : null; };
  const bounded = (w: ProbeLimitWindow) => detail(w) || variant(w) === null;
  if (storedOnly && windows.some(bounded)) throw new WindowUsagePreparing();
  const reader = windows.some(bounded) ? windowEventReader(ctx.sqlite, ctx.rateCards, ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.declarations)) : null;
  return windows.map(w => bounded(w)
    ? windowSumsFromLedgers(reader!, ctx.rateCards, provider, w, register.slice(0, register.indexOf(w)),
      { timeline: detail(w), referenceDay: options.reference_day }).comparison
    : comparisonWindow(w, variant(w)!));
}
/** Standalone manual measurements from their stored interval rows, with the same bounded exceptions. */
function storedManualWindows(ctx: Context, provider: string, account: string, measurements: readonly ManualCapacityMeasurement[],
  options: SubscriptionAccountingOptions, storedOnly = false): ReportWindow[] {
  const detail = (m: ManualCapacityMeasurement) => options.detail_cycle === `manual:${m.id}`;
  const fingerprint = options.reference_day !== undefined ? referenceFingerprint(ctx.rateCards, provider, options.reference_day) : null;
  const stored = readSpanSums(ctx.sqlite, provider, account, measurements.filter(m => !detail(m)).map(m => `manual:${m.id}`),
    (fingerprint === null ? ["cycle"] : ["cycle", "reference"]) as Array<"cycle" | "reference">);
  const variant = (m: ManualCapacityMeasurement) => { const row = stored.get(`manual:${m.id}`); return fingerprint === null ? row?.cycle ?? null
    : row?.reference?.fingerprint === fingerprint ? row.reference.cycle : null; };
  const bounded = (m: ManualCapacityMeasurement) => detail(m) || variant(m) === null;
  if (storedOnly && measurements.some(bounded)) throw new WindowUsagePreparing();
  const reader = measurements.some(bounded) ? windowEventReader(ctx.sqlite, ctx.rateCards, ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.declarations)) : null;
  return measurements.map(m => {
    if (bounded(m)) return intervalSumsFromLedgers(reader!, ctx.rateCards, { kind: "manual", provider, account, counter: m.counter,
      id: `manual:${m.id}`, start: m.start, end: m.end, measurement: m }, { referenceDay: options.reference_day, detailCycle: options.detail_cycle }).comparison;
    const shell = compareManualMeterInterval(m, [], subscriptionWindowTraffic(provider, m.counter, ctx.rateCards).adapter);
    const cycle = variant(m)!;
    return { ...shell, usage: cycle.usage, cycle_usage: cycle.cycle_usage, unpaired_events: cycle.unpaired_events,
      sources: cycle.sources, models: cycle.models,
      evidence: { ...shell.evidence!, sources: cycle.evidence.sources, excluded_events: cycle.evidence.excluded_events } };
  });
}

/**
 * The cycles of one counter of an account over the requested days, as the accounting report and the capacity
 * comparison show them: stored meter windows and standalone manual intervals with their plan context, promotion
 * and evidence. Reads stored rows only; a window without stored sums raises WindowUsagePreparing.
 */
function counterWindows(ctx: Context, adapter: SubscriptionAccountingAdapter, account: string, counter: string,
  options: SubscriptionAccountingOptions, relevantMeasurements: readonly ManualCapacityMeasurement[], planIndex: PeriodIndex | null,
  windowId?: string): ReportWindow[] {
  const end = Date.parse(options.until) + DAY;
  const [counterKind] = parseCapacityCounter(counter) ?? [adapter.defaultCounter];
  const kind = counterKind === "session" || counterKind === "five_hour" ? "session" : "weekly";
  const shared = readLimitWindows(ctx.sqlite, adapter.id, account, counter);
  // Only measurements without a matching meter segment remain standalone.
  const standalone = relevantMeasurements.filter(m => m.counter === counter)
    .filter(m => !shared.some(w => w.manual_measurements?.some(item => item.id === m.id)));
  // A manual interval has no readings to carry a plan: it takes the plan period covering both of
  // its ends, and stays unknown when a plan change falls inside it.
  const manualPlan = (m: ManualCapacityMeasurement) => {
    const first = planIndex?.resolve(adapter.id, account, m.start).value ?? null;
    const last = planIndex?.resolve(adapter.id, account, new Date(Date.parse(m.end) - 1).toISOString()).value ?? null;
    return first === last ? first : null;
  };
  const selectedManual = standalone.filter(m => !windowId || `manual:${m.id}` === windowId);
  const windows = assignSourceMachines(ctx.sqlite, [...storedWindows(ctx, adapter.id, account, counter, shared, options,
    shared.filter(w => (!windowId || w.id === windowId) && Date.parse(w.end) > Date.parse(options.since) && Date.parse(w.start) < end), !!windowId),
  ...storedManualWindows(ctx, adapter.id, account, selectedManual, options, !!windowId)
    .map((window, index) => ({ ...window, plan: manualPlan(selectedManual[index]!) }))])
    .sort((a, b) => a.start.localeCompare(b.start)).map(window => {
      const context = capacityContext(window, ctx.plans, ctx.plansCatalog, adapter.id, kind);
      // A week read only from a limit refusal: 0% is assumed at the vendor reset, so local traffic gives a lower bound.
      const hitOnlyHistoricalWeek = adapter.id === "claude" && counterKind === "weekly_all"
        && window.start_basis === "reset"
        && window.end_percent === 100 && window.meter_sources?.length === 1 && window.meter_sources[0] === "limit_hit";
      return { ...window, ...context,
        ...(hitOnlyHistoricalWeek ? { limit_refusal_capacity: { relation: "≥" as const,
          tokens: window.usage.tokens, api_usd: window.usage.unpriced_events ? null : window.usage.api_standard,
          provenance: "limit refusal" as const, partial: true as const } } : {}),
        plan_detail: window.plan_detail?.status === "mixed" ? window.plan_detail : context.plan_detail,
        plan: window.plan ?? (context.plan_detail.status === "resolved" ? context.plan_detail.label : null),
        promotion: cyclePromotion(window, ctx.plans, ctx.plansCatalog, adapter.id, kind),
      };
    });
  attachWindowEvidence(windows, { provider: adapter.id, eras: ctx.eras, modeRelevant: adapter.speed, opaqueSources: adapter.opaqueSources, sqlite: ctx.sqlite });
  return windows;
}
/** Claude's shared Claude Code capacity estimate over the scan range (claude-code-capacity.ts), from stored readings and window sums. */
function claudeCapacity(ctx: Context, account: string, measurements: ManualCapacityMeasurement[], probeEvidence: ProbeLimitEvidence | undefined,
  scan: { since: string; until: string }) {
  return buildClaudeCodeCapacityReport(ctx.sqlite, account,
    { rateCards: ctx.rateCards, resolver: ctx.resolver, declarations: ctx.declarations,
      cycles: ctx.cycles, planPeriods: ctx.planPeriods, manualCapacity: measurements,
      probeEvidence, probeWindows: claudeWeeklyRegisterWindows(ctx.sqlite, account) }, scan);
}
/** Each meter window's share of that estimate: its weekly counter's only, null on every other counter (the marker forbids the old division). */
function attachClaudeCapacity(sqlite: Database, windows: ReportWindow[], counterKind: string, counterMinutes: number,
  capacity: () => ReturnType<typeof buildClaudeCodeCapacityReport>): void {
  const weekly = counterKind === "weekly_all" && counterMinutes === 10080;
  for (const window of windows) {
    if (window.id.startsWith("manual:")) { window.claude_capacity = claudeCapacityResult(window); continue; }
    // The marker also forbids the old local-traffic/global-meter division when unavailable.
    window.claude_code_capacity = weekly ? claudeCodeCapacitySummary(selectClaudeCodeCapacityReport(capacity(), { windowId: window.id })) : null;
    if (weekly) window.claude_capacity = readClaudeCapacityResult(sqlite, window.claude_code_capacity!);
  }
}

/**
 * The cycles of one counter of a Claude, Gemini, Grok or GLM account over whole UTC days, exactly as the accounting
 * report shows them (`counterWindows`, with Claude's per-window estimate), without the report's traffic, counter
 * discovery or calibration. Reads stored rows only.
 */
export function subscriptionCapacityCycles(ctx: Context, provider: string, account: string, counter: string,
  range: { since: string; until: string }, windowId?: string): ReportWindow[] {
  const adapter = subscriptionAccountingAdapter(provider), normalized = account.toLowerCase();
  ctx = { ...ctx, resolver: ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.declarations ?? ctx.accounts?.subscriptions),
    planPeriods: ctx.planPeriods ?? readPlanPeriods(ctx.sqlite) };
  const options: SubscriptionAccountingOptions = { ...range, account: normalized, counter };
  const allMeasurements = (ctx.manualCapacity ?? readManualCapacity(adapter.id).measurements).filter(m => m.account === normalized);
  const relevant = allMeasurements.filter(m => Date.parse(m.end) >= Date.parse(range.since) && Date.parse(m.start) < Date.parse(range.until) + DAY);
  const { scanStart, scanEnd } = scanBounds(options, relevant);
  const windows = counterWindows(ctx, adapter, normalized, counter, options, relevant, planPeriodIndex(ctx.planPeriods!), windowId);
  if (adapter.id === "claude") {
    const [kind, , minutes] = parseCapacityCounter(counter) ?? [adapter.defaultCounter, "", 0];
    // As the report: the estimate sees the manual intervals of its scan range.
    const scanned = allMeasurements.filter(m => Date.parse(m.end) >= Date.parse(scanStart) && Date.parse(m.start) < Date.parse(scanEnd));
    let capacity: ReturnType<typeof buildClaudeCodeCapacityReport> | undefined;
    attachClaudeCapacity(ctx.sqlite, windows, kind, minutes, () => capacity ??= windowId
      ? buildClaudeCodeCapacityReport(ctx.sqlite, normalized, { ...ctx, manualCapacity: scanned,
        probeWindows: claudeWeeklyRegisterWindows(ctx.sqlite, normalized) }, { since: scanStart, until: scanEnd, windowId })
      : claudeCapacity(ctx, normalized, scanned, undefined, { since: scanStart, until: scanEnd }));
  }
  return windows;
}

/**
 * A provider's accounting report (plan U4.4): built on each request from stored rows (register days,
 * limit windows, window usage, probe readings); nothing is remembered. A window's time axis
 * (`detail_cycle`), a reference day with other rates and a project filter on a provider whose register
 * keeps no subject are the named bounded reads of calls.
 */
export function buildSubscriptionAccountingReport(ctx:Context,provider:string,options:SubscriptionAccountingOptions):ProviderAccountingReport {
  ctx = { ...ctx, resolver: ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.declarations ?? ctx.accounts?.subscriptions),
    planPeriods: ctx.planPeriods ?? readPlanPeriods(ctx.sqlite) };
  const adapter=subscriptionAccountingAdapter(provider);
  const allMeasurements = (ctx.manualCapacity ?? readManualCapacity(adapter.id).measurements)
    .filter(m => m.account === options.account?.toLowerCase());
  const measurements = allMeasurements.filter(m => Date.parse(m.end) >= Date.parse(options.since)
    && Date.parse(m.start) < Date.parse(options.until) + DAY);
  const bounds = scanBounds(options, measurements);
  const windowMeasurements = allMeasurements.filter(m => Date.parse(m.end) >= Date.parse(bounds.scanStart)
    && Date.parse(m.start) < Date.parse(bounds.scanEnd));
  const account = options.account?.toLowerCase();
  if (account && !["all", "__all__"].includes(account)
    && !preparedProbeAccountIndexReady(ctx.sqlite, adapter.id, account)) throw new ProbeAccountIndexUnavailable();
  const probeEvidence = account && !["all", "__all__"].includes(account)
    ? loadProbeLimitEvidence(ctx.sqlite, adapter.id, account, ctx.resolver!) : null;
  const report=computeSubscriptionAccountingReport({...ctx, manualCapacity: windowMeasurements,
    probeEvidence: probeEvidence ?? undefined},provider,options);
  attachWindowEvidence(report.windows,{provider:adapter.id,eras:ctx.eras,modeRelevant:adapter.speed,opaqueSources:adapter.opaqueSources,sqlite:ctx.sqlite});
  return report;
}
function computeSubscriptionAccountingReport(ctx: Context, provider: string, options: SubscriptionAccountingOptions): ProviderAccountingReport {
  accountingOptions(new URLSearchParams({ since: options.since, until: options.until, ...(options.reference_day !== undefined ? { reference_day: options.reference_day } : {}), ...(options.detail_cycle !== undefined ? { detail_cycle: options.detail_cycle, account: options.account ?? "", project: options.project ?? "" } : {}) }));
  if (!options.account || ["all", "__all__"].includes(options.account)) throw new Error(SELECT_ONE_SUBSCRIPTION);
  const account = options.account.toLowerCase(), adapter = subscriptionAccountingAdapter(provider);
  const end = new Date(Date.parse(options.until) + DAY).toISOString();
  const measurements = ctx.manualCapacity ?? [];
  const relevantMeasurements = measurements.filter(m => Date.parse(m.end) >= Date.parse(options.since)
    && Date.parse(m.start) < Date.parse(options.until) + DAY);
  const { scanStart, scanEnd } = scanBounds(options, relevantMeasurements);
  const planIndex = planPeriodIndex(ctx.planPeriods ?? readPlanPeriods(ctx.sqlite));
  const probeEvidence = ctx.probeEvidence ?? loadProbeLimitEvidence(ctx.sqlite, adapter.id, account, ctx.resolver!);
  const catalogue = probeCounterCatalogue(ctx.sqlite, adapter, account, scanStart, scanEnd, ctx.cycles ?? {});
  const counters = [...new Map(catalogue.map(row => [row.counter, { id: row.counter, label: [row.kind, row.limit_group, row.window_minutes ? `${row.window_minutes}m` : "duration unconfirmed"].filter(Boolean).join(" · ") }])).values()];
  for (const hit of probeEvidence.samples.filter(row => row.limitHit && Date.parse(row.ts) >= Date.parse(scanStart)
    && Date.parse(row.ts) < Date.parse(scanEnd))) {
    const counter = probeLimitCounter(hit, account, ctx.cycles ?? {});
    if (!counters.some(item => item.id === counter)) counters.push({ id: counter, label: [hit.kind, hit.limit_group, `${JSON.parse(counter)[2]}m`].filter(Boolean).join(" · ") });
  }
  for (const m of relevantMeasurements) if (!counters.some(c => c.id === m.counter)) {
    const parts = parseCapacityCounter(m.counter);
    if (!parts) throw new Error("Nieprawidłowy licznik ręcznego pomiaru");
    counters.push({ id: m.counter, label: parts.join(" · ") });
  }
  const selectedCounter = options.counter ?? catalogue.find(p => p.kind === adapter.defaultCounter)?.counter ?? catalogue[0]?.counter
    ?? counters.find(c => JSON.parse(c.id)[0] === adapter.defaultCounter)?.id ?? relevantMeasurements[0]?.counter ?? null;
  if (options.counter && !counters.some(c => c.id === options.counter)) throw new SelectedCounterUnavailable("Selected counter is unavailable in this period");
  let probes = loadProbes(ctx.sqlite, adapter, account, scanStart, scanEnd, ctx.cycles ?? {}, planIndex,
    catalogue.find(p => p.counter === selectedCounter));
  const probeCopies = new Map<string, Probe[]>();
  for (const probe of probes) { const rows = probeCopies.get(probe.ts) ?? []; rows.push(probe); probeCopies.set(probe.ts, rows); }
  let conflictingReadings = 0;
  probes = [...probeCopies.values()].flatMap(rows => {
    const first = rows[0]!;
    if (rows.some(p => p.used_percent !== first.used_percent || p.resets_at !== first.resets_at || p.plan !== first.plan)) { conflictingReadings += rows.length; return []; }
    return [first];
  });
  const from=options.project?options.since:scanStart, until=options.project?end:scanEnd;
  // Throws the pending signal while the usage ledger is not ready for this card.
  const factIndex=usageLedgerEventsFor(ctx.sqlite,provider,ctx.rateCards,(ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.declarations)).plan(provider,account));
  // Stored valuations of the ledger; nothing here prices an event.
  type PricedEvent={event:LedgerEvent;standard:StoredPrice;actual:StoredPrice;tokens:number};
  const priced=(event:LedgerEvent):Omit<PricedEvent,"event">=>({standard:event.prices.standard!,actual:event.prices.actual!,
    tokens:TOKEN_BUCKETS.reduce((sum,key)=>sum+event.quantities[key],0)});
  const prepare=(from:string,until:string):PricedEvent[]=>factIndex.load(from,until,scanStart,scanEnd,options.project).map(event=>({event,...priced(event)}));
  const prices=new Map<LedgerEvent,Omit<PricedEvent,"event">>();
  /**
   * The shared register (WP4b) is the source of every aggregate below. A scope that exists
   * but is not current for this configuration is an explicit preparation state, never a
   * partial sum and never a synchronous rebuild (§5, §9). A database where the register has
   * never run keeps the pre-register event path; WP4e removes that branch once every fixture
   * prepares the register.
   */
  // A project filter needs the subject dimension, which one provider does not publish yet.
  const register=options.project && !USAGE_PRICE_SUBJECT_PROVIDERS.has(adapter.id)
    ? {state:"absent"} as const : subscriptionUsagePriceReadiness(ctx.sqlite,adapter.id,ctx.rateCards);
  if(register.state==="pending")
    throw new SubscriptionFactsPending(`Subscription usage prices are awaiting background preparation (${register.reason})`,adapter.id);
  let loaded:ReturnType<typeof uniqueEvents<LedgerEvent>>|undefined;
  const getUnique=()=>loaded ??= (()=>{
    // Deduplication spans the entire requested range: a late conflicting copy may have an older date.
    const prepared:PricedEvent[]=prepare(from,until);
    const unique = uniqueEvents(prepared.map(row=>row.event));
    for (const event of unique.events) event.home = event.source;
    if(factIndex)Object.assign(unique,factIndex.stats(from,until,options.project));
    for(const row of prepared)prices.set(row.event,{standard:row.standard,actual:row.actual,tokens:row.tokens});
    return unique;
  })();
  const blank=(excludedDuplicates:number):ProviderAccountingReport=>({
    schema_version: 1, scope: { ...options, account },
    provider: { id: adapter.id, label: adapter.label, credits: false, speed: adapter.speed, counter: selectedCounter,
      counter_reason: null, counters },
    quantity_basis: "Non-overlapping input, cache reads, cache writes and total output. Reasoning is shown separately as part of total output.",
    tier_evidence: "Dated plan declarations and provider meter readings", quota_verified: false,
    source: adapter.table, account_attribution: "Only usage attributed to this subscription is included; ambiguous identities are excluded.",
    deduplication: "Provider event identity within the subscription; identical copies count once and conflicting copies are excluded.",
    rule_source: "Configured per-model dated rate card; missing rates remain unpriced.",
    events: 0, tokens: 0, known_speed_events: 0, known_speed_tokens: 0, unknown_speed_events: 0, unknown_speed_tokens: 0,
    excluded_mirror_events: excludedDuplicates, unattributed_events: 0, source_home_count: 0,
    amounts: emptyAmounts(), normalization: emptyNormalization(), breakdown: [], windows: [], calibration: null,
    applied_rules: [], subjects: [], model_details: [], traffic_periods: [],
    meter_history: { session_first: null, periodic_first: probes[0]?.ts ?? null, conflicting_readings: conflictingReadings },
    limitations: ["Archive completeness across all computers is unconfirmed. Capacity estimates can be lower when traffic is missing.",
      "API values use each event date's configured Standard prices. Actual-mode API values are separate. Neither is a subscription charge or a confirmed credit balance.",
      "A price, model or cache mix change can change API capacity without changing the subscription allowance. Compare those factors before concluding that a limit changed.",
      "Missing historic rates, modes, plan declarations and meter readings are not reconstructed by guessing."]
  });
  /**
   * Aggregates from the register: whole days, one row per dimension tuple, no event scan.
   * The scan range feeds only the counter heuristics and the conflict limitation; the
   * report sections are cut to the requested days.
   */
  const registerTraffic=(scope:string)=>{
    const scan={since:from.slice(0,10),until:new Date(Date.parse(until)-1).toISOString().slice(0,10)};
    const days=readSubscriptionUsagePriceDays(ctx.sqlite,adapter.id,scope,
      {account,...(options.project?{project:options.project}:{}),...scan}, ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.declarations));
    let duplicates=0,conflicts=0,scanEvents=0,approximate=0;
    // `conflicted_identities` counts an identity once, the measure the report has always shown;
    // `conflicts` is per identity-day and only corrects that day's call count.
    for(const row of days){duplicates+=row.quality.duplicates;conflicts+=row.quality.conflicted_identities;
      scanEvents+=row.calls;approximate+=row.quality.approximate_time_events;}
    const report=blank(duplicates);
    const homes=new Set<string>();
    const daily=new Map<string,NonNullable<SubscriptionAccountingReport["traffic_periods"]>[number]>();
    const standards:UsagePriceAmount[]=[],actuals:UsagePriceAmount[]=[];
    const inRange=(row:UsagePriceDay)=>row.day>=options.since && row.day<=options.until && row.calls>0;
    for(const row of days.filter(inRange)) {
      const tokens=TOKEN_BUCKETS.reduce((sum,key)=>sum+row.tokens[key],0);
      const speed=row.speed??"unknown",known=speed==="standard"||speed==="fast";
      report.events+=row.calls; report.tokens+=tokens; homes.add(row.home??"");
      if(known){report.known_speed_events+=row.calls;report.known_speed_tokens+=tokens;}
      else{report.unknown_speed_events+=row.calls;report.unknown_speed_tokens+=tokens;}
      standards.push(row.standard); actuals.push(row.actual);
      const unavailable=()=>unavailableCoverage(row.calls,tokens);
      report.breakdown.push({day:row.day,model:row.model,speed,account,home:row.home,events:row.calls,tokens,
        amounts:{api_equivalent_usd:coverageOf(row.actual),chatgpt_credits:unavailable()},
        normalization:{standard_api_usd:coverageOf(row.standard),normalized_usd:unavailable(),
          standard_credits:unavailable(),extra_credits:unavailable()}});
      // Rates, per-bucket costs and the pricing note follow from the dated rules for
      // (model, day, speed), so one valuation of the group's own quantities reproduces them.
      const sample={identity:"",account,ts:`${row.day}T00:00:00.000Z`,model:row.model,speed,home:row.home,
        precise_time:true,usage_valid:row.quality.invalid_token_events===0,
        quantities:{...row.tokens,out_thinking:row.reasoning}} as SubscriptionEvent;
      const rule=priceSubscriptionEvent(ctx.rateCards,adapter,sample);
      // `out_thinking` stays beside the disjoint buckets, never added into them (§7).
      report.model_details.push({day:row.day,model:row.model??"?",speed,source:row.home??"?",calls:row.calls,tokens,
        quantities:{...row.tokens,out_thinking:row.reasoning},rates:rule.rates,costs:rule.costs,
        api_standard:row.standard.value===null?null:Number(row.standard.value),
        api_actual:row.actual.value===null?null:Number(row.actual.value),
        pricing_source:rule.source,pricing_note:rule.note,pricing_issue:rule.reason});
      const period=daily.get(row.day)??{account,start:row.day+"T00:00:00.000Z",end:new Date(Date.parse(row.day)+DAY).toISOString(),
        start_reset:false,end_reset:false,events:0,tokens:0,fast_tokens:0,unknown_tokens:0,api:0,credits:0,
        priced_tokens:0,priced_events:0,models:{}};
      period.events+=row.calls; period.tokens+=tokens;
      period.fast_tokens+=speed==="fast"?tokens:0; period.unknown_tokens+=known?0:tokens;
      period.models[row.model??"?"]=(period.models[row.model??"?"]??0)+tokens;
      period.api+=Number(row.standard.pricedSubtotal);
      period.priced_tokens+=Number(row.standard.pricedTokens);
      period.priced_events+=Number(row.standard.pricedEvents);
      daily.set(row.day,period);
    }
    const unavailableTotal=()=>unavailableCoverage(report.events,report.tokens);
    report.amounts={api_equivalent_usd:coverageOf(sumUsagePriceAmounts(actuals)),chatgpt_credits:unavailableTotal()};
    report.normalization={standard_api_usd:coverageOf(sumUsagePriceAmounts(standards)),normalized_usd:unavailableTotal(),
      standard_credits:unavailableTotal(),extra_credits:unavailableTotal()};
    report.traffic_periods=[...daily.values()];
    report.source_home_count=homes.size;
    return {report,scanEvents,allImprecise:approximate===scanEvents,conflicts};
  };
  const computeTraffic=()=>{
  const unique=getUnique();
  const report=blank(unique.duplicates);
  const groups = new Map<string, SubscriptionAccountingReport["breakdown"][number]>();
  const details = new Map<string, SubscriptionModelDetail>();
  const daily = new Map<string, NonNullable<SubscriptionAccountingReport["traffic_periods"]>[number]>();
  const homes = new Set<string>();
  for (const event of unique.events) {
    const {standard,actual,tokens}=prices.get(event)!;
    if (Date.parse(event.ts) < Date.parse(options.since) || Date.parse(event.ts) >= Date.parse(end)) continue;
    report.events++; report.tokens += tokens; homes.add(event.source ?? "");
    const known = event.speed === "standard" || event.speed === "fast";
    if (known) { report.known_speed_events++; report.known_speed_tokens += tokens; }
    else { report.unknown_speed_events++; report.unknown_speed_tokens += tokens; }
    const day = event.ts.slice(0, 10), key = JSON.stringify([day, event.model, event.speed, event.source]);
    const group = groups.get(key) ?? { day, model: event.model, speed: event.speed, account, home: event.source ?? null, events: 0, tokens: 0, amounts: emptyAmounts(), normalization: emptyNormalization() };
    group.events++; group.tokens += tokens; groups.set(key, group);
    for (const target of [report, group]) {
      amount(target.amounts.api_equivalent_usd, actual.amount, tokens, actual.reason ?? "missing_rate");
      amount(target.normalization.standard_api_usd, standard.amount, tokens, "missing_rate");
      for (const unavailable of [target.amounts.chatgpt_credits, target.normalization.standard_credits, target.normalization.extra_credits, target.normalization.normalized_usd]) amount(unavailable, null, tokens, "provider_conversion_unavailable");
    }
    // Rates, source and note describe the dated rule of (day, model, speed), the same for the whole group.
    const rule = details.has(key) ? null : priceSubscriptionEvent(ctx.rateCards, adapter, event);
    const row: SubscriptionModelDetail = details.get(key) ?? { day, model: event.model ?? "?", speed: event.speed, source: event.source ?? "?", calls: 0, tokens: 0,
      quantities: {}, rates: rule!.rates, costs: {}, api_standard: 0, api_actual: 0, pricing_source: rule!.source, pricing_note: rule!.note, pricing_issue: rule!.reason };
    row.calls++; row.tokens += tokens;
    for (const [bucket, quantity] of Object.entries(event.quantities)) row.quantities[bucket] = (row.quantities[bucket] ?? 0) + quantity;
    for (const [bucket, cost] of Object.entries(actual.costs)) row.costs[bucket] = row.costs[bucket] === null || cost === null ? null : (row.costs[bucket] ?? 0) + cost;
    row.api_standard = row.api_standard === null || standard.amount === null ? null : row.api_standard + standard.amount;
    row.api_actual = row.api_actual === null || actual.amount === null ? null : row.api_actual + actual.amount;
    details.set(key, row);
    const period = daily.get(day) ?? { account, start: day + "T00:00:00.000Z", end: new Date(Date.parse(day) + DAY).toISOString(), start_reset: false, end_reset: false,
      events: 0, tokens: 0, fast_tokens: 0, unknown_tokens: 0, api: 0, credits: 0, priced_tokens: 0, priced_events: 0, models: {} };
    period.events++; period.tokens += tokens; period.fast_tokens += event.speed === "fast" ? tokens : 0; period.unknown_tokens += known ? 0 : tokens;
    period.models[event.model ?? "?"] = (period.models[event.model ?? "?"] ?? 0) + tokens;
    if (standard.amount !== null) { period.api += standard.amount; period.priced_tokens += tokens; period.priced_events++; }
    daily.set(day, period);
  }
  report.breakdown = [...groups.values()]; report.model_details = [...details.values()]; report.traffic_periods = [...daily.values()]; report.source_home_count = homes.size;
  return {report,scanEvents:unique.events.length,allImprecise:unique.events.every(e=>!e.precise_time),conflicts:unique.conflicts};
  };
  // The register read is cheap enough to need no memo of its own; the assembled report keeps
  // its response-level memo above. The pre-register branch recomputes under that same memo.
  const traffic=register.state==="ready"?registerTraffic(register.head.scope):computeTraffic();
  const {report}=traffic;
  report.scope={...options,account};
  Object.assign(report.provider!,{counter:selectedCounter,counters});
  report.meter_history={session_first:null,periodic_first:probes[0]?.ts??null,conflicting_readings:conflictingReadings};
  const first = probes[0];
  const [counterKind, , counterMinutes] = (selectedCounter ? parseCapacityCounter(selectedCounter) : null) ?? [adapter.defaultCounter, "", 0];
  report.windows = options.project ? null : selectedCounter
    ? counterWindows(ctx, adapter, account, selectedCounter, options, relevantMeasurements, planIndex) : [];
  if (!first) report.provider!.counter_reason = "No supported account meter in this period. Traffic is available; capacity needs matched percentage readings.";
  else if (!probes.some(p => p.resets_at)) report.provider!.counter_reason = "The meter has no reset anchors. Sliding-window readings cannot be treated as cumulative reset cycles.";
  else if (traffic.scanEvents && traffic.allImprecise) report.provider!.counter_reason = "Source timestamps describe a conversation or file, not individual requests. Traffic is shown by recorded date; it cannot safely be paired with cycle percentages.";
  else if (!traffic.scanEvents) report.provider!.counter_reason = "No traffic attributed to this subscription in this range. Check source and subscription assignments in Settings; meter-only cycles cannot establish capacity.";
  if (traffic.conflicts) report.limitations.push(`${traffic.conflicts} conflicting duplicate event identities excluded.`);
  if (probes.some(p => p.cadence_source === "default")) report.limitations.push("Missing meter durations use the named counter's nominal cadence (weekly: 168h; session: 5h), as in the window rail. Dated cycle settings override it; reset times still require actual readings.");
  if (probes.some(p => p.cadence_source === "declared")) report.limitations.push("Selected counter durations include dated user declarations from cycle settings.");
  if (adapter.id === "glm") report.limitations.push("OpenCode traffic requires an explicit store-to-subscription mapping. A shared provider name alone does not establish the account.");
  if (adapter.id === "gemini") report.limitations.push("Gemini archive dates may be conversation timestamps or file modification times. These are excluded from capacity matching.");
  if (report.windows?.some(w => w.manual_measurement)) {
    report.provider!.counter_reason = null;
    report.limitations.push("Manual readings retain their provenance inside a matching meter window; unmatched measurements remain standalone. Approximate dates are included only when explicitly accepted for that manual interval.");
  }
  if (adapter.id === "claude") {
    // The one shared estimate. Kept beside the measured totals, never added into them.
    const capacity = claudeCapacity(ctx, account, measurements, probeEvidence, { since: scanStart, until: scanEnd });
    report.claude_code_capacity = claudeCodeCapacitySummary(selectClaudeCodeCapacityReport(capacity,
      { since: options.since, untilExclusive: end }));
    attachClaudeCapacity(ctx.sqlite, report.windows ?? [], counterKind, counterMinutes, () => capacity);
    if (report.claude_code_capacity?.weekly_capacity_tokens.value != null) {
      report.limitations.push("The Claude Code capacity figure is a conditional token equivalent: it divides the recognised Claude Code traffic by the provider's product share and weekly utilization. The provider does not confirm that its product share is a share of raw tokens.");
    }
  }
  return report;
}

export function handleSubscriptionAccounting(ctx: Context, req: Request): Response {
  if (req.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  try {
    const params = new URL(req.url).searchParams;
    const options = { ...accountingOptions(params), counter: params.get("counter") || undefined };
    return Response.json(buildSubscriptionAccountingReport(ctx, params.get("provider") ?? "", options));
  } catch (error) {
    if (error instanceof SubscriptionFactsPending || error instanceof ProbeAccountIndexUnavailable) throw error;
    if (error instanceof ProbeAccountReadLimitExceeded)
      return Response.json({ error: error.code }, { status: 503 });
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
