import type { Database } from "bun:sqlite";
import { ledgerMoneyDecimal, type UsageLedgerProvider } from "../db/usage-ledger";
import { decodeCounts, decodeQuality, decodeTokens } from "../db/usage-price-measures";
import type { AccountResolver, IdentityDeclaration } from "./account-resolver";
import type { ClaudeConflictingIdentities, ClaudeProjectEvidence } from "./claude-project-usage";
import type { ProjectFactProvider, ProviderProjectConflict, ProviderProjectEvidence } from "./provider-project-usage";
import { activityDayKey, readDayActKeys, readDayRowsCalls, readLedgerKeyRates, readUsageLedgerPlaces, type LedgerValuedCall } from "./ledger-sums";
import { ownedAccounts, ownedRegisterRows, presentedReason } from "./stored-history-usage";
import { currentProjectRules, placeSubject } from "../projects/rules-now";
import { TOKEN_BUCKETS, type TokenBucket } from "./subscription-accounting-adapters";
import type { RateCard } from "./pricing";
import type { ModelSlice } from "./project-cost-contracts";

/**
 * Project traffic and money of the shared-ledger providers (Claude, Grok, GLM plan calls) for the project cost report, from
 * stored rows only (docs/stored-activity-plan-2026-10-07.md step 8): the day rows the verified accounts own (the frame the
 * history reads, `ownedRegisterRows`), their stored valuations and, by token type, their bucket sums times the stored rates
 * of the row's actual-mode key (`act_key`, migration 0070). Only a row whose calls the sums cannot split - priced and
 * unpriced together, invalid counters, no single key - is read from its own calls; on the live copy two rows of history.
 *
 * Money is summed exactly (femto-dollars) and converted once per account and subject. Both valuation bases travel
 * together: the actual-mode amount the report publishes as `api_usd`, and the Standard-mode amount capacity equivalents
 * divide (null once any priced call has no Standard price).
 */
export interface ProjectTokenTypes { in_uncached: number; cache_read: number; cache_write: number; out: number }
/** One verified account and one subject (`p:project`, `r:repo` or unassigned): its priced calls only. */
export interface ProjectUsageGroup {
  account: string; subject: string | null;
  tokens: number; calls: number; tokens_by_type: ProjectTokenTypes;
  /** Actual-mode API equivalent of exactly the calls counted above. */
  api_usd: number; api_usd_by_type: ProjectTokenTypes;
  /** Standard-mode API equivalent of the same calls; null when any of them has no Standard price. */
  standard_usd: number | null;
  /** The same priced calls by model. */
  models: Record<string, ModelSlice>;
}
/** Calls whose actual-mode price is unknown, never valued as zero, with the account that owns them. */
export interface ProjectUnpricedGroup { account: string; model: string; reason: string; tokens: number; calls: number }
export interface ProjectUsage {
  provider: "claude" | ProjectFactProvider;
  accounts: string[];
  days_by_account: Array<[string, string[]]>;
  groups: ProjectUsageGroup[];
  unpriced: ProjectUnpricedGroup[];
  evidence: Array<ClaudeProjectEvidence | ProviderProjectEvidence>;
  conflicts: Array<ClaudeConflictingIdentities | ProviderProjectConflict>;
}

export class UnsafeProjectSum extends Error {}
function safeCount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new UnsafeProjectSum(`Unsafe project ${what}`);
  return value;
}
const FEMTO_DIGITS = 15;
/** Exact femto-dollars of a stored decimal amount (at most fifteen decimal places, as the ledger stores money). */
function femtoOf(text: string): bigint {
  const parsed = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!parsed || (parsed[2]?.length ?? 0) > FEMTO_DIGITS) throw new UnsafeProjectSum(`Unexpected stored amount: ${text}`);
  return BigInt(parsed[1]!) * 10n ** BigInt(FEMTO_DIGITS) + BigInt((parsed[2] ?? "").padEnd(FEMTO_DIGITS, "0"));
}
const usdOf = (femto: bigint) => Number(ledgerMoneyDecimal(0, 0, femto));
const limbsFemto = (usd: string | null, nano: string | null, femto: string | null) =>
  BigInt(usd ?? 0) * 10n ** BigInt(FEMTO_DIGITS) + BigInt(nano ?? 0) * 1_000_000n + BigInt(femto ?? 0);
/** The report's token types: the three cache-write buckets are one. */
const TYPE_OF: Record<TokenBucket, keyof ProjectTokenTypes> = { in_uncached: "in_uncached", in_cache_read: "cache_read",
  in_cache_write_5m: "cache_write", in_cache_write_1h: "cache_write", in_cache_write_unknown: "cache_write", out_total: "out" };

type Exact = { subject: string | null; firstDay: string; tokens: number; calls: number; types: Record<keyof ProjectTokenTypes, number>;
  actual: bigint; byType: Record<keyof ProjectTokenTypes, bigint>; standard: bigint | null;
  models: Map<string, { tokens: number; calls: number; actual: bigint }> };
const zero = () => ({ in_uncached: 0, cache_read: 0, cache_write: 0, out: 0 });
const zeroExact = () => ({ in_uncached: 0n, cache_read: 0n, cache_write: 0n, out: 0n });

/** The project usage of a shared-ledger provider's plan calls over `[since, until]`, from stored rows. */
export function storedProjectUsage(db: Database, provider: "claude" | ProjectFactProvider, rates: RateCard,
  options: { since?: string; until?: string; resolver?: AccountResolver; declarations?: readonly IdentityDeclaration[] } = {}): ProjectUsage {
  const owned = ownedRegisterRows(db, provider, rates, options);
  const usage: ProjectUsage = { provider, accounts: [], days_by_account: [], groups: [], unpriced: [], evidence: owned.evidence, conflicts: [] };
  if (!owned.accounts.length) return checkedTotals(usage);
  const ledger = provider as UsageLedgerProvider;
  const dims = readUsageLedgerPlaces(db, ledger), rules = currentProjectRules(db), plans = new Map(owned.plans.map(plan => [plan.account, plan]));
  const keys = readDayActKeys(db, ledger, owned.range.since, owned.range.until);
  let keyRates: ReturnType<typeof readLedgerKeyRates> | null = null;
  const ratesOf = (key: number) => (keyRates ??= readLedgerKeyRates(db, ledger)).get(key) ?? null;
  const groups = new Map<string, Map<string, Exact>>(), unpriced = new Map<string, ProjectUnpricedGroup>(), active = new Map<string, Set<string>>();
  const groupOf = (account: string, subject: string | null, day: string): Exact => {
    const byAccount = groups.get(account) ?? groups.set(account, new Map()).get(account)!;
    let group = byAccount.get(subject ?? "");
    if (!group) byAccount.set(subject ?? "", group = { subject, firstDay: day, tokens: 0, calls: 0, types: zero(), actual: 0n, byType: zeroExact(), standard: 0n, models: new Map() });
    if (day < group.firstDay) group.firstDay = day;
    return group;
  };
  const addUnpriced = (account: string, model: string | null, reason: string, tokens: number, calls: number) => {
    const shown = presentedReason(reason), name = model || "?", key = `${account}|${shown}|${name}`;
    const item = unpriced.get(key) ?? { account, model: name, reason: shown, tokens: 0, calls: 0 };
    item.tokens = safeCount(item.tokens + tokens, "unpriced token sum");
    item.calls = safeCount(item.calls + calls, "unpriced call sum");
    unpriced.set(key, item);
  };
  /** Priced calls of one row (or one call): bucket sums valued at the key's stored rates, which must add up to the stored amount. */
  const addPriced = (group: Exact, model: string | null, counts: Record<TokenBucket, number>, calls: number, key: number, actual: bigint, standard: bigint | null) => {
    const keyed = ratesOf(key), byType = zeroExact(), tokensBefore = group.tokens;
    for (const bucket of TOKEN_BUCKETS) {
      const quantity = counts[bucket];
      if (!quantity) continue;
      const rate = keyed?.[bucket];
      if (rate == null || rate === "invalid") throw new UnsafeProjectSum(`Priced ${provider} calls without a ${bucket} rate (key ${key})`);
      byType[TYPE_OF[bucket]] += BigInt(quantity) * BigInt(rate);
      group.types[TYPE_OF[bucket]] = safeCount(group.types[TYPE_OF[bucket]] + quantity, "token type sum");
      group.tokens = safeCount(group.tokens + quantity, "priced token sum");
    }
    if (byType.in_uncached + byType.cache_read + byType.cache_write + byType.out !== actual)
      throw new UnsafeProjectSum(`Stored ${provider} amount and its token-type split disagree (key ${key})`);
    for (const type of ["in_uncached", "cache_read", "cache_write", "out"] as const) group.byType[type] += byType[type];
    group.calls = safeCount(group.calls + calls, "priced call sum");
    group.actual += actual;
    const modelSum = group.models.get(model || "?") ?? { tokens: 0, calls: 0, actual: 0n };
    modelSum.tokens += group.tokens - tokensBefore; modelSum.calls += calls; modelSum.actual += actual;
    group.models.set(model || "?", modelSum);
    group.standard = group.standard === null || standard === null ? null : group.standard + standard;
  };
  /** A row the sums cannot split, from its own calls the account owns (the stored valuation of each). */
  const addCalls = (account: string, subject: string | null, day: string, calls: LedgerValuedCall[]) => {
    const plan = plans.get(account)!;
    for (const call of calls) {
      if (!plan.owns(call.source, call.account_key, call.ts)) continue;
      const counts: Record<TokenBucket, number> = { in_uncached: call.q_uncached, in_cache_read: call.q_cache_read,
        in_cache_write_5m: call.q_write_5m, in_cache_write_1h: call.q_write_1h, in_cache_write_unknown: call.q_write_unknown, out_total: call.q_out };
      if (call.act_reason !== null) {
        // A call priced at nothing keeps its recorded tokens, invalid counters included.
        addUnpriced(account, call.model, call.act_reason, safeCount(TOKEN_BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0), "call tokens"), 1);
        continue;
      }
      addPriced(groupOf(account, subject, day), call.model, counts, 1, call.act_key!, limbsFemto(call.act_usd, call.act_nano, call.act_femto),
        call.std_reason === null ? limbsFemto(call.std_usd, call.std_nano, call.std_femto) : null);
    }
  };
  const exceptionalDims = new Map<string, Set<number>>();
  const rows = owned.rows.map(ownedRow => {
    const { row } = ownedRow;
    const actual = decodeCounts(row.counts).api_actual, standard = decodeCounts(row.counts).api_standard;
    const priced = Number(actual?.pricedEvents ?? 0), unpricedCalls = Number(actual?.unpricedEvents ?? 0);
    const key = keys.get(activityDayKey(row.day, Number(row.dim))) ?? null;
    const needsCalls = Number(decodeQuality(row.quality).invalid_token_events ?? 0) > 0 || priced > 0 && (unpricedCalls > 0 || key === null);
    if (needsCalls) {
      const selected = exceptionalDims.get(row.day) ?? new Set<number>();
      selected.add(Number(row.dim)); exceptionalDims.set(row.day, selected);
    }
    return { ...ownedRow, actual, standard, priced, unpricedCalls, key, needsCalls };
  });
  // Only one exceptional day is retained; account ownership is still checked separately for every row.
  let callsDay: string | null = null, dayCalls = new Map<number, LedgerValuedCall[]>();
  for (const { row, account, calls, actual, standard, priced, unpricedCalls, key, needsCalls } of rows) {
    const dim = dims.get(row.dim)!, subject = placeSubject(rules, provider, dim, row.day);
    (active.get(account) ?? active.set(account, new Set()).get(account)!).add(row.day);
    if (needsCalls) {
      if (callsDay !== row.day) {
        dayCalls = readDayRowsCalls(db, ledger, row.day, [...exceptionalDims.get(row.day)!]);
        callsDay = row.day;
      }
      addCalls(account, subject, row.day, dayCalls.get(Number(row.dim)) ?? []);
      continue;
    }
    if (priced + unpricedCalls !== calls) throw new UnsafeProjectSum(`Stored ${provider} row ${row.day}/${row.dim} counts ${calls} calls, valued ${priced + unpricedCalls}`);
    if (unpricedCalls > 0) {
      for (const [reason, counted] of Object.entries(actual!.reasons)) addUnpriced(account, dim.model, reason, Number(counted.tokens), Number(counted.events));
      continue;
    }
    const tokens = decodeTokens(row.tokens);
    const counts = Object.fromEntries(TOKEN_BUCKETS.map(bucket => [bucket, Number(tokens[bucket] ?? 0)])) as Record<TokenBucket, number>;
    addPriced(groupOf(account, subject, row.day), dim.model, counts, priced, key!, femtoOf(actual!.pricedSubtotal),
      Number(standard?.unpricedEvents ?? 0) > 0 ? null : femtoOf(standard?.pricedSubtotal ?? "0"));
  }
  Object.assign(usage, ownedAccounts(provider, owned, active));
  // Claude lists an account's subjects as its days first show them, the other providers by account and subject.
  const accountOrder = provider === "claude" ? [...groups.keys()].sort() : [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const account of accountOrder) {
    const list = [...groups.get(account)!.values()].sort((a, b) => (provider === "claude" && a.firstDay !== b.firstDay
      ? a.firstDay < b.firstDay ? -1 : 1 : 0) || (a.subject ?? "").localeCompare(b.subject ?? ""));
    for (const group of list) usage.groups.push({ account, subject: group.subject, tokens: group.tokens, calls: group.calls,
      tokens_by_type: group.types, api_usd: usdOf(group.actual),
      api_usd_by_type: { in_uncached: usdOf(group.byType.in_uncached), cache_read: usdOf(group.byType.cache_read),
        cache_write: usdOf(group.byType.cache_write), out: usdOf(group.byType.out) },
      standard_usd: group.standard === null ? null : usdOf(group.standard),
      models: Object.fromEntries([...group.models].map(([model, sum]) => [model, { tokens: sum.tokens, calls: sum.calls, api_usd: usdOf(sum.actual) }])) });
  }
  usage.unpriced = [...unpriced.values()].sort((a, b) =>
    a.account.localeCompare(b.account) || a.model.localeCompare(b.model) || a.reason.localeCompare(b.reason));
  return checkedTotals(usage);
}
/** Separately safe account and subject sums, and the source's evidence, must also fit when the report combines them. */
function checkedTotals(usage: ProjectUsage): ProjectUsage {
  let tokens = 0, calls = 0;
  for (const group of [...usage.groups, ...usage.unpriced, ...usage.evidence]) {
    tokens = safeCount(tokens + group.tokens, "combined token sum");
    calls = safeCount(calls + group.calls, "combined call sum");
  }
  return usage;
}
