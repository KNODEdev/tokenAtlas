import type { Database } from "bun:sqlite";
import { ACCOUNT_PERIODS, ACCOUNT_PERIODS_REVISION, loadPeriods } from "../db/period-store";
import { claudeIdentitySubscription } from "../ingest/claude-identity";
import { buildPeriodIndex, effectiveDatedPeriods, periodInstant, type DatedPeriod, type PeriodIndex } from "./account-periods";
import { normEraKey, normEraVendor } from "./eras";

/**
 * Account at read time (register version 8). An event and a sum know only their source (archive
 * folder) and time, plus the identity the session itself recorded when it did. The account comes
 * from here, by the precedence accepted on 2026-09-21: session identity > declared period >
 * observed period > nothing (a gap or uncovered time is explicit, never assigned).
 *
 * Cached per database revision from `account_periods` (~30 rows) and identity declarations of
 * `accounts.json`; nothing here is stored, so changing a period changes only what the next read
 * returns.
 */
export interface AccountResolution {
  account: string | null;
  basis: "identity" | "declared" | "observed" | "gap" | "uncovered" | "no-source";
}

/** `[from, until)` in epoch milliseconds; an open period ends at `Infinity`. */
export interface SourceRange { source: string; from: number; until: number }

/** One day of one source inside a plan: whole, or the part of it the plan covers. */
export interface PlanDay { source: string; day: string; whole: boolean; from: number; until: number }

export interface AccountReadPlan {
  provider: string;
  account: string;
  /** Stable identity-account clocks: derived Claude ids, including aliases mapped to this account. */
  identityKeys: string[];
  /** Per source, disjoint and sorted; declared time already takes precedence over observed. */
  ranges: SourceRange[];
  /** Whether a row of this source, identity and instant counts for this account. */
  owns(source: string | null, identity: string | null, ts: string): boolean;
  /** The days of `[since, until]` (YYYY-MM-DD, inclusive) the plan covers, whole or cut. */
  days(since: string, until: string): PlanDay[];
}

export interface AccountResolver {
  resolve(provider: string, source: string | null, identity: string | null, ts: string): AccountResolution;
  /** The account a session identity names, or null when the provider records none. */
  identityAccount(provider: string, identity: string | null): string | null;
  /** Session identities `accounts.json` declares, each with the account it resolves to. */
  declaredIdentities(provider: string): ReadonlyArray<{ identity: string; account: string }>;
  plan(provider: string, account: string): AccountReadPlan;
  /** Accounts the periods of a provider name, lower-cased and sorted. */
  accounts(provider: string): string[];
}

export interface IdentityDeclaration { id?: string; account_key?: string; vendor?: string }

const DAY = 86_400_000;
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** `a \ b` for sorted, disjoint interval lists. */
function subtract(a: readonly SourceRange[], b: readonly SourceRange[]): SourceRange[] {
  const out: SourceRange[] = [];
  for (const range of a) {
    let from = range.from;
    for (const cut of b) {
      if (cut.until <= from || cut.from >= range.until) continue;
      if (cut.from > from) out.push({ source: range.source, from, until: cut.from });
      from = Math.max(from, cut.until);
      if (from >= range.until) break;
    }
    if (from < range.until) out.push({ source: range.source, from, until: range.until });
  }
  return out;
}

function toRange(period: DatedPeriod): SourceRange {
  return { source: normEraKey(period.subject), from: periodInstant(period.from, "from"),
    until: period.until === null ? Infinity : periodInstant(period.until, "until") };
}

export function buildAccountResolver(periods: readonly DatedPeriod[], declarations: readonly IdentityDeclaration[] = []): AccountResolver {
  const index: PeriodIndex = buildPeriodIndex(periods);
  periods = effectiveDatedPeriods(periods);
  const claudeDeclarations = declarations
    .filter((d) => normEraVendor(d.vendor) === "claude" && d.id && d.account_key)
    .map((d) => ({ id: d.id!, account_key: d.account_key! }));
  const identityAccount = (provider: string, identity: string | null): string | null => {
    if (!identity) return null;
    // Only Claude records who was signed in inside the session file; the id is derived from the
    // key itself when no declaration names it, so the mapping needs no configuration to be stable.
    return normEraVendor(provider) === "claude" ? claudeIdentitySubscription(identity, claudeDeclarations).toLowerCase() : null;
  };
  const plans = new Map<string, AccountReadPlan>();
  return {
    identityAccount,
    declaredIdentities(provider) {
      if (normEraVendor(provider) !== "claude") return [];
      return [...new Set(claudeDeclarations.map((d) => d.account_key))].sort()
        .map((identity) => ({ identity, account: identityAccount("claude", identity)! }));
    },
    resolve(provider, source, identity, ts) {
      const direct = identityAccount(provider, identity);
      if (direct) return { account: direct, basis: "identity" };
      if (!source) return { account: null, basis: "no-source" };
      const found = index.resolve(provider, source, ts);
      if (found.value !== null) return { account: found.value.toLowerCase(), basis: found.basis === "direct" ? "identity" : found.basis };
      return { account: null, basis: found.basis };
    },
    accounts(provider) {
      const vendor = normEraVendor(provider);
      return [...new Set(periods.filter((p) => normEraVendor(p.provider) === vendor).map((p) => p.value.toLowerCase()))].sort();
    },
    plan(provider, account) {
      const vendor = normEraVendor(provider), wanted = account.toLowerCase(), key = `${vendor}|${wanted}`;
      const cached = plans.get(key);
      if (cached) return cached;
      const ranges: SourceRange[] = [];
      const bySource = new Map<string, DatedPeriod[]>();
      for (const period of periods) {
        if (normEraVendor(period.provider) !== vendor) continue;
        const source = normEraKey(period.subject), list = bySource.get(source) ?? [];
        list.push(period);
        bySource.set(source, list);
      }
      const order = (a: SourceRange, b: SourceRange) => a.from - b.from;
      for (const list of bySource.values()) {
        const own = (p: DatedPeriod) => p.value.toLowerCase() === wanted;
        const declaredAll = list.filter((p) => p.origin === "declared").map(toRange).sort(order);
        const declaredOwn = list.filter((p) => p.origin === "declared" && own(p)).map(toRange).sort(order);
        const observedOwn = list.filter((p) => p.origin === "observed" && own(p)).map(toRange).sort(order);
        ranges.push(...declaredOwn, ...subtract(observedOwn, declaredAll));
      }
      ranges.sort((a, b) => a.source.localeCompare(b.source) || a.from - b.from);
      const plan: AccountReadPlan = {
        provider: vendor, account: wanted, ranges,
        identityKeys: vendor === "claude" ? [...new Set([wanted, ...claudeDeclarations
          .filter(d => d.id.toLowerCase() === wanted)
          .map(d => claudeIdentitySubscription(d.account_key, []).toLowerCase())])].sort() : [],
        owns(source, identity, ts) {
          const direct = identityAccount(vendor, identity);
          if (direct) return direct === wanted;
          if (!source) return false;
          const at = periodInstant(ts, "event time"), lower = normEraKey(source);
          return ranges.some((r) => r.source === lower && r.from <= at && at < r.until);
        },
        days(since, until) {
          const out: PlanDay[] = [];
          const first = dayStart(since), last = dayStart(until) + DAY;
          for (const r of ranges) {
            const from = Math.max(r.from, first), stop = Math.min(r.until, last);
            if (from >= stop) continue;
            for (let start = dayStart(dayOf(from)); start < stop; start += DAY) {
              const dayFrom = Math.max(start, from), dayUntil = Math.min(start + DAY, stop);
              out.push({ source: r.source, day: dayOf(start), whole: dayFrom === start && dayUntil === start + DAY, from: dayFrom, until: dayUntil });
            }
          }
          return out;
        },
      };
      plans.set(key, plan);
      return plan;
    },
  };
}

/** The resolver for a database: its account periods and the identity declarations it was given. */
const resolverCache = new WeakMap<Database, { revision: string; identities: string; resolver: AccountResolver }>();
export function loadAccountResolver(sqlite: Database, declarations: readonly IdentityDeclaration[] = []): AccountResolver {
  const hasTable = sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_periods'").get();
  const hasMeta = sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
  const revision = `${!!hasTable}:${hasMeta ? (sqlite.query("SELECT value FROM meta WHERE key=?").get(ACCOUNT_PERIODS_REVISION) as { value: string } | null)?.value ?? "0" : "0"}`;
  const identities = JSON.stringify(declarations.filter(d => normEraVendor(d.vendor) === "claude" && d.id && d.account_key)
    .map(d => [d.account_key, d.id!.toLowerCase()]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const cached = resolverCache.get(sqlite);
  if (cached?.revision === revision && cached.identities === identities) return cached.resolver;
  const resolver = buildAccountResolver(hasTable ? loadPeriods(sqlite, ACCOUNT_PERIODS) : [], declarations);
  resolverCache.set(sqlite, { revision, identities, resolver });
  return resolver;
}
