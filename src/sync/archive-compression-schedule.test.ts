import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureArchiveIdentity } from "./archive-inventory";
import { archiveLocalStateDirectory } from "./archive-local-state";
import { runScheduledArchiveCompression, ARCHIVE_COMPRESSION_SCAN_MS, ARCHIVE_COMPRESSION_RETRY_MS } from "./archive-compression-schedule";
import { startArchiveCompression, advanceArchiveCompression } from "./archive-compression";
import { startArchiveCompressionMaintenance } from "../server/archive-compression-maintenance";
import { withDecodedRollouts } from "../ingest/codex-rollout";

const text = JSON.stringify({ type: "session_meta", payload: { id: "daily-copy", instructions: "x".repeat(5000) } }) + "\n";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-compression-schedule-")), archiveRoot = path.join(root, "archive"), localStateRoot = path.join(root, "local");
  fs.mkdirSync(archiveRoot); ensureArchiveIdentity(archiveRoot);
  const options = { archiveRoot, localStateRoot, databasePath: path.join(root, "copy.sqlite"),
    env: { ...process.env, TOKENATLAS_ARCHIVE: archiveRoot, TOKENATLAS_LOCAL_STATE: localStateRoot, TOKENATLAS_CONFIG: path.join(root, "config"),
      TOKENATLAS_TEMP_DIR: path.join(root, "scratch"), TOKENATLAS_FROZEN_CONFIG: "1" } };
  const write = (name: string, bytes = text, date = new Date("2020-01-01")) => {
    const file = path.join(archiveRoot, "codex", "PC", "sessions", `${name}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); fs.utimesSync(file, date, date); return file;
  };
  return { options, root, write, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("daily automatic compression resumes bounded work after restart and scans no more than once a day", () => {
  const f = fixture(), now = Date.now();
  try {
    const first = f.write("a"), second = f.write("b"), warm = f.write("warm", text, new Date(now));
    const turn = runScheduledArchiveCompression(f.options, now);
    expect(turn.scanned).toBe(true); expect(turn.turn?.status).toBe("pending"); expect(turn.turn?.job.compressed).toBe(1);
    expect(fs.existsSync(`${first}.zst`)).toBe(true); expect(fs.existsSync(second)).toBe(true);
    const resumed = runScheduledArchiveCompression(f.options, now + 1000);
    expect(resumed.scanned).toBe(false); expect(resumed.turn?.status).toBe("complete"); expect(resumed.turn?.job.jobId).toBe(turn.turn!.job.jobId);
    expect(fs.existsSync(`${second}.zst`)).toBe(true); expect(fs.existsSync(warm)).toBe(true);
    expect(runScheduledArchiveCompression(f.options, now + 2000).turn).toBeUndefined();
    const later = f.write("later");
    const daily = runScheduledArchiveCompression(f.options, now + ARCHIVE_COMPRESSION_SCAN_MS);
    expect(daily.scanned).toBe(true); expect(daily.turn?.job.compressed).toBe(1); expect(fs.existsSync(`${later}.zst`)).toBe(true);
    expect(fs.existsSync(warm)).toBe(true);
  } finally { f.close(); }
});

test("a corrupt retained source retries without preventing a later daily scan from compressing healthy new files", () => {
  const f = fixture(), now = Date.now();
  try {
    const bad = f.write("bad", text + '{"partial":');
    const first = runScheduledArchiveCompression(f.options, now);
    expect(first.turn?.status).toBe("waiting"); expect(first.nextWakeAt).toBe(now + ARCHIVE_COMPRESSION_RETRY_MS);
    expect(runScheduledArchiveCompression(f.options, now + 1000).turn).toBeUndefined();
    const healthy = f.write("healthy"), next = now + ARCHIVE_COMPRESSION_SCAN_MS;
    const daily = runScheduledArchiveCompression(f.options, next);
    expect(daily.scanned).toBe(true); expect(daily.turn?.job.jobId).toBe(first.turn!.job.jobId);
    const ready = runScheduledArchiveCompression(f.options, next + 1000);
    expect(ready.turn?.status).toBe("complete"); expect(ready.turn?.job.total).toBe(1);
    expect(fs.existsSync(`${healthy}.zst`)).toBe(true); expect(fs.readFileSync(bad, "utf8")).toBe(text + '{"partial":');
  } finally { f.close(); }
});

test("a malformed schedule preserves every source and cannot silently reset durable jobs", () => {
  const f = fixture();
  try {
    const source = f.write("a"), directory = path.join(archiveLocalStateDirectory(f.options.archiveRoot, f.options), "compression");
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "schedule.json"), '{"schema":1,"jobs":[{"jobId":"../bad"}]}');
    expect(() => runScheduledArchiveCompression(f.options)).toThrow("Invalid automatic compression checkpoint");
    expect(fs.readFileSync(source, "utf8")).toBe(text); expect(fs.existsSync(`${source}.zst`)).toBe(false);
  } finally { f.close(); }
});

test("a manual job completing an automatic job's pending file safely retires that stale plan", async () => {
  const f = fixture();
  try {
    f.write("a"); f.write("b");
    const now = Date.now(); runScheduledArchiveCompression(f.options, now);
    const manual = startArchiveCompression(f.options);
    expect((await advanceArchiveCompression(f.options, manual.jobId)).status).toBe("complete");
    const next = runScheduledArchiveCompression(f.options, now + 1000);
    expect(next.turn?.status).toBe("complete"); expect(next.turn?.job.skipped).toBe(1);
  } finally { f.close(); }
});

test("the automatic worker honours its import gate and persists its daily cadence across real worker restart", async () => {
  const f = fixture();
  let now = Date.now(), allowed = false;
  const observed: { result?: ReturnType<typeof runScheduledArchiveCompression> } = {};
  const result = () => observed.result;
  const start = () => startArchiveCompressionMaintenance(f.options, () => allowed, value => { observed.result = value; }, { now: () => now, startupDelayMs: 0 });
  let worker = start();
  try {
    const source = f.write("a");
    worker.update(); expect(worker.running).toBe(false); expect(fs.existsSync(source)).toBe(true);
    allowed = true; worker.update(); expect(worker.running).toBe(true); await worker.waitForIdle();
    expect(result()?.turn?.status).toBe("complete"); expect(fs.existsSync(`${source}.zst`)).toBe(true);
    expect(fs.existsSync(f.options.databasePath)).toBe(false);
    await worker.close(); observed.result = undefined; worker = start(); worker.update(); await worker.waitForIdle();
    expect(result()?.scanned).toBe(false); expect(result()?.turn).toBeUndefined();
    const later = f.write("later"); now += ARCHIVE_COMPRESSION_SCAN_MS;
    worker.update(); await worker.waitForIdle(); expect(result()?.scanned).toBe(true); expect(fs.existsSync(`${later}.zst`)).toBe(true);
    await worker.close(); worker.update(); expect(worker.running).toBe(false);
  } finally { await worker.close(); f.close(); }
}, 30_000);

test("closing a running automatic worker waits for its verified publication and does not interrupt the archive writer", async () => {
  const f = fixture();
  const worker = startArchiveCompressionMaintenance(f.options, () => true, () => {}, { startupDelayMs: 0 });
  try {
    const source = f.write("a"); worker.update(); expect(worker.running).toBe(true);
    await worker.close(); expect(worker.running).toBe(false);
    expect(fs.existsSync(source)).toBe(false);
    const bytes = withDecodedRollouts([`${source}.zst`], ([file]) => fs.readFileSync(file!, "utf8"), false, f.options);
    expect(bytes).toBe(text);
    worker.update(); expect(worker.running).toBe(false);
  } finally { await worker.close(); f.close(); }
}, 30_000);
