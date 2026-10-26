import { Database } from "../db/sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCAL_ARCHIVE_LOCATOR_FILE="archive-location.sqlite";
const STAGED_RELOCATION_FILE=".archive-relocation-owner.json";
const archiveIdPattern=/^[a-zA-Z0-9_-]{1,100}$/;
type Environment=Record<string,string|undefined>;
export interface LocalArchiveSelection {root:string;archiveId:string}
export interface LocalArchivePublication extends LocalArchiveSelection {changed:boolean}
export interface LocalArchiveActivationProof {decision:"committed"|"uncommitted"|"unknown";reason?:string}
export class LocalArchiveActivationDecisionError extends Error {
  constructor(readonly decision:"committed"|"uncommitted"|"unknown",message:string) {
    super(message);this.name="LocalArchiveActivationDecisionError";
  }
}

export function resolveLocalStateRootBase(env:Environment=process.env):string {
  return path.resolve(env.TOKENATLAS_LOCAL_STATE?.trim() || (process.platform==="win32"
    ? path.join(env.LOCALAPPDATA?.trim() || os.homedir(),"tokenAtlas")
    : path.join(os.homedir(),".local","state","tokenAtlas")));
}
export function localArchiveLocatorPath(env:Environment=process.env):string {
  return path.join(resolveLocalStateRootBase(env),LOCAL_ARCHIVE_LOCATOR_FILE);
}
function physical(value:string):string {
  const resolved=path.resolve(value);
  if(fs.existsSync(resolved))return fs.realpathSync(resolved);
  const parent=path.dirname(resolved);
  return parent===resolved?resolved:path.join(physical(parent),path.basename(resolved));
}
function contains(root:string,candidate:string):boolean {
  const relative=path.relative(physical(root),physical(candidate));
  return relative==="" || (relative!==".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export function assertLocalStateOutsideRoots(localRoot:string,roots:readonly string[]):void {
  for(const root of roots)if(contains(localRoot,root) || contains(root,localRoot))
    throw new Error("Local machine state must be outside transferable archive/config roots");
}
function assertPrivateDirectory(directory:string,label:string):void {
  if(!fs.existsSync(directory))return;
  const stat=fs.statSync(directory);
  if(!stat.isDirectory())throw new Error(`${label} is not a directory: ${directory}`);
  if(process.platform!=="win32" && (stat.mode & 0o002)!==0)
    throw new Error(`${label} cannot use a world-writable directory: ${directory}`);
}
function archiveIdentity(root:string):string {
  const file=path.join(root,".archive-inventory","identity.json");
  if(!fs.existsSync(file))throw new Error(`Selected archive has no identity: ${root}`);
  const value=JSON.parse(fs.readFileSync(file,"utf8")) as {schema?:unknown;archiveId?:unknown};
  if(value.schema!==1 || typeof value.archiveId!=="string" || !archiveIdPattern.test(value.archiveId))
    throw new Error(`Invalid selected archive identity: ${file}`);
  return value.archiveId;
}

/** Reads may retain an unavailable archive; publications require a present recognized archive. */
export function validateLocalArchiveSelection(selection:LocalArchiveSelection,env:Environment=process.env,
  requirePresent=false):LocalArchiveSelection {
  if(!selection || typeof selection.root!=="string" || !path.isAbsolute(selection.root)
      || /[\r\n\0]/.test(selection.root) || typeof selection.archiveId!=="string"
      || !archiveIdPattern.test(selection.archiveId))throw new Error("Invalid local archive selection");
  const root=path.resolve(selection.root),localRoot=resolveLocalStateRootBase(env);
  const explicitConfig=env.TOKENATLAS_CONFIG?.trim();
  assertLocalStateOutsideRoots(localRoot,[root,...(explicitConfig?[path.resolve(explicitConfig)]:[])]);
  if(!fs.existsSync(root)) {
    if(requirePresent)throw new Error(`Selected archive is unavailable: ${root}`);
    return {root,archiveId:selection.archiveId};
  }
  assertPrivateDirectory(root,"Selected archive");
  if(fs.existsSync(path.join(root,STAGED_RELOCATION_FILE)))
    throw new Error("Relocation destination is staged; activation has not been committed");
  const observed=archiveIdentity(root);
  if(observed!==selection.archiveId)
    throw new Error(`Selected archive identity mismatch at '${root}': expected '${selection.archiveId}', found '${observed}'`);
  const binding=path.join(root,".archive-inventory","path-binding.json");
  if(fs.existsSync(binding)) {
    const value=JSON.parse(fs.readFileSync(binding,"utf8")) as {schema?:unknown;archiveId?:unknown};
    if(value.schema!==1 || value.archiveId!==selection.archiveId)
      throw new Error(`Selected archive path binding does not match '${selection.archiveId}'`);
  }
  return {root,archiveId:selection.archiveId};
}

function readRow(db:Database):LocalArchiveSelection {
  const columns=db.query("PRAGMA table_info(archive_locator)").all() as Array<{name:string}>;
  if(columns.map(column=>column.name).join(",")!=="singleton,schema,archive_id,root")
    throw new Error("Invalid local archive locator database");
  const rows=db.query("SELECT singleton,schema,archive_id,root FROM archive_locator").all() as Array<{
    singleton:number;schema:number;archive_id:string;root:string;
  }>;
  if(rows.length!==1 || rows[0]!.singleton!==1 || rows[0]!.schema!==1)
    throw new Error("Invalid local archive locator state");
  return {root:rows[0]!.root,archiveId:rows[0]!.archive_id};
}
function fileStamp(file:string):string {
  try {
    const stat=fs.statSync(file,{bigint:true});
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT")return "missing";
    throw error;
  }
}
function archiveStamp(selection:LocalArchiveSelection):string {
  const root=selection.root;
  return [fileStamp(root),fileStamp(path.join(root,".archive-inventory","identity.json")),
    fileStamp(path.join(root,".archive-inventory","path-binding.json")),
    fileStamp(path.join(root,STAGED_RELOCATION_FILE))].join("|");
}
const cache=new Map<string,{locatorStamp:string;archiveStamp:string;config:string;selection:LocalArchiveSelection}>();

function contextualOpen(file:string,readonly:boolean):Database {
  try{return new Database(file,{readonly,create:!readonly});}
  catch(error){throw new Error(`Invalid local archive locator '${file}': ${error instanceof Error?error.message:String(error)}`);}
}

/** Pure read: no directory, database, schema or recovery write is attempted. */
export function readLocalArchiveSelection(env:Environment=process.env):LocalArchiveSelection|null {
  const file=localArchiveLocatorPath(env);
  const locatorStamp=fileStamp(file);
  if(locatorStamp==="missing")return null;
  const config=env.TOKENATLAS_CONFIG?.trim()?path.resolve(env.TOKENATLAS_CONFIG.trim()):"";
  const prior=cache.get(file);
  if(prior && prior.locatorStamp===locatorStamp && prior.config===config
      && prior.archiveStamp===archiveStamp(prior.selection))return {...prior.selection};
  let db:Database|undefined;
  try {
    db=contextualOpen(file,true);db.exec("PRAGMA query_only=ON");
    const selection=validateLocalArchiveSelection(readRow(db),env,false);
    cache.set(file,{locatorStamp,archiveStamp:archiveStamp(selection),config,selection});
    return {...selection};
  } catch(error) {
    if(error instanceof Error && error.message.startsWith("Invalid local archive locator '"))throw error;
    throw new Error(`Invalid local archive locator '${file}': ${error instanceof Error?error.message:String(error)}`);
  } finally {db?.close();}
}
export function validateLocalArchiveLocatorState(env:Environment=process.env):void {
  readLocalArchiveSelection(env);
}
function syncDirectory(directory:string):void {
  let descriptor:number|undefined;
  try {descriptor=fs.openSync(directory,"r");fs.fsyncSync(descriptor);}
  catch(error) {
    const code=String((error as NodeJS.ErrnoException).code);
    const unsupported=["EINVAL","ENOTSUP","EISDIR"].includes(code) ||
      (process.platform==="win32" && ["EACCES","EPERM"].includes(code));
    if(!unsupported)throw error;
  } finally {if(descriptor!==undefined)fs.closeSync(descriptor);}
}
function createCandidate(file:string,selection:LocalArchiveSelection):string {
  const candidate=`${file}.${randomUUID()}.tmp`;
  let db:Database|undefined;
  try {
    db=new Database(candidate,{create:true});
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
    db.transaction(()=>{
      db!.exec(`CREATE TABLE archive_locator(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema INTEGER NOT NULL CHECK(schema=1),
        archive_id TEXT NOT NULL,root TEXT NOT NULL)`);
      db!.query("INSERT INTO archive_locator VALUES(1,1,?,?)").run(selection.archiveId,selection.root);
    }).immediate();
    db.close();db=undefined;
    if(process.platform!=="win32")fs.chmodSync(candidate,0o600);
    return candidate;
  } catch(error) {
    db?.close();
    try{fs.unlinkSync(candidate);}catch{}
    throw error;
  }
}

/**
 * First publication builds a complete private database and links it into place
 * exclusively. A killed initializer leaves only an ignorable private temporary;
 * concurrent initializers can never observe an empty public schema. Later writes
 * serialize with BEGIN IMMEDIATE and preserve the previous row on failure.
 */
function sameSelection(left:LocalArchiveSelection|null,right:LocalArchiveSelection|null):boolean {
  if(!left || !right)return left===right;
  const a=physical(left.root),b=physical(right.root);
  return left.archiveId===right.archiveId && (process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b);
}
function cleanupActivationCandidate(candidate:string,committed:boolean):void {
  try{fs.unlinkSync(candidate);}
  catch(error) {
    const code=(error as NodeJS.ErrnoException).code;
    if(code==="ENOENT" || (committed && process.platform==="win32" && ["EACCES","EPERM"].includes(code??"")))return;
    if(committed)throw new LocalArchiveActivationDecisionError("committed",`Locator committed but private cleanup failed: ${String(error)}`);
    throw error;
  }
}

/** Exact durable proof used after an uncertain locator commit; it performs no writes. */
export function proveLocalArchiveActivation(selection:LocalArchiveSelection,expected:LocalArchiveSelection|null,
  env:Environment=process.env):LocalArchiveActivationProof {
  const file=localArchiveLocatorPath(env);
  try {fs.statSync(file);}
  catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT")
      return expected===null?{decision:"uncommitted"}:{decision:"unknown",reason:"locator-file-missing"};
    return {decision:"unknown",reason:error instanceof Error?error.message:String(error)};
  }
  let db:Database|undefined;
  try {
    db=contextualOpen(file,true);db.exec("PRAGMA query_only=ON");
    const current=readRow(db);
    if(sameSelection(current,selection)) {
      validateLocalArchiveSelection(current,env,true);
      return {decision:"committed"};
    }
    if(sameSelection(current,expected))return {decision:"uncommitted"};
    throw new Error("Local archive locator belongs to an unrelated archive or location");
  } catch(error) {
    if(error instanceof Error && error.message.includes("unrelated archive"))throw error;
    return {decision:"unknown",reason:error instanceof Error?error.message:String(error)};
  } finally {db?.close();}
}

/**
 * Activation-only compare-and-swap. A successful link or COMMIT is the durable
 * decision even if later directory synchronization reports failure.
 */
export function activateLocalArchiveSelection(selection:LocalArchiveSelection,expected:LocalArchiveSelection|null,
  env:Environment=process.env,afterCommit?:()=>void):LocalArchivePublication {
  const explicit=env.TOKENATLAS_ARCHIVE?.trim();
  if(explicit!==undefined && (!explicit || /[\r\n\0]/.test(explicit)))
    throw new LocalArchiveActivationDecisionError("uncommitted","Invalid TOKENATLAS_ARCHIVE override");
  if(explicit) {
    const destination=physical(selection.root),configured=physical(explicit);
    if(process.platform==="win32"?destination.toLowerCase()!==configured.toLowerCase():destination!==configured)
      throw new LocalArchiveActivationDecisionError("uncommitted",`TOKENATLAS_ARCHIVE conflicts with relocation destination '${selection.root}'`);
  }
  let valid:LocalArchiveSelection;
  try{valid=validateLocalArchiveSelection(selection,env,true);}
  catch(error){throw new LocalArchiveActivationDecisionError("uncommitted",error instanceof Error?error.message:String(error));}
  const localRoot=resolveLocalStateRootBase(env),file=localArchiveLocatorPath(env);
  fs.mkdirSync(localRoot,{recursive:true,mode:0o700});assertPrivateDirectory(localRoot,"Local state");
  if(!fs.existsSync(file)) {
    if(expected!==null)throw new LocalArchiveActivationDecisionError("unknown","Local archive locator disappeared before activation");
    const candidate=createCandidate(file,valid);
    let committed=false;
    try {
      try {fs.linkSync(candidate,file);committed=true;}
      catch(error) {
        if((error as NodeJS.ErrnoException).code!=="EEXIST")
          throw new LocalArchiveActivationDecisionError("uncommitted",error instanceof Error?error.message:String(error));
      }
      if(committed) {
        try {afterCommit?.();syncDirectory(localRoot);}
        catch(error) {
          if(error instanceof LocalArchiveActivationDecisionError)throw error;
          throw new LocalArchiveActivationDecisionError("committed",error instanceof Error?error.message:String(error));
        }
        cache.delete(file);return {...valid,changed:true};
      }
    } finally {cleanupActivationCandidate(candidate,committed);}
  }
  let db:Database|undefined,transaction=false,committed=false;
  try {
    db=contextualOpen(file,false);db.exec("PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");transaction=true;
    const current=readRow(db);
    if(sameSelection(current,valid)) {db.exec("ROLLBACK");transaction=false;return {...valid,changed:false};}
    if(!sameSelection(current,expected))throw new LocalArchiveActivationDecisionError("uncommitted","Local archive locator changed during relocation activation");
    db.query("UPDATE archive_locator SET schema=1,archive_id=?,root=? WHERE singleton=1").run(valid.archiveId,valid.root);
    try {db.exec("COMMIT");transaction=false;committed=true;}
    catch(error) {throw new LocalArchiveActivationDecisionError("unknown",error instanceof Error?error.message:String(error));}
    try {afterCommit?.();syncDirectory(localRoot);}
    catch(error) {
      if(error instanceof LocalArchiveActivationDecisionError)throw error;
      throw new LocalArchiveActivationDecisionError("committed",error instanceof Error?error.message:String(error));
    }
    cache.delete(file);return {...valid,changed:true};
  } catch(error) {
    if(transaction)try{db?.exec("ROLLBACK");}catch{}
    if(error instanceof LocalArchiveActivationDecisionError)throw error;
    throw new LocalArchiveActivationDecisionError(committed?"committed":"uncommitted",error instanceof Error?error.message:String(error));
  } finally {db?.close();}
}

export function persistLocalArchiveSelection(selection:LocalArchiveSelection,
  env:Environment=process.env):LocalArchivePublication {
  const valid=validateLocalArchiveSelection(selection,env,true);
  const localRoot=resolveLocalStateRootBase(env),file=localArchiveLocatorPath(env);
  fs.mkdirSync(localRoot,{recursive:true,mode:0o700});assertPrivateDirectory(localRoot,"Local state");
  if(!fs.existsSync(file)) {
    const candidate=createCandidate(file,valid);
    let published=false;
    try {
      try {fs.linkSync(candidate,file);published=true;syncDirectory(localRoot);}
      catch(error) {if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    } finally {try{fs.unlinkSync(candidate);}catch(error){if(!published && (error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
    if(published){cache.delete(file);return {...valid,changed:true};}
  }
  let db:Database|undefined;
  try {
    db=contextualOpen(file,false);db.exec("PRAGMA busy_timeout=10000");
    const changed=db.transaction(()=>{
      const current=readRow(db!);
      if(current.archiveId===valid.archiveId && path.resolve(current.root)===valid.root)return false;
      db!.query("UPDATE archive_locator SET schema=1,archive_id=?,root=? WHERE singleton=1")
        .run(valid.archiveId,valid.root);
      return true;
    }).immediate();
    cache.delete(file);
    return {...valid,changed};
  } catch(error) {
    if(error instanceof Error && error.message.startsWith("Invalid local archive locator '"))throw error;
    throw new Error(`Invalid local archive locator '${file}': ${error instanceof Error?error.message:String(error)}`);
  } finally {db?.close();}
}
