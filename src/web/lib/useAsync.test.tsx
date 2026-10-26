import {expect,test} from "bun:test";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {useAsync} from "./useAsync";
import {installTestDom} from "./test-dom-harness";
import {api,bustApiMemo} from "./api";
import {useStaleReportTime} from "./report-freshness";
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
