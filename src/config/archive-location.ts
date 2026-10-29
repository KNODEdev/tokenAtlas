import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ensureArchiveIdentity } from "../sync/archive-inventory";
import { ARCHIVE_RELOCATION_OWNER_FILE, withArchiveWriter } from "../sync/archive-writers";

export type ArchiveConnectionAction = "create" | "connect";
export function realArchiveLocation(location: string): string {
  const resolved = path.resolve(location);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(realArchiveLocation(parent), path.basename(resolved));
}
export function locationContains(root: string, candidate: string): boolean {
  const relative = path.relative(realArchiveLocation(root), realArchiveLocation(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
export function readArchiveIdentity(root: string): string | null {
  const file = path.join(root, ".archive-inventory", "identity.json");
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.schema !== 1 || typeof value.archiveId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.archiveId)) throw new Error("Invalid archive identity");
  return value.archiveId;
}
function boundArchive(sqlite?: Database): string | null {
  if (!sqlite?.query("SELECT 1 FROM sqlite_master WHERE name='meta'").get()) return null;
  return (sqlite.query("SELECT value FROM meta WHERE key='archive:identity'").get() as {value:string}|null)?.value ?? null;
}
function hasIndexedFacts(sqlite?: Database): boolean {
  if (!sqlite) return false;
  for (const table of ["events", "claude_events", "oc_events", "grok_events", "gemini_events", "probe_windows"])
    if (sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) && sqlite.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) return true;
  return false;
}

function hasAccountsConfiguration(root: string): boolean {
  const file = path.join(root, "config", "accounts.json");
  if (!fs.existsSync(file)) return false;
  try {
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    return document.version === 2 && Array.isArray(document.subscriptions) && Array.isArray(document.sources);
  } catch { return false; }
}

/** Called only by explicit setup or relocation, never by an ordinary read. */
export function prepareArchiveConnection(root: string, action: ArchiveConnectionAction, options: {
  database: string; currentRoot?: string; sqlite?: Database;
}): {root:string; archiveId:string} {
  if (!root.trim() || /[\r\n\0]/.test(root)) throw new Error("Invalid archive directory");
  const target = realArchiveLocation(root);
  if (fs.existsSync(path.join(target, ARCHIVE_RELOCATION_OWNER_FILE)))
    throw new Error("Relocation destination is staged; activation has not been committed");
  if (locationContains(target, options.database)) throw new Error("The active database must stay outside the archive");
  const bound = boundArchive(options.sqlite);
  const identity = readArchiveIdentity(target);
  const changing = options.currentRoot && realArchiveLocation(options.currentRoot) !== target;
  if (hasIndexedFacts(options.sqlite) && ((bound && identity !== bound) || (!bound && changing)))
    throw new Error("A different archive cannot be connected to this populated index. Use Settings → Move archive to change its folder. / Innego archiwum nie można połączyć z tą bazą. Aby zmienić folder archiwum, użyj „Przenieś archiwum” w Ustawieniach.");
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) throw new Error("Archive location is not a directory / Wskazana ścieżka archiwum nie jest folderem.");
  const entries = fs.existsSync(target) ? fs.readdirSync(target) : [];
  if (action === "create" && entries.length) throw new Error("Create requires an empty directory; connect an existing archive instead / Nowe archiwum wymaga pustego folderu. Wybierz pusty folder albo „Podłącz istniejące archiwum”.");
  if (action === "connect" && !identity && !hasAccountsConfiguration(target))
    throw new Error("This directory is not a recognized archive; no files were changed / Ten folder nie jest archiwum tokenAtlas; nic nie zostało zmienione. Wybierz „Utwórz w pustym folderze” albo wskaż właściwy folder.");
  if (!fs.existsSync(target)) {
    if (action !== "create") throw new Error("Archive unavailable; connection cannot recreate it / Tego archiwum nie ma pod wskazaną ścieżką. Sprawdź, czy folder jest dostępny i zsynchronizowany.");
    fs.mkdirSync(target, {recursive:true});
  }
  return withArchiveWriter(target, () => {
    const probe = path.join(target, `.archive-write-check-${randomUUID()}`);
    const fd = fs.openSync(probe, "wx");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); fs.unlinkSync(probe); }
    return { root: target, archiveId: ensureArchiveIdentity(target) };
  });
}

export function bindArchiveIdentity(sqlite: Database | undefined, archiveId: string): void {
  if (!sqlite?.query("SELECT 1 FROM sqlite_master WHERE name='meta'").get()) return;
  sqlite.query("INSERT INTO meta(key,value) VALUES('archive:identity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(archiveId);
}
