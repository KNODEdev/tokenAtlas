import type { Database } from "bun:sqlite";
import {
  hasCreditNoticeSchema, readAllStoredPools, readPoolCursor, readStoredPools, replaceStoredPools, resolveExpiryNotices,
  writeCreditNotices, writePoolCursor,
} from "../db/credit-notices";
import { expiryNotices, poolChangeNotices, poolIdentity, type NoticePool, type StoredPool } from "../shared/credit-notices";

/**
 * Producer of credit notices (docs/credit-notices-2026-10-09.md), a background job after the current
 * projection. Its input is the published current card of each account: the card changes (`generated_at`)
 * only when its newest readings do, and its winners name those readings. Of them the newest that states
 * pools is the account's pool state; it is compared with the stored one. Deciding whether work exists
 * reads the cards' timestamps and the cursors, never readings; one changed account reads the extra of its
 * few winner readings.
 */
export interface CreditNoticeOptions {
  /** The pools a reading's extra states; null when it states nothing about pools (an older probe, another meter). */
  decode: (provider: string, extra: Record<string, unknown>) => NoticePool[] | null;
  providers?: readonly string[];
  now?: () => number;
  /** Re-checked before every write; false stops the call. */
  canWrite?: () => boolean;
  /** Accounts folded per call. */
  limit?: number;
}
export interface CreditNoticeResult { accounts: number; notices: number; resolved: number; pending: boolean }

const STAGE_PREFIX = "\u0001";
/** The expiry pass needs no reading; it reruns when pools changed or this long after its last run. */
const EXPIRY_PASS_MS = 10 * 60_000;
const lastExpiryPass = new WeakMap<Database, number>();

interface ChangedCard { provider: string; subject: string; generated_at: string; ids: string }
interface Reading { id: number; ts: string; extra: string }

function changedCards(db: Database, providers: readonly string[], limit: number): ChangedCard[] {
  return db.query(`SELECT s.provider, s.subject, s.generated_at,
      (SELECT json_group_array(json_extract(w.value,'$.id')) FROM json_each(s.data,'$.__winners') w) AS ids
    FROM current_probe_subjects s LEFT JOIN credit_pool_cursor c ON c.provider=s.provider AND c.account=s.subject
    WHERE s.provider IN (${providers.map(() => "?").join(",")}) AND substr(s.subject,1,1)<>?
      AND (c.card_at IS NULL OR c.card_at<>s.generated_at)
    ORDER BY s.provider, s.subject LIMIT ?`).all(...providers, STAGE_PREFIX, limit + 1) as ChangedCard[];
}

/** The newest winner reading of the card that states pools, with its pools. */
function poolReading(db: Database, provider: string, ids: readonly number[], decode: CreditNoticeOptions["decode"]) {
  if (!ids.length) return null;
  const readings = db.query(`SELECT id, ts, extra FROM probe_windows WHERE id IN (${ids.map(() => "?").join(",")})
    AND extra IS NOT NULL ORDER BY ts DESC, id DESC`).all(...ids) as Reading[];
  for (const reading of readings) {
    let extra: Record<string, unknown>;
    try { extra = JSON.parse(reading.extra) as Record<string, unknown>; } catch { continue; }
    const pools = decode(provider, extra);
    if (pools) return { id: reading.id, read_at: new Date(Date.parse(reading.ts)).toISOString(), pools };
  }
  return null;
}

function nextStoredPools(prior: readonly StoredPool[], read_at: string, pools: readonly NoticePool[]): StoredPool[] {
  const known = new Map(prior.map(pool => [pool.identity, pool]));
  return pools.map(pool => {
    const identity = poolIdentity(pool), old = known.get(identity);
    return { identity, pool, read_at, baseline_at: old?.baseline_at ?? read_at, baseline_used: old ? old.baseline_used : pool.used };
  });
}

function foldAccount(db: Database, card: ChangedCard, options: CreditNoticeOptions, now: string): number {
  const cursor = readPoolCursor(db, card.provider, card.subject);
  const ids = (JSON.parse(card.ids ?? "[]") as Array<number | null>).filter((id): id is number => Number.isInteger(id));
  const reading = poolReading(db, card.provider, ids, options.decode);
  let written = 0;
  db.transaction(() => {
    if (reading && reading.id !== cursor?.reading_id) {
      const stored = readStoredPools(db, card.provider, card.subject);
      // A refold that publishes an older reading (a period correction) re-bases the state without notices.
      const older = cursor?.read_at != null && reading.read_at < cursor.read_at;
      const prior = cursor?.reading_id == null ? null : { read_at: cursor.read_at!, pools: stored.map(pool => pool.pool) };
      if (!older) written = writeCreditNotices(db, card.provider, card.subject,
        poolChangeNotices(prior, { read_at: reading.read_at, pools: reading.pools }), now);
      replaceStoredPools(db, card.provider, card.subject, nextStoredPools(older ? [] : stored, reading.read_at, reading.pools));
    }
    writePoolCursor(db, card.provider, card.subject, reading && reading.id !== cursor?.reading_id
      ? { card_at: card.generated_at, reading_id: reading.id, read_at: reading.read_at }
      : { card_at: card.generated_at, reading_id: cursor?.reading_id ?? null, read_at: cursor?.read_at ?? null });
  }).immediate();
  return written;
}

/** Raises and resolves expiry warnings over the stored pools: a few rows, no readings. */
function expiryPass(db: Database, now: number): { notices: number; resolved: number } {
  const at = new Date(now).toISOString();
  let notices = 0, resolved = 0;
  db.transaction(() => {
    for (const { provider, account, pools } of readAllStoredPools(db)) {
      const drafts = expiryNotices(pools, now);
      notices += writeCreditNotices(db, provider, account, drafts, at);
      resolved += resolveExpiryNotices(db, provider, account, new Set(drafts.map(draft => draft.notice)), at);
    }
    // Accounts whose pools are all gone keep no state rows; their warnings resolve here too.
    const orphans = db.query(`SELECT DISTINCT provider,account FROM credit_notices n WHERE kind='expiring' AND resolved_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM credit_pool_state s WHERE s.provider=n.provider AND s.account=n.account)`).all() as
      Array<{ provider: string; account: string }>;
    for (const { provider, account } of orphans) resolved += resolveExpiryNotices(db, provider, account, new Set(), at);
  }).immediate();
  return { notices, resolved };
}

export function advanceCreditNotices(db: Database, options: CreditNoticeOptions): CreditNoticeResult {
  const result: CreditNoticeResult = { accounts: 0, notices: 0, resolved: 0, pending: false };
  if (!hasCreditNoticeSchema(db) || !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='current_probe_subjects'").get())
    return result;
  const canWrite = options.canWrite ?? (() => true), now = (options.now ?? Date.now)();
  const limit = options.limit ?? 50, at = new Date(now).toISOString();
  const cards = changedCards(db, options.providers ?? ["claude", "codex"], limit);
  result.pending = cards.length > limit;
  for (const card of cards.slice(0, limit)) {
    if (!canWrite()) { result.pending = true; return result; }
    result.notices += foldAccount(db, card, options, at);
    result.accounts++;
  }
  const last = lastExpiryPass.get(db);
  const due = result.accounts > 0 || last == null || now - last >= EXPIRY_PASS_MS;
  // Without pools or open warnings the pass has nothing to write and takes no writer transaction.
  const anything = () => !!db.query(`SELECT 1 FROM credit_pool_state UNION ALL
    SELECT 1 FROM credit_notices WHERE kind='expiring' AND resolved_at IS NULL LIMIT 1`).get();
  if (due && canWrite() && anything()) {
    const expiry = expiryPass(db, now);
    result.notices += expiry.notices; result.resolved += expiry.resolved;
    lastExpiryPass.set(db, now);
  }
  return result;
}
