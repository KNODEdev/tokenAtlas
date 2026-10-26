import publishedPlans from '../../plans-catalog.json';
import publishedRates from '../../rate-cards.json';
import type {RateWindow} from './subscription-rate';

export const COMPARISON_VERSION=1;
const fields=['v','week','vendor','plan','pp','value100','priceDate','rate','hours','mix','quality'];
export const PUBLIC_COMPARISON_PLANS=new Map(publishedPlans.provider_groups.flatMap(g=>{
  const vendor=g.aliases.includes('claude')?'claude':g.aliases.includes('codex')?'codex':null;
  return vendor?g.plans.map(p=>[p.plan_id,{vendor,label:p.label}] as const):[];
}));
const publicModels=new Set([...Object.keys(publishedRates.vendors.anthropic.models),...Object.keys(publishedRates.vendors.openai.models),'other']);
export interface ComparisonPayload {
  v:1;week:string;vendor:'claude'|'codex';plan:string;pp:number;value100:number;priceDate:string;
  rate:number;hours:number|null;mix:Array<[string,number]>;quality:'preliminary'|'conditional'|'measured';
}
export class ComparisonCodeError extends Error {
  constructor(readonly reason:'malformed'|'integrity'|'newer_version'|'unsupported_plan'|'invalid_fields'|'measurement_unavailable'){
    super(reason);this.name='ComparisonCodeError';
  }
}
export function isoWeek(at:string):string {
  const date=new Date(at);if(!Number.isFinite(date.getTime()))throw new ComparisonCodeError('invalid_fields');
  date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()+4-(date.getUTCDay()||7));
  const year=date.getUTCFullYear(),first=new Date(0);first.setUTCFullYear(year,0,1);first.setUTCHours(0,0,0,0);
  const week=Math.ceil(((date.getTime()-first.getTime())/86_400_000+1)/7);
  return year+'-W'+String(week).padStart(2,'0');
}
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
function validate(value:unknown):asserts value is ComparisonPayload {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ComparisonCodeError('invalid_fields');
  const p=value as Record<string,unknown>;
  if(typeof p.v==='number'&&p.v>1)throw new ComparisonCodeError('newer_version');
  if(Object.keys(p).length!==fields.length||fields.some(f=>!Object.hasOwn(p,f))||p.v!==1)throw new ComparisonCodeError('invalid_fields');
  const plan=typeof p.plan==='string'?PUBLIC_COMPARISON_PLANS.get(p.plan):null;
  if(!plan||plan.vendor!==p.vendor)throw new ComparisonCodeError('unsupported_plan');
  if(typeof p.week!=='string'||!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(p.week)
    ||p.week>isoWeek(p.week.slice(0,4)+'-12-28')
    ||typeof p.priceDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.priceDate)
    ||!Number.isFinite(Date.parse(p.priceDate))||new Date(p.priceDate).toISOString().slice(0,10)!==p.priceDate)
    throw new ComparisonCodeError('invalid_fields');
  if(!finite(p.pp)||!Number.isInteger(p.pp)||(p.pp as number)<0||(p.pp as number)>100
    ||!finite(p.value100)||!Number.isInteger(p.value100)||(p.value100 as number)<0||(p.value100 as number)%50!==0
    ||!finite(p.rate)||(p.rate as number)<0||(p.rate as number)>1e9||Math.abs((p.rate as number)*10-Math.round((p.rate as number)*10))>1e-7
    ||p.hours!==null&&(!finite(p.hours)||!Number.isInteger(p.hours)||(p.hours as number)<0||(p.hours as number)>10000))throw new ComparisonCodeError('invalid_fields');
  if(!['preliminary','conditional','measured'].includes(p.quality as string)||!Array.isArray(p.mix)||p.mix.length>publicModels.size)throw new ComparisonCodeError('invalid_fields');
  const seen=new Set<string>();
  for(const m of p.mix){
    if(!Array.isArray(m)||m.length!==2||typeof m[0]!=='string'||!publicModels.has(m[0])||seen.has(m[0])
      ||!finite(m[1])||!Number.isInteger(m[1])||m[1]<0||m[1]>100||m[1]%10!==0)throw new ComparisonCodeError('invalid_fields');
    seen.add(m[0]);
  }
}
const bytes=(text:string)=>new TextEncoder().encode(text);
async function checksum(text:string):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',bytes(text));
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('').slice(0,24);
}
function toBase64(text:string):string {
  return btoa(String.fromCharCode(...bytes(text))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export async function encodeComparisonCode(window:RateWindow):Promise<string>{
  if(!window.closed||window.rate===null||window.value_100_usd===null||window.used_pp===null||!window.plan_id)throw new ComparisonCodeError('measurement_unavailable');
  const models=new Map<string,number>();
  for(const m of window.mix){
    if(!Number.isFinite(m.share)||m.share<0||m.share>1)throw new ComparisonCodeError('invalid_fields');
    const name=publicModels.has(m.model)?m.model:'other';models.set(name,(models.get(name)??0)+m.share);
  }
  // This whitelist is the complete transport. Never spread the source window into a share payload.
  const payload:ComparisonPayload={v:1,week:isoWeek(window.start),vendor:window.provider,plan:window.plan_id,
    pp:Math.round(window.used_pp),value100:Math.round(window.value_100_usd/50)*50,priceDate:window.price_date,
    rate:Math.round(window.rate*10)/10,hours:window.hours_per_100===null?null:Math.round(window.hours_per_100),
    mix:[...models].sort(([a],[b])=>a.localeCompare(b)).map(([model,share])=>[model,Math.round(share*10)*10]),
    quality:window.preliminary||window.capacity?.capacity_basis!=='measured'?'preliminary':window.provider==='claude'?'conditional':'measured'};
  validate(payload);const data=toBase64(JSON.stringify(payload));return 'TA1-'+data+'.'+await checksum(data);
}
export async function decodeComparisonCode(code:string):Promise<ComparisonPayload>{
  const trimmed=code.trim();
  if(trimmed.length>8192)throw new ComparisonCodeError('malformed');
  const prefix=/^TA(\d+)-/.exec(trimmed);if(prefix&&Number(prefix[1])>1)throw new ComparisonCodeError('newer_version');
  const match=/^TA1-([A-Za-z0-9_-]+)\.([a-f0-9]{24})$/.exec(trimmed);
  if(!match)throw new ComparisonCodeError('malformed');
  if(await checksum(match[1]!)!==match[2])throw new ComparisonCodeError('integrity');
  let payload:unknown;
  try{const text=atob(match[1]!.replaceAll('-','+').replaceAll('_','/'));payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(text,c=>c.charCodeAt(0))))}
  catch{throw new ComparisonCodeError('malformed')}
  validate(payload);
  // Reject hidden duplicate keys, ignored whitespace and alternate byte encodings too.
  if(toBase64(JSON.stringify(payload))!==match[1])throw new ComparisonCodeError('malformed');
  return payload;
}
export const comparisonMatches=(p:ComparisonPayload,w:RateWindow)=>p.vendor===w.provider&&p.plan===w.plan_id&&p.week===isoWeek(w.start)&&w.closed;
