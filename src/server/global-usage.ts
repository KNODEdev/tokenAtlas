import { withContextPreview, contextRequested } from "./codex-context-preview";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import type { Database } from "bun:sqlite";
import { GLOBAL_USAGE_MAX_DAYS, type GlobalUsageResponse, type GlobalUsageRow, type UsageAmount } from "../shared/global-usage";
import { codexSourceHomes, subscriptionDeclarations } from "./capacity-equivalents";
import { isAccountingDay, resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import type { RateCard } from "./pricing";

import type { EraIndex, EraDeclaration } from "./eras";
import type { SourceDeclaration } from "./archive-source";
import { loadAccountResolver, type AccountResolver } from "./account-resolver";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { isCodexInternalReview } from "../shared/codex-internal";
import { readCodexRegisterDays } from "../db/usage-price-read-codex";
import { codexUsagePriceReadiness, readGlobalUsagePriceDays, subscriptionUsagePriceReadiness,
  usagePriceSourcesStamp } from "../db/usage-price-read-subscription";
import { codexPricingKey } from "./codex-accounting-pricing";
import { codexLedgerReadContext, type CodexLedgerReadContext } from "../db/codex-ledger-adapters";
import { USAGE_VENDOR_IDS, type UsageVendorId } from "../sync/contracts";

export type GlobalUsageRange = { since: string; until: string; vendors?: UsageVendorId[] };

type Context = { sqlite: Database; rateCards: RateCard; homeToSubId: Map<string, string>; eras?: EraIndex; resolver?: AccountResolver; accounts?: {subscriptions?:readonly EraDeclaration[]; sources?: readonly SourceDeclaration[]} };
const SOURCES = { codex: "events", claude: "claude_events", opencode: "oc_events", grok: "grok_events", gemini: "gemini_events" } as const;
/** Shared usage price register scopes, which name OpenCode's plan rather than its store. */
const SOURCE_PROVIDERS = { claude: "claude", opencode: "glm", grok: "grok", gemini: "gemini" } as const;
type Source = keyof typeof SOURCES;
const amount = (): UsageAmount => ({ subtotal: 0, priced_calls: 0, unpriced_calls: 0 });
export function globalUsageRange(params: URLSearchParams, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const until = params.get("until") ?? today;
  const since = params.get("since") ?? new Date(Date.parse(today) - 29 * 86400000).toISOString().slice(0, 10);
  if (!isAccountingDay(since) || !isAccountingDay(until) || since > until) throw new Error("Expected ordered YYYY-MM-DD since/until dates");
  if ((Date.parse(until) - Date.parse(since)) / 86400000 + 1 > GLOBAL_USAGE_MAX_DAYS) throw new Error(`Maximum range is ${GLOBAL_USAGE_MAX_DAYS} days`);
  let vendors: UsageVendorId[] | undefined;
  if (params.has("vendors")) {
    const requested = params.get("vendors")!.split(",");
    if (params.getAll("vendors").length !== 1 || !requested.every(value => USAGE_VENDOR_IDS.includes(value as UsageVendorId)))
      throw new Error("Choose known usage vendors");
    vendors = USAGE_VENDOR_IDS.filter(value => requested.includes(value));
  }
  return { since, until, ...(vendors ? {vendors} : {}) };
}

export function buildGlobalUsage(ctx:Context,range:GlobalUsageRange, contextPreview = false):GlobalUsageResponse {
  range=globalUsageRange(new URLSearchParams({since:range.since,until:range.until,...(range.vendors?{vendors:range.vendors.join(",")}:{})}));
  const declarations=ctx.accounts?.subscriptions??[];
  const physical=ctx.accounts?.sources??subscriptionDeclarations(ctx.homeToSubId);
  ctx={...ctx,accounts:{subscriptions:declarations,sources:physical}};
  return withContextPreview(ctx.sqlite,()=> {
    const sources=Object.entries(SOURCES).filter(([source])=>!range.vendors||range.vendors.includes(source as UsageVendorId));
    const nativeIncluded=sources.some(([source])=>source==='codex')
      && (ctx.sqlite.query('PRAGMA table_info(events)').all() as {name:string}[]).some(column=>column.name==='ts');
    const ledger=nativeIncluded?codexLedgerReadContext(ctx.rateCards):undefined;
    if(ledger) requireGlobalCodexReady(ctx,ledger,{fromMs:Date.parse(range.since),toMs:Date.parse(range.until)+86400000});
    const report:GlobalUsageResponse={...range,timezone:"UTC",rows:[],sources:[],excluded_duplicates:0,conflicting_events:0,approximate_time_events:0,actual_cost_available:false};
    for(const [sourceId,table] of sources) {
      const source=sourceId as Source;
      if(!(ctx.sqlite.query(`PRAGMA table_info(${table})`).all() as {name:string}[]).some(c=>c.name==="ts")) {
        report.sources.push({id:source,available:false,events:0}); continue;
      }
      const sourceRange={since:range.since,until:range.until};
      const part=source==="codex"?codexGlobalUsageFromRegister(ctx,sourceRange,ledger):subscriptionGlobalUsageFromRegister(ctx,sourceRange,source);
      report.rows.push(...part.rows);report.sources.push(...part.sources);
      report.excluded_duplicates+=part.excluded_duplicates;report.conflicting_events+=part.conflicting_events;report.approximate_time_events+=part.approximate_time_events;
    }
    report.rows.sort((a,b)=>a.day.localeCompare(b.day)||a.provider.localeCompare(b.provider));
    return report;
  }, contextPreview);
}

/** Codex aggregates of canonical calls (duplicate copies resolved at build) with exact registered prices. */
function requireGlobalCodexReady(ctx:Context,ledger:CodexLedgerReadContext,range:import('../db/codex-price-ledger').LedgerRange) {
  const register=codexUsagePriceReadiness(ctx.sqlite,{...ledger,range,
    sourcesStamp:usagePriceSourcesStamp(codexSourceHomes(ctx.homeToSubId),ctx.accounts?.sources,ARCHIVE_LOGICAL_ROOT)});
  if(register.state!=='ready')throw new SubscriptionFactsPending(
    `Codex usage prices are awaiting background preparation (${register.reason})`,'codex');
  return register;
}
function codexGlobalUsageFromRegister(ctx:Context,range:{since:string;until:string},context?:CodexLedgerReadContext):GlobalUsageResponse {
  const ledger=context??codexLedgerReadContext(ctx.rateCards);
  const register=requireGlobalCodexReady(ctx,ledger,{fromMs:Date.parse(range.since),toMs:Date.parse(range.until)+86400000});
  const scope=register.head.scope;
  const result:GlobalUsageResponse={...range,timezone:"UTC",rows:[],sources:[{id:"codex",available:true,events:0}],
    excluded_duplicates:0,conflicting_events:0,approximate_time_events:0,actual_cost_available:false};
  const buckets=new Map<string,{row:GlobalUsageRow;first:string}>();
  for(const row of readCodexRegisterDays(ctx.sqlite,scope,range,ctx.resolver??loadAccountResolver(ctx.sqlite,ctx.accounts?.subscriptions),ledger)) {
    result.sources[0]!.events+=row.calls;
    if(!row.selected) { result.excluded_duplicates+=row.calls; continue; }
    const key=JSON.stringify([row.day,"openai",row.account,"codex",row.model]);
    const current=buckets.get(key)??{first:row.first_ts,row:{day:row.day,provider:"openai",account:row.account,
      source:"codex",model:row.model,calls:0,tokens:0,input:0,cache_read:0,cache_write:0,output:0,
      api_usd:amount(),credits:amount(),credit_unit:"chatgpt_credits"}};
    if(row.first_ts && row.first_ts<current.first)current.first=row.first_ts;
    const target=current.row;
    target.calls+=row.calls;
    const quantities={input:row.tokens.in_uncached??0,cache_read:row.tokens.in_cache_read??0,
      cache_write:row.tokens.in_cache_write_unknown??0,output:row.tokens.out_total??0};
    for(const bucket of ["input","cache_read","cache_write","output"] as const) {
      target[bucket]+=quantities[bucket]; target.tokens+=quantities[bucket];
    }
    // The internal reviewer and guardian reviews are recorded traffic without a published price.
    if(isCodexInternalReview(row.model)||row.nested==="guardian_review") {
      target.internal_tokens=(target.internal_tokens??0)+Object.values(quantities).reduce((sum,n)=>sum+n,0);
      target.api_usd.unpriced_calls+=row.calls; target.credits.unpriced_calls+=row.calls;
    } else {
      const credits=row.speed==="fast"?row.variants.credits_fast:row.speed==="standard"?row.variants.credits_standard:undefined;
      for(const [measure,variant] of [[target.api_usd,row.variants.api_actual],[target.credits,credits]] as const) {
        measure.subtotal+=Number(variant?.pricedSubtotal??"0");
        measure.priced_calls+=Number(variant?.pricedEvents??"0");
        // An unusable speed has no actual price at all, so every call of it is unpriced.
        measure.unpriced_calls+=variant?Number(variant.unpricedEvents):row.calls;
      }
    }
    buckets.set(key,current);
  }
  result.rows=[...buckets.values()]
    .sort((a,b)=>a.row.day.localeCompare(b.row.day)||a.first.localeCompare(b.first))
    .map(entry=>entry.row);
  return result;
}

/** The provider register includes qualified subscription traffic and global-only usage. */
function subscriptionGlobalUsageFromRegister(ctx:Context,range:{since:string;until:string},
  source:Exclude<Source,"codex">):GlobalUsageResponse {
  const provider=SOURCE_PROVIDERS[source];
  // Readiness is asked first, and nothing short-circuits past it. A scope that exists but is
  // behind owns the answer: returning the per-event numbers instead would hide a stale register
  // behind a result that looks complete, which is the state this package exists to make visible.
  const register=subscriptionUsagePriceReadiness(ctx.sqlite,provider,ctx.rateCards);
  if(register.state!=="ready")throw new SubscriptionFactsPending(
    `${provider} usage prices are awaiting background preparation (${register.reason})`,provider);
  const days=readGlobalUsagePriceDays(ctx.sqlite,provider,register.head.scope,range,ctx.resolver??loadAccountResolver(ctx.sqlite,ctx.accounts?.subscriptions));
  const result:GlobalUsageResponse={...range,timezone:"UTC",rows:[],
    sources:[{id:source,available:true,events:days.events}],excluded_duplicates:days.excluded_duplicates,
    conflicting_events:days.conflicting_events,approximate_time_events:days.approximate_time_events,
    actual_cost_available:false};
  // `readGlobalUsagePriceDays` already returns its rows in the order the event path emitted
  // them, ties included; re-sorting here on the instant alone would undo the key comparison.
  result.rows=days.rows
    .map(row=>({day:row.day,provider:row.vendor,account:row.account,source,model:row.model,
      calls:row.calls,tokens:row.input+row.cache_read+row.cache_write+row.output,
      input:row.input,cache_read:row.cache_read,cache_write:row.cache_write,output:row.output,
      api_usd:{subtotal:Number(row.priced_subtotal),priced_calls:row.priced_events,unpriced_calls:row.unpriced_events},
      // A subscription source reports no credit unit, so every one of its calls is uncredited.
      credits:{subtotal:0,priced_calls:0,unpriced_calls:row.calls},credit_unit:null}));
  return result;
}

export function handleGlobalUsage(ctx: Context, url: URL): Response {
  let range: ReturnType<typeof globalUsageRange>;
  try { range = globalUsageRange(url.searchParams); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  return Response.json(buildGlobalUsage(ctx, range, contextRequested(url)));
}
