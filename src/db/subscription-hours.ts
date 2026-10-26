import type {Database} from 'bun:sqlite';
import {ACTIVE_GAP_MS} from '../shared/agent-hours';
export function hasSubscriptionHours(db:Database):boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE name='subscription_window_hours'").get();
}
export function markSubscriptionHoursDirty(db:Database,provider:string,account:string,from:number,until:number|null):void {
  if(!hasSubscriptionHours(db)||!['claude','codex','*'].includes(provider))return;
  db.query("INSERT INTO subscription_hours_state(key,value) VALUES('invalidated','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
  const seq=Number((db.query("SELECT value FROM subscription_hours_state WHERE key='invalidated'").get() as {value:string}).value);
  db.query("INSERT INTO subscription_hours_dirty(provider,account,from_ms,until_ms,sequence) VALUES(?,?,?,?,?) ON CONFLICT(provider,account,from_ms) DO UPDATE SET until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END,sequence=excluded.sequence")
    .run(provider,account,Math.floor(from-ACTIVE_GAP_MS),until===null?null:Math.ceil(until+ACTIVE_GAP_MS),seq);
}
export interface StoredWindowHours {
  provider:string;account:string;counter:string;window_id:string;
  start_ts:string;end_ts:string;
  active_ms:number;hours_per_100:number|null;absent:string|null;signature:string;checked:number;computed_at:string;
}
export function readWindowHours(db:Database):StoredWindowHours[] {
  return hasSubscriptionHours(db)?db.query('SELECT * FROM subscription_window_hours').all() as StoredWindowHours[]:[];
}
