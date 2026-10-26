import { resolveArchiveRootFromEnv } from "../config/path-environment";
import { realArchiveLocation, readArchiveIdentity, locationContains } from "../config/archive-location";
import { readLocalArchiveSelection } from "../config/archive-locator";
import { readLocalMachineId } from "../config/local-identity";
import type { ArchiveRelocationState, ArchiveRelocationVerificationReceipt, ArchiveRelocationVerificationOptions } from "./archive-relocation-contracts";
import { assertActivationEnvironment, assertActivationPathOverrides, selectionMatches } from "./archive-relocation-admission";
import { samePath, safeRelative, missing, externalStateDirectory, syncDirectory } from "./archive-relocation-paths";
import { destinationStamp, currentProcessProof, PROCESS_INSTANCE } from "./archive-relocation-process-proof";
import { validateState, jobPath, readJson, writeState } from "./archive-relocation-state";
import path from "node:path";
import fs from "node:fs";
import { hashFileBounded } from "./archive-relocation-copy";
import { withArchiveWriter } from "./archive-writers";
import { randomUUID, createHash } from "node:crypto";
import { atomicArchiveWrite } from "./archive-publication";
import { acquireJobLock, assertCurrentJobLock, releaseJobLock } from "./archive-relocation-lock";

const VERIFICATION_READ_BUDGET = 8 * 1024 * 1024;

function assertVerificationDestination(state:ArchiveRelocationState,env:Record<string,string|undefined>):void {
  if(state.phase!=="activated"||state.activation?.phase!=="complete")throw new Error("Archive relocation is not activated");
  const provenance=state.activation.provenance;
  if(!provenance)throw new Error("Legacy activation has no process provenance; post-activation verification remains unverified");
  assertActivationEnvironment(state.destinationRoot,env);
  assertActivationPathOverrides(state.sourceRoot,state.destinationRoot,env);
  const effective=resolveArchiveRootFromEnv(env);
  if(!samePath(realArchiveLocation(effective),state.destinationRoot))throw new Error("Effective archive root does not match activated destination");
  if(!selectionMatches(readLocalArchiveSelection(env),state.destinationRoot,state.archiveId))throw new Error("Archive verification locator no longer matches the activated job");
  if(readArchiveIdentity(state.destinationRoot)!==state.archiveId)throw new Error("Archive verification destination identity mismatch");
  if(destinationStamp(state.destinationRoot)!==provenance.destinationStamp)throw new Error("Archive verification destination was replaced");
  if(readLocalMachineId()!==provenance.machineId)throw new Error("Archive verification belongs to another local machine");
}

/** Read-only revalidation for status/cleanup proposals. It never authorizes deletion. */
export function assertVerifiedArchiveRelocation(state:ArchiveRelocationState,env:Record<string,string|undefined>=process.env):void {
  validateState(state);
  assertVerificationDestination(state,env);
  const receipt=state.postActivation,activation=state.activation!;
  if(!receipt)throw new Error("Archive relocation has no post-activation verification receipt");
  if(receipt.destinationStamp!==activation.provenance!.destinationStamp||receipt.machineId!==activation.provenance!.machineId
    ||receipt.processInstance===activation.provenance!.processInstance||!activation.completedAt
    ||Date.parse(receipt.processStartedAt)<=Date.parse(activation.completedAt)
    ||Date.parse(receipt.verifiedAt)<Date.parse(receipt.processStartedAt))throw new Error("Archive post-activation process proof does not match activation");
  const entry=state.entries.find(entry=>entry.relative===receipt.read.relative);
  if(!entry||entry.digest!==receipt.read.digest||entry.bytes!==receipt.read.bytes
    ||receipt.write.relative!==`.archive-inventory/post-activation-${state.jobId}.json`)
    throw new Error("Archive post-activation IO proof does not match this job");
}

function verifiedFilePath(root:string,relative:string):string {
  safeRelative(relative);
  let target=root;
  for(const component of relative.split(/[\\/]/)) {
    target=path.join(target,component);
    const stat=fs.lstatSync(target);
    if(stat.isSymbolicLink())throw new Error("Archive verification refuses symbolic paths");
  }
  if(!locationContains(root,fs.realpathSync(target))||!fs.lstatSync(target).isFile())throw new Error("Archive verification requires a contained regular file");
  return target;
}

async function readMovedEvidence(state:ArchiveRelocationState):Promise<ArchiveRelocationVerificationReceipt["read"]> {
  // Activation already verified the whole copy. This is a bounded availability check,
  // not another history scan. Mutable sources may have legitimately advanced meanwhile.
  const identity=".archive-inventory/identity.json";
  const candidates=state.entries.filter(entry=>entry.digest&&entry.bytes<=VERIFICATION_READ_BUDGET&&entry.relative!==identity)
    .sort((a,b)=>Number(a.relative.startsWith(".archive-inventory/"))-Number(b.relative.startsWith(".archive-inventory/")));
  let budget=VERIFICATION_READ_BUDGET,attempts=0;
  for(const entry of candidates) {
    if(attempts>=8)break;
    if(entry.bytes>budget)continue;
    attempts++;budget-=entry.bytes;
    try {
      const file=verifiedFilePath(state.destinationRoot,entry.relative),stat=fs.statSync(file);
      if(stat.size!==entry.bytes)continue;
      const result=await hashFileBounded(file,entry.bytes);
      verifiedFilePath(state.destinationRoot,entry.relative);
      if(result.bytes===entry.bytes&&result.digest===entry.digest)return {relative:entry.relative,...result};
    } catch(error) {if(!missing(error))throw error;}
  }
  // The copied immutable identity remains a valid read proof when all sampled logs changed.
  const file=verifiedFilePath(state.destinationRoot,identity);
  if(fs.statSync(file).size>4096)throw new Error("Archive identity exceeds verification budget");
  const result=await hashFileBounded(file,4096),entry=state.entries.find(row=>row.relative===identity);
  if(!entry||result.bytes!==entry.bytes||result.digest!==entry.digest)throw new Error("Copied archive identity no longer matches verified material");
  return {relative:identity,...result};
}

/** Explicit fresh-process check. No source files are modified or removed. */
export async function verifyArchiveRelocation(jobId:string,options:ArchiveRelocationVerificationOptions):Promise<ArchiveRelocationState> {
  const env=options.env??process.env,stateFile=jobPath(path.resolve(options.stateDirectory),jobId);
  const lock=acquireJobLock(`${stateFile}.lock`);
  try {
    const state=validateState(readJson(stateFile));
    if(state.jobId!==jobId)throw new Error("Relocation verification job ID mismatch");
    externalStateDirectory(options.stateDirectory,state.sourceRoot,state.destinationRoot);
    assertVerificationDestination(state,env);
    const runtimePaths=await import("../config/paths");
    assertActivationEnvironment(state.destinationRoot,process.env);
    assertActivationPathOverrides(state.sourceRoot,state.destinationRoot,process.env);
    if(!samePath(realArchiveLocation(runtimePaths.ARCHIVE_ROOT),state.destinationRoot)
      ||locationContains(state.sourceRoot,runtimePaths.CONFIG_ROOT))
      throw new Error("Running process still uses old archive paths; restart in a new process is required");
    if(state.postActivation) {assertVerifiedArchiveRelocation(state,env);return state;}
    const processProof=currentProcessProof(state.destinationRoot);
    if(!state.activation!.completedAt||processProof.processInstance===state.activation!.provenance!.processInstance
      ||Date.parse(processProof.processStartedAt)<=Date.parse(state.activation!.completedAt))
      throw new Error("Post-activation verification requires a new process started after activation completed");
    return await withArchiveWriter(state.destinationRoot,async()=>{
      const read=await readMovedEvidence(state);
      const relative=`.archive-inventory/post-activation-${state.jobId}.json`,file=path.join(state.destinationRoot,relative);
      const directory=path.dirname(file);
      if(fs.lstatSync(directory).isSymbolicLink()||!samePath(fs.realpathSync(directory),directory))throw new Error("Archive verification control directory was replaced");
      let controlExists=false;
      try {fs.lstatSync(file);controlExists=true;} catch(error) {if(!missing(error))throw error;}
      if(controlExists) {
        verifiedFilePath(state.destinationRoot,relative);
        if(fs.statSync(file).size>4096)throw new Error("Archive verification control file is not owned by this job");
        const previous=readJson(file) as {schema?:number;kind?:string;jobId?:string;archiveId?:string;destinationStamp?:string};
        if(previous.schema!==1||previous.kind!=="archive-relocation-write-check"||previous.jobId!==state.jobId
          ||previous.archiveId!==state.archiveId||previous.destinationStamp!==processProof.destinationStamp)
          throw new Error("Archive verification control file is not owned by this job");
      }
      const payload=JSON.stringify({schema:1,kind:"archive-relocation-write-check",jobId:state.jobId,archiveId:state.archiveId,
        destinationStamp:processProof.destinationStamp,processInstance:PROCESS_INSTANCE,nonce:randomUUID()});
      atomicArchiveWrite(file,payload);
      syncDirectory(directory);
      verifiedFilePath(state.destinationRoot,relative);
      if(fs.readFileSync(file,"utf8")!==payload)throw new Error("Archive verification control write did not read back");
      const write={relative,digest:createHash("sha256").update(payload).digest("hex"),bytes:Buffer.byteLength(payload)};
      await options.hooks?.beforeReceipt?.();
      assertVerificationDestination(state,env);
      assertCurrentJobLock(`${stateFile}.lock`,lock);
      state.postActivation={status:"verified",verifiedAt:new Date().toISOString(),contract:"local-filesystem-read-write-check",...processProof,read,write};
      writeState(stateFile,state);
      return state;
    });
  } finally {releaseJobLock(lock,`${stateFile}.lock`);}
}
