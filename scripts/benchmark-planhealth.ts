import { readSparkClassifier } from "../src/server/plan-health-read";
import { Database } from "../src/db/sqlite";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handlePlanHealth, type AppContext } from "../src/server/api";
import { referencePlanHealth } from "./lib/planhealth-reference";
import { fixtureCodexRateCard, prepareCodexLedgerFixture } from "../src/server/codex-ledger.fixture";
import { CODEX_SOURCE_LOCATOR_INDEX_SQL } from "../src/db/codex-source-evidence";

export function fixture(clusters = 24, unrelated = 0, filename = ":memory:"): AppContext {
  const sqlite = new Database(filename);
  sqlite.exec(`CREATE TABLE events (home TEXT, path TEXT, ts TEXT, model TEXT, in_tok INTEGER, cached_in INTEGER, out_tok INTEGER, cache_write INTEGER DEFAULT 0);
    CREATE INDEX events_ts ON events(home, ts);
    CREATE INDEX events_path ON events(home, path);
    CREATE TABLE ratelimit (home TEXT, path TEXT, ts TEXT, window_minutes INTEGER, limit_id TEXT, resets_at INTEGER, used_percent REAL);`);
  const event = sqlite.query("INSERT INTO events(home,path,ts,model,in_tok,cached_in,out_tok) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const rl = sqlite.query("INSERT INTO ratelimit VALUES (?, ?, ?, ?, ?, ?, ?)");
  sqlite.transaction(() => {
    for (let c = 0; c < clusters; c++) {
      const date = new Date(Date.UTC(2026, 0, 1 + c * 3));
      for (let i = 0; i < 6; i++) {
        const ts = new Date(date.getTime() + i * 3600000).toISOString();
        rl.run(c % 2 ? "A" : "a/", `p${c % 12}`, ts, 10080, "codex", 1000000 + c * 1000 + (i === 5 ? 120 : 0), i * 20);
        event.run("A", `p${c % 12}`, ts, i % 3 === 0 ? "gpt-default" : c % 4 === 0 ? "GPT-SPARK" : "gpt", 1000000 + c * 1000, 200000, 100000);
      }
    }
    // Same path in another home must contribute to classification, not priced account usage.
    for (let i = 0; i < 8; i++) event.run("B", "p1", "1999-01-01", "spark", 999999999, 0, 0);
    for (let i = 0; i < unrelated; i++) event.run("B", `unrelated-${i % 10000}`, "1999-01-01", i % 2 ? null : "spark", 1, 0, 0);
    for (const ts of ["2026-07-12", "2026-07-13", "2026-08-01"]) for (const limit of ["codex", "codex_bengalfox"]) rl.run("A", "p0", ts, 300, limit, 0, 10);
    for (let i = 0; i < 5; i++) rl.run("B", "other", `2026-08-0${i + 1}`, 10080, "codex", 5, i * 20);
  })();
  const ctx = { sqlite, subIdToHomes: new Map([["codex1", ["a"]], ["a", ["a"]], ["b", ["B"]], ["empty", ["empty"]]]),
    rateCards: { version: 1, currency: "USD", unit: "million", vendors: { openai: { models: {
      gpt: { in_uncached: 2, in_cache_read: 0.5, out_total: 8 }, "gpt-default": { in_uncached: 1, in_cache_read: 0.2, out_total: 4 },
    } } } } } as unknown as AppContext;
  ctx.rateCards=fixtureCodexRateCard(ctx.rateCards);
  prepareCodexLedgerFixture(sqlite,ctx.rateCards);
  sqlite.exec(CODEX_SOURCE_LOCATOR_INDEX_SQL);
  return ctx;
}

export function instrument(sqlite: Database, failAt = 0) {
  const samples: Array<{ sql: string; ms: number; parameters: number; plan: string[] }> = [];
  const query = sqlite.query.bind(sqlite);
  const measuredQuery = ((sql: string) => {
    const statement = query(sql);
    if (!/FROM events WHERE path IN/i.test(sql)) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "get" && key !== "all") return typeof value === "function" ? value.bind(target) : value;
      return (...args: any[]) => {
        const plan = (query("EXPLAIN QUERY PLAN " + sql).all(...args) as Array<{ detail: string }>).map(r => r.detail);
        const start = performance.now();
        try {
          if (failAt && samples.length + 1 === failAt) throw new Error("injected classification read failure");
          return value.apply(target, args);
        } finally { samples.push({ sql, ms: performance.now() - start, parameters: args.length, plan }); }
      };
    } });
  }) as Database["query"];
  const wrapped=new Proxy(sqlite,{get(target,key){
    if(key==="query")return measuredQuery;
    const value=Reflect.get(target,key,target);
    return typeof value==="function"?value.bind(target):value;
  }});
  return { sqlite: wrapped, samples };
}

export function assertBounded(samples: ReturnType<typeof instrument>["samples"]) {
  assert.ok(samples.length <= 1, `classification read executions ${samples.length} exceeded 1`);
  assert.ok(samples.flatMap(s => s.plan).filter(p => /SCAN events\b/i.test(p)).length <= 1, "repeated broad events scans");
  assert.ok(samples.every(s => s.parameters <= 1), "excessive bind parameters");
}

export async function capture(ctx: AppContext, account: string, old = false) {
  const response = (old ? referencePlanHealth : handlePlanHealth)(ctx, new URL(`http://localhost/api/planhealth?account=${account}`));
  return { status: response.status, headers: [...response.headers], body: await response.json() };
}

if (import.meta.main) {
  const ctx = fixture(120, 200000);
  try {
    const samples: Array<{ pair: number; implementation: string; route_ms: number; classifier_ms: number; classifier_sql_ms: number; classification_reads: number; broad_scans: number }> = [];
    const memberships = Array.from({ length: 120 }, (_, c) => new Set([`p${c % 12}`]));
    for (let pair = 0; pair < 8; pair++) {
      const captures = new Map();
      for (const old of pair % 2 ? [false, true] : [true, false]) {
        const measured = instrument(ctx.sqlite);
        const start = performance.now();
        const answer = await capture({ ...ctx, sqlite: measured.sqlite }, "a", old);
        const routeMs = performance.now() - start;
        captures.set(old, answer);
        const classifierStart = performance.now();
        const decisions = old ? memberships.map(paths => {
          const row = ctx.sqlite.query(`SELECT count(*) AS tot, sum(CASE WHEN model LIKE '%spark%' THEN 1 ELSE 0 END) AS sp FROM events WHERE path IN (${[...paths].map(() => "?").join(",")})`).get(...paths) as {tot: number; sp: number | null};
          return row.tot > 0 && (row.sp ?? 0) / row.tot > 0.5;
        }) : (() => { const classify = readSparkClassifier(ctx.sqlite, memberships); return memberships.map(classify); })();
        const classifierMs = performance.now() - classifierStart;
        captures.set(`classifier-${old}`, decisions);
        if (!old) assertBounded(measured.samples);
        samples.push({ pair, implementation: old ? "old" : "candidate", route_ms: routeMs,
          classifier_ms: classifierMs, classifier_sql_ms: measured.samples.reduce((sum, s) => sum + s.ms, 0), classification_reads: measured.samples.length,
          broad_scans: measured.samples.flatMap(s => s.plan).filter(p => /SCAN events\b/i.test(p)).length });
      }
      assert.deepEqual(captures.get(false), captures.get(true));
      assert.deepEqual(captures.get("classifier-false"), captures.get("classifier-true"));
    }
    const median = (xs: number[]) => xs.sort((a,b) => a-b)[Math.floor(xs.length/2)];
    const report = { status: "PASS", fixture: { clusters: 120, unrelated_events: 200000 }, full_response_parity: true,
      clock: "fixed stored timestamps; handler has no wall-clock inputs", private_copy: "NOT-RUN", http_cache: false,
      timing_scope: "route includes body parsing and instrumented EXPLAIN; classifier is separately executed full path setup, SQL, evidence materialization and membership summation; classifier_sql is in-route query time",
      samples, medians: Object.fromEntries(["old", "candidate"].map(implementation => [implementation, {
        route_ms: median(samples.filter(s => s.implementation === implementation).map(s => s.route_ms)),
        classifier_ms: median(samples.filter(s => s.implementation === implementation).map(s => s.classifier_ms)),
      }])) };
    const out = process.argv.indexOf("--out");
    if (out >= 0) fs.writeFileSync(process.argv[out + 1]!, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { ctx.sqlite.close(); }
}
