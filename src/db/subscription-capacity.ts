import type { Database } from "bun:sqlite";
import { asSchemaWriter } from "./schema-writer";
import type { RateWindow } from "../shared/subscription-rate";
import {hasSubscriptionHours} from './subscription-hours';
import { matchingContextPrice, storedContextPrice } from "../shared/context-price";
import type { WindowUsage } from "../shared/codex-accounting";

export const SUBSCRIPTION_CAPACITY_SQL = [
  "CREATE TABLE IF NOT EXISTS subscription_capacity_windows (",
  "provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,",
  "start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, scope_start TEXT NOT NULL,",
  "signature TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, computed_at TEXT NOT NULL,",
  "PRIMARY KEY(provider,account,counter,window_id)) STRICT;",
  "CREATE INDEX IF NOT EXISTS subscription_capacity_range ON subscription_capacity_windows(provider,account,end_ts);",
  "CREATE TABLE IF NOT EXISTS subscription_capacity_dirty (",
  "provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,",
  "sequence INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(provider,account,from_ms)) STRICT;",
  "CREATE TABLE IF NOT EXISTS subscription_capacity_state (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;"
].join("\n");
export function ensureSubscriptionCapacitySchema(db: Database): void {
  asSchemaWriter(db, () => db.exec(SUBSCRIPTION_CAPACITY_SQL));
}
export function hasSubscriptionCapacity(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_capacity_windows'").get();
}
/** Durable invalidation, independent of the response-cache marks and their retention. */
export function markSubscriptionCapacityDirty(db: Database, provider: string, account: string, from: number, until: number | null): void {
  if (!hasSubscriptionCapacity(db) || !["claude", "codex", "*"].includes(provider)) return;
  db.query("INSERT INTO subscription_capacity_state(key,value) VALUES('invalidated','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
  const sequence = Number((db.query("SELECT value FROM subscription_capacity_state WHERE key='invalidated'").get() as { value: string }).value);
  db.query("INSERT INTO subscription_capacity_dirty(provider,account,from_ms,until_ms,sequence) VALUES(?,?,?,?,?) ON CONFLICT(provider,account,from_ms) DO UPDATE SET until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END,sequence=excluded.sequence")
    .run(provider, account, Math.floor(from), until === null ? null : Math.ceil(until), sequence);
}
export function readCapacityWindows(db: Database, account?: string): RateWindow[] {
  if (!hasSubscriptionCapacity(db)) return [];
  const hours=hasSubscriptionHours(db);
  const context = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_usage'").get();
  return (db.query("SELECT c.body"+(context ? ",json_extract(u.cycle,'$.cycle_usage') context_usage" : "")+(hours?",h.active_ms,h.hours_per_100,h.absent":"")+" FROM subscription_capacity_windows c"+
    (context ? " LEFT JOIN window_usage u ON u.provider=c.provider AND u.account=c.account AND u.counter=c.counter AND u.window_id=c.window_id" : "")+
    (hours?" LEFT JOIN subscription_window_hours h ON h.provider=c.provider AND h.account=c.account AND h.counter=c.counter AND h.window_id=c.window_id":"")+
    (account ? " WHERE c.account=?" : "") + " ORDER BY c.end_ts,c.start_ts")
    .all(...(account ? [account.toLowerCase()] : [])) as Array<{ body:string;context_usage?:string|null;active_ms?:number|null;hours_per_100?:number|null;absent?:string|null }>)
    .map(row=>{
      const fact = JSON.parse(row.body) as RateWindow;
      const price = fact.provider === "codex" && row.context_usage
        ? matchingContextPrice(storedContextPrice(JSON.parse(row.context_usage) as WindowUsage), fact.api_usd) : undefined;
      return {...fact, ...(price ? { context_price: price } : {}), active_hours:row.active_ms==null?null:row.active_ms/3_600_000,
        hours_per_100:row.hours_per_100??null,hours_absent:row.active_ms==null?'hours_preparing':row.absent??null};
    });
}
/** The window a period ends in, from the same durable rows the rate tab reads. */
export function storedCapacityForPeriod(db: Database, account: string, period?: { since?: string | null; until?: string | null }) {
  const end = period?.until ? Date.parse(period.until.slice(0, 10)) + 86_400_000 : Infinity;
  const start = period?.since ? Date.parse(period.since) : -Infinity;
  return readCapacityWindows(db, account).filter(row => Date.parse(row.start) < end && Date.parse(row.end) > start).at(-1) ?? null;
}
