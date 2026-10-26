import {withFinalContext} from "./codex-context-final-read";
import type {Database} from 'bun:sqlite';
import {hasProjectPlan,readProjectPlanSlices} from '../db/project-plan';
import {readCapacityWindows} from '../db/subscription-capacity';
import {resolvePlanVersion,type PlansCatalog} from './plans-catalog';
import type {RateWindow} from '../shared/subscription-rate';
import {ownWindowCapacity,projectPlanResult,type ProjectPlanCapacity,type ProjectPlanResponse,type ProjectPlanSlice,weightedPlanWeeks} from '../shared/project-plan';
const empty=(date:string,reason:string):ProjectPlanCapacity=>({weekly:null,session:null,price:null,estimate:false,preliminary:true,date,reason});
/** Scaling uses only the official catalog ratio and a measured base valid under that dated version. */
export function chosenPlanCapacity(windows:readonly RateWindow[],catalog:PlansCatalog,provider:'claude'|'codex',plan:string,day:string,slice?:ProjectPlanSlice):ProjectPlanCapacity {
  if(slice?.account===null)return empty(day,'attribution_missing');
  const target=resolvePlanVersion(catalog,provider,plan,day);
  if(target.kind!=='ok')return empty(day,'plan_version_missing');
  const price=target.version.usd_per_month;
  const own=slice?windows.find(w=>w.provider===provider&&w.account===slice.account&&w.id===slice.window_id):undefined;
  if(own?.plan_id===plan)return own.plan_version===target.version_id?{...ownWindowCapacity(own),price,date:day}
    :{...empty(day,'base_version_mismatch'),price};
  const at=Date.parse(day+'T12:00:00Z');
  const candidates=windows.filter(w=>w.provider===provider&&Date.parse(w.start)<=at&&Date.parse(w.end)>at);
  const direct=candidates.find(w=>w.plan_id===plan&&w.plan_version===target.version_id&&w.value_100_usd!==null);
  if(direct)return {...ownWindowCapacity(direct),price,date:day};
  const base=own??candidates.at(-1);
  if(!base||base.value_100_usd===null||!base.plan_id)return {...empty(day,base?.absent??'capacity_missing'),price};
  const version=resolvePlanVersion(catalog,provider,base.plan_id,day);
  if(version.kind!=='ok'||version.version_id!==base.plan_version)return {...empty(day,'base_version_mismatch'),price};
  const to=target.version.limits?.credits_multiplier,from=version.version.limits?.credits_multiplier;
  if(typeof to!=='number'||typeof from!=='number'||to<=0||from<=0)return {...empty(day,'multiplier_missing'),price};
  const factor=to/from;
  return {weekly:base.value_100_usd*factor,session:base.capacity?.session_window_value_usd==null?null:base.capacity.session_window_value_usd*factor,
    price,estimate:true,preliminary:base.preliminary,date:day,reason:price===null?'price_missing':null};
}
function todayCapacity(windows:readonly RateWindow[],catalog:PlansCatalog,provider:'claude'|'codex',plan:string,day:string):ProjectPlanCapacity {
  const newest=[...windows.filter(w=>w.provider===provider)].sort((a,b)=>a.end.localeCompare(b.end)).at(-1);
  if(!newest)return empty(day,'capacity_missing');
  // Today's open window carries the current native model; its rate series is still marked open.
  const value=newest.capacity?.weekly_window_value_usd??null;
  const base={...newest,value_100_usd:value,absent:value===null?newest.capacity?.capacity_reason??'capacity_missing':null};
  return chosenPlanCapacity([base],catalog,provider,plan,day,{provider,account:base.account,subject:'',day,window_id:base.id,historical:0,today:0,peak:0,today_peak:0,calls:0});
}
export function readProjectPlanConversion(db:Database,catalog:PlansCatalog,project?:string,selected:readonly string[]=[],now=Date.now(),context=false):ProjectPlanResponse {
  return withFinalContext(db,context,source=>readProjectPlanBody(source,catalog,project,selected,now),{catalog,source:"project"});
}
function readProjectPlanBody(db:Database,catalog:PlansCatalog,project:string|undefined,selected:readonly string[],now:number):ProjectPlanResponse {
  const all=readProjectPlanSlices(db),slices=all.filter(s=>s.subject===project),windows=readCapacityWindows(db);
  const providers=new Set(slices.map(s=>s.provider));
  const plans=catalog.provider_groups.flatMap(g=>{
    const provider=g.aliases.includes('codex')?'codex':g.aliases.includes('claude')?'claude':null;
    return provider&&providers.has(provider)?g.plans.map(p=>({provider:provider as 'codex'|'claude',id:p.plan_id,label:p.label})):[];
  });
  const state=hasProjectPlan(db)?new Map((db.query('SELECT key,value FROM project_plan_state').all() as {key:string;value:string}[]).map(r=>[r.key,r.value])):new Map<string,string>();
  const preparing=state.get('ready')!=='1',stale=hasProjectPlan(db)&&!!db.query('SELECT 1 FROM project_plan_dirty LIMIT 1').get();
  const today=state.get('price-date')??new Date(now).toISOString().slice(0,10);
  const rows=plans.filter(p=>selected.includes(p.id)).flatMap(p=>{
    const usage=slices.filter(s=>s.provider===p.provider),last=usage.at(-1);
    const capacity=(s:ProjectPlanSlice)=>chosenPlanCapacity(windows,catalog,p.provider,p.id,s.day,s);
    const current=todayCapacity(windows,catalog,p.provider,p.id,today),reference=last?capacity(last):empty(today,'no_vendor_traffic');
    return (['historical','today'] as const).map(mode=>{
      const result=projectPlanResult({provider:p.provider,plan_id:p.id,label:p.label,mode,slices:usage,capacity,current,reference});
      return state.get('filled')!=='1'||mode==='today'&&preparing?{...result,api_usd:null,weeks:null,months:null,pro_rata:null,whole_months:null,sessions:null,five_hour_limited:null,absent:'valuation_preparing'}:result;
    });
  });
  return {projects:[...new Set(all.map(s=>s.subject))].sort(),plans,rows,preparing,stale};
}
/** The drawer's weekly equivalent is the same weighted historical sum, for its selected range/account. */
export function storedProjectWeeks(db:Database,subject:string,account:string,period:{since?:string|null;until?:string|null}):number|null {
  return historicalProjectWeeks(db,period).get(JSON.stringify([account,subject]))??null;
}
export function historicalProjectWeeks(db:Database,period:{since?:string|null;until?:string|null}):Map<string,number|null> {
  if(!hasProjectPlan(db)||(db.query("SELECT value FROM project_plan_state WHERE key='filled'").get() as {value:string}|null)?.value!=='1')return new Map();
  const slices=readProjectPlanSlices(db,period),windows=readCapacityWindows(db),groups=new Map<string,ProjectPlanSlice[]>();
  for(const s of slices){const key=JSON.stringify([s.account,s.subject]);(groups.get(key)??groups.set(key,[]).get(key)!).push(s);}
  return new Map([...groups].map(([key,rows])=>[key,weightedPlanWeeks(rows,s=>ownWindowCapacity(windows.find(w=>w.provider===s.provider&&w.account===s.account&&w.id===s.window_id)))]));
}
