import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { loadAccountResolver } from "./account-resolver";
import { test, expect } from "bun:test";
import { Database } from "../db/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { buildClaudeCodeCapacityReport, readClaudeCodeObservations, claudeCodeCapacitySummary, claudeCodeCapacitySummaryOrAbsent,
  mapClaudeCodeObservationsToWindows, selectClaudeCodeCapacityReport, type ClaudeCodeObservation } from "./claude-code-capacity";
import {
  classifyClaudeCodeEvent, cumulativeClaudeCodeEstimate, intervalClaudeCodeCapacity,
  mergeClaudeCodeProduct, CLAUDE_CODE_PRODUCT_RULE,
} from "../shared/claude-code-capacity";
import { encodeClaudeCodeProductShare, sameResetWindow } from "../providers/adapters/claude";
import { loadProbeLimitEvidence, probeLimitCounter, type ProbeLimitEvidence, type ProbeLimitWindow } from "./probe-limit-windows";
import { ProbeAccountIndexUnavailable, readPreparedProbeAccountingRevision } from "./current/probe-account-reader";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import type { RateCard } from "./pricing";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { WindowUsagePreparing } from "./window-usage";
import { measureAnalysis } from "./claude-code-capacity.fixture";

const dirs: string[] = [];
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), "claude-code-capacity-")); dirs.push(dir); return dir; }
function cleanup() { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }

// 1 USD per 1M input tokens keeps the API-equivalent arithmetic hand-checkable.
const CARDS = { version: 1, currency: "USD", unit: "per 1M", vendors: { anthropic: { source: "test", models: { "claude-sonnet": { in_uncached: 1, in_cache_read: 0, in_cache_write: 0, out_total: 0 } } } } } as unknown as RateCard;

function fixture(path = ":memory:"): Database {
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE claude_events(id INTEGER PRIMARY KEY AUTOINCREMENT,store TEXT,call_id TEXT,ts TEXT,model TEXT,
      entrypoint TEXT,cc_version TEXT,path TEXT,project_id TEXT,subscription_id TEXT,subscription_conflict INTEGER DEFAULT 0,
      in_uncached INTEGER DEFAULT 0,in_cache_read INTEGER DEFAULT 0,in_cache_write INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0,cache_write_1h INTEGER DEFAULT 0,out_total INTEGER DEFAULT 0,out_thinking INTEGER DEFAULT 0,speed TEXT);
    CREATE TABLE probe_windows(id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT,subject TEXT,ts TEXT,kind TEXT,scope TEXT,
      used_percent REAL,resets_at TEXT,extra TEXT);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE analysis_source_revisions(source TEXT,bucket TEXT,revision INTEGER,PRIMARY KEY(source,bucket));`);
  db.exec(`CREATE TABLE account_periods(id INTEGER PRIMARY KEY,provider TEXT,source TEXT,from_ts TEXT,until_ts TEXT,account TEXT,
    origin TEXT,first_seen TEXT,last_seen TEXT,readings INTEGER,evidence TEXT);
    INSERT INTO account_periods VALUES(1,'claude','claude/fixture','2020-01-01',NULL,'seat','declared',NULL,NULL,0,'fixture')`);
  installAnalysisTracking(db);
  return db;
}
let calls = 0;
function addEvent(db: Database, row: { ts: string; tokens: number; entrypoint?: string | null; cc_version?: string | null; store?: string; call_id?: string }): void {
  db.query(`INSERT INTO claude_events(store,call_id,ts,model,entrypoint,cc_version,subscription_id,in_uncached,speed,path)
    VALUES(?,?,?,'claude-sonnet',?,?,'seat',?, 'standard',?)`)
    .run(row.store ?? "live", row.call_id ?? `call-${++calls}`, row.ts, row.entrypoint ?? null, row.cc_version ?? null, row.tokens, `${ARCHIVE_LOGICAL_ROOT}/claude/fixture/events.jsonl`);
}
const WINDOW_START = "2026-09-10T00:00:00.000Z";
const RESET = "2026-09-17T00:00:00.000Z";
const probeSources = [{ id: "seat", vendor: "claude", machine: "FIXTURE", login: "fixture",
  home: `${ARCHIVE_LOGICAL_ROOT}/claude/fixture`, source_home: "C:/probe-fixtures/FIXTURE/.claude" }];
const prepareObservations = (db: Database) => prepareProbeReaderFixture(db, probeSources);
function addObservation(db: Database, row: { ts: string; used: number; sharePercent?: number | null; asOf?: string; reset?: string; scope?: string | null; windowStart?:string }): void {
  const extra = row.sharePercent == null ? null : JSON.stringify(encodeClaudeCodeProductShare({
    schema: 1, key: "claude_code", percent: row.sharePercent,
    as_of: row.asOf ?? row.ts, window_started_at: row.windowStart ?? WINDOW_START, display_name: "Claude Code",
  }));
  db.query("INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra) VALUES('claude','seat',?,'weekly_all',?,?,?,?)")
    .run(row.ts, row.scope ?? null, row.used, row.reset ?? RESET, extra);
  prepareObservations(db);
}
function prepared(db: Database, card: RateCard = CARDS): void {
  fillUsageLedger(db, "claude", card, ARCHIVE_LOGICAL_ROOT, 500);
  prepareObservations(db);
}
/** The maintenance worker publishes window sums between a test's writes and its reads. */
const build = (db: Database, options = {}) => {
  prepareWindowUsageFixture(db, { rateCards: CARDS, manualCapacity: () => [], claudeGauge: {}, cycles: { windows: [] } });
  return buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS }, options);
};

test("indexed observation mapping matches the first-match rule on shuffled counters and resets", () => {
  let seed = 0x91e2b3;
  const random = () => ((seed ^= seed << 13, seed ^= seed >>> 17, seed ^= seed << 5) >>> 0) / 0x1_0000_0000;
  const shuffle = <T>(items: T[]): T[] => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  };
  const windows: ProbeLimitWindow[] = [], samples: ProbeLimitEvidence["samples"] = [];
  const observations: ClaudeCodeObservation[] = [];
  const dayMs = 86_400_000, base = Date.parse("2026-09-06T11:00:00Z");
  for (let week = 0; week < 16; week++) for (const [groupIndex, group] of ["weekly", "alternate"].entries()) {
    const reset = new Date(base + week * 7 * dayMs).toISOString();
    const counter = JSON.stringify(["weekly_all", group, 10080]);
    for (let segment = 0; segment < 5; segment++) {
      const start = new Date(Date.parse(reset) - 7 * dayMs + segment * dayMs).toISOString();
      const end = new Date(Date.parse(start) + dayMs).toISOString();
      const ts = new Date(Date.parse(start) + 2 * 3_600_000 + groupIndex * 600_000).toISOString();
      windows.push({ id: JSON.stringify(["seat", counter, start]), account: "seat", counter, start, end,
        reset, cycle_end_basis: "uncertain", window_minutes: 10080, plan: null, plan_detail: null,
        declared_plan_meter_mismatch: false, readings: [], startDrop: null, endDrop: null });
      samples.push({ provider: "claude", subject: "seat", ts, kind: "weekly_all", scope: null,
        limit_group: group, window_minutes: 10080, resets_at: reset } as ProbeLimitEvidence["samples"][number]);
      observations.push({ account: "seat", counter: "weekly_all", window_id: null, collected_at: ts,
        as_of: ts, reset_at: reset } as ClaudeCodeObservation);
      if (segment === 2) observations.push({ account: "seat", counter: "weekly_all", window_id: null,
        collected_at: new Date(Date.parse(ts) + 60_000).toISOString(),
        as_of: new Date(Date.parse(ts) + 60_000).toISOString(), reset_at: reset } as ClaudeCodeObservation);
    }
  }
  const preciseStart = "2027-01-01T00:00:00.000123Z", preciseEnd = "2027-01-01T01:00:00.000Z";
  const preciseReset = "2027-01-08T00:00:00.000Z", preciseCounter = JSON.stringify(["weekly_all", "weekly", 10080]);
  windows.push({ id: "precise", account: "seat", counter: preciseCounter, start: preciseStart, end: preciseEnd,
    reset: preciseReset, cycle_end_basis: "uncertain", window_minutes: 10080, plan: null, plan_detail: null,
    declared_plan_meter_mismatch: false, readings: [], startDrop: null, endDrop: null });
  for (const ts of ["2027-01-01T00:00:00.000100Z", preciseStart]) {
    samples.push({ provider: "claude", subject: "seat", ts, kind: "weekly_all", scope: null,
      limit_group: "weekly", window_minutes: 10080, resets_at: preciseReset } as ProbeLimitEvidence["samples"][number]);
    observations.push({ account: "seat", counter: "weekly_all", window_id: null, collected_at: ts,
      as_of: ts, reset_at: preciseReset } as ClaudeCodeObservation);
  }
  const evidence: ProbeLimitEvidence = { samples: shuffle(samples), revision: null };
  const shuffledWindows = shuffle(windows), shuffledObservations = shuffle(observations);
  const mapped = mapClaudeCodeObservationsToWindows(shuffledObservations, evidence, shuffledWindows, "seat", {});
  const compare = (left: string, right: string): number => {
    const milliseconds = Date.parse(left) - Date.parse(right);
    if (milliseconds) return milliseconds;
    const fraction = (value: string) => BigInt((/\.(\d+)Z$/.exec(value)?.[1] ?? "").padEnd(9, "0").slice(0, 9));
    return Number(fraction(left) - fraction(right));
  };
  const brute = shuffledObservations.map(observation => {
    const at = observation.as_of ?? observation.collected_at;
    const source = evidence.samples.find(sample => sample.kind === "weekly_all" && sample.scope == null && !sample.limitHit
      && compare(sample.ts, at) === 0 && sameResetWindow(sample.resets_at, observation.reset_at));
    const counter = source ? probeLimitCounter(source, "seat", {}) : null;
    return shuffledWindows.find(window => (counter === null || window.counter === counter)
      && sameResetWindow(window.reset, observation.reset_at)
      && compare(at, window.start) >= 0 && compare(at, window.end) < 0)?.id ?? null;
  });
  expect(mapped.map(observation => observation.window_id)).toEqual(brute);
  expect(mapped.find(observation => observation.as_of === preciseStart)?.window_id).toBe("precise");
  expect(mapped.find(observation => observation.as_of === "2027-01-01T00:00:00.000100Z")?.window_id).toBeNull();
});

test("the documented reference example is reproduced exactly", () => {
  const result = cumulativeClaudeCodeEstimate({ quantity: 120_000, sharePercent: 12, utilizationPercent: 24 });
  expect(result.account_total.value).toBe(1_000_000);
  expect(result.weekly_capacity.value).toBeCloseTo(4166666.666666667, 8);
});


test("every Claude subscription call counts as Code, whatever launched it", () => {
  expect(classifyClaudeCodeEvent()).toBe("code_cli");
  // Merging copies is order independent; positive evidence survives a copy that lacks it.
  expect(mergeClaudeCodeProduct(["unknown", "code_cli"])).toBe("code_cli");
  expect(mergeClaudeCodeProduct(["code_cli", "unknown"])).toBe("code_cli");
  expect(mergeClaudeCodeProduct(["code_cli", "other_product"])).toBe("conflict");
  expect(mergeClaudeCodeProduct(["other_product", "code_cli"])).toBe("conflict");
  expect(mergeClaudeCodeProduct([])).toBe("unknown");
});

test("a cumulative snapshot divides the traffic of every local source and keeps actual totals separate", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 100_000, entrypoint: "cli", cc_version: "1.0.0" });
    addEvent(db, { ts: "2026-09-12T10:00:00.000Z", tokens: 20_000, entrypoint: "cli", cc_version: "1.0.0" });
    // Same store and account, launched from the desktop app and from a source that recorded nothing: still Code.
    addEvent(db, { ts: "2026-09-12T11:00:00.000Z", tokens: 500_000, entrypoint: "claude-desktop", cc_version: "9" });
    addEvent(db, { ts: "2026-09-12T12:00:00.000Z", tokens: 700_000, entrypoint: null, cc_version: null });
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 24, sharePercent: 12 });
    prepared(db);
    const report = build(db);
    expect(report.selected?.kind).toBe("cumulative");
    // T is 1320000, every event: 1320000 / 12% = 11000000, / 24% = 45833333.33.
    expect(report.observed).toMatchObject({ code_tokens: 1_320_000, code_events: 4, account_tokens: 1_320_000, account_events: 4 });
    expect(report.account_total_tokens.value).toBeCloseTo(11_000_000, 6);
    expect(report.weekly_capacity_tokens.value).toBeCloseTo(45833333.333333336, 6);
    // Priced with 1 USD / 1M input tokens the same equations hold on the API equivalent.
    expect(report.observed!.code_api_usd).toBeCloseTo(1.32, 12);
    expect(report.weekly_capacity_api_usd.value).toBeCloseTo(45.833333333333336, 10);
    expect(report.coverage).toMatchObject({ product_rule: CLAUDE_CODE_PRODUCT_RULE, cross_machine: "unconfirmed", complete_from_window_start: false,
      other_product_events: 0, unknown_events: 0 });
  } finally { db.close(); }
});

test("two compatible readings measure the interval without any zero observation", () => {
  const db = fixture();
  try {
    // Before the first reading: inside the window but outside the measured interval.
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 50_000, entrypoint: "cli", cc_version: "1.0.0" });
    addEvent(db, { ts: "2026-09-13T10:00:00.000Z", tokens: 60_000, entrypoint: "cli", cc_version: "1.0.0" });
    addObservation(db, { ts: "2026-09-12T00:00:00.000Z", used: 20, sharePercent: 10 });
    addObservation(db, { ts: "2026-09-14T00:00:00.000Z", used: 40, sharePercent: 20 });
    prepared(db);
    const report = build(db);
    const interval = report.samples.find(sample => sample.kind === "interval");
    expect(interval).toBeDefined();
    // Only the 60000 between the readings counts; delta(u*s) = 40*20 - 20*10 = 600 percent^2.
    expect(interval!.usage.code_tokens).toBe(60_000);
    expect(report.selected?.kind).toBe("interval");
    expect(report.weekly_capacity_tokens.value).toBe(60_000 * 10_000 / 600);
    // Never delta-share and never the final share over the whole interval.
    expect(report.weekly_capacity_tokens.value).not.toBe(60_000 * 100 / (20 - 10));
    expect(report.weekly_capacity_tokens.value).not.toBe(60_000 * 10_000 / (20 * 40));
  } finally { db.close(); }
});

test("interval boundaries are exclusive at the start and inclusive at the end", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-12T00:00:00.000Z", tokens: 7, entrypoint: "cli", cc_version: "1" });
    addEvent(db, { ts: "2026-09-14T00:00:00.000Z", tokens: 11, entrypoint: "cli", cc_version: "1" });
    addObservation(db, { ts: "2026-09-12T00:00:00.000Z", used: 20, sharePercent: 10 });
    addObservation(db, { ts: "2026-09-14T00:00:00.000Z", used: 40, sharePercent: 20 });
    prepared(db);
    const report = build(db);
    const interval = report.samples.find(sample => sample.kind === "interval")!;
    // The event exactly at the first as_of belongs to the cumulative window, not the interval;
    // the event exactly at the second as_of does belong to it.
    expect(interval.usage.code_tokens).toBe(11);
    const cumulative = report.samples.filter(sample => sample.kind === "cumulative");
    expect(cumulative[0]!.usage.code_tokens).toBe(7);
    expect(cumulative[1]!.usage.code_tokens).toBe(18);
  } finally { db.close(); }
});

test("unusable shares, meters and windows keep distinct explicit meanings", () => {
  const cases: Array<[unknown, string]> = [
    [cumulativeClaudeCodeEstimate({ quantity: 10, sharePercent: null, utilizationPercent: 20 }).weekly_capacity.absent, "share_absent"],
    [cumulativeClaudeCodeEstimate({ quantity: 10, sharePercent: 0, utilizationPercent: 20 }).weekly_capacity.absent, "share_zero"],
    [cumulativeClaudeCodeEstimate({ quantity: 10, sharePercent: 120, utilizationPercent: 20 }).weekly_capacity.absent, "share_invalid"],
    [cumulativeClaudeCodeEstimate({ quantity: 10, sharePercent: 12, utilizationPercent: 0 }).weekly_capacity.absent, "utilization_nonpositive"],
    [cumulativeClaudeCodeEstimate({ quantity: 10, sharePercent: 12, utilizationPercent: 101 }).weekly_capacity.absent, "utilization_nonpositive"],
    [cumulativeClaudeCodeEstimate({ quantity: null, sharePercent: 12, utilizationPercent: 20 }).weekly_capacity.absent, "unpriced"],
  ];
  for (const [actual, expected] of cases) expect(actual).toBe(expected);
  // A zero share is a real reading, not an absent one, and stays distinguishable.
  expect(cumulativeClaudeCodeEstimate({ quantity: 10, sharePercent: 0, utilizationPercent: 20 }).account_total.absent).toBe("share_zero");
  // A reset or a shrinking product gives a non-positive delta rather than a number.
  expect(intervalClaudeCodeCapacity({ quantity: 10, first: { sharePercent: 20, utilizationPercent: 40 }, second: { sharePercent: 10, utilizationPercent: 20 } })
    .weekly_capacity.absent).toBe("delta_nonpositive");
});

test("a tiny movement of the rounded meter is refused instead of inflated", () => {
  // Both percents are whole numbers, so the product carries about +/- 0.5pp of play on each
  // factor. A one-unit product change is inside the guard; a clearly larger one is not.
  const small = intervalClaudeCodeCapacity({ quantity: 1000, first: { sharePercent: 10, utilizationPercent: 20 }, second: { sharePercent: 10, utilizationPercent: 21 } });
  expect(small.weekly_capacity.absent).toBe("delta_ineffective");
  expect(small.delta_product_percent).toBe(10);
  expect(small.delta_floor_percent).toBe(4 * (10 * 0.5 + 21 * 0.5));
  const large = intervalClaudeCodeCapacity({ quantity: 1000, first: { sharePercent: 10, utilizationPercent: 20 }, second: { sharePercent: 20, utilizationPercent: 40 } });
  expect(large.weekly_capacity.value).toBe(1000 * 10_000 / 600);
  // Finer reporting resolution lowers the floor, so a 0.1pp scale pair stays usable.
  const fine = intervalClaudeCodeCapacity({ quantity: 1000, first: { sharePercent: 10.0, utilizationPercent: 20.0 }, second: { sharePercent: 10.0, utilizationPercent: 21.0 } });
  expect(fine.weekly_capacity.absent).toBe("delta_ineffective");
});

test("scoped, session and foreign-account readings never donate a timestamp or share", () => {
  const db = fixture();
  try {
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 30, sharePercent: 15, scope: "Claude Sonnet" });
    db.query("INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra) VALUES('claude','seat',?,'session',NULL,?,?,?)")
      .run("2026-09-13T01:00:00.000Z", 55, RESET, JSON.stringify(encodeClaudeCodeProductShare({ schema: 1, key: "claude_code", percent: 40, as_of: "2026-09-13T01:00:00.000Z", window_started_at: WINDOW_START, display_name: null })));
    db.query("INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra) VALUES('claude','other-seat',?,'weekly_all',NULL,?,?,?)")
      .run("2026-09-13T02:00:00.000Z", 70, RESET, JSON.stringify(encodeClaudeCodeProductShare({ schema: 1, key: "claude_code", percent: 50, as_of: "2026-09-13T02:00:00.000Z", window_started_at: WINDOW_START, display_name: null })));
    prepareObservations(db);
    expect(readClaudeCodeObservations(db, "seat")).toEqual([]);
  } finally { db.close(); }
});

test("duplicate readings agree or are an explicit conflict, including on share metadata", () => {
  const db = fixture();
  try {
    const asOf = "2026-09-13T00:00:00.000Z";
    addObservation(db, { ts: "2026-09-13T00:00:01.000Z", used: 24, sharePercent: 12, asOf });
    addObservation(db, { ts: "2026-09-13T00:00:02.000Z", used: 24, sharePercent: 12, asOf });
    let observations = readClaudeCodeObservations(db, "seat");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ copies: 2, conflict: null, usable: true, share_percent: 12, as_of: asOf });
    // Same utilization and reset, different share: still incompatible evidence.
    addObservation(db, { ts: "2026-09-13T00:00:03.000Z", used: 24, sharePercent: 30, asOf });
    observations = readClaudeCodeObservations(db, "seat");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ copies: 3, conflict: "share", usable: false, reason: "observation_conflict" });
  } finally { db.close(); }
});

test("a copy missing its provenance neither discards tokens nor flips the product", () => {
  const db = fixture();
  try {
    // Two physical copies of one call: identical usage, only one carries the CLI metadata.
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 120_000, entrypoint: "cli", cc_version: "1.0.0", call_id: "shared", store: "live" });
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 120_000, entrypoint: null, cc_version: null, call_id: "shared", store: "live" });
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 24, sharePercent: 12 });
    prepared(db);
    const report = build(db);
    // Counted once, kept as Code, and the duplicate is reported rather than dropped.
    expect(report.observed).toMatchObject({ code_tokens: 120_000, code_events: 1, account_tokens: 120_000 });
    expect(report.coverage.duplicate_copies).toBe(1);
    expect(report.account_total_tokens.value).toBe(1_000_000);
  } finally { db.close(); }
});

test("a later correction moves only its own window and matches a fresh full reference", () => {
  const dir = tempDir(), path = join(dir, "db.sqlite");
  let db = fixture(path);
  try {
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 100_000, entrypoint: "cli", cc_version: "1.0.0", call_id: "a" });
    addEvent(db, { ts: "2026-09-12T10:00:00.000Z", tokens: 20_000, entrypoint: "cli", cc_version: "1.0.0", call_id: "b" });
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 24, sharePercent: 12 });
    prepared(db);
    expect(build(db).observed!.code_tokens).toBe(120_000);
    // A delayed correction of one event.
    db.exec("UPDATE claude_events SET in_uncached=40000 WHERE call_id='b'");
    prepared(db);
    const incremental = build(db);
    expect(incremental.observed!.code_tokens).toBe(140_000);
    db.close();
    // A fresh process with no response memory must agree with the incremental result.
    db = new Database(path);
    const fresh = build(db);
    expect(fresh.observed!.code_tokens).toBe(140_000);
    expect(fresh.account_total_tokens.value).toBe(incremental.account_total_tokens.value);
    // A removal is handled explicitly too.
    db.exec("DELETE FROM claude_events WHERE call_id='b'");
    prepared(db);
    expect(build(db).observed!.code_tokens).toBe(100_000);
  } finally { db.close(); cleanup(); }
});

test("a new share over the same boundaries reads the stored sums: no event reads, no revaluations", () => {
  const dir = tempDir(), path = join(dir, "db.sqlite");
  let db = fixture(path);
  try {
    for (let index = 0; index < 6; index++) {
      addEvent(db, { ts: `2026-09-1${index + 1}T10:00:00.000Z`, tokens: 20_000, entrypoint: "cli", cc_version: "1.0.0" });
    }
    addObservation(db, { ts: "2026-09-16T12:00:00.000Z", used: 24, sharePercent: 12 });
    prepared(db);
    const first = build(db);
    expect(first.observed!.code_tokens).toBe(120_000);
    expect(first.account_total_tokens.value).toBe(1_000_000);
    db.close();
    // Restart, so nothing survives except the durable prepared results.
    db = new Database(path);
    // Only the share changes; the window start and as_of stay identical.
    db.exec("UPDATE probe_windows SET extra=replace(extra,'\"claude.share.percent\":12','\"claude.share.percent\":24')");
    prepareObservations(db);
    const measured = measureAnalysis(db, () => buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS }));
    const second = measured.value;
    // The estimate follows the new share; the measured traffic and its valuations do not move.
    expect(second.observed!.code_tokens).toBe(120_000);
    expect(second.observed!.code_api_usd).toBeCloseTo(first.observed!.code_api_usd!, 12);
    expect(second.account_total_tokens.value).toBe(500_000);
    // The running totals at both readings are stored rows: the request reads no event and no fact.
    expect(measured.rawOrFactQueries).toEqual([]);
  } finally { db.close(); cleanup(); }
});

test("Code capacity keeps the stamped-evidence result while skipping its unused whole-history revision reads", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 1000, entrypoint: "cli", cc_version: "1" });
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 24, sharePercent: 12 });
    prepared(db);
    build(db);
    const resolver = loadAccountResolver(db);
    let revisionQueries = 0;
    const query = db.query;
    db.query = function(this: Database, sql: string, ...args: unknown[]) {
      if (sql.includes("p.id,s.revision AS revision")) revisionQueries++;
      return query.call(this, sql, ...args as []);
    } as typeof db.query;
    try {
      const evidence = loadProbeLimitEvidence(db, "claude", "seat", resolver);
      expect(evidence.revision).not.toBeNull();
      expect(revisionQueries).toBeGreaterThan(0);
      const expected = buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS, resolver, probeEvidence: evidence });
      revisionQueries = 0;
      const actual = buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS, resolver });
      expect(actual).toEqual(expected);
      expect(revisionQueries).toBe(0);
    } finally { db.query = query; }
  } finally { db.close(); cleanup(); }
});

test("an unprepared fact index produces the pending path, never a foreground rebuild", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 1000, entrypoint: "cli", cc_version: "1" });
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 24, sharePercent: 12 });
    // The window producer waits for the usage ledger, so the reader answers "preparing".
    expect(() => build(db)).toThrow(WindowUsagePreparing);
  } finally { db.close(); }
});

test("without a usable observation the report stays explicitly unavailable", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 1000, entrypoint: "cli", cc_version: "1" });
    prepared(db);
    expect(build(db)).toMatchObject({ reason: "no_observation", selected: null });
    // An old-format reading without share metadata is absent, not zero.
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 24, sharePercent: null });
    prepared(db);
    const report = build(db);
    expect(report.reason).toBe("share_absent");
    expect(report.weekly_capacity_tokens).toEqual({ value: null, absent: "share_absent" });
    expect(report.observations[0]).toMatchObject({ share_percent: null, utilization_percent: 24, usable: false });
  } finally { db.close(); }
});

test("another account's traffic and readings never reach this account's estimate", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 120_000, entrypoint: "cli", cc_version: "1" });
    db.query(`INSERT INTO claude_events(store,call_id,ts,model,entrypoint,cc_version,subscription_id,in_uncached,speed)
      VALUES('live','foreign','2026-09-11T11:00:00.000Z','claude-sonnet','cli','1','other-seat',999999,'standard')`).run();
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 24, sharePercent: 12 });
    prepared(db);
    const report = build(db);
    expect(report.observed!.code_tokens).toBe(120_000);
    expect(report.account_total_tokens.value).toBe(1_000_000);
  } finally { db.close(); }
});

test("integer share precision is not improved by fractional utilization",()=>{
  const result=intervalClaudeCodeCapacity({quantity:1000,first:{sharePercent:12,utilizationPercent:24.01},
    second:{sharePercent:12,utilizationPercent:24.11}});
  expect(result.weekly_capacity.absent).toBe("delta_ineffective");
  expect(result.delta_floor_percent).toBeCloseTo(4*(12*0.005+24.11*0.5),12);
});

test("vendor timestamps bound delayed copies and disagreements outside collection bounds still conflict",()=>{
  const db=fixture();
  try{
    const asOf="2026-09-13T00:00:00.000Z";
    addObservation(db,{ts:"2026-09-18T00:00:00.000Z",asOf,used:24,sharePercent:12});
    const options={since:asOf,until:asOf};
    expect(readClaudeCodeObservations(db,"seat",options)).toHaveLength(1);
    addObservation(db,{ts:"2026-09-19T00:00:00.000Z",asOf,used:24,sharePercent:15});
    expect(readClaudeCodeObservations(db,"seat",options)[0]).toMatchObject({copies:2,reason:"observation_conflict",usable:false});
  }finally{db.close();}
});

test("vendor observation precision survives UTC normalization",()=>{
  const db=fixture();
  try{
    addObservation(db,{ts:"2026-09-13T00:00:01.000Z",asOf:"2026-09-13T00:00:00.239074+00:00",used:24,sharePercent:12});
    expect(readClaudeCodeObservations(db,"seat")[0]!.as_of).toBe("2026-09-13T00:00:00.239074Z");
  }finally{db.close();}
});

test("copy labels and equivalent timestamp formats do not conflict with canonical share evidence",()=>{
  const db=fixture();
  try{
    const asOf="2026-09-13T00:00:00.239074Z";
    addObservation(db,{ts:"2026-09-13T00:00:01.000Z",asOf,used:24,sharePercent:12});
    const extra=encodeClaudeCodeProductShare({schema:1,key:"claude_code",percent:12,
      as_of:"2026-09-13T02:00:00.2390740+02:00",window_started_at:"2026-09-10T02:00:00+02:00",display_name:"Renamed Code label"});
    db.query("INSERT INTO probe_windows(provider,subject,ts,kind,used_percent,resets_at,extra) VALUES('claude','seat',?,'weekly_all',24,?,?)")
      .run("2026-09-13T00:00:02.000Z","2026-09-17T02:00:00+02:00",JSON.stringify(extra));
    prepareObservations(db);
    const copies=readClaudeCodeObservations(db,"seat");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({copies:2,usable:true,conflict:null,as_of:asOf,share_percent:12});
    addObservation(db,{ts:"2026-09-13T00:00:03.000Z",asOf,used:24,sharePercent:15});
    expect(readClaudeCodeObservations(db,"seat")[0]).toMatchObject({copies:3,usable:false,conflict:"share",reason:"observation_conflict"});
  }finally{db.close();}
});

test("a stale-subject observation follows its collection-time period through a gap and A/C correction",()=>{
  const db = fixture();
  try {
    addObservation(db,{ts:"2026-09-13T10:00:00.000Z",asOf:"2026-09-12T00:00:00.000Z",used:24,sharePercent:12});
    const original = db.query("SELECT id,subject,extra FROM probe_windows").get() as {id:number;subject:string;extra:string};
    db.query("UPDATE probe_windows SET subject='stale' WHERE id=?").run(original.id);
    prepareObservations(db);
    const facts = db.query("SELECT id,payload,payload_digest FROM probe_counters ORDER BY id").all();
    expect(readClaudeCodeObservations(db,"seat")).toHaveLength(1);
    const period = loadPeriods(db,ACCOUNT_PERIODS).find(row=>row.provider==="claude" && row.subject==="claude/fixture")!;
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,[{...period,until:"2026-09-13"}]);
    prepareObservations(db);
    expect(readClaudeCodeObservations(db,"seat")).toEqual([]);
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,[{...period,until:"2026-09-13"},
      {...period,from:"2026-09-13",until:null,value:"c"}]);
    prepareObservations(db);
    expect(readClaudeCodeObservations(db,"seat")).toEqual([]);
    const corrected=readClaudeCodeObservations(db,"c");
    expect(corrected[0]).toMatchObject({account:"c",as_of:"2026-09-12T00:00:00.000Z",usable:true});
    const reference=fixture();
    try {
      addObservation(reference,{ts:"2026-09-13T10:00:00.000Z",asOf:"2026-09-12T00:00:00.000Z",used:24,sharePercent:12});
      reference.query("UPDATE probe_windows SET subject='stale'").run();
      const direct=loadPeriods(reference,ACCOUNT_PERIODS).find(row=>row.provider==="claude" && row.subject==="claude/fixture")!;
      replaceDeclaredPeriods(reference,ACCOUNT_PERIODS,[{...direct,from:"2026-09-13",value:"c"}]);
      prepareObservations(reference);
      expect(corrected).toEqual(readClaudeCodeObservations(reference,"c"));
    } finally { reference.close(); }
    expect(db.query("SELECT id,subject,extra FROM probe_windows").get()).toEqual({...original,subject:"stale"});
    expect(db.query("SELECT id,payload,payload_digest FROM probe_counters ORDER BY id").all()).toEqual(facts);
  } finally { db.close(); }
});

test("invalid share evidence and conflicting copies obey precise vendor-time bounds",()=>{
  const db=fixture();
  try {
    const asOf="2026-09-13T00:00:00.239074Z";
    addObservation(db,{ts:"2026-09-16T00:00:00.000Z",asOf,used:24,sharePercent:12});
    db.query("INSERT INTO probe_windows(provider,subject,ts,kind,used_percent,resets_at,extra) VALUES('claude','stale',?,'weekly_all',24,?,?)")
      .run("2026-09-17T00:00:00.000Z",RESET,JSON.stringify({"claude.share.as_of":"2026-09-13T02:00:00.2390740+02:00","claude.share.percent":12}));
    // The second copy has invalid share metadata but the same raw vendor timestamp.
    prepareProbeReaderFixture(db,probeSources,()=>"seat");
    expect(readClaudeCodeObservations(db,"seat",{since:asOf,untilExclusive:"2026-09-13T00:00:00.239075Z"})[0])
      .toMatchObject({copies:2,conflict:"share",reason:"observation_conflict"});
    expect(readClaudeCodeObservations(db,"seat",{untilExclusive:asOf})).toEqual([]);
    expect(readClaudeCodeObservations(db,"seat",{since:"2026-09-13T00:00:00.239075Z"})).toEqual([]);
  } finally { db.close(); }
});

test("a narrow vendor-time read returns the same readings with 100 or 1000 older observations",()=>{
  const measure = (size: number) => {
    const db=fixture();
    try {
      const insert=db.query("INSERT INTO probe_windows(provider,subject,ts,kind,used_percent,resets_at,extra) VALUES('claude','stale',?,'weekly_all',24,?,?)");
      const start=Date.parse("2026-09-11T00:00:00.000Z");
      let last="";
      for(let i=0;i<size;i++) {
        last=new Date(start+i*60_000).toISOString();
        insert.run(last,RESET,JSON.stringify(encodeClaudeCodeProductShare({schema:1,key:"claude_code",percent:12,
          as_of:last,window_started_at:WINDOW_START,display_name:null})));
      }
      prepareProbeReaderFixture(db,probeSources,()=>"seat");
      fillUsageLedger(db, "claude", CARDS, ARCHIVE_LOGICAL_ROOT, 500);
      prepareWindowUsageFixture(db, { rateCards: CARDS, manualCapacity: () => [], claudeGauge: {}, cycles: { windows: [] } });
      const options = { since: last, until: last };
      const evidence = loadProbeLimitEvidence(db, "claude", "seat", loadAccountResolver(db));
      const expected = buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS, probeEvidence: evidence }, options);
      // Readings fetched from probe_windows: the stored vendor instant is filtered in the indexed query.
      let probes=0;
      const query=db.query;
      db.query=function(this:Database,sql:string,...args:unknown[]) {
        const statement=query.call(this,sql,...args as []);
        if (!/\bprobe_windows\b/.test(sql)) return statement;
        return new Proxy(statement,{get(target,property) {
          const value=Reflect.get(target,property);
          if(property==="all") return (...params:unknown[])=>{const rows=target.all(...params as []);probes+=rows.length;return rows;};
          return typeof value==="function"?value.bind(target):value;
        }}) as typeof statement;
      } as typeof db.query;
      try {
        const observations=readClaudeCodeObservations(db,"seat",{since:last,until:last});
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({as_of:last,copies:1,usable:true});
        const report = buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS }, options);
        expect(report).toEqual(expected);
      } finally {db.query=query;}
      return {probes};
    } finally {db.close();}
  };
  // One observation-reader row plus the report's observation and exact mapping witness.
  expect(measure(100)).toEqual({probes:3});
  expect(measure(1000)).toEqual({probes:3});
});

test("a late invalid share invalidates the original observation day without changing an unrelated day",()=>{
  const db=fixture();
  try {
    const asOf="2026-09-13T00:00:00.000Z";
    addObservation(db,{ts:asOf,used:24,sharePercent:12});
    const revision=(day:string)=>readPreparedProbeAccountingRevision(db,"claude","seat",day,`${day}T23:59:59.999Z`);
    const before=revision("2026-09-13"), unrelated=revision("2026-09-12");
    db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra)
      SELECT provider,subject,'2026-09-20T00:00:00.000Z',kind,scope,used_percent,resets_at,
        json_set(extra,'$."claude.share.percent"',1000) FROM probe_windows`).run();
    prepareObservations(db);
    expect(revision("2026-09-13")).not.toEqual(before);
    expect(revision("2026-09-12")).toEqual(unrelated);
    expect(readClaudeCodeObservations(db,"seat",{since:asOf,until:asOf})[0])
      .toMatchObject({copies:2,usable:false,reason:"observation_conflict"});
  } finally {db.close();}
});

test("fractional window start rounds upward only for event selection and keeps vendor provenance",()=>{
  const db=fixture();
  try{
    const windowStart="2026-09-10T00:00:00.000123Z";
    addEvent(db,{ts:"2026-09-10T00:00:00.000Z",tokens:1000,entrypoint:"cli",cc_version:"1"});
    addEvent(db,{ts:"2026-09-10T00:00:00.001Z",tokens:2000,entrypoint:"cli",cc_version:"1"});
    addObservation(db,{ts:"2026-09-13T00:00:00.000Z",used:24,sharePercent:12,windowStart,
      reset:"2026-09-17T00:00:00.000123Z"});
    prepared(db);
    const report=build(db);
    expect(report.observed!.code_tokens).toBe(2000);
    expect(report.observed!.code_events).toBe(1);
    expect(report.selected).toMatchObject({kind:"cumulative",from:windowStart});
    expect(report.observations[0]!.window_started_at).toBe(windowStart);
  }finally{db.close();}
});

test("exclusive observation upper bound excludes the next midnight in reads, reports and pure selection",()=>{
  const db=fixture();
  try{
    const midnight="2026-09-13T00:00:00.000Z";
    addEvent(db,{ts:"2026-09-11T00:00:00.000Z",tokens:1000,entrypoint:"cli",cc_version:"1"});
    addObservation(db,{ts:"2026-09-12T00:00:00.000Z",used:10,sharePercent:12});
    addObservation(db,{ts:midnight,used:24,sharePercent:12});prepared(db);
    const bounds={untilExclusive:midnight};
    expect(readClaudeCodeObservations(db,"seat",bounds)).toHaveLength(1);
    const full=build(db),scoped=build(db,bounds);
    expect(full.observations).toHaveLength(2);
    expect(scoped.observations).toHaveLength(1);
    expect(scoped.selected!.through).toBe("2026-09-12T00:00:00.000Z");
    expect(selectClaudeCodeCapacityReport(full,bounds).weekly_capacity_tokens).toEqual(scoped.weekly_capacity_tokens);
    expect(selectClaudeCodeCapacityReport(full,{until:midnight}).selected!.through).toBe(midnight);
  }finally{db.close();}
});

// Contradictions block the estimate; a saturated meter is handled by the frozen-sample tests below.
for(const [share,used,reset,reason] of [
  [0,24,RESET,"share_zero"], [12,24,"2026-09-18T00:00:00.000Z","window_mismatch"],
] as const) test(`newest ${reason} cannot reuse an older valid capacity`,()=>{
  const db=fixture();
  try{
    addEvent(db,{ts:"2026-09-11T00:00:00.000Z",tokens:1000,entrypoint:"cli",cc_version:"1"});
    addObservation(db,{ts:"2026-09-12T00:00:00.000Z",used:10,sharePercent:12});
    addObservation(db,{ts:"2026-09-14T00:00:00.000Z",used,sharePercent:share,reset});
    prepared(db);
    const report=build(db);
    expect(report.samples.some(sample=>sample.weekly_capacity_tokens.value!=null)).toBe(true);
    expect(report).toMatchObject({selected:null,reason,weekly_capacity_tokens:{value:null,absent:reason}});
    const historical=selectClaudeCodeCapacityReport(report,{until:"2026-09-12T00:00:00.000Z",resetAt:RESET});
    expect(historical.weekly_capacity_tokens.value).not.toBeNull();
    expect(historical.coverage.complete_from_window_start).toBe(false);
  }finally{db.close();}
});

test("a later silent reading cannot mask a contradictory share when no traffic sample was usable", () => {
  const db=fixture();
  try {
    addObservation(db,{ts:"2026-09-12T00:00:00.000Z",used:20,sharePercent:0});
    addObservation(db,{ts:"2026-09-14T00:00:00.000Z",used:30});
    prepared(db);
    const report=build(db);
    expect(report.observations.at(-1)?.reason).toBe("share_absent");
    expect(report).toMatchObject({selected:null,reason:"share_zero",weekly_capacity_tokens:{value:null,absent:"share_zero"}});
  } finally {db.close();}
});

test("one window reads only its sums and preserves the full report projection across correction and reopen", () => {
  const path = join(tempDir(), "selected-window.sqlite");
  let db = fixture(path);
  try {
    for (const [start, ts, reset] of [
      ["2026-09-03T00:00:00.000Z", "2026-09-05T00:00:00.000Z", WINDOW_START],
      [WINDOW_START, "2026-09-12T00:00:00.000Z", RESET],
    ]) {
      addEvent(db, { ts: ts!, tokens: 1000, entrypoint: "cli", cc_version: "1" });
      addObservation(db, { ts: ts!, used: 20, sharePercent: 100, windowStart: start!, reset: reset! });
    }
    prepared(db);
    const full = build(db), windowId = full.observations.at(-1)!.window_id!;
    const options = { windowId };
    const reference = selectClaudeCodeCapacityReport(full, options);
    const selected = () => buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS }, options);
    expect(selected()).toEqual(reference);
    // A missing unrelated sum cannot turn the selected, fully prepared window into preparing.
    db.exec("CREATE TABLE saved_window_usage AS SELECT * FROM window_usage");
    db.query("DELETE FROM window_usage WHERE window_id != ?").run(windowId);
    expect(() => buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS })).toThrow(WindowUsagePreparing);
    expect(selected()).toEqual(reference);
    db.close();
    db = new Database(path);
    const reopened = measureAnalysis(db, selected);
    expect(reopened.value).toEqual(reference);
    expect(reopened.rawOrFactQueries).toEqual([]);
    // Historical correction republishes shared sums; selection matches an independent full projection.
    db.exec("INSERT OR IGNORE INTO window_usage SELECT * FROM saved_window_usage");
    db.exec("UPDATE claude_events SET in_uncached=2500 WHERE ts='2026-09-12T00:00:00.000Z'");
    prepared(db);
    const corrected = build(db);
    expect(selected()).toEqual(selectClaudeCodeCapacityReport(corrected, options));
    expect(selected().weekly_capacity_tokens.value).toBeCloseTo(2500 / 20 * 100, 9);
    db.query("DELETE FROM window_usage WHERE window_id = ?").run(windowId);
    expect(selected).toThrow(WindowUsagePreparing);
    expect(buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS }, { windowId: "missing" }))
      .toMatchObject({ observations: [], samples: [], selected: null, reason: "no_observation" });
  } finally { db.close(); cleanup(); }
});

test("the first 100% sample survives later traffic, restart and historical correction", () => {
  const path = join(tempDir(), "frozen.sqlite");
  let db = fixture(path);
  try {
    addEvent(db, { ts: "2026-09-11T00:00:00.000Z", tokens: 1000 });
    addObservation(db, { ts: "2026-09-12T00:00:00.000Z", used: 20, sharePercent: 100 });
    addEvent(db, { ts: "2026-09-12T12:00:00.000Z", tokens: 2000 });
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 80, sharePercent: 100 });
    prepared(db);
    build(db);
    addEvent(db, { ts: "2026-09-13T12:00:00.000Z", tokens: 1000 });
    addObservation(db, { ts: "2026-09-14T00:00:00.000Z", used: 100, sharePercent: 100 });
    prepared(db);
    const first100 = build(db);
    addEvent(db, { ts: "2026-09-14T12:00:00.000Z", tokens: 5000 });
    addObservation(db, { ts: "2026-09-15T00:00:00.000Z", used: 100, sharePercent: 100 });
    prepared(db);
    const after = build(db);
    expect(after.selected).toEqual(first100.selected);
    expect(after.reason).toBeNull();
    expect(after.weekly_capacity_api_usd).toEqual(first100.weekly_capacity_api_usd);
    expect(after.weekly_capacity_tokens.value).toBeCloseTo(1000 / 20 * 100, 9);
    expect(claudeCodeCapacitySummary(after)).toMatchObject({
      as_of: "2026-09-14T00:00:00.000Z", source_through: "2026-09-14T00:00:00.000Z",
      sample_meter: { start_percent: 80, end_percent: 100, observed_pp: 20 },
      observed_code_tokens: 1000,
    });
    const cycle = JSON.parse((db.query("SELECT cycle FROM window_usage WHERE provider='claude'").get() as { cycle: string }).cycle);
    expect(cycle.cycle_usage.tokens).toBe(9000);
    expect(cycle.unpaired_events).toBe(1);
    expect(cycle.evidence.excluded_events.funding ?? 0).toBe(0);
    db.close();
    db = new Database(path);
    const restarted = measureAnalysis(db, () => buildClaudeCodeCapacityReport(db, "seat", { rateCards: CARDS }));
    expect(restarted.value.selected).toEqual(after.selected);
    expect(restarted.rawOrFactQueries).toEqual([]);
    // A correction changes the original sample, while post-ceiling traffic stays outside it.
    db.exec("UPDATE claude_events SET in_uncached=1500 WHERE ts='2026-09-13T12:00:00.000Z'");
    prepared(db);
    const corrected = build(db);
    expect(corrected.weekly_capacity_tokens.value).toBeCloseTo(1500 / 20 * 100, 9);
    expect(corrected.selected!.through).toBe(after.selected!.through);
    expect(selectClaudeCodeCapacityReport(corrected, { now: RESET }).reason).toBe("window_mismatch");
  } finally { db.close(); cleanup(); }
});

test("the 100% sample retains partial-price provenance and keeps dollars and tokens on one interval", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-11T00:00:00.000Z", tokens: 1000 });
    addObservation(db, { ts: "2026-09-12T00:00:00.000Z", used: 20, sharePercent: 100 });
    addEvent(db, { ts: "2026-09-12T12:00:00.000Z", tokens: 2000 });
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 80, sharePercent: 100 });
    addObservation(db, { ts: "2026-09-14T00:00:00.000Z", used: 90, sharePercent: 100 });
    addEvent(db, { ts: "2026-09-14T12:00:00.000Z", tokens: 1000 });
    addEvent(db, { ts: "2026-09-14T18:00:00.000Z", tokens: 500, call_id: "unpriced" });
    db.exec("UPDATE claude_events SET model='unknown-model' WHERE call_id='unpriced'");
    addObservation(db, { ts: "2026-09-15T00:00:00.000Z", used: 100, sharePercent: 100 });
    prepared(db);
    const report = build(db);
    expect(report.selected!.through).toBe("2026-09-15T00:00:00.000Z");
    expect(report.weekly_capacity_api_usd.value).toBeCloseTo(0.001 / 10 * 100, 12);
    expect(report.weekly_capacity_api_usd).toMatchObject({ relation: "≥" });
    expect(report.observed!.code_tokens).toBe(1500);
    expect(report.observed!.code_api_usd).toBeNull();
    expect(report.observed!.code_api_priced_subtotal).toBe(0.001);
  } finally { db.close(); }
});

test("saturation never borrows a sample from another window or bypasses an earlier contradiction", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-11T00:00:00.000Z", tokens: 1000 });
    addObservation(db, { ts: "2026-09-12T00:00:00.000Z", used: 20, sharePercent: 100 });
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 30, sharePercent: 0 });
    addObservation(db, { ts: "2026-09-14T00:00:00.000Z", used: 100, sharePercent: 100 });
    prepared(db);
    expect(build(db).selected).toBeNull();
    addObservation(db, { ts: "2026-09-20T00:00:00.000Z", used: 100, sharePercent: 100,
      windowStart: RESET, reset: "2026-09-24T00:00:00.000Z" });
    prepared(db);
    const later = build(db);
    expect(later).toMatchObject({ selected: null, reason: "no_code_tokens" });
  } finally { db.close(); }
});

test("a newer reading without a share does not hide the latest one that carries it",()=>{
  // Another machine's older collector records the meter without the product share; that reading
  // is silent, not contradictory, so the estimate stays at the latest reading with a share.
  const db=fixture();
  try{
    addEvent(db,{ts:"2026-09-11T00:00:00.000Z",tokens:1000,entrypoint:"cli",cc_version:"1"});
    addObservation(db,{ts:"2026-09-12T00:00:00.000Z",used:10,sharePercent:12});
    addObservation(db,{ts:"2026-09-14T00:00:00.000Z",used:24,sharePercent:null});
    prepared(db);
    const report=build(db);
    expect(report.reason).toBeNull();
    expect(report.selected!.through).toBe("2026-09-12T00:00:00.000Z");
    expect(report.weekly_capacity_tokens.value).not.toBeNull();
  }finally{db.close();}
});

test("a share-less first 100% keeps the proven sample without inventing a share-less week", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-11T00:00:00.000Z", tokens: 1000 });
    addObservation(db, { ts: "2026-09-12T00:00:00.000Z", used: 20, sharePercent: 100 });
    addEvent(db, { ts: "2026-09-12T12:00:00.000Z", tokens: 2000 });
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 80, sharePercent: 100 });
    addObservation(db, { ts: "2026-09-14T00:00:00.000Z", used: 100, sharePercent: null });
    addObservation(db, { ts: "2026-09-15T00:00:00.000Z", used: 100, sharePercent: 100 });
    prepared(db);
    const report = build(db);
    expect(report.selected!.through).toBe("2026-09-13T00:00:00.000Z");
    expect(report.reason).toBeNull();
    expect(claudeCodeCapacitySummary(report).share_percent).toBe(100);
    expect(report.weekly_capacity_tokens.value).toBeCloseTo(2000 / 60 * 100, 9);
  } finally { db.close(); }
});

test("unsafe aggregate across individually safe days is unavailable",()=>{
  const db=fixture();
  try{
    for(const date of ["2026-09-11","2026-09-12"])addEvent(db,{ts:`${date}T00:00:00.000Z`,tokens:5_000_000_000_000_000,entrypoint:"cli",cc_version:"1"});
    addObservation(db,{ts:"2026-09-13T00:00:00.000Z",used:24,sharePercent:12});prepared(db);
    expect(build(db)).toMatchObject({reason:"unsafe_total",weekly_capacity_tokens:{value:null,absent:"unsafe_total"}});
  }finally{db.close();}
});

test("summary propagates pending facts and real database failures",()=>{
  const db=fixture();
  try{
    addObservation(db,{ts:"2026-09-13T00:00:00.000Z",used:24,sharePercent:12});
    // Without a ledger the window producer publishes no sums: the reader answers "preparing".
    prepareWindowUsageFixture(db,{rateCards:CARDS,manualCapacity:()=>[],claudeGauge:{},cycles:{windows:[]}});
    expect(()=>claudeCodeCapacitySummaryOrAbsent(db,"seat",{rateCards:CARDS})).toThrow(WindowUsagePreparing);
    prepared(db);
    db.exec("DROP TABLE usage_ledger_facts");
    expect(()=>build(db)).toThrow("usage_ledger_facts");
    db.exec("DROP TABLE probe_windows");
    expect(()=>readClaudeCodeObservations(db,"seat")).toThrow();
    db.exec("CREATE TABLE probe_windows(unrelated TEXT)");
    expect(()=>readClaudeCodeObservations(db,"seat")).toThrow();
  }finally{db.close();}
});

test("API estimates explicitly use Standard pricing for Fast traffic",()=>{
  const db=fixture();
  const rates={currency:"USD",unit:"per 1M",vendors:{anthropic:{source:"test",models:{"claude-sonnet":{in_uncached:1,out_total:0,
    fast:{in_uncached:10,out_total:0}}}}}} as unknown as RateCard;
  try{
    addEvent(db,{ts:"2026-09-11T10:00:00.000Z",tokens:120_000,entrypoint:"cli",cc_version:"1"});
    db.exec("UPDATE claude_events SET speed='fast'");
    addObservation(db,{ts:"2026-09-13T00:00:00.000Z",used:24,sharePercent:12});prepared(db,rates);
    prepareWindowUsageFixture(db,{rateCards:rates,manualCapacity:()=>[],claudeGauge:{},cycles:{windows:[]}});
    const report=buildClaudeCodeCapacityReport(db,"seat",{rateCards:rates});
    expect(report.api_value_basis).toBe("standard");
    expect(report.observed!.code_api_usd).toBeCloseTo(0.12,12);
    expect(report.weekly_capacity_api_usd.value).toBeCloseTo(4.166666666666667,12);
    expect(report.selected!.models!.reduce((sum, row) => sum + row.api_standard, 0)).toBeCloseTo(0.12, 12);
  }finally{db.close();}
});

test("a bare legacy probe table is explicitly unprepared",()=>{
  const db=new Database(":memory:");
  try{
    db.exec("CREATE TABLE probe_windows(provider TEXT,subject TEXT,ts TEXT,kind TEXT,used_percent REAL,resets_at TEXT)");
    db.query("INSERT INTO probe_windows VALUES('claude','seat',?,'weekly_all',24,?)").run("2026-09-13T00:00:00.000Z",RESET);
    expect(()=>readClaudeCodeObservations(db,"seat")).toThrow(ProbeAccountIndexUnavailable);
    expect(()=>buildClaudeCodeCapacityReport(db,"seat",{rateCards:CARDS})).toThrow(ProbeAccountIndexUnavailable);
  }finally{db.close();}
});

test("a meter reset to zero inside the window measures only the usage after the drop", () => {
  const db = fixture();
  try {
    const cli = { entrypoint: "cli", cc_version: "1" };
    // Spent on the old plan: before, and between the last high and the first zero reading.
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 900_000, ...cli });
    addObservation(db, { ts: "2026-09-12T00:00:00.000Z", used: 88, sharePercent: 100 });
    addEvent(db, { ts: "2026-09-12T10:00:00.000Z", tokens: 300_000, ...cli });
    // The vendor zeroes the meter and keeps the reset; this copy carries no share.
    addObservation(db, { ts: "2026-09-13T00:00:00.000Z", used: 0 });
    addEvent(db, { ts: "2026-09-13T10:00:00.000Z", tokens: 40_000, ...cli });
    addObservation(db, { ts: "2026-09-14T00:00:00.000Z", used: 4, sharePercent: 100 });
    prepared(db);
    const report = build(db);
    expect(report.counter_resets).toEqual([{ reset_at: RESET,
      last_before: { at: "2026-09-12T00:00:00.000Z", percent: 88 }, first_after: { at: "2026-09-13T00:00:00.000Z", percent: 0 } }]);
    // No interval across the drop, and the newest estimate starts at the zero reading.
    expect(report.samples.some(sample => sample.kind === "interval")).toBe(false);
    expect(report.selected).toMatchObject({ kind: "cumulative", from: "2026-09-13T00:00:00.001Z" });
    expect(report.observed?.code_tokens).toBe(40_000);
    expect(report.weekly_capacity_tokens.value).toBe(1_000_000);
    const summary = claudeCodeCapacitySummaryOrAbsent(db, "seat", { rateCards: CARDS });
    expect(summary?.counter_reset?.first_after).toEqual({ at: "2026-09-13T00:00:00.000Z", percent: 0 });
  } finally { db.close(); }
});

test("a meter rescaled to a larger cap measures from the first reading after the drop", () => {
  const db = fixture();
  try {
    const cli = { entrypoint: "cli", cc_version: "1" };
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 210_000, ...cli });
    addObservation(db, { ts: "2026-09-12T00:00:00.000Z", used: 21, sharePercent: 100 });
    addObservation(db, { ts: "2026-09-12T12:00:00.000Z", used: 2, sharePercent: 100 });
    addEvent(db, { ts: "2026-09-13T10:00:00.000Z", tokens: 80_000, ...cli });
    addObservation(db, { ts: "2026-09-14T00:00:00.000Z", used: 10, sharePercent: 100 });
    prepared(db);
    const report = build(db);
    expect(report.counter_resets.map(reset => [reset.last_before.percent, reset.first_after.percent])).toEqual([[21, 2]]);
    // Neither the drop reading nor the later one is divided by usage from the window start.
    expect(report.samples.filter(sample => sample.kind === "cumulative").map(sample => sample.through)).toEqual(["2026-09-12T00:00:00.000Z"]);
    expect(report.selected).toMatchObject({ kind: "interval", after: "2026-09-12T12:00:00.000Z", through: "2026-09-14T00:00:00.000Z" });
    // 80000 tokens moved the meter 8 points: delta(u*s) = 10*100 - 2*100.
    expect(report.weekly_capacity_tokens.value).toBe(80_000 * 10_000 / 800);
  } finally { db.close(); }
});

test("a drop reading whose vendor as_of carries microseconds still starts the segment", () => {
  const db = fixture();
  try {
    const cli = { entrypoint: "cli", cc_version: "1" };
    addEvent(db, { ts: "2026-09-11T10:00:00.000Z", tokens: 210_000, ...cli });
    addObservation(db, { ts: "2026-09-12T00:00:00.000Z", used: 21, sharePercent: 100, asOf: "2026-09-12T00:00:00.000318+00:00" });
    // The vendor writes as_of with microseconds and an offset; the register keeps the drop at milliseconds.
    addObservation(db, { ts: "2026-09-12T12:00:00.000Z", used: 2, sharePercent: 100, asOf: "2026-09-12T12:00:00.000511+00:00" });
    addEvent(db, { ts: "2026-09-13T10:00:00.000Z", tokens: 80_000, ...cli });
    addObservation(db, { ts: "2026-09-14T00:00:00.000Z", used: 10, sharePercent: 100, asOf: "2026-09-14T00:00:00.000742+00:00" });
    prepared(db);
    const report = build(db);
    expect(report.samples.filter(sample => sample.kind === "cumulative").map(sample => sample.through)).toEqual(["2026-09-12T00:00:00.000318Z"]);
    expect(report.selected).toMatchObject({ kind: "interval", after: "2026-09-12T12:00:00.000511Z", through: "2026-09-14T00:00:00.000742Z" });
    expect(report.weekly_capacity_tokens.value).toBe(80_000 * 10_000 / 800);
  } finally { db.close(); }
});

test("a lower reading of the next window is a new window, not a drop", () => {
  const db = fixture();
  try {
    addEvent(db, { ts: "2026-09-16T10:00:00.000Z", tokens: 50_000, entrypoint: "cli", cc_version: "1" });
    addObservation(db, { ts: "2026-09-16T12:00:00.000Z", used: 90, sharePercent: 100 });
    addObservation(db, { ts: "2026-09-17T12:00:00.000Z", used: 1, sharePercent: 100,
      reset: "2026-09-24T00:00:00.000Z", windowStart: RESET });
    prepared(db);
    expect(build(db).counter_resets).toEqual([]);
  } finally { db.close(); }
});
