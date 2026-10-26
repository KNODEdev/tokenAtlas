import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { ingestClaude } from "./claude";

test("Claude import rejects an unmigrated existing database before opening it for writes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-claude-migration-"));
  try {
    const dbPath = path.join(directory, "atlas.sqlite");
    const sqlite = new Database(dbPath, { create: true });
    try {
      sqlite.exec("CREATE TABLE retained (value TEXT NOT NULL)");
      sqlite.query("INSERT INTO retained (value) VALUES ('original')").run();
    } finally {
      sqlite.close(true);
    }
    const before = fs.readFileSync(dbPath);
    const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];
    expect(sidecars.every(file => !fs.existsSync(file))).toBe(true);

    await expect(ingestClaude({ dbPath, store: "live", path: path.join(directory, "absent.jsonl") }))
      .rejects.toThrow("an existing database has no migration history");

    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(sidecars.every(file => !fs.existsSync(file))).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
