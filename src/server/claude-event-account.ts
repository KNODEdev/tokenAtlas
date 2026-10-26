import type { Database, SQLQueryBindings } from "bun:sqlite";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { analysisHash } from "../db/analysis";
import type { AccountResolver } from "./account-resolver";
import { normEraKey } from "./eras";
import { readUsageLedgerDayFacts, readUsageLedgerPlaceDays } from "./ledger-sums";

/**
 * The account of a `claude_events` row at read time (docs/account-periods-model-2026-09-21.md §1):
 * the identity the session recorded, otherwise the account period covering the row's source (the
 * archive folder of `path`, as `archiveSourceKey` names it) and instant, otherwise none. Nothing is
 * stamped on the row: the statement carries the resolver's period ranges as parameters, so a changed
 * period is a different statement and `stamp` changes with it.
 *
 * Every session identity the table holds is mapped here exactly as the resolver maps it, so an edit to
 * the identity declarations of `accounts.json` needs no rewrite of stored rows. A conflicted identity
 * (`subscription_conflict`) belongs to nobody.
 *
 * Two comparisons stay in SQL and rest on the shape of the data: `ts` is compared as text, which is
 * exact because ingest stores `toISOString()` instants; and the folder is lower-cased by SQLite's
 * `lower()`, which folds ASCII only, while `normEraKey` folds everything. Archive folder names are
 * computer and profile names; an upper-case non-ASCII letter in one would leave its rows unassigned,
 * explicitly, never on another account.
 */
export interface ClaudeAccountSql {
  sql: string;
  params: SQLQueryBindings[];
  /** Identity of the statement and its parameters, for memo configurations. */
  stamp: string;
}

export interface ClaudeAccountOptions {
  /** Table alias of `claude_events` in the caller's statement. */
  alias?: string;
  /** Archive root the stored paths live under; the register uses the logical root. */
  root?: string;
  /**
   * The statement is applied only to rows at instants in `[from, until)` (ISO instants or days): periods
   * outside it are left out, so a period change alters only the statements of the time it covers.
   */
  within?: { from: string; until: string };
}

interface SourceRanges { prefix: string; ranges: Array<{ from: string; until: string | null; account: string }> }

const iso = (ms: number): string => new Date(ms).toISOString();
const instant = (value: string): number => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);

function columns(options: ClaudeAccountOptions) {
  const c = (name: string) => options.alias ? `${options.alias}.${name}` : name;
  return {
    c,
    // The same folder rule as `archiveFolderOf`: separators unified, compared lower-cased.
    folder: `lower(replace(${c("path")}, char(92), '/'))`,
  };
}

/**
 * Every unconflicted session identity recorded in `claude_events`: a handful of keys, one per signed-in account.
 * Only rows inserted above this connection's last look are scanned (an identity arrives
 * only with an inserted row; a replaced file is re-inserted). A publication that copies staged ids can
 * insert below that point: when the row count grew by anything but the rows above it, all rows are read.
 */
const lastLook = new WeakMap<Database, { top: number; count: number; keys: string[] }>();
function sessionIdentities(db: Database): string[] {
  // A table without the column (an old schema) records no identities; its reads fail as before.
  if (!(db.query("PRAGMA table_info(claude_events)").all() as Array<{ name: string }>).some((c) => c.name === "account_key")) return [];
  const { top, count } = db.query("SELECT COALESCE(MAX(rowid), 0) AS top, COUNT(*) AS count FROM claude_events").get() as { top: number; count: number };
  const prior = lastLook.get(db);
  const above = prior && prior.top <= top
    ? (db.query("SELECT COUNT(*) AS n FROM claude_events WHERE rowid > ?").get(prior.top) as { n: number }).n : -1;
  const from = prior && count - prior.count === above ? prior : { top: 0, keys: [] };
  const keys = new Set(from.keys);
  // Both expressions below give conflicted rows no account, so only unconflicted keys matter. A first
  // look is then served by the partial index of migration 0042 instead of reading every event; later
  // looks read only the rowid range above the last one. Conflicts are only ever set in place, so a
  // key still enters this set only with an inserted row.
  const unconflicted = "account_key IS NOT NULL AND COALESCE(subscription_conflict,0)=0";
  const found = from.top
    ? db.query(`SELECT DISTINCT account_key AS key FROM claude_events NOT INDEXED WHERE rowid > ? AND ${unconflicted}`).all(from.top)
    : db.query(`SELECT DISTINCT account_key AS key FROM claude_events WHERE ${unconflicted}`).all();
  for (const row of found as Array<{ key: string }>) keys.add(row.key);
  const look = { top, count, keys: [...keys].sort() };
  lastLook.set(db, look);
  return look.keys;
}

/** Period ranges of the given Claude accounts, grouped by source so each row tests its folder once. */
function sourceRanges(resolver: AccountResolver, options: ClaudeAccountOptions, accounts: readonly string[]): SourceRanges[] {
  const bySource = new Map<string, SourceRanges>();
  const base = normEraKey(options.root ?? ARCHIVE_LOGICAL_ROOT);
  const from = options.within ? instant(options.within.from) : -Infinity;
  const until = options.within ? instant(options.within.until) : Infinity;
  for (const account of accounts) {
    for (const range of resolver.plan("claude", account).ranges) {
      if (range.until <= from || range.from >= until) continue;
      // Clipped to the window: a day inside a period reads the same statement wherever the period's
      // ends move, so only the days an edit actually changes are read again.
      const start = Math.max(range.from, from), end = Math.min(range.until, until);
      const entry = bySource.get(range.source) ?? { prefix: `${base}/${range.source}/`, ranges: [] };
      entry.ranges.push({ from: iso(start), until: Number.isFinite(end) ? iso(end) : null, account: account.toLowerCase() });
      bySource.set(range.source, entry);
    }
  }
  for (const entry of bySource.values()) entry.ranges.sort((a, b) => a.from.localeCompare(b.from));
  return [...bySource.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/**
 * The identity part: each recorded key maps to the account the resolver gives it. A key newer than
 * the look above keeps the id ingest derived from the key alone, which is what an undeclared key maps to.
 */
function identityAccount(db: Database, resolver: AccountResolver, c: (name: string) => string): { sql: string; params: SQLQueryBindings[] } {
  const keys = sessionIdentities(db);
  if (!keys.length) return { sql: `lower(${c("subscription_id")})`, params: [] };
  return {
    sql: `CASE ${c("account_key")} ${keys.map(() => "WHEN ? THEN ?").join(" ")} ELSE lower(${c("subscription_id")}) END`,
    params: keys.flatMap((key) => [key, resolver.identityAccount("claude", key)]),
  };
}

function finish(sql: string, params: SQLQueryBindings[]): ClaudeAccountSql {
  return { sql, params, stamp: analysisHash([sql, params]) };
}

/** Expression naming the (lower-cased) account of each row, or NULL when none owns it. */
export function claudeEventAccountSql(db: Database, resolver: AccountResolver, options: ClaudeAccountOptions = {}): ClaudeAccountSql {
  const { c, folder } = columns(options);
  const identity = identityAccount(db, resolver, c);
  const sql = [`CASE WHEN COALESCE(${c("subscription_conflict")}, 0) <> 0 THEN NULL`,
    `WHEN ${c("account_key")} IS NOT NULL THEN ${identity.sql}`];
  const params: SQLQueryBindings[] = [...identity.params];
  for (const source of sourceRanges(resolver, options, resolver.accounts("claude"))) {
    params.push(source.prefix);
    const cases = source.ranges.map((range) => {
      params.push(range.from, ...(range.until === null ? [] : [range.until]), range.account);
      return `WHEN ${c("ts")} >= ?${range.until === null ? "" : ` AND ${c("ts")} < ?`} THEN ?`;
    });
    sql.push(`WHEN substr(${folder}, 1, ${source.prefix.length}) = ? THEN CASE ${cases.join(" ")} END`);
  }
  sql.push("END");
  return finish(sql.join(" "), params);
}

/** Predicate selecting the rows `account` owns at read time. */
export function claudeEventOwnedBySql(db: Database, resolver: AccountResolver, account: string, options: ClaudeAccountOptions = {}): ClaudeAccountSql {
  const { c, folder } = columns(options);
  const identity = identityAccount(db, resolver, c);
  const wanted = account.toLowerCase();
  const params: SQLQueryBindings[] = [...identity.params, wanted];
  const periods: string[] = [];
  for (const source of sourceRanges(resolver, options, [wanted])) {
    params.push(source.prefix);
    const times = source.ranges.map((range) => {
      params.push(range.from, ...(range.until === null ? [] : [range.until]));
      return `(${c("ts")} >= ?${range.until === null ? "" : ` AND ${c("ts")} < ?`})`;
    });
    periods.push(`(substr(${folder}, 1, ${source.prefix.length}) = ? AND (${times.join(" OR ")}))`);
  }
  return finish(`(COALESCE(${c("subscription_conflict")}, 0) = 0 AND CASE WHEN ${c("account_key")} IS NOT NULL `
    + `THEN ${identity.sql} = ? ELSE ${periods.length ? periods.join(" OR ") : "0"} END)`, params);
}

export interface ClaudeAccountHistory { id: string; n: number; first: string; last: string }
const dayStartIso = (day: string) => `${day}T00:00:00.000Z`;
const nextDayIso = (day: string) => new Date(Date.parse(dayStartIso(day)) + 86_400_000).toISOString();
/**
 * Rows, first and last row of each Claude account over the whole history, exactly as grouping `claude_events` by
 * `claudeEventAccountSql` counts them, read from the usage ledger instead of every event: the day sums of each source
 * and session identity, and the facts of a source's day that is not one account's whole (a period begins or ends in
 * it, or it has copies or identity conflicts). Null while the ledger has not been published; the caller reads the
 * events then.
 */
export function claudeAccountHistoryFromLedger(db: Database, resolver: AccountResolver,
  ledgerReady: () => boolean, root: string = ARCHIVE_LOGICAL_ROOT): ClaudeAccountHistory[] | null {
  try { if (!ledgerReady()) return []; } catch { return null; }
  const base = normEraKey(root);
  const ranges = new Map(sourceRanges(resolver, { root }, resolver.accounts("claude"))
    .map(entry => [entry.prefix.slice(base.length + 1, -1), entry.ranges]));
  const identities = new Map<string, string | null>();
  const identityAccount = (key: string) => {
    if (!identities.has(key)) identities.set(key, resolver.identityAccount("claude", key));
    return identities.get(key)!;
  };
  /** The account of every row of a source's day, null for none, undefined when the day is split. */
  const dayAccount = (source: string | null, day: string): string | null | undefined => {
    const from = dayStartIso(day), until = nextDayIso(day);
    const touching = (source === null ? [] : ranges.get(normEraKey(source)) ?? []).filter(range => range.from < until && (range.until === null || range.until > from));
    if (!touching.length) return null;
    const whole = touching.length === 1 && touching[0]!.from <= from && (touching[0]!.until === null || touching[0]!.until >= until);
    return whole ? touching[0]!.account : undefined;
  };
  const totals = new Map<string, ClaudeAccountHistory>();
  const add = (id: string | null, n: number, first: string, last: string) => {
    if (id === null || n === 0) return;
    const total = totals.get(id);
    if (!total) { totals.set(id, { id, n, first, last }); return; }
    total.n += n;
    if (first < total.first) total.first = first;
    if (last > total.last) total.last = last;
  };
  const rows = readUsageLedgerPlaceDays(db, "claude");
  // A source's day is read from its facts when any of its rows is not a whole day of one account.
  const split = new Set<string>(), place = (source: string | null, day: string) => JSON.stringify([source, day]);
  for (const row of rows)
    if (row.irregular > 0 || row.identity === null && dayAccount(row.source, row.day) === undefined) split.add(place(row.source, row.day));
  for (const row of rows) {
    if (split.has(place(row.source, row.day))) continue;
    add(row.identity !== null ? identityAccount(row.identity) : dayAccount(row.source, row.day) ?? null, row.n, row.first_ts, row.last_ts);
  }
  for (const key of split) {
    const [source, day] = JSON.parse(key) as [string | null, string];
    const own = source === null ? [] : ranges.get(normEraKey(source)) ?? [];
    for (const fact of readUsageLedgerDayFacts(db, "claude", day, source)) {
      const id = fact.identity_conflict ? null : fact.account_key !== null ? identityAccount(fact.account_key)
        : own.find(range => fact.ts >= range.from && (range.until === null || fact.ts < range.until))?.account ?? null;
      add(id, 1, fact.ts, fact.ts);
    }
  }
  return [...totals.values()];
}
