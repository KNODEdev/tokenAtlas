import type { Database, SQLQueryBindings } from "bun:sqlite";
import { ARCHIVE_LOGICAL_ROOT, MACHINE } from "../config/paths";
import { analysisHash } from "../db/analysis";
import { queryRows } from "./data-groups";
import { codexReadingEvidenceSql } from "../db/codex-ledger-canonical";
import { loadAccountResolver, type AccountResolution, type AccountResolver, type IdentityDeclaration } from "./account-resolver";
import type { SourceDeclaration } from "./archive-source";
import type { ClaudeAccountSql } from "./claude-event-account";
import { codexHomeSource } from "./event-source";

/**
 * The account of a Codex row (a rollout event in `events`, a rate-limit sample in `ratelimit`) at
 * read time (docs/account-periods-model-2026-09-21.md §1): the account period covering the row's
 * source and instant, otherwise none. The source is the archive folder of the row's `home`
 * (`codexHomeSource`: an archive home is its own folder, a local profile the folder `accounts.json`
 * declares for it). Codex records no identity in the session, and reset anchors are evidence of a
 * period, not an owner: nothing is stamped on a row.
 *
 * The statement names each stored `home` that has a source, mapped in JS by `codexHomeSource`
 * itself, so SQL and resolver agree by construction and the comparison is exact equality on the
 * column. Periods are parameters, clipped to `within` when given: a period change alters only the
 * statements of the time it covers, and `stamp` with them. `ts` is compared as text, exact for
 * the `toISOString()` instants ingest stores (every row on the live database, 23.09).
 */
export type CodexAccountSql = ClaudeAccountSql;

export type CodexHomeTable = "ratelimit" | "events";

export interface CodexAccountContext {
  sqlite: Database;
  resolver?: AccountResolver;
  accounts?: { subscriptions?: readonly IdentityDeclaration[]; sources?: readonly SourceDeclaration[] };
}

export interface CodexAccountOptions {
  /** Table alias of the Codex table in the caller's statement. */
  alias?: string;
  /** Rows at instants in `[from, until)` (ISO instants or days) only: periods outside it are left out. */
  within?: { from: string; until: string };
}

export interface CodexAccountSelector {
  /** Expression naming the (lower-cased) account of each row, or NULL when no period owns it. */
  account(options?: CodexAccountOptions): CodexAccountSql;
  /** Predicate selecting the rows `account` owns. */
  ownedBy(account: string, options?: CodexAccountOptions): CodexAccountSql;
  /**
   * NULL for an owned row, otherwise why it has no account: its home has no source
   * (`source-not-declared`), or no period of its source covers its instant (`outside-declared-era`:
   * a gap between periods or time before or after them, explicitly uncertain). The codes are the
   * ones the usage screen already labels.
   */
  unownedReason(options?: CodexAccountOptions): CodexAccountSql;
  /** The same answer for one row, in JS: the reference the SQL reproduces. */
  accountAt(home: string | null, ts: string): string | null;
  /** The resolution behind `accountAt`; null when the row has no source or no comparable instant. */
  resolutionAt(home: string | null, ts: string): AccountResolution | null;
}

/** Every stored `home` of a Codex table: a handful of profiles. */
export function codexTableHomes(db: Database, table: CodexHomeTable): string[] {
  if (table === "events" && !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()
    && db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_price_ledger_copies'").get()) {
    return (db.query("SELECT DISTINCT home AS h FROM codex_price_ledger_copies WHERE home IS NOT NULL").all() as {h:string}[]).map(row=>row.h);
  }
  // Both tables have an index led by `home` (events_ts, rl_ts): one seek per home instead of a scan of every
  // row (0.3–0.5 s for `events` on every Codex screen read).
  return queryRows<{ h: string }>(db, `WITH RECURSIVE homes(h) AS (SELECT MIN(home) FROM ${table}
      UNION ALL SELECT (SELECT MIN(home) FROM ${table} WHERE home > homes.h) FROM homes WHERE homes.h IS NOT NULL)
    SELECT h FROM homes WHERE h IS NOT NULL`).map(row => row.h);
}

/**
 * `ts` is compared as text with period bounds in `toISOString()` form, which orders instants correctly
 * only when `ts` has that form too. Ingest writes it (engine `canonical_ts`; every live row, 23.09); a
 * second-precision `…:ssZ`, exact without milliseconds, is read as `…:ss.000Z`. Anything else (no zone,
 * another fraction, an offset, an impossible date, unparsable text) could sort to the wrong side of a bound, so it belongs
 * to no account (`timestamp-invalid`) and stays in the row as evidence. SQL and `accountAt` share this rule.
 */
const MS_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, SECOND_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DIGITS = (n: number) => "[0-9]".repeat(n);
const SECOND_GLOB = `${DIGITS(4)}-${DIGITS(2)}-${DIGITS(2)}T${DIGITS(2)}:${DIGITS(2)}:${DIGITS(2)}`;
const comparableTs = (ts: string | null): string | null => {
  const key = !ts ? null : MS_TS.test(ts) ? ts : SECOND_TS.test(ts) ? `${ts.slice(0, 19)}.000Z` : null;
  const at = key === null ? NaN : Date.parse(key);
  // The same rule as the SQL: an instant that does not write back unchanged (month 13, 31 April) is none.
  return Number.isFinite(at) && new Date(at).toISOString() === key ? key : null;
};
const iso = (ms: number): string => new Date(ms).toISOString();
const instant = (value: string): number => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);

/**
 * The effective Codex account periods in `[within.from, within.until)`, clipped to it, for a memo whose
 * result assigns Codex rows of that range in JS: it changes when a period in the range does, not when
 * one elsewhere does or a reading only extends one (`last_seen`).
 */
export function codexPeriodsStamp(resolver: AccountResolver, within?: { from: string; until: string }): string {
  const from = within ? instant(within.from) : -Infinity, until = within ? instant(within.until) : Infinity;
  return analysisHash(resolver.accounts("codex").flatMap((account) => {
    const ranges = resolver.plan("codex", account).ranges.filter((range) => range.until > from && range.from < until)
      .map((range) => [range.source, Math.max(range.from, from), Number.isFinite(Math.min(range.until, until)) ? Math.min(range.until, until) : null]);
    return ranges.length ? [[account, ranges]] : [];
  }));
}

interface SourceRanges { homes: string[]; ranges: Array<{ from: string; until: string | null; account: string }> }

/**
 * The selector for one read: the homes of `table` (of the whole table, or of one day for a one-day
 * statement) and their sources are looked up once, on first use, from the analysis register; a caller
 * resolving rows in JS (`accountAt`) reads no table at all.
 */
export function codexAccountSelector(ctx: CodexAccountContext, table: CodexHomeTable = "ratelimit",
  root = ARCHIVE_LOGICAL_ROOT, machine = MACHINE): CodexAccountSelector {
  const declarations = ctx.accounts?.subscriptions ?? [];
  const sourceDeclarations = ctx.accounts?.sources ?? [];
  const resolver = ctx.resolver ?? loadAccountResolver(ctx.sqlite, declarations);
  // A selector resolves every row of a range; its homes are few, so each home's source is derived once.
  const sourceByHome = new Map<string | null, string | null>();
  const sourceOf = (home: string | null) => {
    let source = sourceByHome.get(home);
    if (source === undefined && !sourceByHome.has(home)) sourceByHome.set(home, source = codexHomeSource(home, sourceDeclarations, root, machine));
    return source ?? null;
  };
  const bySourceOf = (homes: ReadonlyArray<string | null>): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const home of new Set(homes)) {
      const source = home === null ? null : sourceOf(home);
      if (source) out.set(source, [...out.get(source) ?? [], home!]);
    }
    for (const list of out.values()) list.sort();
    return out;
  };
  let whole: Map<string, string[]> | null = null;
  // Stored usage remains attributable when only the durable ledger survives (codexTableHomes).
  const sources = (): Map<string, string[]> => whole ??= bySourceOf(codexTableHomes(ctx.sqlite, table));

  const sourceRanges = (options: CodexAccountOptions, accounts: readonly string[]): SourceRanges[] => {
    const homesBySource = sources(), bySource = new Map<string, SourceRanges>();
    const from = options.within ? instant(options.within.from) : -Infinity;
    const until = options.within ? instant(options.within.until) : Infinity;
    for (const account of accounts) {
      for (const range of resolver.plan("codex", account).ranges) {
        const homes = homesBySource.get(range.source);
        if (!homes || range.until <= from || range.from >= until) continue;
        // Clipped to the window: a day inside a period reads the same statement wherever its ends move.
        const start = Math.max(range.from, from), end = Math.min(range.until, until);
        const entry = bySource.get(range.source) ?? { homes, ranges: [] };
        entry.ranges.push({ from: iso(start), until: Number.isFinite(end) ? iso(end) : null, account: account.toLowerCase() });
        bySource.set(range.source, entry);
      }
    }
    for (const entry of bySource.values()) entry.ranges.sort((a, b) => a.from.localeCompare(b.from));
    return [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry);
  };
  const columns = (options: CodexAccountOptions) => (name: string) => options.alias ? `${options.alias}.${name}` : name;
  const homeIn = (c: (name: string) => string, homes: readonly string[]) => `${c("home")} IN (${homes.map(() => "?").join(",")})`;
  const key = (c: (name: string) => string) => `(CASE WHEN ${c("ts")} GLOB '${SECOND_GLOB}.${DIGITS(3)}Z' THEN ${c("ts")} `
    + `WHEN ${c("ts")} GLOB '${SECOND_GLOB}Z' THEN substr(${c("ts")}, 1, 19) || '.000Z' END)`;
  // The shape alone admits impossible instants (month 13, 31 April, 25:00, 29 February 2026): only a key
  // SQLite writes back unchanged is a real instant. Checked once per row, before the cheap comparisons.
  const valid = (c: (name: string) => string) => `COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${key(c)}) = ${key(c)}, 0)`;
  const time = (c: (name: string) => string, until: string | null) => `${key(c)} >= ?${until === null ? "" : ` AND ${key(c)} < ?`}`;
  const finish = (sql: string, params: SQLQueryBindings[]): CodexAccountSql => ({ sql, params, stamp: analysisHash([sql, params]) });

  const resolutionAt = (home: string | null, ts: string): AccountResolution | null => {
    const at = comparableTs(ts), source = sourceOf(home);
    return at === null || source === null ? null : resolver.resolve("codex", source, null, at);
  };
  const account = (options: CodexAccountOptions = {}): CodexAccountSql => {
    const c = columns(options), params: SQLQueryBindings[] = [], cases: string[] = [];
    for (const source of sourceRanges(options, resolver.accounts("codex"))) {
      params.push(...source.homes);
      const times = source.ranges.map((range) => {
        params.push(range.from, ...(range.until === null ? [] : [range.until]), range.account);
        return `WHEN ${time(c, range.until)} THEN ?`;
      });
      cases.push(`WHEN ${homeIn(c, source.homes)} THEN CASE ${times.join(" ")} END`);
    }
    return finish(cases.length ? `CASE WHEN ${valid(c)} THEN CASE ${cases.join(" ")} END END` : "CAST(NULL AS TEXT)", params);
  };
  return {
    account,
    ownedBy(wanted, options = {}) {
      const c = columns(options), params: SQLQueryBindings[] = [], periods: string[] = [];
      for (const source of sourceRanges(options, [wanted.toLowerCase()])) {
        params.push(...source.homes);
        const times = source.ranges.map((range) => {
          params.push(range.from, ...(range.until === null ? [] : [range.until]));
          return `(${time(c, range.until)})`;
        });
        periods.push(`(${homeIn(c, source.homes)} AND (${times.join(" OR ")}))`);
      }
      return finish(periods.length ? `(${valid(c)} AND (${periods.join(" OR ")}))` : "0", params);
    },
    unownedReason(options = {}) {
      const c = columns(options), owner = account(options), mapped = [...sources().values()].flat().sort();
      const known = mapped.length ? `WHEN ${homeIn(c, mapped)} THEN CASE WHEN ${owner.sql} IS NULL THEN 'outside-declared-era' END ` : "";
      return finish(`CASE WHEN ${c("home")} IS NULL THEN 'source-missing' WHEN ${c("ts")} IS NULL THEN 'timestamp-missing' `
        + `WHEN NOT ${valid(c)} THEN 'timestamp-invalid' `
        + `${known}ELSE 'source-not-declared' END`, [...mapped, ...owner.params]);
    },
    accountAt: (home, ts) => resolutionAt(home, ts)?.account ?? null,
    resolutionAt,
  };
}

export interface OwnershipGapSummary {
  unowned_samples: number;
  reasons: Array<{ reason: string; samples: number }>;
}

/**
 * The newest gap summaries per connection, keyed by their query and the meter samples' revision: every
 * subscription switch asked again for the same whole-history count (0.1-0.2 s per request).
 */
const gapMemo = new WeakMap<Database, Map<string, OwnershipGapSummary>>();
function meterSamplesRevision(sqlite: Database): string {
  const top = (sqlite.query("SELECT MAX(rowid) AS top FROM ratelimit").get() as { top: number | null } | null)?.top ?? null;
  const synced = sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vendor_sync_revisions'").get()
    ? (sqlite.query("SELECT data_revision AS revision FROM vendor_sync_revisions WHERE vendor='codex'").get() as { revision: number } | null)?.revision ?? null
    : null;
  const ledger = sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_ledger_state'").get()
    ? (sqlite.query("SELECT revision FROM usage_ledger_state WHERE provider='codex'").get() as { revision: number } | null)?.revision ?? null
    : null;
  return JSON.stringify([top, synced, ledger]);
}

/** Samples of `homes` that no account period owns, by reason. */
export function codexOwnershipGaps(sqlite: Database, selector: CodexAccountSelector, homes: readonly string[],
  options: { windowMinutes: number; limitId: string; since?: string; until?: string }): OwnershipGapSummary {
  if (homes.length === 0) return { unowned_samples: 0, reasons: [] };
  const where = [`r.home IN (${homes.map(() => "?").join(",")})`, "r.window_minutes = ?", "r.limit_id = ?",
    codexReadingEvidenceSql(sqlite, "r")];
  const params: SQLQueryBindings[] = [...homes, options.windowMinutes, options.limitId];
  if (options.since) { where.push("substr(r.ts, 1, 10) >= ?"); params.push(options.since); }
  if (options.until) { where.push("substr(r.ts, 1, 10) <= ?"); params.push(options.until); }
  const reason = selector.unownedReason({ alias: "p" });
  const sql = `WITH picked AS (SELECT r.home AS home, r.ts AS ts FROM ratelimit r WHERE ${where.join(" AND ")})
    SELECT reason, COUNT(*) AS samples FROM (SELECT ${reason.sql} AS reason FROM picked p) WHERE reason IS NOT NULL GROUP BY reason`;
  // The reason expression carries the periods and sources it resolves with; the revision, the samples.
  const key = JSON.stringify([sql, params, reason.params, meterSamplesRevision(sqlite)]);
  const memo = gapMemo.get(sqlite) ?? new Map<string, OwnershipGapSummary>();
  gapMemo.set(sqlite, memo);
  const known = memo.get(key);
  if (known) return structuredClone(known);
  const rows = queryRows<{ reason: string; samples: number }>(sqlite, sql, [...params, ...reason.params]);
  const reasons = new Map<string, number>();
  for (const row of rows) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + row.samples);
  const sorted = [...reasons].map(([reason, samples]) => ({ reason, samples }))
    .sort((a, b) => b.samples - a.samples || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  const summary = { unowned_samples: sorted.reduce((sum, row) => sum + row.samples, 0), reasons: sorted };
  if (memo.size >= 64) memo.delete(memo.keys().next().value!);
  memo.set(key, summary);
  return structuredClone(summary);
}
