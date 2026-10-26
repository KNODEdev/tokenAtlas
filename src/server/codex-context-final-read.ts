import type {Database} from "../db/sqlite";
import {normEraKey} from "./eras";
import {withReadSnapshot} from "../db/analysis";
import {readCodexContextState,codexContextPending} from "../db/codex-context-producer";
import {contextDetailsState,contextWindowRangesPending} from "../db/codex-context-details";
import {hasFinalContext,finalState,finalContextDatabase,finalHash} from "./codex-context-final-store";
import type {ContextPreviewResponse,ContextPreviewStatus} from "../shared/context-preview";
import type {JsonResponse} from "./codex-context-preview";

export type FinalContextSource="project"|"rate"|"plan"|"billing";
export function finalSourcePending(db:Database,kind:FinalContextSource,account?:string|null):boolean {
 const sums=!!db.query(`SELECT 1 FROM window_usage_dirty d JOIN window_usage w ON w.provider='codex'
   AND d.provider IN ('codex','*') AND d.account IN (w.account,'*') AND d.counter IN (w.counter,'*')
   AND d.from_ms<unixepoch(w.end_ts)*1000 AND (d.until_ms IS NULL OR d.until_ms>unixepoch(w.start_ts)*1000)
   WHERE (? IS NULL OR w.account=?) LIMIT 1`).get(account??null,account??null)
   ||!!db.query("SELECT 1 FROM window_usage_pending WHERE provider='codex' AND (? IS NULL OR account=?) LIMIT 1").get(account??null,account??null);
 if(sums)return true;
 if((kind==="project"||kind==="rate")&&db.query("SELECT 1 FROM subscription_capacity_dirty WHERE provider IN ('codex','*') AND (? IS NULL OR account IN (?,'*')) LIMIT 1").get(account??null,account??null))return true;
 return kind==="project"&&!!db.query("SELECT 1 FROM project_plan_dirty WHERE provider IN ('codex','*') LIMIT 1").get();
}
export const FINAL_CONTEXT_PATHS=new Set(["/api/project-plan","/api/billing-cycles","/api/plan-capacity","/api/subscription-rate"]);
export function finalContextStamp(db:Database,path?:string){return hasFinalContext(db)?[
 db.query("SELECT key,value FROM codex_context_final_state WHERE key IN ('version','revision','ready','policy','configuration','source-revision','detail-revision') ORDER BY key").all(),
 db.query("SELECT key,value FROM codex_context_final_subscription_capacity_state WHERE key IN ('revision','ready') ORDER BY key").all(),
 db.query("SELECT key,value FROM codex_context_final_project_plan_state WHERE key IN ('revision','ready') ORDER BY key").all(),
 !!db.query("SELECT 1 FROM codex_context_final_pending LIMIT 1").get(),!!db.query("SELECT 1 FROM codex_context_final_project_plan_dirty LIMIT 1").get(),contextDetailsState(db),contextWindowRangesPending(db),
 db.query("SELECT * FROM window_usage_dirty WHERE provider IN ('codex','*') ORDER BY provider,account,counter,from_ms").all(),
 db.query("SELECT * FROM window_usage_pending WHERE provider='codex' ORDER BY account,counter,window_id").all(),
 ...(path==="/api/project-plan"||path==="/api/subscription-rate"?[db.query("SELECT * FROM subscription_capacity_dirty WHERE provider IN ('codex','*') ORDER BY provider,account,from_ms").all()]:[]),
 ...(path==="/api/project-plan"?[db.query("SELECT * FROM project_plan_dirty WHERE provider IN ('codex','*') ORDER BY provider,day").all()]:[]),
 ...(path==="/api/billing-cycles"?[db.query("SELECT * FROM billing_cycle_dirty WHERE provider IN ('codex','*') ORDER BY provider,account").all()]:[])
 ]:null;}
function statusOf(db:Database,account?:string|null,catalog?:unknown,billing=false,kind?:FinalContextSource):ContextPreviewStatus{
 account=account?normEraKey(account):null;
 const source=readCodexContextState(db),details=contextDetailsState(db),exists=hasFinalContext(db);
 return {revision:exists?Number(finalState(db,"revision")??0):0,ready:exists&&finalState(db,"version")==="1"&&finalState(db,"ready")==="1"
   &&!!source&&!codexContextPending(db,source)&&!!details&&!details.pending&&!contextWindowRangesPending(db)
   &&(!kind||!finalSourcePending(db,kind,account))
   &&finalState(db,"source-revision")===String(source.revision)&&finalState(db,"detail-revision")===String(details.revision)
   &&!db.query("SELECT 1 FROM codex_context_model_pending LIMIT 1").get()
   &&(!billing||!db.query("SELECT 1 FROM billing_cycle_dirty WHERE provider IN ('codex','*') AND (? IS NULL OR account IN (?,'*')) LIMIT 1").get(account??null,account??null))
   &&(!catalog||finalState(db,"catalog")===finalHash(catalog))
   &&!db.query(`SELECT 1 FROM window_point_values p LEFT JOIN codex_context_final_window_point_values c USING(provider,account,counter,window_start)
     WHERE p.provider='codex' AND (c.inputs_rev IS NULL OR p.inputs_rev<>c.inputs_rev OR p.status<>c.status OR p.computed_at<>c.computed_at) LIMIT 1`).get()
   &&!db.query(`SELECT 1 FROM codex_context_final_window_point_values c LEFT JOIN window_point_values p USING(provider,account,counter,window_start)
     WHERE c.provider='codex' AND p.provider IS NULL LIMIT 1`).get()
   &&!db.query(`SELECT 1 FROM billing_cycles b LEFT JOIN codex_context_final_billing_cycles c USING(provider,account,start_ts)
     WHERE b.provider='codex' AND (c.inputs_rev IS NULL OR b.inputs_rev<>c.inputs_rev OR b.computed_at<>c.computed_at) LIMIT 1`).get()
   &&!db.query("SELECT 1 FROM codex_context_final_pending LIMIT 1").get()
   &&!db.query("SELECT 1 FROM codex_context_final_project_plan_dirty LIMIT 1").get()
   &&!db.query("SELECT 1 FROM window_point_value_dirty WHERE provider IN ('codex','*') LIMIT 1").get(),
   missing_groups:exists?Number((db.query("SELECT coalesce(sum(missing),0) n FROM codex_context_final_windows WHERE (? IS NULL OR account=?)").get(account??null,account??null) as {n:number}).n):0};
}
const apiKeys=new Set(["api_usd","api_standard","api_normalized","api_usd_per_1pct","usd_per_1pct","usd_per_point","weekly_window_value_usd","session_window_value_usd","value_100_usd","rate","fixed_api_usd","common_historical_usd","common_fixed_usd","capacity_usd","api_by_type","usd_per_1m","leverage","reference_api_standard","paired_historical_api","paired_reference_api"]);
const identity=(value:unknown):string|null=>{
 if(!value||typeof value!=="object")return null;const row=value as Record<string,unknown>;
 const part=row.id!==undefined?[row.id]:row.mode!==undefined&&row.plan_id!==undefined?[row.plan_id,row.mode]:row.account!==undefined?[row.account]:row.start!==undefined?[row.start,row.end]:row.name!==undefined?[row.name]:null;
 return part?JSON.stringify([row.provider??null,...part]):null;
};
/** The recalculated monetary branch must not change a provider's token/credit/percentage observations or payments. */
export function mergeFinalApi<T>(base:T,preview:T):T {
 if(base===null||preview===null||typeof base!=="object"||typeof preview!=="object")return base;
 if(Array.isArray(base)){const rows=preview as unknown[],byIdentity=new Map(rows.map(row=>[identity(row),row]));
   return base.map((value,i)=>mergeFinalApi(value,identity(value)===null?rows[i]:byIdentity.get(identity(value)))) as T;}
 const old=base as Record<string,unknown>,next=preview as Record<string,unknown>;
 if(old.provider!==next.provider)return base;
 if(typeof old.provider==="string"&&!['codex','openai'].includes(old.provider))return base;
 const result={...old};
 if(old.provider==="codex"&&("mode" in old)&&("plan_id" in old)) {
   for(const key of ["weeks","months","pro_rata","whole_months","sessions","five_hour_limited","absent","session_absent"])if(key in next)result[key]=next[key];
 }
 if(next.context_api_calibration)result.context_api_calibration=next.context_api_calibration;
 for(const key of Object.keys(old)){
   if(apiKeys.has(key)||key==="api")result[key]=next[key]===undefined?old[key]:next[key];
   else if(old[key]&&next[key]&&typeof old[key]==="object"&&typeof next[key]==="object")result[key]=mergeFinalApi(old[key],next[key]);
 }
 return result as T;
}
function missingApiPair(base:unknown,preview:unknown):boolean {
 if(!base||!preview||typeof base!=="object"||typeof preview!=="object")return false;
 if(Array.isArray(base)){if(!Array.isArray(preview))return true;const byId=new Map(preview.map(row=>[identity(row),row]));return base.some((row,i)=>missingApiPair(row,identity(row)===null?preview[i]:byId.get(identity(row))));}
 const old=base as Record<string,unknown>,next=preview as Record<string,unknown>;
 if(old.provider!==next.provider||typeof old.provider==="string"&&!['codex','openai'].includes(old.provider))return false;
 return Object.keys(old).some(key=>{
   if((apiKeys.has(key)||key==="api")&&key in next){
     const amount=(value:unknown)=>value&&typeof value==="object"&&"value" in value?(value as {value:unknown}).value:value;
     const a=amount(old[key]),b=amount(next[key]);if((a===null&&typeof b==="number")||(b===null&&typeof a==="number"))return true;
   }
   return missingApiPair(old[key],next[key]);
 });
}
export function withFinalContext<T>(db:Database,on:boolean,read:(db:Database)=>T,options:{account?:string|null;catalog?:unknown;plan?:boolean;billing?:boolean;source?:FinalContextSource}={}):T & ContextPreviewResponse<T>{
 if(!on)return read(db) as T & ContextPreviewResponse<T>;
 return withReadSnapshot(db,()=>{
   const base=read(db);
   if(base instanceof Response)return base as T & ContextPreviewResponse<T>;
   const status=statusOf(db,options.account,options.catalog,options.billing,options.source??(options.billing?"billing":undefined));
   if(!base||typeof base!=="object")return base as T & ContextPreviewResponse<T>;
   if(!status.ready||status.missing_groups)return {...base,context_preview_status:status};
   const preview=read(finalContextDatabase(db));
   if(preview instanceof Response)return {...base,context_preview_status:{...status,ready:false}};
   if(missingApiPair(base,preview)){status.missing_groups++;return {...base,context_preview_status:status};}
   if(options.plan&&(preview as any)?.primary?.source==="default_reference"&&(preview as any)?.primary?.api_usd_per_1pct?.value!=null){
     status.missing_groups++;return {...base,context_preview_status:status};
   }
   return {...base,context_preview:mergeFinalApi(base,preview),context_preview_status:status};
 });
}
export function finalContextResponse(db:Database,on:boolean,read:(db:Database,json:JsonResponse)=>Response,options:{account?:string|null;catalog?:unknown;plan?:boolean;billing?:boolean;source?:FinalContextSource}={}):Response{
 if(!on)return read(db,Response.json);
 let init:ResponseInit|undefined,body:unknown;
 const value=withFinalContext(db,true,source=>{body=undefined;const response=read(source,(value,options)=>{body=value;init=options;return new Response(null,options);});
   if(response.status!==200||body===undefined)return body===undefined?response:Response.json(body,init);return body;},options);
 return value instanceof Response?value:Response.json(value,init);
}
