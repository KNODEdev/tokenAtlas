import { DecimalSum, subtractDecimalAmounts } from "./decimal-amount";

/**
 * Notices about subscription extras ("pakiety"): what arrived, what was spent or used, and what is about to
 * expire unused. They are derived from two consecutive pool states of one account (see shared/credit-pools,
 * whose `CreditPoolState` these structural types accept unchanged) and from the stored state alone as time
 * passes; never from a scan of reading history. Design: docs/credit-notices-2026-10-09.md.
 */

export interface NoticePoolItem {
  id: string;
  status: string | null;
  granted_at: string | null;
  expires_at: string | null;
  title: string | null;
}

/** One pool at one reading; structurally a `CreditPoolState`. */
export interface NoticePool {
  key: string;
  kind: "grant" | "purchase" | "balance" | "resets";
  unit: "usd" | "credits" | "resets";
  granted: number | null;
  used: number | null;
  remaining: number | null;
  remaining_text: string | null;
  unlimited: boolean;
  granted_at: string | null;
  expires_at: string | null;
  items: NoticePoolItem[] | null;
}

export interface PoolReading { read_at: string; pools: readonly NoticePool[] }

/** A pool as stored between readings: its last state and the first observation its pace is measured from. */
export interface StoredPool {
  identity: string;
  pool: NoticePool;
  read_at: string;
  baseline_at: string;
  baseline_used: number | null;
}

export type CreditNoticeKind = "received" | "topped_up" | "used" | "spent" | "expiring" | "expired_unused";
export const CREDIT_NOTICE_KINDS: readonly CreditNoticeKind[] = ["received", "topped_up", "used", "spent", "expiring", "expired_unused"];

export interface CreditNoticeDraft {
  /** Identity within the account: `<pool identity>|<kind>|<ref>`; writing the same draft twice is one notice. */
  notice: string;
  pool: string;
  kind: CreditNoticeKind;
  unit: NoticePool["unit"];
  /** Positive amount of the notice in its unit; `amount_text` is exact when the vendor sent decimal text. */
  amount: number | null;
  amount_text: string | null;
  expires_at: string | null;
  /** Reading time the notice rests on (expiry notices: the reading their remaining amount comes from). */
  observed_at: string;
  detail: Record<string, string | number | boolean | null>;
}

const DAY = 86_400_000;
/** A pool first seen on an account with no earlier pool reading is a baseline, unless its items state a grant this recent. */
export const FIRST_SIGHT_RECENT_MS = 7 * DAY;
/** Grants warn twice before expiry (the earlier stage is resolved by the later); a free reset once. */
export const GRANT_EXPIRY_STAGES = [{ stage: "3d", ms: 3 * DAY }, { stage: "14d", ms: 14 * DAY }] as const;
export const RESET_EXPIRY_MS = 3 * DAY;
/** Pace needs at least this span of observation; shorter, the whole remaining amount is at risk. */
export const PACE_MIN_SPAN_MS = DAY;

const time = (value: string | null) => value == null ? NaN : Date.parse(value);
const isAvailable = (item: NoticePoolItem) => item.status == null || item.status === "available";

/** A grant renewed under the same meter with a new expiry is a new grant; other pools are one per key. */
export function poolIdentity(pool: NoticePool): string {
  return pool.kind === "grant" ? `${pool.key}@${pool.expires_at ?? ""}` : pool.key;
}

const draft = (identity: string, pool: NoticePool, kind: CreditNoticeKind, ref: string, observed_at: string,
  amount: number | null, extra: Partial<CreditNoticeDraft> = {}): CreditNoticeDraft => ({
  notice: `${identity}|${kind}|${ref}`, pool: identity, kind, unit: pool.unit, amount, amount_text: null,
  expires_at: pool.expires_at, observed_at, detail: {}, ...extra,
});

function itemDraft(identity: string, pool: NoticePool, kind: CreditNoticeKind, item: NoticePoolItem, at: string): CreditNoticeDraft {
  return draft(identity, pool, kind, item.id, at, 1, { expires_at: item.expires_at,
    detail: { title: item.title, granted_at: item.granted_at } });
}

/** Free resets that appeared and disappeared between two item lists; a reset gone at or after its expiry was lost. */
function resetChanges(identity: string, pool: NoticePool, before: readonly NoticePoolItem[], after: readonly NoticePoolItem[],
  at: string): CreditNoticeDraft[] {
  const known = new Set(before.map(item => item.id)), now = new Set(after.map(item => item.id));
  const drafts = after.filter(item => !known.has(item.id)).map(item => itemDraft(identity, pool, "received", item, at));
  for (const item of before) {
    if (now.has(item.id)) continue;
    const lost = item.expires_at != null && time(item.expires_at) <= time(at);
    drafts.push(itemDraft(identity, pool, lost ? "expired_unused" : "used", item, at));
  }
  return drafts;
}

/**
 * The notices of one account between its previous pool reading and the next. With no previous reading
 * (`prior` null: a new database, an account first probed) only free resets granted within
 * FIRST_SIGHT_RECENT_MS count as received; everything else is the baseline, so a rebuild does not replay
 * every grant ever seen.
 */
export function poolChangeNotices(prior: PoolReading | null, next: PoolReading): CreditNoticeDraft[] {
  const at = next.read_at;
  const before = new Map((prior?.pools ?? []).map(pool => [poolIdentity(pool), pool]));
  const drafts: CreditNoticeDraft[] = [];
  for (const pool of next.pools) {
    const identity = poolIdentity(pool), old = before.get(identity);
    before.delete(identity);
    if (!old) {
      if (!prior) {
        if (pool.kind === "resets") drafts.push(...(pool.items ?? [])
          .filter(item => isAvailable(item) && time(at) - time(item.granted_at) <= FIRST_SIGHT_RECENT_MS)
          .map(item => itemDraft(identity, pool, "received", item, at)));
        continue;
      }
      if (pool.kind === "resets") drafts.push(...resetChanges(identity, pool, [], (pool.items ?? []).filter(isAvailable), at));
      // A grant's identity already names its expiry; a balance or purchase may return after it ran out.
      else drafts.push(draft(identity, pool, "received", pool.kind === "grant" ? "" : at, at, pool.granted ?? pool.remaining,
        { amount_text: pool.kind === "balance" ? pool.remaining_text : null, detail: { remaining: pool.remaining } }));
      continue;
    }
    if (pool.kind === "resets") {
      drafts.push(...resetChanges(identity, pool, (old.items ?? []).filter(isAvailable), (pool.items ?? []).filter(isAvailable), at));
      continue;
    }
    if (pool.unlimited || old.unlimited) continue;
    if (pool.kind === "balance") {
      if (pool.remaining_text == null || old.remaining_text == null) continue;
      const delta = subtractDecimalAmounts(pool.remaining_text, old.remaining_text);
      if (delta === "0") continue;
      const up = !delta.startsWith("-"), amount = up ? delta : delta.slice(1);
      drafts.push(draft(identity, pool, up ? "topped_up" : "spent", up ? at : "", at, Number(amount),
        { amount_text: amount, detail: { remaining: pool.remaining, remaining_text: pool.remaining_text } }));
      continue;
    }
    // Grants and purchased extra usage state their limit and use.
    if (old.granted != null && pool.granted != null && pool.granted > old.granted)
      drafts.push(draft(identity, pool, "topped_up", at, at, pool.granted - old.granted, { detail: { granted: pool.granted } }));
    if (old.used != null && pool.used != null && pool.used > old.used)
      drafts.push(draft(identity, pool, "spent", "", at, pool.used - old.used, { detail: { remaining: pool.remaining } }));
    // A meter still reported after its expiry states what was left at that point.
    if (pool.kind === "grant" && time(pool.expires_at) <= time(at) && (pool.remaining ?? 0) > 0)
      drafts.push(draft(identity, pool, "expired_unused", "", at, pool.remaining, { detail: { granted: pool.granted, upper_bound: false } }));
  }
  // Pools the next reading no longer carries. Only a grant past its expiry with something left is news; a
  // grant gone earlier was used up or withdrawn, and the amount at its last reading is an upper bound.
  for (const [identity, old] of before) {
    if (old.kind === "resets") drafts.push(...resetChanges(identity, old, (old.items ?? []).filter(isAvailable), [], at));
    else if (old.kind === "grant" && old.expires_at != null && time(old.expires_at) <= time(at) && (old.remaining ?? 0) > 0)
      drafts.push(draft(identity, old, "expired_unused", "", at, old.remaining,
        { detail: { granted: old.granted, last_seen: prior!.read_at, upper_bound: true } }));
  }
  return drafts;
}

export interface GrantOutlook {
  remaining: number;
  days_left: number;
  /** Use per day since the pool's first observation; null while observed for less than PACE_MIN_SPAN_MS. */
  pace_per_day: number | null;
  /** What the current pace leaves unused at expiry (the whole remainder without a pace). */
  projected_unused: number;
}

/** Remaining amount, time left and projected unused amount of a grant at `now`; null without the needed facts. */
export function grantOutlook(stored: StoredPool, now: number): GrantOutlook | null {
  const { pool } = stored;
  const expires = time(pool.expires_at), read = time(stored.read_at), since = time(stored.baseline_at);
  if (pool.remaining == null || !Number.isFinite(expires) || expires <= now) return null;
  const span = read - since;
  const pace = pool.used != null && stored.baseline_used != null && span >= PACE_MIN_SPAN_MS
    ? Math.max(0, pool.used - stored.baseline_used) / span : null;
  // The remainder was read at `read_at`; use continues at the pace until expiry.
  const projected = pace == null ? pool.remaining : Math.max(0, pool.remaining - pace * (expires - read));
  return { remaining: pool.remaining, days_left: (expires - now) / DAY, pace_per_day: pace == null ? null : pace * DAY,
    projected_unused: projected };
}

/** A grant warns while its projected unused part is at least a dollar and 5% of the grant. */
export const grantAtRisk = (pool: NoticePool, projected: number) =>
  projected >= Math.max(1, 0.05 * (pool.granted ?? pool.remaining ?? 0));

/**
 * The expiry warnings that hold at `now` over the stored pools of one account. A writer raises the ones
 * missing and resolves stored warnings no longer in the list (used up, expired, gone).
 */
export function expiryNotices(pools: readonly StoredPool[], now: number): CreditNoticeDraft[] {
  const drafts: CreditNoticeDraft[] = [];
  for (const stored of pools) {
    const { pool, identity } = stored;
    if (pool.kind === "resets") {
      for (const item of pool.items ?? []) {
        const left = time(item.expires_at) - now;
        if (isAvailable(item) && left > 0 && left <= RESET_EXPIRY_MS)
          drafts.push({ ...itemDraft(identity, pool, "expiring", item, stored.read_at), notice: `${identity}|expiring|${item.id}` });
      }
      continue;
    }
    if (pool.kind !== "grant") continue;
    const outlook = grantOutlook(stored, now);
    if (!outlook || !grantAtRisk(pool, outlook.projected_unused)) continue;
    const stage = GRANT_EXPIRY_STAGES.find(entry => outlook.days_left * DAY <= entry.ms);
    if (!stage) continue;
    drafts.push(draft(identity, pool, "expiring", stage.stage, stored.read_at, outlook.projected_unused,
      { detail: { stage: stage.stage, granted: pool.granted, remaining: outlook.remaining,
        pace_per_day: outlook.pace_per_day, days_left: outlook.days_left } }));
  }
  return drafts;
}

/** Adds a spent amount to a stored one, exactly when both are decimal text. */
export function addSpent(stored: { amount: number | null; amount_text: string | null }, next: CreditNoticeDraft) {
  if (stored.amount_text != null && next.amount_text != null) {
    const sum = new DecimalSum();
    sum.add(stored.amount_text); sum.add(next.amount_text);
    const text = sum.toString();
    return { amount: Number(text), amount_text: text };
  }
  return { amount: (stored.amount ?? 0) + (next.amount ?? 0), amount_text: null };
}

/** One open notice as `/api/credit-notices` sends it; `label` is the subscription's name. */
export interface CreditNoticeView {
  id: number;
  provider: string;
  account: string;
  label: string;
  /** Pool identity (`claude:<meter>@<expiry>`, `codex:credits`, …). */
  pool: string;
  kind: CreditNoticeKind;
  unit: NoticePool["unit"];
  amount: number | null;
  amount_text: string | null;
  expires_at: string | null;
  observed_at: string;
  detail: Record<string, string | number | boolean | null>;
}
