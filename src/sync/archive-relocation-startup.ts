import path from "node:path";
import {readLocalArchiveSelection} from "../config/archive-locator";
import {readArchiveRelocationLink} from "../config/archive-relocation-link";
import { readArchiveRelocation } from "./archive-relocation-state";
import { verifyArchiveRelocation } from "./archive-relocation-verification";

export type StartupRelocationResult = {status:"not-applicable"}|{status:"verified";jobId:string}|{status:"pending";jobId?:string;reason:string};
/** Called only in the startup worker; ordinary reads never execute verification. */
export async function verifyStartupArchiveRelocation(roots:{archiveRoot:string;configRoot:string;processStartedAt:number}):Promise<StartupRelocationResult> {
  let jobId:string|undefined;
  try {
    const selected=readLocalArchiveSelection();
    if(!selected)return {status:"not-applicable"};
    const link=readArchiveRelocationLink(selected);
    if(!link)return {status:"not-applicable"};
    jobId=link.jobId;
    const paths=await import("../config/paths");
    const same=(a:string,b:string)=>process.platform==="win32"?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
    if(!same(roots.archiveRoot,paths.ARCHIVE_ROOT)||!same(roots.configRoot,paths.CONFIG_ROOT))
      throw new Error("Server still uses different archive paths; restart required");
    const state=readArchiveRelocation(link.stateDirectory,jobId);
    if(state.archiveId!==link.archiveId || !same(state.destinationRoot,link.root))throw new Error("Relocation job does not match local startup link");
    if(state.phase!=="activated")throw new Error("Relocation activation needs explicit resume before verification");
    if(!Number.isFinite(roots.processStartedAt)||!state.activation?.completedAt||roots.processStartedAt<=Date.parse(state.activation.completedAt))
      throw new Error("Server process predates relocation activation; restart required");
    await verifyArchiveRelocation(jobId,{stateDirectory:link.stateDirectory});
    return {status:"verified",jobId};
  } catch(error) {return {status:"pending",jobId,reason:error instanceof Error?error.message:String(error)};}
}

/** Hashing and durable writes run off the HTTP event loop; failures remain retryable. */
export function startArchiveRelocationVerification(roots:{archiveRoot:string;configRoot:string},onResult:(result:StartupRelocationResult)=>void=()=>{}) {
  let worker:Bun.Subprocess<"ignore","pipe","ignore">|null=null,closed=false,complete=false,retryAt=0;
  const processStartedAt=Date.now()-process.uptime()*1000;
  const update=()=>{
    if(closed||complete||worker||Date.now()<retryAt)return;
    let next:Bun.Subprocess<"ignore","pipe","ignore">;
    try {
      next=Bun.spawn([process.execPath,path.join(import.meta.dir,"archive-relocation-startup-worker.ts"),JSON.stringify({...roots,processStartedAt})],{stdin:"ignore",stdout:"pipe",stderr:"ignore"});
    } catch(error) {retryAt=Date.now()+60000;onResult({status:"pending",reason:String(error)});return;}
    worker=next;
    void Promise.all([next.exited,new Response(next.stdout).text()]).then(([code,output])=>{
      if(closed)return;
      const result:StartupRelocationResult=code===0?JSON.parse(output):{status:"pending",reason:`Verification process exited without a result (${code})`};
      complete=result.status!=="pending";retryAt=Date.now()+60000;onResult(result);
    }).catch(error=>{
      if(!closed){retryAt=Date.now()+60000;onResult({status:"pending",reason:String(error)});}
    }).finally(()=>{if(worker===next)worker=null;});
    // Keep exit delivery alive until completion; close() owns cancellation.
  };
  return {update,async close(){closed=true;const active=worker;worker=null;if(active){active.kill();await active.exited;}}};
}
