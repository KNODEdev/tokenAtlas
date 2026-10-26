import { LocalArchiveActivationDecisionError } from "../config/archive-locator";
import { initializeArchiveWriterIdentity } from "./archive-writers";
import { activateArchiveRelocation, type ArchiveRelocationActivationHook } from "./archive-relocation";

const [jobId,stateDirectory,database,exitAt]=process.argv.slice(2);
if(!jobId || !stateDirectory || !database)throw new Error("activation worker requires job, state directory and database");
initializeArchiveWriterIdentity();
const state=await activateArchiveRelocation(jobId,{
  stateDirectory,database,env:process.env,
  hooks:exitAt==="uncertain-commit"?{
    afterLocatorCommit(){throw new LocalArchiveActivationDecisionError("unknown","simulated uncertain post-commit failure");},
    proveDecision(){throw new Error("simulated decision read failure");},
  }:exitAt?{onPhase(phase:ArchiveRelocationActivationHook){if(phase===exitAt)process.exit(86);}}:undefined,
});
console.log(JSON.stringify({phase:state.phase,activation:state.activation}));
