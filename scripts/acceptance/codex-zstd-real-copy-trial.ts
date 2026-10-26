import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Database } from "../../src/db/sqlite";
import { SyncCoordinator } from "../../src/sync/coordinator";
import { SyncFileQueue } from "../../src/sync/file-queue";
import { ARCHIVE_ROOT, toArchiveLogicalPath } from "../../src/config/paths";
import { startArchiveCompression, advanceArchiveCompression, type ArchiveCompressionTurn } from "../../src/sync/archive-compression";
import { startArchiveCompressionMaintenance } from "../../src/server/archive-compression-maintenance";

const root = process.env.TOKENATLAS_ZSTD_COPY_TRIAL;
if (!root || !fs.existsSync(path.join(root, "copy-only"))) throw new Error("A frozen copy-only trial is required");
const database = process.env.TOKENATLAS_DB!;
assert.equal(path.resolve(database), path.join(root, "copy.sqlite"));
assert.equal(path.resolve(ARCHIVE_ROOT), path.join(root, "archive"));
const samples = JSON.parse(fs.readFileSync(path.join(root, "sample.json"), "utf8")) as string[];
const files = samples.map(relative => path.join(ARCHIVE_ROOT, relative));
const logical = files.map(toArchiveLogicalPath);
const db = new Database(database, { readonly: true, safeIntegers: true });
const hash = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows,
  (_, value) => typeof value === "bigint" ? value.toString() : value)).digest("hex");
const placeholders = logical.map(() => "?").join(",");
const snapshot = () => {
  const raw = db.query(`SELECT rowid,* FROM events WHERE path IN (${placeholders}) ORDER BY home,path,source_offset,rowid`).all(...logical);
  const proof = db.query(`SELECT * FROM codex_file_evidence WHERE path IN (${placeholders}) ORDER BY home,path`).all(...logical);
  const copies = db.query(`SELECT * FROM codex_price_ledger_copies WHERE path IN (${placeholders}) ORDER BY id`).all(...logical) as { id: number | bigint }[];
  const priced = copies.length ? db.query(`SELECT * FROM codex_price_ledger_events WHERE copy_id IN (${copies.map(() => "?").join(",")}) ORDER BY id`)
    .all(...copies.map(copy => copy.id)) : [];
  const dirty = db.query("SELECT kind,value FROM usage_ledger_dirty WHERE provider='codex' ORDER BY kind,value").all();
  return { rawRows: raw.length, pricedRows: priced.length, copies: copies.length,
    rawHash: hash(raw), proofHash: hash(proof), pricedHash: hash(priced), copiesHash: hash(copies), dirtyHash: hash(dirty) };
};
const before = snapshot(); assert(before.rawRows > 0 && before.pricedRows > 0);
let compression: ArchiveCompressionTurn | undefined;
if (process.env.TOKENATLAS_ZSTD_COPY_AUTOMATIC === "1") {
  let clock = Date.now();
  const worker = startArchiveCompressionMaintenance({ archiveRoot: ARCHIVE_ROOT, databasePath: database }, () => true,
    result => { assert(!result.error, result.error ?? "automatic compression worker failed"); compression = result.turn; }, { now: () => clock, startupDelayMs: 0 });
  try {
    for (let step = 0; step < 100; step++) {
      worker.update(); await worker.waitForIdle();
      assert(compression, "automatic worker should leave an executable turn");
      if (compression.status !== "pending") break;
      clock += 1000;
    }
  } finally { await worker.close(); }
  assert.equal(compression?.status, "complete", JSON.stringify(compression));
  assert.equal(compression!.job.compressed, files.length);
  for (const file of files) { assert(!fs.existsSync(file)); assert(fs.existsSync(`${file}.zst`)); }
} else if (process.env.TOKENATLAS_ZSTD_COPY_COMPRESS === "1") {
  const options = { archiveRoot: ARCHIVE_ROOT, databasePath: database }, job = startArchiveCompression(options);
  do { compression = await advanceArchiveCompression(options, job.jobId); } while (compression.status === "pending");
  assert.equal(compression.status, "complete", JSON.stringify(compression));
  assert.equal(compression.job.compressed, files.length); assert.equal(compression.job.skipped, 0);
  for (const file of files) { assert(!fs.existsSync(file)); assert(fs.existsSync(`${file}.zst`)); }
}
const queue = new SyncFileQueue(ARCHIVE_ROOT);
try { if (!compression) for (const file of files) queue.enqueue(file, "codex"); } finally { queue.close(); }
let coordinator = new SyncCoordinator({ dbPath: database, rootDir: process.cwd(), configFingerprint: () => "frozen-copy",
  refreshDerived: () => {} });
const request = { trigger: "manual" as const, mode: "incremental" as const, collection: "archive" as const,
  scope: { kind: "vendor" as const, vendor: "codex" as const } };
try {
  const conversion = await coordinator.enter(request).completion;
  assert.equal(conversion.status, "success", JSON.stringify(conversion.vendors));
  assert(conversion.vendors.every(vendor => !vendor.dataChanged), "codec change must not alter stored facts");
  assert.deepEqual(snapshot(), before, "accepted facts, prices, identities and pending work must stay identical");
  coordinator.close(); coordinator = new SyncCoordinator({ dbPath: database, rootDir: process.cwd(), configFingerprint: () => "frozen-copy", refreshDerived: () => {} });
  const restart = await coordinator.enter(request).completion;
  assert.equal(restart.status, "success"); assert(restart.vendors.every(vendor => vendor.processedInputs === 0));
  assert.deepEqual(snapshot(), before);
  const report = { entry: `${compression ? "archive compression job → " : ""}SyncCoordinator → production archive adapter and incremental publisher`,
    mode: "SQLite backup of live DB; isolated copies of accepted archived sources",
    sample: { files: files.length, ...before }, excludes: "live writes, real OneDrive transport, full startup/whole-history acceptance",
    dataChanged: false, newPricingWork: 0, restartProcessed: restart.vendors.reduce((sum, vendor) => sum + vendor.processedInputs, 0),
    ...(compression ? { archiveCompression: { status: compression.status, ...compression.job,
      automaticWorker: process.env.TOKENATLAS_ZSTD_COPY_AUTOMATIC === "1" } } : {}) };
  console.log(JSON.stringify(report)); fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2));
} finally { coordinator.close(); db.close(); }
