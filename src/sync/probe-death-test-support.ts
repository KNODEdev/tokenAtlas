import fs from "node:fs";

/** Startup, migration and replay share the outer budget; each child has its own hang guard. */
export const PROBE_DEATH_TEST_TIMEOUT_MS = 120_000;
// These fixtures start Bun, migrate two databases and replay the real coordinator.
// Their process-start guard is separate from the application's read latency budget.
const CHILD_TIMEOUT_MS = 30_000;

export async function runProbeDeathProcess(code: string, env: NodeJS.ProcessEnv, marker: string, kill: boolean, timeoutMs = CHILD_TIMEOUT_MS): Promise<void> {
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  const started=performance.now();
  const child=Bun.spawn([process.execPath,"--eval",code],{env,stdout:"pipe",stderr:"pipe"});
  const out=new Response(child.stdout).text(),err=new Response(child.stderr).text();
  let timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;if(child.exitCode==null)child.kill();},timeoutMs);
  try {
    if(kill) {
      const deadline=performance.now()+timeoutMs;
      while(!fs.existsSync(marker) && child.exitCode==null && performance.now()<deadline)await Bun.sleep(10);
      if(!fs.existsSync(marker)) {
        // Drain pipes only after termination; a live unarmed process may never close stderr.
        if(child.exitCode==null)child.kill();
        await child.exited;
        throw Error(`death boundary not armed after ${Math.round(performance.now()-started)}ms: ${await err}`);
      }
      child.kill();
      if(await child.exited===0)throw Error("Armed child exited successfully instead of external death");
    } else {
      const exit=await child.exited;
      if(exit!==0)throw Error(`probe child ${timedOut?"timed out":"failed"} after ${Math.round(performance.now()-started)}ms (exit ${exit}): ${await err}`);
    }
    if(timedOut)throw Error(`probe child exceeded ${timeoutMs}ms`);
  } finally {
    clearTimeout(timeout);
    if(child.exitCode==null)child.kill();
    await child.exited;
    await Promise.allSettled([out,err]);
  }
}
