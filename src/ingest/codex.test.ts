import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { CodexSourceError, ensureCodexSchema, selectedRollouts, syncCodex } from "./codex";
import { CODEX_PARSER_VERSION, pyDumps } from "./codex-storage";
import { prepareCodexBytes, prepareCodexFixture } from "./native-test-support";
import { toArchiveLogicalPath } from "../config/paths";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const rollout = (input: number) =>
  line({ timestamp: "2026-09-08T00:00:00.000Z", type: "session_meta", payload: { originator: "codex-tui", thread_source: "user", cwd: "C:/work/alpha", cli_version: "1.2.3" } })
  + line({ type: "turn_context", payload: { model: "gpt-test", effort: "high" } })
  + line({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } })
  + line({ type: "response_item", payload: { type: "message", content: "PROMPT_BODY with token_count mention" } })
  + line({ timestamp: "2026-09-08T02:01:00+02:00", type: "event_msg", payload: {
    type: "token_count",
    info: { last_token_usage: { input_tokens: input, cached_input_tokens: 2, output_tokens: 5 }, total_token_usage: { input_tokens: input, output_tokens: 5 } },
    rate_limits: { limit_id: "codex", plan_type: "plus", primary: { window_minutes: 300, used_percent: 12.5, resets_at: 1790000000 } },
  } });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-codex-"));
  const home = path.join(directory, "codex", "PC-user");
  const files = ["a", "b", "c"].map((name, index) => {
    const file = path.join(home, "sessions", "2026", "09", "08", `rollout-${name}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rollout(10 * (index + 1)));
    return file;
  });
  const db = new Database(path.join(directory, "atlas.sqlite"));
  ensureCodexSchema(db);
  return { directory, home, files, db, close: () => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
// Two fixtures are written at different instants, so file times are left out of comparisons.
const dump = (db: Database) => Object.fromEntries(["events", "ratelimit", "files"].map(table =>
  [table, (db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>)
    .map(({ mtime: _mtime, ...row }) => row)]));

test("a rollout becomes events, readings and a bookmark; an unchanged file is skipped until forced", async () => {
  const f = fixture();
  try {
    const first = await syncCodex(f.db, { homes: [f.home] });
    expect(first).toMatchObject({ status: "success", processed_inputs: 3, skipped_inputs: 0, written_rows: 6,
      // The session header's own time is no stored fact: the range spans the call and its reading.
      dirty_range: { from: "2026-09-08T00:01:00.000Z", to: "2026-09-08T00:01:00.000Z" }, unavailable_inputs: [] });
    const event = f.db.query("SELECT * FROM events ORDER BY rowid LIMIT 1").get() as Record<string, unknown>;
    expect(event).toMatchObject({ ts: "2026-09-08T00:01:00.000Z", surface: "cli-tui", nested: "user", model: "gpt-test", effort: "high",
      project: "alpha", in_tok: 10, cached_in: 2, out_tok: 5, service_tier: "priority", speed: "fast", plan_type: "plus",
      billing_mode: "allowance", usage_source: "token_count", producer_version: "1.2.3", usage_status: "valid", cache_write_status: "missing" });
    expect(f.db.query("SELECT used_percent, typeof(used_percent) AS type, window_minutes, limit_id FROM ratelimit LIMIT 1").get())
      .toEqual({ used_percent: 12.5, type: "real", window_minutes: 300, limit_id: "codex" });
    const bookmark = f.db.query("SELECT parser_version, parser_state, offset, size FROM files ORDER BY rowid LIMIT 1").get() as Record<string, unknown>;
    expect(bookmark.parser_version).toBe(CODEX_PARSER_VERSION);
    expect(bookmark.offset).toBe(bookmark.size);
    expect(String(bookmark.parser_state)).toStartWith('{"surface": "cli-tui", "nested": "user", "model": "gpt-test"');
    const again = await syncCodex(f.db, { homes: [f.home] });
    expect(again).toMatchObject({ processed_inputs: 0, skipped_inputs: 3, written_rows: 0, dirty_range: null });
    const forced = await syncCodex(f.db, { homes: [f.home], force: true });
    expect(forced).toMatchObject({ processed_inputs: 3, written_rows: 6 });
    expect(f.db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 3 });
  } finally { f.close(); }
});

test("discovery is reported before the file total, then files in order", async () => {
  const f = fixture();
  try {
    const updates: string[] = [];
    await syncCodex(f.db, { homes: [f.home], onDiscovery: found => updates.push(`discover:${found}`),
      onFileProgress: (completed, total) => updates.push(`files:${completed}/${total}`) });
    expect(updates[0]).toBe("discover:0");
    expect(updates).toContain("discover:3");
    expect(updates.indexOf("files:0/3")).toBeGreaterThan(updates.lastIndexOf("discover:3"));
    expect(updates.at(-1)).toBe("files:3/3");
  } finally { f.close(); }
});

test("bulk stage writes retain direct-insert values, rowids and indexes across multiple batches", async () => {
  const f = fixture();
  const reference = new Database(":memory:");
  try {
    const file = f.files[0]!;
    for (let index = 0; index < 215; index++) fs.appendFileSync(file, line({
      timestamp: new Date(Date.UTC(2026, 8, 8, 0, 2, index)).toISOString(), type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: index + 1, output_tokens: 2 } } },
    }));
    const prepared = prepareCodexFixture(file, fs.statSync(file).size);
    if (prepared.kind !== "ok") throw new Error("fixture preparation failed");
    expect(prepared.parse.events.length).toBeGreaterThan(200);
    ensureCodexSchema(reference);
    const eventColumns = "home,path,ts,surface,nested,model,effort,project,in_tok,cached_in,cache_write,out_tok,reasoning_out,cwd,"
      + "service_tier,speed,speed_source,speed_source_offset,source_offset,plan_type,billing_mode,meter_reset,account_id,"
      + "response_id,turn_id,usage_source,producer_version,cache_write_status,usage_status,resp_ms";
    const home = toArchiveLogicalPath(f.home), stored = toArchiveLogicalPath(file);
    reference.transaction(() => {
      const event = reference.query(`INSERT INTO events(${eventColumns}) VALUES(${Array(30).fill("?").join(",")})`);
      for (const row of prepared.parse.events) event.run(home, stored, ...(row as never[]));
    })();
    const indexes = f.db.query("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all();
    await syncCodex(f.db, { homes: [f.home], files: [file], force: true });
    const sql = `SELECT rowid,${eventColumns} FROM events ORDER BY rowid`;
    expect(f.db.query(sql).all()).toEqual(reference.query(sql).all());
    expect(f.db.query("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all()).toEqual(indexes);
  } finally { reference.close(); f.close(); }
});

test("selected rollouts check their home once, never the listed transcripts or their folders, and keep conflict checks", () => {
  const f = fixture();
  const original = fs.lstatSync.bind(fs);
  const calls: string[] = [];
  const inspect = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    calls.push(String(file));
    return Reflect.apply(original, fs, [file, ...args]);
  }) as typeof fs.lstatSync);
  const stat = spyOn(fs, "statSync");
  try {
    expect(selectedRollouts([f.home], f.files).get(path.resolve(f.home))).toEqual(f.files);
    expect(calls.filter(file => file === path.resolve(f.home))).toHaveLength(1);
    expect(calls.filter(file => f.files.some(selected => file === selected || file.startsWith(path.join(f.home, "sessions"))))).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
    const conflict = path.join(f.home, "sessions", `blocked.conflict-${"a".repeat(64)}`, "rollout.jsonl");
    fs.mkdirSync(path.dirname(conflict), { recursive: true }); fs.writeFileSync(conflict, rollout(1));
    expect(() => selectedRollouts([f.home], [f.files[0]!, conflict])).toThrow("not an eligible archive file");
  } finally { inspect.mockRestore(); stat.mockRestore(); f.close(); }
});

test("a semantic stage guard keeps its lookup index and failed batches roll back", async () => {
  const f = fixture();
  try {
    f.db.exec(`CREATE TRIGGER guard_event BEFORE INSERT ON events BEGIN
      SELECT 1 FROM events INDEXED BY events_path WHERE home=NEW.home AND path=NEW.path;
      SELECT RAISE(ABORT,'rejected event'); END`);
    const schema = f.db.query("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name").all();
    await expect(syncCodex(f.db, { homes: [f.home], files: [f.files[0]!], force: true })).rejects.toThrow("rejected event");
    expect(f.db.query("SELECT count(*) n FROM events").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) n FROM files").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name").all()).toEqual(schema);
  } finally { f.close(); }
});

test("semantic triggers cannot leave rows they seeded for a later selected file", async () => {
  const f = fixture();
  try {
    f.db.exec(`CREATE TRIGGER seed_next_file AFTER INSERT ON events WHEN NEW.path LIKE '%rollout-a.jsonl' BEGIN
      INSERT INTO ratelimit(home,path,ts,window_minutes,used_percent,limit_id)
      VALUES(NEW.home,replace(NEW.path,'rollout-a.jsonl','rollout-b.jsonl'),'2026-09-07T00:00:00.000Z',300,99,'seed'); END`);
    await syncCodex(f.db, { homes: [f.home], files: f.files.slice(0, 2), force: true });
    expect(f.db.query("SELECT used_percent FROM ratelimit ORDER BY rowid").all()).toEqual([{ used_percent: 12.5 }, { used_percent: 12.5 }]);
  } finally { f.close(); }
});

test("native worker counts preserve identical stored facts", async () => {
  const previous = process.env.TOKENATLAS_PARSE_WORKERS;
  const pooled = fixture(), serial = fixture();
  try {
    process.env.TOKENATLAS_PARSE_WORKERS = "3";
    const a = await syncCodex(pooled.db, { homes: [pooled.home] });
    process.env.TOKENATLAS_PARSE_WORKERS = "0";
    const b = await syncCodex(serial.db, { homes: [serial.home] });
    expect(a.preparation.preparedFiles).toBeGreaterThan(0);
    expect(b.preparation.preparedFiles).toBeGreaterThan(0);
    expect(b.preparation.maxWorkers).toBe(1);
    const strip = (rows: ReturnType<typeof dump>, root: string) => JSON.parse(JSON.stringify(rows).split(JSON.stringify(root).slice(1, -1)).join("ROOT"));
    expect(strip(dump(pooled.db), pooled.directory)).toEqual(strip(dump(serial.db), serial.directory));
  } finally {
    if (previous === undefined) delete process.env.TOKENATLAS_PARSE_WORKERS; else process.env.TOKENATLAS_PARSE_WORKERS = previous;
    pooled.close(); serial.close();
  }
});

test("a queued transcript that cannot be read keeps the previous index and names the file", async () => {
  const f = fixture();
  try {
    const missing = path.join(f.home, "sessions", "2026", "09", "08", "rollout-missing.jsonl");
    const error = await syncCodex(f.db, { homes: [f.home], files: [f.files[0]!, missing] }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CodexSourceError);
    expect((error as Error).message).toStartWith("Codex transcript unavailable: ");
    expect((error as Error).message).toContain("Previous Codex index was kept");
    expect((error as Error).message).toEndWith(`File: ${missing}`);
    expect(f.db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test("stored text follows the engine's Python formatting", () => {
  expect(pyDumps({ a: "żółw\n", b: [1, null, true], c: 0.5, d: 0.00001, e: { f: "x" } }))
    .toBe('{"a": "\\u017c\\u00f3\\u0142w\\n", "b": [1, null, true], "c": 0.5, "d": 1e-05, "e": {"f": "x"}}');
});

test("native timestamps preserve explicit zones, invalid dates and missing zones", () => {
  for (const [timestamp, expected] of [
    ["2026-09-08T02:00:00.1234+02:00", "2026-09-08T00:00:00.123Z"],
    [" 2026-09-08 00:00:00Z ", "2026-09-08T00:00:00.000Z"],
    ["2026-02-30T00:00:00Z", "2026-02-30T00:00:00Z"],
    ["2026-09-08T00:00:00", "2026-09-08T00:00:00"],
  ]) {
    const prepared = prepareCodexBytes(Buffer.from(JSON.stringify({ timestamp, type: "event_msg", payload: {
      type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
    } }) + "\n"));
    if (prepared.kind !== "ok") throw new Error(prepared.message);
    expect(prepared.parse.events[0]?.[0]).toBe(expected);
  }
});
