import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { PLAN_PERIODS, recordPeriodReading } from "../db/period-store";
import type { PlansCatalog } from "./plans-catalog";

/** Two Codex accounts with weekly and 5 h windows, their sums and a running observed "pro" plan (billing-cycle tests). */
export const CATALOG: PlansCatalog = { provider_groups: [
  { id: "codex", label: "Codex", aliases: ["codex", "openai"], plans: [
    { plan_id: "codex-pro", label: "Pro", aliases: ["pro"], versions: [{ from: null, usd_per_month: 200 }] },
    { plan_id: "codex-plus", label: "Plus", aliases: ["plus"], versions: [{ from: null, usd_per_month: 20 }] },
    // The meter reports Pro 5× as "prolite"; declarations name it "pro-5x".
    { plan_id: "codex-pro-5x", label: "Pro (5x)", aliases: ["pro-5x", "prolite"], versions: [{ from: null, usd_per_month: 100 }] }] },
  { id: "claude", label: "Claude", aliases: ["claude", "anthropic"], plans: [
    { plan_id: "claude-max-20x", label: "Max 20x", aliases: ["max-20x"], versions: [{ from: null, usd_per_month: 200 }] },
    { plan_id: "claude-pro", label: "Pro", aliases: ["pro"], versions: [{ from: null, usd_per_month: 20 }] }] },
] };
export const H = 3_600_000, D = 24 * H;
export const iso = (ms: number) => new Date(ms).toISOString();
export const NOW = Date.parse("2026-10-08T14:30:00Z");
export const MAIN = JSON.stringify(["codex", "codex", 10080]);
export const FIVE = JSON.stringify(["codex", "codex", 300]);
/** Codex Free's 30-day meter. */
export const MONTH = JSON.stringify(["codex", "codex", 43200]);

export function database(): Database {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  return db;
}
/** A limit window with readings every 6 h (% linear to `final`) and its window-usage row (API value linear to `usd`). */
export function addWindow(db: Database, account: string, counter: string, startMs: number, endMs: number, final: number, usd: number, plan = "pro") {
  const minutes = counter === MAIN ? 10080 : counter === MONTH ? 43200 : 300;
  const steps = Math.max(1, Math.floor((Math.min(endMs, NOW) - startMs) / (6 * H)));
  const readings = Array.from({ length: steps }, (_, i) => ({ ts: iso(startMs + (i + 1) * (Math.min(endMs, NOW) - startMs) / (steps + 1)),
    percent: Math.round(final * (i + 1) / steps), source: "probe" }));
  const id = JSON.stringify([account, counter, iso(startMs)]);
  const seq = (db.query("SELECT COUNT(*) AS n FROM limit_windows WHERE provider='codex' AND account=? AND counter=?").get(account, counter) as { n: number }).n;
  db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_detail,
    plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input) VALUES('codex',?,?,?,?,?,?,?,'reset',?,?,NULL,0,?,NULL,NULL,NULL,1,?)`)
    .run(account, counter, seq, id, iso(startMs), iso(endMs), iso(endMs), minutes, plan, JSON.stringify(readings), iso(startMs));
  const running = readings.map((r, i) => ({ ts: r.ts, usage: { api_standard: usd * (i + 1) / readings.length } }));
  db.query(`INSERT INTO window_usage(provider,account,counter,window_id,start_ts,end_ts,cycle,rail,readings,slices,reference)
    VALUES('codex',?,?,?,?,?,?,'{}',?,'[]',NULL)`).run(account, counter, id, iso(startMs), iso(endMs),
    JSON.stringify({ usage: { api_standard: usd } }), JSON.stringify(running));
}
export function seed(db: Database) {
  const start = Date.parse("2026-08-31T06:00:00Z");
  for (const account of ["codex1", "codex2"]) {
    for (let i = 0; i < 6; i++) addWindow(db, account, MAIN, start + i * 7.5 * D, start + i * 7.5 * D + 7 * D, 40 + 5 * i, 1000 + 100 * i);
    for (let i = 0; i < 4; i++) addWindow(db, account, FIVE, start + i * D, start + i * D + 5 * H, 80, 50);
    recordPeriodReading(db, PLAN_PERIODS, { provider: "codex", subject: account, ts: "2026-09-09T15:11:32.698Z", value: "pro" });
    recordPeriodReading(db, PLAN_PERIODS, { provider: "codex", subject: account, ts: "2026-10-08T14:00:00.000Z", value: "pro" });
  }
}
