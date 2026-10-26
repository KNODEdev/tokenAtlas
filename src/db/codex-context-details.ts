import type { Database, SQLQueryBindings } from "./sqlite";
import type { LedgerRange, LedgerStoredGroup } from "./codex-price-ledger";
import { readCodexContextState, codexContextPending, contextAmount } from "./codex-context-producer";
import { compileCodexLedgerPolicy } from "../server/codex-ledger-policy";
import { add, subtract, equal, nanoValuation, rational, type Rational } from "./price-ledger-exact";

export const CONTEXT_DETAILS_VERSION = 1;
export const CONTEXT_PART_KEYS = ["input", "cached", "cache_write", "output"] as const;
export type ContextBucketParts = Record<typeof CONTEXT_PART_KEYS[number], Rational>;
export const emptyContextParts = (): ContextBucketParts => ({ input: rational(0n), cached: rational(0n), cache_write: rational(0n), output: rational(0n) });
export const encodeContextParts = (parts: ContextBucketParts) => JSON.stringify(CONTEXT_PART_KEYS.map(key => [String(parts[key].n), String(parts[key].d)]));
export function decodeContextParts(json: string): ContextBucketParts {
  const values = JSON.parse(json) as [string, string][];
  return Object.fromEntries(CONTEXT_PART_KEYS.map((key, index) => [key, rational(BigInt(values[index]![0]), BigInt(values[index]![1]))])) as ContextBucketParts;
}
export function contextDetailsState(db: Database): { version: number; revision: number; pending: boolean } | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='codex_context_detail_state'").get()) return null;
  const state = db.query("SELECT version,revision FROM codex_context_detail_state WHERE singleton=1").get() as {version:number;revision:number};
  return { ...state, pending: state.version !== CONTEXT_DETAILS_VERSION || !!db.query("SELECT 1 FROM codex_context_detail_dirty LIMIT 1").get() };
}
const bucketKeys = ["in_uncached", "in_cache_read", "in_cache_write", "out_total"] as const;
/** New bucket measures only. The request's eligibility and total uplift are already saved by phase 1. */
export function advanceContextBucketParts(db: Database, options: { canWrite?(): boolean; limit?: number } = {}) {
  let partitions = 0, writes = 0;
  const state = readCodexContextState(db), details = contextDetailsState(db);
  if (!details) return { partitions, writes, pending: false };
  if (details.version !== CONTEXT_DETAILS_VERSION) return { partitions, writes, pending: true };
  if (!details.pending) return { partitions, writes, pending: false };
  if (!state || codexContextPending(db, state) || options.canWrite?.() === false)
    return { partitions, writes, pending: true };
  const published = (db.query("SELECT rules_json FROM usage_ledger_state WHERE provider='codex'").get() as {rules_json:string}).rules_json;
  const policy = compileCodexLedgerPolicy(JSON.parse(published));
  const scopes = db.query("SELECT day,dim_id FROM codex_context_detail_dirty ORDER BY day,dim_id LIMIT ?").all(options.limit ?? 1) as {day:string;dim_id:number}[];
  for (const scope of scopes) {
    if (!db.query("SELECT 1 FROM codex_context_detail_dirty WHERE day=? AND dim_id=?").get(scope.day,scope.dim_id)) continue;
    if (options.canWrite?.() === false) break;
    const params: SQLQueryBindings[] = [scope.day, ...(scope.dim_id < 0 ? [] : [scope.dim_id])];
    const dim = scope.dim_id < 0 ? "" : " AND p.dim_id=?";
    const rows = db.query(`SELECT p.*,e.instant_ms,e.uncached,e.cached,e.writes,e.output,d.model FROM codex_context_events p
      JOIN codex_price_ledger_events e ON e.id=p.event_id JOIN codex_price_ledger_dims d ON d.id=p.dim_id
      WHERE p.day=?${dim} AND p.reason IS NULL AND p.included=0 AND p.long_tokens<>'0'`).all(...params) as
      Array<import("./codex-context-producer").ContextEvent & { instant_ms:number;uncached:number;cached:number;writes:number;output:number;model:string|null }>;
    const desired = new Map<number, { row: typeof rows[number]; parts: string }>();
    for (const row of rows) {
      const rule = policy.resolveBaseRule(row.model, "api_equivalent_usd", row.day);
      if (!rule?.long_context) throw new Error("Saved long-context request has no matching published rule");
      const normal = policy.baseBands.find(band => band.id === rule.id && band.band === "normal")!;
      const long = policy.contextBands.find(band => band.id === rule.id)!;
      const amounts = [row.uncached, row.cached, row.writes, row.output];
      const parts = emptyContextParts();
      bucketKeys.forEach((key, index) => {
        const tokens = { in_uncached: 0n, in_cache_read: 0n, in_cache_write: 0n, out_total: 0n, [key]: BigInt(amounts[index]!) };
        parts[CONTEXT_PART_KEYS[index]!] = subtract(nanoValuation(long.coefficients, tokens), nanoValuation(normal.coefficients, tokens));
      });
      if (!equal(Object.values(parts).reduce(add, rational(0n)), contextAmount(row, "extra")!))
        throw new Error("Context bucket contributions disagree with the saved request uplift");
      desired.set(row.event_id, { row, parts: encodeContextParts(parts) });
    }
    if (options.canWrite?.() === false || readCodexContextState(db)?.revision !== state.revision) break;
    const published = db.transaction(() => {
      if (readCodexContextState(db)?.revision !== state.revision || codexContextPending(db)) return false;
      const old = db.query(`SELECT * FROM codex_context_bucket_parts p WHERE day=?${dim}`).all(...params) as Array<{event_id:number;parts:string;day:string;dim_id:number;hour:number;instant_ms:number;cohort:string}>;
      const before = new Map(old.map(row => [row.event_id, row]));
      for (const row of old) if (!desired.has(row.event_id)) { db.query("DELETE FROM codex_context_bucket_parts WHERE event_id=?").run(row.event_id); writes++; }
      for (const [id, { row, parts }] of desired) {
        const previous = before.get(id);
        if (previous && previous.parts === parts && previous.instant_ms === row.instant_ms && previous.cohort === row.cohort && previous.dim_id === row.dim_id) continue;
        db.query("INSERT OR REPLACE INTO codex_context_bucket_parts(event_id,day,dim_id,hour,instant_ms,cohort,parts) VALUES(?,?,?,?,?,?,?)")
          .run(id, row.day, row.dim_id, row.hour, row.instant_ms, row.cohort, parts); writes++;
      }
      // The queue names the affected pricing day/model; the source/account selection is applied by the model producer.
      db.query(`INSERT OR IGNORE INTO codex_context_model_pending SELECT w.account,w.counter,w.window_id FROM limit_windows w
        JOIN window_usage u ON u.provider=w.provider AND u.account=w.account AND u.counter=w.counter AND u.window_id=w.window_id
        WHERE w.provider='codex' AND julianday(w.start_ts)<julianday(?)+2 AND julianday(w.end_ts)>julianday(?)-1
        AND (?<0 OR EXISTS(SELECT 1 FROM json_each(json_extract(u.rail,'$.by_model')) m
          WHERE json_extract(m.value,'$.model') IS (SELECT model FROM codex_price_ledger_dims WHERE id=?)))`)
        .run(scope.day, scope.day, scope.dim_id, scope.dim_id);
      db.query(`DELETE FROM codex_context_detail_dirty WHERE day=?${scope.dim_id < 0 ? "" : " AND dim_id=?"}`).run(...params);
      db.query("UPDATE codex_context_detail_state SET revision=revision+1 WHERE singleton=1").run();
      return true;
    }).immediate();
    if (!published) break;
    partitions++;
  }
  return { partitions, writes, pending: !!db.query("SELECT 1 FROM codex_context_detail_dirty LIMIT 1").get() };
}
/** Saved sparse long-request components; every other complete request contributes an exact zero. */
export function readContextBucketParts(db: Database, row: LedgerStoredGroup, range: LedgerRange = {}): ContextBucketParts {
  const params: SQLQueryBindings[] = [row.day, row.dim_id, JSON.stringify([row.api_band,row.credit_band,row.api_reason || "",row.credit_reason || "",row.api_zero,row.credit_zero,row.copy_state])];
  const terms = ["day=?", "dim_id=?", "cohort=?"];
  if (row.hour !== undefined && row.hour !== null) { terms.push("hour=?"); params.push(row.hour); }
  if (range.fromMs !== undefined) { terms.push("instant_ms>=?"); params.push(range.fromMs + (range.startInclusive === false ? 1 : 0)); }
  if (range.toMs !== undefined) { terms.push("instant_ms<?"); params.push(range.toMs + (range.endInclusive ? 1 : 0)); }
  const total = emptyContextParts();
  for (const part of db.query(`SELECT parts FROM codex_context_bucket_parts WHERE ${terms.join(" AND ")}`).all(...params) as {parts:string}[]) {
    const values = decodeContextParts(part.parts);
    for (const key of CONTEXT_PART_KEYS) total[key] = add(total[key], values[key]);
  }
  return total;
}


const rangeSchemas=new WeakSet<Database>();
export function hasContextWindowRanges(db:Database):boolean {
  if(rangeSchemas.has(db))return true;
  if(!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_context_window_ranges'").get())return false;
  rangeSchemas.add(db);return true;
}
/** Inside the existing publication transaction; overlap discovery belongs to the background consumer. */
export function markContextWindowRange(db:Database,account:string,from:number,until:number|null):void {
  if(!hasContextWindowRanges(db))return;
  db.query(`INSERT INTO codex_context_window_ranges VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET
    from_ms=MIN(from_ms,excluded.from_ms),until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END`)
    .run(account.toLowerCase(),from,until);
}
export function contextWindowRangesPending(db:Database):boolean {
  return hasContextWindowRanges(db)&&!!db.query("SELECT 1 FROM codex_context_window_ranges LIMIT 1").get();
}
export function consumeContextWindowRanges(db:Database):number {
  if(!hasContextWindowRanges(db))return 0;
  const rows=db.query("SELECT * FROM codex_context_window_ranges ORDER BY account LIMIT 1").all() as {account:string;from_ms:number;until_ms:number|null}[];
  for(const row of rows)db.transaction(()=>{
    db.query(`INSERT OR IGNORE INTO codex_context_model_pending SELECT account,counter,window_id FROM limit_windows
      WHERE provider='codex' AND (?='*' OR account=?) AND julianday(end_ts)>julianday(?/1000.0,'unixepoch')
      AND (? IS NULL OR julianday(start_ts)<julianday(?/1000.0,'unixepoch'))`).run(row.account,row.account,row.from_ms,row.until_ms,row.until_ms);
    db.query(`INSERT OR IGNORE INTO codex_context_model_pending SELECT m.account,m.counter,m.window_id FROM codex_context_model_windows m
      WHERE (?='*' OR m.account=?) AND NOT EXISTS(SELECT 1 FROM limit_windows w WHERE w.provider='codex' AND w.account=m.account AND w.counter=m.counter AND w.window_id=m.window_id)`).run(row.account,row.account);
    if(db.query("SELECT 1 FROM sqlite_master WHERE name='codex_context_final_pending'").get())
      db.query(`INSERT OR IGNORE INTO codex_context_final_pending SELECT account,counter,window_id FROM codex_context_model_pending`).run();
    db.query("DELETE FROM codex_context_window_ranges WHERE account=?").run(row.account);
    db.query("UPDATE codex_context_detail_state SET revision=revision+1 WHERE singleton=1").run();
  }).immediate();
  return rows.length;
}
