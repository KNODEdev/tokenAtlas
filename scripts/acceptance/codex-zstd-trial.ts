import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Database } from "../../src/db/sqlite";
import { ensureCodexSchema } from "../../src/ingest/codex";
import { createTestDatabase } from "../../src/sync/test-support";
import { SyncCoordinator } from "../../src/sync/coordinator";
import { ARCHIVE_ROOT, HOME_DIR, toArchiveLogicalPath } from "../../src/config/paths";
import { ensureArchiveIdentity } from "../../src/sync/archive-inventory";
import { bindCanonicalArchiveRoot } from "../../src/config/archive-paths";
import { readArchiveIdentity } from "../../src/sync/archive-local-state";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../../src/server/codex-ledger-policy";
import { enqueueCodexLedgerRuleChanges, processCodexLedgerBatch } from "../../src/db/codex-ledger-producer";
import { ledgerCopyAnchorFromArchive } from "../../src/db/codex-ledger-copies";
import { SyncFileQueue } from "../../src/sync/file-queue";
import { startArchiveCompression, advanceArchiveCompression } from "../../src/sync/archive-compression";

// This runner is deliberately limited to an isolated fixture selected by its parent test.
const root = process.env.TOKENATLAS_ZSTD_TRIAL_ROOT;
if (!root || !path.isAbsolute(root) || !fs.existsSync(path.join(root, "fixture-only")))
  throw new Error("An isolated fixture-only trial root is required");
for (const selected of [ARCHIVE_ROOT, HOME_DIR, process.env.TOKENATLAS_CONFIG!, process.env.TOKENATLAS_LOCAL_STATE!])
  assert(!path.relative(root, selected).startsWith(".."), "trial selections must stay inside its copy");
const line = (value: unknown) => JSON.stringify(value) + "\n";
const header = line({ type: "session_meta", payload: { id: "compression-session", originator: "Codex Desktop", cwd: root } })
  + line({ type: "turn_context", payload: { model: "m", service_tier: "default" } });
const usage = (id: string, input: number, minute = "00") => line({ timestamp: `2026-09-08T00:${minute}:00Z`, type: "token_usage_record",
  payload: { thread_id: "compression-session", response_id: id, usage: { input_tokens: input, cached_input_tokens: 2,
    cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 1 } } });
const text = header + usage("r1", 100);
const source = path.join(HOME_DIR, ".codex", "sessions", "rollout-compression-session.jsonl");
const archived = path.join(ARCHIVE_ROOT, "codex", "PC", "sessions", path.basename(source));
fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
ensureArchiveIdentity(ARCHIVE_ROOT); fs.writeFileSync(source, text);
const fixture = createTestDatabase();
const baseline = new Database(fixture.dbPath); ensureCodexSchema(baseline); baseline.close();
const dbPath = path.join(root, "copy.sqlite"); fs.copyFileSync(fixture.dbPath, dbPath);
const provenance = { verified_at: "2026-01-01", sources: ["https://example.com/fixture"], confidence: "official" as const };
const policy: CodexLedgerPolicy = { version: 1, tiers: ["standard"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }],
  base_rules: (["api_equivalent_usd", "chatgpt_credits"] as const).map(billing_basis => ({ id: billing_basis, model: "m", billing_basis,
    valid_from: "2026-01-01", multiplier: "1", rates: { in_uncached: "2", in_cache_read: "0.2", out_total: "8" }, ...provenance })),
  tier_rules: (["api_equivalent_usd", "chatgpt_credits"] as const).map(billing_basis => ({ id: `${billing_basis}-standard`, model: "m", billing_basis,
    tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance })) };
const binding = bindCanonicalArchiveRoot(null, readArchiveIdentity(ARCHIVE_ROOT), ARCHIVE_ROOT);
const producer = { bands: compileCodexLedgerPolicy(policy).baseBands, policy, factsRevision: 0, rulesRevision: "fixture-rules",
  anchorOf: (_home: string | null, file: string) => ledgerCopyAnchorFromArchive(binding, "codex/fixture", file) };
let db = new Database(dbPath);
const drain = () => {
  const totals = { processed: 0, repricedApi: 0, repricedCredits: 0, aggregatePartitions: 0 };
  for (let step = 0; step < 100; step++) {
    const result = processCodexLedgerBatch(db, producer);
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result[key];
    if (result.ready) return totals;
    if (!result.progressed) throw new Error("fixture ledger did not progress");
  }
  throw new Error("fixture ledger did not settle");
};
const snapshot = () => ({
  raw: db.query("SELECT rowid,* FROM events ORDER BY home,path,source_offset").all(),
  proof: db.query("SELECT * FROM codex_file_evidence ORDER BY home,path").all(),
  ledger: db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all(),
  copies: db.query("SELECT * FROM codex_price_ledger_copies ORDER BY id").all(),
});
const request = { trigger: "manual" as const, mode: "incremental" as const, scope: { kind: "vendor" as const, vendor: "codex" as const } };
const start = (selectedDb = dbPath) => new SyncCoordinator({ dbPath: selectedDb, rootDir: process.cwd(), configFingerprint: () => "fixture-only",
  prepareStage: () => {}, refreshDerived: () => {} });
const enqueue = (files: string[]) => {
  const queue = new SyncFileQueue(ARCHIVE_ROOT);
  try { for (const file of files) queue.enqueue(file, "codex"); } finally { queue.close(); }
};
let coordinator = start();
const run = async () => {
  const result = await coordinator.enter(request).completion;
  assert.equal(result.status, "success", JSON.stringify(result.vendors)); return result;
};
try {
  await run(); enqueueCodexLedgerRuleChanges(db, producer); drain();
  const accepted = snapshot(); assert.equal(accepted.raw.length, 1);
  fs.utimesSync(archived, new Date("2020-01-01"), new Date("2020-01-01"));
  const compressionOptions = { archiveRoot: ARCHIVE_ROOT, databasePath: dbPath };
  const compressionJob = startArchiveCompression(compressionOptions);
  const compression = await advanceArchiveCompression(compressionOptions, compressionJob.jobId);
  assert.equal(compression.status, "complete", JSON.stringify(compression)); assert.equal(compression.job.compressed, 1);
  assert.equal(fs.readFileSync(source, "utf8"), text, "archive compression must leave provider originals untouched");
  assert.equal(fs.existsSync(archived), false); assert.equal(fs.existsSync(`${archived}.zst`), true);
  const archiveConversion = await run(), archiveWork = drain();
  assert.deepEqual(snapshot(), accepted); assert.equal(archiveConversion.vendors[0]!.dataChanged, false);
  assert.deepEqual(archiveWork, { processed: 0, repricedApi: 0, repricedCredits: 0, aggregatePartitions: 0 });
  // An unchanged plain provider must not undo the explicit archive compression.
  enqueue([source]); await run(); assert.deepEqual(snapshot(), accepted); assert.equal(drain().processed, 0);
  assert.equal(fs.existsSync(archived), false); assert.equal(fs.existsSync(`${archived}.zst`), true);
  coordinator.close(); db.close(); db = new Database(dbPath); coordinator = start();
  const archiveRestart = await run(); assert.equal(archiveRestart.vendors[0]?.processedInputs ?? 0, 0); assert.deepEqual(snapshot(), accepted);
  fs.writeFileSync(`${source}.zst`, Bun.zstdCompressSync(text, { level: 3 })); fs.unlinkSync(source);
  enqueue([source, `${source}.zst`]);
  const conversion = await run(); const codecWork = drain();
  assert.deepEqual(snapshot(), accepted); assert.equal(conversion.vendors[0]!.dataChanged, false);
  assert.deepEqual(codecWork, { processed: 0, repricedApi: 0, repricedCredits: 0, aggregatePartitions: 0 });
  assert.equal(fs.existsSync(archived), false); assert.equal(fs.existsSync(`${archived}.zst`), true);
  const bounded = await coordinator.enter({ ...request, reparse: { from: "2026-09-08", until: "2026-09-08" } }).completion;
  assert.equal(bounded.status, "success", JSON.stringify(bounded.vendors)); assert.deepEqual(snapshot(), accepted);
  assert.equal(drain().processed, 0);
  coordinator.close(); db.close(); db = new Database(dbPath); coordinator = start();
  const restart = await run(); assert.equal(restart.vendors[0]?.processedInputs ?? 0, 0); assert.deepEqual(snapshot(), accepted);
  // A newly delivered plain sibling is the same conversation; only its appended call changes facts.
  fs.writeFileSync(source, text + usage("r2", 12, "01"));
  enqueue([source]);
  await run(); const appended = drain();
  assert.equal(snapshot().raw.length, 2); assert.equal(snapshot().copies.length, 1);
  assert.deepEqual(snapshot().ledger[0], accepted.ledger[0]);
  const afterAppend = snapshot(); await run(); assert.deepEqual(snapshot(), afterAppend);
  // A delayed stale compressed-only cloud copy must keep accepted facts and remain retriable.
  fs.unlinkSync(source); fs.unlinkSync(archived); fs.writeFileSync(`${archived}.zst`, Bun.zstdCompressSync(text));
  enqueue([archived, `${archived}.zst`]);
  const stale = await coordinator.enter({ ...request, collection: "archive" }).completion;
  assert.notEqual(stale.status, "success"); assert.deepEqual(snapshot(), afterAppend);
  // Deliver the complete replacement, then retry the same durable queue.
  fs.writeFileSync(`${archived}.zst`, Bun.zstdCompressSync(text + usage("r2", 12, "01")));
  enqueue([`${archived}.zst`]);
  const restored = await coordinator.enter({ ...request, collection: "archive" }).completion;
  assert.equal(restored.status, "success", JSON.stringify(restored.vendors)); assert.deepEqual(snapshot(), afterAppend);
  const stable = snapshot(); coordinator.close(); db.close();
  const reference = createTestDatabase();
  try {
    const setup = new Database(reference.dbPath); ensureCodexSchema(setup); setup.close();
    db = new Database(reference.dbPath); coordinator = start(reference.dbPath);
    const rebuild = await coordinator.enter({ ...request, mode: "full", collection: "archive" }).completion;
    assert.equal(rebuild.status, "success", JSON.stringify(rebuild.vendors));
    enqueueCodexLedgerRuleChanges(db, producer); drain();
    assert.deepEqual(snapshot(), stable, "archive-only full reference must match incremental stored facts and valuations");
  } finally { coordinator.close(); db.close(); fs.rmSync(reference.directory, { recursive: true, force: true }); }
  db = new Database(dbPath); coordinator = start();
  const report = { entry: "SyncCoordinator → production mirror/adapters → shared Codex ledger", mode: "isolated copied database and archive",
    sample: "1 conversation, 1 call → 2 calls", excludes: "live database/server, whole-history timing, real OneDrive transport",
    conversion: { dataChanged: conversion.vendors[0]!.dataChanged, ...codecWork }, restartProcessed: restart.vendors[0]?.processedInputs ?? 0,
    archiveCompression: { status: compression.status, compressed: compression.job.compressed,
      sourceBytes: compression.job.sourceBytes, compressedBytes: compression.job.compressedBytes,
      dataChanged: archiveConversion.vendors[0]!.dataChanged, ...archiveWork,
      restartProcessed: archiveRestart.vendors[0]?.processedInputs ?? 0, providerOriginalPreserved: true },
    appended, conversationCopies: snapshot().copies.length, staleStatus: stale.status, restoredStatus: restored.status,
    boundedReparse: bounded.status, archiveOnlyReference: "identical",
    canonicalPath: toArchiveLogicalPath(`${archived}.zst`) };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { coordinator.close(); db.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); }
