import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { buildAccountResolver } from "./account-resolver";
import type { DatedPeriod } from "./account-periods";
import { claudeEventAccountSql, claudeEventOwnedBySql } from "./claude-event-account";
import { archiveSourceKey } from "./event-source";
import { claudeIdentitySubscription } from "../ingest/claude-identity";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { createClaudeCodeAcceptanceFixture, ACCOUNTS } from "./claude-code-capacity.fixture";
import { subscriptionDailyUsage } from "./subscription-usage";
import { prepareUsageRegisters } from "./usage-register.fixture";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { applyDrizzleMigrations } from "../db/migrate";

const ROOT = "H:/Archive/tokenUsage";
const KEY_DECLARED = "claude:6deed05f-c0a9-41d1-8e7f-fd5baaa36db2:bd47f8bf-640e-4156-ad4a-4d6650376a59";
const KEY_UNDECLARED = "claude:3c56ad18-8472-452a-b5a2-4437e25a7e4a:bd47f8bf-640e-4156-ad4a-4d6650376a59";
const KEY_WITHDRAWN = "claude:9a1b2c3d-0000-4000-8000-000000000001:bd47f8bf-640e-4156-ad4a-4d6650376a59";
const period = (subject: string, value: string, from: string, until: string | null, origin: DatedPeriod["origin"]): DatedPeriod =>
  ({ provider: "claude", subject, from, until, value, origin, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });

const periods = [
  // MAIN: declared history, then an observed period whose start a declaration overrides.
  period("claude/EXAMPLE-MAIN", "acct-a", "2026-01-01", "2026-03-29", "declared"),
  period("claude/EXAMPLE-MAIN", "acct-b", "2026-07-29T09:54:00Z", null, "observed"),
  period("claude/EXAMPLE-MAIN", "acct-c", "2026-07-29T09:54:00Z", "2026-08-01T12:30:00Z", "declared"),
  // LAPTOP: one observed period; the time before it is a gap.
  period("claude/example-laptop", "acct-b", "2026-06-09T20:29:00.353Z", null, "observed"),
  // A folder with a non-ASCII letter, written lower-case as archive folders are.
  period("claude/pc-żółw", "acct-c", "2026-01-01", null, "declared"),
];
const resolver = buildAccountResolver(periods, [{ id: "acct-a", vendor: "claude", account_key: KEY_DECLARED }]);
/** `[day, next day)` as a `within` window. */
const dayWindow = (day: string) => ({ from: day, until: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString() });

interface Row { call: string; path: string; ts: string; key: string | null; conflict?: number; stored?: string }
const rows: Row[] = [
  { call: "declared", path: `${ROOT}/claude/EXAMPLE-MAIN/p/a.jsonl`, ts: "2026-02-10T10:00:00.000Z", key: null },
  { call: "before-declared", path: `${ROOT}/claude/EXAMPLE-MAIN/p/a.jsonl`, ts: "2025-12-31T23:59:59.999Z", key: null },
  { call: "gap-main", path: `${ROOT}/claude/EXAMPLE-MAIN/p/a.jsonl`, ts: "2026-05-01T00:00:00.000Z", key: null },
  { call: "declared-over-observed", path: `${ROOT}/claude/EXAMPLE-MAIN/p/b.jsonl`, ts: "2026-07-30T00:00:00.000Z", key: null },
  { call: "at-declared-until", path: `${ROOT}/claude/EXAMPLE-MAIN/p/b.jsonl`, ts: "2026-08-01T12:30:00.000Z", key: null },
  { call: "observed-open", path: `${ROOT}/claude/EXAMPLE-MAIN/p/b.jsonl`, ts: "2026-09-20T08:00:00.000Z", key: null },
  { call: "backslashes-and-case", path: "H:\\ARCHIVE\\tokenUsage\\claude\\example-main\\p\\c.jsonl", ts: "2026-09-20T08:00:00.000Z", key: null },
  { call: "laptop-gap", path: `${ROOT}/claude/EXAMPLE-LAPTOP/x.jsonl`, ts: "2026-06-09T20:29:00.352Z", key: null },
  { call: "laptop-at-start", path: `${ROOT}/claude/EXAMPLE-LAPTOP/x.jsonl`, ts: "2026-06-09T20:29:00.353Z", key: null },
  { call: "outside-archive", path: "C:/Users/x/.claude/projects/y.jsonl", ts: "2026-09-20T08:00:00.000Z", key: null },
  { call: "prefix-of-another-folder", path: `${ROOT}/claude/EXAMPLE-MAIN-desktop/z.jsonl`, ts: "2026-09-20T08:00:00.000Z", key: null },
  { call: "non-ascii-lower", path: `${ROOT}/claude/pc-żółw/n.jsonl`, ts: "2026-09-20T08:00:00.000Z", key: null },
  // A session identity beats every period; a declared key maps to its id, another to the id derived from it.
  { call: "identity-declared", path: `${ROOT}/claude/EXAMPLE-MAIN/p/d.jsonl`, ts: "2026-09-20T08:00:00.000Z", key: KEY_DECLARED },
  { call: "identity-undeclared", path: `${ROOT}/claude/EXAMPLE-MAIN/p/d.jsonl`, ts: "2026-02-10T10:00:00.000Z", key: KEY_UNDECLARED },
  // Stored when its declaration still named it "acct-old"; the declaration is gone, so the key's own id applies.
  { call: "identity-withdrawn", path: `${ROOT}/claude/EXAMPLE-MAIN/p/d.jsonl`, ts: "2026-02-10T10:00:00.000Z", key: KEY_WITHDRAWN, stored: "acct-old" },
  { call: "conflict", path: `${ROOT}/claude/EXAMPLE-MAIN/p/e.jsonl`, ts: "2026-02-10T10:00:00.000Z", key: KEY_DECLARED, conflict: 1 },
];

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE claude_events(call_id TEXT, path TEXT, ts TEXT, account_key TEXT, subscription_id TEXT,
    subscription_conflict INTEGER NOT NULL DEFAULT 0)`);
  const insert = db.query("INSERT INTO claude_events VALUES (?,?,?,?,?,?)");
  for (const row of rows) insert.run(row.call, row.path, row.ts, row.key,
    row.key && !row.conflict ? row.stored ?? claudeIdentitySubscription(row.key) : null, row.conflict ?? 0);
  return db;
}

/** What the resolver answers for a row, which the SQL must reproduce. */
function expected(row: Row): string | null {
  if (row.conflict) return null;
  return resolver.resolve("claude", archiveSourceKey(row.path, ROOT), row.key, row.ts).account;
}

test("the account expression resolves every row exactly as the period resolver does", () => {
  const db = fixture();
  try {
    const want = Object.fromEntries(rows.map((row) => [row.call, expected(row)]));
    const whole = claudeEventAccountSql(db, resolver, { root: ROOT });
    const actual = db.query(`SELECT call_id, ${whole.sql} AS account FROM claude_events`).all(...whole.params) as
      Array<{ call_id: string; account: string | null }>;
    expect(Object.fromEntries(actual.map((row) => [row.call_id, row.account]))).toEqual(want);
    // Per-day statements, each naming only its own day's periods, give the same answers on their day.
    for (const row of rows) {
      const day = claudeEventAccountSql(db, resolver, { root: ROOT, within: dayWindow(row.ts.slice(0, 10)) });
      expect((db.query(`SELECT ${day.sql} AS account FROM claude_events WHERE call_id = ?`).get(...day.params, row.call) as
        { account: string | null }).account).toBe(want[row.call] ?? null);
    }
    // The fixture must reach every branch, not compare two empty columns.
    expect(new Set(actual.map((row) => row.account))).toEqual(new Set(["acct-a", "acct-b", "acct-c",
      claudeIdentitySubscription(KEY_UNDECLARED).toLowerCase(), claudeIdentitySubscription(KEY_WITHDRAWN).toLowerCase(), null]));
  } finally { db.close(); }
});

test("the ownership predicate selects exactly the rows the resolver gives the account", () => {
  const db = fixture();
  try {
    for (const account of ["acct-a", "ACCT-B", "acct-c", claudeIdentitySubscription(KEY_UNDECLARED), "acct-old", "nobody"]) {
      const owned = claudeEventOwnedBySql(db, resolver, account, { root: ROOT });
      const calls = (db.query(`SELECT call_id FROM claude_events WHERE ${owned.sql} ORDER BY call_id`).all(...owned.params) as
        Array<{ call_id: string }>).map((row) => row.call_id);
      expect(calls).toEqual(rows.filter((row) => expected(row) === account.toLowerCase()).map((row) => row.call).sort());
    }
  } finally { db.close(); }
});

test("a session identity published below the last rowid seen is still found", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE claude_events(call_id TEXT, path TEXT, ts TEXT, account_key TEXT, subscription_id TEXT,
      subscription_conflict INTEGER NOT NULL DEFAULT 0)`);
    const insert = db.query("INSERT INTO claude_events(rowid, call_id, path, ts, account_key, subscription_id) VALUES (?,?,?,?,?,?)");
    insert.run(10, "first", `${ROOT}/claude/EXAMPLE-MAIN/p/a.jsonl`, "2026-02-10T10:00:00.000Z", KEY_DECLARED, "acct-a");
    insert.run(20, "second", `${ROOT}/claude/EXAMPLE-MAIN/p/a.jsonl`, "2026-02-11T10:00:00.000Z", null, null);
    const accountOf = (call: string) => {
      const account = claudeEventAccountSql(db, resolver, { root: ROOT });
      return (db.query(`SELECT ${account.sql} AS account FROM claude_events WHERE call_id = ?`).get(...account.params, call) as
        { account: string | null }).account;
    };
    expect(accountOf("first")).toBe("acct-a");
    // A full-copy publication keeps the staged ids, so a new identity can land below rowid 20. Its stored id
    // is stale, so only a rescan that finds the key gives the resolver's answer.
    insert.run(5, "copied", `${ROOT}/claude/EXAMPLE-MAIN/p/b.jsonl`, "2026-02-12T10:00:00.000Z", KEY_WITHDRAWN, "acct-old");
    expect(accountOf("copied")).toBe(claudeIdentitySubscription(KEY_WITHDRAWN).toLowerCase());
  } finally { db.close(); }
});

test("identity looks read the 0042 partial index first, then only the rowid range above the last look", () => {
  const db = fixture(), migrated = new Database(":memory:");
  try {
    applyDrizzleMigrations(drizzle(migrated, { schema }), path.resolve(import.meta.dir, "../../drizzle"));
    const looks: string[] = [];
    const query = db.query.bind(db);
    db.query = ((sql: string) => { if (sql.includes("SELECT DISTINCT account_key")) looks.push(sql); return query(sql); }) as typeof db.query;
    claudeEventAccountSql(db, resolver, { root: ROOT });
    query("INSERT INTO claude_events VALUES ('later', NULL, '2026-03-01T00:00:00.000Z', NULL, NULL, 0)").run();
    claudeEventAccountSql(db, resolver, { root: ROOT });
    const plan = (sql: string) => (migrated.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.includes("?") ? [0] : [])) as
      Array<{ detail: string }>).map(row => row.detail).join("; ");
    expect(looks).toHaveLength(2);
    expect(plan(looks[0]!)).toContain("USING INDEX claude_events_remembered_identity");
    expect(plan(looks[1]!)).toContain("USING INTEGER PRIMARY KEY (rowid>?)");
  } finally { db.close(); migrated.close(); }
});

test("an upper-case non-ASCII folder fails closed: SQLite folds ASCII only, so its rows stay unassigned", () => {
  const db = fixture();
  try {
    db.query("INSERT INTO claude_events VALUES ('non-ascii-upper', ?, '2026-09-20T08:00:00.000Z', NULL, NULL, 0)")
      .run(`${ROOT}/claude/PC-ŻÓŁW/u.jsonl`);
    const account = claudeEventAccountSql(db, resolver, { root: ROOT });
    expect(db.query(`SELECT ${account.sql} AS account FROM claude_events WHERE call_id = 'non-ascii-upper'`).get(...account.params))
      .toEqual({ account: null });
  } finally { db.close(); }
});

test("a day's statement names only that day's periods, clipped to the day", () => {
  const db = fixture();
  try {
    const day = (value: string, periodsNow: DatedPeriod[]) =>
      claudeEventAccountSql(db, buildAccountResolver(periodsNow), { root: ROOT, within: dayWindow(value) }).stamp;
    // Moving the laptop period's start moves nothing on days the period covers either way.
    const moved = periods.map((p) => p.subject === "claude/example-laptop" ? { ...p, from: "2026-06-10T08:00:00Z" } : p);
    expect(day("2026-08-15", moved)).toBe(day("2026-08-15", periods));
    expect(day("2026-06-10", moved)).not.toBe(day("2026-06-10", periods));
    expect(day("2026-06-09", moved)).not.toBe(day("2026-06-09", periods));
  } finally { db.close(); }
});

test("daily usage joins a period change at read time from the register: no event is read again", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    prepareUsageRegisters(f.db, f.rates);
    const statements: string[] = [];
    const query = f.db.query.bind(f.db);
    f.db.query = ((sql: string) => { statements.push(sql); return query(sql); }) as typeof f.db.query;
    const read = () => { statements.length = 0; return subscriptionDailyUsage({ sqlite: f.db, rateCards: f.rates }); };
    const days = new Set([...read().values()].flat().map((row) => row.day));
    // account-a stops owning its folder at noon on 16.09: its usage ends that day, from the prepared sums.
    replaceDeclaredPeriods(f.db, ACCOUNT_PERIODS, loadPeriods(f.db, ACCOUNT_PERIODS)
      .map((p) => p.value === ACCOUNTS.a ? { ...p, until: "2026-09-16T12:00:00.000Z" } : p));
    const changed = read();
    expect(statements.some((sql) => /\bclaude_events\b/.test(sql))).toBe(false);
    expect([...days].some((day) => day > "2026-09-16")).toBe(true);
    expect(changed.get(ACCOUNTS.a)!.every((row) => row.day <= "2026-09-16")).toBe(true);
  } finally { f.teardown(); }
});
