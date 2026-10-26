import { withContextPreview, contextRequested } from "./codex-context-preview";
import { assignSourceMachines } from "./source-machines";
import { CODEX_COUNTERS, CODEX_WINDOW_MINUTES, codexHeadlineWindowMinutes, isCodexWindowMinutes } from "../shared/codex-counters";
import { hasCurrentSchema, readCurrentSubject } from "./current/store";
import { loadAccountResolver, type AccountResolver, type IdentityDeclaration } from "./account-resolver";
import { codexAccountSelector } from "./codex-source-account";
import type { SourceDeclaration } from "./archive-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { subscriptionDeclarations } from "./capacity-equivalents";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import type { CodexRegisterDay } from "../db/usage-price-read-codex";
import { codexUsagePriceReadiness, usagePriceSourcesStamp } from "../db/usage-price-read-subscription";
import type { UsagePriceAmount } from "../db/usage-price-totals";
import { isCodexInternalReview } from "../shared/codex-internal";
import { attachWindowEvidence } from "./subscription-evidence";
import { CODEX_ANALYSIS_PROVIDER } from "../shared/subscription-accounting";
import type { CodexAccountingReport, CodexAccountingOptions, AmountCoverage, CodexComparisonWindow, CodexTrafficPeriod } from "../shared/codex-accounting";
export type { CodexAccountingReport, CodexAccountingOptions } from "../shared/codex-accounting";
import { SELECT_ONE_SUBSCRIPTION } from "../shared/subscription-accounting";
import type { Database } from "bun:sqlite";
import { codexLedgerCompatibilityDays,codexLedgerReadContext,readCodexLedgerOwnedSeries,
  ledgerPresentationNumber,type CodexLedgerReadContext,type OwnedGroup } from "../db/codex-ledger-adapters";
import { readCodexLedgerPieceSums, readCodexLedgerPublishedBands, readCodexLedgerSources } from "../db/codex-price-ledger";
import { deriveCodexLedgerGroups, type CODEX_LEDGER_VARIANTS } from "../db/codex-price-ledger-read";
import { codexEventOwner } from "./codex-event-owner";
import { normEraKey } from "./eras";
import { decimal,multiply } from "../db/price-ledger-exact";
import type { LedgerBaseRule } from "./codex-ledger-policy";
import type { RateCard } from "./pricing";
import type { EraIndex } from "./eras";
import { calibrateCodex, type CalibrationIntervalUsage, type CodexProbe } from "./codex-calibration";
import { preparedProbeAccountIndexReady, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { codexLimitCounter, codexVisibleLimitWindows, readCodexLimitWindows } from "./codex-limit-windows";
import { comparisonWindow, intervalSums } from "./window-usage-presentation";
import { readWindowSums } from "./window-usage-read";
import { referenceFingerprint } from "./window-usage-reference";
import { windowEventReader } from "./window-usage-events";
import { windowSumsFromLedgers } from "./window-usage-ledger-sums";
import { type WindowSums, type WindowSumsPart } from "./window-usage-contracts";
import { cyclePromotion } from "./codex-promotions";
import { capacityContext } from "./codex-capacity-context";
import { loadPlans, type PlansConfig } from "./plans";
import { loadPlansCatalog, type PlansCatalog } from "./plans-catalog";
import { codexTrafficPeriods, historicalTrafficProbes } from "./codex-traffic-periods";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { codexSourceHomes } from "./capacity-equivalents";
import {
  CODEX_BILLING_BASES, isAccountingDay, resolveCodexAccountingConfig, prepareCodexPricing,
  type CodexBillingBasis,
} from "./codex-accounting-pricing";

/** Current published card only: choosing a meter never revisits source readings. */
export function currentCodexWindowMinutes(sqlite: Database, account?: string) {
  const current = account && hasCurrentSchema(sqlite) ? readCurrentSubject(sqlite, "codex", account.toLowerCase()) : null;
  const minutes = codexHeadlineWindowMinutes((current?.limits ?? []).map(limit => ({
    limit_id: limit.group ?? "", window_minutes: limit.window_minutes, ts: limit.measured_at,
  })));
  return isCodexWindowMinutes(minutes) ? minutes : 10080;
}

export function accountingOptions(params: URLSearchParams, now = new Date(), maxDays = 36600): CodexAccountingOptions {
  const today = now.toISOString().slice(0, 10);
  const since = params.get("since") ?? today, until = params.get("until") ?? today;
  if (!isAccountingDay(since) || !isAccountingDay(until) || since > until) throw new Error("Expected ordered YYYY-MM-DD since/until dates");
  if ((Date.parse(until) - Date.parse(since)) / 86400000 + 1 > maxDays) throw new Error(`Maximum range is ${maxDays} days`);
  const referenceDay = params.get("reference_day");
  if (referenceDay !== null && !isAccountingDay(referenceDay)) throw new Error("Expected YYYY-MM-DD reference_day");
  const minutes = params.get("window_minutes");
  if (minutes !== null && !CODEX_WINDOW_MINUTES.some(value => String(value) === minutes)) throw new Error("Expected window_minutes 300 or 10080 or 43200");
  const detailCycle = params.get("detail_cycle");
  if (detailCycle !== null && (!detailCycle || detailCycle.length > 2048 || !params.get("account")?.trim()
    || ["all", "__all__"].includes(params.get("account")!.trim().toLowerCase()) || params.get("project"))) {
    throw new Error("Cycle detail requires one account, no project filter and a cycle identifier (max 2048 characters)");
  }
  return { since, until, ...(detailCycle ? { detail_cycle: detailCycle } : {}), ...(referenceDay ? { reference_day: referenceDay } : {}), account: params.get("account")?.trim().toLowerCase() || undefined,
    project: params.get("project")?.trim() || undefined, ...(minutes ? { window_minutes: Number(minutes) as 300 | 10080 | 43200 } : {}) };
}

const emptyAmount = (): AmountCoverage => ({ value: null, priced_subtotal: 0, status: "empty",
  priced_events: 0, unpriced_events: 0, priced_tokens: 0, unpriced_tokens: 0, reasons: {} });
const emptyAmounts = (): Record<CodexBillingBasis, AmountCoverage> => ({ chatgpt_credits: emptyAmount(), api_equivalent_usd: emptyAmount() });
const emptyNormalization = () => ({ standard_api_usd: emptyAmount(), normalized_usd: emptyAmount(), standard_credits: emptyAmount(), extra_credits: emptyAmount() });


/* ------------------------------------------------------------------------------------- */
/* Register-backed collection (WP4c). Whole days and hours come from the ledger sums; only */
/* the parts of hours a counter boundary cuts are summed from the ledger's calls.          */
/* ------------------------------------------------------------------------------------- */

type ReasonMap = Record<string, { events: number; tokens: number }>;
/** Failures `priceCodexEvent` reports before it looks at speed, basis or rules. */
const EARLY_REASONS = new Set(["invalid_tokens", "incomplete_usage", "invalid_timestamp"]);
const SPARK_MODEL = "gpt-5.3-codex-spark";
const HOUR_MS = 3_600_000;

const pricedPart = (amount?: UsagePriceAmount) => ({ events: Number(amount?.pricedEvents ?? "0"),
  tokens: Number(amount?.pricedTokens ?? "0"), subtotal: Number(amount?.pricedSubtotal ?? "0") });
const reasonsOf = (amount?: UsagePriceAmount): ReasonMap =>
  Object.fromEntries(Object.entries(amount?.reasons ?? {})
    .map(([reason, counted]) => [reason, { events: Number(counted.events), tokens: Number(counted.tokens) }]));
function mergeReason(into: ReasonMap, reason: string, counted: { events: number; tokens: number }): void {
  if (!counted.events && !counted.tokens) return;
  const current = into[reason] ??= { events: 0, tokens: 0 };
  current.events += counted.events; current.tokens += counted.tokens;
}

/** `addAmount`, fed by a register dimension-day instead of one event at a time. */
function addCoverage(target: AmountCoverage, priced: { events: number; tokens: number; subtotal: number },
  reasons: ReasonMap): void {
  target.priced_events += priced.events;
  target.priced_tokens += priced.tokens;
  target.priced_subtotal += priced.subtotal;
  for (const [reason, counted] of Object.entries(reasons)) {
    mergeReason(target.reasons, reason, counted);
    target.unpriced_events += counted.events; target.unpriced_tokens += counted.tokens;
  }
  target.status = target.unpriced_events ? (target.priced_events ? "partial" : "unpriced")
    : target.priced_events ? "complete" : "empty";
  // A partial subtotal must never masquerade as the whole requested quantity.
  target.value = target.status === "complete" ? target.priced_subtotal : null;
}

/**
 * The reason `normalizeCodexEvent` reports, which is the actual credit price's reason, then the
 * standard credit price's, then the standard API price's.
 *
 * Within one dimension and day an event can only fail in three ways, and each variant sees the
 * same three: a shared check before speed and rules (`priceCodexEvent` reports the same reason
 * for every basis), a positive cache-write counter (which only a credit price refuses, and which
 * therefore wins the chain), or a missing dated rule, which is a property of the dimension and
 * day rather than of the event. Mapping a variant's own reasons onto those three classes
 * reproduces the chain without revisiting an event.
 */
function unifiedReasons(row: CodexRegisterDay, variant: string): ReasonMap {
  const own = reasonsOf(row.variants[variant]);
  if (row.speed === "unknown") {
    const fallback = isCodexInternalReview(row.model) ? "missing_rate" : "unknown_speed";
    const merged: ReasonMap = {};
    for (const [reason, counted] of Object.entries(own))
      mergeReason(merged, fallback === "unknown_speed" && EARLY_REASONS.has(reason) ? reason : fallback, counted);
    return merged;
  }
  const merged: ReasonMap = {};
  const other = { events: 0, tokens: 0 };
  for (const [reason, counted] of Object.entries(own)) {
    if (EARLY_REASONS.has(reason)) mergeReason(merged, reason, counted);
    else { other.events += counted.events; other.tokens += counted.tokens; }
  }
  // The cache-write class is all or nothing for a variant: either its rule prices those events
  // or none of them, so the credit price's own count identifies the whole class.
  const write = reasonsOf(row.variants[actualCreditVariant(row.speed)]).cache_write_semantics_unknown;
  if (write && other.events >= write.events && write.events > 0) {
    mergeReason(merged, "cache_write_semantics_unknown", write);
    mergeReason(merged, "missing_rate", { events: other.events - write.events, tokens: other.tokens - write.tokens });
  } else mergeReason(merged, "missing_rate", other);
  return merged;
}

/** Every event of an unusable-speed dimension is unpriced at its actual speed, under that chain. */
function unusableSpeedReasons(row: CodexRegisterDay): ReasonMap {
  const api = row.variants.api_standard;
  const merged = unifiedReasons(row, "api_standard");
  mergeReason(merged, isCodexInternalReview(row.model) ? "missing_rate" : "unknown_speed",
    { events: Number(api?.pricedEvents ?? "0"), tokens: Number(api?.pricedTokens ?? "0") });
  return merged;
}

/** Each `normalization` measure and the register variant that carries its amount. */
const NORMALIZATION_VARIANTS = [["standard_api_usd", "api_standard"], ["normalized_usd", "normalized_usd"],
  ["standard_credits", "credits_standard"], ["extra_credits", "extra_credits"]] as const;

/** The register variant holding the credit price at the event's own speed. */
const actualCreditVariant = (_speed: string) => "credits_actual";

function accountingLedger(sqlite:Database,card:RateCard,homes:Map<string,string>,declarations:readonly SourceDeclaration[],range:import("../db/codex-price-ledger").LedgerRange,referenceDay?:string) {
  const sourceHomes=codexSourceHomes(homes);
  // Calls are valued at a reference day when read (codex-ledger-reference.ts): there is nothing to prepare.
  const ledger={...codexLedgerReadContext(card),referenceDay};
  const readiness=codexUsagePriceReadiness(sqlite,{...ledger,range,
    sourcesStamp:usagePriceSourcesStamp(sourceHomes,declarations,ARCHIVE_LOGICAL_ROOT)});
  if(readiness.state!=="ready") throw new SubscriptionFactsPending(
    `Codex usage prices are awaiting background preparation (${readiness.reason})`,"codex");
  return {ledger,readiness};
}

/** Standard-normalized USD of each (account, subject), summed from register rows. */
type SubjectNormalized = Map<string,{account:string|null;subject:string|null;normalized_usd:AmountCoverage}>;
function addSubjectNormalized(subjects:SubjectNormalized,row:CodexRegisterDay):void {
  const key=JSON.stringify([row.account,row.subject]);
  const subject=subjects.get(key)??{account:row.account,subject:row.subject??null,normalized_usd:emptyAmount()};
  addCoverage(subject.normalized_usd,pricedPart(row.variants.normalized_usd),unifiedReasons(row,"normalized_usd"));
  subjects.set(key,subject);
}
const subjectList=(subjects:SubjectNormalized):CodexAccountingReport["subjects"]=>[...subjects.values()]
  .sort((a,b) => (a.account ?? "").localeCompare(b.account ?? "") || (a.subject ?? "").localeCompare(b.subject ?? ""));
/** The checks the report makes before it reads: valid ordered days and Codex events with a timestamp. */
function requireAccountingInput(sqlite:Database,options:{since:string;until:string}):string {
  accountingOptions(new URLSearchParams({ since: options.since, until: options.until }), new Date(), 36600);
  if (!(sqlite.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).some(r => r.name === "ts"))
    throw new Error("Codex raw events are unavailable; synchronize the local index first");
  return new Date(Date.parse(options.until) + 86400000).toISOString().slice(0, 10);
}

/**
 * The report's `subjects` without the rest of it (no quota comparison, every account, no project): Standard-normalized USD
 * per account and subject of the selected calls of `[since, until]` (UTC instants), from the same owned register rows.
 */
export function codexSubjectNormalized(sqlite:Database,card:RateCard,options:{since:string;until:string},homeToSubId=new Map<string,string>(),
  resolver:AccountResolver=loadAccountResolver(sqlite),declarations:readonly SourceDeclaration[]=subscriptionDeclarations(homeToSubId)):CodexAccountingReport["subjects"] {
  const toExclusive=requireAccountingInput(sqlite,options);
  return sqlite.transaction(() => {
    const range={fromMs:Date.parse(options.since),toMs:Date.parse(toExclusive)};
    const {ledger}=accountingLedger(sqlite,card,homeToSubId,declarations,range);
    const subjects:SubjectNormalized=new Map();
    // Standard remains present for the context preview's stored-value coverage check.
    for(const row of codexLedgerCompatibilityDays(readCodexLedgerOwnedSeries(sqlite,range,resolver,ledger,["api_standard","normalized_usd"] as const,{coarse:true}), ["normalized_usd"]))
      if(row.selected) addSubjectNormalized(subjects,row);
    return subjectList(subjects);
  }).deferred();
}

/**
 * The report's native counter calibration models of one account (`calibration.models`), without the rest of it: the stored windows
 * and readings of `[since, until]` and their interval sums, calibrated as the report calibrates them. Spark calls, which the
 * report lists beside a model as `excluded_separate_counter_events`, are not counted here (that field reads 0).
 */
export function codexWindowCalibrationModels(sqlite:Database,card:RateCard,options:{since:string;until:string;account:string;windowMinutes?:300|10080|43200;calibrationRange?:{from:string;until:string}},
  homeToSubId=new Map<string,string>()):ReturnType<typeof calibrateCodex>["models"] {
  const resolver=loadAccountResolver(sqlite),declarations=subscriptionDeclarations(homeToSubId);
  const config = prepareCodexPricing(resolveCodexAccountingConfig(card));
  const toExclusive=requireAccountingInput(sqlite,options);
  const scanSince=new Date(Date.parse(options.since) - 7 * 86400000).toISOString().slice(0, 10);
  const scanUntil=new Date(Date.parse(toExclusive) + 7 * 86400000).toISOString().slice(0, 10);
  return sqlite.transaction(() => {
    const {ledger}=accountingLedger(sqlite,card,homeToSubId,declarations,{fromMs:Date.parse(scanSince),toMs:Date.parse(scanUntil)});
    // The report's reading of the account's probes refuses first while their index is prepared: the same answer here.
    if(!preparedProbeAccountIndexReady(sqlite)) throw new ProbeAccountIndexUnavailable();
    const comparison=storedWindows(sqlite,card,resolver,options,options.windowMinutes??10080,toExclusive,ledger.referenceDay);
    const readings=options.calibrationRange ? comparison.readings.filter(p=>Date.parse(p.ts)>=Date.parse(options.calibrationRange!.from) && Date.parse(p.ts)<Date.parse(options.calibrationRange!.until)) : comparison.readings;
    return calibrateCodex(config,readings,comparison.intervalUsage,0).models;
  }).deferred();
}

/**
 * The stored ledger sources an account's calls can come from (the sources its periods name; a business pool's are its
 * account's), as a range narrowing; none for every account or the pool of calls no period owns.
 */
function accountLedgerSources(sqlite:Database,resolver:AccountResolver,account?:string):{sources?:string[]} {
  const owner=account?.toLowerCase().replace(/::business$/,"");
  if(!owner || owner.startsWith("codex-unassigned"))return {};
  const named=new Set(resolver.plan("codex",owner).ranges.map(range=>range.source));
  return {sources:readCodexLedgerSources(sqlite,source=>named.has(normEraKey(source)))};
}

/** Metadata follows the same stored base and dated factor as the published variants. */
function appliedLedgerRules(sqlite:Database,options:CodexAccountingOptions,
  groups:readonly OwnedGroup[],ledger:CodexLedgerReadContext):CodexAccountingReport["applied_rules"] {
  const bands=readCodexLedgerPublishedBands(sqlite),rules=new Map<string,CodexAccountingReport["applied_rules"][number]>();
  // A rule follows from its band, basis and dated tier factor (model and day): each is described once, not once per group.
  const described=new Set<string>();
  for(const {group,account} of groups) {
    if(!group.selected || options.account && account?.toLowerCase()!==options.account.toLowerCase()
      || options.project && group.stored.subject!=="p:"+options.project)continue;
    for(const basis of CODEX_BILLING_BASES) {
      const standard=group.variants[basis==="chatgpt_credits"?"credits_standard":"api_standard"];
      if(!standard.pricedEvents)continue;
      const bandId=basis==="chatgpt_credits"?group.stored.credit_band:group.stored.api_band,band=bands.get(bandId);
      if(!band)throw new Error("Applied price has no published coefficient snapshot");
      const actualTier=group.tier && group.tier!=="standard" && (basis==="chatgpt_credits"
        ? group.variants.extra_credits.pricedEvents : group.variants.api_actual.pricedEvents) ? group.tier : null;
      const key=JSON.stringify([basis,bandId,actualTier&&[actualTier,group.stored.model,group.stored.day]]);
      if(described.has(key))continue;
      described.add(key);
      const base=JSON.parse(band.evidence) as LedgerBaseRule;
      const rate=(key:"in_uncached"|"in_cache_read"|"in_cache_write"|"out_total")=> {
        const value=band.rates[key];
        if(value==null)throw new Error("Published rate metadata has no confirmed coefficient");
        return ledgerPresentationNumber(decimal(value));
      };
      const rates={in_uncached:rate("in_uncached"),in_cache_read:rate("in_cache_read"),out_total:rate("out_total"),
        ...(band.rates.in_cache_write===undefined?{}:{in_cache_write:band.rates.in_cache_write===null?null:rate("in_cache_write")})};
      const remember=(tier?:string)=> {
        const factor=tier?ledger.policy.multiplier(group.stored.model,basis,tier,group.stored.day):null;
        const dated=tier?ledger.policy.resolveTierRule(group.stored.model,basis,tier,group.stored.day):null;
        if(tier && (!factor || !dated))return;
        const until=[band.validUntil,dated?.valid_until].filter((day):day is string=>!!day).sort()[0];
        const rule:CodexAccountingReport["applied_rules"][number]={
          id:`${base.id}${band.band==="long"?":long":""}${dated?`:${dated.id}`:""}`,
          model:band.model,billing_basis:basis,speed:tier??"standard",
          valid_from:[band.validFrom,dated?.valid_from].filter((day):day is string=>!!day).sort().at(-1)!,
          ...(until?{valid_until:until}:{}),verified_at:[base.verified_at,dated?.verified_at].filter((day):day is string=>!!day).sort().at(-1)!,
          sources:[...new Set([...base.sources,...dated?.sources??[]])],
          confidence:base.confidence==="user"||dated?.confidence==="user"?"user":"official",rates,
          multiplier:ledgerPresentationNumber(factor?multiply(decimal(band.multiplier),factor):decimal(band.multiplier)),
          ...(dated?.included_usage?{included_usage:dated.included_usage}:{}),
          ...((base.note||dated?.note)?{note:[base.note,dated?.note].filter(Boolean).join("\n")}:{}),
          ...(band.band==="long"?{long_context:{above_input_tokens:band.threshold!,rates}}:{}),
        };
        rules.set(JSON.stringify(rule),rule);
      };
      remember();
      if(actualTier)remember(actualTier);
    }
  }
  return [...rules.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * The Codex accounting report. Every part is a read of prepared rows: register days, stored windows
 * and their sums, including the meter history published with those windows.
 */
export function buildCodexAccountingReport(...args: Parameters<typeof computeCodexAccountingReport>): ReturnType<typeof computeCodexAccountingReport> {
  const [db,,options,,,compareQuota=true]=args;
  if (!options.project && compareQuota && !options.account && !preparedProbeAccountIndexReady(db)) throw new ProbeAccountIndexUnavailable();
  const { contextPreview = false, ...storedOptions } = options;
  args[2] = storedOptions;
  if (!contextPreview) return computeCodexAccountingReport(...args);
  return withContextPreview(args[0], () => computeCodexAccountingReport(...args), contextPreview);
}

/** Read prepared sums; exact counter edges use bounded accepted ledger events. */
function computeCodexAccountingReport(
  sqlite: Database, card: RateCard, options: CodexAccountingOptions & { contextPreview?: boolean }, homeToSubId = new Map<string, string>(), eras?: EraIndex, compareQuota = true,
  onTiming?: (phase: string, milliseconds: number) => void,
  plans: PlansConfig = {}, catalog: PlansCatalog = { provider_groups: [] },
  resolver: AccountResolver = loadAccountResolver(sqlite), declarations: readonly SourceDeclaration[] = subscriptionDeclarations(homeToSubId),
): CodexAccountingReport & { traffic_periods: CodexTrafficPeriod[] } {
  let phaseStart = performance.now();
  const timed = (phase: string) => { const now = performance.now(); onTiming?.(phase, now - phaseStart); phaseStart = now; };
  const config = prepareCodexPricing(resolveCodexAccountingConfig(card));
  // Validate direct callers as well as HTTP/CLI parameters.
  accountingOptions(new URLSearchParams({ since: options.since, until: options.until, ...(options.reference_day !== undefined ? { reference_day: options.reference_day } : {}), ...(options.window_minutes !== undefined ? { window_minutes: String(options.window_minutes) } : {}), ...(options.detail_cycle !== undefined ? { detail_cycle: options.detail_cycle, account: options.account ?? "", project: options.project ?? "" } : {}) }), new Date(), 36600);
  const windowMinutes = options.window_minutes ?? currentCodexWindowMinutes(sqlite, options.account);
  const windowKind = CODEX_COUNTERS[windowMinutes].id;
  const contextMs = Math.max(7 * 86400000, windowMinutes * 60_000);
  const toExclusive = new Date(Date.parse(options.until) + 86400000).toISOString().slice(0, 10);
  const scanSince = !compareQuota ? options.since
    : new Date(Date.parse(options.since) - contextMs).toISOString().slice(0, 10);
  const scanUntil = !compareQuota ? toExclusive
    : new Date(Date.parse(toExclusive) + contextMs).toISOString().slice(0, 10);
  return sqlite.transaction(() => {
    const columns = new Set((sqlite.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).map(r => r.name));
    if (!columns.has("ts")) throw new Error("Codex raw events are unavailable; synchronize the local index first");
    if (options.project && !columns.has("project_id")) throw new Error("Codex project attribution is unavailable");
    // Missing or stale ledger publication is explicit preparation; reads never reconstruct it.
    const {ledger}=accountingLedger(sqlite,card,homeToSubId,declarations,{fromMs:Date.parse(scanSince),toMs:Date.parse(scanUntil)},options.reference_day);
    // Capacity reads the same published cycles and sums as the rail, never the raw probe history. The meter belongs
    // to the whole account, so a project filter keeps the account's cycles and adds the project's share of each.
    const comparison = !compareQuota ? null
      : storedWindows(sqlite, card, resolver, options, windowMinutes, toExclusive, ledger.referenceDay);
    const trafficPeriods = comparison?.trafficPeriods ?? codexTrafficPeriods(historicalTrafficProbes(sqlite,
      codexAccountSelector({ sqlite,resolver,accounts:{sources:declarations} }).accountAt,
      windowMinutes, {from:scanSince,until:scanUntil}).filter(p => !options.account || p.subject === options.account.toLowerCase()),
      options.since, toExclusive, windowMinutes);
    timed("traffic periods");
    const amounts = emptyAmounts(), normalization = emptyNormalization();
    const subjects: SubjectNormalized = new Map();
    const breakdown = new Map<string,{day:string;model:string|null;speed:string;account:string|null;home:string|null;events:number;tokens:number;amounts:ReturnType<typeof emptyAmounts>;normalization:ReturnType<typeof emptyNormalization>}>();
    const funding = new Map<string,{mode:string;events:number;tokens:number;first:string;last:string}>();
    const homes = new Set<string>();
    let events=0,tokens=0,knownSpeedTokens=0,knownSpeedEvents=0,excludedMirrorEvents=0,unattributedEvents=0,sparkEvents=0;
    /** Instants where a source changes hands: a call's owner is the period covering its source and instant. */
    const accountCuts = resolver.accounts("codex").flatMap(account=>resolver.plan("codex",account).ranges.flatMap(range=>[range.from,range.until]))
      .filter(Number.isFinite);
    /**
     * Whole days from `usage_price_*`. Every measure below is a sum over days times dimensions,
     * so an ordinary read never scans events. Only the days a counter boundary cuts are read
     * per event, further down, and there are at most two of those per traffic period (§6).
     */
    // The ledger groups of the report's days, owned at their instants: the register days and the applied rules.
    // Only the sources the account's periods name can hold its calls: the read skips every other source's sums.
    const sources = accountLedgerSources(sqlite,resolver,options.account);
    const ownedGroups = readCodexLedgerOwnedSeries<typeof CODEX_LEDGER_VARIANTS>(sqlite,{fromMs:Date.parse(options.since),toMs:Date.parse(toExclusive),...sources},resolver,ledger,undefined,{coarse:true});
    const reportGroups = options.account ? ownedGroups.filter(({account})=>account?.toLowerCase()===options.account!.toLowerCase()) : ownedGroups;
    type CountedRow = Pick<CodexRegisterDay,"calls"|"tokensReported"|"speed"|"model"|"variants">;
    // Hour sums of a pricing day, read once for the report's periods and the cycles' project share.
    const hoursOf = new Map<string,OwnedGroup[]>();
    /**
     * Adds the counted calls (selected, not Spark, of the filtered project) to the spans they fall in. A boundary
     * that is not midnight splits its day between spans, so that day is counted one event at a time. Every other
     * day of a span is whole and comes from `days`, the register rows that passed the report's filters.
     */
    function addToSpans<Span extends {account:string;start:string;end:string}>(spans:readonly Span[],days:readonly CodexRegisterDay[],
      since:string,until:string,add:(span:Span,row:CountedRow)=>void): void {
      const streams = new Map<string,Array<{start:number;end:number;period:Span}>>();
      for(const period of spans) {
        const stream=streams.get(period.account)??[];
        stream.push({start:Date.parse(period.start),end:Date.parse(period.end),period});
        streams.set(period.account,stream);
      }
      for(const stream of streams.values()) stream.sort((a,b)=>a.start-b.start);
      const edgeDays = new Map<string,Set<string>>();
      for(const period of spans) for(const boundary of [period.start,period.end]) {
        const day=boundary.slice(0,10);
        if(Date.parse(boundary)===Date.parse(day)) continue;
        const known=edgeDays.get(period.account)??new Set<string>();
        known.add(day); edgeDays.set(period.account,known);
      }
      for(const row of days) {
        if(!row.account || row.model===SPARK_MODEL || edgeDays.get(row.account)?.has(row.day)) continue;
        const dayStart=Date.parse(row.day);
        const period=(streams.get(row.account)??[]).find(p=>p.start<=dayStart && p.end>=dayStart+86400000)?.period;
        if(period) add(period,row);
      }
      // A day a boundary cuts: its whole hours come from the hour sums; only the calls of an hour a
      // boundary falls inside are read one at a time.
      for(const [account,days] of edgeDays) {
        const stream=streams.get(account)??[];
        const periodAt=(time:number)=>{
          let lo=0,hi=stream.length;
          while(lo<hi) { const mid=(lo+hi)>>>1; if(stream[mid]!.start<=time) lo=mid+1; else hi=mid; }
          const match=stream[lo-1];
          return match && time<match.end ? match : undefined;
        };
        const cutHours=new Set(stream.flatMap(entry=>[entry.start,entry.end]).filter(edge=>edge%HOUR_MS!==0).map(edge=>Math.floor(edge/HOUR_MS)));
        // The hours a boundary falls inside, read once for all the account's edge days: the stored sums of their calls between
        // the boundaries (spans and account periods), valued, by hour and in time order.
        const pieces:Array<[number,number]>=[],piecesOf=new Map<number,number[]>();
        const edges=[...new Set([...stream.flatMap(entry=>[entry.start,entry.end]),...accountCuts])].sort((a,b)=>a-b);
        const reach=[...days].map(day=>Date.parse(day)),first=Math.min(...reach)-86400000,last=Math.max(...reach)+2*86400000;
        for(const hour of [...cutHours].filter(hour=>hour*HOUR_MS>=first&&hour*HOUR_MS<last).sort((a,b)=>a-b)) {
          const start=hour*HOUR_MS,end=start+HOUR_MS,points=[start,...edges.filter(at=>at>start&&at<end),end];
          for(let index=0;index+1<points.length;index++) { piecesOf.set(hour,[...piecesOf.get(hour)??[],pieces.length]); pieces.push([points[index]!,points[index+1]!]); }
        }
        const pieceRows=readCodexLedgerPieceSums(sqlite,pieces,{sources:sources.sources});
        const pieceGroups=deriveCodexLedgerGroups<typeof CODEX_LEDGER_VARIANTS>(sqlite,ledger.policy,pieceRows);
        const byPiece=new Map<number,Array<{row:typeof pieceRows[number];group:typeof pieceGroups[number]}>>();
        pieceRows.forEach((row,index)=>byPiece.set(row.piece,[...byPiece.get(row.piece)??[],{row,group:pieceGroups[index]!}]));
        for(const day of days) {
          if(day<since||day>=until) continue;
          // Hour sums of the pricing day (UTC hour of each call's instant; a call without one is in no period).
          let hours=hoursOf.get(day);
          if(!hours) { hours=readCodexLedgerOwnedSeries<typeof CODEX_LEDGER_VARIANTS>(sqlite,{since:day,until:day,grain:"hour",...sources},resolver,ledger,undefined,{coarse:true}); hoursOf.set(day,hours); }
          const cut=new Set<number>();
          const own=hours.filter(({group,account:owner})=>owner===account && group.selected && group.stored.model!==SPARK_MODEL
            && (!options.project || group.stored.subject==="p:"+options.project));
          for(const row of codexLedgerCompatibilityDays(own) as Array<CodexRegisterDay&{hour:number}>) {
            if(cutHours.has(row.hour)) { cut.add(row.hour); continue; }
            const match=periodAt(row.hour*HOUR_MS);
            if(match) add(match.period,row);
          }
          // Each piece of a cut hour counted for the span it lies in: pieces in time order within each hour, and a piece's rows
          // by their first call, so a period lists its models as they appear.
          for(const hour of cut) for(const piece of piecesOf.get(hour)??[]) {
            const at=pieces[piece]![0];
            const own:OwnedGroup[]=[];
            for(const {row,group} of byPiece.get(piece)??[]) {
              const owner=codexEventOwner(resolver.resolve("codex",row.source,null,new Date(at).toISOString()).account,row);
              if(row.day===day&&owner===account&&group.selected&&row.model!==SPARK_MODEL
                && (!options.project || row.subject==="p:"+options.project)) own.push({group,account:owner});
            }
            const match=periodAt(at);
            if(match&&own.length) for(const row of codexLedgerCompatibilityDays(own).sort((a,b)=>a.first_ts<b.first_ts?-1:a.first_ts>b.first_ts?1:0))
              add(match.period,row);
          }
        }
      }
    }
    const addTraffic = (period:CodexTrafficPeriod,row:CountedRow) => {
      const count=row.tokensReported;
      period.events+=row.calls; period.tokens+=count;
      period.fast_tokens+=row.speed==="fast"?count:0;
      period.unknown_tokens+=row.speed==="unknown"?count:0;
      const model=row.model??"?";
      period.models[model]=(period.models[model]??0)+count;
      // A period counts an event only when the standard API *and* standard credit prices exist.
      const credited=row.variants.api_standard_credited;
      if(Number(credited?.pricedEvents??"0")>0) {
        period.api+=Number(credited!.pricedSubtotal);
        period.credits+=Number(row.variants.credits_standard?.pricedSubtotal??"0");
        period.priced_events+=Number(credited!.pricedEvents);
        period.priced_tokens+=Number(credited!.pricedTokens);
      }
    };
    /** The report's totals from whole days; returns the counted rows, which the traffic periods then place. */
    function collectFromRegister(): CodexRegisterDay[] {
      const counted: CodexRegisterDay[] = [];
      for(const row of codexLedgerCompatibilityDays(reportGroups)) {
        if(options.account && row.account?.toLowerCase()!==options.account.toLowerCase()) continue;
        if(options.project && row.subject!=="p:"+options.project) continue;
        if(!row.selected) { excludedMirrorEvents+=row.calls; continue; }
        const speed=row.speed, count=row.tokensReported;
        events+=row.calls; tokens+=count;
        if(speed!=="unknown") { knownSpeedEvents+=row.calls; knownSpeedTokens+=count; }
        if(row.model===SPARK_MODEL) sparkEvents+=row.calls;
        unattributedEvents+=row.quality.unattributed_events;
        if(row.home) homes.add(row.home);
        const mode=row.billing_mode??"unknown";
        const funded=funding.get(mode)??{mode,events:0,tokens:0,first:row.first_ts,last:row.last_ts};
        funded.events+=row.calls; funded.tokens+=count;
        if(row.first_ts && row.first_ts<funded.first) funded.first=row.first_ts;
        if(row.last_ts>funded.last) funded.last=row.last_ts;
        funding.set(mode,funded);
        const key=JSON.stringify([row.day,row.model,speed,row.account,row.home]);
        let bucket=breakdown.get(key);
        if(!bucket) { bucket={day:row.day,model:row.model,speed,account:row.account,home:row.home,
          events:0,tokens:0,amounts:emptyAmounts(),normalization:emptyNormalization()}; breakdown.set(key,bucket); }
        bucket.events+=row.calls; bucket.tokens+=count;
        // At an unusable speed no actual credit price exists, so that basis is unpriced under one chain. The API
        // basis of a call that records no tier is priced at Standard (UNKNOWN_MODE_RATE_RULE); an unmapped tier is not.
        const unusable=speed==="unknown" ? unusableSpeedReasons(row) : null;
        const zero={events:0,tokens:0,subtotal:0};
        const actual: Record<CodexBillingBasis,UsagePriceAmount|undefined> = {
          chatgpt_credits: row.variants[actualCreditVariant(speed)], api_equivalent_usd: row.variants.api_actual };
        for(const basis of CODEX_BILLING_BASES) {
          const blocked=unusable && (basis==="chatgpt_credits" || !!reasonsOf(actual[basis]).unknown_speed);
          const part=blocked?zero:pricedPart(actual[basis]), because=blocked?unusable!:reasonsOf(actual[basis]);
          addCoverage(amounts[basis],part,because); addCoverage(bucket.amounts[basis],part,because);
        }
        for(const [measure,variant] of NORMALIZATION_VARIANTS) {
          const part=pricedPart(row.variants[variant]), because=unifiedReasons(row,variant);
          addCoverage(normalization[measure],part,because); addCoverage(bucket.normalization[measure],part,because);
        }
        addSubjectNormalized(subjects,row);
        counted.push(row);
      }
      timed("register days");
      return counted;
    }
    const counted=collectFromRegister();
    addToSpans(trafficPeriods,counted,options.since,toExclusive,addTraffic);
    timed("boundary days");
    // The project's traffic over each whole cycle, from the same stored day, hour and piece sums as the periods above.
    const projectUsage = new Map<string,NonNullable<CodexComparisonWindow["project_usage"]>>();
    if(options.project && comparison?.windows.length) {
      const cycles=comparison.windows.map(w=>({id:w.id,account:w.account,start:w.cycle_start??w.start,end:w.cycle_end??w.reset}));
      const dayOf=(at:number)=>new Date(Math.floor(at/86400000)*86400000).toISOString().slice(0,10);
      // Cycles at the range's edges reach beyond it; the ledger was checked for the scan range around it.
      const from=Math.max(Date.parse(scanSince),Math.min(...cycles.map(cycle=>Date.parse(cycle.start))));
      const until=Math.min(Date.parse(scanUntil),Math.max(...cycles.map(cycle=>Date.parse(cycle.end))));
      const fromDay=dayOf(from), untilDay=dayOf(until-1+86400000);
      // The report's own days are its counted rows (already the project's); only the days beyond the range are read.
      const beyond=(fromMs:number,toMs:number)=>{
        if(fromMs>=toMs) return [];
        const groups=readCodexLedgerOwnedSeries<typeof CODEX_LEDGER_VARIANTS>(sqlite,{fromMs,toMs,...sources},resolver,ledger,undefined,{coarse:true});
        return codexLedgerCompatibilityDays(options.account ? groups.filter(({account})=>account?.toLowerCase()===options.account!.toLowerCase()) : groups)
          .filter(row=>row.selected && row.subject==="p:"+options.project);
      };
      const rows=[...beyond(Date.parse(fromDay),Date.parse(options.since)),...counted,...beyond(Date.parse(toExclusive),Date.parse(untilDay))];
      timed("project days");
      for(const cycle of cycles) projectUsage.set(cycle.id,{project:options.project,events:0,tokens:0,api_standard:0,api_normalized:0,priced_tokens:0,unpriced_events:0});
      addToSpans(cycles,rows,fromDay,untilDay,(cycle,row)=>{
        const usage=projectUsage.get(cycle.id)!, api=row.variants.api_standard;
        usage.events+=row.calls; usage.tokens+=row.tokensReported;
        // The same Standard API value and credit-normalized value the cycle's own sums carry.
        usage.api_standard+=Number(api?.pricedSubtotal??"0");
        usage.api_normalized+=Number(row.variants.window_normalized?.pricedSubtotal??"0");
        usage.priced_tokens+=Number(api?.pricedTokens??"0");
        usage.unpriced_events+=Number(api?.unpricedEvents??"0");
      });
      timed("project share");
    }
    const windows = comparison?.windows ?? null;
    const calibration = comparison ? calibrateCodex(config, comparison.readings, comparison.intervalUsage, sparkEvents) : null;
    timed("calibration");
    const decoratedWindows = windows ? decorateCodexWindows(sqlite, windows, windowMinutes, plans, catalog, eras)
      .map(w => projectUsage.has(w.id) ? { ...w, project_usage: projectUsage.get(w.id)! } : w) : null;
    timed("window evidence");
    const appliedRules = appliedLedgerRules(sqlite,options,reportGroups,ledger);
    timed("applied rules");
    return {
      schema_version: 1, scope: options, quantity_basis: "indexed_token_events",
      provider: { ...CODEX_ANALYSIS_PROVIDER, counter: windowKind,
        counters: CODEX_WINDOW_MINUTES.map(minutes => CODEX_COUNTERS[minutes]),
        counter_reason: windows?.length ? null : "No matched cycles for this counter in the selected range. Missing readings do not establish that the historical plan lacked this limit." },
      tier_evidence: "configured", quota_verified: false, source: "raw-events",
      account_attribution: "account-periods",
      deduplication: "existing_source_archive_policy", rule_source: card.codex_accounting === undefined && card.codex_ledger_policy === undefined ? "shipped" : "configured",
      funding: [...funding.values()],
      events, tokens, known_speed_events: knownSpeedEvents, known_speed_tokens: knownSpeedTokens,
      unknown_speed_events: events - knownSpeedEvents, unknown_speed_tokens: tokens - knownSpeedTokens,
      excluded_mirror_events: excludedMirrorEvents, unattributed_events: unattributedEvents, source_home_count: homes.size,
      amounts, normalization, breakdown: [...breakdown.values()].sort((a, b) => JSON.stringify([a.day,a.model,a.speed,a.account,a.home]).localeCompare(JSON.stringify([b.day,b.model,b.speed,b.account,b.home]))),
      windows: decoratedWindows,
      meter_history: comparison?.meterHistory ?? { session_first: null, periodic_first: null },
      traffic_periods: trafficPeriods,
      calibration,
      applied_rules: appliedRules,
      subjects: subjectList(subjects),
      limitations: ["Configured tier is not confirmed billed tier.", "Reference estimates exclude contract discounts, tools and regional uplifts.",
        "Existing source/archive deduplication does not certify complete multi-machine traffic or fork accounting.",
        "Credits are not a measured subscription percentage.", "Positive cache-write counters remain unpriced until their input overlap is established.",
        "5h, weekly and 30-day percentages are independent denominators. Never sum their capacities or compare their per-point values as one allowance.",
        ...(windowMinutes !== 10080 ? ["Matching uses account, plan and event timestamps. The event-level stored meter_reset identifies the weekly counter and is not an anchor for this counter."] : [])],
    };
  }).deferred();
}

/**
 * The windows of the requested counter whose cycles overlap the requested days, from the stored
 * register and its stored sums, and the readings of those days with their interval sums for the
 * calibration. A reference-day valuation is the stored variant when the day's coefficients are the
 * stored ones (the configured day, today by default). Two bounded exceptions read the events of their
 * own window only: a cycle's time axis (`detail_cycle`) and a reference day with other coefficients,
 * whose calls are valued at `ledgerDay` as they are read.
 */
function storedWindows(sqlite: Database, card: RateCard, resolver: AccountResolver, options: CodexAccountingOptions,
  windowMinutes: 300 | 10080 | 43200, toExclusive: string, ledgerDay?: string) {
  const since = Date.parse(options.since), until = Date.parse(toExclusive);
  const contextMs = Math.max(7 * 86400000, windowMinutes * 60_000);
  const historySince = since - contextMs, historyUntil = until + contextMs;
  const accounts = options.account ? [options.account.toLowerCase()] : resolver.accounts("codex").map(account => account.toLowerCase());
  const fingerprint = options.reference_day !== undefined ? referenceFingerprint(card, "codex", options.reference_day) : null;
  const reader = options.detail_cycle !== undefined || options.reference_day !== undefined
    ? windowEventReader(sqlite, card, resolver, ledgerDay) : null;
  const windows: CodexComparisonWindow[] = [], readings: CodexProbe[] = [];
  const trafficPeriods: CodexTrafficPeriod[] = [];
  const meterHistory: NonNullable<CodexAccountingReport["meter_history"]> = { session_first: null, periodic_first: null };
  const located = new Map<string, { window: string; sums: Pick<WindowSums, "cycle" | "readings"> }>();
  for (const account of accounts) {
    const { register, overlapping, stored, visible } = storedAccountWindows(sqlite, account, windowMinutes, since, until,
      (fingerprint === null ? ["cycle", "readings"] : ["cycle", "readings", "reference"]) as Array<"cycle" | "readings" | "reference">);
    trafficPeriods.push(...storedTrafficPeriods(register, since, until));
    for (const window of register) for (const reading of window.readings) {
      const at = Date.parse(reading.ts);
      if (at < historySince || at >= historyUntil || reading.source === "manual") continue;
      const key = reading.source === "session" ? "session_first" : "periodic_first";
      if (meterHistory[key] === null || reading.ts < meterHistory[key]!) meterHistory[key] = reading.ts;
    }
    for (const window of overlapping) {
      const row = stored.get(window.id)!;
      const variant = fingerprint !== null && row.reference?.fingerprint === fingerprint ? row.reference.cycle : null;
      if (visible.has(window.id)) windows.push(reader && (fingerprint !== null && !variant || options.detail_cycle === window.id)
        ? windowSumsFromLedgers(reader, card, "codex", window, register.slice(0, register.indexOf(window)),
          { timeline: options.detail_cycle === window.id, referenceDay: ledgerDay }).comparison
        : comparisonWindow(window, variant ?? row.cycle));
      // Readings the stored sums already include: a row recomputed after a new reading is the last consistent one.
      const summed = new Set(row.readings.map(reading => reading.ts));
      for (const reading of window.readings) {
        const at = Date.parse(reading.ts);
        if (at < since || at >= until || !summed.has(reading.ts)) continue;
        readings.push({ subject: account, ts: reading.ts, kind: reading.source, plan: window.plan, used_percent: reading.percent,
          resets_at: window.reset, window_minutes: windowMinutes });
        located.set(`${account}\u0000${reading.ts}`, { window: window.id, sums: row });
      }
    }
  }
  /** Sums of `(start, end]`: within one window a difference of running sums; across a reset the rest of the first and the start of the next. */
  const intervalUsage = (start: CodexProbe, end: CodexProbe): CalibrationIntervalUsage => {
    const from = located.get(`${start.subject}\u0000${start.ts}`)!, to = located.get(`${end.subject}\u0000${end.ts}`)!;
    const parts = (from.window === to.window ? [intervalSums(from.sums, start.ts, end.ts)]
      : [intervalSums(from.sums, start.ts, null), intervalSums(to.sums, null, end.ts)]).map(part => part!);
    const sourcesSeen = new Set(parts.flatMap(part => part.homes)), models = new Set(parts.flatMap(part => part.models));
    const total = (key: "credits_low" | "api_normalized" | "unpriced_events" | "events") => parts.reduce((sum, part) => sum + part.usage[key], 0);
    return { credits: total("credits_low"), normalized: total("api_normalized"), missing: total("unpriced_events"), events: total("events"),
      sources: [...sourcesSeen].sort(), models: [...models] };
  };
  return { windows: assignSourceMachines(sqlite, windows.sort((a, b) => a.start.localeCompare(b.start))), readings, intervalUsage,
    trafficPeriods: trafficPeriods.sort((a, b) => a.start.localeCompare(b.start) || a.account.localeCompare(b.account)), meterHistory };
}

/** Clip published cycles to observed traffic coverage; never segment or reconcile source readings on a screen read. */
function storedTrafficPeriods(register: readonly ProbeLimitWindow[], since: number, until: number): CodexTrafficPeriod[] {
  const observed = register.map(window => ({ window, readings: window.readings.filter(reading => reading.source !== "manual") }))
    .filter(item => item.readings.length > 0);
  // A scheduled reset is confirmed only by readings on both sides. Drops and gaps stay partial.
  const joined = observed.map((item, index) => {
    const next = observed[index + 1];
    const reset = Date.parse(item.window.reset);
    return !!next && !item.window.endDrop && item.window.end === item.window.reset
      && reset > Date.parse(item.readings.at(-1)!.ts) && reset <= Date.parse(next.readings[0]!.ts)
      && Math.abs(reset - Date.parse(next.window.reset)) > 120000;
  });
  return observed.flatMap(({ window, readings }, index) => {
    const start = index > 0 && joined[index - 1] ? Date.parse(observed[index - 1]!.window.reset) : Date.parse(readings[0]!.ts);
    const end = joined[index] ? Date.parse(window.reset) : Math.min(Date.parse(window.end), Date.parse(readings.at(-1)!.ts));
    const from = Math.max(since, start), to = Math.min(until, end);
    if (to <= from) return [];
    return [{ account: window.account, start: new Date(from).toISOString(), end: new Date(to).toISOString(),
      start_reset: index > 0 && joined[index - 1]! && from === start, end_reset: joined[index]! && to === end,
      events: 0, tokens: 0, fast_tokens: 0, unknown_tokens: 0, api: 0, credits: 0,
      priced_tokens: 0, priced_events: 0, models: Object.create(null) as Record<string, number> }];
  });
}

/** One account's stored windows of a counter overlapping `[since, until)`, their stored sums and the visible ones. Never computes. */
function storedAccountWindows<Part extends WindowSumsPart>(sqlite: Database, account: string, windowMinutes: 300 | 10080 | 43200,
  since: number, until: number, parts: readonly Part[], windowId?: string) {
  const register = readCodexLimitWindows(sqlite, account, windowMinutes);
  const overlapping = register.filter(window => Date.parse(window.end) > since && Date.parse(window.start) < until);
  const stored = readWindowSums(sqlite, "codex", account, codexLimitCounter(windowMinutes), overlapping.filter(w => !windowId || w.id === windowId), parts);
  const visible = new Set(codexVisibleLimitWindows(overlapping).map(window => window.id));
  return { register, overlapping, stored, visible };
}

/** The plan context, promotion and evidence the capacity screens show beside each stored Codex window. */
function decorateCodexWindows(sqlite: Database, windows: CodexComparisonWindow[], windowMinutes: 300 | 10080 | 43200,
  plans: PlansConfig, catalog: PlansCatalog, eras?: EraIndex): CodexComparisonWindow[] {
  const windowKind = CODEX_COUNTERS[windowMinutes].id;
  const decorated = windows.map(w => ({ ...w, ...capacityContext(w, plans, catalog, "codex", windowKind),
    ...(w.declared_plan_meter_mismatch && w.plan_detail ? { plan_detail: w.plan_detail } : {}),
    promotion: cyclePromotion(w, plans, catalog, "codex", windowKind) }));
  attachWindowEvidence(decorated, { provider: "codex", eras, sqlite });
  return decorated;
}

/**
 * One Codex account's cycles of a counter over whole UTC days `since`–`until`, exactly as the accounting report
 * shows them, read from the stored register and its stored sums only (no ledger scan, no calibration). A window
 * without stored sums raises WindowUsagePreparing.
 */
export function codexCapacityCycles(sqlite: Database, account: string, windowMinutes: 300 | 10080 | 43200, range: { since: string; until: string },
  plans: PlansConfig, catalog: PlansCatalog, eras?: EraIndex, windowId?: string): CodexComparisonWindow[] {
  const since = Date.parse(range.since), until = Date.parse(range.until) + 86_400_000;
  const { overlapping, stored, visible } = storedAccountWindows(sqlite, account.toLowerCase(), windowMinutes, since, until, ["cycle"], windowId);
  const windows = overlapping.filter(window => visible.has(window.id) && (!windowId || window.id === windowId)).map(window => comparisonWindow(window, stored.get(window.id)!.cycle))
    .sort((a, b) => a.start.localeCompare(b.start));
  return decorateCodexWindows(sqlite, windows, windowMinutes, plans, catalog, eras);
}

/**
 * The options of an HTTP request for the report, or the reason it is refused: dates and counter as
 * `accountingOptions` checks them, and one subscription (the report reads that account's windows and calls).
 */
export function codexAccountingRequest(params: URLSearchParams): { options: CodexAccountingOptions } | { error: string } {
  let options: CodexAccountingOptions;
  try { options = accountingOptions(params); }
  catch (error) { return { error: (error as Error).message }; }
  return !options.account || ["all", "__all__"].includes(options.account) ? { error: SELECT_ONE_SUBSCRIPTION } : { options };
}

export function handleCodexAccounting(ctx: { sqlite: Database; rateCards: RateCard; homeToSubId?: Map<string, string>; eras?: EraIndex; plans?: PlansConfig; plansCatalog?: PlansCatalog; resolver?: AccountResolver; accounts?: { subscriptions?: IdentityDeclaration[]; sources?: SourceDeclaration[] } }, req: Request): Response {
  if (req.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
  const request = codexAccountingRequest(new URL(req.url).searchParams);
  if ("error" in request) return Response.json({ error: request.error }, { status: 400 });
  const { options } = request;
  try { return Response.json(buildCodexAccountingReport(ctx.sqlite, ctx.rateCards, { ...options, contextPreview: contextRequested(new URL(req.url)) }, ctx.homeToSubId, ctx.eras, true, undefined, ctx.plans ?? loadPlans(), ctx.plansCatalog ?? loadPlansCatalog(), ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.accounts?.subscriptions), ctx.accounts?.sources)); }
  catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable || error instanceof SubscriptionFactsPending) return Response.json({ status: "preparing", error: "Dane są przygotowywane w tle." },
      { status: 202, headers: { "X-Analysis": "preparing", "X-Analysis-Poll-Ms": "100", "Cache-Control": "no-store" } });
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
}
