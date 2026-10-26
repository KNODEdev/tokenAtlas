import { contextPreviewFixture } from "./codex-context-preview.fixture";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import { windowEventReader } from "./window-usage-events";
import { windowSumsFromLedgers } from "./window-usage-ledger-sums";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { advanceCodexContextDetails } from "./codex-context-model-producer";
import type { RateCard } from "./pricing";

export function contextDetailsFixture(included=false, configure?: (rates:RateCard)=>void) {
  const f=contextPreviewFixture(included,rates=>{
    const rules=rates.codex_ledger_policy!.base_rules;
    for(const model of ["gpt-reserve","gpt-5.3-codex-spark"])
      for(const rule of [...rules].filter(rule=>rule.model==="m"))rules.push({...structuredClone(rule),model,id:model+rule.billing_basis});
    configure?.(rates);
  },db=>{
    db.exec("ALTER TABLE events ADD COLUMN billing_mode TEXT; ALTER TABLE events ADD COLUMN meter_reset INTEGER;");
    db.exec("UPDATE events SET service_tier='default' WHERE id IN (3,4)");
    const home=(db.query("SELECT home FROM events LIMIT 1").get() as {home:string}).home;
    for(const [id,model,billing] of [[8,"m","credits"],[9,"gpt-reserve","credits"],[10,"gpt-reserve",null],[11,"gpt-5.3-codex-spark","credits"],[12,"m","business_credits"]] as const)
      db.query(`INSERT INTO events(id,home,path,source_offset,ts,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,service_tier,
        usage_status,cache_write_status,project_id,project,repo,surface,billing_mode) VALUES(?,?,?,?,'2026-09-01T13:45:00.000Z',?,1000000,0,0,0,0,'default','valid','reported','a','a','repo-a','cli',?)`)
        .run(id,home,'session',id*100,model,billing);
  });
  f.fill();
  const window:ProbeLimitWindow={id:"context-window",account:"owner",counter:'["codex","codex",10080]',start:"2026-09-01T11:59:00.000Z",end:"2026-09-08T00:00:00.000Z",
    reset:"2026-09-08T00:00:00.000Z",cycle_end_basis:"scheduled",window_minutes:10080,plan:"plus",plan_detail:null,declared_plan_meter_mismatch:false,
    startDrop:null,endDrop:null,readings:[["11:59",0],["12:00",20],["12:30",40],["13:00",60],["13:30",80],["14:00",80],["15:00",100]]
      .map(([time,percent])=>({ts:`2026-09-01T${time}:00.000Z`,percent:Number(percent),source:"probe" as const}))};
  const {db,ctx}=f;
  db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_mismatch,
    readings,seen_reset,last_input) VALUES('codex',?,?,0,?,?,?,?,?,10080,'plus',0,?,1,'{}')`)
    .run(window.account,window.counter,window.id,window.start,window.end,window.reset,window.cycle_end_basis,JSON.stringify(window.readings));
  db.query("INSERT INTO limit_window_state(provider,account,scope,version,status) VALUES('codex','owner',?,1,'ready')").run(window.counter);
  const sums=windowSumsFromLedgers(windowEventReader(db,f.rates,ctx.resolver!),f.rates,"codex",window,[]).sums;
  db.query("INSERT INTO window_usage(provider,account,counter,window_id,start_ts,end_ts,cycle,rail,readings,slices) VALUES('codex',?,?,?,?,?,?,?,?,?)")
    .run(window.account,window.counter,window.id,window.start,window.end,JSON.stringify(sums.cycle),JSON.stringify(sums.rail),JSON.stringify(sums.readings),JSON.stringify(sums.slices));
  prepareProbeReaderFixture(db,[],undefined,false);
  const fillDetails=(limit=1)=>{
    for(let turn=0;turn<1000;turn++)if(!advanceCodexContextDetails(db,f.rates,{limit,subscriptions:ctx.accounts.subscriptions}).pending)return;
    throw new Error("Context details fixture did not finish");
  };
  return {...f,window,sums,fillDetails};
}
