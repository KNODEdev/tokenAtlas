import type {Database} from "bun:sqlite";
import type {RateCard} from "./pricing";
import {codexUsagePriceReadiness,readUsagePriceAccountTotals,subscriptionUsagePriceReadiness,usagePriceSourcesStamp} from "../db/usage-price-read-subscription";
import {USAGE_PRICE_TOTALS_VERSION} from "../db/usage-price-totals";
import {CODEX_CANONICAL_COPY_POLICY} from "../db/codex-ledger-canonical";
import {normalizeRebuildAccounts,type RebuildAccount} from "../shared/rebuild-accounts";
import {rebuildTimeBounds} from "../shared/analysis-rebuild";
import type {EraDeclaration,EraIndex} from "./eras";
import type {SourceDeclaration} from "./archive-source";
import {subscriptionAccountingAdapter,type TokenBucket} from "./subscription-accounting-adapters";
import {loadAccountResolver,type AccountResolver} from "./account-resolver";
import {ARCHIVE_LOGICAL_ROOT} from "../config/paths";

export interface RebuildAccountTokenSnapshot extends RebuildAccount {
  provider:string|null;
  status:"available"|"unavailable";
  reason:string|null;
  buckets:Record<TokenBucket,string>|null;
  calls:string|null;
  quality:{complete:boolean;invalidIdentityDays:string|null;conflictedIdentityDays:string|null;duplicateCopies:string|null}|null;
  provenance:{basis:"canonical-reported-tokens-v1";source:string;scope:string|null;cursor:number|null;versions:Record<string,string>;revisions?:Record<string,string>}|null;
}
export interface RebuildAccountTotalsContext {
  subscriptions:readonly EraDeclaration[];sources:readonly SourceDeclaration[];eras?:EraIndex;rateCards?:RateCard;
  sourceHomes?:readonly string[];resolver?:AccountResolver;
}
type Range={from:string;until:string}|null;
function unavailable(account:RebuildAccount,provider:string|null,reason:string):RebuildAccountTokenSnapshot {
  return {...account,provider,status:"unavailable",reason,buckets:null,calls:null,quality:null,provenance:null};
}

/** Read the shared register only. Missing preparation never becomes a source scan or a zero. */
export function captureRebuildAccountTotals(db:Database,accounts:readonly RebuildAccount[],range:Range,context:RebuildAccountTotalsContext):RebuildAccountTokenSnapshot[] {
  if(range)rebuildTimeBounds(range);
  const resolver=context.resolver??loadAccountResolver(db,context.subscriptions);
  return db.transaction(()=>normalizeRebuildAccounts(accounts).map((account):RebuildAccountTokenSnapshot=>{
    let provider:string=account.vendor;
    if(provider==="opencode") {
      const providers=new Set<string>();
      for(const sub of context.subscriptions.filter(sub=>sub.id.toLowerCase()===account.account)) {
        try {
          const adapter=subscriptionAccountingAdapter(sub.vendor??"codex");
          if(adapter.table!=="oc_events")return unavailable(account,null,"account-provider-ambiguous");
          providers.add(adapter.id);
        } catch {return unavailable(account,null,"account-provider-unsupported");}
      }
      if(providers.size!==1)return unavailable(account,null,providers.size?"account-provider-ambiguous":"account-provider-unavailable");
      provider=[...providers][0]!;
    }
    if(!context.rateCards)return unavailable(account,provider,"price-configuration-not-provided");
    const state=provider==="codex"
      ?codexUsagePriceReadiness(db,{sourcesStamp:context.sourceHomes?usagePriceSourcesStamp(context.sourceHomes,context.sources,ARCHIVE_LOGICAL_ROOT):undefined})
      :subscriptionUsagePriceReadiness(db,provider,context.rateCards);
    if(state.state!=="ready")return unavailable(account,provider,state.reason);
    const owners=provider==="codex"?[account.account,`${account.account}::business`]:[account.account];
    const totals=readUsagePriceAccountTotals(db,state.head.scope,provider,resolver,owners,range?{since:range.from,until:range.until}:null);
    const invalid=totals.quality.invalid_token_events??"0",conflicted=totals.quality.conflicts??"0";
    return {...account,provider,status:"available",reason:null,buckets:totals.tokens,calls:totals.calls,
      quality:{complete:invalid==="0"&&conflicted==="0",invalidIdentityDays:invalid,conflictedIdentityDays:conflicted,duplicateCopies:totals.quality.duplicates??"0"},
      provenance:{basis:"canonical-reported-tokens-v1",source:provider==="codex"?"codex_price_ledger_aggregates":"usage_ledger_days",scope:state.head.scope,cursor:state.head.cursor,
        versions:{register:String(USAGE_PRICE_TOTALS_VERSION),mirrorPolicy:String(CODEX_CANONICAL_COPY_POLICY),attribution:"account-periods"}}};
  })).deferred();
}
