import path from "node:path";
import { Database } from "bun:sqlite";
import { activeDatabasePath } from "../../src/db";
import { readAccountsV2 } from "../../src/config/accounts-document";
import { configFile, MACHINE } from "../../src/config/paths";
import { resolveLocalStateRootBase } from "../../src/config/archive-locator";
import { scanCodexProfiles, discoveredCodexId } from "../../src/providers/codex-identity";
import { scanVendorProfiles, discoveredVendorId } from "../../src/providers/vendor-identity";
import { resolveCodexDiscovery, rememberedCodexAccounts } from "../../src/server/codex-discovery";
import { resolveVendorDiscovery, rememberedVendorAccounts } from "../../src/server/vendor-discovery";
import { loadCycles, type CyclesConfig } from "../../src/server/cycles";
import type { CanonicalProbe } from "../../src/db/probe-facts";
import { probeLimitCounter, RESET_JOIN_MS, type ProbeLimitSample } from "../../src/server/probe-limit-windows";
import { runUsageMonitor } from "../usage-monitor";
import { mainAppStatus, openMonitorOutbox, readMonitorCurrent } from "../lib/usage-monitor";

export interface MonitorSelection {id:string;provider:"codex"|"claude";key:string;subject:string}
export function monitorTip(fact: CanonicalProbe, selected: readonly MonitorSelection[], cycles: CyclesConfig) {
  const p=fact.payload;
  if(p.provider!=="codex"&&p.provider!=="claude") return null;
  const extra=JSON.parse(typeof p.extra==="string"?p.extra:"{}");
  const identity=JSON.parse(extra[p.provider==="codex"?"codex_account":"vendor_account"]??"null");
  const account=selected.find(s=>s.provider===p.provider && s.subject===p.subject && s.key===identity?.key);
  if(!account || typeof p.used_percent!=="number" || !Number.isFinite(p.used_percent)
    || p.used_percent<0 || p.used_percent>100 || typeof p.resets_at!=="string"
    || !Number.isFinite(Date.parse(p.resets_at)) || !Number.isFinite(Date.parse(String(p.ts)))) return null;
  let counter: string;
  if(p.provider==="codex") {
    if(p.limit_group!=="codex" || typeof p.window_minutes!=="number" || !Number.isInteger(p.window_minutes) || p.window_minutes<=0) return null;
    counter=JSON.stringify(["codex","codex",p.window_minutes]);
  } else counter=probeLimitCounter({...p,id:0} as unknown as ProbeLimitSample,account.id.slice("claude:".length),cycles);
  const [kind,group,minutes]=JSON.parse(counter) as [string,string,number];
  return {account:account.id,at:Date.parse(String(p.ts)),observation_id:fact.observation_id,counter_id:fact.counter_id,
    meter:{kind,group,minutes:minutes>0?minutes:null,scope:kind.includes("scoped")?"model":null,
      percent:p.used_percent,resets_at:Date.parse(p.resets_at)},facts:{plan:p.plan},reset_tolerance_ms:RESET_JOIN_MS};
}

// Wait for the parent's request before spawning anything: Windows attaches this process to its job first.
async function main() {
const request: unknown = await Bun.stdin.json();
if (!request || typeof request!=="object") throw new Error("Invalid monitor request");
const input=request as {version?:number;accounts?:unknown;interval_minutes?:number;force?:boolean};
if(input.version!==1 || !Array.isArray(input.accounts) || input.accounts.length>8
  || !input.accounts.every(id=>typeof id==="string"&&id.length<256)
  || !Number.isInteger(input.interval_minutes) || input.interval_minutes!<5 || input.interval_minutes!>120) throw new Error("Invalid monitor request");
const wanted=new Set(input.accounts as string[]);
const declarations=readAccountsV2(configFile("accounts.json")).subscriptions;
const db=new Database(activeDatabasePath(),{readonly:true});
const selected: MonitorSelection[] = [];
try {
  const codex=resolveCodexDiscovery(scanCodexProfiles(),declarations,rememberedCodexAccounts(db),MACHINE);
  const vendors=resolveVendorDiscovery(scanVendorProfiles({vendor:"claude",machine:MACHINE}),declarations,rememberedVendorAccounts(db,declarations),MACHINE);
  for(const account of codex.accounts) if(wanted.has(`codex:${account.id.toLowerCase()}`) && account.profiles[0]) selected.push({id:`codex:${account.id.toLowerCase()}`,provider:"codex",key:account.key,subject:discoveredCodexId(account.profiles[0])});
  for(const account of vendors.accounts) if(wanted.has(`claude:${account.id.toLowerCase()}`)) selected.push({id:`claude:${account.id.toLowerCase()}`,provider:"claude",key:account.key,subject:discoveredVendorId({vendor:"claude",key:account.key})});
} finally {db.close();}
const report=await runUsageMonitor({identityKeys:selected.map(s=>`${s.provider}:${s.key}`),intervalMinutes:input.interval_minutes,force:input.force});
const status=await mainAppStatus();
const transport=openMonitorOutbox(path.join(resolveLocalStateRootBase(),"usage-monitor","outbox.sqlite"));
const tips: unknown[]=[];
const cycles=loadCycles();
try {
  for(const facts of readMonitorCurrent(transport,selected.map(s=>`${s.provider}:${s.subject}`))) for(const fact of facts) {
    const tip=monitorTip(fact,selected,cycles);
    if(tip) tips.push(tip);
  }
}finally{transport.close();}
const attempts=Array.isArray(report.accounts)?report.accounts as Array<{provider:string;identity_key?:string;error:string|null}>:[];
const errors=[...selected.flatMap(s=>{
  const attempt=attempts.find(a=>a.provider===s.provider&&a.identity_key===s.key&&a.error);
  if(attempt) return [{account:s.id,error:attempt.error}];
  return !status.running && !(Array.isArray(report.observed_keys)&&report.observed_keys.includes(`${s.provider}:${s.key}`))
    ? [{account:s.id,error:"Brak zalogowanego profilu tego abonamentu"}] : [];
}),...([...wanted].filter(id=>!status.running&&!selected.some(s=>s.id===id))).map(account=>({account,error:"Brak zweryfikowanego profilu tego abonamentu"}))];
console.log(JSON.stringify({version:1,main_pid:status.running?status.pid:null,handoff:status.running,tips,errors,
  error:typeof report.error==="string"?report.error:Array.isArray(report.errors)&&report.errors.length?report.errors.join("; "):null,pending:report.pending??0}));
}
if(import.meta.main) await main();
