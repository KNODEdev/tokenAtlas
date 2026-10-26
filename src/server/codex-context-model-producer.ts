import { createHash } from "node:crypto";
import type { Database } from "../db/sqlite";
import { advanceContextBucketParts, contextDetailsState, consumeContextWindowRanges, contextWindowRangesPending } from "../db/codex-context-details";
import { codexContextPending, contextAmount, readCodexContextState } from "../db/codex-context-producer";
import { limitWindowFromRow, type LimitWindowRow } from "../db/limit-windows";
import { add, rational, type Rational } from "../db/price-ledger-exact";
import { codexLedgerReadContext, ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { readCodexEventRange, resolveCodexLedgerEventOwner, getPublishedCodexLedgerGroup } from "./codex-priced-events";
import { prepareCodexPricing, resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { loadAccountResolver, type IdentityDeclaration } from "./account-resolver";
import { codexWindowAdapter } from "./codex-window-comparison";
import { populateMeterWindows, registerWindowShell, emptyWindowUsage } from "./subscription-window-comparison";
import type { ModelCapacityWindow } from "../shared/model-capacity";
import type { RateCard } from "./pricing";

export interface ContextModelWindow {
  version: 1; missing: number; sample_extra: number[];
  model_extra: Array<[string | null, number]>;
  hour_extra: Array<[string | null, string, number]>;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type SourceWindow = LimitWindowRow & { cycle: string; rail: string; slices: string; usage_readings: string };
const source = (db: Database, account: string, counter: string, id: string) => db.query(`SELECT w.*,u.cycle,u.rail,u.slices,u.readings usage_readings
  FROM limit_windows w JOIN window_usage u ON u.provider=w.provider AND u.account=w.account AND u.counter=w.counter AND u.window_id=w.window_id
  WHERE w.provider='codex' AND w.account=? AND w.counter=? AND w.window_id=?`).get(account, counter, id) as SourceWindow | null;
const inputs = (row: SourceWindow) => hash([row.start_ts,row.end_ts,row.reset_ts,row.readings,row.manual,row.seq,row.cycle,row.rail,row.slices,row.usage_readings]);

/** Sparse eligible/unknown context requests only. Reuses membership; never computes or publishes window sums. */
export function computeContextModelWindow(db: Database, rates: RateCard, row: SourceWindow, subscriptions: readonly IdentityDeclaration[] = []): ContextModelWindow {
  const window = limitWindowFromRow(row), shell = registerWindowShell(window, window.window_minutes);
  const earlier = (db.query(`SELECT * FROM limit_windows WHERE provider='codex' AND account=? AND counter=? AND seq<?
    AND start_ts<? AND end_ts>? ORDER BY seq`).all(row.account,row.counter,row.seq,row.end_ts,row.start_ts) as LimitWindowRow[])
    .map(other => { const w = limitWindowFromRow(other); return registerWindowShell(w,w.window_minutes); });
  const manual=row.window_id.startsWith("manual:"),from=Date.parse(row.start_ts)+(manual?1:0),until=Date.parse(row.end_ts)+(manual?1:0);
  const saved = db.query(`SELECT p.*,e.instant_ms FROM codex_price_ledger_events e INDEXED BY codex_price_ledger_events_time
    CROSS JOIN codex_context_events p ON p.event_id=e.id WHERE e.instant_ms>=? AND e.instant_ms<?
    AND (p.reason IS NOT NULL OR p.included=0 AND p.long_tokens<>'0' AND p.extra_n<>'0')`)
    .all(from,until) as Array<import("../db/codex-context-producer").ContextEvent>;
  const result: ContextModelWindow = { version: 1, missing: 0, sample_extra: [], model_extra: [], hour_extra: [] };
  const samples = (JSON.parse(row.cycle).model_capacity as ModelCapacityWindow | undefined)?.samples ?? [];
  const sampleSums = samples.map(() => rational(0n)), models = new Map<string | null,Rational>(), hours = new Map<string,Rational>();
  result.sample_extra = samples.map(() => 0);
  if (!saved.length) return result;
  const values = new Map(saved.map(value => [value.event_id, value]));
  const resolver = loadAccountResolver(db, subscriptions), config = prepareCodexPricing(resolveCodexAccountingConfig(rates));
  const events = readCodexEventRange(db,config,new Date(from).toISOString(),new Date(until).toISOString(),event => resolveCodexLedgerEventOwner(resolver,event),codexLedgerReadContext(rates),
    { canonical:true,eventIds:saved.map(value=>value.event_id) }).filter(event=>event.account?.toLowerCase()===row.account.toLowerCase());
  const adapter = codexWindowAdapter(config, window.window_minutes);
  const accumulate = <K>(map: Map<K,Rational>, key: K, value: Rational) => map.set(key,add(map.get(key)??rational(0n),value));
  const delta = (event: typeof events[number]) => {
    const value = values.get(Number(event.id));
    if (!value || value.reason) { result.missing++; return null; }
    return value.included ? rational(0n) : contextAmount(value,"extra");
  };
  // Only membership runs here; zero-valued temporary shells cannot re-sum accepted money or context rates.
  populateMeterWindows([...earlier,shell],events,{ ...adapter,detail:undefined,usage:()=>emptyWindowUsage() },{
    excluded() {},
    counted(target,event) {
      if (target!==shell) return;
      const group = getPublishedCodexLedgerGroup(event)!;
      if (group.variants.api_standard.value===null) return;
      const extra = delta(event); if (extra===null) return;
      accumulate(models,event.model,extra);
      const hour = new Date(Math.floor(Date.parse(event.ts)/3600000)*3600000).toISOString();
      accumulate(hours,JSON.stringify([event.model,hour]),extra);
      if (group.variants.window_api.value===null) return;
      samples.forEach((sample,index)=>{
        if (sample.model===event.model && Date.parse(event.ts)>Date.parse(sample.from) && Date.parse(event.ts)<=Date.parse(sample.through))
          sampleSums[index]=add(sampleSums[index]!,extra);
      });
    },
  });
  result.sample_extra=sampleSums.map(ledgerPresentationNumber);
  result.model_extra=[...models].map(([model,value])=>[model,ledgerPresentationNumber(value)]);
  result.hour_extra=[...hours].map(([key,value])=>[...JSON.parse(key),ledgerPresentationNumber(value)] as [string|null,string,number]);
  return result;
}
/** Independent durable queues/checkpoint. Existing ledger/window producers and rows are never invoked or changed. */
export function advanceCodexContextDetails(db: Database, rates: RateCard, options: { canWrite?():boolean; limit?:number; subscriptions?:readonly IdentityDeclaration[] } = {}) {
  if(options.canWrite?.()!==false)consumeContextWindowRanges(db);
  const parts=advanceContextBucketParts(db,{canWrite:options.canWrite});
  let windows=0,writes=parts.writes;
  if (!contextDetailsState(db)) return { ...parts,windows,writes,pending:false };
  const state=readCodexContextState(db);
  if (!state || codexContextPending(db,state) || parts.pending || options.canWrite?.()===false)
    return { ...parts,windows,writes,pending:true };
  const queue=db.query(`SELECT p.account,p.counter,p.window_id FROM codex_context_model_pending p
    WHERE NOT EXISTS(SELECT 1 FROM window_usage_pending u WHERE u.provider='codex' AND u.account=p.account AND u.counter=p.counter AND u.window_id=p.window_id)
    ORDER BY p.account,p.counter,p.window_id LIMIT ?`)
    .all(options.limit??1) as Array<{account:string;counter:string;window_id:string}>;
  for(const key of queue) {
    if(options.canWrite?.()===false)break;
    const args=[key.account,key.counter,key.window_id] as const;
    if(db.query("SELECT 1 FROM window_usage_pending WHERE provider='codex' AND account=? AND counter=? AND window_id=?").get(...args))continue;
    const fence = () => hash([source(db,...args),
      db.query("SELECT * FROM limit_windows WHERE provider='codex' AND account=? AND counter=? ORDER BY seq").all(key.account,key.counter),
      db.query("SELECT source,from_ts,until_ts,account,origin FROM account_periods WHERE provider='codex' ORDER BY id").all()]);
    const before=fence(),row=source(db,...args), stamp=row?inputs(row):null;
    const data=row?JSON.stringify(computeContextModelWindow(db,rates,row,options.subscriptions)):null;
    if(options.canWrite?.()===false || readCodexContextState(db)?.revision!==state.revision || (source(db,...args) ? inputs(source(db,...args)!) : null)!==stamp)break;
    const published = db.transaction(()=>{
      if (codexContextPending(db) || readCodexContextState(db)?.revision!==state.revision || fence()!==before) return false;
      const old=db.query("SELECT inputs,data FROM codex_context_model_windows WHERE account=? AND counter=? AND window_id=?").get(...args) as {inputs:string;data:string}|null;
      if(data===null) { if(old){db.query("DELETE FROM codex_context_model_windows WHERE account=? AND counter=? AND window_id=?").run(...args);writes++;} }
      else if(!old || old.inputs!==stamp || old.data!==data) {db.query("INSERT OR REPLACE INTO codex_context_model_windows VALUES(?,?,?,?,?)").run(...args,stamp!,data);writes++;}
      db.query("DELETE FROM codex_context_model_pending WHERE account=? AND counter=? AND window_id=?").run(...args);
      db.query("UPDATE codex_context_detail_state SET revision=revision+1 WHERE singleton=1").run();
      return true;
    }).immediate();
    if (!published) break;
    windows++;
  }
  return {...parts,windows,writes,pending:contextWindowRangesPending(db)||!!db.query("SELECT 1 FROM codex_context_model_pending LIMIT 1").get()};
}
