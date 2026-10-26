import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { ParsePool, NativeParserError, ParseWorkerError, type ParseFormat, type ParseFormats } from "./parse-pool";
import { identityCompanion } from "./claude-companion";
import { verifySourceSqliteRead } from "./source-sqlite";
import { Database } from "../db/sqlite";
import { createOtherSqliteGoldens } from "../../native/tokenatlas-parse/tests/golden/other/fixtures";

const golden = path.resolve(import.meta.dir, "../../native/tokenatlas-parse/tests/golden");
let previousZone: string | undefined;
beforeEach(() => { previousZone = process.env.TZ; process.env.TZ = "Europe/Warsaw"; });
afterEach(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });
const stored = JSON.parse(fs.readFileSync(path.join(golden, "expected.json"), "utf8")) as {
  cases: Array<{ format: ParseFormat; input: ParseFormats[ParseFormat]["input"]; expected?: unknown; error?: string }>;
};
function replacePaths(value: unknown, replacements: Array<[string, string]>): any {
  if (value && typeof value === "object" && "$number" in value) return Number(value.$number);
  if (typeof value === "string") return replacements.reduce((text, [from, to]) =>
    text.split(from).map((part,index)=>index ? part.replaceAll("\\",path.sep) : part).join(to), value);
  if (Array.isArray(value)) return value.map(item => replacePaths(item, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePaths(item, replacements)]));
  return value;
}

test("native providers match stored goldens, byte prefixes, errors and concurrent repeats", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-golden-"));
  const files = createOtherSqliteGoldens(temp), pool = new ParsePool(4);
  const replacements: Array<[string, string]> = [["$GOLDEN", golden], ["$SQLITE", temp]];
  try {
    for (const entry of stored.cases) {
      const input = replacePaths(entry.input, replacements);
      if (entry.error) {
        const error = await pool.run(entry.format, input).then(() => null, error => error);
        expect(error).toBeInstanceOf(NativeParserError);
        expect(error.message).toBe(replacePaths(entry.error, replacements));
      }
      else {
        const expected = replacePaths(entry.expected, replacements);
        if (entry.format==="claude") {
          // The stored corpus was captured on Windows; cwd basename is a host path contract.
          for (const event of expected.events) if (typeof event.cwd==="string" && event.cwd)
            event.project=path.basename(event.cwd.replaceAll("\\","/")) || event.cwd;
        }
        const [first, second] = await Promise.all([pool.run(entry.format, input), pool.run(entry.format, input)]);
        expect(first).toEqual(expected); expect(second).toEqual(expected);
      }
    }
    expect((Reflect.get(pool, "live") as Set<Worker>).size).toBe(0);
    for (const file of Object.values(files)) for (const suffix of ["-wal", "-shm"]) expect(fs.existsSync(file + suffix)).toBe(false);
  } finally { await pool.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}, 60000);

test("strict Grok reads reject the malformed corpus that permissive legacy goldens skip", async () => {
  const pool = new ParsePool(1), file = path.join(golden, "other", "grok.jsonl");
  try {
    const error = await pool.run("grok", { file, cwd: null, strictRead: true }).catch(error => error);
    expect(error).toBeInstanceOf(NativeParserError);
    expect(error.message).toBe(`Invalid JSONL record in ${file} at byte 0`);
  } finally { await pool.close(); }
});

test("native restarts preserve in-flight results without Bun provider workers", async () => {
  const pool = new ParsePool(2);
  try {
    for (const format of ["codex", "claude", "grok", "gaugesJournal"] as const) {
      const entry = stored.cases.find(entry => entry.format === format && !entry.error)!;
      const input = replacePaths(entry.input, [["$GOLDEN", golden]]), expected = replacePaths(entry.expected, [["$GOLDEN", golden]]);
      expect(await pool.run(format, input)).toEqual(expected);
      const work = Array.from({ length: 12 }, () => pool.run(format, input));
      (Reflect.get(pool, "native") as ChildProcess).kill();
      expect(await Promise.all(work)).toEqual(Array(12).fill(expected));
    }
    expect((Reflect.get(pool, "live") as Set<Worker>).size).toBe(0);
  } finally { await pool.close(); }
});

test("closing native cannot miss a close event emitted during kill", async () => {
  const pool = new ParsePool(1), child = Reflect.get(pool, "native") as ChildProcess;
  const kill = child.kill.bind(child), emit = child.emit.bind(child);
  let closed = false;
  child.emit = (event: string | symbol, ...args: unknown[]) => {
    if (event === "close") { if (closed) return false; closed = true; }
    return emit(event, ...args);
  };
  child.kill = signal => { child.emit("close", null, "SIGTERM"); return kill(signal); };
  await pool.close();
  expect(await pool.run("grok", { file: "unused", cwd: null }).catch(error => error)).toBeInstanceOf(ParseWorkerError);
});

test("partial gauge replies are discarded before native retry", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-chunks-"));
  const file = path.join(temp, "journal.jsonl"), text = '"' + "x".repeat(4 * 1024 * 1024) + '"\n';
  fs.writeFileSync(file, text);
  const pool = new ParsePool(2), chunks = Reflect.get(pool, "gaugeChunks") as Map<number, unknown>;
  const set = chunks.set.bind(chunks); let interrupted = false;
  chunks.set = (id, lines) => {
    set(id, lines);
    if (!interrupted) { interrupted = true; Reflect.get(pool, "loseNative").call(pool, "forced partial response"); }
    return chunks;
  };
  try {
    expect(await pool.run("gaugesJournal", { file, offset: 0, size: Buffer.byteLength(text), chunkedTransport: true })).toEqual({
      lines: [{ line: text.slice(0, -1), offset: 0, raw: null, entry_id: null, compact: false, canonical: false }],
      bytes: [], consumed: Buffer.byteLength(text), done: true, prefixHash: createHash("sha256").update(text).digest("hex"),
    });
    expect(interrupted).toBe(true); expect(chunks.size).toBe(0);
  } finally { await pool.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}, 60000);

test("missing and crashing native parsers fail closed; Bun utility tasks remain available", async () => {
  const file = path.join(golden, "usage.jsonl"), size = fs.statSync(file).size;
  for (const binary of [path.join(golden, "absent.exe"), process.execPath]) {
    const pool = new ParsePool(2, { binary });
    try {
      const errors = await Promise.all(Array.from({ length: 8 }, () => pool.run("codex", { file, size }).catch(error => error)));
      for (const error of errors) expect(error).toBeInstanceOf(NativeParserError);
      expect(await pool.run("validateJsonl", { file })).toEqual({});
      expect((Reflect.get(pool, "live") as Set<Worker>).size).toBe(2);
    } finally { await pool.close(); }
    expect(await pool.run("codex", { file, size }).catch(error => error)).toBeInstanceOf(ParseWorkerError);
  }
});

test("SQLite rejects originals, changed bytes, malformed archived messages and uncheckpointed WAL", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-fence-"));
  const files = createOtherSqliteGoldens(temp), pool = new ParsePool(1);
  try {
    await expect(pool.run("gemini", { file: files.gemini })).rejects.toThrow("Archive SQLite inputs");
    await expect(pool.run("opencode", { file: files.opencode })).rejects.toThrow("Archive SQLite inputs");
    await expect(verifySourceSqliteRead(files.opencode, async () => { fs.appendFileSync(files.opencode, "x"); throw new Error("read failed"); })).rejects.toThrow("changed");
    const db = new Database(files.opencode);
    try { db.query("INSERT INTO message VALUES('bad','s','{broken')").run(); } finally { db.close(); }
    await expect(pool.run("opencode", { file: files.opencode, archivedInput: true })).rejects.toThrow("Invalid archived OpenCode message JSON");
    const wal = new Database(files.opencode);
    try {
      wal.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      wal.query("INSERT INTO message VALUES('wal','s','{}')").run();
      await expect(verifySourceSqliteRead(files.opencode, async () => null)).rejects.toThrow("uncheckpointed WAL");
    } finally { wal.close(); }
  } finally { await pool.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test("long-lived native companion cache refreshes on creation, change and deletion", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-companion-"));
  const session = "01234567-89ab-cdef-0123-456789abcdef", file = path.join(temp, session, "subagents/agent.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(golden, "claude", session, "subagents/agent.jsonl"), file);
  const companion = identityCompanion("live", file)!;
  const owner = { type: "bridge-session", sessionId: session, ownerAccountUuid: "11111111-2222-3333-4444-555555555555", ownerOrganizationUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
  const pool = new ParsePool(2);
  try {
    const run = () => pool.run("claude", { store: "live", file });
    expect((await run()).events[0]!.account_key).toBeNull();
    fs.writeFileSync(companion, JSON.stringify(owner));
    const first = (await run()).events[0]!.account_key;
    expect(first).toBe("claude:11111111-2222-3333-4444-555555555555:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    fs.writeFileSync(companion, JSON.stringify({ ...owner, ownerAccountUuid: "66666666-2222-3333-4444-555555555555" }));
    const later = new Date(Date.now() + 2000); fs.utimesSync(companion, later, later);
    expect((await run()).events[0]!.account_key).not.toBe(first);
    fs.appendFileSync(companion, "\n" + JSON.stringify(owner));
    expect((await run()).events[0]!.subscription_conflict).toBe(1);
    fs.unlinkSync(companion); expect((await run()).events[0]!.account_key).toBeNull();
  } finally { await pool.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
