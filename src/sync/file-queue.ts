import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentStamp, fingerprint, metadata, missing, stamp } from "./file-fingerprint";
import { fingerprintAll, type FingerprintResult } from "./fingerprint-batch";
import { stampAll } from "./stamp-batch";
import { Database } from "../db/sqlite";
import { localStateRoot } from "../config/local-identity";
import { archiveCodecSource, archiveSourceIdentity } from "../shared/archive-codec-path";
import type { VendorId } from "./contracts";

export interface SyncFileRoot { path:string; vendor:VendorId; kind:"source"|"archive" }
export interface QueuedSyncFile { path:string; vendor:VendorId; revision:number; kind:"source"|"archive"; fingerprint:string }
export interface SyncFileFailure { path:string; error:string }
export interface SyncFileQueueOptions { reconcileMinutes?:number }
const key=(file:string)=>process.platform==="win32"?path.resolve(file).toLowerCase():path.resolve(file);
const ignored=(file:string)=>/\.conflict-[a-f0-9]{64}(?:\.|$)/i.test(file)||/\.tmp(?:-|$)/i.test(file);
const batchSize=512;
// Files hashed per parallel batch; progress is reported between batches.
const verifySlice=2048;
// Files a walk states per batch; progress moves between batches.
const statSlice=4096;
const identityOf=(result:FingerprintResult|undefined,file:string):string=>{
  if(!result)return fingerprint(file);
  if("error" in result)throw new Error(result.error);
  return result.fingerprint;
};
const content=(value:string)=>value==="missing"?value:JSON.parse(value)[1] as string|null;
/**
 * Whether a folder between `file` and its root (the root included) is a symbolic link. Files of
 * one pass share their folders, so `memo` keeps each folder's answer for that pass; a missing
 * folder counts as no link, and any other error is thrown uncached, as before.
 */
function symlinkAncestor(root:string,file:string,memo:Map<string,boolean>):boolean {
  const rootKey=key(root),visited:string[]=[];
  let found=false;
  for(let ancestor=path.dirname(file);;ancestor=path.dirname(ancestor)) {
    const ancestorKey=key(ancestor);
    if(!holds(rootKey,ancestorKey))break;
    const memoKey=rootKey+"|"+ancestorKey,known=memo.get(memoKey);
    if(known!==undefined){found=known;break;}
    visited.push(memoKey);
    try{if(fs.lstatSync(ancestor).isSymbolicLink()){found=true;break;}}catch(error){if(!missing(error))throw error;}
    if(ancestorKey===rootKey||path.dirname(ancestor)===ancestor)break;
  }
  for(const visitedKey of visited)memo.set(visitedKey,found);
  return found;
}
/** Whether `take()` would hash this file: an ordinary file with no symbolic-link ancestor below its root. */
function plainFileUnder(root:string,file:string,memo:Map<string,boolean>):boolean {
  try {
    if(symlinkAncestor(root,file,memo))return false;
    const stat=fs.lstatSync(file);
    return stat.isFile()&&!stat.isSymbolicLink();
  } catch {return false;}
}
/** Whether the key `fileKey` is `folderKey` or lies below it. Keys are resolved, so this is a prefix test. */
function holds(folderKey:string,fileKey:string) {
  return fileKey===folderKey||fileKey.startsWith(folderKey.endsWith(path.sep)?folderKey:folderKey+path.sep);
}
function within(root:string,file:string) {return holds(key(root),key(file));}
/**
 * The first of a key and its folders, upwards, that `find` answers. A containment test against a
 * set of folders costs the depth of the path, not a comparison with every folder of the set (the
 * live queue holds ~54k files; comparing each with every unreadable entry took minutes).
 */
function nearest<T>(fileKey:string,find:(folderKey:string)=>T|undefined):T|undefined {
  for(let at=fileKey;;) {
    const found=find(at);
    if(found!==undefined)return found;
    const parent=path.dirname(at);
    if(parent===at)return undefined;
    at=parent;
  }
}
/** The most specific root of a vendor that holds a file key. */
function rootIndex(roots:SyncFileRoot[]) {
  const byKey=new Map<string,SyncFileRoot>();
  for(const root of [...roots].sort((a,b)=>b.path.length-a.path.length)) {
    const entry=`${root.vendor}|${key(root.path)}`;
    if(!byKey.has(entry))byKey.set(entry,root);
  }
  return (vendor:VendorId,fileKey:string)=>nearest(fileKey,folder=>byKey.get(`${vendor}|${folder}`));
}
const nameKey=(name:string)=>process.platform==="win32"?name.toLowerCase():name;
const absent=(error:unknown)=>missing(error)||(error as NodeJS.ErrnoException)?.code==="ENOTDIR";

/** Progress of a queue pass: items handled so far, of a total when it is known. */
export type QueueProgress = (done:number,total:number|null)=>void;
function queueDatabase(archiveRoot:string,stateRoot:string):string {
  return path.join(stateRoot,"sync-file-queues",createHash("sha256").update(key(archiveRoot)).digest("hex")+".sqlite");
}
/** Actual durable pending entries tagged by a scoped background repair. */
export function readPendingSyncFileTasks(archiveRoot:string,vendor:VendorId,task:string,stateRoot=localStateRoot()):Array<{path:string;data:string}> {
  const file=queueDatabase(archiveRoot,stateRoot);
  if(!fs.existsSync(file))return [];
  const db=new Database(file,{readonly:true});
  try {
    return db.query(`SELECT p.path,s.value data FROM pending p JOIN state s ON s.key=?||p.path_key
      WHERE p.vendor=? ORDER BY p.revision`).all(`task:${task}:`,vendor) as Array<{path:string;data:string}>;
  } finally {db.close();}
}
/** Read-only proof that this installation previously accepted an archive file. */
export function acceptedArchiveFingerprint(archiveRoot:string,file:string,stateRoot=localStateRoot()):string|null {
  if(!within(archiveRoot,file))return null;
  const database=queueDatabase(archiveRoot,stateRoot);
  if(!fs.existsSync(database))return null;
  const sqlite=new Database(database,{readonly:true});
  try {
    try {
      const retained=sqlite.query("SELECT fingerprint FROM accepted_archive WHERE path_key=?").get(key(file)) as {fingerprint:string}|null;
      if(retained)return retained.fingerprint==="missing"?null:retained.fingerprint;
    } catch(error) {
      if(!/no such table: accepted_archive/i.test(String(error)))throw error;
    }
    const older=(sqlite.query("SELECT fingerprint FROM files WHERE path_key=?").get(key(file)) as {fingerprint:string}|null)?.fingerprint;
    return older&&older!=="missing"?older:null;
  } finally {sqlite.close(true);}
}
/** Local durable work; acknowledging after publication makes a crash a safe retry. */
export class SyncFileQueue {
  private readonly db:Database;
  private readonly reconciliationIntervalMs:number;
  private readonly selectionFailures=new Map<VendorId,SyncFileFailure[]>();
  private readonly scanFailures=new Map<VendorId,SyncFileFailure[]>();
  /** Stamps of the files the last `prepare` walked, by path key; valid for that pass only. */
  private readonly listed=new Map<string,string>();
  constructor(private readonly archiveRoot:string,stateRoot=localStateRoot(),options:SyncFileQueueOptions={}) {
    const interval=Number(options.reconcileMinutes??process.env.TOKENATLAS_RECONCILE_MINUTES??60)*60000;
    this.reconciliationIntervalMs=Number.isFinite(interval)&&interval>0?interval:3600000;
    fs.mkdirSync(path.join(stateRoot,"sync-file-queues"),{recursive:true});
    const file=queueDatabase(archiveRoot,stateRoot);
    this.db=new Database(file,{create:true});
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending(path_key TEXT PRIMARY KEY,path TEXT NOT NULL,vendor TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_vendor ON pending(vendor,revision);
      CREATE TABLE IF NOT EXISTS files(path_key TEXT PRIMARY KEY,path TEXT NOT NULL,vendor TEXT NOT NULL,stamp TEXT NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accepted_archive(path_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS walks(path_key TEXT PRIMARY KEY,path TEXT NOT NULL,vendor TEXT NOT NULL);
      INSERT OR IGNORE INTO state VALUES('sequence','0');`);
  }
  close(){this.db.close();}
  hasPending(vendor:VendorId,file?:string):boolean {
    return !!(file===undefined ? this.db.query("SELECT 1 FROM pending WHERE vendor=? LIMIT 1").get(vendor)
      : this.db.query("SELECT 1 FROM pending WHERE vendor=? AND path_key=?").get(vendor,key(file)));
  }
  /** Read queue metadata only; content verification belongs to the vendor's processing turn. */
  pendingRevision(vendor:VendorId,roots:SyncFileRoot[]):number|null {
    const rootOf=rootIndex(roots);
    let revision:number|null=null;
    for(const row of this.db.query("SELECT path_key,revision FROM pending WHERE vendor=?").iterate(vendor) as Iterable<{path_key:string;revision:number}>) {
      if(rootOf(vendor,row.path_key))revision=Math.max(revision??0,row.revision);
    }
    return revision;
  }
  fileTaskState(task:string,file:string):string|undefined {return this.taskState(`${task}:${key(file)}`);}
  setFileTaskState(task:string,file:string,value:string):void {this.setTaskState(`${task}:${key(file)}`,value);}
  takeFailures(vendor:VendorId):SyncFileFailure[] {return (this.selectionFailures.get(vendor)??[]).map(row=>({...row}));}
  reconciliationFailures(vendor:VendorId):SyncFileFailure[] {return (this.scanFailures.get(vendor)??[]).map(row=>({...row}));}
  private get(name:string){return (this.db.query("SELECT value FROM state WHERE key=?").get(name) as {value:string}|null)?.value;}
  private set(name:string,value:string){this.db.query("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(name,value);}
  enqueue(file:string,vendor:VendorId) {
    if(ignored(file))return;
    this.enqueueBatch([{path:file,vendor}]);
  }
  /** Accept an original only in the transaction that leaves all its archived outputs pending import. */
  checkpointMirroredSource(row:QueuedSyncFile,archives:readonly string[]):Array<Pick<QueuedSyncFile,"path"|"vendor"|"revision">> {
    if(row.kind!=="source"||row.fingerprint==="missing"||!archives.length)throw new Error("A mirror checkpoint needs a source and archived outputs");
    const files=[...new Map(archives.map(file=>[key(file),path.resolve(file)])).values()];
    for(const file of files)if(!within(this.archiveRoot,file)||key(file)===key(row.path)||metadata(file)==="missing")
      throw new Error(`Mirrored archive output is unavailable: ${file}`);
    const current=metadata(row.path),before=JSON.parse(row.fingerprint)[0] as string;
    const unchanged=current!=="missing"&&contentStamp(current)===contentStamp(before);
    return this.db.transaction(()=>{
      let revision=Number(this.get("sequence")??0);
      const insert=this.db.query("INSERT INTO pending VALUES(?,?,?,?) ON CONFLICT(path_key) DO UPDATE SET path=excluded.path,vendor=excluded.vendor,revision=excluded.revision");
      const pending=files.map(file=>{
        const queued={path:file,vendor:row.vendor,revision:++revision};
        insert.run(key(file),file,row.vendor,queued.revision);
        this.set(`mirror-original:${key(file)}`,JSON.stringify({source:row.path}));
        return queued;
      });
      this.set("sequence",String(revision));
      if(unchanged)this.acceptRows([row]);
      return pending;
    }).immediate();
  }
  private enqueueBatch(rows:{path:string;vendor:VendorId}[]) {
    if(!rows.length)return;
    this.db.transaction(()=>{
      let revision=Number(this.get("sequence")??0);
      const insert=this.db.query("INSERT INTO pending VALUES(?,?,?,?) ON CONFLICT(path_key) DO UPDATE SET path=excluded.path,vendor=excluded.vendor,revision=excluded.revision");
      for(const row of rows)insert.run(key(row.path),path.resolve(row.path),row.vendor,++revision);
      this.set("sequence",String(revision));
    }).immediate();
  }
  /** Asks for every root to be walked again by the next `prepare`. */
  reconcileLater(){
    this.db.transaction(()=>this.set("reconcile_request",String(Number(this.get("reconcile_request")??0)+1))).immediate();
  }
  /** Queue state of a one-time task; it lives with the queue, never in the tracked atlas `meta`. */
  taskState(name:string):string|undefined {return this.get(`task:${name}`);}
  setTaskState(name:string,value:string) {this.set(`task:${name}`,value);}
  /** An empty Atlas index must reread archive files accepted by an older index. */
  revisitAcceptedForTask(name:string,roots:SyncFileRoot[],include:(vendor:VendorId,file:string)=>boolean):void {
    if(this.taskState(name))return;
    const accepted=this.db.query("SELECT path_key,path,vendor,fingerprint FROM files").all() as Array<{path_key:string;path:string;vendor:VendorId;fingerprint:string}>;
    const rootOf=rootIndex(roots);
    this.db.transaction(()=>{
      if(this.taskState(name))return;
      let revision=Number(this.get("sequence")??0);
      const remove=this.db.query("DELETE FROM files WHERE path_key=?");
      const enqueue=this.db.query("INSERT INTO pending VALUES(?,?,?,?) ON CONFLICT(path_key) DO UPDATE SET path=excluded.path,vendor=excluded.vendor,revision=excluded.revision");
      const retain=this.db.query("INSERT INTO accepted_archive(path_key,fingerprint) VALUES(?,?) ON CONFLICT(path_key) DO UPDATE SET fingerprint=excluded.fingerprint");
      for(const row of accepted) {
        if(!rootOf(row.vendor,row.path_key)||!include(row.vendor,row.path))continue;
        retain.run(row.path_key,row.fingerprint);
        remove.run(row.path_key);
        enqueue.run(row.path_key,row.path,row.vendor,++revision);
      }
      this.set("sequence",String(revision));
      this.set(`task:${name}`,"1");
    }).immediate();
  }
  /**
   * A vanished local archive copy must wake its unchanged original for collection. Collection
   * does not list the archive, so this looks at the archive files the queue holds or accepted.
   */
  requeueMissingArchiveSources(roots:SyncFileRoot[],original:(vendor:VendorId,file:string)=>string|null,onProgress?:QueueProgress):void {
    const sourceRoot=rootIndex(roots.filter(root=>root.kind==="source"));
    const archiveRoot=rootIndex(roots.filter(root=>root.kind==="archive"));
    // Archive files by folder: one listing per folder answers which of them are gone. A stat per
    // file opens each one, which a cloud folder answers slowly (~54k files on OneDrive).
    const folders=new Map<string,Map<string,{path:string;vendor:VendorId}>>();
    let total=0;
    for(const row of this.db.query("SELECT path_key,path,vendor FROM pending UNION ALL SELECT path_key,path,vendor FROM files WHERE stamp<>'missing'")
      .iterate() as Iterable<{path_key:string;path:string;vendor:VendorId}>) {
      if(!archiveRoot(row.vendor,row.path_key))continue;
      const folder=path.dirname(row.path),folderKey=key(folder);
      let files=folders.get(folderKey);
      if(!files){files=new Map();folders.set(folderKey,files);}
      if(!files.has(row.path_key)){files.set(row.path_key,row);total++;}
    }
    let done=0;
    for(const files of folders.values()) {
      const folder=path.dirname(files.values().next().value!.path);
      let names:Set<string>|null;
      try{names=new Set(fs.readdirSync(folder,{withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>nameKey(entry.name)));}
      catch(error){names=absent(error)?new Set():null;}
      const present=(file:string)=>{
        if(names)return names.has(nameKey(path.basename(file)));
        // A folder that cannot be listed is asked file by file; links are not archive inputs.
        try{const stat=fs.lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink();}catch{return false;}
      };
      for(const row of files.values()) {
        onProgress?.(++done,total);
        if(present(row.path))continue;
        // Compression changes the physical name, not the retained history. Checking only the
        // retired name repeatedly discarded the original's checkpoint and re-read old files.
        const codec=archiveCodecSource(path.relative(this.archiveRoot,row.path));
        const identity=archiveSourceIdentity(row.path);
        if(codec?.vendor===row.vendor&&present(row.path===identity?`${identity}.zst`:identity))continue;
        const source=original(row.vendor,row.path);
        if(source&&fs.existsSync(source)&&sourceRoot(row.vendor,key(source)))this.revisit(source,row.vendor);
      }
    }
    onProgress?.(total,total);
  }
  /** Unchanged bytes must be read again (e.g. by a newer parser): drop the accepted fingerprint and queue the file. */
  revisit(file:string,vendor:VendorId) {
    if(ignored(file))return;
    this.db.query("DELETE FROM files WHERE path_key=?").run(key(file));
    this.enqueue(file,vendor);
  }
  signal(file:string|null,roots:SyncFileRoot[]) {
    if(!file){this.reconcileLater();return;}
    if(ignored(file))return;
    const fileKey=key(file);
    const root=roots.filter(root=>holds(key(root.path),fileKey)).sort((a,b)=>b.path.length-a.path.length)[0];
    // The shared configuration is watched beside the roots; its files are no queue input.
    if(!root)return;
    let info:fs.Stats|null=null;
    try{info=fs.lstatSync(file);}catch{/* gone or unreadable: queued below */}
    if(info?.isDirectory()) {
      // Writing a file also reports its folder and the folder's parents. The changed files are
      // reported themselves, so a folder event is no reason to walk every root (that made each
      // two-minute cycle list the whole archive). Only a folder the queue knows nothing below,
      // new or moved in whole, is walked, alone, by the next `prepare`.
      if(!this.knowsBelow(fileKey))this.walkLater(file,root.vendor);
      return;
    }
    // A watcher also reports an access or attribute change: an importer opening an accepted file is one. A
    // file whose content stamp is still the accepted one is not queued again.
    const accepted=this.db.query("SELECT stamp FROM files WHERE path_key=?").get(fileKey) as {stamp:string}|null;
    if(accepted&&accepted.stamp!=="missing"&&info?.isFile()&&contentStamp(stamp(info))===contentStamp(accepted.stamp))return;
    this.enqueue(file,root.vendor);
  }
  /** Whether the queue holds or accepted any file below the folder key `folderKey`. */
  private knowsBelow(folderKey:string):boolean {
    const low=folderKey.endsWith(path.sep)?folderKey:folderKey+path.sep;
    // Every key below the folder sorts between `folder\` and `folder` followed by the next character.
    const high=low.slice(0,-1)+String.fromCharCode(path.sep.charCodeAt(0)+1);
    return !!this.db.query(`SELECT 1 FROM files WHERE path_key>=?1 AND path_key<?2 AND stamp<>'missing'
      UNION ALL SELECT 1 FROM pending WHERE path_key>=?1 AND path_key<?2 LIMIT 1`).get(low,high);
  }
  private walkLater(folder:string,vendor:VendorId) {
    this.db.query("INSERT INTO walks VALUES(?,?,?) ON CONFLICT(path_key) DO NOTHING").run(key(folder),path.resolve(folder),vendor);
  }
  /**
   * Metadata discovery is an explicit background reconciliation, never a screen read. Each root
   * remembers the reconciliation request it last answered with a complete walk and when; it is
   * walked again after a newer request (a watcher overflow, a new index) or once the interval
   * has passed. A walk that could not list a folder leaves its root due.
   *
   * The files a walk finds keep their stamp for this pass: `take` uses it instead of a second
   * stat, and needs no folder check either, because the walk never descends into a link.
   */
  prepare(roots:SyncFileRoot[],now=Date.now(),onProgress?:QueueProgress) {
    this.scanFailures.clear();
    this.listed.clear();
    const requested=Number(this.get("reconcile_request")??0);
    const rootKey=(root:SyncFileRoot)=>`${key(root.path)}|${root.vendor}|${root.kind}`;
    const due=roots.filter(root=>{
      const [answered,at]=(this.get(`root:${rootKey(root)}`)??"-1|0").split("|").map(Number) as [number,number];
      return answered<requested||now-at>=this.reconciliationIntervalMs;
    });
    const walks=this.db.query("SELECT path_key,path,vendor FROM walks").all() as Array<{path_key:string;path:string;vendor:VendorId}>;
    if(!due.length&&!walks.length)return;
    const seen=new Set<string>();
    // Keys of the entries this pass could not read; what lies below them is unknown.
    const inaccessible=new Set<string>();
    // Only a directory this pass could not list leaves its contents unknown, so
    // only that keeps its root due. A link is skipped by policy and an entry that
    // cannot be read is reported as itself; treating either as an incomplete scan
    // would rewalk every root on every cycle, forever.
    const unlisted=new Set<string>();
    const walkedByRoot=new Map<string,number>();
    const failed=(file:string,root:SyncFileRoot,error:unknown,unlistedDirectory=false)=>{
      const failures=this.scanFailures.get(root.vendor)??[];
      failures.push({path:file,error:error instanceof Error?error.message:String(error)});
      this.scanFailures.set(root.vendor,failures);inaccessible.add(key(file));
      if(unlistedDirectory)unlisted.add(rootKey(root));
    };
    // A walk compares every file with its accepted stamp: one read of all of them, not a query per file.
    const accepted=due.length?new Map<string,{path:string;vendor:VendorId;stamp:string}>():null;
    if(accepted)for(const row of this.db.query("SELECT path_key,path,vendor,stamp FROM files").iterate() as Iterable<{path_key:string;path:string;vendor:VendorId;stamp:string}>)
      accepted.set(row.path_key,{path:row.path,vendor:row.vendor,stamp:row.stamp});
    const acceptedStamp=(fileKey:string)=>accepted ? accepted.get(fileKey)?.stamp
      : (this.db.query("SELECT stamp FROM files WHERE path_key=?").get(fileKey) as {stamp:string}|null)?.stamp;
    // The last completed walk of the same roots is the only honest estimate of their size.
    const previousWalk=due.reduce((sum,root)=>sum+Number(this.get(`walked:${rootKey(root)}`)??0),0);
    let walked=0;
    let queued:{path:string;vendor:VendorId}[]=[];
    const flush=()=>{this.enqueueBatch(queued);queued=[];};
    const queue=(file:string,vendor:VendorId)=>{queued.push({path:file,vendor});if(queued.length>=batchSize)flush();};
    const record=(file:string,current:string,root:SyncFileRoot)=>{
      const fileKey=key(file);if(seen.has(fileKey))return;seen.add(fileKey);
      this.listed.set(fileKey,current);
      walkedByRoot.set(rootKey(root),(walkedByRoot.get(rootKey(root))??0)+1);
      onProgress?.(++walked,previousWalk>walked?previousWalk:null);
      const previous=acceptedStamp(fileKey);
      if(previous===undefined||contentStamp(previous)!==contentStamp(current))queue(file,root.vendor);
    };
    const link=(file:string,root:SyncFileRoot)=>failed(file,root,new Error(`Queued input is a symbolic link: ${file}`));
    // One entry of unknown kind: a root, or an entry its listing did not call a folder or a file.
    const scan=(file:string,root:SyncFileRoot)=>{
      if(ignored(file))return;
      let info:fs.Stats;
      try{info=fs.lstatSync(file);}catch(error){if(!missing(error))failed(file,root,error);return;}
      if(info.isSymbolicLink()){link(file,root);return;}
      if(info.isDirectory()){walk(file,root);return;}
      if(info.isFile())record(file,stamp(info),root);
    };
    // A folder's tree is listed first, then its files are stated together: a stat per file in turn
    // costs ~0.4-2 ms on OneDrive, minutes for the archive, and many at once take a fraction.
    // The listing names folders without a stat; a link is never listed as a folder.
    const walk=(folder:string,root:SyncFileRoot)=>{
      let files:string[]=[];
      const state=()=>{
        const slice=files;files=[];
        const results=stampAll(slice);
        for(const [index,file] of slice.entries()) {
          const result=results[index]!;
          if(result.kind==="file")record(file,result.stamp,root);
          else if(result.kind==="error")failed(file,root,result.error);
          else if(result.kind==="link")link(file,root);
          else if(result.kind==="directory")walk(file,root);
        }
      };
      const list=(directory:string)=>{
        let entries:fs.Dirent[];
        try{entries=fs.readdirSync(directory,{withFileTypes:true});}catch(error){failed(directory,root,error,true);return;}
        for(const entry of entries) {
          const file=path.join(directory,entry.name);
          if(ignored(file))continue;
          if(entry.isDirectory())list(file);
          else if(entry.isFile()){files.push(file);if(files.length>=statSlice)state();}
          else scan(file,root);
        }
      };
      list(folder);
      state();
    };
    // Nested roots first, so a file belongs to the most specific root that holds it.
    for(const root of [...due].sort((a,b)=>b.path.length-a.path.length))scan(root.path,root);
    // Folders a watcher reported new are walked alone, unless their root was walked above. A folder
    // whose root is not part of this pass (collection lists originals only) waits for one that is.
    const rootOf=rootIndex(roots),dueRootOf=rootIndex(due),finishedWalks:string[]=[];
    for(const request of walks) {
      const root=rootOf(request.vendor,request.path_key);
      if(!root)continue;
      if(!dueRootOf(request.vendor,request.path_key))scan(request.path,root);
      finishedWalks.push(request.path_key);
    }
    if(accepted) {
      const dueKeys=new Set(due.map(root=>key(root.path)));
      for(const [fileKey,row] of accepted) {
        if(row.stamp!=="missing"&&!seen.has(fileKey)&&!ignored(row.path)&&!nearest(fileKey,folder=>inaccessible.has(folder)||undefined)
          &&nearest(fileKey,folder=>dueKeys.has(folder)||undefined))queue(row.path,row.vendor);
      }
    }
    flush();
    this.db.transaction(()=>{
      const done=this.db.query("DELETE FROM walks WHERE path_key=?");
      for(const folder of finishedWalks)done.run(folder);
      for(const root of due) {
        this.set(`walked:${rootKey(root)}`,String(walkedByRoot.get(rootKey(root))??0));
        if(!unlisted.has(rootKey(root)))this.set(`root:${rootKey(root)}`,`${requested}|${now}`);
      }
    }).immediate();
    onProgress?.(walked,walked);
  }
  take(vendor:VendorId,roots:SyncFileRoot[],deferFingerprint:false|((file:string)=>boolean)=false,onProgress?:QueueProgress):QueuedSyncFile[] {
    const selected:QueuedSyncFile[]=[];
    const failures:SyncFileFailure[]=[];this.selectionFailures.set(vendor,failures);
    let unchanged:QueuedSyncFile[]=[];
    const pending=this.db.query("SELECT path,vendor,revision FROM pending WHERE vendor=? ORDER BY revision").all(vendor) as Omit<QueuedSyncFile,"kind"|"fingerprint">[];
    let verified=0;
    const vendorRoot=rootIndex(roots),rootOf=(file:string)=>vendorRoot(vendor,key(file));
    // Hash a slice ahead in parallel; the checks below still run first for each row, so a
    // precomputed identity is only used where the sequential pass would hash the file.
    let hashed=new Map<string,FingerprintResult>();
    const linkedFolders=new Map<string,boolean>();
    const accepted=(file:string)=>(this.db.query("SELECT fingerprint FROM files WHERE path_key=?").get(key(file)) as {fingerprint:string}|null)?.fingerprint;
    // A first import of a provider without parser digests accepted its files by their listed stamp (no
    // digest). Such a file queued again with the same content stamp is the same file, by the test the
    // listing itself applies: it is neither hashed nor read again.
    const stampWitnessed=(file:string,listed:string|undefined)=>{
      const previous=accepted(file);
      return !!previous&&previous!=="missing"&&listed!==undefined&&listed!=="missing"&&content(previous)===null
        &&contentStamp(JSON.parse(previous)[0] as string)===contentStamp(listed)?previous:null;
    };
    for(const [index,row] of pending.entries()) {
      const deferred=deferFingerprint && deferFingerprint(row.path);
      if(index%verifySlice===0) {
        const slice=pending.slice(index,index+verifySlice).map(row=>row.path)
          .filter(file=>{const root=rootOf(file);return !!root&&!ignored(file)&&!(deferFingerprint&&deferFingerprint(file))
            &&(this.listed.has(key(file))||plainFileUnder(root.path,file,linkedFolders))&&!stampWitnessed(file,this.listed.get(key(file)));});
        const results=fingerprintAll(slice);
        hashed=new Map(slice.map((file,position)=>[file,results[position]!]));
      }
      onProgress?.(verified++,pending.length);
      const root=rootOf(row.path);
      if(!root)continue;
      if(ignored(row.path)){this.remove(row);continue;}
      try {
      // A file this pass listed is an ordinary file with no link on its way from the root.
      let listed=this.listed.get(key(row.path));
      if(listed===undefined) {
        if(symlinkAncestor(root.path,row.path,linkedFolders))throw new Error(`Queued input has a symbolic-link ancestor: ${row.path}`);
        let stat:fs.Stats|undefined;
        try{stat=fs.lstatSync(row.path);}catch(error){if(!missing(error))throw error;}
        if(stat?.isDirectory()) {if(!this.knowsBelow(key(row.path)))this.walkLater(row.path,vendor);this.remove(row);continue;}
        if(stat?.isSymbolicLink()||(stat&&!stat.isFile()))throw new Error(`Queued input is not an ordinary file: ${row.path}`);
        listed=stat?stamp(stat):"missing";
      }
      const witnessed=deferred?null:stampWitnessed(row.path,listed);
      if(witnessed) {
        unchanged.push({...row,kind:root.kind,fingerprint:witnessed});
        if(unchanged.length>=batchSize){this.publish(unchanged);unchanged=[];}
        continue;
      }
      if(listed==="missing"&&root.kind==="archive") {
        const original=this.get(`mirror-original:${key(row.path)}`);
        const codec=archiveCodecSource(path.relative(this.archiveRoot,row.path));
        const sibling=archiveSourceIdentity(row.path)===row.path?`${row.path}.zst`:archiveSourceIdentity(row.path);
        if(original&&!(codec?.vendor===vendor&&metadata(sibling)!=="missing")) {
          const source=JSON.parse(original).source as unknown;
          if(typeof source==="string"&&rootOf(source)?.kind==="source"&&metadata(source)!=="missing")this.revisit(source,vendor);
        }
      }
      const current=deferred ? (listed==="missing" ? listed : JSON.stringify([listed,null])) : identityOf(hashed.get(row.path),row.path);
      const previous=this.db.query("SELECT fingerprint FROM files WHERE path_key=?").get(key(row.path)) as {fingerprint:string}|null;
      if(!deferred&&previous&&content(previous.fingerprint)===content(current)) {
        unchanged.push({...row,kind:root.kind,fingerprint:current});
        if(unchanged.length>=batchSize){this.publish(unchanged);unchanged=[];}
        continue;
      }
      selected.push({...row,kind:root.kind,fingerprint:current});
      } catch(error) {
        failures.push({path:row.path,error:error instanceof Error?error.message:String(error)});
      }
    }
    this.publish(unchanged);
    onProgress?.(pending.length,pending.length);
    return selected;
  }
  /** Only a complete parser-produced SHA may resolve a deferred first-fill witness. */
  resolveParsedFingerprint(row:QueuedSyncFile,sha256:string,byteLength:number):QueuedSyncFile {
    const [before,digest]=JSON.parse(row.fingerprint) as [string,string|null];
    if(digest!==null || !/^[a-f0-9]{64}$/.test(sha256) || JSON.parse(before)[0]!==byteLength
      || contentStamp(metadata(row.path))!==contentStamp(before)) throw new Error(`Parsed source identity changed: ${row.path}`);
    return {...row,fingerprint:JSON.stringify([before,sha256])};
  }
  observe(file:string,vendor:VendorId):QueuedSyncFile {
    const [witness]=this.observeAll([file],vendor);
    if(witness instanceof Error)throw witness;
    return witness!;
  }
  /** Witnesses of archive files in input order; a file that cannot be verified yields its error. */
  observeAll(files:string[],vendor:VendorId):Array<QueuedSyncFile|Error> {
    const results=fingerprintAll(files);
    return files.map((file,index)=>{
      try{return {path:path.resolve(file),vendor,revision:-1,kind:"archive",fingerprint:identityOf(results[index],file)};}
      catch(error){return error instanceof Error?error:new Error(String(error));}
    });
  }
  acknowledge(rows:QueuedSyncFile[]) {
    const failures:SyncFileFailure[]=[];
    let verified:QueuedSyncFile[]=[];
    const flush=()=>{this.publish(verified);verified=[];};
    // The digest was taken by the read that produced the facts. A file whose content stamp (size,
    // mtime, device, inode) is still the one recorded then is accepted without reading it again,
    // the same test the scan uses to find changes; only a changed stamp is hashed. Re-hashing every
    // file was a further full read of the archive on a first fill (deployment 03.10).
    const unchangedStamp=(row:QueuedSyncFile)=>{
      if(row.fingerprint==="missing")return false;
      try{return contentStamp(metadata(row.path))===contentStamp(JSON.parse(row.fingerprint)[0] as string);}catch{return false;}
    };
    const rehash:QueuedSyncFile[]=[];
    for(const row of rows) {
      if(unchangedStamp(row)){verified.push(row);if(verified.length>=batchSize)flush();}
      else rehash.push(row);
    }
    rows=rehash;
    let hashed:FingerprintResult[]=[];
    for(const [index,row] of rows.entries()) {
      if(index%verifySlice===0)hashed=fingerprintAll(rows.slice(index,index+verifySlice).map(row=>row.path));
      // The bytes the publication read are what must still be there; an attribute
      // touch during the run is not a reason to reread the source.
      try {
        if(content(identityOf(hashed[index%verifySlice],row.path))!==content(row.fingerprint))throw new Error("Source digest changed before checkpoint; kept for retry");
      }catch(error){this.enqueue(row.path,row.vendor);failures.push({path:row.path,error:String(error)});continue;}
      verified.push(row);if(verified.length>=batchSize)flush();
    }
    flush();
    return failures;
  }
  private publish(rows:QueuedSyncFile[]) {
    if(!rows.length)return;
    this.db.transaction(()=>this.acceptRows(rows)).immediate();
  }
  private acceptRows(rows:QueuedSyncFile[]) {
    for(const row of rows) {
      const stamp=row.fingerprint==="missing"?"missing":JSON.parse(row.fingerprint)[0];
      if(row.kind==="archive"&&row.fingerprint!=="missing") {
        this.db.query("INSERT INTO accepted_archive(path_key,fingerprint) VALUES(?,?) ON CONFLICT(path_key) DO UPDATE SET fingerprint=excluded.fingerprint")
          .run(key(row.path),row.fingerprint);
        this.db.query("DELETE FROM state WHERE key=?").run(`mirror-original:${key(row.path)}`);
      }
      this.db.query("INSERT INTO files VALUES(?,?,?,?,?) ON CONFLICT(path_key) DO UPDATE SET path=excluded.path,vendor=excluded.vendor,stamp=excluded.stamp,fingerprint=excluded.fingerprint")
        .run(key(row.path),row.path,row.vendor,stamp,row.fingerprint);
      this.remove(row);
    }
  }
  private remove(row:{path:string;revision:number}) {this.db.query("DELETE FROM pending WHERE path_key=? AND revision=?").run(key(row.path),row.revision);}
}
