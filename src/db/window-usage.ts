import type { Database } from "bun:sqlite";
import { asSchemaWriter } from "./schema-writer";
import { ledgerAnswerAccounts, markWindowAnswersDirty, type LedgerPlace } from "./window-answers";
import {markSubscriptionHoursDirty} from './subscription-hours';
import {markProjectPlanDirty} from './project-plan';

/** The tables drizzle/0051_window_usage.sql creates, with the column 0056_window_usage_reference.sql adds; tests compare them. */
export const WINDOW_USAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS window_usage (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  start_ts TEXT NOT NULL, end_ts TEXT NOT NULL,
  cycle TEXT NOT NULL, rail TEXT NOT NULL, readings TEXT NOT NULL, slices TEXT NOT NULL, reference TEXT,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;
CREATE TABLE IF NOT EXISTS window_usage_pending (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;
CREATE TABLE IF NOT EXISTS window_usage_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, from_ms INTEGER NOT NULL,
  until_ms INTEGER, sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account, counter, from_ms)
) STRICT;`;

/** The table drizzle/0055_window_usage_interval_kinds.sql leaves (0052 created it with fewer kinds); tests compare them. */
export const WINDOW_USAGE_INTERVALS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS window_usage_intervals (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('manual','gauge','declared','rolling','anchored')), start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, spec TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;`;

export function ensureWindowUsageSchema(db: Database): void {
  asSchemaWriter(db, () => {
    db.exec(WINDOW_USAGE_SCHEMA_SQL);
    db.exec(WINDOW_USAGE_INTERVALS_SCHEMA_SQL);
  });
}

/** Every account, or every counter, of a provider. */
export const WINDOW_USAGE_ALL = "*";
/** The lower bound of an entry that covers the whole history. */
export const WINDOW_USAGE_BEGINNING = -8_640_000_000_000_000;

const present = new WeakSet<Database>();
function hasDirtyQueue(db: Database): boolean {
  if (present.has(db)) return true;
  const found = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_usage_dirty'").get();
  if (found) present.add(db);
  return found;
}

export interface WindowUsageChange {
  provider: string;
  /** An account, or `*` for every account of the provider. */
  account: string;
  /** A counter identity, or `*` for every counter. */
  counter?: string;
  /** Changed instants `[fromMs, untilMs)`; an absent or infinite upper bound is open. */
  fromMs: number;
  untilMs?: number | null;
  /** The accounts whose stored window answers the change touches, when narrower than `account` (a ledger change). */
  answerAccounts?: readonly string[];
}

/**
 * Called by the writer that changed an input of window sums, inside its own transaction: the sums of
 * every window whose cycle overlaps `[fromMs, untilMs)` must be recomputed. Entries with the same start
 * merge their upper bounds. Databases without the window-usage schema (partial test schemas) have
 * nothing to invalidate.
 */
export function markWindowUsageDirty(db: Database, change: WindowUsageChange): void {
  if (!Number.isFinite(change.fromMs) && change.fromMs !== -Infinity) return;
  const from = Math.max(WINDOW_USAGE_BEGINNING, Math.floor(change.fromMs));
  const until = change.untilMs == null || !Number.isFinite(change.untilMs) ? null : Math.ceil(change.untilMs);
  if (until !== null && until <= from) return;
  // Stored window screens read the same inputs (db/window-answers.ts).
  for (const account of change.answerAccounts ?? [change.account])
    markWindowAnswersDirty(db, { provider: change.provider, account, fromMs: from, untilMs: until });
  if (!hasDirtyQueue(db)) return;
  db.query(`INSERT INTO window_usage_dirty(provider,account,counter,from_ms,until_ms) VALUES(?,?,?,?,?)
    ON CONFLICT(provider,account,counter,from_ms) DO UPDATE SET
      until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END,
      sequence=sequence+1`)
    .run(change.provider.toLowerCase(), change.account === WINDOW_USAGE_ALL ? change.account : change.account.toLowerCase(),
      change.counter ?? WINDOW_USAGE_ALL, from, until);
}

/**
 * The same for many instant ranges of one provider (a ledger batch): touching or overlapping ranges are
 * merged first, so a batch of adjacent hours becomes one entry. Every account's window sums follow them; the
 * stored window answers only of the accounts that own the changed `places` there, when the writer can tell
 * (`setLedgerAnswerOwners`), so another account's answers stay current.
 */
export function markWindowUsageRangesDirty(db: Database, provider: string, ranges: ReadonlyArray<readonly [number, number]>,
  places?: readonly LedgerPlace[]): void {
  if (!ranges.length) return;
  const sorted = ranges.filter(([from, until]) => Number.isFinite(from) && Number.isFinite(until) && until > from)
    .map(([from, until]) => [from, until] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  for (const [fromMs, untilMs] of merged) {
    const accounts=ledgerAnswerAccounts(db, provider, places, fromMs, untilMs);
    markWindowUsageDirty(db, { provider, account: WINDOW_USAGE_ALL, fromMs, untilMs,answerAccounts:accounts });
    markProjectPlanDirty(db,provider,fromMs,untilMs);
    for(const account of accounts)markSubscriptionHoursDirty(db,provider,account,fromMs,untilMs);
  }
}
