import type { VendorId } from "./contracts";
import path from "node:path";
import { ARCHIVE_ROOT, toArchiveLogicalPath, toArchivePhysicalPath } from "../config/paths";
import { archiveCodecSource, archiveSourceIdentity } from "../shared/archive-codec-path";
import { JOURNAL_FILE_PATH, supersededJournals } from "../providers/core/journal-files";
import fs from "node:fs";
import type { Database } from "../db/sqlite";
import type { ReparsePlan } from "./reparse";
import { DELTA_SPECS } from "./vendor-publication-schema";
import { quoteIdentifier, tableExists } from "./sync-sql";
import type { SyncFileFailure } from "./file-queue";

export function calculationInput(vendor:VendorId,file:string):boolean {
  const relative=path.relative(ARCHIVE_ROOT,file).split(path.sep).join("/");
  if(!relative.startsWith(`${vendor}/`)||/\.conflict-[a-f0-9]{64}(?:\.|$)/i.test(relative))return false;
  if (archiveCodecSource(relative)?.vendor === vendor) return true;
  switch(vendor) {
    case "codex":return /^codex\/[^/]+\/(sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/i.test(relative);
    case "claude":return relative.endsWith(".jsonl");
    case "grok":return /^grok\/[^/]+\/sessions\/[^/]+\/[^/]+\/updates\.jsonl$/.test(relative);
    case "gemini":return /^gemini\/[^/]+\/conversations\/[^/]+\.db$/.test(relative);
    case "opencode":return /^opencode\/[^/]+\/opencode\.sqlite$/.test(relative);
    case "gauges":return JOURNAL_FILE_PATH.test(relative);
  }
}

export function archiveCalculationInputs(vendor: VendorId): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || /\.conflict-[a-f0-9]{64}(?:\.|$)/i.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && calculationInput(vendor, file)) files.push(file);
    }
  };
  visit(path.join(ARCHIVE_ROOT, vendor));
  return files;
}

/** Stat-only discovery: an unrecognised or changed source may contain a late range correction. */
export async function boundedReparseInputs(active: Database, vendor: VendorId, sources: ReparsePlan["sources"],
  inputs: string[]): Promise<string[]> {
  const spec = DELTA_SPECS[vendor];
  const bookmarks = new Map<string, Array<{ size: number; mtime: number }>>();
  const remember = (file: string, bookmark: { size: number; mtime: number }) => {
    const logical = toArchiveLogicalPath(file);
    const rows = bookmarks.get(logical) ?? [];
    rows.push(bookmark); bookmarks.set(logical, rows);
  };
  if (spec.bookmarkTable) {
    const rows = active.query(`SELECT path,size,mtime${vendor === "gauges" ? ",store" : ""} FROM ${quoteIdentifier(spec.bookmarkTable)}`).all() as
      Array<{ path: string; store: string; size: number; mtime: number }>;
    for (const row of rows) remember(vendor === "gauges"
      ? path.join(ARCHIVE_ROOT, "gauges", row.store, row.path) : row.path, row);
  } else {
    for (const row of active.query("SELECT value FROM meta WHERE key LIKE 'opencode_snapshot:%'").all() as { value: string }[]) {
      const bookmark = JSON.parse(row.value) as { path: string; size: number; mtime: number };
      remember(bookmark.path, bookmark);
    }
  }
  const selected = new Set(sources.map(source => toArchivePhysicalPath(source.path)).filter(file => calculationInput(vendor, file)));
  const candidates=inputs.filter(file=>!selected.has(file));
  // Refill each slot as it finishes: one slow cloud stat must not hold up the next 64 files.
  // Every known candidate is still checked, including corrections inside old folders.
  const changed = new Uint8Array(candidates.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(64, candidates.length) }, async () => {
    for (let index = next++; index < candidates.length; index = next++) {
      const file = candidates[index]!;
      const prior=bookmarks.get(toArchiveLogicalPath(file));
      if(!prior?.length) { changed[index] = 1; continue; }
      try {
        const stat=await fs.promises.stat(file);
        // Codex retains CPython seconds; the other importers retain milliseconds.
        const mtime=vendor==="codex"?stat.mtimeMs/1000:stat.mtimeMs;
        changed[index] = prior.some(row=>row.size===stat.size && (vendor==="codex"
          ? Math.abs(row.mtime-mtime)<1e-6:row.mtime===mtime)) ? 0 : 1;
      } catch { changed[index] = 1; }
    }
  }));
  // Completion order must not change replica ownership or publication order.
  for (const [index, file] of candidates.entries()) if (changed[index]) selected.add(file);
  return [...selected];
}

export function addClaudeAuditCompanions(active: Database, files: string[]): void {
  for (const file of [...files]) {
    // A changed cloud session declaration (places, owner) is read with its events again.
    const cloud = /^(.+)\.session\.jsonl$/i.exec(file);
    if (cloud && fs.existsSync(`${cloud[1]}.events.jsonl`) && !files.includes(`${cloud[1]}.events.jsonl`)) files.push(`${cloud[1]}.events.jsonl`);
    const audit = path.basename(file).match(/^([0-9a-f]{8})-audit\.jsonl$/i);
    if (!audit) continue;
    const prefix = toArchiveLogicalPath(path.join(path.dirname(file), audit[1]! + "-"));
    const upper = prefix.slice(0, -1) + ".";
    for (const row of active.query("SELECT path FROM claude_files WHERE store='desktop' AND path>=? AND path<?")
      .all(prefix, upper) as { path: string }[]) {
      const companion = toArchivePhysicalPath(row.path);
      if (!files.includes(companion)) files.push(companion);
    }
  }
}

/**
 * The same question for a file that may still be a provider original: a failed
 * mirror reports the source path, not its archive copy. Archive files keep the
 * strict layout contract above; an original is judged by what it is, so an
 * attachment or a link beside a transcript is not mistaken for a source of facts.
 */
export function calculationInputName(vendor:VendorId,file:string):boolean {
  if(calculationInput(vendor,file))return true;
  const relative=path.relative(ARCHIVE_ROOT,file).split(path.sep).join("/");
  if(relative&&!relative.startsWith("../")&&!path.isAbsolute(relative))return false;
  const name=archiveSourceIdentity(file).split(path.sep).join("/");
  if(/\.conflict-[a-f0-9]{64}(?:\.|$)/i.test(name))return false;
  switch(vendor) {
    case "codex":return /(?:^|\/)(?:sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/i.test(name);
    case "claude":return name.endsWith(".jsonl");
    case "grok":return /(?:^|\/)updates\.jsonl$/.test(name);
    case "gemini":return /(?:^|\/)conversations\/[^/]+\.db$/.test(name);
    case "opencode":return /(?:^|\/)opencode\.sqlite$/.test(name);
    case "gauges":return JOURNAL_FILE_PATH.test(name);
  }
}

/**
 * Registered gauge journals a rebuild cannot read from the archive. Journals are read whole and
 * never through a reparse plan, so a vanished one is found here; a journal its owner rewrote into
 * other files is covered once every replacement has arrived.
 */
export function unreadableRegisteredJournals(sqlite: Database): Array<{ store: string; path: string }> {
  if (!tableExists(sqlite, "gauge_files")) return [];
  const missing: Array<{ store: string; path: string }> = [];
  for (const row of sqlite.query("SELECT store,path FROM gauge_files ORDER BY store,path").all() as { store: string; path: string }[]) {
    const storeRoot = path.join(ARCHIVE_ROOT, "gauges", row.store);
    const file = path.join(storeRoot, row.path);
    try { fs.accessSync(file, fs.constants.R_OK); continue; } catch { /* checked below */ }
    const replaced = supersededJournals(storeRoot)[row.path];
    if (replaced?.into.every(target => fs.existsSync(path.join(storeRoot, target)))) continue;
    missing.push({ store: row.store, path: toArchiveLogicalPath(file) });
  }
  return missing;
}

/** A vendor error names what is unread, without carrying every input into the run record. */
export function unreadInputSummary(items: SyncFileFailure[]): string {
  const shown = items.slice(0, 5).map(item => `${item.path}: ${item.error}`).join("; ");
  return items.length > 5 ? `${shown}; and ${items.length - 5} more unread input(s)` : shown;
}

/**
 * A read that found its file longer or newer than when it began: a live session is still writing
 * it. The verification, copy, parse and checkpoint steps each raise one of these messages.
 */
const STILL_GROWING = /changed (?:before|during) (?:verification|preparation|copy|checkpoint)|changed while reading|Parsed source identity changed/i;

export const stillGrowing = (item: SyncFileFailure) => STILL_GROWING.test(item.error);

/** SQLite sidecars name the same mirror operation as their base database. */
export function mirrorInputFailed(file: string, failures: ReadonlySet<string>): boolean {
  const candidate = process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  return failures.has(candidate) || failures.has(candidate.replace(/-(wal|shm)$/i, ""));
}
