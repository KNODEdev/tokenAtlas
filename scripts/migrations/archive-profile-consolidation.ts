import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "../../src/db/sqlite";
import { ARCHIVE_LAYOUT_FILE, readArchiveLayout, validateArchiveLayout, type ArchiveLayout } from "./archive-layout";
import { locationContains, readArchiveIdentity } from "../../src/config/archive-location";
import { acquireArchiveWriterFence } from "../../src/sync/archive-writers";
import { containedArchivePath } from "../../src/sync/archive-source-path";
import { atomicWrite, assertDirectory, inventory, syncDirectory, type TreeEntry } from "./archive-layout-migration";

type Move = TreeEntry & { source: string; destination: string; logical: string; retained: boolean };
interface Plan { schema: 1; layout: ArchiveLayout; previous: ArchiveLayout; moves: Move[] }
export interface ProfileConsolidationOptions {
  archiveRoot: string; database: string; stateDirectory: string;
  /** Confirmed computer/profile destinations keyed by the accepted source store. */
  targets: Record<string, string>;
  progress?: (value: { phase: string; files: number; bytes: number }) => void;
  checkpoint?: (phase: "fenced" | "intent" | "moved" | "cleaned" | "complete") => void;
}
function fileAt(root: string, relative: string): string {
  const file = containedArchivePath(root, relative);
  assertDirectory(root, path.relative(root, path.dirname(file)).split(path.sep).join("/"));
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())) throw new Error(`Not an ordinary source file: ${relative}`);
  return file;
}
function verify(file: string, expected: TreeEntry, keepTime: boolean) {
  const stat = fs.statSync(file);
  if (stat.size !== expected.bytes || (keepTime && stat.mtimeMs !== expected.modified)) throw new Error(`Source fingerprint changed: ${file}`);
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(file, "r");
  try { let n: number; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  catch (error) { throw new Error(`Cannot verify archived source ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  finally { fs.closeSync(fd); }
  const after = fs.statSync(file);
  if (hash.digest("hex") !== expected.digest || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error(`Source bytes changed: ${file}`);
}
/** Rehydrate an unreadable cloud blob from its verified original, never from metadata alone. */
function verifyRetainedBlob(source: string, destination: string, expected: TreeEntry) {
  try { verify(destination, expected, false); }
  catch (error) {
    const cause = (error as Error).cause as NodeJS.ErrnoException | undefined;
    if (!cause || !["EUNKNOWN", "EINVAL"].includes(cause.code ?? "")) throw error;
    const temporary = `${destination}.restore-${randomUUID()}`;
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      verify(temporary, expected, false);
      const fd = fs.openSync(temporary,"r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary,destination);
      verify(destination,expected,false);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}
function validatePlan(plan: Plan, archiveId: string, jobId: string): Plan {
  if (plan.schema !== 1 || plan.layout?.archiveId !== archiveId || plan.layout.jobId !== jobId || plan.layout.schema !== 2
    || plan.previous?.schema !== 1 || plan.previous.archiveId !== archiveId || !Array.isArray(plan.moves)) throw new Error("Invalid profile consolidation evidence");
  validateArchiveLayout(plan.layout, archiveId); validateArchiveLayout(plan.previous, archiveId);
  if (plan.moves.length !== plan.layout.files!.length) throw new Error("Incomplete profile consolidation evidence");
  const known = new Map(plan.layout.files!.map(file => [file.logical, file.physical]));
  const seen = new Set<string>();
  for (const move of plan.moves) {
    const origin = plan.previous.entries.find(entry => move.logical.startsWith(entry.logical + "/"));
    if (!origin || move.source !== origin.physical + move.logical.slice(origin.logical.length)
      || known.get(move.logical) !== move.destination || seen.has(move.logical)
      || !/^[a-f0-9]{64}$/.test(move.digest) || !Number.isSafeInteger(move.bytes) || move.bytes < 0 || !Number.isFinite(move.modified)
      || move.retained !== move.destination.startsWith(".source-versions/blobs/")) throw new Error("Invalid profile consolidation move");
    if (move.retained && move.destination !== `.source-versions/blobs/${move.digest}`) throw new Error("Invalid retained source digest");
    seen.add(move.logical);
  }
  return plan;
}
/** Remove directories only when empty; an unexpected arrival aborts the operation. */
function removeEmptyTree(directory: string) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unexpected source remains: ${path.join(directory, entry.name)}`);
    removeEmptyTree(path.join(directory, entry.name));
  }
  fs.rmdirSync(directory);
  syncDirectory(path.dirname(directory));
}

/** Merge accepted source files into ordinary profiles, retaining collisions as original versions. */
export function consolidateArchiveProfiles(options: ProfileConsolidationOptions) {
  const root = fs.realpathSync(options.archiveRoot), archiveId = readArchiveIdentity(root);
  if (!archiveId) throw new Error("Archive identity required");
  if (locationContains(root, options.stateDirectory) || locationContains(options.stateDirectory, root)
    || locationContains(root, options.database)) throw new Error("Database and migration evidence must remain outside the archive");
  if (!fs.statSync(options.database).isFile()) throw new Error("Existing calculated database required");
  const id = createHash("sha256").update(`source-layout-v2:${archiveId}`).digest("hex");
  const jobId = `${id.slice(0,8)}-${id.slice(8,12)}-5${id.slice(13,16)}-a${id.slice(17,20)}-${id.slice(20,32)}`;
  const planFile = path.join(options.stateDirectory, `${archiveId}.profiles.json`);
  const db = new Database(options.database, { readwrite: true, create: false });
  let fence: ReturnType<typeof acquireArchiveWriterFence> | undefined;
  let published = false, completed = false;
  try {
    db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='claude_files'").get()) throw new Error("Selected database has no Claude source register");
    if (db.query("SELECT 1 FROM sqlite_master WHERE name='meta'").get()) {
      const binding = db.query("SELECT value FROM meta WHERE key='archive:identity'").get() as {value:string}|null;
      if (binding && binding.value !== archiveId) throw new Error("Database belongs to a different archive");
    }
    if (db.query("SELECT 1 FROM sqlite_master WHERE name='sync_runs'").get()
      && db.query("SELECT 1 FROM sync_runs WHERE status='running' LIMIT 1").get()) throw new Error("Synchronization is running");
    fence = acquireArchiveWriterFence(root, jobId); fence.assertDrained(); options.checkpoint?.("fenced");
    const previous = readArchiveLayout(root, true);
    if (!previous) throw new Error("Source layout required before profile consolidation");
    if (previous.schema === 2 && previous.phase === "complete") {
      completed = true; fence.release(); fence = undefined;
      return { phase: "complete", alreadyComplete: true, entries: previous.entries };
    }
    let plan: Plan;
    if (previous.schema === 2) {
      published = true;
      plan = validatePlan(JSON.parse(fs.readFileSync(planFile,"utf8")), archiveId, jobId);
      if (JSON.stringify(previous) !== JSON.stringify(plan.layout)) throw new Error("Published source layout differs from consolidation evidence");
    } else {
      if (previous.phase !== "complete") throw new Error("Finish the pending source layout migration first");
      const entries = previous.entries.map(entry => ({...entry, physical: options.targets[entry.store] ?? ""}));
      const layout: ArchiveLayout = {schema:2, archiveId, jobId, phase:"moving", entries, files:[]};
      validateArchiveLayout(layout, archiveId);
      for (const entry of entries) {
        assertDirectory(root, entry.physical);
        if (previous.entries.some(old => locationContains(path.join(root,old.physical), path.join(root,entry.physical))
          || locationContains(path.join(root,entry.physical), path.join(root,old.physical)))) throw new Error("Source and target profiles overlap");
      }
      plan = {schema:1, layout, previous, moves:[]};
      for (const origin of previous.entries) {
        const target = entries.find(entry => entry.logical === origin.logical)!;
        const files = inventory(assertDirectory(root,origin.physical), (files,bytes)=>options.progress?.({phase:`inventory:${origin.store}`,files,bytes}));
        for (const file of files) {
          const logical = `${origin.logical}/${file.relative}`, source = `${origin.physical}/${file.relative}`;
          const current = `${target.physical}/${file.relative}`;
          const retained = fs.existsSync(fileAt(root,current));
          if (retained && file.relative.endsWith(".jsonl")) throw new Error(`Transcript collision requires identity reconciliation: ${current}`);
          const destination = retained ? `.source-versions/blobs/${file.digest}` : current;
          layout.files!.push({logical,physical:destination});
          plan.moves.push({...file,source,destination,logical,retained});
        }
      }
      validatePlan(plan,archiveId,jobId);
      atomicWrite(planFile,plan);
      atomicWrite(path.join(root,ARCHIVE_LAYOUT_FILE),layout);
      published = true; options.checkpoint?.("intent");
    }
    let files = 0, bytes = 0;
    for (const move of plan.moves) {
      const source = fileAt(root,move.source), destination = fileAt(root,move.destination);
      if (fs.existsSync(source)) {
        verify(source,move,true);
        if (fs.existsSync(destination)) {
          if (!move.retained) throw new Error(`Target appeared during consolidation: ${move.destination}`);
          verifyRetainedBlob(source,destination,move);
          fs.unlinkSync(source);
        } else {
          const parent = path.dirname(destination);
          if (!fs.existsSync(parent)) fs.mkdirSync(parent,{recursive:true});
          fs.renameSync(source,destination);
        }
        syncDirectory(path.dirname(source)); syncDirectory(path.dirname(destination));
      }
      verify(destination,move,!move.retained);
      options.checkpoint?.("moved");
      files++; bytes += move.bytes;
      if (files % 250 === 0) options.progress?.({phase:"merged",files,bytes});
    }
    for (const origin of plan.previous.entries) removeEmptyTree(assertDirectory(root,origin.physical));
    options.checkpoint?.("cleaned");
    atomicWrite(path.join(root,ARCHIVE_LAYOUT_FILE),{...plan.layout,phase:"complete"});
    completed = true; options.checkpoint?.("complete");
    fence.release(); fence = undefined;
    return {phase:"complete",files,bytes,retainedVersions:plan.moves.filter(move=>move.retained).length,entries:plan.layout.entries};
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK"); db.close();
    if (fence && (!published || completed)) fence.release();
  }
}
