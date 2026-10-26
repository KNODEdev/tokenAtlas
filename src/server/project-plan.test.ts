import {test,expect} from 'bun:test';
import fs from 'node:fs';
import {Database} from '../db/sqlite';
import {createTestDatabase} from '../sync/test-support';
import {readProjectPlanSlices,markProjectPlanDirty} from '../db/project-plan';
import {readProjectPlanConversion,storedProjectWeeks,chosenPlanCapacity} from './project-plan';
import {advanceProjectPlanFacts,projectPeak,type PreparedProjectCall} from './project-plan-producer';
import {WEEKS_PER_MONTH,type RateWindow} from '../shared/subscription-rate';
import type {PlansCatalog} from './plans-catalog';
import type {RateCard} from './pricing';
import {createClaudeCodeAcceptanceFixture,ACCOUNTS,PROJECT,EXPECTED} from './claude-code-capacity.fixture';
import {buildProjectCost} from './project-cost';
import {ownWindowCapacity} from '../shared/project-plan';
import {ACCOUNT_PERIODS,loadPeriods,replaceDeclaredPeriods} from '../db/period-store';
import {ensureCodexSchema} from '../ingest/codex';
import {addEvent,publishLedger,card as codexRates} from './window-usage-codex.fixture';
import {fillUsageLedgerFixture} from './usage-ledger.fixture';
import {USAGE_LEDGER_VERSION} from '../db/usage-ledger';
import {CODEX_LEDGER_VERSION} from '../db/codex-ledger-state';

const catalog:PlansCatalog={provider_groups:[{id:'claude',label:'Claude',aliases:['claude'],plans:[
  {plan_id:'base',label:'Base',aliases:['base'],versions:[{from:null,usd_per_month:20,limits:{credits_multiplier:1}},{from:'2026-01-08',usd_per_month:30,limits:{credits_multiplier:1}}]},
  {plan_id:'large',label:'Large',versions:[{from:null,usd_per_month:100,limits:{credits_multiplier:5}},{from:'2026-01-08',usd_per_month:150,limits:{credits_multiplier:5}}]}
]},{id:'codex',label:'Codex',aliases:['codex'],plans:[{plan_id:'codex-base',label:'Codex base',versions:[{from:null,usd_per_month:20,limits:{credits_multiplier:1}}]}]}]};
const rates={version:1,currency:'USD',unit:'per 1M',vendors:{}} as RateCard;
function capacity(id:string,start:string,end:string,value:number,price:number,version:string):RateWindow {
  return {id,provider:'claude',account:'a',start,end,closed:true,plan:'base',plan_id:'base',plan_version:version,
    price_usd:price,price_date:start.slice(0,10),rule_from:start,cycles:3,preliminary:false,value_100_usd:value,rate:1,absent:null,
    used_pp:50,api_usd:value/2,comparison:null,fixed_api_usd:null,fixed_date:null,common_historical_usd:null,common_fixed_usd:null,
    mix:[],scope:null,computed_at:end,active_hours:null,hours_per_100:null,hours_absent:null,
    capacity:{sub_id:'a',vendor:'claude',plan:'base',usd_per_month:price,usd_per_point:value/100,weekly_window_value_usd:value,
      session_window_value_usd:40,window_hours:168,session_hours:5,capacity_basis:'measured',price_basis:'rate-card',cadence:'probe',calibration_start_ts:start,calibration_end_ts:end}};
}
function fixture(){
  const temp=createTestDatabase(),db=new Database(temp.dbPath);
  const windows=[capacity('w1','2026-01-01T00:00:00Z','2026-01-08T00:00:00Z',100,20,'origin'),capacity('w2','2026-01-08T00:00:00Z','2026-01-15T00:00:00Z',200,30,'2026-01-08')];
  for(const w of windows)db.query('INSERT INTO subscription_capacity_windows(provider,account,counter,window_id,start_ts,end_ts,scope_start,signature,body,computed_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(w.provider,w.account,'weekly',w.id,w.start,w.end,w.start,'test',JSON.stringify(w),w.end);
  const calls:PreparedProjectCall[]=[{account:'a',subject:'p:project',ts:'2026-01-02T00:00:00Z',historical:100,today:200},
    {account:'a',subject:'p:project',ts:'2026-01-09T00:00:00Z',historical:400,today:500}];
  const options={rates,catalog,config:{sources:[],subscriptions:[]},now:Date.parse('2026-01-14'),bounds:{first:'2026-01-01' as string|null,last:'2026-01-14' as string|null},limit:2,
    readCalls:(provider:'claude'|'codex',day:string)=>provider==='claude'?calls.filter(c=>c.ts.slice(0,10)===day):[{account:'codex1',subject:'p:project',ts:day+'T00:00:00Z',historical:7,today:8}]};
  function settle(){for(let i=0;i<30;i++)if(!advanceProjectPlanFacts(db,options)?.pending)return;throw Error('facts did not settle')}
  return {...temp,db,windows,calls,options,settle,cleanup(){db.close();fs.rmSync(temp.directory,{recursive:true,force:true})}};
}
test('per-week historical price change, vendor numerator and weighted drawer equality',()=>{
  const f=fixture();try{
    f.settle();const result=readProjectPlanConversion(f.db,catalog,'p:project',['base','large','codex-base']);
    const own=result.rows.find(r=>r.plan_id==='base'&&r.mode==='historical')!;
    expect(own.api_usd).toBe(500);expect(own.weeks).toBe(3);
    expect(own.pro_rata).toBe((1*20+2*30)/WEEKS_PER_MONTH);
    expect(own.whole_months).toBe(30);
    expect(storedProjectWeeks(f.db,'p:project','a',{since:'2026-01-01',until:'2026-01-14'})).toBe(own.weeks);
    expect(result.rows.find(r=>r.plan_id==='codex-base'&&r.mode==='historical')?.api_usd).toBe(14*7);
    expect(result.rows.find(r=>r.plan_id==='base'&&r.mode==='today')?.api_usd).toBe(700);
    expect(result.rows.find(r=>r.plan_id==='base'&&r.mode==='today')?.weeks).toBe(3.5);
    expect(result.rows.find(r=>r.plan_id==='base'&&r.mode==='today')?.pro_rata).toBe(3.5*30/WEEKS_PER_MONTH);
    expect(own.five_hour_limited).toBe(true);expect(own.sessions).toBe(500/40);
    const previous=f.db.query("SELECT value FROM project_plan_state WHERE key='revision'").get();
    readProjectPlanConversion(f.db,catalog,'p:project',['base']);readProjectPlanConversion(f.db,catalog,'p:other',['large']);
    expect(f.db.query("SELECT value FROM project_plan_state WHERE key='revision'").get()).toEqual(previous);
    const ro=new Database(f.dbPath,{readonly:true});try{expect(readProjectPlanConversion(ro,catalog,'p:project',['base','large','codex-base'])).toEqual(result)}finally{ro.close()}
  }finally{f.cleanup()}
});
test('official ratio estimates are labelled, incompatible dated base and missing values remain absent',()=>{
  const f=fixture();try{
    f.settle();const rows=readProjectPlanConversion(f.db,catalog,'p:project',['large']).rows;
    expect(rows[0]?.estimate).toBe(true);expect(rows[0]?.weeks).toBeCloseTo(0.6,12);
    expect(ownWindowCapacity({...f.windows[0]!,price_usd:null,value_100_usd:null,absent:'plan_price_missing'}).weekly).toBe(100);
    expect(chosenPlanCapacity([{...f.windows[0]!,plan_version:'other'}],catalog,'claude','large','2026-01-02',{provider:'claude',account:'a',subject:'p:project',day:'2026-01-02',window_id:'w1',historical:1,today:1,peak:1,today_peak:1,calls:1}).weekly).toBeNull();
    expect(chosenPlanCapacity([f.windows[0]!],catalog,'claude','base','2026-01-09',{provider:'claude',account:'a',subject:'p:project',day:'2026-01-09',window_id:'w1',historical:1,today:1,peak:1,today_peak:1,calls:1}).reason).toBe('base_version_mismatch');
    f.calls[0]!.historical=null;markProjectPlanDirty(f.db,'claude',Date.parse('2026-01-02'),Date.parse('2026-01-03'));f.settle();
    const missing=readProjectPlanConversion(f.db,catalog,'p:project',['base']).rows[0]!;
    expect(missing.api_usd).toBeNull();expect(missing.weeks).toBeNull();expect(missing.absent).toBe('valuation_missing');
  }finally{f.cleanup()}
});
test('correction retains unrelated provider days and agrees with a full fresh fill',()=>{
  const f=fixture();try{
    f.settle();const other=f.db.query("SELECT * FROM project_plan_days WHERE provider='codex'").all();
    f.calls[0]!.historical=150;markProjectPlanDirty(f.db,'claude',Date.parse('2026-01-02'),Date.parse('2026-01-03'));f.settle();
    expect(f.db.query("SELECT * FROM project_plan_days WHERE provider='codex'").all()).toEqual(other);
    const incremental=readProjectPlanSlices(f.db);f.db.exec('DELETE FROM project_plan_days');f.settle();expect(readProjectPlanSlices(f.db)).toEqual(incremental);
  }finally{f.cleanup()}
});
test('exact busiest five hours spans midnight and excludes the far endpoint',()=>{
  const calls=[['2026-01-01T23:00:00Z',10],['2026-01-02T01:00:00Z',20],['2026-01-02T04:00:00Z',100]].map(([ts,n])=>({account:'a',subject:'p:x',ts:ts as string,historical:n as number,today:(n as number)*2}));
  expect(projectPeak(calls,'2026-01-01',false)).toBe(30);expect(projectPeak(calls,'2026-01-01',true)).toBe(60);
});
test('real canonical Claude project traffic uses its own stored Standard prices and all accepted accounts',()=>{
  const f=createClaudeCodeAcceptanceFixture();try{
    for(let i=0;i<30&&advanceProjectPlanFacts(f.db,{rates:f.rates,catalog,config:{sources:[],subscriptions:[]},now:Date.parse('2026-09-21'),limit:10})?.pending;i++);
    const own=readProjectPlanSlices(f.db,{subject:'p:'+PROJECT,account:ACCOUNTS.a});
    expect(own.reduce((s,g)=>s+g.historical!,0)).toBeCloseTo(EXPECTED.aProjectCli.usd,12);
    expect(own.reduce((s,g)=>s+g.calls,0)).toBe(2);
    const unused=structuredClone(f.rates);
    unused.vendors.anthropic!.models!['unused-public-model']={in_uncached:999,in_cache_read:999,in_cache_write_5m:999,in_cache_write_1h:999,out_total:999};
    expect(advanceProjectPlanFacts(f.db,{rates:unused,catalog,config:{sources:[],subscriptions:[]},now:Date.parse('2026-09-21'),limit:10})?.processed).toBe(0);
  }finally{f.teardown()}
});
test('the actual project drawer report reads the identical weighted weekly result for its subscription and range',()=>{
  const f=createClaudeCodeAcceptanceFixture();try{
    f.db.query('UPDATE claude_events SET project_id=NULL WHERE subscription_id=?').run(ACCOUNTS.b);f.prepareFacts();
    const actual=f.db.query("SELECT * FROM limit_windows WHERE provider='claude' AND account=? AND window_minutes=10080 LIMIT 1").get(ACCOUNTS.a) as {counter:string;window_id:string;start_ts:string;end_ts:string};
    const measured={...capacity(actual.window_id,actual.start_ts,actual.end_ts,1000,30,'2026-01-08'),account:ACCOUNTS.a};
    f.db.query('INSERT INTO subscription_capacity_windows(provider,account,counter,window_id,start_ts,end_ts,scope_start,signature,body,computed_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('claude',ACCOUNTS.a,actual.counter,actual.window_id,actual.start_ts,actual.end_ts,actual.start_ts,'test',JSON.stringify(measured),actual.end_ts);
    for(let i=0;i<30&&advanceProjectPlanFacts(f.db,{rates:f.rates,catalog,config:{sources:[],subscriptions:[]},now:Date.parse('2026-09-21'),limit:10})?.pending;i++);
    const report=buildProjectCost(f.db,f.rates,new Map(),{since:'2026-09-13',until:'2026-09-17'});
    const drawer=report.subjects.find(p=>p.subject==='p:'+PROJECT)?.subscriptions[ACCOUNTS.a]?.equivalents.weekly_cycles.value;
    const tab=readProjectPlanConversion(f.db,catalog,'p:'+PROJECT,['base']).rows.find(r=>r.mode==='historical')?.weeks;
    expect(drawer).toBeCloseTo(EXPECTED.aProjectCli.usd/1000,12);expect(tab).toBe(drawer);
  }finally{f.teardown()}
});

for(const change of ['moved-edge','removed-edge','empty-provider'] as const)test(change+' reconciles obsolete days before readiness and matches fresh fill',()=>{
  const f=fixture();try{
    f.settle();const old=Date.parse('2026-01-09');
    if(change==='moved-edge'){f.calls[1]!.ts='2026-01-01T00:00:00Z';markProjectPlanDirty(f.db,'claude',Date.parse('2026-01-01'),Date.parse('2026-01-02'));}
    else if(change==='removed-edge')f.calls.pop();else f.calls.length=0;
    f.options.bounds.last=change==='empty-provider'?null:'2026-01-02';
    if(change==='empty-provider')f.options.bounds.first=null;
    markProjectPlanDirty(f.db,'claude',old,old+1);
    const turn=advanceProjectPlanFacts(f.db,f.options);expect(turn?.pending).toBe(true);
    expect(f.db.query('SELECT * FROM project_plan_dirty').all().length).toBeGreaterThan(0);
    f.settle();const incremental=readProjectPlanSlices(f.db);
    expect(incremental.every(s=>s.day<='2026-01-02')).toBe(true);
    if(change==='empty-provider')expect(incremental).toEqual([]);
    f.db.exec('DELETE FROM project_plan_days');f.settle();expect(readProjectPlanSlices(f.db)).toEqual(incremental);
    const reopened=new Database(f.dbPath,{readonly:true});try{expect(readProjectPlanSlices(reopened)).toEqual(incremental)}finally{reopened.close()}
  }finally{f.cleanup()}
});

test('canonical vendor traffic retains partial and wholly missing account attribution, then recovers without losing work',()=>{
  const f=createClaudeCodeAcceptanceFixture();try{
    const original=loadPeriods(f.db,ACCOUNT_PERIODS).filter(p=>p.origin==='declared');
    const options={rates:f.rates,catalog,config:{sources:[],subscriptions:[]},now:Date.parse('2026-09-21'),limit:10};
    const settle=()=>{for(let i=0;i<30;i++)if(!advanceProjectPlanFacts(f.db,options)?.pending)return;throw Error('did not settle')};
    settle();const whole=readProjectPlanSlices(f.db,{subject:'p:'+PROJECT}).reduce((sum,s)=>sum+s.historical!,0);
    expect(whole).toBeCloseTo(5.076,12);
    replaceDeclaredPeriods(f.db,ACCOUNT_PERIODS,original.filter(p=>p.value!==ACCOUNTS.b));settle();
    const partial=readProjectPlanConversion(f.db,catalog,'p:'+PROJECT,['base']).rows.find(r=>r.mode==='historical')!;
    expect(partial.api_usd).toBeCloseTo(5.076,12);expect(partial.weeks).toBeNull();expect(partial.absent).toBe('attribution_missing');
    expect(readProjectPlanSlices(f.db,{subject:'p:'+PROJECT}).some(s=>s.account===null)).toBe(true);
    replaceDeclaredPeriods(f.db,ACCOUNT_PERIODS,[]);settle();
    expect(readProjectPlanConversion(f.db,catalog).projects).toContain('p:'+PROJECT);
    const uncovered=readProjectPlanSlices(f.db,{subject:'p:'+PROJECT});expect(uncovered.every(s=>s.account===null)).toBe(true);
    expect(uncovered.reduce((sum,s)=>sum+s.historical!,0)).toBeCloseTo(5.076,12);
    replaceDeclaredPeriods(f.db,ACCOUNT_PERIODS,original);settle();
    const recovered=readProjectPlanSlices(f.db);expect(recovered.filter(s=>s.subject==='p:'+PROJECT).every(s=>s.account!==null)).toBe(true);
    f.db.exec('DELETE FROM project_plan_days');settle();expect(readProjectPlanSlices(f.db)).toEqual(recovered);
  }finally{f.teardown()}
});

test('unprepared provider cannot prune completed facts or acknowledge an empty-looking coverage range',()=>{
  const f=createClaudeCodeAcceptanceFixture();try{
    const options={rates:f.rates,catalog,config:{sources:[],subscriptions:[]},now:Date.parse('2026-09-21'),limit:10};
    for(let i=0;i<30&&advanceProjectPlanFacts(f.db,options)?.pending;i++);
    const before=f.db.query("SELECT * FROM project_plan_days WHERE provider='claude'").all();expect(before.length).toBeGreaterThan(0);
    const revision=(f.db.query("SELECT published_revision FROM usage_ledger_state WHERE provider='claude'").get() as {published_revision:number}).published_revision;
    f.db.exec("UPDATE usage_ledger_state SET published_revision=0 WHERE provider='claude'");
    markProjectPlanDirty(f.db,'claude',Date.parse('2026-09-01'),null);
    expect(advanceProjectPlanFacts(f.db,{...options,bounds:{first:null,last:null}})?.pending).toBe(true);
    expect(f.db.query("SELECT * FROM project_plan_days WHERE provider='claude'").all()).toEqual(before);
    expect(f.db.query('SELECT 1 FROM project_plan_dirty LIMIT 1').get()).not.toBeNull();
    expect(f.db.query("SELECT value FROM project_plan_state WHERE key='ready'").get()).toEqual({value:'0'});
    f.db.query("UPDATE usage_ledger_state SET published_revision=? WHERE provider='claude'").run(revision);
    for(let i=0;i<30&&advanceProjectPlanFacts(f.db,options)?.pending;i++);
    expect(readProjectPlanSlices(f.db,{subject:'p:'+PROJECT}).reduce((sum,s)=>sum+s.historical!,0)).toBeCloseTo(5.076,12);
  }finally{f.teardown()}
});

for(const provider of ['claude','codex'] as const)for(const coverage of ['absent','raw-first','head-first','ready-empty'] as const)
test(provider+' '+coverage+' distinguishes first preparation from authoritative empty coverage',()=>{
  const temp=createTestDatabase(),db=new Database(temp.dbPath);
  const card=provider==='codex'?codexRates:rates;
  const options={rates:card,catalog,config:{sources:[],subscriptions:[]},now:Date.parse('2027-01-09'),limit:10};
  const publish=()=>provider==='codex'?publishLedger(db,card):fillUsageLedgerFixture(db,card,['claude']);
  try{
    if(provider==='codex')ensureCodexSchema(db);
    if(coverage==='raw-first'){
      if(provider==='codex'){
        addEvent(db,{ts:'2027-01-01T00:30:00.000Z',billing:'allowance'});
        db.exec("UPDATE events SET project_id='pending',service_tier='default',usage_status='valid'");
      }else db.query("INSERT INTO claude_events(store,call_id,path,ts,project_id) VALUES('synthetic','call','synthetic.jsonl','2027-01-01T00:30:00.000Z','pending')").run();
    }
    if(coverage==='head-first')db.query("INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest) VALUES(?,?,'backfill','pending',0,'','')")
      .run(provider,provider==='codex'?CODEX_LEDGER_VERSION:USAGE_LEDGER_VERSION);
    if(coverage==='ready-empty')publish();
    markProjectPlanDirty(db,provider,Date.parse('2027-01-01'),null);
    const preparing=coverage==='raw-first'||coverage==='head-first';
    expect(advanceProjectPlanFacts(db,options)).toEqual({processed:0,pending:preparing});
    expect(db.query("SELECT value FROM project_plan_state WHERE key='ready'").get()).toEqual({value:preparing?'0':'1'});
    expect(db.query('SELECT 1 FROM project_plan_dirty LIMIT 1').get()!==null).toBe(preparing);
    if(preparing){
      expect(db.query("SELECT value FROM project_plan_state WHERE key='filled'").get()).toBeNull();
      publish();
      for(let i=0;i<30&&advanceProjectPlanFacts(db,options)?.pending;i++);
      expect(db.query("SELECT value FROM project_plan_state WHERE key='ready'").get()).toEqual({value:'1'});
      expect(db.query('SELECT 1 FROM project_plan_dirty LIMIT 1').get()).toBeNull();
      if(coverage==='raw-first')expect(readProjectPlanConversion(db,catalog).projects).toContain('p:pending');
    }
    const before=readProjectPlanSlices(db);expect(advanceProjectPlanFacts(db,options)?.processed).toBe(0);
    const reopened=new Database(temp.dbPath);try{expect(advanceProjectPlanFacts(reopened,options)?.processed).toBe(0);expect(readProjectPlanSlices(reopened)).toEqual(before)}finally{reopened.close()}
  }finally{db.close();fs.rmSync(temp.directory,{recursive:true,force:true})}
});
