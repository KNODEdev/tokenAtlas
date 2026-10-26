import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database, setTransactionContext } from "./sqlite";

test("close releases cached, overflow and explicitly prepared statements without GC", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-statement-owner-"));
  const file = path.join(root, "stage.sqlite");
  const db = new Database(file, { create: true });
  const held = [];
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts(n INTEGER)");
    db.transaction(() => db.run("INSERT INTO facts VALUES(7)"))();
    for (let index = 0; index < Database.MAX_QUERY_CACHE_SIZE + 100; index++) {
      const statement = db.query(`SELECT n, ${index} AS ordinal FROM facts`);
      expect(statement.get()).toEqual({ n: 7, ordinal: index });
      held.push(statement);
    }
    const explicit = db.prepare("SELECT n FROM facts");
    held.push(explicit);
    expect(() => db.close(true)).not.toThrow();
    expect(() => explicit.get()).toThrow();
    expect(() => db.close(true)).not.toThrow();
    // Keeping the JS statement objects alive must not retain the Windows file lock.
    fs.unlinkSync(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(held).toHaveLength(Database.MAX_QUERY_CACHE_SIZE + 101);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit finalization, cache reuse and transaction rollback keep their contracts", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE facts(n INTEGER)");
    const old = db.query("SELECT 1 AS n");
    old.finalize();
    expect(db.query("SELECT 1 AS n").get()).toEqual({ n: 1 });
    expect(() => db.transaction(() => {
      db.run("INSERT INTO facts VALUES(1)");
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(db.query("SELECT count(*) AS n FROM facts").get()).toEqual({ n: 0 });
  } finally { db.close(true); }
});

test("query iteration wraps a reused statement only once", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE facts(n INTEGER); INSERT INTO facts VALUES(1), (2), (3)");
    const sql = "SELECT n FROM facts WHERE n >= ? ORDER BY n";
    const first = db.query<{ n: number }, [number]>(sql);
    const iterate = first.iterate;
    for (let index = 0; index < 100; index++) {
      const statement = db.query<{ n: number }, [number]>(sql);
      expect(statement).toBe(first);
      expect(statement.iterate).toBe(iterate);
      expect(Array.from(statement.iterate(index % 2 ? 2 : 3))).toEqual(index % 2 ? [{ n: 2 }, { n: 3 }] : [{ n: 3 }]);
    }
    first.finalize();
    const replacement = db.query<{ n: number }, [number]>(sql);
    expect(replacement).not.toBe(first);
    expect(Array.from(replacement.iterate(1))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  } finally { db.close(true); }
});

test("open and deserialize keep statement ownership and read-only options", () => {
  const original = Database.open(":memory:");
  original.exec("CREATE TABLE facts(n INTEGER); INSERT INTO facts VALUES(9)");
  const bytes = original.serialize();
  original.close(true);
  for (const options of [true, { readonly: true, safeIntegers: true }]) {
    const copy = Database.deserialize(bytes, options as { readonly: boolean });
    const held = Array.from({ length: 50 }, (_, index) => copy.query(`SELECT n, ${index} FROM facts`));
    expect(() => copy.run("INSERT INTO facts VALUES(10)")).toThrow();
    expect(() => copy.close(true)).not.toThrow();
    expect(() => held[49]!.get()).toThrow();
  }
});

test("long transactions are reported once as read or write with their caller", () => {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE facts(n INTEGER)");
    const insertSlowly = () => db.transaction((n: number) => {
      db.transaction(() => db.run("INSERT INTO facts VALUES(?)", [n]))();
      now += 6_000;
      return n * 2;
    }).immediate(4);
    expect(insertSlowly()).toBe(8);
    expect(warn).toHaveBeenCalledTimes(1);
    // A batch under a second is not reported.
    db.transaction(() => { db.run("INSERT INTO facts VALUES(3)"); now += 900; }).immediate();
    db.exec("DELETE FROM facts WHERE n=3");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/write transaction held 6\.0 s on main: at .*sqlite\.test\.ts/);

    db.transaction(() => db.run("INSERT INTO facts VALUES(5)"))();
    expect(() => db.transaction(() => { now += 6_000; throw new Error("rollback"); })()).toThrow("rollback");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toMatch(/^\[tokenAtlas sqlite\] read transaction held 6\.0 s/);

    db.exec("BEGIN IMMEDIATE");
    db.run("INSERT INTO facts VALUES(6)");
    now += 7_000;
    db.exec("COMMIT");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[2]![0])).toMatch(/write transaction held 7\.0 s/);
    expect(db.query("SELECT n FROM facts ORDER BY n").all()).toEqual([{ n: 4 }, { n: 5 }, { n: 6 }]);

    // A worker names the job it runs, because a report builder's stack does not.
    setTransactionContext("/api/era-timelines?provider=claude");
    db.transaction(() => { now += 8_000; })();
    expect(String(warn.mock.calls[3]![0])).toMatch(/read transaction held 8\.0 s on main \(\/api\/era-timelines\?provider=claude\): at /);
    setTransactionContext("");

    // TEMP rows a report fills count as changes but lock nothing: a read-only connection reads.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-sqlite-")), "facts.db");
    new Database(file).close();
    const reader = new Database(file, { readonly: true });
    try {
      reader.exec("BEGIN DEFERRED");
      reader.exec("CREATE TEMP TABLE scratch(n INTEGER); INSERT INTO temp.scratch VALUES(1)");
      now += 9_000;
      reader.exec("COMMIT");
    } finally { reader.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
    expect(String(warn.mock.calls[4]![0])).toMatch(/read transaction held 9\.0 s/);
  } finally {
    setTransactionContext("");
    db.close(true);
    clock.mockRestore();
    warn.mockRestore();
  }
});
