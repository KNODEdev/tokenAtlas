import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { ensureCodexSchema, syncCodex } from "./codex";
import { prepareCodexFixture } from "./native-test-support";
import { selectRolloutRepresentation } from "./codex-rollout";
import { validateQueuedJsonl } from "../sync/adapters";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const zstdRollout = line({ type: "session_meta", payload: { id: "compression-session", originator: "Codex Desktop" } })
  + line({ type: "turn_context", payload: { model: "m", service_tier: "default" } })
  + line({ timestamp: "2026-09-08T00:00:00Z", type: "token_usage_record", payload: { thread_id: "compression-session", response_id: "r1",
    usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 1 } } });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-zstd-import-"));
  const home = path.join(root, "codex", "PC");
  const plain = path.join(home, "sessions", "rollout-compression-session.jsonl"), compressed = `${plain}.zst`;
  fs.mkdirSync(path.dirname(plain), { recursive: true });
  fs.writeFileSync(plain, zstdRollout);
  fs.writeFileSync(compressed, Bun.zstdCompressSync(zstdRollout));
  const db = new Database(path.join(root, "copy.sqlite")); ensureCodexSchema(db);
  return { root, home, plain, compressed, db, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("native zstd decoding preserves every JSONL fact, raw record hash and logical byte offset", () => {
  const f = fixture();
  try {
    const parse = (file: string) => prepareCodexFixture(file, fs.statSync(file).size);
    expect(parse(f.compressed)).toEqual(parse(f.plain));
    const encoded = fs.readFileSync(f.compressed);
    fs.writeFileSync(f.compressed, encoded.subarray(0, encoded.length - 1));
    expect(parse(f.compressed).kind).toBe("read_error");
    fs.writeFileSync(f.compressed, Buffer.concat([encoded, Buffer.from("garbage")]));
    expect(parse(f.compressed).kind).toBe("read_error");
    fs.writeFileSync(f.compressed, Bun.zstdCompressSync('{"broken":'));
    expect(parse(f.compressed).kind).toBe("read_error");
  } finally { f.close(); }
});

test("plain/compressed siblings import once, transitions retain canonical keys and compressed restarts skip parsing", async () => {
  const f = fixture();
  try {
    expect((await syncCodex(f.db, { homes: [f.home] })).processed_inputs).toBe(1);
    const rows = () => f.db.query("SELECT * FROM events ORDER BY source_offset").all();
    const accepted = rows();
    fs.unlinkSync(f.plain);
    const converted = await syncCodex(f.db, { homes: [f.home], files: [f.compressed], force: true });
    expect(converted.unavailable_inputs).toEqual([]);
    expect(converted.source_digests[0]?.byteLength).toBe(fs.statSync(f.compressed).size);
    expect(rows()).toEqual(accepted);
    expect(f.db.query("SELECT path,offset,size FROM files").get()).toEqual({ path: f.plain, offset: Buffer.byteLength(zstdRollout), size: fs.statSync(f.compressed).size });
    expect((await syncCodex(f.db, { homes: [f.home] })).skipped_inputs).toBe(1);
    fs.writeFileSync(f.plain, zstdRollout + line({ timestamp: "2026-09-08T00:01:00Z", type: "token_usage_record", payload: { response_id: "r2", usage: { input_tokens: 12, output_tokens: 2 } } }));
    expect(selectRolloutRepresentation(f.compressed)).toBe(f.plain);
    await syncCodex(f.db, { homes: [f.home], files: [f.compressed, f.plain], force: true });
    expect(rows()).toHaveLength(2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM files").get()).toEqual({ n: 1 });
    fs.writeFileSync(f.compressed, Bun.zstdCompressSync(zstdRollout.replace('"input_tokens":100', '"input_tokens":999')));
    const conflicting = await syncCodex(f.db, { homes: [f.home], files: [f.compressed], force: true });
    expect(conflicting.unavailable_inputs).toHaveLength(1);
    expect(rows()).toHaveLength(2);
  } finally { f.close(); }
});

test("the queued validator rejects incomplete compressed frames alongside ordinary JSONL", async () => {
  const f = fixture();
  try {
    expect(await validateQueuedJsonl("codex", [f.plain, f.compressed])).toEqual([undefined, undefined]);
    fs.writeFileSync(f.compressed, Buffer.from("incomplete-frame"));
    const checked = await validateQueuedJsonl("codex", [f.plain, f.compressed]);
    expect(checked[0]).toBeUndefined(); expect(checked[1]).toContain("Zstandard");
  } finally { f.close(); }
});
