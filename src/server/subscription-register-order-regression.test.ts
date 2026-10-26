import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import { installAnalysisTracking } from "../db/analysis";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { buildAccountResolver } from "./account-resolver";
import * as readiness from "../db/usage-price-read-subscription";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import { buildSubscriptionAccountingReport } from "./subscription-accounting";
import type { SubscriptionAccountingOptions } from "../shared/subscription-accounting";
import type { RateCard } from "./pricing";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

const rates: RateCard = {
  version: 1,
  currency: "USD",
  unit: "per 1M",
  vendors: {
    anthropic: {
      source: "fixture",
      models: {
        "a-model": { in_uncached: 1, in_cache_read: 1, in_cache_write_5m: 1, in_cache_write_1h: 1, out_total: 1 },
        "z-model": { in_uncached: 2, in_cache_read: 2, in_cache_write_5m: 2, in_cache_write_1h: 2, out_total: 2 },
      },
    },
  },
};

type Context = Parameters<typeof buildSubscriptionAccountingReport>[0];

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE probe_windows(
      id INTEGER PRIMARY KEY,provider TEXT NOT NULL,subject TEXT NOT NULL,ts TEXT NOT NULL,
      plan TEXT,kind TEXT NOT NULL,limit_group TEXT,used_percent REAL,resets_at TEXT,
      window_minutes INTEGER,ok INTEGER DEFAULT 1
    );
    CREATE TABLE claude_events(
      id INTEGER PRIMARY KEY,store TEXT NOT NULL,call_id TEXT NOT NULL,ts TEXT NOT NULL,path TEXT,
      subscription_id TEXT,subscription_conflict INTEGER DEFAULT 0,model TEXT,speed TEXT,project_id TEXT,
      in_uncached INTEGER DEFAULT 0,in_cache_read INTEGER DEFAULT 0,in_cache_write INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0,cache_write_1h INTEGER DEFAULT 0,out_total INTEGER DEFAULT 0,
      out_thinking INTEGER DEFAULT 0
    );`);
  const insert = db.prepare(`INSERT INTO claude_events(
      id,store,call_id,ts,path,subscription_id,model,speed,project_id,in_uncached
    ) VALUES(?,?,?,?,?,'seat',?,'standard','project',?)`);
  // The legacy fact path preserves event time order. Model order is deliberately the reverse,
  // so a reader-side sort cannot accidentally satisfy the assertion below.
  insert.run(1, "z-home", "first", "2026-08-10T01:00:00Z", `${ARCHIVE_LOGICAL_ROOT}/claude/z-home/history.jsonl`, "z-model", 100);
  insert.run(2, "a-home", "second", "2026-08-10T02:00:00Z", `${ARCHIVE_LOGICAL_ROOT}/claude/a-home/history.jsonl`, "a-model", 200);
  createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  return db;
}

function context(sqlite: Database): Context {
  return {
    sqlite,
    rateCards: rates,
    plans: { segments: [], capacity_regimes: [] },
    plansCatalog: { provider_groups: [] },
    manualCapacity: [],
    resolver: buildAccountResolver(["z-home","a-home"].map(source=>({provider:"claude",subject:`claude/${source}`,
      from:"2000-01-01",until:null,value:"seat",origin:"declared",firstSeen:null,lastSeen:null,readings:0,evidence:"fixture"})),[]),
  };
}

/** The usage ledger in small batches, as the background producer fills it. */
function finishFacts(db: Database): void {
  fillUsageLedger(db, "claude", rates, ARCHIVE_LOGICAL_ROOT, 5);
}

function finishProbeIndex(db: Database): void {
  // This order regression has no probe rows; an empty but settled current index is the evidence.
  prepareProbeReaderFixture(db, []);
}

/** The report's per-event path: the ledger's events summed one by one instead of its day rows. */
function eventPathReport(db: Database, options: SubscriptionAccountingOptions) {
  const absent = spyOn(readiness, "subscriptionUsagePriceReadiness")
    .mockImplementation(() => ({ state: "absent", head: null, reason: "usage-price-register-absent" }));
  try { return buildSubscriptionAccountingReport(context(db), "claude", options); }
  finally { absent.mockRestore(); }
}

const reportOptions: SubscriptionAccountingOptions = {
  account: "seat",
  since: "2026-08-10",
  until: "2026-08-10",
};

test("the ledger's day rows preserve the per-event path's row order", () => {
  const legacyDb = fixture();
  const registerDb = fixture();
  try {
    finishFacts(legacyDb);
    finishFacts(registerDb);
    finishProbeIndex(legacyDb);
    finishProbeIndex(registerDb);
    const before = eventPathReport(legacyDb, reportOptions);
    const after = buildSubscriptionAccountingReport(context(registerDb), "claude", reportOptions);

    const breakdownOrder = (report: typeof before) => report.breakdown
      .map(row => [row.day, row.model, row.speed, row.home]);
    const detailOrder = (report: typeof before) => (report.model_details ?? [])
      .map(row => [row.day, row.model, row.speed, row.source]);
    expect(breakdownOrder(before)).toEqual([
      ["2026-08-10", "z-model", "standard", "claude/z-home"],
      ["2026-08-10", "a-model", "standard", "claude/a-home"],
    ]);
    expect(breakdownOrder(after)).toEqual(breakdownOrder(before));
    expect(detailOrder(after)).toEqual(detailOrder(before));
  } finally {
    legacyDb.close();
    registerDb.close();
  }
});

/**
 * Two groups whose first events share an instant. The ledger's `source_key` is the source row id
 * as TEXT, so `"10"` precedes `"2"` and the ids below put the z-model group first even though its
 * id is numerically larger — an order no comparison of instants, models, speeds or homes can
 * reproduce. `usage_ledger_days.first_key` carries that key beside `first_ts`.
 */
function tiedFixture(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE probe_windows(
      id INTEGER PRIMARY KEY,provider TEXT NOT NULL,subject TEXT NOT NULL,ts TEXT NOT NULL,
      plan TEXT,kind TEXT NOT NULL,limit_group TEXT,used_percent REAL,resets_at TEXT,
      window_minutes INTEGER,ok INTEGER DEFAULT 1
    );
    CREATE TABLE claude_events(
      id INTEGER PRIMARY KEY,store TEXT NOT NULL,call_id TEXT NOT NULL,ts TEXT NOT NULL,path TEXT,
      subscription_id TEXT,subscription_conflict INTEGER DEFAULT 0,model TEXT,speed TEXT,project_id TEXT,
      in_uncached INTEGER DEFAULT 0,in_cache_read INTEGER DEFAULT 0,in_cache_write INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0,cache_write_1h INTEGER DEFAULT 0,out_total INTEGER DEFAULT 0,
      out_thinking INTEGER DEFAULT 0
    );`);
  const insert = db.prepare(`INSERT INTO claude_events(
      id,store,call_id,ts,path,subscription_id,model,speed,project_id,in_uncached
    ) VALUES(?,?,?,?,?,'seat',?,'standard','project',?)`);
  const tied = "2026-08-10T01:00:00Z";
  insert.run(2, "a-home", "a-first", tied, `${ARCHIVE_LOGICAL_ROOT}/claude/a-home/history.jsonl`, "a-model", 100);
  insert.run(10, "z-home", "z-first", tied, `${ARCHIVE_LOGICAL_ROOT}/claude/z-home/history.jsonl`, "z-model", 200);
  // Two later events of the a-model group, so deleting its earliest one leaves the group in
  // place and its `first_key` has to be re-derived rather than patched. Their ids are chosen so
  // that, among the survivors, the earliest instant and the smallest key belong to *different*
  // rows ("20" < "9"): taking the two as independent aggregates would then publish a pair no
  // event ever had.
  insert.run(9, "a-home", "a-second", "2026-08-10T05:00:00Z", `${ARCHIVE_LOGICAL_ROOT}/claude/a-home/history.jsonl`, "a-model", 50);
  insert.run(20, "a-home", "a-third", "2026-08-10T09:00:00Z", `${ARCHIVE_LOGICAL_ROOT}/claude/a-home/history.jsonl`, "a-model", 30);
  createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  return db;
}

test("groups whose first events share an instant keep the per-event path's order", () => {
  const legacyDb = tiedFixture();
  const registerDb = tiedFixture();
  try {
    finishFacts(legacyDb);
    finishFacts(registerDb);
    finishProbeIndex(legacyDb);
    finishProbeIndex(registerDb);
    const before = eventPathReport(legacyDb, reportOptions);
    const after = buildSubscriptionAccountingReport(context(registerDb), "claude", reportOptions);
    const order = (report: typeof before) => report.breakdown.map(row => [row.model, row.home]);
    // The tie is decided by the text order of the source row ids, not by the model name.
    expect(order(before)).toEqual([["z-model", "claude/z-home"], ["a-model", "claude/a-home"]]);
    expect(order(after)).toEqual(order(before));
  } finally {
    legacyDb.close();
    registerDb.close();
  }
});

test("deleting a group's earliest event re-derives first_key as a full rebuild would", () => {
  const incremental = tiedFixture();
  const reference = tiedFixture();
  try {
    finishFacts(incremental);
    finishProbeIndex(incremental);
    const published = (db: Database) => db.query(`SELECT m.model,d.first_ts,d.first_key,d.calls
      FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id
      WHERE d.provider='claude' ORDER BY m.model`).all();
    // The pair belongs to one event: the earliest one.
    expect(published(incremental)).toEqual([
      { model: "a-model", first_ts: "2026-08-10T01:00:00.000Z", first_key: "2", calls: 3 },
      { model: "z-model", first_ts: "2026-08-10T01:00:00.000Z", first_key: "10", calls: 1 },
    ]);
    // The a-model group loses the event that gave it its ordering pair; the later one remains.
    for (const db of [incremental, reference]) db.exec("DELETE FROM claude_events WHERE id=2");
    finishFacts(incremental);
    finishFacts(reference);
    finishProbeIndex(reference);
    // Incremental maintenance and a fresh build agree on the pair, not only on the instant.
    expect(published(incremental)).toEqual(published(reference));
    // The survivors are `9 @05:00` and `20 @09:00`: the pair is the earliest event's, `"9"`,
    // never the group's smallest key `"20"`.
    expect(published(incremental)).toEqual([
      { model: "a-model", first_ts: "2026-08-10T05:00:00.000Z", first_key: "9", calls: 2 },
      { model: "z-model", first_ts: "2026-08-10T01:00:00.000Z", first_key: "10", calls: 1 },
    ]);
    // And the report the two produce is the same report.
    expect(buildSubscriptionAccountingReport(context(incremental), "claude", reportOptions).breakdown)
      .toEqual(buildSubscriptionAccountingReport(context(reference), "claude", reportOptions).breakdown);
  } finally {
    incremental.close();
    reference.close();
  }
});
