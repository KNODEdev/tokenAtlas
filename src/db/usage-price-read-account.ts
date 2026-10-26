import type { Database } from "bun:sqlite";
import type { AccountResolver, PlanDay } from "../server/account-resolver";
import { codexEventOwner } from "../server/codex-event-owner";
import { DecimalSum } from "../shared/decimal-amount";
import { decodeCounts, decodeQuality, decodeTokens, encodeCounts, encodeQuality, encodeTokens, type StoredCounts, type StoredMap } from "./usage-price-measures";
import type { UsagePriceDimension } from "./usage-price-totals";
import { readCodexLedgerRegisterRows, type CodexLedgerReadContext } from "./codex-ledger-adapters";
import { usageLedgerContributionMeasures, usageLedgerContributions, usageLedgerDayMeasures, usageLedgerDimensions, usageLedgerProviderOf,
  usageLedgerStoredDays } from "./usage-ledger-read";
import { ledgerMoneyDecimal } from "./usage-ledger";
import { subscriptionAccountingAdapter } from "../server/subscription-accounting-adapters";
import { currentProjectRules, placeSubject, type StoredPlace } from "../projects/rules-now";

/**
 * Register version 8: the account of a register row is joined in here, at read time, from the
 * account periods (docs/register-v8-design-2026-09-22.md §3).
 *
 *   row with a session identity      → the account that identity names, whatever the periods say
 *   whole day inside one period      → that period's account, from the day table as stored
 *   day cut by a period boundary     → the contributions of that day and source, split at the instant
 *   day no period covers             → account null: unassigned, reported as such, never guessed
 *
 * Whole days cost one row per dimension; a cut day costs the contributions of one source on one
 * day (measured 14–200 ms on the live database), and boundaries with a time of day are the
 * exception. Nothing here prepares, prices or scans events.
 */
export interface RegisterDayRow extends UsagePriceDimension {
  day: string; dim: string;
  /** The physical copy the row came from; Codex rows no longer carry one (copies are resolved per call). */
  copy: string | null;
  calls: number;
  calls_exact: string;
  first_ts: string; first_key: string; last_ts: string;
  tokens: string; tokens_reported: string; counts: string; quality: string;
  /** Resolved account (Codex: with `::business` for business-credit traffic), or null. */
  account: string | null;
}

type StoredDay = { day: string; dim: string; copy: string | null; calls: number; calls_exact: string; first_ts: string; first_key: string;
  last_ts: string; tokens: string; tokens_reported: string; counts: string; quality: string };
type Contribution = { dim: string; copy: string; ts: string; source_key: string; calls: number; calls_exact: string;
  tokens: string; tokens_reported: string; counts: string; quality: string };

/** Coverage of one (source, day): the slices each account's periods own, in milliseconds. */
type Slice = PlanDay & { account: string };
type Coverage = Map<string, Slice[]>;
const coverageKey = (source: string | null, day: string) => `${source}|${day}`;

function coverageOf(resolver: AccountResolver, provider: string, since: string, until: string): Coverage {
  const coverage: Coverage = new Map();
  for (const account of resolver.accounts(provider)) {
    for (const slice of resolver.plan(provider, account).days(since, until)) {
      const key = coverageKey(slice.source, slice.day), list = coverage.get(key) ?? [];
      list.push({ ...slice, account });
      coverage.set(key, list);
    }
  }
  return coverage;
}

const accountAt = (slices: readonly Slice[] | undefined, ms: number): string | null =>
  slices?.find(slice => slice.from <= ms && ms < slice.until)?.account ?? null;

/** Codex business-credit traffic sits under `<account>::business`, as every Codex reader expects. */
const owned = (provider: string, account: string | null, dimension: UsagePriceDimension): string | null =>
  provider === "codex" ? codexEventOwner(account, { billing_mode: dimension.billing_mode }) : account;

/** A variant's amounts while a cut day's contributions add up. */
type AmountSum = { subtotal: DecimalSum; pricedSubtotal: DecimalSum; pricedEvents: bigint; unpricedEvents: bigint;
  pricedTokens: bigint; unpricedTokens: bigint; reasons: Map<string, { events: bigint; tokens: bigint }> };
/**
 * A cut day's group. Its measures are summed as exact numbers and encoded once, which gives the text
 * chained additions of the encoded forms would: counters are integers and decimal sums are exact.
 */
type Group = { row: RegisterDayRow; callsExact: bigint; tokensReported: bigint; tokens: Map<string, bigint>;
  quality: Map<string, bigint>; counts: Map<string, AmountSum> };
const add = (target: Map<string, bigint>, values: StoredMap) => {
  for (const key in values) target.set(key, (target.get(key) ?? 0n) + BigInt(values[key]!));
};
function accumulate(group: Group, row: Contribution): void {
  const target = group.row;
  target.calls += row.calls;
  group.callsExact += BigInt(row.calls_exact);
  add(group.tokens, decodeTokens(row.tokens));
  group.tokensReported += BigInt(row.tokens_reported);
  add(group.quality, decodeQuality(row.quality));
  for (const [variant, amount] of Object.entries(decodeCounts(row.counts))) {
    let slot = group.counts.get(variant);
    if (!slot) group.counts.set(variant, slot = { subtotal: new DecimalSum(), pricedSubtotal: new DecimalSum(), pricedEvents: 0n,
      unpricedEvents: 0n, pricedTokens: 0n, unpricedTokens: 0n, reasons: new Map() });
    slot.subtotal.add(amount.subtotal);
    slot.pricedSubtotal.add(amount.pricedSubtotal);
    for (const key of ["pricedEvents", "unpricedEvents", "pricedTokens", "unpricedTokens"] as const) slot[key] += BigInt(amount[key]);
    for (const [reason, counted] of Object.entries(amount.reasons)) {
      const prior = slot.reasons.get(reason) ?? { events: 0n, tokens: 0n };
      slot.reasons.set(reason, { events: prior.events + BigInt(counted.events), tokens: prior.tokens + BigInt(counted.tokens) });
    }
  }
  if (!target.first_ts || row.ts < target.first_ts || (row.ts === target.first_ts && row.source_key < target.first_key)) {
    target.first_ts = row.ts; target.first_key = row.source_key;
  }
  if (row.ts > target.last_ts) target.last_ts = row.ts;
}
const texts = (values: Map<string, bigint>): StoredMap => Object.fromEntries([...values].map(([key, value]) => [key, String(value)]));
function finished(group: Group): RegisterDayRow {
  const counts: StoredCounts = {};
  for (const [variant, slot] of group.counts) counts[variant] = { subtotal: slot.subtotal.toString(),
    pricedSubtotal: slot.pricedSubtotal.toString(), pricedEvents: String(slot.pricedEvents), unpricedEvents: String(slot.unpricedEvents),
    pricedTokens: String(slot.pricedTokens), unpricedTokens: String(slot.unpricedTokens),
    reasons: Object.fromEntries([...slot.reasons].map(([reason, n]) => [reason, { events: String(n.events), tokens: String(n.tokens) }])) };
  return { ...group.row, calls_exact: String(group.callsExact), tokens_reported: String(group.tokensReported),
    tokens: encodeTokens(texts(group.tokens)), quality: encodeQuality(texts(group.quality)), counts: encodeCounts(counts) };
}

const CUT_DAY = Symbol("cut day");
/**
 * The account a stored day row of a dimension resolves to whole: its session identity's, else the one period covering its
 * whole source day, else none (null). `CUT_DAY` when period boundaries cut its source day: it is rebuilt from contributions.
 */
function storedDayAccount(provider: string, resolver: AccountResolver, coverage: Coverage, dimension: UsagePriceDimension,
  day: string): string | null | typeof CUT_DAY {
  const direct = resolver.identityAccount(provider, dimension.identity);
  if (direct) return owned(provider, direct, dimension);
  const slices = dimension.source ? coverage.get(coverageKey(dimension.source, day)) : undefined;
  if (!slices) return owned(provider, null, dimension);
  if (slices.length === 1 && slices[0]!.whole) return owned(provider, slices[0]!.account, dimension);
  return CUT_DAY;
}
/** The account one contribution of a cut source day resolves to at its instant. */
const contributionAccount = (provider: string, resolver: AccountResolver, slices: readonly Slice[] | undefined,
  dimension: UsagePriceDimension, instant: number): string | null =>
  owned(provider, resolver.identityAccount(provider, dimension.identity) ?? accountAt(slices, instant), dimension);

/**
 * The register days of a range with their accounts; Codex rows are its canonical calls.
 * With `account`, only that (lower-cased) account's rows are returned, and a day is rebuilt from
 * its contributions only where that account can own part of it.
 */
export function readRegisterDays(db: Database, scope: string, provider: string, resolver: AccountResolver,
  range: { since: string; until: string; within?: { from: number; until: number }; account?: string },
  ledger?: CodexLedgerReadContext): RegisterDayRow[] {
  if (provider === "codex") return readCodexLedgerRegisterRows(db, resolver, range, ledger);
  // Claude, Gemini, Grok and GLM are read from the usage ledger; it has no physical-copy table, its
  // source folder is part of the dimension.
  const ledgerProvider = usageLedgerProviderOf(provider);
  if (!ledgerProvider) return [];
  const dims = usageLedgerDimensions(db, ledgerProvider);
  const coverage = coverageOf(resolver, provider, range.since, range.until);
  const wanted = range.account;
  const mine = (account: string | null) => wanted === undefined || account?.toLowerCase() === wanted;
  const stored: StoredDay[] = usageLedgerStoredDays(db, ledgerProvider, range.since, range.until);
  const out: RegisterDayRow[] = [];
  const cut = new Map<string, { source: string | null; day: string; clipped: boolean }>();
  const dayMs = 86_400_000;
  for (const row of stored) {
    const dimension = dims.get(row.dim);
    if (!dimension) continue;
    if (wanted !== undefined) {
      // The accounts this row can resolve to: its identity's, else those of its day's periods. A
      // contribution on an adjacent lexical day falls outside every slice of this day and gets none.
      const direct = resolver.identityAccount(provider, dimension.identity);
      const candidates = direct ? [direct] : dimension.source ? (coverage.get(coverageKey(dimension.source, row.day)) ?? []).map(slice => slice.account) : [];
      if (!candidates.some(account => mine(owned(provider, account, dimension)))) continue;
    }
    if (range.within) {
      // Stored days retain source spelling; adjacent days may contain offset timestamps.
      const start = Date.parse(row.day), earliest = start - dayMs, latest = start + 2 * dayMs;
      if (latest <= range.within.from || earliest >= range.within.until) continue;
      if (earliest < range.within.from || latest > range.within.until) {
        cut.set(coverageKey(dimension.source, row.day), { source: dimension.source, day: row.day, clipped: true });
        continue;
      }
    }
    const account = storedDayAccount(provider, resolver, coverage, dimension, row.day);
    if (account !== CUT_DAY) { out.push({ ...row, ...dimension, account }); continue; }
    cut.set(coverageKey(dimension.source!, row.day), { source: dimension.source!, day: row.day, clipped: false });
  }
  // A cut day is rebuilt from its contributions, split at the period boundary. Rows of identities
  // were already emitted whole above and are skipped here.
  for (const { source, day, clipped } of cut.values()) {
    const slices = coverage.get(coverageKey(source, day));
    const groups = new Map<string, Group>();
    {
      const rows: Contribution[] = usageLedgerContributions(db, ledgerProvider, source, day, subscriptionAccountingAdapter(ledgerProvider).speed);
      for (const row of rows) {
        const dimension = dims.get(row.dim);
        if (!dimension) continue;
        if (!clipped && resolver.identityAccount(provider, dimension.identity)) continue;
        const instant = Date.parse(row.ts);
        if (clipped && range.within && !(range.within.from <= instant && instant < range.within.until)) continue;
        const account = contributionAccount(provider, resolver, slices, dimension, instant);
        if (!mine(account)) continue;
        const key = `${row.dim}||${account ?? ""}`;
        let group = groups.get(key);
        if (!group) {
          group = { row: { day, dim: row.dim, copy: null, calls: 0, calls_exact: "0", first_ts: "", first_key: "", last_ts: "",
            tokens: "", tokens_reported: "0", counts: "", quality: "", ...dimension, account }, callsExact: 0n, tokensReported: 0n,
            tokens: new Map(), quality: new Map(), counts: new Map() };
          groups.set(key, group);
        }
        accumulate(group, row);
      }
    }
    for (const group of groups.values()) out.push(finished(group));
  }
  // The subject follows the project rules at read time from the place of the calls (rules-now.ts).
  const places = new Map((db.query("SELECT id, home, cwd, project, repo, shift FROM usage_ledger_dims WHERE provider=?").all(ledgerProvider) as
    Array<StoredPlace & { id: number }>).map(place => [String(place.id), place]));
  const rules = currentProjectRules(db);
  for (const row of out) { const place = places.get(row.dim); row.subject = place ? placeSubject(rules, ledgerProvider, place, row.day) : null; }
  return wanted === undefined ? out : out.filter(row => mine(row.account));
}


/** What an account history reads of one register day (`readRegisterDayMeasures`). */
export interface RegisterDayMeasures {
  day: string; dim: string; model: string | null; vendor: string | null; account: string | null;
  calls: number; first_ts: string; last_ts: string;
  /** Tokens of the history's buckets (`TOKEN_BUCKETS`; reasoning is part of the output and is not added again). */
  tokens: number; conflicts: number;
  /** The API equivalent at the actual tier (`api_actual`): the priced part as decimal text, and what stayed unpriced. */
  actual: { pricedSubtotal: string; unpricedTokens: number; unpricedEvents: number };
}
const HISTORY_TOKEN_COLUMNS = ["t_uncached", "t_cache_read", "t_write_5m", "t_write_1h", "t_write_unknown", "t_out"] as const;
/**
 * The rows `readRegisterDays` returns for a usage-ledger provider over a range (the same accounts and order; no account filter
 * or clipping) with only the measures a history reads: the stored day sums and, on a source day period boundaries cut, its
 * contributions split at them, read from their columns instead of through the register's encoded forms.
 */
export function readRegisterDayMeasures(db: Database, provider: string, resolver: AccountResolver,
  range: { since: string; until: string }): RegisterDayMeasures[] {
  const ledgerProvider = usageLedgerProviderOf(provider);
  if (!ledgerProvider) return [];
  const dims = usageLedgerDimensions(db, ledgerProvider);
  const coverage = coverageOf(resolver, provider, range.since, range.until);
  const out: RegisterDayMeasures[] = [];
  const cut = new Map<string, { source: string; day: string }>();
  for (const row of usageLedgerDayMeasures(db, ledgerProvider, range.since, range.until)) {
    const dimension = dims.get(String(row.dim_id));
    if (!dimension) continue;
    const account = storedDayAccount(provider, resolver, coverage, dimension, row.day);
    if (account === CUT_DAY) { cut.set(coverageKey(dimension.source!, row.day), { source: dimension.source!, day: row.day }); continue; }
    out.push({ day: row.day, dim: String(row.dim_id), model: dimension.model, vendor: dimension.vendor, account, calls: Number(row.calls),
      first_ts: row.first_ts, last_ts: row.last_ts, tokens: HISTORY_TOKEN_COLUMNS.reduce((sum, column) => sum + Number(row[column]), 0),
      conflicts: Number(row.conflicts), actual: { pricedSubtotal: ledgerMoneyDecimal(row.act_priced_usd, row.act_priced_nano, row.act_priced_femto),
        unpricedTokens: Number(row.act_unpriced_tokens), unpricedEvents: Number(row.act_unpriced_events) } });
  }
  // A cut day: its contributions, grouped per dimension and account in the order they are read, as `readRegisterDays` groups them.
  for (const { source, day } of cut.values()) {
    const slices = coverage.get(coverageKey(source, day));
    const groups = new Map<string, { row: RegisterDayMeasures; firstKey: string; tokens: bigint; femto: bigint; unpricedTokens: bigint;
      unpricedEvents: bigint }>();
    for (const fact of usageLedgerContributionMeasures(db, ledgerProvider, source, day)) {
      const dimension = dims.get(String(fact.dim_id));
      if (!dimension || resolver.identityAccount(provider, dimension.identity)) continue;
      const account = contributionAccount(provider, resolver, slices, dimension, Date.parse(fact.ts));
      const key = `${fact.dim_id}||${account ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = { row: { day, dim: String(fact.dim_id), model: dimension.model, vendor: dimension.vendor, account, calls: 0, first_ts: "",
          last_ts: "", tokens: 0, conflicts: 0, actual: { pricedSubtotal: "0", unpricedTokens: 0, unpricedEvents: 0 } }, firstKey: "",
          tokens: 0n, femto: 0n, unpricedTokens: 0n, unpricedEvents: 0n };
        groups.set(key, group);
      }
      const target = group.row;
      target.calls += 1;
      if (fact.marker) target.conflicts += 1;
      else {
        group.tokens += fact.tokens;
        if (fact.eligible && fact.priced) group.femto += fact.femto;
        else if (fact.eligible) { group.unpricedTokens += fact.total; group.unpricedEvents += 1n; }
      }
      if (!target.first_ts || fact.ts < target.first_ts || (fact.ts === target.first_ts && fact.source_key < group.firstKey)) {
        target.first_ts = fact.ts; group.firstKey = fact.source_key;
      }
      if (fact.ts > target.last_ts) target.last_ts = fact.ts;
    }
    for (const group of groups.values()) {
      group.row.tokens = Number(group.tokens);
      group.row.actual = { pricedSubtotal: ledgerMoneyDecimal(0, 0, group.femto), unpricedTokens: Number(group.unpricedTokens),
        unpricedEvents: Number(group.unpricedEvents) };
      out.push(group.row);
    }
  }
  return out;
}
