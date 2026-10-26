// Raw OpenCode archive publication, retaining source rows that disappear upstream.
import fs from "node:fs";
import path from "node:path";
import { initializeArchiveWriterIdentity } from "../../src/sync/archive-writers";
import { publishSourceDatabase, type SourceDatabasePublicationOptions } from "../../src/sync/source-database-publication";

interface FileStamp { size: number; mtimeMs: number; ctimeMs: number; }
export interface SourceFingerprint { source: string; database: FileStamp; wal: FileStamp | null; }
export interface BackupResult { status: "created" | "unchanged"; bytes: number; stable: boolean; }
function stamp(file: string): FileStamp | null {
  try { const st = fs.statSync(file); return {size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function sourceFingerprint(src: string): SourceFingerprint {
  const database = stamp(src);
  if (!database) throw new Error(`Source database not found: ${src}`);
  return {source: path.resolve(src), database, wal: stamp(`${src}-wal`)};
}
export function backupSqlite(src: string, dest: string, options: SourceDatabasePublicationOptions = {}): BackupResult {
  return publishSourceDatabase(src, dest, "opencode", options);
}

if (import.meta.main) {
  const [src, dest] = process.argv.slice(2).filter(arg => arg !== "--force");
  if (!src || !dest) { console.error("Usage: bun scripts/dev/db-backup.ts <source.sqlite> <dest.sqlite> [--force]"); process.exit(1); }
  try {
    initializeArchiveWriterIdentity();
    const result = backupSqlite(src, dest, {force: process.argv.includes("--force")});
    const suffix = !result.stable ? "source unavailable or changed; retry next sync" : result.status === "unchanged" ? "unchanged, skipped" : "archive updated";
    console.log(`      ${dest}  (${(result.bytes / 1024 / 1024).toFixed(1)} MB; ${suffix})`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
