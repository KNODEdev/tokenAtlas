import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "./sqlite";
import { applyDrizzleMigrations } from "./migrate";
import { buildPeriodIndex, observedPeriods, type PeriodReading } from "../server/account-periods";
import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, recordPeriodReading, replaceObservedPeriods, replaceDeclaredPeriods } from "./period-store";
import { loadAccountResolver } from "../server/account-resolver";

function migrated(): Database {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  return db;
}
const reading = (ts: string, value: string, subject = "claude/PC"): PeriodReading => ({ provider: "claude", subject, ts, value });
type OwnerChange = { account: string; from_ms: number; until_ms: number | null };
/** The window-sum intervals an edit hands to the background producer: the accounts whose ownership changed. */
function ownerChanges(db: Database, edit: () => unknown): OwnerChange[] {
  db.exec("DELETE FROM window_usage_dirty");
  edit();
  return db.query("SELECT account,from_ms,until_ms FROM window_usage_dirty ORDER BY account,from_ms").all() as OwnerChange[];
}
/** Whether a change of this account overlaps the UTC day. */
const touches = (changes: readonly OwnerChange[], account: string, day: string) => {
  const start = Date.parse(`${day}T00:00:00Z`), end = start + 86_400_000;
  return changes.some(change => change.account === account && change.from_ms < end && (change.until_ms === null || change.until_ms > start));
};

test("current v2 queues only the changed interval's owners even without an analysis schema", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE account_periods(id INTEGER PRIMARY KEY,provider TEXT NOT NULL,source TEXT NOT NULL,
    from_ts TEXT NOT NULL,until_ts TEXT,account TEXT NOT NULL,origin TEXT NOT NULL,
    first_seen TEXT,last_seen TEXT,readings INTEGER NOT NULL DEFAULT 0,evidence TEXT NOT NULL);
    CREATE TABLE current_projection_state(id INTEGER PRIMARY KEY,schema_version INTEGER,probe_revision INTEGER);
    INSERT INTO current_projection_state VALUES(1,2,0);
    CREATE TABLE current_projection_dirty(provider TEXT,subject TEXT,PRIMARY KEY(provider,subject));
    CREATE TABLE current_probe_subjects(provider TEXT,subject TEXT,data TEXT,generated_at TEXT,next_refresh_at TEXT,
      PRIMARY KEY(provider,subject));`);
  const declared = (account: string) => ({ provider: "codex", subject: "codex/pc", from: "2026-01-01",
    until: null, value: account, origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [declared("old")]);
  // The projection has applied the first declaration.
  db.exec("DELETE FROM meta WHERE key='current_v2_period_deltas'");
  db.query("INSERT INTO current_probe_subjects VALUES('codex',?,'pending','now',NULL)").run("\u0001stage:old");
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [declared("new")]);
  // The projection moves the interval between the two cards itself; a card in preparation is kept.
  const deltas = JSON.parse((db.query("SELECT value FROM meta WHERE key='current_v2_period_deltas'").get() as { value: string }).value);
  expect(deltas.map((delta: { oldAccount: string; newAccount: string; source: string }) => [delta.source, delta.oldAccount, delta.newAccount]))
    .toEqual([["codex/pc", "old", "new"]]);
  expect(db.query("SELECT subject FROM current_projection_dirty").all()).toEqual([]);
  expect(db.query("SELECT subject FROM current_probe_subjects").all()).toEqual([{ subject: "stage:old" }]);
  expect((db.query("SELECT probe_revision FROM current_projection_state").get() as { probe_revision: number }).probe_revision).toBe(2);
  db.close();
});

test("declared end survives new readings and resolver reload, invalidating only the ended account range", () => {
  const db = migrated();
  recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-09-10T10:19:47.724Z", "a"));
  const observed = loadPeriods(db, ACCOUNT_PERIODS)[0]!;
  const changes = ownerChanges(db, () => replaceDeclaredPeriods(db, ACCOUNT_PERIODS,
    [{ ...observed, origin: "declared", from: "2026-09-10T10:19:00Z", until: "2026-09-17T10:19:00Z" }]));
  expect(touches(changes, "a", "2026-09-18")).toBe(true);
  expect(touches(changes, "a", "2026-09-12")).toBe(false);
  expect(touches(changes, "b", "2026-09-18")).toBe(false);
  recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-09-22T10:00:00Z", "a"));
  const rows = loadPeriods(db, ACCOUNT_PERIODS);
  expect(rows.find(row => row.origin === "observed")?.until).toBeNull();
  expect(buildPeriodIndex(rows).resolve("claude", "claude/PC", "2026-09-18").value).toBeNull();
  const resolver = loadAccountResolver(db);
  expect(resolver.resolve("claude", "claude/PC", null, "2026-09-18").account).toBeNull();
  expect(resolver.plan("claude", "a").owns("claude/PC", null, "2026-09-18")).toBe(false);
  expect(resolver.plan("claude", "a").days("2026-09-18", "2026-09-22")).toEqual([]);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, []);
  expect(loadAccountResolver(db).resolve("claude", "claude/PC", null, "2026-09-18").account).toBe("a");
  db.close();
});

test("period edits invalidate just changed owners and days, including observed ownership exposed by removal", () => {
  const db = migrated();
  recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-01-01T00:00:00.000Z", "observed"));
  const declared = { ...loadPeriods(db, ACCOUNT_PERIODS)[0]!, origin: "declared" as const, from: "2026-03-01", until: "2026-04-01", value: "declared" };
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [declared]);
  const changes = ownerChanges(db, () => replaceDeclaredPeriods(db, ACCOUNT_PERIODS, []));
  expect(touches(changes, "declared", "2026-03-10")).toBe(true);
  expect(touches(changes, "observed", "2026-03-10")).toBe(true);
  expect(touches(changes, "other", "2026-03-10")).toBe(false);
  expect(touches(changes, "declared", "2026-04-01")).toBe(false);
});

test("resolver cache follows ownership revisions and identity mapping, not evidence, last_seen or labels", () => {
  const db = migrated();
  recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-01-01T00:00:00.000Z", "a"));
  const declarations = [{ vendor: "claude", account_key: "claude:k:k", id: "a", label: "Old" }];
  const first = loadAccountResolver(db, declarations);
  recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-01-02T00:00:00.000Z", "a"));
  const relabeled = [{ ...declarations[0]!, label: "New" }];
  expect(loadAccountResolver(db, relabeled)).toBe(first);
  const rows = loadPeriods(db, ACCOUNT_PERIODS);
  replaceObservedPeriods(db, ACCOUNT_PERIODS, "claude", "claude/PC", rows.map(p => ({ ...p, evidence: "new evidence" })));
  expect(loadAccountResolver(db, declarations)).toBe(first);
  recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-01-03T00:00:00.000Z", "b"));
  const next = loadAccountResolver(db, declarations);
  expect(next).not.toBe(first);
  expect(next.resolve("claude", "claude/PC", null, "2026-01-04").account).toBe("b");
  const remapped = loadAccountResolver(db, [{ ...declarations[0]!, id: "c" }]);
  expect(remapped).not.toBe(next);
  expect(remapped.identityAccount("claude", "claude:k:k")).toBe("c");
});

test("moving a declared boundary invalidates only the changed day and evidence-only edits invalidate nothing", () => {
  const db = migrated();
  recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-01-01T00:00:00.000Z", "observed"));
  const declared = { ...loadPeriods(db, ACCOUNT_PERIODS)[0]!, origin: "declared" as const, from: "2026-03-01", until: "2026-04-01", value: "declared" };
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [declared]);
  const moved = ownerChanges(db, () => replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [{ ...declared, until: "2026-04-02" }]));
  expect(touches(moved, "declared", "2026-03-20")).toBe(false);
  expect(touches(moved, "declared", "2026-04-01")).toBe(true);
  expect(touches(moved, "declared", "2026-04-02")).toBe(false);
  const resolver = loadAccountResolver(db);
  let saved: boolean | undefined;
  expect(ownerChanges(db, () => { saved = replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [{ ...declared, until: "2026-04-02", evidence: "receipt" }]); })).toEqual([]);
  expect(saved).toBe(true);
  expect(loadAccountResolver(db)).toBe(resolver);
});

test("repeated readings of one account move last_seen on a single row", () => {
  const db = migrated();
  expect(recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-09-09T15:48:00.000Z", "a"))).toBe("opened");
  expect(recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-09-09T15:53:00.000Z", "a"))).toBe("extended");
  expect(recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-09-12T13:41:00.000Z", "a", "CLAUDE/pc"))).toBe("extended");
  expect(loadPeriods(db, ACCOUNT_PERIODS)).toEqual([{
    provider: "claude", subject: "claude/PC", from: "2026-09-09T15:48:00.000Z", until: null, value: "a", origin: "observed",
    firstSeen: "2026-09-09T15:48:00.000Z", lastSeen: "2026-09-12T13:41:00.000Z", readings: 3, evidence: "profile-reading",
  }]);
});

test("another account closes the period at its last reading; incremental rows equal the full derivation", () => {
  const db = migrated();
  const readings = [
    reading("2026-07-08T14:40:00.000Z", "old"), reading("2026-07-08T14:43:00.000Z", "old"),
    reading("2026-07-29T09:54:00.000Z", "new"), reading("2026-07-30T09:54:00.000Z", "new"),
    reading("2026-07-29T10:00:00.000Z", "other", "claude/LAPTOP"),
  ];
  const outcomes = readings.map((r) => recordPeriodReading(db, ACCOUNT_PERIODS, r));
  expect(outcomes).toEqual(["opened", "extended", "switched", "extended", "opened"]);
  expect(loadPeriods(db, ACCOUNT_PERIODS)).toEqual(observedPeriods(readings));
  expect(buildPeriodIndex(loadPeriods(db, ACCOUNT_PERIODS)).resolve("claude", "claude/PC", "2026-07-20T00:00:00.000Z").basis).toBe("gap");
});

test("a late reading changes nothing and is reported; a rebuild replaces observed rows and keeps declared ones", () => {
  const db = migrated();
  recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-09-10T00:00:00.000Z", "a"));
  db.query(`INSERT INTO account_periods (provider, source, from_ts, until_ts, account, origin, evidence)
    VALUES ('claude', 'claude/PC', '2026-01-01', '2026-03-29', 'paid', 'declared', 'owner-declaration')`).run();
  const before = loadPeriods(db, ACCOUNT_PERIODS);
  expect(recordPeriodReading(db, ACCOUNT_PERIODS, reading("2026-09-09T00:00:00.000Z", "b"))).toBe("out-of-order");
  expect(loadPeriods(db, ACCOUNT_PERIODS)).toEqual(before);

  const all = [reading("2026-09-09T00:00:00.000Z", "b"), reading("2026-09-10T00:00:00.000Z", "a")];
  replaceObservedPeriods(db, ACCOUNT_PERIODS, "claude", "claude/PC", observedPeriods(all));
  expect(loadPeriods(db, ACCOUNT_PERIODS).map((p) => [p.origin, p.value, p.until])).toEqual([
    ["declared", "paid", "2026-03-29"], ["observed", "b", "2026-09-09T00:00:00.001Z"], ["observed", "a", null],
  ]);
  expect(() => replaceObservedPeriods(db, ACCOUNT_PERIODS, "claude", "claude/PC", observedPeriods([reading("2026-09-01T00:00:00.000Z", "x", "claude/LAPTOP")]))).toThrow();
});

test("plan periods run on the same mechanism, keyed by account", () => {
  const db = migrated();
  const plan = (ts: string, value: string): PeriodReading => ({ provider: "claude", subject: "account-1", ts, value });
  recordPeriodReading(db, PLAN_PERIODS, plan("2026-08-31T13:05:00.000Z", "max_20x"));
  expect(recordPeriodReading(db, PLAN_PERIODS, plan("2026-09-21T19:55:00.000Z", "max_5x"))).toBe("switched");
  const index = buildPeriodIndex(loadPeriods(db, PLAN_PERIODS));
  expect(index.resolve("claude", "account-1", "2026-08-31T13:05:00.000Z").value).toBe("max_20x");
  expect(index.resolve("claude", "account-1", "2026-09-10T00:00:00.000Z").basis).toBe("gap");
  expect(index.resolve("claude", "account-1", "2026-09-22T00:00:00.000Z").value).toBe("max_5x");
  expect(loadPeriods(db, ACCOUNT_PERIODS)).toEqual([]);
});
