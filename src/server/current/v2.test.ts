import { afterEach, expect, test } from "bun:test";
import { Database } from "../../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../../db/migrate";
import { ARCHIVE_LOGICAL_ROOT, LOGIN, MACHINE } from "../../config/paths";
import { persistProbeWindows } from "../../providers/core/probe";
import { configureGaugeJournal } from "../../providers/core/journal";
import type { WindowReading } from "../../providers/types";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../../db/period-store";
import { advanceAccountPeriods } from "../account-period-feed";
import { probeSourcesPending } from "../../db/probe-sources";
import { publishFirstFill } from "../../sync/first-fill";
import { acceptProbeFact, createProbeCollection, mapProbeLegacy } from "../../db/probe-facts";
import type { DatedPeriod } from "../account-periods";
import type { BootstrapSnapshot, SubscriptionDeclaration } from "../../web/lib/current-contract";
import type { SourceDeclaration } from "../archive-source";
import { currentSnapshot, handleCurrentRequest } from "./http";
import { preparedProbeAccountIndexReady, readPreparedProbeAccountRows, readPreparedProbeCoverage,
  readPreparedProbeProfileHealth, readPreparedProbeAccountRange, readPreparedProbeActivity, readPreparedProbeCadences,
  hasPreparedProbeAvailability } from "./probe-account-reader";
import { readLatestAccountStateRows } from "../latest-account-state-query";
import { cardProbeHealth, cardSubscriptionActivity, probeHealth, readCardHistories } from "../probe-health";
import { cycleStarts } from "../probe-limit-windows";
import { prepareLimitWindowsFixture } from "../limit-windows.fixture";
import { currentRegistry } from "./registry";
import { projectionState, publishCurrentBatch } from "./store";
import { markAllCurrentAccountsDirty, publishCurrentV2 } from "./v2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NOW = "2026-09-05T12:00:00.000Z";
const HOME = `C:/Users/${LOGIN}/.codex`;
type FixtureDefinition = SubscriptionDeclaration & SourceDeclaration;
const declarations: FixtureDefinition[] = [
  { id: "a", vendor: "codex", machine: "PC", home: `${ARCHIVE_LOGICAL_ROOT}/codex/PC-${LOGIN}`, source_home: HOME },
  { id: "b", vendor: "codex", machine: "LAPTOP", home: `${ARCHIVE_LOGICAL_ROOT}/codex/LAPTOP-${LOGIN}`, source_home: HOME },
  { id: "c", vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/other`, source_home: `C:/Users/${LOGIN}/.codex-2` },
];
function split(rows: readonly FixtureDefinition[]) {
  return { subscriptions: rows.map(({ id, vendor, account, account_key, label, note, status }) =>
    ({ id, vendor, account, account_key, label, note, status })),
    sources: rows.map(({ vendor, machine, login, home, source_home }) => ({ vendor, machine, login, home, source_home })) };
}
const opened: Database[] = [], directories: string[] = [];
afterEach(() => {
  opened.splice(0).forEach(db => db.close(true));
  directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});
function database(file = ":memory:") {
  const db = new Database(file, { create: true }); opened.push(db);
  applyDrizzleMigrations(drizzle(db));
  return db;
}
function period(source: string, account: string, from = "2026-09-01T00:00:00.000Z", until: string | null = null): DatedPeriod {
  return { provider: "codex", subject: source, value: account, from, until, origin: "declared",
    firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" };
}
function row(db: Database, machine: string, account: string, ts = "2026-09-05T11:00:00.000Z", used = 40,
  home = HOME, kind = "primary") {
  const id = Number(db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent,
    machine,profile,extra) VALUES('codex',?,? ,?,'used',?,?,?,?)`)
    .run(account, ts, kind, used, machine, LOGIN, JSON.stringify({ home })).lastInsertRowid);
  linkRow(db, id, home);
  return id;
}
function linkRow(db: Database, id: number, home?: string) {
  const reading = db.query("SELECT * FROM probe_windows WHERE id=?").get(id) as Record<string, unknown>;
  const sourceHome = home ?? (JSON.parse(String(reading.extra ?? "{}")) as { home?: string }).home ?? null;
  const fact = createProbeCollection([{ ...reading, raw_subject: null, login: LOGIN, source_home: sourceHome }])[0]!;
  db.transaction(() => { acceptProbeFact(db, fact); mapProbeLegacy(db, fact, id, "fixture-linked"); }).immediate();
}
function run(db: Database, defs = declarations, budget = 32, at = NOW) {
  const config = split(defs);
  const registry = currentRegistry(config.subscriptions, at);
  return publishCurrentBatch(db, registry, at, budget, config);
}
function settle(db: Database, defs = declarations, budget = 32, at = NOW) {
  let work = 0;
  while (run(db, defs, budget, at)) {
    if (++work > 500) throw new Error("projection did not settle");
  }
  return work;
}
function snapshot(db: Database, defs = declarations) {
  return currentSnapshot({ sqlite: db, accounts: split(defs) }, NOW) as BootstrapSnapshot;
}
function limit(db: Database, account: string, defs = declarations) {
  return snapshot(db, defs).data.subscriptions.find(s => s.id === account)?.limits[0];
}
const published = (db: Database, account: string) =>
  (db.query("SELECT data FROM current_probe_subjects WHERE provider='codex' AND subject=?").get(account) as { data: string } | null)?.data;
const counter = (db: Database, key: string) => Number((db.query("SELECT value FROM meta WHERE key=?")
  .get(`current_v2_${key}`) as { value: string } | null)?.value ?? 0);
/** The stored evidence of every reading with its write revision; unchanged means nothing was rewritten. */
const evidence = (db: Database) => db.query("SELECT probe_id,ord,revision FROM probe_sources ORDER BY probe_id,ord").all();

test("a first fill into a prepared empty projection reaches readers and cards through the evidence queue",()=>{
  const db=database();
  replaceDeclaredPeriods(db,ACCOUNT_PERIODS,[period(`codex/pc-${LOGIN}`.toLowerCase(),"a")]);
  settle(db);
  let id=0;
  db.transaction(()=>publishFirstFill(db,["probe_windows"],()=>{id=row(db,"PC","a");})).immediate();
  expect(probeSourcesPending(db)).toBe(true);
  settle(db);
  expect(readPreparedProbeAccountRows(db,"codex","a",{index:"resolved",limit:10})?.rows.map(r=>r.id)).toEqual([id]);
  expect(limit(db,"a")?.used_percent).toBe(40);
  expect(run(db)).toBe(false);
});

test("dated source correction moves only the missing-source Claude cohort and survives replay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-probe-correction-")); directories.push(root);
  const db = database(), account = "ea41";
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [{ ...period("claude/main", account, "2026-08-01"), provider: "claude" }]);
  const add = (subject: string, ts: string, machine: string | null, home: string | null) => {
    const id = Number(db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent,
      machine) VALUES('claude',?,?,'weekly','used',20,?)`).run(subject, ts, machine).lastInsertRowid);
    const projection = db.query("SELECT * FROM probe_windows WHERE id=?").get(id) as Record<string, unknown>;
    const fact = createProbeCollection([{ ...projection, raw_subject: null, login: home ? LOGIN : null,
      source_home: home }])[0]!;
    db.transaction(() => { acceptProbeFact(db, fact); mapProbeLegacy(db, fact, id, "fixture-linked"); }).immediate();
    return id;
  };
  const missing = add(account, "2026-08-25T10:00:00Z", null, null);
  const machineOnly = add(account, "2026-08-25T11:00:00Z", "LAPTOP", null);
  const physical = add(account, "2026-09-04T10:00:00Z", "PC", `C:/Users/${LOGIN}/.claude`);
  const registry = currentRegistry([{ id: account, vendor: "claude" }], NOW);
  const config = { archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN, configRoot: root };
  const settleCorrection = (physical = config) => { let n = 0; while (publishCurrentV2(db, registry, [], NOW, 16, physical)) {
    if (++n > 100) throw new Error("correction did not settle");
  } };
  settleCorrection();
  const owned = () => readPreparedProbeAccountRows(db, "claude", account, { index: "all", limit: 10 })!.rows
    .map(reading => reading.id).sort((a, b) => a - b);
  const base = owned();
  expect(base).not.toContain(missing);
  const originals = db.query("SELECT * FROM probe_counters ORDER BY id").all(), stored = evidence(db);
  const correctionFile = path.join(root, "probe-source-corrections.json");
  const declaration = { version: 1, corrections: [{
    provider: "claude", subject: account, from: "2026-08-24", until: "2026-09-03",
    source: "claude/main", evidence: "owner-declaration",
  }] };
  fs.writeFileSync(correctionFile, JSON.stringify(declaration));
  settleCorrection();
  // Only the reading without a computer joins; the one with a computer but no profile stays unowned.
  expect(owned()).toEqual([...base, missing].sort((a, b) => a - b));
  expect(owned()).not.toContain(machineOnly);
  expect(db.query("SELECT * FROM probe_counters ORDER BY id").all()).toEqual(originals);
  // A correction is read through: no evidence is rewritten, and a settled writer has nothing left to do.
  expect(evidence(db)).toEqual(stored);
  expect(publishCurrentV2(db, registry, [], NOW, 16, config)).toBe(false);
  fs.writeFileSync(correctionFile, JSON.stringify({ version: 1, corrections: [] }));
  settleCorrection();
  expect(owned()).toEqual(base);
  fs.writeFileSync(correctionFile, JSON.stringify(declaration));
  // A new archive location starts the projection over; the stored evidence survives it.
  settleCorrection({ ...config, archiveRoot: "H:/OtherArchive" });
  expect(owned()).toContain(missing);
  expect(evidence(db)).toEqual(stored);
  expect(physical).toBeGreaterThan(0);
});

test("daily probe activity survives restart and follows corrections without scanning history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-probe-activity-")); directories.push(dir);
  const file = path.join(dir, "index.sqlite"), db = database(file);
  const a = period(`codex/pc-${LOGIN}`, "a"), b = period(`codex/laptop-${LOGIN}`, "b");
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [a, b]);
  const first = row(db, "PC", "stale", "2026-09-01T10:00:00.000Z", 10, HOME, "weekly");
  const second = row(db, "PC", "stale", "2026-09-02T10:00:00.000Z", 20, HOME, "weekly");
  const error = row(db, "PC", "stale", "2026-09-02T11:00:00.000Z", 0, HOME, "error");
  row(db, "LAPTOP", "stale", "2026-09-03T10:00:00.000Z", 5);
  row(db, "UNKNOWN", "stale", "2026-09-03T10:00:00.000Z", 5);
  db.query("UPDATE probe_windows SET resets_at='2026-09-08T00:00:00Z',window_minutes=10080 WHERE id IN (?,?)")
    .run(first, second);
  linkRow(db, first); linkRow(db, second);
  settle(db);
  const before = readPreparedProbeActivity(db)!;
  expect(before.map(day => [day.account, day.day, day.samples, Object.keys(day.resets)])).toEqual([
    ["a", "2026-09-01", 1, ["2026-09-08T00:00:00Z"]],
    ["a", "2026-09-02", 2, ["2026-09-08T00:00:00Z"]],
    ["b", "2026-09-03", 1, []],
  ]);
  expect(before[1]!.last_ts).toBe("2026-09-02T11:00:00.000Z");
  expect(readPreparedProbeCadences(db, "codex", "a")?.map(row => [row.kind, row.latest?.id]))
    .toEqual([["weekly", second]]);
  const reopened = new Database(file, { readonly: true });
  try { expect(readPreparedProbeActivity(reopened)).toEqual(before); } finally { reopened.close(); }
  const counters = db.query("SELECT key,value FROM meta WHERE key LIKE 'current_v2_%' ORDER BY key").all();
  settle(db);
  expect(db.query("SELECT key,value FROM meta WHERE key LIKE 'current_v2_%' ORDER BY key").all()).toEqual(counters);
  db.query("DELETE FROM probe_windows WHERE id=?").run(error);
  db.query("UPDATE probe_windows SET resets_at='2026-09-09T00:00:00Z' WHERE id=?").run(second);
  linkRow(db, second);
  // The published evidence keeps answering while the corrected reading's evidence is written (golden rules §9).
  expect(probeSourcesPending(db)).toBe(true);
  const pending = readPreparedProbeActivity(db);
  settle(db);
  const corrected = readPreparedProbeActivity(db)!;
  expect(pending).toEqual(corrected);
  expect(corrected[1]).toMatchObject({ samples: 1, last_ts: "2026-09-02T10:00:00.000Z",
    resets: { "2026-09-09T00:00:00Z": 1 } });
  const originals = db.query("SELECT * FROM probe_windows ORDER BY id").all();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [{ ...a, value: "c" }, b]);
  // A period change is read through at once; nothing per account is rebuilt for readers.
  expect(readPreparedProbeActivity(db, "codex", "a")).toEqual([]);
  settle(db);
  expect(readPreparedProbeActivity(db, "codex", "a")).toEqual([]);
  expect(readPreparedProbeActivity(db, "codex", "c")).toEqual(corrected.filter(day => day.account === "a")
    .map(day => ({ ...day, account: "c" })));
  expect(readPreparedProbeActivity(db, "codex", "b")).toEqual(before.filter(day => day.account === "b"));
  expect(db.query("SELECT * FROM probe_windows ORDER BY id").all()).toEqual(originals);
  db.query("DELETE FROM probe_windows WHERE id=?").run(second);
  settle(db);
  expect(readPreparedProbeCadences(db, "codex", "c")?.map(row => row.latest?.id)).toEqual([first]);
  db.query("DELETE FROM probe_windows WHERE id=?").run(first);
  settle(db);
  expect(readPreparedProbeCadences(db, "codex", "c")).toEqual([]);
  expect(readPreparedProbeActivity(db, "codex", "c")).toEqual([]);
});

test("v1 cutover keeps original subjects and evidence while resolving two machines and excluding gaps", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [
    period(`codex/pc-${LOGIN}`.toLowerCase(), "a", undefined, "2026-09-05T11:30:00.000Z"),
    period(`codex/laptop-${LOGIN}`.toLowerCase(), "b"),
  ]);
  const first = row(db, "PC", "stale-subject");
  row(db, "LAPTOP", "stale-subject", undefined, 60, HOME, "primary");
  row(db, "PC", "a", "2026-09-05T11:40:00.000Z", 99);
  row(db, "PC", "a", "2026-09-05T11:50:00.000Z", 77, "C:/Unknown/profile");
  const originals = db.query("SELECT id,subject,extra FROM probe_windows ORDER BY id").all();
  expect(projectionState(db)?.schema_version).toBe(1);
  expect(snapshot(db).status).toBe("initializing");
  expect(run(db, declarations, 1)).toBe(true);
  expect(snapshot(db).status).toBe("initializing");
  settle(db, declarations, 1);
  expect(projectionState(db)?.schema_version).toBe(2);
  expect(limit(db, "a")?.used_percent).toBe(40);
  expect(limit(db, "b")?.used_percent).toBe(60);
  expect(limit(db, "c")).toBeUndefined();
  expect(db.query("SELECT id,subject,extra FROM probe_windows ORDER BY id").all()).toEqual(originals);
  expect(first).toBeGreaterThan(0);
  expect(counter(db, "source_rows")).toBe(4);
});

test("canonical-only physical evidence links after the probe journal and survives restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-current-canonical-")); directories.push(dir);
  const file = path.join(dir, "atlas.sqlite"), db = database(file);
  const source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  const id = Number(db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent,
    machine,profile,extra) VALUES('codex','stale','2026-09-05T11:00:00.000Z','primary','used',63,'PC',?,NULL)`)
    .run(LOGIN).lastInsertRowid);
  settle(db);
  expect(limit(db, "a")).toBeUndefined();
  const written = counter(db, "source_rows");
  linkRow(db, id, HOME);
  settle(db);
  expect(limit(db, "a")?.used_percent).toBe(63);
  // The new link queues its one reading again; nothing else is rewritten.
  expect(counter(db, "source_rows") - written).toBe(1);
  expect(db.query("SELECT extra FROM probe_windows WHERE id=?").get(id)).toEqual({ extra: null });
  db.close(); opened.splice(opened.indexOf(db), 1);
  const restarted = new Database(file); opened.push(restarted);
  const before = evidence(restarted);
  settle(restarted);
  expect(limit(restarted, "a")?.used_percent).toBe(63);
  expect(evidence(restarted)).toEqual(before);
});

test("prepared account reads and the current limit both order readings by instant", () => {
  const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  row(db, "PC", "stale", "2026-09-05T10:00:00+02:00", 20);
  row(db, "PC", "stale", "2026-09-05T09:00:00Z", 70);
  row(db, "PC", "stale", "2026-09-05T11:00:00Z", 90, HOME, "error");
  expect(preparedProbeAccountIndexReady(db)).toBe(false);
  settle(db);
  expect(preparedProbeAccountIndexReady(db)).toBe(true);
  // 10:00+02:00 is lexically newest but collected before 09:00Z.
  expect(limit(db, "a")?.used_percent).toBe(70);
  expect(readLatestAccountStateRows(db).find(sample => sample.account === "a")?.used_percent).toBe(70);
  expect(readPreparedProbeAccountRows(db, "codex", "a", { index: "codex-success", limit: 2 })?.rows.map(r => r.used_percent)).toEqual([70, 20]);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "b")]);
  // A period change does not take the readers down: the next read follows the new periods.
  expect(preparedProbeAccountIndexReady(db)).toBe(true);
  expect(readLatestAccountStateRows(db).find(sample => sample.account === "b")?.used_percent).toBe(70);
  settle(db);
  expect(readLatestAccountStateRows(db).find(sample => sample.account === "a")).toBeUndefined();
  expect(readLatestAccountStateRows(db).find(sample => sample.account === "b")?.used_percent).toBe(70);
});

test("a stale subject does not discard a physically proven reading", () => {
  const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  row(db, "PC", "stale", "2026-09-05T11:00:00.000Z", 81, HOME, "primary");
  settle(db);
  expect(limit(db, "a")?.used_percent).toBe(81);
  expect(readPreparedProbeAccountRows(db, "codex", "a", { index: "codex-success", limit: 1 })?.rows[0]?.used_percent).toBe(81);
  expect(readLatestAccountStateRows(db)[0]).toMatchObject({ account: "a", used_percent: 81 });
});

test("a probe captured by another process login follows its profile home and account period", () => {
  const db = database(), foreignHome = "C:/Users/sample_c/.codex";
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [
    period(`codex/pc-${LOGIN}`.toLowerCase(), "codex1"),
    period("codex/pc-sample_c", "codex3"),
  ]);
  const own = row(db, "PC", "stale", "2026-09-05T10:00:00.000Z", 20);
  const foreign = row(db, "PC", "codex3", "2026-09-05T11:00:00.000Z", 40, foreignHome);
  settle(db);
  expect(readPreparedProbeAccountRows(db, "codex", "codex1", { index: "resolved", limit: 10 })?.rows.map(r => r.id))
    .toEqual([own]);
  expect(readPreparedProbeAccountRows(db, "codex", "codex3", { index: "resolved", limit: 10 })?.rows.map(r => r.id))
    .toEqual([foreign]);
  expect(db.query("SELECT subject FROM probe_windows WHERE id=?").get(foreign)).toEqual({ subject: "codex3" });
});

test("the first evidence write resumes across restart, then ready startup reads no probe history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-current-v2-")); directories.push(dir);
  const file = path.join(dir, "atlas.sqlite"), db = database(file);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/pc-${LOGIN}`.toLowerCase(), "a")]);
  for (let i = 0; i < 7; i++) row(db, "PC", "wrong", `2026-09-05T11:0${i}:00.000Z`, i);
  run(db, declarations, 2);
  run(db, declarations, 2);
  expect(counter(db, "source_rows")).toBe(4);
  expect(preparedProbeAccountIndexReady(db)).toBe(false);
  db.close(); opened.splice(opened.indexOf(db), 1);
  const restarted = new Database(file); opened.push(restarted);
  settle(restarted, declarations, 2);
  expect(counter(restarted, "source_rows")).toBe(7);
  expect(limit(restarted, "a")?.used_percent).toBe(6);
  const count = counter(restarted, "source_rows");
  expect(run(restarted, declarations, 2)).toBe(false);
  expect(counter(restarted, "source_rows")).toBe(count);
  const cold = new Database(file, { readonly: true }); opened.push(cold);
  expect(limit(cold, "a")?.used_percent).toBe(6);
});

test("the first evidence write takes in concurrent insert, correction and removal before publishing", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/pc-${LOGIN}`.toLowerCase(), "a")]);
  const first = row(db, "PC", "stale", "2026-09-05T10:00:00.000Z", 10);
  const removed = row(db, "PC", "stale", "2026-09-05T11:00:00.000Z", 60);
  run(db, declarations, 1);
  expect(db.query("SELECT probe_id FROM probe_sources").all()).toEqual([{ probe_id: first }]);
  db.query("UPDATE probe_windows SET used_percent=25 WHERE id=?").run(first);
  linkRow(db, first);
  db.query("DELETE FROM probe_windows WHERE id=?").run(removed);
  const added = row(db, "PC", "stale", "2026-09-05T11:30:00.000Z", 75);
  expect(snapshot(db).status).toBe("initializing");
  settle(db, declarations, 1);
  expect(limit(db, "a")?.used_percent).toBe(75);
  expect(db.query("SELECT DISTINCT probe_id FROM probe_sources ORDER BY probe_id").all()).toEqual([{ probe_id: first }, { probe_id: added }]);
});

test("insert, correction and deletion find the predecessor with bounded resumed folds", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/pc-${LOGIN}`.toLowerCase(), "a")]);
  const old = row(db, "PC", "wrong", "2026-09-05T10:00:00.000Z", 20);
  settle(db, declarations, 1);
  const folded = counter(db, "fold_rows");
  const winner = row(db, "PC", "wrong", "2026-09-05T11:00:00.000Z", 70);
  settle(db, declarations, 1);
  expect(limit(db, "a")?.used_percent).toBe(70);
  expect(counter(db, "fast_inserts")).toBe(1);
  expect(counter(db, "fold_rows")).toBe(folded);
  db.query("UPDATE probe_windows SET used_percent=80 WHERE id=?").run(winner);
  linkRow(db, winner);
  settle(db, declarations, 1);
  expect(limit(db, "a")?.used_percent).toBe(80);
  db.query("DELETE FROM probe_windows WHERE id=?").run(winner);
  const before = published(db, "a"), foldedBefore = counter(db, "fold_rows");
  settle(db, declarations, 1);
  expect(published(db, "a")).not.toBe(before);
  // The winner's predecessor is sought by index; the account is not folded again.
  expect(counter(db, "fold_rows")).toBe(foldedBefore);
  expect(limit(db, "a")?.used_percent).toBe(20);
  expect(old).toBeGreaterThan(0);
  const generation = projectionState(db)!.generation;
  db.query("UPDATE probe_windows SET used_percent=used_percent WHERE id=?").run(old);
  settle(db, declarations, 1);
  expect(projectionState(db)!.generation).toBe(generation);
});

test("a period correction publishes old and new accounts together; unrelated snapshot stays byte-identical", () => {
  const db = database();
  const source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  row(db, "PC", "stale", undefined, 44);
  row(db, "LAPTOP", "stale", undefined, 64);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a"), period(`codex/laptop-${LOGIN}`.toLowerCase(), "b")]);
  settle(db, declarations, 1);
  const unrelated = db.query("SELECT data,generated_at FROM current_probe_subjects WHERE provider='codex' AND subject='b'").get();
  const old = published(db, "a");
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "c"), period(`codex/laptop-${LOGIN}`.toLowerCase(), "b")]);
  expect((JSON.parse((db.query("SELECT value FROM meta WHERE key='current_v2_period_deltas'").get() as { value: string }).value) as
    Array<{ oldAccount: string; newAccount: string }>).map(delta => [delta.oldAccount, delta.newAccount])).toEqual([["a", "c"]]);
  run(db, declarations, 1);
  expect(published(db, "a")).toBe(old);
  expect(db.query("SELECT data,generated_at FROM current_probe_subjects WHERE provider='codex' AND subject='b'").get()).toEqual(unrelated);
  settle(db, declarations, 1);
  expect(limit(db, "a")).toBeUndefined();
  expect(limit(db, "c")?.used_percent).toBe(44);
  expect(db.query("SELECT data,generated_at FROM current_probe_subjects WHERE provider='codex' AND subject='b'").get()).toEqual(unrelated);
});

test("account readings follow an A/C period change at once while B and unrelated work stay readable", () => {
  const db = database(), pc = `codex/pc-${LOGIN}`.toLowerCase(), laptop = `codex/laptop-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "a"), period(laptop, "b")]);
  for (let i = 0; i < 40; i++)
    row(db, "PC", "stale", new Date(Date.parse("2026-09-05T10:00:00Z") + i * 1000).toISOString(), i);
  row(db, "LAPTOP", "stale", "2026-09-05T11:00:00.000Z", 73);
  const unrelatedLink = Number(db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,
    used_percent,machine,profile,extra) VALUES('gemini','stale',?,'weekly','used',31,'PC',?,?)`)
    .run("2026-09-05T11:00:00.000Z", LOGIN, JSON.stringify({ home: HOME })).lastInsertRowid);
  settle(db, declarations, 2);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "c"), period(laptop, "b")]);
  run(db, declarations, 1);
  expect(preparedProbeAccountIndexReady(db)).toBe(true);
  expect(readPreparedProbeCoverage(db, "codex", "a")?.samples).toBe(0);
  expect(readPreparedProbeCoverage(db, "codex", "c")?.samples).toBe(40);
  expect(readPreparedProbeCoverage(db, "codex", "b")?.samples).toBe(1);
  expect(readPreparedProbeProfileHealth(db)?.find(profile => profile.account === "b")?.preparing).toBe(false);
  expect(probeHealth(db, "codex", "a", Date.parse(NOW)).reading).toBeNull();
  expect(readLatestAccountStateRows(db).find(sample => sample.account === "c")?.used_percent).toBe(39);
  expect(readPreparedProbeAccountRows(db, "codex", "b", { index: "success", limit: 1 })?.rows[0]?.used_percent).toBe(73);
  expect(readPreparedProbeCoverage(db, "codex", "b")?.samples).toBe(1);
  expect(probeHealth(db, "codex", "b", Date.parse(NOW)).reading?.ts).toBe("2026-09-05T11:00:00.000Z");
  linkRow(db, unrelatedLink, HOME);
  expect(readPreparedProbeAccountRows(db, "codex", "b", { index: "success", limit: 1 })?.rows[0]?.used_percent).toBe(73);
  expect(probeHealth(db, "codex", "b", Date.parse(NOW)).reading?.ts).toBe("2026-09-05T11:00:00.000Z");
  expect(readPreparedProbeAccountRows(db, "codex", "c", { index: "success", limit: 1 })?.rows[0]?.used_percent).toBe(39);
});

test("changing only a display label leaves probe history and published counters unchanged", () => {
  const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  for (let i = 0; i < 100; i++)
    row(db, "PC", "stale", new Date(Date.parse("2026-09-05T10:00:00Z") + i * 1000).toISOString(), i);
  settle(db);
  const before = published(db, "a"), scanned = counter(db, "fold_rows");
  const renamed = declarations.map(d => d.id === "a" ? { ...d, label: "New display label" } : d);
  settle(db, renamed);
  expect(snapshot(db, renamed).data.subscriptions.find(s => s.id === "a")?.label).toBe("New display label");
  expect(published(db, "a")).toBe(before);
  expect(counter(db, "fold_rows")).toBe(scanned);
});

test("splitting unchanged physical sources from subscriptions preserves the prepared index", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/pc-${LOGIN}`.toLowerCase(), "a")]);
  row(db, "PC", "stale");
  const config = split(declarations);
  const oldRegistry = currentRegistry(config.subscriptions).map(identity => ({ ...identity, binding_active: true }));
  for (let attempt = 0; publishCurrentBatch(db, oldRegistry, NOW, 32, config); attempt++)
    if (attempt > 500) throw new Error("old current projection did not settle");
  const stored = evidence(db), scanned = counter(db, "fold_rows");
  const oldDefinitions = db.query("SELECT value FROM meta WHERE key='current_v2_definitions'").get() as { value: string };
  db.query("UPDATE meta SET value=? WHERE key='current_v2_declarations'").run(JSON.stringify(declarations));
  settle(db);
  expect((db.query("SELECT value FROM meta WHERE key='current_v2_definitions'").get() as { value: string }).value)
    .toBe(oldDefinitions.value);
  expect(evidence(db)).toEqual(stored);
  expect(counter(db, "fold_rows")).toBe(scanned);
});

test.each(["delete", "move"])("removing a lower-id conflicting tie clears the surviving counter (%s)", action => {
  const db = database(), pc = `codex/pc-${LOGIN}`.toLowerCase(), laptop = `codex/laptop-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "a"), period(laptop, "a")]);
  const lower = row(db, "PC", "stale", "2026-09-05T11:00:00.000Z", 40);
  row(db, "LAPTOP", "stale", "2026-09-05T11:00:00.000Z", 60);
  settle(db);
  expect(limit(db, "a")?.freshness).toBe("conflict");
  if (action === "delete") db.query("DELETE FROM probe_windows WHERE id=?").run(lower);
  else replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "b"), period(laptop, "a")]);
  settle(db);
  expect(limit(db, "a")?.used_percent).toBe(60);
  expect(limit(db, "a")?.freshness).not.toBe("conflict");
  if (action === "move") expect(limit(db, "b")?.used_percent).toBe(40);
});

test("source mapping correction reindexes archived profile without using account label", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period("codex/corrected", "a"),
    period(`codex/laptop-${LOGIN}`.toLowerCase(), "b")]);
  const claude = { id: "claude-account", vendor: "claude", machine: "PC",
    home: `${ARCHIVE_LOGICAL_ROOT}/claude/PC`, source_home: `C:/Users/${LOGIN}/.claude` };
  const initial = [...declarations, claude];
  db.query(`INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence)
    VALUES('claude','claude/pc','2026-09-01','claude-account','declared','fixture')`).run();
  db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent,machine,profile,extra)
    VALUES('claude','stale','2026-09-05T11:00:00.000Z','weekly','used',26,'PC',?,?)`)
    .run(LOGIN, JSON.stringify({ home: claude.source_home }));
  const claudeId = (db.query("SELECT id FROM probe_windows WHERE provider='claude' ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
  linkRow(db, claudeId, claude.source_home);
  for (let i = 0; i < 100; i++) row(db, "LAPTOP", "unrelated", new Date(Date.parse("2026-09-05T10:00:00Z") + i * 1000).toISOString(), i,
    `C:/Users/${LOGIN}/.codex-unrelated`);
  row(db, "LAPTOP", "other-machine", "2026-09-05T10:30:00.000Z", 33, `C:/Users/${LOGIN}/.codex-custom`);
  row(db, "PC", "a", undefined, 51, `C:/Users/${LOGIN}/.codex-custom`);
  row(db, "LAPTOP", "stale", undefined, 67);
  settle(db, initial);
  expect(limit(db, "a", initial)).toBeUndefined();
  const unrelated = published(db, "claude-account"), stored = evidence(db), unchanged = published(db, "b");
  const corrected = [{ ...declarations[0]!, home: `${ARCHIVE_LOGICAL_ROOT}/codex/corrected`, source_home: `C:/Users/${LOGIN}/.codex-custom` },
    ...declarations.slice(1), claude];
  run(db, corrected, 1);
  // Readers resolve with the new declarations at once.
  expect(readPreparedProbeAccountRows(db, "codex", "a", { index: "success", limit: 1 })?.rows[0]?.used_percent).toBe(51);
  expect(readPreparedProbeAccountRows(db, "codex", "b", { index: "success", limit: 1 })?.rows[0]?.used_percent).toBe(67);
  settle(db, corrected);
  expect(limit(db, "a", corrected)?.used_percent).toBe(51);
  expect(readPreparedProbeCoverage(db, "codex", "a")?.samples).toBe(1);
  expect(readPreparedProbeProfileHealth(db)?.some(profile => profile.provider === "codex"
    && profile.account === "a" && profile.machine === "PC"
    && profile.profile === `C:/Users/${LOGIN}/.codex-custom`)).toBe(true);
  expect(published(db, "claude-account")).toBe(unrelated);
  expect(published(db, "b")).toBe(unchanged);
  expect(evidence(db)).toEqual(stored);
});

test("duplicate canonical profiles are both indexed and a disputed remap removes ownership", () => {
  const db = database(), otherHome = `C:/Users/${LOGIN}/.codex-2`;
  const source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  const base = { id: "a", vendor: "codex", machine: "PC",
    home: `${ARCHIVE_LOGICAL_ROOT}/codex/PC-${LOGIN}` };
  const defs = [{ ...base, source_home: HOME }, { ...base, source_home: otherHome }];
  const id = row(db, "PC", "stale", undefined, 45);
  const projected = db.query("SELECT * FROM probe_windows WHERE id=?").get(id) as Record<string, unknown>;
  const second = createProbeCollection([{ ...projected, raw_subject: null, login: LOGIN, source_home: otherHome }])[0]!;
  db.transaction(() => { acceptProbeFact(db, second); mapProbeLegacy(db, second, id, "second-profile"); }).immediate();
  settle(db, defs);
  expect(limit(db, "a", defs)?.used_percent).toBe(45);
  expect(db.query("SELECT count(*) n FROM probe_sources WHERE probe_id=?").get(id)).toEqual({ n: 2 });
  expect(readPreparedProbeProfileHealth(db)?.filter(profile => profile.account === "a"
    && profile.machine === "PC").map(profile => profile.profile).sort()).toEqual([HOME, otherHome].sort());
  const originals = db.query("SELECT id,payload FROM probe_counters ORDER BY id").all();
  const corrected = [defs[0]!, { ...defs[1]!, home: `${ARCHIVE_LOGICAL_ROOT}/codex/other` }];
  settle(db, corrected);
  expect(limit(db, "a", corrected)).toBeUndefined();
  expect(readPreparedProbeCoverage(db, "codex", "a")?.samples).toBe(0);
  expect(readPreparedProbeProfileHealth(db)?.filter(profile => profile.account === null
    && profile.machine === "PC").map(profile => profile.profile).sort()).toEqual([HOME, otherHome].sort());
  expect(db.query("SELECT id,payload FROM probe_counters ORDER BY id").all()).toEqual(originals);
});

test("a later reading republishes the projection from its own queue, with no change journal", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/pc-${LOGIN}`.toLowerCase(), "a")]);
  row(db, "PC", "wrong"); settle(db);
  row(db, "PC", "wrong", "2026-09-05T11:30:00.000Z", 70);
  const generation = projectionState(db)!.generation;
  expect(run(db, declarations, 1)).toBe(true);
  expect(snapshot(db).status).not.toBe("initializing");
  settle(db, declarations, 1);
  expect(limit(db, "a")?.used_percent).toBe(70);
  expect(projectionState(db)!.generation).toBe(generation + 1);
});

test("published result matches an independent full source and period fold; GET reads only projection", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/pc-${LOGIN}`.toLowerCase(), "a")]);
  const rows = [
    { machine: "PC", account: "stale", ts: "2026-09-05T10:00:00.000Z", used: 10 },
    { machine: "PC", account: "wrong", ts: "2026-09-05T11:00:00.000Z", used: 30 },
    { machine: "LAPTOP", account: "a", ts: "2026-09-05T11:30:00.000Z", used: 99 },
  ];
  rows.forEach(r => row(db, r.machine, r.account, r.ts, r.used));
  settle(db, declarations, 1);
  const reference = () => (db.query("SELECT machine,ts,used_percent,extra FROM probe_windows").all() as Array<{
    machine: string; ts: string; used_percent: number; extra: string;
  }>).filter(r => r.machine === "PC" && JSON.parse(r.extra).home === HOME && r.ts <= NOW)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0]?.used_percent;
  expect(limit(db, "a")?.used_percent).toBe(reference());
  const added = row(db, "PC", "wrong", "2026-09-05T11:45:00.000Z", 73);
  settle(db, declarations, 1);
  expect(limit(db, "a")?.used_percent).toBe(reference());
  db.query("UPDATE probe_windows SET used_percent=81 WHERE id=?").run(added);
  linkRow(db, added);
  settle(db, declarations, 1);
  expect(limit(db, "a")?.used_percent).toBe(reference());
  db.query("DELETE FROM probe_windows WHERE id=?").run(added);
  settle(db, declarations, 1);
  expect(limit(db, "a")?.used_percent).toBe(reference());
  const before = (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
  const sql: string[] = [];
  const traced = new Proxy(db, { get(target, property) {
    if (property === "query") return (statement: string) => { sql.push(statement); return target.query(statement); };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  for (const route of ["/api/bootstrap", "/api/subscriptions/a/current", "/api/revisions"])
    expect(handleCurrentRequest({ sqlite: traced, accounts: split(declarations) },
      new Request(`http://fixture${route}`), NOW)?.status).toBe(200);
  expect(sql.some(query => /\b(probe_windows|analysis_changes)\b/i.test(query))).toBe(false);
  expect((db.query("SELECT total_changes() AS n").get() as { n: number }).n).toBe(before);
});

test("v2 retains conflict, error, reset and future-reading semantics", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/pc-${LOGIN}`.toLowerCase(), "a")]);
  row(db, "PC", "stale", "2026-09-05T11:00:00.000Z", 20);
  row(db, "PC", "different-stamp", "2026-09-05T11:00:00.000Z", 80, HOME, "primary");
  row(db, "PC", "stale", "2026-09-05T11:30:00.000Z", 1, HOME, "error");
  const future = row(db, "PC", "stale", "2026-09-05T13:00:00.000Z", 90);
  settle(db);
  expect(limit(db, "a")?.freshness).toBe("conflict");
  expect(snapshot(db).data.subscriptions.find(s => s.id === "a")?.latest_error?.code).toBe("probe-failed");
  expect(snapshot(db).data.subscriptions.find(s => s.id === "a")?.clock_warning).toBe(true);
  settle(db, declarations, 32, "2026-09-05T13:00:01.000Z");
  const later = currentSnapshot({ sqlite: db, accounts: split(declarations) }, "2026-09-05T13:00:01.000Z") as BootstrapSnapshot;
  expect(later.data.subscriptions.find(s => s.id === "a")?.limits[0]?.used_percent).toBe(90);
  db.query("UPDATE probe_windows SET resets_at=? WHERE id=?").run("2026-09-05T13:00:01.000Z", future);
  linkRow(db, future);
  settle(db, declarations, 32, "2026-09-05T13:00:01.000Z");
  const expired = currentSnapshot({ sqlite: db, accounts: split(declarations) }, "2026-09-05T13:00:01.000Z") as BootstrapSnapshot;
  expect(expired.data.subscriptions.find(s => s.id === "a")?.limits[0]).toMatchObject({
    freshness: "expired", used_percent: null, remaining_percent: null,
  });
});

test("cards keep the activity and probe health the account readers answer, through corrections, deletions and period moves", () => {
  const db = database(), pc = `codex/pc-${LOGIN}`.toLowerCase(), laptop = `codex/laptop-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "a"), period(laptop, "b")]);
  const ids: number[] = [];
  for (let i = 0; i < 12; i++) ids.push(row(db, i % 3 ? "PC" : "LAPTOP", "stale",
    new Date(Date.parse("2026-09-03T10:00:00.000Z") + i * 3_600_000).toISOString(), i * 5, HOME, i % 4 === 3 ? "error" : "weekly"));
  ids.push(row(db, "PC", "stale", "2026-09-06T10:00:00.000Z", 1));
  db.query("UPDATE probe_windows SET ok=0, error='quota read failed' WHERE id=?").run(ids[3]!);
  db.query("UPDATE probe_windows SET machine='OTHER' WHERE id=?").run(ids[4]!);
  db.query("UPDATE probe_windows SET window_minutes=10080, resets_at=CASE WHEN id<? THEN '2026-09-08T00:00:00Z' ELSE '2026-09-09T00:00:00Z' END WHERE kind='weekly'")
    .run(ids[6]!);
  for (const id of ids) linkRow(db, id);
  // Cycles are stored limit windows, not part of the card; here the span alone is compared.
  const reference = () => {
    const activity = new Map<string, { first_seen: string | null; last_seen: string | null; cycle_count: number }>();
    for (const day of readPreparedProbeActivity(db)!) {
      const value = activity.get(day.account) ?? { first_seen: null, last_seen: null, cycle_count: 0 };
      if (!value.first_seen || day.first_ts < value.first_seen) value.first_seen = day.first_ts;
      if (!value.last_seen || day.last_ts > value.last_seen) value.last_seen = day.last_ts;
      activity.set(day.account, value);
    }
    return { activity: [...activity].sort(), health: ["a", "b", "c"].map(id => probeHealth(db, "codex", id, Date.parse(NOW), 30)) };
  };
  const stored = () => {
    const cards = readCardHistories(db);
    return { activity: [...cardSubscriptionActivity(cards, () => [])].sort(),
      health: ["a", "b", "c"].map(id => cardProbeHealth(cards, "codex", id, Date.parse(NOW), 30)) };
  };
  settle(db);
  expect(stored()).toEqual(reference());
  expect(stored().activity.find(([id]) => id === "a")?.[1]).toMatchObject({ first_seen: "2026-09-03T11:00:00.000Z" });
  // A reading under an undeclared computer belongs to no account.
  expect(stored().health[0]!.machines.map(machine => machine.machine)).toEqual(["PC"]);
  // A correction brings that reading back with another reset; a deletion removes the newest success and an edge.
  db.query("UPDATE probe_windows SET machine='PC', resets_at='2026-09-10T00:00:00Z' WHERE id=?").run(ids[4]!);
  linkRow(db, ids[4]!);
  db.query("DELETE FROM probe_windows WHERE id IN (?,?)").run(ids[12]!, ids[1]!);
  settle(db);
  expect(stored()).toEqual(reference());
  // The removals were repaired by seeking within their spans, not by folding the account again.
  expect(counter(db, "history_repairs")).toBeGreaterThan(0);
  // A period move: the gaining account folds the interval, the losing one repairs what came from it.
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "a", undefined, "2026-09-03T16:00:00.000Z"),
    period(pc, "c", "2026-09-03T16:00:00.000Z"), period(laptop, "b")]);
  settle(db);
  expect(stored()).toEqual(reference());
  expect(stored().health[2]!.reading).not.toBeNull();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "c"), period(laptop, "b")]);
  settle(db);
  expect(stored()).toEqual(reference());
  expect(stored().activity.some(([id]) => id === "a")).toBe(false);
});

test("cycles are the stored windows of the main weekly counter; idle meters and reset jitter add none, and cards keep no resets", () => {
  const db = database(), pc = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "a")]);
  const insert = (ts: string, used: number, kind: string, group: string, reset: string) => {
    const id = row(db, "PC", "stale", ts, used, HOME, kind);
    db.query("UPDATE probe_windows SET limit_group=?, resets_at=?, window_minutes=10080 WHERE id=?").run(group, reset, id);
    linkRow(db, id);
  };
  // Two weeks of the main meter, each reported with sub-second reset jitter in either notation.
  const weeks = ["2026-09-08T11:00:00.000Z", "2026-09-15T11:00:00.000Z"];
  weeks.forEach((week, w) => { for (let i = 0; i < 6; i++) {
    const reset = i % 2 ? new Date(Date.parse(week) - 400 + i * 37).toISOString()
      : new Date(Date.parse(week) + i * 53).toISOString().replace(/\.(\d{3})Z$/, ".$1123+00:00");
    insert(new Date(Date.parse(week) - 6 * 86_400_000 + i * 3_600_000).toISOString(), 10 * w + i, "primary", "codex", reset);
  } });
  // An idle secondary meter whose reset is always "now + 7 days".
  for (let i = 0; i < 12; i++) {
    const ts = new Date(Date.parse("2026-09-02T12:00:00.000Z") + i * 86_400_000).toISOString();
    insert(ts, 0, "primary", "base_model_inference", new Date(Date.parse(ts) + 7 * 86_400_000).toISOString());
  }
  settle(db);
  prepareLimitWindowsFixture(db);
  expect(cycleStarts(db, "codex", "a")).toHaveLength(2);
  const cards = readCardHistories(db);
  expect(cardSubscriptionActivity(cards, (provider, subject) => cycleStarts(db, provider, subject)).get("a"))
    .toMatchObject({ first_seen: "2026-09-02T11:00:00.000Z", cycle_count: 2 });
  const data = JSON.parse(published(db, "a")!) as { __activity: Record<string, unknown> };
  expect(Object.keys(data.__activity)).toEqual(["first", "last"]);
});

test("a one-second period edit folds one reading at N=100 and N=1000", () => {
  for (const size of [100, 1000]) {
    const db = database();
    const source = `codex/pc-${LOGIN}`.toLowerCase();
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
    const base = Date.parse("2026-09-05T10:00:00.000Z");
    for (let i = 0; i < size; i++) row(db, "PC", "stale", new Date(base + i * 1000).toISOString(), i % 100);
    row(db, "PC", "stale", "2026-09-05T11:00:00.000Z", 99);
    settle(db);
    const index = Math.floor(size / 2), from = new Date(base + index * 1000).toISOString();
    const until = new Date(base + (index + 1) * 1000).toISOString();
    const before = published(db, "a"), folded = counter(db, "fold_rows") + counter(db, "period_rows"), stored = evidence(db);
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a", undefined, from),
      period(source, "b", from, until), period(source, "a", until)]);
    settle(db);
    // B's card is folded from its one reading; A's card did not show it and is kept; no evidence is rewritten.
    expect({ size, folded: counter(db, "fold_rows") + counter(db, "period_rows") - folded }).toEqual({ size, folded: 1 });
    expect(evidence(db)).toEqual(stored);
    expect(published(db, "a")).toBe(before);
    expect(limit(db, "a")?.used_percent).toBe(99);
    expect(limit(db, "b")?.used_percent).toBe(index % 100);
  }
});

test("prepared coverage and physical health follow periods, gaps, stale subjects and deletion", () => {
  const db = database(), pc = `codex/pc-${LOGIN}`.toLowerCase(), laptop = `codex/laptop-${LOGIN}`.toLowerCase();
  const t1 = "2026-09-05T10:00:00.000Z", t2 = "2026-09-05T10:00:01.000Z";
  const t3 = "2026-09-05T10:00:02.000Z";
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "a", undefined, t2),
    period(pc, "b", t2, t3), period(laptop, "c")]);
  const first = row(db, "PC", "wrong", t1, 10, HOME, "primary");
  const second = row(db, "PC", "wrong", t2, 20);
  row(db, "PC", "wrong", t3, 30);
  row(db, "LAPTOP", "wrong", t2, 40);
  const originals = db.query("SELECT id,subject,extra FROM probe_windows ORDER BY id").all();
  settle(db);
  expect(readPreparedProbeCoverage(db, "codex", "a")).toMatchObject({ samples: 1, first_at: t1, last_at: t1, visitedBuckets: 1 });
  expect(readPreparedProbeCoverage(db, "codex", "b")?.samples).toBe(1);
  expect(readPreparedProbeCoverage(db, "codex", "c")?.samples).toBe(1);
  expect(readPreparedProbeAccountRange(db, "codex", "a", t2, t3)?.rows).toHaveLength(0);
  const profiles = readPreparedProbeProfileHealth(db)!;
  expect(profiles.some(profile => profile.account === null && profile.machine === "PC" && profile.success?.ts === t3)).toBe(true);
  expect(profiles.some(profile => profile.account === "c" && profile.machine === "LAPTOP" && profile.success?.ts === t2)).toBe(true);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "a", undefined, t3), period(laptop, "c")]);
  settle(db);
  const reference = (db.query("SELECT ts FROM probe_windows WHERE machine='PC' AND ts<? AND used_percent IS NOT NULL ORDER BY ts")
    .all(t3) as Array<{ ts: string }>).map(reading => reading.ts);
  expect(readPreparedProbeCoverage(db, "codex", "a")).toMatchObject({
    samples: reference.length, first_at: reference[0], last_at: reference.at(-1), visitedBuckets: 1,
  });
  expect(readPreparedProbeCoverage(db, "codex", "b")?.samples).toBe(0);
  expect(db.query("SELECT id,subject,extra FROM probe_windows ORDER BY id").all()).toEqual(originals);
  db.query("DELETE FROM probe_windows WHERE id=?").run(first);
  settle(db);
  expect(readPreparedProbeCoverage(db, "codex", "a")).toMatchObject({ samples: 1, first_at: t2, last_at: t2 });
  expect(readPreparedProbeAccountRange(db, "codex", "a", t2, t3)?.rows.map(reading => reading.id)).toEqual([second]);
});

test("coverage reads the account's readings through the evidence index at N=100 and N=1000", () => {
  for (const size of [100, 1000]) {
    const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
    for (let i = 0; i < size; i++) row(db, "PC", "wrong",
      new Date(Date.parse("2026-09-05T10:00:00.000Z") + i * 1000).toISOString(), i % 100);
    settle(db);
    let unindexed = 0;
    const original = db.query.bind(db);
    (db as Database & { query: Database["query"] }).query = ((sql: string) => {
      if (/\bprobe_windows\b/i.test(sql) && !/\bprobe_sources\b/i.test(sql)) unindexed++;
      return original(sql);
    }) as Database["query"];
    const coverage = readPreparedProbeCoverage(db, "codex", "a");
    expect({ size, samples: coverage?.samples, buckets: coverage?.visitedBuckets, unindexed })
      .toEqual({ size, samples: size, buckets: 1, unindexed: 0 });
  }
});

test("availability retains zero quota evidence across a period move and deletion", () => {
  const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  const id = row(db, "PC", "stale", undefined, 0, HOME, "quota");
  db.query("UPDATE probe_windows SET used_percent=NULL,allowance=0 WHERE id=?").run(id);
  linkRow(db, id);
  const invalid = row(db, "PC", "stale", "2026-09-05T11:01:00.000Z", 20, HOME, "invalid");
  db.query("UPDATE probe_windows SET ok=2 WHERE id=?").run(invalid); linkRow(db, invalid);
  settle(db);
  expect(hasPreparedProbeAvailability(db, "codex", "a")).toBe(true);
  expect(readPreparedProbeCoverage(db, "codex", "a")?.samples).toBe(0);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "c")]);
  settle(db);
  expect(hasPreparedProbeAvailability(db, "codex", "a")).toBe(false);
  expect(hasPreparedProbeAvailability(db, "codex", "c")).toBe(true);
  db.query("DELETE FROM probe_windows WHERE id=?").run(id); settle(db);
  expect(hasPreparedProbeAvailability(db, "codex", "c")).toBe(false);
});

test("canonical append work is constant at N=100 and N=1000", () => {
  for (const size of [100, 1000]) {
    const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
    for (let i = 0; i < size; i++)
      row(db, "PC", "stale", new Date(Date.parse("2026-09-05T10:00:00Z") + i * 1000).toISOString(), i % 100);
    settle(db);
    const before = Object.fromEntries(["source_rows", "fold_rows", "fast_inserts"].map(key => [key, counter(db, key)]));
    row(db, "PC", "stale", "2026-09-05T11:30:00.000Z", 88);
    let probeReads = 0;
    const original = db.query.bind(db);
    (db as Database & { query: Database["query"] }).query = ((sql: string) => {
      if (sql.replace(/\s+/g, " ").trim() === "SELECT * FROM probe_windows WHERE id=?") probeReads++;
      return original(sql);
    }) as Database["query"];
    settle(db);
    expect({ size, probeReads, written: counter(db, "source_rows") - before.source_rows!,
      folded: counter(db, "fold_rows") - before.fold_rows!, fast: counter(db, "fast_inserts") - before.fast_inserts! }).toEqual({
      size, probeReads: 1, written: 1, folded: 0, fast: 1,
    });
    expect(limit(db, "a")?.used_percent).toBe(88);
  }
});

test("period delta matches an independent full fold across two physical machines", () => {
  const db = database(), pc = `codex/pc-${LOGIN}`.toLowerCase(), laptop = `codex/laptop-${LOGIN}`.toLowerCase();
  const periods = [period(pc, "a"), period(laptop, "b")];
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, periods);
  row(db, "PC", "wrong", "2026-09-05T10:00:00.000Z", 10);
  row(db, "PC", "wrong", "2026-09-05T10:00:01.000Z", 20);
  row(db, "PC", "wrong", "2026-09-05T10:00:02.000Z", 30);
  row(db, "LAPTOP", "wrong", "2026-09-05T10:00:01.000Z", 70);
  settle(db, declarations, 1);
  const corrected = [period(pc, "a", undefined, "2026-09-05T10:00:01.000Z"),
    period(pc, "c", "2026-09-05T10:00:01.000Z", "2026-09-05T10:00:02.000Z"),
    period(pc, "a", "2026-09-05T10:00:02.000Z"), period(laptop, "b")];
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, corrected);
  settle(db, declarations, 1);
  const originals = db.query("SELECT machine,ts,used_percent,extra FROM probe_windows").all() as Array<{
    machine: string; ts: string; used_percent: number; extra: string }>;
  const reference = (account: string) => originals.flatMap(reading => {
    if (JSON.parse(reading.extra).home !== HOME || Date.parse(reading.ts) > Date.parse(NOW)) return [];
    const source = reading.machine === "PC" ? pc : reading.machine === "LAPTOP" ? laptop : null;
    const owner = corrected.find(p => p.subject === source && Date.parse(p.from) <= Date.parse(reading.ts)
      && (p.until === null || Date.parse(reading.ts) < Date.parse(p.until)))?.value;
    return owner === account ? [reading] : [];
  }).sort((a,b) => b.ts.localeCompare(a.ts))[0]?.used_percent;
  for (const account of ["a", "b", "c"]) expect(limit(db, account)?.used_percent).toBe(reference(account));
});

test("ordinary winner deletion seeks a predecessor without an account-source fold", () => {
  for (const size of [100, 1000]) {
    const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
    for (let i = 0; i < size; i++) row(db, "PC", "stale", new Date(Date.parse("2026-09-05T10:00:00Z") + i * 1000).toISOString(), i % 100);
    const winner = row(db, "PC", "stale", "2026-09-05T11:00:00.000Z", 99);
    settle(db);
    const folded = counter(db, "fold_rows"), repaired = counter(db, "repairs");
    db.query("DELETE FROM probe_windows WHERE id=?").run(winner);
    settle(db);
    expect(limit(db, "a")?.used_percent).toBe((size - 1) % 100);
    expect(counter(db, "fold_rows") - folded).toBe(0);
    expect(counter(db, "repairs") - repaired).toBe(1);
  }
});

test("changing a losing historical probe keeps the published account bytes and generation", () => {
  const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  const older = row(db, "PC", "stale", "2026-09-05T10:00:00.000Z", 10);
  row(db, "PC", "stale", "2026-09-05T11:00:00.000Z", 80);
  settle(db);
  const before = db.query("SELECT data,generated_at FROM current_probe_subjects WHERE provider='codex' AND subject='a'").get();
  const generation = projectionState(db)!.generation;
  db.query("UPDATE probe_windows SET used_percent=15 WHERE id=?").run(older);
  linkRow(db, older);
  settle(db);
  expect(db.query("SELECT data,generated_at FROM current_probe_subjects WHERE provider='codex' AND subject='a'").get()).toEqual(before);
  expect(projectionState(db)!.generation).toBe(generation);
});

test("period corrections honor half-open bounds, gaps and indexed predecessor repair", () => {
  const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  row(db, "PC", "stale", "2026-09-05T10:00:00.000Z", 10);
  row(db, "PC", "stale", "2026-09-05T10:00:01.000Z", 20);
  row(db, "PC", "stale", "2026-09-05T10:00:02.000Z", 30);
  settle(db, declarations, 1);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a", undefined, "2026-09-05T10:00:02.000Z"),
    period(source, "b", "2026-09-05T10:00:02.000Z", "2026-09-05T10:00:03.000Z"),
    period(source, "a", "2026-09-05T10:00:03.000Z")]);
  settle(db, declarations, 1);
  expect(limit(db, "a")?.used_percent).toBe(20);
  expect(limit(db, "b")?.used_percent).toBe(30);
  expect(counter(db, "repairs")).toBeGreaterThan(0);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a", undefined, "2026-09-05T10:00:01.000Z"),
    period(source, "b", "2026-09-05T10:00:02.000Z", "2026-09-05T10:00:03.000Z")]);
  settle(db, declarations, 1);
  expect(limit(db, "a")?.used_percent).toBe(10);
  expect(limit(db, "b")?.used_percent).toBe(30);
});

test("unrelated readings publish during a resumed A/C correction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-current-correction-")); directories.push(dir);
  const file = path.join(dir, "atlas.sqlite"), db = database(file);
  const source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a"), period(`codex/laptop-${LOGIN}`.toLowerCase(), "b")]);
  for (let i = 0; i < 40; i++) row(db, "PC", "stale", new Date(Date.parse("2026-09-05T10:00:00Z") + i * 1000).toISOString(), i);
  row(db, "LAPTOP", "stale", "2026-09-05T10:30:00.000Z", 50);
  settle(db, declarations, 2);
  const oldA = published(db, "a");
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "c"), period(`codex/laptop-${LOGIN}`.toLowerCase(), "b")]);
  run(db, declarations, 2);
  for (let i = 0; i < 3; i++) {
    const added = row(db, "LAPTOP", "stale", new Date(Date.parse("2026-09-05T10:31:00Z") + i * 1000).toISOString(), 60 + i);
    run(db, declarations, 2);
    expect(limit(db, "b")?.used_percent).toBe(60 + i);
    expect(published(db, "a")).toBe(oldA);
    if (i === 1) {
      db.query("UPDATE probe_windows SET used_percent=77 WHERE id=?").run(added);
      linkRow(db, added);
      for (let attempt = 0; attempt < 5 && limit(db, "b")?.used_percent !== 77; attempt++) run(db, declarations, 2);
      expect(limit(db, "b")?.used_percent).toBe(77);
      expect(published(db, "a")).toBe(oldA);
    }
  }
  db.close(); opened.splice(opened.indexOf(db), 1);
  const restarted = new Database(file); opened.push(restarted);
  settle(restarted, declarations, 2);
  expect(limit(restarted, "a")).toBeUndefined();
  expect(limit(restarted, "c")?.used_percent).toBe(39);
  expect(limit(restarted, "b")?.used_percent).toBe(62);
});

test("moving error and future probes updates both accounts' derived status", () => {
  const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  row(db, "PC", "stale", "2026-09-05T10:00:00.000Z", 0, HOME, "error");
  row(db, "PC", "stale", "2026-09-05T13:00:00.000Z", 30);
  settle(db, declarations, 1);
  expect(snapshot(db).data.subscriptions.find(s => s.id === "a")?.latest_error?.code).toBe("probe-failed");
  expect(snapshot(db).data.subscriptions.find(s => s.id === "a")?.clock_warning).toBe(true);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "b")]);
  settle(db, declarations, 1);
  const a = snapshot(db).data.subscriptions.find(s => s.id === "a")!;
  const b = snapshot(db).data.subscriptions.find(s => s.id === "b")!;
  expect(a.latest_error).toBeNull();
  expect(a.clock_warning).toBe(false);
  expect(a.limits).toEqual([]);
  expect(b.latest_error?.code).toBe("probe-failed");
  expect(b.clock_warning).toBe(true);
});

test("a probe arriving on the correcting source keeps the durable interval cursor", () => {
  const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  for (let i = 0; i < 30; i++) row(db, "PC", "stale", new Date(Date.parse("2026-09-05T10:00:00Z") + i * 1000).toISOString(), i);
  settle(db, declarations, 2);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "c")]);
  run(db, declarations, 2);
  const cursor = () => {
    const value = (db.query("SELECT value FROM meta WHERE key='current_v2_period_deltas'").get() as { value: string }).value;
    return (JSON.parse(value) as Array<{ cursor: string | null }>)[0]!.cursor;
  };
  const before = cursor();
  row(db, "PC", "stale", "2026-09-05T11:00:00.000Z", 95);
  run(db, declarations, 2);
  expect(cursor()! >= before!).toBe(true);
  settle(db, declarations, 2);
  expect(limit(db, "c")?.used_percent).toBe(95);
  expect(limit(db, "a")).toBeUndefined();
});

test("a second period edit retains a scanned but unpublished first correction", () => {
  const db = database(), pc = `codex/pc-${LOGIN}`.toLowerCase(), laptop = `codex/laptop-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "a"), period(laptop, "b")]);
  row(db, "PC", "stale", "2026-09-05T10:00:00.000Z", 40);
  row(db, "LAPTOP", "stale", "2026-09-05T11:00:00.000Z", 50);
  settle(db);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "b"), period(laptop, "b")]);
  run(db, declarations, 1);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "b"), period(laptop, "c")]);
  settle(db);
  expect(limit(db, "a")).toBeUndefined();
  expect(limit(db, "b")?.used_percent).toBe(40);
  expect(limit(db, "c")?.used_percent).toBe(50);
});

test("invalid timestamps stay unassigned and the 128-key cap includes future-only keys", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/pc-${LOGIN}`.toLowerCase(), "a")]);
  row(db, "PC", "bad", "not-a-time", 99);
  for (let i = 0; i < 129; i++) row(db, "PC", `stamp-${i}`, "2026-09-05T13:00:00.000Z", i, HOME, `kind-${String(i).padStart(3, "0")}`);
  row(db, "PC", "now", "2026-09-05T11:00:00.000Z", 42, HOME, "zz-current");
  settle(db, declarations, 32);
  const sub = snapshot(db).data.subscriptions.find(s => s.id === "a")!;
  expect(sub.limits_truncated).toBe(true);
  expect(sub.limits).toEqual([]);
  expect(sub.clock_warning).toBe(true);
});

test("availability preserves zero quota evidence through correction and deletion, reading by index", () => {
  const db = database(), source = `codex/pc-${LOGIN}`.toLowerCase();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "a")]);
  const id = row(db, "PC", "stale-target", undefined, 0, HOME, "quota");
  db.query("UPDATE probe_windows SET used_percent=NULL,allowance=0 WHERE id=?").run(id);
  linkRow(db, id);
  const invalid = row(db, "PC", "stale-target", "2026-09-05T11:01:00.000Z", 20, HOME, "invalid");
  db.query("UPDATE probe_windows SET ok=2 WHERE id=?").run(invalid); linkRow(db, invalid);
  settle(db);
  expect(hasPreparedProbeAvailability(db, "codex", "a")).toBe(true);
  expect(readPreparedProbeCoverage(db, "codex", "a")?.samples).toBe(0);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(source, "c")]);
  settle(db);
  expect(hasPreparedProbeAvailability(db, "codex", "a")).toBe(false);
  expect(hasPreparedProbeAvailability(db, "codex", "c")).toBe(true);
  db.query("DELETE FROM probe_windows WHERE id=?").run(id); settle(db);
  expect(hasPreparedProbeAvailability(db, "codex", "c")).toBe(false);
  const traced = new Proxy(db, { get(target, property) {
    if (property === "query") return (sql: string) => {
      if (/\bprobe_windows\b/i.test(sql) && !/\bprobe_sources\b/i.test(sql)) throw new Error("availability scanned raw probes");
      return target.query(sql);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  expect(hasPreparedProbeAvailability(traced, "codex", "c")).toBe(false);
});

test("correcting a captured probe keeps its projection id and both immutable facts without dangling account keys", () => {
  const db = database();
  configureGaugeJournal(null);
  const sources = [{ id: "a", vendor: "codex", machine: MACHINE, source_home: HOME,
    home: `${ARCHIVE_LOGICAL_ROOT}/codex/${MACHINE}-${LOGIN}` }];
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/${MACHINE}-${LOGIN}`.toLowerCase(), "a")]);
  const reading: WindowReading = { kind: "primary", group: "codex", scope: null, plan: "plus",
    reportedPercentSide: "used", usedPercent: 40, vendorPercent: 40, remainingPercent: null,
    windowMinutes: 300, allowance: null, used: null, remaining: null, resetsAt: null,
    rateLimitReached: false, resetCredits: null, profile: LOGIN, ok: true, error: null, extra: { home: HOME } };
  persistProbeWindows(db, "codex", "captured-target", NOW, [reading]); settle(db, sources);
  const prior = (db.query("SELECT id FROM probe_windows").get() as { id: number }).id;
  const originals = db.query("SELECT id,payload,payload_digest FROM probe_counters").all();
  persistProbeWindows(db, "codex", "captured-target", NOW, [{ ...reading, usedPercent: 66, vendorPercent: 66 }]);
  settle(db, sources);
  expect(db.query("SELECT id,used_percent FROM probe_windows").all()).toEqual([{ id: prior, used_percent: 66 }]);
  expect(preparedProbeAccountIndexReady(db, "codex", "a")).toBe(true);
  expect(readPreparedProbeAccountRows(db, "codex", "a", { index: "resolved", limit: 10 })?.rows.map(r => r.id))
    .toEqual([prior]);
  expect(readPreparedProbeCoverage(db, "codex", "a")?.samples).toBe(1);
  expect(db.query("SELECT id,payload,payload_digest FROM probe_counters").all()).toEqual(expect.arrayContaining(originals));
  expect(db.query("SELECT COUNT(*) n FROM probe_counters").get()).toEqual({ n: 2 });
});

test("a whole-history refold queues only accounts and republishes the same cards", () => {
  const db = database();
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(`codex/pc-${LOGIN}`.toLowerCase(), "a")]);
  for (let hour = 0; hour < 6; hour++) row(db, "PC", "stale", `2026-09-05T0${hour}:00:00.000Z`, 10 + hour);
  row(db, "LAPTOP", "b", "2026-09-05T07:00:00.000Z", 50);
  settle(db, declarations, 32);
  const before = published(db, "a");
  const registry = currentRegistry(split(declarations).subscriptions, NOW);
  db.exec("UPDATE current_projection_state SET config_fingerprint='',generated_at=NULL WHERE id=1");
  markAllCurrentAccountsDirty(db, registry);
  expect((db.query("SELECT subject FROM current_projection_dirty ORDER BY subject").all() as { subject: string }[])
    .map(r => r.subject)).toEqual(["a", "b", "c"]);
  expect(settle(db, declarations, 32)).toBeLessThan(20);
  expect(db.query("SELECT count(*) AS n FROM current_projection_dirty").get()).toEqual({ n: 0 });
  expect(published(db, "a")).toBe(before);
  expect(limit(db, "a")?.used_percent).toBe(15);
});

test("each account qualifier selects its readings by index, newest first, within a period range", () => {
  const db = database(), pc = `codex/pc-${LOGIN}`.toLowerCase();
  // The account owns PC readings only until 11:30; the later reading belongs to nobody.
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [period(pc, "a", undefined, "2026-09-05T11:30:00.000Z")]);
  const ok = row(db, "PC", "stale", "2026-09-05T10:00:00.000Z", 10);
  const failed = row(db, "PC", "stale", "2026-09-05T10:10:00.000Z", 20);
  db.query("UPDATE probe_windows SET ok=0 WHERE id=?").run(failed); linkRow(db, failed);
  const error = row(db, "PC", "stale", "2026-09-05T10:20:00.000Z", 0, HOME, "error");
  const latest = row(db, "PC", "stale", "2026-09-05T11:00:00.000Z", 30);
  row(db, "PC", "stale", "2026-09-05T11:40:00.000Z", 40);
  settle(db);
  const ids = (index: Parameters<typeof readPreparedProbeAccountRows>[3]["index"], extra: { machine?: string | null; timestamp?: string; limit?: number } = {}) =>
    readPreparedProbeAccountRows(db, "codex", "a", { index, limit: extra.limit ?? 10, ...extra })?.rows.map(reading => reading.id);
  expect(ids("all")).toEqual([latest, error, failed, ok]);
  expect(ids("all", { limit: 2 })).toEqual([latest, error]);
  expect(ids("success")).toEqual([latest, ok]);
  expect(ids("codex-success")).toEqual([latest, ok]);
  expect(ids("machine-ok", { machine: "PC" })).toEqual([latest, ok]);
  expect(ids("machine-error", { machine: "PC" })).toEqual([error, failed]);
  expect(ids("machine-ok", { machine: "LAPTOP" })).toEqual([]);
  expect(ids("resolved", { timestamp: "2026-09-05T10:00:00.000Z" })).toEqual([ok]);
  // Provider-specific qualifiers select nothing for another provider.
  expect(ids("grok-percent")).toEqual([]);
  expect(ids("glm-kind")).toEqual([]);
  expect(readPreparedProbeAccountRows(db, "codex", "nobody", { index: "all", limit: 10 })?.rows).toEqual([]);
});

test("a card whose account is read on an undeclared profile catches up once that profile is declared", () => {
  // codex2 is read on two computers; only MAIN's profile has an archive folder. MAIN stops, the laptop keeps reading.
  const db = database(), home2 = `C:/Users/${LOGIN}/.codex-2`;
  const subscriptions = [{ id: "codex1", vendor: "codex" }, { id: "codex2", vendor: "codex" }];
  const sources: SourceDeclaration[] = [
    { vendor: "codex", machine: "MAIN", home: `${ARCHIVE_LOGICAL_ROOT}/codex/MAIN-${LOGIN}`, source_home: HOME },
    { vendor: "codex", machine: "LAPTOP", home: `${ARCHIVE_LOGICAL_ROOT}/codex/LAPTOP-${LOGIN}`, source_home: HOME },
    { vendor: "codex", machine: "MAIN", home: `${ARCHIVE_LOGICAL_ROOT}/codex/MAIN-sample_b`, source_home: home2 }];
  const reading = (machine: string, home: string, account: string, ts: string, used: number) => {
    const id = Number(db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent,machine,profile,extra)
      VALUES('codex',?,?,'primary','used',?,?,?,?)`).run(account, ts, used, machine, LOGIN,
      JSON.stringify({ home, codex_account: JSON.stringify({ subscription: account, home, login: LOGIN, machine }) })).lastInsertRowid);
    linkRow(db, id, home);
  };
  const t1 = "2026-09-05T09:00:00.000Z", t2 = "2026-09-05T11:00:00.000Z";
  reading("MAIN", HOME, "codex1", t1, 10); reading("MAIN", home2, "codex2", t1, 20);
  reading("LAPTOP", HOME, "codex1", t1, 10); reading("LAPTOP", home2, "codex2", t1, 20);
  reading("LAPTOP", HOME, "codex1", t2, 11); reading("LAPTOP", home2, "codex2", t2, 25);
  // The background worker's two jobs: the account-period feed, then the current projection.
  const pass = (declared: SourceDeclaration[]) => {
    for (let turns = 0; !advanceAccountPeriods(db, { declarations: declared, archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN }).done;)
      if (++turns > 50) throw new Error("account periods did not settle");
    let work = 0;
    while (publishCurrentBatch(db, currentRegistry(subscriptions, NOW), NOW, 32, { subscriptions, sources: declared }))
      if (++work > 500) throw new Error("projection did not settle");
  };
  const newest = (account: string) =>
    (JSON.parse(published(db, account)!) as { limits: Array<{ measured_at: string; machine: string; used_percent: number }> }).limits[0];
  pass(sources);
  // The reported state: the laptop's codex2 readings map to no source, so the card keeps MAIN's last reading.
  expect(newest("codex1")).toMatchObject({ measured_at: t2, machine: "LAPTOP", used_percent: 11 });
  expect(newest("codex2")).toMatchObject({ measured_at: t1, machine: "MAIN", used_percent: 20 });
  const codex1 = published(db, "codex1");

  // Declaring the laptop profile maps its readings from the first one; no new reading is needed.
  const declared = [...sources,
    { vendor: "codex", machine: "LAPTOP", home: `${ARCHIVE_LOGICAL_ROOT}/codex/LAPTOP-${LOGIN}-codex-2`, source_home: home2 }];
  pass(declared);
  expect(newest("codex2")).toMatchObject({ measured_at: t2, machine: "LAPTOP", used_percent: 25 });
  expect(loadPeriods(db, ACCOUNT_PERIODS).filter(p => p.subject === `codex/laptop-${LOGIN}-codex-2`.toLowerCase())
    .map(p => [p.value, p.from, p.until])).toEqual([["codex2", t1, null]]);
  // The other account's card is not touched.
  expect(published(db, "codex1")).toBe(codex1);
});
