import type {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {hasProjectPlan} from '../db/project-plan';
import {readCapacityWindows} from '../db/subscription-capacity';
import {codexLedgerDayBounds} from '../db/codex-price-ledger';
import {ledgerDayBounds} from './ledger-sums';
import {loadAccountResolver} from './account-resolver';
import {projectRulesStamp} from '../projects/rules-now';
import { windowEventReader } from "./window-usage-events";
import { referenceFingerprint } from "./window-usage-reference";
import {normalizePublishedCodexTier,pricePublishedCodexEvent} from './codex-priced-events';
import {prepareCodexPricing,resolveCodexAccountingConfig} from './codex-accounting-pricing';
import {subscriptionAccountingAdapter} from './subscription-accounting-adapters';
import {subscriptionWindowAdapter} from './subscription-accounting';
import type {ProjectPlanSlice} from '../shared/project-plan';
import type {RateProducerOptions} from './subscription-rate';
import {usageLedgerReadiness} from '../db/usage-ledger-read';
import {codexLedgerPendingReason,codexLedgerReadContext} from '../db/codex-ledger-adapters';
import {normEraKey} from './eras';

export interface PreparedProjectCall {account:string|null;subject:string|null;ts:string;historical:number|null;today:number|null;model?:string|null;source?:string|null;identity?:string|null}
const FIVE_HOURS=5*3_600_000,DAY=86_400_000;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** All accounts of the provider contribute to its exact busiest five-hour project period. */
export function projectPeak(calls:readonly PreparedProjectCall[],day:string,today:boolean):number|null {
  const selected=[...calls].sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
  if(selected.some(c=>(today?c.today:c.historical)===null))return null;
  let right=0,sum=0,peak=0;
  for(let left=0;left<selected.length&&selected[left]!.ts.slice(0,10)===day;left++){
    const until=Date.parse(selected[left]!.ts)+FIVE_HOURS;
    while(right<selected.length&&Date.parse(selected[right]!.ts)<until)sum+=(today?selected[right++]!.today:selected[right++]!.historical)!;
    peak=Math.max(peak,sum);sum-=(today?selected[left]!.today:selected[left]!.historical)!;
  }
  return peak;
}
type Options=Omit<RateProducerOptions,'calculate'> & {referenceDay?:string;readCalls?:(provider:'claude'|'codex',day:string)=>PreparedProjectCall[];bounds?:{first:string|null;last:string|null};providers?:readonly ('codex'|'claude')[];scopePeaks?:boolean;contextRevision?:(models:readonly string[]|undefined,day:string,referenceDay:string)=>unknown};
/** Stored daily project facts. Initial fill and real dependency corrections run only in the maintenance writer. */
export function advanceProjectPlanFacts(db:Database,options:Options):{processed:number;pending:boolean}|null {
  if(!hasProjectPlan(db))return null;
  if(options.canWrite&&!options.canWrite())return {processed:0,pending:true};
  const now=options.now??Date.now(),referenceDay=options.referenceDay??new Date(now).toISOString().slice(0,10);
  const resolver=loadAccountResolver(db,options.config.subscriptions),reader=windowEventReader(db,options.rates,resolver,referenceDay);
  const windows=readCapacityWindows(db),rules=projectRulesStamp(db);
  const dirty=db.query('SELECT * FROM project_plan_dirty').all() as Array<{provider:string;day:string;until_day:string|null;sequence:number}>;
  const stored=db.query('SELECT provider,day,signature,checked FROM project_plan_days').all() as Array<{provider:string;day:string;signature:string;checked:number}>;
  const old=new Map(stored.map(r=>[r.provider+':'+r.day,r]));
  const codex=prepareCodexPricing(resolveCodexAccountingConfig(options.rates)),claude=subscriptionWindowAdapter(subscriptionAccountingAdapter('claude'),'weekly',10080,options.rates,referenceDay);
  let processed=0,pending=false;
  for(const provider of options.providers??['claude','codex'] as const){
    const providerRows=stored.filter(row=>row.provider===provider);
    if(!options.readCalls){
      const raw=provider==='claude'?'claude_events':'events';
      const hasRaw=!!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(raw)&&!!db.query(`SELECT 1 FROM ${raw} LIMIT 1`).get();
      const hasHead=!!db.query('SELECT 1 FROM usage_ledger_state WHERE provider=?').get(provider);
      // No provider input is an empty source. A first build with facts or a ledger head
      // must prove ready coverage even before aggregate bounds or project rows exist.
      const hasInput=hasRaw||hasHead||options.bounds?.first!=null||providerRows.length>0;
      const preparing=provider==='claude'?usageLedgerReadiness(db,provider,options.rates).state!=='ready'
        :codexLedgerPendingReason(db,codexLedgerReadContext(options.rates))!==null;
      if(hasInput&&preparing){pending=true;continue;}
    }
    const bounds=options.bounds??(provider==='claude'?ledgerDayBounds(db,'claude'):codexLedgerDayBounds(db));
    for(const row of providerRows)if(!bounds.first||!bounds.last||row.day<bounds.first||row.day>bounds.last){
      if(processed>=(options.limit??1)||options.canWrite&&!options.canWrite()){pending=true;continue;}
      db.transaction(()=>{
        db.query('DELETE FROM project_plan_days WHERE provider=? AND day=?').run(provider,row.day);
        db.query("INSERT INTO project_plan_state(key,value) VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
      }).immediate();processed++;
    }
    if(!bounds.first||!bounds.last)continue;
    const accounts=resolver.accounts(provider);
    for(let at=Date.parse(bounds.first);at<=Date.parse(bounds.last);at+=DAY){
      const day=new Date(at).toISOString().slice(0,10),from=new Date(at).toISOString(),until=new Date(at+DAY+FIVE_HOURS).toISOString();
      const relevant=windows.filter(w=>w.provider===provider&&Date.parse(w.start)<at+DAY&&Date.parse(w.end)>at);
      const dependencyWindows=options.scopePeaks?windows.filter(w=>w.provider===provider&&Date.parse(w.start)<at+DAY+FIVE_HOURS&&Date.parse(w.end)>at):relevant;
      const checked=Math.max(0,...dirty.filter(d=>(d.provider==='*'||d.provider===provider)&&d.day<=day&&(d.until_day===null||d.until_day>=day)).map(d=>d.sequence));
      const prior=old.get(provider+':'+day);
      let priorModels:string[]|undefined,priorSources:Array<[string|null,string|null]>|undefined;
      try{const meta=JSON.parse(prior?.signature??'null');if(meta?.version===4&&Array.isArray(meta.models)&&Array.isArray(meta.sources)){priorModels=meta.models;priorSources=meta.sources;}}catch{ /* Previous producer version. */ }
      const signatureOf=(models:readonly string[]|undefined,sources:Array<[string|null,string|null]>|undefined)=>{
        const ownership=sources?.map(([source,identity])=>{const direct=resolver.identityAccount(provider,identity);
          return [source,identity,direct,direct?[]:accounts.flatMap(account=>resolver.plan(provider,account).ranges
            .filter(r=>r.source===source&&r.from<at+DAY+FIVE_HOURS&&r.until>at)
            .map(r=>[account,Math.max(r.from,at),Math.min(r.until,at+DAY+FIVE_HOURS)]))];});
        return JSON.stringify({version:4,models,sources,dependency:hash([referenceFingerprint(options.rates,provider,referenceDay,models),rules,ownership,dependencyWindows.map(w=>[w.account,w.id,w.start,w.end]),...(options.contextRevision?[options.contextRevision(models,day,referenceDay)]:[])])});
      };
      const signature=signatureOf(priorModels,priorSources);
      if(prior?.signature===signature&&prior.checked>=checked)continue;
      if(processed>=(options.limit??1)||options.canWrite&&!options.canWrite()){pending=true;continue;}
      const calls:PreparedProjectCall[]=options.readCalls?options.readCalls(provider,day):provider==='codex'?reader.codexAll(from,until).map(e=>{
          const norm=normalizePublishedCodexTier(e,e.speed),ref=pricePublishedCodexEvent(codex,{...e,speed:'standard'},'api_equivalent_usd',referenceDay).amount;
          return {account:e.account??null,source:e.source?normEraKey(e.source):null,identity:null,subject:(e as {subject?:string|null}).subject??null,model:e.model,ts:new Date(e.ts).toISOString(),historical:norm.normalized_usd,
            today:ref===null||norm.multiplier===null?null:ref*norm.multiplier};
        }):reader.ledgerAll(provider,from,until).map(e=>{const u=claude.usage(e);return {account:resolver.resolve(provider,e.source,e.account_key,e.ts).account,
          source:e.source?normEraKey(e.source):null,identity:e.account_key??null,subject:e.subject??null,model:e.model,ts:new Date(e.ts).toISOString(),
          historical:e.prices.standard?.amount??null,today:u.reference_unpriced_events?null:u.reference_api_standard??null}});
      const peakWindows=options.scopePeaks?windows.filter(w=>w.provider===provider&&Date.parse(w.start)<at+DAY+FIVE_HOURS&&Date.parse(w.end)>at):[];
      const peakWindow=(call:PreparedProjectCall)=>peakWindows.filter(w=>w.account===call.account&&Date.parse(w.start)<=Date.parse(call.ts)&&Date.parse(w.end)>Date.parse(call.ts)).at(-1)?.id??null;
      const bySubject=new Map<string,PreparedProjectCall[]>();
      for(const c of calls)if(c.subject)(bySubject.get(c.subject)??bySubject.set(c.subject,[]).get(c.subject)!).push(c);
      const groups=new Map<string,ProjectPlanSlice>();
      for(const c of calls){
        if(!c.subject||c.ts.slice(0,10)!==day)continue;
        const window=relevant.filter(w=>w.account===c.account&&Date.parse(w.start)<=Date.parse(c.ts)&&Date.parse(w.end)>Date.parse(c.ts)).at(-1);
        const key=JSON.stringify([c.account,c.subject,window?.id??null]);
        const row=groups.get(key)??(()=>{const peakCalls=options.scopePeaks?bySubject.get(c.subject)!.filter(call=>call.account===c.account&&peakWindow(call)===(window?.id??null)):bySubject.get(c.subject)!;
        return {provider,account:c.account,subject:c.subject,day,window_id:window?.id??null,
          historical:0,today:0,peak:projectPeak(peakCalls,day,false),today_peak:projectPeak(peakCalls,day,true),calls:0};})();
        row.calls++;row.historical=row.historical===null||c.historical===null?null:row.historical+c.historical;
        row.today=row.today===null||c.today===null?null:row.today+c.today;groups.set(key,row);
      }
      if(options.canWrite&&!options.canWrite()){pending=true;continue;}
      const models=[...new Set(calls.filter(c=>c.subject).flatMap(c=>c.model?[c.model]:[]))].sort();
      const sources=Array.from(new Map(calls.filter(c=>c.subject).map(c=>{const pair:[string|null,string|null]=[c.source??null,c.identity??null];return [JSON.stringify(pair),pair]})).values()).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      db.transaction(()=>{
        db.query("INSERT INTO project_plan_days(provider,day,signature,checked,body,computed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(provider,day) DO UPDATE SET signature=excluded.signature,checked=excluded.checked,body=excluded.body,computed_at=excluded.computed_at")
          .run(provider,day,signatureOf(models,sources),Math.max(checked,prior?.checked??0),JSON.stringify([...groups.values()]),new Date(now).toISOString());
        db.query("INSERT INTO project_plan_state(key,value) VALUES('revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
        db.query("INSERT INTO project_plan_state(key,value) VALUES('ready','0') ON CONFLICT(key) DO UPDATE SET value='0' WHERE value<>'0'").run();
      }).immediate();processed++;
    }
  }
  db.transaction(()=>{
    db.query("INSERT INTO project_plan_state(key,value) VALUES('ready',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").run(pending?'0':'1');
    if(!pending){
      for(const d of dirty)db.query('DELETE FROM project_plan_dirty WHERE provider=? AND day=? AND sequence=?').run(d.provider,d.day,d.sequence);
      db.query("INSERT INTO project_plan_state(key,value) VALUES('price-date',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").run(referenceDay);
      db.query("INSERT INTO project_plan_state(key,value) VALUES('filled','1') ON CONFLICT(key) DO UPDATE SET value='1' WHERE value<>'1'").run();
    }
  }).immediate();
  return {processed,pending};
}
