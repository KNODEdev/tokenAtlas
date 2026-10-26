import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as nativeProcess from "node:child_process";
import { planArchiveCompression, startArchiveCompression, advanceArchiveCompression, archiveCompressionStatus } from "./archive-compression";
import { ensureArchiveIdentity } from "./archive-inventory";
import { archiveLocalStateDirectory } from "./archive-local-state";
import { publishArchiveFile } from "./archive-publication";
import { withDecodedRollouts } from "../ingest/codex-rollout";
import { readOriginalRecord } from "./archive-originals";
import { SyncFileQueue } from "./file-queue";

const text = JSON.stringify({ type: "session_meta", payload: { id: "compression", instructions: "x".repeat(6000) } }) + "\n"
  + '{"type":"token_usage_record","payload":{"response_id":"r1","usage":{"input_tokens":100,"output_tokens":10}}}\n';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-compression-test-")), archiveRoot = path.join(root, "archive"), local = path.join(root, "local");
  fs.mkdirSync(archiveRoot); ensureArchiveIdentity(archiveRoot);
  const options = { archiveRoot, localStateRoot: local, databasePath: path.join(root, "copy.sqlite"),
    env: { ...process.env, TOKENATLAS_ARCHIVE: archiveRoot, TOKENATLAS_CONFIG: path.join(root, "config"), TOKENATLAS_LOCAL_STATE: local,
      TOKENATLAS_TEMP_DIR: path.join(root, "scratch") } };
  const write = (relative: string, bytes = text, cold = true) => {
    const file = path.join(archiveRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    if (cold) fs.utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01")); return file;
  };
  const plain = write("codex/PC/sessions/one.jsonl");
  const decode = (file: string) => withDecodedRollouts([file], ([decoded]) => fs.readFileSync(decoded!), false, options);
  return { root, options, plain, write, decode, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test("a metadata plan selects cold Codex rollouts only, preserving warm files and other providers", () => {
  const f = fixture();
  try {
    f.write("codex/PC/archived_sessions/old.jsonl"); f.write("codex/PC/sessions/warm.jsonl", text, false);
    f.write("claude/PC/old.jsonl"); f.write("gauges/PC/old.jsonl");
    f.write(`codex/PC/sessions/old.jsonl.conflict-${"a".repeat(64)}.source`);
    f.write("codex/PC/delegate-ledger.jsonl"); f.write("codex/PC/sessions/old.jsonl.superseded-abc.reading");
    const before = fs.readFileSync(f.plain), plan = planArchiveCompression(f.options);
    expect(plan.files.map(file => file.relative)).toEqual(["codex/PC/archived_sessions/old.jsonl", "codex/PC/sessions/one.jsonl"]);
    expect(fs.readFileSync(f.plain)).toEqual(before); expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
  } finally { f.close(); }
});

test("a bounded job compresses losslessly, resumes, and its next mirror keeps the compressed archive", async () => {
  const f = fixture();
  try {
    const second = f.write("codex/PC/sessions/two.jsonl"), job = startArchiveCompression(f.options);
    expect((await advanceArchiveCompression(f.options, job.jobId, { maxFiles: 1 })).status).toBe("pending");
    expect(archiveCompressionStatus(f.options, job.jobId).job.compressed).toBe(1);
    const done = await advanceArchiveCompression(f.options, job.jobId, { maxFiles: 1 });
    expect(done.status).toBe("complete"); expect(done.job.compressed).toBe(2);
    expect(f.decode(`${f.plain}.zst`).toString()).toBe(text); expect(f.decode(`${second}.zst`).toString()).toBe(text);
    expect(fs.existsSync(f.plain)).toBe(false); expect(done.job.compressedBytes).toBeLessThan(done.job.sourceBytes);
    const original = path.join(f.root, "provider.jsonl"); fs.writeFileSync(original, text);
    const stamped = fs.statSync(`${f.plain}.zst`).mtimeMs;
    expect(publishArchiveFile(original, f.plain, { ...f.options, jsonl: true })).toBe("unchanged");
    expect(publishArchiveFile(original, f.plain, { ...f.options, jsonl: true })).toBe("unchanged");
    expect(fs.existsSync(f.plain)).toBe(false); expect(fs.statSync(`${f.plain}.zst`).mtimeMs).toBe(stamped);
    expect(readOriginalRecord(f.options.archiveRoot, `${f.plain}.zst`)).toBeNull();
    fs.appendFileSync(original, '{"new":1}\n');
    expect(publishArchiveFile(original, f.plain, { ...f.options, jsonl: true })).toBe("copied");
    expect(fs.readFileSync(f.plain, "utf8")).toBe(text + '{"new":1}\n'); expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
    expect((await advanceArchiveCompression(f.options, job.jobId)).job.compressed).toBe(2);
  } finally { f.close(); }
});

test("a file changed after planning is deferred without deleting or replacing its new history", async () => {
  const f = fixture();
  try {
    const job = startArchiveCompression(f.options); fs.appendFileSync(f.plain, '{"late":1}\n');
    const done = await advanceArchiveCompression(f.options, job.jobId);
    expect(done.job.skipped).toBe(1); expect(done.job.compressed).toBe(0);
    expect(fs.readFileSync(f.plain, "utf8")).toBe(text + '{"late":1}\n'); expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
  } finally { f.close(); }
});

test("compression and canonical publication verify one native decode per unchanged file", async () => {
  const f = fixture(), spawn = nativeProcess.spawnSync;
  let decodes = 0;
  const hook = spyOn(nativeProcess, "spawnSync").mockImplementation(((...args: Parameters<typeof spawn>) => {
    if (args[1]?.[0] === "--decode-rollout") decodes++;
    return spawn(...args);
  }) as typeof spawn);
  try {
    const job = startArchiveCompression(f.options), turn = await advanceArchiveCompression(f.options, job.jobId);
    expect(turn.status).toBe("complete"); expect(turn.errors).toEqual([]); expect(turn.job.compressed).toBe(1);
    expect(decodes).toBe(1);
    hook.mockRestore();
    expect(f.decode(`${f.plain}.zst`).toString()).toBe(text);
    expect(fs.existsSync(f.plain)).toBe(false);
  } finally { hook.mockRestore(); f.close(); }
});

test("pre-existing accepted-prefix disagreement preserves the plain archive and retains a retry", async () => {
  const f = fixture();
  try {
    const original = path.join(f.root, "provider.jsonl"); fs.writeFileSync(original, text);
    publishArchiveFile(original, f.plain, { ...f.options, jsonl: true });
    const rewritten = text.replace('"input_tokens":100', '"input_tokens":999');
    fs.writeFileSync(f.plain, rewritten); fs.utimesSync(f.plain, new Date("2020-01-01"), new Date("2020-01-01"));
    const job = startArchiveCompression(f.options), turn = await advanceArchiveCompression(f.options, job.jobId);
    expect(turn.status).toBe("waiting"); expect(turn.job.retries).toEqual([0]);
    expect(turn.errors[0]?.message).toContain("cannot prove its accepted prefix");
    expect(fs.readFileSync(f.plain, "utf8")).toBe(rewritten);
    expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
  } finally { f.close(); }
});

test("incomplete archive input stays pending and preserves every original byte", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.plain, text + '{"partial":'); fs.utimesSync(f.plain, new Date("2020-01-01"), new Date("2020-01-01"));
    const before = fs.readFileSync(f.plain), job = startArchiveCompression(f.options), turn = await advanceArchiveCompression(f.options, job.jobId);
    expect(turn.status).toBe("waiting"); expect(turn.job.retries).toEqual([0]); expect(turn.errors[0]?.message).toContain("incomplete");
    expect(fs.readFileSync(f.plain)).toEqual(before); expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
  } finally { f.close(); }
});

test("restart after publication but before its receipt completes from durable verified bytes", async () => {
  const f = fixture();
  try {
    const job = startArchiveCompression(f.options), unlink = fs.unlinkSync.bind(fs); let stopped = false;
    const interrupt = spyOn(fs, "unlinkSync").mockImplementation((file => {
      unlink(file);
      if (String(file) === f.plain && !stopped) { stopped = true; throw new Error("synthetic stop after retirement"); }
    }) as typeof fs.unlinkSync);
    let interrupted;
    try { interrupted = await advanceArchiveCompression(f.options, job.jobId); } finally { interrupt.mockRestore(); }
    expect(interrupted.status).toBe("waiting"); expect(fs.existsSync(f.plain)).toBe(false);
    expect(f.decode(`${f.plain}.zst`).toString()).toBe(text);
    const done = await advanceArchiveCompression(f.options, job.jobId);
    expect(done.status).toBe("complete"); expect(done.job.compressed).toBe(1);
    expect((await advanceArchiveCompression(f.options, job.jobId)).job.compressed).toBe(1);
  } finally { f.close(); }
});

test("a conflicting existing compressed sibling is preserved alongside the original and blocks compaction", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(`${f.plain}.zst`, Bun.zstdCompressSync(text.replace('"input_tokens":100', '"input_tokens":999')));
    const existing = fs.readFileSync(`${f.plain}.zst`), job = startArchiveCompression(f.options);
    const failed = await advanceArchiveCompression(f.options, job.jobId);
    expect(failed.status).toBe("waiting"); expect(failed.job.compressed).toBe(0);
    expect(fs.readFileSync(f.plain, "utf8")).toBe(text); expect(fs.readFileSync(`${f.plain}.zst`)).toEqual(existing);
  } finally { f.close(); }
});

test("a failed durable queue notification resumes from verified compressed history before declaring completion", async () => {
  const f = fixture();
  try {
    const job = startArchiveCompression(f.options);
    const stop = spyOn(SyncFileQueue.prototype, "enqueue").mockImplementation(() => { throw new Error("synthetic queue unavailable"); });
    let interrupted;
    try { interrupted = await advanceArchiveCompression(f.options, job.jobId); } finally { stop.mockRestore(); }
    expect(interrupted.status).toBe("waiting"); expect(interrupted.job.compressed).toBe(0);
    expect(fs.existsSync(f.plain)).toBe(false); expect(f.decode(`${f.plain}.zst`).toString()).toBe(text);
    const done = await advanceArchiveCompression(f.options, job.jobId);
    expect(done.status).toBe("complete"); expect(done.job.compressed).toBe(1);
    const queue = new SyncFileQueue(f.options.archiveRoot, f.options.localStateRoot);
    try { expect(queue.hasPending("codex", f.plain)).toBe(true); expect(queue.hasPending("codex", `${f.plain}.zst`)).toBe(true); }
    finally { queue.close(); }
  } finally { f.close(); }
});

test("failed atomic publication keeps the plain source intact and permits a lossless retry", async () => {
  const f = fixture();
  try {
    const job = startArchiveCompression(f.options), rename = fs.renameSync.bind(fs);
    const stop = spyOn(fs, "renameSync").mockImplementation(((from, to) => {
      if (String(to) === `${f.plain}.zst`) throw new Error("synthetic cloud publication unavailable");
      rename(from, to);
    }) as typeof fs.renameSync);
    let interrupted;
    try { interrupted = await advanceArchiveCompression(f.options, job.jobId); } finally { stop.mockRestore(); }
    expect(interrupted.status).toBe("waiting"); expect(fs.readFileSync(f.plain, "utf8")).toBe(text);
    expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
    expect((await advanceArchiveCompression(f.options, job.jobId)).status).toBe("complete");
    expect(f.decode(`${f.plain}.zst`).toString()).toBe(text);
  } finally { f.close(); }
});

test("a saved plan refuses an archive directory replaced by a junction", async () => {
  const f = fixture();
  const directory = path.dirname(f.plain), moved = `${directory}-original`;
  try {
    const job = startArchiveCompression(f.options); fs.renameSync(directory, moved);
    fs.symlinkSync(moved, directory, process.platform === "win32" ? "junction" : "dir");
    const turn = await advanceArchiveCompression(f.options, job.jobId);
    expect(turn.status).toBe("waiting"); expect(turn.job.compressed).toBe(0);
    expect(fs.readFileSync(path.join(moved, path.basename(f.plain)), "utf8")).toBe(text);
    expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
  } finally { if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) fs.unlinkSync(directory); f.close(); }
});

test("malformed or traversing durable plans are rejected before archive mutation", async () => {
  const f = fixture();
  try {
    const job = startArchiveCompression(f.options), planFile = path.join(archiveLocalStateDirectory(f.options.archiveRoot, f.options), "compression", job.jobId, "plan.json");
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8")); plan.files[0].relative = "../outside.jsonl";
    fs.writeFileSync(planFile, JSON.stringify(plan));
    await expect(advanceArchiveCompression(f.options, job.jobId)).rejects.toThrow();
    expect(fs.readFileSync(f.plain, "utf8")).toBe(text); expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
  } finally { f.close(); }
});

test("a forged terminal cursor cannot claim completion without its durable file receipts", () => {
  const f = fixture();
  try {
    const job = startArchiveCompression(f.options), stateFile = path.join(archiveLocalStateDirectory(f.options.archiveRoot, f.options), "compression", job.jobId, "state.json");
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")); saved.cursor = saved.total;
    fs.writeFileSync(stateFile, JSON.stringify(saved));
    expect(() => archiveCompressionStatus(f.options, job.jobId)).toThrow("Invalid archive compression checkpoint");
    saved.compressed = 1; saved.sourceBytes = Buffer.byteLength(text); saved.compressedBytes = 100;
    fs.writeFileSync(stateFile, JSON.stringify(saved));
    expect(() => archiveCompressionStatus(f.options, job.jobId)).toThrow("Missing completed compression proof");
    expect(fs.readFileSync(f.plain, "utf8")).toBe(text);
  } finally { f.close(); }
});

test("the explicit CLI plans without writes, uses selected copy locations and resumes its completed job", () => {
  const f = fixture();
  try {
    const run = (...args: string[]) => {
      const child = spawnSync(process.execPath, [path.resolve("scripts/archive-compress.ts"), ...args], {
        cwd: process.cwd(), env: f.options.env, windowsHide: true, encoding: "utf8", timeout: 20_000,
      });
      expect({ exit: child.status, stderr: child.stderr }).toMatchObject({ exit: 0 }); return child.stdout;
    };
    expect(JSON.parse(run("plan"))).toMatchObject({ mode: "read-only plan", files: 1, minimumAgeDays: 7 });
    expect(fs.existsSync(f.plain)).toBe(true); expect(fs.existsSync(`${f.plain}.zst`)).toBe(false);
    const output = run("start").trim().split(/\r?\n/), started = JSON.parse(output[0]!);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: "complete", job: { compressed: 1 } });
    expect(JSON.parse(run("status", started.jobId))).toMatchObject({ status: "complete", job: { compressed: 1 } });
    expect(JSON.parse(run("resume", started.jobId).trim().split(/\r?\n/).at(-1)!)).toMatchObject({ status: "complete", attempted: 0 });
    expect(f.decode(`${f.plain}.zst`).toString()).toBe(text);
    expect(fs.existsSync(f.options.databasePath)).toBe(false);
  } finally { f.close(); }
}, 30_000);
