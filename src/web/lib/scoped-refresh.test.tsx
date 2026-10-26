import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, bustApiMemo, refreshApiData, trackApiReads, apiReadsAffected } from "./api";
import { useAsync } from "./useAsync";
import { installTestDom } from "./test-dom-harness";

test("mounted readers refresh only changed scopes; a switch and a configuration refresh retain freshness",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as HTMLElement),calls=new Map<string,number>();
  Object.defineProperty(window,"location",{configurable:true,value:{origin:"http://fixture.local"}});
  const fetch=spyOn(globalThis,"fetch").mockImplementation(Object.assign(async(url:unknown)=>{
    const account=new URL(String(url)).searchParams.get("account")!;
    const n=(calls.get(account)??0)+1;calls.set(account,n);return Response.json({windows:[],n});
  },{preconnect(){}}) as typeof globalThis.fetch);
  function Reader({account,live=false}:{account:string;live?:boolean}){
    const state=useAsync(signal=>api.windows({account},signal),[account],live);
    return <span>{account}:{(state.data as unknown as {n:number}|null)?.n}</span>;
  }
  const path=(account:string)=>`/api/windows?account=${account}`;
  try{
    await act(async()=>root.render(<><Reader account="a"/><Reader account="b"/><Reader account="live" live/></>));
    expect([...calls]).toEqual([["a",1],["b",1],["live",1]]);
    await act(async()=>refreshApiData({unchanged:[path("b"),path("live")]}));
    expect([...calls]).toEqual([["a",2],["b",1],["live",1]]);
    await act(async()=>refreshApiData({unchanged:[path("a"),path("b"),path("live")],live:true}));
    expect([...calls]).toEqual([["a",2],["b",1],["live",2]]);
    await act(async()=>root.render(<Reader account="c"/>));
    await act(async()=>refreshApiData({unchanged:[path("a"),path("b")]}));
    expect(calls.get("c")).toBe(2);
    await act(async()=>refreshApiData());expect(calls.get("c")).toBe(3);
  }finally{await act(async()=>root.unmount());fetch.mockRestore();bustApiMemo();dom.restore();}
});

test("mixed and not-yet-known dependencies stay conservative; completed memo of an unchanged scope survives",async()=>{
  const dom=installTestDom(),signal=new AbortController().signal,stop=trackApiReads(signal);let calls=0;
  Object.defineProperty(window,"location",{configurable:true,value:{origin:"http://fixture.local"}});
  const fetch=spyOn(globalThis,"fetch").mockImplementation(Object.assign(async()=>{calls++;return Response.json({totals:{tokens:calls}});},{preconnect(){}}) as typeof globalThis.fetch);
  const args={account:"seat",since_ts:"2026-09-01T00:00:00Z",until_ts:"2026-09-02T00:00:00Z"};
  try{
    expect(apiReadsAffected(signal,{unchanged:[]})).toBe(true);
    await api.cycleBreakdown(args,signal);
    // The real status request exposes the paths collected from mounted reads and memo entries.
    const seen:string[]=[];
    fetch.mockImplementation(Object.assign(async(url:unknown)=>{
      seen.push(String(url));calls++;return Response.json({totals:{tokens:calls}});
    },{preconnect(){}}) as typeof globalThis.fetch);
    await api.syncStatus(undefined,0);
    const paths=JSON.parse(new URL(seen[0]!).searchParams.get("read_paths")!) as string[];
    const cycle=paths.find(path=>path.startsWith("/api/cycle-breakdown"))!;
    expect(cycle).toBeDefined();expect(apiReadsAffected(signal,{unchanged:[cycle]})).toBe(false);
    refreshApiData({unchanged:[cycle]});await api.cycleBreakdown(args,new AbortController().signal);
    expect(calls).toBe(2);
    await api.windows({account:"another"},signal);
    expect(apiReadsAffected(signal,{unchanged:[cycle]})).toBe(true);
    refreshApiData();await api.cycleBreakdown(args,new AbortController().signal);expect(calls).toBe(4);
  }finally{stop();fetch.mockRestore();bustApiMemo();dom.restore();}
});

test("dependency checks fit an ordinary HTTP request even when many long request paths are mounted",async()=>{
  const dom=installTestDom(),signal=new AbortController().signal,stop=trackApiReads(signal),seen:string[]=[];
  Object.defineProperty(window,"location",{configurable:true,value:{origin:"http://fixture.local"}});
  const fetch=spyOn(globalThis,"fetch").mockImplementation(Object.assign(async(url:unknown)=>{
    seen.push(String(url));return Response.json({windows:[]});
  },{preconnect(){}}) as typeof globalThis.fetch);
  try{
    for(let i=0;i<30;i++)await api.windows({account:`seat-${i}-${"a".repeat(300)}`},signal);
    await api.syncStatus(undefined,1);
    expect(seen.at(-1)!.length).toBeLessThan(6500);
    const paths=JSON.parse(new URL(seen.at(-1)!).searchParams.get("read_paths")!) as string[];
    expect(paths.length).toBeGreaterThan(0);expect(paths.length).toBeLessThan(30);
    expect(apiReadsAffected(signal,{unchanged:paths})).toBe(true);
  }finally{stop();fetch.mockRestore();bustApiMemo();dom.restore();}
});
