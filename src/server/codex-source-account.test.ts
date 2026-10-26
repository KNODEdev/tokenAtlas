import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { buildAccountResolver } from "./account-resolver";
import type { DatedPeriod } from "./account-periods";
import { codexAccountSelector, type CodexHomeTable } from "./codex-source-account";
import { codexHomeSource } from "./event-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { installAnalysisTracking } from "../db/analysis";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { createTestDatabase } from "../sync/test-support";
import { removeTestFixture } from "../test-cleanup";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { queryRows } from "./data-groups";

const ROOT = "H:/Archive/tokenUsage";
/** `[day, next day)`. */
const dayWindow = (day: string) => ({ from: day, until: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString() });
const MACHINE = "EXAMPLE-MAIN";
const period = (subject: string, value: string, from: string, until: string | null, origin: DatedPeriod["origin"]): DatedPeriod =>
  ({ provider: "codex", subject, from, until, value, origin, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });

const periods = [
  // The live shape: a declared day-precise history handing over to the first reading, same account.
  period("codex/EXAMPLE-MAIN-sample_a", "acct-a", "2025-09-16", "2026-09-09T15:11:32.698Z", "declared"),
  period("codex/example-main-sample_a", "acct-a", "2026-09-09T15:11:32.698Z", null, "observed"),
  // A gap: nothing is known between the declared days and the first reading.
  period("codex/EXAMPLE-MAIN-sample_b", "acct-b", "2026-08-19", "2026-08-22", "declared"),
  period("codex/example-main-sample_b", "acct-b", "2026-09-09T15:11:32.717Z", null, "observed"),
  // An owner change at an instant.
  period("codex/EXAMPLE-MAIN-sample_c", "acct-c", "2026-08-21", "2026-09-09T15:11:32.728Z", "declared"),
  period("codex/example-main-sample_c", "acct-d", "2026-09-09T15:11:32.728Z", null, "observed"),
  // A declaration covering part of an observed period wins inside its range only.
  period("codex/example-laptop", "acct-a", "2026-09-01T00:00:00.000Z", null, "observed"),
  period("codex/example-laptop", "acct-e", "2026-09-05T12:00:00.000Z", "2026-09-06T00:00:00.000Z", "declared"),
];
const resolver = buildAccountResolver(periods);
const subscriptions = [
  // The local profile of MAIN is a copy of its archive folder, on this computer only.
  { id: "acct-a", vendor: "codex", machine: MACHINE, home: `${ROOT}/codex/EXAMPLE-MAIN-sample_a`, source_home: "C:\\Users\\sample_a\\.codex" },
  { id: "acct-a", vendor: "codex", machine: "OTHER-PC", home: `${ROOT}/codex/example-laptop`, source_home: "C:\\Users\\far\\.codex" },
  // One local profile declared for two folders has no source.
  { id: "acct-b", vendor: "codex", home: `${ROOT}/codex/EXAMPLE-MAIN-sample_b`, source_home: "C:\\Users\\shared\\.codex" },
  { id: "acct-c", vendor: "codex", home: `${ROOT}/codex/EXAMPLE-MAIN-sample_c`, source_home: "C:\\Users\\shared\\.codex" },
];
const ctx = (db: Database) => ({ sqlite: db, resolver, accounts: splitProbeReaderFixtureConfig(subscriptions) });

const H = {
  main: "H:\\Archive\\tokenUsage\\codex\\EXAMPLE-MAIN-sample_a",
  mainSlashes: "h:/archive/TOKENUSAGE/codex/example-main-sample_a",
  local: "C:\\Users\\sample_a\\.codex",
  stk: "H:\\Archive\\tokenUsage\\codex\\EXAMPLE-MAIN-sample_b",
  aic: "H:\\Archive\\tokenUsage\\codex\\EXAMPLE-MAIN-sample_c",
  laptop: "H:\\Archive\\tokenUsage\\codex\\example-laptop",
  otherMachine: "C:\\Users\\far\\.codex",
  ambiguous: "C:\\Users\\shared\\.codex",
  undeclared: "C:\\Users\\nobody\\.codex",
  noPeriods: "H:\\Archive\\tokenUsage\\codex\\EXAMPLE-NEW",
  prefix: "H:\\Archive\\tokenUsage\\codex\\EXAMPLE-MAIN-sample_a-2",
};
interface Row { name: string; home: string; ts: string }
const rows: Row[] = [
  { name: "before-first", home: H.main, ts: "2025-09-15T23:59:59.999Z" },
  { name: "at-declared-from", home: H.main, ts: "2025-09-16T00:00:00.000Z" },
  { name: "declared", home: H.main, ts: "2026-03-01T10:00:00.000Z" },
  { name: "just-before-handover", home: H.main, ts: "2026-09-09T15:11:32.697Z" },
  { name: "at-handover", home: H.main, ts: "2026-09-09T15:11:32.698Z" },
  { name: "observed-open", home: H.main, ts: "2026-09-20T08:00:00.000Z" },
  { name: "slashes-and-case", home: H.mainSlashes, ts: "2026-09-20T08:00:00.000Z" },
  { name: "local-profile", home: H.local, ts: "2026-09-20T08:00:00.000Z" },
  { name: "stk-declared", home: H.stk, ts: "2026-08-21T23:59:59.999Z" },
  { name: "stk-declared-until", home: H.stk, ts: "2026-08-22T00:00:00.000Z" },
  { name: "stk-gap", home: H.stk, ts: "2026-09-01T00:00:00.000Z" },
  { name: "stk-observed", home: H.stk, ts: "2026-09-09T15:11:32.717Z" },
  { name: "aic-before-change", home: H.aic, ts: "2026-09-09T15:11:32.727Z" },
  { name: "aic-after-change", home: H.aic, ts: "2026-09-09T15:11:32.728Z" },
  { name: "laptop-observed", home: H.laptop, ts: "2026-09-05T11:59:59.999Z" },
  { name: "laptop-declared", home: H.laptop, ts: "2026-09-05T12:00:00.000Z" },
  { name: "laptop-after-declared", home: H.laptop, ts: "2026-09-06T00:00:00.000Z" },
  { name: "other-machine", home: H.otherMachine, ts: "2026-09-05T12:00:00.000Z" },
  { name: "ambiguous-profile", home: H.ambiguous, ts: "2026-08-21T12:00:00.000Z" },
  { name: "undeclared-profile", home: H.undeclared, ts: "2026-09-20T08:00:00.000Z" },
  { name: "folder-without-periods", home: H.noPeriods, ts: "2026-09-20T08:00:00.000Z" },
  { name: "prefix-of-another-folder", home: H.prefix, ts: "2026-09-20T08:00:00.000Z" },
  // Inside an open period, but not in the one text form bounds are compared in: nobody's, never guessed.
  // Whole seconds are exact: this one is before the change at .728 although `…32Z` sorts after `…32.728Z` as text.
  { name: "aic-seconds-before-change", home: H.aic, ts: "2026-09-09T15:11:32Z" },
  { name: "unzoned-ts", home: H.main, ts: "2026-09-20T08:00:00" },
  { name: "unparsable-ts", home: H.main, ts: "yesterday" },
  // The right shape, but no such instant: month 13, 31 April, 25:00, 29 February of a non-leap year.
  { name: "month-13", home: H.main, ts: "2026-13-01T00:00:00.000Z" },
  { name: "april-31", home: H.main, ts: "2026-04-31T08:00:00.000Z" },
  { name: "hour-25", home: H.main, ts: "2026-09-20T25:00:00.000Z" },
  { name: "feb-29-2026", home: H.main, ts: "2026-02-29T08:00:00Z" },
];
const comparable = (ts: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts) ? ts
  : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ts) ? `${ts.slice(0, 19)}.000Z` : null;
const canonical = (ts: string) => {
  const key = comparable(ts), at = key === null ? NaN : Date.parse(key);
  return Number.isFinite(at) && new Date(at).toISOString() === key;
};

function fixture(table: CodexHomeTable = "ratelimit"): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE ${table}(name TEXT, home TEXT, path TEXT, ts TEXT)`);
  const insert = db.query(`INSERT INTO ${table} VALUES (?,?,?,?)`);
  for (const row of rows) insert.run(row.name, row.home, `${row.home}\\sessions\\${row.name}.jsonl`, row.ts);
  return db;
}

/** What the resolver answers for a row, which the SQL must reproduce. */
const expected = (row: Row): string | null => canonical(row.ts)
  ? resolver.resolve("codex", codexHomeSource(row.home, subscriptions, ROOT, MACHINE), null, comparable(row.ts)!).account : null;

test("the account expression resolves every Codex row exactly as the period resolver does", () => {
  for (const table of ["ratelimit", "events"] as const) {
    const db = fixture(table);
    try {
      const selector = codexAccountSelector(ctx(db), table, ROOT, MACHINE);
      const want = Object.fromEntries(rows.map((row) => [row.name, expected(row)]));
      const whole = selector.account({ alias: "r" });
      const actual = db.query(`SELECT r.name, ${whole.sql} AS account FROM ${table} r`).all(...whole.params) as
        Array<{ name: string; account: string | null }>;
      expect(Object.fromEntries(actual.map((row) => [row.name, row.account]))).toEqual(want);
      expect(Object.fromEntries(rows.map((row) => [row.name, selector.accountAt(row.home, row.ts)]))).toEqual(want);
      // Per-day statements, each naming only its own day's periods, give the same answers on their day.
      for (const row of rows.filter((row) => canonical(row.ts))) {
        const day = selector.account({ within: dayWindow(row.ts.slice(0, 10)) });
        expect((db.query(`SELECT ${day.sql} AS account FROM ${table} WHERE name = ?`).get(...day.params, row.name) as
          { account: string | null }).account).toBe(want[row.name] ?? null);
      }
      // Half-open ends, the gap and every source rule are exercised, not two empty columns compared.
      expect(want).toMatchObject({
        "before-first": null, "at-declared-from": "acct-a", "just-before-handover": "acct-a", "at-handover": "acct-a",
        "slashes-and-case": "acct-a", "local-profile": "acct-a", "stk-declared": "acct-b", "stk-declared-until": null,
        "stk-gap": null, "stk-observed": "acct-b", "aic-before-change": "acct-c", "aic-after-change": "acct-d",
        "laptop-observed": "acct-a", "laptop-declared": "acct-e", "laptop-after-declared": "acct-a", "other-machine": null,
        "ambiguous-profile": null, "undeclared-profile": null, "folder-without-periods": null, "prefix-of-another-folder": null,
        "aic-seconds-before-change": "acct-c", "unzoned-ts": null, "unparsable-ts": null,
        "month-13": null, "april-31": null, "hour-25": null, "feb-29-2026": null,
      });
    } finally { db.close(); }
  }
});

test("the ownership predicate selects exactly the rows the resolver gives the account", () => {
  const db = fixture();
  try {
    const selector = codexAccountSelector(ctx(db), "ratelimit", ROOT, MACHINE);
    for (const account of ["acct-a", "ACCT-B", "acct-c", "acct-d", "acct-e", "nobody"]) {
      const names = (within?: { from: string; until: string }) => {
        const owned = selector.ownedBy(account, { alias: "r", ...(within ? { within } : {}) });
        return (db.query(`SELECT r.name FROM ratelimit r WHERE ${owned.sql} ORDER BY r.name`).all(...owned.params) as
          Array<{ name: string }>).map((row) => row.name);
      };
      const want = rows.filter((row) => expected(row) === account.toLowerCase()).map((row) => row.name).sort();
      expect(names()).toEqual(want);
      const byDay = [...new Set(rows.filter((row) => canonical(row.ts)).map((row) => row.ts.slice(0, 10)))].flatMap((day) =>
        names(dayWindow(day)).filter((name) => rows.find((row) => row.name === name)!.ts.startsWith(day)));
      expect(byDay.sort()).toEqual(want);
    }
  } finally { db.close(); }
});

test("an unowned row names why: no source, or no period of its source at that instant", () => {
  const db = fixture();
  try {
    db.exec("INSERT INTO ratelimit VALUES ('no-home', NULL, NULL, '2026-09-20T08:00:00.000Z')");
    const reason = codexAccountSelector(ctx(db), "ratelimit", ROOT, MACHINE).unownedReason();
    const reasons = Object.fromEntries((db.query(`SELECT name, ${reason.sql} AS reason FROM ratelimit`).all(...reason.params) as
      Array<{ name: string; reason: string | null }>).map((row) => [row.name, row.reason]));
    for (const row of rows) if (expected(row)) expect(reasons[row.name]).toBeNull();
    expect(reasons).toMatchObject({
      "before-first": "outside-declared-era", "stk-gap": "outside-declared-era", "stk-declared-until": "outside-declared-era",
      "folder-without-periods": "outside-declared-era", "undeclared-profile": "source-not-declared",
      "ambiguous-profile": "source-not-declared", "other-machine": "source-not-declared", "no-home": "source-missing",
      "unzoned-ts": "timestamp-invalid", "unparsable-ts": "timestamp-invalid", "month-13": "timestamp-invalid",
      "april-31": "timestamp-invalid", "hour-25": "timestamp-invalid", "feb-29-2026": "timestamp-invalid",
    });
  } finally { db.close(); }
});

test("a day's statement names only that day's periods, clipped to the day", () => {
  const db = fixture();
  try {
    const day = (value: string, periodsNow: DatedPeriod[]) => codexAccountSelector({ sqlite: db,
      resolver: buildAccountResolver(periodsNow), accounts: splitProbeReaderFixtureConfig(subscriptions) }, "ratelimit", ROOT, MACHINE)
      .account({ within: dayWindow(value) }).stamp;
    // Moving the end of the sample_b declaration by a day changes only the days between the old and new end.
    const moved = periods.map((p) => p.subject === "codex/EXAMPLE-MAIN-sample_b" && p.origin === "declared" ? { ...p, until: "2026-08-23" } : p);
    expect(day("2026-08-20", moved)).toBe(day("2026-08-20", periods));
    expect(day("2026-08-22", moved)).not.toBe(day("2026-08-22", periods));
    expect(day("2026-08-23", moved)).toBe(day("2026-08-23", periods));
    expect(day("2026-09-20", moved)).toBe(day("2026-09-20", periods));
  } finally { db.close(); }
});

test("a period change and a new home of the same folder change the rows the account owns", () => {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  try {
    const home = `${ARCHIVE_LOGICAL_ROOT}/codex/MAIN`;
    db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS ratelimit(home TEXT, path TEXT, ts TEXT, window_minutes INTEGER, limit_id TEXT,
      used_percent REAL, resets_at INTEGER, plan_type TEXT)`);
    installAnalysisTracking(db);
    const insert = db.query("INSERT INTO ratelimit VALUES (?, ?, ?, 10080, 'codex', 10, 0, 'plus')");
    const days = Array.from({ length: 10 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
    for (const day of days) insert.run(home, `${day}.jsonl`, `${day}T18:00:00.000Z`);
    const subscriptions = [{ id: "acct", vendor: "codex", home, source_home: "C:/Users/x/.codex" }];
    declareCodexEraPeriods(db, subscriptions, { replace: true });
    const ctx = { sqlite: db, accounts: splitProbeReaderFixtureConfig(subscriptions) };
    // The account's weekly readings, as the Codex readers select them.
    const read = () => {
      const owned = codexAccountSelector(ctx).ownedBy("acct", { alias: "r" });
      return queryRows<{ ts: string }>(db, `SELECT r.ts AS ts FROM ratelimit r
        WHERE r.window_minutes = 10080 AND r.limit_id = 'codex' AND ${owned.sql} ORDER BY r.ts, r.rowid`, owned.params);
    };
    expect(read().length).toBe(days.length);
    // The account stops owning the folder at noon on 06.09: that day and the later ones leave it, nothing before.
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, loadPeriods(db, ACCOUNT_PERIODS)
      .filter((p) => p.origin === "declared").map((p) => ({ ...p, until: "2026-09-06T12:00:00.000Z" })));
    const changed = read();
    // A new profile of the same folder (its local copy) writes on 03.09, inside the account's period.
    db.query("INSERT INTO ratelimit VALUES ('C:/Users/x/.codex', 'local.jsonl', '2026-09-03T20:00:00.000Z', 10080, 'codex', 10, 0, 'plus')").run();
    const arrival = read();
    expect(changed.map((row) => row.ts.slice(0, 10))).toEqual(days.slice(0, 5));
    expect(arrival.map((row) => row.ts)).toEqual([...changed.map((row) => row.ts), "2026-09-03T20:00:00.000Z"].sort());
  } finally { db.close(); removeTestFixture(directory, { recursive: true, force: true }); }
});
