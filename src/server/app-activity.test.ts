import { expect, test, spyOn } from "bun:test";
import { Database } from "../db/sqlite";
import { ensureUsageLedgerSchema } from "../db/usage-ledger";
import { handleAppActivity, readAppActivity } from "./app-activity";
import type { ActivityIssueReason } from "../shared/app-activity";
import { ProgressRegistry, progressDirectory } from "../sync/progress";
import { createFetchHandler, type AppContext } from "./api";
import { DATA_VIEWS, DIRECT_DATA_ROUTES } from "./data-views";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fixture(file = ":memory:") {
  const db = new Database(file);
  ensureUsageLedgerSchema(db);
  db.exec(`CREATE TABLE fact_day_revisions(source TEXT,day TEXT,revision INTEGER,PRIMARY KEY(source,day));`);
  return db;
}
/** One usage ledger state row; the status bar reads Claude/Gemini/Grok/GLM from it. */
function ledger(db: Database, provider: string, phase: string, status: string, covered: number, bookmark: string) {
  db.query("INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest) VALUES(?,1,?,?,?,?,'rules')")
    .run(provider, phase, status, covered, bookmark);
}
/** The source table's change revision (fact-day-revisions.ts) a ledger compares with what it covers. */
const sourceRevision = (db: Database, table: string, revision: number) =>
  db.query("INSERT OR REPLACE INTO fact_day_revisions(source,day,revision) VALUES(?,'*',?)").run(table, revision);
const claude = (activity: ReturnType<typeof readAppActivity>) => activity.providers.find(provider => provider.provider === "claude")!;

test("WAL activity reads stay responsive during an uncommitted writer and observe later commits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-activity-wal-"));
  const file = path.join(root, "fixture.sqlite");
  const writer = fixture(file);
  let reader: Database | undefined;
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    ledger(writer, "claude", "backfill", "pending", 1, "10");
    reader = new Database(file, { readonly: true });
    reader.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000");
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("UPDATE usage_ledger_state SET bookmark='20'");
    const start = performance.now();
    const duringWrite = readAppActivity(reader, 1000);
    const elapsed = performance.now() - start;
    expect(duringWrite.unavailable).toBe(false);
    expect(claude(duringWrite).register.checkpoint).toBe(10);
    // Well below the configured lock wait: this read must use the committed WAL snapshot.
    expect(elapsed).toBeLessThan(500);
    expect(writer.inTransaction).toBe(true);
    writer.exec("ROLLBACK");
    expect(claude(readAppActivity(reader, 2000)).register.checkpoint).toBe(10);
    writer.exec("BEGIN IMMEDIATE; UPDATE usage_ledger_state SET bookmark='30'; COMMIT");
    const published = readAppActivity(reader, 3000);
    expect(claude(published).register).toMatchObject({checkpoint:30,lastProgressAt:3000});
    expect((reader.query("PRAGMA query_only").get() as {query_only:number}).query_only).toBe(1);
    expect((reader.query("SELECT total_changes() AS changes").get() as {changes:number}).changes).toBe(0);
  } finally {
    if (writer.inTransaction) writer.exec("ROLLBACK");
    reader?.close();
    writer.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
    fs.rmdirSync(root);
  }
});
test("activity reads bounded metadata on a query-only database without data history or preparation", async () => {
  const db = fixture();
  ledger(db, "claude", "backfill", "pending", 19, "900001");
  db.exec("PRAGMA query_only=ON");
  const queries: string[] = [], original = db.query.bind(db);
  const query = spyOn(db, "query").mockImplementation(sql => { queries.push(sql); return original(sql); });
  try {
    const response = handleAppActivity(db);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.providers[1].register).toMatchObject({ state: "backfill", checkpoint: 900001, cursor: 19, etaMs: null, lastProgressAt: null });
    expect(body.unavailable).toBe(false);
    expect(queries.every(sql => /^SELECT /.test(sql))).toBe(true);
    expect(queries.join(" ")).not.toMatch(/\b(events|usage_ledger_facts|usage_ledger_days|usage_ledger_dirty|COUNT)\b/i);
    expect(queries.length).toBeLessThan(25);
  } finally { query.mockRestore(); db.close(); }
});
test("opaque ledger bookmarks are honest and never disclosed", () => {
  const db = fixture();
  try {
    ledger(db, "claude", "backfill", "pending", 3, "120");
    ledger(db, "gemini", "reconcile", "ready", 1, "secret/path");
    sourceRevision(db, "gemini_events", 1);
    const first = readAppActivity(db, 1000);
    expect(claude(first).facts).toMatchObject({state:"backfill", checkpoint:120});
    expect(first.providers.find(provider => provider.provider === "gemini")!.register)
      .toMatchObject({state:"ready", version:1, checkpoint:null, lastProgressAt:null});
    expect(JSON.stringify(first)).not.toContain("secret");
  } finally { db.close(); }
});
test("progress records only observed changes and a new process observation starts unknown", () => {
  const db = fixture();
  try {
    ledger(db, "claude", "backfill", "pending", 1, "10");
    expect(claude(readAppActivity(db, 100)).register.lastProgressAt).toBeNull();
    expect(claude(readAppActivity(db, 200)).register.lastProgressAt).toBeNull();
    db.exec("UPDATE usage_ledger_state SET bookmark='20'");
    expect(claude(readAppActivity(db, 300)).register.lastProgressAt).toBe(300);
    expect(claude(readAppActivity(db, 400)).register.lastProgressAt).toBe(300);
    const fresh = fixture();
    try {
      ledger(fresh, "claude", "backfill", "pending", 1, "20");
      const restarted = readAppActivity(fresh, 500);
      expect(restarted.observationStartedAt).toBe(500);
      expect(claude(restarted).register.lastProgressAt).toBeNull();
    } finally { fresh.close(); }
  } finally { db.close(); }
});
test("report counts are bounded, grouped and never disclose parameters", () => {
  const db = fixture();
  try {
    const report = readAppActivity(db, Date.now(), [
      { path: "/api/roster", failed: false },
      { path: "/api/project-cost", failed: true, reason: "preparation-failed" },
    ]);
    expect(report.reports).toMatchObject({pending:1,failed:1,truncated:false});
    expect(report.reports.views).toContainEqual({view:"subscriptions",pending:1,failed:0});
    expect(report.busy).toBe(true);
    const many = Array.from({ length: 300 }, () => ({ path: "/api/usage-series", failed: false }));
    const bounded = readAppActivity(db, Date.now(), many).reports;
    expect(bounded.truncated).toBe(true);
    expect(bounded.pending + bounded.failed).toBe(256);
  } finally { db.close(); }
});
test("failure categories explain pending views", () => {
  const db = fixture();
  try {
    db.exec("PRAGMA query_only=ON");
    const failed = (reason: ActivityIssueReason) => ({ path: "/api/windows", failed: true, reason });
    const report = readAppActivity(db, Date.now(), [failed("account-unavailable"), failed("account-unavailable"), failed("database-busy"),
      failed("database-busy"), failed("invalid-request"), failed("preparation-failed"), failed("preparation-failed"), { path: "/api/windows", failed: false }]);
    expect(report.unavailable).toBe(false);
    expect(report.reports.views).toEqual([{view:"overview",pending:1,failed:7,issues:[
      {reason:"account-unavailable",count:2},
      {reason:"database-busy",count:2},
      {reason:"preparation-failed",count:2},
      {reason:"invalid-request",count:1},
    ]}]);
  } finally { db.close(); }
});

test("an unfinished ledger reconciliation is reported and metadata failures are unavailable", () => {
  const db = fixture();
  try {
    ledger(db, "claude", "reconcile", "pending", 1, "");
    expect(claude(readAppActivity(db)).register.state).toBe("replay");
    db.exec("ALTER TABLE usage_ledger_state RENAME COLUMN covered TO incompatible");
    const failed = readAppActivity(db);
    expect(failed.unavailable).toBe(true);
    expect(failed.providers.every(provider => provider.register.state === "unavailable")).toBe(true);
  } finally { db.close(); }
});

test("dedicated activity endpoint bypasses analytical preparation and preserves historical activity", async () => {
  const db = fixture();
  try {
    const ctx = { sqlite: db, homeConflict: { message: "private conflict" }, databaseRelocating: true } as AppContext;
    const fetch = createFetchHandler(ctx);
    db.exec("PRAGMA query_only=ON");
    const response = await fetch(new Request("http://local/api/app-activity"));
    expect(response.status).toBe(200);
    expect((await response.json()).providers).toHaveLength(5);
    expect(DATA_VIEWS["/api/activity"]).toBeDefined();
    expect(DATA_VIEWS["/api/app-activity"]).toBeUndefined();
    expect(DIRECT_DATA_ROUTES["/api/app-activity"]).toBeDefined();
  } finally { db.close(); }
});

test("a source change revision past the ledger's reveals queued corrections with one key lookup", () => {
  const db = fixture();
  try {
    sourceRevision(db, "claude_events", 50);
    ledger(db, "claude", "reconcile", "ready", 40, "");
    db.exec("PRAGMA query_only=ON");
    const result = readAppActivity(db);
    expect(claude(result).register.state).toBe("replay");
    expect(claude(result).facts!.state).toBe("replay");
    expect(result.busy).toBe(true);
    const plan = db.query("EXPLAIN QUERY PLAN SELECT revision FROM fact_day_revisions WHERE source=? AND day='*'").all("claude_events");
    expect(JSON.stringify(plan)).not.toContain("SCAN");
    // Once the ledger covers the source's revision both stages are ready and nothing is busy.
    db.exec("PRAGMA query_only=OFF; UPDATE usage_ledger_state SET covered=50");
    const caughtUp = readAppActivity(db);
    expect(claude(caughtUp).register.state).toBe("ready");
    expect(claude(caughtUp).facts!.state).toBe("ready");
    expect(caughtUp.busy).toBe(false);
  } finally { db.close(); }
});

test("the Codex price ledger reports its state; its counters come from the progress register", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ta-activity-progress-"));
  const db = fixture(path.join(directory, "atlas.sqlite"));
  try {
    ensureUsageLedgerSchema(db);
    db.exec(`CREATE TABLE codex_file_evidence(home TEXT,path TEXT);
      INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest,revision) VALUES('codex',1,'reconcile','pending',0,'','r',10);
      INSERT INTO codex_file_evidence VALUES('h','a'),('h','b'),('h','c'),('h','d');
      INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','copy','["h","a"]'),('codex','copy','["h","b"]'),('codex','rules','{}')`);
    const building = readAppActivity(db, 1000).providers.find(provider => provider.provider === "codex")!;
    expect(building.register.state).toBe("backfill");
    db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind='copy'");
    const rules = readAppActivity(db, 1500).providers.find(provider => provider.provider === "codex")!.register;
    expect(rules.state).toBe("backfill");
    db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex'; UPDATE usage_ledger_state SET status='ready' WHERE provider='codex'");
    const ready = readAppActivity(db, 2000);
    const done = ready.providers.find(provider => provider.provider === "codex")!.register;
    expect(done.state).toBe("ready");
    expect(ready.busy).toBe(false);
    // A producer's register entry is part of the activity and keeps it busy.
    const register = new ProgressRegistry(progressDirectory(db.filename));
    try {
      register.step("codex-ledger", "copies", "Choosing source copies", "files", 4, 2);
      const reported = readAppActivity(db, 2500);
      expect(reported.progress.map(({ scope, step, done, total, unit }) => ({ scope, step, done, total, unit })))
        .toEqual([{ scope: "codex-ledger", step: "copies", done: 2, total: 4, unit: "files" }]);
      expect(reported.busy).toBe(true);
    } finally { register.end("codex-ledger"); }
    expect(readAppActivity(db, 3000).progress).toEqual([]);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
