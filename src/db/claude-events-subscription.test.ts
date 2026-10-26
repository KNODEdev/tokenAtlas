import { describe, expect, it } from "bun:test";
import { Database } from "./sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { REPO_ROOT } from "../config/paths";
import { applyDrizzleMigrations } from "./migrate";
const MIGRATIONS = path.join(REPO_ROOT, "drizzle");
const ADD_SQL = fs.readFileSync(path.join(MIGRATIONS, "0010_claude_events_subscription_id.sql"), "utf-8");
const LEGACY_CLAUDE_EVENTS = `
  CREATE TABLE claude_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    store TEXT NOT NULL,
    call_id TEXT NOT NULL,
    session_id TEXT,
    request_id TEXT,
    ts TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    project TEXT,
    cwd TEXT,
    git_branch TEXT,
    entrypoint TEXT,
    is_sidechain INTEGER DEFAULT 0 NOT NULL,
    agent_id TEXT,
    attribution_agent TEXT,
    service_tier TEXT,
    speed TEXT,
    cc_version TEXT,
    path TEXT NOT NULL,
    in_uncached INTEGER DEFAULT 0 NOT NULL,
    in_cache_read INTEGER DEFAULT 0 NOT NULL,
    in_cache_write INTEGER DEFAULT 0 NOT NULL,
    cache_write_5m INTEGER DEFAULT 0 NOT NULL,
    cache_write_1h INTEGER DEFAULT 0 NOT NULL,
    out_total INTEGER DEFAULT 0 NOT NULL,
    out_thinking INTEGER DEFAULT 0 NOT NULL,
    project_id TEXT
  );
  CREATE UNIQUE INDEX claude_events_store_call_id_unique ON claude_events (store, call_id);
`;
function insertAwkwardRows(db: Database) {
  db.run(
    `INSERT INTO claude_events (store, call_id, session_id, ts, path, in_uncached, project_id, cwd)
     VALUES ('live', 'call-empty-session', '', '2026-01-01T00:00:00Z', 'C:/p/a.jsonl', 10, NULL, NULL)`
  );
  db.run(
    `INSERT INTO claude_events (store, call_id, ts, path, in_uncached, out_total, project)
     VALUES ('hub', 'call-zero', '2026-01-02T00:00:00Z', 'C:/p/unicode-żółć.jsonl', 0, 0, 'żółć')`
  );
  db.run(
    `INSERT INTO claude_events (store, call_id, ts, path, in_uncached, project_id)
     VALUES ('live', 'call-assigned', '2026-01-03T00:00:00Z', ?, 5, 'proj-1')`,
    [`C:/very/${"long/".repeat(20)}path.jsonl`]
  );
}
describe("claude_events.subscription_id migration", () => {
  it("upgrades a representative legacy table without rewriting existing rows", () => {
    const db = new Database(":memory:");
    db.run(LEGACY_CLAUDE_EVENTS);
    insertAwkwardRows(db);
    const before = db.query(`SELECT store, call_id, path, project_id, in_uncached FROM claude_events ORDER BY call_id`).all();
    db.exec(ADD_SQL.replace(/--> statement-breakpoint/g, ";"));
    const cols = db.query(`PRAGMA table_info(claude_events)`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    expect(cols.some((c) => c.name === "subscription_id")).toBe(true);
    expect(cols.find((c) => c.name === "subscription_id")!.notnull).toBe(0);
    expect(cols.find((c) => c.name === "subscription_conflict")!.notnull).toBe(1);
    const after = db.query(`SELECT store, call_id, path, project_id, in_uncached FROM claude_events ORDER BY call_id`).all();
    expect(after).toEqual(before);
    const ids = db.query(`SELECT subscription_id, subscription_conflict FROM claude_events`).all() as Array<{
      subscription_id: string | null;
      subscription_conflict: number;
    }>;
    expect(ids.every((r) => r.subscription_id == null && r.subscription_conflict === 0)).toBe(true);
  });
  it("rolls back a real second-statement failure through applyDrizzleMigrations", () => {
    const sqlite = new Database(":memory:");
    sqlite.run(LEGACY_CLAUDE_EVENTS);
    insertAwkwardRows(sqlite);
    const beforeCols = sqlite.query(`PRAGMA table_info(claude_events)`).all() as Array<{ name: string }>;
    const beforeRows = sqlite
      .query(`SELECT store, call_id, path, project_id, in_uncached FROM claude_events ORDER BY call_id`)
      .all();
    sqlite.run(`CREATE INDEX claude_events_subscription_id_idx ON claude_events (path)`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-fail-mig-"));
    fs.mkdirSync(path.join(dir, "meta"));
    fs.writeFileSync(
      path.join(dir, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [{ idx: 0, version: "6", when: 1, tag: "0000_fail_second", breakpoints: true }],
      })
    );
    fs.writeFileSync(
      path.join(dir, "0000_fail_second.sql"),
      "ALTER TABLE `claude_events` ADD `subscription_id` text;--> statement-breakpoint\nCREATE INDEX `claude_events_subscription_id_idx` ON `claude_events` (`subscription_id`);\n"
    );
    let failed = false;
    try {
      applyDrizzleMigrations(drizzle(sqlite), dir);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const afterCols = sqlite.query(`PRAGMA table_info(claude_events)`).all() as Array<{ name: string }>;
    expect(afterCols.some((c) => c.name === "subscription_id")).toBe(false);
    expect(afterCols.map((c) => c.name)).toEqual(beforeCols.map((c) => c.name));
    const afterRows = sqlite
      .query(`SELECT store, call_id, path, project_id, in_uncached FROM claude_events ORDER BY call_id`)
      .all();
    expect(afterRows).toEqual(beforeRows);
  });
  it("applies 0010 through the drizzle migrator on a fresh database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-mig-"));
    const dbPath = path.join(dir, "atlas.sqlite");
    const sqlite = new Database(dbPath);
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
    try {
      const cols = sqlite.query(`PRAGMA table_info(claude_events)`).all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "subscription_id")).toBe(true);
      expect(cols.some((c) => c.name === "subscription_conflict")).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
