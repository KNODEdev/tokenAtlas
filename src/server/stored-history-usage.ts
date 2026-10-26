import type { Database } from "bun:sqlite";
import type { RegisterDayRow } from "../db/usage-price-read-account";
import { decodeCounts, decodeQuality, decodeTokens } from "../db/usage-price-measures";
import { loadAccountResolver, type AccountReadPlan, type AccountResolver, type IdentityDeclaration } from "./account-resolver";
import { claudeSourceDiscovery, type ClaudeConflictingIdentities, type ClaudeProjectEvidence } from "./claude-project-usage";
import { providerSourceDiscovery, PROVIDER_PROJECT_USAGE_CONTRACT, type ProjectFactProvider, type ProviderProjectConflict,
  type ProviderProjectEvidence } from "./provider-project-usage";
import { activityDayKey, readActivityDays, readConflictedIdentities, readUsageLedgerPlaces } from "./ledger-sums";
import { currentProjectRules, placeSubject } from "../projects/rules-now";
import { CLAUDE_PROVENANCE_RULE, CLAUDE_SUBJECT_RULE, TOKEN_BUCKETS } from "./subscription-accounting-adapters";
import { CLAUDE_CODE_PRODUCT_RULE } from "../shared/claude-code-capacity";
import type { RateCard } from "./pricing";

/**
 * Traffic, activity and money of the shared-ledger providers (Claude, Grok, GLM plan calls) for the repository/project
 * history and the subject selector, from stored rows only (docs/stored-activity-plan-2026-10-07.md step 5): the day sums
 * per dimension and account (`readRegisterDays`, which splits a day an account period cuts from its facts), the stored
 * activity (`readActivityDays`) and the stored valuations. Nothing here prices, deduplicates or walks a range's calls.
 *
 * Activity (rule D2, `STORED_ACTIVITY_RULE`): a call's active time is its gap to the previous canonical call of the same
 * session that the same account owns, however far back, capped at the idle cutoff and counted on the later call.
 */
export const STORED_ACTIVITY_RULE = "activity-d2-stored-v1";
/** Bumped when these sums change meaning. */
export const STORED_HISTORY_ALGORITHM = 1;
export const STORED_HISTORY_CONTRACT = [STORED_HISTORY_ALGORITHM, STORED_ACTIVITY_RULE, CLAUDE_SUBJECT_RULE, CLAUDE_PROVENANCE_RULE,
  CLAUDE_CODE_PRODUCT_RULE, ...PROVIDER_PROJECT_USAGE_CONTRACT] as const;

/** One verified account, canonical UTC day, subject, repository and model. */
export interface HistoryRow {
  account: string; day: string;
  /** `p:project`, `r:repo` or null when the source recorded neither. */
  subject: string | null; repo: string | null; repo_group: string | null; model: string | null;
  /** The ledger source (archive folder key) of the calls: it names the computer. */
  source: string | null;
  tokens: number; calls: number;
  /** Exact milliseconds over 1000; rounding belongs to the presentation layer. */
  active_seconds: number;
  /** Actual-mode API equivalent of the priced calls only: a subtotal, never a complete zero. */
  api_usd: number; unpriced_calls: number; unpriced_tokens: number;
}
/** Traffic whose actual-mode price is unknown, with the account that owns it. */
export interface HistoryUnpriced { account: string; model: string; reason: string; tokens: number; calls: number }
export interface HistoryUsage {
  provider: "claude" | ProjectFactProvider;
  /** Verified accounts with recognised traffic in the selected range, sorted. */
  accounts: string[];
  days_by_account: Array<[string, string[]]>;
  rows: HistoryRow[];
  unpriced: HistoryUnpriced[];
  /** Rows no verified account owns: evidence, never a guessed account. */
  evidence: Array<ClaudeProjectEvidence | ProviderProjectEvidence>;
  /** Calls excluded because their copies contradict each other, per account, counted once for the range. */
  conflicts: Array<ClaudeConflictingIdentities | ProviderProjectConflict>;
}
export interface HistoryOptions {
  since?: string; until?: string;
  /** One of the stored idle cutoffs (5, 10, 15, 30, 45, 60 minutes). */
  idleGapMinutes: number;
  resolver?: AccountResolver; declarations?: readonly IdentityDeclaration[];
}

const FIRST_DAY = "0000-01-01", LAST_DAY = "9999-12-31";
export class UnsafeHistorySum extends Error {}
function safeCount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new UnsafeHistorySum(`Unsafe history ${what}`);
  return value;
}
/** The stored reason readers report: the register records invalid counters as `invalid_usage`, per call the cache totals failed. */
export const presentedReason = (reason: string) => reason === "invalid_usage" ? "invalid_cache_totals" : reason;

/**
 * What the history and the project cost (stored-project-usage.ts) both read of a shared-ledger provider's plan calls over a
 * range: the accounts discovery finds, the evidence no account owns, the conflicted identities per account and the stored day
 * rows those accounts own, each with its calls less its conflict markers (rows without a counted call are left out).
 */
export interface OwnedRegisterRows {
  range: { since: string; until: string };
  accounts: string[];
  plans: AccountReadPlan[];
  accountDays: Map<string, Set<string>>;
  evidence: Array<ClaudeProjectEvidence | ProviderProjectEvidence>;
  conflicts: Map<string, number>;
  rows: Array<{ row: RegisterDayRow; account: string; calls: number }>;
}
export function ownedRegisterRows(db: Database, provider: "claude" | ProjectFactProvider, rates: RateCard,
  options: { since?: string; until?: string; resolver?: AccountResolver; declarations?: readonly IdentityDeclaration[] }): OwnedRegisterRows {
  const range = { since: options.since ?? FIRST_DAY, until: options.until ?? LAST_DAY };
  const resolver = options.resolver ?? loadAccountResolver(db, options.declarations);
  // Which accounts have traffic on which days, and what no account owns: the discovery every report shares.
  const discovery = provider === "claude" ? claudeSourceDiscovery(db, rates, { ...range, resolver })
    : providerSourceDiscovery(db, rates, provider, { ...range, resolver });
  const owned: OwnedRegisterRows = { range, accounts: [], plans: [], accountDays: discovery.accountDays, evidence: [], conflicts: new Map(), rows: [] };
  if (provider === "claude") {
    const unverified = (discovery as ReturnType<typeof claudeSourceDiscovery>).unverified;
    if (unverified.calls > 0 || unverified.tokens > 0) owned.evidence.push({ reason: "unverified_account", tokens: unverified.tokens, calls: unverified.calls });
  } else owned.evidence = [...(discovery as ReturnType<typeof providerSourceDiscovery>).evidence].map(([reason, totals]) => ({ reason, ...totals }));
  owned.accounts = [...discovery.accountDays.keys()].sort();
  if (!owned.accounts.length) return owned;
  owned.plans = owned.accounts.map(account => resolver.plan(provider, account));
  owned.conflicts = readConflictedIdentities(db, provider, owned.plans, range.since, range.until);
  const accounts = new Set(owned.accounts);
  // The register days discovery read (a ready ledger's, clamped to its stored days): read once.
  for (const row of discovery.rows) {
    if (!row.account || row.vendor !== null || !accounts.has(row.account)) continue;
    const calls = row.calls - Number(decodeQuality(row.quality).conflicts ?? 0);
    if (calls > 0) owned.rows.push({ row, account: row.account, calls });
  }
  return owned;
}
/**
 * The accounts a report lists with their days, given the days with counted calls (`active`): Claude lists an account only
 * with counted calls in the range, the other providers every discovered account with its discovered days. Conflicts are
 * listed for every discovered account.
 */
export function ownedAccounts(provider: "claude" | ProjectFactProvider, owned: OwnedRegisterRows, active: ReadonlyMap<string, ReadonlySet<string>>):
  Pick<HistoryUsage, "accounts" | "days_by_account" | "conflicts"> {
  const out: Pick<HistoryUsage, "accounts" | "days_by_account" | "conflicts"> = { accounts: [], days_by_account: [], conflicts: [] };
  for (const account of owned.accounts) {
    const conflicted = owned.conflicts.get(account) ?? 0;
    if (conflicted > 0) out.conflicts.push({ account, identities: conflicted });
    const days = [...(active.get(account) ?? [])].sort();
    if (provider === "claude" && !days.length) continue;
    out.accounts.push(account);
    out.days_by_account.push([account, provider === "claude" ? days : [...(owned.accountDays.get(account) ?? [])]
      .filter(day => day >= owned.range.since && day <= owned.range.until).sort()]);
  }
  return out;
}

/** The history of a shared-ledger provider's plan calls over `[since, until]`, from stored rows. */
export function storedHistoryUsage(db: Database, provider: "claude" | ProjectFactProvider, rates: RateCard, options: HistoryOptions): HistoryUsage {
  const owned = ownedRegisterRows(db, provider, rates, options);
  const usage: HistoryUsage = { provider, accounts: [], days_by_account: [], rows: [], unpriced: [], evidence: owned.evidence, conflicts: [] };
  if (!owned.accounts.length) return usage;
  const { range, plans } = owned;
  const dims = readUsageLedgerPlaces(db, provider), rules = currentProjectRules(db);
  const rows = new Map<string, HistoryRow>(), unpriced = new Map<string, HistoryUnpriced>(), active = new Map<string, Set<string>>();
  const activity = new Map(plans.map(plan => [plan.account, readActivityDays(db, provider, plan, options.idleGapMinutes, { since: range.since, until: range.until })]));
  for (const { row, account, calls } of owned.rows) {
    const dim = dims.get(row.dim)!, tokens = decodeTokens(row.tokens), counts = decodeCounts(row.counts).api_actual;
    const total = TOKEN_BUCKETS.reduce((sum, bucket) => sum + Number(tokens[bucket] ?? 0), 0);
    // The project follows the rules at read time from the place of the calls (and their raw day for dated rules).
    const subject = placeSubject(rules, provider, dim, row.day);
    const key = JSON.stringify([account, row.day, subject, dim.repo, dim.repo_group, dim.model, dim.source]);
    const target = rows.get(key) ?? { account, day: row.day, subject, repo: dim.repo, repo_group: dim.repo_group,
      model: dim.model, source: dim.source, tokens: 0, calls: 0, active_seconds: 0, api_usd: 0, unpriced_calls: 0, unpriced_tokens: 0 };
    rows.set(key, target);
    target.tokens = safeCount(target.tokens + total, "token sum");
    target.calls = safeCount(target.calls + calls, "call sum");
    // A cut day yields one row per account; its activity is read once per (day, dimension, account).
    const ms = activity.get(account)!.get(activityDayKey(row.day, Number(row.dim)));
    if (ms) { target.active_seconds += ms / 1000; activity.get(account)!.delete(activityDayKey(row.day, Number(row.dim))); }
    if (counts) {
      target.api_usd += Number(counts.pricedSubtotal);
      target.unpriced_calls = safeCount(target.unpriced_calls + Number(counts.unpricedEvents), "unpriced call sum");
      target.unpriced_tokens = safeCount(target.unpriced_tokens + Number(counts.unpricedTokens), "unpriced token sum");
      for (const [reason, counted] of Object.entries(counts.reasons ?? {})) {
        const model = dim.model || "?", shown = presentedReason(reason);
        const item = unpriced.get(`${account}|${shown}|${model}`) ?? { account, model, reason: shown, tokens: 0, calls: 0 };
        item.tokens = safeCount(item.tokens + Number(counted.tokens), "unpriced token sum");
        item.calls = safeCount(item.calls + Number(counted.events), "unpriced call sum");
        unpriced.set(`${account}|${shown}|${model}`, item);
      }
    }
    (active.get(account) ?? active.set(account, new Set()).get(account)!).add(row.day);
  }
  // Activity always rides on an owned call, so every (day, dimension) above has its row; one left over would be lost.
  for (const [account, left] of activity) if (left.size)
    throw new Error(`Stored activity of ${provider}/${account} without its day row: ${[...left.keys()].slice(0, 3).join(", ")}`);
  Object.assign(usage, ownedAccounts(provider, owned, active));
  usage.rows = [...rows.values()];
  usage.unpriced = [...unpriced.values()].sort((a, b) =>
    a.account.localeCompare(b.account) || a.model.localeCompare(b.model) || a.reason.localeCompare(b.reason));
  return usage;
}
