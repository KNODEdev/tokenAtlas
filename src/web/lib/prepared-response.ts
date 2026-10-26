/** A preparation receipt is never a report. Keep the caller's last ready state until ready. */
export async function preparedResponse(url:string, options:{fetcher?:typeof fetch;wait?:(ms:number)=>Promise<void>;maxAttempts?:number;signal?:AbortSignal}={}):Promise<Response> {
  const {fetcher=fetch,wait=ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)),maxAttempts=300,signal}=options;
  for(let attempt=0;attempt<maxAttempts;attempt++) {
    signal?.throwIfAborted();
    const response=await fetcher(url,{signal});
    const state=response.headers.get("X-Analysis");
    const retry=response.status===202 && state==="preparing" || response.status===503 && state==="busy";
    if(!retry)return response;
    await response.body?.cancel();
    if(attempt+1===maxAttempts)throw new Error("Dane są nadal przygotowywane w tle. Spróbuj ponownie za chwilę.");
    const seconds=Number(response.headers.get("Retry-After")??2);
    const retryMs=Number.isFinite(seconds)?Math.max(1,Math.min(seconds,10))*1000:2000;
    const hint=Number(response.headers.get("X-Analysis-Poll-Ms"));
    // A short preparation can finish before the first legacy two-second poll. Back
    // off to that cadence for longer jobs; lock contention retains Retry-After.
    const ms=response.status===202 && hint>0 && Number.isFinite(hint)
      ? Math.min(2000,Math.max(100,hint)*2**Math.min(attempt,5)) : retryMs;
    if(!signal)await wait(ms);
    else await new Promise<void>((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener("abort",abort);reject(signal.reason);};
      signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted){abort();return;}
      wait(ms).then(()=>{signal.removeEventListener("abort",abort);resolve();},error=>{signal.removeEventListener("abort",abort);reject(error);});
    });
  }
  throw new Error("Data preparation retry limit exceeded");
}
