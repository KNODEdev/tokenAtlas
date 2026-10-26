import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, replaceObservedPeriods } from "../db/period-store";
import { accountReadingOf, advanceAccountPeriods, observedStarts, planReadingOf, POOL_LOGIN_EVIDENCE, type AccountPeriodFeedOptions } from "./account-period-feed";
import { USAGE_LEDGER_VERSION } from "../db/usage-ledger";
import { observedPeriods, periodSubjectKey, type DatedPeriod, type PeriodReading } from "./account-periods";

const options: AccountPeriodFeedOptions = {
  archiveRoot: "H:/Archive", defaultLogin: "sample_a",
  declarations: [{ vendor: "codex", machine: "PC", home: "H:/Archive/codex/PC-agy11", source_home: "C:/Users/sample_a/.codex-mr" }],
};
function fixture(file = ":memory:"): Database {
  const db = new Database(file);
  applyDrizzleMigrations(drizzle(db));
  return db;
}
function probe(db: Database, provider: string, ts: string, machine: string, login: string | null, extra: unknown, plan: string | null = null): void {
  db.query("INSERT INTO probe_windows (provider, subject, ts, kind, reported_percent_side, ok, machine, profile, extra, plan) VALUES (?, 'stamp', ?, ?, 'used', 1, ?, ?, ?, ?)")
    .run(provider, ts, `k${Math.random()}`, machine, login, JSON.stringify(extra), plan);
}
const claude = (id: string, home = "C:\\Users\\sample_a\\.claude") => ({ home, vendor_account: JSON.stringify({ id, vendor: "claude", key: `k-${id}` }) });
const codex = (subscription: string, home: string, machine = "PC") => ({ codex_account: { subscription, home, login: "sample_a", machine, key: "k" } });

test("the feed uses physical source and observed account while preserving the stamped subject and source evidence", () => {
  const db = fixture();
  const ts = "2026-09-09T15:50:00.000Z";
  probe(db, "codex", ts, "PC", null, codex("observed-account", "C:/Users/sample_a/.codex-mr"));
  db.query("UPDATE probe_windows SET subject = 'stale-account'").run();
  const before = db.query("SELECT subject, extra FROM probe_windows").get();
  const row = db.query("SELECT id, provider, ts, plan, machine, profile, extra FROM probe_windows").get() as Parameters<typeof accountReadingOf>[0];
  expect(accountReadingOf(row, options)).toEqual({ provider: "codex", subject: "codex/pc-agy11", ts, value: "observed-account" });
  expect(advanceAccountPeriods(db, options)).toMatchObject({ readings: 1, unmapped: 0 });
  expect(loadPeriods(db, ACCOUNT_PERIODS).map(p => [p.subject, p.value])).toEqual([["codex/pc-agy11", "observed-account"]]);
  expect(db.query("SELECT subject, extra FROM probe_windows").get()).toEqual(before);
  expect(accountReadingOf({ ...row, extra: JSON.stringify({ home: "C:/Users/sample_a/.codex-mr" }) }, options)).toBeNull();
});

test("new probe rows extend, switch and resume from the stored cursor; both account fields feed one table", () => {
  const db = fixture();
  probe(db, "claude", "2026-09-09T15:48:00.000Z", "PC", "sample_a", claude("acc-a"));
  probe(db, "claude", "2026-09-09T15:48:00.000Z", "PC", "sample_a", claude("acc-a"));
  probe(db, "codex", "2026-09-09T15:50:00.000Z", "PC", null, codex("codex1", "C:\\Users\\sample_a\\.codex-mr"));
  probe(db, "codex", "2026-09-09T15:50:00.000Z", "PC", null, { note: "a reading without an account" });
  probe(db, "claude", "2026-09-09T15:53:00.000Z", "PC", "sample_c", claude("acc-x", "C:\\Users\\sample_c\\.claude"));
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 5, readings: 3, unmapped: 1, rebuilt: [], done: true });
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 0, readings: 0 });

  probe(db, "claude", "2026-09-10T08:00:00.000Z", "PC", "sample_a", claude("acc-a"));
  probe(db, "claude", "2026-09-12T08:00:00.000Z", "PC", "sample_a", claude("acc-b"));
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 2, readings: 2, rebuilt: [] });
  expect(loadPeriods(db, ACCOUNT_PERIODS).map((p) => [p.subject, p.value, p.from, p.until, p.readings])).toEqual([
    ["claude/pc", "acc-a", "2026-09-09T15:48:00.000Z", "2026-09-10T08:00:00.001Z", 2],
    ["claude/pc", "acc-b", "2026-09-12T08:00:00.000Z", null, 1],
    ["codex/PC-agy11".toLowerCase(), "codex1", "2026-09-09T15:50:00.000Z", null, 1],
  ]);
});

test("a late journal from the other computer rebuilds only its own subject and keeps a declared row", () => {
  const db = fixture();
  probe(db, "codex", "2026-09-18T10:00:00.000Z", "LAPTOP", null, codex("codex1", "C:\\Users\\sample_a\\.codex", "LAPTOP"));
  probe(db, "codex", "2026-09-18T10:00:00.000Z", "PC", null, codex("codex1", "C:\\Users\\sample_a\\.codex"));
  advanceAccountPeriods(db, options);
  db.query(`INSERT INTO account_periods (provider, source, from_ts, until_ts, account, origin, evidence)
    VALUES ('codex', 'codex/laptop-sample_a', '2026-01-01', '2026-02-01', 'declared-account', 'declared', 'owner-declaration')`).run();
  const pcBefore = loadPeriods(db, ACCOUNT_PERIODS).filter((p) => p.subject === "codex/pc-sample_a");

  probe(db, "codex", "2026-09-11T09:00:00.000Z", "LAPTOP", null, codex("codex-old", "C:\\Users\\sample_a\\.codex", "LAPTOP"));
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 1, rebuilt: ["codex/codex/laptop-sample_a"] });
  const periods = loadPeriods(db, ACCOUNT_PERIODS);
  expect(periods.filter((p) => p.subject === "codex/laptop-sample_a").map((p) => [p.origin, p.value, p.from, p.until])).toEqual([
    ["declared", "declared-account", "2026-01-01", "2026-02-01"],
    ["observed", "codex-old", "2026-09-11T09:00:00.000Z", "2026-09-11T09:00:00.001Z"],
    ["observed", "codex1", "2026-09-18T10:00:00.000Z", null],
  ]);
  expect(periods.filter((p) => p.subject === "codex/pc-sample_a")).toEqual(pcBefore);
});

test("the first fill in small batches gives the same rows as one pass", () => {
  const seed = (db: Database) => {
    for (let i = 0; i < 40; i++) probe(db, "claude", new Date(Date.UTC(2026, 8, 9, 0, i * 5)).toISOString(), "PC", "sample_a", claude(i < 25 ? "acc-a" : "acc-b"));
  };
  const whole = fixture(), stepped = fixture();
  seed(whole); seed(stepped);
  advanceAccountPeriods(whole, options);
  let steps = 0;
  while (!advanceAccountPeriods(stepped, { ...options, batch: 7 }).done) steps++;
  expect(steps).toBeGreaterThan(3);
  expect(loadPeriods(stepped, ACCOUNT_PERIODS)).toEqual(loadPeriods(whole, ACCOUNT_PERIODS));
});

test("the profile's rate-limit tier feeds plan periods of the account, dated by when the profile was fetched", () => {
  const db = fixture();
  const home = "C:\\Users\\sample_a\\.claude";
  const withPlan = (tier: string, fetched: string) => ({ home, vendor_account: JSON.stringify({ id: "acc-a", vendor: "claude",
    key: "k", plan: "pro", profiles: [{ home, machine: "PC", planTier: tier, planReadAt: fetched }] }) });
  probe(db, "claude", "2026-08-31T10:00:00.000Z", "PC", "sample_a", withPlan("default_claude_max_20x", "2026-08-31T09:00:00.000Z"));
  // A stale profile read again: same fetch instant, no new evidence.
  probe(db, "claude", "2026-09-05T10:00:00.000Z", "PC", "sample_a", withPlan("default_claude_max_20x", "2026-08-31T09:00:00.000Z"));
  probe(db, "claude", "2026-09-12T10:00:00.000Z", "PC", "sample_a", withPlan("default_claude_max_5x", "2026-09-12T09:30:00.000Z"));
  // Readings from before the tier was recorded carry only the token's label and open no plan period.
  probe(db, "claude", "2026-09-13T10:00:00.000Z", "PC", "sample_a", claude("acc-a"));
  expect(advanceAccountPeriods(db, options)).toMatchObject({ readings: 4, planReadings: 3, rebuilt: [] });
  expect(loadPeriods(db, PLAN_PERIODS).map((p) => [p.subject, p.value, p.from, p.until, p.readings])).toEqual([
    ["acc-a", "max-20x", "2026-08-31T09:00:00.000Z", "2026-08-31T09:00:00.001Z", 1],
    ["acc-a", "max-5x", "2026-09-12T09:30:00.000Z", null, 1],
  ]);
  expect(loadPeriods(db, PLAN_PERIODS).map(p => JSON.parse(p.evidence).rawPlan)).toEqual(["default_claude_max_20x", "default_claude_max_5x"]);
  db.query("UPDATE meta SET value='2' WHERE key='plan_periods_rules'").run();
  const before = loadPeriods(db, PLAN_PERIODS);
  expect(advanceAccountPeriods(db, options).rebuilt).toEqual(["plan:claude/acc-a"]);
  expect(loadPeriods(db, PLAN_PERIODS)).toEqual(before);
});

/** One Claude profile reading: [taken at, machine, tier, fetched at, probe reached the account]. */
type ProfileReading = [string, string, string, string, boolean];
const MAX20 = "default_claude_max_20x", PRO = "default_claude_ai", SHARED_FETCH = "2026-10-23T15:21:13.844Z";
/** Feeds the readings one probe at a time (live) and all at once (rebuild); both must agree. */
function liveAndWhole(readings: readonly ProfileReading[]) {
  const home = "C:\Users\sample_a\.claude";
  const insert = (db: Database, [ts, machine, tier, fetched, reached]: ProfileReading) => db.query(`INSERT INTO probe_windows
      (provider, subject, ts, kind, reported_percent_side, ok, machine, profile, extra) VALUES ('claude', 'stamp', ?, ?, 'used', ?, ?, 'sample_a', ?)`)
    .run(ts, reached ? `k${Math.random()}` : "error", reached ? 1 : 0, machine, JSON.stringify({ home, vendor_account: JSON.stringify({
      id: "acc-a", vendor: "claude", key: "k", profiles: [{ home, machine, planTier: tier, planReadAt: fetched }] }) }));
  const live = fixture(), whole = fixture();
  for (const reading of readings) { insert(live, reading); advanceAccountPeriods(live, options); insert(whole, reading); }
  advanceAccountPeriods(whole, options);
  const shape = (db: Database) => loadPeriods(db, PLAN_PERIODS).map((p) => [p.value, p.from, p.until, p.lastSeen]);
  expect(shape(whole)).toEqual(shape(live));
  return { periods: shape(live), evidence: loadPeriods(live, PLAN_PERIODS).map((p) => JSON.parse(p.evidence)) };
}
// 24.10.2026: the CLI rewrote Max 20x to Pro under the same fetch time; usage was refused from 10:03 to the purchase.
const planChange: ProfileReading[] = [
  ["2026-10-23T15:00:00.000Z", "PC", MAX20, "2026-10-23T14:48:51.809Z", true],
  ["2026-10-23T15:22:51.685Z", "PC", MAX20, SHARED_FETCH, true], ["2026-10-24T09:53:27.025Z", "PC", MAX20, SHARED_FETCH, true],
  ["2026-10-24T10:03:26.585Z", "PC", MAX20, SHARED_FETCH, false], ["2026-10-24T12:45:16.915Z", "PC", MAX20, SHARED_FETCH, false],
  ["2026-10-24T12:55:18.153Z", "PC", PRO, SHARED_FETCH, true], ["2026-10-24T13:05:17.385Z", "PC", PRO, SHARED_FETCH, true],
  ["2026-10-24T14:00:00.000Z", "PC", PRO, "2026-10-24T13:59:00.000Z", true],
];

test("a fetch instant that shows two plans dates its readings by when they were taken, counting only probes that reached the account", () => {
  const { periods, evidence } = liveAndWhole(planChange);
  expect(periods).toEqual([
    ["max-20x", "2026-10-23T14:48:51.809Z", "2026-10-24T09:53:27.026Z", "2026-10-24T09:53:27.025Z"],
    ["default_claude_ai", "2026-10-24T12:55:18.153Z", null, "2026-10-24T13:59:00.000Z"],
  ]);
  expect(evidence[1]).toEqual({ kind: "profile-reading", rawPlan: PRO, fetchedAt: SHARED_FETCH });
});

test("a second computer whose CLI has not refreshed yet does not move the change", () => {
  const laptop: ProfileReading[] = [
    ["2026-10-24T11:00:00.000Z", "LAPTOP", MAX20, "2026-10-23T12:00:00.000Z", true],
    ["2026-10-24T13:10:00.000Z", "LAPTOP", MAX20, "2026-10-23T12:00:00.000Z", false],
    ["2026-10-24T14:30:00.000Z", "LAPTOP", PRO, "2026-10-24T14:29:00.000Z", true],
  ];
  const mixed = [...planChange, ...laptop].sort((a, b) => a[0].localeCompare(b[0]));
  expect(liveAndWhole(mixed).periods).toEqual([
    ["max-20x", "2026-10-23T12:00:00.000Z", "2026-10-24T09:53:27.026Z", "2026-10-24T09:53:27.025Z"],
    ["default_claude_ai", "2026-10-24T12:55:18.153Z", null, "2026-10-24T14:29:00.000Z"],
  ]);
});

test("a plan that flips back under the same fetch instant runs again from its next reading", () => {
  const T = SHARED_FETCH;
  expect(liveAndWhole([
    ["2026-10-24T09:00:00.000Z", "PC", MAX20, T, true], ["2026-10-24T09:10:00.000Z", "PC", PRO, T, true],
    ["2026-10-24T09:20:00.000Z", "PC", PRO, T, false], ["2026-10-24T09:30:00.000Z", "PC", MAX20, T, true],
    ["2026-10-24T09:40:00.000Z", "PC", MAX20, "2026-10-24T09:35:00.000Z", true],
  ]).periods).toEqual([
    ["max-20x", "2026-10-24T09:00:00.000Z", "2026-10-24T09:00:00.001Z", "2026-10-24T09:00:00.000Z"],
    ["default_claude_ai", "2026-10-24T09:10:00.000Z", "2026-10-24T09:10:00.001Z", "2026-10-24T09:10:00.000Z"],
    ["max-20x", "2026-10-24T09:30:00.000Z", null, "2026-10-24T09:35:00.000Z"],
  ]);
});

test("a reading without a machine takes the profile of that home read most recently", () => {
  const db = fixture();
  const home = "C:\\Users\\sample_a\\.claude";
  probe(db, "claude", "2026-10-24T13:00:00.000Z", "", "sample_a", { home, vendor_account: JSON.stringify({ id: "acc-a", vendor: "claude", key: "k",
    profiles: [{ home, machine: "LAPTOP", planTier: "default_claude_max_20x", planReadAt: "2026-10-23T14:48:51.809Z" },
      { home, machine: "PC", planTier: "default_claude_ai", planReadAt: "2026-10-23T15:21:13.844Z" }] }) });
  advanceAccountPeriods(db, options);
  expect(loadPeriods(db, PLAN_PERIODS).map((p) => [p.value, p.from])).toEqual([["default_claude_ai", "2026-10-23T15:21:13.844Z"]]);
});

test("Codex's plan comes with every rate-limit reading and belongs to the account, whichever computer read it", () => {
  const db = fixture();
  const home = "C:\\Users\\sample_a\\.codex-mr";
  probe(db, "codex", "2026-09-01T10:00:00.000Z", "PC", null, codex("codex1", home), "plus");
  probe(db, "codex", "2026-09-02T10:00:00.000Z", "LAPTOP", null, codex("codex1", home, "LAPTOP"), "plus");
  // A reading that lost its plan (an error answer) says nothing about the plan.
  probe(db, "codex", "2026-09-03T10:00:00.000Z", "PC", null, codex("codex1", home), null);
  probe(db, "codex", "2026-09-04T10:00:00.000Z", "PC", null, codex("codex1", home), "pro");
  // Claude's own `plan` column is the token's label, not evidence; only the profile tier opens a plan period.
  probe(db, "claude", "2026-09-04T11:00:00.000Z", "PC", "sample_a", claude("acc-a"), "pro");
  expect(advanceAccountPeriods(db, options)).toMatchObject({ planReadings: 3, rebuilt: [] });
  expect(loadPeriods(db, PLAN_PERIODS).map((p) => [p.provider, p.subject, p.value, p.from, p.until, p.readings])).toEqual([
    ["codex", "codex1", "plus", "2026-09-01T10:00:00.000Z", "2026-09-02T10:00:00.001Z", 2],
    ["codex", "codex1", "pro", "2026-09-04T10:00:00.000Z", null, 1],
  ]);
});

test("a reading never opens the reserved \"none\" plan: only the owner declares a stretch without a subscription", () => {
  const db = fixture();
  const home = "C:\\Users\\sample_a\\.codex-mr";
  probe(db, "codex", "2026-09-01T10:00:00.000Z", "PC", null, codex("codex1", home), "plus");
  probe(db, "codex", "2026-09-02T10:00:00.000Z", "PC", null, codex("codex1", home), "none");
  probe(db, "codex", "2026-09-03T10:00:00.000Z", "PC", null, codex("codex1", home), "None");
  expect(advanceAccountPeriods(db, options)).toMatchObject({ planReadings: 1 });
  expect(loadPeriods(db, PLAN_PERIODS).map((p) => [p.value, p.from, p.until])).toEqual([["plus", "2026-09-01T10:00:00.000Z", null]]);
});

test("a changed plan rule rebuilds the plan track once from readings the cursor already passed", () => {
  const db = fixture();
  const home = "C:\\Users\\sample_a\\.codex-mr";
  probe(db, "codex", "2026-09-01T10:00:00.000Z", "PC", null, codex("codex1", home), "plus");
  probe(db, "codex", "2026-09-02T10:00:00.000Z", "PC", null, codex("codex1", home), "pro");
  advanceAccountPeriods(db, options);
  // A database fed under the previous rules: the cursor is past the readings and no plan row exists.
  db.exec("DELETE FROM plan_periods; DELETE FROM meta WHERE key = 'plan_periods_rules'");
  const accounts = loadPeriods(db, ACCOUNT_PERIODS);
  const query = db.query.bind(db);
  let scans = 0;
  db.query = ((...args: Parameters<Database["query"]>) => {
    if (/FROM probe_windows WHERE id <= \?/.test(args[0])) { expect(db.inTransaction).toBe(false); scans++; }
    return query(...args);
  }) as Database["query"];
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 0, readings: 0, planReadings: 0, rebuilt: ["plan:codex/codex1"] });
  expect(scans).toBe(1);
  expect(loadPeriods(db, PLAN_PERIODS).map((p) => [p.subject, p.value, p.from, p.until])).toEqual([
    ["codex1", "plus", "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.001Z"],
    ["codex1", "pro", "2026-09-02T10:00:00.000Z", null],
  ]);
  expect(loadPeriods(db, ACCOUNT_PERIODS)).toEqual(accounts);
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 0, rebuilt: [] });
});

function seedBacklog(db: Database): void {
  for (const day of [20, 10, 25, 5, 15, 30]) for (let i = 0; i < 12; i++) {
    const machine = "PC-" + i, ts = new Date(Date.UTC(2026, 8, day)).toISOString();
    const home = "C:/Users/sample_a/.codex", account = (day < 15 ? "old-" : "acc-") + i;
    probe(db, "codex", ts, machine, null, codex(account, home, machine), day < 15 ? "plus" : "pro");
    const claudeHome = "C:/Users/sample_a/.claude", tier = day < 15 ? "default_claude_max_20x" : "default_claude_max_5x";
    probe(db, "claude", ts, machine, "sample_a", { home: claudeHome, vendor_account: {
      id: account, profiles: [{ home: claudeHome, machine, planTier: tier, planReadAt: ts }] } });
  }
  db.exec(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,evidence)
    VALUES('codex','codex/pc-0-sample_a','2026-01-01','2026-02-01','declared','declared','owner');
    INSERT INTO plan_periods(provider,account,from_ts,until_ts,plan,origin,evidence)
    VALUES('codex','acc-0','2026-01-01','2026-02-01','plus','declared','owner')`);
}
const periodSnapshot = (db: Database) => ({ accounts: loadPeriods(db, ACCOUNT_PERIODS), plans: loadPeriods(db, PLAN_PERIODS) });
function fullReference(db: Database): ReturnType<typeof periodSnapshot> {
  const rows = db.query("SELECT id,provider,ts,plan,machine,profile,extra FROM probe_windows ORDER BY id").all() as Parameters<typeof accountReadingOf>[0][];
  for (const table of [ACCOUNT_PERIODS, PLAN_PERIODS]) {
    const groups = new Map<string, Array<PeriodReading & { evidence?: string }>>();
    for (const row of rows) {
      const reading = table === ACCOUNT_PERIODS ? accountReadingOf(row, options) : planReadingOf(row);
      if (!reading || reading === "unmapped") continue;
      const key = periodSubjectKey(reading.provider, reading.subject), readings = groups.get(key) ?? [];
      readings.push(reading); groups.set(key, readings);
    }
    for (const readings of groups.values()) {
      const periods = observedPeriods(readings).map(p => ({ ...p,
        evidence: readings.find(r => r.ts === p.from && r.value === p.value)?.evidence ?? p.evidence }));
      replaceObservedPeriods(db, table, readings[0]!.provider, readings[0]!.subject, periods);
    }
  }
  return periodSnapshot(db);
}

test("many late subjects converge across batch sizes to a full reference without scans during backlog", () => {
  const reference = fixture(); seedBacklog(reference);
  const expected = fullReference(reference); reference.close();
  for (const batch of [3, 7, 1000]) {
    const db = fixture(); seedBacklog(db);
    const query = db.query.bind(db);
    let scans = 0, pendingCalls = 0;
    db.query = ((...args: Parameters<Database["query"]>) => {
      if (/WHERE provider = \? AND id <= \?/.test(args[0])) {
        expect(db.inTransaction).toBe(false); scans++;
      }
      return query(...args);
    }) as Database["query"];
    try {
      for (let turn = 0; ; turn++) {
        expect(turn).toBeLessThan(100);
        const before = scans, fed = advanceAccountPeriods(db, { ...options, batch });
        if (fed.rows === batch) {
          expect(fed.done).toBe(false); expect(fed.rebuilt).toEqual([]); expect(scans).toBe(before);
        }
        const pending = JSON.parse((db.query("SELECT value FROM meta WHERE key='account_periods_probe_pending'").get() as { value: string }).value) as { accounts: unknown[]; plans: unknown[] };
        if (pending.accounts.length || pending.plans.length) { pendingCalls++; expect(fed.done).toBe(false); }
        if (fed.done) break;
      }
      if (batch < 1000) { expect(pendingCalls).toBeGreaterThan(0); expect(scans).toBe(2); }
      expect(periodSnapshot(db)).toEqual(expected);
    } finally { db.close(); }
  }
});

test("a new connection resumes both durable pending tracks in the middle of a backlog", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-period-restart-")), file = path.join(root, "feed.sqlite");
  let db = fixture(file);
  const reference = fixture(); seedBacklog(reference);
  const expected = fullReference(reference); reference.close();
  try {
    seedBacklog(db);
    for (let i = 0; i < 28; i++) expect(advanceAccountPeriods(db, { ...options, batch: 3 })).toMatchObject({ done: false, rebuilt: [] });
    const saved = (db.query("SELECT value FROM meta WHERE key='account_periods_probe_pending'").get() as { value: string }).value;
    const pending = JSON.parse(saved) as { accounts: unknown[]; plans: unknown[] };
    expect(pending.accounts.length).toBeGreaterThan(0); expect(pending.plans.length).toBeGreaterThan(0);
    db.close(); db = new Database(file);
    expect((db.query("SELECT value FROM meta WHERE key='account_periods_probe_pending'").get() as { value: string }).value).toBe(saved);
    let turns = 0;
    while (!advanceAccountPeriods(db, { ...options, batch: 7 }).done) expect(++turns).toBeLessThan(100);
    expect(periodSnapshot(db)).toEqual(expected);
    expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 0, rebuilt: [], done: true });
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a changed cursor rejects pending publication and keeps done false even on an empty batch", () => {
  const db = fixture();
  const home = "C:/Users/sample_a/.codex-mr";
  probe(db, "codex", "2026-09-20T00:00:00.000Z", "PC", null, codex("acc", home), "pro");
  advanceAccountPeriods(db, options);
  probe(db, "codex", "2026-09-10T00:00:00.000Z", "PC", null, codex("acc", home), "plus");
  expect(advanceAccountPeriods(db, { ...options, batch: 1 })).toMatchObject({ done: false, rebuilt: [] });
  const query = db.query.bind(db);
  let invalidate = true;
  db.query = ((...args: Parameters<Database["query"]>) => {
    if (invalidate && /WHERE provider = \? AND id <= \?/.test(args[0])) {
      invalidate = false;
      query("UPDATE meta SET value='3' WHERE key='account_periods_probe_cursor'").run();
    }
    return query(...args);
  }) as Database["query"];
  try {
    expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 0, done: false, rebuilt: [] });
    expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 0, done: true, rebuilt: ["codex/codex/pc-agy11", "plan:codex/acc"] });
    expect(loadPeriods(db, PLAN_PERIODS).map(p => p.value)).toEqual(["plus", "pro"]);
  } finally { db.close(); }
});

// Readings as `vendor-identity.ts` records them: the Gemini CLI account of a profile, and an Antigravity pool worker.
const geminiCli = (id: string, login = "sample_a") => ({ home: `C:\\Users\\${login}\\.gemini`, vendor_account: JSON.stringify({ id, vendor: "gemini" }) });
const pool = (worker: string, login: string, id: string) => ({ home: `pool:${worker}`, vendor_account: JSON.stringify({ id, vendor: "gemini",
  profiles: [{ vendor: "gemini", surface: "antigravity", machine: "PC", login, home: `pool:${worker}` }] }) });
function geminiCycle(db: Database, ts: string): void {
  probe(db, "gemini", ts, "PC", "sample_a", geminiCli("gemini-cli"));
  probe(db, "gemini", ts.replace(/\.000Z$/, ".013Z"), "PC", "sample_a", pool("main", "sample_a", "gemini-pool-main"));
  probe(db, "gemini", ts.replace(/\.000Z$/, ".045Z"), "PC", "agy08", pool("agy08", "agy08", "gemini-pool-08"));
}
const accountRows = (db: Database, provider = "gemini") => loadPeriods(db, ACCOUNT_PERIODS).filter(p => p.provider === provider)
  .map(p => [p.subject, p.value, p.from, p.until, p.firstSeen, p.evidence]);
const seenAccounts = (db: Database) => JSON.parse((db.query("SELECT value FROM meta WHERE key='account_periods_seen_accounts'").get() as { value: string }).value);

test("pool readings feed their worker's source; the pool login outranks the Gemini CLI account read on the same source", () => {
  const db = fixture();
  geminiCycle(db, "2026-09-09T15:48:11.000Z");
  geminiCycle(db, "2026-09-09T15:58:11.000Z");
  expect(advanceAccountPeriods(db, options)).toMatchObject({ readings: 6, unmapped: 0, rebuilt: ["gemini/gemini/pc-sample_a"], done: true });
  geminiCycle(db, "2026-09-09T16:08:11.000Z");
  expect(advanceAccountPeriods(db, options)).toMatchObject({ readings: 3, rebuilt: [], done: true });
  // One period per source: the weaker identity neither splits nor moves it.
  expect(accountRows(db)).toEqual([
    ["gemini/pc-agy08", "gemini-pool-08", "2026-09-09T15:48:11.045Z", null, "2026-09-09T15:48:11.045Z", POOL_LOGIN_EVIDENCE],
    ["gemini/pc-sample_a", "gemini-pool-main", "2026-09-09T15:48:11.013Z", null, "2026-09-09T15:48:11.013Z", POOL_LOGIN_EVIDENCE],
  ]);
  expect(loadPeriods(db, ACCOUNT_PERIODS).find(p => p.subject === "gemini/pc-sample_a")!.readings).toBe(3);
  // Both accounts stay on record as seen on that source.
  expect(seenAccounts(db)["gemini|gemini/pc-sample_a"]).toEqual(["gemini-cli", "gemini-pool-main"]);
  // A profile without a pool worker keeps its Gemini CLI account.
  probe(db, "gemini", "2026-09-11T09:52:10.000Z", "LAPTOP", "sample_a", geminiCli("gemini-laptop"));
  advanceAccountPeriods(db, options);
  expect(accountRows(db).find(r => r[0] === "gemini/laptop-sample_a")).toEqual(["gemini/laptop-sample_a", "gemini-laptop", "2026-09-11T09:52:10.000Z", null, "2026-09-11T09:52:10.000Z", "profile-reading"]);
});

test("an existing database reads the readings it already passed once under the new account rules", () => {
  const db = fixture();
  geminiCycle(db, "2026-09-09T15:48:11.000Z");
  advanceAccountPeriods(db, options);
  // The state the previous rules left: pool readings unmapped, the Gemini CLI account on the shared source.
  db.query("DELETE FROM account_periods").run();
  db.query("DELETE FROM meta WHERE key IN ('account_periods_rules','account_periods_seen_accounts')").run();
  replaceObservedPeriods(db, ACCOUNT_PERIODS, "gemini", "gemini/pc-sample_a", observedPeriods([
    { provider: "gemini", subject: "gemini/pc-sample_a", ts: "2026-09-09T15:48:11.000Z", value: "gemini-cli" }]));
  const rebuilt = advanceAccountPeriods(db, options);
  expect(rebuilt).toMatchObject({ rows: 0, done: true });
  expect(rebuilt.rebuilt.sort()).toEqual(["gemini/gemini/pc-agy08", "gemini/gemini/pc-sample_a"]);
  expect(accountRows(db).map(r => [r[0], r[1]])).toEqual([["gemini/pc-agy08", "gemini-pool-08"], ["gemini/pc-sample_a", "gemini-pool-main"]]);
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 0, rebuilt: [], done: true });
});

function ledgerFirstCalls(db: Database, calls: Record<string, string>): void {
  db.query(`INSERT OR REPLACE INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest,revision,published_revision)
    VALUES('gemini', ?, 'reconcile', 'ready', 0, '', '', 1, 1)`).run(USAGE_LEDGER_VERSION);
  let id = 0;
  for (const [source, ts] of Object.entries(calls)) {
    db.query("INSERT INTO usage_ledger_dims(id,provider,key,source) VALUES(?, 'gemini', ?, ?)").run(++id, `k${id}`, source);
    db.query(`INSERT INTO usage_ledger_hours(provider,day,hour,dim_id,calls,first_ts,last_ts,t_uncached,t_cache_read,t_write_5m,t_write_1h,
      t_write_unknown,t_out,t_thinking) VALUES('gemini', ?, ?, ?, 1, ?, ?, 0, 0, 0, 0, 0, 1, 0)`)
      .run(ts.slice(0, 10), Math.floor(Date.parse(ts) / 3_600_000), id, ts, ts);
  }
}
const dirty = (db: Database) => ({
  usage: db.query("SELECT provider, account, from_ms, until_ms FROM window_usage_dirty ORDER BY account, from_ms").all(),
  windows: db.query("SELECT provider, account, kind, from_ms FROM limit_window_dirty ORDER BY account").all(),
});
const clearDirty = (db: Database) => { db.query("DELETE FROM window_usage_dirty").run(); db.query("DELETE FROM limit_window_dirty").run(); };

test("a source that only ever showed one account keeps it back to its first call; only that account's moved range is invalidated", () => {
  const db = fixture();
  geminiCycle(db, "2026-09-09T15:48:11.000Z");
  advanceAccountPeriods(db, options);
  expect(accountRows(db).map(r => r[2])).toEqual(["2026-09-09T15:48:11.045Z", "2026-09-09T15:48:11.013Z"]);
  ledgerFirstCalls(db, { "gemini/pc-agy08": "2026-08-18T12:29:44.000Z", "gemini/pc-sample_a": "2026-06-21T11:12:34.000Z" });
  clearDirty(db);
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 0, rebuilt: ["start:gemini/gemini/pc-agy08"], done: true });
  // pc-sample_a showed two accounts (Gemini CLI and the pool), so its history before the first reading stays uncovered.
  expect(accountRows(db).map(r => [r[0], r[2], r[4]])).toEqual([
    ["gemini/pc-agy08", "2026-08-18T12:29:44.000Z", "2026-09-09T15:48:11.045Z"],
    ["gemini/pc-sample_a", "2026-09-09T15:48:11.013Z", "2026-09-09T15:48:11.013Z"],
  ]);
  const moved = { from: Date.parse("2026-08-18T12:29:44.000Z"), until: Date.parse("2026-09-09T15:48:11.045Z") };
  expect(dirty(db)).toEqual({
    usage: [{ provider: "gemini", account: "gemini-pool-08", from_ms: moved.from, until_ms: moved.until }],
    windows: [{ provider: "gemini", account: "gemini-pool-08", kind: "inputs", from_ms: moved.from }],
  });
  // Restart: nothing moves again.
  clearDirty(db);
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 0, rebuilt: [], done: true });
  expect(dirty(db)).toEqual({ usage: [], windows: [] });

  // A second account on the source withdraws the whole-history start; the readings keep their own periods.
  probe(db, "gemini", "2026-09-20T10:00:00.000Z", "PC", "agy08", pool("agy08", "agy08", "gemini-other"));
  clearDirty(db);
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 1, rebuilt: ["start:gemini/gemini/pc-agy08"], done: true });
  expect(accountRows(db).filter(r => r[0] === "gemini/pc-agy08").map(r => [r[1], r[2], r[3]])).toEqual([
    ["gemini-pool-08", "2026-09-09T15:48:11.045Z", "2026-09-09T15:48:11.046Z"],
    ["gemini-other", "2026-09-20T10:00:00.000Z", null],
  ]);
  const usage = dirty(db).usage as Array<{ provider: string; account: string; from_ms: number; until_ms: number | null }>;
  expect([...new Set(usage.map(r => r.account))].sort()).toEqual(["gemini-other", "gemini-pool-08"]);
  expect(usage).toContainEqual({ provider: "gemini", account: "gemini-pool-08", from_ms: moved.from, until_ms: moved.until });
});

test("whole-history starts skip declared sources, Codex and ledgers still being prepared", () => {
  const observed = (provider: string, subject: string, value: string, ts: string): DatedPeriod => ({ provider, subject, from: ts, until: null,
    value, origin: "observed", firstSeen: ts, lastSeen: ts, readings: 1, evidence: "profile-reading" });
  const first = "2026-08-01T00:00:00.000Z", reading = "2026-09-09T00:00:00.000Z";
  const periods: DatedPeriod[] = [
    observed("grok", "grok/pc-sample_a", "grok-a", reading),
    observed("codex", "codex/pc-sample_a", "codex1", reading),
    observed("claude", "claude/pc", "claude-a", reading),
    { ...observed("claude", "claude/PC", "claude-a", "2026-07-01"), origin: "declared", until: "2026-07-02" },
    observed("gemini", "gemini/pc-agy09", "gemini-b", reading),
  ];
  const calls: Record<string, string | null | undefined> = { "grok/pc-sample_a": first, "codex/pc-sample_a": first, "claude/pc": first, "gemini/pc-agy09": undefined };
  expect(observedStarts(periods, {}, (_provider, source) => calls[source])).toEqual([{ provider: "grok", subject: "grok/pc-sample_a", from: first }]);
  // A start already moved returns to the first reading once the source is contested.
  const moved = periods.map(p => p.subject === "grok/pc-sample_a" ? { ...p, from: first } : p);
  expect(observedStarts(moved, { "grok|grok/pc-sample_a": ["grok-a", "grok-b"] }, (_provider, source) => calls[source]))
    .toEqual([{ provider: "grok", subject: "grok/pc-sample_a", from: reading }]);
});

test("a profile declared after its readings were passed gets its periods from the first reading; only its source is rebuilt", () => {
  const db = fixture();
  const laptop = (subscription: string, ts: string) => probe(db, "codex", ts, "LAPTOP", null, codex(subscription, "C:/Users/sample_a/.codex-2", "LAPTOP"));
  probe(db, "codex", "2026-09-18T09:00:00.000Z", "PC", null, codex("codex1", "C:/Users/sample_a/.codex-mr"));
  laptop("other-account", "2026-09-18T09:00:00.000Z");
  laptop("codex2", "2026-09-23T09:00:00.000Z");
  laptop("codex2", "2026-10-09T22:00:00.000Z");
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rows: 4, readings: 1, unmapped: 3, rebuilt: [], done: true });
  const pc = loadPeriods(db, ACCOUNT_PERIODS);
  const declared = { ...options, declarations: [...options.declarations,
    { vendor: "codex", machine: "LAPTOP", home: "H:/Archive/codex/LAPTOP-sample_a-codex-2", source_home: "C:/Users/sample_a/.codex-2" }] };
  const laptopRows = () => loadPeriods(db, ACCOUNT_PERIODS).filter(p => p.subject === "codex/laptop-sample_a-codex-2").map(p => [p.value, p.from, p.until]);
  const expected = [["other-account", "2026-09-18T09:00:00.000Z", "2026-09-18T09:00:00.001Z"], ["codex2", "2026-09-23T09:00:00.000Z", null]];

  // No new reading: the declaration alone rebuilds the one source it maps, from all of its readings.
  expect(advanceAccountPeriods(db, declared)).toMatchObject({ rows: 0, rebuilt: ["codex/codex/laptop-sample_a-codex-2"], done: true });
  expect(laptopRows()).toEqual(expected);
  expect(loadPeriods(db, ACCOUNT_PERIODS).filter(p => p.subject !== "codex/laptop-sample_a-codex-2")).toEqual(pc);
  expect(seenAccounts(db)["codex|codex/laptop-sample_a-codex-2"]).toEqual(["codex2", "other-account"]);
  expect(advanceAccountPeriods(db, declared)).toMatchObject({ rows: 0, rebuilt: [], done: true });

  // A database fed before the declarations were kept: a declared source without observed periods catches up.
  db.query("DELETE FROM account_periods WHERE source = 'codex/laptop-sample_a-codex-2'").run();
  db.query("DELETE FROM meta WHERE key = 'account_periods_sources'").run();
  expect(advanceAccountPeriods(db, declared)).toMatchObject({ rebuilt: ["codex/codex/laptop-sample_a-codex-2"], done: true });
  expect(laptopRows()).toEqual(expected);

  // Withdrawing the declaration empties the source again.
  expect(advanceAccountPeriods(db, options)).toMatchObject({ rebuilt: ["codex/codex/laptop-sample_a-codex-2"], done: true });
  expect(laptopRows()).toEqual([]);
  expect(loadPeriods(db, ACCOUNT_PERIODS)).toEqual(pc);
});

test("readings stamped with a minted id of a declared login count for that login; only the sources that showed it are rebuilt", () => {
  const db = fixture();
  const home = "C:/Users/sample_a/.codex-3";
  const reading = (subscription: string, ts: string) => db.query(`INSERT INTO probe_windows (provider, subject, ts, kind, reported_percent_side, ok,
    machine, extra, plan) VALUES ('codex', ?, ?, ?, 'used', 1, 'LAPTOP', ?, 'plus')`).run(subscription, ts, `k${Math.random()}`, JSON.stringify({ home,
    codex_account: JSON.stringify({ key: "account:a1", account_id: "a1", email: "hello@example.com", subscription, home, login: "sample_a", machine: "LAPTOP" }) }));
  const declared = { ...options, declarations: [...options.declarations,
    { vendor: "codex", machine: "LAPTOP", home: "H:/Archive/codex/LAPTOP-sample_a-codex-3", source_home: home }] };
  probe(db, "codex", "2026-09-18T09:00:00.000Z", "PC", null, codex("codex1", "C:/Users/sample_a/.codex-mr"));
  reading("codex3", "2026-09-18T09:00:00.000Z");
  reading("chatgpt-minted", "2026-09-29T10:00:00.000Z");
  reading("codex3", "2026-10-06T21:00:00.000Z");
  advanceAccountPeriods(db, declared);
  const laptopRows = () => loadPeriods(db, ACCOUNT_PERIODS).filter(p => p.subject === "codex/laptop-sample_a-codex-3").map(p => [p.value, p.from, p.until]);
  expect(laptopRows().map(([value]) => value)).toEqual(["codex3", "chatgpt-minted", "codex3"]);
  const pc = loadPeriods(db, ACCOUNT_PERIODS).filter(p => p.subject !== "codex/laptop-sample_a-codex-3");

  // The business credits of the same email are a billing mode, not a second login.
  const subscriptions = [{ id: "codex3", vendor: "codex", account: "hello@example.com" },
    { id: "codex1::business", vendor: "codex", account: "hello@example.com" }];
  expect(advanceAccountPeriods(db, { ...declared, subscriptions })).toMatchObject({ rows: 0, done: true,
    rebuilt: ["codex/codex/laptop-sample_a-codex-3", "plan:codex/chatgpt-minted", "plan:codex/codex3"] });
  expect(laptopRows()).toEqual([["codex3", "2026-09-18T09:00:00.000Z", null]]);
  expect(loadPeriods(db, ACCOUNT_PERIODS).filter(p => p.subject !== "codex/laptop-sample_a-codex-3")).toEqual(pc);
  expect(loadPeriods(db, PLAN_PERIODS).map(p => p.subject)).toEqual(["codex3"]);
  expect(seenAccounts(db)["codex|codex/laptop-sample_a-codex-3"]).toEqual(["codex3"]);
  expect(advanceAccountPeriods(db, { ...declared, subscriptions })).toMatchObject({ rows: 0, rebuilt: [], done: true });

  // A new reading under the minted id joins the declared login's running period.
  reading("chatgpt-minted", "2026-10-10T07:00:00.000Z");
  expect(advanceAccountPeriods(db, { ...declared, subscriptions })).toMatchObject({ rows: 1, rebuilt: [], done: true });
  expect(laptopRows()).toEqual([["codex3", "2026-09-18T09:00:00.000Z", null]]);
});
