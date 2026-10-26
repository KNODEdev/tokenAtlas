import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { remap } from "./remap";
import { removeTestFixture } from "../test-cleanup";

// The repository remap reads its inputs under the writer it writes them with (`BEGIN IMMEDIATE`): a deferred
// transaction's read snapshot can go stale when another connection commits first, and its write then fails.
test("repository remap takes the WAL writer before its reads", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-remap-wal-"));
  const dbPath = path.join(directory, "atlas.sqlite");
  const db = new Database(dbPath), other = new Database(dbPath);
  const transaction = db.transaction.bind(db), modes: string[] = [];
  const spy = spyOn(db, "transaction").mockImplementation(callback => {
    const run = transaction(callback);
    return Object.assign((...args: Parameters<typeof run>) => { modes.push("default"); return run(...args); }, {
      deferred: (...args: Parameters<typeof run>) => { modes.push("deferred"); return run.deferred(...args); },
      immediate: (...args: Parameters<typeof run>) => { modes.push("immediate"); return run.immediate(...args); },
      exclusive: run.exclusive,
    });
  });
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE account_periods(id INTEGER PRIMARY KEY,provider TEXT,source TEXT,from_ts TEXT,until_ts TEXT,
        account TEXT,origin TEXT,first_seen TEXT,last_seen TEXT,readings INTEGER,evidence TEXT);
      CREATE TABLE claude_events(store TEXT,session_id TEXT,ts TEXT,cwd TEXT,project TEXT,repo TEXT,repo_group TEXT,project_id TEXT);`);
    const insert = db.query("INSERT INTO claude_events VALUES('pc','session','2026-10-04T12:00:00Z','C:/repos/internal/atlas','atlas',NULL,NULL,NULL)");
    for (let index = 0; index < 256; index++) insert.run();
    const cfg = { projects: [{ id: "atlas", name: "Atlas", matches: [{ cwd: "C:/repos/internal/atlas" }] }] };
    // Another connection holding the writer: the remap fails before reading or writing anything.
    other.exec("BEGIN IMMEDIATE");
    expect(() => remap(db, cfg)).toThrow(/database is locked|SQLITE_BUSY/i);
    expect(db.query("SELECT count(repo) n FROM claude_events").get()).toEqual({ n: 0 });
    other.exec("COMMIT");
    modes.length = 0;
    expect(remap(db, cfg).repoPerTable?.claude_events).toEqual({ assigned: 256, total: 256 });
    expect(modes.length).toBeGreaterThan(0);
    expect(modes.every(mode => mode === "immediate")).toBe(true);
    // Project ids are not written: the rules apply at read time.
    expect(db.query("SELECT DISTINCT project_id, repo FROM claude_events").all()).toEqual([{ project_id: null, repo: "atlas" }]);
  } finally {
    spy.mockRestore(); other.close(); db.close();
    removeTestFixture(directory, { recursive: true, force: true });
  }
});
