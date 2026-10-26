import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, onApiRefresh, refreshApiData, type AnalysisRebuildJob } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { chooseOption, dropdownOptions, dropdowns, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { AnalysisRebuildControl } from "./AnalysisRebuildControl";

function find(node:TestNode,tag:string):TestNode|undefined {
  if(node.tagName===tag && (tag!=="BUTTON" || /Recalculat/.test(node.textContent)))return node;
  for(const child of node.children){const found=find(child,tag);if(found)return found;}
}
const queued:AnalysisRebuildJob={generation:1,scope:"week",range:{from:"2026-09-10",until:"2026-09-16"},state:"queued",error:null};
function all(node:TestNode,tag:string):TestNode[] {return [...(node.tagName===tag?[node]:[]),...node.children.flatMap(child=>all(child,tag))];}

test("custom UTC dates are explicit and invalid dates never submit a reset",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as Element);
  const request=spyOn(api,"rebuildAnalysis").mockResolvedValue({ok:true,generation:1,job:queued});
  const status=spyOn(api,"analysisRebuildStatus").mockResolvedValue({job:null});setLanguage("en");
  try {
    await act(async()=>root.render(<AnalysisRebuildControl/>));
    const [scope,mode]=dropdowns(dom.host);
    expect((await dropdownOptions(scope!)).map(option => option.value)).toEqual(["all", "1d", "week", "14d", "month", "60d", "90d", "180d", "360d", "730d", "custom"]);
    expect((await dropdownOptions(mode!)).map(option => option.value)).toEqual(["archive", "collect-archive"]);
    await invoke(mode!,"onClick");
    await chooseOption(scope!,"custom");
    await invoke(find(dom.host,"BUTTON")!,"onClick");expect(request).not.toHaveBeenCalled();
    const inputs=all(dom.host,"INPUT");expect(inputs).toHaveLength(2);
    await invoke(inputs[0]!,"onChange",{target:{value:"2024-02-29"}});
    await invoke(inputs[1]!,"onChange",{target:{value:"2024-03-01"}});
    await invoke(find(dom.host,"BUTTON")!,"onClick");
    expect(request).toHaveBeenCalledWith({scope:"custom",from:"2024-02-29",until:"2024-03-01",mode:"archive"});
  } finally {await act(async()=>root.unmount());request.mockRestore();status.mockRestore();dom.restore();}
});

test("chosen scope is explicit, double clicks are blocked and server completion refreshes views",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as Element);
  let finish!:(value:Awaited<ReturnType<typeof api.rebuildAnalysis>>)=>void,refreshes=0;
  const request=spyOn(api,"rebuildAnalysis").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const status=spyOn(api,"analysisRebuildStatus").mockResolvedValue({job:null});
  const off=onApiRefresh(()=>{refreshes++;});setLanguage("en");
  try {
    await act(async()=>root.render(<AnalysisRebuildControl/>));
    expect(request).not.toHaveBeenCalled();
    await chooseOption(dropdowns(dom.host)[0]!,"week");
    await invoke(find(dom.host,"BUTTON")!,"onClick");await invoke(find(dom.host,"BUTTON")!,"onClick");
    expect(request).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledWith("week");
    expect(find(dom.host,"BUTTON")!.hasAttribute("disabled")).toBe(true);
    status.mockResolvedValue({job:queued});
    await act(async()=>{finish({ok:true,generation:1,job:queued});});
    expect(refreshes).toBe(1);expect(find(dom.host,"BUTTON")!.hasAttribute("disabled")).toBe(true);
    expect(dom.host.textContent).toContain("2026-09-10 – 2026-09-16");
    status.mockResolvedValue({job:{...queued,state:"complete"}});
    await act(async()=>refreshApiData());
    expect(find(dom.host,"BUTTON")!.hasAttribute("disabled")).toBe(false);
    expect(dom.host.textContent).toContain("Summaries and reports are ready.");expect(refreshes).toBe(3);
  } finally {await act(async()=>root.unmount());off();request.mockRestore();status.mockRestore();dom.restore();}
});

test("failed rebuild is retryable without claiming success or refreshing data",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as Element);
  const request=spyOn(api,"rebuildAnalysis").mockRejectedValue(new Error("Data is being saved"));
  const status=spyOn(api,"analysisRebuildStatus").mockResolvedValue({job:null});
  let refreshes=0;const off=onApiRefresh(()=>{refreshes++;});setLanguage("en");
  try {
    await act(async()=>root.render(<AnalysisRebuildControl/>));
    await invoke(find(dom.host,"BUTTON")!,"onClick");
    expect(request).toHaveBeenCalledWith("all");
    expect(dom.host.textContent).toContain("Data is being saved");
    expect(dom.host.textContent).not.toContain("Summaries and reports are ready.");
    expect(find(dom.host,"BUTTON")!.hasAttribute("disabled")).toBe(false);expect(refreshes).toBe(0);
  } finally {await act(async()=>root.unmount());off();request.mockRestore();status.mockRestore();dom.restore();}
});

test("returning to settings resumes display of an active job without starting another",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as Element);
  const request=spyOn(api,"rebuildAnalysis");
  const status=spyOn(api,"analysisRebuildStatus").mockResolvedValue({job:{...queued,state:"running"}});
  setLanguage("en");
  try {
    await act(async()=>root.render(<AnalysisRebuildControl/>));
    expect(find(dom.host,"BUTTON")!.hasAttribute("disabled")).toBe(true);
    expect(dom.host.textContent).toContain("Rebuilding summaries");expect(request).not.toHaveBeenCalled();
  } finally {await act(async()=>root.unmount());request.mockRestore();status.mockRestore();dom.restore();}
});

test("a failed job can resume without starting a new full reset",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as Element);
  const request=spyOn(api,"rebuildAnalysis");
  const resume=spyOn(api,"resumeAnalysis").mockResolvedValue({ok:true,generation:1,job:queued});
  const status=spyOn(api,"analysisRebuildStatus").mockResolvedValue({job:{...queued,state:"error",error:"interrupted"}});
  setLanguage("en");
  const button=(node:TestNode):TestNode|undefined=>node.tagName==="BUTTON" && node.textContent.includes("Resume")?node:node.children.map(button).find(Boolean);
  try {
    await act(async()=>root.render(<AnalysisRebuildControl/>));
    await invoke(button(dom.host)!,"onClick");
    expect(resume).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());resume.mockRestore();request.mockRestore();status.mockRestore();dom.restore();}
});
