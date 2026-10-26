import { test, expect } from "bun:test";
import { Database } from "../db/sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixture as legacyFixture, capture, instrument, NOW, SINCE, UNTIL, SOURCE_A } from "../../scripts/benchmark-cycle-breakdown";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { referenceCycleBreakdown } from "../../scripts/lib/cycle-breakdown-reference";
import { handleCycleBreakdown, type AppContext } from "./api";
import { prepareProbeReaderFixture, type ProbeReaderFixtureSource } from "./probe-reader.fixture";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import { codexAccountSelector } from "./codex-source-account";
import { codexEventOwnedBy } from "./codex-event-owner";
import { assertCycleBreakdownParity } from "../../scripts/lib/cycle-breakdown-parity";

const EVENT_COLUMNS = "(home,path,ts,model,project_id,in_tok,cached_in,cache_write,out_tok)";
function fixture(unrelated = 0, filename = ":memory:"): AppContext {
  const ctx = legacyFixture(unrelated,filename);
  // The general parity cohort declares complete vectors; NULL coverage is exercised separately below.
  ctx.sqlite.exec("UPDATE events SET cached_in=0 WHERE in_tok IS NULL; UPDATE events SET in_tok=0 WHERE in_tok IS NULL; UPDATE events SET cache_write=0 WHERE cache_write IS NULL");
  ctx.rateCards.codex_accounting = {version:1,rules:[{id:"fixture-api",model:"gpt",speed:"standard",billing_basis:"api_equivalent_usd",
    valid_from:"1900-01-01",verified_at:"2026-01-01",confidence:"user",sources:["https://example.com/synthetic"],multiplier:1,
    rates:{in_uncached:2,in_cache_read:0.5,in_cache_write:0,out_total:8}}]};
  ctx.homeToSubId = indexSubscriptionHomes([{id:SOURCE_A.id,home:SOURCE_A.source_home}],[SOURCE_A]);
  return ctx;
}

const PROBE_SOURCE: ProbeReaderFixtureSource = { ...SOURCE_A, machine: "synthetic", login: "fixture", source_home: "A" };
const fixtureProxyDatabases = new WeakSet<object>();
function prepare(ctx: AppContext): void {
  if (!fixtureProxyDatabases.has(ctx.sqlite)) {
    if (ctx.rateCards) {
      prepareCodexLedgerFixture(ctx.sqlite,ctx.rateCards,ctx.homeToSubId,ctx.accounts.sources);
      ctx.sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS fixture_event_locator ON events(home,path,source_offset)");
    }
    prepareProbeReaderFixture(ctx.sqlite, [PROBE_SOURCE]);
  }
}
async function preparedCapture(ctx: AppContext, suffix = "", handler = handleCycleBreakdown) {
  prepare(ctx);
  return capture(ctx, suffix, handler);
}

test("frozen reference source is pinned independently", () => {
  const bytes = fs.readFileSync(path.resolve(import.meta.dir, "../../scripts/lib/cycle-breakdown-reference.ts"));
  expect(createHash("sha256").update(bytes.toString("utf8").replaceAll("\r\n","\n")).digest("hex")).toBe("165e48d10d5adc90adfc5790b6359510b73448df60243850fc276ee73ff3ea3d");
});

async function parity(ctx: AppContext, suffix = "") {
  const actual = await preparedCapture(ctx,suffix);
  const expected = await preparedCapture(ctx,suffix,referenceCycleBreakdown);
  assertCompatible(ctx,suffix,actual,expected);
  return actual.body as any;
}
function assertCompatible(ctx:AppContext,suffix:string,actual:{status:number;body:any},expected:{status:number;body:any}) {
  assertCycleBreakdownParity(ctx,{since:SINCE,until:UNTIL},suffix,actual,expected);
}

for (const suffix of ["", "&project_id=alpha", "&project_id=unassigned", "&project_id=missing", "&limit_id=spark", "&anchor="+Math.floor(NOW/1000), "&session_window=37", "&session_window=invalid", "&anchor=-1", "&since_ts=bad", "&until_ts=bad", "&since_ts=", "&until_ts="+SINCE, "&account=empty", "&account=unknown"]) {
  test(`full response parity ${suffix}`, async () => {
    const ctx=fixture();
    try { await parity(ctx,suffix); } finally {ctx.sqlite.close();}
  });
}

test("local-day parity uses the host timezone in UTC and across Warsaw daylight saving", async () => {
  for (const zone of ["UTC","Europe/Warsaw"]) {
    const child=Bun.spawn([process.execPath,"test",import.meta.filename,"--test-name-pattern","^full response parity $","--timeout","60000"],
      {cwd:process.cwd(),env:{...process.env,TZ:zone},stdout:"pipe",stderr:"pipe"});
    const [code,output]=await Promise.all([child.exited,new Response(child.stderr).text()]);
    expect({zone,code,output:code===0?"":output}).toEqual({zone,code:0,output:""});
    expect(output).toContain("1 pass");
  }
},60000);

function mutate(sqlite: Database, edit: (sql:string)=>string) {
  const wrapped=Object.create(sqlite) as Database;
  Object.defineProperty(wrapped,"inTransaction",{get:()=>sqlite.inTransaction});
  wrapped.transaction=sqlite.transaction.bind(sqlite) as Database["transaction"];
  wrapped.query=((sql:string)=>sqlite.query(edit(sql))) as Database["query"];
  fixtureProxyDatabases.add(wrapped);
  return wrapped;
}

test("inclusive boundary regression", async () => {
  const ctx=fixture();
  try {
    ctx.sqlite.exec("DELETE FROM events");
    const put=ctx.sqlite.query(`INSERT INTO events ${EVENT_COLUMNS} VALUES ('A','p',?,'gpt','alpha',10,2,1,3)`);
    for (const ts of [SINCE, UNTIL, new Date(Date.parse(SINCE)-1).toISOString(),new Date(Date.parse(UNTIL)+1).toISOString()]) put.run(ts);
    prepare(ctx);
    const candidate=process.env.CYCLE_BOUNDARY_MUTANT ? {...ctx,sqlite:mutate(ctx.sqlite,sql=>sql.replaceAll("l.instant_ms <= ?","l.instant_ms < ?"))} : ctx;
    const response=(await capture(candidate)).body as any;
    expect(response.totals.calls).toBe(2);
    expect(response.sessions.reduce((n:number,s:any)=>n+s.calls,0)).toBe(2);
    // Burn intentionally has no owner or upper bound in the pre-existing contract.
    expect(response.burn_windows[0].calls).toBe(2);
    // Keep the independent frozen oracle outside the mutated database proxy.
    await parity(ctx);
  } finally {ctx.sqlite.close();}
});

test("hour sums, cut pieces and an independent moving burn read despite unrelated history and many displayed buckets", async () => {
  const ctx=fixture(200000);
  try {
    prepare(ctx);
    const measured=instrument(ctx.sqlite);
    const candidate=await capture({...ctx,sqlite:measured.sqlite},"&session_window=1");
    const reference=await parity(ctx,"&session_window=1");
    expect(candidate.body).toEqual(reference);
    // Whole hours come from the stored hour sums, the parts of the hours the window's boundaries cut from the ledger's calls
    // through its time index; no read joins the calls' facts or scans a ledger or fact table.
    const plans=measured.samples.flatMap(s=>s.plan);
    expect(plans.some(p=>p.includes("fixture_event_locator"))).toBe(false);
    expect(plans.filter(p=>/SCAN (events|e|l|a|codex_price_ledger_events|codex_price_ledger_aggregates)\b/.test(p))).toEqual([]);
    expect(plans.some(p=>/SEARCH a USING INDEX codex_price_ledger_aggregates_day/.test(p))).toBe(true);
    expect(plans.some(p=>/SEARCH e USING INDEX codex_price_ledger_events_time \(instant_ms>\? AND instant_ms<\?\)/.test(p))).toBe(true);
  } finally {ctx.sqlite.close();}
});

test("ties, duplicates, NULLs, unpriced and owner/project distinctions", async () => {
  const ctx=fixture();
  try {
    ctx.sqlite.exec("DELETE FROM events");
    const put=ctx.sqlite.query(`INSERT INTO events ${EVENT_COLUMNS} VALUES ('A',?,?,?, ?, ?, ?, ?, ?)`);
    const ts="2026-04-01T12:30:00.000Z";
    for(const model of [null,"gpt","missing","gpt",null,"missing"]) put.run("p",ts,model,null,10,null,null,2);
    // Owned by nobody: an instant in a gap between the account's periods, and no owner row for the reference.
    put.run("unowned","2026-04-01T12:31:30.000Z","gpt",null,999,0,0,0);
    declareCodexEraPeriods(ctx.sqlite, [{...SOURCE_A, until:"2026-04-01T12:31:00.000Z"}, {...SOURCE_A, from:"2026-04-01T12:32:00.000Z"}], {replace:true});
    const result=(await preparedCapture(ctx)).body as any;
    expect(result.totals.calls).toBe(6);
    expect(result.days.find((d:any)=>d.calls)?.top_model).toBe(null);
    expect(result.totals.tokens).toBe(0); // NULL counters cannot establish a complete chargeable vector.
    expect(result.totals.usd).toBe(0);
    expect(ctx.sqlite.query("SELECT COUNT(*) n FROM codex_price_ledger_events WHERE common_reason='invalid_tokens'").get()).toEqual({n:6});
    expect(ctx.sqlite.query("SELECT COUNT(*) n FROM events WHERE cached_in IS NULL AND cache_write IS NULL").get()).toEqual({n:6});
    expect(result.burn_windows[2].calls).toBe(7);
  } finally {ctx.sqlite.close();}
});

test("an invalid stored timestamp belongs to no account and turns no NULL bucket into session zero", async () => {
  const ctx=fixture();
  try {
    const clean=await parity(ctx);
    ctx.sqlite.query(`INSERT INTO events ${EVENT_COLUMNS} VALUES ('A','p',?,'missing',NULL,10,0,0,2)`).run("2026-03-27Tgarbage");
    // The frozen reference trusted the rollout's owner row; an account period cannot place an unreadable instant.
    // Burn rates count every event of the homes, owner or not, as they always have.
    const {burn_windows:burn,unpriced,...rest}=(await preparedCapture(ctx)).body as any, {burn_windows:cleanBurn,unpriced:cleanUnpriced,...cleanRest}=clean;
    expect(rest).toEqual(cleanRest);
    // The retired lexical query assigned malformed source text to a window. Its time remains unplaced.
    expect(burn[3].calls).toBe(cleanBurn[3].calls);
    expect(unpriced).toEqual({...cleanUnpriced,time_quality:{scope:"declared-source",unplaced_calls:1}});
  } finally {ctx.sqlite.close();}
});

test("anchor tolerance, separate limits, session threshold and partial block edge", async () => {
  const ctx=fixture();
  try {
    ctx.sqlite.exec("DELETE FROM ratelimit; DELETE FROM events");
    const anchor=Math.floor(NOW/1000);
    const put=ctx.sqlite.query("INSERT INTO ratelimit VALUES ('A','p',?,?,?,10,?)");
    for (const delta of [-121,-120,0,120,121]) put.run(UNTIL,301,"codex",anchor+delta);
    put.run(UNTIL,300,"codex",anchor);
    put.run(UNTIL,300,"spark",anchor);
    put.run(UNTIL,301,"spark",anchor);
    const body=await parity(ctx,"&anchor="+anchor);
    expect(body.days.reduce((sum:number,d:any)=>sum+d.gauge_samples,0)).toBe(3);
    expect(body.short_counter.reported).toBe(true);
    const edge=Math.floor(Date.parse(SINCE)/1000)*1000+300*60000;
    for(const delta of [-1,0,455,456]) ctx.sqlite.query(`INSERT INTO events ${EVENT_COLUMNS} VALUES ('A','p',?,'gpt',NULL,1,0,0,1)`).run(new Date(edge+delta).toISOString());
    const blocks=await parity(ctx);
    expect(blocks.sessions[0].calls).toBe(1);
    expect(blocks.sessions[1].calls).toBe(3);
  } finally {ctx.sqlite.close();}
});

test("current short counters preserve latest success and same-timestamp error semantics", async () => {
  const ctx=fixture();
  try {
    ctx.sqlite.exec(`CREATE TABLE probe_windows(provider TEXT,subject TEXT,ts TEXT,kind TEXT,limit_group TEXT,scope TEXT,plan TEXT,window_minutes INTEGER,used_percent REAL,resets_at TEXT,rate_limit_reached INTEGER,reset_credits INTEGER,machine TEXT,ok INTEGER);
      INSERT INTO probe_windows VALUES ('codex','a','2026-04-02T10:00:00.000Z','primary','codex','subscription','pro',300,20,NULL,0,0,'synthetic',1),
        ('codex','a','2026-04-02T10:00:00.000Z','primary','spark','subscription','pro',300,30,NULL,0,0,'synthetic',0),
        ('codex','a','2026-04-02T11:00:00.000Z','error','codex','subscription','pro',300,99,NULL,0,0,'synthetic',0)`);
    const body=await parity(ctx);
    expect(body.short_counter.live.used_percent).toBe(20);
    expect(body.short_counter.other[0].used_percent).toBe(30);
  } finally {ctx.sqlite.close();}
});

test("late input and attribution correction are visible after next read and reopen", async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ta-cycle-restart-"));
  const filename=path.join(dir,"test.sqlite");
  const ctx=fixture(0,filename);
  try {
    const before=await parity(ctx);
    // A late event of the account's source and time counts on the next read.
    const late="2026-03-30T00:00:00.500Z";
    ctx.sqlite.query(`INSERT INTO events ${EVENT_COLUMNS} VALUES ('A','late',?,'gpt','alpha',500,10,0,20)`).run(late);
    const after=await parity(ctx);
    expect(after.totals.calls).toBe(before.totals.calls+1);
    // An account period correction leaves the late event's instant to nobody: it no longer counts.
    declareCodexEraPeriods(ctx.sqlite, [{...SOURCE_A, until:late}, {...SOURCE_A, from:new Date(Date.parse(late)+1).toISOString()}], {replace:true});
    const corrected=await parity(ctx);
    expect(corrected.totals.calls).toBe(before.totals.calls);
    ctx.sqlite.close();
    ctx.sqlite=new Database(filename);
    expect((await preparedCapture(ctx)).body).toEqual(corrected);
  } finally {ctx.sqlite.close();fs.rmSync(dir,{recursive:true});}
});

test("required native read failures stay explicit while independent probe reads retain best-effort behavior", async () => {
  const ctx=fixture();
  try {
    prepare(ctx);
    const failed=mutate(ctx.sqlite,sql=> {
      if (sql.includes("FROM codex_price_ledger_events l INDEXED BY")) throw new Error("shared read failure");
      return sql;
    });
    await expect(preparedCapture({...ctx,sqlite:failed})).rejects.toThrow("shared read failure");
    expect((await preparedCapture({...ctx,rateCards:null as unknown as AppContext["rateCards"]})).status).toBe(202);
    ctx.sqlite.exec("DROP TABLE ratelimit");
    await parity(ctx);
    // Without ownership no event enters this account; its declared source burn still remains known.
    ctx.sqlite.exec("DROP TABLE account_periods");
    const unowned=(await capture(ctx)).body as any;
    expect(unowned.totals.calls).toBe(0);
    expect(unowned.burn_windows[3].calls).toBeGreaterThan(0);
  } finally {ctx.sqlite.close();}
});

if (process.env.CYCLE_DST_CHILD) {
  test("local days retain 23 and 25 hour DST spans and partial hours", async () => {
    const ctx=fixture();
    try {
      prepare(ctx);
      const spans = process.platform === "win32" ? [
        ["2025-03-09T05:00:00.000Z", "2025-03-10T04:00:00.000Z", 23],
        ["2025-11-02T04:00:00.000Z", "2025-11-03T05:00:00.000Z", 25],
        ["2025-03-09T06:17:23.456Z", "2025-03-09T08:19:03.789Z", 2.03],
      ] as const : [
        ["2025-03-29T23:00:00.000Z", "2025-03-30T22:00:00.000Z", 23],
        ["2025-10-25T22:00:00.000Z", "2025-10-26T23:00:00.000Z", 25],
        ["2025-03-30T00:17:23.456Z", "2025-03-30T02:19:03.789Z", 2.03],
      ] as const;
      for (const [since,until,hours] of spans) {
        ctx.sqlite.exec("DELETE FROM events");
        for(const ts of [since,new Date(Date.parse(since)+3600000).toISOString()]) ctx.sqlite.query(`INSERT INTO events ${EVENT_COLUMNS} VALUES ('A','p',?,'gpt',NULL,10,0,0,2)`).run(ts);
        const before=Date.now;Date.now=()=>NOW;
        let actual:Response,reference:Response;
        try {prepare(ctx);const url=new URL(`http://localhost/?account=a&since_ts=${since}&until_ts=${until}`);actual=handleCycleBreakdown(ctx,url);reference=referenceCycleBreakdown(ctx,url);}
        finally {Date.now=before;}
        const body=await actual!.json() as any;
        assertCompatible(ctx,`since_ts=${since}&until_ts=${until}`,{status:actual!.status,body},{status:reference!.status,body:await reference!.json()});
        expect(body.days.map((d:any)=>d.hours)).toEqual([hours]);expect(body.totals.calls).toBe(2);
      }
    } finally {ctx.sqlite.close();}
  });
} else {
  test("DST runs in a separate TZ process", () => {
    // Windows CRT uses US DST rules. EST5EDT is understood by both it and JS's timezone database;
    // CET-1CEST is not a JS timezone, so it silently used the runner's host timezone instead.
    const tz=process.platform==="win32" ? "EST5EDT" : "Europe/Warsaw";
    const result=Bun.spawnSync([process.execPath,"test",import.meta.filename,"--test-name-pattern","local days retain"],
      {env:{...process.env,TZ:tz,CYCLE_DST_CHILD:"1"},stdout:"pipe",stderr:"pipe"});
    expect({code:result.exitCode,stderr:result.exitCode===0?"":result.stderr.toString()}).toEqual({code:0,stderr:""});
    expect(result.stderr.toString()).toContain("1 pass");
  });
}

test("default cycle prices each request context before grouping and preserves missing usage", async () => {
  const ctx=fixture();
  try {
    ctx.sqlite.exec("DELETE FROM events; ALTER TABLE events ADD COLUMN usage_status TEXT");
    const ts="2026-04-01T12:30:00.000Z";
    const put=ctx.sqlite.query("INSERT INTO events(home,path,ts,model,project_id,in_tok,cached_in,cache_write,out_tok,usage_status) VALUES ('A','p',?,'gpt','alpha',?,0,0,0,?)");
    put.run(ts,150000,"valid"); put.run(ts,150000,"valid"); put.run(ts,250000,"valid"); put.run(ts,50,"incomplete");
    ctx.sqlite.query("INSERT INTO events(home,path,ts,model,project_id,in_tok,cached_in,cache_write,out_tok,usage_status) VALUES ('A','p',?,'gpt','alpha',150000,100000,0,0,'valid'),('A','p',?,'gpt','alpha',50,100,0,0,'valid')").run(ts,ts);
    ctx.rateCards.codex_accounting={version:1,rules:[{id:"threshold",model:"gpt",speed:"standard",billing_basis:"api_equivalent_usd",
      valid_from:"2026-01-01",verified_at:"2026-01-01",confidence:"user",sources:["https://example.com"],multiplier:1,
      rates:{in_uncached:2,in_cache_read:1,out_total:4},long_context:{above_input_tokens:200000,rates:{in_uncached:6,in_cache_read:3,out_total:8}}}]};
    const body=(await preparedCapture(ctx)).body as any;
    expect(body.totals.calls).toBe(6);
    expect(body.totals.usd).toBe(2.3); // 0.3 + 0.3 + 1.5 + (50k*2 + 100k*1)/1M.
    expect(body.unpriced.tokens).toBe(50); // Count the incomplete known vector once; the invalid vector establishes no valid token total.
    expect(ctx.sqlite.query("SELECT COUNT(*) n FROM codex_price_ledger_events WHERE common_reason IS NOT NULL").get()).toEqual({n:2});
  } finally {ctx.sqlite.close();}
});
