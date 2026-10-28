import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { installFirstTokenTracking, replaceFirstTokenFile } from "../db/first-token";
import { codexFirstTokenAdapter } from "../providers/first-token/codex";
import type { FirstTokenAdapter, FirstTokenTurn } from "../providers/first-token/types";
import { firstTokenSummary } from "../shared/first-token";
import { buildAccountResolver } from "./account-resolver";
import { advanceFirstTokenTimes, NativeFirstTokenReader, type FirstTokenReader } from "./first-token-producer";
import { selectArchiveRepresentation, withDecodedArchiveFiles } from "../ingest/archive-codec";
import { attachFirstTokenTimes, readFirstTokenTimes } from "./first-token-read";

const migration = fs.readFileSync(new URL("../../drizzle/0095_first_token.sql", import.meta.url), "utf8");
const modeMigration = fs.readFileSync(new URL("../../drizzle/0096_model_execution_timings.sql", import.meta.url), "utf8");
const source = "codex/pc";
const evidence = { firstSeen: null, lastSeen: null, readings: 0, evidence: "synthetic" };
// A synchronous semantic reference keeps producer/cursor tests independent of native scheduling.
const referenceReader: FirstTokenReader = { forget() {}, read(_key, _generation, adapter, file) {
  return withDecodedArchiveFiles([selectArchiveRepresentation(file)], ([decoded]) => ({ turns: adapter.parse(
    fs.readFileSync(decoded!, "utf8").split("\n").slice(0, -1).filter(s => s.trim()).map(s => JSON.parse(s))) }));
} };
function fixture(file = ":memory:") {
  const db = new Database(file);
  db.exec(migration);
  db.exec(modeMigration);
  db.exec("CREATE TABLE files(home TEXT,path TEXT,size INTEGER,mtime REAL,PRIMARY KEY(home,path))");
  installFirstTokenTracking(db, codexFirstTokenAdapter);
  return db;
}
const sample = (id: string, ms: number | null, ts = "2026-10-25T10:00:00.000Z"): FirstTokenTurn =>
  ({ id, model: "fixture-model", ts, ms, billing: "allowance", reason: ms === null ? "not_recorded" : null });
function resolver(cut = false) {
  return buildAccountResolver([
    { ...evidence, provider: "codex", subject: source, value: "a", from: "2026-10-25T00:00:00.000Z", until: cut ? "2026-10-25T10:30:00.000Z" : null, origin: "declared" },
    ...(cut ? [{ ...evidence, provider: "codex", subject: source, value: "b", from: "2026-10-25T10:30:00.000Z", until: null, origin: "declared" as const }] : []),
  ]);
}
const snapshot = (db: Database) => ({ turns: db.query("SELECT * FROM response_time_turns ORDER BY turn_id").all(),
  hours: db.query("SELECT * FROM response_time_hours ORDER BY provider,source,hour,model,billing,ms").all() });

test("incremental correction, copy deduplication and deletion equal rebuilding the same inputs", () => {
  const db = fixture(), full = fixture();
  try {
    const first = [sample("one", 2000), sample("two", null), sample("three", 8000)];
    replaceFirstTokenFile(db, "codex", "h", "p1", source, first);
    const before = snapshot(db), changes = db.query("SELECT total_changes() n").get();
    expect(replaceFirstTokenFile(db, "codex", "h", "p1", source, first)).toBe(false);
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    replaceFirstTokenFile(db, "codex", "h", "copy", source, first);
    expect(snapshot(db)).toEqual(before);
    const changed = [sample("one", 3000), sample("two", null), sample("new", 0)];
    replaceFirstTokenFile(db, "codex", "h", "p1", source, changed);
    expect((db.query("SELECT ms,reason FROM response_time_turns WHERE turn_id='one'").get())).toEqual({ ms: null, reason: "conflicting_measurement" });
    replaceFirstTokenFile(db, "codex", "h", "copy", source, []);
    replaceFirstTokenFile(full, "codex", "h", "p1", source, changed);
    expect(snapshot(db)).toEqual(snapshot(full));
    const result = readFirstTokenTimes(db, resolver(), "codex", "a", { grain: "day" });
    expect(firstTokenSummary(result.models.get(JSON.stringify(["fixture-model","standard",null]))!.get("2026-10-25"))).toEqual({ turns: 3, measured: 2, median_ms: 1500, p90_ms: 3000, coverage: 2 / 3 });
  } finally { db.close(); full.close(); }
});
test("dated ownership, business pools, date filtering and timing-only days share the stored facts", () => {
  const db = fixture();
  try {
    const turns = [sample("before", 1000, "2026-10-25T10:10:00.000Z"), sample("after", 9000, "2026-10-25T10:40:00.000Z"),
      { ...sample("business", 5000, "2026-10-25T11:00:00.000Z"), billing: "business_credits" }];
    replaceFirstTokenFile(db, "codex", "h", "p", source, turns);
    const read = (account: string) => readFirstTokenTimes(db, resolver(true), "codex", account, { grain: "day" });
    expect(firstTokenSummary(read("a").models.get(JSON.stringify(["fixture-model","standard",null]))!.get("2026-10-25")).median_ms).toBe(1000);
    expect(firstTokenSummary(read("b").models.get(JSON.stringify(["fixture-model","standard",null]))!.get("2026-10-25")).median_ms).toBe(9000);
    expect(firstTokenSummary(read("b::business").models.get(JSON.stringify(["fixture-model","standard",null]))!.get("2026-10-25")).median_ms).toBe(5000);
    expect(readFirstTokenTimes(db, resolver(), "codex", "a", { grain: "day", since: "2026-10-26" }).models.size).toBe(0);
    const attached = attachFirstTokenTimes([], read("a"));
    expect(attached[0]!.total.calls).toBe(0);
    expect(attached[0]!.total.first_token!.turns).toBe(1);
    const noWrites = db.query("SELECT total_changes() n").get();
    read("a"); read("b");
    expect(db.query("SELECT total_changes() n").get()).toEqual(noWrites);
  } finally { db.close(); }
});
test("a provider with conflicting source/model evidence is never assigned guessed timing", () => {
  const db = fixture();
  try {
    replaceFirstTokenFile(db, "codex", "h", "p", source, [sample("one", 1000)]);
    replaceFirstTokenFile(db, "codex", "h", "other", "codex/other", [sample("one", 1000)]);
    expect(db.query("SELECT COUNT(*) n FROM response_time_hours").get()).toEqual({ n: 0 });
    expect(db.query("SELECT source,ms,reason FROM response_time_turns").get()).toEqual({ source: null, ms: null, reason: "conflicting_identity" });
  } finally { db.close(); }
});
test("history backfill, changed-file queue, restart and source errors preserve completed work", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-first-token-")), dbPath = path.join(dir, "copy.sqlite");
  let db = fixture(dbPath);
  const file = path.join(dir, "codex", "pc", "session.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = (ms: number) => [
    { type: "turn_context", payload: { turn_id: "t", model: "fixture-model" } },
    { type: "event_msg", timestamp: "2026-10-25T10:00:00.000Z", payload: { type: "task_started", turn_id: "t" } },
    { type: "event_msg", timestamp: "2026-10-25T10:00:10.000Z", payload: { type: "task_complete", turn_id: "t", duration_ms: 10000, time_to_first_token_ms: ms } },
  ].map(v => JSON.stringify(v)).join("\n") + "\n";
  const run = () => advanceFirstTokenTimes(db, { reader: referenceReader, archiveRoot: dir, physicalPath: p => p, now: 1000 });
  try {
    fs.writeFileSync(file, records(2000));
    db.query("INSERT INTO files VALUES (?,?,?,?)").run("h", file, 10, 1);
    expect(run()).toMatchObject({ processed: 1, pending: false, failed: 0 });
    const kept = snapshot(db);
    db.close(); db = new Database(dbPath);
    const changes = db.query("SELECT total_changes() n").get();
    expect(run()).toMatchObject({ processed: 0, pending: false, failed: 0 });
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    expect(snapshot(db)).toEqual(kept);
    fs.writeFileSync(file, "broken-json\n");
    db.query("UPDATE files SET mtime=2").run();
    expect(run()).toMatchObject({ processed: 0, pending: true, failed: 1 });
    expect(snapshot(db)).toEqual(kept);
    fs.writeFileSync(file, records(4000)); db.query("UPDATE files SET mtime=3").run();
    expect(run().processed).toBe(1);
    expect(db.query("SELECT ms FROM response_time_turns").get()).toEqual({ ms: 4000 });
    fs.writeFileSync(`${file}.zst`, Bun.zstdCompressSync(Buffer.from(records(6000))));
    fs.unlinkSync(file); db.query("UPDATE files SET mtime=4").run();
    expect(run()).toMatchObject({ processed: 1, pending: false, failed: 0 });
    expect(db.query("SELECT ms FROM response_time_turns").get()).toEqual({ ms: 6000 });
    db.query("DELETE FROM files").run(); expect(run().processed).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM response_time_turns").get()).toEqual({ n: 0 });
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("a new adapter uses the same queue, persistence and reader without provider branches", () => {
  const db = fixture();
  const adapter: FirstTokenAdapter = { id: "fixture", version: 1, files: { table: "fixture_files", owner: "store" },
    parse: () => [], baseAccount: a => a, owner: (r, s, ts) => r.resolve("fixture", s, null, ts).account };
  try {
    db.exec("CREATE TABLE fixture_files(store TEXT,path TEXT,size INTEGER,mtime REAL)");
    installFirstTokenTracking(db, adapter);
    replaceFirstTokenFile(db, adapter.id, "h", "p", "fixture/pc", [sample("one", 1234)]);
    const r = buildAccountResolver([{ ...evidence, provider: "fixture", subject: "fixture/pc", value: "a", from: "2026-10-01", until: null, origin: "declared" }]);
    expect(readFirstTokenTimes(db, r, "fixture", "a", { grain: "day", adapters: [adapter] }).models.get(JSON.stringify(["fixture-model","standard",null]))!.get("2026-10-25")!.histogram).toEqual([[1234, 1]]);
  } finally { db.close(); }
});

test("bounded batches resume their durable file progress, including files without timings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-first-token-batch-")), dbPath = path.join(dir, "copy.sqlite");
  let db = fixture(dbPath), elapsed = 0;
  const parsed: number[] = [];
  const adapter: FirstTokenAdapter = { ...codexFirstTokenAdapter, parse(lines) {
    const { id } = [...lines][0] as { id: number };
    parsed.push(id); elapsed += 5;
    return id % 2 ? [sample(String(id), id)] : [];
  } };
  const run = (limit = 128, budgetMs = 12) => advanceFirstTokenTimes(db, { adapters: [adapter], archiveRoot: dir,
    reader: referenceReader, physicalPath: p => p, clock: () => elapsed, budgetMs, limit });
  try {
    fs.mkdirSync(path.join(dir, "codex", "pc"), { recursive: true });
    for (let id = 0; id < 12; id++) {
      const file = path.join(dir, "codex", "pc", `${id}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ id }) + "\n");
      db.query("INSERT INTO files VALUES (?,?,?,?)").run("h", file, 10, id);
    }
    expect(run()).toEqual({ processed: 3, pending: true, failed: 0, completed: 3, remaining: 9, total: 12 });
    expect(parsed).toEqual([11, 10, 9]);
    const kept = snapshot(db);
    db.close(); db = new Database(dbPath);
    expect(snapshot(db)).toEqual(kept);
    expect(run(4, 100)).toEqual({ processed: 4, pending: true, failed: 0, completed: 7, remaining: 5, total: 12 });
    expect(run(128, 100)).toEqual({ processed: 5, pending: false, failed: 0, completed: 12, remaining: 0, total: 12 });
    expect(new Set(parsed).size).toBe(12);
    const changes = db.query("SELECT total_changes() n").get();
    expect(run().processed).toBe(0);
    expect(parsed).toHaveLength(12);
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    db.query("UPDATE files SET mtime=100 WHERE path=?").run(path.join(dir, "codex", "pc", "3.jsonl"));
    expect(run(1).completed).toBe(12);
    expect(parsed).toHaveLength(13);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a batch yields its write lease between files and a broken file does not stop the others", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-first-token-yield-")), db = fixture();
  let writing = true;
  const adapter: FirstTokenAdapter = { ...codexFirstTokenAdapter, parse: lines => {
    Array.from(lines); writing = false; return [sample("held", 1000)];
  } };
  try {
    fs.mkdirSync(path.join(dir, "codex", "pc"), { recursive: true });
    for (const id of [1, 2, 3]) {
      const file = path.join(dir, "codex", "pc", `${id}.jsonl`);
      fs.writeFileSync(file, id === 3 ? "broken\n" : "{}\n");
      db.query("INSERT INTO files VALUES (?,?,?,?)").run("h", file, 10, id);
    }
    const run = () => advanceFirstTokenTimes(db, { adapters: [adapter], archiveRoot: dir, physicalPath: p => p,
      reader: referenceReader, canWrite: () => writing, now: 1000, budgetMs: 1000 });
    expect(run()).toEqual({ processed: 0, pending: true, failed: 1, completed: 0, remaining: 3, total: 3 });
    // Parsed work whose writer lease was requested stays queued; existing publication is untouched.
    expect(snapshot(db).turns).toEqual([]);
    writing = true;
    const finished = advanceFirstTokenTimes(db, { reader: referenceReader, archiveRoot: dir, physicalPath: p => p, now: 1000, budgetMs: 1000 });
    expect(finished).toEqual({ processed: 2, pending: true, failed: 1, completed: 2, remaining: 1, total: 3 });
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ordinary import handoff publishes TTFT without reading the archived file again", () => {
  const db = fixture(), file = "/fixture-archive/codex/pc/ordinary.jsonl";
  try {
    db.exec("CREATE TABLE codex_file_evidence(home TEXT,path TEXT,first_token_json TEXT)");
    db.query("INSERT INTO files VALUES (?,?,?,?)").run("h", file, 20, 10);
    db.query("INSERT INTO codex_file_evidence VALUES (?,?,?)").run("h", file,
      JSON.stringify({ version: codexFirstTokenAdapter.version, turns: [sample("ordinary", 1200)], bookmark: { size: 20, mtime: 10 } }));
    const result = advanceFirstTokenTimes(db, { archiveRoot: "/fixture-archive",
      physicalPath: () => { throw new Error("Must consume the native import result"); } });
    expect(result).toMatchObject({ processed: 1, completed: 1, pending: false, failed: 0 });
    expect(db.query("SELECT ms FROM response_time_turns").get()).toEqual({ ms: 1200 });
    db.query("UPDATE files SET mtime=11").run();
    const retry = advanceFirstTokenTimes(db, { archiveRoot: "/fixture-archive" });
    expect(retry).toMatchObject({ processed: 0, pending: true, failed: 1 });
    expect(db.query("SELECT ms FROM response_time_turns").get()).toEqual({ ms: 1200 });
  } finally { db.close(); }
});

test("native preparation runs outside the writer turn, retains ready results and rejects stale generations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-first-token-native-ready-"));
  const file = path.join(dir, "codex", "pc", "f.jsonl"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{}\n");
  const waiting: Array<(turns: FirstTokenTurn[]) => void> = [];
  let submitted = 0, wakes = 0;
  const adapter: FirstTokenAdapter = { ...codexFirstTokenAdapter, prepare: async () => {
    submitted++; return new Promise(resolve => waiting.push(resolve));
  } };
  const fakePool = { close: async () => {} } as import("../ingest/parse-pool").ParsePool;
  const reader = new NativeFirstTokenReader(() => { wakes++; }, 2, () => fakePool);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    expect(reader.read("key", "old", adapter, file)).toBeNull();
    expect(submitted).toBe(0);
    await settle(); expect(submitted).toBe(1);
    waiting.shift()!([sample("old", 1000)]); await settle();
    expect(wakes).toBe(1);
    expect(reader.read("key", "old", adapter, file)).toEqual({ turns: [sample("old", 1000)] });
    expect(reader.read("key", "old", adapter, file)).toEqual({ turns: [sample("old", 1000)] });
    expect(submitted).toBe(1);
    expect(reader.read("key", "new", adapter, file)).toBeNull();
    await settle(); expect(submitted).toBe(2);
    fs.appendFileSync(file, "{}\n"); waiting.shift()!([sample("new", 2000)]); await settle();
    expect(reader.read("key", "new", adapter, file)).toMatchObject({ error: expect.any(Error) });
  } finally { await reader.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a bookmark changed during native preparation retains the old publication until the new generation is ready", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-first-token-generation-")), db = fixture();
  const file = path.join(dir, "codex", "pc", "f.jsonl"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{}\n");
  const waiting: Array<(turns: FirstTokenTurn[]) => void> = [];
  const adapter: FirstTokenAdapter = { ...codexFirstTokenAdapter, prepare: () => new Promise(resolve => waiting.push(resolve)) };
  const reader = new NativeFirstTokenReader(() => {}, 2, () => ({ close: async () => {} }) as import("../ingest/parse-pool").ParsePool);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  let writing = true;
  const run = () => advanceFirstTokenTimes(db, { reader, adapters: [adapter], archiveRoot: dir, physicalPath: p => p, canWrite: () => writing });
  try {
    db.query("INSERT INTO files VALUES(?,?,?,?)").run("h", file, 3, 1);
    replaceFirstTokenFile(db, "codex", "h", file, source, [sample("t", 900)]);
    db.query("UPDATE files SET mtime=2").run();
    expect(run().processed).toBe(0); await settle();
    db.query("UPDATE files SET mtime=3").run();
    waiting.shift()!([sample("t", 1000)]); await settle();
    expect(run().processed).toBe(0); await settle();
    expect(db.query("SELECT ms FROM response_time_turns").get()).toEqual({ ms: 900 });
    expect(db.query("SELECT COUNT(*) n FROM response_time_queue").get()).toEqual({ n: 1 });
    waiting.shift()!([sample("t", 2000)]); await settle();
    writing = false; expect(run().processed).toBe(0);
    writing = true; expect(run()).toMatchObject({ processed: 1, pending: false, failed: 0 });
    expect(db.query("SELECT ms FROM response_time_turns").get()).toEqual({ ms: 2000 });
  } finally { await reader.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("closing before deferred submission never starts a native process", async () => {
  let pools = 0, wakes = 0;
  const reader = new NativeFirstTokenReader(() => { wakes++; }, 1, () => {
    pools++; throw new Error("Reader was already closed");
  });
  reader.read("key", "generation", codexFirstTokenAdapter, "unused");
  await reader.close(); await new Promise(resolve => setTimeout(resolve, 0));
  expect({ pools, wakes }).toEqual({ pools: 0, wakes: 0 });
});

test("a full native reader skips filesystem probes for files it cannot accept", async () => {
  const db = fixture(); let probes = 0, parsed = 0;
  const reader = new NativeFirstTokenReader(() => {}, 1,
    () => ({ close: async () => {} }) as import("../ingest/parse-pool").ParsePool);
  const adapter: FirstTokenAdapter = { ...codexFirstTokenAdapter, prepare: async () => { parsed++; return []; } };
  try {
    for (let i = 0; i < 128; i++) db.query("INSERT INTO files VALUES (?,?,?,?)").run("h", `/archive/codex/pc/${i}`, 1, 1);
    const options = { adapters: [adapter], archiveRoot: "/archive", reader,
      physicalPath: (p: string) => { probes++; return p; }, budgetMs: 1000 };
    expect(advanceFirstTokenTimes(db, options).processed).toBe(0);
    expect(probes).toBe(1); expect(parsed).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(parsed).toBe(1);
    expect(advanceFirstTokenTimes(db, options)).toMatchObject({ processed: 1, completed: 1, remaining: 127 });
  } finally { await reader.close(); db.close(); }
});
