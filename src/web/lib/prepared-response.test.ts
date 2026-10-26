import {expect,test} from "bun:test";
import {preparedResponse} from "./prepared-response";

const pending=()=>Response.json({status:"preparing"},{status:202,headers:{"X-Analysis":"preparing","Retry-After":"2"}});
test("preparing is retried without resolving with a false empty report",async()=>{
  let attempts=0,release!:()=>void;
  const wait=new Promise<void>(resolve=>release=resolve);
  const fetcher=(async()=>++attempts===1?pending():Response.json({account:"new",total:42})) as unknown as typeof fetch;
  let settled=false;
  const result=preparedResponse("/api/summary?account=new",{fetcher,wait:()=>wait}).then(res=>{settled=true;return res;});
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(attempts).toBe(1);expect(settled).toBe(false);
  release();expect(await (await result).json()).toEqual({account:"new",total:42});
});
test("preparation failures and retry exhaustion are not successful reports",async()=>{
  const failed=Response.json({error:"unavailable"},{status:503});
  expect(await preparedResponse("/api/summary",{fetcher:(async()=>failed) as unknown as typeof fetch})).toBe(failed);
  await expect(preparedResponse("/api/summary",{fetcher:(async()=>pending()) as unknown as typeof fetch,wait:async()=>{},maxAttempts:2})).rejects.toThrow("nadal przygotowywane");
});

test("a busy durable queue is retried until admission and the actual report arrives",async()=>{
  const responses=[Response.json({error:"database is locked"},{status:503,headers:{"X-Analysis":"busy","Retry-After":"2"}}),pending(),Response.json({account:"new",tokens:42})];
  const waits:number[]=[];
  const response=await preparedResponse("/api/summary?account=new",{
    fetcher:(async()=>responses.shift()!) as unknown as typeof fetch,wait:async ms=>{waits.push(ms);},
  });
  expect(await response.json()).toEqual({account:"new",tokens:42});
  expect(waits).toEqual([2000,2000]);
  expect(responses).toHaveLength(0);
});

test("cancelling a drawer stops its pending retry before another request",async()=>{
  const controller=new AbortController();let requests=0;
  const result=preparedResponse("/api/repo-history",{signal:controller.signal,fetcher:(async(_url:unknown,init?:RequestInit)=>{
    expect(init?.signal).toBe(controller.signal);requests++;return pending();
  }) as unknown as typeof fetch,wait:()=>new Promise(()=>{})});
  const handled=result.catch(error=>error);
  await Bun.sleep(0);controller.abort(new DOMException("Aborted","AbortError"));
  expect((await handled).message).toBe("Aborted");expect(requests).toBe(1);
});

test("short background preparation has no two-second presentation floor and long work backs off",async()=>{
  const simulate=async(readyAt:number,hinted:boolean)=>{
    let elapsed=0,requests=0;
    const waits:number[]=[];
    const response=await preparedResponse("/api/summary",{
      fetcher:(async()=>{
        requests++;
        return elapsed>=readyAt?Response.json({tokens:42}):Response.json({status:"preparing"},{status:202,
          headers:{"X-Analysis":"preparing",...(hinted?{"X-Analysis-Poll-Ms":"100"}:{"Retry-After":"2"})}});
      }) as unknown as typeof fetch,
      wait:async ms=>{waits.push(ms);elapsed+=ms;},
    });
    expect(await response.json()).toEqual({tokens:42});
    return {elapsed,requests,waits};
  };
  expect((await simulate(180,false)).elapsed).toBe(2000);
  const short=await simulate(180,true);
  expect(short.elapsed).toBe(300);
  expect(short.requests).toBe(3);
  const long=await simulate(30_000,true);
  expect(long.waits.slice(0,6)).toEqual([100,200,400,800,1600,2000]);
  expect(long.elapsed).toBeLessThan(32_000);
  expect(long.requests).toBeLessThanOrEqual(21);
});

test("only valid preparation hints change polling; busy responses keep server backpressure",async()=>{
  const waits:number[]=[];
  const responses=[
    ...["NaN","0","-10","Infinity"].map(hint=>Response.json({}, {status:202,headers:{"X-Analysis":"preparing","X-Analysis-Poll-Ms":hint}})),
    Response.json({}, {status:503,headers:{"X-Analysis":"busy","X-Analysis-Poll-Ms":"100","Retry-After":"3"}}),
    Response.json({ready:true}),
  ];
  await preparedResponse("/api/summary",{fetcher:(async()=>responses.shift()!) as unknown as typeof fetch,wait:async ms=>{waits.push(ms);}});
  expect(waits).toEqual([2000,2000,2000,2000,3000]);
});
