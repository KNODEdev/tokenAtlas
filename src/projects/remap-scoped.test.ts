import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { ensureCodexSchema } from "../ingest/codex";
import { remap } from "./remap";
import { createTestDatabase } from "../sync/test-support";
import { omitStageAnalysisTracking } from "../sync/stage-tracking";
import { removeTestFixture } from "../test-cleanup";

test("scoped remap retains global casing votes and writes only changed repositories, never projects or gaps", () => {
  const fixture = createTestDatabase();
  const db = new Database(fixture.dbPath);
  try {
    ensureCodexSchema(db);
    omitStageAnalysisTracking(db);
    const insert = db.query(`INSERT INTO claude_events(store,call_id,path,ts,cwd,project,project_id,session_id)
      VALUES('pc',?,'other','2026-08-28T00:00:00Z','C:/repos/internal/ATLAS','ATLAS','keep','other')`);
    for (let index=0;index<4;index++) insert.run(String(index));
    db.exec(`
      INSERT INTO events(home,path,ts,cwd,project) VALUES
      ('pc','a','2026-08-28T00:00:00Z','C:/repos/internal/atlas','atlas'),
      ('pc','a','2026-08-28T00:01:00Z','C:/repos/internal/atlas','atlas'),
      ('other','b','2026-08-29T00:00:00Z','C:/repos/internal/beta','beta');`);
    const cfg = { projects: [
      { id: "generic", name: "Generic", matches: [{ cwd: "C:/repos/internal/atlas" }] },
      { id: "account", name: "Account", matches: [{ store: "pc", repo: "atlas", from: "2026-08-28", until: "2026-08-29" }] },
    ] };
    remap(db, cfg, undefined, ["events"]);
    // The casing of a repository is voted across every table, the Claude calls included.
    expect(db.query("SELECT project_id,repo FROM events ORDER BY rowid").all()).toEqual([
      { project_id: null, repo: "ATLAS" }, { project_id: null, repo: "ATLAS" }, { project_id: null, repo: "beta" },
    ]);
    expect(db.query("SELECT project_id FROM claude_events").all()).toEqual(Array(4).fill({ project_id: "keep" }));
    db.exec(`CREATE TRIGGER no_identical_event_update BEFORE UPDATE ON events
      WHEN NEW.project_id IS OLD.project_id AND NEW.repo IS OLD.repo AND NEW.repo_group IS OLD.repo_group
      BEGIN SELECT RAISE(ABORT,'unchanged event updated'); END`);
    remap(db, cfg, undefined, ["events"]);
    db.exec(`INSERT INTO events(home,path,ts,cwd,project)
      VALUES('pc','a','2026-08-28T00:02:00Z','C:/repos/internal/atlas','atlas')`);
    remap(db, cfg, undefined, ["events"]);
    expect(db.query("SELECT project_id, repo FROM events WHERE rowid=4").get()).toEqual({ project_id: null, repo: "ATLAS" });
  } finally { db.close(); removeTestFixture(fixture.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});
