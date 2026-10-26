import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { api, type ClaudeLimitResponse } from "../lib/api";
import { installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { setLanguage } from "../lib/i18n";
import { ClaudeOverview } from "./ClaudeOverview";
import { claudeSections } from "../components/ClaudeSections";
import { VendorOverview } from "../components/VendorOverview";
import { ACCOUNTS, TIMES, createClaudeCodeAcceptanceFixture } from "../../server/claude-code-capacity.fixture";
import { buildClaudeLimit, buildClaudeLimitCard, readClaudeLimitCardMetadata } from "../../server/claude-limit";
import { getClaudeRate } from "../../server/pricing";
import { advanceClaudeCardMetadata } from "../../server/claude-card-metadata";
const allNodes=(node:TestNode):TestNode[]=>[node,...node.children.flatMap(allNodes)];

test("Claude first mounts the small card; history is lazy and old account/bounds reads are cancelled", async () => {
  const f=createClaudeCodeAcceptanceFixture(),dom=installTestDom(),root=createRoot(dom.host as unknown as Element);
  const storageDescriptor=Object.getOwnPropertyDescriptor(globalThis,"localStorage"),storage=new Map<string,string>();
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)}});
  setLanguage("en");
  type Pending={account?:string;bounds?:{from:string;until:string}|null;signal?:AbortSignal;resolve:(value:ClaudeLimitResponse)=>void};
  const cards:Pending[]=[],histories:Pending[]=[];
  const cardSpy=spyOn(api,"claudeLimitCard").mockImplementation((account,bounds,signal)=>new Promise(resolve=>cards.push({account,bounds,signal,resolve})));
  const projectsSpy=spyOn(api,"windowProjects").mockImplementation(async request=>({...request,provider:"claude",projects:[]}));
  const historySpy=spyOn(api,"claudeLimit").mockImplementation((account,bounds,signal)=>new Promise(resolve=>histories.push({account,bounds,signal,resolve})));
  const report=(account:string)=>{
    const cfg={subscription:account,window_hours:168,observations:[]};
    const price=(m:string|null,d:string,s:string|null)=>getClaudeRate(f.rates,m,d,s);
    const full=buildClaudeLimit(f.db,cfg,price,TIMES.asOf,{rateCards:f.rates});
    const card=buildClaudeLimitCard(f.db,cfg,price,TIMES.asOf,{rateCards:f.rates},undefined,readClaudeLimitCardMetadata(f.db,cfg));
    expect(card).toEqual({...full,observations:[]});
    return {full:full as ClaudeLimitResponse,card:card as ClaudeLimitResponse};
  };
  try {
    for(let i=0;i<100;i++)if(!advanceClaudeCardMetadata(f.db).pending)break;
    const a=report(ACCOUNTS.a),b=report(ACCOUNTS.b);
    const sections=(data:ClaudeLimitResponse)=>claudeSections({capabilities:null,data,account:ACCOUNTS.a});
    expect(renderToStaticMarkup(<VendorOverview sections={sections(a.card)}/>)).toBe(renderToStaticMarkup(<VendorOverview sections={sections(a.full)}/>));
    await act(async()=>root.render(<ClaudeOverview account={ACCOUNTS.a} capabilities={null}/>));
    expect(cards).toHaveLength(1);expect(histories).toHaveLength(0);
    await act(async()=>cards[0]!.resolve(a.card));
    expect(histories).toHaveLength(0);
    const calibration=allNodes(dom.host).find(node=>node.tagName==="BUTTON"&&node.textContent==="Data and calibration");
    expect(calibration).toBeDefined();await act(async()=>invoke(calibration!,"onClick"));
    expect(histories).toHaveLength(1);
    await act(async()=>root.render(<ClaudeOverview account={ACCOUNTS.b} capabilities={null}/>));
    expect(cards[0]!.signal?.aborted).toBe(true);expect(histories[0]!.signal?.aborted).toBe(true);
    expect(cards[1]!.account).toBe(ACCOUNTS.b);
    await act(async()=>histories[0]!.resolve(a.full));
    await act(async()=>cards[1]!.resolve(b.card));
    const bounds={from:TIMES.start,until:TIMES.reset};
    await act(async()=>root.render(<ClaudeOverview account={ACCOUNTS.b} capabilities={null} bounds={bounds}/>));
    expect(cards[1]!.signal?.aborted).toBe(true);expect(cards.at(-1)!.bounds).toEqual(bounds);
    await act(async()=>cards.at(-1)!.resolve(b.card));
    expect(histories.at(-1)!.bounds).toEqual(bounds);
  } finally {
    await act(async()=>root.unmount());cardSpy.mockRestore();historySpy.mockRestore();projectsSpy.mockRestore();dom.restore();f.teardown();
    if(storageDescriptor)Object.defineProperty(globalThis,"localStorage",storageDescriptor);else Reflect.deleteProperty(globalThis,"localStorage");
  }
});
