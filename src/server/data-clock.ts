import type {ApiCycle,UsageSeries} from "../web/lib/api";
import type {SourceHealthResponse,SourceHealthRow} from "../shared/source-health";
import { limitPace, windowFromReset } from "../providers/core/limit";

/** When the stored body was built. Presentation needs it; the clock alone never invalidates it. */
export const PREPARED_AT_HEADER="X-Prepared-At";
const HOUR=3600000,MINUTE=60000;
const NODE_BUDGET=200000;
const isoInstant=(value:unknown):number|null=>
  typeof value==="string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const isoDay=(value:unknown):number|null=>
  typeof value==="string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const epochSeconds=(value:unknown):number|null=>
  typeof value==="number" && Number.isFinite(value) && value>0 ? value*1000 : null;
export function preparedAtMs(headers:readonly (readonly [string,string])[]|undefined):number|null {
  const header=headers?.find(([name])=>name.toLowerCase()===PREPARED_AT_HEADER.toLowerCase())?.[1];
  return header===undefined?null:isoInstant(header);
}
// Instants at which a prepared body genuinely changes: a window opens or closes, a
// declaration starts applying. Estimates (eta_100_iso) change nothing when reached.
const END_KEYS=["reset_at","resetIso","resets_at_iso","next_reset","reset","window_end","cycle_end",
  "weekly_resets_at","session_resets_at","boost_ends","expires_at","valid_until","end","end_ts"] as const;
const START_KEYS=["window_start","startIso","start_ts","window_start_iso","cycle_start","start"] as const;
const DATED_KEYS=["from","valid_from","effective_from"] as const;
const EPOCH_SECOND_KEYS=["anchor"] as const;
const first=(node:Record<string,unknown>,keys:readonly string[],parse:(value:unknown)=>number|null):number|null=> {
  for(const key of keys) { const value=parse(node[key]); if(value!==null) return value; }
  return null;
};
/**
 * Earliest instant after `afterMs` at which this body stops describing the present (a kept answer of
 * data-read.ts is computed again from then). Only timestamps the builder itself published are considered.
 */
export function clockBoundaryMs(body:unknown,afterMs:number):number|null {
  let boundary:number|null=null,budget=NODE_BUDGET;
  const consider=(instant:number|null)=> {
    if(instant!==null && instant>afterMs && (boundary===null || instant<boundary)) boundary=instant;
  };
  const walk=(node:unknown,depth:number):void=> {
    if(budget--<=0 || depth>16 || node===null || typeof node!=="object") return;
    if(Array.isArray(node)) { for(const item of node) walk(item,depth+1); return; }
    for(const [key,value] of Object.entries(node as Record<string,unknown>)) {
      if(END_KEYS.includes(key as typeof END_KEYS[number]) || START_KEYS.includes(key as typeof START_KEYS[number])) consider(isoInstant(value));
      else if(DATED_KEYS.includes(key as typeof DATED_KEYS[number])) consider(isoDay(value));
      else if(EPOCH_SECOND_KEYS.includes(key as typeof EPOCH_SECOND_KEYS[number])) consider(epochSeconds(value));
      walk(value,depth+1);
    }
  };
  walk(body,0);
  return boundary;
}

const round=(value:number,places:number)=>Math.round((value+Number.EPSILON)*10**places)/10**places;
const placesOf=(value:number,minimum:number):number=> {
  const text=String(value),dot=text.indexOf(".");
  return Math.min(6,Math.max(minimum,dot<0?0:text.length-dot-1));
};
// Every field below measures wall-clock distance to an instant the body already
// carries, so presentation reproduces exactly what a rebuild would compute.
const AGE_FIELDS:Record<string,{unit:number;places:number;sources:readonly string[]}>={
  // Only an unambiguous observation timestamp counts as the basis; anything else
  // advances by the time that has passed, which is the same arithmetic.
  age_minutes:{unit:MINUTE,places:1,sources:["ts","sampledAtIso","measured_at"]},
  age_hours:{unit:HOUR,places:2,sources:["ts","sampledAtIso","measured_at"]},
  measured_age_minutes:{unit:MINUTE,places:1,sources:["measured_at","ts"]},
  measurement_age_minutes:{unit:MINUTE,places:1,sources:["measured_at","ts"]},
  measured_age_hours:{unit:HOUR,places:2,sources:["measured_at","ts"]},
  gauge_age_hours:{unit:HOUR,places:2,sources:[]},
};
const REMAINING_FIELDS:Record<string,number>={remaining_hours:HOUR,remaining_minutes:MINUTE};
const ELAPSED_FIELDS:Record<string,number>={elapsed_hours:HOUR,elapsed_minutes:MINUTE};
const AHEAD_FIELDS=["pp_ahead","ppAhead"] as const;
const isCycle=(node:Record<string,unknown>):boolean=>
  typeof node.peak_percent==="number" && typeof node.hit_100==="boolean" && typeof node.work_to_ts==="string"
  && (typeof node.window_start_iso==="string" || typeof node.start_ts==="string");
const isProbeHealth=(node:Record<string,unknown>):boolean=>
  typeof node.fresh_minutes==="number" && (node.state==="fresh" || node.state==="stale");

function presentNode(node:Record<string,unknown>,nowMs:number,preparedMs:number):Record<string,unknown> {
  const since=nowMs-preparedMs;
  if(isCycle(node)) {
    const anchorMs=epochSeconds(node.anchor);
    const active=node.is_active===true && (anchorMs===null || anchorMs>nowMs);
    return {...node,...usageCycleClock(node as unknown as ApiCycle,active,nowMs)};
  }
  const result={...node};
  const start=first(node,START_KEYS,isoInstant),end=first(node,END_KEYS,isoInstant);
  const advancingWindow=node.isCurrent!==false && node.is_active!==false && (end===null || end>preparedMs);
  // Work observed inside a window stops at its end; an observation's age never stops.
  const observed=end!==null ? Math.min(nowMs,end) : nowMs;
  for(const [field,rule] of Object.entries(AGE_FIELDS)) {
    const stored=node[field];
    if(typeof stored!=="number" || !Number.isFinite(stored)) continue;
    const source=first(node,rule.sources,isoInstant);
    const age=source!==null ? (nowMs-source)/rule.unit : stored+since/rule.unit;
    result[field]=round(Math.max(0,age),placesOf(stored,rule.places));
  }
  for(const [field,unit] of Object.entries(REMAINING_FIELDS)) {
    if(!advancingWindow)continue;
    const stored=node[field];
    if(typeof stored!=="number" || !Number.isFinite(stored)) continue;
    const remaining=end!==null ? (end-nowMs)/unit : stored-since/unit;
    result[field]=round(Math.max(0,remaining),placesOf(stored,2));
  }
  for(const [field,unit] of Object.entries(ELAPSED_FIELDS)) {
    if(!advancingWindow)continue;
    const stored=node[field];
    if(typeof stored!=="number" || !Number.isFinite(stored)) continue;
    const elapsed=start!==null ? (observed-start)/unit : stored+(observed-preparedMs)/unit;
    result[field]=round(Math.max(0,elapsed),placesOf(stored,2));
  }
  for(const field of ["elapsed_percent","elapsedPercent"] as const) {
    if(!advancingWindow)continue;
    const stored=node[field];
    if(typeof stored!=="number" || !Number.isFinite(stored) || start===null || end===null || end<=start) continue;
    const places=placesOf(stored,2);
    const percent=round(Math.max(0,Math.min(100,((observed-start)/(end-start))*100)),places);
    result[field]=percent;
    // pp_ahead is "used minus elapsed": shifting it by the same delta keeps the pair
    // consistent without re-deriving which percentage the builder used.
    for(const ahead of AHEAD_FIELDS) {
      const value=node[ahead];
      if(typeof value==="number" && Number.isFinite(value)) result[ahead]=round(value+(stored-percent),placesOf(value,places));
    }
  }
  // Claude's current-window forecast uses the same measured/estimated basis as
  // its builder. Historical measurements and token-derived estimates stay fixed.
  if(advancingWindow && "percent_all_measured" in node && "projected_end_percent" in node && start!==null && end!==null && end>start) {
    const percent=node.percent_all_measured ?? node.percent_all_est;
    const timing=windowFromReset(new Date(end).toISOString(),(end-start)/HOUR,observed);
    const pace=limitPace(typeof percent==="number" ? percent : null,timing,1);
    result.projected_end_percent=pace.projectedEndPercent===null?null:round(pace.projectedEndPercent,1);
    result.eta_100_iso=pace.eta100Iso;
  }
  if(isProbeHealth(node)) {
    const reading=node.reading as Record<string,unknown>|null|undefined;
    const ts=isoInstant(reading?.ts);
    if(ts!==null) result.state=(nowMs-ts)/MINUTE<=(node.fresh_minutes as number) ? "fresh":"stale";
  }
  return result;
}

/**
 * Advance age, countdown and live-window semantics of a prepared body to `nowMs`.
 * Valued facts, tokens, percentages and identities are copied unchanged.
 */
export function presentClockFields<T>(body:T,nowMs:number,preparedMs:number):T {
  let budget=NODE_BUDGET;
  const walk=(node:unknown,depth:number):unknown=> {
    if(budget--<=0 || depth>16 || node===null || typeof node!=="object") return node;
    if(Array.isArray(node)) return node.map(item=>walk(item,depth+1));
    const presented=presentNode(node as Record<string,unknown>,nowMs,preparedMs);
    for(const [key,value] of Object.entries(presented))
      if(value!==null && typeof value==="object") presented[key]=walk(value,depth+1);
    return presented;
  };
  return walk(body,0) as T;
}

export function sourceHealthStatus(row:SourceHealthRow,nowMs:number,hours:number):SourceHealthRow["status"] {
  return row.historical ? "history" : row.error ? "error"
    : !row.machine ? "unknown"
    : !row.configured && row.profile && !row.last_session && ["codex", "claude"].includes(row.vendor) ? "missing-assignment"
    : row.vendor === "glm" ? row.last_meter ? nowMs-Date.parse(row.last_meter)>hours*3600000 ? "older":"current" : "unknown"
    : !row.last_session ? "no-sessions"
    : [row.last_session,row.last_meter].some(ts=>ts && nowMs-Date.parse(ts)>hours*3600000) ? "older":"current";
}
export function presentSourceHealth(value:unknown,nowMs=Date.now()):unknown {
  const health=value as SourceHealthResponse;
  if(!Array.isArray(health?.sources))return value;
  return {...health,generated_at:new Date(nowMs).toISOString(),sources:health.sources.map(row=>({...row,
    status:sourceHealthStatus(row,nowMs,health.older_after_hours)}))};
}

type ClockCycle=Pick<ApiCycle,"window_start_iso"|"start_ts"|"work_to_ts"|"anchor"|"peak_percent"|"hit_100">;
/** Presentation arithmetic over prepared cycles; never reads or prices events. */
export function usageCycleClock(cycle:ClockCycle,isActive:boolean,nowMs:number) {
  const hour=3600000,round=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
  const startMs=Date.parse(cycle.window_start_iso||cycle.start_ts);
  const elapsedMs=Math.max(0,(isActive?nowMs:Date.parse(cycle.work_to_ts))-startMs);
  const remainingMs=cycle.anchor==null?null:Math.max(0,cycle.anchor*1000-nowMs);
  const pace=round(cycle.peak_percent/Math.max(elapsedMs/(24*hour),1/24));
  const projected=isActive && remainingMs!=null?round(cycle.peak_percent+pace*remainingMs/(24*hour)):null;
  const eta=isActive && remainingMs!=null && pace>0 && cycle.peak_percent<100
    ?new Date(nowMs+(100-cycle.peak_percent)/pace*24*hour).toISOString():null;
  const status=cycle.hit_100?"spent":!isActive?"closed":projected!=null && projected>=100?"over_pace":projected!=null && projected>=85?"watch":"on_track";
  return {is_active:isActive,status,elapsed_hours:round(elapsedMs/hour),remaining_hours:remainingMs==null?null:round(remainingMs/hour),
    pace_percent_per_day:pace,projected_end_percent:projected,eta_100_iso:eta};
}
