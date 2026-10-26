import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {locationContains,readArchiveIdentity} from "../config/archive-location";
import {atomicArchiveWrite} from "./archive-publication";
import { assertVerifiedArchiveRelocation } from "./archive-relocation-verification";
import { hashFileBounded } from "./archive-relocation-copy";
import { readArchiveRelocation } from "./archive-relocation-state";
import { type ArchiveRelocationState } from "./archive-relocation-contracts";

type FileCheck={status:"matching"|"changed"|"missing"|"unsafe-path"|"unreadable"|"deferred-budget";digest:string|null;bytes:number|null};
export interface ArchiveCleanupPlanPage {
  schema:1;jobId:string;archiveId:string;basis:string;capturedAt:string;
  sourceRoot:string;destinationRoot:string;scope:"recorded-relocation-files-only";
  deletionAuthorized:false;blockingReasons:string[];unlistedPaths:"not-assessed-must-be-preserved";
  sourceIdentity:"matching"|"unavailable-or-changed";
  offset:number;totalFiles:number;next:string|null;
  files:Array<{relative:string;expectedDigest:string;source:FileCheck;destination:FileCheck;matchingCopies:boolean}>;
  reportFile:string;
}
const samePath=(a:string,b:string)=>process.platform==="win32"?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
function planBasis(state:ArchiveRelocationState):string {
  return createHash("sha256").update(JSON.stringify([state.jobId,state.archiveId,state.sourceRoot,state.destinationRoot,
    state.activation,state.postActivation,state.entries.map(entry=>[entry.relative,entry.bytes,entry.digest])])).digest("hex");
}
async function checkFile(root:string,relative:string,digest:string,bytes:number):Promise<FileCheck> {
  try {
    if(!samePath(fs.realpathSync(root),root))return {status:"unsafe-path",digest:null,bytes:null};
    const file=path.resolve(root,...relative.split("/"));
    if(!locationContains(root,file) || !samePath(fs.realpathSync(file),file))return {status:"unsafe-path",digest:null,bytes:null};
    const before=fs.lstatSync(file,{bigint:true});
    if(!before.isFile() || before.isSymbolicLink())return {status:"unsafe-path",digest:null,bytes:null};
    if(before.size!==BigInt(bytes))return {status:"changed",digest:null,bytes:Number.isSafeInteger(Number(before.size))?Number(before.size):null};
    const actual=await hashFileBounded(file,bytes),after=fs.lstatSync(file,{bigint:true});
    const stable=before.dev===after.dev && before.ino===after.ino && before.size===after.size
      && before.mtimeNs===after.mtimeNs && before.ctimeNs===after.ctimeNs && samePath(fs.realpathSync(file),file);
    return {status:stable&&actual.digest===digest&&actual.bytes===bytes?"matching":"changed",...actual};
  } catch(error) {
    return {status:(error as NodeJS.ErrnoException).code==="ENOENT"?"missing":"unreadable",digest:null,bytes:null};
  }
}

/** Advisory, bounded manifest pages. This API never removes files or approves deletion. */
export async function prepareArchiveCleanupPlan(jobId:string,options:{stateDirectory:string;after?:string;maxFiles?:number;maxBytes?:number;
  env?:Record<string,string|undefined>}):Promise<ArchiveCleanupPlanPage> {
  const maxFiles=options.maxFiles??25;
  const maxBytes=options.maxBytes??8*1024*1024;
  if(!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>100)throw new Error("Invalid cleanup report page size");
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024)throw new Error("Invalid cleanup report byte budget");
  const state=readArchiveRelocation(options.stateDirectory,jobId);
  if(state.postActivation?.status!=="verified")throw new Error("Post-activation read/write verification is required before a cleanup report");
  // Revalidate current locator and destination before trusting the saved receipt.
  assertVerifiedArchiveRelocation(state,options.env);
  const directory=fs.realpathSync(options.stateDirectory);
  if(locationContains(state.sourceRoot,directory)||locationContains(state.destinationRoot,directory))
    throw new Error("Cleanup report state must remain outside both archive roots");
  const basis=planBasis(state);
  let offset=0;
  if(options.after!==undefined) {
    const token=/^([a-f0-9]{64}):(\d+)$/.exec(options.after);
    if(!token || token[1]!==basis || !Number.isSafeInteger(Number(token[2])))throw new Error("Cleanup report checkpoint no longer matches the relocation");
    offset=Number(token[2]);
    if(offset>state.entries.length)throw new Error("Invalid cleanup report checkpoint offset");
  }
  let sourceIdentity:ArchiveCleanupPlanPage["sourceIdentity"]="unavailable-or-changed";
  try {if(samePath(fs.realpathSync(state.sourceRoot),state.sourceRoot)&&readArchiveIdentity(state.sourceRoot)===state.archiveId)sourceIdentity="matching";} catch {/* Unavailable old copies remain protected. */}
  const files:ArchiveCleanupPlanPage["files"]=[];
  let budget=0;
  for(const entry of state.entries.slice(offset,offset+maxFiles)) {
    if(entry.status!=="verified" || !entry.digest)throw new Error("Cleanup report requires verified relocation entries");
    if(entry.bytes*2>maxBytes-budget) {
      const deferred:FileCheck={status:"deferred-budget",digest:null,bytes:null};
      files.push({relative:entry.relative,expectedDigest:entry.digest,source:deferred,destination:deferred,matchingCopies:false});
      continue;
    }
    budget+=entry.bytes*2;
    const source=sourceIdentity==="matching"?await checkFile(state.sourceRoot,entry.relative,entry.digest,entry.bytes)
      :{status:"unreadable" as const,digest:null,bytes:null};
    const destination=await checkFile(state.destinationRoot,entry.relative,entry.digest,entry.bytes);
    files.push({relative:entry.relative,expectedDigest:entry.digest,source,destination,
      matchingCopies:source.status==="matching"&&destination.status==="matching"});
  }
  if(planBasis(readArchiveRelocation(options.stateDirectory,jobId))!==basis)throw new Error("Relocation changed while preparing the cleanup report");
  // A second check catches a disconnected/replaced destination or locator during hashing.
  assertVerifiedArchiveRelocation(state,options.env);
  const nextOffset=offset+files.length;
  const reportFile=path.join(directory,`${jobId}.cleanup-${basis}-${offset}.json`);
  const page:ArchiveCleanupPlanPage={schema:1,jobId,archiveId:state.archiveId,basis,capturedAt:new Date().toISOString(),
    sourceRoot:state.sourceRoot,destinationRoot:state.destinationRoot,scope:"recorded-relocation-files-only",
    deletionAuthorized:false,blockingReasons:["other-machines-and-jobs-not-confirmed","unlisted-paths-not-assessed",
      ...(sourceIdentity==="matching"?[]:["source-identity-unavailable-or-changed"]),
      ...(files.some(file=>!file.matchingCopies)?["recorded-copies-differ-or-are-unavailable"]:[])],
    unlistedPaths:"not-assessed-must-be-preserved",sourceIdentity,offset,totalFiles:state.entries.length,
    next:nextOffset<state.entries.length?`${basis}:${nextOffset}`:null,files,reportFile};
  atomicArchiveWrite(reportFile,JSON.stringify(page));
  return page;
}
