import type {Database} from "../db/sqlite";
import {readCodexContextState,codexContextPending,contextAmount,type ContextEvent} from "../db/codex-context-producer";
import {contextDetailsState,contextWindowRangesPending} from "../db/codex-context-details";
import {hasFinalContext,finalContextDatabase,finalHash,finalState,setFinalState} from "./codex-context-final-store";
import {computeFinalContextWindow,finalContextPolicy,type FinalWindowSource} from "./codex-context-final-window";
import {advanceProjectPlanFacts,type PreparedProjectCall} from "./project-plan-producer";
import {advanceSubscriptionRates,type RateProducerOptions} from "./subscription-rate";
import {readCodexEventRange,resolveCodexLedgerEventOwner,normalizePublishedCodexTier,getPublishedCodexLedgerGroup} from "./codex-priced-events";
import {loadAccountResolver} from "./account-resolver";
import {prepareCodexPricing,resolveCodexAccountingConfig} from "./codex-accounting-pricing";
import {codexReferenceValuation,codexLedgerReferenceRevision} from "../db/codex-ledger-reference";
import {ledgerPresentationNumber} from "../db/codex-ledger-adapters";
import {add,multiply,decimal,rational} from "../db/price-ledger-exact";
import {AccountInputs,deriveAccountCycles,cycleRow,type StoredCycleRow} from "./billing-cycle-producer";
import {loadPeriods,PLAN_PERIODS} from "../db/period-store";
import {storedFxLookup} from "../db/fx-rates";

const source=(db:Database,key:readonly [string,string,string])=>db.query(`SELECT w.*,u.cycle,u.rail,u.readings usage_readings,u.slices,u.reference
 FROM limit_windows w JOIN window_usage u USING(provider,account,counter,window_id) WHERE w.provider='codex' AND w.account=? AND w.counter=? AND w.window_id=?`).get(...key) as FinalWindowSource|null;
const sourceStamp=(db:Database,row:FinalWindowSource|null)=>finalHash([row,
 row&&db.query("SELECT inputs,data FROM codex_context_model_windows WHERE account=? AND counter=? AND window_id=?").get(row.account,row.counter,row.window_id),
 row&&db.query("SELECT * FROM window_point_values WHERE provider='codex' AND account=? AND counter=? AND window_start=?").get(row.account,row.counter,row.start_ts)]);
function saveObject(db:Database,table:string,value:Record<string,unknown>){const columns=Object.keys(value);db.query(`INSERT OR REPLACE INTO ${table}(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).run(...columns.map(key=>value[key] as string|number|null));}
export function readFinalProjectCalls(db:Database,options:RateProducerOptions,day:string,referenceDay:string):PreparedProjectCall[]{
 const ledger=finalContextPolicy(options.rates),resolver=loadAccountResolver(db,options.config.subscriptions),from=Date.parse(day),until=from+29*3600000;
 const events=readCodexEventRange(db,prepareCodexPricing(resolveCodexAccountingConfig(options.rates)),new Date(from).toISOString(),new Date(until).toISOString(),event=>resolveCodexLedgerEventOwner(resolver,event),ledger,{canonical:true});
 const saved=new Map((db.query(`SELECT p.* FROM codex_price_ledger_events e INDEXED BY codex_price_ledger_events_time JOIN codex_context_events p ON p.event_id=e.id WHERE e.instant_ms>=? AND e.instant_ms<?`).all(from,until) as ContextEvent[]).map(value=>[value.event_id,value]));
 const reference=codexReferenceValuation(ledger.bands,referenceDay);
 return events.map(event=>{const group=getPublishedCodexLedgerGroup(event)!,norm=normalizePublishedCodexTier(event,event.speed),stored=saved.get(Number(event.id)),raw=group.stored;
   const extra=stored&&!stored.reason?(stored.included?rational(0n):contextAmount(stored,"extra")):null;
   const historical=norm.normalized_usd===null||extra===null?null:norm.normalized_usd+ledgerPresentationNumber(multiply(extra,decimal(String(norm.multiplier!))));
   const ref=reference({model:event.model,in_tok:event.in_tok,uncached:Number(raw.uncached),cached:Number(raw.cached),writes:Number(raw.writes),output:Number(raw.output),common_reason:(raw as unknown as {common_reason?:string}).common_reason||null});
   return {account:event.account,subject:event.subject,source:event.source,identity:null,model:event.model,ts:new Date(event.ts).toISOString(),historical,
     today:ref.amount===null||norm.multiplier===null?null:ledgerPresentationNumber(multiply(ref.amount,decimal(String(norm.multiplier))))};});
}
/** Replace only API amounts; monetary calibration must never change tokens, credits, points or reset causes. */
export function overlayBillingApi(base:StoredCycleRow,preview:StoredCycleRow):StoredCycleRow{
 const before=JSON.parse(base.detail),after=JSON.parse(preview.detail);
 for(const key of ["capacity","used_units","unmetered"]){if(before[key]&&after[key])before[key]={...before[key],api_usd:after[key].api_usd,
   ...(key==="capacity"?{context_api_calibration:after[key].calibration}: {})};}
 if(before.resets&&after.resets)for(const key of Object.keys(before.resets))if(before.resets[key]&&after.resets[key])before.resets[key]={...before.resets[key],api_usd:after.resets[key].api_usd};
 return {...base,api_usd:preview.api_usd,capacity_usd:preview.capacity_usd,detail:JSON.stringify(before)};
}
/** One bounded background stage, using the existing pure calculators and only allowlisted companion writes. */
export function advanceFinalContext(db:Database,options:RateProducerOptions){
 let written=0,processed=0;if(!hasFinalContext(db))return {written,processed,pending:false};
 if(options.canWrite?.()===false)return {written,processed,pending:true};
 const state=readCodexContextState(db),details=contextDetailsState(db);
 if(!state||codexContextPending(db,state)||!details||details.pending||contextWindowRangesPending(db)||db.query("SELECT 1 FROM codex_context_model_pending LIMIT 1").get())return {written,processed,pending:true};
 const now=options.now??Date.now(),day=new Date(now).toISOString().slice(0,10),ledger=finalContextPolicy(options.rates),proxy=finalContextDatabase(db,true);
 const projectDay=(db.query("SELECT value FROM project_plan_state WHERE key='price-date'").get() as {value:string}|null)?.value??day;
 const referenceDay=(row:FinalWindowSource)=>{try{const value=JSON.parse(row.reference??'null')?.day;return /^\d{4}-\d{2}-\d{2}$/.test(value??'')?value:projectDay;}catch{return projectDay;}};
 const inputsOf=(row:FinalWindowSource|null)=>{
   if(!row)return finalHash(null);const models=new Set<string>((JSON.parse(row.rail).by_model??[]).map((m:any)=>m.model)),ref=referenceDay(row);
   const within=(rule:{model:string;valid_from:string;valid_until?:string})=>models.has(rule.model)&&(
     Date.parse(rule.valid_from)<Date.parse(row.end_ts)&&(!rule.valid_until||Date.parse(rule.valid_until)>Date.parse(row.start_ts))||
     rule.valid_from<=ref&&(!rule.valid_until||ref<rule.valid_until));
   return finalHash(["reference-base-1",sourceStamp(db,row),ledger.policy.policy.base_rules.filter(within),ledger.policy.policy.tier_rules.filter(within),ledger.policy.policy.mappings,ledger.policy.policy.tiers,
     codexLedgerReferenceRevision(ledger.bands.filter(b=>models.has(b.model)),ref)]);
 };
 const configuration=finalHash([options.catalog,options.config]);
 if(finalState(db,"configuration")!==configuration)db.transaction(()=>{setFinalState(db,"configuration",configuration);setFinalState(db,"catalog",finalHash(options.catalog));setFinalState(db,"ready","0");}).immediate();
 const policy=finalHash(ledger.policy.policy),priorPolicy=finalState(db,"policy");
 if(priorPolicy!==policy||finalState(db,"window-inputs")!=="3"){
   const windows=db.query("SELECT account,counter,window_id,inputs FROM codex_context_final_windows").all() as {account:string;counter:string;window_id:string;inputs:string}[];
   db.transaction(()=>{for(const old of windows){const row=source(db,[old.account,old.counter,old.window_id]);if(old.inputs!==inputsOf(row))db.query("INSERT OR IGNORE INTO codex_context_final_pending VALUES(?,?,?)").run(old.account,old.counter,old.window_id);}
     setFinalState(db,"policy",policy);setFinalState(db,"window-inputs","3");setFinalState(db,"ready","0");}).immediate();
 }
 db.query(`INSERT OR IGNORE INTO codex_context_final_pending SELECT w.account,w.counter,w.window_id FROM window_point_values p
   JOIN limit_windows w ON w.provider=p.provider AND w.account=p.account AND w.counter=p.counter AND w.start_ts=p.window_start
   LEFT JOIN codex_context_final_window_point_values c USING(provider,account,counter,window_start)
   WHERE p.provider='codex' AND (c.inputs_rev IS NULL OR c.inputs_rev<>p.inputs_rev OR c.status<>p.status OR c.computed_at<>p.computed_at)`).run();
 db.query(`INSERT OR IGNORE INTO codex_context_final_pending SELECT u.account,u.counter,u.window_id FROM codex_context_final_window_usage u
   JOIN codex_context_final_window_point_values p ON p.provider=u.provider AND p.account=u.account AND p.counter=u.counter AND p.window_start=u.start_ts
   LEFT JOIN window_point_values n USING(provider,account,counter,window_start) WHERE u.provider='codex' AND n.provider IS NULL`).run();
 const queue=db.query("SELECT * FROM codex_context_final_pending ORDER BY account,counter,window_id LIMIT 1").all() as {account:string;counter:string;window_id:string}[];
 for(const key of queue){
   const args=[key.account,key.counter,key.window_id] as const,row=source(db,args),stamp=sourceStamp(db,row),revision=state.revision;
   const old=db.query("SELECT inputs FROM codex_context_final_windows WHERE account=? AND counter=? AND window_id=?").get(...args) as {inputs:string}|null;
   const signature=inputsOf(row);
   const result=row&&old?.inputs!==signature?computeFinalContextWindow(db,options.rates,row,options.config.subscriptions,referenceDay(row)):null;
   if(options.canWrite?.()===false||readCodexContextState(db)?.revision!==revision||sourceStamp(db,source(db,args))!==stamp)return {written,processed,pending:true};
   db.transaction(()=>{
     if(codexContextPending(db)||readCodexContextState(db)?.revision!==revision||sourceStamp(db,source(db,args))!==stamp)return;
     setFinalState(db,"ready","0");
     db.query(`DELETE FROM codex_context_final_window_point_values AS c WHERE provider='codex' AND account=? AND counter=?
       AND NOT EXISTS(SELECT 1 FROM window_point_values p WHERE p.provider=c.provider AND p.account=c.account AND p.counter=c.counter AND p.window_start=c.window_start)`).run(key.account,key.counter);
     if(!row){db.query("DELETE FROM codex_context_final_window_point_values WHERE provider='codex' AND account=? AND counter=? AND window_start IN (SELECT start_ts FROM codex_context_final_window_usage WHERE provider='codex' AND account=? AND counter=? AND window_id=?)").run(key.account,key.counter,...args);db.query("DELETE FROM codex_context_final_window_usage WHERE provider='codex' AND account=? AND counter=? AND window_id=?").run(...args);db.query("DELETE FROM codex_context_final_windows WHERE account=? AND counter=? AND window_id=?").run(...args);}
     else if(result){
       saveObject(db,"codex_context_final_window_usage",{provider:"codex",account:row.account,counter:row.counter,window_id:row.window_id,start_ts:row.start_ts,end_ts:row.end_ts,
         cycle:JSON.stringify(result.sums.cycle),rail:JSON.stringify(result.sums.rail),readings:JSON.stringify(result.sums.readings),slices:JSON.stringify(result.sums.slices),reference:JSON.stringify(result.sums.reference)});
       if(result.point)saveObject(db,"codex_context_final_window_point_values",{...result.point});
       else db.query("DELETE FROM codex_context_final_window_point_values WHERE provider='codex' AND account=? AND counter=? AND window_start=?").run(key.account,key.counter,row.start_ts);
       db.query("INSERT OR REPLACE INTO codex_context_final_windows VALUES(?,?,?,?,?)").run(...args,signature,result.missing);
       written++;
     }
     setFinalState(db,"account:"+key.account,String(Number(finalState(db,"account:"+key.account)??0)+1));
     db.query("DELETE FROM codex_context_final_pending WHERE account=? AND counter=? AND window_id=?").run(...args);
     db.query("DELETE FROM codex_context_final_subscription_capacity_state WHERE key='inputs'").run();
     setFinalState(db,"revision",String(Number(finalState(db,"revision")??0)+1));
   }).immediate();processed++;
 }
 if(queue.length)return {written,processed,pending:true};
 const canWrite=()=>options.canWrite?.()!==false&&readCodexContextState(db)?.revision===state.revision&&!codexContextPending(db);
 const rates=advanceSubscriptionRates(proxy,{...options,providers:["codex"],canWrite,limit:1});
 if(rates?.pending)return {written:written+(rates?.processed??0),processed:processed+(rates?.processed??0),pending:true};
 const projects=advanceProjectPlanFacts(proxy,{...options,providers:["codex"],scopePeaks:true,canWrite,limit:1,referenceDay:projectDay,
   readCalls:(_provider,from)=>readFinalProjectCalls(db,options,from,projectDay),
   contextRevision:(models,from,referenceDay)=>finalHash(["scoped-peaks-1",ledger.bands.filter(b=>(!models||models.includes(b.model))&&((b.validFrom<=from&&(!b.validUntil||from<b.validUntil))||(b.validFrom<=referenceDay&&(!b.validUntil||referenceDay<b.validUntil))))]) });
 if(projects?.pending)return {written:written+(projects?.processed??0),processed:processed+(projects?.processed??0),pending:true};
 const catalog=finalHash(options.catalog),plans=loadPeriods(db,PLAN_PERIODS),fx=storedFxLookup(db);
 const accounts=db.query("SELECT DISTINCT account FROM billing_cycles WHERE provider='codex' ORDER BY account").all() as {account:string}[];
 for(const {account}of accounts){
   const base=db.query("SELECT * FROM billing_cycles WHERE provider='codex' AND account=? ORDER BY start_ts").all(account) as StoredCycleRow[];
   const signature=finalHash([base,finalState(db,"account:"+account),catalog,plans.filter(p=>p.provider==='codex'&&p.subject===account)]);
   if(finalState(db,"billing:"+account)===signature)continue;
   const rows:StoredCycleRow[]=[];
   for(const old of base){const at=Date.parse(old.computed_at),inputs=new AccountInputs(proxy,{provider:"codex",account},options.catalog),derived=deriveAccountCycles(plans,inputs,options.catalog,at,fx).find(c=>new Date(c.start).toISOString()===old.start_ts&&new Date(c.end).toISOString()===old.end_ts&&inputs.planKey(c.plan)===inputs.planKey(old.plan));
     if(derived)rows.push(overlayBillingApi(old,cycleRow(inputs,derived,at)));else rows.push(old);}
   if(!canWrite())return {written,processed,pending:true};
   db.transaction(()=>{for(const row of rows){const old=db.query("SELECT api_usd,capacity_usd,detail,inputs_rev,computed_at FROM codex_context_final_billing_cycles WHERE provider='codex' AND account=? AND start_ts=?").get(account,row.start_ts) as Partial<StoredCycleRow>|null;
     if(!old||old.api_usd!==row.api_usd||old.capacity_usd!==row.capacity_usd||old.detail!==row.detail||old.inputs_rev!==row.inputs_rev||old.computed_at!==row.computed_at){saveObject(db,"codex_context_final_billing_cycles",row as unknown as Record<string,unknown>);written++;}}
     setFinalState(db,"billing:"+account,signature);setFinalState(db,"revision",String(Number(finalState(db,"revision")??0)+1));}).immediate();
   return {written,processed:processed+1,pending:true};
 }
 if(canWrite())db.transaction(()=>{setFinalState(db,"ready","1");setFinalState(db,"reference",codexLedgerReferenceRevision(ledger.bands,projectDay));setFinalState(db,"source-revision",String(state.revision));setFinalState(db,"detail-revision",String(details.revision));}).immediate();
 return {written,processed,pending:false};
}
