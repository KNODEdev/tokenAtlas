import type { SQLQueryBindings } from "bun:sqlite";
import { Database } from "../db/sqlite";
import rateCards from "../../rate-cards.json";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import type { RateCard } from "./pricing";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { CODEX_RESERVE_MODEL } from "./codex-window-comparison";
import { overrideProjectRules } from "../projects/resolve";

/**
 * Test support: two days of Codex calls of every kind window and range reads distinguish (models with and without prices,
 * tiers, credit funding, another meter reset, invalid counters, mirror copies, another account's source), on a source
 * that changes hands at 10:15 on the first day, with the ledger prepared from them.
 */
export const card = rateCards as RateCard;
export const openedDatabases: Database[] = [];
export interface SceneOptions { account: string; homes: string[]; from: string; until: string; anchor: number | null; limitId: string; sessionMinutes: number;
  inclusiveEnd?: boolean; project?: string | null; includeBurn?: boolean; filterCounter?: boolean;
  sessionOrigin?: number; homeToSubId?: Map<string, string> }

export function database(): Database {
  const db = new Database(":memory:");
  openedDatabases.push(db);
  db.exec(`CREATE TABLE events (
    home TEXT NOT NULL, path TEXT NOT NULL, ts TEXT NOT NULL,
    surface TEXT, nested TEXT, model TEXT, effort TEXT, project TEXT, project_id TEXT,
    in_tok INTEGER NOT NULL, cached_in INTEGER NOT NULL, cache_write INTEGER NOT NULL,
    out_tok INTEGER NOT NULL, reasoning_out INTEGER NOT NULL DEFAULT 0,
    speed TEXT, billing_mode TEXT, meter_reset INTEGER, plan_type TEXT, account_id TEXT, source_offset INTEGER
  )`);
  return db;
}

export function insertCalls(db: Database, homes: { own: string; mirror: string; foreign: string }, anchor: number) {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const models = ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.3-codex-spark", "codex-auto-review", "not-shipped-model", CODEX_RESERVE_MODEL];
  const speeds = ["standard", "standard", "fast", "priority", null];
  // A call of project 7 is made in the place the scene's rule names (`project` "seven").
  const insert = db.query(`INSERT INTO events (home,path,ts,surface,model,project,in_tok,cached_in,cache_write,out_tok,reasoning_out,
    speed,billing_mode,meter_reset,plan_type,source_offset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const start = Date.parse("2026-09-10T22:00:00Z");
  for (let index = 0; index < 600; index++) {
    const at = start + Math.floor(next() * 46 * 3_600_000);
    const roll = next(), home = roll < 0.08 ? homes.foreign : homes.own;
    const file = `${home}/session-${Math.floor(next() * 12)}.jsonl`;
    const in_tok = 1_000 + Math.floor(next() * 300_000), cached_in = Math.floor(next() * in_tok);
    const invalid = next() < 0.03;
    const row = [home, file, new Date(at).toISOString(), next() < 0.5 ? "cli" : "ide", models[Math.floor(next() * models.length)]!,
      next() < 0.3 ? "seven" : null, in_tok, invalid ? in_tok + 5 : cached_in, next() < 0.05 ? 3 : 0, Math.floor(next() * 20_000),
      Math.floor(next() * 5_000), speeds[Math.floor(next() * speeds.length)] ?? null,
      next() < 0.06 ? "credits" : next() < 0.04 ? "business_credits" : "allowance", next() < 0.1 ? anchor + 600 : anchor, "pro", index * 10] as const;
    insert.run(...(row as unknown as SQLQueryBindings[]));
  }
  // Two files are also copied whole into the mirror home: the same calls, resolved as one canonical copy each.
  db.query("INSERT INTO events SELECT ?,replace(path,?,?),ts,surface,nested,model,effort,project,project_id,in_tok,cached_in,cache_write,out_tok,reasoning_out,speed,billing_mode,meter_reset,plan_type,account_id,source_offset FROM events WHERE home=? AND (path LIKE ? OR path LIKE ?)")
    .run(homes.mirror, homes.own, homes.mirror, homes.own, "%session-0.jsonl", "%session-1.jsonl");
}

export function codexCallsScene() {
  const db = database(), archive = `${ARCHIVE_LOGICAL_ROOT}/codex`, own = "c:/own", mirror = "c:/mirror", foreign = "c:/foreign";
  // The own source changes hands at 10:15 on the first day; the mirror copies the same archive folder.
  const declarations = [
    { id: "before", vendor: "codex", home: `${archive}/main`, source_home: own, until: "2026-09-11T10:15:00Z" },
    { id: "acct", vendor: "codex", home: `${archive}/main`, source_home: own, from: "2026-09-11T10:15:00Z" },
    { id: "acct", vendor: "codex", home: `${archive}/main`, source_home: mirror, from: "2026-09-11T10:15:00Z" },
    { id: "other", vendor: "codex", home: `${archive}/other`, source_home: foreign },
  ];
  declareCodexEraPeriods(db, declarations);
  overrideProjectRules(db, { projects: [{ id: "7", name: "Seven", matches: [{ project: "seven" }] }] });
  const homeToSubId = indexSubscriptionHomes([{ id: "acct", home: own, source_home: mirror }, { id: "other", home: foreign }], declarations);
  const anchor = Date.parse("2026-09-15T00:00:00Z") / 1000;
  insertCalls(db, { own, mirror, foreign }, anchor);
  prepareCodexLedgerFixture(db, card, homeToSubId);
  const base: SceneOptions = { account: "acct", homes: [own, mirror, foreign], from: "2026-09-10T23:17:41.250Z", until: "2026-09-12T17:42:05.500Z",
    anchor, limitId: "codex", sessionMinutes: 300, includeBurn: true, homeToSubId };
  return { db, base };
}
