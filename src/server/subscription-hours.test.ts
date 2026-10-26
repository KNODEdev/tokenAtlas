import {test,expect} from 'bun:test';
import fs from 'node:fs';
import {Database} from '../db/sqlite';
import {createTestDatabase} from '../sync/test-support';
import {activeMilliseconds,hoursPer100,ACTIVE_GAP_MS} from '../shared/agent-hours';
import {advanceSubscriptionHours} from './subscription-hours';
import {readWindowHours,markSubscriptionHoursDirty} from '../db/subscription-hours';
import {createClaudeCodeAcceptanceFixture,ACCOUNTS,TIMES} from './claude-code-capacity.fixture';
import {advanceWindowPointValues} from './window-point-values';
import {markWindowAnswersDirty} from '../db/window-answers';
import type {PlansCatalog} from './plans-catalog';
import type {RateCard} from './pricing';

test('inclusive five minutes, one second over, duplicates, boundary split and null denominator',()=>{
  expect(activeMilliseconds([0,ACTIVE_GAP_MS],0,ACTIVE_GAP_MS)).toBe(ACTIVE_GAP_MS);
  expect(activeMilliseconds([0,ACTIVE_GAP_MS+1000],0,ACTIVE_GAP_MS+1000)).toBe(0);
  const times=[0,0,ACTIVE_GAP_MS,ACTIVE_GAP_MS];
  expect(activeMilliseconds(times,0,120_000)).toBe(120_000);
  expect(activeMilliseconds(times,120_000,ACTIVE_GAP_MS)).toBe(180_000);
  expect(hoursPer100(3_600_000,20)).toBe(5);
  expect(hoursPer100(0,20)).toBe(0);
  expect(hoursPer100(0,19)).toBeNull();expect(hoursPer100(0,null)).toBeNull();
});
function fixture(){
  const temp=createTestDatabase(),db=new Database(temp.dbPath),base=Date.parse('2026-01-01');
  for(const [id,account,from,until,pp] of [['a','codex1',0,1000,50],['b','codex1',1000,2000,20],['c','codex1',2000,3000,10],['d','codex2',0,2000,50]] as const){
    const lo=new Date(base+from*1000).toISOString(),hi=new Date(base+until*1000).toISOString(),counter='["codex",10080]';
    db.query("INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_mismatch,readings,seen_reset,last_input) VALUES('codex',?,?,?,?,?,?,?,'reset',10080,'plus',0,'[]',1,?)").run(account,counter,from/1000,id,lo,hi,hi,hi);
    db.query("INSERT INTO window_point_values(provider,account,counter,window_start,window_end,plan,regime_factor,pp,basis,status,inputs_rev,computed_at) VALUES('codex',?,?,?,?,'plus',1,?,'final','eligible','test',?)").run(account,counter,lo,hi,pp,lo);
  }
  const times=new Map([['codex1',[800,900,1100,1300,2100,2300].map(n=>base+n*1000)],['codex2',[0,100,200].map(n=>base+n*1000)]]);
  const visits:string[]=[];
  const options={rates:{version:1,currency:'USD',unit:'per 1M',vendors:{}} as RateCard,catalog:{provider_groups:[]} as PlansCatalog,
    config:{sources:[],subscriptions:[]},now:base+10_000_000,limit:1,readTimes:(w:{window_id:string;account:string},from:string,until:string)=>{
      visits.push(w.window_id);return times.get(w.account)!.filter(t=>t>=Date.parse(from)&&t<Date.parse(until));}};
  function settle(){for(let i=0;i<20;i++)if(!advanceSubscriptionHours(db,options)?.pending)return;throw Error('did not settle');}
  return {...temp,db,base,times,visits,options,settle,cleanup(){db.close();fs.rmSync(temp.directory,{recursive:true,force:true})}};
}
test('late and corrected requests change only touched neighbouring windows; fresh fill and restart agree',()=>{
  const f=fixture();try{
    f.settle();const original=readWindowHours(f.db),other=original.find(r=>r.account==='codex2');
    expect(original.find(r=>r.window_id==='a')?.active_ms).toBe(200_000);
    expect(original.find(r=>r.window_id==='b')?.active_ms).toBe(300_000);
    expect(original.find(r=>r.window_id==='c')?.hours_per_100).toBeNull();
    f.visits.length=0;f.settle();expect(f.visits).toEqual([]);
    f.times.get('codex1')!.push(f.base+990_000);
    markSubscriptionHoursDirty(f.db,'codex','codex1',f.base+990_000,f.base+990_001);
    f.settle();expect(f.visits.sort()).toEqual(['a','b']);expect(readWindowHours(f.db).find(r=>r.account==='codex2')).toEqual(other);
    f.visits.length=0;
    const moved=f.base+1100_000,newTime=f.base+1700_000;
    f.times.set('codex1',f.times.get('codex1')!.filter(t=>t!==moved).concat(newTime));
    markSubscriptionHoursDirty(f.db,'codex','codex1',moved,moved+1);
    markSubscriptionHoursDirty(f.db,'codex','codex1',newTime,newTime+1);
    f.settle();expect(f.visits.sort()).toEqual(['a','b','c']);
    expect(readWindowHours(f.db).filter(r=>r.account==='codex1').map(r=>r.active_ms)).toEqual([190_000,0,200_000]);
    const incremental=readWindowHours(f.db);f.db.exec('DELETE FROM subscription_window_hours');f.settle();
    const values=(rows:ReturnType<typeof readWindowHours>)=>rows.map(({checked,...r})=>r);
    expect(values(readWindowHours(f.db))).toEqual(values(incremental));
    const ro=new Database(f.dbPath,{readonly:true});try{expect(readWindowHours(ro)).toEqual(readWindowHours(f.db))}finally{ro.close()}
  }finally{f.cleanup()}
});
test('actual canonical Claude reader joins all sources and does not count duplicate copies',()=>{
  const f=createClaudeCodeAcceptanceFixture();try{
    const insert=f.db.query("INSERT INTO claude_events(store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total) VALUES(?,?,?,'fixture',?,'claude-sonnet-fixture','standard',?,'cli','2.1.0',100,0)");
    for(const [id,time] of [['active1','2026-09-15T01:00:00Z'],['active2','2026-09-15T01:02:00Z']] as const)
      for(const store of ['primary','copy'])insert.run(store,id,'hours',time,ACCOUNTS.a);
    f.prepareFacts();
    const catalog:PlansCatalog={provider_groups:[]};
    const now=Date.parse('2026-10-01');
    for(let i=0;i<20&&advanceWindowPointValues(f.db,{catalog,plans:{},now,budgetMs:10000})?.pending;i++);
    for(let i=0;i<20&&advanceSubscriptionHours(f.db,{rates:f.rates,catalog,config:{sources:[],subscriptions:[]},now,limit:10})?.pending;i++);
    const own=readWindowHours(f.db).find(w=>w.account===ACCOUNTS.a&&w.start_ts===TIMES.start);
    // The original fixture also contains two requests separated by one millisecond.
    expect(own?.active_ms).toBe(120_001);expect(own?.hours_per_100).toBeCloseTo(120_001/3_600_000/0.24,12);
  }finally{f.teardown()}
});

test('percentage-only updates reuse active time and preserve missing traffic when a window closes',()=>{
  const f=fixture();try{
    f.times.set('codex2',[]);f.options.now=f.base+500_000;f.settle();
    expect(readWindowHours(f.db).find(r=>r.window_id==='d')?.absent).toBe('open_window');
    f.visits.length=0;f.options.now=f.base+10_000_000;
    f.db.query("UPDATE window_point_values SET pp=100 WHERE account='codex1' AND window_start=?").run(new Date(f.base).toISOString());
    markWindowAnswersDirty(f.db,{provider:'codex',account:'codex1',fromMs:f.base,untilMs:f.base+1_000_000});
    expect(f.db.query('SELECT * FROM subscription_hours_dirty').all()).toEqual([]);
    expect(f.db.query('SELECT * FROM project_plan_dirty').all()).toEqual([]);
    f.settle();expect(f.visits).toEqual([]);
    const rows=readWindowHours(f.db);
    expect(rows.find(r=>r.window_id==='a')?.hours_per_100).toBe(200_000/3_600_000);
    expect(rows.find(r=>r.window_id==='d')?.absent).toBe('traffic_missing');
    expect(rows.find(r=>r.window_id==='d')?.hours_per_100).toBeNull();
  }finally{f.cleanup()}
});
