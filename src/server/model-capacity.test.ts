import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import type { AppContext } from "./api";
import { LIMIT_WINDOW_SCHEMA_SQL } from "../db/limit-windows";
import { WINDOW_USAGE_SCHEMA_SQL } from "../db/window-usage";
import { MODEL_CAPACITY_VERSION, type ModelCapacityResponse, type ModelCapacitySample } from "../shared/model-capacity";
import { handleModelCapacity } from "./model-capacity";
import { DATA_VIEWS } from "./data-views";
import { WINDOW_USAGE_CLOCK } from "./window-usage";

const opened: Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const counter = '["codex","codex",10080]';
const sample = (from: string, through: string, tokens = 200): ModelCapacitySample => ({ model: "m", from, through,
  observed_pp: 20, tokens, events: 20, api_usd: 2, unpriced_events: 0, unknown_mode_tokens: 0, fast_tokens: 0,
  max_gap_minutes: 10, reaches_100: false });
function fixture() {
  const db = new Database(":memory:"); opened.push(db);
  db.exec(LIMIT_WINDOW_SCHEMA_SQL); db.exec(WINDOW_USAGE_SCHEMA_SQL);
  db.query("INSERT INTO limit_window_state(provider,account,scope,version,status) VALUES('codex','a',?,1,'ready')").run(counter);
  const add = (id: string, samples: ModelCapacitySample[] | null, plan = "plus", account = "a") => {
    db.query(`INSERT INTO limit_windows VALUES('codex',?,?,? ,?,'2026-09-20T00:00:00Z','2026-09-27T00:00:00Z','2026-09-27T00:00:00Z','scheduled',10080,?,NULL,0,'[]',NULL,NULL,NULL,1,'{}')`)
      .run(account,counter,Number(id),id,plan);
    if(samples!==null)db.query(`INSERT INTO window_usage VALUES('codex',?,?,?,'2026-09-20T00:00:00Z','2026-09-27T00:00:00Z',?,'{}','[]','[]',NULL)`)
      .run(account,counter,id,JSON.stringify({model_capacity:{version:MODEL_CAPACITY_VERSION,models:['m'],samples,single_model_intervals:samples.length}}));
  };
  const ctx = {sqlite:db,plans:{},plansCatalog:{provider_groups:[]}} as unknown as AppContext;
  const request = async (extra = '') => (await handleModelCapacity(ctx,new URL(`http://local/api/model-capacity?provider=codex&account=a&since=2026-09-01&until=2026-09-30${extra}`)).json()) as ModelCapacityResponse;
  return {db,add,ctx,request};
}

test("a stored-row route follows the window register clock", () => {
  expect(DATA_VIEWS['/api/model-capacity']).toMatchObject({direct:true,clock:false});
  expect(DATA_VIEWS['/api/model-capacity']!.sources).toContain(WINDOW_USAGE_CLOCK);
});
test("invalid scope, calendar dates and model-scoped counters are refused before a database read", () => {
  for(const query of ['provider=gemini&account=a&since=2026-09-01&until=2026-09-30',
    'provider=codex&account=all&since=2026-09-01&until=2026-09-30',
    'account=a&since=2026-02-30&until=2026-03-30',
    'account=a&since=2026-09-01&until=2026-09-30&project=x',
    `provider=claude&account=a&since=2026-09-01&until=2026-09-30&counter=${encodeURIComponent('["weekly_scoped","weekly",10080]')}`])
    expect(handleModelCapacity({} as AppContext,new URL(`http://local/api/model-capacity?${query}`)).status).toBe(400);
});
test("medians stay within account, plan and mode; missing prices never become zero", async () => {
  const f=fixture();
  f.add('1',[sample('2026-09-21T00:00:00Z','2026-09-21T00:20:00Z',200),
    {...sample('2026-09-21T01:00:00Z','2026-09-21T01:20:00Z',400),unpriced_events:1}]);
  f.add('2',[sample('2026-09-22T00:00:00Z','2026-09-22T00:20:00Z',600)]);
  f.add('3',[sample('2026-09-23T00:00:00Z','2026-09-23T00:20:00Z',1000)],'pro');
  f.add('4',[{...sample('2026-09-24T00:00:00Z','2026-09-24T00:20:00Z',500),fast_tokens:500}]);
  f.add('5',[sample('2026-09-25T00:00:00Z','2026-09-25T00:20:00Z',99999)],'plus','b');
  const r=await f.request();
  expect(r.rows).toHaveLength(3);
  const standard=r.rows.find(row=>row.plan==='plus'&&row.mode==='standard')!;
  expect(standard).toMatchObject({samples:3,windows:2,priced_samples:2,observed_pp:60,tokens:{median:2000,p25:1500,p75:2500},api_usd:{median:10}});
  expect(standard.reasons).toContain('partial_prices');
  expect(r.rows.find(row=>row.mode==='fast')!.tokens!.median).toBe(2500);
});

test("All can cover more than one year while reading only stored model samples", async () => {
  const f = fixture();
  f.add('1', [sample('2026-09-21T00:00:00Z', '2026-09-21T00:20:00Z')]);
  const before = (f.db.query('SELECT total_changes() n').get() as { n: number }).n;
  const response = handleModelCapacity(f.ctx, new URL('http://local/api/model-capacity?account=a&since=2024-01-01&until=2026-10-16'));
  expect(response.status).toBe(200);
  expect((await response.json() as ModelCapacityResponse).rows[0]!.samples).toBe(1);
  expect((f.db.query('SELECT total_changes() n').get() as { n: number }).n).toBe(before);
});
test("the range keeps whole samples and preparing reads do not write or read event tables", async () => {
  const f=fixture(); f.add('1',[sample('2026-09-21T00:00:00Z','2026-09-22T00:00:00Z')]);f.add('2',null);
  const before=(f.db.query('SELECT total_changes() n').get() as {n:number}).n;
  const queries:string[]=[],original=f.db.query;
  f.db.query=function(this:Database,sql:string,...args:unknown[]){queries.push(sql);return original.call(this,sql,...args as []);} as typeof f.db.query;
  const r=await f.request();expect(r.preparing_windows).toBe(1);expect(r.rows[0]!.samples).toBe(1);
  const narrowed=await handleModelCapacity(f.ctx,new URL('http://local/api/model-capacity?account=a&since=2026-09-22&until=2026-09-23')).json() as ModelCapacityResponse;
  expect(narrowed.rows).toEqual([]);
  expect((f.db.query('SELECT total_changes() n').get() as {n:number}).n).toBe(before);
  expect(queries.every(sql=>!/(?:FROM|JOIN)\s+(?:events|codex_price_ledger_events|usage_ledger_facts)\b/i.test(sql))).toBe(true);
});
test("pending windows retain a complete stored result and expose preparation", async () => {
  const f=fixture();f.add('1',[sample('2026-09-21T00:00:00Z','2026-09-21T00:20:00Z')]);
  f.db.query("INSERT INTO window_usage_pending VALUES('codex','a',?,'1')").run(counter);
  const r=await f.request();expect(r.preparing_windows).toBe(1);expect(r.rows[0]!.tokens!.median).toBe(1000);
});
test("sub-20pp evidence is visible and never mixed into a full-sample median", async () => {
  const f=fixture();f.add('1',[sample('2026-09-21T00:00:00Z','2026-09-21T00:20:00Z'),
    {...sample('2026-09-21T01:00:00Z','2026-09-21T01:20:00Z',9999),observed_pp:1}]);
  let r=await f.request();expect(r.rows[0]).toMatchObject({samples:1,small_samples:1,tokens:{median:1000}});
  f.db.query('DELETE FROM window_usage').run();f.db.query('DELETE FROM limit_windows').run();
  f.add('2',[{...sample('2026-09-21T01:00:00Z','2026-09-21T01:20:00Z',100),observed_pp:5}]);
  r=await f.request();expect(r.rows[0]).toMatchObject({samples:0,small_samples:1,tentative:true,tokens:{median:2000}});
});

test("a mismatched plan and manual readings cannot contaminate the confirmed automatic cohort", async () => {
  const f=fixture();
  f.add('1',[sample('2026-09-21T00:00:00Z','2026-09-21T00:20:00Z',200)]);
  f.add('2',[sample('2026-09-22T00:00:00Z','2026-09-22T00:20:00Z',2000)]);
  f.add('3',[sample('2026-09-23T00:00:00Z','2026-09-23T00:20:00Z',4000)]);
  f.db.query("UPDATE limit_windows SET plan_mismatch=1 WHERE window_id='2'").run();
  f.db.query("UPDATE limit_windows SET manual='[]' WHERE window_id='3'").run();
  const r=await f.request();expect(r.rows).toHaveLength(3);
  expect(r.rows.find(row=>row.plan==='plus'&&!row.reasons.includes('manual'))!.tokens!.median).toBe(1000);
  expect(r.rows.find(row=>row.plan===null)!.reasons).toContain('unknown_plan');
  expect(r.rows.find(row=>row.reasons.includes('manual'))!.samples).toBe(1);
});

test("a catalog allowance boundary inside a window keeps earlier and later samples separate", async () => {
  const f=fixture();
  f.add('1',[sample('2026-05-30T10:00:00Z','2026-05-30T11:00:00Z',200),sample('2026-06-01T10:00:00Z','2026-06-01T11:00:00Z',2000)]);
  f.db.query("UPDATE limit_windows SET start_ts='2026-05-29T00:00:00Z',end_ts='2026-06-05T00:00:00Z'").run();
  const r=await handleModelCapacity(f.ctx,new URL('http://local/api/model-capacity?account=a&since=2026-05-01&until=2026-06-30')).json() as ModelCapacityResponse;
  expect(r.rows).toHaveLength(2);
  expect(r.rows.map(row=>row.tokens!.median).sort((a,b)=>a-b)).toEqual([1000,10000]);
});

test("known imprecise traffic makes purity unavailable rather than dropping a second model", async () => {
  const f=fixture();f.add('1',[sample('2026-09-21T00:00:00Z','2026-09-21T00:20:00Z')]);
  f.db.query("UPDATE window_usage SET cycle=json_set(cycle,'$.model_capacity.uncertain_events',1)").run();
  const r=await f.request();expect(r.rows[0]).toMatchObject({samples:0,tokens:null});
  expect(r.rows[0]!.reasons).toContain('uncertain_traffic');
});

test("private allowance changes split samples within one window and a crossing sample stays unavailable", async () => {
  const f=fixture();
  f.ctx.plans={capacity_regimes:[{id:'before',subscription:'a',factor:1,from:'2026-09-01',until:'2026-09-21',source:'user'},
    {id:'after',subscription:'a',factor:2,from:'2026-09-22',until:'2026-09-30',source:'user'}]};
  f.add('1',[sample('2026-09-21T00:00:00Z','2026-09-21T00:20:00Z',200),sample('2026-09-22T00:00:00Z','2026-09-22T00:20:00Z',2000),
    sample('2026-09-21T23:50:00Z','2026-09-22T00:10:00Z',1000)]);
  const r=await f.request();expect(r.rows).toHaveLength(3);
  expect(r.rows.filter(row=>row.samples).map(row=>row.allowance_factor).sort()).toEqual([1,2]);
  const crossing=r.rows.find(row=>row.terms==='mixed')!;
  expect(crossing.tokens).toBeNull();expect(crossing.reasons).toContain('changing_terms');
});
