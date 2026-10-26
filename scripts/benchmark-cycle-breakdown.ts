import { Database } from "../src/db/sqlite";
import { handleCycleBreakdown, periodEras, type AppContext } from "../src/server/api";
import { referenceCycleBreakdown } from "./lib/cycle-breakdown-reference";
import { assertCycleBreakdownParity } from "./lib/cycle-breakdown-parity";
import { ARCHIVE_LOGICAL_ROOT, configFile, expandPath } from "../src/config/paths";
import { declareCodexEraPeriods } from "../src/server/codex-periods.fixture";
import { fixtureCodexRateCard, prepareCodexLedgerFixture } from "../src/server/codex-ledger.fixture";
import { prepareProbeReaderFixture } from "../src/server/probe-reader.fixture";
import { CODEX_SOURCE_LOCATOR_INDEX_SQL } from "../src/db/codex-source-evidence";
import { readAccountsV2 } from "../src/config/accounts-document";
import { buildEraIndex } from "../src/server/eras";
import { loadAccountResolver } from "../src/server/account-resolver";
import { codexAccountSelector } from "../src/server/codex-source-account";
import { codexEventOwnedBy } from "../src/server/codex-event-owner";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


export const NOW = Date.parse("2026-04-02T12:17:23.456Z");
export const SINCE = "2026-03-26T12:17:23.456Z";
export const UNTIL = "2026-04-02T12:17:23.456Z";
/** Home `A` is a local profile copying the archive folder whose account period names `a`. */
export const SOURCE_A = { id: "a", vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/A`, source_home: "A" };
export function fixture(unrelated = 0, filename = ":memory:"): AppContext {
  const sqlite = new Database(filename);
  sqlite.exec(`CREATE TABLE events(home TEXT, path TEXT, ts TEXT, model TEXT, project_id TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER);
    CREATE INDEX events_ts ON events(home, ts);
    CREATE INDEX events_path ON events(home, path);
    CREATE TABLE ratelimit(home TEXT, path TEXT, ts TEXT, window_minutes INTEGER, limit_id TEXT, used_percent REAL, resets_at INTEGER);
    CREATE INDEX ratelimit_ts ON ratelimit(home,ts);`);
  const put = sqlite.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)");
  sqlite.transaction(() => {
    for (let i = 0; i < 10000; i++) {
      const ts = new Date(NOW - (i % 169) * 3600000).toISOString();
      put.run("A", "p", ts, i % 3 ? "gpt" : null, i % 2 ? "alpha" : null, i % 5 ? 1000 : null, 100, null, 200);
    }
    for (let i = 0; i < unrelated; i++) put.run(i % 2 ? "A" : "B", "unrelated", "1999-01-01", "gpt", null, 1, 0, 0, 1);
    for (let i = 0; i < 30; i++) {
      sqlite.query("INSERT INTO ratelimit VALUES ('A','p',?,? ,?, ?, ?)").run(new Date(NOW - i * 3600000).toISOString(), i % 2 ? 300 : 10080, i % 3 ? "codex" : "spark", 50 - i, Math.floor(NOW / 1000) + (i % 3) * 120);
    }
  })();
  declareCodexEraPeriods(sqlite, [SOURCE_A]);
  return { sqlite, accounts: { version: 2, subscriptions: [{id:SOURCE_A.id,vendor:SOURCE_A.vendor}], sources: [{vendor:SOURCE_A.vendor,home:SOURCE_A.home,source_home:SOURCE_A.source_home}] }, subIdToHomes: new Map([["a", ["a"]], ["empty", ["empty"]]]), rateCards: { version: 1, currency: "USD", unit: "million", vendors: { openai: { models: { gpt: {in_uncached: 2, in_cache_read: 0.5, in_cache_write: 0, out_total: 8} } } } } } as unknown as AppContext;
}

export function instrument(sqlite: Database) {
  const samples: Array<{ family: string; ms: number; plan: string[] }> = [];
  const query = sqlite.query.bind(sqlite);
  const measuredQuery = ((sql: string) => {
    const statement = query(sql);
    const family = /WITH cycle_events/.test(sql) ? "events-shared" : /GROUP BY d, model/.test(sql) ? "events-day" : /GROUP BY blk, model/.test(sql) ? "events-session" : /FROM events/.test(sql) && /COUNT\(\*\)/i.test(sql) ? "burn" : /FROM ratelimit/.test(sql) ? "gauge" : "other";
    return new Proxy(statement, {get(target,key) {
      const value = Reflect.get(target,key,target);
      if (key !== "all" && key !== "get") return typeof value === "function" ? value.bind(target) : value;
      return (...args: any[]) => {
        const plan = (query("EXPLAIN QUERY PLAN " + sql).all(...args) as Array<{detail:string}>).map(r => r.detail);
        const start = performance.now();
        try { return value.apply(target,args); }
        finally {samples.push({family, ms: performance.now() - start, plan});}
      };
    }});
  }) as Database["query"];
  const wrapped=new Proxy(sqlite,{get(target,key){
    if(key==="query")return measuredQuery;
    const value=Reflect.get(target,key,target);
    return typeof value==="function"?value.bind(target):value;
  }});
  return {sqlite: wrapped, samples};
}

export async function capture(ctx: AppContext, suffix = "", handler = handleCycleBreakdown, now = NOW) {
  const before = Date.now;
  let response: Response;
  const url = new URL(`http://localhost/api/cycle-breakdown?account=a&since_ts=${SINCE}&until_ts=${UNTIL}`);
  for (const [key,value] of new URLSearchParams(suffix.replace(/^&/,""))) url.searchParams.set(key,value);
  try { Date.now = () => now; response = handler(ctx, url); }
  finally { Date.now = before; }
  return {status: response.status, body: await response.json()};
}

if (import.meta.main) {
  const dbArg=process.argv.indexOf("--db");
  const out=process.argv.indexOf("--out");
  if (!process.argv.includes("--worker")) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ta-cycle-ab-"));
    try {
      const processes=[];
      for(let i=0;i<5;i++) {
        const output=path.join(dir,`${i}.json`);
        // Bind synthetic settings before imports; explicit copied-database diagnostics keep their settings.
        const isolated = dbArg < 0 ? ["--preload", path.join(import.meta.dir, "test-environment.ts")] : [];
        const result=Bun.spawnSync([process.execPath,...isolated,import.meta.filename,"--worker","--out",output,...(i%2?["--candidate-first"]:[]),...(dbArg>=0?["--db",process.argv[dbArg+1]!]:[])],{env:{...process.env},stdout:"pipe",stderr:"pipe"});
        assert.equal(result.exitCode,0,result.stderr.toString());
        processes.push(JSON.parse(fs.readFileSync(output,"utf8")));
      }
      const unavailable=processes.some(p=>p.status==="NOT-RUN");
      const report={status:unavailable?"NOT-RUN":"PASS",independent_processes:5,warm_pairs_per_process:unavailable?0:20,order:"interleaved, reversed each pair",quantile:"nearest-rank p50",private_copy:dbArg>=0?"read-only same supplied database":"NOT-RUN",processes};
      if(out>=0)fs.writeFileSync(process.argv[out+1]!,JSON.stringify(report,null,2));
      console.log(JSON.stringify({status:report.status,independent_processes:5,medians:processes.map(p=>p.medians)}));
    } finally {fs.rmSync(dir,{recursive:true});}
    process.exit(0);
  }
  let ctx = fixture(dbArg>=0?0:200000);
  let now=NOW, suffix="";
  if(dbArg>=0) {
    ctx.sqlite.close();
    ctx.sqlite=new Database(process.argv[dbArg+1]!,{readonly:true});
    const accounts = readAccountsV2(configFile("accounts.json"));
    const expanded = { ...accounts, sources: accounts.sources.map(source => ({ ...source,
      home: expandPath(source.home),
      ...(source.source_home ? { source_home: expandPath(source.source_home) } : {}),
    })) };
    ctx = { ...ctx, accounts: expanded, resolver: loadAccountResolver(ctx.sqlite, expanded.subscriptions),
      eras: buildEraIndex(periodEras(ctx.sqlite, expanded), "instant") };
    // The account whose period owns the latest event: its last seven days are a populated owned cycle.
    const latest=ctx.sqlite.query("SELECT home, MAX(ts) AS ts FROM events").get() as {home:string|null;ts:string|null}|null;
    const selector=codexAccountSelector(ctx,"events");
    const account=latest?.ts ? selector.accountAt(latest.home,latest.ts) : null;
    if(!account) {
      const report={status:"NOT-RUN",reason:"no account period owns the latest event; no populated owned cycle available"};
      ctx.sqlite.close();
      if(out>=0)fs.writeFileSync(process.argv[out+1]!,JSON.stringify(report));
      console.log(JSON.stringify(report));process.exit(0);
    }
    now=Date.parse(latest!.ts!);assert.ok(Number.isFinite(now));
    const since=new Date(now-7*86400000).toISOString(),until=new Date(now).toISOString();
    const owned=codexEventOwnedBy(ctx.sqlite,selector,account,{within:{from:since,until:new Date(now+1).toISOString()}});
    const homes=(ctx.sqlite.query(`SELECT DISTINCT home FROM events WHERE ts >= ? AND ts <= ? AND ${owned.sql}`)
      .all(since,until,...owned.params) as Array<{home:string}>).map(r=>r.home);
    assert.ok(homes.length>0);
    ctx.subIdToHomes=new Map([[account,homes]]);
    suffix="&"+new URLSearchParams({account,since_ts:since,until_ts:until});
  }
  if (dbArg<0) {
    // The parity cohort declares complete vectors; missing data has separate acceptance tests.
    ctx.sqlite.exec("UPDATE events SET cached_in=0 WHERE in_tok IS NULL; UPDATE events SET in_tok=0 WHERE in_tok IS NULL; UPDATE events SET cache_write=0 WHERE cache_write IS NULL");
    ctx.rateCards=fixtureCodexRateCard({...ctx.rateCards,unit:"per 1M"});
    prepareCodexLedgerFixture(ctx.sqlite,ctx.rateCards,new Map([["a","a"]]),[SOURCE_A]);
    ctx.sqlite.exec(CODEX_SOURCE_LOCATOR_INDEX_SQL);
    prepareProbeReaderFixture(ctx.sqlite,[SOURCE_A]);
  }
  try {
    const samples: Array<{pair:number;implementation:string;route_ms:number;sql:ReturnType<typeof instrument>["samples"]}> = [];
    for (let pair = 0; pair <= 20; pair++) {
      const captures = new Map();
      for (const old of (pair + Number(process.argv.includes("--candidate-first"))) % 2 ? [false,true] : [true,false]) {
        const measured = instrument(ctx.sqlite);
        const start = performance.now();
        captures.set(old, await capture({...ctx, sqlite: measured.sqlite}, suffix, old ? referenceCycleBreakdown : handleCycleBreakdown,now));
        samples.push({pair, implementation: old ? "reference" : "candidate", route_ms: performance.now()-start, sql: measured.samples});
      }
      assertCycleBreakdownParity(ctx,{since:SINCE,until:UNTIL},suffix,captures.get(false),captures.get(true));
      if(dbArg>=0) assert.ok((captures.get(false).body as {totals:{calls:number}}).totals.calls>0,"private reference lacks populated owned events in the selected window");
    }
    const median = (xs: number[]) => xs.sort((a,b)=>a-b)[Math.ceil(xs.length/2)-1];
    const report = {status: "PASS", full_response_parity: true, fixed_clock: dbArg>=0?"latest stored event, fixed for both handlers":new Date(NOW).toISOString(), fixture: dbArg>=0?{kind:"private read-only reference",pricing:"same synthetic rate card for both, missing models remain unpriced"}:{selected_events:10000, unrelated_events:200000},
      timing_scope: "uncached handler and JSON parse; SQL separately timed; EXPLAIN overhead included only in handler; no HTTP/render claim", samples,
      medians: Object.fromEntries(["reference","candidate"].map(implementation => [implementation, {
        route_ms: median(samples.filter(s=>s.implementation===implementation && s.pair>0).map(s=>s.route_ms)),
        event_sql_ms: median(samples.filter(s=>s.implementation===implementation && s.pair>0).map(s=>s.sql.filter(q=>q.family.startsWith("events-")).reduce((a,q)=>a+q.ms,0))),
      }]))};
    if (out >= 0) fs.writeFileSync(process.argv[out+1]!,JSON.stringify(report,null,2));
    console.log(JSON.stringify(report.medians));
  } finally {ctx.sqlite.close();}
}
