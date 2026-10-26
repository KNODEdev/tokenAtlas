import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_ROOT } from "../config/paths";
import { resolveDbPath } from "../db";
import { resolveLocalStateRootBase } from "../config/archive-locator";
import { createTemporaryWorkspace } from "../config/temporary-storage";
import { archivePublicationPaths, atomicArchiveCopy, fileDigest } from "./archive-publication";
import { acceptedArchiveFingerprint } from "./file-queue";
import { atomicLocalWrite, withLocalArchiveLock } from "./archive-local-state";
import { ensureArchiveIdentity } from "./archive-inventory";
import { withArchiveWriter } from "./archive-writers";
import { sourceDatabaseCredentialTables, SourceDatabaseConflict, type SourceDatabaseMergeReport, type SourceDatabaseVendor } from "./source-database-merge";

export interface SourceDatabasePublicationOptions {
  force?: boolean;
  archiveRoot?: string;
  localStateRoot?: string;
  env?: Record<string, string | undefined>;
}
export interface SourceDatabasePublicationResult {
  status: "created" | "unchanged";
  bytes: number;
  stable: boolean;
  sourceMissing?: boolean;
  merge?: SourceDatabaseMergeReport;
}
interface Checkpoint {
  schema: 1 | 2;
  vendor: SourceDatabaseVendor;
  source: string;
  sourceStamp: string;
  destinationStamp: string;
  acceptedDigest: string;
  excludedTables?: string[];
}
// A persistent conflict stops this source's archival until accepted content is repaired.
// Later provider changes remain pending; neither the first evidence nor history is overwritten.
interface ConflictLatch {schema:1;source:string;vendor:SourceDatabaseVendor;acceptedDigest:string|null;conflictFile:string;reason:string}
function readConflictLatch(file:string,destination:string):ConflictLatch|null {
  let value:ConflictLatch;
  try {value=JSON.parse(fs.readFileSync(file,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
  if(value.schema!==1||typeof value.source!=="string"||!["opencode","gemini"].includes(value.vendor)
    ||(value.acceptedDigest!==null&&!/^[a-f0-9]{64}$/.test(value.acceptedDigest))||typeof value.reason!=="string"
    ||typeof value.conflictFile!=="string"||!value.conflictFile.startsWith(destination+".conflict-")||!/^[a-f0-9]{64}$/.test(value.conflictFile.slice((destination+".conflict-").length)))throw new Error("Invalid local database conflict latch");
  return value;
}
function stamp(file: string): string | null {
  try {
    const st = fs.lstatSync(file, {bigint: true});
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Not a regular source database file: ${file}`);
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(":");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function sourceStamp(file: string): string | null {
  const database = stamp(file);
  return database === null ? null : JSON.stringify([database, stamp(`${file}-wal`)]);
}
/**
 * Content identity of a stamp: which file it is, how many bytes and when they
 * were written. The change time is dropped, because a cloud client updating
 * attributes, pin state or hydration rewrites it for databases nobody touched;
 * treating that as a change failed publication and reread whole archives. Real
 * content changes still move size, mtime or the digests compared beside this.
 */
const sameFile = (left: string | null, right: string | null) =>
  (left === null ? null : left.split(":").slice(0, 4).join(":"))
  === (right === null ? null : right.split(":").slice(0, 4).join(":"));
const sameSource = (left: string | null, right: string | null) => {
  if (left === null || right === null) return left === right;
  const parts = (value: string) => JSON.parse(value) as Array<string | null>;
  const [database, wal] = parts(left), [otherDatabase, otherWal] = parts(right);
  return sameFile(database ?? null, otherDatabase ?? null) && sameFile(wal ?? null, otherWal ?? null);
};
function readCheckpoint(file: string): Checkpoint | null {
  let value: Checkpoint;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (![1,2].includes(value.schema) || !["opencode", "gemini"].includes(value.vendor) || typeof value.source !== "string" || !path.isAbsolute(value.source)
    || typeof value.sourceStamp !== "string" || typeof value.destinationStamp !== "string" || !/^[a-f0-9]{64}$/.test(value.acceptedDigest)
    || (value.excludedTables !== undefined && (!Array.isArray(value.excludedTables) || value.excludedTables.some(name => typeof name !== "string")))) throw new Error(`Invalid local database publication checkpoint: ${file}`);
  return value;
}
export class SourceDatabasePublicationConflict extends Error {
  constructor(readonly conflictFile: string, reason: string) {
    super(`Source database archive unchanged: ${reason}. Accepted archive and first source evidence at '${conflictFile}' are preserved. NEW CHANGES TO THIS SOURCE ARE NOT ARCHIVED until the accepted database is repaired; work remains pending.`);
    this.name = "SourceDatabasePublicationConflict";
  }
}

/**
 * Frames in the archive's WAL belong to a writer whose changes the database file lacks. An empty
 * WAL holds none: it is what a reader that once opened the archive in place left behind, and a
 * cloud client keeps it forever. Reading its mere existence as a writer blocked every
 * publication of that database, including the check that nothing had changed.
 */
function hasActiveWal(database: string): boolean {
  const wal = stamp(`${database}-wal`);
  return wal !== null && wal.split(":")[2] !== "0";
}

/** Publishes one raw provider database; all progress and scratch data remain local. */
export function publishSourceDatabase(source: string, destination: string, vendor: SourceDatabaseVendor, options: SourceDatabasePublicationOptions = {}): SourceDatabasePublicationResult {
  source = path.resolve(source); destination = path.resolve(destination);
  if (source === destination) throw new Error("Provider source and archive destination must be distinct");
  const archiveRoot = path.resolve(options.archiveRoot ?? ARCHIVE_ROOT);
  const env: Record<string, string | undefined> = {...(options.env ?? process.env), TOKENATLAS_ARCHIVE: archiveRoot};
  const localStateRoot = options.localStateRoot ?? resolveLocalStateRootBase(env);
  env.TOKENATLAS_LOCAL_STATE = localStateRoot;
  if (!fs.existsSync(archiveRoot)) fs.mkdirSync(archiveRoot, {recursive: true});
  ensureArchiveIdentity(archiveRoot);
  return withArchiveWriter(archiveRoot, () => {
    const paths = archivePublicationPaths(archiveRoot, destination, {localStateRoot});
    if (!paths.relative.startsWith(`${vendor}/`)) throw new Error(`Archive destination does not belong to ${vendor}: ${destination}`);
    return withLocalArchiveLock(paths.lock, () => {
      const checkpointFile = path.join(paths.directory, "database-state.json");
      const conflictStateFile = path.join(paths.directory,"database-conflict.json");
      const before = sourceStamp(source), destinationBefore = stamp(destination);
      if (before === null) {
        if (destinationBefore === null) throw new Error(`Provider source database is unavailable and no archive exists: ${source}`);
        if (sourceDatabaseCredentialTables(destination).length) throw new Error(`Source database is unavailable; existing archive credential rows require explicit cleanup before reuse: ${destination}`);
        return {status: "unchanged", bytes: fs.statSync(destination).size, stable: false, sourceMissing: true};
      }
      if (hasActiveWal(destination)) throw new Error(`Archive database has an active WAL; close its writer before publication: ${destination}`);
      const blocked=readConflictLatch(conflictStateFile,destination);
      if(blocked) {
        if(blocked.source!==source||blocked.vendor!==vendor)throw new Error("Database conflict requires repair before changing its source identity");
        const currentDigest=destinationBefore===null?null:fileDigest(destination);
        if(!sameFile(stamp(destination),destinationBefore))throw new Error(`Archive database changed during inspection: ${destination}`);
        if(currentDigest===blocked.acceptedDigest)throw new SourceDatabasePublicationConflict(blocked.conflictFile,blocked.reason);
      }
      const prior = readCheckpoint(checkpointFile);
      if (destinationBefore === null && !prior && acceptedArchiveFingerprint(archiveRoot,destination,localStateRoot))
        throw new Error(`Archived source database is missing and its previously accepted bytes have no publication checkpoint: ${destination}`);
      if (destinationBefore === null && prior
        && (prior.schema !== 2 || prior.vendor !== vendor || prior.source !== source))
        throw new Error(`Archived source database is missing and its accepted checkpoint belongs to another source: ${destination}`);
      if (!blocked && !options.force && prior?.schema === 2 && prior.vendor === vendor && prior.source === source && sameSource(prior.sourceStamp, before) && sameFile(prior.destinationStamp, destinationBefore)) {
        return {status: "unchanged", bytes: fs.statSync(destination).size, stable: true};
      }
      const destinationDigest = destinationBefore === null ? null : fileDigest(destination);
      if (!sameFile(stamp(destination), destinationBefore)) throw new Error(`Archive database changed during inspection: ${destination}`);
      const workspace = createTemporaryWorkspace("source-database", resolveDbPath(undefined, env), env);
      try {
        const snapshot = path.join(workspace.directory, "snapshot.sqlite"), merged = path.join(workspace.directory, "merged.sqlite");
        let merge: SourceDatabaseMergeReport;
        try {
          const temporaryEnvironment={TMP:workspace.directory,TEMP:workspace.directory,TMPDIR:workspace.directory,SQLITE_TMPDIR:workspace.directory};
          const child=Bun.spawnSync([process.execPath,path.join(import.meta.dir,"source-database-worker.ts"),JSON.stringify({source,snapshot,archive:destinationBefore===null?null:destination,output:merged,vendor,temporaryDirectory:workspace.directory})],{env:{...process.env,...env,...temporaryEnvironment},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
          if(!sameSource(sourceStamp(source),before))throw new Error(`Provider database changed during snapshot/reconciliation; retry: ${source}`);
          const response=JSON.parse(child.stdout.toString()) as {merge?:SourceDatabaseMergeReport;error?:{reason?:SourceDatabaseConflict["reason"];table?:string;message:string}};
          if(response.error) {
            if(response.error.reason){const conflict=new SourceDatabaseConflict(response.error.reason,response.error.table??"",response.error.message);conflict.message=response.error.message;throw conflict;}
            throw new Error(response.error.message);
          }
          if(child.exitCode!==0||!response.merge)throw new Error(`SQLite source worker failed (exit ${child.exitCode})`);
          merge=response.merge;
        }
        catch (error) {
          if (!(error instanceof SourceDatabaseConflict)) throw error;
          if (error.reason === "sensitive-source-schema") throw error;
          if (!fs.existsSync(snapshot)) throw error;
          if(!sameFile(stamp(destination),destinationBefore)||(destinationBefore!==null&&fileDigest(destination)!==destinationDigest)||hasActiveWal(destination))throw new Error(`Archive database changed during reconciliation; retry: ${destination}`);
          const digest = fileDigest(snapshot), conflictFile = `${destination}.conflict-${digest}`;
          if (stamp(conflictFile) !== null) {
            if (fileDigest(conflictFile) !== digest) throw new Error(`Source database conflict evidence collision: ${conflictFile}`);
          } else atomicArchiveCopy(snapshot, conflictFile, digest);
          atomicLocalWrite(conflictStateFile,JSON.stringify({schema:1,source,vendor,acceptedDigest:destinationDigest,conflictFile,reason:error.message} satisfies ConflictLatch));
          throw new SourceDatabasePublicationConflict(conflictFile, error.message);
        }
        if (destinationBefore === null && prior && fileDigest(merged) !== prior.acceptedDigest)
          throw new Error(`Archived source database is missing and the original cannot prove its accepted snapshot: ${destination}`);
        const acceptedDigest = merge.status === "updated" ? fileDigest(merged) : destinationDigest!;
        const currentDestinationDigest = destinationBefore === null ? null : fileDigest(destination);
        if (!sameFile(stamp(destination), destinationBefore) || currentDestinationDigest !== destinationDigest || hasActiveWal(destination)) {
          throw new Error(`Archive database changed during reconciliation; retry: ${destination}`);
        }
        if (!sameSource(sourceStamp(source), before)) throw new Error(`Provider database changed during reconciliation; retry: ${source}`);
        if (merge.status === "updated") atomicArchiveCopy(merged, destination, acceptedDigest);
        const stable = sameSource(sourceStamp(source), before);
        const destinationAfter = stamp(destination);
        if (!destinationAfter || fileDigest(destination) !== acceptedDigest || !sameFile(stamp(destination), destinationAfter)) throw new Error(`Archive database changed after publication; retry: ${destination}`);
        if (stable) {
          const next: Checkpoint = {schema: 2, vendor, source, sourceStamp: before, destinationStamp: destinationAfter, acceptedDigest, ...(merge.excludedTables ? {excludedTables:merge.excludedTables} : {})};
          atomicLocalWrite(checkpointFile, JSON.stringify(next));
          fs.rmSync(conflictStateFile,{force:true});
        }
        return {status: merge.status === "updated" ? "created" : "unchanged", bytes: fs.statSync(destination).size, stable, merge};
      } finally { workspace.dispose(); }
    });
  });
}
