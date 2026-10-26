import type {Database} from "../db/sqlite";
import type {RateCard} from "./pricing";
import type {IdentityDeclaration} from "./account-resolver";
import {loadAccountResolver} from "./account-resolver";
import {limitWindowFromRow,type LimitWindowRow} from "../db/limit-windows";
import {readCodexEventRange,resolveCodexLedgerEventOwner,getPublishedCodexLedgerGroup,normalizePublishedCodexTier} from "./codex-priced-events";
import {prepareCodexPricing,resolveCodexAccountingConfig,CODEX_CREDIT_BILLING_START} from "./codex-accounting-pricing";
import {codexLedgerReadContext,ledgerPresentationNumber} from "../db/codex-ledger-adapters";
import {contextAmount,type ContextEvent} from "../db/codex-context-producer";
import {rational,add,multiply,divide,subtract,type Rational} from "../db/price-ledger-exact";
import {codexReferenceValuation,codexLedgerReferenceRevision} from "../db/codex-ledger-reference";
import {codexWindowAdapter} from "./codex-window-comparison";
import {populateMeterWindows,registerWindowShell,emptyWindowUsage} from "./subscription-window-comparison";
import {addReferenceValuation} from "./subscription-revaluation";
import type {WindowSums,WindowSlice} from "./window-usage-contracts";
import type {WindowPointValueRow} from "../db/window-point-values";
import {ledgerTierMultiplier} from "./codex-ledger-policy";
import type {TokenRates} from "./plan-capacity-contracts";

export type FinalWindowSource=LimitWindowRow & {cycle:string;rail:string;usage_readings:string;slices:string;reference:string|null};
const zero=rational(0n),number=ledgerPresentationNumber;
interface Extra {api:Rational;normal:Rational}
const empty=():Extra=>({api:zero,normal:zero});
const plus=(target:Extra,value:Extra)=>{target.api=add(target.api,value.api);target.normal=add(target.normal,value.normal);};
const enrich=(usage:any,extra:Extra)=>({...usage,api_standard:usage.api_standard+number(extra.api),
  ...(usage.api_normalized===undefined?{}:{api_normalized:usage.api_normalized+number(extra.normal)})});
export function finalContextPolicy(rates:RateCard){const ledger=codexLedgerReadContext(rates);return {...ledger,bands:[...ledger.policy.baseBands.filter(b=>b.band!=="long").map(b=>{
  const long=ledger.policy.contextBands.find(candidate=>candidate.id===b.id);return long?{...b,band:"normal" as const,threshold:long.threshold}:b;
 }),...ledger.policy.contextBands]};}
/** Only new companion measures: source rows and accepted prices are never written. */
export function computeFinalContextWindow(db:Database,rates:RateCard,row:FinalWindowSource,subscriptions:readonly IdentityDeclaration[],referenceDay:string){
  const ledger=finalContextPolicy(rates),config=prepareCodexPricing(resolveCodexAccountingConfig(rates)),resolver=loadAccountResolver(db,subscriptions);
  const manual=row.window_id.startsWith("manual:"),from=Date.parse(row.start_ts)+(manual?1:0),until=Date.parse(row.end_ts)+(manual?1:0);
  const events=readCodexEventRange(db,config,new Date(from).toISOString(),new Date(until).toISOString(),event=>resolveCodexLedgerEventOwner(resolver,event),ledger,{canonical:true})
    .filter(event=>event.account===row.account);
  const saved=new Map((db.query(`SELECT p.* FROM codex_price_ledger_events e INDEXED BY codex_price_ledger_events_time
    JOIN codex_context_events p ON p.event_id=e.id WHERE e.instant_ms>=? AND e.instant_ms<?`).all(from,until) as ContextEvent[]).map(value=>[value.event_id,value]));
  const window=limitWindowFromRow(row),shell=registerWindowShell(window,window.window_minutes);
  const earlier=(db.query("SELECT * FROM limit_windows WHERE provider='codex' AND account=? AND counter=? AND seq<? AND start_ts<? AND end_ts>? ORDER BY seq")
    .all(row.account,row.counter,row.seq,row.end_ts,row.start_ts) as LimitWindowRow[]).map(value=>{const window=limitWindowFromRow(value);return registerWindowShell(window,window.window_minutes);});
  const cycle=JSON.parse(row.cycle),rail=JSON.parse(row.rail),readings=JSON.parse(row.usage_readings) as WindowSums["readings"];
  const readingTimes=readings.map(reading=>Date.parse(reading.ts));
  const all=empty(),paired=empty(),running=readings.map(()=>empty()),models=new Map<string|null,Extra>(),sources=new Map<string,Extra>(),surfaces=new Map<string|null,Rational>();
  const modelAll=new Map<string|null,Rational>(),at=empty(),funded=new Map<string,Rational>();let fundedAll=zero,atApi=zero,missing=0;
  const slices=new Map<string,WindowSlice>(),referenceAll=emptyWindowUsage(),referencePaired=emptyWindowUsage();
  const reference=codexReferenceValuation(ledger.bands,referenceDay),normalReference=codexReferenceValuation(ledger.policy.baseBands,referenceDay),savedReference=JSON.parse(row.reference??'null');
  const referenceChanges=()=>({reference_api_standard:0,paired_historical_api:0,paired_reference_api:0}),refAll=referenceChanges(),refPaired=referenceChanges();
  const limit=rail.at_limit?.ts?Date.parse(rail.at_limit.ts):null;
  const valueOf=(event:typeof events[number])=>{const group=getPublishedCodexLedgerGroup(event)!,value=saved.get(Number(event.id));
    if(group.variants.api_standard.value===null)return zero;
    if(!value||value.reason){missing++;return zero;}return value.included?zero:contextAmount(value,"extra")!;};
  const refKeys=["reference_api_standard","reference_priced_tokens","reference_unpriced_events","paired_historical_api","paired_reference_api","revaluation_events","revaluation_tokens"] as const;
  populateMeterWindows([...earlier,shell],events,{...codexWindowAdapter(config,window.window_minutes),usage:()=>emptyWindowUsage(),detail:undefined},{
    excluded(target,event,reason){if(target!==shell||reason!=="funding"||event.billing_mode!=="credits")return;const value=valueOf(event),hour=new Date(Math.floor(Date.parse(event.ts)/3600000)*3600000).toISOString();fundedAll=add(fundedAll,value);funded.set(hour,add(funded.get(hour)??zero,value));},
    counted(target,event,_usage,isPaired){
      if(target!==shell)return;const t=Date.parse(event.ts),group=getPublishedCodexLedgerGroup(event)!,delta=valueOf(event),joint=group.variants.window_api.value!==null;
      const norm=normalizePublishedCodexTier(event,event.speed);
      const actual=event.speed==="standard"?group.variants.credits_standard.value:event.speed==="fast"?group.variants.credits_fast.value:(group.variants.extra_credits.value===null?null:add(group.variants.credits_standard.subtotal,group.variants.extra_credits.subtotal));
      const standard=group.variants.credits_standard.value;
      const factor=actual&&standard?(standard.n?divide(actual,standard):actual.n===0n?rational(1n):null):null;
      const weight=group.variants.window_api.value?.n?divide(group.variants.window_normalized.value!,group.variants.window_api.value):
        event.ts.slice(0,10)<CODEX_CREDIT_BILLING_START?rational(1n):group.tier===null?rational(1n):factor;
      const normal=joint&&weight?multiply(delta,weight):zero;
      const extra={api:joint?delta:zero,normal};plus(all,extra);
      let low=0,high=readingTimes.length;while(low<high){const middle=(low+high)>>>1;if(readingTimes[middle]!<t)low=middle+1;else high=middle;}
      if(low<running.length)plus(running[low]!,extra);
      modelAll.set(event.model,add(modelAll.get(event.model)??zero,delta));surfaces.set((event as any).surface??null,add(surfaces.get((event as any).surface??null)??zero,delta));
      if(limit!==null&&t<=limit){atApi=add(atApi,delta);plus(at,extra);}
      if(isPaired){plus(paired,extra);const m=models.get(event.model)??empty();plus(m,extra);models.set(event.model,m);const name=event.source??event.home??"nieznane źródło",s=sources.get(name)??empty();plus(s,extra);sources.set(name,s);}
      const raw=group.stored,ref=reference({model:event.model,in_tok:event.in_tok,uncached:Number(raw.uncached),cached:Number(raw.cached),writes:Number(raw.writes),output:Number(raw.output),common_reason:(raw as unknown as {common_reason?:string}).common_reason||null});
      const normalRef=normalReference({model:event.model,in_tok:event.in_tok,uncached:Number(raw.uncached),cached:Number(raw.cached),writes:Number(raw.writes),output:Number(raw.output),common_reason:(raw as unknown as {common_reason?:string}).common_reason||null});
      if(savedReference&&((ref.amount===null)!==(normalRef.amount===null)))missing++;
      const referenceExtra=ref.amount!==null&&normalRef.amount!==null?number(subtract(ref.amount,normalRef.amount)):0;
      const changes={reference_api_standard:referenceExtra,paired_historical_api:normalRef.amount!==null&&group.variants.api_standard.value!==null?number(delta):0,
        paired_reference_api:group.variants.api_standard.value!==null?referenceExtra:0};
      for(const key of Object.keys(changes) as (keyof typeof changes)[]){refAll[key]+=changes[key];if(isPaired)refPaired[key]+=changes[key];}
      const refUsage=emptyWindowUsage();refUsage.tokens=Number(group.tokensReported);refUsage.events=Number(group.calls);
      const historical=group.variants.api_standard.value;addReferenceValuation(refUsage,historical===null?null:number(add(historical,delta)),ref.amount===null?null:number(ref.amount));
      for(const key of refKeys){(referenceAll as any)[key]=((referenceAll as any)[key]??0)+((refUsage as any)[key]??0);if(isPaired)(referencePaired as any)[key]=((referencePaired as any)[key]??0)+((refUsage as any)[key]??0);}
      const rule=ledger.policy.resolveBaseRule(event.model,"api_equivalent_usd",raw.day);
      if(norm.multiplier===null||!rule){
        const hour=new Date(Math.floor(t/3600000)*3600000).toISOString(),key=JSON.stringify([event.model,event.speed,hour,isPaired,"unsupported"]);
        const slice=slices.get(key)??{model:event.model,speed:event.speed??"unknown",hour,paired:isPaired,tokens:{in_uncached:0,in_cache_read:0,in_cache_write_5m:0,in_cache_write_1h:0,out_total:0}};
        slice.tokens.in_uncached+=Number(raw.uncached);slice.tokens.in_cache_read+=Number(raw.cached);slice.tokens.in_cache_write_5m+=Number(raw.writes);slice.tokens.out_total+=Number(raw.output);slices.set(key,slice);return;
      }
      const price=rule.long_context&&event.in_tok>rule.long_context.above_input_tokens?rule.long_context.rates:rule.rates;
      const multiplier=number(ledgerTierMultiplier(rule.multiplier));
      const rates:TokenRates={in_uncached:Number(price.in_uncached)*multiplier,in_cache_read:Number(price.in_cache_read)*multiplier,in_cache_write_5m:price.in_cache_write==null?null:Number(price.in_cache_write)*multiplier,in_cache_write_1h:price.in_cache_write==null?null:Number(price.in_cache_write)*multiplier,out_total:Number(price.out_total)*multiplier};
      const hour=new Date(Math.floor(t/3600000)*3600000).toISOString(),key=JSON.stringify([event.model,event.speed,hour,isPaired,rates]);
      const slice=slices.get(key)??{model:event.model,speed:event.speed??"unknown",hour,paired:isPaired,context_rates:rates,context_classified:true,tokens:{in_uncached:0,in_cache_read:0,in_cache_write_5m:0,in_cache_write_1h:0,out_total:0}};
      const quantities={in_uncached:Number(raw.uncached),in_cache_read:Number(raw.cached),in_cache_write_5m:Number(raw.writes),in_cache_write_1h:0,out_total:Number(raw.output)};
      for(const key of Object.keys(quantities) as (keyof typeof quantities)[])slice.tokens[key]+=quantities[key]*norm.multiplier;
      slices.set(key,slice);
    }
  });
  for(let index=1;index<running.length;index++)plus(running[index]!,running[index-1]!);
  cycle.usage=enrich(cycle.usage,paired);cycle.cycle_usage=enrich(cycle.cycle_usage,all);
  cycle.models=cycle.models.map((value:any)=>({...value,...enrich(value,models.get(value.name)??empty())}));
  cycle.sources=cycle.sources.map((value:any)=>({...value,...enrich(value,sources.get(value.name)??empty())}));
  const augmented=readings.map((reading,i)=>({...reading,usage:enrich(reading.usage,running[i]!)}));
  rail.api_standard+=number([...modelAll.values()].reduce(add,zero));
  rail.by_model=rail.by_model.map((value:any)=>value.excluded===null?{...value,api_standard:value.api_standard+number(modelAll.get(value.model)??zero)}:value);
  rail.by_surface=rail.by_surface?.map((value:any)=>({...value,api_standard:value.api_standard+number(surfaces.get(value.surface)??zero)}));
  if(rail.at_limit){rail.at_limit.api_standard+=number(atApi);rail.at_limit.joint_api_standard+=number(at.api);}
  if(rail.credit_funded){rail.credit_funded.api_standard+=number(fundedAll);rail.credit_funded.hours=rail.credit_funded.hours.map((hour:any[])=>[...hour.slice(0,4),hour[4]+number(funded.get(hour[0])??zero)]);}
  const refCycle={...cycle,usage:{...cycle.usage,...referencePaired},cycle_usage:{...cycle.cycle_usage,...referenceAll}};
  if(savedReference?.cycle)for(const [key,changes] of [["usage",refPaired],["cycle_usage",refAll]] as const)
    for(const field of refKeys)(refCycle[key] as any)[field]=(savedReference.cycle[key][field]??0)+(field in changes?changes[field as keyof typeof changes]:0);
  // Reference usage keys are additive; retain the original token/credit populations of the cycle.
  for(const key of Object.keys(emptyWindowUsage())){(refCycle.usage as any)[key]=cycle.usage[key];(refCycle.cycle_usage as any)[key]=cycle.cycle_usage[key];}
  const point=db.query("SELECT * FROM window_point_values WHERE provider='codex' AND account=? AND counter=? AND window_start=?").get(row.account,row.counter,row.start_ts) as WindowPointValueRow|null;
  let pointExtra=paired;
  if(point?.basis==="at_limit"){
    const first=window.readings[0]!,shellStart=registerWindowShell(window,window.window_minutes).start_basis;
    const low=shellStart==="reset"?empty():running.find((_sum,i)=>readings[i]!.ts===first.ts)??empty();
    pointExtra={api:add(at.api,{n:-low.api.n,d:low.api.d}),normal:add(at.normal,{n:-low.normal.n,d:low.normal.d})};
  }
  const pointValue=point?{...point,api_standard:point.api_standard===null?null:Math.round((point.api_standard+number(pointExtra.api))*1e6)/1e6,
    api_normalized:point.api_normalized===null?null:Math.round((point.api_normalized+number(pointExtra.normal))*1e6)/1e6}:null;
  return {missing,point:pointValue,sums:{cycle,rail,readings:augmented,slices:[...slices.values()],reference:{day:referenceDay,fingerprint:codexLedgerReferenceRevision(ledger.bands,referenceDay),cycle:refCycle}} as WindowSums};
}
