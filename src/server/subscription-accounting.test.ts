import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import { currentRegistry } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { buildAccountResolver, loadAccountResolver } from "./account-resolver";
import { encodeClaudeCodeProductShare, sameResetWindow } from "../providers/adapters/claude";
import { readPreparedProbeAccountRange, readPreparedProbeAccountHistory, ProbeAccountReadLimitExceeded } from "./current/probe-account-reader";
import { subscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import { planPeriodIndex, type DatedPeriod } from "./account-periods";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { Database } from "../db/sqlite";
import { buildSubscriptionAccountingReport as readSubscriptionAccountingReport } from "./subscription-accounting";
import { buildEraIndex } from "./eras";
import type { SubscriptionAccountingOptions } from "../shared/subscription-accounting";
import type { RateCard } from "./pricing";
import { createFetchHandler, handleWindows as apiHandleWindows, handleClaudeLimit, type AppContext } from "./api";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import { capacityPerPoint } from "../web/lib/codex-capacity";
import { buildProbeLimitWindows, claudeWeeklyRegisterWindows, loadProbeLimitEvidence, probeLimitCounter, probeWindowPlan } from "./probe-limit-windows";
import * as probeRegister from "./probe-limit-windows";
import * as probeReader from "./current/probe-account-reader";
import { mapClaudeCodeObservationsToWindows, readClaudeCodeObservations } from "./claude-code-capacity";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { subscriptionRulesDigest } from "../db/usage-price-totals";
import * as readiness from "../db/usage-price-read-subscription";
import type { UsageLedgerProvider } from "../db/usage-ledger";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { stepUsageLedger, usageLedgerState } from "./usage-ledger-producer";
import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { prepareLimitWindowsFixture } from "./limit-windows.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import type { AccountsV2 } from "../config/accounts-v2";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

function fixturePeriods(db: Database, provider: string, eras?: AccountingContext["eras"]): DatedPeriod[] {
  const adapter = subscriptionAccountingAdapter(provider);
  const periods = new Map<string,DatedPeriod>();
  const rows = db.query(`SELECT * FROM ${adapter.table}`).all() as Array<Record<string,any>>;
  for (const row of rows) {
    const account = provider === "claude" ? row.subscription_conflict ? null : row.subscription_id
      : eras ? adapter.aliases.map(alias=>eras.resolve(alias,row.store,row.ts)).find(Boolean) : row.store;
    const folder = provider === "glm" ? String(row.store) : `${row.store}-${account ?? "unassigned"}`;
    const source = `${provider}/${folder.toLowerCase()}`;
    if (provider !== "glm" && !row.path?.startsWith(ARCHIVE_LOGICAL_ROOT))
      db.query(`UPDATE ${adapter.table} SET path=? WHERE id=?`).run(`${ARCHIVE_LOGICAL_ROOT}/${source}/${row.id}.jsonl`,row.id);
    if (account) periods.set(source,{provider,subject:source,from:"2000-01-01",until:null,value:String(account),origin:"declared",firstSeen:null,lastSeen:null,readings:0,evidence:"fixture"});
  }
  for (const probe of db.query("SELECT DISTINCT provider,subject FROM probe_windows WHERE provider=?").all(provider) as Array<{ provider: string; subject: string }>) {
    const source = `${provider}/fixture-${probe.subject}`.toLowerCase();
    periods.set(source, { provider, subject: source, from: "2000-01-01", until: null,
      value: probe.subject.toLowerCase(), origin: "declared", firstSeen: null, lastSeen: null,
      readings: 0, evidence: "physical fixture" });
  }
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS account_periods(id INTEGER PRIMARY KEY,provider TEXT,source TEXT,from_ts TEXT,until_ts TEXT,account TEXT,
      origin TEXT,first_seen TEXT,last_seen TEXT,readings INTEGER,evidence TEXT)`);
  const declared = [...loadPeriods(db,ACCOUNT_PERIODS).filter(p=>p.provider!==provider),...periods.values()];
  replaceDeclaredPeriods(db,ACCOUNT_PERIODS,declared);
  return declared;
}
function prepareProbeProjection(db: Database, provider: string) {
  const probeRows = db.query("SELECT DISTINCT provider,subject FROM probe_windows WHERE provider=?")
    .all(provider) as Array<{ provider: string; subject: string }>;
  const definitions = probeRows.map(row => ({ id: row.subject.toLowerCase(), vendor: provider,
      machine: `FIXTURE-${row.subject}`, home: `${ARCHIVE_LOGICAL_ROOT}/${provider}/fixture-${row.subject}`,
      source_home: `C:/Users/${LOGIN}/.${provider}-${row.subject}` }));
  const config = splitProbeReaderFixtureConfig(definitions);
  const at = "2026-08-20T00:00:00.000Z";
  for (let step = 0; publishCurrentBatch(db, currentRegistry(config.subscriptions, at), at, 512, config); step++) {
    if (step > 1000) throw new Error("probe fixture projection did not settle");
  }
  // The maintenance worker publishes limit windows after the projection.
  prepareLimitWindowsFixture(db);
}
function buildSubscriptionAccountingReport(ctx: AccountingContext, provider: string, opts: SubscriptionAccountingOptions) {
  const resolver = buildAccountResolver(fixturePeriods(ctx.sqlite,provider,ctx.eras));
  ctx.resolver=resolver;
  prepareProbeProjection(ctx.sqlite, provider);
  createAnalysisSourceRevisions(ctx.sqlite);
  if (!ctx.sqlite.query("SELECT 1 FROM sqlite_master WHERE name='usage_ledger_state'").get()) installAnalysisTracking(ctx.sqlite);
  // The background producer keeps the ledger caught up with source rows; a rate card it has not
  // walked yet stays pending, as tests of that state expect.
  const state = usageLedgerState(ctx.sqlite, provider);
  if (!state || state.rules_digest === subscriptionRulesDigest(ctx.rateCards, provider))
    fillUsageLedger(ctx.sqlite, provider as UsageLedgerProvider, ctx.rateCards, ARCHIVE_LOGICAL_ROOT, 100);
  // Plan periods given to the report are the stored ones in production (Settings writes them).
  if (ctx.planPeriods) {
    const declared = ctx.planPeriods.filter(period => period.origin === "declared");
    if (declared.length && !ctx.sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_periods'").get())
      ctx.sqlite.exec(fs.readFileSync(new URL("../../drizzle/0040_account_periods.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
    if (ctx.sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_periods'").get())
      replaceDeclaredPeriods(ctx.sqlite, PLAN_PERIODS, declared);
  }
  prepareLimitWindowsFixture(ctx.sqlite, { cycles: ctx.cycles ?? { windows: [] },
    manualCapacity: vendor => (ctx.manualCapacity ?? []).filter(m => vendor === provider && m.account) });
  // The maintenance worker publishes window sums after the windows and the ledger.
  prepareWindowUsageFixture(ctx.sqlite, { rateCards: ctx.rateCards, cycles: ctx.cycles ?? { windows: [] }, claudeGauge: {},
    manualCapacity: vendor => (ctx.manualCapacity ?? []).filter(m => vendor === provider && m.account) });
  return readSubscriptionAccountingReport({...ctx,resolver},provider,opts);
}
const MILLION = 1_000_000;
const dbs: Database[] = [];

const rates: RateCard = {
  version: 1,
  currency: "USD",
  unit: "per 1M",
  vendors: {
    anthropic: {
      source: "fixture",
      models: {
        "claude-3-sonnet": {
          in_uncached: 1,
          in_cache_read: 2,
          in_cache_write_5m: 3,
          in_cache_write_1h: 4,
          out_total: 5,
          until: "2026-08-11",
          after: { in_uncached: 10, in_cache_read: 20, in_cache_write_5m: 30, in_cache_write_1h: 40, out_total: 50 },
          fast: { in_uncached: 2, in_cache_read: 4, in_cache_write_5m: 6, in_cache_write_1h: 8, out_total: 10 },
        },
      },
    },
    google: { source: "fixture", models: { "gemini-2.5-pro": { in_uncached: 1, in_cache_read: 2, out_total: 3 } } },
    xai: { source: "fixture", models: { "grok-3": { in_uncached: 1, in_cache_read: 2, in_cache_write: 3, out_total: 4 } } },
    zai: { source: "fixture", models: { "glm-4": { in_uncached: 1, in_cache_read: 2, in_cache_write: 3, out_total: 4 } } },
  },
};

type AccountingContext = Omit<Parameters<typeof readSubscriptionAccountingReport>[0], "accounts"> & { accounts: AccountsV2 };

function fixture(path = ":memory:"): Database {
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE probe_windows (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      ts TEXT NOT NULL,
      plan TEXT,
      kind TEXT NOT NULL,
      limit_group TEXT,
      used_percent REAL,
      resets_at TEXT,
      window_minutes INTEGER,
      machine TEXT, profile TEXT, extra TEXT, scope TEXT, error TEXT,
      remaining_percent REAL, remaining REAL, used REAL, allowance REAL, rate_limit_reached INTEGER,
      ok INTEGER DEFAULT 1
    );
    CREATE TABLE claude_events (
      id INTEGER PRIMARY KEY,
      store TEXT NOT NULL,
      call_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      path TEXT,
      subscription_id TEXT,
      subscription_conflict INTEGER DEFAULT 0,
      model TEXT,
      speed TEXT,
      project_id TEXT,
      in_uncached INTEGER DEFAULT 0,
      in_cache_read INTEGER DEFAULT 0,
      in_cache_write INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0,
      cache_write_1h INTEGER DEFAULT 0,
      out_total INTEGER DEFAULT 0,
      out_thinking INTEGER DEFAULT 0
    );
    CREATE TABLE gemini_events (
      id INTEGER PRIMARY KEY,
      store TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      gen_idx INTEGER NOT NULL,
      ts TEXT NOT NULL,
      ts_basis TEXT,
      path TEXT,
      model TEXT,
      project_id TEXT,
      fresh_in INTEGER DEFAULT 0,
      cached_in INTEGER DEFAULT 0,
      out_total INTEGER DEFAULT 0,
      out_thinking INTEGER DEFAULT 0,
      out_visible INTEGER DEFAULT 0,
      usd REAL DEFAULT 0
    );
    CREATE TABLE grok_events (
      id INTEGER PRIMARY KEY,
      store TEXT NOT NULL,
      session_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      path TEXT,
      model TEXT,
      project_id TEXT,
      in_tok INTEGER DEFAULT 0,
      cached_in INTEGER DEFAULT 0,
      cache_write INTEGER DEFAULT 0,
      out_tok INTEGER DEFAULT 0,
      reasoning INTEGER DEFAULT 0
    );
    CREATE TABLE oc_events (
      id INTEGER PRIMARY KEY,
      store TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      project_id TEXT,
      in_tok INTEGER DEFAULT 0,
      out_tok INTEGER DEFAULT 0,
      reasoning INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      cache_write INTEGER DEFAULT 0,
      cost REAL DEFAULT 0
    );
  `);
  dbs.push(sqlite);
  // Periods exist before change tracking is installed, as migration 0040 guarantees in a real database.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS account_periods(id INTEGER PRIMARY KEY,provider TEXT,source TEXT,from_ts TEXT,until_ts TEXT,account TEXT,
      origin TEXT,first_seen TEXT,last_seen TEXT,readings INTEGER,evidence TEXT)`);
  sqlite.exec(fs.readFileSync(new URL("../../drizzle/0021_current_read_models.sql", import.meta.url), "utf8"));
  installFactDayRevisions(sqlite);
  return sqlite;
}

function context(sqlite: Database, eras?: AccountingContext["eras"]): AccountingContext {
  return { sqlite, accounts: { version: 2 as const, subscriptions: [{ id: "claude1", vendor: "claude" }], sources: [] },
    rateCards: rates, eras, plans: { segments: [], capacity_regimes: [] }, plansCatalog: { provider_groups: [] }, manualCapacity: [] };
}

/** Runs the usage ledger's background producer to completion, as the maintenance worker would. */
function finishRegister(db: Database, provider: UsageLedgerProvider = "claude",
  eras?: AccountingContext["eras"], limit = 50) {
  fixturePeriods(db,provider,eras);
  fillUsageLedger(db, provider, rates, ARCHIVE_LOGICAL_ROOT, limit);
}

function options(account: string, since = "2026-08-10", until = "2026-08-16", project?: string): SubscriptionAccountingOptions {
  return { account, since, until, ...(project ? { project } : {}) };
}

function probe(sqlite: Database, row: {
  id: number; provider: string; subject: string; ts: string; kind: string; used: number;
  reset?: string | null; minutes?: number; plan?: string | null; group?: string | null;
}) {
  sqlite.run(`INSERT INTO probe_windows
    (id, provider, subject, ts, plan, kind, limit_group, used_percent, resets_at, window_minutes, ok, machine,profile,extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  [row.id, row.provider, row.subject, row.ts, row.plan ?? "pro", row.kind, row.group ?? null,
    row.used, row.reset ?? null, row.minutes ?? 10080, `FIXTURE-${row.subject}`, LOGIN,
    JSON.stringify({ home: `C:/Users/${LOGIN}/.${row.provider}-${row.subject}` })]);
}

test("accounting keeps a stale-subject meter when its physical period proves the account", () => {
  const db = fixture(), ctx = context(db), opts = options("claude1");
  claude(db, { id: 1, store: "pc", call: "call-1", ts: "2026-08-10T11:00:00Z", fresh: 1000 });
  probe(db, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T10:00:00Z",
    kind: "weekly_all", used: 20, reset: "2026-08-17T00:00:00Z" });
  probe(db, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-10T12:00:00Z",
    kind: "weekly_all", used: 35, reset: "2026-08-17T00:00:00Z" });
  expect(buildSubscriptionAccountingReport(ctx, "claude", opts).meter_history?.periodic_first).toBe("2026-08-10T10:00:00Z");
  db.query("UPDATE probe_windows SET subject='stale' WHERE id=2").run();
  const defs = [{ id: "claude1", vendor: "claude", machine: "FIXTURE-claude1",
    home: `${ARCHIVE_LOGICAL_ROOT}/claude/fixture-claude1`, source_home: `C:/Users/${LOGIN}/.claude-claude1` }];
  const config = splitProbeReaderFixtureConfig(defs);
  const at = "2026-08-20T00:00:00.000Z";
  for (let step = 0; publishCurrentBatch(db, currentRegistry(config.subscriptions, at), at, 64, config); step++) {
    if (step > 100) throw new Error("stale-subject fixture did not settle");
  }
  const reading = db.query("SELECT subject,extra FROM probe_windows WHERE id=2").get();
  const report = readSubscriptionAccountingReport(ctx, "claude", opts);
  expect(report.meter_history?.periodic_first).toBe("2026-08-10T10:00:00Z");
  expect(report.windows?.some(window => window.observed_pp === 35)).toBe(true);
  expect(db.query("SELECT subject,extra FROM probe_windows WHERE id=2").get()).toEqual(reading);
});

test("probe window register keeps plan edges inside meter segments and attaches a fitting manual 100%", () => {
  const account = "claude-ea41a81ab8dcf86d", counter = '["weekly_all","weekly",10080]';
  const period = (from: string, until: string | null, value: string): DatedPeriod => ({
    provider: "claude", subject: account, from, until, value, origin: "declared", firstSeen: null,
    lastSeen: null, readings: 0, evidence: "fixture",
  });
  const periods = [period("2026-09-09", "2026-09-12T01:00:00.000Z", "pro"),
    period("2026-09-12T01:00:00.000Z", "2026-09-24T09:55:57.164Z", "max-5x"),
    period("2026-09-24T09:55:57.164Z", null, "max-20x")];
  const meter = (ts: string, used_percent: number, resets_at: string) => ({ ts, used_percent, resets_at, window_minutes: 10080 });
  const readings = [
    meter("2026-09-11T21:00:00.000Z", 15, "2026-09-13T11:00:00.000Z"),
    meter("2026-09-12T01:00:58.000Z", 18, "2026-09-13T11:00:00.000Z"),
    meter("2026-09-12T12:14:29.000Z", 21, "2026-09-13T11:00:00.000Z"),
    meter("2026-09-12T13:35:26.000Z", 2, "2026-09-13T11:00:00.000Z"),
    meter("2026-09-20T11:00:00.000Z", 0, "2026-09-27T11:00:00.000Z"),
    meter("2026-09-23T16:26:51.000Z", 88, "2026-09-27T11:00:00.000Z"),
    meter("2026-09-24T09:55:57.164Z", 0, "2026-09-27T11:00:00.000Z"),
  ];
  const measurement: ManualCapacityMeasurement = { id: "manual-week", account, counter,
    start: "2026-09-20T11:00:00.000Z", end: "2026-09-23T21:46:18.888Z",
    start_percent: 0, end_percent: 100, approximate_time: false, note: "limit reached", updated_at: "2026-09-24T00:00:00.000Z" };
  const build = () => buildProbeLimitWindows({ provider: "claude", account, counter, readings, periods, measurements: [measurement] });
  const windows = build();
  const firstDrop = windows.find(w => w.start === "2026-09-12T13:35:26.000Z")!;
  expect(firstDrop.plan).toBe("max-5x");
  expect(windows.find(w => w.end === firstDrop.start)).toMatchObject({ declared_plan_meter_mismatch: true,
    plan_detail: { status: "mixed" } });
  const week = windows.find(w => w.start === "2026-09-20T11:00:00.000Z")!;
  expect(week.end).toBe("2026-09-24T09:55:57.164Z");
  expect(week.plan).toBe("max-5x");
  expect(week.manual_measurement?.id).toBe("manual-week");
  expect(week.readings).toContainEqual({ ts: measurement.end, percent: 100, source: "manual" });
  expect(build().map(w => w.id)).toEqual(windows.map(w => w.id));
  // Before the first declared period (06.09–09.09) the plan is unknown, which is not a plan change.
  expect(probeWindowPlan(planPeriodIndex(periods), periods, "claude", account, "2026-09-06T11:00:00.000Z", "2026-09-12T01:00:00.000Z"))
    .toEqual({ plan: "pro", plan_detail: null, declared_plan_meter_mismatch: false });
  expect(windows.find(w => w.end === firstDrop.start)!.plan_detail!.label).toBe("pro → max-5x");
});

test("a weekly refusal without probe readings anchors a historical week at its reset", () => {
  const reset = "2026-03-08T07:00:00.000Z";
  const windows = buildProbeLimitWindows({ provider: "claude", account: "claude-2e0938c0eccc4dbc",
    counter: '["weekly_all","weekly",10080]', periods: [], readings: [{
      ts: "2026-03-07T10:03:23.098Z", used_percent: 100, resets_at: reset,
      window_minutes: 10080, source: "limit_hit", limit_hit: { call_id: "first-refusal" },
    }] });
  expect(windows).toHaveLength(1);
  expect(windows[0]).toMatchObject({ start: "2026-03-01T07:00:00.000Z", end: reset,
    readings: [{ ts: "2026-03-07T10:03:23.098Z", percent: 100, source: "limit_hit" }] });
});

test("Capacity and /api/windows expose one Claude meter's boundaries, plans and manual reading", async () => {
  const db = fixture(), ctx = context(db), account = "claude-ea41a81ab8dcf86d";
  ctx.accounts.subscriptions = [{ id: account, vendor: "claude" }];
  db.exec(fs.readFileSync(new URL("../../drizzle/0040_account_periods.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  db.exec(fs.readFileSync(new URL("../../drizzle/0043_claude_limit_hits.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  const plan = (from: string, until: string | null, value: string): DatedPeriod => ({ provider: "claude", subject: account,
    from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
  ctx.planPeriods = [plan("2026-09-09", "2026-09-12T01:00:00Z", "pro"),
    plan("2026-09-12T01:00:00Z", "2026-09-24T09:55:57.164Z", "max-5x"),
    plan("2026-09-24T09:55:57.164Z", null, "max-20x")];
  replaceDeclaredPeriods(db, PLAN_PERIODS, ctx.planPeriods);
  const counter = '["weekly_all","weekly",10080]';
  const reading = (id: number, ts: string, used: number, reset: string) => probe(db,
    { id, provider: "claude", subject: account, ts, kind: "weekly_all", group: "weekly", used, reset });
  reading(1, "2026-09-11T21:00:00Z", 15, "2026-09-13T11:00:00Z");
  reading(2, "2026-09-12T01:00:58Z", 18, "2026-09-13T11:00:00Z");
  reading(3, "2026-09-12T12:14:29Z", 21, "2026-09-13T11:00:00Z");
  reading(4, "2026-09-12T13:35:26Z", 2, "2026-09-13T11:00:00Z");
  reading(5, "2026-09-20T11:00:00Z", 0, "2026-09-27T11:00:00Z");
  reading(6, "2026-09-23T16:26:51Z", 88, "2026-09-27T11:00:00Z");
  reading(7, "2026-09-24T09:55:57.164Z", 0, "2026-09-27T11:00:00Z");
  reading(8, "2026-09-27T12:00:00Z", 1, "2026-10-04T11:00:00Z");
  reading(9, "2026-09-12T18:00:00Z", 4, "2026-09-13T11:00:00Z");
  reading(10, "2026-09-24T12:00:00Z", 4, "2026-09-27T11:00:00Z");
  const share = db.query("UPDATE probe_windows SET extra=? WHERE id=?");
  for (const [id, ts, reset] of [
    [1, "2026-09-11T21:00:00Z", "2026-09-13T11:00:00Z"],
    [3, "2026-09-12T12:14:29Z", "2026-09-13T11:00:00Z"],
    [4, "2026-09-12T13:35:26Z", "2026-09-13T11:00:00Z"],
    [9, "2026-09-12T18:00:00Z", "2026-09-13T11:00:00Z"],
    [6, "2026-09-23T16:26:51Z", "2026-09-27T11:00:00Z"],
    [7, "2026-09-24T09:55:57.164Z", "2026-09-27T11:00:00Z"],
    [10, "2026-09-24T12:00:00Z", "2026-09-27T11:00:00Z"],
    [8, "2026-09-27T12:00:00Z", "2026-10-04T11:00:00Z"],
  ] as const) share.run(JSON.stringify({ home: `C:/Users/${LOGIN}/.claude-${account}`,
    ...encodeClaudeCodeProductShare({ schema: 1, key: "claude_code", percent: 12,
      as_of: ts, window_started_at: new Date(Date.parse(reset) - 7 * 86_400_000).toISOString(), display_name: "Claude Code" }) }), id);
  db.exec("ALTER TABLE claude_events ADD COLUMN entrypoint TEXT; ALTER TABLE claude_events ADD COLUMN cc_version TEXT");
  claude(db, { id: 1, store: "pc", account, call: "after-upgrade", ts: "2026-09-24T11:00:00Z", fresh: 100_000 });
  db.query("UPDATE claude_events SET entrypoint='cli', cc_version='1' WHERE id=1").run();
  db.query(`INSERT INTO claude_limit_hits (store, call_id, ts, limit_type, status, resets_at, path)
    VALUES ('pc', 'refused-week', '2026-09-23T18:00:00.000Z', 'seven_day', 'rejected',
      '2026-09-27T11:00:00Z', ?)`)
    .run(`${ARCHIVE_LOGICAL_ROOT}/claude/fixture-${account}/session.jsonl`);
  db.query(`INSERT INTO claude_limit_hits (store, call_id, ts, limit_type, status, resets_at, path)
    VALUES ('pc', 'refused-first', '2026-09-12T13:00:00.000Z', 'seven_day', 'rejected',
      '2026-09-13T11:00:00Z', ?)`)
    .run(`${ARCHIVE_LOGICAL_ROOT}/claude/fixture-${account}/session.jsonl`);
  ctx.manualCapacity = [{ id: "manual-week", account, counter, start: "2026-09-20T11:00:00Z",
    end: "2026-09-23T21:46:18.888Z", start_percent: 0, end_percent: 100,
    approximate_time: false, note: "reached", updated_at: "2026-09-24T00:00:00Z" }];
  const capacity = buildSubscriptionAccountingReport(ctx, "claude", { account, since: "2026-09-09", until: "2026-09-27", counter });
  expect(capacity.windows?.find(w => w.cycle_end === "2026-09-12T13:35:26.000Z"))
    .toMatchObject({ declared_plan_meter_mismatch: true, plan_detail: { status: "mixed" } });
  expect(capacity.windows?.find(w => w.cycle_start === "2026-09-20T11:00:00.000Z"))
    .toMatchObject({ plan: "max-5x", manual_measurement: { id: "manual-week" } });
  const closed = capacity.windows?.find(w => w.cycle_start === "2026-09-24T09:55:57.164Z")!;
  const dropEnded = capacity.windows?.find(w => w.cycle_start === "2026-09-20T11:00:00.000Z")!;
  const running = capacity.windows?.find(w => w.cycle_start === "2026-09-27T11:00:00.000Z")!;
  expect([closed.cycle_end_basis, dropEnded.cycle_end_basis, running.cycle_end_basis])
    .toEqual(["reset", "uncertain", "scheduled"]);
  const detail = buildSubscriptionAccountingReport(ctx, "claude", { account, since: "2026-09-20", until: "2026-09-24",
    counter, detail_cycle: dropEnded.id });
  expect(detail.windows?.find(w => w.id === dropEnded.id)?.timeline?.readings).toContainEqual(expect.objectContaining({
    percent: 100, source: "limit_hit", limit_hit: { call_id: "refused-week" },
  }));
  const narrow = buildSubscriptionAccountingReport(ctx, "claude", { account, since: "2026-09-20", until: "2026-09-24", counter });
  expect(narrow.windows?.find(w => w.manual_measurement?.id === "manual-week")?.id)
    .toBe(capacity.windows?.find(w => w.manual_measurement?.id === "manual-week")?.id);
  const afterDrop = buildSubscriptionAccountingReport(ctx, "claude", { account, since: "2026-09-24", until: "2026-09-26", counter });
  expect(afterDrop.windows?.find(w => w.id === closed.id)).toMatchObject({ cycle_start: closed.cycle_start,
    cycle_end: closed.cycle_end, plan: closed.plan });
  const orphanCounter = '["session","session",300]';
  ctx.manualCapacity.push({ ...ctx.manualCapacity[0]!, id: "orphan", counter: orphanCounter,
    start: "2026-09-22T10:00:00Z", end: "2026-09-22T12:00:00Z" });
  expect(buildSubscriptionAccountingReport(ctx, "claude", { account, since: "2026-09-22", until: "2026-09-22", counter: orphanCounter })
    .windows?.map(w => w.id)).toEqual(["manual:orphan"]);
  const apiContext = { ...ctx, claudeGauge: { subscription: account, plan: "wrong-plan", observations: [] },
    grokGauge: {}, cycles: { windows: [] }, homeToSubId: new Map(), subIdToHomes: new Map(),
    eras: buildEraIndex(ctx.accounts.subscriptions), rootDir: "", homeConflict: null, eraErrors: [] } as unknown as AppContext;
  const response = await apiHandleWindows(apiContext, new URL(`http://localhost/api/windows?account=${account}`));
  const rail = (await response.json() as { windows: Array<{ windowId?: string; startIso: string; resetIso: string;
    plan?: string | null; key: string; cycle_end_basis?: string; shape?: Array<{ pct: number }> | null;
    declared_plan_meter_mismatch?: boolean; manual_measurement?: { id: string } }> }).windows;
  expect(rail.some(w => w.key === "manual:orphan")).toBe(true);
  const byId = new Map(rail.filter(w => w.windowId).map(w => [w.windowId, w]));
  for (const window of capacity.windows ?? []) {
    if (window.id.startsWith("manual:")) continue;
    const counterpart = byId.get(window.id);
    expect(counterpart).toBeDefined();
    expect([counterpart!.startIso, counterpart!.resetIso, counterpart!.plan]).toEqual([
      window.cycle_start, window.cycle_end, window.plan]);
    expect(counterpart!.declared_plan_meter_mismatch).toBe(window.declared_plan_meter_mismatch);
    expect(counterpart!.cycle_end_basis).toBe(window.cycle_end_basis);
    expect(counterpart!.manual_measurement?.id).toBe(window.manual_measurement?.id);
    expect(window.claude_code_capacity?.window_id).toBe(window.id);
  }
  expect(byId.get(dropEnded.id)?.shape?.filter(point => point.pct === 100).length).toBeGreaterThanOrEqual(2);
  expect(closed.claude_code_capacity?.weekly_capacity_tokens.value).toBeGreaterThan(0);
  const limit = await handleClaudeLimit(apiContext, new URL(`http://127.0.0.1/api/claude-limit?account=${account}`
    + `&from=${encodeURIComponent(closed.cycle_start!)}&until=${encodeURIComponent(closed.cycle_end!)}`)).json();
  expect(limit.plan).toBe("max-20x");
  expect(limit.current?.window_id).toBe(closed.id);
  expect(limit.claude_code_capacity?.window_id).toBe(closed.id);
  const resolver = loadAccountResolver(db);
  const evidence = loadProbeLimitEvidence(db, "claude", account, resolver);
  const register = claudeWeeklyRegisterWindows(db, account);
  const observations = readClaudeCodeObservations(db, account);
  const mapped = mapClaudeCodeObservationsToWindows(observations, evidence, register, account, {});
  const brute = observations.map(observation => {
    const at = observation.as_of ?? observation.collected_at;
    const source = evidence.samples.find(sample => sample.kind === "weekly_all" && sample.scope == null && !sample.limitHit
      && Date.parse(sample.ts) === Date.parse(at) && sameResetWindow(sample.resets_at, observation.reset_at));
    const selected = source ? probeLimitCounter(source, account, {}) : null;
    return register.find(window => (selected === null || window.counter === selected)
      && sameResetWindow(window.reset, observation.reset_at)
      && Date.parse(at) >= Date.parse(window.start) && Date.parse(at) < Date.parse(window.end))?.id ?? null;
  });
  expect(mapped.map(observation => observation.window_id)).toEqual(brute);
  // Every read reads the account's history once: limit evidence, or the readings it derives everything from.
  const loader = spyOn(probeRegister, "loadProbeLimitEvidence"), readings = spyOn(probeReader, "readPreparedProbeAccountReadings");
  const reads = () => loader.mock.calls.length + readings.mock.calls.length;
  try {
    const beforeCapacity = reads();
    buildSubscriptionAccountingReport(ctx, "claude", { account, since: "2026-09-24", until: "2026-09-27", counter });
    expect(reads() - beforeCapacity).toBe(1);
    const beforeLimit = reads();
    await handleClaudeLimit(apiContext, new URL(`http://127.0.0.1/api/claude-limit?account=${account}`)).json();
    expect(reads() - beforeLimit).toBe(1);
    const beforeWindows = reads();
    await apiHandleWindows(apiContext, new URL(`http://localhost/api/windows?account=${account}`));
    expect(reads() - beforeWindows).toBe(1);
  } finally { loader.mockRestore(); readings.mockRestore(); }
});

test("a range starting after the scan margin keeps an earlier drop of the same long meter window", () => {
  const db = fixture(), ctx = context(db), account = "claude1";
  const counter = '["weekly_all","weekly",43200]';
  probe(db, { id: 1, provider: "claude", subject: account, ts: "2026-09-03T10:00:00Z",
    kind: "weekly_all", group: "weekly", used: 50, reset: "2026-10-01T00:00:00Z", minutes: 43200 });
  probe(db, { id: 2, provider: "claude", subject: account, ts: "2026-09-05T10:00:00Z",
    kind: "weekly_all", group: "weekly", used: 1, reset: "2026-10-01T00:00:00Z", minutes: 43200 });
  probe(db, { id: 3, provider: "claude", subject: account, ts: "2026-09-25T10:00:00Z",
    kind: "weekly_all", group: "weekly", used: 30, reset: "2026-10-01T00:00:00Z", minutes: 43200 });
  const wide = buildSubscriptionAccountingReport(ctx, "claude", { account, counter, since: "2026-09-01", until: "2026-09-26" });
  const narrow = buildSubscriptionAccountingReport(ctx, "claude", { account, counter, since: "2026-09-25", until: "2026-09-26" });
  const selected = (windows: typeof wide.windows) => windows?.find(w => w.cycle_start === "2026-09-05T10:00:00.000Z");
  expect(selected(narrow.windows)).toMatchObject({ id: selected(wide.windows)?.id, cycle_end: selected(wide.windows)?.cycle_end,
    cycle_end_basis: selected(wide.windows)?.cycle_end_basis });
});

test("a narrow Claude report seeks effective observation time across more than 20000 unrelated probes", () => {
  const results: Array<{ size: number; selected: number; first: string | null; observed: number[] }> = [];
  for (const size of [100, 20_050]) {
    const db = fixture(), ctx = context(db);
    const insert = db.query(`INSERT INTO probe_windows(id,provider,subject,ts,kind,used_percent,ok,machine,profile,extra,resets_at)
      VALUES(?,'claude','claude1',?,'weekly_all',10,1,'FIXTURE-claude1',?,?,NULL)`);
    const home = `C:/Users/${LOGIN}/.claude-claude1`, extra = JSON.stringify({ home });
    db.transaction(() => {
      for (let i = 0; i < size; i++) insert.run(i + 1,
        new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString(), LOGIN, extra);
    }).immediate();
    probe(db, { id: size + 1, provider: "claude", subject: "claude1", ts: "2026-08-10T10:00:00.000Z",
      kind: "weekly_all", used: 20, reset: "2026-08-17T00:00:00.000Z" });
    probe(db, { id: size + 2, provider: "claude", subject: "claude1", ts: "2026-09-01T00:00:00.000Z",
      kind: "weekly_all", used: 35, reset: "2026-08-17T00:00:00.000Z" });
    db.query("UPDATE probe_windows SET extra=? WHERE id=?").run(JSON.stringify({ home,
      ...encodeClaudeCodeProductShare({ schema: 1, key: "claude_code", percent: 35,
        as_of: "2026-08-11T02:00:00.000+14:00", window_started_at: "2026-08-10T00:00:00.000Z",
        display_name: "Claude Code" }) }), size + 2);
    const opts = options("claude1", "2026-08-10", "2026-08-10");
    const report = buildSubscriptionAccountingReport(ctx, "claude", opts);
    const selected = readPreparedProbeAccountRange(db, "claude", "claude1",
      "2026-07-27T00:00:00.000Z", "2026-08-26T00:00:00.000Z", 20_000, "accounting")!;
    expect(readPreparedProbeAccountRange(db, "claude", "claude1",
      "2026-08-10T12:00:00.000Z", "2026-08-10T12:00:01.000Z", 20_000, "accounting")?.rows.map(row => row.id))
      .toEqual([size + 2]);
    expect(readPreparedProbeAccountRange(db, "claude", "claude1",
      "2026-08-11T02:00:00.000+14:00", "2026-08-11T02:00:01.000+14:00", 20_000, "accounting")?.rows.map(row => row.id))
      .toEqual([size + 2]);
    results.push({ size, selected: selected.visitedKeys, first: report.meter_history?.periodic_first ?? null,
      observed: (report.windows ?? []).map(window => window.observed_pp ?? -1).sort() });
    if (size === 20_050) {
      const history = readPreparedProbeAccountHistory(db, "claude", "claude1")!;
      expect(history.visitedKeys).toBe(size + 2);
      expect(history.rows.map(row => row.id)).toEqual(Array.from({ length: size + 2 }, (_, i) => i + 1));
      // Readings load in one statement per indexed range of the account, not one statement per reading.
      let pages = 0;
      const query = db.query.bind(db);
      db.query = ((sql: string) => {
        const statement = query(sql);
        // Bun returns one cached statement per SQL text, so count through a proxy.
        return !sql.includes("JOIN probe_windows") ? statement : new Proxy(statement, { get(target, property) {
          if (property === "all") return (...args: Parameters<typeof target.all>) => { pages++; return target.all(...args); };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      }) as typeof db.query;
      try { readPreparedProbeAccountHistory(db, "claude", "claude1"); } finally { db.query = query; }
      expect(pages).toBe(1);
      expect(readPreparedProbeAccountHistory(db, "claude", "claude1", "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z")?.rows.map(row => row.id)).toEqual([1]);
      expect(() => readPreparedProbeAccountRange(db, "claude", "claude1", null, null, 20_000, "accounting"))
        .toThrow(ProbeAccountReadLimitExceeded);
      expect(() => readPreparedProbeAccountRange(db, "claude", "claude1", null, null, 50_000, "accounting"))
        .toThrow(ProbeAccountReadLimitExceeded);
      expect(() => readSubscriptionAccountingReport(ctx, "claude",
        options("claude1", "2026-01-01", "2026-09-01"))).toThrow(ProbeAccountReadLimitExceeded);
      const source = "claude/fixture-claude1";
      replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [
        { provider: "claude", subject: source, value: "claude1", from: "2000-01-01",
          until: "2026-08-15T00:00:00.000Z", origin: "declared", firstSeen: null,
          lastSeen: null, readings: 0, evidence: "fixture" },
        { provider: "claude", subject: source, value: "other", from: "2026-08-15T00:00:00.000Z",
          until: null, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" },
      ]);
      const defs = [{ id: "claude1", vendor: "claude", machine: "FIXTURE-claude1",
        home: `${ARCHIVE_LOGICAL_ROOT}/${source}`, source_home: home }, { id: "other", vendor: "claude" }];
      const config = splitProbeReaderFixtureConfig(defs);
      const at = "2026-09-02T00:00:00.000Z";
      for (let step = 0; publishCurrentBatch(db, currentRegistry(config.subscriptions, at), at, 512, config); step++) {
        if (step > 1000) throw new Error("period correction did not settle");
      }
      prepareLimitWindowsFixture(db);
      prepareWindowUsageFixture(db, { rateCards: ctx.rateCards, subscriptions: defs, manualCapacity: () => [], claudeGauge: {}, cycles: { windows: [] } });
      ctx.resolver = loadAccountResolver(db, defs);
      expect(readPreparedProbeAccountRange(db, "claude", "claude1", "2026-08-10T00:00:00.000Z",
        "2026-08-11T00:00:00.000Z", 20_000, "accounting")?.rows.map(row => row.id)).toEqual([size + 1]);
      expect(readPreparedProbeAccountRange(db, "claude", "other", "2026-08-10T00:00:00.000Z",
        "2026-08-11T00:00:00.000Z", 20_000, "accounting")?.rows.map(row => row.id)).toEqual([size + 2]);
      expect(readPreparedProbeAccountHistory(db, "claude", "claude1")?.rows.map(row => row.id))
        .toEqual(Array.from({ length: size + 1 }, (_, i) => i + 1));
      expect(readPreparedProbeAccountHistory(db, "claude", "other")?.rows.map(row => row.id)).toEqual([size + 2]);
      expect(readSubscriptionAccountingReport(ctx, "claude", opts).windows?.some(window => window.observed_pp === 35)).toBe(false);
      expect(readSubscriptionAccountingReport(ctx, "claude", { ...opts, account: "other" }).windows
        ?.some(window => window.observed_pp === 35)).toBe(true);
    }
  }
  expect(results[0]).toMatchObject({ size: 100, selected: 2, first: "2026-08-10T10:00:00.000Z" });
  expect(results[1]).toEqual({ ...results[0]!, size: 20_050 });
}, 30_000);

test("an A/C period correction moves A's accounting to C while B's report stays byte-identical", () => {
  const db = fixture(), ctx = context(db);
  probe(db, { id: 1, provider: "claude", subject: "a", ts: "2026-09-01T10:00:00.000Z",
    kind: "weekly_all", used: 25, reset: "2026-09-08T00:00:00.000Z" });
  probe(db, { id: 2, provider: "claude", subject: "b", ts: "2026-08-10T10:00:00.000Z",
    kind: "weekly_all", used: 50, reset: "2026-08-17T00:00:00.000Z" });
  const aOptions = options("a", "2026-09-01", "2026-09-01"), bOptions = options("b", "2026-08-10", "2026-08-10");
  const beforeA = buildSubscriptionAccountingReport(ctx, "claude", aOptions);
  const beforeB = buildSubscriptionAccountingReport(ctx, "claude", bOptions);
  expect(beforeA.meter_history?.periodic_first).toBe("2026-09-01T10:00:00.000Z");
  const periods = loadPeriods(db, ACCOUNT_PERIODS);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, periods.map(period => period.subject === "claude/fixture-a"
    ? { ...period, value: "c" } : period));
  const defs = [
    { id: "a", vendor: "claude", machine: "FIXTURE-a", home: `${ARCHIVE_LOGICAL_ROOT}/claude/fixture-a`,
      source_home: `C:/Users/${LOGIN}/.claude-a` },
    { id: "b", vendor: "claude", machine: "FIXTURE-b", home: `${ARCHIVE_LOGICAL_ROOT}/claude/fixture-b`,
      source_home: `C:/Users/${LOGIN}/.claude-b` },
    { id: "c", vendor: "claude" },
  ];
  const config = splitProbeReaderFixtureConfig(defs);
  const at = "2026-09-02T00:00:00.000Z";
  for (let step = 0; publishCurrentBatch(db, currentRegistry(config.subscriptions, at), at, 64, config); step++) {
    if (step > 100) throw new Error("account correction did not settle");
  }
  prepareLimitWindowsFixture(db);
  prepareWindowUsageFixture(db, { rateCards: ctx.rateCards, subscriptions: defs, manualCapacity: () => [], claudeGauge: {}, cycles: { windows: [] } });
  ctx.resolver = loadAccountResolver(db, defs);
  // Reports are read from the stored rows on each request: B's rows did not change, A's moved to C.
  expect(JSON.stringify(readSubscriptionAccountingReport(ctx, "claude", bOptions))).toBe(JSON.stringify(beforeB));
  expect(readSubscriptionAccountingReport(ctx, "claude", aOptions).meter_history?.periodic_first).toBeNull();
  expect(readSubscriptionAccountingReport(ctx, "claude", { ...aOptions, account: "c" })
    .meter_history?.periodic_first).toBe("2026-09-01T10:00:00.000Z");
});

function claude(sqlite: Database, row: {
  id: number; store: string; call: string; ts: string; account?: string | null; model?: string;
  speed?: string | null; project?: string | null; conflict?: number;
  fresh?: number; cached?: number; write?: number; write5?: number; write1?: number; output?: number; thinking?: number;
}) {
  sqlite.run(`INSERT INTO claude_events
    (id, store, call_id, ts, path, subscription_id, subscription_conflict, model, speed, project_id,
     in_uncached, in_cache_read, in_cache_write, cache_write_5m, cache_write_1h, out_total, out_thinking)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    row.id, row.store, row.call, row.ts, `${row.store}/history.jsonl`, row.account ?? "claude1", row.conflict ?? 0,
    row.model ?? "claude-3-sonnet", row.speed ?? "standard", row.project ?? "project-a", row.fresh ?? 0,
    row.cached ?? 0, row.write ?? 0, row.write5 ?? 0, row.write1 ?? 0, row.output ?? 0, row.thinking ?? 0,
  ]);
}

afterEach(() => {
  for (const sqlite of dbs.splice(0)) sqlite.close();
});

describe("subscription accounting provider adapters", () => {
  const manual = (patch: Partial<ManualCapacityMeasurement> = {}): ManualCapacityMeasurement => ({
    id: "manual-test", account: "claude1", counter: '["weekly_all","weekly",10080]', start: "2026-08-10T10:00:00.000Z", end: "2026-08-10T12:00:00.000Z",
    start_percent: 20, end_percent: 40, approximate_time: false, note: "History", updated_at: "2026-09-01T00:00:00.000Z", ...patch,
  });

  test("manual percentages pair the exact interval, retain unpriced tokens and recompute after an edit", () => {
    const sqlite = fixture(), ctx = context(sqlite);
    ctx.manualCapacity = [manual()];
    for (const [id, ts] of [[1, "2026-08-10T10:00:00Z"], [2, "2026-08-10T11:00:00Z"], [3, "2026-08-10T12:00:00Z"], [4, "2026-08-10T12:00:00.001Z"]] as const)
      claude(sqlite, { id, ts, store: "pc", call: String(id), fresh: MILLION, model: "unpriced" });
    claude(sqlite, { id: 5, ts: "2026-08-10T11:00:00Z", store: "pc", call: "foreign", account: "other", fresh: MILLION });
    const before = buildSubscriptionAccountingReport(ctx, "claude", { ...options("claude1"), detail_cycle: "manual:manual-test" });
    expect(before.tokens).toBe(4 * MILLION);
    expect(before.windows).toHaveLength(1);
    const w = before.windows![0]!;
    expect(w).toMatchObject({ observed_pp: 20, start_percent: 20, start_basis: "partial", usage: { events: 2, tokens: 2 * MILLION }, cycle_usage: { events: 2, tokens: 2 * MILLION } });
    expect(w.timeline!.readings.map(p => [p.percent, p.source])).toEqual([[20, "manual"], [40, "manual"]]);
    expect(capacityPerPoint(w, "tokens")).toBe(100000);
    expect(capacityPerPoint(w, "api_standard")).toBeNull();
    ctx.manualCapacity = [manual({ end_percent: 60 })];
    expect(capacityPerPoint(buildSubscriptionAccountingReport(ctx, "claude", options("claude1")).windows![0]!, "tokens")).toBe(50000);
    expect(buildSubscriptionAccountingReport(ctx, "claude", options("other")).windows).toHaveLength(0);
    expect(buildSubscriptionAccountingReport(ctx, "claude", options("claude1", "2026-08-10", "2026-08-16", "project-a")).windows).toBeNull();
  });

  test("a window's plan comes from plan periods, never from the label a reading carried", () => {
    const sqlite = fixture();
    claude(sqlite, { id: 1, ts: "2026-08-10T11:00:00Z", store: "pc", call: "1", fresh: MILLION });
    const reset = "2026-08-16T00:00:00.000Z";
    // The probe's own label flips mid-week (Claude's token label is not a plan); it must not cut the week.
    probe(sqlite, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T10:00:00Z", kind: "weekly_all", used: 10, reset, plan: "pro" });
    probe(sqlite, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-12T10:00:00Z", kind: "weekly_all", used: 30, reset, plan: "max" });
    const declared = { provider: "claude", subject: "claude1", from: "2026-08-01", until: null, value: "default_claude_max_5x",
      origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" };
    const withPeriods = buildSubscriptionAccountingReport({ ...context(sqlite), planPeriods: [declared] }, "claude", options("claude1"));
    expect(withPeriods.windows!.map(w => w.plan)).toEqual(["max-5x"]);
    const unknown = buildSubscriptionAccountingReport({ ...context(sqlite), planPeriods: [] }, "claude", options("claude1"));
    expect(unknown.windows!.map(w => w.plan)).toEqual([null]);
  });

  test("a manual interval takes the plan period covering both ends and stays unknown across a plan change", () => {
    const sqlite = fixture();
    const period = (from: string, until: string | null, value: string) => ({ provider: "claude", subject: "claude1", from, until, value,
      origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
    const planOf = (planPeriods: ReturnType<typeof period>[]) =>
      buildSubscriptionAccountingReport({ ...context(sqlite), manualCapacity: [manual()], planPeriods }, "claude", options("claude1")).windows!.map(w => w.plan);
    expect(planOf([period("2026-08-01", null, "default_claude_max_5x")])).toEqual(["max-5x"]);
    // The interval ends at 12:00 exclusive, so a change exactly at its end does not split it.
    expect(planOf([period("2026-08-01", "2026-08-10T12:00:00.000Z", "default_claude_max_5x"), period("2026-08-10T12:00:00.000Z", null, "default_claude_max_20x")]))
      .toEqual(["max-5x"]);
    expect(planOf([period("2026-08-01", "2026-08-10T11:00:00.000Z", "default_claude_max_5x"), period("2026-08-10T11:00:00.000Z", null, "default_claude_max_20x")]))
      .toEqual([null]);
  });

  test("manual corrections join a fitting meter window while original probes remain available", () => {
    const sqlite = fixture(), ctx = context(sqlite);
    probe(sqlite, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T10:00:00Z", kind: "weekly_all", group: "weekly", used: 20, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-10T12:00:00Z", kind: "weekly_all", group: "weekly", used: 40, reset: "2026-08-17T00:00:00Z" });
    claude(sqlite, { id: 1, store: "pc", call: "one", ts: "2026-08-10T11:00:00Z", fresh: MILLION });
    const original = buildSubscriptionAccountingReport(ctx, "claude", options("claude1"));
    ctx.manualCapacity = [manual()];
    expect(buildSubscriptionAccountingReport(ctx, "claude", options("claude1")).windows).toEqual([
      expect.objectContaining({ id: original.windows![0]!.id, manual_measurement: expect.objectContaining({ id: "manual-test" }) }),
    ]);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM probe_windows").get()).toEqual({ n: 2 });
    ctx.manualCapacity = [];
    expect(buildSubscriptionAccountingReport(ctx, "claude", options("claude1")).windows).toEqual(original.windows);
  });

  test("Gemini includes conversation timestamps only after explicit approximate-time consent", () => {
    const sqlite = fixture(), ctx = context(sqlite);
    sqlite.run(`INSERT INTO gemini_events (id,store,conversation_id,gen_idx,ts,ts_basis,model,fresh_in,cached_in,out_total,out_thinking)
      VALUES (1,'agy1','conversation',0,'2026-08-10T11:00:00Z','conversation','gemini-2.5-pro',1000000,0,0,0)`);
    ctx.manualCapacity = [manual({ account: "agy1", counter: '["weekly","gemini",10080]' })];
    const strict = buildSubscriptionAccountingReport(ctx, "gemini", options("agy1"));
    expect(strict.tokens).toBe(MILLION);
    expect(strict.windows![0]!.usage.tokens).toBe(0);
    ctx.manualCapacity[0]!.approximate_time = true;
    const approximate = buildSubscriptionAccountingReport(ctx, "gemini", options("agy1"));
    expect(approximate.windows![0]!).toMatchObject({ manual_measurement: { approximate_time: true }, usage: { tokens: MILLION } });
    expect(capacityPerPoint(approximate.windows![0]!, "tokens")).toBe(50000);
  });

  test("a long manual interval loads its complete traffic outside the normal context margin", () => {
    const sqlite = fixture(), ctx = context(sqlite);
    ctx.manualCapacity = [manual({ start: "2026-07-01T00:00:00.000Z", end: "2026-08-16T00:00:00.000Z" })];
    claude(sqlite, { id: 1, store: "pc", call: "old", ts: "2026-07-02T00:00:00Z", fresh: MILLION });
    const report = buildSubscriptionAccountingReport(ctx, "claude", options("claude1"));
    expect(report.events).toBe(0);
    expect(report.windows![0]!.usage.tokens).toBe(MILLION);
  });
  test("prepared manual intervals include the final day and exact endpoint beyond the context margin", () => {
    const sqlite = fixture(), ctx = context(sqlite);
    createAnalysisSourceRevisions(sqlite);
    installAnalysisTracking(sqlite);
    ctx.manualCapacity = [manual({ start: "2026-08-10T00:00:00.000Z", end: "2026-09-04T12:00:00.000Z" })];
    claude(sqlite, { id: 1, store: "pc", call: "endpoint", ts: "2026-09-04T12:00:00Z", fresh: MILLION });
    claude(sqlite, { id: 2, store: "pc", call: "after", ts: "2026-09-04T12:00:01Z", fresh: MILLION });
    const report = buildSubscriptionAccountingReport(ctx, "claude", options("claude1"));
    expect(report.events).toBe(0);
    expect(report.windows![0]!.usage).toMatchObject({ events: 1, tokens: MILLION });
  });
  test("Claude cycle detail is opt-in, retains exact timestamps and excludes duplicate or foreign traffic", async () => {
    const sqlite = fixture(), ctx = context(sqlite), base = options("claude1");
    probe(sqlite, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T10:00:00Z", kind: "weekly_all", used: 10, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-10T13:00:00Z", kind: "weekly_all", used: 30, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 3, provider: "claude", subject: "claude1", ts: "2026-08-10T12:00:00Z", kind: "session", used: 80, reset: "2026-08-10T15:00:00Z", minutes: 300 });
    claude(sqlite, { id: 1, store: "pc", call: "one", ts: "2026-08-10T11:07:13.417Z", fresh: MILLION });
    claude(sqlite, { id: 2, store: "mirror", call: "one", ts: "2026-08-10T11:07:13.417Z", fresh: MILLION });
    claude(sqlite, { id: 3, store: "pc", call: "foreign", ts: "2026-08-10T12:00:00Z", fresh: MILLION, account: "claude2" });
    const normal = buildSubscriptionAccountingReport(ctx, "claude", base);
    expect(normal.windows![0]!.timeline).toBeUndefined();
    const id = normal.windows![0]!.id;
    const params = new URLSearchParams({ since: base.since, until: base.until, account: "claude1", provider: "claude", detail_cycle: id });
    const response = await createFetchHandler(ctx as unknown as AppContext)(new Request(`http://localhost/api/subscription-accounting?${params}`));
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.provider.credits).toBe(false);
    const detail = report.windows.find((w: { id: string }) => w.id === id);
    expect(detail.usage).toEqual(normal.windows![0]!.usage);
    expect(detail.timeline.readings).toHaveLength(2);
    expect(detail.timeline.models).toHaveLength(1);
    expect(detail.timeline.models[0]).toMatchObject({ events: 1, input: MILLION, output: 0, cache_write: 0, tokens: MILLION, api_standard: 1, pricing_issues: {} });
    expect(detail.timeline.usage).toEqual([{ ts: Date.parse("2026-08-10T11:07:13.417Z"), events: 1, tokens: MILLION, api_standard: 1, credits_low: 0, credits_high: 0, credits_unavailable_events: 0, unpriced_events: 0, unknown_tokens: 0 }]);
    // The same counted traffic by source: one source here, the whole cycle's sums, with its first and last call.
    expect(detail.timeline.sources).toHaveLength(1);
    expect(detail.timeline.sources[0]).toMatchObject({ events: 1, tokens: MILLION, api_standard: 1,
      first: "2026-08-10T11:07:13.417Z", last: "2026-08-10T11:07:13.417Z" });
    params.set("account", "claude2");
    const other = await (await createFetchHandler(ctx as unknown as AppContext)(new Request(`http://localhost/api/subscription-accounting?${params}`))).json();
    expect(other.windows.some((w: { timeline?: unknown }) => w.timeline)).toBe(false);
    params.set("account", "all");
    expect((await createFetchHandler(ctx as unknown as AppContext)(new Request(`http://localhost/api/subscription-accounting?${params}`))).status).toBe(400);
  });
  test("generic fixed-date valuation preserves matching and excludes missing common rates", () => {
    const sqlite = fixture();
    probe(sqlite, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T00:00:00Z", kind: "weekly_all", used: 0, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-11T00:00:00Z", kind: "weekly_all", used: 50, reset: "2026-08-17T00:00:00Z" });
    claude(sqlite, { id: 1, store: "pc", call: "priced", ts: "2026-08-10T12:00:00Z", fresh: MILLION });
    claude(sqlite, { id: 2, store: "pc", call: "missing", ts: "2026-08-10T13:00:00Z", fresh: MILLION, model: "missing" });
    const report = buildSubscriptionAccountingReport(context(sqlite), "claude", { ...options("claude1"), reference_day: "2026-08-12" });
    expect(report.scope.reference_day).toBe("2026-08-12");
    expect(report.windows).toHaveLength(1);
    expect(report.windows![0]!.usage).toMatchObject({ events: 2, api_standard: 1, reference_api_standard: 10, paired_historical_api: 1, paired_reference_api: 10, revaluation_events: 1, revaluation_tokens: MILLION, reference_unpriced_events: 1 });
    const missingContext = { ...context(sqlite), rateCards: structuredClone(rates) };
    delete missingContext.rateCards.vendors.anthropic!.models!["claude-3-sonnet"]!.after;
    // The background producer revalues the ledger under the edited card before reports read it.
    fillUsageLedger(sqlite, "claude", missingContext.rateCards, ARCHIVE_LOGICAL_ROOT);
    const expired = buildSubscriptionAccountingReport(missingContext, "claude", { ...options("claude1"), reference_day: "2026-08-12" });
    expect(expired.windows![0]!.usage).toMatchObject({ reference_api_standard: 0, reference_unpriced_events: 2, revaluation_events: 0 });
    fillUsageLedger(sqlite, "claude", rates, ARCHIVE_LOGICAL_ROOT);
    expect(() => buildSubscriptionAccountingReport(context(sqlite), "claude", { ...options("claude1"), reference_day: "2026-02-30" })).toThrow("reference_day");
  });
  test("universal HTTP route requires a provider and dispatches provider accounting without mutating data", async () => {
    const sqlite = fixture(), ctx = context(sqlite) as unknown as AppContext, read = createFetchHandler(ctx);
    buildSubscriptionAccountingReport(ctx,"claude",options("claude1"));
    const url = "http://localhost/api/subscription-accounting?account=claude1&since=2026-08-10&until=2026-08-16";
    expect((await read(new Request(url))).status).toBe(400);
    expect((await read(new Request(url + "&provider=unsupported"))).status).toBe(400);
    const response = await read(new Request(url + "&provider=claude"));
    expect(response.status).toBe(200);
    expect((await response.json()).provider.id).toBe("claude");
    expect((await read(new Request(url + "&provider=claude", { method: "POST", headers: { "content-type": "application/json" } }))).status).toBe(405);
  });

  test("missing named cadence uses nominal duration and dated settings, keeping full cycles outside the date filter", () => {
    const sqlite = fixture();
    probe(sqlite, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T12:00:00Z", kind: "weekly_all", used: 20, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-12T12:00:00Z", kind: "weekly_all", used: 50, reset: "2026-08-17T00:00:00Z" });
    sqlite.run("UPDATE probe_windows SET window_minutes=NULL");
    claude(sqlite, { id: 1, store: "pc", call: "early", ts: "2026-08-10T01:00:00Z", fresh: MILLION });
    claude(sqlite, { id: 2, store: "pc", call: "in-range", ts: "2026-08-11T01:00:00Z", fresh: 2 * MILLION });
    claude(sqlite, { id: 3, store: "pc", call: "later", ts: "2026-08-13T01:00:00Z", fresh: 3 * MILLION });
    const ctx = context(sqlite);
    const report = buildSubscriptionAccountingReport(ctx, "claude", options("claude1", "2026-08-11", "2026-08-11"));
    expect(report.provider?.counter).toBe('["weekly_all","",10080]');
    expect(report.tokens).toBe(2 * MILLION);
    expect(report.windows).toHaveLength(1);
    expect(report.windows![0]!.start).toBe("2026-08-10T00:00:00.000Z");
    expect(report.windows![0]!.observed_pp).toBe(50);
    expect(report.windows![0]!.usage.tokens).toBe(3 * MILLION);
    expect(report.windows![0]!.cycle_usage!.tokens).toBe(6 * MILLION);
    expect(report.limitations.some(note => note.includes("nominal cadence"))).toBe(true);
    ctx.cycles = { windows: [{ subscription: "claude1", kind: "weekly_all", segments: [{ from: "2026-08-10", period_hours: 192 }] }] };
    const declared = buildSubscriptionAccountingReport(ctx, "claude", options("claude1"));
    expect(declared.provider?.counter).toBe('["weekly_all","",11520]');
    expect(declared.windows![0]!.start).toBe("2026-08-09T00:00:00.000Z");
    expect(declared.limitations.some(note => note.includes("dated user declarations"))).toBe(true);
  });

  test("Claude weekly_all selects the all-model counter, excludes other accounts/conflicts, deduplicates stores, and separates Standard from Fast", () => {
    const sqlite = fixture();
    probe(sqlite, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T00:00:00Z", kind: "weekly_all", group: "weekly_all", used: 0, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-11T00:00:00Z", kind: "weekly_all", group: "weekly_all", used: 50, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 3, provider: "claude", subject: "claude1", ts: "2026-08-11T00:00:00Z", kind: "weekly_sonnet", group: "weekly_sonnet", used: 90, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 4, provider: "other", subject: "claude1", ts: "2026-08-11T00:00:00Z", kind: "weekly_all", group: "weekly_all", used: 90, reset: "2026-08-17T00:00:00Z" });
    const quantities = { fresh: MILLION, cached: 2 * MILLION, write: 7 * MILLION, write5: 3 * MILLION, write1: 4 * MILLION, output: 5 * MILLION, thinking: 2 * MILLION };
    claude(sqlite, { id: 1, store: "claude-main", call: "call-std", ts: "2026-08-10T01:00:00Z", speed: "standard", ...quantities });
    claude(sqlite, { id: 2, store: "claude-mirror", call: "call-std", ts: "2026-08-10T01:00:00Z", speed: "standard", ...quantities });
    claude(sqlite, { id: 3, store: "claude-main", call: "call-fast", ts: "2026-08-10T02:00:00Z", speed: "fast", ...quantities });
    claude(sqlite, { id: 4, store: "claude-main", call: "call-other", ts: "2026-08-10T03:00:00Z", account: "other-account", ...quantities });
    claude(sqlite, { id: 5, store: "claude-main", call: "call-conflict", ts: "2026-08-10T04:00:00Z", conflict: 1, ...quantities });

    const report = buildSubscriptionAccountingReport(context(sqlite), "claude", options("CLAUDE1"));
    expect(report.provider).toMatchObject({ counter: JSON.stringify(["weekly_all", "weekly_all", 10080]) });
    expect(report.provider?.counters).toHaveLength(1);
    expect(report.events).toBe(2);
    expect(report.tokens).toBe(30 * MILLION);
    expect(report.known_speed_events).toBe(2);
    expect(report.unknown_speed_events).toBe(0);
    expect(report.excluded_mirror_events).toBe(1);
    expect(report.amounts.api_equivalent_usd).toMatchObject({ status: "complete", value: 165, priced_events: 2, priced_tokens: 30 * MILLION });
    expect(report.normalization.standard_api_usd).toMatchObject({ status: "complete", value: 110, priced_events: 2, priced_tokens: 30 * MILLION });

    const standard = report.model_details.find((detail) => detail.speed === "standard")!;
    const fast = report.model_details.find((detail) => detail.speed === "fast")!;
    expect(standard.quantities).toMatchObject({ in_uncached: MILLION, in_cache_read: 2 * MILLION, in_cache_write_5m: 3 * MILLION, in_cache_write_1h: 4 * MILLION, out_total: 5 * MILLION, out_thinking: 2 * MILLION });
    expect(standard.tokens).toBe(15 * MILLION);
    expect(standard.api_standard).toBeCloseTo(55, 10);
    expect(standard.api_actual).toBeCloseTo(55, 10);
    expect(fast.tokens).toBe(15 * MILLION);
    expect(fast.api_standard).toBeCloseTo(55, 10);
    expect(fast.api_actual).toBeCloseTo(110, 10);
    expect(report.windows?.[0]?.usage).toMatchObject({ events: 2, tokens: 30 * MILLION, input: 20 * MILLION, cached: 4 * MILLION,
      output: 10 * MILLION, cache_write_5m: 6 * MILLION, cache_write_1h: 8 * MILLION, api_standard: 110 });
  });

  test("missing rates keep token quantities and expose a partial API amount", () => {
    const sqlite = fixture();
    claude(sqlite, { id: 1, store: "claude-main", call: "priced", ts: "2026-08-10T01:00:00Z", fresh: MILLION });
    claude(sqlite, { id: 2, store: "claude-main", call: "unpriced", ts: "2026-08-10T02:00:00Z", model: "claude-new-model", fresh: 2 * MILLION });

    const report = buildSubscriptionAccountingReport(context(sqlite), "claude", options("claude1"));
    expect(report.events).toBe(2);
    expect(report.tokens).toBe(3 * MILLION);
    expect(report.amounts.api_equivalent_usd).toMatchObject({ status: "partial", value: null, priced_subtotal: 1,
      priced_events: 1, unpriced_events: 1, priced_tokens: MILLION, unpriced_tokens: 2 * MILLION });
    expect(report.normalization.standard_api_usd).toMatchObject({ status: "partial", value: null, priced_subtotal: 1,
      priced_events: 1, unpriced_events: 1, priced_tokens: MILLION, unpriced_tokens: 2 * MILLION });
  });

  test("project scope filters traffic while disabling capacity windows", () => {
    const sqlite = fixture();
    claude(sqlite, { id: 1, store: "claude-main", call: "project-a", ts: "2026-08-10T01:00:00Z", project: "project-a", fresh: 10 });
    claude(sqlite, { id: 2, store: "claude-main", call: "project-b", ts: "2026-08-10T02:00:00Z", project: "project-b", fresh: 20 });

    const report = buildSubscriptionAccountingReport(context(sqlite), "claude", options("claude1", "2026-08-10", "2026-08-10", "project-a"));
    expect(report.scope.project).toBe("project-a");
    expect(report.events).toBe(1);
    expect(report.tokens).toBe(10);
    expect(report.windows).toBeNull();
  });

  test("Gemini traffic remains visible, but conversation and mtime timestamps are excluded from capacity usage", () => {
    const sqlite = fixture();
    probe(sqlite, { id: 1, provider: "gemini", subject: "gem1", ts: "2026-08-10T00:00:00Z", kind: "weekly", group: "gemini", used: 0, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 2, provider: "gemini", subject: "gem1", ts: "2026-08-11T00:00:00Z", kind: "weekly", group: "gemini", used: 40, reset: "2026-08-17T00:00:00Z" });
    sqlite.run(`INSERT INTO gemini_events (id, store, conversation_id, gen_idx, ts, ts_basis, model, fresh_in)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [1, "gem1", "conversation", 0, "2026-08-10T01:00:00Z", "conversation", "gemini-2.5-pro", 10]);
    sqlite.run(`INSERT INTO gemini_events (id, store, conversation_id, gen_idx, ts, ts_basis, model, fresh_in)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [2, "gem1", "mtime", 0, "2026-08-10T02:00:00Z", "mtime", "gemini-2.5-pro", 20]);
    sqlite.run(`INSERT INTO gemini_events (id, store, conversation_id, gen_idx, ts, ts_basis, model, fresh_in)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [3, "gem1", "event", 0, "2026-08-10T03:00:00Z", "event", "gemini-2.5-pro", 30]);

    const report = buildSubscriptionAccountingReport(context(sqlite), "gemini", options("gem1"));
    expect(report.events).toBe(3);
    expect(report.tokens).toBe(60);
    expect(report.traffic_periods[0]).toMatchObject({ events: 3, tokens: 60 });
    expect(report.windows).toHaveLength(1);
    expect(report.windows?.[0]?.usage).toMatchObject({ events: 1, tokens: 30 });
  });

  test("GLM OpenCode traffic is not assigned by a mismatched store, but an explicit era mapping assigns it", () => {
    const sqlite = fixture();
    sqlite.run(`INSERT INTO oc_events (id, store, message_id, ts, model, provider, in_tok, out_tok, reasoning, cache_read, cache_write)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [1, "machine-a", "glm-message", "2026-08-10T01:00:00Z", "glm-4", "zai-coding-plan", 10, 5, 2, 3, 4]);
    const withoutMapping = buildSubscriptionAccountingReport(context(sqlite), "glm", options("glm1"));
    expect(withoutMapping.events).toBe(0);
    expect(withoutMapping.tokens).toBe(0);

    const eras = buildEraIndex([{ id: "glm1", vendor: "glm", home: "machine-a" }]);
    const mapped = buildSubscriptionAccountingReport(context(sqlite, eras), "glm", options("glm1"));
    expect(mapped.events).toBe(1);
    expect(mapped.tokens).toBe(24);
    expect(mapped.model_details[0]).toMatchObject({ quantities: { in_uncached: 10, in_cache_read: 3, in_cache_write_unknown: 4, out_total: 7, out_thinking: 2 }, tokens: 24 });
  });

  test("GLM accounting and its rail read the window's stored row", async () => {
    const sqlite = fixture();
    const eras = buildEraIndex([{ id: "glm1", vendor: "glm", home: "machine-a" }]);
    probe(sqlite, { id: 1, provider: "glm", subject: "glm1", ts: "2026-08-10T00:30:00Z", kind: "weekly", group: "glm", used: 5, reset: "2026-08-17T00:00:00Z" });
    probe(sqlite, { id: 2, provider: "glm", subject: "glm1", ts: "2026-08-10T03:00:00Z", kind: "weekly", group: "glm", used: 25, reset: "2026-08-17T00:00:00Z" });
    for (const [id, ts] of [[1, "2026-08-10T01:00:00Z"], [2, "2026-08-10T02:00:00Z"], [3, "2026-08-12T00:00:00Z"]] as const)
      sqlite.run(`INSERT INTO oc_events (id, store, message_id, ts, model, provider, in_tok, out_tok, reasoning, cache_read, cache_write)
        VALUES (?, 'machine-a', ?, ?, 'glm-4', 'zai-coding-plan', 10, 5, 0, 0, 0)`, [id, `message-${id}`, ts]);
    const ctx = context(sqlite, eras);
    const report = buildSubscriptionAccountingReport(ctx, "glm", options("glm1"));
    expect(report.windows).toHaveLength(1);
    // Paired from the reset to the last reading; the call after it is unpaired.
    expect(report.windows![0]).toMatchObject({ usage: { events: 2, tokens: 30 }, cycle_usage: { events: 3, tokens: 45 }, unpaired_events: 1 });
    const apiContext = { ...ctx, claudeGauge: {}, grokGauge: {}, cycles: { windows: [] }, homeToSubId: new Map(), subIdToHomes: new Map(),
      rootDir: "", homeConflict: null, eraErrors: [] } as unknown as AppContext;
    const rail = (await (await apiHandleWindows(apiContext, new URL("http://localhost/api/windows?account=glm1"))).json() as
      { windows: Array<{ windowId?: string; activityShape: Array<{ t: number; amount: number }> | null; trafficByMachine: Array<{ amount: number }>;
        tokensTotal: number | null }> }).windows;
    const window = rail.find(row => row.windowId === report.windows![0]!.id)!;
    // Measured rails keep no token total; their curve and machine split are the stored row's.
    expect(window.tokensTotal).toBeNull();
    expect(window.activityShape?.at(-1)).toEqual({ t: 100, amount: 45 });
    expect(window.trafficByMachine.reduce((sum, row) => sum + row.amount, 0)).toBe(45);
  });

  test("Grok traffic without a reset anchor is not presented as a reset cycle", () => {
    const sqlite = fixture();
    probe(sqlite, { id: 1, provider: "grok", subject: "grok1", ts: "2026-08-10T05:00:00Z", kind: "weekly", group: "subscription", used: 30, reset: null });
    sqlite.run(`INSERT INTO grok_events (id, store, session_id, prompt_id, ts, model, in_tok, cached_in, cache_write, out_tok, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [1, "grok1", "session", "prompt", "2026-08-10T06:00:00Z", "grok-3", 10, 2, 3, 4, 1]);

    const report = buildSubscriptionAccountingReport(context(sqlite), "grok", options("grok1"));
    expect(report.events).toBe(1);
    expect(report.tokens).toBe(17);
    expect(report.windows).toEqual([]);
    expect(report.provider?.counter_reason).toBe("The meter has no reset anchors. Sliding-window readings cannot be treated as cumulative reset cycles.");
  });

  test("Claude prices the inclusive until day with the old rate and applies after only on the next day", () => {
    const sqlite = fixture();
    for (const [id, day] of [[1, "2026-08-10"], [2, "2026-08-11"], [3, "2026-08-12"]] as const) {
      claude(sqlite, { id, store: "claude-main", call: `dated-${id}`, ts: `${day}T01:00:00Z`, fresh: MILLION });
    }
    const report = buildSubscriptionAccountingReport(context(sqlite), "claude", options("claude1", "2026-08-10", "2026-08-12"));
    expect(report.amounts.api_equivalent_usd).toMatchObject({ status: "complete", value: 12, priced_subtotal: 12 });
    expect(report.normalization.standard_api_usd.value).toBe(12);
    expect(report.model_details.find((detail) => detail.day === "2026-08-10")?.rates.in_uncached).toBe(1);
    expect(report.model_details.find((detail) => detail.day === "2026-08-11")?.rates.in_uncached).toBe(1);
    expect(report.model_details.find((detail) => detail.day === "2026-08-12")?.rates.in_uncached).toBe(10);
  });
});

test("prepared subscription numeric traffic and exact window usage survive percentage edits without decoding events",()=>{
  const db=fixture(),ctx=context(db),opts=options('claude1');
  for(let id=1;id<=20;id++)claude(db,{id,store:'pc',call:`call-${id}`,ts:`2026-08-10T11:${String(id).padStart(2,'0')}:00Z`,fresh:1000});
  probe(db,{id:1,provider:'claude',subject:'claude1',ts:'2026-08-10T10:00:00Z',kind:'weekly_all',used:20,reset:'2026-08-17T00:00:00Z'});
  probe(db,{id:2,provider:'claude',subject:'claude1',ts:'2026-08-10T12:00:00Z',kind:'weekly_all',used:30,reset:'2026-08-17T00:00:00Z'});
  createAnalysisSourceRevisions(db);installAnalysisTracking(db);
  finishRegister(db,"claude",undefined,7);
  const first=buildSubscriptionAccountingReport(ctx,'claude',opts);
  expect(first.tokens).toBe(20000);expect(first.windows![0]!.observed_pp).toBe(30);
  db.exec("UPDATE probe_windows SET used_percent=35 WHERE id=2");
  prepareProbeProjection(db, "claude");
  let factReads=0;
  const query=db.query.bind(db);
  const spy=spyOn(db,'query').mockImplementation(((sql:string)=>{
    if(/SELECT.*(?:FROM usage_ledger_facts|FROM claude_events)/s.test(sql))factReads++;
    return query(sql);
  }) as typeof db.query);
  try {
    const next=readSubscriptionAccountingReport(ctx,'claude',opts);
    expect(next.tokens).toBe(20000);expect(next.windows![0]!.usage.tokens).toBe(20000);expect(next.windows![0]!.observed_pp).toBe(35);
    expect(factReads).toBe(0);
  } finally {spy.mockRestore();}
  claude(db,{id:21,store:'copy',call:'call-1',ts:'2026-08-11T11:01:00Z',fresh:2000});
  finishRegister(db);
  const conflicted=buildSubscriptionAccountingReport(ctx,'claude',opts);
  expect(conflicted.tokens).toBe(19000);expect(conflicted.windows![0]!.usage.tokens).toBe(19000);
  db.exec('DELETE FROM claude_events WHERE id=21');
  finishRegister(db);
  expect(buildSubscriptionAccountingReport(ctx,'claude',opts).tokens).toBe(20000);
});

/** The ledger in small batches, so a fill crosses several bounded steps. */
function finishFacts(db: Database, provider: UsageLedgerProvider = "claude", limit = 7,
  eras?: AccountingContext["eras"]) {
  finishRegister(db, provider, eras, limit);
}

function cloneEvents(source: Database): Database {
  const sqlite = fixture();
  for (const table of ["probe_windows", "claude_events", "gemini_events", "grok_events", "oc_events"] as const) {
    const rows = source.query(`SELECT * FROM ${table}`).all() as Record<string, string | number | null>[];
    if (!rows.length) continue;
    // Columns a fixture added to the source (rules.fixture.ts) are added to the clone too.
    const have = new Set((sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
    for (const column of Object.keys(rows[0]!)) if (!have.has(column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    const cols = Object.keys(rows[0]!);
    const insert = sqlite.query(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
    for (const row of rows) insert.run(...cols.map(c => row[c] ?? null));
  }
  return sqlite;
}

function numeric(report: ReturnType<typeof buildSubscriptionAccountingReport>) {
  return {
    events: report.events,
    tokens: report.tokens,
    excluded: report.excluded_mirror_events,
    amount: report.amounts.api_equivalent_usd,
    standard: report.normalization.standard_api_usd,
    windowTokens: report.windows?.map(w => w.usage.tokens) ?? null,
  };
}

function enablePrepared(db: Database) {
  createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
}

/**
 * A report from a fresh ledger fill of the same events. With `register` false the report takes its
 * per-event path (the ledger's stored valuations summed event by event) instead of the day rows.
 */
function freshIndexedReport(source: Database, provider: string, opts: SubscriptionAccountingOptions,
  eras?: AccountingContext["eras"], register = true) {
  const sqlite = cloneEvents(source);
  enablePrepared(sqlite);
  finishFacts(sqlite, provider as UsageLedgerProvider, 7, eras);
  if (register) return buildSubscriptionAccountingReport(context(sqlite, eras), provider, opts);
  const absent = spyOn(readiness, "subscriptionUsagePriceReadiness")
    .mockImplementation(() => ({ state: "absent", head: null, reason: "usage-price-register-absent" }));
  try { return buildSubscriptionAccountingReport(context(sqlite, eras), provider, opts); }
  finally { absent.mockRestore(); }
}

test("incremental prepared accounting matches a fresh index and hand-computed tokens after late conflict, delete, move and project change", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "subscription-accounting-"));
  const file = join(dir, "db.sqlite");
  let db = fixture(file);
  const opts = options("claude1");
  const usd = (tokens: number) => tokens / MILLION;
  try {
    claude(db, { id: 1, store: "pc", call: "keep", ts: "2026-08-10T11:00:00Z", fresh: 1000, project: "core" });
    claude(db, { id: 2, store: "pc", call: "move", ts: "2026-08-10T12:00:00Z", fresh: 2000, model: "claude-new-model", project: "core" });
    claude(db, { id: 3, store: "pc", call: "project-a", ts: "2026-08-10T13:00:00Z", fresh: 4000, project: "project-a" });
    probe(db, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T10:00:00Z", kind: "weekly_all", used: 10, reset: "2026-08-17T00:00:00Z" });
    probe(db, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-10T14:00:00Z", kind: "weekly_all", used: 20, reset: "2026-08-17T00:00:00Z" });
    enablePrepared(db);
    finishFacts(db);
    finishRegister(db);
    const baseline = buildSubscriptionAccountingReport(context(db), "claude", opts);
    expect(baseline.events).toBe(3);
    expect(baseline.tokens).toBe(7000);
    expect(baseline.amounts.api_equivalent_usd).toMatchObject({
      status: "partial", value: null, priced_subtotal: usd(5000), priced_events: 2, unpriced_events: 1,
      priced_tokens: 5000, unpriced_tokens: 2000,
    });
    expect(numeric(baseline)).toEqual(numeric(freshIndexedReport(db, "claude", opts)));

    claude(db, { id: 4, store: "copy", call: "keep", ts: "2026-09-20T11:00:00Z", fresh: 9000 });
    finishFacts(db);
    finishRegister(db);
    const conflicted = buildSubscriptionAccountingReport(context(db), "claude", opts);
    expect(conflicted.events).toBe(2);
    expect(conflicted.tokens).toBe(6000);
    expect(conflicted.amounts.api_equivalent_usd).toMatchObject({
      status: "partial", value: null, priced_subtotal: usd(4000), priced_events: 1, unpriced_events: 1,
      priced_tokens: 4000, unpriced_tokens: 2000,
    });
    expect(conflicted.windows![0]!.usage.tokens).toBe(6000);
    expect(conflicted.limitations.some(note => note.includes("conflicting duplicate"))).toBe(true);
    expect(numeric(conflicted)).toEqual(numeric(freshIndexedReport(db, "claude", opts)));

    db.exec("DELETE FROM claude_events WHERE id=4");
    finishFacts(db);
    finishRegister(db);
    const restored = buildSubscriptionAccountingReport(context(db), "claude", opts);
    expect(restored.tokens).toBe(7000);
    expect(restored.amounts.api_equivalent_usd.priced_subtotal).toBe(usd(5000));
    expect(numeric(restored)).toEqual(numeric(freshIndexedReport(db, "claude", opts)));

    db.exec("UPDATE claude_events SET ts='2026-08-12T12:00:00Z' WHERE id=2");
    finishFacts(db);
    finishRegister(db);
    const moved = buildSubscriptionAccountingReport(context(db), "claude", opts);
    expect(moved.tokens).toBe(7000);
    expect(buildSubscriptionAccountingReport(context(db), "claude", options("claude1", "2026-08-10", "2026-08-10")).tokens).toBe(5000);
    expect(buildSubscriptionAccountingReport(context(db), "claude", options("claude1", "2026-08-12", "2026-08-12")).tokens).toBe(2000);
    expect(numeric(moved)).toEqual(numeric(freshIndexedReport(db, "claude", opts)));

    db.exec("UPDATE claude_events SET project_id='project-b' WHERE id=3");
    finishFacts(db);
    finishRegister(db);
    const reassigned = buildSubscriptionAccountingReport(context(db), "claude", opts);
    expect(reassigned.tokens).toBe(7000);
    expect(buildSubscriptionAccountingReport(context(db), "claude", options("claude1", "2026-08-10", "2026-08-16", "project-a")).tokens).toBe(0);
    expect(buildSubscriptionAccountingReport(context(db), "claude", options("claude1", "2026-08-10", "2026-08-16", "project-b")).tokens).toBe(4000);
    expect(numeric(reassigned)).toEqual(numeric(freshIndexedReport(db, "claude", opts)));

    claude(db, { id: 5, store: "mirror", call: "project-a", ts: "2026-08-10T13:00:00Z", fresh: 4000, project: "project-a" });
    finishFacts(db);
    finishRegister(db);
    const mirrored = buildSubscriptionAccountingReport(context(db), "claude", opts);
    expect(mirrored.events).toBe(3);
    expect(mirrored.tokens).toBe(7000);
    expect(mirrored.excluded_mirror_events).toBe(1);
    expect(buildSubscriptionAccountingReport(context(db), "claude", options("claude1", "2026-08-10", "2026-08-16", "project-a")).tokens
      + buildSubscriptionAccountingReport(context(db), "claude", options("claude1", "2026-08-10", "2026-08-16", "project-b")).tokens).toBe(4000);
    expect(numeric(mirrored)).toEqual(numeric(freshIndexedReport(db, "claude", opts)));

    // A percentage edit neither revalues nor republishes the ledger.
    const valuations = () => db.query(`SELECT row_id,copy_state,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto,glb_usd,glb_nano,glb_femto
      FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all();
    const beforeGauge = valuations(), revision = usageLedgerState(db, "claude")!.revision;
    db.exec("UPDATE probe_windows SET used_percent=25 WHERE id=2");
    const gauged = buildSubscriptionAccountingReport(context(db), "claude", opts);
    expect(gauged.tokens).toBe(7000);
    expect(gauged.windows![0]!.observed_pp).toBe(25);
    expect(valuations()).toEqual(beforeGauge);
    expect(usageLedgerState(db, "claude")!.revision).toBe(revision);

    expect(stepUsageLedger(db,"claude",rates,ARCHIVE_LOGICAL_ROOT)).toEqual({ complete: true, processed: 0 });
    db.close();
    db = new Database(file);
    dbs.push(db);
    expect(stepUsageLedger(db,"claude",rates,ARCHIVE_LOGICAL_ROOT)).toEqual({ complete: true, processed: 0 });
    expect(valuations()).toEqual(beforeGauge);
    const restarted = buildSubscriptionAccountingReport(context(db), "claude", opts);
    expect(restarted.tokens).toBe(7000);
    expect(restarted.amounts.api_equivalent_usd.priced_subtotal).toBe(usd(5000));
    expect(restarted.windows![0]!.observed_pp).toBe(25);
    expect(numeric(restarted)).toEqual(numeric(freshIndexedReport(db, "claude", opts)));
  } finally {
    for (const sqlite of dbs.splice(0)) {
      try { sqlite.close(); } catch { /* already closed for restart */ }
    }
    Bun.gc(true);fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a settled ledger keeps one canonical copy per identity and serves repeated reads without repricing", () => {
  const db = fixture(), opts = options("claude1");
  claude(db, { id: 1, store: "pc", call: "keep", ts: "2026-08-10T11:00:00.000Z", fresh: 1000, project: "core" });
  claude(db, { id: 2, store: "copy", call: "dup", ts: "2026-08-10T12:00:00Z", fresh: 2000, project: "core" });
  claude(db, { id: 3, store: "copy", call: "dup", ts: "2026-08-10T12:00:00.000Z", fresh: 2000, project: "core" });
  enablePrepared(db);
  const compute = () => buildSubscriptionAccountingReport(context(db), "claude", opts);
  const first = compute();
  expect(first.events).toBe(2);
  expect(first.tokens).toBe(3000);
  expect(first.excluded_mirror_events).toBe(1);
  expect(first.amounts.api_equivalent_usd).toMatchObject({
    status: "complete", value: 0.003, priced_events: 2, priced_tokens: 3000,
  });
  const valuations = () => db.query(`SELECT row_id,copy_state,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto,glb_usd,glb_nano,glb_femto
    FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all();
  const before = valuations(), revision = usageLedgerState(db, "claude")!.revision;
  expect((before as Array<{ copy_state: string }>).map(row => row.copy_state)).toEqual(["canonical", "canonical", "duplicate"]);

  expect(stepUsageLedger(db, "claude", rates, ARCHIVE_LOGICAL_ROOT)).toEqual({ complete: true, processed: 0 });
  const again = compute();
  expect(again.events).toBe(2);
  expect(again.tokens).toBe(3000);
  expect(again.excluded_mirror_events).toBe(1);
  expect(again.amounts.api_equivalent_usd.value).toBe(0.003);
  expect(valuations()).toEqual(before);
  expect(usageLedgerState(db, "claude")!.revision).toBe(revision);
});
/* ------------------------------------------------------------------------------------- */
/* WP4d: the aggregate sections read the usage ledger's day rows.                         */
/* ------------------------------------------------------------------------------------- */

type Report = ReturnType<typeof buildSubscriptionAccountingReport>;

/**
 * Everything the aggregate sections publish, in a stable order. `breakdown` and
 * `model_details` are sorted because the register groups by dimension while the
 * pre-register path grouped in first-event order; the rows themselves must match.
 */
function canonical(report: Report) {
  const sortBy = <T>(rows: readonly T[], key: (row: T) => string) =>
    [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  return {
    events: report.events, tokens: report.tokens,
    known_speed_events: report.known_speed_events, known_speed_tokens: report.known_speed_tokens,
    unknown_speed_events: report.unknown_speed_events, unknown_speed_tokens: report.unknown_speed_tokens,
    source_home_count: report.source_home_count,
    amounts: report.amounts, normalization: report.normalization,
    counter_reason: report.provider?.counter_reason ?? null,
    limitations: report.limitations,
    breakdown: sortBy(report.breakdown, row => JSON.stringify([row.day, row.model, row.speed, row.home])),
    traffic_periods: sortBy(report.traffic_periods ?? [], row => row.start),
    model_details: sortBy(report.model_details ?? [], row => JSON.stringify([row.day, row.model, row.speed, row.source])),
    windows: (report.windows ?? []).map(window => ({ id: window.id, start: window.start, end: window.end,
      usage: window.usage, cycle_usage: window.cycle_usage, models: window.models, sources: window.sources })),
  };
}

/** The same events in a fresh ledger, read through the per-event path and through the day rows. */
function beforeAndAfter(source: Database, provider: string, opts: SubscriptionAccountingOptions,
  eras?: AccountingContext["eras"]) {
  return {
    before: freshIndexedReport(source, provider, opts, eras, false),
    after: freshIndexedReport(source, provider, opts, eras, true),
  };
}

function goldenFixture(): Database {
  const sqlite = fixture();
  probe(sqlite, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T00:00:00Z", kind: "weekly_all", used: 0, reset: "2026-08-17T00:00:00Z" });
  probe(sqlite, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-12T00:00:00Z", kind: "weekly_all", used: 40, reset: "2026-08-17T00:00:00Z" });
  probe(sqlite, { id: 3, provider: "gemini", subject: "gem1", ts: "2026-08-10T00:00:00Z", kind: "weekly", group: "gemini", used: 0, reset: "2026-08-17T00:00:00Z" });
  probe(sqlite, { id: 4, provider: "gemini", subject: "gem1", ts: "2026-08-12T00:00:00Z", kind: "weekly", group: "gemini", used: 30, reset: "2026-08-17T00:00:00Z" });
  probe(sqlite, { id: 5, provider: "grok", subject: "grok1", ts: "2026-08-10T00:00:00Z", kind: "weekly", group: "subscription", used: 0, reset: "2026-08-17T00:00:00Z" });
  probe(sqlite, { id: 6, provider: "grok", subject: "grok1", ts: "2026-08-12T00:00:00Z", kind: "weekly", group: "subscription", used: 20, reset: "2026-08-17T00:00:00Z" });
  // Cache writes stay fully split into 5m/1h so every bucket has a configured rate.
  const split = { write: 7 * MILLION, write5: 3 * MILLION, write1: 4 * MILLION };
  claude(sqlite, { id: 1, store: "pc-a", call: "std-a", ts: "2026-08-10T01:00:00Z", speed: "standard", project: "project-a", fresh: MILLION, cached: 2 * MILLION, ...split, output: 5 * MILLION, thinking: MILLION });
  claude(sqlite, { id: 2, store: "pc-b", call: "std-a", ts: "2026-08-10T01:00:00Z", speed: "standard", project: "project-a", fresh: MILLION, cached: 2 * MILLION, ...split, output: 5 * MILLION, thinking: MILLION });
  claude(sqlite, { id: 3, store: "pc-a", call: "fast-a", ts: "2026-08-10T02:00:00Z", speed: "fast", project: "project-a", fresh: 2 * MILLION });
  claude(sqlite, { id: 4, store: "pc-b", call: "unknown-a", ts: "2026-08-11T03:00:00Z", speed: null, project: "project-b", fresh: 3 * MILLION });
  claude(sqlite, { id: 5, store: "pc-a", call: "unpriced", ts: "2026-08-11T04:00:00Z", speed: "standard", model: "claude-new-model", project: "project-b", fresh: 4 * MILLION });
  claude(sqlite, { id: 6, store: "pc-a", call: "conflict", ts: "2026-08-12T05:00:00Z", speed: "standard", project: "project-a", fresh: 5 * MILLION });
  claude(sqlite, { id: 7, store: "pc-b", call: "conflict", ts: "2026-08-12T05:00:00Z", speed: "standard", project: "project-a", fresh: 6 * MILLION });
  claude(sqlite, { id: 8, store: "pc-a", call: "foreign", ts: "2026-08-12T06:00:00Z", account: "other-account", fresh: MILLION });
  for (const [id, conversation, ts, basis, fresh, project] of [
    [1, "chat-1", "2026-08-10T01:00:00Z", "conversation", 10, "project-a"],
    [2, "chat-2", "2026-08-11T02:00:00Z", "event", 20, "project-b"],
    [3, "chat-3", "2026-08-12T03:00:00Z", "event", 30, "project-a"],
  ] as const) {
    sqlite.run(`INSERT INTO gemini_events (id, store, conversation_id, gen_idx, ts, ts_basis, model, project_id, fresh_in, cached_in, out_total, out_thinking)
      VALUES (?, 'gem1', ?, 0, ?, ?, 'gemini-2.5-pro', ?, ?, ?, ?, ?)`, [id, conversation, ts, basis, project, fresh, fresh, fresh * 2, fresh]);
  }
  for (const [id, prompt, ts, tokens, project] of [
    [1, "p1", "2026-08-10T06:00:00Z", 10, "project-a"],
    [2, "p2", "2026-08-11T07:00:00Z", 20, "project-b"],
  ] as const) {
    sqlite.run(`INSERT INTO grok_events (id, store, session_id, prompt_id, ts, model, project_id, in_tok, cached_in, cache_write, out_tok, reasoning)
      VALUES (?, 'grok1', 'session', ?, ?, 'grok-3', ?, ?, ?, ?, ?, ?)`, [id, prompt, ts, project, tokens, 2, 3, 4, 1]);
  }
  for (const [id, message, ts, tokens, project] of [
    [1, "m1", "2026-08-10T08:00:00Z", 10, "project-a"],
    [2, "m2", "2026-08-11T09:00:00Z", 20, "project-b"],
  ] as const) {
    sqlite.run(`INSERT INTO oc_events (id, store, message_id, ts, model, provider, project_id, in_tok, out_tok, reasoning, cache_read, cache_write)
      VALUES (?, 'machine-a', ?, ?, 'glm-4', 'zai-coding-plan', ?, ?, ?, ?, ?, ?)`, [id, message, ts, project, tokens, 7, 2, 3, 4]);
  }
  return sqlite;
}

const glmEras = () => buildEraIndex([{ id: "glm1", vendor: "glm", home: "machine-a" }]);

describe("WP4d ledger-backed subscription accounting", () => {
  const cases = [
    { provider: "claude", account: "claude1" },
    { provider: "gemini", account: "gem1" },
    { provider: "grok", account: "grok1" },
    { provider: "glm", account: "glm1" },
  ] as const;

  for (const { provider, account } of cases) {
    for (const project of [undefined, "project-a"] as const) {
      test(`golden sample: ${provider}${project ? " with a project filter" : ""} is identical from per-event valuations and from the ledger's day rows`, () => {
        const source = goldenFixture();
        const eras = provider === "glm" ? glmEras() : undefined;
        const opts = options(account, "2026-08-10", "2026-08-13", project);
        const { before, after } = beforeAndAfter(source, provider, opts, eras);
        expect(canonical(after)).toEqual(canonical(before));
      });
    }
  }

  test("duplicates and conflicts come from the register's quality counters", () => {
    const source = goldenFixture();
    const opts = options("claude1", "2026-08-10", "2026-08-13");
    const { before, after } = beforeAndAfter(source, "claude", opts);
    // One accepted duplicate copy (std-a) and one conflicting identity (conflict).
    expect(before.excluded_mirror_events).toBe(2);
    expect(after.excluded_mirror_events).toBe(1);
    const conflictNote = (report: Report) => report.limitations.find(note => note.includes("conflicting duplicate"));
    expect(conflictNote(before)).toBe("1 conflicting duplicate event identities excluded.");
    expect(conflictNote(after)).toBe(conflictNote(before));
    // Both exclude the conflicting identity's tokens from every aggregate.
    expect(after.events).toBe(before.events);
    expect(after.tokens).toBe(before.tokens);
  });

  test("a conflicting identity spanning two days is still reported once", () => {
    const source = fixture();
    claude(source, { id: 1, store: "pc-a", call: "split", ts: "2026-08-10T01:00:00Z", fresh: MILLION });
    claude(source, { id: 2, store: "pc-b", call: "split", ts: "2026-08-11T01:00:00Z", fresh: 2 * MILLION });
    const opts = options("claude1", "2026-08-10", "2026-08-11");
    const { before, after } = beforeAndAfter(source, "claude", opts);
    // Both exclude the identity from every measured aggregate.
    expect(before.tokens).toBe(0);
    expect(after.tokens).toBe(0);
    const note = (report: Report) => report.limitations.find(line => line.includes("conflicting duplicate"));
    expect(note(after)).toBe("1 conflicting duplicate event identities excluded.");
    expect(note(after)).toBe(note(before));
  });

  test("a partially rated event keeps its computable subtotal out of the priced subtotal", () => {
    const source = fixture();
    // `in_cache_write_unknown` has no configured rate, so this event is unpriced overall
    // while its other buckets are computable. Only fully priced events reach the subtotal.
    claude(source, { id: 1, store: "pc-a", call: "partial", ts: "2026-08-10T01:00:00Z", fresh: MILLION, write: 2 * MILLION, write5: MILLION });
    const opts = options("claude1", "2026-08-10", "2026-08-10");
    const { before, after } = beforeAndAfter(source, "claude", opts);
    expect(canonical(after)).toEqual(canonical(before));
    expect(after.normalization.standard_api_usd).toMatchObject({ status: "unpriced", value: null,
      priced_subtotal: 0, unpriced_events: 1, priced_events: 0 });
  });

  test("a meter interval crossing midnight keeps its exact bounds while the day sums stay whole", () => {
    const source = fixture();
    probe(source, { id: 1, provider: "claude", subject: "claude1", ts: "2026-08-10T22:00:00Z", kind: "weekly_all", used: 10, reset: "2026-08-17T00:00:00Z" });
    probe(source, { id: 2, provider: "claude", subject: "claude1", ts: "2026-08-11T02:00:00Z", kind: "weekly_all", used: 30, reset: "2026-08-17T00:00:00Z" });
    claude(source, { id: 1, store: "pc-a", call: "before", ts: "2026-08-10T21:00:00Z", fresh: MILLION });
    claude(source, { id: 2, store: "pc-a", call: "inside-first", ts: "2026-08-10T23:30:00Z", fresh: 2 * MILLION });
    claude(source, { id: 3, store: "pc-a", call: "inside-second", ts: "2026-08-11T00:30:00Z", fresh: 4 * MILLION });
    claude(source, { id: 4, store: "pc-a", call: "after", ts: "2026-08-11T03:00:00Z", fresh: 8 * MILLION });
    const opts = options("claude1", "2026-08-10", "2026-08-11");
    const { before, after } = beforeAndAfter(source, "claude", opts);
    expect(canonical(after)).toEqual(canonical(before));
    expect(after.tokens).toBe(15 * MILLION);
    // The cycle starts at the scheduled reset, not at midnight; the traffic days stay whole.
    expect(after.windows![0]!.usage.tokens).toBe(7 * MILLION);
    expect(after.traffic_periods.map(period => [period.start, period.tokens]))
      .toEqual([["2026-08-10T00:00:00.000Z", 3 * MILLION], ["2026-08-11T00:00:00.000Z", 12 * MILLION]]);
  });

  test("a published register behind its facts answers from its rows; an unpublished one is an explicit preparation state", () => {
    const db = goldenFixture();
    enablePrepared(db);
    finishFacts(db);
    finishRegister(db);
    const opts = options("claude1", "2026-08-10", "2026-08-13");
    expect(buildSubscriptionAccountingReport(context(db), "claude", opts).events).toBeGreaterThan(0);
    const published = buildSubscriptionAccountingReport(context(db), "claude", opts).events;
    db.exec("UPDATE usage_ledger_state SET status='pending' WHERE provider='claude'");
    expect(readSubscriptionAccountingReport(context(db), "claude", opts).events).toBe(published);
    db.exec("UPDATE usage_ledger_state SET published_revision=0 WHERE provider='claude'");
    // Read without the producer step the wrapper runs; the producer would settle the state.
    expect(() => readSubscriptionAccountingReport(context(db), "claude", opts)).toThrow("awaiting background preparation");
  });

  test("a rate card change is pending until the register rewalks its dated rules", () => {
    const db = goldenFixture();
    enablePrepared(db);
    finishFacts(db);
    finishRegister(db);
    const opts = options("claude1", "2026-08-10", "2026-08-13");
    const changed = structuredClone(rates);
    changed.vendors.anthropic!.models!["claude-3-sonnet"]!.in_uncached = 7;
    const ctx = { ...context(db), rateCards: changed };
    expect(() => buildSubscriptionAccountingReport(ctx, "claude", opts)).toThrow("usage-price-rules-pending");
  });
});
