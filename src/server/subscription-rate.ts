import {withFinalContext} from "./codex-context-final-read";
import { CLAUDE_CAPACITY_RESULT_VERSION } from "../shared/claude-capacity-result";
import { CLAUDE_CODE_CAPACITY_ALGORITHM } from "../shared/claude-code-capacity";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { hasSubscriptionCapacity, readCapacityWindows } from "../db/subscription-capacity";
import { limitWindowFromRow, type LimitWindowRow } from "../db/limit-windows";
import { registerWindowShell } from "./subscription-window-comparison";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import { buildEraIndex } from "./eras";
import { periodEras, subscriptionMaps } from "./subscription-maps";
import { buildSubscriptionCapacities, type SubscriptionCapacity } from "./capacity-equivalents";
import { matchPlanAlias, resolvePlanVersion, type PlansCatalog } from "./plans-catalog";
import { subscriptionRate, type RateWindow, type SubscriptionRateResponse } from "../shared/subscription-rate";
import { PROVIDER_RESETS } from "../shared/provider-resets";
import { CODEX_PROMOTIONS } from "../shared/codex-promotions";
import { currentVendor, type CurrentConfig } from "./current/registry";
import { periodInstant, effectivePlanPeriods } from "./account-periods";
import type { RateCard } from "./pricing";
import type { WindowCycleSums, WindowRailSums } from "./window-usage-contracts";
import { parseCounter } from "./main-counter";
import { readPreparedProbeAccountingRevisions } from "./current/probe-account-reader";
import {hasSubscriptionHours} from '../db/subscription-hours';
import { referenceFingerprint } from "./window-usage-reference";

const RULE = "subscription-capacity-6";
const iso = (ms: number) => new Date(ms).toISOString();
const day = (at: string) => at.slice(0, 10);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface RateProducerOptions {
  rates: RateCard; catalog: PlansCatalog; config: CurrentConfig;
  providers?:readonly string[];
  now?: number; limit?: number; canWrite?: () => boolean;
  /** Same provider algorithms; injected only by fixture tests. */
  calculate?: (window: LimitWindowRow, from: string) => SubscriptionCapacity | null;
}
interface Input extends LimitWindowRow { cycle: string | null; rail: string | null; reference: string | null; point_pp: number | null }
/** Conservative cohort boundary from dated plan evidence and the catalog, never an inferred entitlement. */
export function rateRuleStart(db: Database, w: LimitWindowRow, catalog: PlansCatalog,
  prepared?: { first: string | null; periods: ReturnType<typeof loadPeriods> }): { from: string; plan_id: string | null; version: string | null; price: number | null } {
  const match = w.plan ? matchPlanAlias(catalog, w.provider, w.plan) : null;
  const version = match?.kind === "ok" ? resolvePlanVersion(catalog, w.provider, match.plan_id, day(w.start_ts)) : null;
  const candidates = [w.start_ts];
  // The beginning of the recorded same-plan cohort, bounded by dated plan periods.
  const first = prepared ? { start: prepared.first } : db.query("SELECT MIN(start_ts) start FROM limit_windows WHERE provider=? AND account=? AND plan IS ?")
    .get(w.provider, w.account, w.plan) as { start: string | null };
  candidates[0] = first.start ?? w.start_ts;
  if (version?.kind === "ok" && version.version_from) candidates.push(version.version_from);
  if (match?.kind === "ok") for (const v of match.plan.versions) {
    if (v.from && Date.parse(v.from) < Date.parse(w.end_ts) && Date.parse(v.from) >= Date.parse(candidates[0]!)) candidates.push(v.from);
  }
  const periods=effectivePlanPeriods(prepared?.periods ?? loadPeriods(db,PLAN_PERIODS)).filter(p=>p.provider===w.provider && p.subject===w.account)
    .sort((a,b)=>periodInstant(a.from,"from")-periodInstant(b.from,"from"));
  // A first observed plan dates the evidence, not an invented mid-window plan change.
  for (let i=1;i<periods.length;i++) {
    const p=periods[i]!;
    if (p.value===periods[i-1]!.value) continue;
    const at = periodInstant(p.from, "from");
    if (at < Date.parse(w.end_ts) && at >= Date.parse(candidates[0]!)) candidates.push(iso(at));
  }
  for (const reset of PROVIDER_RESETS) {
    if (reset.provider === w.provider && Date.parse(reset.at) < Date.parse(w.end_ts)
      && Date.parse(reset.at) >= Date.parse(candidates[0]!)) candidates.push(reset.at);
  }
  const from = candidates.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)!;
  return { from, plan_id: match?.kind === "ok" ? match.plan_id : null,
    version: version?.kind === "ok" ? version.version_id : null,
    price: version?.kind === "ok" ? version.version.usd_per_month : null };
}
function state(db: Database, key: string): string | null {
  return (db.query("SELECT value FROM subscription_capacity_state WHERE key=?").get(key) as { value: string } | null)?.value ?? null;
}
const putState = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO subscription_capacity_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").run(key, value);
function discoveryStamp(db:Database,options:RateProducerOptions,now:number):string {
  const rows=db.query("SELECT w.provider,w.account,w.counter,w.window_id,w.start_ts,w.end_ts,w.plan,w.readings,p.inputs_rev FROM limit_windows w LEFT JOIN window_point_values p ON p.provider=w.provider AND p.account=w.account AND p.counter=w.counter AND p.window_start=w.start_ts WHERE (w.provider IN ('claude','codex') AND w.window_minutes=10080) OR (w.provider='codex' AND w.window_minutes=300) ORDER BY w.provider,w.account,w.counter,w.seq").all() as Array<{end_ts:string}>;
  const probes=db.query("SELECT provider,COUNT(*) n,COALESCE(SUM(revision),0) revision FROM probe_sources WHERE provider IN ('claude','codex') GROUP BY provider").all();
  const stored=db.query('SELECT COUNT(*) n FROM subscription_capacity_windows').get();
  return hash([RULE,CLAUDE_CAPACITY_RESULT_VERSION,CLAUDE_CODE_CAPACITY_ALGORITHM,options.rates.vendors?.anthropic,options.rates.vendors?.openai,options.rates.codex_accounting,options.catalog,options.config,
    rows,rows.map(w=>Date.parse(w.end_ts)<=now),probes,loadPeriods(db,PLAN_PERIODS),stored]);
}
/** Stored summary rows only. Background preparation never runs in the route below. */
function inputs(db: Database): Input[] {
  return db.query("SELECT w.*,u.cycle,u.rail,u.reference,p.pp point_pp FROM limit_windows w LEFT JOIN window_usage u ON u.provider=w.provider AND u.account=w.account AND u.counter=w.counter AND u.window_id=w.window_id LEFT JOIN window_point_values p ON p.provider=w.provider AND p.account=w.account AND p.counter=w.counter AND p.window_start=w.start_ts WHERE (w.provider IN ('claude','codex') AND w.window_minutes=10080) OR (w.provider='codex' AND w.window_minutes=300) ORDER BY w.end_ts,w.start_ts")
    .all() as Input[];
}

/** Model samples extend the register; they do not change the capacity calibration's inputs. */
function capacityCycle(value: string | null): string | null {
  if (value === null) return null;
  const { model_capacity: _samples, ...cycle } = JSON.parse(value) as WindowCycleSums;
  return JSON.stringify(cycle);
}
function toFact(w: Input, boundary: ReturnType<typeof rateRuleStart>, capacity: SubscriptionCapacity | null, cohort: readonly Input[], now: number): RateWindow {
  const cycle = w.cycle ? JSON.parse(w.cycle) as WindowCycleSums : null;
  const rail = w.rail ? JSON.parse(w.rail) as WindowRailSums : null;
  const ref = w.reference ? JSON.parse(w.reference) as { day: string; cycle: WindowCycleSums } : null;
  const wholeUsage=cycle?.cycle_usage??cycle?.usage;
  const pp = w.point_pp;
  const value = capacity?.weekly_window_value_usd ?? null;
  const closed = Date.parse(w.end_ts) <= now;
  const reason = !closed ? "open_window" : Date.parse(boundary.from) > Date.parse(w.start_ts) ? "rule_change_inside_window"
    : pp === null ? "no_percent" : pp < 20 ? "below_20pp" : !cycle ? "sums_preparing"
    : cycle.usage.unpriced_events > 0 ? "standard_valuation_missing"
    : value === null ? capacity?.capacity_reason ?? capacity?.note ?? "calibration_missing"
    : boundary.price === null || boundary.price <= 0 ? "plan_price_missing" : null;
  const eligible = cohort.filter(x => x.provider === w.provider && x.account === w.account && x.plan === w.plan
    && Date.parse(x.start_ts) >= Date.parse(boundary.from) && Date.parse(x.end_ts) <= Date.parse(w.end_ts)
    && Date.parse(x.end_ts) <= now && (x.point_pp ?? 0) >= 20);
  const models = rail?.by_model?.filter(model => model.excluded === null) ?? [];
  const calls = models.reduce((sum, model) => sum + model.calls, 0);
  const window = limitWindowFromRow(w);
  const comparison = ref && window.readings.length ? {...registerWindowShell(window,w.window_minutes),usage:ref.cycle.usage} : null;
  return { id: w.window_id, provider: w.provider as RateWindow["provider"], account: w.account,
    start: w.start_ts, end: w.end_ts, closed, plan: w.plan, plan_id: boundary.plan_id, plan_version: boundary.version,
    price_usd: boundary.price, price_date: day(w.start_ts), rule_from: boundary.from,
    cycles: eligible.length, preliminary: eligible.length < 3, capacity, value_100_usd: reason ? null : value,
    rate: reason ? null : subscriptionRate(value, boundary.price), absent: reason,
    used_pp: pp, api_usd: !wholeUsage || wholeUsage.unpriced_events ? null : wholeUsage.api_standard,
    fixed_api_usd: ref?.cycle.usage.reference_api_standard ?? null, fixed_date: ref?.day ?? null,
    common_historical_usd: ref?.cycle.usage.paired_historical_api ?? null,
    common_fixed_usd: ref?.cycle.usage.paired_reference_api ?? null,
    comparison,
    active_hours:null,hours_per_100:null,hours_absent:'hours_preparing',
    mix: models.map(model => ({ model: model.model ?? "unknown", share: calls ? model.calls / calls : 0 })),
    scope: capacity?.capacity_scope ?? null, computed_at: iso(now) };
}
/**
 * One bounded background publication. Persistent dirty ranges survive restarts/cache clearing;
 * they follow the actual writers through markWindowAnswersDirty. Cheap discovery reads stored
 * windows only. A correction can affect later calibrated windows within its dated cohort.
 */
export function advanceSubscriptionRates(db: Database, options: RateProducerOptions): { processed: number; pending: boolean } | null {
  if (!hasSubscriptionCapacity(db) || !db.query("SELECT 1 FROM sqlite_master WHERE name='window_point_values'").get()) return null;
  if (options.canWrite && !options.canWrite()) return { processed: 0, pending: true };
  const now = options.now ?? Date.now();
  // Idle discovery reads published register keys only, never a per-window probe range or the stored traffic bodies.
  const discovery=discoveryStamp(db,options,now);
  if(state(db,'inputs')===discovery&&!db.query('SELECT 1 FROM subscription_capacity_dirty LIMIT 1').get())return {processed:0,pending:false};
  const prepared = inputs(db).filter(w=>!options.providers||options.providers.includes(w.provider)).map(w => ({ ...w, cycle: capacityCycle(w.cycle) })), all=prepared.filter(w=>w.window_minutes===10080);
  const sources=options.config.sources.map(s=>{
    if (!s.vendor || !s.home) throw new Error("Capacity sources need an explicit vendor and archive home");
    return {...s,vendor:s.vendor,home:s.home,source_home:s.source_home ?? undefined};
  });
  const accounts = {version:2 as const,sources,subscriptions:options.config.subscriptions.map(s=>({...s,account:s.account ?? undefined}))};
  const homes = subscriptionMaps(db,accounts).homeToSubId;
  const eras = buildEraIndex(periodEras(db,accounts), "instant");
  const dirty = db.query("SELECT * FROM subscription_capacity_dirty").all() as Array<{ provider: string; account: string; from_ms: number; until_ms: number | null; sequence: number }>;
  const sumsDirty=db.query('SELECT provider,account,counter,from_ms,until_ms FROM window_usage_dirty').all() as Array<{provider:string;account:string;counter:string;from_ms:number;until_ms:number|null}>;
  const stored = db.query("SELECT provider,account,counter,window_id,signature,checked,scope_start,body FROM subscription_capacity_windows").all() as
    Array<{ provider: string; account: string; counter: string; window_id: string; signature: string; checked: number; scope_start: string; body: string }>;
  const idOf = (w: Pick<LimitWindowRow, "provider" | "account" | "counter" | "window_id">) => JSON.stringify([w.provider,w.account,w.counter,w.window_id]);
  const known = new Map(stored.map(w => [idOf(w), w]));
  const firstStarts = new Map((db.query("SELECT provider,account,plan,MIN(start_ts) first FROM limit_windows GROUP BY provider,account,plan").all() as
    Array<{provider:string;account:string;plan:string|null;first:string}>).map(w => [JSON.stringify([w.provider,w.account,w.plan]),w.first]));
  const periods = loadPeriods(db, PLAN_PERIODS);
  const boundaries = new Map(all.map(w => [idOf(w), rateRuleStart(db, w, options.catalog,
    {first:firstStarts.get(JSON.stringify([w.provider,w.account,w.plan])) ?? null,periods})]));
  const probeRevisions = new Map<string, ReturnType<typeof readPreparedProbeAccountingRevisions>[number]>();
  const loadedProbes = new Set<string>();
  const probeRevision = (w: Input) => {
    const owner = JSON.stringify([w.provider,w.account]);
    if (loadedProbes.has(owner)) return probeRevisions.get(idOf(w));
    const windows = all.filter(row => row.provider === w.provider && row.account === w.account);
    const revisions = readPreparedProbeAccountingRevisions(db, w.provider, w.account,
      windows.map(w => [boundaries.get(idOf(w))!.from, w.end_ts] as const));
    windows.forEach((w, index) => probeRevisions.set(idOf(w), revisions[index]!));
    loadedProbes.add(owner);
    return probeRevisions.get(idOf(w));
  };
  const pendingSums = new Set((db.query("SELECT provider,account,counter,window_id FROM window_usage_pending").all() as LimitWindowRow[]).map(idOf));
  let processed = 0, pending = false;
  for (const w of all) {
    if (w.provider === "claude" && parseCounter(w.counter, w.window_minutes).kind !== "weekly_all") continue;
    const boundary = boundaries.get(idOf(w))!;
    // Only this provider's configuration; an unrelated vendor change is not a dependency.
    const cohort = all.filter(x => x.provider === w.provider && x.account === w.account
      && Date.parse(x.end_ts) <= Date.parse(w.end_ts) && Date.parse(x.end_ts) > Date.parse(boundary.from));
    const calibrationInputs=[...cohort,...prepared.filter(x=>w.provider==='codex'&&x.provider==='codex'&&x.account===w.account&&x.window_minutes===300
      &&Date.parse(x.start_ts)<Date.parse(w.end_ts)&&Date.parse(x.end_ts)>Date.parse(boundary.from))];
    // Pending summaries retain their last publication. Do not inspect or hash their historical inputs again.
    if (calibrationInputs.some(x => pendingSums.has(idOf(x)) || sumsDirty.some(d =>
      (d.provider==='*'||d.provider===x.provider)&&(d.account==='*'||d.account===x.account)&&(d.counter==='*'||d.counter===x.counter)
      &&d.from_ms<Date.parse(x.end_ts)&&(d.until_ms===null||d.until_ms>Date.parse(x.start_ts))))) { pending = true; continue; }
    const models=[...new Set(calibrationInputs.flatMap(x=>x.rail?(JSON.parse(x.rail) as WindowRailSums).by_model?.flatMap(m=>m.model?[m.model]:[])??[]:[]))];
    const vendor=referenceFingerprint(options.rates,w.provider,day(w.end_ts),models);
    const signature = hash([RULE, ...(w.provider === "claude" ? [CLAUDE_CAPACITY_RESULT_VERSION, CLAUDE_CODE_CAPACITY_ALGORITHM] : []), boundary, vendor, w.provider === "codex" ? options.rates.codex_accounting : null,
      calibrationInputs.map(x => [x.counter,x.start_ts,x.end_ts,x.plan,x.cycle,x.readings,x.point_pp]),
      probeRevision(w),
      w.reference, Date.parse(w.end_ts) <= now]);
    const old = known.get(idOf(w));
    const checked = Math.max(0, ...dirty.filter(d => (d.provider === "*" || d.provider === w.provider) && (d.account === "*" || d.account === w.account)
      && d.from_ms < Date.parse(w.end_ts) && (d.until_ms === null || d.until_ms > Date.parse(boundary.from))).map(d => d.sequence));
    if (old?.signature === signature && old.checked >= checked) continue;
    if (processed >= (options.limit ?? 1) || options.canWrite && !options.canWrite()) { pending = true; break; }
    const until = day(iso(Date.parse(w.end_ts) - 1));
    let capacity: SubscriptionCapacity | null = null;
    if (Date.parse(boundary.from) <= Date.parse(w.start_ts)) {
      const rates = options.rates.subscriptions?.[w.account] ? options.rates : { ...options.rates,
        subscriptions:{...options.rates.subscriptions,[w.account]:{usd_per_month:boundary.price}} };
      capacity = options.calculate ? options.calculate(w, boundary.from) : buildSubscriptionCapacities(db, rates, homes, {
        period: { since: boundary.from, until }, eras, claudeAccounts: w.provider === "claude" ? [w.account] : [],
        subscriptions: [w.account], fromStored: false, calibrationRange:{from:boundary.from,until:w.end_ts}
      }).get(w.account) ?? null;
    }
    const fact = toFact(w, boundary, capacity, all, now);
    db.transaction(() => {
      db.query("INSERT INTO subscription_capacity_windows(provider,account,counter,window_id,start_ts,end_ts,scope_start,signature,checked,body,computed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,account,counter,window_id) DO UPDATE SET start_ts=excluded.start_ts,end_ts=excluded.end_ts,scope_start=excluded.scope_start,signature=excluded.signature,checked=excluded.checked,body=excluded.body,computed_at=excluded.computed_at")
        .run(w.provider,w.account,w.counter,w.window_id,w.start_ts,w.end_ts,boundary.from,signature,Math.max(old?.checked ?? 0,checked),JSON.stringify(fact),iso(now));
      putState(db, "revision", String(Number(state(db, "revision") ?? 0) + 1));
    }).immediate();
    processed++;
  }
  // Removed windows disappear together with their derived facts.
  const ids = new Set(all.map(idOf));
  db.transaction(() => {
    for (const subscription of options.config.subscriptions) {
      const vendor = currentVendor(subscription.vendor);
      if (vendor === "claude" || vendor === "codex") putState(db, "account:" + subscription.id.toLowerCase(), vendor);
    }
    for (const old of stored) if ((!options.providers||options.providers.includes(old.provider))&&!ids.has(idOf(old))) {
      db.query("DELETE FROM subscription_capacity_windows WHERE provider=? AND account=? AND counter=? AND window_id=?").run(old.provider,old.account,old.counter,old.window_id);
      putState(db, "revision", String(Number(state(db, "revision") ?? 0) + 1));
    }
    // An unfinished range remains durable. Completed signatures prevent expensive work on restart.
    putState(db,"ready",pending ? "0" : "1");
    if (!pending) {
      for (const d of dirty) db.query("DELETE FROM subscription_capacity_dirty WHERE provider=? AND account=? AND from_ms=? AND sequence=?").run(d.provider,d.account,d.from_ms,d.sequence);
      putState(db, "ready", "1");
      putState(db,'inputs',discoveryStamp(db,options,now));
    }
  }).immediate();
  return { processed, pending };
}
export function readSubscriptionRates(db: Database, account?: string, context=false): SubscriptionRateResponse {
 return withFinalContext(db,context,source=>readSubscriptionRatesBody(source,account),{account,source:"rate"});
}
function readSubscriptionRatesBody(db:Database,account?:string):SubscriptionRateResponse {
  const windows = readCapacityWindows(db, account);
  const has = hasSubscriptionCapacity(db);
  const hours=hasSubscriptionHours(db);
  const stale = has && !!db.query("SELECT 1 FROM subscription_capacity_dirty" + (account ? " WHERE account IN (?, '*')" : "") + " LIMIT 1").get(...(account ? [account.toLowerCase()] : []))
    || hours && !!db.query("SELECT 1 FROM subscription_hours_dirty"+(account?" WHERE account IN (?, '*')":"")+" LIMIT 1").get(...(account?[account.toLowerCase()]:[]));
  const hoursReady=hours && (db.query("SELECT value FROM subscription_hours_state WHERE key='ready'").get() as {value:string}|null)?.value==='1';
  return { windows, preparing: !has || state(db, "ready") !== "1", hours_preparing:!hoursReady,stale,
    annotations: [...PROVIDER_RESETS.map(r => ({ provider: r.provider, at: r.at, label: r.note ?? "Reset", source: r.source })),
      ...CODEX_PROMOTIONS.map(p => ({ provider: "codex", at: p.announced, label: p.title.pl, source: p.source }))] };
}
