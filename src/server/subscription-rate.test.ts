import { test, expect } from "bun:test";
import fs from "node:fs";
import { Database } from "../db/sqlite";
import { createTestDatabase } from "../sync/test-support";
import { readCapacityWindows } from "../db/subscription-capacity";
import { markWindowAnswersDirty } from "../db/window-answers";
import { advanceSubscriptionRates, readSubscriptionRates } from "./subscription-rate";
import { buildSubscriptionCapacities, restoreSubscriptionHomes, type SubscriptionCapacity, type CycleLike } from "./capacity-equivalents";
import { subscriptionRate, rateChange } from "../shared/subscription-rate";
import type { PlansCatalog } from "./plans-catalog";
import type { RateCard } from "./pricing";
import { createClaudeCodeAcceptanceFixture, ACCOUNTS, TIMES } from "./claude-code-capacity.fixture";
import { buildClaudeCodeCapacityReport } from "./claude-code-capacity";
import { advanceWindowPointValues } from "./window-point-values";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import type { CodexComparisonWindow } from "../shared/codex-accounting";
import { addEvent, publishLedger, card as nativeCodexRates, sources as codexSources } from './window-usage-codex.fixture';
import { prepareProbeReaderFixture } from './probe-reader.fixture';
import { prepareWindowUsageFixture } from './window-usage.fixture';
import { advanceProjectPlanFacts } from './project-plan-producer';
import { readProjectPlanConversion } from './project-plan';
import { markWindowUsageDirty } from '../db/window-usage';
import { codexLimitCounter } from './codex-limit-windows';
import { ensureCodexSchema } from '../ingest/codex';
import { ACCOUNT_PERIODS,PLAN_PERIODS,loadPeriods,replaceDeclaredPeriods } from '../db/period-store';
import { readProjectPlanSlices } from '../db/project-plan';

const catalog: PlansCatalog={provider_groups:[{id:"codex",label:"Codex",aliases:["codex"],plans:[{plan_id:"codex-plus",label:"Plus",aliases:["plus"],versions:[{from:null,usd_per_month:20}]}]}]};
const rates={version:1,currency:"USD",unit:"per 1M",vendors:{},subscriptions:{codex1:{usd_per_month:20},codex2:{usd_per_month:20}}} as RateCard;
const config={subscriptions:[{id:"codex1",vendor:"codex"},{id:"codex2",vendor:"codex"}],sources:[]};
const now=Date.parse("2026-02-01T00:00:00.000Z");
function setup() {
  const temp=createTestDatabase(), db=new Database(temp.dbPath);
  const window=(id:string,account:string,start:string,end:string,pp=30,usd=100)=>{
    const counter='["codex",10080]';
    db.query("INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_detail,plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input) VALUES('codex',?,?,?, ?,?,?,?,'reset',10080,'plus',NULL,0,'[]',NULL,NULL,NULL,1,?)")
      .run(account,counter,id==="a2"?1:0,id,start,end,end,end);
    const usage={events:100,tokens:1000,priced_tokens:1000,unpriced_events:0,api_standard:usd};
    db.query("INSERT INTO window_usage(provider,account,counter,window_id,start_ts,end_ts,cycle,rail,readings,slices,reference) VALUES('codex',?,?,?,?,?,?,'{}','[]','[]',NULL)")
      .run(account,counter,id,start,end,JSON.stringify({usage}));
    db.query("INSERT INTO window_point_values(provider,account,counter,window_start,window_end,plan,regime_factor,pp,basis,status,inputs_rev,computed_at) VALUES('codex',?,?,?,?,'plus',1,?,'final','eligible','fixture',?)")
      .run(account,counter,start,end,pp,start);
  };
  window("a1","codex1","2026-01-01T00:00:00.000Z","2026-01-08T00:00:00.000Z");
  window("a2","codex1","2026-01-08T00:00:00.000Z","2026-01-15T00:00:00.000Z");
  window("b1","codex2","2026-01-01T00:00:00.000Z","2026-01-08T00:00:00.000Z");
  const computed:string[]=[];
  const calculate=(w:{window_id:string;account:string;start_ts:string;end_ts:string}):SubscriptionCapacity=>{
    computed.push(w.window_id);
    return {sub_id:w.account,vendor:"codex",plan:"plus",usd_per_month:20,usd_per_point:10,weekly_window_value_usd:1000,
      session_window_value_usd:null,window_hours:168,session_hours:null,capacity_basis:"single",price_basis:"rate-card",cadence:"probe",
      calibration_start_ts:w.start_ts,calibration_end_ts:w.end_ts};
  };
  const settle=()=>{
    for(let i=0;i<10;i++){const turn=advanceSubscriptionRates(db,{rates,catalog,config,now,limit:1,calculate});if(!turn?.pending)return;}
    throw new Error("Capacity producer did not settle");
  };
  return {db,...temp,computed,calculate,settle,cleanup:()=>{db.close();fs.rmSync(temp.directory,{recursive:true,force:true});}};
}
test("rate formula and missing values retain exact precision",()=>{
  expect(subscriptionRate(1000,20)).toBe(1000*(365.25/12/7)/20);
  expect(subscriptionRate(null,20)).toBeNull();expect(subscriptionRate(1000,null)).toBeNull();
  expect(subscriptionRate(1000,0)).toBeNull();
});

test("rate reads attach the whole-window split to existing facts, without producer work or writes", () => {
  const fixture = setup();
  try {
    fixture.settle();
    const before = readSubscriptionRates(fixture.db, "codex1");
    const facts = fixture.db.query("SELECT body,signature FROM subscription_capacity_windows ORDER BY window_id").all();
    fixture.db.query(`UPDATE window_usage SET cycle=json_set(cycle,'$.cycle_usage',json(?)) WHERE account='codex1'`)
      .run(JSON.stringify({ events: 100, tokens: 1000, priced_tokens: 1000, unpriced_events: 0, api_standard: 100,
        api_normalized: 10, context_api_base: 10, context_api_extra: 3, context_priced_tokens: 1000 }));
    const changes = fixture.db.query("SELECT total_changes() n").get();
    const after = readSubscriptionRates(fixture.db, "codex1");
    expect(after.windows.map(window => window.api_usd)).toEqual(before.windows.map(window => window.api_usd));
    for (const window of after.windows) expect(window.context_price).toEqual({ base: 100, extra: 30, stored: 100 });
    expect(fixture.db.query("SELECT body,signature FROM subscription_capacity_windows ORDER BY window_id").all()).toEqual(facts);
    expect(fixture.db.query("SELECT total_changes() n").get()).toEqual(changes);
    fixture.db.query("UPDATE window_usage SET cycle=json_set(cycle,'$.cycle_usage.api_standard',101) WHERE account='codex1'").run();
    expect(readSubscriptionRates(fixture.db, "codex1").windows.every(window => window.context_price === undefined)).toBe(true);
  } finally { fixture.cleanup(); }
});
test('native Codex 5h samples feed durable capacity, project sessions and correction dependencies',()=>{
  const temp=createTestDatabase(),db=new Database(temp.dbPath),nativeNow=Date.parse('2027-01-09');
  const localConfig={subscriptions:[{id:'codex1',vendor:'codex'}],sources:codexSources};
  // Keep the configured card object stable, as the maintenance worker does.
  const configuredRates={...nativeCodexRates,subscriptions:{codex1:{usd_per_month:20}}};
  const nativeOptions={rates:configuredRates,catalog,config:localConfig,now:nativeNow,limit:10};
  const settle=()=>{for(let i=0;i<30;i++)if(!advanceSubscriptionRates(db,nativeOptions)?.pending)return;throw Error('native capacity did not settle')};
  try{
    ensureCodexSchema(db);
    addEvent(db,{ts:'2027-01-01T00:30:00.000Z',billing:'allowance'});
    addEvent(db,{ts:'2027-01-01T01:30:00.000Z',input:1_000_000,billing:'allowance'});
    db.exec("UPDATE events SET project_id='native-project',cwd='C:/synthetic/native-project',service_tier='default',usage_status='valid',cache_write_status='missing'");
    publishLedger(db,nativeCodexRates);
    replaceDeclaredPeriods(db,PLAN_PERIODS,[{provider:'codex',subject:'codex1',value:'plus',from:'2000-01-01',until:null,origin:'declared',firstSeen:null,lastSeen:null,readings:0,evidence:'synthetic'}]);
    const probe=db.query("INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,window_minutes,used_percent,resets_at,plan,ok,reported_percent_side) VALUES('codex','codex1',?,?,'codex',?,?,?,'plus',1,'used')");
    for(const minutes of [300,10080]){
      const reset=minutes===300?'2027-01-01T05:00:00.000Z':'2027-01-08T00:00:00.000Z';
      const kind=minutes===300?'primary':'secondary';
      probe.run('2027-01-01T00:00:00.000Z',kind,minutes,0,reset);
      probe.run('2027-01-01T01:00:00.000Z',kind,minutes,20,reset);
      if(minutes===10080)probe.run('2027-01-01T02:00:00.000Z',kind,minutes,60,reset);
    }
    prepareProbeReaderFixture(db,codexSources);
    prepareWindowUsageFixture(db,{rateCards:nativeCodexRates,claudeGauge:{},cycles:{windows:[]}});
    for(let i=0;i<20&&advanceWindowPointValues(db,{catalog,plans:{},now:nativeNow,budgetMs:10000})?.pending;i++);
    settle();
    const measured=readCapacityWindows(db,'codex1').find(w=>w.closed)!;
    // The sole native 5h sample pairs one Standard call with a 20pp increase.
    const oneCall=(80_000*3+20_000*.3+10_000*15)/1_000_000,session=oneCall/20*100;
    expect(measured.absent).toBeNull();
    expect(measured.capacity?.session_window_value_usd).toBeCloseTo(session,12);
    expect(measured.capacity?.weekly_window_value_usd).not.toBeCloseTo(session,6);
    for(let i=0;i<30&&advanceProjectPlanFacts(db,nativeOptions)?.pending;i++);
    const project=readProjectPlanConversion(db,catalog,'p:native-project',['codex-plus'],nativeNow).rows.find(r=>r.mode==='historical')!;
    const total=oneCall+(980_000*3+20_000*.3+10_000*15)/1_000_000;
    expect(project.api_usd).toBeCloseTo(total,12);expect(project.absent).toBeNull();
    expect(project.sessions).toBeCloseTo(total/session,12);expect(project.five_hour_limited).toBe(true);
    expect(advanceSubscriptionRates(db,nativeOptions)?.processed).toBe(0);
    // Only the native session counter changes. Its pending sums preserve the completed rate.
    db.query("UPDATE probe_windows SET used_percent=40 WHERE window_minutes=300 AND used_percent=20").run();
    prepareProbeReaderFixture(db,codexSources);
    markWindowUsageDirty(db,{provider:'codex',account:'codex1',counter:codexLimitCounter(300),fromMs:Date.parse('2027-01-01'),untilMs:Date.parse('2027-01-02')});
    expect(advanceSubscriptionRates(db,nativeOptions)?.pending).toBe(true);
    expect(readCapacityWindows(db,'codex1').find(w=>w.closed)?.capacity?.session_window_value_usd).toBeCloseTo(session,12);
    prepareWindowUsageFixture(db,{rateCards:nativeCodexRates,claudeGauge:{},cycles:{windows:[]}});settle();
    expect(readCapacityWindows(db,'codex1').find(w=>w.closed)?.capacity?.session_window_value_usd).toBeCloseTo(oneCall/40*100,12);
    const incremental=readCapacityWindows(db);
    db.exec('DELETE FROM subscription_capacity_windows');settle();expect(readCapacityWindows(db)).toEqual(incremental);
    const ro=new Database(temp.dbPath,{readonly:true});try{expect(readCapacityWindows(ro)).toEqual(incremental)}finally{ro.close()}
    const settleProject=()=>{for(let i=0;i<30;i++)if(!advanceProjectPlanFacts(db,nativeOptions)?.pending)return;throw Error('native project did not settle')};
    const periods=loadPeriods(db,ACCOUNT_PERIODS).filter(p=>p.origin==='declared');
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,periods.map(p=>({...p,from:'2027-01-01T00:45:00.000Z'})));settleProject();
    const partial=readProjectPlanConversion(db,catalog,'p:native-project',['codex-plus'],nativeNow).rows.find(r=>r.mode==='historical')!;
    expect(partial.api_usd).toBeCloseTo(total,12);expect(partial.absent).toBe('attribution_missing');expect(partial.sessions).toBeNull();
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,[]);settleProject();
    expect(readProjectPlanConversion(db,catalog).projects).toContain('p:native-project');
    expect(readProjectPlanSlices(db).every(s=>s.account===null)).toBe(true);
    expect(readProjectPlanSlices(db).reduce((sum,s)=>sum+s.historical!,0)).toBeCloseTo(total,12);
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,periods);settleProject();
    const restored=readProjectPlanSlices(db);expect(restored.every(s=>s.account!==null)).toBe(true);
    db.exec('DELETE FROM project_plan_days');settleProject();expect(readProjectPlanSlices(db)).toEqual(restored);
  }finally{db.close();fs.rmSync(temp.directory,{recursive:true,force:true})}
});
test("the real Claude algorithm is published unchanged and the drawer reads that same durable result",()=>{
  const f=createClaudeCodeAcceptanceFixture();try{
    const original=buildClaudeCodeCapacityReport(f.db,ACCOUNTS.a,{rateCards:f.rates});
    const localCatalog:PlansCatalog={provider_groups:[{id:"claude",label:"Claude",aliases:["claude"],plans:[{plan_id:"claude-max",label:"Max",aliases:["max"],versions:[{from:null,usd_per_month:100}]}]}]};
    for(let i=0;i<20 && advanceWindowPointValues(f.db,{catalog:localCatalog,plans:{},now:Date.parse("2026-10-01"),budgetMs:10000})?.pending;i++);
    const localConfig={subscriptions:[{id:ACCOUNTS.a,vendor:"claude"},{id:ACCOUNTS.b,vendor:"claude"}],sources:Object.values(ACCOUNTS).map(id=>({vendor:"claude",machine:"synthetic",login:"fixture",home:ARCHIVE_LOGICAL_ROOT+"/claude/"+id,source_home:"C:/Users/fixture/.claude-"+id}))};
    for(let i=0;i<20 && advanceSubscriptionRates(f.db,{rates:f.rates,catalog:localCatalog,config:localConfig,now:Date.parse("2026-10-01"),limit:10})?.pending;i++);
    const row=readCapacityWindows(f.db,ACCOUNTS.a).at(-1)!;
    expect(row).toBeDefined();expect(row.capacity?.weekly_window_value_usd).toBe(original.weekly_capacity_api_usd.value);
    const stored=buildSubscriptionCapacities(f.db,f.rates,new Map(),{subscriptions:[ACCOUNTS.a],claudeAccounts:[ACCOUNTS.a],period:{since:TIMES.start,until:"2026-09-19"}}).get(ACCOUNTS.a);
    expect(stored?.weekly_window_value_usd).toBe(row.capacity?.weekly_window_value_usd);
    const unused=structuredClone(f.rates);
    unused.vendors.anthropic!.models!['unused-model']={in_uncached:999,in_cache_read:999,in_cache_write_5m:999,in_cache_write_1h:999,out_total:999};
    expect(advanceSubscriptionRates(f.db,{rates:unused,catalog:localCatalog,config:localConfig,now:Date.parse('2026-10-01'),limit:10})?.processed).toBe(0);
  }finally{f.teardown();}
});
test("bounded producer makes progress, restart and cleared cache cause no historical calculation",()=>{
  const f=setup();try{
    f.settle();expect(f.computed).toHaveLength(3);
    const before=readCapacityWindows(f.db);
    f.db.exec("DELETE FROM window_answers");
    f.settle();expect(f.computed).toHaveLength(3);
    expect(readCapacityWindows(f.db)).toEqual(before);
    const ro=new Database(f.dbPath,{readonly:true});
    try{
      const rows=readSubscriptionRates(ro,"codex1");
      expect(rows.windows).toHaveLength(2);
      expect(rows.preparing).toBe(false);
      const capacity=buildSubscriptionCapacities(ro,rates,new Map(),{subscriptions:["codex1"],period:{since:"2026-01-08",until:"2026-01-14"}}).get("codex1");
      expect(capacity?.weekly_window_value_usd).toBe(rows.windows[1]!.capacity!.weekly_window_value_usd);
      expect(advanceSubscriptionRates(f.db,{rates,catalog,config,now,calculate:f.calculate})?.processed).toBe(0);
    }finally{ro.close();}
  }finally{f.cleanup();}
});
test('stored capacity respects the verified Claude selection and never restores its legacy alias through fallback',()=>{
  const f=setup();try{
    f.settle();const base=readCapacityWindows(f.db)[0]!;
    for(const id of ['seat','other','claude']){
      const row={...base,id:'stored-'+id,provider:'claude',account:id,capacity:{...base.capacity!,sub_id:id,vendor:'claude'}};
      f.db.query('INSERT INTO subscription_capacity_windows(provider,account,counter,window_id,start_ts,end_ts,scope_start,signature,body,computed_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run('claude',id,'weekly',row.id,row.start,row.end,row.start,'fixture',JSON.stringify(row),row.computed_at);
      f.db.query('INSERT INTO subscription_capacity_state(key,value) VALUES(?,?)').run('account:'+id,'claude');
    }
    const configured={...rates,subscriptions:{...rates.subscriptions,seat:{usd_per_month:20},other:{usd_per_month:20},claude:{usd_per_month:200}}};
    const read=(claudeAccounts:string[])=>[...buildSubscriptionCapacities(f.db,configured,new Map(),{claudeAccounts}).values()].filter(c=>c.vendor==='claude');
    expect(read([])).toEqual([]);expect(read(['SEAT','claude']).map(c=>c.sub_id)).toEqual(['seat']);
    expect(read(['other']).map(c=>c.sub_id)).toEqual(['other']);
    expect([...buildSubscriptionCapacities(f.db,configured,new Map(),{claudeAccounts:['seat'],subscriptions:['SEAT']}).keys()]).toEqual(['seat']);
    const original=f.db.query;
    try {
      f.db.query=(()=>{throw Error('Empty selection queried the database');}) as typeof f.db.query;
      expect(buildSubscriptionCapacities(f.db,configured,new Map(),{subscriptions:[]}).size).toBe(0);
    } finally { f.db.query=original; }
  }finally{f.cleanup()}
});
test('mapped Codex ids stay preparing before publication and never invoke native cycle calibration',()=>{
  const f=setup();try{
    const configured={...rates,subscriptions:{seat:{usd_per_month:20}}};
    const bindings=[
      new Map([['C:/Users/test/.codex','seat']]),
      new Map([[`${ARCHIVE_LOGICAL_ROOT}/codex/custom`,'seat']]),
      restoreSubscriptionHomes([['C:/Users/test/custom-profile','seat']],['C:/Users/test/custom-profile'],
        [{vendor:'codex',home:`${ARCHIVE_LOGICAL_ROOT}/codex/custom`,source_home:'C:/Users/test/custom-profile'}]),
    ];
    const forbiddenCycles=Object.defineProperty({},'seat',{enumerable:true,get(){throw Error('Ordinary read invoked native calibration');}}) as Record<string,CycleLike[]>;
    for(const homes of bindings)for(const subscriptions of [undefined,['SEAT'],[]]){
      const opts={claudeAccounts:[],subscriptions};
      const result=buildSubscriptionCapacities(f.db,configured,homes,opts);
      if(subscriptions?.length===0){expect(result.size).toBe(0);continue;}
      expect(result.get('seat')).toMatchObject({vendor:'codex',capacity_basis:'none',weekly_window_value_usd:null,note:'capacity preparing'});
      expect(buildSubscriptionCapacities(f.db,configured,homes,{...opts,codexCycles:forbiddenCycles})).toEqual(result);
    }
    expect(f.db.query('SELECT COUNT(*) n FROM subscription_capacity_windows').get()).toEqual({n:0});
    replaceDeclaredPeriods(f.db,ACCOUNT_PERIODS,[...loadPeriods(f.db,ACCOUNT_PERIODS).filter(p=>p.origin==='declared'),
      {provider:'codex',subject:'codex/period-only',value:'period-seat',from:'2026-01-01',until:null,origin:'declared',
        firstSeen:null,lastSeen:null,readings:0,evidence:'fixture'}]);
    expect(buildSubscriptionCapacities(f.db,{...rates,subscriptions:{'period-seat':{usd_per_month:20}}},new Map(),{subscriptions:['PERIOD-SEAT']})
      .get('period-seat')).toMatchObject({vendor:'codex',weekly_window_value_usd:null,note:'capacity preparing'});
    expect(buildSubscriptionCapacities(f.db,configured,new Map(),{claudeGauge:{subscription:'seat'},subscriptions:['SEAT']})
      .get('seat')).toMatchObject({vendor:'claude',weekly_window_value_usd:null,note:'capacity preparing'});
    expect(buildSubscriptionCapacities(f.db,configured,new Map(),{codexCycles:forbiddenCycles,subscriptions:['SEAT']})
      .get('seat')).toMatchObject({vendor:'codex',weekly_window_value_usd:null,note:'capacity preparing'});
  }finally{f.cleanup();}
});
test("correction dirties only its account cohort and matches an independently filled register",()=>{
  const f=setup();try{
    f.settle();f.computed.length=0;
    const other=readCapacityWindows(f.db,"codex2");
    f.db.query("UPDATE window_usage SET cycle=json_set(cycle,'$.usage.api_standard',200) WHERE window_id='a1'").run();
    markWindowAnswersDirty(f.db,{provider:"codex",account:"codex1",fromMs:Date.parse("2026-01-02"),untilMs:Date.parse("2026-01-03")});
    f.settle();expect(f.computed.sort()).toEqual(["a1","a2"]);
    expect(readCapacityWindows(f.db,"codex2")).toEqual(other);
    const incremental=readCapacityWindows(f.db);
    f.db.exec("DELETE FROM subscription_capacity_windows");
    f.settle();expect(readCapacityWindows(f.db)).toEqual(incremental);
    f.computed.length=0;
    markWindowAnswersDirty(f.db,{provider:"gemini",account:"different",fromMs:0,untilMs:null});
    f.settle();expect(f.computed).toHaveLength(0);
  }finally{f.cleanup();}
});
test("below threshold, missing Standard valuation and rule changes are gaps, never zeros",()=>{
  const f=setup();try{
    f.db.query("UPDATE window_point_values SET pp=19 WHERE account='codex1' AND window_start LIKE '2026-01-01%'").run();
    f.db.query("UPDATE window_usage SET cycle=json_set(cycle,'$.usage.unpriced_events',1) WHERE window_id='a2'").run();
    f.settle();
    expect(readCapacityWindows(f.db,"codex1").map(w=>[w.rate,w.absent])).toEqual([[null,"below_20pp"],[null,"standard_valuation_missing"]]);
    const changed:PlansCatalog=JSON.parse(JSON.stringify(catalog));
    changed.provider_groups[0]!.plans[0]!.versions.push({from:"2026-01-04",usd_per_month:25});
    for(let i=0;i<10 && advanceSubscriptionRates(f.db,{rates,catalog:changed,config,now,limit:1,calculate:f.calculate})?.pending;i++);
    expect(readCapacityWindows(f.db,"codex1")[0]?.absent).toBe("rule_change_inside_window");
    expect(readCapacityWindows(f.db,"codex2")[0]?.rate).toBeNull();
  }finally{f.cleanup();}
});
test("matched one-date comparison identity holds before rounding and rejects incompatible cycles",()=>{
  const f=setup();try{
    f.settle();const [a,b]=readCapacityWindows(f.db,"codex1");
    const first={...a!,fixed_date:"2026-02-01",common_historical_usd:120,common_fixed_usd:150,used_pp:30};
    const second={...b!,fixed_date:"2026-02-01",common_historical_usd:240,common_fixed_usd:180,used_pp:40};
    for(const w of [first,second]) w.comparison={id:w.id,account:w.account,plan:w.plan,window_minutes:10080,
      start:w.start,end:w.end,reset:w.end,observed_pp:w.used_pp,start_percent:0,end_percent:w.used_pp,
      probes:2,max_gap_hours:1,models:[],sources:[],plan_detail:{status:"resolved",label:"Plus",multiplier:1},
      usage:{events:1,tokens:1,input:1,cached:0,output:0,fast_tokens:0,unknown_tokens:0,priced_tokens:1,unpriced_events:0,
        api_standard:1,credits_low:0,credits_high:0,revaluation_events:1,paired_historical_api:w.common_historical_usd,
        paired_reference_api:w.common_fixed_usd}} satisfies CodexComparisonWindow;
    const result=rateChange(first,second)!;
    expect(result.historical).toBe(result.price_effect+result.remainder);
    expect(rateChange(first,{...second,fixed_date:"2026-01-01"})).toBeNull();
    expect(rateChange(first,{...second,provider:"claude"})).toBeNull();
    expect(rateChange(first,first)).toBeNull();
  }finally{f.cleanup();}
});


test("model-only cycle samples do not rebuild capacity when discovery changes", () => {
  const f = setup();
  try {
    f.settle();
    const before = readCapacityWindows(f.db);
    f.computed.length = 0;
    f.db.exec("UPDATE window_usage SET cycle=json_set(cycle,'$.model_capacity',json('[{\"model\":\"sample-only\"}]'))");
    const relabeled = { ...config, subscriptions: config.subscriptions.map(s => ({ ...s, label: "renamed " + s.id })) };
    expect(advanceSubscriptionRates(f.db, { rates, catalog, config: relabeled, now, limit: 10, calculate: f.calculate }))
      .toEqual({ processed: 0, pending: false });
    expect(f.computed).toEqual([]);
    expect(readCapacityWindows(f.db)).toEqual(before);
  } finally { f.cleanup(); }
});

test("a one-window turn skips pending cohorts and resumes without replacing their completed publication", () => {
  const f = setup();
  try {
    f.settle();
    const before = readCapacityWindows(f.db, "codex1");
    f.computed.length = 0;
    f.db.exec("INSERT INTO window_usage_pending(provider,account,counter,window_id) SELECT provider,account,counter,window_id FROM window_usage WHERE window_id='a1'");
    f.db.query("UPDATE window_usage SET cycle=json_set(cycle,'$.usage.api_standard',200) WHERE window_id IN ('a1','b1')").run();
    markWindowAnswersDirty(f.db, { provider: "codex", account: "*", fromMs: Date.parse("2026-01-02"), untilMs: Date.parse("2026-01-03") });
    expect(advanceSubscriptionRates(f.db, { rates, catalog, config, now, limit: 1, calculate: f.calculate }))
      .toEqual({ processed: 1, pending: true });
    expect(f.computed).toEqual(["b1"]);
    expect(readCapacityWindows(f.db, "codex1")).toEqual(before);
    f.db.exec("DELETE FROM window_usage_pending WHERE window_id='a1'");
    const resumed = advanceSubscriptionRates(f.db, { rates, catalog, config, now, limit: 1, calculate: f.calculate });
    expect(resumed).toEqual({ processed: 1, pending: true });
    expect(f.computed).toHaveLength(2);
    f.settle();
    expect(f.computed.sort()).toEqual(["a1", "a2", "b1"]);
    const incremental = readCapacityWindows(f.db);
    f.db.exec("DELETE FROM subscription_capacity_windows");
    f.settle();
    expect(readCapacityWindows(f.db)).toEqual(incremental);
  } finally { f.cleanup(); }
});
