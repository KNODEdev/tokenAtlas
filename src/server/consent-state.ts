import type { Database } from "../db/sqlite";

/**
 * Stored while the consent screen waits (TALK-001 D3), so background jobs outside this thread
 * (exchange rates) also make no network request before the user agrees.
 */
export const AWAITING_CONSENT_KEY = "setup:awaiting-consent";

export function awaitingConsent(sqlite: Database): boolean {
  try {
    return sqlite.query("SELECT 1 FROM meta WHERE key=?").get(AWAITING_CONSENT_KEY) != null;
  } catch { return false; }
}

export function markAwaitingConsent(sqlite: Database, awaiting: boolean): void {
  try {
    if (awaiting) sqlite.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(AWAITING_CONSENT_KEY, new Date().toISOString());
    else sqlite.query("DELETE FROM meta WHERE key=?").run(AWAITING_CONSENT_KEY);
  } catch (error) { console.warn("[tokenAtlas setup] consent marker not stored", error); }
}
