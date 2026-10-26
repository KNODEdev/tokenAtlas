import type { Database } from "bun:sqlite";
import { SubscriptionFactsPending } from "./subscription-facts";
import { ledgerMoneyDecimal, sqlProvider, type UsageLedgerProvider } from "./usage-ledger";
import { usageLedgerProviderOf, usageLedgerReadiness } from "./usage-ledger-read";
import type { AccountReadPlan } from "../server/account-resolver";
import type { RateCard } from "../server/pricing";
import { reportedMoneyFromRaw, subscriptionAccountingAdapter, TOKEN_BUCKETS, type ReportedMoney, type SubscriptionAccountingAdapter,
  type SubscriptionEvent, type TokenBucket } from "../server/subscription-accounting-adapters";
import type { ClaudeCodeProductClass } from "../shared/claude-code-capacity";
import { currentProjectRules, placeSubject } from "../projects/rules-now";
import { PROJECT_TABLE_OF, type ProjectRules } from "../projects/resolve";

/**
 * Event-level reads of the usage ledger: the canonical facts of a range with their stored
 * valuations, for the readers that need per-call detail (the window sums' producer, subscription accounting
 * edges). It has the old fact index's interface (`load`, `stats`,
 * `dependencies`), but nothing here prices an event: the amounts are the ledger's.
 */
export interface StoredPrice {
  /** USD of a fully priced event; null when unpriced. */
  amount: number | null;
  /** Every computable bucket's USD, also for an unpriced event (the register's subtotal). */
  subtotal: number;
  /** Null when priced; the per-event pricing reason otherwise (`missing_rate`, `unknown_mode`, ...). */
  reason: string | null;
  /** USD per token bucket: quantity times the stored rate of the event's key; null for a missing rate. */
  costs: Record<TokenBucket, number | null>;
}
export type LedgerEvent = SubscriptionEvent & {
  /** Standard-mode and actual-mode API valuations; null on a row the plan cannot account. */
  prices: { standard: StoredPrice | null; actual: StoredPrice | null; global: StoredPrice };
};

type Row = Record<string, string | number | null>;
const instant = (value: string) => new Date(value).toISOString();
const dayOf = (value: string) => value.slice(0, 10);

type KeyRates = Map<number, Record<string, string | null> | null>;
function price(row: Row, prefix: string, keys: KeyRates): StoredPrice | null {
  if (row[`${prefix}_usd`] === null || row[`${prefix}_usd`] === undefined) return null;
  const rates = keys.get(Number(row[`${prefix}_key`])) ?? null;
  const quantities: Record<TokenBucket, number> = { in_uncached: Number(row.q_uncached), in_cache_read: Number(row.q_cache_read),
    in_cache_write_5m: Number(row.q_write_5m), in_cache_write_1h: Number(row.q_write_1h), in_cache_write_unknown: Number(row.q_write_unknown),
    out_total: Number(row.q_out) };
  const costs = Object.fromEntries(TOKEN_BUCKETS.map(bucket => {
    const rate = rates?.[bucket];
    return [bucket, quantities[bucket] === 0 ? 0 : rate == null || rate === "invalid" ? null
      : Number(ledgerMoneyDecimal(0, 0, BigInt(quantities[bucket]) * BigInt(rate)))];
  })) as Record<TokenBucket, number | null>;
  const value = Number(ledgerMoneyDecimal(row[`${prefix}_usd`]!, row[`${prefix}_nano`]!, row[`${prefix}_femto`]!));
  const stored = row[`${prefix}_reason`] as string | null;
  // The register records invalid counters before pricing; per call it is the cache-total check that failed.
  const reason = stored === "invalid_usage" ? "invalid_cache_totals" : stored;
  return { amount: reason === null ? value : null, subtotal: value, reason, costs };
}

function reportedOf(adapter: SubscriptionAccountingAdapter, row: Row): ReportedMoney | undefined {
  if (!adapter.reported) return undefined;
  const { unit, provenance } = adapter.reported;
  const money = reportedMoneyFromRaw(unit, provenance, row.m_reported_raw === null ? null : Number(row.m_reported_raw));
  return row.m_reported_conflict === 1 ? { usd: null, raw: null, unit, provenance, conflict: true } : money;
}

/**
 * The fact a canonical row describes, shaped as `subscriptionEventFromRow` shaped it. Its subject follows the project rules
 * at read time from the place of the call and the raw day of its timestamp (rules-now.ts), not the stored one.
 */
function eventOf(adapter: SubscriptionAccountingAdapter, row: Row, keys: KeyRates, rules: ProjectRules): LedgerEvent {
  const reported = reportedOf(adapter, row);
  return { account: null, source: row.source as string | null, account_key: row.account_key as string | null,
    ...(row.identity_conflict === 1 ? { identity_conflict: true as const } : {}),
    eligible: row.eligible === 1, vendor: String(row.vendor), ts: String(row.ts), model: row.model as string | null,
    home: String(row.home), identity: String(row.identity), source_id: String(row.source_id), speed: String(row.speed),
    quantities: { in_uncached: Number(row.q_uncached), in_cache_read: Number(row.q_cache_read), in_cache_write_5m: Number(row.q_write_5m),
      in_cache_write_1h: Number(row.q_write_1h), in_cache_write_unknown: Number(row.q_write_unknown), out_total: Number(row.q_out),
      out_thinking: Number(row.q_thinking) },
    usage_valid: row.usage_valid === 1, precise_time: row.precise_time === 1,
    ...(row.billing_mode === "grant" ? { funding: "grant" as const } : {}),
    ...(adapter.recordsProvenance ? { subject: placeSubject(rules, adapter.id, { home: row.home as string | null, cwd: row.cwd as string | null,
        project: row.project_name as string | null, repo: row.repo as string | null }, String(row.src_day)), session: row.session as string | null,
      repo: row.repo as string | null, repo_group: row.repo_group as string | null } : {}),
    ...(adapter.product ? { product: (row.m_product ?? row.product) as ClaudeCodeProductClass } : {}),
    ...(reported ? { reported } : {}),
    prices: { standard: price(row, "std", keys), actual: price(row, "act", keys), global: price(row, "glb", keys)! } };
}

/**
 * The provider's events for an account plan (or the whole provider without one). Throws
 * `SubscriptionFactsPending` while the ledger is not ready, as the old index did.
 */
export function usageLedgerEvents(db: Database, provider: UsageLedgerProvider, card: RateCard, plan: AccountReadPlan | null = null) {
  // The reason readers report: preparation, rules pending after a card change, unsupported card.
  const readiness = usageLedgerReadiness(db, provider, card);
  if (readiness.state !== "ready")
    throw new SubscriptionFactsPending(`Usage ledger is awaiting background preparation (${readiness.reason})`, provider);
  const P = sqlProvider(provider), prefix = `usage-ledger:${provider}`, rules = currentProjectRules(db);
  /** A fact's project by the rules (projects/resolve.ts) over its place and raw day, once per place; Gemini's calls have none. */
  const table = PROJECT_TABLE_OF[provider];
  const projectOf = (row: { home: unknown; cwd: unknown; project_name: unknown; repo: unknown; src_day: unknown }) => table
    ? rules.projectOf(table, { store: row.home as string | null, cwd: row.cwd as string | null, project: row.project_name as string | null,
      repo: row.repo as string | null }, String(row.src_day)) : null;
  const assign = (event: LedgerEvent, ineligible: boolean): LedgerEvent | null => {
    if (!event.eligible && !ineligible) return null;
    if (!plan) return event;
    if (!plan.owns(event.source, event.account_key, event.ts)) return null;
    event.account = plan.account;
    return event;
  };
  function identityCopies(from: string, until: string, project?: string): Array<{ ts: string; duplicates: number; conflict: boolean }> {
    const lower = instant(from), upper = instant(until);
    // With a project, the identities with a copy of it in range are chosen first, by the rules over each copy's place.
    const chosen = project === undefined ? null : JSON.stringify([...new Set((db.query(`SELECT b.identity, b.home, b.cwd, b.project_name, b.repo, b.src_day
        FROM usage_ledger_facts b INDEXED BY usage_ledger_facts_day_${provider}
        WHERE b.provider=${P} AND b.day>=? AND b.day<=? AND b.ts>=? AND b.ts<?`).all(dayOf(lower), dayOf(upper), lower, upper) as
      Array<{ identity: string; home: string; cwd: string | null; project_name: string | null; repo: string | null; src_day: string }>)
      .filter(row => projectOf(row) === project).map(row => row.identity))]);
    const rows = db.query(`SELECT a.identity, COUNT(*) copies, MIN(a.fingerprint)<>MAX(a.fingerprint) conflict, MIN(a.ts) ts,
        MIN(CASE WHEN a.ts>=? AND a.ts<? THEN a.ts END) first,
        (SELECT k.source FROM usage_ledger_facts k INDEXED BY usage_ledger_facts_identity_${provider}
          WHERE k.provider=${P} AND k.identity=a.identity ORDER BY k.source_key LIMIT 1) source,
        (SELECT k.account_key FROM usage_ledger_facts k INDEXED BY usage_ledger_facts_identity_${provider}
          WHERE k.provider=${P} AND k.identity=a.identity ORDER BY k.source_key LIMIT 1) account_key
      FROM usage_ledger_facts a INDEXED BY usage_ledger_facts_identity_${provider}
      WHERE a.provider=${P} AND a.eligible=1 AND a.identity IN (SELECT b.identity FROM usage_ledger_facts b INDEXED BY usage_ledger_facts_day_${provider}
        WHERE b.provider=${P} AND b.day>=? AND b.day<=? AND b.ts>=? AND b.ts<? ${chosen === null ? "" : "AND b.identity IN (SELECT value FROM json_each(?))"})
      GROUP BY a.identity`).all(lower, upper, dayOf(lower), dayOf(upper), lower, upper, ...(chosen === null ? [] : [chosen])) as
      Array<{ copies: number; conflict: number; ts: string; first: string | null; source: string | null; account_key: string | null }>;
    // Ownership follows the identity's earliest copy, as it always has; the running position is its first copy in range.
    return (plan ? rows.filter(row => plan.owns(row.source, row.account_key, row.ts)) : rows)
      .map(row => ({ ts: row.first ?? row.ts, duplicates: row.copies - 1, conflict: row.conflict === 1 }));
  }
  return {
    scope: prefix,
    /** Canonical events of `[from, until)`, ordered by instant then copy key as text; scan bounds are accepted for compatibility. */
    load(from: string, until: string, _scanFrom?: string, _scanUntil?: string, project?: string, ineligible = false): LedgerEvent[] {
      const lower = instant(from), upper = instant(until);
      const rows = db.query(`SELECT * FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_${provider}
        WHERE provider=${P} AND day>=? AND day<=? AND ts>=? AND ts<? AND copy_state='canonical' ORDER BY ts, source_key`)
        .all(dayOf(lower), dayOf(upper), lower, upper) as Row[];
      const keys: KeyRates = new Map((db.query("SELECT id,rates FROM usage_ledger_keys WHERE provider=?").all(provider) as
        Array<{ id: number; rates: string }>).map(key => [key.id, JSON.parse(key.rates || "null")]));
      const events: LedgerEvent[] = [];
      const adapter = subscriptionAccountingAdapter(provider);
      for (const row of rows) {
        // The same test `assign` makes, on the raw row first: another account's calls are never decoded or priced.
        if (row.eligible !== 1 && !ineligible || plan && !plan.owns(row.source as string | null, row.account_key as string | null, String(row.ts))) continue;
        if (project !== undefined && projectOf(row as Parameters<typeof projectOf>[0]) !== project) continue;
        const event = assign(eventOf(adapter, row, keys, rules), ineligible); if (event) events.push(event);
      }
      return events;
    },
    /** Duplicate copies and conflicted identities among the plan's eligible identities with a copy in range. */
    stats(from: string, until: string, project?: string): { duplicates: number; conflicts: number } {
      const owned = identityCopies(from, until, project);
      return { duplicates: owned.reduce((sum, row) => sum + row.duplicates, 0), conflicts: owned.filter(row => row.conflict).length };
    },
    /**
     * The same identities one by one: the first instant of a copy in range (where a running sum meets the
     * identity), its extra copies and whether the copies disagree.
     */
    identityCopies(from: string, until: string): Array<{ ts: string; duplicates: number; conflict: boolean }> {
      return identityCopies(from, until);
    },
    /**
     * The last instant of each listed session strictly before `before`, over the same calls `load` returns
     * (canonical, eligible, owned by the plan). Reads four columns only: no decoding or pricing of the calls.
     */
    sessionLastBefore(sessions: Iterable<string>, before: string): Map<string, string> {
      const found = new Map<string, string>(), pending = new Set(sessions);
      if (!pending.size || !subscriptionAccountingAdapter(provider).recordsProvenance) return found;
      const upper = instant(before);
      const rows = db.query(`SELECT session, ts, source, account_key FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_${provider}
        WHERE provider=${P} AND day<=? AND ts<? AND copy_state='canonical' AND eligible=1 AND session IS NOT NULL`)
        .all(dayOf(upper), upper) as Array<{ session: string; ts: string; source: string | null; account_key: string | null }>;
      for (const row of rows) {
        if (!pending.has(row.session) || plan && !plan.owns(row.source, row.account_key, row.ts)) continue;
        const current = found.get(row.session);
        if (current === undefined || row.ts > current) found.set(row.session, row.ts);
      }
      return found;
    },
    /** Earliest recorded instant of any copy of the provider, as the old index's `MIN(ts)` over its live versions. */
    firstInstant(): string | null {
      return (db.query(`SELECT MIN(ts) ts FROM usage_ledger_facts WHERE provider=${P}`).get() as { ts: string | null }).ts;
    },
    /** Days of `[since, until]` on which any copy of the provider was recorded. */
    factDays(since: string, until: string): string[] {
      return (db.query(`SELECT DISTINCT day FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_${provider}
        WHERE provider=${P} AND day>=? AND day<=? ORDER BY day`).all(since, until) as Array<{ day: string }>).map(row => row.day);
    },
  };
}
/** `usageLedgerEvents` for a provider name or alias of the four ledger providers. */
export function usageLedgerEventsFor(db: Database, provider: string, card: RateCard, plan: AccountReadPlan | null = null) {
  const id = usageLedgerProviderOf(provider);
  if (!id) throw new Error(`No usage ledger for provider '${provider}'`);
  return usageLedgerEvents(db, id, card, plan);
}
export type UsageLedgerEvents = ReturnType<typeof usageLedgerEvents>;
