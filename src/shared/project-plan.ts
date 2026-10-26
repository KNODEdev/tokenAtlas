import type {RateWindow} from './subscription-rate';
import {WEEKS_PER_MONTH} from './subscription-rate';
export interface ProjectPlanSlice {
  provider:'claude'|'codex';account:string|null;subject:string;day:string;window_id:string|null;
  historical:number|null;today:number|null;peak:number|null;today_peak:number|null;calls:number;
}
export interface ProjectPlanCapacity {weekly:number|null;session:number|null;price:number|null;estimate:boolean;preliminary:boolean;date:string;reason:string|null}
export interface ProjectPlanResult {
  provider:'claude'|'codex';plan_id:string;label:string;mode:'historical'|'today';api_usd:number|null;
  weeks:number|null;months:number|null;pro_rata:number|null;whole_months:number|null;
  sessions:number|null;five_hour_limited:boolean|null;estimate:boolean;preliminary:boolean;
  reference_date:string;capacity_usd:number|null;absent:string|null;session_absent:string|null;
}
export interface ProjectPlanResponse {
  projects:string[];plans:Array<{provider:'claude'|'codex';id:string;label:string}>;rows:ProjectPlanResult[];preparing:boolean;stale:boolean;
}
/** Shared weighted equivalent, also used by the project drawer. A missing slice never becomes zero. */
export function weightedPlanWeeks(slices:readonly ProjectPlanSlice[],capacity:(slice:ProjectPlanSlice)=>ProjectPlanCapacity):number|null {
  if(!slices.length)return null;
  let weeks=0;
  for(const slice of slices){const c=capacity(slice);if(slice.historical===null||c.weekly===null||c.weekly<=0)return null;weeks+=slice.historical/c.weekly;}
  return weeks;
}
export function projectPlanResult(input:{provider:'claude'|'codex';plan_id:string;label:string;mode:'historical'|'today';slices:readonly ProjectPlanSlice[];
  capacity:(slice:ProjectPlanSlice)=>ProjectPlanCapacity;current:ProjectPlanCapacity;reference:ProjectPlanCapacity}):ProjectPlanResult {
  const selected=input.slices.filter(s=>s.provider===input.provider),today=input.mode==='today';
  const capacities=today?[input.current]:selected.map(input.capacity);
  const values=selected.map(s=>today?s.today:s.historical);
  const api=values.length&&values.every(v=>v!==null)?values.reduce<number>((sum,v)=>sum+v!,0):null;
  // Preserve the first concrete missing reason; the arithmetic never substitutes a subtotal.
  let absent=!selected.length?'no_vendor_traffic':api===null?'valuation_missing':!today&&selected.some(s=>s.account===null)?'attribution_missing':capacities.find(c=>c.reason)?.reason??null;
  if(!absent&&capacities.some(c=>c.weekly===null||c.weekly<=0))absent='capacity_missing';
  if(!absent&&capacities.some(c=>c.price===null||c.price<=0))absent='price_missing';
  const weeks=absent?null:today?api!/input.current.weekly!:weightedPlanWeeks(selected,input.capacity);
  const months=weeks===null?null:weeks/WEEKS_PER_MONTH;
  const proRata=weeks===null?null:today?months!*input.current.price!:selected.reduce((sum,s)=>{const c=input.capacity(s);return sum+s.historical!/c.weekly!*c.price!/WEEKS_PER_MONTH},0);
  const reference=today?input.current:input.reference;
  const whole=months===null||reference.price===null?null:Math.ceil(months)*reference.price;
  const sessionMissing=capacities.some(c=>c.session===null||c.session<=0);
  const sessions=api===null||sessionMissing||absent==='attribution_missing'?null:today?api/input.current.session!:selected.reduce((sum,s)=>sum+s.historical!/input.capacity(s).session!,0);
  const peaks=selected.map(s=>today?s.today_peak:s.peak);
  const limited=sessionMissing||peaks.some(v=>v===null)?null:selected.some((s,i)=>peaks[i]!>(today?input.current:input.capacity(s)).session!);
  return {provider:input.provider,plan_id:input.plan_id,label:input.label,mode:input.mode,api_usd:api,weeks,months,pro_rata:proRata,whole_months:whole,
    sessions,five_hour_limited:limited,estimate:capacities.some(c=>c.estimate),preliminary:capacities.some(c=>c.preliminary),
    reference_date:reference.date,capacity_usd:today?input.current.weekly:null,absent,session_absent:sessionMissing?'session_capacity_missing':api===null?'valuation_missing':null};
}
export const ownWindowCapacity=(window:RateWindow|undefined):ProjectPlanCapacity=>({weekly:window?.absent==='plan_price_missing'
  ?window.capacity?.weekly_window_value_usd??null:window?.value_100_usd??null,
  session:window?.capacity?.session_window_value_usd??null,price:window?.price_usd??null,estimate:false,
  preliminary:window?.preliminary??true,date:window?.price_date??'',reason:window?window.absent:'window_missing'});
