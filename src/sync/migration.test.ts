import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../db/migrate";
import * as schema from "../db/schema";

const directories: string[] = [];

function tempDatabase(): { directory: string; dbPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-migration-test-"));
  directories.push(directory);
  return { directory, dbPath: path.join(directory, "atlas.sqlite") };
}

afterEach(() => {
  const tempRoot = path.resolve(os.tmpdir());
  while (directories.length > 0) {
    const resolved = path.resolve(directories.pop()!);
    if (path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith("tokenatlas-migration-test-")) {
      try {
        removeTestFixture(resolved, { recursive: true, force: true });
      } catch {
        // Bun can retain a Windows SQLite handle until process teardown.
      }
    }
  }
});

describe("0013 sync persistence migration", () => {
  test("keeps every Drizzle metadata file valid JSON", () => {
    const metadataDir = path.resolve(import.meta.dir, "../../drizzle/meta");
    const metadataFiles = fs
      .readdirSync(metadataDir)
      .filter((name) => name === "_journal.json" || name.endsWith("_snapshot.json"));

    for (const file of metadataFiles) {
      expect(() => JSON.parse(fs.readFileSync(path.join(metadataDir, file), "utf8"))).not.toThrow();
    }
  });

  test("initializes revision and run tables on an empty database", () => {
    const { dbPath } = tempDatabase();
    const sqlite = new Database(dbPath, { create: true });
    try {
      applyDrizzleMigrations(drizzle(sqlite, { schema }));
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sync_%' ORDER BY name")
        .all();
      expect(tables).toEqual([{ name: "sync_revisions" }, { name: "sync_runs" }]);
      expect(sqlite.query("SELECT data_revision, config_revision FROM sync_revisions WHERE id = 1").get()).toEqual({
        data_revision: 0,
        config_revision: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  test("preserves raw rows when upgrading a populated 0012 database", () => {
    const { dbPath } = tempDatabase();
    const sqlite = new Database(dbPath, { create: true });
    const migrationsDir = path.resolve(import.meta.dir, "../../drizzle");
    try {
      const oldMigrations = fs
        .readdirSync(migrationsDir)
        .filter((name) => /^00(0[0-9]|1[0-2])_.*\.sql$/.test(name))
        .sort();
      for (const migration of oldMigrations) {
        sqlite.exec(fs.readFileSync(path.join(migrationsDir, migration), "utf8"));
      }
      sqlite
        .query("INSERT INTO claude_events (store, call_id, ts, path) VALUES ('live', 'preserve-me', ?, ?)")
        .run("2026-08-31T10:00:00.000Z", "fixture.jsonl");
      sqlite.exec(fs.readFileSync(path.join(migrationsDir, "0013_first_kingpin.sql"), "utf8"));
      expect(sqlite.query("SELECT call_id FROM claude_events").get()).toEqual({ call_id: "preserve-me" });
      expect(sqlite.query("SELECT count(*) AS n FROM sync_revisions").get()).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }
  });
});
