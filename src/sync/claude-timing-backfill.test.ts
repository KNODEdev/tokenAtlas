import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { CLAUDE_PARSER_VERSION } from "../ingest/claude";
import { backfillClaudeTiming, CLAUDE_TIMING_ATTEMPTS, type ClaudeTimingAttempts } from "./claude-timing-backfill";
import { ParsePool } from "../ingest/parse-pool";

/**
 * The response-time pass settles each file alone: a file it cannot parse is reported with its own path and
 * error, the files around it are written, and after a bounded number of failed cycles it is passed over.
 */
function fixture(names: string[], callsPerFile = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-timing-pass-"));
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE claude_files(store TEXT,path TEXT,size INTEGER,mtime REAL,parser_version INTEGER,PRIMARY KEY(store,path));
    CREATE TABLE claude_events(store TEXT,call_id TEXT,path TEXT,resp_ms INTEGER,UNIQUE(store,call_id))`);
  const files = names.map(name => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, `${name}\n`);
    const stat = fs.statSync(file);
    db.query("INSERT INTO claude_files VALUES('live',?,?,?,5)").run(file, stat.size, stat.mtimeMs);
    for (let call = 0; call < callsPerFile; call++) db.query("INSERT INTO claude_events VALUES('live',?,?,NULL)").run(`${name}-${call}`, file);
    return file;
  });
  return { dir, db, files, close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
/** A parser that fails on the named files, as a native parse error or an unreadable file would. */
const parser = (failing: Set<string>, callsPerFile = 2) => ({
  run: (async (_format: string, input: { store: string; file: string }) => {
    const name = path.basename(input.file, ".jsonl");
    if (failing.has(name)) throw new Error(`EACCES: permission denied, open '${input.file}'`);
    return { events: Array.from({ length: callsPerFile }, (_, call) => ({ store: input.store, call_id: `${name}-${call}`, resp_ms: 1000 + call })),
      limitHits: [] };
  }) as never,
});
const direct = async <T,>(apply: () => T) => apply();
const memory = (): ClaudeTimingAttempts & { counts: Map<string, number> } => {
  const counts = new Map<string, number>();
  return { counts, count: file => counts.get(file) ?? 0, fail: file => { counts.set(file, (counts.get(file) ?? 0) + 1); } };
};
const versions = (db: Database) => (db.query("SELECT path,parser_version FROM claude_files ORDER BY path").all() as Array<{ path: string; parser_version: number }>)
  .map(row => [path.basename(row.path), row.parser_version]);

test("an unreadable file is reported with its own path; the files around it are written; its retries are bounded", async () => {
  const f = fixture(["a", "b", "c"]);
  try {
    const attempts = memory();
    const first = await backfillClaudeTiming(f.db, parser(new Set(["b"])), direct, undefined, undefined, attempts);
    expect(first.failures).toEqual([{ path: f.files[1]!, error: expect.stringContaining("EACCES") }]);
    expect(first.files).toBe(2); expect(first.updated).toBe(4); expect(first.done).toBe(true);
    expect(versions(f.db)).toEqual([["a.jsonl", CLAUDE_PARSER_VERSION], ["b.jsonl", 5], ["c.jsonl", CLAUDE_PARSER_VERSION]]);
    expect(f.db.query("SELECT COUNT(*) n FROM claude_events WHERE resp_ms IS NULL").get()).toEqual({ n: 2 });
    // Later cycles try it again until the bound, then pass over it.
    for (let cycle = 2; cycle <= CLAUDE_TIMING_ATTEMPTS; cycle++)
      expect((await backfillClaudeTiming(f.db, parser(new Set(["b"])), direct, undefined, undefined, attempts)).failures).toHaveLength(1);
    const after = await backfillClaudeTiming(f.db, parser(new Set(["b"])), direct, undefined, undefined, attempts);
    expect(after).toMatchObject({ failures: [], deferred: 1, files: 0, done: true });
  } finally { f.close(); }
});

test("a pass interrupted between the write slices of one file completes it in the next cycle", async () => {
  const f = fixture(["big"], 2500);
  try {
    let writes = 0;
    const interrupted = async <T,>(apply: () => T) => { if (++writes === 2) throw new Error("stopped"); return apply(); };
    await expect(backfillClaudeTiming(f.db, parser(new Set(), 2500), interrupted)).rejects.toThrow("stopped");
    // The first slice is written; the file is not marked read, so the next cycle reads it again.
    expect(f.db.query("SELECT COUNT(*) n FROM claude_events WHERE resp_ms IS NOT NULL").get()).toEqual({ n: 1000 });
    expect(versions(f.db)).toEqual([["big.jsonl", 5]]);
    const resumed = await backfillClaudeTiming(f.db, parser(new Set(), 2500), direct);
    // Times already written are not written again.
    expect(resumed).toMatchObject({ files: 1, updated: 1500, done: true, failures: [] });
    expect(f.db.query("SELECT COUNT(*) n FROM claude_events WHERE resp_ms IS NULL").get()).toEqual({ n: 0 });
    expect(versions(f.db)).toEqual([["big.jsonl", CLAUDE_PARSER_VERSION]]);
  } finally { f.close(); }
});

test("an unavailable parser defers the pass without spending any file's retries; once restored the files are timed", async () => {
  const f = fixture(["a", "b"]);
  const missing = new ParsePool(1, { binary: path.join(f.dir, "absent.exe") });
  try {
    const attempts = memory();
    for (let cycle = 1; cycle <= CLAUDE_TIMING_ATTEMPTS; cycle++) {
      const step = await backfillClaudeTiming(f.db, missing, direct, undefined, undefined, attempts);
      expect(step).toMatchObject({ files: 0, done: false, failures: [], unavailable: expect.stringContaining("Native parser") });
    }
    expect(attempts.counts.size).toBe(0);
    expect(versions(f.db)).toEqual([["a.jsonl", 5], ["b.jsonl", 5]]);
    const restored = await backfillClaudeTiming(f.db, parser(new Set()), direct, undefined, undefined, attempts);
    expect(restored).toMatchObject({ files: 2, updated: 4, done: true, deferred: 0, failures: [] });
    expect(versions(f.db)).toEqual([["a.jsonl", CLAUDE_PARSER_VERSION], ["b.jsonl", CLAUDE_PARSER_VERSION]]);
  } finally { await missing.close(); f.close(); }
});
