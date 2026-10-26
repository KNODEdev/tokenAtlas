import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {assertLocalStateOutsideRoots,resolveLocalStateRootBase,type LocalArchiveSelection} from "./archive-locator";
import {atomicArchiveWrite} from "../sync/archive-publication";

export interface ArchiveRelocationLink extends LocalArchiveSelection {
  schema:1;
  jobId:string;
  stateDirectory:string;
}
function linkPath(selection:LocalArchiveSelection,env:NodeJS.ProcessEnv):string {
  const root=path.resolve(selection.root);
  const key=createHash("sha256").update(JSON.stringify([selection.archiveId,process.platform==="win32"?root.toLowerCase():root])).digest("hex");
  return path.join(resolveLocalStateRootBase(env),`archive-relocation-${key}.json`);
}
function validate(value:ArchiveRelocationLink):void {
  if(value.schema!==1 || !/^[a-f0-9-]{36}$/i.test(value.jobId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.archiveId)
    || typeof value.root!=="string" || !path.isAbsolute(value.root)
    || typeof value.stateDirectory!=="string" || !path.isAbsolute(value.stateDirectory)
    || /[\r\n\0]/.test(value.root+value.stateDirectory))throw new Error("Invalid local relocation link");
}
/** Published before cutover, so a crash cannot lose the job needed after restart. */
export function persistArchiveRelocationLink(link:ArchiveRelocationLink,sourceRoot:string,env:NodeJS.ProcessEnv=process.env):void {
  validate(link);
  const localRoot=resolveLocalStateRootBase(env);
  assertLocalStateOutsideRoots(localRoot,[sourceRoot,link.root]);
  assertLocalStateOutsideRoots(link.stateDirectory,[sourceRoot,link.root]);
  const file=linkPath(link,env);
  atomicArchiveWrite(file,JSON.stringify(link));
  // Windows does not support fsync on directory handles; file data was flushed above.
  if(process.platform!=="win32") {
    const fd=fs.openSync(localRoot,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
}
/** Missing links on legacy activations remain unknown; this read creates nothing. */
export function readArchiveRelocationLink(selection:LocalArchiveSelection,env:NodeJS.ProcessEnv=process.env):ArchiveRelocationLink|null {
  const file=linkPath(selection,env);
  let stat:fs.Stats;
  try{stat=fs.lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error("Invalid local relocation link file");
  const link=JSON.parse(fs.readFileSync(file,"utf8")) as ArchiveRelocationLink;
  validate(link);
  if(link.archiveId!==selection.archiveId || path.resolve(link.root)!==path.resolve(selection.root))throw new Error("Local relocation link does not match locator");
  return link;
}
