import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Database } from "../../src/db/sqlite";
import { createTestDatabase } from "../../src/sync/test-support";
import { ensureCodexSchema } from "../../src/ingest/codex";
import { SyncCoordinator } from "../../src/sync/coordinator";
import { ARCHIVE_ROOT } from "../../src/config/paths";

// The parent supplies copied sources and Settings locations; never runs against a live DB.
const root = process.env.TOKENATLAS_ZSTD_REBUILD_TRIAL;
if (!root || !fs.existsSync(path.join(root, "copy-only"))) throw new Error("An isolated copy-only benchmark is required");
assert.equal(path.resolve(ARCHIVE_ROOT), path.join(root, "archive"));
assert.equal(path.resolve(process.env.TOKENATLAS_DB!), path.join(root, "copy.sqlite"));
for (const name of ["TOKENATLAS_LOCAL_STATE", "TOKENATLAS_CONFIG", "TOKENATLAS_TEMP_DIR"])
  assert(!path.relative(root, process.env[name]!).startsWith(".."));
const fixture = createTestDatabase();
try {
  const schema = new Database(fixture.dbPath); ensureCodexSchema(schema); schema.close();
  fs.copyFileSync(fixture.dbPath, process.env.TOKENATLAS_DB!);
  const coordinator = new SyncCoordinator({ dbPath: process.env.TOKENATLAS_DB!, rootDir: process.cwd(),
    configFingerprint: () => "isolated-rebuild-benchmark", refreshDerived: () => {} });
  let elapsedMs: number;
  try {
    const started = performance.now();
    const run = await coordinator.enter({ trigger: "manual", mode: "full", collection: "archive", scope: { kind: "vendor", vendor: "codex" } }).completion;
    elapsedMs = performance.now() - started;
    assert.equal(run.status, "success", JSON.stringify(run.vendors));
  } finally { coordinator.close(); }
  const db = new Database(process.env.TOKENATLAS_DB!, { readonly: true, safeIntegers: true });
  try {
    const rows = db.query("SELECT rowid,* FROM events ORDER BY home,path,source_offset,rowid").all();
    const proof = db.query("SELECT * FROM codex_file_evidence ORDER BY home,path").all();
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value,
      (_, entry) => typeof entry === "bigint" ? entry.toString() : entry)).digest("hex");
    const result = { elapsedMs, rawRows: rows.length, files: proof.length, rawHash: hash(rows), proofHash: hash(proof) };
    assert(result.rawRows > 0); fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally { db.close(); }
} finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
