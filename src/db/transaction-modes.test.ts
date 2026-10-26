import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./sqlite";
import { removeTestFixture } from "../test-cleanup";

/**
 * Every transaction in the application names its mode (U2.3). A deferred transaction that reads and
 * then writes fails at once in WAL mode when another connection committed in between: SQLite cannot
 * upgrade the stale snapshot and returns SQLITE_BUSY without waiting. A write transaction therefore
 * takes the writer at its start (`.immediate()`, `BEGIN IMMEDIATE`); a read snapshot says so
 * (`.deferred()`, `BEGIN DEFERRED`).
 */
const root = path.resolve(import.meta.dir, "..");
function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [file] : [];
  });
}

test("every transaction in src names its mode: immediate for writes, deferred for read snapshots", () => {
  const unnamed: string[] = [];
  for (const file of sources(root)) {
    if (file === path.join(root, "db", "sqlite.ts")) continue;
    const text = fs.readFileSync(file, "utf8");
    const at = (index: number) => `${path.relative(root, file)}:${text.slice(0, index).split("\n").length}`;
    for (const match of text.matchAll(/\.transaction\(/g)) {
      let index = match.index! + match[0].length, depth = 1;
      while (depth && index < text.length) {
        const character = text[index++];
        if (character === "(") depth++;
        else if (character === ")") depth--;
      }
      if (!/^\.(immediate|deferred|exclusive)\(/.test(text.slice(index, index + 12))) unnamed.push(at(match.index!));
    }
    for (const match of text.matchAll(/\b(?:exec|run)\(\s*["'`]\s*BEGIN\s*(?:TRANSACTION\s*)?[;"'`]/gi)) unnamed.push(at(match.index!));
  }
  expect(unnamed).toEqual([]);
});

for (const mode of ["deferred", "immediate"] as const) {
  test(`a transaction that reads and then writes ${mode === "deferred" ? "fails at once when deferred" : "waits for the writer when immediate"}`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-transaction-mode-"));
    const file = path.join(directory, "atlas.sqlite");
    const db = new Database(file), other = new Database(file);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE facts(value INTEGER)");
      other.exec("PRAGMA busy_timeout=0");
      let otherWrote = false;
      const work = db.transaction(() => {
        const before = (db.query("SELECT COUNT(*) n FROM facts").get() as { n: number }).n;
        // Another connection commits between this transaction's read and its write.
        try { other.query("INSERT INTO facts VALUES(1)").run(); otherWrote = true; }
        catch (error) { if (!/database is locked|SQLITE_BUSY/i.test(String(error))) throw error; }
        db.query("INSERT INTO facts VALUES(?)").run(before + 100);
      });
      if (mode === "deferred") {
        expect(() => work.deferred()).toThrow(/database is locked|SQLITE_BUSY/);
        expect(otherWrote).toBe(true);
      } else {
        work.immediate();
        expect(otherWrote).toBe(false);
        expect(db.query("SELECT value FROM facts").all()).toEqual([{ value: 100 }]);
      }
    } finally { other.close(); db.close(); removeTestFixture(directory, { recursive: true, force: true }); }
  });
}
