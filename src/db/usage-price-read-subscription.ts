import type { Database } from "bun:sqlite";
import { analysisHash } from "./analysis";
import { decodeCounts, decodeQuality, decodeTokens } from "./usage-price-measures";
import { PRICE_TOTAL_ARITHMETIC, subscriptionRulesDigest, USAGE_PRICE_TOTALS_VERSION,
  type UsagePriceAmount } from "./usage-price-totals";
import { readRegisterDays } from "./usage-price-read-account";
import { usageLedgerConflictedIdentities, usageLedgerDayBounds, usageLedgerProviderOf, usageLedgerReadiness } from "./usage-ledger-read";
import { addDecimalAmounts } from "../shared/decimal-amount";
import { CODEX_CANONICAL_COPY_POLICY } from "./codex-ledger-canonical";
import type { AccountResolver } from "../server/account-resolver";
import { subscriptionAccountingAdapter, TOKEN_BUCKETS, type TokenBucket } from "../server/subscription-accounting-adapters";
import type { RateCard } from "../server/pricing";
import { readCodexLedgerState } from "./codex-ledger-state";
import { CODEX_LEDGER_SCOPE, codexLedgerPendingReason, readPublishedCodexLedgerContext,
  readCodexLedgerOwnedSeries, readCodexLedgerCompatibilityDays, sumCodexLedgerCompatibilityAmounts,
  type CodexLedgerReadContext } from "./codex-ledger-adapters";

/**
 * Day readers of priced usage: the usage ledger for Claude, Gemini, Grok and GLM, the Codex price
 * ledger for Codex, both through `readRegisterDays`. Aggregates only: no preparation, no event
 * scan and no valuation call, so an ordinary screen read never waits behind a historical rebuild
 * (golden rules §5, §9). Day and dimension rows are read for the requested range only (§10).
 */

type Head = {
  scope: string; provider: string; version: number; cursor: number;
  phase: string; status: string; rules_digest: string; sources: string;
  mirror_policy: number;
};

export type UsagePriceReadiness =
  /** The register was never prepared on this database; the caller may use its legacy path. */
  | { state: "absent"; head: null; reason: "usage-price-register-absent" }
  /** Prepared, but not current for this configuration. Never a silent partial number. */
  | { state: "pending"; head: Head | null; reason: string }
  | { state: "ready"; head: Head; reason: null };

export interface UsagePriceQuality {
  duplicates: number;
  /** Per identity and day, so a day's calls can be corrected by it. */
  conflicts: number;
  /** Per identity, once on its earliest day: the measure `factIndex.stats()` reports. */
  conflicted_identities: number;
  approximate_time_events: number;
  invalid_token_events: number; unattributed_events: number; unknown_speed_tokens: number;
}
/** One register day for one dimension tuple, with the subject dimension already applied. */
export interface UsagePriceDay {
  day: string;
  account: string | null;
  /** The archive folder the traffic was recorded in (`home` of earlier versions). */
  home: string | null;
  model: string | null; speed: string | null;
  calls: number;
  tokens: Record<TokenBucket, number>;
  /** `out_thinking`: nested inside `out_total`, never added to a disjoint total (§7). */
  reasoning: number;
  standard: UsagePriceAmount; actual: UsagePriceAmount;
  quality: UsagePriceQuality;
}
export interface UsagePriceDayFilter {
  account: string;
  /** Local project id; matched against the register's `p:<project_id>` subject dimension. */
  project?: string;
  since: string; until: string;
}

const QUALITY_KEYS = ["duplicates", "conflicts", "conflicted_identities", "approximate_time_events",
  "invalid_token_events", "unattributed_events", "unknown_speed_tokens"] as const;

/**
 * Global usage's ordering-key comparison. Its pre-register path scanned `ORDER BY ts` over a
 * rowid table, so two rows of one instant came out in *numeric* row order — unlike the
 * subscription fact path, whose `source_key` is compared as text. Two integer keys are therefore
 * compared as numbers here, and anything else as text so the order stays total.
 */
const orderedBefore = (left: string, right: string): boolean => {
  const a = Number(left), b = Number(right);
  if (left !== "" && right !== "" && Number.isSafeInteger(a) && Number.isSafeInteger(b)) return a < b;
  return left < right;
};

const emptyTokens = (): Record<TokenBucket, number> =>
  Object.fromEntries(TOKEN_BUCKETS.map(key => [key, 0])) as Record<TokenBucket, number>;
const emptyQuality = (): UsagePriceQuality =>
  Object.fromEntries(QUALITY_KEYS.map(key => [key, 0])) as unknown as UsagePriceQuality;

type StoredAmount = Omit<UsagePriceAmount, "value">;
export type { UsagePriceAmount };

/**
 * The producer's subscription rules digest. It is the producer's own definition rather than a
 * copy of it: a second copy could drift, and a drifted digest either prices from a superseded
 * card or reports "rules pending" forever.
 */
export function subscriptionUsagePriceRulesDigest(card: RateCard, provider: string): string {
  return subscriptionRulesDigest(card, provider);
}

/**
 * Providers whose register rows carry the subject dimension.
 *
 * `subscriptionEventFromRow` attaches recorded provenance for Claude, Grok and GLM only, so a
 * Gemini day row has `subject = NULL` while the usage ledger's facts still hold the raw project
 * column a project-filtered report matches on; that filter is answered from the ledger's events.
 */
export const USAGE_PRICE_SUBJECT_PROVIDERS: ReadonlySet<string> = new Set(["claude", "grok", "glm"]);

/** First and last register day of a provider: the usage ledger's for Claude, Gemini, Grok and GLM. */
export function registerDayBounds(db: Database, provider: string, scope: string): { since: string | null; until: string | null } {
  const ledgerProvider = usageLedgerProviderOf(provider);
  return ledgerProvider ? usageLedgerDayBounds(db, ledgerProvider) : { since: null, until: null };
}

/** Whether the subscription registers can price with this card: they record USD per million tokens only. */
export function usagePriceCardSupported(card: RateCard): boolean {
  return currency(card);
}
function currency(card: RateCard): boolean {
  return card.currency === "USD" && ["per 1M", "USD per 1,000,000 tokens"].includes(card.unit);
}

/**
 * Readiness of one provider scope. `absent` means the register has never run here, which is
 * the only state in which a caller may fall back to its pre-register path; every other
 * not-ready state is explicit, so the background producer owns the repair (§5, §8).
 */
export function subscriptionUsagePriceReadiness(db: Database, provider: string, card: RateCard): UsagePriceReadiness {
  const ledgerProvider = usageLedgerProviderOf(provider);
  return ledgerProvider ? usageLedgerReadiness(db, ledgerProvider, card) : { state: "absent", head: null, reason: "usage-price-register-absent" };
}

/** Codex readiness. `sourceHomes` is verified only when the caller knows the declared list. */
export function codexUsagePriceReadiness(db: Database,
  options: { rulesDigest?: string; sourcesStamp?: string; rulesRevision?: string;
    range?: import("./codex-price-ledger").LedgerRange; policy?: import("../server/codex-ledger-policy").CompiledCodexLedgerPolicy }): UsagePriceReadiness {
  const state = readCodexLedgerState(db);
  if (!state && !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) {
    return { state: "pending", head: null, reason: "usage-price-inputs-unavailable" };
  }
  const head: Head | null = state ? { scope: CODEX_LEDGER_SCOPE, provider: "codex", version: USAGE_PRICE_TOTALS_VERSION,
    cursor: state.covered, phase: "ledger", status: state.status,
    rules_digest: state.rules_digest, sources: options.sourcesStamp ?? "", mirror_policy: CODEX_CANONICAL_COPY_POLICY } : null;
  const reason = codexLedgerPendingReason(db, options);
  // A missing ledger is preparation work, never permission to reprice history during a read.
  return reason ? { state: "pending", head, reason } : { state: "ready", head: head!, reason: null };
}

/** The Codex mirror source-home stamp, as `usage-price-totals.ts` records it. */
export { usagePriceSourcesStamp } from "./usage-price-totals";

const storedAmount = (): StoredAmount => ({ subtotal: "0", pricedSubtotal: "0", pricedEvents: "0",
  unpricedEvents: "0", pricedTokens: "0", unpricedTokens: "0", reasons: {} });

function addStored(target: StoredAmount, incoming: StoredAmount | undefined): void {
  if (!incoming) return;
  target.subtotal = addDecimalAmounts(target.subtotal, incoming.subtotal);
  target.pricedSubtotal = addDecimalAmounts(target.pricedSubtotal, incoming.pricedSubtotal);
  for (const key of ["pricedEvents", "unpricedEvents", "pricedTokens", "unpricedTokens"] as const)
    target[key] = String(BigInt(target[key]) + BigInt(incoming[key] ?? "0"));
  for (const [reason, counted] of Object.entries(incoming.reasons)) {
    const prior = target.reasons[reason] ?? { events: "0", tokens: "0" };
    target.reasons[reason] = { events: String(BigInt(prior.events) + BigInt(counted.events)),
      tokens: String(BigInt(prior.tokens) + BigInt(counted.tokens)) };
  }
}
/** A total is a value only when every one of its events carries a price (§8). */
function seal(amount: StoredAmount): UsagePriceAmount {
  return { ...amount, value: amount.unpricedEvents === "0" ? amount.subtotal : null };
}

/** Exact decimal sum of register amounts; report-level totals never round per group. */
export function sumUsagePriceAmounts(rows: Iterable<UsagePriceAmount>): UsagePriceAmount {
  const values = [...rows];
  if (values.some(value => value.exact)) return sumCodexLedgerCompatibilityAmounts(values);
  const total = storedAmount();
  for (const row of values) addStored(total, row);
  return seal(total);
}

/**
 * Daily register rows for one account, optionally one project, over the account's periods.
 *
 * Conflicting identities are represented in the register by a marker row: one call, no
 * tokens, no amounts, `quality.conflicts`. Their calls are subtracted here so a conflict
 * never reaches the report as traffic, exactly as `uniqueEvents` excluded it before.
 */
export function readSubscriptionUsagePriceDays(db: Database, provider: string, scope: string,
  filter: UsagePriceDayFilter, resolver: AccountResolver): UsagePriceDay[] {
  const account = filter.account.toLowerCase();
  const subject = filter.project === undefined ? null : `p:${filter.project}`;
  const rows = readRegisterDays(db, scope, provider, resolver, { since: filter.since, until: filter.until })
    .filter(row => row.account === account && row.vendor === null && (subject === null || row.subject === subject));
  type Accumulator = Omit<UsagePriceDay, "standard" | "actual">
    & { standard: StoredAmount; actual: StoredAmount; first: string; firstKey: string };
  const totals = new Map<string, Accumulator>();
  for (const row of rows) {
    const quality = decodeQuality(row.quality);
    const conflicts = Number(quality.conflicts ?? "0");
    const calls = row.calls - conflicts;
    const key = JSON.stringify([row.day, row.model, row.speed, row.source]);
    const current = totals.get(key) ?? { day: row.day, account: row.account, home: row.source,
      model: row.model, speed: row.speed, calls: 0, tokens: emptyTokens(), reasoning: 0,
      standard: storedAmount(), actual: storedAmount(), quality: emptyQuality(), first: "", firstKey: "" };
    current.calls += calls;
    if (row.first_ts && (!current.first
      || row.first_ts < current.first || (row.first_ts === current.first && row.first_key < current.firstKey))) {
      current.first = row.first_ts; current.firstKey = row.first_key;
    }
    for (const bucket of QUALITY_KEYS) current.quality[bucket] += Number(quality[bucket] ?? "0");
    if (calls > 0) {
      const tokens = decodeTokens(row.tokens);
      for (const bucket of TOKEN_BUCKETS) current.tokens[bucket] += Number(tokens[bucket] ?? "0");
      current.reasoning += Number(tokens.reasoning_out ?? "0");
      const counts = decodeCounts(row.counts);
      addStored(current.standard, counts.api_standard);
      addStored(current.actual, counts.api_actual);
    }
    totals.set(key, current);
  }
  // Report rows are rendered in this order: groups appear by their first event, as the per-event
  // path produced them. That path ordered its events by `(ts, source_key)` compared as text, so
  // two groups whose first events share an instant are separated by the recorded copy's key -
  // `"10"` before `"2"` - and only then by the keys that make the rest deterministic.
  return [...totals.values()]
    .sort((a, b) => a.day.localeCompare(b.day) || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0)
      || (a.firstKey < b.firstKey ? -1 : a.firstKey > b.firstKey ? 1 : 0)
      || (a.model ?? "").localeCompare(b.model ?? "")
      || (a.speed ?? "").localeCompare(b.speed ?? "") || (a.home ?? "").localeCompare(b.home ?? ""))
    .map(({ first: _first, firstKey: _firstKey, ...row }): UsagePriceDay =>
      ({ ...row, standard: seal(row.standard), actual: seal(row.actual) }));
}

/* ------------------------------------------------------------------------------------------ */
/* Global usage (WP4f): every account of a provider plus the traffic none of them owns.          */
/* ------------------------------------------------------------------------------------------ */

export interface GlobalUsagePriceRow {
  day: string;
  /** The rate vendor global usage reports the row under. */
  vendor: string;
  account: string | null;
  model: string | null;
  calls: number;
  /** First recorded instant of the group, which is the order the event path emitted rows in. */
  first_ts: string;
  /** Ordering key of that first event: the source row id, which global usage compares numerically. */
  first_key: string;
  input: number; cache_read: number; cache_write: number; output: number;
  /** Sum over fully priced events only, exactly what `addAmount` accumulated per event. */
  priced_subtotal: string;
  priced_events: number; unpriced_events: number;
}
export interface GlobalUsagePriceDays {
  rows: GlobalUsagePriceRow[];
  /** Recorded source rows scanned, duplicates and conflicts included. */
  events: number;
  excluded_duplicates: number;
  conflicting_events: number;
  approximate_time_events: number;
}

/**
 * Global usage's own view of one provider scope over whole days: the accounts' own contributions
 * and the unassigned track's, together, with the counters the response reports.
 *
 * `excluded_duplicates` is derived rather than stored: every scanned row is either accepted,
 * excluded as a duplicate, or the one copy a conflicted identity loses along with its duplicates.
 * So `scanned - accepted - conflicted identities` is the exclusion count, for an accepted
 * identity (`n - 1 - 0`) and a conflicted one (`n - 0 - 1`) alike.
 *
 * The conflicted identities of the range are counted, not summed. A conflicted identity is
 * marked once, on its earliest day, because it is one identity however many days its copies fall
 * on; summing that column over a range that excludes the earliest day would report the copies it
 * does cover as ordinary duplicates, which is the wrong reason for the same number of rows. The
 * markers are the only contributions with an empty dependency, and there is one per identity and
 * day, so counting the distinct identities among them is exact for any range.
 */
export function readGlobalUsagePriceDays(db: Database, provider: string, scope: string,
  range: { since: string; until: string }, resolver: AccountResolver): GlobalUsagePriceDays {
  const adapter = subscriptionAccountingAdapter(provider);
  const ledgerProvider = usageLedgerProviderOf(adapter.id);
  const conflicted = ledgerProvider ? usageLedgerConflictedIdentities(db, ledgerProvider, range.since, range.until) : 0;
  const rows = readRegisterDays(db, scope, provider, resolver, range);
  type Accumulator = Omit<GlobalUsagePriceRow, "priced_subtotal" | "priced_events" | "unpriced_events">
    & { amount: StoredAmount };
  const totals = new Map<string, Accumulator>();
  let events = 0, accepted = 0, attribution = 0, approximate = 0;
  for (const row of rows) {
    const quality = decodeQuality(row.quality);
    events += Number(quality.source_events ?? "0");
    attribution += Number(quality.attribution_conflicts ?? "0");
    approximate += Number(quality.approximate_time_events ?? "0");
    const calls = row.calls - Number(quality.conflicts ?? "0");
    accepted += calls;
    if (calls <= 0) continue;
    // A contribution the provider's own track owns carries no vendor: global usage names it by
    // the adapter, and for Gemini by the model, exactly as the per-event path named it.
    const vendor = row.vendor ?? (adapter.id === "gemini" ? row.model?.startsWith("claude-") ? "anthropic" : "google"
      : adapter.rateVendor);
    const account = row.vendor !== null && row.vendor !== adapter.rateVendor ? null : row.account;
    const key = JSON.stringify([row.day, vendor, account, row.model]);
    const current = totals.get(key) ?? { day: row.day, vendor, account, model: row.model,
      calls: 0, first_ts: row.first_ts, first_key: row.first_key, input: 0, cache_read: 0,
      cache_write: 0, output: 0, amount: storedAmount() };
    if (row.first_ts && (!current.first_ts
      || row.first_ts < current.first_ts
      || (row.first_ts === current.first_ts && orderedBefore(row.first_key, current.first_key)))) {
      current.first_ts = row.first_ts; current.first_key = row.first_key;
    }
    current.calls += calls;
    const tokens = decodeTokens(row.tokens);
    current.input += Number(tokens.in_uncached ?? "0");
    current.cache_read += Number(tokens.in_cache_read ?? "0");
    current.cache_write += Number(tokens.in_cache_write_5m ?? "0") + Number(tokens.in_cache_write_1h ?? "0")
      + Number(tokens.in_cache_write_unknown ?? "0");
    current.output += Number(tokens.out_total ?? "0");
    addStored(current.amount, decodeCounts(row.counts).api_global);
    totals.set(key, current);
  }
  return {
    // Deterministic, and the legacy order where it is derivable: the per-event scan read rows
    // `ORDER BY ts` from a rowid table, so its ties fell in *numeric* row order - unlike the
    // subscription fact path, whose ties fall in text order. Two integer keys are therefore
    // compared numerically here; anything else falls back to text so the order is still total.
    rows: [...totals.values()]
      .sort((a, b) => a.day.localeCompare(b.day) || a.first_ts.localeCompare(b.first_ts)
        || (orderedBefore(a.first_key, b.first_key) ? -1 : orderedBefore(b.first_key, a.first_key) ? 1 : 0)
        || a.vendor.localeCompare(b.vendor) || (a.account ?? "").localeCompare(b.account ?? "")
        || (a.model ?? "").localeCompare(b.model ?? ""))
      .map(({ amount, ...row }): GlobalUsagePriceRow => ({ ...row,
      priced_subtotal: amount.pricedSubtotal, priced_events: Number(amount.pricedEvents),
      unpriced_events: Number(amount.unpricedEvents) })),
    events, excluded_duplicates: events - accepted - conflicted,
    conflicting_events: conflicted + attribution, approximate_time_events: approximate,
  };
}

/** Whole-history account totals for the rebuild boundaries: token buckets plus both variants. */
export interface UsagePriceAccountTotals {
  calls: string;
  tokens: Record<TokenBucket, string>;
  variants: Record<string, UsagePriceAmount>;
  quality: Record<string, string>;
}

/**
 * Account totals of canonical calls (duplicate copies are resolved when the ledger is built). `owners` lists the resolved account identities to
 * include: a Codex business-credit event resolves to `<account>::business`, so the caller names
 * both. Without a range the whole register is read, bounded by its first and last day.
 */
export function readUsagePriceAccountTotals(db: Database, scope: string, provider: string, resolver: AccountResolver,
  owners: readonly string[], range: { since: string; until: string } | null, ledger?: CodexLedgerReadContext): UsagePriceAccountTotals {
  if (provider === "codex") {
    const current = ledger ?? readPublishedCodexLedgerContext(db), wanted = new Set(owners.map(owner => owner.toLowerCase()));
    const all = readCodexLedgerOwnedSeries(db, range ?? {}, resolver, current);
    const days = all.map(row => row.group.stored.day).sort();
    if (!days.length) return { calls: "0", tokens: Object.fromEntries(TOKEN_BUCKETS.map(key => [key, "0"])) as Record<TokenBucket, string>, variants: {}, quality: {} };
    const rows = readCodexLedgerCompatibilityDays(db, { since: range?.since ?? days[0]!, until: range?.until ?? days.at(-1)! }, resolver, current)
      .filter(row => row.selected && row.account !== null && wanted.has(row.account));
    const variants = new Set(rows.flatMap(row => Object.keys(row.variants))), tokens: Record<string, bigint> = {}, quality: Record<string, bigint> = {};
    for (const row of rows) {
      for (const [key, value] of Object.entries(row.tokens)) tokens[key] = (tokens[key] ?? 0n) + BigInt(value);
      for (const [key, value] of Object.entries(row.quality)) quality[key] = (quality[key] ?? 0n) + BigInt(value);
    }
    return { calls: String(rows.reduce((sum, row) => sum + BigInt(row.calls), 0n)),
      tokens: Object.fromEntries(TOKEN_BUCKETS.map(key => [key, String(tokens[key] ?? 0n)])) as Record<TokenBucket, string>,
      quality: Object.fromEntries(Object.entries(quality).map(([key, value]) => [key, String(value)])),
      variants: Object.fromEntries([...variants].map(variant => [variant, sumCodexLedgerCompatibilityAmounts(rows.map(row => row.variants[variant]))])) };
  }
  const bounds = range ?? registerDayBounds(db, provider, scope);
  const wanted = new Set(owners.map(owner => owner.toLowerCase()));
  const rows = bounds.since && bounds.until
    ? readRegisterDays(db, scope, provider, resolver, { since: bounds.since, until: bounds.until })
      .filter(row => row.vendor === null && row.account !== null && wanted.has(row.account))
    : [];
  let calls = 0n;
  const tokens = Object.fromEntries(TOKEN_BUCKETS.map(key => [key, 0n])) as Record<TokenBucket, bigint>;
  const quality: Record<string, bigint> = Object.fromEntries(QUALITY_KEYS.map(key => [key, 0n]));
  const variants = new Map<string, StoredAmount>();
  for (const row of rows) {
    const rowQuality = decodeQuality(row.quality);
    const conflicts = BigInt(rowQuality.conflicts ?? "0");
    calls += BigInt(row.calls_exact) - conflicts;
    for (const [key, value] of Object.entries(rowQuality)) quality[key] = (quality[key] ?? 0n) + BigInt(value);
    const rowTokens = decodeTokens(row.tokens);
    for (const bucket of TOKEN_BUCKETS) tokens[bucket] += BigInt(rowTokens[bucket] ?? "0");
    for (const [variant, amount] of Object.entries(decodeCounts(row.counts))) {
      const target = variants.get(variant) ?? storedAmount();
      addStored(target, amount);
      variants.set(variant, target);
    }
  }
  return {
    calls: String(calls),
    tokens: Object.fromEntries(TOKEN_BUCKETS.map(key => [key, String(tokens[key])])) as Record<TokenBucket, string>,
    variants: Object.fromEntries([...variants].map(([key, value]) => [key, seal(value)])),
    quality: Object.fromEntries(Object.entries(quality).map(([key, value]) => [key, String(value)])),
  };
}

export { PRICE_TOTAL_ARITHMETIC };
