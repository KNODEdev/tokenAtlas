import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "../../src/db/sqlite";
import { ARCHIVE_LAYOUT_FILE, LEGACY_ARCHIVE_FOLDERS, readArchiveLayout, type ArchiveLayout } from "./archive-layout";
import { locationContains, readArchiveIdentity } from "../../src/config/archive-location";
import { ensureArchiveIdentity } from "../../src/sync/archive-inventory";
import { acquireArchiveWriterFence } from "../../src/sync/archive-writers";

export type TreeEntry = { relative: string; bytes: number; modified: number; digest: string };
type Evidence = { schema: 1; archiveId: string; jobId: string; trees: Record<string, TreeEntry[]> };
export interface LayoutMigrationOptions {
  archiveRoot: string;
  stateDirectory: string;
  database: string;
  progress?: (value: { phase: string; folder: string; files: number; bytes: number }) => void;
  afterMove?: (folder: string) => void;
  checkpoint?: (phase: "fenced" | "intent" | "complete") => void;
}
export function atomicWrite(file: string, value: unknown) {
  if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx");
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function syncDirectory(directory: string) {
  let fd: number | undefined;
  try { fd = fs.openSync(directory, "r"); fs.fsyncSync(fd); }
  catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(code)
      && !(process.platform === "win32" && ["EACCES", "EPERM"].includes(code))) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function assertDirectory(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  if (!locationContains(root, candidate) || candidate === path.resolve(root)) throw new Error("Migration path escapes archive");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()))
      throw new Error(`Migration directory is not an ordinary contained folder: ${current}`);
  }
  return candidate;
}
export function inventory(directory: string, progress?: (files: number, bytes: number) => void): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const walk = (relative: string) => {
    const current = path.join(directory, relative);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(directory, child);
      if (entry.isSymbolicLink()) throw new Error(`Cannot migrate a source symlink: ${file}`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        let verified: TreeEntry | undefined;
        // Cloud hydration can change metadata during the first read; accept only a stable complete read.
        for (let attempt = 0; attempt < 3 && !verified; attempt++) {
          const before = fs.statSync(file);
          const hash = createHash("sha256");
          const fd = fs.openSync(file, "r");
          try { let count: number; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
          finally { fs.closeSync(fd); }
          const after = fs.statSync(file);
          if (before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs)
            verified = { relative: child, bytes: after.size, modified: after.mtimeMs, digest: hash.digest("hex") };
        }
        if (!verified) throw new Error(`Source changed while verifying: ${file}`);
        entries.push(verified);
        bytes += verified.bytes;
        if (entries.length % 250 === 0) progress?.(entries.length, bytes);
      } else throw new Error(`Unsupported source entry: ${file}`);
    }
  };
  walk(""); progress?.(entries.length, bytes);
  return entries.sort((a, b) => a.relative.localeCompare(b.relative));
}
function sameTree(expected: TreeEntry[], actual: TreeEntry[]): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}
function summary(layout: ArchiveLayout, evidence: Evidence) {
  return { phase: layout.phase, archiveId: layout.archiveId, jobId: layout.jobId,
    folders: layout.entries.map(entry => ({ ...entry, files: evidence.trees[entry.logical]!.length,
      bytes: evidence.trees[entry.logical]!.reduce((total, file) => total + file.bytes, 0) })) };
}

/** Offline, same-volume renames. No facts or bookmarks are rewritten. */
export function consolidateArchiveLayout(options: LayoutMigrationOptions) {
  const root = fs.realpathSync(options.archiveRoot);
  if (locationContains(root, options.stateDirectory) || locationContains(options.stateDirectory, root)) throw new Error("Migration evidence must stay outside the archive");
  if (locationContains(root, options.database)) throw new Error("The calculated database must be local and outside the archive");
  if (!fs.statSync(options.database).isFile()) throw new Error("Migration requires an existing calculated database");
  let layout = readArchiveLayout(root, true);
  const archiveId = layout?.archiveId ?? readArchiveIdentity(root) ?? ensureArchiveIdentity(root);
  const evidenceFile = path.join(options.stateDirectory, `${archiveId}.json`);
  assertDirectory(root, ".archive-inventory");
  if (!layout) {
    const entries = LEGACY_ARCHIVE_FOLDERS.filter(entry => fs.existsSync(assertDirectory(root, entry.logical)));
    if (!entries.length) throw new Error("No legacy source folders to consolidate");
    for (const entry of entries) if (fs.existsSync(assertDirectory(root, entry.physical))) throw new Error(`Destination already exists: ${entry.physical}`);
    // Every contender derives the same resumable job, even with a different local state folder.
    const id = createHash("sha256").update(`source-layout-v1:${archiveId}`).digest("hex");
    const jobId = `${id.slice(0, 8)}-${id.slice(8, 12)}-5${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`;
    layout = { schema: 1, archiveId, jobId, phase: "moving", entries };
  }
  // Hold a write reservation without changing any rows. Existing reads stay available.
  const db = new Database(options.database, { readwrite: true, create: false });
  let fence: ReturnType<typeof acquireArchiveWriterFence> | undefined;
  let committed = false;
  let publishedIntent = false;
  try {
    db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='claude_files'").get()) throw new Error("Selected database has no Claude source register");
    if (db.query("SELECT 1 FROM sqlite_master WHERE name='meta'").get()) {
      const binding = db.query("SELECT value FROM meta WHERE key='archive:identity'").get() as { value: string } | null;
      if (binding && binding.value !== archiveId) throw new Error("Database belongs to a different archive");
    }
    if (db.query("SELECT 1 FROM sqlite_master WHERE name='sync_runs'").get()
      && db.query("SELECT 1 FROM sync_runs WHERE status='running' LIMIT 1").get()) throw new Error("Synchronization is running; stop it before migrating source folders");
    fence = acquireArchiveWriterFence(root, layout.jobId);
    fence.assertDrained();
    options.checkpoint?.("fenced");
    let evidence: Evidence;
    const existing = readArchiveLayout(root, true);
    if (existing) {
      publishedIntent = true;
      layout = existing;
      if (layout.phase === "complete") {
        committed = true;
        fence.release(); fence = undefined;
        return { phase: layout.phase, archiveId, jobId: layout.jobId, folders: layout.entries, alreadyComplete: true };
      }
      evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
      if (evidence.schema !== 1 || evidence.archiveId !== archiveId || evidence.jobId !== layout.jobId || !evidence.trees) throw new Error("Migration evidence does not match the archive layout");
    } else {
      evidence = { schema: 1, archiveId, jobId: layout.jobId, trees: {} };
      for (const entry of layout.entries) {
        if (fs.existsSync(assertDirectory(root, entry.physical))) throw new Error(`Destination already exists: ${entry.physical}`);
        evidence.trees[entry.logical] = inventory(assertDirectory(root, entry.logical), (files, bytes) => options.progress?.({ phase: "before", folder: entry.logical, files, bytes }));
      }
      atomicWrite(evidenceFile, evidence);
      atomicWrite(path.join(root, ARCHIVE_LAYOUT_FILE), layout);
      publishedIntent = true;
      options.checkpoint?.("intent");
    }
    for (const entry of layout.entries) {
      const source = assertDirectory(root, entry.logical), destination = assertDirectory(root, entry.physical);
      if (fs.existsSync(source) && fs.existsSync(destination)) throw new Error(`Both original and destination exist: ${entry.logical}`);
      const current = fs.existsSync(source) ? source : destination;
      const before = inventory(current, (files, bytes) => options.progress?.({ phase: "verify", folder: entry.logical, files, bytes }));
      if (!sameTree(evidence.trees[entry.logical]!, before)) throw new Error(`Source contents differ from migration evidence: ${entry.logical}`);
      if (current === source) {
        const parent = path.dirname(destination);
        // Bun can reject recursive mkdir on an existing cloud reparse directory.
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        // Both absolute paths are validated beneath the selected archive; no overwrite or deletion.
        fs.renameSync(source, destination);
        syncDirectory(path.dirname(destination)); syncDirectory(path.dirname(source));
        options.afterMove?.(entry.logical);
      }
      const after = inventory(destination, (files, bytes) => options.progress?.({ phase: "after", folder: entry.physical, files, bytes }));
      if (!sameTree(evidence.trees[entry.logical]!, after)) throw new Error(`Moved source verification failed: ${entry.logical}`);
    }
    layout = { ...layout, phase: "complete" };
    atomicWrite(path.join(root, ARCHIVE_LAYOUT_FILE), layout);
    committed = true;
    options.checkpoint?.("complete");
    fence.release(); fence = undefined;
    return summary(layout, evidence);
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
    // A partial migration keeps writer admission closed. The same job resumes after a crash.
    if (fence && (!publishedIntent || committed)) fence.release();
  }
}
