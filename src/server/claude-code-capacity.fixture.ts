import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { loadAccountResolver } from "./account-resolver";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { createTestDatabase } from "../sync/test-support";
import { installAnalysisTracking } from "../db/analysis";
import { claudeProbeAdapter, CLAUDE_CODE_SHARE_EXTRA } from "../providers/adapters/claude";
import type { RateCard } from "../server/pricing";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { usageLedgerEvents } from "../db/usage-ledger-events";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import {advanceSubscriptionRates} from './subscription-rate';
import {advanceProjectPlanFacts} from './project-plan-producer';
import {advanceWindowPointValues} from './window-point-values';
import type {PlansCatalog} from './plans-catalog';

export const TIMES = {
  start: "2026-09-13T00:00:00.000Z", first: "2026-09-15T00:00:00.000Z",
  asOf: "2026-09-17T00:00:00.000Z", reset: "2026-09-20T00:00:00.000Z",
  beforeStart: "2026-09-12T23:59:59.999Z", afterAsOf: "2026-09-17T00:00:00.001Z",
} as const;
export const ACCOUNTS = { a: "account-a", b: "account-b" } as const;
export const PROJECT = "project-subset";
export const RATES: RateCard = { version: 1, currency: "USD", unit: "per 1M", vendors: {
  anthropic: { source: "independent-synthetic-fixture", models: {
    "claude-sonnet-fixture": { in_uncached: 3, in_cache_read: 0.3,
      in_cache_write_5m: 3.75, in_cache_write_1h: 6, out_total: 15 },
  } },
} };
// Every event has 80% fresh input and 20% output: cost = tokens * 5.4 / 1M.
// Cumulative intervals include both endpoints; paired interval is (first, asOf].
export const EXPECTED = {
  aCli: { tokens: 120_000, input: 96_000, output: 24_000, usd: 0.648 },
  aFirstCli: { tokens: 50_000, usd: 0.27 }, aPairCli: { tokens: 70_000, usd: 0.378 },
  aProjectCli: { tokens: 40_000, usd: 0.216 },
  aOtherProducts: { sdk: 11_000, desktop: 13_000, unknown: 17_000 },
  aAllProducts: { tokens: 161_000, usd: 0.8694 }, bCli: { tokens: 900_000, usd: 4.86 },
  duplicateTokensExcluded: 30_000, outsideCumulative: { before: 7_000, after: 9_000, atReset: 6_000 },
  observation: { firstShare: 12, firstUtilization: 10, share: 12, utilization: 24 },
} as const;

export function createClaudeCodeAcceptanceFixture(options: { referenceDay?: string } = {}) {
  const { directory, dbPath } = createTestDatabase();
  let db = new Database(dbPath);
  const probeSources = Object.values(ACCOUNTS).map(id => ({ id, vendor: "claude", machine: "synthetic", login: "fixture",
    home: `${ARCHIVE_LOGICAL_ROOT}/claude/${id}`, source_home: `C:/Users/fixture/.claude-${id}` }));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  const insert = db.query(`INSERT INTO claude_events
    (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,project_id,in_uncached,out_total)
    VALUES (?,?,?, ?,?,'claude-sonnet-fixture','standard',?,?,?,?,?,?)`);
  function event(id: string, ts: string, tokens: number, product: "cli"|"sdk"|"desktop"|"unknown" = "cli",
    account: string = ACCOUNTS.a, project: string|null = null, store = "fixture-primary") {
    const entrypoint = { cli: "cli", sdk: "sdk-ts", desktop: "desktop", unknown: null }[product];
    insert.run(store,id,`session-${id}`,`${ARCHIVE_LOGICAL_ROOT}/claude/${account}/${id}.jsonl`,ts,account,
      entrypoint,product === "unknown" ? null : "2.1.0",project,tokens * 0.8,tokens * 0.2);
  }
  event("at-start",TIMES.start,10_000,"cli",ACCOUNTS.a,PROJECT);
  event("before-first","2026-09-14T12:00:00.000Z",30_000);
  event("at-first",TIMES.first,10_000);
  event("between","2026-09-16T12:00:00.000Z",30_000,"cli",ACCOUNTS.a,PROJECT);
  event("at-asof",TIMES.asOf,40_000);
  event("before-first","2026-09-14T12:00:00.000Z",30_000,"cli",ACCOUNTS.a,null,"fixture-copy");
  event("sdk","2026-09-16T13:00:00.000Z",11_000,"sdk");
  event("desktop","2026-09-16T14:00:00.000Z",13_000,"desktop");
  event("unknown","2026-09-16T15:00:00.000Z",17_000,"unknown");
  event("before-start",TIMES.beforeStart,7_000);
  event("after-asof",TIMES.afterAsOf,9_000);
  event("at-reset",TIMES.reset,6_000);
  event("foreign-account","2026-09-16T12:00:00.000Z",900_000,"cli",ACCOUNTS.b,PROJECT);
  insert.finalize();
  function observation(account: string, asOf: string, used: number, share: number) {
    const parsed = claudeProbeAdapter.parse({ plan: "max", usage: {
      seven_day: { utilization: used, resets_at: TIMES.reset },
      seven_day_breakdown: { as_of: asOf, window_started_at: TIMES.start,
        rows: [{ key: "claude_code", display_name: "Claude Code", percent: share }] },
    } });
    // Seed only the synthetic projection. No global journal configuration or external sink.
    const reading = parsed.readings[0]!;
    db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,
      reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine)
      VALUES('claude',?,?,'max','weekly_all','weekly',NULL,'used',?,?,?,10080,1,?,'synthetic')`)
      .run(account,new Date(Date.parse(asOf)+1000).toISOString(),used,used,TIMES.reset,JSON.stringify(reading.extra));
  }
  observation(ACCOUNTS.a,TIMES.first,10,12);
  observation(ACCOUNTS.a,TIMES.asOf,24,12);
  observation(ACCOUNTS.b,TIMES.asOf,80,90);
  for (const account of Object.values(ACCOUNTS)) db.query(`INSERT INTO account_periods
    (provider,source,from_ts,until_ts,account,origin,first_seen,last_seen,readings,evidence)
    VALUES ('claude',?,'2020-01-01',NULL,?,'declared',NULL,NULL,0,'fixture')`).run(`claude/${account}`,account);
  let preparationRates = RATES;
  let manualCapacity: readonly ManualCapacityMeasurement[] = [];
  /** The maintenance worker publishes window sums after the ledger and the limit windows. */
  function publishSums(measurements: readonly ManualCapacityMeasurement[] = manualCapacity, referenceDay?: string) {
    manualCapacity = measurements;
    prepareWindowUsageFixture(db, { rateCards: preparationRates, referenceDay: referenceDay ?? options.referenceDay, claudeGauge: {}, cycles: { windows: [] },
      manualCapacity: provider => provider === "claude" ? manualCapacity : [] });
  }
  function prepareFacts(rates: RateCard = preparationRates, referenceDay?: string) {
    preparationRates = rates;
    const periods = loadPeriods(db, ACCOUNT_PERIODS).filter(period => period.origin === "declared");
    for (const {account} of db.query("SELECT DISTINCT subscription_id account FROM claude_events WHERE subscription_id IS NOT NULL").all() as {account:string}[]) {
      const source = `claude/${account.toLowerCase()}`;
      if (!periods.some(period => period.provider === "claude" && period.subject === source))
        periods.push({ provider: "claude", subject: source, value: account, from: "2020-01-01", until: null,
          origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
    }
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, periods);
    db.query(`UPDATE claude_events SET path=? || '/claude/' || lower(subscription_id) || '/' || call_id || '.jsonl'
      WHERE subscription_id IS NOT NULL AND COALESCE(subscription_conflict,0)=0
      AND (path IS NULL OR path NOT LIKE ?)`)
      .run(ARCHIVE_LOGICAL_ROOT,`${ARCHIVE_LOGICAL_ROOT}/%`);
    // Small batches, so the producer's chunked phases run as they do on a real history.
    fillUsageLedgerFixture(db, rates, undefined, 3);
    prepareProbeReaderFixture(db, probeSources);
    publishSums(manualCapacity, referenceDay);
  }
  prepareFacts();
  function prepareSharedCapacities(rates:RateCard=preparationRates){
    const catalog:PlansCatalog={provider_groups:[{id:'claude',label:'Claude',aliases:['claude'],plans:[{plan_id:'claude-max',label:'Max',aliases:['max'],versions:[{from:null,usd_per_month:100}]}]}]};
    const config={sources:probeSources,subscriptions:Object.values(ACCOUNTS).map(id=>({id,vendor:'claude'}))},now=Date.parse('2026-09-21');
    for(let i=0;i<20&&advanceWindowPointValues(db,{catalog,plans:{},now,budgetMs:10000})?.pending;i++);
    for(let i=0;i<20&&advanceSubscriptionRates(db,{rates,catalog,config,now,limit:10})?.pending;i++);
    for(let i=0;i<20&&advanceProjectPlanFacts(db,{rates,catalog,config,now,limit:10})?.pending;i++);
  }
  return {
    directory, dbPath, get db() { return db; }, rates: RATES, prepareFacts,prepareSharedCapacities,
    prepareProbes() { prepareProbeReaderFixture(db, probeSources); publishSums(); },
    publishSums,
    reopen() { db.close(true); db = new Database(dbPath); return db; },
    changeShare(share: number) {
      if (!Number.isFinite(share) || share < 0 || share > 100) throw new Error("Invalid synthetic share");
      db.query("UPDATE probe_windows SET extra=json_set(extra,?,?) WHERE subject=? AND json_extract(extra,?)=?")
        .run(`$."${CLAUDE_CODE_SHARE_EXTRA.percent}"`,share,ACCOUNTS.a,
          `$."${CLAUDE_CODE_SHARE_EXTRA.asOf}"`,TIMES.asOf);
      prepareProbeReaderFixture(db, probeSources);
      publishSums();
    },
    teardown() {
      db.close(true);
      fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    },
  };
}

/** Runs `compute` and records the statements it sent to the call or ledger fact tables. */
export function measureAnalysis<T>(db: Database, compute: () => T) {
  const sql: string[] = [];
  const query = db.query, prepare = db.prepare;
  const record = (value: string) => { if (/\b(?:FROM|JOIN)\s+["`\[]?(?:claude_events|usage_ledger_facts)\b/i.test(value)) sql.push(value); };
  db.query = function(this: Database, statement: string, ...rest: unknown[]) { record(statement); return query.call(this,statement,...rest as []); } as typeof db.query;
  db.prepare = function(this: Database, statement: string, ...rest: unknown[]) { record(statement); return prepare.call(this,statement,...rest as []); } as typeof db.prepare;
  try {
    return { value: compute(), rawOrFactQueries: sql };
  } finally { db.query = query; db.prepare = prepare; }
}

export function verifyFixture() {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const sum = (where: string, ...args: string[]) => (f.db.query(`SELECT sum(in_uncached+out_total) AS n FROM (
      SELECT call_id,ts,in_uncached,out_total FROM claude_events WHERE subscription_id=? AND ${where}
      GROUP BY call_id,ts,in_uncached,out_total)`).get(ACCOUNTS.a,...args) as {n:number}).n;
    const cli = "entrypoint='cli' AND cc_version IS NOT NULL";
    assert.equal(sum(`${cli} AND ts>=? AND ts<=?`,TIMES.start,TIMES.asOf),EXPECTED.aCli.tokens);
    assert.equal(sum(`${cli} AND ts>=? AND ts<=?`,TIMES.start,TIMES.first),EXPECTED.aFirstCli.tokens);
    assert.equal(sum(`${cli} AND ts>? AND ts<=?`,TIMES.first,TIMES.asOf),EXPECTED.aPairCli.tokens);
    assert.equal(sum(`${cli} AND ts>=? AND ts<=? AND project_id=?`,TIMES.start,TIMES.asOf,PROJECT),EXPECTED.aProjectCli.tokens);
    const reader = usageLedgerEvents(f.db,"claude",RATES,loadAccountResolver(f.db).plan("claude",ACCOUNTS.a));
    const events = reader.load(TIMES.start,TIMES.afterAsOf,TIMES.start,TIMES.afterAsOf);
    assert.equal(events.reduce((n,e)=>n+e.quantities.in_uncached+e.quantities.out_total,0),EXPECTED.aAllProducts.tokens);
    assert.equal(reader.stats(TIMES.start,TIMES.afterAsOf).duplicates,1);
    const positive = measureAnalysis(f.db,()=>f.db.query("SELECT COUNT(*) AS n FROM claude_events").get());
    assert.ok(positive.rawOrFactQueries.length > 0);
    f.changeShare(15);
    f.reopen();
    assert.equal((f.db.query("SELECT json_extract(extra,?) AS p FROM probe_windows WHERE subject=? ORDER BY ts DESC LIMIT 1")
      .get(`$."${CLAUDE_CODE_SHARE_EXTRA.percent}"`,ACCOUNTS.a) as {p:number}).p,15);
    return EXPECTED;
  } finally { f.teardown(); }
}
if (import.meta.main) console.log(JSON.stringify({verified:verifyFixture()},null,2));

