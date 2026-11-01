import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { createTestDatabase } from "../sync/test-support";
import { FirstFillPublication, hasUnfinishedFirstFills } from "../sync/first-fill";
import { undoStoppedFirstFills, undoStoppedFirstFillsAtStartup } from "./server-sync";
import { removeTestFixture } from "../test-cleanup";

const fixtures: string[] = [];
afterEach(() => { Bun.gc(true); for (const dir of fixtures.splice(0)) removeTestFixture(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

// TALK-001 D12 (REQ-064 AC2): Pause can stop a process between first-fill batches. What it published so far must
// not stay readable while paused: the fill is undone at once and the vendor's schema objects come back.
test("a first fill stopped between batches is undone before the import reads as paused", async () => {
  const f = createTestDatabase(); fixtures.push(f.directory);
  const db = new Database(f.dbPath);
  try {
    const schema = () => db.query("SELECT type,name FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='claude_events' ORDER BY type,name").all();
    const before = schema();
    expect(before.length).toBeGreaterThan(0);
    const transact = (work: () => void) => db.transaction(work).immediate();
    const fill = FirstFillPublication.begin(db, "claude", ["claude_events"], transact);
    // One batch committed, then the process is gone (no restore, no commit).
    fill.move(() => { db.exec("INSERT INTO claude_events(store,call_id,path,ts,model) VALUES('live','a','a.jsonl','2026-10-01T00:00:00Z','m')"); return true; });
    expect(db.query("SELECT count(*) AS n FROM claude_events").get()).toEqual({ n: 1 });
    expect(hasUnfinishedFirstFills(db)).toBe(true);

    expect(await undoStoppedFirstFills(db)).toEqual(["claude"]);
    expect(db.query("SELECT count(*) AS n FROM claude_events").get()).toEqual({ n: 0 });
    expect(hasUnfinishedFirstFills(db)).toBe(false);
    expect(schema()).toEqual(before);
    // Nothing left to undo: a second call is a no-op.
    expect(await undoStoppedFirstFills(db)).toEqual([]);
  } finally { db.close(); }
});

// The server stopped after Pause ended the importer but before that cleanup ran: the next start settles it.
test("a paused server's start undoes a first fill the previous server left half-published", () => {
  const f = createTestDatabase(); fixtures.push(f.directory);
  const db = new Database(f.dbPath);
  try {
    const transact = (work: () => void) => db.transaction(work).immediate();
    FirstFillPublication.begin(db, "claude", ["claude_events"], transact)
      .move(() => { db.exec("INSERT INTO claude_events(store,call_id,path,ts,model) VALUES('live','a','a.jsonl','2026-10-01T00:00:00Z','m')"); return true; });
    expect(undoStoppedFirstFillsAtStartup(db)).toEqual(["claude"]);
    expect(db.query("SELECT count(*) AS n FROM claude_events").get()).toEqual({ n: 0 });
    expect(hasUnfinishedFirstFills(db)).toBe(false);
  } finally { db.close(); }
});

// The same, end to end: a real server start of a paused installation settles the fill before it serves reads.
test("a restarted paused server leaves no half-published first fill readable", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { saveImportPaused } = await import("../sync/import-pause");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pause-restart-"));
  fixtures.push(root);
  for (const dir of ["config", "archive", "state", "profile/AppData/Roaming", "profile/AppData/Local"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
  const database = path.join(root, "atlas.sqlite");
  const start = async (confirm: boolean) => {
    const script = path.join(root, `start-${Math.random().toString(36).slice(2)}.ts`);
    fs.writeFileSync(script, `const { startServer } = await import(${JSON.stringify(path.join(import.meta.dir, "api.ts"))});
      const running = startServer(0, ${JSON.stringify(database)});
      if (${confirm}) await fetch("http://127.0.0.1:" + running.server.port + "/api/setup/confirm", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ limit_readings: false, cloud_import: false }) });
      await new Promise(resolve => setTimeout(resolve, 2000));
      running.close?.(); process.exit(0);`);
    const profile = path.join(root, "profile");
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe", env: { ...process.env,
      TOKENATLAS_CONFIG: path.join(root, "config"), TOKENATLAS_ARCHIVE: path.join(root, "archive"), TOKENATLAS_LOCAL_STATE: path.join(root, "state"),
      TOKENATLAS_SYNC_MINUTES: "0", TOKENATLAS_PROBE_MINUTES: "0", TOKENATLAS_GEMINI_MINUTES: "0", TOKENATLAS_CLOUD_MINUTES: "0",
      TOKENATLAS_CONFIRM_LOCATIONS: "", USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData", "Local"), CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", GROK_HOME: "", OneDrive: "" } });
    const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`server exited ${code}: ${stderr.slice(-2000)}`);
  };
  await start(true);
  const db = new Database(database);
  try {
    FirstFillPublication.begin(db, "claude", ["claude_events"], work => db.transaction(work).immediate())
      .move(() => { db.exec("INSERT INTO claude_events(store,call_id,path,ts,model) VALUES('live','a','a.jsonl','2026-10-01T00:00:00Z','m')"); return true; });
  } finally { db.close(); }
  saveImportPaused(true, path.join(root, "state"));
  await start(false);
  const after = new Database(database, { readonly: true });
  try {
    expect(after.query("SELECT count(*) AS n FROM claude_events").get()).toEqual({ n: 0 });
    expect(hasUnfinishedFirstFills(after)).toBe(false);
  } finally { after.close(); }
}, 120_000);
