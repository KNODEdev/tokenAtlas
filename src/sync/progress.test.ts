import { afterAll, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BacklogProgress, ProgressRegistry, progressDirectory, readProgress } from "./progress";
import { reportBackgroundProgress } from "../server/background-progress";
import { createCodexLedgerSchema } from "../db/codex-price-ledger";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { USAGE_LEDGER_VERSION } from "../db/usage-ledger";
import { removeTestFixture } from "../test-cleanup";
import { SyncCoordinator } from "./coordinator";
import { SyncStore } from "./store";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";
import { ResponseCache, readingsRevision } from "../server/cache";

const directories: string[] = [];
afterAll(() => {
  Bun.gc(true);
  for (const directory of directories) {
    try { removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch (error) {
      // Bun may retain a Windows SQLite handle until process teardown.
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
    }
  }
});

test("running phases remain readable after all vendors finish and gauges precede history", async () => {
  const { directory, dbPath } = createTestDatabase();
  directories.push(directory);
  const reader = new Database(dbPath);
  const store = new SyncStore(reader);
  const phases: string[] = [];
  const vendors: string[] = [];
  const snapshot = () => {
    const run = store.activeRun()!;
    expect(run.status).toBe("running");
    expect(run.progress!.completed).toBeLessThan(run.progress!.total);
    phases.push(run.progress!.phase);
  };
  const coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(),
    configFingerprint: () => "progress-fixture", sourceFingerprint: () => "changed",
    mirror: async vendor => { vendors.push(vendor); snapshot(); return noMirror(); },
    adapters: adaptersWith({ codex: async () => { snapshot(); return successfulNoop(); } }),
    prepareStage: () => {}, refreshDerived: (_db, result, _domains, _affected, progress) => {
      expect(result.vendors.every(vendor => vendor.status === "success")).toBe(true);
      for (const phase of ["attribution", "projects"] as const) { progress(phase); snapshot(); }
    },
  });
  try {
    const result = await coordinator.enter({ trigger: "manual", mode: "incremental", scope: { kind: "all" } }).completion;
    expect(vendors[0]).toBe("gauges");
    expect(phases).toContain("mirror");
    expect(phases).toContain("ingest");
    expect(phases.slice(-2)).toEqual(["attribution", "projects"]);
    expect(result.status).toBe("success");
    expect(result.progress!.completed).toBe(result.progress!.total);
  } finally { coordinator.close(); reader.close(true); }
});

test("probe changes invalidate live responses while the history cache remains frozen", () => {
  const { directory, dbPath } = createTestDatabase();
  directories.push(directory);
  const db = new Database(dbPath);
  const cache = new ResponseCache();
  try {
    const revision = readingsRevision(db)!;
    const history = cache.stamp(db);
    const live = cache.clockStamp(db, 0);
    const coordinator = new SyncStore(db);
    coordinator.saveRun({ runId: "running", trigger: "manual", mode: "incremental", scope: { kind: "all" },
      status: "running", startedAt: new Date().toISOString(), finishedAt: null,
      beforeRevisions: coordinator.revisions(), afterRevisions: coordinator.revisions(),
      aggregateWorkRequested: false, vendors: [], error: null });
    db.exec("INSERT INTO probe_windows(provider,subject,ts,kind,used_percent,reported_percent_side) VALUES ('codex','fixture','2026-09-11T12:00:00Z','primary',42,'used')");
    expect(readingsRevision(db)).toBeGreaterThan(revision);
    expect(cache.stamp(db)).toBe(history);
    expect(cache.clockStamp(db, 0)).not.toBe(live);
  } finally { db.close(true); }
});

const registerFolders: string[] = [];
afterAll(() => { for (const folder of registerFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function registerFolder(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ta-progress-"));
  registerFolders.push(directory);
  return path.join(directory, "progress");
}
const brief = (directory: string) => readProgress(directory).map(({ scope, step, done, total, unit }) => ({ scope, step, done, total, unit }));

test("register: one entry per scope; a new step replaces the old one, counters move and end removes the entry", async () => {
  const directory = registerFolder(), register = new ProgressRegistry(directory);
  register.step("sync:codex", "copy", "Copying originals", "files", 10);
  register.step("sync:claude", "parse", "Reading files", "files", null);
  expect(brief(directory)).toEqual([
    { scope: "sync:claude", step: "parse", done: 0, total: null, unit: "files" },
    { scope: "sync:codex", step: "copy", done: 0, total: 10, unit: "files" },
  ]);
  register.advance("sync:codex", 3);
  // Within the write interval a counter is held back, then written when the interval ends.
  expect(brief(directory)[1]!.done).toBe(0);
  await Bun.sleep(300);
  expect(brief(directory)[1]!.done).toBe(3);
  register.advance("sync:codex", 10);
  expect(brief(directory)[1]!.done).toBe(10);
  register.report("sync:codex", "parse", "Reading files", "files", 1, 4);
  expect(brief(directory)[1]).toEqual({ scope: "sync:codex", step: "parse", done: 1, total: 4, unit: "files" });
  register.end("sync:codex");
  register.end("sync:claude");
  expect(readProgress(directory)).toEqual([]);
});

test("register: readers skip exited owners and torn files; endAll leaves other live owners alone", () => {
  const directory = registerFolder(), register = new ProgressRegistry(directory);
  register.step("limit-windows", "windows", "dividing limit windows", "accounts", 5);
  const write = (scope: string, pid: number) => fs.writeFileSync(path.join(directory, `${encodeURIComponent(scope).replaceAll("%", "~")}.json`),
    JSON.stringify({ scope, step: "parse", label: "Reading files", done: 1, total: 2, unit: "files",
      startedAt: "2026-10-04T10:00:00Z", updatedAt: "2026-10-04T10:00:00Z", pid }));
  write("sync:codex", 999_999_999);
  write("sync:gemini", process.ppid);
  fs.writeFileSync(path.join(directory, "sync~3Agrok.json"), "{\"scope\":");
  expect(brief(directory).map(entry => entry.scope)).toEqual(["limit-windows", "sync:gemini"]);
  register.endAll("sync");
  // The exited owner's leftover is removed; the live parent's entry is not this registry's to end.
  expect(fs.existsSync(path.join(directory, "sync~3Acodex.json"))).toBe(false);
  expect(brief(directory).map(entry => entry.scope)).toEqual(["limit-windows", "sync:gemini"]);
  register.end("limit-windows");
  expect(progressDirectory(":memory:")).toBeNull();
  expect(readProgress(null)).toEqual([]);
});

test("register: a backlog's first size is the total, what left the queue is done, growth raises the total", () => {
  const directory = registerFolder(), register = new ProgressRegistry(directory), backlog = new BacklogProgress(register);
  backlog.report("account-periods", "feed", "reading limit readings", "readings", 100);
  backlog.report("account-periods", "feed", "reading limit readings", "readings", 40);
  expect(register.entries().map(({ done, total }) => ({ done, total }))).toEqual([{ done: 60, total: 100 }]);
  backlog.report("account-periods", "feed", "reading limit readings", "readings", 130);
  expect(register.entries().map(({ done, total }) => ({ done, total }))).toEqual([{ done: 0, total: 130 }]);
  backlog.report("account-periods", "feed", "reading limit readings", "readings", 0);
  expect(register.entries()).toEqual([]);
  expect(readProgress(directory)).toEqual([]);
});

test("register: background producers report their queues (periods, a Codex fill by phase, Codex files, Codex sums, window sums)", () => {
  const directory = registerFolder();
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const db = new Database(path.join(path.dirname(directory), "atlas.sqlite"));
  const register = new ProgressRegistry(progressDirectory(db.filename)), backlog = new BacklogProgress(register);
  try {
    db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE probe_windows(id INTEGER PRIMARY KEY);
      INSERT INTO probe_windows(id) VALUES(1),(2),(3),(4);
      INSERT INTO meta VALUES('account_periods_probe_cursor','1')`);
    createCodexLedgerSchema(db);
    // A fill from empty reports its phases, each with what it has done of what it knows.
    db.exec(`INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest)
        VALUES('codex',1,'backfill','pending',0,'{"phase":"events","cursor":"1"}','r');
      INSERT INTO codex_price_ledger_copies(id,identity,locator) VALUES(1,'a','["h","a"]'),(2,'b','["h","b"]'),(3,'c','["h","c"]')`);
    const codex = () => register.entries().filter(entry => entry.scope === "codex-ledger").map(({ step, done, total, unit }) => ({ step, done, total, unit }));
    reportBackgroundProgress(db, register, backlog);
    expect(codex()).toEqual([{ step: "fill.events", done: 1, total: 3, unit: "files" }]);
    db.exec("INSERT INTO codex_price_ledger_events(id,copy_id,source_offset,dim_id,ts,day,admitted,reported,uncached,cached,writes,output,reasoning,window_input,window_cached,window_output,invalid_tokens) VALUES(7,1,0,1,'t','2026-01-01',1,0,0,0,0,0,0,0,0,0,0); UPDATE usage_ledger_state SET bookmark='{\"phase\":\"canonical\",\"cursor\":\"2\"}' WHERE provider='codex'");
    reportBackgroundProgress(db, register, backlog);
    expect(codex()).toEqual([{ step: "fill.canonical", done: 2, total: 7, unit: "records" }]);
    db.exec("DELETE FROM codex_price_ledger_events");
    db.exec("UPDATE usage_ledger_state SET phase='reconcile',bookmark='' WHERE provider='codex'");
    db.exec(`INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','copy','["h","a"]'),('codex','copy','["h","b"]'),('codex','rules','{}')`);
    reportBackgroundProgress(db, register, backlog);
    expect(brief(directory)).toEqual([
      { scope: "account-periods", step: "feed", done: 0, total: 3, unit: "readings" },
      { scope: "codex-ledger", step: "copies", done: 0, total: 2, unit: "files" },
    ]);
    db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND value='[\"h\",\"a\"]'; UPDATE meta SET value='4'");
    reportBackgroundProgress(db, register, backlog);
    // Counters inside the write interval are visible in the registry at once, on disk when it ends.
    const owned = () => register.entries().map(({ scope, step, done, total, unit }) => ({ scope, step, done, total, unit }));
    expect(owned()).toEqual([{ scope: "codex-ledger", step: "copies", done: 1, total: 2, unit: "files" }]);
    db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind='copy'");
    reportBackgroundProgress(db, register, backlog);
    expect(brief(directory)).toEqual([{ scope: "codex-ledger", step: "aggregates", done: 0, total: 1, unit: "items" }]);
    expect(owned()).toEqual(brief(directory));
    // Window sums: windows whose sums are current, of all stored windows.
    db.exec(`CREATE TABLE limit_windows(provider TEXT,account TEXT,counter TEXT,window_id TEXT);
      CREATE TABLE window_usage(provider TEXT,account TEXT,counter TEXT,window_id TEXT);
      CREATE TABLE window_usage_pending(provider TEXT,account TEXT,counter TEXT,window_id TEXT);
      INSERT INTO limit_windows VALUES('codex','a','primary','w1'),('codex','a','primary','w2');
      INSERT INTO window_usage VALUES('codex','a','primary','w1')`);
    reportBackgroundProgress(db, register, backlog);
    expect(owned().filter(entry => entry.scope === "window-usage")).toEqual([{ scope: "window-usage", step: "sums", done: 1, total: 2, unit: "items" }]);
    db.exec("INSERT INTO window_usage VALUES('codex','a','primary','w2')");
    reportBackgroundProgress(db, register, backlog);
    expect(owned().filter(entry => entry.scope === "window-usage")).toEqual([]);
    // Queued activity work (gaps of sessions or copies, activity sums of days) keeps both ledgers' entries open.
    db.exec(`DELETE FROM usage_ledger_dirty WHERE provider='codex';
      INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','session','1'),('codex','activity','2026-01-01')`);
    reportBackgroundProgress(db, register, backlog);
    expect(owned().filter(entry => entry.scope === "codex-ledger")).toEqual([{ scope: "codex-ledger", step: "aggregates", done: 0, total: 2, unit: "items" }]);
    db.exec(`CREATE TABLE claude_events(id INTEGER PRIMARY KEY, ts TEXT);
      INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest) VALUES('claude',${USAGE_LEDGER_VERSION},'reconcile','ready',0,'','r');
      INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('claude','session','s1'),('claude','session','s2'),('claude','activity','2026-01-01')`);
    installFactDayRevisions(db);
    reportBackgroundProgress(db, register, backlog);
    expect(owned().filter(entry => entry.scope === "usage-ledger:claude")).toEqual([{ scope: "usage-ledger:claude", step: "activity", done: 0, total: 3, unit: "items" }]);
  } finally { register.endAll("codex-ledger"); db.close(); }
});

