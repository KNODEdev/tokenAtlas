import { ProbeAccountIndexUnavailable } from "./current/probe-account-unavailable";
import type { Database } from "bun:sqlite";
import type { StoredModelCapacityWindow, StoredModelUsageShareWindow, WindowSumsPart, WindowSums, WindowInterval } from "./window-usage-contracts";
import { contextReadScope } from "../db/codex-context-read-scope";
import type { ModelCapacityWindow } from "../shared/model-capacity";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { tableExists } from "./window-usage-meta";

/* ------------------------------------------------------------------------------------------ */
/* Read API                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** A window has no stored sums yet. Screens answer "preparing". */
export class WindowUsagePreparing extends ProbeAccountIndexUnavailable {
  constructor() { super(); this.message = "Window sums are preparing"; }
}

/** Prepared model samples and their dated window metadata; pending work retains the last publication. */
export function readModelCapacityWindows(db: Database, provider: string, account: string, counter: string,
  from: string, until: string): StoredModelCapacityWindow[] {
  const rows = db.query(`SELECT w.window_id,w.start_ts,w.end_ts,w.reset_ts,w.cycle_end_basis,w.plan,w.plan_mismatch,w.manual,
    json_extract(u.cycle,'$.model_capacity') samples,
    EXISTS(SELECT 1 FROM window_usage_pending p WHERE p.provider=w.provider AND p.account=w.account AND p.counter=w.counter AND p.window_id=w.window_id) pending
    FROM limit_windows w LEFT JOIN window_usage u
    ON u.provider=w.provider AND u.account=w.account AND u.counter=w.counter AND u.window_id=w.window_id
    WHERE w.provider=? AND w.account=? AND w.counter=? AND w.start_ts<? AND w.end_ts>? ORDER BY w.seq`)
    .all(provider, account, counter, until, from) as StoredModelCapacityWindow[];
  const read = provider === "codex" ? contextReadScope(db)?.modelWindow : undefined;
  if (!read) return rows;
  return rows.map(row => {
    const context = read(account,counter,row.window_id,!!row.pending || row.samples===null);
    if (!context || !row.samples) return row;
    const prepared = JSON.parse(row.samples) as ModelCapacityWindow;
    return { ...row, samples: JSON.stringify({ ...prepared, samples: prepared.samples.map((sample,index) =>
      ({ ...sample, api_usd: sample.api_usd + (context.sample_extra[index] ?? 0) })) }) };
  });
}

/** Stored per-model traffic and hourly slices with the window's meter by hour; pending work retains the last publication. */
export function readModelUsageShareWindows(db: Database, provider: string, account: string, counter: string,
  from: string, until: string): StoredModelUsageShareWindow[] {
  const rows = db.query(`SELECT w.window_id,w.start_ts,w.end_ts,w.plan,w.plan_mismatch,
    (SELECT json_group_array(json_array(h,p)) FROM (SELECT substr(json_extract(r.value,'$.ts'),1,13) h,
      max(json_extract(r.value,'$.percent')) p FROM json_each(w.readings) r GROUP BY h ORDER BY h)) meter,
    json_extract(u.rail,'$.by_model') by_model, u.slices, u.window_id IS NOT NULL stored,
    EXISTS(SELECT 1 FROM window_usage_pending p WHERE p.provider=w.provider AND p.account=w.account AND p.counter=w.counter AND p.window_id=w.window_id) pending
    FROM limit_windows w LEFT JOIN window_usage u
    ON u.provider=w.provider AND u.account=w.account AND u.counter=w.counter AND u.window_id=w.window_id
    WHERE w.provider=? AND w.account=? AND w.counter=? AND w.start_ts<? AND w.end_ts>? ORDER BY w.seq`)
    .all(provider, account, counter, until, from) as StoredModelUsageShareWindow[];
  const read = provider === "codex" ? contextReadScope(db)?.modelWindow : undefined;
  if (!read) return rows;
  return rows.map(row => {
    const context=read(account,counter,row.window_id,!!row.pending || !row.stored);
    if(!context)return row;
    const extras=new Map(context.model_extra);
    const models=JSON.parse(row.by_model??"[]") as import("./window-usage-contracts").WindowModelTraffic[];
    return {...row,by_model:JSON.stringify(models.map(model=>model.excluded===null
      ? {...model,api_standard:model.api_standard+(extras.get(model.model)??0)} : model)),context_hour_extra:context.hour_extra};
  });
}

/**
 * The stored sums of the given windows of one account and counter, by window id. Never computes:
 * a window without a row raises WindowUsagePreparing.
 */
export function readWindowSums<Part extends WindowSumsPart>(db: Database, provider: string, account: string, counter: string,
  windows: readonly Pick<ProbeLimitWindow, "id">[], parts: readonly Part[]): Map<string, Pick<WindowSums, Part>> {
  const out = new Map<string, Pick<WindowSums, Part>>();
  if (!windows.length) return out;
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_usage'").get()) throw new WindowUsagePreparing();
  const rows = db.query(`SELECT window_id,${parts.join(",")} FROM window_usage WHERE provider=? AND account=? AND counter=?
    AND window_id IN (SELECT value FROM json_each(?))`)
    .all(provider.toLowerCase(), account.toLowerCase(), counter, JSON.stringify(windows.map(window => window.id))) as Array<Record<string, string>>;
  const byId = new Map(rows.map(row => [row.window_id!, row]));
  for (const window of windows) {
    const row = byId.get(window.id);
    if (!row) throw new WindowUsagePreparing();
    out.set(window.id, Object.fromEntries(parts.map(part => [part, JSON.parse(row[part]!)])) as Pick<WindowSums, Part>);
  }
  return out;
}

/** The published intervals, optionally of one provider and account. A database without them has none. */
export function readWindowIntervals(db: Database, provider?: string, account?: string): WindowInterval[] {
  if (!tableExists(db, "window_usage_intervals")) return [];
  const where = ["1=1"], params: string[] = [];
  if (provider) { where.push("provider=?"); params.push(provider.toLowerCase()); }
  if (account) { where.push("account=?"); params.push(account.toLowerCase()); }
  return (db.query(`SELECT * FROM window_usage_intervals WHERE ${where.join(" AND ")} ORDER BY provider,account,counter,window_id`)
    .all(...params) as Array<Record<string, string>>).map(row => ({ provider: row.provider!, account: row.account!, counter: row.counter!,
    id: row.window_id!, kind: row.kind, start: row.start_ts!, end: row.end_ts!, ...JSON.parse(row.spec!) }) as WindowInterval);
}

/* ------------------------------------------------------------------------------------------ */
/* Reading stored spans                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * The stored sums of spans of one account by id, whatever their counter: rail windows and intervals.
 * Never computes: a span without a row raises WindowUsagePreparing.
 */
export function readSpanSums<Part extends WindowSumsPart>(db: Database, provider: string, account: string,
  ids: readonly string[], parts: readonly Part[]): Map<string, Pick<WindowSums, Part>> {
  const out = new Map<string, Pick<WindowSums, Part>>();
  if (!ids.length) return out;
  if (!tableExists(db, "window_usage")) throw new WindowUsagePreparing();
  const rows = db.query(`SELECT window_id,${parts.join(",")} FROM window_usage WHERE provider=? AND account=?
    AND window_id IN (SELECT value FROM json_each(?))`).all(provider.toLowerCase(), account.toLowerCase(), JSON.stringify([...new Set(ids)])) as
    Array<Record<string, string>>;
  const byId = new Map(rows.map(row => [row.window_id!, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw new WindowUsagePreparing();
    out.set(id, Object.fromEntries(parts.map(part => [part, JSON.parse(row[part]!)])) as Pick<WindowSums, Part>);
  }
  return out;
}
