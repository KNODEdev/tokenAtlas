import {markWindowAnswersDirty} from "../db/window-answers";
import { afterEach, expect, test } from "bun:test";
import { contextDetailsFixture } from "./codex-context-details.fixture";
import { advanceCodexContextDetails, computeContextModelWindow } from "./codex-context-model-producer";
import { handleCycleBreakdown } from "./api-cycle-breakdown";
import { handleModelCapacity } from "./model-capacity";
import { handleModelUsageShare } from "./model-usage-share";
import { decodeContextParts } from "../db/codex-context-details";
import { ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { dataVersion } from "./data-version";
import { readCodexWindowDetail } from "./codex-window-detail";
import { captureContextRead, runContextRead } from "../db/codex-context-read-scope";
import { contextDetailPreviewReader } from "./codex-context-detail-read";

const opened: ReturnType<typeof contextDetailsFixture>[]=[];
afterEach(()=>{for(const f of opened.splice(0))f.db.close();});
const fixture=(included=false)=>{const f=contextDetailsFixture(included);opened.push(f);return f;};
const url=(path:string,on=false)=>{const u=new URL("http://test"+path);if(on)u.searchParams.set("context","1");return u;};
const modelPath=(name:string)=>`/api/${name}?account=owner&since=2026-09-01&until=2026-09-08`;
const cyclePath=(f:ReturnType<typeof fixture>)=>`/api/cycle-breakdown?account=owner&since_ts=${f.window.start}&until_ts=${f.window.end}&anchor=${Date.parse(f.window.reset)/1000}&valuation=dated`;

test("bucket projection reconciles its components and restarts without rewriting existing window rows",()=>{
  const f=fixture(),before=f.db.query("SELECT cycle,rail,readings,slices FROM window_usage").all();
  f.fillDetails();
  const parts=decodeContextParts((f.db.query("SELECT parts FROM codex_context_bucket_parts WHERE event_id=2").get() as {parts:string}).parts);
  expect(Object.fromEntries(Object.entries(parts).map(([key,value])=>[key,ledgerPresentationNumber(value)])))
    .toEqual({input:0.8,cached:0.1,cache_write:0.25,output:0.25});
  expect(f.db.query("SELECT cycle,rail,readings,slices FROM window_usage").all()).toEqual(before);
  const changes=f.db.query("SELECT total_changes() n").get();
  expect(advanceCodexContextDetails(f.db,f.rates)).toMatchObject({pending:false,writes:0,windows:0,partitions:0});
  expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
});

test("window buckets and CostSplit add exact saved parts, retain funding exclusions and default bytes",async()=>{
  const f=fixture();
  const before=await handleCycleBreakdown(f.ctx,url(cyclePath(f))).text();
  f.fillDetails();
  expect(await handleCycleBreakdown(f.ctx,url(cyclePath(f))).text()).toBe(before);
  const body:any=await handleCycleBreakdown(f.ctx,url(cyclePath(f),true)).json();
  expect(body.context_preview_status).toMatchObject({ready:true,missing_groups:0});
  const preview=body.context_preview;
  expect(preview.totals.usd).toBeCloseTo(14.05,9);
  expect(preview.days.reduce((sum:number,row:any)=>sum+row.usd,0)).toBeCloseTo(preview.totals.usd,9);
  expect(preview.sessions.reduce((sum:number,row:any)=>sum+row.usd,0)).toBeCloseTo(preview.totals.usd,9);
  expect(preview.model_detail.rows.reduce((sum:number,row:any)=>sum+(row.api?.total??0),0)).toBeCloseTo(preview.totals.usd,9);
  expect(preview.model_detail.surfaces.reduce((sum:number,row:any)=>sum+row.usd,0)).toBeCloseTo(preview.totals.usd,9);
  expect(preview.credit_funded).toMatchObject({calls:2,tokens:2000000,api_standard:4});
  expect(preview.credit_funded.hours.reduce((sum:number,h:any[])=>sum+h[4],0)).toBe(4);
  expect(JSON.parse(before)).not.toHaveProperty("context_preview");
  expect(preview.totals.tokens).toBe(body.totals.tokens);
});

test("By model applies each sample before quantiles and exact hour deltas before API ranking",async()=>{
  const f=fixture();f.fillDetails();
  const normal:any=await handleModelCapacity(f.ctx,url(modelPath("model-capacity"))).json();
  const paired:any=await handleModelCapacity(f.ctx,url(modelPath("model-capacity"),true)).json();
  expect(paired.context_preview_status).toMatchObject({ready:true,missing_groups:0});
  const base=normal.rows.find((row:any)=>row.model==="m"),next=paired.context_preview.rows.find((row:any)=>row.model==="m");
  expect(base.api_usd).toEqual({median:5,p25:5,p75:15});
  expect(next.api_usd).toEqual({median:10,p25:10,p75:17.5});
  expect(next.tokens).toEqual(base.tokens);
  const share:any=await handleModelUsageShare(f.ctx,url(modelPath("model-usage-share"),true),Date.parse(f.window.end)).json();
  expect(share.context_preview_status).toMatchObject({ready:true,missing_groups:0});
  const preview=share.context_preview;
  expect(preview.windows[0].api_usd.reduce((sum:number,value:number)=>sum+value,0)).toBeCloseTo(14.05,9);
  expect(preview.detail.points.at(-1).api_usd.reduce((sum:number,value:number)=>sum+value,0)).toBeCloseTo(14.05,9);
});

test("ordinary handlers query no new projection and unprepared opt-in reads keep their original money",async()=>{
  const f=fixture();
  const routes=[{path:cyclePath(f),read:handleCycleBreakdown},{path:modelPath("model-capacity"),read:handleModelCapacity},
    {path:modelPath("model-usage-share"),read:handleModelUsageShare}];
  const query=f.db.query.bind(f.db),queries:string[]=[];
  f.db.query=((sql:string)=>{queries.push(sql);return query(sql);}) as typeof f.db.query;
  for(const route of routes){const body:any=await route.read(f.ctx,url(route.path)).json();expect(body).not.toHaveProperty("context_preview_status");}
  expect(queries.filter(sql=>/codex_context_(?:detail|bucket|model)/.test(sql))).toEqual([]);
  for(const route of routes){
    const plain:any=await route.read(f.ctx,url(route.path)).json(),pending:any=await route.read(f.ctx,url(route.path,true)).json();
    expect(pending.context_preview_status.ready).toBe(false);expect(pending.context_preview).toBeUndefined();
    delete pending.context_preview_status;expect(pending).toEqual(plain);
  }
});

test("exact instant and project cuts preserve their population and request membership",()=>{
  const f=fixture();f.fillDetails();
  const read=()=>readCodexWindowDetail(f.db,f.rates,{account:"owner",homes:[...f.ctx.homeToSubId.keys()][0]?[...f.ctx.homeToSubId.keys()]:[],
    from:"2026-09-01T12:00:00.001Z",until:"2026-09-01T13:30:00.000Z",inclusiveEnd:false,
    anchor:Date.parse(f.window.reset)/1000,limitId:"codex",sessionMinutes:30,project:"b",includeBurn:false,homeToSubId:f.ctx.homeToSubId});
  const reader=contextDetailPreviewReader(f.db,"details"),base=captureContextRead(reader.scope,read),preview=runContextRead(reader.scope,read);
  expect(reader.status).toMatchObject({ready:true,missing_groups:0});
  expect(base.totals.calls).toBe(2);expect(base.totals.usd).toBe(2);expect(preview.totals.usd).toBe(4);
  expect([...preview.byBlock.values()].reduce((sum,row)=>sum+row.usd,0)).toBe(4);
  expect(preview.detail.rows.reduce((sum,row)=>sum+(row.api?.total??0),0)).toBe(4);
});

test("missing uplift remains unknown and already included uplift is never added again",async()=>{
  const missing=contextDetailsFixture(false,rates=>{delete rates.codex_ledger_policy!.base_rules[0]!.long_context!.rates.in_cache_write;});opened.push(missing);
  missing.fillDetails();
  const result:any=await handleCycleBreakdown(missing.ctx,url(cyclePath(missing),true)).json();
  expect(result.context_preview_status.missing_groups).toBeGreaterThan(0);
  const included=fixture(true);included.fillDetails();
  const paired:any=await handleModelCapacity(included.ctx,url(modelPath("model-capacity"),true)).json();
  expect(paired.context_preview.rows).toEqual(paired.rows);
  expect(included.db.query("SELECT count(*) n FROM codex_context_bucket_parts").get()).toEqual({n:0});
});

test("interruption resumes only the new queues; duplicate retries and a changed reading are idempotent",()=>{
  const f=fixture();
  expect(advanceCodexContextDetails(f.db,f.rates,{canWrite:()=>false})).toMatchObject({writes:0,pending:true});
  const first=advanceCodexContextDetails(f.db,f.rates,{limit:0});expect(first.partitions).toBe(1);expect(first.windows).toBe(0);
  f.fillDetails();
  const saved=f.db.query("SELECT * FROM codex_context_model_windows").all();
  f.db.query("INSERT OR IGNORE INTO codex_context_model_pending VALUES('owner',?,?)").run(f.window.counter,f.window.id);
  expect(advanceCodexContextDetails(f.db,f.rates)).toMatchObject({windows:1,writes:0,pending:false});
  expect(f.db.query("SELECT * FROM codex_context_model_windows").all()).toEqual(saved);
  f.db.query("UPDATE limit_windows SET readings=json_set(readings,'$[2].percent',41) WHERE window_id=?").run(f.window.id);
  markWindowAnswersDirty(f.db,{provider:"codex",account:"owner",fromMs:Date.parse(f.window.start),untilMs:Date.parse(f.window.end)});
  expect(f.db.query("SELECT count(*) n FROM codex_context_window_ranges").get()).toEqual({n:1});
  f.fillDetails();
  const row=f.db.query("SELECT w.*,u.cycle,u.rail,u.slices,u.readings usage_readings FROM limit_windows w JOIN window_usage u USING(provider,account,counter,window_id)").get() as Parameters<typeof computeContextModelWindow>[2];
  const full=computeContextModelWindow(f.db,f.rates,row,f.ctx.accounts.subscriptions);
  expect(JSON.parse((f.db.query("SELECT data FROM codex_context_model_windows").get() as {data:string}).data)).toEqual(full);
});

test("detail publications affect only opt-in routes declaring this new dependency",()=>{
  const f=fixture();f.fillDetails();
  const normal=dataVersion(f.db),phase2=dataVersion(f.db,{contextPrices:"/api/global-usage"}),detail=dataVersion(f.db,{contextPrices:"/api/cycle-breakdown"});
  f.db.exec("UPDATE codex_context_detail_state SET revision=revision+1");
  expect(dataVersion(f.db)).toBe(normal);expect(dataVersion(f.db,{contextPrices:"/api/global-usage"})).toBe(phase2);
  expect(dataVersion(f.db,{contextPrices:"/api/cycle-breakdown"})).not.toBe(detail);
});


test("API-only requests change model totals while capacity samples retain their joint-price population",()=>{
  const f=fixture();f.fillDetails();
  const data=JSON.parse((f.db.query("SELECT data FROM codex_context_model_windows").get() as {data:string}).data);
  expect(new Map(data.model_extra).get("api-only")).toBe(1);
  const samples=JSON.parse((f.db.query("SELECT cycle FROM window_usage").get() as {cycle:string}).cycle).model_capacity.samples;
  for(const [index,sample] of samples.entries())if(sample.model==="api-only")expect(data.sample_extra[index]).toBe(0);
  expect(data.sample_extra).toEqual(samples.map((sample:any)=>sample.model==="m" ? ({"12:00":0,"12:30":1,"13:00":1,"15:00":0} as Record<string,number>)[sample.through.slice(11,16)]??0 : 0));
});

test("a scoped projection correction preserves unrelated day/model and window checkpoints",()=>{
  const f=fixture();f.fillDetails();
  const before=f.db.query("SELECT * FROM codex_context_bucket_parts ORDER BY event_id").all();
  const dim=(f.db.query("SELECT dim_id FROM codex_context_events WHERE event_id=2").get() as {dim_id:number}).dim_id;
  f.db.query("UPDATE codex_context_aggregates SET rule_revision=rule_revision WHERE grain='day' AND day='2026-09-01' AND dim_id=?").run(dim);
  expect(f.db.query("SELECT * FROM codex_context_detail_dirty").all()).toEqual([{day:"2026-09-01",dim_id:dim}]);
  const result=advanceCodexContextDetails(f.db,f.rates);
  expect(result.partitions).toBe(1);expect(result.writes).toBe(0);f.fillDetails();
  expect(f.db.query("SELECT * FROM codex_context_bucket_parts ORDER BY event_id").all()).toEqual(before);
  expect(f.db.query("SELECT count(*) n FROM codex_context_model_pending").get()).toEqual({n:0});
});


test("manual window boundaries use (from, through] and do not rerun stored sums",()=>{
  const f=fixture();f.fillDetails();
  const row=f.db.query("SELECT w.*,u.cycle,u.rail,u.slices,u.readings usage_readings FROM limit_windows w JOIN window_usage u USING(provider,account,counter,window_id)").get() as Parameters<typeof computeContextModelWindow>[2];
  const next={...row,window_id:"manual:boundaries",start_ts:"2026-09-01T12:00:00.000Z",end_ts:"2026-09-01T13:00:00.000Z",seq:-1};
  const result=computeContextModelWindow(f.db,f.rates,next,f.ctx.accounts.subscriptions);
  expect(new Map(result.model_extra).get("m")).toBe(2);
});


test("publication fences context source changes made after a model batch was computed",()=>{
  const f=fixture();f.fillDetails();let checks=0;
  f.db.query("INSERT OR IGNORE INTO codex_context_model_pending VALUES('owner',?,?)").run(f.window.counter,f.window.id);
  const before=f.db.query("SELECT * FROM codex_context_model_windows").all();
  const result=advanceCodexContextDetails(f.db,f.rates,{canWrite(){if(++checks===3)f.db.exec("UPDATE codex_context_state SET source_revision=source_revision+1");return true;}});
  expect(result).toMatchObject({windows:0,writes:0,pending:true});
  expect(f.db.query("SELECT * FROM codex_context_model_windows").all()).toEqual(before);
  f.db.exec("UPDATE codex_context_state SET covered_revision=source_revision");
  expect(advanceCodexContextDetails(f.db,f.rates)).toMatchObject({windows:1,writes:0,pending:false});
});
