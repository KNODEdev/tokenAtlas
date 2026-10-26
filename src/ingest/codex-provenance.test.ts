import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "../db/sqlite";
import { CODEX_SOURCE_EVIDENCE_SCHEMA_SQL, fileProviderIds, retireCodexEventEvidence } from "../db/codex-source-evidence";
import { ensureCodexSchema, syncCodex } from "./codex";
import { ParsePool } from "./parse-pool";
import { CODEX_PARSER_VERSION } from "./codex-storage";
import { prepareCodexBytes, prepareCodexFixture } from "./native-test-support";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const usage = (input = 10) => ({ input_tokens: input, cached_input_tokens: 2, output_tokens: 5 });
const rich = (response = "response-1", input = 10) => line({ timestamp: "2026-09-08T00:00:00Z", type: "token_usage_record", payload: {
  thread_id: "thread-1", session_id: "session-1", response_id: response, turn_id: "turn-1",
  usage: usage(input), thread_token_usage: { input_tokens: input, output_tokens: 5 },
  opaque_provider_metadata: { nested: { revision: input } },
} });
const header = (id: string) => line({ type: "session_meta", payload: { id, originator: "codex-tui", thread_source: "user" } });
const context = line({ type: "turn_context", payload: { model: "gpt-test" } });
const count = line({ timestamp: "2026-09-08T00:00:00Z", type: "event_msg", payload: {
  type: "token_count", info: { last_token_usage: usage(), total_token_usage: { input_tokens: 10, output_tokens: 5 } },
  rate_limits: { primary: { used_percent: 12, window_minutes: 300 }, plan_type: "plus" },
} });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-persisted-proof-"));
  const home = path.join(directory, "codex", "synthetic-source"), folder = path.join(home, "sessions");
  fs.mkdirSync(folder, { recursive: true });
  const a = path.join(folder, "a.jsonl"), b = path.join(folder, "b.jsonl");
  const aText = header("session-a") + context + count + rich();
  const bText = header("session-b") + context + rich("response-b", 20);
  fs.writeFileSync(a, aText); fs.writeFileSync(b, bText);
  const db = new Database(":memory:"); ensureCodexSchema(db);
  const savedWorkers = process.env.TOKENATLAS_PARSE_WORKERS;
  process.env.TOKENATLAS_PARSE_WORKERS = "1";
  const close = () => {
    if (savedWorkers === undefined) delete process.env.TOKENATLAS_PARSE_WORKERS; else process.env.TOKENATLAS_PARSE_WORKERS = savedWorkers;
    db.close(); fs.rmSync(directory, { recursive: true, force: true });
  };
  return { home, a, b, aText, bText, db, close };
}
const dump = (db: Database) => Object.fromEntries(["events", "ratelimit", "files", "codex_file_evidence"]
  .map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY home,path,rowid`).all()]));

test("a file's calls are stored once in events, with provider identifiers per call and thread and session per file", async () => {
  const f = fixture();
  try {
    const parsed = prepareCodexFixture(f.a, Buffer.byteLength(f.aText)); if (parsed.kind !== "ok") throw new Error("parse failed");
    const result = await syncCodex(f.db, { homes: [f.home], files: [f.a] });
    expect(result).toMatchObject({ processed_inputs: 1, written_rows: 2, unavailable_inputs: [] });
    const event = f.db.query("SELECT * FROM events").get() as Record<string, unknown>;
    expect(event).toMatchObject({ in_tok: 10, cached_in: 2, out_tok: 5, source_offset: Buffer.byteLength(header("session-a") + context),
      response_id: "response-1", turn_id: "turn-1", usage_source: "token_usage_record+token_count", usage_status: "valid", provider_ids_observed: null });
    expect(Object.keys(event)).not.toContain("accounting_record_sha256");
    const file = f.db.query(`SELECT source_sha256,CAST(source_byte_length AS TEXT) AS bytes,parser_version,evidence_version,session_headers_json,
      provider_thread_id,provider_session_id FROM codex_file_evidence`).get();
    expect(file).toEqual({ source_sha256: sha(f.aText), bytes: String(Buffer.byteLength(f.aText)), parser_version: CODEX_PARSER_VERSION,
      evidence_version: 1, session_headers_json: JSON.stringify(parsed.parse.evidence.sessionHeaders),
      provider_thread_id: "thread-1", provider_session_id: "session-1" });
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name IN ('codex_usage_facts','codex_event_evidence')").all()).toEqual([]);
    expect(f.db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: parsed.parse.events.length });
    expect(f.db.query("SELECT COUNT(*) AS n FROM ratelimit").get()).toEqual({ n: parsed.parse.rateLimits.length });
  } finally { f.close(); }
});
test("a file's thread and session are the one value its calls carry, else the session header, else none", () => {
  const call = (thread: string | null, session: string | null) => ({ providerThreadId: thread, providerSessionId: session });
  expect(fileProviderIds([call("t", "s"), call("t", null)], ["header"])).toEqual({ thread: "t", session: "s" });
  expect(fileProviderIds([call(null, null)], ["header", null])).toEqual({ thread: null, session: "header" });
  expect(fileProviderIds([call("t1", "s1"), call("t2", "s1")], ["h1", "h2"])).toEqual({ thread: null, session: "s1" });
  expect(fileProviderIds([], ["h1", "h2"])).toEqual({ thread: null, session: null });
});
test("retiring per-call evidence keeps file thread and session and only the calls whose identifiers differ from their response id", () => {
  const db = new Database(":memory:");
  try {
    db.exec(CODEX_SOURCE_EVIDENCE_SCHEMA_SQL);
    db.exec("CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,response_id TEXT,provider_ids_observed INTEGER)");
    db.exec(`CREATE TABLE codex_event_evidence(home TEXT,path TEXT,source_offset INTEGER,provider_thread_id TEXT,provider_session_id TEXT,provider_response_id TEXT)`);
    const evidence = db.query("INSERT INTO codex_event_evidence VALUES('h',?,?,?,?,?)"), event = db.query("INSERT INTO events VALUES('h',?,?,?,NULL)");
    for (const [file, offset, response, thread, session] of [["a", 1, "r1", "t", "s"], ["a", 2, null, "t", "s"], ["a", 3, "r3", null, null],
      ["b", 1, null, null, null], ["b", 2, null, "t1", null], ["b", 3, null, "t2", null]] as const) {
      event.run(file, offset, response); evidence.run(file, offset, thread, session, response);
    }
    for (const file of ["a", "b"]) db.query("INSERT INTO codex_file_evidence VALUES('h',?,'digest',1,1,1,'[]',NULL,NULL)").run(file);
    retireCodexEventEvidence(db);
    expect(db.query("SELECT path,source_offset,provider_ids_observed FROM events WHERE provider_ids_observed IS NOT NULL ORDER BY path,source_offset").all())
      .toEqual([{ path: "a", source_offset: 2, provider_ids_observed: 1 }, { path: "a", source_offset: 3, provider_ids_observed: 0 },
        { path: "b", source_offset: 2, provider_ids_observed: 1 }, { path: "b", source_offset: 3, provider_ids_observed: 1 }]);
    expect(db.query("SELECT path,provider_thread_id,provider_session_id FROM codex_file_evidence ORDER BY path").all())
      .toEqual([{ path: "a", provider_thread_id: "t", provider_session_id: "s" }, { path: "b", provider_thread_id: null, provider_session_id: null }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='codex_event_evidence'").get()).toBeNull();
    retireCodexEventEvidence(db);
  } finally { db.close(); }
});
test("identical retry preserves proof and bookmark; force, nested correction and append replace only selected-file evidence", async () => {
  const f = fixture();
  try {
    await syncCodex(f.db, { homes: [f.home], files: [f.a, f.b] });
    const initial = dump(f.db);
    const repeated = await syncCodex(f.db, { homes: [f.home], files: [f.a, f.b] });
    expect(repeated).toMatchObject({ processed_inputs: 0, skipped_inputs: 2, written_rows: 0 });
    expect(dump(f.db)).toEqual(initial);
    const forced = await syncCodex(f.db, { homes: [f.home], files: [f.a], force: true });
    expect(forced).toMatchObject({ processed_inputs: 1, written_rows: 2 });
    expect(dump(f.db)).toEqual(initial);
    const unchangedB = f.db.query("SELECT * FROM codex_file_evidence WHERE path=?").get(f.b);
    const unchangedBEvents = f.db.query("SELECT * FROM events WHERE path=?").all(f.b);
    const correctedRich = rich().replace('"revision":10', '"revision":11');
    const correction = header("session-a") + context + count + correctedRich;
    fs.writeFileSync(f.a, correction);
    await syncCodex(f.db, { homes: [f.home], files: [f.a], force: true });
    expect(f.db.query("SELECT source_sha256 FROM codex_file_evidence WHERE path=?").get(f.a)).toEqual({ source_sha256: sha(correction) });
    const appended = correction + rich("response-2", 15);
    fs.writeFileSync(f.a, appended);
    const result = await syncCodex(f.db, { homes: [f.home], files: [f.a] });
    expect(result.processed_inputs).toBe(1);
    expect(f.db.query("SELECT response_id FROM events WHERE path=? ORDER BY source_offset").all(f.a))
      .toEqual([{ response_id: "response-1" }, { response_id: "response-2" }]);
    expect(f.db.query("SELECT source_sha256 FROM codex_file_evidence WHERE path=?").get(f.a)).toEqual({ source_sha256: sha(appended) });
    expect(f.db.query("SELECT * FROM codex_file_evidence WHERE path=?").get(f.b)).toEqual(unchangedB);
    expect(f.db.query("SELECT * FROM events WHERE path=?").all(f.b)).toEqual(unchangedBEvents);
  } finally { f.close(); }
});
test("failed evidence insert rolls back event replacement and bookmark advancement together", async () => {
  const f = fixture();
  try {
    await syncCodex(f.db, { homes: [f.home], files: [f.a, f.b] });
    const accepted = dump(f.db);
    fs.appendFileSync(f.a, rich("response-2", 20));
    f.db.exec("CREATE TRIGGER synthetic_proof_failure BEFORE INSERT ON codex_file_evidence BEGIN SELECT RAISE(ABORT,'synthetic evidence failure'); END");
    await expect(syncCodex(f.db, { homes: [f.home], files: [f.a], force: true })).rejects.toThrow("synthetic evidence failure");
    expect(dump(f.db)).toEqual(accepted);
    f.db.exec("DROP TRIGGER synthetic_proof_failure");
    await syncCodex(f.db, { homes: [f.home], files: [f.a] });
    expect(f.db.query("SELECT COUNT(*) AS n FROM events WHERE path=?").get(f.a)).toEqual({ n: 2 });
  } finally { f.close(); }
});
test("source mutation during native preparation keeps all previously accepted rows, evidence and bookmark", async () => {
  const f = fixture();
  let reader: ReturnType<typeof spyOn> | undefined;
  try {
    await syncCodex(f.db, { homes: [f.home], files: [f.a] });
    const accepted = dump(f.db);
    fs.appendFileSync(f.a, rich("response-2", 20));
    const originalRun = ParsePool.prototype.run;
    let changed = false;
    reader = spyOn(ParsePool.prototype, "run").mockImplementation(async function(this: ParsePool, format, input) {
      const result = await originalRun.call(this, format, input);
      if (format === "codex" && (input as { file: string }).file === f.a && !changed) {
        changed = true; fs.appendFileSync(f.a, rich("response-3", 30));
      }
      return result;
    } as typeof originalRun);
    const result = await syncCodex(f.db, { homes: [f.home], files: [f.a], force: true });
    expect(result).toMatchObject({ processed_inputs: 0, written_rows: 0,
      unavailable_inputs: [{ path: f.a, message: "source changed during preparation" }] });
    expect(dump(f.db)).toEqual(accepted);
  } finally { reader?.mockRestore(); f.close(); }
});
test("short read without complete-source evidence cannot invent a verified full-source hash", async () => {
  const f = fixture();
  let reader: ReturnType<typeof spyOn> | undefined;
  try {
    await syncCodex(f.db, { homes: [f.home], files: [f.a] });
    const accepted = dump(f.db), originalRun = ParsePool.prototype.run;
    // Simulate an outdated native reply that covers only a prefix of the inventoried file.
    reader = spyOn(ParsePool.prototype, "run").mockImplementation(async function(this: ParsePool, format, input) {
      if (format === "codex" && (input as { file: string }).file === f.a) return prepareCodexBytes(Buffer.from(header("session-a")));
      return originalRun.call(this, format, input);
    } as typeof originalRun);
    const result = await syncCodex(f.db, { homes: [f.home], files: [f.a], force: true });
    expect(result.processed_inputs).toBe(0);
    expect(result.unavailable_inputs[0]?.message).toContain("complete original source evidence is unavailable");
    expect(dump(f.db)).toEqual(accepted);
  } finally { reader?.mockRestore(); f.close(); }
});
test("the file proof retains all session headers; conflicting duplicate usage makes the call invalid, including full-source incomplete tails", async () => {
  const f = fixture();
  try {
    const raw = header("session-a") + header("session-b") + context + rich() + rich("response-1", 20) + '{"unfinished":';
    fs.writeFileSync(f.a, raw);
    const result = await syncCodex(f.db, { homes: [f.home], files: [f.a] });
    expect(result).toMatchObject({ written_rows: 1, processed_inputs: 1 });
    const file = f.db.query("SELECT source_sha256,source_byte_length,session_headers_json FROM codex_file_evidence").get() as {
      source_sha256: string; source_byte_length: number; session_headers_json: string };
    expect(file.source_sha256).toBe(sha(raw));
    expect(file.source_byte_length).toBe(Buffer.byteLength(raw));
    expect(JSON.parse(file.session_headers_json).map((item: { providerSessionId: string }) => item.providerSessionId)).toEqual(["session-a", "session-b"]);
    expect(f.db.query("SELECT response_id,usage_status FROM events").all()).toEqual([{ response_id: "response-1", usage_status: "invalid" }]);
    const saved = f.db.query("SELECT size,offset FROM files").get() as { size: number; offset: number };
    expect(saved.size - saved.offset).toBe(Buffer.byteLength('{"unfinished":'));
  } finally { f.close(); }
});
test("file evidence stores int64 lengths as exact integers beyond JavaScript Number precision", () => {
  const db = new Database(":memory:");
  try {
    db.exec(CODEX_SOURCE_EVIDENCE_SCHEMA_SQL);
    const length = 9_007_199_254_740_993n;
    db.query("INSERT INTO codex_file_evidence VALUES (?,?,?,?,?,?,?,?,?)").run("home", "path", sha("synthetic"), length, 5, 1, "[]", null, null);
    expect(db.query("SELECT CAST(source_byte_length AS TEXT) AS bytes,typeof(source_byte_length) AS type FROM codex_file_evidence").get())
      .toEqual({ bytes: length.toString(), type: "integer" });
  } finally { db.close(); }
});
