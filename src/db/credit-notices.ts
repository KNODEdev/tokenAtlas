import type { Database } from "bun:sqlite";
import { addSpent, creditNoticeOccurredAt, type CreditNoticeDraft, type CreditNoticeKind, type NoticePool, type StoredPool } from "../shared/credit-notices";
import { asSchemaWriter } from "./schema-writer";

/**
 * The stored register of credit notices (docs/credit-notices-2026-10-09.md), written by the background
 * producer (server/credit-notice-producer.ts); the user's acknowledgement is the only other write:
 * - `credit_pool_cursor`: per account, the published current card and the pool reading last folded;
 * - `credit_pool_state`: per account and pool identity, the last state and the first observation (pace);
 * - `credit_notices`: one row per notice identity; replays and refolds write the same rows again.
 * Kept identical to drizzle/0074_credit_notices.sql; tests compare them.
 */
export const CREDIT_NOTICE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS credit_pool_cursor (
  provider TEXT NOT NULL, account TEXT NOT NULL, card_at TEXT NOT NULL, reading_id INTEGER, read_at TEXT,
  PRIMARY KEY(provider, account)
) STRICT;
CREATE TABLE IF NOT EXISTS credit_pool_state (
  provider TEXT NOT NULL, account TEXT NOT NULL, identity TEXT NOT NULL, state TEXT NOT NULL, read_at TEXT NOT NULL,
  baseline_at TEXT NOT NULL, baseline_used REAL,
  PRIMARY KEY(provider, account, identity)
) STRICT;
CREATE TABLE IF NOT EXISTS credit_notices (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, notice TEXT NOT NULL, pool TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('received','topped_up','used','spent','expiring','expired_unused')),
  unit TEXT NOT NULL, amount REAL, amount_text TEXT, expires_at TEXT, observed_at TEXT NOT NULL, detail TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, acknowledged_at TEXT,
  UNIQUE(provider, account, notice)
) STRICT;
CREATE INDEX IF NOT EXISTS credit_notices_open ON credit_notices(observed_at) WHERE acknowledged_at IS NULL AND resolved_at IS NULL;`;

export function ensureCreditNoticeSchema(db: Database): void {
  asSchemaWriter(db, () => { db.exec(CREDIT_NOTICE_SCHEMA_SQL); });
}

export function hasCreditNoticeSchema(db: Database): boolean {
  return (db.query(`SELECT count(*) AS n FROM sqlite_master WHERE type='table'
    AND name IN ('credit_pool_cursor','credit_pool_state','credit_notices')`).get() as { n: number }).n === 3;
}

export interface CreditNoticeRow {
  id: number; provider: string; account: string; notice: string; pool: string; kind: CreditNoticeKind;
  unit: NoticePool["unit"]; amount: number | null; amount_text: string | null; expires_at: string | null;
  observed_at: string; detail: Record<string, string | number | boolean | null>;
  created_at: string; updated_at: string; resolved_at: string | null; acknowledged_at: string | null;
}
type RawNotice = Omit<CreditNoticeRow, "detail"> & { detail: string };
const decodeRow = (row: RawNotice): CreditNoticeRow => ({ ...row, detail: JSON.parse(row.detail) as CreditNoticeRow["detail"] });

export interface PoolCursor { card_at: string; reading_id: number | null; read_at: string | null }

export function readPoolCursor(db: Database, provider: string, account: string): PoolCursor | null {
  return db.query("SELECT card_at,reading_id,read_at FROM credit_pool_cursor WHERE provider=? AND account=?")
    .get(provider, account) as PoolCursor | null;
}

export function writePoolCursor(db: Database, provider: string, account: string, cursor: PoolCursor): void {
  db.query(`INSERT INTO credit_pool_cursor(provider,account,card_at,reading_id,read_at) VALUES(?,?,?,?,?)
    ON CONFLICT(provider,account) DO UPDATE SET card_at=excluded.card_at,reading_id=excluded.reading_id,read_at=excluded.read_at`)
    .run(provider, account, cursor.card_at, cursor.reading_id, cursor.read_at);
}

export function readStoredPools(db: Database, provider: string, account: string): StoredPool[] {
  return (db.query(`SELECT identity,state,read_at,baseline_at,baseline_used FROM credit_pool_state
    WHERE provider=? AND account=? ORDER BY identity`).all(provider, account) as Array<Omit<StoredPool, "pool"> & { state: string }>)
    .map(({ state, ...row }) => ({ ...row, pool: JSON.parse(state) as NoticePool }));
}

/** Every account with stored pools; the expiry pass reads only these rows. */
export function readAllStoredPools(db: Database): Array<{ provider: string; account: string; pools: StoredPool[] }> {
  const accounts = db.query("SELECT DISTINCT provider,account FROM credit_pool_state ORDER BY provider,account")
    .all() as Array<{ provider: string; account: string }>;
  return accounts.map(({ provider, account }) => ({ provider, account, pools: readStoredPools(db, provider, account) }));
}

/** Replaces the account's pool states; a continuing identity keeps its first observation. */
export function replaceStoredPools(db: Database, provider: string, account: string, pools: readonly StoredPool[]): void {
  const keep = new Set(pools.map(pool => pool.identity));
  for (const { identity } of readStoredPools(db, provider, account))
    if (!keep.has(identity)) db.query("DELETE FROM credit_pool_state WHERE provider=? AND account=? AND identity=?").run(provider, account, identity);
  const save = db.query(`INSERT INTO credit_pool_state(provider,account,identity,state,read_at,baseline_at,baseline_used) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(provider,account,identity) DO UPDATE SET state=excluded.state,read_at=excluded.read_at`);
  for (const pool of pools)
    save.run(provider, account, pool.identity, JSON.stringify(pool.pool), pool.read_at, pool.baseline_at, pool.baseline_used);
}

/**
 * Writes drafts of one account. A notice identity is written once; a `spent` notice is one rolling row per
 * pool until acknowledgement. Later use preserves that row and starts a new total. An `expiring` notice
 * keeps its row and follows the current projection (amount, detail) while it holds.
 */
export function writeCreditNotices(db: Database, provider: string, account: string, drafts: readonly CreditNoticeDraft[], now: string): number {
  let written = 0;
  const find = db.query("SELECT * FROM credit_notices WHERE provider=? AND account=? AND notice=?");
  const insert = db.query(`INSERT INTO credit_notices(provider,account,notice,pool,kind,unit,amount,amount_text,expires_at,
    observed_at,detail,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const archiveSpent = db.query("UPDATE credit_notices SET notice=? WHERE id=?");
  const update = db.query(`UPDATE credit_notices SET amount=?,amount_text=?,expires_at=?,observed_at=?,detail=?,updated_at=?,
    resolved_at=NULL,acknowledged_at=? WHERE id=?`);
  for (const draft of drafts) {
    const existing = find.get(provider, account, draft.notice) as RawNotice | null;
    const detail = JSON.stringify(draft.detail);
    if (!existing) {
      // A spent total states since when it adds up.
      const stored = draft.kind === "spent" ? JSON.stringify({ ...draft.detail, since: draft.observed_at }) : detail;
      insert.run(provider, account, draft.notice, draft.pool, draft.kind, draft.unit, draft.amount, draft.amount_text,
        draft.expires_at, draft.observed_at, stored, now, now);
      written++;
    } else if (draft.kind === "spent") {
      if (existing.observed_at >= draft.observed_at) continue;
      if (existing.acknowledged_at != null) {
        db.transaction(() => {
          archiveSpent.run(`${draft.notice}|history:${existing.observed_at}`, existing.id);
          insert.run(provider, account, draft.notice, draft.pool, draft.kind, draft.unit, draft.amount, draft.amount_text,
            draft.expires_at, draft.observed_at, JSON.stringify({ ...draft.detail, since: draft.observed_at }), now, now);
        })();
        written++;
        continue;
      }
      const total = addSpent(existing, draft);
      const since = (JSON.parse(existing.detail) as { since?: string }).since ?? existing.created_at;
      update.run(total.amount, total.amount_text, draft.expires_at, draft.observed_at, JSON.stringify({ ...draft.detail, since }),
        now, null, existing.id);
      written++;
    } else if (draft.kind === "expiring" && existing.resolved_at == null
      && (existing.amount !== draft.amount || existing.detail !== detail)) {
      update.run(draft.amount, draft.amount_text, draft.expires_at, draft.observed_at, detail, now, existing.acknowledged_at, existing.id);
      written++;
    }
  }
  return written;
}

/** Resolves the account's open expiry warnings that no longer hold. */
export function resolveExpiryNotices(db: Database, provider: string, account: string, holding: ReadonlySet<string>, now: string): number {
  const open = db.query(`SELECT id,notice FROM credit_notices WHERE provider=? AND account=? AND kind='expiring' AND resolved_at IS NULL`)
    .all(provider, account) as Array<{ id: number; notice: string }>;
  const resolve = db.query("UPDATE credit_notices SET resolved_at=?,updated_at=? WHERE id=?");
  let resolved = 0;
  for (const row of open) if (!holding.has(row.notice)) { resolve.run(now, now, row.id); resolved++; }
  return resolved;
}

function decodeNotices(rows: RawNotice[]): CreditNoticeRow[] {
  return rows.map(decodeRow).sort((a, b) =>
    Date.parse(creditNoticeOccurredAt(b)) - Date.parse(creditNoticeOccurredAt(a)) || b.id - a.id);
}

/** Stored history, including acknowledged notices and resolved warnings; no reading-history scan. */
export function readCreditNotices(db: Database): CreditNoticeRow[] {
  if (!hasCreditNoticeSchema(db)) return [];
  return decodeNotices(db.query("SELECT * FROM credit_notices").all() as RawNotice[]);
}

/** Open notices do not silently disappear with age. */
export function readOpenCreditNotices(db: Database): CreditNoticeRow[] {
  if (!hasCreditNoticeSchema(db)) return [];
  return decodeNotices(db.query(`SELECT * FROM credit_notices
    WHERE acknowledged_at IS NULL AND resolved_at IS NULL`).all() as RawNotice[]);
}

export function acknowledgeCreditNotices(db: Database, ids: readonly number[], now: string): number {
  const ack = db.query("UPDATE credit_notices SET acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL");
  return db.transaction(() => ids.reduce((sum, id) => sum + ack.run(now, id).changes, 0)).immediate();
}
