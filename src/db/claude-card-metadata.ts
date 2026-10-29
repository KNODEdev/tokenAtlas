import type { Database } from "bun:sqlite";
import { ProbeAccountIndexUnavailable } from "../server/current/probe-account-unavailable";

export const CLAUDE_CARD_METADATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS claude_card_members(account TEXT NOT NULL,probe_id INTEGER NOT NULL,at_ms INTEGER NOT NULL,
 reset_ms REAL,reset_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,probe_id)) STRICT;
CREATE INDEX IF NOT EXISTS claude_card_member_time ON claude_card_members(account,at_ms,probe_id);
CREATE INDEX IF NOT EXISTS claude_card_member_reset ON claude_card_members(account,reset_ms);
CREATE TABLE IF NOT EXISTS claude_card_components(account TEXT NOT NULL,component TEXT NOT NULL,from_ms REAL,until_ms REAL,
 observations INTEGER NOT NULL,samples INTEGER NOT NULL,PRIMARY KEY(account,component)) STRICT;
CREATE TABLE IF NOT EXISTS claude_card_state(account TEXT PRIMARY KEY,version INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS claude_card_dirty_probes(account TEXT NOT NULL,probe_id INTEGER NOT NULL,PRIMARY KEY(account,probe_id)) STRICT;
CREATE TABLE IF NOT EXISTS claude_card_dirty_ranges(account TEXT NOT NULL,from_ms INTEGER NOT NULL,until_ms INTEGER,after_id INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(account,from_ms)) STRICT;
CREATE TABLE IF NOT EXISTS claude_card_component_work(account TEXT NOT NULL,component TEXT NOT NULL,from_ms REAL,until_ms REAL,
 PRIMARY KEY(account,component)) STRICT;`;
export function hasClaudeCardMetadata(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='claude_card_state'").get();
}
export function markClaudeCardProbeDirty(db: Database, account: string, probeId: number): void {
  if (hasClaudeCardMetadata(db)) db.query("INSERT OR IGNORE INTO claude_card_dirty_probes VALUES(?,?)").run(account.toLowerCase(),probeId);
}
export function markClaudeCardRangeDirty(db: Database, account: string, from: number, until: number | null): void {
  if (!hasClaudeCardMetadata(db)) return;
  db.query(`INSERT INTO claude_card_dirty_ranges(account,from_ms,until_ms) VALUES(?,?,?) ON CONFLICT(account,from_ms) DO UPDATE SET after_id=0,
    until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END`)
    .run(account.toLowerCase(),Math.floor(from),until === null ? null : Math.ceil(until));
}
export function preparedClaudeCardMetadata(db: Database, account: string): { observationCount: number; probeSampleCount: number } {
  // The producer only visits accounts with a limit window or a state row. A detected account with neither,
  // and no probe reading that could still become a window, has nothing to prepare: it reads as no
  // observations instead of waiting forever.
  const table = (name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (hasClaudeCardMetadata(db) && table("limit_windows") && table("probe_windows")
    && !db.query("SELECT 1 FROM claude_card_state WHERE account=?").get(account)
    && !db.query("SELECT 1 FROM limit_windows WHERE provider='claude' AND account=? LIMIT 1").get(account)
    && !db.query("SELECT 1 FROM probe_windows WHERE provider='claude' AND subject IN (?1, lower(?1)) LIMIT 1").get(account))
    return { observationCount: 0, probeSampleCount: 0 };
  if (!hasClaudeCardMetadata(db) || !db.query("SELECT 1 FROM claude_card_state WHERE account=? AND version=1").get(account)
    || db.query("SELECT 1 FROM claude_card_dirty_probes WHERE account=? LIMIT 1").get(account)
    || db.query("SELECT 1 FROM claude_card_component_work WHERE account=? LIMIT 1").get(account)
    || db.query("SELECT 1 FROM claude_card_dirty_ranges WHERE account IN (?, '*') LIMIT 1").get(account)) throw new ProbeAccountIndexUnavailable();
  const row = db.query("SELECT COALESCE(SUM(observations),0) n,COALESCE(SUM(samples),0) s FROM claude_card_components WHERE account=?")
    .get(account) as { n: number; s: number };
  return { observationCount: row.n, probeSampleCount: row.s };
}
