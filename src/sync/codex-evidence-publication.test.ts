import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "../db/sqlite";
import { SyncCoordinator } from "./coordinator";
import type { VendorAdapter } from "./adapters";
import { adaptersWith, createTestDatabase, importCodexHome, noMirror } from "./test-support";
import { removeTestFixture } from "../test-cleanup";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const header = line({ type: "session_meta", payload: { id: "synthetic-session", originator: "codex-tui", thread_source: "user" } })
  + line({ type: "turn_context", payload: { model: "gpt-test" } });
const rich = (response = "synthetic-response", input = 10, metadata = 1, day = "2026-09-08") => line({ type: "token_usage_record",
  timestamp: `${day}T00:00:00Z`, payload: { thread_id: "synthetic-thread", response_id: response,
    usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 }, metadata: { revision: metadata } } });
async function fixture() {
  const { directory, dbPath } = createTestDatabase(), home = path.join(directory, "codex");
  const file = path.join(home, "sessions", "synthetic.jsonl"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = header + rich(); fs.writeFileSync(file, original); await importCodexHome(dbPath, home);
  const db = new Database(dbPath);
  let revision = 1;
  const adapter: VendorAdapter = async context => {
    const result = await importCodexHome(context.stageDbPath, home);
    return { processedInputs: result.processed_inputs, skippedInputs: result.skipped_inputs, writtenRows: result.written_rows,
      dirtyRange: result.dirty_range, diagnostics: {}, validationErrors: [] };
  };
  let coordinator: SyncCoordinator | undefined;
  const start = (afterPublishBeforeRevision?: () => void) => {
    coordinator = new SyncCoordinator({ archiveInputs: () => undefined, dbPath, rootDir: process.cwd(), adapters: adaptersWith({ codex: adapter }),
      mirror: noMirror, configFingerprint: () => "synthetic", sourceFingerprint: () => String(revision),
      prepareStage: () => {}, refreshDerived: () => {}, afterPublishBeforeRevision });
    return coordinator;
  };
  const changed = () => { revision++; };
  const close = () => { db.close(); coordinator?.close(); removeTestFixture(directory, { recursive: true, force: true }); };
  return { directory, dbPath, home, file, original, db, start, changed, close };
}
const request = { trigger: "manual" as const, mode: "incremental" as const, scope: { kind: "vendor" as const, vendor: "codex" as const } };
const raw = (db: Database) => ["events", "ratelimit"].map(table =>
  db.query(`SELECT rowid AS original_rowid,* FROM ${table} ORDER BY rowid`).all());
const proof = (db: Database) => ["codex_file_evidence", "files"].map(table =>
  db.query(`SELECT * FROM ${table} ORDER BY home,path`).all());
const ledgerWork = (db: Database) => db.query("SELECT kind,value FROM usage_ledger_dirty WHERE provider='codex' ORDER BY kind,value").all();
test("source-only raw metadata correction publishes proof and queues its copy without changing usage rows", async () => {
  const f = await fixture();
  try {
    const before = raw(f.db), beforeWork = ledgerWork(f.db), coordinator = f.start();
    const corrected = header + rich("synthetic-response", 10, 2); fs.writeFileSync(f.file, corrected); f.changed();
    const run = await coordinator.enter(request).completion;
    expect(run.status).toBe("success");
    expect(raw(f.db)).toEqual(before);
    expect(f.db.query("SELECT source_sha256 FROM codex_file_evidence WHERE path=?").get(f.file)).toEqual({ source_sha256: sha(corrected) });
    expect(ledgerWork(f.db)).not.toEqual(beforeWork);
    expect(f.db.query("SELECT value FROM usage_ledger_dirty WHERE provider='codex' AND kind='copy'").all())
      .toEqual([{ value: JSON.stringify([f.home, f.file]) }]);
    const accepted = proof(f.db), acceptedWork = ledgerWork(f.db);
    f.changed();
    expect((await coordinator.enter(request).completion).status).toBe("success");
    expect(raw(f.db)).toEqual(before);
    expect(proof(f.db)).toEqual(accepted);
    expect(ledgerWork(f.db)).toEqual(acceptedWork);
  } finally { f.close(); }
}, 30_000);
test("raw rows, source evidence, bookmark and durable ledger notification roll back on source publication failure", async () => {
  const f = await fixture();
  try {
    const before = raw(f.db), accepted = proof(f.db), beforeWork = ledgerWork(f.db);
    const coordinator = f.start(() => { throw new Error("synthetic revision failure"); });
    fs.appendFileSync(f.file, rich("synthetic-second", 20)); f.changed();
    const failed = await coordinator.enter(request).completion;
    expect(failed.status).toBe("failure");
    expect(raw(f.db)).toEqual(before);
    expect(proof(f.db)).toEqual(accepted);
    expect(ledgerWork(f.db)).toEqual(beforeWork);
  } finally { f.close(); }
}, 30_000);
test("full source replacement transfers original source proof and marks copied scope in its transaction", async () => {
  const f = await fixture();
  try {
    const coordinator = f.start(), beforeWork = ledgerWork(f.db), updated = header + rich("synthetic-response", 10, 2) + rich("synthetic-second", 20);
    fs.writeFileSync(f.file, updated); f.changed();
    const run = await coordinator.enter({ ...request, mode: "full" }).completion;
    expect(run.status).toBe("success");
    expect(f.db.query("SELECT source_sha256 FROM codex_file_evidence WHERE path=?").get(f.file)).toEqual({ source_sha256: sha(updated) });
    expect(f.db.query("SELECT COUNT(*) AS n FROM events WHERE path=?").get(f.file)).toEqual({ n: 2 });
    expect(ledgerWork(f.db)).not.toEqual(beforeWork);
  } finally { f.close(); }
}, 30_000);
test("bounded hybrid publication cannot attach complete source proof to facts retained from another reading", async () => {
  const f = await fixture();
  try {
    const original = header + rich("synthetic-old", 10, 1, "2026-09-07") + rich("synthetic-new", 20, 1, "2026-09-08");
    fs.writeFileSync(f.file, original); await importCodexHome(f.dbPath, f.home);
    const coordinator = f.start();
    fs.writeFileSync(f.file, header + rich("synthetic-old", 99, 2, "2026-09-07") + rich("synthetic-new", 30, 2, "2026-09-08")); f.changed();
    const run = await coordinator.enter({ ...request, reparse: { from: "2026-09-08", until: "2026-09-08" } }).completion;
    expect(run.status).toBe("success");
    expect(f.db.query("SELECT in_tok FROM events ORDER BY ts").all()).toEqual([{ in_tok: 10 }, { in_tok: 30 }]);
    expect(f.db.query("SELECT * FROM codex_file_evidence WHERE path=?").get(f.file)).toBeNull();
  } finally { f.close(); }
}, 30_000);
