import {afterEach,expect,test} from "bun:test";
import {contextDetailsFixture} from "./codex-context-details.fixture";
import {computeFinalContextWindow,type FinalWindowSource,finalContextPolicy} from "./codex-context-final-window";
import {finalContextDatabase,setFinalState,finalHash} from "./codex-context-final-store";
import {withFinalContext,mergeFinalApi,finalContextResponse} from "./codex-context-final-read";
import {overlayBillingApi,advanceFinalContext,readFinalProjectCalls} from "./codex-context-final-producer";
import {projectPeak,advanceProjectPlanFacts,type PreparedProjectCall} from "./project-plan-producer";
import {cyclePointCalibration} from "./window-point-values";
import {cycleResets,type StoredCycleRow} from "./billing-cycle-producer";
import type {WindowPointValueRow} from "../db/window-point-values";
import {markContextWindowRange} from "../db/codex-context-details";
import {dataVersion} from "./data-version";
import {medianApi} from "./plan-capacity-statistics";
import {admit,type Candidate} from "./plan-capacity-candidates";
import type {TokenRates} from "./plan-capacity-contracts";
const opened:ReturnType<typeof contextDetailsFixture>[]=[];
afterEach(()=>{for(const f of opened.splice(0))f.db.close();});
const fixture=(included=false,configure?:Parameters<typeof contextDetailsFixture>[1])=>{const f=contextDetailsFixture(included,configure);opened.push(f);return f;};
const source=(f:ReturnType<typeof fixture>)=>f.db.query(`SELECT w.*,u.cycle,u.rail,u.readings usage_readings,u.slices,u.reference FROM limit_windows w JOIN window_usage u USING(provider,account,counter,window_id)`).get() as FinalWindowSource;
const compute=(f:ReturnType<typeof fixture>)=>computeFinalContextWindow(f.db,f.rates,source(f),f.ctx.accounts.subscriptions,"2026-09-01");
test("final window projection keeps joint/API-only/funded populations and exact prefix boundaries",()=>{
 const f=fixture(),before=f.db.query("SELECT * FROM window_usage").all(),result=compute(f);
 expect(result.missing).toBe(0);
 expect(result.sums.cycle.usage.api_standard-f.sums.cycle.usage.api_standard).toBeCloseTo(2,9);
 expect(result.sums.rail.api_standard-f.sums.rail.api_standard).toBeCloseTo(4.4,9);
 expect(result.sums.rail.credit_funded!.api_standard-f.sums.rail.credit_funded!.api_standard).toBeCloseTo(2,9);
 expect(result.sums.readings.map((r,i)=>r.usage.api_standard-f.sums.readings[i]!.usage.api_standard)).toEqual([0,0,1,2,2,2,2]);
 expect(result.sums.cycle.usage.tokens).toBe(f.sums.cycle.usage.tokens);
 expect(f.db.query("SELECT * FROM window_usage").all()).toEqual(before);
});
test("already included premium is never added twice",()=>{
 const f=fixture(true),result=compute(f);
 expect(result.sums.cycle.usage.api_standard).toBe(f.sums.cycle.usage.api_standard);
 expect(result.sums.rail.api_standard).toBe(f.sums.rail.api_standard);
});
test("a missing projection keeps coverage unknown rather than inventing a zero price",()=>{
 const f=fixture();f.db.query("DELETE FROM codex_context_events WHERE event_id=3").run();
 expect(compute(f).missing).toBeGreaterThan(0);
});
test("classified request slices retain cache-write rates and preserve unsupported slices",()=>{
 const f=fixture(),slices=compute(f).sums.slices;
 expect(slices.some(s=>s.context_rates?.in_uncached===2&&s.context_classified)).toBe(true);
 expect(slices.some(s=>s.tokens.in_cache_write_5m>0&&!s.context_classified)).toBe(true);
 expect(slices.some(s=>s.model==="missing"&&!s.context_classified)).toBe(true);
});
test("calculator proxy rejects original/compound writes and permits only its companion tables",()=>{
 const f=fixture(),db=finalContextDatabase(f.db,true),before=f.db.query("SELECT * FROM window_usage").all();
 expect(()=>db.exec("DELETE FROM events")).toThrow("source write");
 expect(()=>db.exec("SELECT 1; DELETE FROM events")).toThrow("compound write");
 expect(()=>finalContextDatabase(f.db).exec("DELETE FROM window_usage")).toThrow("source write");
 db.query("INSERT INTO project_plan_state VALUES('test','1')").run();
 expect(f.db.query("SELECT value FROM codex_context_final_project_plan_state WHERE key='test'").get()).toEqual({value:"1"});
 expect(f.db.query("SELECT * FROM window_usage").all()).toEqual(before);
});
test("default reads perform no companion work; preparing opt-in retains legacy bytes",()=>{
 const f=fixture(),base={api_usd:2,tokens:4},sql:string[]=[],query=f.db.query;
 f.db.query=function(this:ReturnType<typeof fixture>["db"],statement:string,...args:any[]){sql.push(statement);return query.call(this,statement,...args as []);} as typeof f.db.query;
 expect(withFinalContext(f.db,false,()=>base)).toBe(base);expect(sql).toEqual([]);
 const preview=withFinalContext(f.db,true,()=>base);expect(preview.api_usd).toBe(2);
 expect(preview.context_preview_status?.ready).toBe(false);expect(preview.context_preview).toBeUndefined();
});
test("revision/lease fence refuses a producer write and leaves its durable queue intact",()=>{
 const f=fixture();f.fillDetails();const changes=f.db.query("SELECT total_changes() n").get();
 expect(advanceFinalContext(f.db,{rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,canWrite:()=>false})).toMatchObject({written:0,pending:true});
 expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
});
const call=(time:string,historical:number|null,today=historical):PreparedProjectCall=>({account:"a",subject:null,ts:"2026-09-01T"+time+":00.000Z",historical,today});
test("five-hour preview peak is independently maximized rather than adding the peak uplift",()=>{
 const calls=[call("09:00",10,10),call("15:00",9,20)];
 expect(projectPeak(calls,"2026-09-01",false)).toBe(10);expect(projectPeak(calls,"2026-09-01",true)).toBe(20);
 const reference=Math.max(...calls.map(c=>calls.filter(x=>Date.parse(x.ts)>=Date.parse(c.ts)&&Date.parse(x.ts)<Date.parse(c.ts)+18000000).reduce((s,x)=>s+x.today!,0)));
 expect(projectPeak(calls,"2026-09-01",true)).toBe(reference);
});
test("peak includes next-day calls only before the exact five-hour end; missing remains unknown",()=>{
 const calls=[call("23:00",2),{...call("02:00",3),ts:"2026-09-02T02:00:00.000Z"},{...call("04:00",50),ts:"2026-09-02T04:00:00.000Z"}];
 expect(projectPeak(calls,"2026-09-01",true)).toBe(5);
 expect(projectPeak([...calls,call("20:00",null)],"2026-09-01",true)).toBeNull();
});
test("reference fingerprint selects dated long-context rules independently of historical policy",()=>{
 const f=fixture(),options={rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts};
 const calls=readFinalProjectCalls(f.db,options,"2026-09-01","2026-09-01");
 expect(calls.find(c=>c.ts.includes("12:30"))?.historical).toBe(2);
 expect(calls.find(c=>c.ts.includes("12:30"))?.today).toBe(2);
 const before=finalHash(finalContextPolicy(f.rates).bands);
 f.rates.codex_ledger_policy!.base_rules.find(r=>r.model==="m"&&r.billing_basis==="api_equivalent_usd")!.long_context!.rates.in_uncached="3";
 expect(finalHash(finalContextPolicy(f.rates).bands)).not.toBe(before);
 expect(readFinalProjectCalls(f.db,options,"2026-09-01","2026-09-01").find(c=>c.ts.includes("12:30"))?.today).toBe(3);
});
const point=(day:number,api:number)=>({status:"eligible",plan:"pro",pp:50,regime_factor:1,scope:null,window_start:`2026-09-${String(day).padStart(2,"0")}T00:00:00Z`,window_end:`2026-09-${String(day+1).padStart(2,"0")}T00:00:00Z`,api_standard:api,tokens_input:500,tokens_cached:100,tokens_output:50,credits_low:null,credits_high:null} as WindowPointValueRow);
test("preview observation values enter monetary outlier screening and borrowing before calibration",()=>{
 const rows=[point(1,100),point(4,1000),point(7,1200)],cycle={start:Date.parse(rows[0]!.window_start),end:Date.parse(rows[0]!.window_end),plan:"pro"};
 const base=cyclePointCalibration(rows,cycle)!,preview=cyclePointCalibration([{...rows[0]!,api_standard:2000},...rows.slice(1)],cycle)!;
 expect(base.outliers.count).toBe(1);expect(base.inside).toBe(0);expect(base.per_point.api_standard).toBe(22);
 expect(preview.outliers.count).toBe(0);expect(preview.inside).toBe(1);expect(preview.per_point.api_standard).toBe(30);
 expect(preview.pp).toBe(base.pp);expect(preview.per_point.tokens_input).toBe(base.per_point.tokens_input);
});
test("reset cap conserves point/token/credit bonuses and causes while previewing API money",()=>{
 const rows=[{cause:"banked",window_start:"2026-09-01",window_end:"2026-09-02",planned_reset:"2026-09-03",bonus:2,banked_origin:"all_accounts"}] as any;
 const cycle={start:Date.parse("2026-09-01"),end:Date.parse("2026-10-01")},per={tokens_input:10,tokens_cached:2,tokens_output:1,api_standard:22,credits_low:1,credits_high:2};
 const a=cycleResets(rows,cycle,per,()=>2,2,1),b=cycleResets(rows,cycle,{...per,api_standard:30},()=>2,2,1);
 expect(a.capped).toBe(true);expect(b.resets!.banked!.api_usd).toBe(6000);
 expect({...b.resets!.banked,api_usd:0}).toEqual({...a.resets!.banked,api_usd:0});
});
test("API-only overlay preserves stored bill, catalogue price, tokens, reset causes and provenance",()=>{
 const base={api_usd:2,capacity_usd:4,amount_minor:3000,detail:JSON.stringify({capacity:{api_usd:4,tokens:50,calibration:{windows:2}},used_units:{api_usd:2,tokens:3},resets:{banked:{api_usd:1,pp:4,count:1}}})} as StoredCycleRow;
 const next={...base,api_usd:3,capacity_usd:8,amount_minor:999,detail:JSON.stringify({capacity:{api_usd:8,tokens:999,calibration:{windows:3}},used_units:{api_usd:3,tokens:999},resets:{banked:{api_usd:2,pp:99,count:9}}})};
 const result=overlayBillingApi(base,next),detail=JSON.parse(result.detail);
 expect(result.amount_minor).toBe(3000);expect(detail.capacity.tokens).toBe(50);expect(detail.resets.banked).toEqual({api_usd:2,pp:4,count:1});
 expect(detail.capacity.context_api_calibration).toEqual({windows:3});
});
const prices:TokenRates={in_uncached:1,in_cache_read:0.1,in_cache_write_5m:1.25,in_cache_write_1h:1.25,out_total:5};
const candidate=(rates?:TokenRates)=>({window_id:"x",start_ts:"2026-09-01",end_ts:"2026-09-08",first_percent:0,peak_percent:50,sample_count:80,distinct_steps:40,cadence_hours:168,capacity_factor:1,capacity_regime_id:null,tokens:{in_uncached:2000000,in_cache_read:0,in_cache_write_5m:0,in_cache_write_1h:0,out_total:0},rates,obs:{window_id:"x"}} as Candidate);
test("classified slices are valued separately before aggregation and quantile selection",()=>{
 const f=fixture(),c=candidate();c.slices=[{model:"m",speed:"standard",day:"2026-09-01",context_classified:true,rates:prices,tokens:c.tokens},{model:"m",speed:"standard",day:"2026-09-01",context_classified:true,rates:{...prices,in_uncached:2},tokens:c.tokens}];
 const result=admit(c,f.rates,"openai");expect(result.sample!.api_usd_per_1pct.value).toBeCloseTo(6/50,4);
});
test("custom reference rates keep their provenance and are not reclassified",()=>{
 const f=fixture(),result=admit(candidate({...prices,in_uncached:7}),f.rates,"openai");expect(result.sample!.api_usd_per_1pct.value).toBeCloseTo(14/50,4);
 expect(admit(candidate(),f.rates,"openai").sample).toBeNull();
});
test("merge previews only API branches and leaves other vendors and measurements unchanged",()=>{
 const base={rows:[{provider:"codex",api_usd:2,tokens:4},{provider:"claude",api_usd:5,tokens:8}],capacity_usd:3,usd:30};
 const next={rows:[{provider:"codex",api_usd:3,tokens:9},{provider:"claude",api_usd:9,tokens:9}],capacity_usd:6,usd:99};
 expect(mergeFinalApi(base,next)).toEqual({rows:[{provider:"codex",api_usd:3,tokens:4},{provider:"claude",api_usd:5,tokens:8}],capacity_usd:6,usd:30});
});

test("independent producer checkpoint resumes, preserves source rows, and unchanged restart writes nothing",()=>{
 const f=fixture();f.fillDetails();const before=f.db.query("SELECT * FROM window_usage").all();
 const options={rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,now:Date.parse("2026-09-09")};
 let result=advanceFinalContext(f.db,options);expect(result.processed).toBe(1);
 for(let turn=0;turn<30&&result.pending;turn++)result=advanceFinalContext(f.db,options);
 expect(result.pending).toBe(false);
 const changes=f.db.query("SELECT total_changes() n").get();expect(advanceFinalContext(f.db,options)).toEqual({written:0,processed:0,pending:false});
 expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
 expect(f.db.query("SELECT * FROM window_usage").all()).toEqual(before);
 const prepared=f.db.query("SELECT cycle,rail,readings,slices FROM codex_context_final_window_usage WHERE account='owner'").get() as any;
 const full=compute(f).sums;expect(JSON.parse(prepared.cycle)).toEqual(full.cycle);expect(JSON.parse(prepared.slices)).toEqual(full.slices);
});

test("a scoped rate correction invalidates preceding peak days and incremental results equal a fresh full derivation",()=>{
 const f=fixture();f.fillDetails();const options={rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,now:Date.parse("2026-09-09")};
 const settle=(f:ReturnType<typeof fixture>)=>{for(let n=0;n<40;n++)if(!advanceFinalContext(f.db,{...options,rates:f.rates,config:f.ctx.accounts,catalog:f.ctx.plansCatalog}).pending)return;throw new Error("did not settle");};settle(f);
 const before=f.db.query("SELECT * FROM window_usage").all();
 const change=(rates:typeof f.rates)=>{rates.codex_ledger_policy!.base_rules.find(r=>r.model==="m"&&r.billing_basis==="api_equivalent_usd")!.long_context!.rates.in_uncached="3";};
 change(f.rates);f.db.query("UPDATE usage_ledger_state SET rules_json=? WHERE provider='codex'").run(JSON.stringify(f.rates.codex_ledger_policy));f.fill();
 expect(f.db.query("SELECT day,until_day FROM codex_context_final_project_plan_dirty WHERE provider='codex'").all()).toContainEqual({day:"2026-08-31",until_day:"2026-09-01"});
 f.fillDetails();settle(f);
 const full=fixture(false,change);full.fillDetails();settle(full);
 for(const table of ["codex_context_final_window_usage","codex_context_final_project_plan_days"]){const column=table.endsWith("days")?"body":"cycle";const own=f.db.query(`SELECT ${column} FROM ${table} WHERE provider='codex' ORDER BY 1`).all() as any[],reference=full.db.query(`SELECT ${column} FROM ${table} WHERE provider='codex' ORDER BY 1`).all() as any[];
 const facts=(rows:any[])=>rows.map(r=>JSON.stringify(JSON.parse(r[column]),(key,value)=>key.startsWith("context_")?undefined:value));expect(facts(own)).toEqual(facts(reference));}
 expect(f.db.query("SELECT * FROM window_usage").all()).toEqual(before);
 const changes=f.db.query("SELECT total_changes() n").get();expect(advanceFinalContext(f.db,options).pending).toBe(false);expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
});

test.each([[999999,2],[1000000,0],[1000001,0]])("request threshold %i is strict before slice aggregation",(threshold,extra)=>{
 const f=fixture(false,rates=>{rates.codex_ledger_policy!.base_rules.find(r=>r.model==="m"&&r.billing_basis==="api_equivalent_usd")!.long_context!.above_input_tokens=threshold!;}),result=compute(f);
 expect(result.sums.cycle.usage.api_standard-f.sums.cycle.usage.api_standard).toBe(extra!);
 const measured=result.sums.slices.filter(s=>s.paired&&s.model==="m"&&s.context_classified&&s.tokens.in_uncached>0);
 expect(measured.every(s=>s.context_rates!.in_uncached===(extra?2:1))).toBe(true);
});

test("companion array scopes match stable identities when another provider adds or reorders rows",()=>{
 const base={accounts:[{provider:"claude",account:"new",api_usd:1},{provider:"codex",account:"a",api_usd:2}]},preview={accounts:[{provider:"codex",account:"a",api_usd:3}]};
 expect(mergeFinalApi(base,preview)).toEqual({accounts:[base.accounts[0]!,{provider:"codex",account:"a",api_usd:3}]});
});

test("only the four explicit companion cache dependencies follow final projection publications",()=>{
 const f=fixture(),base=dataVersion(f.db,{windowSums:false}),unrelated=dataVersion(f.db,{windowSums:false,contextPrices:"/api/summary?context=1"});
 const paths=["project-plan","billing-cycles","plan-capacity","subscription-rate"],before=paths.map(path=>dataVersion(f.db,{windowSums:false,contextPrices:"/api/"+path+"?context=1"}));
 setFinalState(f.db,"revision","123");expect(dataVersion(f.db,{windowSums:false})).toBe(base);expect(dataVersion(f.db,{windowSums:false,contextPrices:"/api/summary?context=1"})).toBe(unrelated);
 paths.forEach((path,i)=>expect(dataVersion(f.db,{windowSums:false,contextPrices:"/api/"+path+"?context=1"})).not.toBe(before[i]));
});

test("window normalization retains the priced fallback cohort when the request mode is unknown",()=>{
 const f=fixture();f.db.exec("UPDATE codex_price_ledger_dims SET service_tier=NULL,speed='unknown' WHERE id=(SELECT dim_id FROM codex_price_ledger_events WHERE id=4)");
 const result=compute(f);expect(result.sums.cycle.usage.api_standard-f.sums.cycle.usage.api_standard).toBe(2);
 expect(result.sums.cycle.usage.api_normalized!-f.sums.cycle.usage.api_normalized!).toBe(2);
 expect(result.sums.slices.some(s=>s.model==='m'&&s.speed==='unknown'&&!s.context_classified)).toBe(true);
});

test("plan API medians use previewed sample values before selecting the central observation",()=>{
 const f=fixture(),values=[1,4,2],samples=values.map((rate,i)=>{const c=candidate();c.window_id=String(i);c.slices=[{model:'m',speed:'standard',day:'2026-09-01',context_classified:true,rates:{...prices,in_uncached:rate},tokens:c.tokens}];return admit(c,f.rates,'openai').sample!;});
 const reference=values.map(rate=>2000000/1000000*rate/50).sort((a,b)=>a-b)[1]!;
 expect(medianApi(samples).usd.value).toBe(reference);expect(medianApi([...samples].reverse()).usd.value).toBe(reference);
});

test("simulation peaks keep account and unassigned-window boundaries, including next-day calls",()=>{
 const f=fixture(),proxy=finalContextDatabase(f.db,true),next={provider:'codex',account:'owner',id:'next',start:'2026-09-02T00:00:00.000Z',end:'2026-09-03T00:00:00.000Z',capacity:null};
 f.db.query("INSERT INTO codex_context_final_subscription_capacity_windows VALUES('codex','owner','weekly','next',?,?,'2026-09-01','fixture',0,?,'2026-09-09')").run(next.start,next.end,JSON.stringify(next));
 const calls=[{...call('23:00',2),account:'owner',subject:'p:test'},{...call('23:00',3),account:'before',subject:'p:test'},{...call('01:00',9),ts:'2026-09-02T01:00:00.000Z',account:'owner',subject:'p:test'}];
 expect(advanceProjectPlanFacts(proxy,{rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,providers:['codex'],scopePeaks:true,referenceDay:'2026-09-01',bounds:{first:'2026-09-01',last:'2026-09-01'},readCalls:()=>calls,limit:10})?.pending).toBe(false);
 const body=JSON.parse((f.db.query("SELECT body FROM codex_context_final_project_plan_days WHERE provider='codex'").get() as {body:string}).body);
 expect(body.map((row:any)=>[row.account,row.window_id,row.historical,row.peak,row.today_peak])).toEqual([['owner',null,2,2,2],['before',null,3,3,3]]);
 next.start='2026-09-02T03:00:00.000Z';f.db.query("UPDATE codex_context_final_subscription_capacity_windows SET start_ts=?,body=? WHERE provider='codex' AND account='owner' AND window_id='next'").run(next.start,JSON.stringify(next));
 expect(advanceProjectPlanFacts(proxy,{rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,providers:['codex'],scopePeaks:true,referenceDay:'2026-09-01',bounds:{first:'2026-09-01',last:'2026-09-01'},readCalls:()=>calls,limit:10})?.processed).toBe(1);
 const corrected=JSON.parse((f.db.query("SELECT body FROM codex_context_final_project_plan_days WHERE provider='codex'").get() as {body:string}).body);expect(corrected.find((r:any)=>r.account==='owner').peak).toBe(11);

});

test("opt-in validation errors preserve their original status and body",async()=>{
 const f=fixture(),response=finalContextResponse(f.db,true,(_db,json)=>json({error:'missing plan'},{status:400}));
 expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'missing plan'});
});

test("unsupported companion slices cannot be reconstructed into an invented known cache/mode price",()=>{
 const f=fixture(),c=candidate();c.slices=[{model:'m',speed:'standard',day:'2026-09-01',context_classified:false,tokens:c.tokens}];
 expect(admit(c,f.rates,'openai')).toMatchObject({sample:null,diagnostic:{reason:'missing_rate'}});
});

test("a pending original billing-scope correction retains stored money and is scoped to its account",()=>{
 const f=fixture();f.fillDetails();const options={rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,now:Date.parse('2026-09-09')};
 for(let n=0;n<40;n++)if(!advanceFinalContext(f.db,options).pending)break;
 f.db.exec("DELETE FROM billing_cycle_dirty; DELETE FROM window_point_value_dirty; DELETE FROM window_usage_dirty; DELETE FROM window_usage_pending");const base={api_usd:2};
 expect(withFinalContext(f.db,true,()=>base,{billing:true,account:'owner'}).context_preview_status!.ready).toBe(true);
 f.db.exec("INSERT INTO billing_cycle_dirty(provider,account,from_ms,until_ms) VALUES('codex','owner',0,NULL)");
 const pending=withFinalContext(f.db,true,()=>base,{billing:true,account:'owner'});expect(pending.api_usd).toBe(2);expect(pending.context_preview).toBeUndefined();expect(pending.context_preview_status!.ready).toBe(false);
 expect(withFinalContext(f.db,true,()=>base,{billing:true,account:'before'}).context_preview_status!.ready).toBe(true);
 expect(withFinalContext(f.db,true,()=>base,{billing:true,account:'OWNER'}).context_preview_status!.ready).toBe(false);
});


test("reference companions use each saved reference day rather than the worker clock",()=>{
 const f=fixture(false,rates=>{const rule=rates.codex_ledger_policy!.base_rules.find(r=>r.model==='m'&&r.billing_basis==='api_equivalent_usd')!;rule.valid_until='2026-09-02';const next=structuredClone(rule);next.id+='-later';next.valid_from='2026-09-02';delete next.valid_until;next.long_context!.rates.in_uncached='3';rates.codex_ledger_policy!.base_rules.push(next);});
 f.db.query("UPDATE window_usage SET reference=?").run(JSON.stringify({day:'2026-09-01',fingerprint:'saved',cycle:f.sums.cycle}));
 f.db.query("INSERT OR REPLACE INTO project_plan_state VALUES('price-date','2026-09-01')").run();f.fillDetails();
 const options={rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,now:Date.parse('2026-09-09')};
 for(let n=0;n<40;n++)if(!advanceFinalContext(f.db,options).pending)break;
 const saved=JSON.parse((f.db.query("SELECT reference FROM codex_context_final_window_usage WHERE account='owner'").get() as {reference:string}).reference);
 expect(saved.day).toBe('2026-09-01');
 expect(saved.cycle.usage.reference_api_standard).toBeCloseTo(compute(f).sums.reference!.cycle.usage.reference_api_standard!,9);
 expect(f.db.query("SELECT value FROM codex_context_final_project_plan_state WHERE key='price-date'").get()).toEqual({value:'2026-09-01'});
});

test("pending original sums suppress only the affected account's opt-in branch",()=>{
 const f=fixture();f.fillDetails();const options={rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,now:Date.parse('2026-09-09')};
 for(let n=0;n<40;n++)if(!advanceFinalContext(f.db,options).pending)break;
 f.db.exec("DELETE FROM window_usage_dirty; DELETE FROM window_usage_pending; DELETE FROM billing_cycle_dirty; DELETE FROM window_point_value_dirty");
 f.db.query("INSERT INTO window_usage_dirty(provider,account,counter,from_ms,until_ms) VALUES('codex','owner','*',0,NULL)").run();
 const read=()=>({api_usd:2});
 expect(withFinalContext(f.db,true,read,{billing:true,account:'owner'}).context_preview_status!.ready).toBe(false);
 expect(withFinalContext(f.db,true,read,{billing:true,account:'before'}).context_preview_status!.ready).toBe(true);
});

test("a missing preview or stored API basis retains stored values and reports coverage",()=>{
 const f=fixture();f.fillDetails();const options={rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,now:Date.parse('2026-09-09')};
 for(let n=0;n<40;n++)if(!advanceFinalContext(f.db,options).pending)break;
 for(const [old,next] of [[2,null],[null,2]] as const){const response=withFinalContext(f.db,true,db=>({api_usd:db===f.db?old:next}));expect(response.api_usd).toBe(old);expect(response.context_preview).toBeUndefined();expect(response.context_preview_status!.missing_groups).toBe(1);}
});


test("ordinary reference-only publication invalidates the companion even with identical phase-3 money",()=>{
 const f=fixture();f.fillDetails();const options={rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,now:Date.parse('2026-09-09')};
 const settle=()=>{for(let n=0;n<40;n++)if(!advanceFinalContext(f.db,options).pending)return;throw new Error('not settled');};settle();
 f.db.query("UPDATE window_usage SET reference=?").run(JSON.stringify({day:'2026-09-02',fingerprint:'saved',cycle:f.sums.cycle}));
 markContextWindowRange(f.db,'owner',Date.parse(f.window.start),Date.parse(f.window.end));f.fillDetails();
 expect(f.db.query("SELECT 1 FROM codex_context_final_pending").get()).not.toBeNull();settle();
 expect(JSON.parse((f.db.query("SELECT reference FROM codex_context_final_window_usage WHERE account='owner'").get() as {reference:string}).reference).day).toBe('2026-09-02');
 const changes=f.db.query("SELECT total_changes() n").get();settle();expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
});


test("reference projection adds only the dated uplift to an older accepted reference baseline",()=>{
 const f=fixture(),calculated=compute(f),reference=structuredClone(calculated.sums.reference!);
 reference.cycle.usage.reference_api_standard=123;reference.cycle.cycle_usage.reference_api_standard=456;
 reference.cycle.usage.paired_historical_api=21;reference.cycle.usage.paired_reference_api=22;
 f.db.query("UPDATE window_usage SET reference=?").run(JSON.stringify(reference));
 const result=compute(f).sums.reference!;
 expect(result.cycle.usage.reference_api_standard).toBeCloseTo(127.4,9);
 expect(result.cycle.cycle_usage.reference_api_standard).toBeCloseTo(460.4,9);
 expect(result.cycle.usage.paired_historical_api).toBeCloseTo(25.4,9);expect(result.cycle.usage.paired_reference_api).toBeCloseTo(26.4,9);
});


test("a corrected window start cannot leave its old companion point in calibration",()=>{
 const f=fixture();f.fillDetails();f.db.query("INSERT INTO window_point_values(provider,account,counter,window_start,window_end,basis,status,inputs_rev,computed_at) VALUES('codex','owner',?, ?,?,'final','no_percent','point','2026-09-09')").run(f.window.counter,f.window.start,f.window.end);
 const options={rates:f.rates,catalog:f.ctx.plansCatalog,config:f.ctx.accounts,now:Date.parse('2026-09-09')};
 const settle=()=>{for(let n=0;n<40;n++)if(!advanceFinalContext(f.db,options).pending)return;throw new Error('not settled');};settle();
 const next='2026-09-01T11:59:01.000Z';f.db.query("UPDATE limit_windows SET start_ts=? WHERE account='owner'").run(next);f.db.query("UPDATE window_usage SET start_ts=? WHERE account='owner'").run(next);f.db.query("UPDATE window_point_values SET window_start=? WHERE account='owner'").run(next);
 markContextWindowRange(f.db,'owner',Date.parse(f.window.start),Date.parse(f.window.end));f.fillDetails();settle();
 expect(f.db.query("SELECT window_start FROM codex_context_final_window_point_values WHERE account='owner'").all()).toEqual([{window_start:next}]);
 const changes=f.db.query("SELECT total_changes() n").get();settle();expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
});
