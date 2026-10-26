import {persistLocalArchiveSelection} from "../config/archive-locator";
import {initializeArchiveWriterIdentity} from "./archive-writers";

const [mode,source,destination,stateDirectory,database,archiveId,jobId]=process.argv.slice(2);
if(!mode || !source || !destination || !stateDirectory || !database || !archiveId)
  throw new Error("Verification fixture requires mode and isolated fixture paths");
initializeArchiveWriterIdentity();
if(mode.startsWith("activate"))persistLocalArchiveSelection({root:source,archiveId},process.env);
// Cache the effective startup root before activation, as a long-lived app would.
const paths=await import("../config/paths");
const relocation=await import("./archive-relocation");
if(mode.startsWith("activate")) {
  let state=relocation.startArchiveRelocation(source,destination,{stateDirectory});
  for(let step=0;state.phase!=="ready-to-switch" && step<100;step++)
    state=await relocation.advanceArchiveRelocation(state.jobId,{stateDirectory,maxFiles:2,maxBytes:1024});
  if(state.phase!=="ready-to-switch")throw new Error("Synthetic relocation failed to prepare");
  state=await relocation.activateArchiveRelocation(state.jobId,{stateDirectory,database,env:process.env});
  let oldProcessError:string|null=null;
  if(mode==="activate-and-refuse-old") {
    try {await relocation.verifyArchiveRelocation(state.jobId,{stateDirectory,env:process.env});}
    catch(error){oldProcessError=String(error);}
  }
  console.log(JSON.stringify({state,oldProcessError,startupRoot:paths.ARCHIVE_ROOT}));
} else {
  if(mode==="startup" || mode==="startup-stale") {
    const {startArchiveRelocationVerification}=await import("./archive-relocation-startup");
    const result=await new Promise<unknown>(resolve=>{
      const verifier=startArchiveRelocationVerification({archiveRoot:mode==="startup-stale"?source:paths.ARCHIVE_ROOT,configRoot:paths.CONFIG_ROOT},value=>{
        resolve(value);void verifier.close();
      });
      verifier.update();
    });
    console.log(JSON.stringify({result,startupRoot:paths.ARCHIVE_ROOT}));
    process.exit(0);
  }
  if(!jobId)throw new Error("Verification fixture requires a job ID");
  const state=await relocation.verifyArchiveRelocation(jobId,{stateDirectory,env:process.env,
    hooks:mode==="fail-before-receipt"?{beforeReceipt(){throw new Error("synthetic failure before verification receipt");}}
      :mode==="crash-before-receipt"?{beforeReceipt(){process.exit(87);}}:undefined});
  console.log(JSON.stringify({state,startupRoot:paths.ARCHIVE_ROOT}));
}
