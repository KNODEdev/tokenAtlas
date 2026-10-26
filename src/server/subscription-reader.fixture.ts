import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database as SqliteDatabase } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { installAnalysisTracking } from "../db/analysis";
import { fillUsageLedger, fillUsageLedgerFixture } from "./usage-ledger.fixture";
import type { RateCard } from "./pricing";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import type { DatedPeriod } from "./account-periods";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import { installFactDayRevisions } from "../db/fact-day-revisions";

/**
 * Test support: a fixture written before stage 4 names each Claude row's account in `subscription_id`.
 * Production resolves it from the account period of the row's archive folder instead (W4), so every
 * labelled row without a session identity moves into the folder `claude/<label>` and the label gets
 * a declared period there from `from` on; the readers then resolve the account the fixture meant.
 */
export function declareClaudeLabelPeriods(db: Database, from = "2000-01-01"): void {
  const cols = new Set((db.query("PRAGMA table_info(claude_events)").all() as {name:string}[]).map(c=>c.name));
  const keyless = `${cols.has("account_key") ? " AND account_key IS NULL" : ""}${cols.has("subscription_conflict") ? " AND COALESCE(subscription_conflict,0)=0" : ""}`;
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS account_periods(id INTEGER PRIMARY KEY,provider TEXT NOT NULL,source TEXT NOT NULL,from_ts TEXT NOT NULL,
    until_ts TEXT,account TEXT NOT NULL,origin TEXT NOT NULL,first_seen TEXT,last_seen TEXT,readings INTEGER NOT NULL DEFAULT 0,evidence TEXT NOT NULL)`);
  const labels = (db.query(`SELECT DISTINCT subscription_id AS label FROM claude_events WHERE subscription_id IS NOT NULL${keyless}`)
    .all() as {label:string}[]).map(row => row.label);
  const declared = loadPeriods(db, ACCOUNT_PERIODS).filter(period => period.origin === "declared");
  for (const label of labels) {
    const folder = `claude/${label.toLowerCase()}`;
    db.query(`UPDATE claude_events SET path = ? || '/' || rowid || '.jsonl' WHERE subscription_id = ?${keyless}`)
      .run(`${ARCHIVE_LOGICAL_ROOT}/${folder}`, label);
    if (declared.some(period => period.subject.toLowerCase() === folder)) continue;
    declared.push({ provider: "claude", subject: folder, from, until: null, value: label, origin: "declared",
      firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" } satisfies DatedPeriod);
  }
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, declared);
}

/** Translate the fixture's explicit ownership labels to archived sources and dated declarations. */
export function prepareClaudeReaderFixture(db: Database, rates: RateCard, limit = 4): void {
  const cols = new Set((db.query("PRAGMA table_info(claude_events)").all() as {name:string}[]).map(c=>c.name));
  if (!cols.has("path")) db.exec("ALTER TABLE claude_events ADD COLUMN path TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS account_periods(id INTEGER PRIMARY KEY,provider TEXT,source TEXT,from_ts TEXT,until_ts TEXT,account TEXT,
    origin TEXT,first_seen TEXT,last_seen TEXT,readings INTEGER,evidence TEXT)`);
  if (cols.has("subscription_id")) {
    const rows = db.query("SELECT DISTINCT subscription_id account FROM claude_events WHERE subscription_id IS NOT NULL").all() as {account:string}[];
    for (const {account} of rows) {
      const source = `claude/${account.toLowerCase()}`;
      db.query(`UPDATE claude_events SET path=? || '/' || call_id || '.jsonl' WHERE subscription_id=? AND path IS NULL
        ${cols.has("subscription_conflict") ? "AND COALESCE(subscription_conflict,0)=0" : ""}`)
        .run(`${ARCHIVE_LOGICAL_ROOT}/${source}`, account);
      db.query(`INSERT INTO account_periods(provider,source,from_ts,account,origin,readings,evidence)
        SELECT 'claude',?,'2000-01-01',?,'declared',0,'fixture' WHERE NOT EXISTS(SELECT 1 FROM account_periods WHERE source=?)`)
        .run(source,account.toLowerCase(),source);
    }
    if (cols.has("subscription_conflict")) db.query("UPDATE claude_events SET path=NULL WHERE subscription_conflict<>0 AND path IS NOT NULL").run();
  }
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  fillUsageLedger(db,"claude",rates,ARCHIVE_LOGICAL_ROOT,limit);
  prepareProbeReaderFixture(db, []);
}

/**
 * An empty in-memory database with the real schema whose (empty) facts and registers are
 * prepared, as a fresh installation leaves them. Register v8 reports facts that were never
 * prepared as pending, so a "no data" screen test needs this rather than a bare database.
 */
export function emptyPreparedDatabase(rates: RateCard): Database {
  const db = new SqliteDatabase(":memory:");
  applyDrizzleMigrations(drizzle(db));
  prepareClaudeReaderFixture(db, rates);
  fillUsageLedgerFixture(db, rates, ["gemini", "grok", "glm"]);
  prepareProbeReaderFixture(db, []);
  return db;
}
