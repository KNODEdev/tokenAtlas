import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { Database } from "../db/sqlite";
import { createTestDatabase } from "../sync/test-support";
import { ensureCodexSchema } from "../ingest/codex";
import { ACCOUNT_PERIODS, ACCOUNT_PERIODS_REVISION, loadPeriods, PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import {
  LIMIT_WINDOW_SCHEMA_SQL, LimitWindowsPreparing, markLimitWindowFilesDirty, markLimitWindowsDirty, readLimitWindows,
} from "../db/limit-windows";
import type { DatedPeriod } from "./account-periods";
import { WINDOW_USAGE_SCHEMA_SQL } from "../db/window-usage";
import type { CyclesConfig } from "./cycles";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import type { SourceDeclaration } from "./archive-source";
import { codexLimitCounter } from "./probe-limit-windows";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
type ProbeReaderFixtureDeclaration = Parameters<typeof prepareProbeReaderFixture>[1][number];
import {
  advanceLimitWindows, computeLimitWindowsFull, emptyLimitWindowStats, type LimitWindowProducerOptions,
  type LimitWindowProducerStats,
} from "./limit-window-producer";

const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const START = Date.parse("2026-03-02T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const opened: Array<{ directory: string; db: Database }> = [];
afterEach(() => {
  for (const { directory, db } of opened.splice(0)) {
    db.close(true);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function database(): Database {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  opened.push({ directory, db });
  // Durability is not under test; commits dominate the run time of these fixtures otherwise.
  db.exec("PRAGMA synchronous=OFF; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  db.exec(WINDOW_USAGE_SCHEMA_SQL);
  return db;
}

/** Until idle, as the maintenance worker's turns would. */
function settle(db: Database, options: LimitWindowProducerOptions): void {
  for (let turn = 0; turn < 10_000; turn++) {
    const result = advanceLimitWindows(db, { budgetMs: 1e9, ...options });
    if (!result.pending) return;
    if (!result.progressed) throw new Error("Limit window producer is blocked");
  }
  throw new Error("Limit window producer did not settle");
}

/** Window-usage entries the producer queued since the last call (it publishes them with its windows). */
function windowUsageEntries(db: Database): Array<{ account: string; counter: string; from_ms: number; until_ms: number | null }> {
  const rows = db.query("SELECT account,counter,from_ms,until_ms FROM window_usage_dirty WHERE provider='claude' ORDER BY account,counter,from_ms").all() as
    Array<{ account: string; counter: string; from_ms: number; until_ms: number | null }>;
  db.query("DELETE FROM window_usage_dirty").run();
  return rows;
}

/** Incremental result = the reference computed from all readings, for every account and counter. */
function expectTableIsFull(db: Database, options: LimitWindowProducerOptions): number {
  const full = computeLimitWindowsFull(db, options);
  let windows = 0;
  for (const [key, expected] of full) {
    const [provider, account, counter] = JSON.parse(key) as [string, string, string];
    expect({ key, windows: readLimitWindows(db, provider, account, counter) }).toEqual({ key, windows: expected });
    windows += expected.length;
  }
  const stored = db.query("SELECT DISTINCT provider, account, counter FROM limit_windows").all() as Array<{ provider: string; account: string; counter: string }>;
  for (const row of stored) expect(full.has(JSON.stringify([row.provider, row.account, row.counter]))).toBe(true);
  return windows;
}

// --- Claude (probe readings and refusals) ---------------------------------------------------------

const CLAUDE = "claude-a", OTHER = "claude-b";
const claudeSources: ProbeReaderFixtureDeclaration[] = [
  { id: CLAUDE, vendor: "claude", machine: "MAIN", login: "fixture" },
  { id: CLAUDE, vendor: "claude", machine: "LAPTOP", login: "fixture" },
  { id: OTHER, vendor: "claude", machine: "OTHER", login: "fixture" },
];

function claudeReading(db: Database, machine: string, ts: number, kind: "weekly_all" | "session", used: number, reset: number, plan = "max"): void {
  db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,
    vendor_percent,resets_at,window_minutes,ok,extra,machine) VALUES('claude',?,?,?,?,?,NULL,'used',?,?,?,NULL,1,NULL,?)`)
    .run(machine === "OTHER" ? OTHER : CLAUDE, iso(ts), plan, kind, kind === "weekly_all" ? "weekly" : "session", used, used, iso(reset), machine);
}

/** Weekly windows with readings every 12 h, a 5 h counter, and a mid-week drop. */
function claudeHistory(db: Database, weeks: number): void {
  for (let week = 0; week < weeks; week++) {
    const reset = START + (week + 1) * WEEK;
    for (let step = 1; step < 14; step++) {
      const ts = START + week * WEEK + step * 12 * HOUR;
      const used = week % 5 === 3 && step > 7 ? step - 7 : Math.min(100, step * 7);
      claudeReading(db, "MAIN", ts, "weekly_all", used, reset);
      if (step % 3 === 1) claudeReading(db, "MAIN", ts, "session", 10 + step, ts + 4 * HOUR);
    }
  }
}

function claudeRefusal(db: Database, id: string, ts: number, reset: number): void {
  const source = loadPeriods(db, ACCOUNT_PERIODS).find(period => period.provider === "claude" && period.value === CLAUDE && /main/i.test(period.subject))!.subject;
  db.transaction(() => {
    db.query(`INSERT INTO claude_limit_hits(store,call_id,ts,limit_type,status,resets_at,path)
      VALUES('pc',?,?,'seven_day','rejected',?,?)`).run(id, iso(ts), iso(reset), `${ARCHIVE_LOGICAL_ROOT}/${source}/session.jsonl`);
    // The sync publication marks refusals it publishes, in the same transaction (publishClaudeLimitHits).
    markLimitWindowsDirty(db, "claude", "*", ts);
  }).immediate();
}

function claudeFixture(weeks = 8) {
  const db = database();
  claudeHistory(db, weeks);
  prepareProbeReaderFixture(db, claudeSources, row => row.subject, false);
  claudeRefusal(db, "refusal-1", START + 2 * WEEK + 160 * HOUR, START + 3 * WEEK);
  const measurements: ManualCapacityMeasurement[] = [];
  let cycles: CyclesConfig = { windows: [] };
  const options: LimitWindowProducerOptions = { sources: [], get cycles() { return cycles; },
    manualCapacity: provider => provider === "claude" ? measurements : [] };
  return { db, options, measurements, setCycles(next: CyclesConfig) { cycles = next; },
    refresh() { prepareProbeReaderFixture(db, claudeSources, row => row.subject, false); } };
}

test("schema in code equals migration 0048", () => {
  const migration = fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0050_limit_windows.sql"), "utf8");
  const normalize = (sql: string) => sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n")
    .replace(/--> statement-breakpoint/g, "").replace(/\s+/g, " ").trim();
  expect(normalize(migration)).toBe(normalize(LIMIT_WINDOW_SCHEMA_SQL));
});

test("source-plan migration adds nullable metadata without changing prepared inputs", () => {
  const db = new Database(":memory:");
  try {
    db.exec(LIMIT_WINDOW_SCHEMA_SQL);
    db.query(`INSERT INTO limit_window_inputs(provider,account,scope,counter,ts,grp,ord,used_percent,resets_at,window_minutes,source,anchor)
      VALUES('codex','codex1','weekly','weekly','2026-04-11T09:54:24.825Z','session',0,95,'2026-04-18T09:03:23Z',10080,'session',1)`).run();
    const before = db.query("SELECT * FROM limit_window_inputs").get() as Record<string, unknown>;
    db.exec(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0084_limit_window_source_plan.sql"), "utf8"));
    const { source_plan, ...after } = db.query("SELECT source_plan,* FROM limit_window_inputs").get() as Record<string, unknown>;
    expect(source_plan).toBeNull();
    expect(after).toEqual(before);
  } finally { db.close(); }
});

test("meter-evidence migration preserves existing inputs and adds no invented counters", () => {
  const db = new Database(":memory:");
  try {
    db.exec(LIMIT_WINDOW_SCHEMA_SQL);
    db.query(`INSERT INTO limit_window_inputs(provider,account,scope,counter,ts,grp,ord,used_percent,resets_at,window_minutes,source,anchor)
      VALUES('glm','account','*','weekly','2026-10-20T00:00:00Z','',0,40,'2026-10-25T00:00:00Z',10080,'probe',1)`).run();
    const before=db.query("SELECT * FROM limit_window_inputs").get() as Record<string,unknown>;
    db.exec(fs.readFileSync(path.resolve(import.meta.dir,"../../drizzle/0094_window_meter_evidence.sql"),"utf8"));
    const {meter_evidence,...after}=db.query("SELECT * FROM limit_window_inputs").get() as Record<string,unknown>;
    expect(meter_evidence).toBeNull();
    expect(after).toEqual(before);
  } finally { db.close(); }
});

test("readers answer preparing until the worker has filled an account, never computing", () => {
  const { db, options } = claudeFixture(2);
  // As right after migration 0048: the worker has not run yet.
  db.exec("DELETE FROM limit_windows; DELETE FROM limit_window_inputs; DELETE FROM limit_window_state; DELETE FROM meta WHERE key LIKE 'limit_windows_%'");
  expect(() => readLimitWindows(db, "claude", CLAUDE, '["weekly_all","weekly",10080]')).toThrow(LimitWindowsPreparing);
  settle(db, options);
  expect(readLimitWindows(db, "claude", CLAUDE, '["weekly_all","weekly",10080]').length).toBeGreaterThan(0);
  // An account no period names has no windows, as before.
  expect(readLimitWindows(db, "claude", "unknown-account", '["weekly_all","weekly",10080]')).toEqual([]);
});

test("Claude registers stay equal to the full segmentation through appended, late, period, plan, manual and cadence changes", () => {
  const fixture = claudeFixture(5), { db, options } = fixture;
  settle(db, options);
  const total = expectTableIsFull(db, options);
  expect(total).toBeGreaterThan(5);
  // The refusal is a 100% reading of its week.
  expect(readLimitWindows(db, "claude", CLAUDE, '["weekly_all","weekly",10080]')
    .some(window => window.readings.some(reading => reading.source === "limit_hit"))).toBe(true);

  // Appended reading.
  windowUsageEntries(db);
  claudeReading(db, "MAIN", START + 5 * WEEK - 2 * HOUR, "weekly_all", 99, START + 5 * WEEK);
  fixture.refresh();
  let stats = emptyLimitWindowStats();
  settle(db, { ...options, stats });
  expectTableIsFull(db, options);
  expect(stats.slices).toBe(1);
  // Only the changed week's span is queued; unrelated later windows keep their sums.
  const lastWeek = readLimitWindows(db, "claude", CLAUDE, '["weekly_all","weekly",10080]').at(-1)!;
  expect(windowUsageEntries(db).filter(entry => entry.counter === '["weekly_all","weekly",10080]'))
    .toEqual([{ account: CLAUDE, counter: '["weekly_all","weekly",10080]', from_ms: Date.parse(lastWeek.start), until_ms: Date.parse(lastWeek.end) }]);

  // A late reading from a second machine, in the middle of the history; it opens a drop.
  claudeReading(db, "LAPTOP", START + 3 * WEEK + 3 * DAY + 1000, "weekly_all", 2, START + 4 * WEEK);
  fixture.refresh();
  settle(db, options);
  expectTableIsFull(db, options);

  // Account period change: the laptop's readings belong to the other account from week 5 on.
  const periods = loadPeriods(db, ACCOUNT_PERIODS).filter(period => period.origin === "declared");
  const laptop = periods.find(period => /laptop/i.test(period.subject))!;
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [...periods.filter(period => period !== laptop),
    { ...laptop, until: iso(START + 3 * WEEK) }, { ...laptop, from: iso(START + 3 * WEEK), value: OTHER }]);
  fixture.refresh();
  settle(db, options);
  expectTableIsFull(db, options);

  // Plan period change: only plan fields, no input recomputation.
  const plan = (from: string, until: string | null, value: string): DatedPeriod => ({ provider: "claude", subject: CLAUDE,
    from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
  replaceDeclaredPeriods(db, PLAN_PERIODS, [plan("2026-01-01", iso(START + 4 * WEEK + DAY), "pro"),
    plan(iso(START + 4 * WEEK + DAY), null, "max-5x")]);
  windowUsageEntries(db);
  stats = emptyLimitWindowStats();
  settle(db, { ...options, stats });
  expectTableIsFull(db, options);
  expect([stats.slices, stats.segmentations]).toEqual([0, 1]);
  // A plan changes no sum.
  expect(windowUsageEntries(db)).toEqual([]);
  expect(readLimitWindows(db, "claude", CLAUDE, '["weekly_all","weekly",10080]').some(window => window.declared_plan_meter_mismatch)).toBe(true);

  // Manual measurement added, then removed.
  fixture.measurements.push({ id: "manual-1", account: CLAUDE, counter: '["weekly_all","weekly",10080]',
    start: iso(START + 4 * WEEK + DAY), end: iso(START + 4 * WEEK + 2 * DAY), start_percent: 5, end_percent: 40,
    approximate_time: false, note: "fixture", updated_at: iso(START) });
  settle(db, options);
  expectTableIsFull(db, options);
  const manualWindow = readLimitWindows(db, "claude", CLAUDE, '["weekly_all","weekly",10080]').find(window => window.manual_measurement?.id === "manual-1")!;
  // The window that pairs the manual readings recomputes its sums.
  expect(windowUsageEntries(db)).toContainEqual({ account: CLAUDE, counter: '["weekly_all","weekly",10080]',
    from_ms: Date.parse(manualWindow.start), until_ms: Date.parse(manualWindow.end) });
  fixture.measurements.splice(0);
  settle(db, options);
  expectTableIsFull(db, options);

  // Cadence configuration change: the weekly counter of this account becomes a 6-day counter.
  fixture.setCycles({ windows: [{ subscription: CLAUDE, kind: "weekly_all", period_hours: 144, anchor_ts: null }] as never });
  settle(db, options);
  expectTableIsFull(db, options);
  expect(readLimitWindows(db, "claude", CLAUDE, '["weekly_all","weekly",8640]').length).toBeGreaterThan(0);
  expect(readLimitWindows(db, "claude", CLAUDE, '["weekly_all","weekly",10080]')).toEqual([]);
}, 180_000);

test("a resumed segmentation with identical windows advances its checkpoint without invalidating sums", () => {
  const { db, options } = claudeFixture(5);
  settle(db, options);
  windowUsageEntries(db);
  db.query("UPDATE limit_window_state SET changed_from=?,status='filling' WHERE provider='claude' AND account=?")
    .run(START + WEEK, CLAUDE);
  const stats = emptyLimitWindowStats();
  settle(db, { ...options, stats });
  expect(stats.segmentations).toBe(1);
  expect(stats.windowsWritten).toBe(0);
  expect(windowUsageEntries(db)).toEqual([]);
  expectTableIsFull(db, options);
  const repeated = emptyLimitWindowStats();
  settle(db, { ...options, stats: repeated });
  expect(repeated.segmentations).toBe(0);
});

test("a historical percentage correction leaves unchanged later weeks and other counters out of the sums queue", () => {
  const fixture = claudeFixture(8), { db, options } = fixture;
  settle(db, options);
  windowUsageEntries(db);
  const counter = '["weekly_all","weekly",10080]';
  const before = readLimitWindows(db, "claude", CLAUDE, counter);
  const correctedAt = START + WEEK + 2 * DAY;
  db.query("UPDATE probe_windows SET used_percent=29,vendor_percent=29 WHERE provider='claude' AND machine='MAIN' AND kind='weekly_all' AND ts=?")
    .run(iso(correctedAt));
  fixture.refresh();
  const stats = emptyLimitWindowStats();
  settle(db, { ...options, stats });
  const after = readLimitWindows(db, "claude", CLAUDE, counter);
  expect(after.length).toBe(before.length);
  const changed = after.filter((window, index) => JSON.stringify(window) !== JSON.stringify(before[index]));
  expect(changed.length).toBe(1);
  expect(stats.windowsWritten).toBe(1);
  expect(windowUsageEntries(db)).toEqual([{ account: CLAUDE, counter,
    from_ms: Date.parse(changed[0]!.start), until_ms: Date.parse(changed[0]!.end) }]);
  expectTableIsFull(db, options);
});

test("a new Claude reading reads a bounded range, not the account's history", () => {
  const read = (weeks: number): LimitWindowProducerStats => {
    const fixture = claudeFixture(weeks), { db, options } = fixture;
    settle(db, options);
    claudeReading(db, "MAIN", START + weeks * WEEK - HOUR, "weekly_all", 99, START + weeks * WEEK);
    fixture.refresh();
    const stats = emptyLimitWindowStats();
    settle(db, { ...options, stats });
    expectTableIsFull(db, options);
    return stats;
  };
  const short = read(4), long = read(8);
  expect(long.probeRows).toBe(short.probeRows);
  // A resumed meter replays whole overlapping resets; prior same-reset drops may add a boundary row.
  expect(Math.abs(long.inputRows - short.inputRows)).toBeLessThanOrEqual(1);
  expect(Math.max(long.inputRows, short.inputRows)).toBeLessThan(75);
  // 8 weeks have about 140 readings; the update reads about two weeks of them.
  expect(long.probeRows).toBeLessThan(75);
}, 180_000);

test("plan switches, resume, restart and a historical correction preserve one durable window per meter", () => {
  const db = database(), counter = '["weekly_all","weekly",10080]';
  const options: LimitWindowProducerOptions = { sources: [], cycles: { windows: [] }, manualCapacity: () => [] };
  const append = (hour: number, used: number, plan: string) => {
    claudeReading(db, "MAIN", START + hour * HOUR, "weekly_all", used, START + WEEK, plan);
    prepareProbeReaderFixture(db, claudeSources, row => row.subject, false);
    settle(db, options); expectTableIsFull(db, options);
  };
  append(1, 0, "max-20x"); append(144, 94, "max-20x");
  const original = readLimitWindows(db, "claude", CLAUDE, counter)[0]!.id;
  replaceDeclaredPeriods(db, PLAN_PERIODS, [{ provider: "claude", subject: CLAUDE, value: "pro",
    from: iso(START + 146.5 * HOUR), until: null, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "activation" }]);
  append(147, 3, "pro"); append(148, 14, "pro"); append(149, 94, "max-20x"); append(150, 99, "max-20x");
  const result = readLimitWindows(db, "claude", CLAUDE, counter);
  expect(result.map(window => [window.plan, window.readings.at(-1)!.percent])).toEqual([["max-20x", 99], ["pro", 14]]);
  expect(result[0]!.id).toBe(original);
  expect(result[1]!.end).toBe(iso(START + 149 * HOUR));
  expect(result[1]!.cycle_end_basis).toBe("plan_change");
  expect(result[1]!.reset).toBe(iso(START + WEEK));
  expect(result[1]!.start).toBe(iso(START + 146.5 * HOUR));
  expect(result[1]!.activity?.start_basis).toBe("activation");
  const reopened = new Database((db.query("PRAGMA database_list").get() as { file: string }).file);
  try {
    const stats = emptyLimitWindowStats(); settle(reopened, { ...options, stats });
    expect([stats.probeRows, stats.inputRows, stats.windowsWritten]).toEqual([0, 0, 0]);
    expect(readLimitWindows(reopened, "claude", CLAUDE, counter)).toEqual(result);
  } finally { reopened.close(); }
  db.query("UPDATE probe_windows SET used_percent=15,vendor_percent=15 WHERE provider='claude' AND ts=?").run(iso(START + 148 * HOUR));
  prepareProbeReaderFixture(db, claudeSources, row => row.subject, false);
  markLimitWindowsDirty(db, "claude", CLAUDE, START + 148 * HOUR);
  settle(db, options); expectTableIsFull(db, options);
  expect(readLimitWindows(db, "claude", CLAUDE, counter).map(window => window.readings.at(-1)!.percent)).toEqual([99, 15]);
}, 60_000);

// --- Codex (periodic probes, transcript readings and reconciliation) -------------------------------

const CODEX = "codex1";
const codexSources: SourceDeclaration[] = ["/archive", "laptop"].map(source_home => ({
  id: CODEX, vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/fixture`, source_home,
})) as SourceDeclaration[];

function codexFixture(weeks: number) {
  const db = database();
  ensureCodexSchema(db);
  db.query("INSERT INTO account_periods(provider,source,account,from_ts,origin,evidence) VALUES('codex','codex/fixture',?,'2000-01-01T00:00:00Z','declared','fixture')")
    .run(CODEX);
  const probe = db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,
    used_percent,vendor_percent,resets_at,window_minutes,ok,machine) VALUES('codex',?,?,'pro','secondary','codex',NULL,'used',?,?,?,10080,1,'fixture')`);
  const session = db.query("INSERT INTO ratelimit(home,path,ts,window_minutes,used_percent,resets_at,plan_type,limit_id) VALUES(?,?,?,10080,?,?,'pro','codex')");
  const addSession = (home: string, file: string, ts: number, used: number, reset: number) => {
    db.transaction(() => {
      session.run(home, file, iso(ts), used, reset / 1000);
      // The publication marks the transcript it changed, in the same transaction.
      markLimitWindowFilesDirty(db, [{ home, path: file }]);
    }).immediate();
  };
  for (let week = 0; week < weeks; week++) {
    const reset = START + (week + 1) * WEEK;
    for (let step = 1; step < 14; step++) {
      const ts = START + week * WEEK + step * 12 * HOUR;
      if (step % 3 === 0) probe.run(CODEX, iso(ts + 60_000), Math.min(100, step * 6), Math.min(100, step * 6), iso(reset));
      addSession("/archive", `/archive/sessions/w${week}-${step % 4}.jsonl`, ts, Math.min(100, step * 6 + 1), reset + 15_000);
      // A parallel, foreign clock that the reconciliation rejects.
      if (week % 3 === 1 && step > 5 && step < 8) addSession("/archive", `/archive/sessions/p${week}.jsonl`, ts + 600_000, 50 + step, reset + 2 * DAY);
    }
  }
  prepareProbeReaderFixture(db, [{ id: CODEX, vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/fixture`, source_home: "/archive" }], undefined, false);
  const options: LimitWindowProducerOptions = { sources: codexSources, cycles: { windows: [] }, manualCapacity: () => [] };
  return { db, options, addSession,
    addProbe(ts: number, used: number, reset: number) { this.addProbes([[ts, used, reset]]); },
    addProbes(readings: ReadonlyArray<readonly [number, number, number]>) {
      for (const [ts, used, reset] of readings) probe.run(CODEX, iso(ts), used, used, iso(reset));
      prepareProbeReaderFixture(db, [{ id: CODEX, vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/fixture`, source_home: "/archive" }], undefined, false);
    } };
}

test("Free 30-day windows survive restart and correction without replacing 5h or weekly windows", () => {
  const { db, options } = codexFixture(1);
  settle(db, options);
  const legacy = () => db.query("SELECT * FROM limit_windows WHERE provider='codex' AND window_minutes<>43200 ORDER BY counter,seq").all();
  const before = legacy();
  const counter = codexLimitCounter(43200), start = START + WEEK, reset = start + 30 * DAY;
  db.query("DELETE FROM limit_window_state WHERE provider='codex' AND scope=?").run(counter);
  const insert = db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,reported_percent_side,
    used_percent,resets_at,window_minutes,ok,machine) VALUES('codex',?,?,'free','primary','codex','used',?,?,43200,1,'fixture')`);
  for (const [hours, percent] of [[0, 0], [1, 20], [2, 100], [3, 100]]) insert.run(CODEX, iso(start + hours! * HOUR), percent!, iso(reset));
  prepareProbeReaderFixture(db, [{ id: CODEX, vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/fixture`, source_home: "/archive" }], undefined, false);
  settle(db, options);
  const windows = readLimitWindows(db, "codex", CODEX, counter);
  expect(windows).toHaveLength(1);
  expect(windows[0]).toMatchObject({ window_minutes: 43200, reset: iso(reset) });
  expect(legacy()).toEqual(before);
  expectTableIsFull(db, options);
  const file = (db.query("PRAGMA database_list").get() as { file: string }).file;
  const restarted = new Database(file);
  try {
    expect(readLimitWindows(restarted, "codex", CODEX, counter)).toEqual(windows);
    const stats = emptyLimitWindowStats();
    settle(restarted, { ...options, stats });
    expect(stats.windowsWritten).toBe(0);
    expect(stats.probeRows).toBe(0);
  } finally { restarted.close(); }
  db.query("UPDATE probe_windows SET used_percent=35 WHERE provider='codex' AND window_minutes=43200 AND ts=?").run(iso(start + HOUR));
  prepareProbeReaderFixture(db, [{ id: CODEX, vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/fixture`, source_home: "/archive" }], undefined, false);
  markLimitWindowsDirty(db, "codex", CODEX, start + HOUR);
  settle(db, options);
  expect(readLimitWindows(db, "codex", CODEX, counter)[0]!.readings.some(reading => reading.percent === 35)).toBe(true);
  expect(legacy()).toEqual(before);
  expectTableIsFull(db, options);
});

test("source plan repair preserves billing, sums and completed work through upgrade, correction and restart", () => {
  const fixture = codexFixture(0), { db, options } = fixture;
  const file = "/archive/sessions/free.jsonl", counter = codexLimitCounter(10080);
  fixture.addSession("/archive", file, START + HOUR, 8, START + WEEK);
  fixture.addSession("/archive", file, START + 2 * HOUR, 95, START + WEEK);
  db.query("UPDATE ratelimit SET plan_type='free' WHERE path=?").run(file);
  const paid: DatedPeriod = { provider: "codex", subject: CODEX, from: iso(START - DAY), until: iso(START + 30 * DAY),
    value: "plus", origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "payment", amountMinor: 8049, currency: "PLN" };
  replaceDeclaredPeriods(db, PLAN_PERIODS, [paid]);
  settle(db, options);
  const billing = loadPeriods(db, PLAN_PERIODS);
  expect(readLimitWindows(db, "codex", CODEX, counter)[0]!.plan).toBe("free");
  expectTableIsFull(db, options);

  // An installed older version has the same inputs/readings, without source-plan metadata.
  for (const row of db.query("SELECT provider,account,counter,seq,readings FROM limit_windows").all() as any[]) {
    const readings = JSON.parse(row.readings).map(({ plan: _plan, ...reading }: any) => reading);
    db.query("UPDATE limit_windows SET plan='plus',readings=? WHERE provider=? AND account=? AND counter=? AND seq=?")
      .run(JSON.stringify(readings), row.provider, row.account, row.counter, row.seq);
  }
  db.exec("UPDATE limit_window_inputs SET source_plan=NULL; DELETE FROM meta WHERE key='limit_windows_codex_source_plan'; DELETE FROM window_usage_dirty");
  settle(db, options);
  expect(readLimitWindows(db, "codex", CODEX, counter)[0]!.plan).toBe("free");
  expect(db.query("SELECT count(*) n FROM window_usage_dirty").get()).toEqual({ n: 0 });
  expect(loadPeriods(db, PLAN_PERIODS)).toEqual(billing);
  expectTableIsFull(db, options);

  const databasePath = (db.query("PRAGMA database_list").get() as { file: string }).file;
  const reopened = new Database(databasePath);
  try {
    const stats = emptyLimitWindowStats();
    settle(reopened, { ...options, stats });
    expect([stats.probeRows, stats.sessionRows, stats.windowsWritten]).toEqual([0, 0, 0]);
    expect(readLimitWindows(reopened, "codex", CODEX, counter)[0]!.plan).toBe("free");
  } finally { reopened.close(); }

  db.query("UPDATE ratelimit SET plan_type='plus' WHERE path=?").run(file);
  markLimitWindowFilesDirty(db, [{ home: "/archive", path: file }]);
  settle(db, options);
  expect(readLimitWindows(db, "codex", CODEX, counter)[0]!.plan).toBe("plus");
  expect(db.query("SELECT count(*) n FROM window_usage_dirty").get()).toEqual({ n: 0 });
  expect(loadPeriods(db, PLAN_PERIODS)).toEqual(billing);
  expectTableIsFull(db, options);
});

test("Codex registers stay equal to the full reconciliation and segmentation through appended and late readings", () => {
  const fixture = codexFixture(5), { db, options } = fixture;
  settle(db, options);
  expect(expectTableIsFull(db, options)).toBeGreaterThan(4);
  // Appended transcript and periodic readings.
  fixture.addSession("/archive", "/archive/sessions/w4-new.jsonl", START + 5 * WEEK - 3 * HOUR, 97, START + 5 * WEEK + 15_000);
  fixture.addProbe(START + 5 * WEEK - 2 * HOUR, 98, START + 5 * WEEK);
  const stats = emptyLimitWindowStats();
  settle(db, { ...options, stats });
  expectTableIsFull(db, options);
  // A late transcript reading from the second machine, weeks back, opening a parallel clock.
  fixture.addSession("laptop", "laptop/sessions/late.jsonl", START + 2 * WEEK + 2 * DAY, 3, START + 3 * WEEK + 15_000);
  settle(db, options);
  expectTableIsFull(db, options);
}, 180_000);

test("a new Codex reading reads a bounded range, not the account's history", () => {
  const read = (weeks: number): LimitWindowProducerStats => {
    const fixture = codexFixture(weeks), { db, options } = fixture;
    settle(db, options);
    fixture.addSession("/archive", "/archive/sessions/new.jsonl", START + weeks * WEEK - HOUR, 99, START + weeks * WEEK + 15_000);
    const stats = emptyLimitWindowStats();
    settle(db, { ...options, stats });
    expectTableIsFull(db, options);
    return stats;
  };
  const short = read(4), long = read(8);
  expect(long.sessionRows).toBe(short.sessionRows);
  expect(long.probeRows).toBe(short.probeRows);
  expect(long.inputRows).toBe(short.inputRows);
  expect(long.sessionRows).toBeLessThan(75);
}, 180_000);

test("a changed Codex transcript recomputes only the accounts that own its readings", () => {
  const fixture = codexFixture(3), { db } = fixture;
  // A second account on its own home, with periodic and transcript readings of its own.
  const OTHER_CODEX = "codex2", otherHome = `${ARCHIVE_LOGICAL_ROOT}/codex/other`;
  db.query("INSERT INTO account_periods(provider,source,account,from_ts,origin,evidence) VALUES('codex','codex/other',?,'2000-01-01T00:00:00Z','declared','fixture')")
    .run(OTHER_CODEX);
  // The resolver is cached per period revision, which a period writer bumps.
  db.query("INSERT INTO meta(key,value) VALUES(?,'fixture-2') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(ACCOUNT_PERIODS_REVISION);
  const declarations = [{ id: CODEX, vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/fixture`, source_home: "/archive" },
    { id: OTHER_CODEX, vendor: "codex", home: otherHome, source_home: "/other" }] as ProbeReaderFixtureDeclaration[];
  const probe = db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,
    used_percent,vendor_percent,resets_at,window_minutes,ok,machine) VALUES('codex',?,?,'pro','secondary','codex',NULL,'used',?,?,?,10080,1,'fixture')`);
  for (let step = 1; step < 14; step++) {
    const ts = START + step * 12 * HOUR;
    if (step % 3 === 0) probe.run(OTHER_CODEX, iso(ts + 60_000), step * 5, step * 5, iso(START + WEEK));
    fixture.addSession("/other", `/other/sessions/o-${step % 3}.jsonl`, ts, step * 5 + 1, START + WEEK + 15_000);
  }
  prepareProbeReaderFixture(db, declarations, undefined, false);
  const options: LimitWindowProducerOptions = { ...fixture.options,
    sources: [...fixture.options.sources, { id: OTHER_CODEX, vendor: "codex", home: otherHome, source_home: "/other" } as SourceDeclaration] };
  settle(db, options);
  expect(readLimitWindows(db, "codex", OTHER_CODEX, codexLimitCounter(10080)).length).toBeGreaterThan(0);
  fixture.addSession("/archive", "/archive/sessions/w2-new.jsonl", START + 3 * WEEK - 3 * HOUR, 97, START + 3 * WEEK + 15_000);
  // One step: the queued transcript has entered the states, the first scope has started.
  advanceLimitWindows(db, { ...options, budgetMs: 0 });
  const touched = db.query("SELECT DISTINCT account FROM limit_window_state WHERE inputs_from IS NOT NULL OR changed_from IS NOT NULL")
    .all() as Array<{ account: string }>;
  expect(touched.map(row => row.account)).toEqual([CODEX]);
  settle(db, options);
  expectTableIsFull(db, options);
}, 180_000);

test("a recomputation keeps slicing past a day denser than one page of readings", () => {
  const fixture = codexFixture(6), { db, options } = fixture;
  settle(db, options);
  // A late reading in week 1 recomputes from there; a slice ends just after a burst of transcript readings,
  // and a new reading in week 4 is only reached if slicing continues past the burst.
  const late = START + WEEK + 2 * DAY;
  fixture.addSession("/archive", "/archive/sessions/late.jsonl", late, 30, START + 2 * WEEK + 15_000);
  for (let index = 0; index < 80; index++)
    fixture.addSession("/archive", "/archive/sessions/dense.jsonl", late + WEEK - 2 * HOUR + index * 60_000, 26, START + 3 * WEEK + 15_000);
  fixture.addProbes(Array.from({ length: 70 }, (_, index) => [late + WEEK - 3 * HOUR + index * 60_000, 26, START + 3 * WEEK] as const));
  fixture.addSession("/archive", "/archive/sessions/later.jsonl", START + 4 * WEEK + 3 * DAY, 99, START + 5 * WEEK + 15_000);
  const stats = emptyLimitWindowStats();
  settle(db, { ...options, sliceMs: WEEK, stats });
  expect(stats.slices).toBeGreaterThan(1);
  expectTableIsFull(db, options);
}, 180_000);

test("a first fill in one slice stores the rows a fill in week-long slices stores", () => {
  const whole = codexFixture(5);
  settle(whole.db, whole.options);
  const sliced = codexFixture(5);
  settle(sliced.db, sliced.options);
  // The same registers emptied and refilled in chronological week-long slices.
  sliced.db.exec(`DELETE FROM limit_windows; DELETE FROM limit_window_inputs;
    UPDATE limit_window_state SET inputs_from=${START - DAY}, changed_from=NULL, status='filling' WHERE account<>''`);
  const stats = emptyLimitWindowStats();
  settle(sliced.db, { ...sliced.options, sliceMs: WEEK, stats });
  expect(stats.slices).toBeGreaterThan(4);
  const rows = (db: Database, table: string) => db.query(`SELECT * FROM ${table} ORDER BY 1,2,3,4,5,6,7`).all();
  for (const table of ["limit_windows", "limit_window_inputs"]) expect(rows(sliced.db, table)).toEqual(rows(whole.db, table));
  expectTableIsFull(whole.db, whole.options);
}, 180_000);
