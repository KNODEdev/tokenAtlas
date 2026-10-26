import { archiveSourceIdentity, compressedArchiveSource } from "../shared/archive-codec-path";
import fs from "node:fs";
import { ArchivePublicationConflictError, archivePublicationPaths, publishArchiveFile } from "./archive-publication";
import { createHash } from "node:crypto";
import path from "node:path";
import { ARCHIVE_ROOT, ATLAS_INDEX_SNAPSHOT_DIRECTORY, HOME_DIR, LOGIN, MACHINE, archive, requireArchiveRoot, configFile, expandPhysicalPath } from "../config/paths";
import type { SyncMode, VendorId } from "./contracts";
import { VENDOR_IDS } from "./contracts";
import type { SyncFileRoot } from "./file-queue";
import { mirrorDesktop } from "../../scripts/dev/mirror-desktop";
import { publishSourceDatabase } from "./source-database-publication";
import { readStartupAccounts } from "../config/accounts-document";
import { resolveDbPath } from "../db";

export interface MirrorResult {
  copied: number;
  skipped: number;
  warnings: string[];
  errors: string[];
  archiveFiles?: string[];
  failedFiles?: string[];
  /** Called once per source file handled (progress only; not stored with the result). */
  onFile?: () => void;
  /** Internal notification after a source was durably published; excluded from stored diagnostics. */
  onPublished?: (source:string,archive:string)=>void;
}

interface ProfileDeclaration { vendor: string; machine?: string; source_home?: string; home: string }
const MAX_ARCHIVE_PUBLICATION_ATTEMPTS = 3;
function isArchivePublicationConflict(error: unknown, source: string, destination: string): boolean {
  return error instanceof Error && (
    error.message === `Archive source changed while reading: ${source}` ||
    error.message === `Archive destination changed while reading: ${destination}` ||
    error.message === `Archive destination changed during publication: ${destination}`
  );
}
function publishMirrorFile(source: string, destination: string, archiveRoot: string): "copied" | "unchanged" | "recorded" {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return publishArchiveFile(source, destination, { archiveRoot, jsonl: source.endsWith(".jsonl") });
    } catch (error) {
      // A divergence raised before, over these same bytes, is a decision on record:
      // report it every run, but do not fail a copy pass that can never take them.
      if (error instanceof ArchivePublicationConflictError && error.alreadyRecorded) return "recorded";
      if (attempt >= MAX_ARCHIVE_PUBLICATION_ATTEMPTS || !isArchivePublicationConflict(error, source, destination)) throw error;
    }
  }
}
export function profileMirrorTargets(vendor: "codex" | "claude" | "grok" | "gemini", profiles: Array<{ login: string; home: string }>,
  declarations: ProfileDeclaration[] = loadProfileDeclarations()): Array<{ source: string; destination: string }> {
  const key = (p: string) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
  const sourceSuffix = { codex: "sessions", claude: "projects", grok: "sessions", gemini: path.join("antigravity-cli", "conversations") }[vendor];
  const destinationSuffix = { codex: "sessions", claude: "", grok: "sessions", gemini: "conversations" }[vendor];
  const declared = declarations.filter(d => d.vendor === vendor && d.source_home &&
    (!d.machine || d.machine.toLowerCase() === MACHINE.toLowerCase()))
    .map(d => ({ source: path.join(expandPhysicalPath(d.source_home!), sourceSuffix),
      destination: path.join(expandPhysicalPath(d.home!), destinationSuffix) }));
  const defaults = vendor === "claude"
    ? [{ source: path.join(HOME_DIR, ".claude", "projects"), destination: archive("claude", MACHINE) }]
    : profiles.map(p => ({ source: path.join(p.home, `.${vendor}`, sourceSuffix), destination: archive(vendor, `${MACHINE}-${p.login}`, destinationSuffix) }));
  // A moved profile replaces the old writer, while its existing archive remains intact.
  const targets = [...defaults.filter(d => !declared.some(p => key(p.source) === key(d.source) || key(p.destination) === key(d.destination))), ...declared]
    .filter((target, i, all) => all.findIndex(p => key(p.source) === key(target.source) && key(p.destination) === key(target.destination)) === i);
  return vendor === "codex" ? targets.flatMap(target => [target, {
    source: path.join(path.dirname(target.source), "archived_sessions"),
    destination: path.join(path.dirname(target.destination), "archived_sessions"),
  }]) : targets;
}
function loadProfileDeclarations(): ProfileDeclaration[] {
  return readStartupAccounts(configFile("accounts.json"), resolveDbPath()).sources;
}

function fingerprintTree(
  root: string,
  hash: ReturnType<typeof createHash>,
  ignore?: (candidate: string) => boolean
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    hash.update(`${root}\0${isMissingSourceError(error) ? "missing" : String(error)}\n`);
    return;
  }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (ignore?.(file)) continue;
    if (entry.isDirectory()) {
      fingerprintTree(file, hash, ignore);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(file);
        hash.update(`${file}\0${stat.size}\0${stat.mtimeMs}\n`);
      } catch (error) {
        hash.update(`${file}\0${String(error)}\n`);
      }
    }
  }
}

/**
 * Local paths whose change means "this vendor has new data to mirror": exactly
 * what mirrorVendorSources copies, nothing wider. The OpenCode store and the
 * Antigravity home hold tens of thousands of files the mirror never reads
 * (snapshots, caches); stat-walking them cost more than the ingest itself.
 */
export function vendorLocalSourceRoots(
  vendor: VendorId,
  profiles: Array<{ login: string; home: string }>,
  declarations?: ProfileDeclaration[]
): string[] {
  switch (vendor) {
    case "codex":
      return [
        ...profileMirrorTargets("codex", profiles, declarations).map(p => p.source),
        path.join(HOME_DIR, ".codex", "delegate-ledger.jsonl"),
      ];
    case "claude":
      return [
        ...profileMirrorTargets("claude", profiles, declarations).map(p => p.source),
        path.join(process.env.APPDATA || path.join(HOME_DIR, "AppData", "Roaming"), "Claude", "local-agent-mode-sessions"),
      ];
    case "opencode": {
      const db = path.join(HOME_DIR, ".local", "share", "opencode", "opencode.db");
      return [db, `${db}-wal`];
    }
    case "grok":
      return profileMirrorTargets("grok", profiles, declarations).map(target => target.source);
    case "gemini":
      return [
        ...profileMirrorTargets("gemini", profiles, declarations).flatMap(target => [target.source, path.join(path.dirname(target.source), "history.jsonl")]),
      ];
    case "gauges":
      // Journals are written straight into the archive by the probes; the local
      // machine's own journal is never ingested incrementally, so it is left out
      // of the fingerprint too or every probe cycle would mark the vendor dirty.
      return [];
  }
}

/**
 * Is this archive path one this machine writes itself (its mirrors, ledger and
 * gauge journal)? Those subtrees change only through the local roots above,
 * so the fingerprint skips them and the watcher ignores their events.
 */
export function isOwnArchiveDestination(candidate: string | null, archiveRoot: string = ARCHIVE_ROOT): boolean {
  if (!candidate) return false;
  const relative = path.relative(archiveRoot, path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const [vendor, profile] = relative.split(path.sep);
  // Legacy shared snapshots must never wake the archive watcher. Current
  // snapshots live in the machine-local application data directory.
  if (vendor === ATLAS_INDEX_SNAPSHOT_DIRECTORY) return true;
  if (!vendor || !profile) return false;
  const profileLower = profile.toLowerCase();
  const machineLower = MACHINE.toLowerCase();
  if (vendor === "codex") return profile === "_ledger" || profileLower.startsWith(`${machineLower}-`);
  if (vendor === "claude") return profileLower === machineLower || profileLower === `${machineLower}-desktop`;
  if (vendor === "opencode") return profileLower === machineLower;
  if (vendor === "gauges") return profileLower === `${machineLower}-${LOGIN.toLowerCase()}`;
  return (vendor === "grok" || vendor === "gemini") && profileLower.startsWith(`${machineLower}-`);
}

export function vendorSourceFingerprint(vendor: VendorId): string {
  const hash = createHash("sha256");
  // Revisit unchanged archives when the Codex parser gains new historical facts.
  if (vendor === "codex") hash.update("codex-parser:3:all-history\n");
  if (vendor === "claude") hash.update("claude-parser:2:session-identity-dates:desktop3:cloud-funding7\n");
  const profiles = userProfiles({ copied: 0, skipped: 0, warnings: [], errors: [] });
  for (const root of [...vendorLocalSourceRoots(vendor, profiles), archive(vendor)]) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch (error) {
      hash.update(`${root}\0${isMissingSourceError(error) ? "missing" : String(error)}\n`);
      continue;
    }
    if (stat.isDirectory()) {
      fingerprintTree(root, hash, root === archive(vendor) ? (candidate) => isOwnArchiveDestination(candidate) : undefined);
    }
    else hash.update(`${root}\0${stat.size}\0${stat.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

export function isMissingSourceError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function userProfiles(result: MirrorResult): Array<{ login: string; home: string }> {
  const parent = path.dirname(HOME_DIR);
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ login: entry.name, home: path.join(parent, entry.name) }));
  } catch (error) {
    result.errors.push(`Cannot enumerate user profiles: ${String(error)}`);
    return [{ login: LOGIN, home: HOME_DIR }];
  }
}

export function syncFileRoots():SyncFileRoot[] {
  const profiles=userProfiles({copied:0,skipped:0,warnings:[],errors:[]});
  return VENDOR_IDS.flatMap(vendor=>[
    ...vendorLocalSourceRoots(vendor,profiles).map(file=>({path:file,vendor,kind:"source" as const})),
    {path:archive(vendor),vendor,kind:"archive" as const},
  ]);
}

/**
 * This machine's transcript folders and their archive folders (Codex sessions and archived
 * sessions, Claude projects, Grok sessions): what archive-verification.ts reads side by side.
 */
export function archiveCopyRoots(): Array<{ source: string; destination: string }> {
  const profiles = userProfiles({ copied: 0, skipped: 0, warnings: [], errors: [] });
  return (["codex", "claude", "grok"] as const).flatMap(vendor => profileMirrorTargets(vendor, profiles).flatMap(target => vendor !== "codex" ? [target]
    : [target, { source: path.join(path.dirname(target.source), "archived_sessions"), destination: path.join(path.dirname(target.destination), "archived_sessions") }]));
}

/** Archive discovery never enumerates provider homes. */
export function archiveFileRoots():SyncFileRoot[] {
  return VENDOR_IDS.map(vendor=>({path:archive(vendor),vendor,kind:"archive"}));
}

/** Resolve only this machine's archive destinations back to their provider originals. */
export function originalForOwnArchiveFile(vendor:VendorId,file:string):string|null {
  // A missing destination may be recreated only against a retained publication
  // checkpoint. Without it there is no proof that provider history is complete.
  file = archiveSourceIdentity(file);
  let paths:ReturnType<typeof archivePublicationPaths>;
  try { paths=archivePublicationPaths(ARCHIVE_ROOT,file); }
  catch { return null; }
  const proof=vendor==="opencode"||vendor==="gemini"
    ? path.join(paths.directory,"database-state.json"):paths.state;
  if(!fs.existsSync(proof))return null;
  const within=(root:string)=>{const relative=path.relative(path.resolve(root),path.resolve(file));
    return relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative)?relative:null;};
  if(vendor==="gauges")return null;
  if(vendor==="opencode")return path.resolve(file)===path.resolve(archive("opencode",MACHINE,"opencode.sqlite"))
    ? path.join(HOME_DIR,".local","share","opencode","opencode.db"):null;
  if(vendor==="codex") {
    const ledger=within(archive("codex","_ledger"));
    if(ledger==="delegate-ledger.jsonl")return path.join(HOME_DIR,".codex","delegate-ledger.jsonl");
  }
  if(vendor==="claude") {
    const desktop=within(archive("claude",`${MACHINE}-desktop`));
    if(desktop!==null)return path.join(process.env.APPDATA||path.join(HOME_DIR,"AppData","Roaming"),"Claude","local-agent-mode-sessions",desktop);
  }
  const profiles=userProfiles({copied:0,skipped:0,warnings:[],errors:[]});
  for(const target of profileMirrorTargets(vendor,profiles)) {
    const relative=within(target.destination);
    if(relative!==null)return path.join(target.source,relative);
    if(vendor==="gemini"&&path.resolve(file)===path.resolve(path.join(path.dirname(target.destination),"history.jsonl")))
      return path.join(path.dirname(target.source),"history.jsonl");
  }
  return null;
}

export function copyFileToArchive(source: string, destination: string, result: MirrorResult, archiveRoot = ARCHIVE_ROOT): void {
  try { copySourceFile(source, destination, result, archiveRoot); } finally { result.onFile?.(); }
}
function copySourceFile(source: string, destination: string, result: MirrorResult, archiveRoot: string): void {
  try {
    fs.statSync(source);
  } catch (error) {
    if(!isMissingSourceError(error))(result.failedFiles??=[]).push(source);
    (isMissingSourceError(error) ? result.warnings : result.errors).push(
      `${source}: ${isMissingSourceError(error) ? "source absent" : String(error)}`
    );
    return;
  }
  try {
    const status = publishMirrorFile(source, destination, archiveRoot);
    const retained = !fs.existsSync(destination) && (compressedArchiveSource(destination) || destination.endsWith(".jsonl"))
      ? [archiveSourceIdentity(destination), `${archiveSourceIdentity(destination)}.zst`].find(file => fs.existsSync(file)) ?? destination : destination;
    (result.archiveFiles??=[]).push(retained);
    if (status === "copied") result.copied++;
    else result.skipped++;
    // A divergence this archive already holds as evidence stays visible every run
    // without failing the vendor over bytes no publication may take.
    if (status === "recorded") result.warnings.push(`${source}: source diverges from the accepted archive; kept as evidence`);
    result.onPublished?.(source,retained);
  } catch (error) {
    result.errors.push(`${source}: ${String(error)}`);
    (result.failedFiles??=[]).push(source);
  }
}

export function copyDirectoryAdditive(
  source: string,
  destination: string,
  result: MirrorResult,
  includeFile: (candidate: string) => boolean = () => true
): void {
  try {
    if (!fs.statSync(source).isDirectory()) {
      result.errors.push(`${source}: source is not a directory`);
      return;
    }
  } catch (error) {
    (isMissingSourceError(error) ? result.warnings : result.errors).push(
      `${source}: ${isMissingSourceError(error) ? "source absent" : String(error)}`
    );
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch (error) {
    result.errors.push(`${source}: ${String(error)}`);
    return;
  }
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectoryAdditive(from, to, result, includeFile);
    else if (entry.isFile() && includeFile(from)) copyFileToArchive(from, to, result);
  }
}

export async function mirrorVendorSources(
  vendor: VendorId,
  rootDir: string,
  mode: SyncMode,
  changedPaths?:string[],
  onProgress?:(completed:number,total:number|null)=>void,
  onSourceArchived?:(source:string,archives:readonly string[])=>void,
): Promise<MirrorResult> {
  requireArchiveRoot();
  const result: MirrorResult = { copied: 0, skipped: 0, warnings: [], errors: [] };
  // A queued batch has a known size; a whole-folder walk reports files handled so far.
  const total = changedPaths ? new Set(changedPaths.map(file => path.resolve(file))).size : null;
  let handled = 0;
  if (onProgress) Object.defineProperty(result, "onFile", { enumerable: false, value: () => onProgress(++handled, total) });
  // Gauge journals are appended in place by the probes; there is nothing local to copy.
  if (vendor === "gauges") return result;
  const profiles = userProfiles(result);
  const copyDatabase=(source:string,destination:string,databaseVendor:"opencode"|"gemini")=>{
    try {
      const published=publishSourceDatabase(source,destination,databaseVendor,{force:mode==="full"});
      if(published.status==="created")result.copied++;else result.skipped++;
      result.onFile?.();
      if(!published.stable&&!published.sourceMissing)throw new Error(`Provider database changed during publication; retry: ${source}`);
      (result.archiveFiles??=[]).push(destination);
    } catch(error) {result.errors.push(`${source}: ${String(error)}`);(result.failedFiles??=[]).push(source);}
  };
  const desktopRoot=path.join(process.env.APPDATA||path.join(HOME_DIR,"AppData","Roaming"),"Claude","local-agent-mode-sessions");
  const copyDesktop=(files?:string[])=>{
    try {
      const desktop=mirrorDesktop(desktopRoot,archive("claude",`${MACHINE}-desktop`),ARCHIVE_ROOT,files,
        file=>(result.archiveFiles??=[]).push(file));
      result.copied+=desktop.copied;result.skipped+=desktop.unchanged;
    } catch(error) {result.errors.push(String(error));if(files)(result.failedFiles??=[]).push(...files);}
  };
  if(changedPaths) {
    const inside=(root:string,file:string)=>{const rel=path.relative(path.resolve(root),path.resolve(file));return rel===""||(rel!==".."&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel));};
    const selected=[...new Set(changedPaths.map(file=>path.resolve(vendor==="gemini"?file.replace(/\.db-(wal|shm)$/,".db"):file)))];
    if(vendor!=="opencode") {
      const tasks:Array<()=>void>=[],planned=new Set<string>(),expected=new Map<string,number>(),published=new Map<string,string[]>();
      const sourceKey=(file:string)=>process.platform==="win32"?path.resolve(file).toLowerCase():path.resolve(file);
      const planFile=(source:string,destination:string)=>{
        const id=sourceKey(source),pair=JSON.stringify([id,sourceKey(destination)]);
        if(planned.has(pair))return;
        planned.add(pair);expected.set(id,(expected.get(id)??0)+1);
        tasks.push(()=>copyFileToArchive(source,destination,result));
      };
      if(onSourceArchived)Object.defineProperty(result,"onPublished",{enumerable:false,value:(source:string,archiveFile:string)=>{
        const id=sourceKey(source),files=[...published.get(id)??[],archiveFile];
        if(files.length===expected.get(id))onSourceArchived(source,files);
        published.set(id,files);
      }});
      for(const target of profileMirrorTargets(vendor,profiles))for(const file of selected) {
        if(vendor==="grok"&&path.basename(file)!=="updates.jsonl")continue;
        if(inside(target.source,file)&&(!vendor.includes("claude")||file.endsWith(".jsonl"))) {
          const destination=path.join(target.destination,path.relative(target.source,file));
          if(vendor==="gemini") {if(file.endsWith(".db"))tasks.push(()=>copyDatabase(file,destination,"gemini"));}
          else planFile(file,destination);
        }
        if(vendor==="codex"&&file===path.join(path.dirname(target.source),"delegate-ledger.jsonl"))
          planFile(file,path.join(path.dirname(target.destination),"delegate-ledger.jsonl"));
        if(vendor==="gemini"&&file===path.join(path.dirname(target.source),"history.jsonl"))
          planFile(file,path.join(path.dirname(target.destination),"history.jsonl"));
      }
      if(vendor==="codex"&&selected.includes(path.join(HOME_DIR,".codex/delegate-ledger.jsonl")))
        planFile(path.join(HOME_DIR,".codex/delegate-ledger.jsonl"),archive("codex","_ledger","delegate-ledger.jsonl"));
      for(const task of tasks)task();
      if(vendor==="claude")copyDesktop(selected.filter(file=>inside(desktopRoot,file)));
      return result;
    }
    if(!selected.length)return result;
  }
  if (vendor === "codex") {
    const copiedPairs = new Set<string>();
    const pairKey = (source: string, destination: string): string => {
      const normalize = (value: string) => {
        const resolved = path.resolve(value).replaceAll("\\", "/");
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      };
      return `${normalize(source)}\0${normalize(destination)}`;
    };
    const copyDirectoryOnce = (source: string, destination: string): void => {
      const key = pairKey(source, destination);
      if (copiedPairs.has(key)) return;
      copiedPairs.add(key);
      copyDirectoryAdditive(source, destination, result);
    };
    const copyFileOnce = (source: string, destination: string): void => {
      const key = pairKey(source, destination);
      if (copiedPairs.has(key)) return;
      copiedPairs.add(key);
      copyFileToArchive(source, destination, result);
    };
    for (const profile of profileMirrorTargets("codex", profiles)) {
      copyDirectoryOnce(profile.source, profile.destination);
      const sourceHome=path.dirname(profile.source),destinationHome=path.dirname(profile.destination);
      copyDirectoryOnce(path.join(sourceHome,"archived_sessions"),path.join(destinationHome,"archived_sessions"));
      copyFileOnce(path.join(sourceHome,"delegate-ledger.jsonl"),path.join(destinationHome,"delegate-ledger.jsonl"));
    }
    copyFileOnce(
      path.join(HOME_DIR, ".codex", "delegate-ledger.jsonl"),
      archive("codex", "_ledger", "delegate-ledger.jsonl")
    );
  } else if (vendor === "claude") {
    for (const profile of profileMirrorTargets("claude", profiles)) {
      // Memory and editor artefacts live beside transcripts but are not session inputs.
      copyDirectoryAdditive(profile.source, profile.destination, result,
        candidate => candidate.toLowerCase().endsWith(".jsonl"));
    }
    copyDesktop();
  } else if (vendor === "opencode") {
    const source = path.join(HOME_DIR, ".local", "share", "opencode", "opencode.db");
    let sourceAvailable = false;
    try {
      sourceAvailable = fs.statSync(source).isFile();
      if (!sourceAvailable) result.errors.push(`${source}: source is not a file`);
    } catch (error) {
      (isMissingSourceError(error) ? result.warnings : result.errors).push(
        `${source}: ${isMissingSourceError(error) ? "source absent" : String(error)}`
      );
    }
    if (sourceAvailable) {
      const destination = archive("opencode", MACHINE, "opencode.sqlite");
      copyDatabase(source,destination,"opencode");
    }
  } else if (vendor === "grok") {
    for (const target of profileMirrorTargets("grok", profiles)) copyDirectoryAdditive(target.source, target.destination, result,file=>path.basename(file)==="updates.jsonl");
  } else {
    for (const target of profileMirrorTargets("gemini", profiles)) {
      try {
        for(const entry of fs.readdirSync(target.source,{withFileTypes:true}))
          if(entry.isFile()&&entry.name.endsWith(".db"))copyDatabase(path.join(target.source,entry.name),path.join(target.destination,entry.name),"gemini");
      } catch(error) {(isMissingSourceError(error)?result.warnings:result.errors).push(`${target.source}: ${String(error)}`);}
      copyFileToArchive(path.join(path.dirname(target.source), "history.jsonl"), path.join(path.dirname(target.destination), "history.jsonl"), result);
    }
  }
  return result;
}
