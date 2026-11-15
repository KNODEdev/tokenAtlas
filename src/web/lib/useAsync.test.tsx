import {expect,test} from "bun:test";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {useAsync} from "./useAsync";
import {installTestDom} from "./test-dom-harness";
import {api,bustApiMemo} from "./api";
import {markReportStale,useStaleReportTime} from "./report-freshness";
/** Reads the stale-report store the header activity shows. */
function ReportFreshness(){return useStaleReportTime()===null?null:<span>Showing the last consistent result</span>;}

test("refresh retains a ready report and late completion cannot overwrite a newly selected account",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as HTMLElement);
  const pending=new Map<string,(value:string)=>void>();
  const revisions=new Map<string,number>();
  let refresh=()=>{};
  function Screen({account}:{account:string}) {
    const state=useAsync(()=>new Promise<string>(resolve=>{
      const revision=revisions.get(account)??0;revisions.set(account,revision+1);
      pending.set(`${account}:${revision}`,resolve);
    }),[account]);
    refresh=state.reload;
    return <div>{state.data??"preparing"}</div>;
  }
  try {
    await act(async()=>root.render(<Screen account="old"/>));
    await act(async()=>pending.get("old:0")!("old ready"));
    await act(async()=>refresh());
    expect(dom.host.textContent).toBe("old ready");
    await act(async()=>root.render(<Screen account="new"/>));
    expect(dom.host.textContent).toBe("preparing");
    await act(async()=>pending.get("new:0")!("new ready"));
    await act(async()=>pending.get("old:1")!("obsolete old report"));
    expect(dom.host.textContent).toBe("new ready");
  }finally{await act(async()=>root.unmount());dom.restore();}
});

test("returning to a subscription shows its last data while it is read again, never another subscription's",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as HTMLElement);
  const pending=new Map<string,(value:string)=>void>();
  const revisions=new Map<string,number>();
  function Screen({account}:{account:string}) {
    const state=useAsync(()=>new Promise<string>(resolve=>{
      const revision=revisions.get(account)??0;revisions.set(account,revision+1);
      pending.set(`${account}:${revision}`,resolve);
    }),[account]);
    return <div>{state.data??"preparing"}{state.loading?" (reading)":""}</div>;
  }
  try {
    await act(async()=>root.render(<Screen account="a"/>));
    await act(async()=>pending.get("a:0")!("a ready"));
    await act(async()=>root.render(<Screen account="b"/>));
    expect(dom.host.textContent).toBe("preparing (reading)");
    await act(async()=>pending.get("b:0")!("b ready"));
    await act(async()=>root.render(<Screen account="a"/>));
    expect(dom.host.textContent).toBe("a ready (reading)");
    await act(async()=>pending.get("b:1")?.("obsolete b"));
    expect(dom.host.textContent).toBe("a ready (reading)");
    await act(async()=>pending.get("a:1")!("a again"));
    expect(dom.host.textContent).toBe("a again");
  }finally{await act(async()=>root.unmount());dom.restore();}
});

test("obsolete subscription polling is aborted while the selected subscription resolves",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as HTMLElement);
  const signals=new Map<string,AbortSignal>();
  function Screen({account}:{account:string}) {
    const state=useAsync(signal=>{signals.set(account,signal);return account==="old"?new Promise<string>(()=>{}):Promise.resolve("new ready");},[account]);
    return <div>{state.data??"preparing"}</div>;
  }
  try {
    await act(async()=>root.render(<Screen account="old"/>));
    await act(async()=>root.render(<Screen account="new"/>));
    expect(signals.get("old")?.aborted).toBe(true);
    expect(signals.get("new")?.aborted).toBe(false);
    expect(dom.host.textContent).toBe("new ready");
  }finally{await act(async()=>root.unmount());dom.restore();}
});

test("an explicitly stale API result stays visible with its timestamp and refreshes automatically",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as HTMLElement),originalFetch=globalThis.fetch;
  const location=Object.getOwnPropertyDescriptor(globalThis,"location");
  Object.defineProperty(globalThis,"location",{configurable:true,value:document.location});
  let requests=0;
  bustApiMemo();
  globalThis.fetch=(async()=>++requests===1
    ? Response.json({subscriptions:[{id:"old-result"}]},{headers:{"X-Analysis":"stale","X-Analysis-Prepared-At":"1789732800000"}})
    : Response.json({subscriptions:[{id:"fresh-result"}]})) as unknown as typeof fetch;
  function Screen(){const state=useAsync(()=>api.accounts(),[]);return <><ReportFreshness/><div>{state.data?.subscriptions[0]?.id}</div></>;}
  try {
    await act(async()=>root.render(<Screen/>));
    expect(dom.host.textContent).toContain("old-result");
    expect(dom.host.textContent).toContain("Showing the last consistent result");
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,2100));});
    expect(requests).toBe(2);
    expect(dom.host.textContent).toContain("fresh-result");
    expect(dom.host.textContent).not.toContain("Showing the last consistent result");
  }finally{
    await act(async()=>root.unmount());globalThis.fetch=originalFetch;
    if(location)Object.defineProperty(globalThis,"location",location);else Reflect.deleteProperty(globalThis,"location");
    bustApiMemo();dom.restore();
  }
});

/** Manual clock for timers of a second or more (the stale refresh); shorter ones stay real for React and the DOM harness. */
function installSlowTimerClock(){
  const real={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval};
  const timers=new Map<number,{at:number;fn:()=>void;every?:number}>();
  let now=0,nextId=0;
  const schedule=(repeat:boolean)=>((fn:()=>void,ms=0,...args:unknown[])=>{
    if(ms<1000)return (repeat?real.setInterval:real.setTimeout)(fn,ms,...args);
    timers.set(++nextId,{at:now+ms,fn,every:repeat?ms:undefined});return nextId;
  }) as unknown as typeof setTimeout;
  const clear=(fallback:(id:unknown)=>void)=>((id:unknown)=>{if(!timers.delete(id as number))fallback(id);}) as typeof clearTimeout;
  globalThis.setTimeout=schedule(false);globalThis.setInterval=schedule(true) as unknown as typeof setInterval;
  globalThis.clearTimeout=clear(real.clearTimeout as (id:unknown)=>void);globalThis.clearInterval=clear(real.clearInterval as (id:unknown)=>void);
  return {
    async advance(ms:number){
      const end=now+ms;
      for(;;){
        const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!due)break;
        const [id,timer]=due;now=timer.at;
        if(timer.every)timer.at+=timer.every;else timers.delete(id);
        await act(async()=>timer.fn());
      }
      now=end;
    },
    restore(){Object.assign(globalThis,real);},
  };
}
/** Each read stays unanswered until the test answers it: stale (with a prepared-at time), fresh or failed. */
function controlledReads(){
  const reads:{account:string;signal:AbortSignal;answer:(body:{value:string})=>void;fail:(error:Error)=>void}[]=[];
  const count=(account:string)=>reads.filter(read=>read.account===account).length;
  const latest=()=>reads.at(-1)!;
  return {
    reads,count,
    read:(account:string,signal:AbortSignal)=>new Promise<{value:string}>((answer,fail)=>reads.push({account,signal,answer,fail})),
    stale(preparedAt:number){const body={value:`stale ${preparedAt}`};markReportStale(body,preparedAt);latest().answer(body);},
    fresh(){latest().answer({value:"fresh"});},
  };
}

test("a stale report refreshes one request at a time, backing off 2 s, 4 s, 8 s, 16 s, then every 30 s",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as HTMLElement),clock=installSlowTimerClock(),server=controlledReads();
  function Screen(){const state=useAsync(signal=>server.read("a",signal),["a"]);return <><ReportFreshness/><div>{state.data?.value}</div></>;}
  const expectNextRefreshAfter=async(ms:number)=>{
    const before=server.count("a");
    await clock.advance(ms-1);expect(server.count("a")).toBe(before);
    await clock.advance(1);expect(server.count("a")).toBe(before+1);
  };
  try {
    await act(async()=>root.render(<Screen/>));
    await act(async()=>server.stale(1));
    expect(dom.host.textContent).toContain("Showing the last consistent result");
    await expectNextRefreshAfter(2000);
    // The refresh is still unanswered: however long the server takes, no request piles on top of it.
    await clock.advance(120_000);
    expect(server.count("a")).toBe(2);
    expect(server.reads[1]!.signal.aborted).toBe(false);
    // A newer prepared-at time still means "preparing": the backoff continues.
    let preparedAt=1;
    for(const delay of [4000,8000,16000,30000,30000]){
      await act(async()=>server.stale(++preparedAt));
      await expectNextRefreshAfter(delay);
    }
    // A failed refresh keeps the last result and waits as long as a stale answer would.
    await act(async()=>server.reads.at(-1)!.fail(new Error("server busy")));
    expect(dom.host.textContent).toContain(`stale ${preparedAt}`);
    await expectNextRefreshAfter(30000);
    await act(async()=>server.fresh());
    expect(dom.host.textContent).toContain("fresh");
    expect(dom.host.textContent).not.toContain("Showing the last consistent result");
    const settled=server.count("a");
    await clock.advance(600_000);
    expect(server.count("a")).toBe(settled);
  }finally{await act(async()=>root.unmount());clock.restore();dom.restore();}
});

test("another scope, or a report that turns stale again after a fresh answer, restarts the refresh delay at 2 s",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as HTMLElement),clock=installSlowTimerClock(),server=controlledReads();
  let reload=()=>{};
  function Screen({account}:{account:string}){
    const state=useAsync(signal=>server.read(account,signal),[account]);reload=state.reload;
    return <div>{state.data?.value}</div>;
  }
  try {
    await act(async()=>root.render(<Screen account="a"/>));
    await act(async()=>server.stale(1));
    await clock.advance(2000);
    await act(async()=>server.stale(2));
    // "a" now waits 4 s; switching to "b" drops that schedule and starts over.
    await act(async()=>root.render(<Screen account="b"/>));
    await act(async()=>server.stale(3));
    await clock.advance(1999);expect(server.count("b")).toBe(1);
    await clock.advance(1);expect(server.count("b")).toBe(2);
    expect(server.count("a")).toBe(2);
    await act(async()=>server.stale(4));
    await clock.advance(4000);expect(server.count("b")).toBe(3);
    await act(async()=>server.fresh());
    await act(async()=>reload());expect(server.count("b")).toBe(4);
    await act(async()=>server.stale(5));
    await clock.advance(1999);expect(server.count("b")).toBe(4);
    await clock.advance(1);expect(server.count("b")).toBe(5);
  }finally{await act(async()=>root.unmount());clock.restore();dom.restore();}
});
