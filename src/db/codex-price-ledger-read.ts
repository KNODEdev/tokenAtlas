import type { Database } from "./sqlite";
import { readCodexLedgerGroups, requireCodexLedgerReady, type LedgerRange, type LedgerStoredGroup } from "./codex-price-ledger";
import { rational, add, subtract, multiply, readNanoAggregate, type Rational } from "./price-ledger-exact";
import { projectRulesStamp } from "../projects/rules-now";
import { contextDerivedGroups, markContextRange, projectContextGroup } from "./codex-context-read-scope";

export const CODEX_LEDGER_VARIANTS = ["api_standard", "api_standard_credited", "api_actual", "credits_standard", "credits_fast",
  "normalized_usd", "extra_credits", "window_api", "window_credits_low", "window_credits_high", "window_normalized"] as const;
export type LedgerVariant = typeof CODEX_LEDGER_VARIANTS[number];
export type LedgerVariantProjection<Requested extends readonly LedgerVariant[]> = number extends Requested["length"]
  ? Partial<Record<Requested[number], LedgerAmount>> : Pick<Record<LedgerVariant, LedgerAmount>, Requested[number]>;
export interface LedgerAmount {
  subtotal: Rational; pricedSubtotal: Rational; value: Rational | null;
  pricedEvents: bigint; unpricedEvents: bigint; pricedTokens: bigint; unpricedTokens: bigint;
  reasons: Record<string, { events: bigint; tokens: bigint }>;
}
export interface LedgerTierPolicy {
  classify(raw: string | null, day: string): string | null;
  multiplier(model: string | null, basis: "chatgpt_credits" | "api_equivalent_usd", tier: string, day: string): Rational | null;
}
export interface LedgerReadGroup<Requested extends readonly LedgerVariant[] = typeof CODEX_LEDGER_VARIANTS> {
  stored: LedgerStoredGroup; tier: string | null;
  /** The canonical copy of its calls (resolved when the ledger was built); duplicates and conflicts are not usage. */
  selected: boolean;
  variants: LedgerVariantProjection<Requested>;
  calls: bigint; tokensReported: bigint; tokens: Record<string, bigint>;
  quality: { invalid_token_events: bigint; unknown_speed_tokens: bigint };
  windowTokens: { input: bigint; cached: bigint; output: bigint };
}
interface Price { amount: Rational | null; reason: string | null }
const absent = (reason: string): Price => ({ amount: null, reason });
const generalBlockers = new Set(["invalid_tokens", "incomplete_usage", "invalid_timestamp"]);
const one = rational(1n), zero = rational(0n);
export const emptyLedgerAmount = (): LedgerAmount => ({ subtotal: zero, pricedSubtotal: zero, value: zero,
  pricedEvents: 0n, unpricedEvents: 0n, pricedTokens: 0n, unpricedTokens: 0n, reasons: {} });

function amount(row: LedgerStoredGroup, prefix: "api" | "credit", denominators: ReadonlyMap<number, bigint>): Price {
  const reason = row[`${prefix}_reason`];
  if (reason) return absent(reason);
  const denominator = denominators.get(row[`${prefix}_band`]);
  if (!denominator) throw new Error("Published base has no exact band denominator");
  const part = (key: string) => {
    const value = row[key as keyof LedgerStoredGroup];
    return typeof value === "string" ? BigInt(value) : null;
  };
  return { amount: readNanoAggregate({ rows: BigInt(row.calls), invalid_rows: 0n,
    whole_hi: part(`${prefix}_whole_hi`), whole_lo: part(`${prefix}_whole_lo`),
    fraction_hi: part(`${prefix}_fraction_hi`), fraction_lo: part(`${prefix}_fraction_lo`) }, denominator), reason: null };
}
function tierPrice(base: Price, multiplier: Rational | null, basis: "api" | "credit", model: string | null): Price {
  if (model === "codex-auto-review" || base.reason && generalBlockers.has(base.reason)
    || basis === "credit" && base.reason === "cache_write_semantics_unknown") return base;
  if (!multiplier) return absent("missing_rate");
  return base.amount === null ? base : { amount: multiply(base.amount, multiplier), reason: null };
}
function counter(price: Price | null, calls: bigint, tokens: bigint, signed = false): LedgerAmount {
  const priced = price?.amount != null && (signed || price.amount.n >= 0n);
  const value = priced ? price!.amount! : null;
  return { subtotal: value ?? zero, pricedSubtotal: value ?? zero, value,
    pricedEvents: priced ? calls : 0n, unpricedEvents: priced ? 0n : calls,
    pricedTokens: priced ? tokens : 0n, unpricedTokens: priced ? 0n : tokens,
    reasons: priced ? {} : { [price?.reason ?? (price ? "invalid_valuation" : "unknown_speed")]: { events: calls, tokens } } };
}

function projectedVariants<Requested extends readonly LedgerVariant[]>(values: Partial<Record<LedgerVariant, LedgerAmount>>,
  requested: Requested): LedgerVariantProjection<Requested> {
  const entries = requested.map(key => {
    const value = values[key];
    if (!value) throw new Error(`Requested ledger variant was not derived: ${key}`);
    return [key, value];
  });
  // Literal tuples require their exact keys; a dynamic array exposes optional keys.
  return Object.fromEntries(entries) as LedgerVariantProjection<Requested>;
}
function groupFacts(row: LedgerStoredGroup, tier: string | null, calls: bigint, reported: bigint) {
  return { stored: row, tier, selected: row.copy_state === "canonical", calls, tokensReported: reported,
    tokens: { in_uncached: BigInt(row.uncached), in_cache_read: BigInt(row.cached), in_cache_write: 0n,
      in_cache_write_unknown: BigInt(row.writes), out_total: BigInt(row.output), reasoning_out: BigInt(row.reasoning) },
    quality: { invalid_token_events: BigInt(row.invalid_tokens), unknown_speed_tokens: tier ? 0n : reported },
    windowTokens: { input: BigInt(row.window_input), cached: BigInt(row.window_cached), output: BigInt(row.window_output) } };
}

const MAX_SHARED_ROWS = 30_000, MAX_SHARED_BYTES = 64 * 1024 * 1024;
interface StoredSnapshot { key: string; fence: string; rows: readonly LedgerStoredGroup[] }
interface SnapshotOwner { observed: boolean; pending?: StoredSnapshot }
const storedSnapshots = new WeakMap<Database, StoredSnapshot>();
const snapshotOwners = new WeakMap<Database, SnapshotOwner>();
export function codexLedgerWholeDaySnapshotEligible(range: LedgerRange): boolean {
  return range.since === undefined && range.until === undefined && range.fromMs === undefined && range.toMs === undefined
    && range.instantValidity === undefined && (range.grain ?? "day") === "day" && range.dependencyModels === undefined && range.copyPaths === undefined && range.sources === undefined && range.models === undefined;
}
function ownChanges(db: Database): string {
  return (db.query("SELECT CAST(total_changes() AS TEXT) changes").get() as { changes: string }).changes;
}
function snapshotFence(db: Database): string {
  const version = (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  // Stored groups carry their project by the rules at read time (projects/rules-now.ts).
  return `${version}:${ownChanges(db)}:${projectRulesStamp(db)}`;
}
/** Publish only committed readonly snapshots; a caller's write/rollback must never populate this cache. */
export function withCodexLedgerStoredSnapshot<T>(db: Database, read: () => T): T {
  if (db.inTransaction) return read();
  const before = ownChanges(db), owner: SnapshotOwner = { observed: false };
  const result = db.transaction(() => {
    snapshotOwners.set(db, owner);
    try { return read(); } finally { snapshotOwners.delete(db); }
  }).deferred();
  if (owner.observed && ownChanges(db) === before) {
    if (owner.pending) storedSnapshots.set(db, owner.pending);
    else storedSnapshots.delete(db);
  }
  return result;
}
/** One bounded physical whole-day cohort snapshot shared by its dependency stamp and report body. */
export function readCodexLedgerStoredSnapshot(db: Database, range: LedgerRange = {}): readonly LedgerStoredGroup[] {
  if (!codexLedgerWholeDaySnapshotEligible(range)) return readCodexLedgerGroups(db, range);
  return withCodexLedgerStoredSnapshot(db, () => {
    requireCodexLedgerReady(db, range);
    const key = "whole:day", fence = snapshotFence(db), owner = snapshotOwners.get(db);
    const cached = owner?.pending ?? storedSnapshots.get(db);
    if (cached?.key === key && cached.fence === fence) return markContextRange(db, cached.rows, range);
    const rows = readCodexLedgerGroups(db, range);
    if (!owner) return rows;
    owner.observed = true; owner.pending = undefined;
    if (rows.length > MAX_SHARED_ROWS) return rows;
    let bytes = rows.length * 512;
    for (const row of rows) for (const value of Object.values(row)) {
      if (typeof value === "string") bytes += value.length * 2;
      else if (value !== null && typeof value === "object") return rows;
      if (bytes > MAX_SHARED_BYTES) return rows;
    }
    for (const row of rows) Object.freeze(row);
    Object.freeze(rows);
    owner.pending = { key, fence, rows };
    return rows;
  });
}
/** Apply exact tier factors to homogeneous stored sums, never reprice the underlying events. */
export function deriveCodexLedgerGroup<Requested extends readonly LedgerVariant[] = typeof CODEX_LEDGER_VARIANTS>(
  row: LedgerStoredGroup, denominators: ReadonlyMap<number, bigint>, policy: LedgerTierPolicy,
  requestedVariants?: Requested): LedgerReadGroup<Requested> {
  const calls = BigInt(row.calls), reported = BigInt(row.reported);
  const tier = policy.classify(row.service_tier, row.day);
  if (requestedVariants?.length === 0) return { ...groupFacts(row, tier, calls, reported), variants: projectedVariants({}, requestedVariants) };
  const api = amount(row, "api", denominators);
  if (requestedVariants?.length && requestedVariants.every(variant => variant === "api_standard")) {
    return { ...groupFacts(row, tier, calls, reported), variants: projectedVariants<Requested>({ api_standard: counter(api, calls, reported) }, requestedVariants) };
  }
  const cs = amount(row, "credit", denominators);
  const actualCreditMultiplier = tier === "standard" ? one : tier ? policy.multiplier(row.model, "chatgpt_credits", tier, row.day) : null;
  const actual = tier ? tierPrice(cs, actualCreditMultiplier, "credit", row.model) : null;
  // Zero/zero credit burden is one, irrespective of the configured tier multiplier.
  const burden = actual?.amount != null && cs.amount != null ? row.credit_zero ? one : actualCreditMultiplier : null;
  const normalizedUsd = counter(burden !== null && api.amount !== null
    ? { amount: multiply(api.amount, burden), reason: null } : absent(actual?.reason ?? api.reason ?? "unknown_speed"), calls, reported);
  if (requestedVariants?.length && requestedVariants.every(variant => variant === "api_standard" || variant === "normalized_usd")) {
    return { ...groupFacts(row, tier, calls, reported), variants: projectedVariants<Requested>(
      { api_standard: counter(api, calls, reported), normalized_usd: normalizedUsd }, requestedVariants) };
  }
  const fastCredit = policy.multiplier(row.model, "chatgpt_credits", "fast", row.day);
  const cf = tierPrice(cs, fastCredit, "credit", row.model);
  // A call that records no tier is valued at the Standard API rate, a lower bound (UNKNOWN_MODE_RATE_RULE);
  // its tier stays unknown for credits and for the quality measures. An unmapped recorded tier stays unpriced.
  const apiTier = tier ?? (row.service_tier == null ? "standard" : null);
  const actualApiMultiplier = apiTier === "standard" ? one : apiTier ? policy.multiplier(row.model, "api_equivalent_usd", apiTier, row.day) : null;
  const apiActual = apiTier ? tierPrice(api, actualApiMultiplier, "api", row.model) : null;
  const variants = {} as Record<LedgerVariant, LedgerAmount>;
  variants.api_standard = counter(api, calls, reported);
  variants.api_standard_credited = counter(cs.amount !== null && api.amount !== null ? api : absent(cs.amount === null ? cs.reason! : api.reason!), calls, reported);
  variants.api_actual = counter(apiActual, calls, reported);
  variants.credits_standard = counter(cs, calls, reported);
  variants.credits_fast = counter(cf, calls, reported);
  variants.normalized_usd = normalizedUsd;
  variants.extra_credits = counter(actual?.amount != null && cs.amount !== null
    ? { amount: subtract(actual.amount, cs.amount), reason: null } : absent(actual?.reason ?? cs.reason ?? "unknown_speed"), calls, reported, true);
  const low = tier && tier !== "standard" ? actual! : cs, high = actual ?? cf;
  const lowFactor = low.amount !== null && cs.amount !== null ? row.credit_zero ? one : tier && tier !== "standard" ? actualCreditMultiplier : one : null;
  const normalized = lowFactor !== null && api.amount !== null ? multiply(api.amount, lowFactor) : null;
  const early = row.day < "2026-04-02";
  const blocker = early ? api.amount === null ? api : null
    : [api, low, high].find(price => price.amount === null) ?? (normalized === null ? absent("missing_rate") : null);
  const windowAmounts = [api.amount, early ? zero : low.amount, early ? zero : high.amount, early ? api.amount : normalized];
  (["window_api", "window_credits_low", "window_credits_high", "window_normalized"] as const).forEach((variant, index) => {
    variants[variant] = counter(blocker ?? { amount: windowAmounts[index]!, reason: null }, calls, reported);
  });
  // The complete record already satisfies every subset; default readers reuse it without another allocation.
  const projected = requestedVariants ? projectedVariants(variants, requestedVariants) : variants as LedgerVariantProjection<Requested>;
  return { ...groupFacts(row, tier, calls, reported), variants: projected };
}

export function mergeLedgerAmounts(left: LedgerAmount, right: LedgerAmount): LedgerAmount {
  const reasons: LedgerAmount["reasons"] = {};
  for (const reason of new Set([...Object.keys(left.reasons), ...Object.keys(right.reasons)])) reasons[reason] = {
    events: (left.reasons[reason]?.events ?? 0n) + (right.reasons[reason]?.events ?? 0n),
    tokens: (left.reasons[reason]?.tokens ?? 0n) + (right.reasons[reason]?.tokens ?? 0n) };
  const subtotal = add(left.subtotal, right.subtotal), unpricedEvents = left.unpricedEvents + right.unpricedEvents;
  return { subtotal, pricedSubtotal: add(left.pricedSubtotal, right.pricedSubtotal), value: unpricedEvents ? null : subtotal,
    pricedEvents: left.pricedEvents + right.pricedEvents, unpricedEvents,
    pricedTokens: left.pricedTokens + right.pricedTokens, unpricedTokens: left.unpricedTokens + right.unpricedTokens, reasons };
}

/**
 * A running `mergeLedgerAmounts` of many amounts: fractions over one denominator are added as integers and reduced once when
 * read, instead of reducing every partial sum. The result is the same exact amount.
 */
export class LedgerAmountSum {
  private readonly subtotal = new Map<bigint, bigint>();
  private readonly priced = new Map<bigint, bigint>();
  private pricedEvents = 0n; private unpricedEvents = 0n; private pricedTokens = 0n; private unpricedTokens = 0n;
  private readonly reasons: LedgerAmount["reasons"] = {};
  add(amount: LedgerAmount): void {
    this.subtotal.set(amount.subtotal.d, (this.subtotal.get(amount.subtotal.d) ?? 0n) + amount.subtotal.n);
    this.priced.set(amount.pricedSubtotal.d, (this.priced.get(amount.pricedSubtotal.d) ?? 0n) + amount.pricedSubtotal.n);
    this.pricedEvents += amount.pricedEvents; this.unpricedEvents += amount.unpricedEvents;
    this.pricedTokens += amount.pricedTokens; this.unpricedTokens += amount.unpricedTokens;
    for (const [reason, counted] of Object.entries(amount.reasons)) {
      const current = this.reasons[reason] ??= { events: 0n, tokens: 0n };
      current.events += counted.events; current.tokens += counted.tokens;
    }
  }
  total(): LedgerAmount {
    const sum = (parts: Map<bigint, bigint>) => [...parts].reduce((total, [d, n]) => add(total, rational(n, d)), zero);
    const subtotal = sum(this.subtotal);
    return { subtotal, pricedSubtotal: sum(this.priced), value: this.unpricedEvents ? null : subtotal, pricedEvents: this.pricedEvents,
      unpricedEvents: this.unpricedEvents, pricedTokens: this.pricedTokens, unpricedTokens: this.unpricedTokens,
      reasons: Object.fromEntries(Object.entries(this.reasons).map(([reason, counted]) => [reason, { ...counted }])) };
  }
}

export function readCodexLedgerSeries<Requested extends readonly LedgerVariant[] = typeof CODEX_LEDGER_VARIANTS>(db: Database, policy: LedgerTierPolicy,
  options: { range?: LedgerRange; requestedVariants?: Requested } = {}): LedgerReadGroup<Requested>[] {
  return deriveCodexLedgerGroups(db, policy, readCodexLedgerStoredSnapshot(db, options.range), options.requestedVariants);
}
/** Stored groups valued under the published bands (`deriveCodexLedgerGroup` of each). */
export function deriveCodexLedgerGroups<Requested extends readonly LedgerVariant[] = typeof CODEX_LEDGER_VARIANTS>(db: Database, policy: LedgerTierPolicy,
  rows: readonly LedgerStoredGroup[], requestedVariants?: Requested): LedgerReadGroup<Requested>[] {
  const apiOnly = requestedVariants?.length && requestedVariants.every(variant => variant === "api_standard");
  const bands = requestedVariants?.length === 0 ? [] : db.query(`SELECT id,CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands${apiOnly ? " WHERE basis='api_equivalent_usd'" : ""}`)
    .all() as { id: number; denominator: string }[];
  const denominators = new Map(bands.map(row => [row.id, BigInt(row.denominator)]));
  return contextDerivedGroups(db, policy, rows, requestedVariants,
    () => rows.map(row => projectContextGroup(db, deriveCodexLedgerGroup(row, denominators, policy, requestedVariants), policy)));
}
