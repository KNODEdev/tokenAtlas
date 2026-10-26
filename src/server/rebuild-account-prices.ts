import type {Database} from "bun:sqlite";
import {subtractDecimalAmounts} from "../shared/decimal-amount";
import type {RebuildAccount} from "../shared/rebuild-accounts";
import {loadAccountResolver,type AccountResolver} from "./account-resolver";
import {ARCHIVE_LOGICAL_ROOT} from "../config/paths";
import type {RateCard} from "./pricing";
import {PRICE_TOTAL_ARITHMETIC} from "../db/usage-price-totals";
import {CODEX_CANONICAL_COPY_POLICY} from "../db/codex-ledger-canonical";
import {USAGE_PRICE_TOTALS_VERSION,type UsagePriceAmount} from "../db/usage-price-totals";
import {codexLedgerSettings} from "./codex-ledger-settings";
import {codexUsagePriceReadiness,readUsagePriceAccountTotals,subscriptionUsagePriceReadiness,
  subscriptionUsagePriceRulesDigest,usagePriceSourcesStamp} from "../db/usage-price-read-subscription";
import {captureRebuildAccountTotals,type RebuildAccountTotalsContext} from "./rebuild-account-totals";

type AccountPriceTotals=RegisterPriceTotals;
/**
 * WP4d: the same boundary read from the shared register. The field set is the union of the
 * two pre-register shapes, so nothing a reader relied on disappears; `accountPriceDelta` keeps
 * comparing `[provider, scope, provenance]`, which stays stable across a pair of boundaries.
 */
type RegisterPriceTotals={
  status:"available";reason:null;scope:string;cursor:number;
  provenance:{version:number;arithmetic:string;currency:"USD";unit:"api-equivalent";
    basis:"dated-canonical-event-valuations";rulesDigest:string;mirrorPolicy:number;attribution:string|null};
  /** `reasons` carries `{events, tokens}` here, the register's richer coverage shape. */
  standard:UsagePriceAmount;actual:UsagePriceAmount;
  quality:{complete:boolean;invalidIdentityDays:string|null;conflictedIdentityDays:string|null;duplicateCopies:string|null};
};

function registerPrices(db:Database,provider:string,account:string,rates:RateCard,
  range:{from:string;until:string}|null,resolver:AccountResolver,context:RebuildAccountTotalsContext):
  {state:"absent"}|{state:"pending";reason:string}|{state:"ready";totals:RegisterPriceTotals} {
  const codex=provider==="codex";
  const rulesDigest=codex?codexLedgerSettings(rates).semantic_revision:subscriptionUsagePriceRulesDigest(rates,provider);
  const readiness=codex
    ?codexUsagePriceReadiness(db,{rulesRevision:rulesDigest,
      sourcesStamp:context.sourceHomes?usagePriceSourcesStamp(context.sourceHomes,context.sources,ARCHIVE_LOGICAL_ROOT):undefined})
    :subscriptionUsagePriceReadiness(db,provider,rates);
  if(readiness.state!=="ready")return readiness.state==="absent"?{state:"absent"}:{state:"pending",reason:readiness.reason};
  const owners=codex?[account,`${account}::business`]:[account];
  const totals=readUsagePriceAccountTotals(db,readiness.head.scope,provider,resolver,owners,
    range?{since:range.from,until:range.until}:null);
  const invalid=totals.quality.invalid_token_events??"0",conflicted=totals.quality.conflicts??"0";
  // Codex identity quality is not materialized at this boundary yet; keeping it unknown
  // preserves today's "no exact delta" contract for Codex rebuilds (WP4e).
  const quality=codex?{complete:false,invalidIdentityDays:null,conflictedIdentityDays:null,duplicateCopies:null}
    :{complete:invalid==="0"&&conflicted==="0"&&(totals.variants.api_standard?.unpricedEvents??"0")==="0"
        &&(totals.variants.api_actual?.unpricedEvents??"0")==="0",
      invalidIdentityDays:invalid,conflictedIdentityDays:conflicted,duplicateCopies:totals.quality.duplicates??"0"};
  const valid=codex||invalid==="0"&&conflicted==="0";
  // An account the register holds no rows for costs exactly zero; so does a variant no event
  // contributed to. Both are a proven total, not an unknown one, and the pre-register boundary
  // reported them as "0" (§8). Only an unpriced event makes the total unknown.
  const empty:UsagePriceAmount={value:"0",subtotal:"0",pricedSubtotal:"0",pricedEvents:"0",
    unpricedEvents:"0",pricedTokens:"0",unpricedTokens:"0",reasons:{}};
  const amount=(variant:"api_standard"|"api_actual"):UsagePriceAmount=>{
    const stored=totals.variants[variant]??empty;
    return {...stored,value:valid&&stored.unpricedEvents==="0"?stored.subtotal:null};
  };
  return {state:"ready",totals:{status:"available",reason:null,scope:readiness.head.scope,cursor:readiness.head.cursor,
    provenance:{version:USAGE_PRICE_TOTALS_VERSION,arithmetic:PRICE_TOTAL_ARITHMETIC,currency:"USD",unit:"api-equivalent",
      basis:"dated-canonical-event-valuations",rulesDigest,mirrorPolicy:CODEX_CANONICAL_COPY_POLICY,
      attribution:"account-periods"},
    standard:amount("api_standard"),actual:amount("api_actual"),quality}};
}

export interface RebuildAccountPriceSnapshot extends RebuildAccount {
  provider:string|null;
  status:"available"|"unavailable";
  reason:string|null;
  totals:AccountPriceTotals|null;
}
export interface AccountPriceBoundary {capturedAt:string|null;accounts:RebuildAccountPriceSnapshot[]}
export interface RebuildAccountPrices {
  scope:"declared-selected-accounts";
  before:AccountPriceBoundary;
  after:AccountPriceBoundary|null;
  delta:ReturnType<typeof accountPriceDelta>|null;
}
export function unavailableAccountPrices(accounts:readonly RebuildAccount[],reason:string):AccountPriceBoundary {
  return {capturedAt:null,accounts:accounts.map(account=>({...account,provider:null,status:"unavailable",reason,totals:null}))};
}
/** Uses the same account resolution and durable fact readiness as the token boundary. */
export function captureAccountPrices(db:Database,accounts:readonly RebuildAccount[],range:{from:string;until:string}|null,
  at:string,context?:RebuildAccountTotalsContext):AccountPriceBoundary {
  if(!context?.rateCards)return unavailableAccountPrices(accounts,"price-configuration-not-provided");
  const rates=context.rateCards,resolver=context.resolver??loadAccountResolver(db,context.subscriptions);
  return {capturedAt:at,accounts:captureRebuildAccountTotals(db,accounts,range,context).map(row=>{
    const base={vendor:row.vendor,account:row.account,provider:row.provider};
    if(!row.provider || row.status!=="available")return {...base,status:"unavailable" as const,reason:row.reason??"account-facts-unavailable",totals:null};
    if(row.provider==="codex"&&!context.sourceHomes)return {...base,status:"unavailable" as const,reason:"codex-source-homes-not-provided",totals:null};
    // The shared register is the source wherever it has run; the per-provider registers stay
    // below only for databases that predate it, and WP4e removes them with this branch.
    const register=registerPrices(db,row.provider,row.account,rates,range,resolver,context);
    if(register.state==="pending")return {...base,status:"unavailable" as const,reason:register.reason,totals:null};
    if(register.state==="ready")return {...base,status:"available" as const,reason:null,totals:register.totals};
    return {...base,status:"unavailable" as const,reason:"usage-price-register-absent",totals:null};
  })};
}
export function accountPriceDelta(before:AccountPriceBoundary,after:AccountPriceBoundary) {
  return after.accounts.map(right=>{
    const left=before.accounts.find(row=>row.vendor===right.vendor && row.account===right.account);
    const a=left?.totals,b=right.totals;
    const basis=(row:RebuildAccountPriceSnapshot)=>JSON.stringify([row.provider,row.totals?.scope,row.totals?.provenance]);
    const reason=left?.status!=="available"||right.status!=="available"||!a||!b
      ?"prices-not-available-at-both-boundaries"
      :!a.quality||!b.quality||[a.quality,b.quality].some(quality=>quality.invalidIdentityDays!=="0"||quality.conflictedIdentityDays!=="0")?"price-quality-not-complete-at-both-boundaries"
      :basis(left)!==basis(right)?"account-price-basis-changed":null;
    const difference=(variant:"standard"|"actual")=>{
      if(reason)return {status:"unavailable" as const,reason,value:null};
      const old=a![variant]?.value,fresh=b![variant]?.value;
      if(old==null||fresh==null)return {status:"unavailable" as const,reason:"price-variant-incomplete",value:null};
      return {status:"available" as const,reason:null,value:subtractDecimalAmounts(fresh,old)};
    };
    return {vendor:right.vendor,account:right.account,standard:difference("standard"),actual:difference("actual")};
  });
}
