import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { isFirstRun, readStartupAccounts } from "./accounts-document";

const roots: string[] = [];
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-first-run-"));
  roots.push(root);
  return { accounts: path.join(root, "config", "accounts.json"), database: path.join(root, "atlas.sqlite") };
}
function database(file: string, statuses: string[] | null) {
  const db = new Database(file, { create: true });
  if (statuses !== null) {
    db.exec("CREATE TABLE sync_runs (run_id INTEGER PRIMARY KEY, status TEXT NOT NULL)");
    for (const status of statuses) db.query("INSERT INTO sync_runs (status) VALUES (?)").run(status);
  }
  db.close();
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("first run", () => {
  test("a machine without declarations or a database starts from empty declarations", () => {
    const { accounts, database: db } = workspace();
    expect(isFirstRun(accounts, db)).toBe(true);
    expect(readStartupAccounts(accounts, db)).toEqual({ version: 2, subscriptions: [], sources: [] });
    expect(fs.existsSync(db)).toBe(false);
  });

  test("a migrated database without a completed sync is still a first run", () => {
    const { accounts, database: db } = workspace();
    database(db, ["failed", "running"]);
    expect(isFirstRun(accounts, db)).toBe(true);
    const unmigrated = workspace();
    database(unmigrated.database, null);
    expect(isFirstRun(unmigrated.accounts, unmigrated.database)).toBe(true);
  });

  test("a database with a completed sync and no declarations keeps failing", () => {
    for (const status of ["success", "partial_success"]) {
      const { accounts, database: db } = workspace();
      database(db, ["failed", status]);
      expect(isFirstRun(accounts, db)).toBe(false);
      expect(() => readStartupAccounts(accounts, db)).toThrow("accounts v2: missing configuration");
    }
  });

  test("an existing file is read as v2 and the old format is still refused", () => {
    const { accounts, database: db } = workspace();
    fs.mkdirSync(path.dirname(accounts), { recursive: true });
    fs.writeFileSync(accounts, JSON.stringify({ subscriptions: [] }));
    expect(isFirstRun(accounts, db)).toBe(false);
    expect(() => readStartupAccounts(accounts, db)).toThrow("accounts v2:");
  });
});
