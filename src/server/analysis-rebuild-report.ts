import type { Database } from "bun:sqlite";
import { readLedgerSums, sumVendors, type LedgerSum } from "./ledger-sums";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { CodexLedgerNotReady } from "../db/codex-price-ledger";
import type { RebuildDateRange, RebuildMode, RebuildScope } from "../shared/analysis-rebuild";
import type { RebuildAccount } from "../shared/rebuild-accounts";
import type { RevisionSnapshot, SyncRunResult, VendorSyncResult, VendorId } from "../sync/contracts";
import { TOKEN_BUCKETS, type TokenBucket } from "./subscription-accounting-adapters";
import { captureRebuildAccountTotals, type RebuildAccountTokenSnapshot, type RebuildAccountTotalsContext } from "./rebuild-account-totals";
import {captureAccountPrices,unavailableAccountPrices,accountPriceDelta,type RebuildAccountPrices} from "./rebuild-account-prices";
import {unavailableSourceImpact} from "../sync/source-impact";

const MAX_SOURCE_ATTEMPTS=8;
const MAX_PHASE_ATTEMPTS=12;
const MAX_WARNING_VALUES=32;
const MAX_GAP_EXAMPLES=8;
/** The ledgers' token buckets, the same for every provider. */
const METRICS=["calls","uncached","cache_read","write_5m","write_1h","write_unknown","out","thinking"] as const;

export interface ExactAggregateMetric {
  status:"available"|"unavailable";
  value:string|null;
  unit:"integer-count";
  reason?:string;
}
export interface AggregateSnapshot {
  status:"captured"|"unavailable";
  capturedAt:string|null;
  verification:"verified-current"|"unverified"|"unavailable";
  reason:string|null;
  source:{table:"ledgers";columns:string[];coverageStatus:string|null;scope:"declared-selected-scope"};
  vendors:Array<{vendor:string;metrics:Record<string,ExactAggregateMetric>;provenance:"ledgers"}>;
}
export interface PhaseAttempt {
  attempt:number;startedAt:string;finishedAt:string|null;outcome:"running"|"success"|"failure";
  wallElapsedMs:number|null;timingSemantics:"wall-clock-including-process-downtime";
}
export interface PhaseSummary {
  attempts:PhaseAttempt[];
  totals:{attempts:number;successes:number;failures:number};
}
export interface ResolvedDirtyRange {vendor:string;from:string;to:string}
export interface AccountTotalsBoundary {
  capturedAt:string|null;
  accounts:RebuildAccountTokenSnapshot[];
}
export interface AccountTotalsDelta {
  vendor:string;account:string;status:"available"|"unavailable";reason:string|null;
  buckets:Record<TokenBucket,string>|null;calls:string|null;
}
export interface RebuildAccountTotals {
  scope:"declared-selected-accounts";
  before:AccountTotalsBoundary;after:AccountTotalsBoundary|null;delta:AccountTotalsDelta[]|null;
}
export interface AnalysisRebuildReport {
  version:2;
  generation:number;
  requested:{scope:RebuildScope;range:RebuildDateRange|null;timeBounds:{from:string;untilExclusive:string}|null;mode?:RebuildMode;requestedAt?:string;vendors?:VendorId[];
    accounts?:RebuildAccount[]; meters?:"archive"; accountScope?:"usage-with-existing-meters"|"usage-with-archived-counters"};
  adoptedLegacy:boolean;
  lifecycle:{state:string;phase:"sources"|"summaries"|"reports"|null;updatedAt:string};
  phases:Record<"sources"|"summaries"|"reports",PhaseSummary>;
  inputs:{firstAttemptBeforeRevisions:RevisionSnapshot|null;latestAfterRevisions:RevisionSnapshot|null;latestRebuildConfiguration:string|null};
  sources:Array<ReturnType<typeof sourceSummary>>;
  sourceAttempts:Array<{runId:string;status:string;startedAt:string;finishedAt:string|null;beforeRevisions:RevisionSnapshot;afterRevisions:RevisionSnapshot;
    unavailableRequiredSources:number;warnings:string[];dirtyRanges:ResolvedDirtyRange[];
    sourceImpacts?:Array<{vendor:VendorId;impact:NonNullable<VendorSyncResult["sourceImpact"]>}>}>;
  sourceAttemptTotals:{attempts:number;successes:number;failures:number;gapOccurrences:number;warningOccurrences:number};
  lastRecordedSourceRunId:string|null;
  resolvedDirtyRanges:ResolvedDirtyRange[];
  unresolvedDirtyVendors:string[];
  dependencyExpansion:{basis:"actual-source-dirty-ranges";outsideRequested:Array<ResolvedDirtyRange&{outside:"before"|"after"|"both"}>};
  preparedRevisionCoverage:null|{kind:"current-revision-inventory-not-dependency-expansion";capturedAt:string;entries:Array<{source:string;bucket:string;revision:number}>;excludedNonDayBuckets:number};
  warningSummary:{latest:string[];unique:string[];observedOccurrences:number;truncated:boolean};
  aggregates:{scope:"declared-selected-scope";before:AggregateSnapshot;after:AggregateSnapshot|null;delta:null|{vendors:Array<{vendor:string;metrics:Record<string,ExactAggregateMetric>}>};
    pricing:{status:"unavailable";reason:"no-shared-durable-price-aggregate"}};
  accountTotals?:RebuildAccountTotals;
  accountPrices?:RebuildAccountPrices;
  unknownSourceMetrics:{canonicalFacts:null;duplicates:null;corrections:null;basis?:"cross-copy-canonical-impact";
    reason:"not-reported-by-sync-contract"|"canonical-impact-not-reported-by-sync-contract"};
  ready:{status:"pending"|"ready";at:string|null;gate:"derived-registers-current";completed:number|null;total:number|null};
}

type JobLike={generation:number;scope:RebuildScope;range:RebuildDateRange|null;timeBounds?:{from:string;untilExclusive:string}|null;mode?:RebuildMode;
  vendors?:VendorId[];
  accounts?:RebuildAccount[];
  meters?:"archive";
  requestedAt?:string;state:string;phase?:"sources"|"summaries"|"reports";warnings?:string[];report?:AnalysisRebuildReport};

function unavailableSnapshot(reason:string):AggregateSnapshot {
  return {status:"unavailable",capturedAt:null,verification:"unavailable",reason,
    source:{table:"ledgers",columns:[],coverageStatus:null,scope:"declared-selected-scope"},vendors:[]};
}
function unavailableMetric(reason:string):ExactAggregateMetric {
  return {status:"unavailable",value:null,unit:"integer-count",reason};
}
function unavailableAccountBoundary(accounts:readonly RebuildAccount[],reason:string):AccountTotalsBoundary {
  return {capturedAt:null,accounts:accounts.map(({vendor,account})=>({vendor,account,provider:null,
    status:"unavailable",reason,buckets:null,calls:null,quality:null,provenance:null}))};
}
function captureAccountBoundary(db:Database,accounts:readonly RebuildAccount[],range:RebuildDateRange|null,
  at:string,context?:RebuildAccountTotalsContext):AccountTotalsBoundary {
  return context ? {capturedAt:at,accounts:captureRebuildAccountTotals(db,accounts,range,context)}
    : unavailableAccountBoundary(accounts,"account-configuration-not-provided");
}
function accountDelta(before:AccountTotalsBoundary,after:AccountTotalsBoundary):AccountTotalsDelta[] {
  const basis=(row:RebuildAccountTokenSnapshot)=>row.provenance && JSON.stringify({provider:row.provider,
    basis:row.provenance.basis,source:row.provenance.source,scope:row.provenance.scope,
    versions:Object.entries(row.provenance.versions).sort(([a],[b])=>a.localeCompare(b))});
  return after.accounts.map(right=>{
    const left=before.accounts.find(row=>row.vendor===right.vendor && row.account===right.account);
    const reason=left?.status!=="available" || right.status!=="available" || !left.buckets || !right.buckets
      || left.calls===null || right.calls===null ? "totals-not-available-at-both-boundaries"
      : !left.quality?.complete || !right.quality?.complete ? "quality-not-complete-at-both-boundaries"
      : !left.provenance || !right.provenance || basis(left)!==basis(right) ? "account-totals-basis-changed" : null;
    if(reason)return {vendor:right.vendor,account:right.account,status:"unavailable",reason,buckets:null,calls:null};
    return {vendor:right.vendor,account:right.account,status:"available",reason:null,
      buckets:Object.fromEntries(TOKEN_BUCKETS.map(bucket=>[bucket,(BigInt(right.buckets![bucket])-BigInt(left!.buckets![bucket])).toString()])) as Record<TokenBucket,string>,
      calls:(BigInt(right.calls!)-BigInt(left!.calls!)).toString()};
  });
}
/** Usage sums of the selected vendors and days, from the ledgers (each call counted once). */
function captureAggregates(db:Database,range:RebuildDateRange|null,at:string,selected?:readonly VendorId[]):AggregateSnapshot {
  const vendors=sumVendors().filter(vendor=>!selected || (selected as readonly string[]).includes(vendor));
  const captured:AggregateSnapshot["vendors"]=[];
  let verified=true;
  for(const vendor of vendors) {
    let rows:LedgerSum[];
    try { rows=readLedgerSums(db,{vendors:[vendor],grain:"day",...(range?{since:range.from,until:range.until}:{})}); }
    catch(error) {
      if(!(error instanceof SubscriptionFactsPending || error instanceof CodexLedgerNotReady))throw error;
      verified=false;
      captured.push({vendor,metrics:Object.fromEntries(METRICS.map(metric=>[metric,unavailableMetric("ledger-not-current-at-capture")])),provenance:"ledgers"});
      continue;
    }
    if(!rows.length)continue;
    const totals=Object.fromEntries(METRICS.map(metric=>[metric,0n])) as Record<typeof METRICS[number],bigint>;
    for(const row of rows)for(const metric of METRICS)totals[metric]+=BigInt(row[metric]);
    captured.push({vendor,provenance:"ledgers",metrics:Object.fromEntries(METRICS.map(metric=>[metric,
      {status:"available",value:totals[metric].toString(),unit:"integer-count"} satisfies ExactAggregateMetric]))});
  }
  return {status:"captured",capturedAt:at,verification:verified?"verified-current":"unverified",
    reason:verified?null:"ledger-not-current-at-capture",
    source:{table:"ledgers",columns:[...METRICS],coverageStatus:verified?"current":"pending",scope:"declared-selected-scope"},
    vendors:captured};
}
function delta(before:AggregateSnapshot,after:AggregateSnapshot) {
  const old=new Map(before.vendors.map(row=>[row.vendor,row.metrics])),fresh=new Map(after.vendors.map(row=>[row.vendor,row.metrics]));
  const vendors=[...new Set([...old.keys(),...fresh.keys()])].sort();
  return {vendors:vendors.map(vendor=>{
    const left=old.get(vendor)??{},right=fresh.get(vendor)??{};
    const names=[...new Set([...Object.keys(left),...Object.keys(right)])].sort();
    return {vendor,metrics:Object.fromEntries(names.map(name=>{
      const a=left[name],b=right[name];
      if(a?.status!=="available" || b?.status!=="available" || a.value===null || b.value===null)
        return [name,unavailableMetric("metric-not-available-at-both-boundaries")];
      return [name,{status:"available",value:(BigInt(b.value)-BigInt(a.value)).toString(),unit:"integer-count"} satisfies ExactAggregateMetric];
    }))};
  })};
}
function emptyPhase():PhaseSummary {return {attempts:[],totals:{attempts:0,successes:0,failures:0}};}
function clone<T>(value:T):T {return JSON.parse(JSON.stringify(value)) as T;}
function transition(report:AnalysisRebuildReport,state:string,phase:JobLike["phase"],at:string):void {
  const prior=report.lifecycle,priorPhase=prior.phase;
  if(prior.state==="running" && priorPhase) {
    const summary=report.phases[priorPhase],open=[...summary.attempts].reverse().find(item=>item.outcome==="running");
    if(open && (state!=="running" || phase!==priorPhase)) {
      open.finishedAt=at;open.wallElapsedMs=Math.max(0,Date.parse(at)-Date.parse(open.startedAt));
      open.outcome=state==="error"?"failure":"success";
      if(open.outcome==="failure")summary.totals.failures++;else summary.totals.successes++;
    }
  }
  if(state==="running" && phase) {
    const summary=report.phases[phase];
    if(!summary.attempts.some(item=>item.outcome==="running")) {
      summary.totals.attempts++;
      summary.attempts.push({attempt:summary.totals.attempts,startedAt:at,finishedAt:null,outcome:"running",wallElapsedMs:null,
        timingSemantics:"wall-clock-including-process-downtime"});
    }
    if(summary.attempts.length>MAX_PHASE_ATTEMPTS)summary.attempts=summary.attempts.slice(-MAX_PHASE_ATTEMPTS);
  }
  report.lifecycle={state,phase:phase??null,updatedAt:at};
}
function base(job:JobLike,at:string,legacy:boolean):AnalysisRebuildReport {
  const report:AnalysisRebuildReport={version:2,generation:job.generation,
    requested:{scope:job.scope,range:job.range,timeBounds:job.timeBounds??null,mode:job.mode,requestedAt:job.requestedAt,
      ...(job.vendors?{vendors:[...job.vendors]}:{}),
      ...(job.accounts?{accounts:clone(job.accounts),...(job.meters ? {meters:job.meters} : {}),
        accountScope:job.meters === "archive" ? "usage-with-archived-counters" as const : "usage-with-existing-meters" as const}:{})},adoptedLegacy:legacy,
    lifecycle:{state:"queued",phase:job.phase??null,updatedAt:at},phases:{sources:emptyPhase(),summaries:emptyPhase(),reports:emptyPhase()},
    inputs:{firstAttemptBeforeRevisions:null,latestAfterRevisions:null,latestRebuildConfiguration:null},sources:[],sourceAttempts:[],
    sourceAttemptTotals:{attempts:0,successes:0,failures:0,gapOccurrences:0,warningOccurrences:0},lastRecordedSourceRunId:null,
    resolvedDirtyRanges:[],unresolvedDirtyVendors:[],dependencyExpansion:{basis:"actual-source-dirty-ranges",outsideRequested:[]},preparedRevisionCoverage:null,
    warningSummary:{latest:[],unique:[],observedOccurrences:0,truncated:false},
    aggregates:{scope:"declared-selected-scope",before:unavailableSnapshot(legacy?"legacy-job-adopted-after-queue-boundary":"queue-boundary-not-captured"),
      after:null,delta:null,pricing:{status:"unavailable",reason:"no-shared-durable-price-aggregate"}},
    ...(job.accounts ? {accountTotals:{scope:"declared-selected-accounts" as const,
      before:unavailableAccountBoundary(job.accounts,legacy?"legacy-job-adopted-after-queue-boundary":"queue-boundary-not-captured"),after:null,delta:null}} : {}),
    unknownSourceMetrics:{canonicalFacts:null,duplicates:null,corrections:null,basis:"cross-copy-canonical-impact",reason:"canonical-impact-not-reported-by-sync-contract"},
    ready:{status:"pending",at:null,gate:"derived-registers-current",completed:null,total:null}};
  return report;
}

export function createAnalysisRebuildReport(db:Database,job:JobLike,now=new Date(),context?:RebuildAccountTotalsContext):AnalysisRebuildReport {
  const at=now.toISOString(),report=base(job,at,false);
  report.aggregates.before=job.accounts ? unavailableSnapshot("ledger-sums-carry-no-account-the-account-totals-report-it") : captureAggregates(db,job.range,at,job.vendors);
  if(job.accounts)report.accountTotals!.before=captureAccountBoundary(db,job.accounts,job.range,at,context);
  if(job.accounts)report.accountPrices={scope:"declared-selected-accounts",before:captureAccountPrices(db,job.accounts,job.range,at,context),after:null,delta:null};
  transition(report,job.state,job.phase,at);
  return report;
}
export function evolveAnalysisRebuildReport(db:Database,current:JobLike,next:JobLike,now=new Date()):AnalysisRebuildReport {
  const at=now.toISOString(),report=clone(current.report??base(current,at,true));
  transition(report,next.state,next.phase,at);
  if(next.warnings) {
    report.warningSummary.latest=next.warnings.slice(0,MAX_WARNING_VALUES);
    report.warningSummary.unique=[...new Set([...report.warningSummary.unique,...next.warnings])].slice(-MAX_WARNING_VALUES);
    report.warningSummary.truncated=report.warningSummary.truncated || next.warnings.length>MAX_WARNING_VALUES;
  }
  report.lifecycle.updatedAt=at;
  return report;
}
function reported(value:unknown):number|null {
  return typeof value==="number" && Number.isSafeInteger(value) && value>=0?value:null;
}
function strings(value:unknown):string[] {return Array.isArray(value)?value.filter(item=>typeof item==="string") as string[]:[];}
function evidence(value:unknown):unknown {
  if(value===null || ["string","number","boolean"].includes(typeof value))return value;
  if(Array.isArray(value))return value.slice(0,8).map(evidence);
  if(typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).slice(0,8).map(([key,item])=>[key,evidence(item)]));
  return String(value);
}
function sourceSummary(vendor:VendorSyncResult,runId="") {
  const reparse=vendor.diagnostics?.reparse as {unavailable?:unknown[]}|undefined;
  const mirror=vendor.diagnostics?.mirror as {warnings?:unknown}|undefined;
  const warningValues=[...strings(mirror?.warnings),...strings(vendor.diagnostics?.warnings)];
  const unavailable=Array.isArray(reparse?.unavailable)?reparse!.unavailable!:[];
  return {vendor:vendor.vendor,status:vendor.status,error:vendor.error,dirtyRange:vendor.dirtyRange,
    sourceImpact:clone(vendor.sourceImpact??unavailableSourceImpact("legacy-sync-result-without-source-impact")),
    counters:{processedInputs:{value:reported(vendor.processedInputs),meaning:"adapter-reported-inputs"},
      skippedInputs:{value:reported(vendor.skippedInputs),meaning:"adapter-reported-skips"},
      adapterWrittenRows:{value:reported(vendor.writtenRows),meaning:"adapter-or-publication-reported-rows-not-canonical-facts"},
      canonicalFacts:{value:null,reason:"not-reported-by-sync-contract"},duplicates:{value:null,reason:"not-reported-by-sync-contract"},
      corrections:{value:vendor.sourceImpact?.sourceCorrections.value??null,
        reason:vendor.sourceImpact?.sourceCorrections.reason??(vendor.sourceImpact?null:"not-reported-by-sync-contract"),
        meaning:"source-record-semantic-corrections"}},warnings:warningValues.slice(0,MAX_WARNING_VALUES),
    gaps:{count:unavailable.length,examples:unavailable.slice(0,MAX_GAP_EXAMPLES).map(evidence),provenance:"diagnostics.reparse.unavailable"},
    provenance:{runId,diagnosticKeys:Object.keys(vendor.diagnostics??{}).sort()}};
}
function mergeRanges(current:ResolvedDirtyRange[],incoming:ResolvedDirtyRange[]):ResolvedDirtyRange[] {
  const sorted=[...current,...incoming].sort((a,b)=>a.vendor.localeCompare(b.vendor)||Date.parse(a.from)-Date.parse(b.from)||Date.parse(a.to)-Date.parse(b.to));
  const out:ResolvedDirtyRange[]=[];
  for(const range of sorted) {
    const last=out.at(-1);
    if(last && last.vendor===range.vendor && Date.parse(range.from)<=Date.parse(last.to))
      last.to=Date.parse(range.to)>Date.parse(last.to)?range.to:last.to;
    else out.push({...range});
  }
  return out;
}
function expansion(ranges:ResolvedDirtyRange[],bounds:AnalysisRebuildReport["requested"]["timeBounds"]) {
  if(!bounds)return [];
  return ranges.flatMap(range=>{
    const before=Date.parse(range.from)<Date.parse(bounds.from),after=Date.parse(range.to)>=Date.parse(bounds.untilExclusive);
    return before||after?[{...range,outside:before&&after?"both" as const:before?"before" as const:"after" as const}]:[];
  });
}
export function recordSourceAttemptInReport(db:Database,input:AnalysisRebuildReport,result:SyncRunResult,warnings:string[],unavailable:number,now=new Date()):AnalysisRebuildReport {
  const report=clone(input),at=now.toISOString();
  if(report.lastRecordedSourceRunId===result.runId)return report;
  const dirtyRanges=result.vendors.flatMap(vendor=>vendor.dirtyRange?[{vendor:vendor.vendor,...vendor.dirtyRange}]:[]);
  report.unresolvedDirtyVendors=[...new Set([...(report.unresolvedDirtyVendors??[]),
    ...result.vendors.filter(vendor=>vendor.dataChanged && !vendor.dirtyRange).map(vendor=>vendor.vendor)])].sort();
  report.sourceAttemptTotals.attempts++;
  if(result.status==="success" && unavailable===0)report.sourceAttemptTotals.successes++;else report.sourceAttemptTotals.failures++;
  report.sourceAttemptTotals.gapOccurrences+=unavailable;
  report.sourceAttemptTotals.warningOccurrences+=warnings.length;
  report.sourceAttempts.push({runId:result.runId,status:result.status,startedAt:result.startedAt,finishedAt:result.finishedAt,
    beforeRevisions:result.beforeRevisions,afterRevisions:result.afterRevisions,unavailableRequiredSources:unavailable,
    warnings:warnings.slice(0,MAX_WARNING_VALUES),dirtyRanges,
    sourceImpacts:result.vendors.map(vendor=>({vendor:vendor.vendor,
      impact:clone(vendor.sourceImpact??unavailableSourceImpact("legacy-sync-result-without-source-impact"))}))});
  if(report.sourceAttempts.length>MAX_SOURCE_ATTEMPTS)report.sourceAttempts=report.sourceAttempts.slice(-MAX_SOURCE_ATTEMPTS);
  report.lastRecordedSourceRunId=result.runId;
  report.sources=result.vendors.map(vendor=>sourceSummary(vendor,result.runId));
  report.inputs.firstAttemptBeforeRevisions??=result.beforeRevisions;
  report.inputs.latestAfterRevisions=result.afterRevisions;
  report.inputs.latestRebuildConfiguration=result.rebuildConfiguration??report.inputs.latestRebuildConfiguration;
  report.resolvedDirtyRanges=mergeRanges(report.resolvedDirtyRanges,dirtyRanges);
  report.dependencyExpansion={basis:"actual-source-dirty-ranges",outsideRequested:expansion(report.resolvedDirtyRanges,report.requested.timeBounds)};
  report.warningSummary.latest=warnings.slice(0,MAX_WARNING_VALUES);
  const unique=[...new Set([...report.warningSummary.unique,...warnings])];
  report.warningSummary.truncated=report.warningSummary.truncated || unique.length>MAX_WARNING_VALUES || warnings.length>MAX_WARNING_VALUES;
  report.warningSummary.unique=unique.slice(-MAX_WARNING_VALUES);
  report.warningSummary.observedOccurrences+=warnings.length;
  report.lifecycle.updatedAt=at;
  return report;
}
export function finalizeAnalysisRebuildReport(db:Database,input:AnalysisRebuildReport,completed:number,total:number,now=new Date(),context?:RebuildAccountTotalsContext):AnalysisRebuildReport {
  const report=clone(input),at=now.toISOString(),after=report.requested.accounts
    ? unavailableSnapshot("ledger-sums-carry-no-account-the-account-totals-report-it")
    : captureAggregates(db,report.requested.range,at,report.requested.vendors);
  report.aggregates.after=after;
  report.aggregates.delta=delta(report.aggregates.before,after);
  if(report.requested.accounts) {
    report.accountTotals??={scope:"declared-selected-accounts",
      before:unavailableAccountBoundary(report.requested.accounts,"legacy-job-adopted-after-queue-boundary"),after:null,delta:null};
    report.accountTotals.after=captureAccountBoundary(db,report.requested.accounts,report.requested.range,at,context);
    report.accountTotals.delta=accountDelta(report.accountTotals.before,report.accountTotals.after);
    report.accountPrices??={scope:"declared-selected-accounts",
      before:unavailableAccountPrices(report.requested.accounts,"legacy-job-adopted-after-queue-boundary"),after:null,delta:null};
    report.accountPrices.after=captureAccountPrices(db,report.requested.accounts,report.requested.range,at,context);
    report.accountPrices.delta=accountPriceDelta(report.accountPrices.before,report.accountPrices.after);
  }
  report.ready={status:"ready",at,gate:"derived-registers-current",completed,total};
  report.lifecycle.updatedAt=at;
  return report;
}
