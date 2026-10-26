import type {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {hasSubscriptionHours,readWindowHours} from '../db/subscription-hours';
import {parseCounter} from './main-counter';
import {loadAccountResolver} from './account-resolver';
import { windowEventReader } from "./window-usage-events";
import {activeMilliseconds,hoursPer100,ACTIVE_GAP_MS} from '../shared/agent-hours';
import type {RateProducerOptions} from './subscription-rate';

interface Input {provider:string;account:string;counter:string;window_id:string;start_ts:string;end_ts:string;pp:number|null}
type Options=Omit<RateProducerOptions,'calculate'> & {readTimes?:(window:Input,from:string,until:string)=>number[]};
const key=(w:Pick<Input,'provider'|'account'|'counter'|'window_id'>)=>JSON.stringify([w.provider,w.account,w.counter,w.window_id]);
export function advanceSubscriptionHours(db:Database,options:Options):{processed:number;pending:boolean}|null {
  if(!hasSubscriptionHours(db))return null;
  if(options.canWrite&&!options.canWrite())return {processed:0,pending:true};
  const now=options.now??Date.now();
  const all=(db.query("SELECT w.provider,w.account,w.counter,w.window_id,w.start_ts,w.end_ts,p.pp FROM limit_windows w LEFT JOIN window_point_values p ON p.provider=w.provider AND p.account=w.account AND p.counter=w.counter AND p.window_start=w.start_ts WHERE w.provider IN ('claude','codex') AND w.window_minutes=10080 ORDER BY w.start_ts")
    .all() as Input[]).filter(w=>w.provider!=='claude'||parseCounter(w.counter,10080).kind==='weekly_all');
  const old=new Map(readWindowHours(db).map(w=>[key(w),w]));
  const dirty=db.query('SELECT * FROM subscription_hours_dirty').all() as Array<{provider:string;account:string;from_ms:number;until_ms:number|null;sequence:number}>;
  const resolver=loadAccountResolver(db,options.config.subscriptions),reader=windowEventReader(db,options.rates,resolver);
  let processed=0,pending=false;
  for(const w of all) {
    const from=Date.parse(w.start_ts),until=Date.parse(w.end_ts),closed=until<=now;
    const plan=resolver.plan(w.provider,w.account);
    const ownership=[plan.identityKeys,plan.ranges.filter(r=>r.from<until+ACTIVE_GAP_MS&&r.until>from-ACTIVE_GAP_MS)
      .map(r=>[r.source,Math.max(r.from,from-ACTIVE_GAP_MS),Math.min(r.until,until+ACTIVE_GAP_MS)])];
    const input=createHash('sha256').update(JSON.stringify([2,w.start_ts,w.end_ts,ownership,ACTIVE_GAP_MS])).digest('hex');
    const checked=Math.max(0,...dirty.filter(d=>(d.provider==='*'||d.provider===w.provider)&&(d.account==='*'||d.account===w.account)
      &&d.from_ms<until&&(d.until_ms===null||d.until_ms>from)).map(d=>d.sequence));
    const previous=old.get(key(w));
    let previousInput:string|null=null,present:boolean|null=null;
    try{const metadata=previous?JSON.parse(previous.signature):null;previousInput=metadata?.input??null;
      present=typeof metadata?.present==='boolean'?metadata.present:null}catch{ /* Previous producer version. */ }
    if(present!==null&&previous?.signature===JSON.stringify({input,pp:w.pp,closed,present})&&previous.checked>=checked)continue;
    if(processed>=(options.limit??1)||options.canWrite&&!options.canWrite()){pending=true;continue;}
    const lo=new Date(from-ACTIVE_GAP_MS).toISOString(),hi=new Date(until+ACTIVE_GAP_MS).toISOString();
    const reuse=previous&&present!==null&&previousInput===input&&previous.checked>=checked;
    const times=reuse?null:options.readTimes?options.readTimes(w,lo,hi):(w.provider==='codex'?reader.codex(w.account,lo,hi):reader.ledger(w.provider,w.account,lo,hi)).map(e=>Date.parse(e.ts));
    const active=reuse?previous.active_ms:activeMilliseconds(times!,from,until);
    const hasTraffic=reuse?present!:times!.some(t=>t>=from&&t<until)||active>0;
    const missing=!hasTraffic;
    const signature=JSON.stringify({input,pp:w.pp,closed,present:hasTraffic});
    const absent=!closed?'open_window':w.pp===null?'no_percent':w.pp<20?'below_20pp':missing?'traffic_missing':null;
    const hours=absent?null:hoursPer100(active,w.pp),changed=!previous||previous.active_ms!==active||previous.hours_per_100!==hours||previous.absent!==absent;
    if(options.canWrite&&!options.canWrite()){pending=true;continue;}
    db.transaction(()=>{
      db.query("INSERT INTO subscription_window_hours(provider,account,counter,window_id,start_ts,end_ts,active_ms,hours_per_100,absent,signature,checked,computed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,account,counter,window_id) DO UPDATE SET start_ts=excluded.start_ts,end_ts=excluded.end_ts,active_ms=excluded.active_ms,hours_per_100=excluded.hours_per_100,absent=excluded.absent,signature=excluded.signature,checked=excluded.checked,computed_at=excluded.computed_at")
        .run(w.provider,w.account,w.counter,w.window_id,w.start_ts,w.end_ts,active,hours,absent,signature,Math.max(checked,previous?.checked??0),changed?new Date(now).toISOString():previous!.computed_at);
      if(changed)db.query("INSERT INTO subscription_hours_state(key,value) VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
    }).immediate();processed++;
  }
  db.transaction(()=>{
    const valid=new Set(all.map(key));
    for(const [id,row] of old)if(!valid.has(id)){
      db.query('DELETE FROM subscription_window_hours WHERE provider=? AND account=? AND counter=? AND window_id=?').run(row.provider,row.account,row.counter,row.window_id);
      db.query("INSERT INTO subscription_hours_state(key,value) VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
    }
    db.query("INSERT INTO subscription_hours_state(key,value) VALUES('ready',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").run(pending?'0':'1');
    if(!pending)for(const d of dirty)db.query('DELETE FROM subscription_hours_dirty WHERE provider=? AND account=? AND from_ms=? AND sequence=?').run(d.provider,d.account,d.from_ms,d.sequence);
  }).immediate();
  return {processed,pending};
}
