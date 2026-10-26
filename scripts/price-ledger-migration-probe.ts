import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "../src/db/sqlite";
import { activeDatabasePath } from "../src/db/index";
import { createTemporaryWorkspace } from "../src/config/temporary-storage";
import { assertMigrationHistory, snapshotBeforePendingMigrations } from "../src/db/migrate";
import { publishAtlasSnapshot } from "../src/db/snapshot-publish";
import { frozenLedgerCopy } from "./lib/price-ledger-copy";

const [input] = process.argv.slice(2);
if (!input) throw new Error("Usage: bun scripts/price-ledger-migration-probe.ts <closed-frozen-copy.sqlite>");
const frozen = frozenLedgerCopy(input);
const directory = createTemporaryWorkspace("price-ledger-migration", activeDatabasePath()).directory;
const candidate = path.join(directory, "candidate.sqlite"), restored = path.join(directory, "restored.sqlite");
const reportPath = path.join(directory, "report.json");
const started = performance.now();
const phases: Record<string, number> = {};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const progress = (phase: string) => {
  fs.writeFileSync(path.join(directory, "progress.json"), JSON.stringify({ directory, phase, elapsed_ms: performance.now() - started, phases }));
  console.log(JSON.stringify({ directory, phase, elapsed_ms: performance.now() - started }));
};
function fileHash(file: string): string {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(8 * 1024 * 1024), descriptor = fs.openSync(file, "r");
  try { let length; while ((length = fs.readSync(descriptor, buffer))) hash.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}
function schema(db: Database) {
  return db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as
    { type: string; name: string; tbl_name: string; sql: string | null }[];
}
// SQL storage types and integer spelling are compared, not lossy JS Number conversions.
function tableFingerprint(db: Database, table: string) {
  const columns = db.query(`PRAGMA table_info(${quote(table)})`).all() as { name: string; pk: number }[];
  const keys = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk);
  const order = keys.length ? keys.map(column => quote(column.name)).join(",") : "rowid";
  const projections = columns.map((column, index) => {
    const field = quote(column.name);
    return `typeof(${field}) || ':' || CASE typeof(${field}) WHEN 'text' THEN hex(CAST(${field} AS BLOB))
      WHEN 'real' THEN printf('%!.26g',${field}) ELSE quote(${field}) END AS v${index}`;
  }).join(",");
  const hash = createHash("sha256"); let rows = 0;
  for (const row of db.query(`SELECT ${projections} FROM ${quote(table)} ORDER BY ${order}`).iterate()) {
    hash.update(JSON.stringify(row)); hash.update("\n"); rows++;
  }
  return { rows, sha256: hash.digest("hex") };
}
const fingerprint = (db: Database, tables: readonly string[]) => Object.fromEntries(tables.map(table => [table, tableFingerprint(db, table)]));
let db: Database | undefined;
try {
  progress("copy frozen input"); let phaseStart = performance.now();
  fs.copyFileSync(frozen.copy, candidate); frozen.assertUnchanged();
  phases.copy_ms = performance.now() - phaseStart;
  db = new Database(candidate);
  assertMigrationHistory(drizzle(db));
  const originalSchema = schema(db), originalHistory = db.query("SELECT * FROM __drizzle_migrations ORDER BY id").all();
  const tables = originalSchema.filter(entry => entry.type === "table" && entry.name !== "__drizzle_migrations").map(entry => entry.name);
  progress("fingerprint existing durable tables"); phaseStart = performance.now();
  const before = fingerprint(db, tables);
  phases.before_fingerprint_ms = performance.now() - phaseStart;
  fs.writeFileSync(path.join(directory, "before.json"), JSON.stringify({ originalSchema, originalHistory, before }));
  db.close(true); db = undefined;
  progress("real pre-migration snapshot in isolated pool"); phaseStart = performance.now();
  const snapshot = snapshotBeforePendingMigrations(candidate, { publish: options => publishAtlasSnapshot({ ...options,
    archiveRoot: path.join(directory, "archive"), poolPath: path.join(directory, "snapshots"), sourceMachine: "price-ledger-copy-probe" }) });
  if (!snapshot?.databasePath) throw new Error("Expected pending migration and a fresh rollback snapshot");
  phases.snapshot_ms = performance.now() - phaseStart;
  progress("apply migration0045 to candidate"); phaseStart = performance.now();
  db = new Database(candidate); assertMigrationHistory(drizzle(db));
  migrate(drizzle(db), { migrationsFolder: path.resolve(import.meta.dir, "../drizzle") });
  phases.migration_ms = performance.now() - phaseStart;
  const afterSchema = new Map(schema(db).map(entry => [`${entry.type}:${entry.name}`, entry]));
  for (const entry of originalSchema) {
    if (JSON.stringify(afterSchema.get(`${entry.type}:${entry.name}`)) !== JSON.stringify(entry)) throw new Error(`Existing schema changed: ${entry.name}`);
  }
  progress("verify all existing durable table bytes"); phaseStart = performance.now();
  const after = fingerprint(db, tables);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("Existing durable rows changed during migration");
  const newHistory = db.query("SELECT * FROM __drizzle_migrations ORDER BY id").all();
  if (newHistory.length !== originalHistory.length + 1) throw new Error("Expected exactly one pending migration");
  const ledgerTables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'codex_ledger_%' OR name LIKE 'codex_price_ledger_%') ORDER BY name").all();
  if (!ledgerTables.length) throw new Error("Ledger schema was not created");
  phases.after_fingerprint_ms = performance.now() - phaseStart;
  db.close(true); db = undefined;
  progress("cold restore from accepted snapshot"); phaseStart = performance.now();
  const rollback = frozenLedgerCopy(snapshot.databasePath);
  fs.copyFileSync(rollback.copy, restored); rollback.assertUnchanged();
  if (fileHash(restored) !== fileHash(rollback.copy)) throw new Error("Restored snapshot file differs");
  db = new Database(restored, { readonly: true });
  if (JSON.stringify(schema(db)) !== JSON.stringify(originalSchema)
    || JSON.stringify(db.query("SELECT * FROM __drizzle_migrations ORDER BY id").all()) !== JSON.stringify(originalHistory)
    || JSON.stringify(fingerprint(db, tables)) !== JSON.stringify(before)) throw new Error("Cold rollback does not recover original schema and rows");
  phases.rollback_ms = performance.now() - phaseStart;
  frozen.assertUnchanged();
  fs.writeFileSync(reportPath, JSON.stringify({ status: "passed", input: frozen.copy, directory, runtime: Bun.version,
    source_bytes: frozen.before.size, tables: tables.length, before, original_migrations: originalHistory.length,
    migrated_migrations: newHistory.length, ledgerTables, snapshot, phases, total_ms: performance.now() - started }, null, 2));
  progress("passed");
} catch (error) {
  fs.writeFileSync(reportPath, JSON.stringify({ status: "failed", error: String(error), directory, phases, elapsed_ms: performance.now() - started }, null, 2));
  throw error;
} finally { db?.close(true); }
