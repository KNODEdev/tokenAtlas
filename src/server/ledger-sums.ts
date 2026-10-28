import type { Database } from "../db/sqlite";
import { storedActivityIntervals, type ActivityInterval } from "../db/activity-intervals";
import { readCodexLedgerState } from "../db/codex-ledger-state";
import { CodexLedgerNotReady, readCodexLedgerGroups, readCodexLedgerSources, requireCodexLedgerReady, type LedgerRange,
  type LedgerStoredGroup } from "../db/codex-price-ledger";
import { codexOwnershipCuts } from "../db/codex-ledger-adapters";
import { codexEventOwner } from "./codex-event-owner";
import { registerFreshness } from "../db/read-freshness";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { ACTIVITY_CUTOFF_MINUTES, activityColumn, LONG_CALL_OUT, ledgerMoneyDecimal, sqlProvider, TIMED_SUMS, USAGE_LEDGER_VERSION, type ActivityCutoff,
  type TimedSums, type UsageLedgerProvider } from "../db/usage-ledger";
import { usageLedgerReadiness } from "../db/usage-ledger-read";
import { ledgerProviderOf, subscriptionAccountingAdapter, subscriptionAccountingAdapters, reportedUnitsPerUsd } from "./subscription-accounting-adapters";
import type { RateCard } from "./pricing";
import type { AccountReadPlan, AccountResolver } from "./account-resolver";
import { normEraKey } from "./eras";
import { currentProjectRules, placeProject, placeSubject, usagePlaceSql } from "../projects/rules-now";
import { PROJECT_TABLE_OF } from "../projects/resolve";

/**
 * Project and subject of a provider's usage-ledger dimension on a UTC day, by the project rules at read time: a reader
 * groups its SQL by dimension and asks here (once per place, per day only where a dated rule decides), as the rules as
 * one SQL expression cost about 13 microseconds a row.
 */
function usageDimProjects(db: Database, provider: UsageLedgerProvider): (dimId: number | string, day: string) => { project_id: string | null; subject: string | null } {
  const places = readUsageLedgerPlaces(db, provider), rules = currentProjectRules(db);
  return (dimId, day) => {
    const place = places.get(String(dimId));
    if (!place) return { project_id: null, subject: null };
    return { project_id: placeProject(rules, provider, place, day), subject: placeSubject(rules, provider, place, day) };
  };
}
/**
 * A filter of rows (dimension id column `dimId`, joined dimension `dims`, UTC day `day`) to one project (null: none): its
 * dimensions by id, the rules evaluated in SQL only for dimensions a dated rule may decide.
 */
function usageProjectFilter(db: Database, provider: UsageLedgerProvider, dimId: string, dims: string, day: string, projectId: string | null):
  { sql: string; params: Array<string | null> } {
  const table = PROJECT_TABLE_OF[provider], rules = currentProjectRules(db), fixed: number[] = [], dated: number[] = [];
  for (const [id, place] of readUsageLedgerPlaces(db, provider)) {
    const key = { store: place.home, cwd: place.cwd, project: place.project, repo: place.repo };
    if (table && rules.resolver.dated(table, key)) dated.push(Number(id));
    else if ((table ? rules.projectOf(table, key, day) : null) === projectId) fixed.push(Number(id));
  }
  const datedSql = dated.length ? ` OR (${dimId} IN (SELECT value FROM json_each(?)) AND ${usagePlaceSql(db, provider, dims, day).project} IS ?)` : "";
  return { sql: `(${dimId} IN (SELECT value FROM json_each(?))${datedSql})`,
    params: [JSON.stringify(fixed), ...(dated.length ? [JSON.stringify(dated), projectId] : [])] };
}

/**
 * The one reader of usage sums by day or calendar hour and by the place of a call, for every
 * provider (plan U4.1): Codex from its price ledger, the others from the shared usage ledger. Both
 * count each call once (its canonical copy). A ledger that has not caught up with its facts raises
 * `SubscriptionFactsPending`; nothing here falls back to the event tables.
 */
/** A screen's vendor: `codex` or the sync vendor of a shared-ledger provider (`opencode` for GLM). */
export type SumVendor = string;
/** Every vendor with sums: Codex and each registered ledger provider's vendor. */
export const sumVendors = (): SumVendor[] => ["codex", ...subscriptionAccountingAdapters().map(adapter => adapter.vendor)];
/** The shared-ledger provider of a screen vendor. */
export function usageLedgerProviderOfVendor(vendor: SumVendor): UsageLedgerProvider {
  const adapter = ledgerProviderOf(vendor);
  if (!adapter) throw new Error(`No usage ledger for vendor '${vendor}'`);
  return adapter.id;
}

export interface LedgerSum {
  vendor: SumVendor;
  day: string;
  /** UTC epoch hour (instant / 3 600 000) on the hour grain, null on the day grain. */
  hour: number | null;
  source: string | null; home: string | null; model: string | null; speed: string | null;
  /** Session account identity when the provider records one (Claude); Codex has no ownership identity here. */
  identity?: string | null;
  project_id: string | null; project: string | null; cwd: string | null; repo: string | null;
  /** The rate vendor a row names when the provider's plan does not cover it (OpenCode's other providers); null otherwise. */
  rate_vendor: string | null;
  calls: number; first_ts: string; last_ts: string;
  uncached: number; cache_read: number; write_5m: number; write_1h: number; write_unknown: number; out: number; thinking: number;
}
export interface LedgerSumsQuery { vendors: readonly SumVendor[]; grain: "day" | "hour"; since?: string; until?: string; includeIdentity?: boolean }

const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const hasRows = (db: Database, table: string) => tableExists(db, table) && !!db.query(`SELECT 1 FROM ${table} LIMIT 1`).get();
const text = (value: unknown): string | null => value == null || value === "" ? null : String(value);

/** Whether Codex has anything to sum: a ledger or the events it is built from. */
export function codexSumsPresent(db: Database): boolean {
  return !!readCodexLedgerState(db) || hasRows(db, "events");
}

/**
 * Whether a shared-ledger provider has facts to sum; throws until its ledger was published once.
 * Afterwards its committed sums stay readable while newer facts are processed (read-freshness.ts).
 * Token sums do not depend on prices, so the card is checked only when one is given.
 */
export function requireUsageLedgerSums(db: Database, provider: UsageLedgerProvider, card?: RateCard): boolean {
  const pending = () => new SubscriptionFactsPending(`Usage sums of ${provider} await background preparation`, provider);
  const state = tableExists(db, "usage_ledger_state")
    ? db.query("SELECT version,published_revision FROM usage_ledger_state WHERE provider=?").get(provider) as
      { version: number; published_revision: number } | null : null;
  // A published ledger answers without touching the facts; before it, facts mean a first build.
  if (!state || state.version !== USAGE_LEDGER_VERSION || !state.published_revision) {
    if (!hasRows(db, subscriptionAccountingAdapter(provider).table)) return false;
    throw pending();
  }
  if (card && usageLedgerReadiness(db, provider, card).state !== "ready") throw pending();
  return true;
}

function codexSums(db: Database, query: LedgerSumsQuery): LedgerSum[] {
  if (!codexSumsPresent(db)) return [];
  // Events without a ledger yet: the producer has not created it.
  if (!readCodexLedgerState(db)) throw new SubscriptionFactsPending("Codex usage sums await background preparation", "codex");
  const range = { grain: query.grain, ...(query.since ? { since: query.since } : {}), ...(query.until ? { until: query.until } : {}) };
  return readCodexLedgerGroups(db, range).filter(group => group.copy_state === "canonical").map(group => ({
    vendor: "codex", day: group.day, hour: query.grain === "hour" ? Number(group.hour) : null,
      source: group.source, home: group.home, model: group.model, speed: group.speed,
    project_id: text(group.project_id), project: text(group.project), cwd: text(group.cwd), repo: text(group.repo), rate_vendor: null,
    calls: Number(group.calls), first_ts: group.first_ts, last_ts: group.last_ts,
    uncached: Number(group.uncached), cache_read: Number(group.cached), write_5m: 0, write_1h: 0, write_unknown: Number(group.writes),
    out: Number(group.output), thinking: Number(group.reasoning),
  }));
}

function sharedSums(db: Database, vendor: SumVendor, query: LedgerSumsQuery): LedgerSum[] {
  const provider = usageLedgerProviderOfVendor(vendor);
  if (!requireUsageLedgerSums(db, provider)) return [];
  const terms = ["h.provider=?"], params: string[] = [provider];
  if (query.since) { terms.push("h.day>=?"); params.push(query.since); }
  if (query.until) { terms.push("h.day<=?"); params.push(query.until); }
  const hour = query.grain === "hour", projects = usageDimProjects(db, provider);
  const rows = db.query(`SELECT h.day, ${hour ? "h.hour" : "NULL hour"}, h.dim_id, m.source, ${query.includeIdentity ? "m.identity," : ""}m.home, m.model, m.speed, m.project, m.cwd,
      m.vendor, SUM(h.calls) calls, MIN(h.first_ts) first_ts, MAX(h.last_ts) last_ts,
      SUM(h.t_uncached) uncached, SUM(h.t_cache_read) cache_read, SUM(h.t_write_5m) write_5m, SUM(h.t_write_1h) write_1h,
      SUM(h.t_write_unknown) write_unknown, SUM(h.t_out) out, SUM(h.t_thinking) thinking
    FROM usage_ledger_hours h JOIN usage_ledger_dims m ON m.id=h.dim_id
    WHERE ${terms.join(" AND ")} GROUP BY h.day, ${hour ? "h.hour, " : ""}h.dim_id`).all(...params) as
    Array<Omit<LedgerSum, "vendor" | "repo" | "rate_vendor" | "project_id"> & { dim_id: number; vendor: string | null }>;
  return rows.map(({ dim_id, vendor: rateVendor, ...row }) => {
    const { project_id, subject } = projects(dim_id, row.day);
    return { ...row, vendor, repo: subject?.startsWith("r:") ? subject.slice(2) : null, rate_vendor: rateVendor,
      project_id, project: text(row.project), cwd: text(row.cwd), home: text(row.home) };
  });
}

/** Sums of the selected providers on the day or calendar-hour grain; `since`/`until` bound the call's UTC day. */
export function readLedgerSums(db: Database, query: LedgerSumsQuery): LedgerSum[] {
  return query.vendors.flatMap(vendor => vendor === "codex" ? codexSums(db, query) : sharedSums(db, vendor, query));
}

/** Calls, all tokens and the first and last call of each project (or home), per vendor, over the whole history. */
export interface LedgerTotal { vendor: SumVendor; key: string | null; calls: number; tokens: number; first_ts: string; last_ts: string }
/**
 * `readLedgerSums` on the day grain summed by vendor and the place dimension `by` (`sumTokens` gross for the tokens),
 * added up in SQL instead of returning every day and place of the history.
 */
export function readLedgerTotals(db: Database, vendors: readonly SumVendor[], by: "project_id" | "home"): LedgerTotal[] {
  type Row = { key: unknown; calls: number; tokens: number; first_ts: string; last_ts: string };
  const merged = new Map<string, LedgerTotal>();
  const add = (vendor: SumVendor, rows: Row[]) => {
    for (const row of rows) {
      const key = text(row.key), id = JSON.stringify([vendor, key]), total = merged.get(id);
      if (!total) { merged.set(id, { vendor, key, calls: row.calls, tokens: row.tokens, first_ts: row.first_ts, last_ts: row.last_ts }); continue; }
      total.calls += row.calls; total.tokens += row.tokens;
      if (row.first_ts < total.first_ts) total.first_ts = row.first_ts;
      if (row.last_ts > total.last_ts) total.last_ts = row.last_ts;
    }
  };
  for (const vendor of vendors) {
    if (vendor === "codex") {
      if (!codexSumsPresent(db)) continue;
      if (!readCodexLedgerState(db)) throw new SubscriptionFactsPending("Codex usage sums await background preparation", "codex");
      requireCodexLedgerReady(db, { grain: "day" });
      if (by === "home") add(vendor, db.query(`SELECT d.home key, SUM(a.calls) calls,
          SUM(a.uncached + a.cached + a.writes + a.output) tokens, MIN(a.first_ts) first_ts, MAX(a.last_ts) last_ts
        FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id
        WHERE a.grain='day' AND a.copy_state='canonical' GROUP BY 1`).all() as Row[]);
      else {
        // Per dimension and pricing day, the project from the rules.
        const places = readCodexPlaces(db), rules = currentProjectRules(db);
        add(vendor, (db.query(`SELECT a.dim_id, a.day, SUM(a.calls) calls, SUM(a.uncached + a.cached + a.writes + a.output) tokens,
            MIN(a.first_ts) first_ts, MAX(a.last_ts) last_ts
          FROM codex_price_ledger_aggregates a WHERE a.grain='day' AND a.copy_state='canonical' GROUP BY a.dim_id, a.day`).all() as
          Array<Row & { dim_id: number; day: string }>).map(row => ({ ...row, key: placeProject(rules, "codex", places.get(row.dim_id)!, row.day) })));
      }
      continue;
    }
    const provider = usageLedgerProviderOfVendor(vendor);
    if (!requireUsageLedgerSums(db, provider)) continue;
    if (by === "home") add(vendor, db.query(`SELECT m.home key, SUM(h.calls) calls,
        SUM(h.t_uncached + h.t_cache_read + h.t_write_5m + h.t_write_1h + h.t_write_unknown + h.t_out) tokens,
        MIN(h.first_ts) first_ts, MAX(h.last_ts) last_ts
      FROM usage_ledger_hours h JOIN usage_ledger_dims m ON m.id=h.dim_id WHERE h.provider=? GROUP BY 1`).all(provider) as Row[]);
    else {
      const projects = usageDimProjects(db, provider);
      add(vendor, (db.query(`SELECT h.dim_id, h.day, SUM(h.calls) calls,
          SUM(h.t_uncached + h.t_cache_read + h.t_write_5m + h.t_write_1h + h.t_write_unknown + h.t_out) tokens,
          MIN(h.first_ts) first_ts, MAX(h.last_ts) last_ts
        FROM usage_ledger_hours h WHERE h.provider=? GROUP BY h.dim_id, h.day`).all(provider) as Array<Row & { dim_id: number; day: string }>)
        .map(row => ({ ...row, key: projects(row.dim_id, row.day).project_id })));
    }
  }
  return [...merged.values()];
}

/**
 * A shared-ledger provider's day sums by source and session identity: its source rows (copies included), first and
 * last call, and how many of them are copies, conflicts or conflicted identities (`irregular`).
 */
export function readUsageLedgerPlaceDays(db: Database, provider: UsageLedgerProvider): Array<{ day: string; source: string | null;
  identity: string | null; n: number; first_ts: string; last_ts: string; irregular: number }> {
  return db.query(`SELECT d.day, m.source, m.identity, d.source_events n, d.first_ts, d.last_ts,
      d.duplicates + d.conflicts + d.attribution_conflicts irregular
    FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id WHERE d.provider=?`).all(provider) as
    Array<{ day: string; source: string | null; identity: string | null; n: number; first_ts: string; last_ts: string; irregular: number }>;
}
/** Every source row of one source's day in a shared ledger (copies and conflicts included), with its session identity. */
export function readUsageLedgerDayFacts(db: Database, provider: UsageLedgerProvider, day: string, source: string | null):
  Array<{ ts: string; account_key: string | null; identity_conflict: number }> {
  // The provider as a literal: the partial day index of its facts matches only then.
  return db.query(`SELECT ts, account_key, identity_conflict FROM usage_ledger_facts WHERE provider=${sqlProvider(provider)} AND day=? AND source IS ?`)
    .all(day, source) as Array<{ ts: string; account_key: string | null; identity_conflict: number }>;
}

/**
 * The first call of one archive source of a shared-ledger provider: null when it has none there,
 * undefined while that ledger is still being prepared, so nothing is decided on a partial answer.
 */
export function ledgerSourceFirstCall(db: Database, provider: string, source: string): string | null | undefined {
  try { if (!requireUsageLedgerSums(db, provider as UsageLedgerProvider)) return null; }
  catch { return undefined; }
  return (db.query(`SELECT MIN(first_ts) AS first FROM usage_ledger_hours WHERE provider = ?
    AND dim_id IN (SELECT id FROM usage_ledger_dims WHERE provider = ? AND source = ? COLLATE NOCASE)`)
    .get(provider, provider, source) as { first: string | null } | null)?.first ?? null;
}

/** The instant of the last call of the selected providers, or null. */
export function ledgerLastCall(db: Database, vendors: readonly SumVendor[]): string | null {
  let last: string | null = null;
  for (const vendor of vendors) {
    let ts: string | null = null;
    if (vendor === "codex") {
      if (!codexSumsPresent(db)) continue;
      if (!readCodexLedgerState(db)) throw new SubscriptionFactsPending("Codex usage sums await background preparation", "codex");
      requireCodexLedgerReady(db);
      ts = (db.query("SELECT MAX(last_ts) ts FROM codex_price_ledger_aggregates WHERE grain='day' AND copy_state='canonical'").get() as { ts: string | null }).ts;
    } else {
      const provider = usageLedgerProviderOfVendor(vendor);
      if (!requireUsageLedgerSums(db, provider)) continue;
      ts = (db.query("SELECT MAX(last_ts) ts FROM usage_ledger_hours WHERE provider=?").get(provider) as { ts: string | null }).ts;
    }
    if (ts && (!last || ts > last)) last = ts;
  }
  return last;
}

/** All tokens of a row and its fresh part (input not read from cache, plus output), as the activity views count them. */
export function sumTokens(row: LedgerSum): { gross: number; fresh: number } {
  const writes = row.write_5m + row.write_1h + row.write_unknown;
  // A Codex cache write is input that was not read from the cache.
  return { gross: row.uncached + row.cache_read + writes + row.out,
    fresh: row.uncached + row.out + (row.vendor === "codex" ? writes : 0) };
}

/** The local calendar day, weekday (Sunday = 0) and hour of a UTC epoch hour, in the process time zone. */
export function localHour(hour: number): { day: string; dow: number; hour: number } {
  const at = new Date(hour * 3_600_000);
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return { day, dow: at.getDay(), hour: at.getHours() };
}

/** `project_id` request filter: `unassigned` selects calls without a project. */
export function projectMatcher(url: URL): ((row: Pick<LedgerSum, "project_id">) => boolean) | null {
  const wanted = url.searchParams.get("project_id");
  if (!wanted) return null;
  return wanted === "unassigned" ? row => row.project_id === null : row => row.project_id === wanted;
}

/** A shared-ledger day sum with its valuation by model, day and mode (fast mode at its own rates). */
export interface PricedLedgerDay {
  day: string; model: string | null; speed: string | null; project_id: string | null;
  calls: number; uncached: number; cache_read: number; write_5m: number; write_1h: number; write_unknown: number; out: number; thinking: number;
  /** Exact USD decimal of the priced calls. */
  priced_usd: string; unpriced_tokens: number;
}
/** Day sums of one shared-ledger provider with stored valuations; pending until the ledger is ready under this card. */
export function readPricedLedgerDays(db: Database, provider: UsageLedgerProvider, card: RateCard, range: { since?: string; until?: string }): PricedLedgerDay[] {
  if (!requireUsageLedgerSums(db, provider, card)) return [];
  const terms = ["d.provider=?"], params: string[] = [provider];
  if (range.since) { terms.push("d.day>=?"); params.push(range.since); }
  if (range.until) { terms.push("d.day<=?"); params.push(range.until); }
  // Fast mode is priced at its own rates (the actual-mode variant); every other call at the dated standard
  // rates, an unknown mode included, as the model's rate on that day reads.
  const variant = (field: string) => `CASE WHEN m.speed='fast' THEN d.act_${field} ELSE d.std_${field} END`;
  // Conflict markers are rows with no tokens; their count is `conflicts`.
  const projects = usageDimProjects(db, provider);
  type Row = Omit<PricedLedgerDay, "priced_usd" | "project_id"> & { dim_id: number; usd: string; nano: string; femto: string };
  const rows = db.query(`SELECT d.day, m.model, m.speed, d.dim_id, SUM(d.calls - d.conflicts) calls,
      SUM(d.t_uncached) uncached, SUM(d.t_cache_read) cache_read, SUM(d.t_write_5m) write_5m, SUM(d.t_write_1h) write_1h,
      SUM(d.t_write_unknown) write_unknown, SUM(d.t_out) out, SUM(d.t_thinking) thinking,
      ${["usd", "nano", "femto"].map(limb => `CAST(SUM(${variant(`priced_${limb}`)}) AS TEXT) ${limb}`).join(", ")},
      SUM(${variant("unpriced_tokens")}) unpriced_tokens
    FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id
    WHERE ${terms.join(" AND ")} GROUP BY 1, 2, 3, 4`).all(...params) as Row[];
  // Dimensions of one project on a day add up; money limbs are summed as integers, as SQL summed them.
  const days = new Map<string, Omit<Row, "dim_id"> & { project_id: string | null }>();
  const counts = ["calls", "uncached", "cache_read", "write_5m", "write_1h", "write_unknown", "out", "thinking", "unpriced_tokens"] as const;
  for (const { dim_id, ...row } of rows) {
    const project_id = projects(dim_id, row.day).project_id, key = JSON.stringify([row.day, row.model, row.speed, project_id]);
    const day = days.get(key);
    if (!day) { days.set(key, { ...row, project_id }); continue; }
    for (const field of counts) day[field] += row[field];
    for (const limb of ["usd", "nano", "femto"] as const) day[limb] = String(BigInt(day[limb] ?? "0") + BigInt(row[limb] ?? "0"));
  }
  return [...days.values()].map(({ usd, nano, femto, ...row }) => ({ ...row, priced_usd: ledgerMoneyDecimal(usd, nano, femto) }))
    .filter(row => row.calls > 0);
}

/** Whether every ledger with facts to sum is published and has caught up with them. */
export function ledgerSumsCurrent(db: Database): boolean {
  if (codexSumsPresent(db)) {
    const codex = registerFreshness(db, "codex");
    if (!codex.published || codex.pending) return false;
  }
  for (const adapter of subscriptionAccountingAdapters()) {
    if (!hasRows(db, adapter.table)) continue;
    const state = registerFreshness(db, adapter.id);
    if (!state.published || state.pending) return false;
  }
  return true;
}

/**
 * Usage of one shared-ledger provider by day and place of call (dimension), with the valuation the
 * screens show and the provider's own reported money:
 * - `priced_usd`: the stored API valuation of the priced calls, fast mode at its own rates and every
 *   other call at the dated standard rates (as `readPricedLedgerDays`);
 * - `reported_usd`: the money the provider itself recorded for its calls (Grok cost ticks, OpenCode
 *   cost); null for providers that record none.
 * Whole days read the day sums. An instant range (`sinceTs`/`untilTs`) reads the canonical facts of
 * the range from the ledger, grouped the same way. Valuations are read only when `card` is given,
 * which then requires the ledger to be ready under it.
 */
export interface LedgerUsageRow {
  vendor: SumVendor; day: string; first_ts: string; last_ts: string;
  source: string | null; identity: string | null; model: string | null; speed: string | null; home: string | null;
  project_id: string | null; project: string | null; cwd: string | null; rate_vendor: string | null;
  calls: number; uncached: number; cache_read: number; write_5m: number; write_1h: number; write_unknown: number; out: number; thinking: number;
  priced_usd: string; priced_events: number; unpriced_events: number; unpriced_tokens: number;
  reported_usd: number | null;
}
export interface LedgerUsageQuery { since?: string; until?: string; sinceTs?: string; untilTs?: string; card?: RateCard }
export function readLedgerUsage(db: Database, vendor: SumVendor, query: LedgerUsageQuery = {}): LedgerUsageRow[] {
  const provider = usageLedgerProviderOfVendor(vendor);
  if (!requireUsageLedgerSums(db, provider, query.card)) return [];
  const instants = query.sinceTs !== undefined || query.untilTs !== undefined;
  const since = query.since ?? query.sinceTs?.slice(0, 10), until = query.until ?? query.untilTs?.slice(0, 10);
  const terms = ["x.provider=?"], params: string[] = [provider];
  if (since) { terms.push("x.day>=?"); params.push(since); }
  if (until) { terms.push("x.day<=?"); params.push(until); }
  if (query.sinceTs) { terms.push("x.ts>=?"); params.push(new Date(query.sinceTs).toISOString()); }
  if (query.untilTs) { terms.push("x.ts<?"); params.push(new Date(query.untilTs).toISOString()); }
  // Fast mode is priced at its own rates (actual mode); every other call at the dated standard rates.
  const pick = (std: string, act: string) => `CASE WHEN m.speed='fast' THEN ${act} ELSE ${std} END`;
  const tokens = "CASE WHEN x.usage_valid THEN x.q_uncached+x.q_cache_read+x.q_write_5m+x.q_write_1h+x.q_write_unknown+x.q_out ELSE 0 END";
  const unpricedFact = `(${pick("x.std_usd", "x.act_usd")} IS NULL OR ${pick("x.std_reason", "x.act_reason")} IS NOT NULL)`;
  const money = query.card === undefined
    ? "'0' usd, '0' nano, '0' femto, 0 priced_events, 0 unpriced_events, 0 unpriced_tokens"
    : instants
      ? `${["usd", "nano", "femto"].map(limb => `CAST(SUM(CASE WHEN ${unpricedFact} THEN 0 ELSE ${pick(`x.std_${limb}`, `x.act_${limb}`)} END) AS TEXT) ${limb}`).join(", ")},
          SUM(CASE WHEN ${unpricedFact} THEN 0 ELSE 1 END) priced_events, SUM(CASE WHEN ${unpricedFact} THEN 1 ELSE 0 END) unpriced_events,
          SUM(CASE WHEN ${unpricedFact} THEN ${tokens} ELSE 0 END) unpriced_tokens`
      : `${["usd", "nano", "femto"].map(limb => `CAST(SUM(${pick(`x.std_priced_${limb}`, `x.act_priced_${limb}`)}) AS TEXT) ${limb}`).join(", ")},
          SUM(${pick("x.std_priced_events", "x.act_priced_events")}) priced_events,
          SUM(${pick("x.std_unpriced_events", "x.act_unpriced_events")}) unpriced_events,
          SUM(${pick("x.std_unpriced_tokens", "x.act_unpriced_tokens")}) unpriced_tokens`;
  const grain = instants
    ? `SELECT x.day, x.dim_id, MIN(x.ts) first_ts, MAX(x.ts) last_ts, COUNT(*) calls,
        SUM(x.q_uncached) uncached, SUM(x.q_cache_read) cache_read, SUM(x.q_write_5m) write_5m, SUM(x.q_write_1h) write_1h,
        SUM(x.q_write_unknown) write_unknown, SUM(x.q_out) out, SUM(x.q_thinking) thinking, ${money}
      FROM usage_ledger_facts x JOIN usage_ledger_dims m ON m.id=x.dim_id
      WHERE ${terms.join(" AND ")} AND x.copy_state='canonical' AND x.accounting=1 GROUP BY x.day, x.dim_id`
    : `SELECT x.day, x.dim_id, MIN(x.first_ts) first_ts, MAX(x.last_ts) last_ts, SUM(x.calls - x.conflicts) calls,
        SUM(x.t_uncached) uncached, SUM(x.t_cache_read) cache_read, SUM(x.t_write_5m) write_5m, SUM(x.t_write_1h) write_1h,
        SUM(x.t_write_unknown) write_unknown, SUM(x.t_out) out, SUM(x.t_thinking) thinking, ${money}
      FROM usage_ledger_days x JOIN usage_ledger_dims m ON m.id=x.dim_id
      WHERE ${terms.join(" AND ")} GROUP BY x.day, x.dim_id`;
  const projects = usageDimProjects(db, provider);
  const rows = (db.query(`SELECT g.*, m.source, m.identity, m.model, m.speed, m.home, m.project, m.cwd, m.vendor rate_vendor
    FROM (${grain}) g JOIN usage_ledger_dims m ON m.id=g.dim_id`).all(...params) as Array<Record<string, string | number | null>>)
    .map(row => ({ ...row, project_id: projects(row.dim_id!, String(row.day)).project_id }) as Record<string, string | number | null>);
  // The provider's own money of its canonical calls; a call whose copies disagree on it has none.
  const providerMoney = subscriptionAccountingAdapter(provider).reported, unit = providerMoney ? reportedUnitsPerUsd(providerMoney.unit) : undefined;
  const reported = new Map<string, number>();
  if (unit !== undefined) for (const row of db.query(`SELECT x.day, x.dim_id, SUM(x.m_reported_raw) raw FROM usage_ledger_facts x
      WHERE ${terms.join(" AND ")} AND x.copy_state='canonical' AND x.accounting=1 AND x.m_reported_raw IS NOT NULL
        AND COALESCE(x.m_reported_conflict, 0)=0 GROUP BY x.day, x.dim_id`).all(...params) as Array<{ day: string; dim_id: number; raw: number }>)
    reported.set(`${row.day}\u0000${row.dim_id}`, row.raw / unit);
  return rows.filter(row => Number(row.calls) > 0).map(row => ({ vendor, day: String(row.day),
    first_ts: String(row.first_ts), last_ts: String(row.last_ts),
    source: text(row.source), identity: text(row.identity), model: text(row.model), speed: text(row.speed), home: text(row.home),
    project_id: text(row.project_id), project: text(row.project), cwd: text(row.cwd), rate_vendor: text(row.rate_vendor),
    calls: Number(row.calls), uncached: Number(row.uncached), cache_read: Number(row.cache_read), write_5m: Number(row.write_5m),
    write_1h: Number(row.write_1h), write_unknown: Number(row.write_unknown), out: Number(row.out), thinking: Number(row.thinking),
    priced_usd: ledgerMoneyDecimal(String(row.usd ?? "0"), String(row.nano ?? "0"), String(row.femto ?? "0")),
    priced_events: Number(row.priced_events ?? 0), unpriced_events: Number(row.unpriced_events ?? 0), unpriced_tokens: Number(row.unpriced_tokens ?? 0),
    reported_usd: unit === undefined ? null : reported.get(`${row.day}\u0000${row.dim_id}`) ?? 0 }));
}

/**
 * Token buckets of a shared-ledger provider's calls with each bucket's cost at the rates the ledger
 * stored for the call's valuation (fast mode at its own rates, every other call at the dated standard
 * rates), per model: what a cache report needs beyond day totals. `hypothetical_uncached` is the
 * cache reads valued at the uncached input rate. Unpriced calls contribute tokens only.
 */
export interface LedgerBucketCosts {
  model: string | null;
  tokens: { uncached: number; cache_read: number; write_5m: number; write_1h: number; write_unknown: number; out: number };
  /** Exact USD decimals of the priced calls. */
  costs: { uncached: string; cache_read: string; write_5m: string; write_1h: string; write_unknown: string; out: string; hypothetical_uncached: string };
  unpriced_tokens: number;
}
const BUCKET_RATE = { uncached: "in_uncached", cache_read: "in_cache_read", write_5m: "in_cache_write_5m", write_1h: "in_cache_write_1h",
  write_unknown: "in_cache_write_unknown", out: "out_total" } as const;
export function readLedgerBucketCosts(db: Database, vendor: SumVendor, card: RateCard,
  range: { since?: string; until?: string; projectId?: string | null }): LedgerBucketCosts[] {
  const provider = usageLedgerProviderOfVendor(vendor);
  if (!requireUsageLedgerSums(db, provider, card)) return [];
  const terms = ["x.provider=?", "x.copy_state='canonical'", "x.accounting=1"], params: Array<string | null> = [provider];
  if (range.since) { terms.push("x.day>=?"); params.push(range.since); }
  if (range.until) { terms.push("x.day<=?"); params.push(range.until); }
  if (range.projectId !== undefined) { const filter = usageProjectFilter(db, provider, "x.dim_id", "m", "x.day", range.projectId); terms.push(filter.sql); params.push(...filter.params); }
  const pick = (std: string, act: string) => `CASE WHEN m.speed='fast' THEN ${act} ELSE ${std} END`;
  const unpriced = `(${pick("x.std_usd", "x.act_usd")} IS NULL OR ${pick("x.std_reason", "x.act_reason")} IS NOT NULL)`;
  const rows = db.query(`SELECT m.model, ${pick("x.std_key", "x.act_key")} key, ${unpriced} unpriced,
      SUM(x.q_uncached) uncached, SUM(x.q_cache_read) cache_read, SUM(x.q_write_5m) write_5m, SUM(x.q_write_1h) write_1h,
      SUM(x.q_write_unknown) write_unknown, SUM(x.q_out) out,
      SUM(CASE WHEN x.usage_valid THEN x.q_uncached+x.q_cache_read+x.q_write_5m+x.q_write_1h+x.q_write_unknown+x.q_out ELSE 0 END) tokens
    FROM usage_ledger_facts x JOIN usage_ledger_dims m ON m.id=x.dim_id
    WHERE ${terms.join(" AND ")} GROUP BY m.model, key, unpriced`).all(...params) as Array<{
      model: string | null; key: number | null; unpriced: number; tokens: number } & LedgerBucketCosts["tokens"]>;
  const rates = new Map((db.query("SELECT id, rates FROM usage_ledger_keys WHERE provider=?").all(provider) as
    Array<{ id: number; rates: string }>).map(row => [row.id, JSON.parse(row.rates || "null") as Record<string, string | null> | null]));
  const out = new Map<string, { row: LedgerBucketCosts; femto: Record<keyof LedgerBucketCosts["costs"], bigint> }>();
  for (const row of rows) {
    const id = JSON.stringify(row.model);
    const entry = out.get(id) ?? { row: { model: row.model, tokens: { uncached: 0, cache_read: 0, write_5m: 0, write_1h: 0, write_unknown: 0, out: 0 },
      costs: { uncached: "0", cache_read: "0", write_5m: "0", write_1h: "0", write_unknown: "0", out: "0", hypothetical_uncached: "0" }, unpriced_tokens: 0 },
      femto: { uncached: 0n, cache_read: 0n, write_5m: 0n, write_1h: 0n, write_unknown: 0n, out: 0n, hypothetical_uncached: 0n } };
    for (const bucket of Object.keys(BUCKET_RATE) as Array<keyof typeof BUCKET_RATE>) entry.row.tokens[bucket] += Number(row[bucket]);
    const keyRates = row.key === null ? null : rates.get(Number(row.key)) ?? null;
    if (row.unpriced || !keyRates) entry.row.unpriced_tokens += Number(row.tokens);
    else {
      const rate = (bucket: string) => { const value = keyRates[bucket]; return value == null || value === "invalid" ? 0n : BigInt(value); };
      for (const bucket of Object.keys(BUCKET_RATE) as Array<keyof typeof BUCKET_RATE>)
        entry.femto[bucket] += BigInt(row[bucket]) * rate(BUCKET_RATE[bucket]);
      entry.femto.hypothetical_uncached += BigInt(row.cache_read) * rate("in_uncached");
    }
    out.set(id, entry);
  }
  return [...out.values()].map(({ row, femto }) => ({ ...row,
    costs: Object.fromEntries(Object.entries(femto).map(([key, value]) => [key, ledgerMoneyDecimal(0, 0, value)])) as LedgerBucketCosts["costs"] }));
}

/**
 * The timed sums of canonical facts, named as the columns, for a reader of a bounded fact range (an hour a
 * period boundary cuts). The producer writes the same definition into the day and hour rows.
 */
const TIMED_FACT_SUMS_SQL = (() => {
  const timed = "CASE WHEN resp_ms>0 AND usage_valid=1 THEN 1 ELSE 0 END";
  const long = `CASE WHEN resp_ms>0 AND usage_valid=1 AND q_out>=${LONG_CALL_OUT} THEN 1 ELSE 0 END`;
  return [`SUM(${timed}) timed_calls`, `SUM((${timed})*q_out) timed_out`, `SUM((${timed})*resp_ms) timed_ms`,
    `SUM(${long}) timed_long_calls`, `SUM((${long})*q_out) timed_long_out`, `SUM((${long})*resp_ms) timed_long_ms`].join(", ");
})();
/**
 * Calendar-hour sums of one account of a shared-ledger provider: the hours whose calls the account
 * plan owns by their source and session identity. An hour a period boundary of the plan cuts is read
 * from the ledger's canonical facts on each side of the boundary, so ownership stays exact. Each hour
 * also carries its timed sums (response times, usage-ledger.ts `TIMED_SUMS`).
 */
export function readOwnedLedgerHours(db: Database, vendor: SumVendor, plan: AccountReadPlan,
  range: { since?: string; until?: string; fromMs?: number; untilMs?: number } = {}): Array<LedgerSum & TimedSums> {
  const provider = usageLedgerProviderOfVendor(vendor);
  if (!requireUsageLedgerSums(db, provider)) return [];
  const terms = ["h.provider=?"], params: string[] = [provider];
  if (range.since) { terms.push("h.day>=?"); params.push(range.since); }
  if (range.until) { terms.push("h.day<=?"); params.push(range.until); }
  const hours = db.query(`SELECT h.day, h.hour, h.dim_id, h.calls, h.first_ts, h.last_ts, h.t_uncached uncached, h.t_cache_read cache_read,
      h.t_write_5m write_5m, h.t_write_1h write_1h, h.t_write_unknown write_unknown, h.t_out out, h.t_thinking thinking,
      ${TIMED_SUMS.map(column => `h.${column}`).join(", ")}, m.source, m.identity, m.home, m.model, m.speed,
      m.project, m.cwd, m.vendor rate_vendor
    FROM usage_ledger_hours h JOIN usage_ledger_dims m ON m.id=h.dim_id WHERE ${terms.join(" AND ")}`).all(...params) as
    Array<Record<string, string | number | null>>;
  const projects = usageDimProjects(db, provider);
  for (const row of hours) Object.assign(row, projects(row.dim_id!, String(row.day)));
  const part = db.query(`SELECT COUNT(*) calls, MIN(ts) first_ts, MAX(ts) last_ts, SUM(q_uncached) uncached, SUM(q_cache_read) cache_read,
      SUM(q_write_5m) write_5m, SUM(q_write_1h) write_1h, SUM(q_write_unknown) write_unknown, SUM(q_out) out, SUM(q_thinking) thinking,
      ${TIMED_FACT_SUMS_SQL}
    FROM usage_ledger_facts WHERE provider=? AND day=? AND dim_id=? AND ts>=? AND ts<? AND copy_state='canonical' AND accounting=1`);
  const out: Array<LedgerSum & TimedSums> = [];
  const emit = (row: Record<string, string | number | null>, sums: Record<string, string | number | null>) => {
    if (!Number(sums.calls)) return;
    const subject = text(row.subject);
    out.push({ vendor, day: String(row.day), hour: Number(row.hour), source: text(row.source), home: text(row.home), model: text(row.model),
      speed: text(row.speed), project_id: text(row.project_id), project: text(row.project), cwd: text(row.cwd),
      repo: subject?.startsWith("r:") ? subject.slice(2) : null, rate_vendor: text(row.rate_vendor),
      calls: Number(sums.calls), first_ts: String(sums.first_ts), last_ts: String(sums.last_ts),
      uncached: Number(sums.uncached), cache_read: Number(sums.cache_read), write_5m: Number(sums.write_5m), write_1h: Number(sums.write_1h),
      write_unknown: Number(sums.write_unknown), out: Number(sums.out), thinking: Number(sums.thinking),
      ...Object.fromEntries(TIMED_SUMS.map(column => [column, Number(sums[column] ?? 0)])) as TimedSums });
  };
  for (const row of hours) {
    const source = text(row.source), identity = text(row.identity), first = String(row.first_ts), last = String(row.last_ts);
    const firstMs = Date.parse(first), lastMs = Date.parse(last);
    const lower = Math.max(firstMs, range.fromMs ?? firstMs), upper = Math.min(lastMs + 1, range.untilMs ?? lastMs + 1);
    if (upper <= lower) continue;
    // A plan boundary of this source between the hour's first and last call splits the hour.
    const cuts = source === null || !Number.isFinite(firstMs) || !Number.isFinite(lastMs) ? []
      : [...new Set(plan.ranges.filter(r => r.source === normEraKey(source)).flatMap(r => [r.from, r.until])
        .filter(at => Number.isFinite(at) && at > firstMs && at <= lastMs))].sort((a, b) => a - b);
    if (!cuts.length && lower === firstMs && upper === lastMs + 1) { if (plan.owns(source, identity, first)) emit(row, row); continue; }
    const bounds = [lower, ...cuts.filter(at => at > lower && at < upper), upper];
    for (let index = 0; index < bounds.length - 1; index++) {
      const from = new Date(bounds[index]!).toISOString();
      if (!plan.owns(source, identity, from)) continue;
      emit(row, part.get(provider, String(row.day), Number(row.dim_id), from, new Date(bounds[index + 1]!).toISOString()) as Record<string, string | number | null>);
    }
  }
  return out;
}

/**
 * First and last UTC day with a counted call of a shared-ledger provider: coverage of the source,
 * traffic no account owns included. `plan` counts only calls the provider's plan can account
 * (OpenCode: its GLM providers), `other` only the rest (OpenCode's other providers).
 */
export function ledgerDayBounds(db: Database, vendor: SumVendor, calls: "all" | "plan" | "other" = "all"):
  { first: string | null; last: string | null } {
  const provider = usageLedgerProviderOfVendor(vendor);
  if (!requireUsageLedgerSums(db, provider)) return { first: null, last: null };
  const scope = calls === "plan" ? " AND m.vendor IS NULL" : calls === "other" ? " AND m.vendor IS NOT NULL" : "";
  const row = db.query(`SELECT MIN(d.day) first, MAX(d.day) last FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id
    WHERE d.provider=? AND d.calls>d.conflicts${scope}`).get(provider) as { first: string | null; last: string | null };
  return { first: row.first, last: row.last };
}

export { ledgerSumsStamp } from "../db/ledger-revision";

/** Tokens the ledgers stored as unpriced for a missing rate, per provider, call vendor, model and valuation variant. */
export interface MissingRateTokens { ledger: "codex" | "usage"; provider: string; vendor: string | null; model: string; variant: string; tokens: number;
  /** The first UTC day of such a call. */
  first_day: string }
/**
 * Every model whose calls a ledger valued with reason `missing_rate`, over the whole history: the Codex price
 * ledger's canonical day aggregates (API equivalent) and the usage ledger's day reasons. Stored valuations
 * only; a ledger not built yet contributes nothing.
 */
export function readMissingRateTokens(db: Database): MissingRateTokens[] {
  const has = (name: string) => db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
  const out: MissingRateTokens[] = [];
  if (has("codex_price_ledger_aggregates")) {
    // Codex input includes its cached part, as the cards count it.
    // Filter in the covering primary-key index before fetching amounts from the wide aggregate rows.
    for (const row of db.query(`WITH missing AS MATERIALIZED (
        SELECT rowid FROM codex_price_ledger_aggregates
        WHERE grain = 'day' AND copy_state = 'canonical' AND api_reason = 'missing_rate'
      ) SELECT d.model model, SUM(a.uncached + a.cached + a.output) amount, MIN(a.day) first_day
        FROM missing m JOIN codex_price_ledger_aggregates a ON a.rowid = m.rowid
        JOIN codex_price_ledger_dims d ON d.id = a.dim_id GROUP BY d.model`)
      .all() as Array<{ model: string | null; amount: number; first_day: string }>)
      if (row.model) out.push({ ledger: "codex", provider: "codex", vendor: "openai", model: row.model, variant: "api_standard", tokens: Number(row.amount),
        first_day: row.first_day });
  }
  if (has("usage_ledger_day_reasons")) {
    for (const row of db.query(`SELECT r.provider provider, d.vendor vendor, d.model model, r.variant variant, SUM(r.tokens) tokens, MIN(r.day) first_day
        FROM usage_ledger_day_reasons r JOIN usage_ledger_dims d ON d.id = r.dim_id
        WHERE r.reason = 'missing_rate' GROUP BY r.provider, d.vendor, d.model, r.variant`)
      .all() as Array<{ provider: string; vendor: string | null; model: string | null; variant: string; tokens: number; first_day: string }>)
      if (row.model) out.push({ ledger: "usage", provider: row.provider, vendor: row.vendor, model: row.model, variant: row.variant, tokens: Number(row.tokens),
        first_day: row.first_day });
  }
  return out;
}

const HOUR_MS = 3_600_000;
type CodexTimedHour = { hour: number; day: string; dim_id: number; source: string | null; model: string | null; billing_mode: string | null;
  calls: number; first_ts: string } & TimedSums;
type TimedRow = { hour: number; model: string | null; calls: number } & TimedSums;
/**
 * One Codex account's calls and timed sums per calendar hour and model: the ledger's canonical stored hour cohorts of the
 * account's sources, owned through the periods at the same grain as `readCodexLedgerOwnedSeries` (each dimension's hour at
 * its first call; an hour a period boundary cuts, `codexOwnershipCuts`, read per slice from its calls), but not valued.
 * The caller checks readiness; `dependencyBases` restricts the slice reads to the same valuation dependencies.
 */
export function readCodexOwnedTimedHours(db: Database, resolver: AccountResolver, account: string,
  range: { since?: string; until?: string; dependencyBases?: LedgerRange["dependencyBases"] } = {}): TimedRow[] {
  const wanted = account.toLowerCase(), base = wanted.replace(/::business$/, "");
  // A business pool's calls come from its account's sources; calls no period owns may come from any source.
  const named = base.startsWith("codex-unassigned") ? null : new Set(resolver.plan("codex", base).ranges.map(r => r.source));
  const sources = named ? readCodexLedgerSources(db, source => named.has(normEraKey(source))) : null;
  if (sources?.length === 0) return [];
  const terms = ["a.grain='hour'", "a.hour IS NOT NULL", "a.copy_state='canonical'"], params: string[] = [];
  if (range.since) { terms.push("a.day>=?"); params.push(range.since); }
  if (range.until) { terms.push("a.day<=?"); params.push(range.until); }
  if (sources) { terms.push(`d.source IN (${sources.map(() => "?").join(",")})`); params.push(...sources); }
  const rows = db.query(`SELECT a.hour, a.day, a.dim_id, d.source, d.model, d.billing_mode, SUM(a.calls) calls, MIN(a.first_ts) first_ts,
      ${TIMED_SUMS.map(column => `SUM(a.${column}) ${column}`).join(", ")}
    FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id WHERE ${terms.join(" AND ")}
    GROUP BY a.hour, a.day, a.dim_id`).all(...params) as CodexTimedHour[];
  const boundaries = resolver.accounts("codex").flatMap(name => resolver.plan("codex", name).ranges);
  const ownerAt = (source: string | null, billing: string | null, ts: string) => {
    const instant = Date.parse(ts);
    return codexEventOwner(Number.isFinite(instant) ? resolver.resolve("codex", source, null, new Date(instant).toISOString()).account : null,
      { billing_mode: billing })?.toLowerCase() ?? null;
  };
  const out: TimedRow[] = [];
  const emit = (hour: number, model: string | null, sums: { calls: string | number } & Record<typeof TIMED_SUMS[number], string | number>) =>
    out.push({ hour, model, calls: Number(sums.calls), ...Object.fromEntries(TIMED_SUMS.map(column => [column, Number(sums[column] ?? 0)])) as TimedSums });
  const slices = new Map<string, LedgerStoredGroup[]>();
  for (const row of rows) {
    const from = row.hour * HOUR_MS, until = from + HOUR_MS;
    const cuts = codexOwnershipCuts(boundaries, row.source, from, until);
    if (!cuts.length) { if (ownerAt(row.source, row.billing_mode, row.first_ts) === wanted) emit(row.hour, row.model, row); continue; }
    const edges = [from, ...cuts, until];
    for (let index = 0; index < edges.length - 1; index++) {
      const key = JSON.stringify([row.day, row.source, edges[index], edges[index + 1]]);
      let part = slices.get(key);
      if (!part) {
        part = readCodexLedgerGroups(db, { grain: "hour", since: row.day, until: row.day, fromMs: edges[index], toMs: edges[index + 1],
          startInclusive: true, endInclusive: false, sources: [row.source ?? ""],
          ...(range.dependencyBases ? { dependencyBases: range.dependencyBases } : {}) });
        slices.set(key, part);
      }
      for (const group of part) if (group.hour === row.hour && group.dim_id === row.dim_id && group.copy_state === "canonical"
        && ownerAt(group.source, group.billing_mode, group.first_ts) === wanted) emit(row.hour, row.model, group);
    }
  }
  return out;
}

/** Thrown while a ledger's activity sums are still being prepared (the backfill migrations 0066 and 0067 queue). */
export class ActivityPending extends SubscriptionFactsPending {}
/** OpenCode's plan vendors: the GLM ledger's other ineligible calls are an activity class of their own. */
const GLM_RATE_VENDORS = new Set(["zai", "z-ai"]);
type ActivityFact = { session: string; source: string | null; account_key: string | null; home: string; eligible: number; vendor: string; ts: string;
  identity: string; day: string; dim_id: number | null; accounting: number; gap_ms: number | null; gap_from: string | null };
const activityClass = (provider: string, fact: Pick<ActivityFact, "eligible" | "vendor">) =>
  fact.eligible === 1 ? "e" : provider === "glm" && !GLM_RATE_VENDORS.has(fact.vendor) ? "o" : null;
const byInstantThenIdentity = (a: ActivityFact, b: ActivityFact) =>
  a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
/** The key of a (UTC day, dimension) in `readActivityDays`. */
export const activityDayKey = (day: string, dim: number) => `${day}|${dim}`;

/**
 * Active milliseconds of one account's calls of a shared-ledger provider, per (UTC day, dimension), for one idle cutoff
 * (docs/stored-activity-plan-2026-10-07.md, rule D2): a call's gap to the previous call of its session that the same
 * account owns, counted on the later call. Read from the stored day sums; a day row is read from its facts only when an
 * ownership boundary of its source lies after its earliest predecessor or first call and up to its last call, and the
 * few sessions with calls in more than one chain (`usage_ledger_mixed_sessions`) are walked from their facts. `kind` picks
 * the plan's calls (`e`, the default) or, in the GLM ledger, OpenCode's other providers (`o`). Raises `ActivityPending`
 * until the provider's activity was published.
 */
export function readActivityDays(db: Database, provider: UsageLedgerProvider, plan: AccountReadPlan, cutoffMinutes: number,
  range: { since?: string; until?: string } = {}, kind: "e" | "o" = "e", intervals?: Map<string, ActivityInterval[]>): Map<string, number> {
  if (!(ACTIVITY_CUTOFF_MINUTES as readonly number[]).includes(cutoffMinutes)) throw new Error(`Unsupported idle cutoff: ${cutoffMinutes}`);
  const column = activityColumn(cutoffMinutes as ActivityCutoff);
  if (!requireUsageLedgerSums(db, provider)) return new Map();
  const state = db.query("SELECT activity_published FROM usage_ledger_state WHERE provider=?").get(provider) as { activity_published: number } | null;
  if (!state?.activity_published) throw new ActivityPending(`Active time of ${provider} awaits background preparation`, provider);
  const P = sqlProvider(provider), cutoff = cutoffMinutes * 60_000, out = new Map<string, number>();
  const prepared = intervals ? storedActivityIntervals(db, provider, cutoffMinutes, range) : null;
  const add = (day: string, dim: number, ms: number, until?: number) => {
    if (ms > 0) out.set(activityDayKey(day, dim), (out.get(activityDayKey(day, dim)) ?? 0) + ms);
    if (intervals && ms > 0) {
      const key = activityDayKey(day, dim);
      const spans = until !== undefined ? [[until - ms, until] as ActivityInterval] : prepared!.get(key);
      if (!spans) throw new ActivityPending(`Active intervals of ${provider} await background preparation`, provider);
      let collected = intervals.get(key);
      if (!collected) intervals.set(key, collected = []);
      for (const span of spans) collected.push(span);
    }
  };
  const inRange = (day: string) => (range.since === undefined || day >= range.since) && (range.until === undefined || day <= range.until);
  const terms = ["d.provider=?"], params: string[] = [provider];
  if (range.since) { terms.push("d.day>=?"); params.push(range.since); }
  if (range.until) { terms.push("d.day<=?"); params.push(range.until); }
  // A plan call's dimension names no rate vendor; an OpenCode-other call's names its own.
  terms.push(kind === "e" ? "m.vendor IS NULL" : "m.vendor IS NOT NULL");
  const rows = db.query(`SELECT d.day, d.dim_id, d.first_ts, d.last_ts, d.gap_from_ts, d.${column} active, m.source, m.identity
    FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id WHERE ${terms.join(" AND ")}`).all(...params) as
    Array<{ day: string; dim_id: number; first_ts: string; last_ts: string; gap_from_ts: string | null; active: number; source: string | null; identity: string | null }>;
  const factColumns = "f.session, f.source, f.account_key, f.home, f.eligible, f.vendor, f.ts, f.identity, f.day, f.dim_id, f.accounting, f.gap_ms, f.gap_from";
  const mixed = new Set((db.query("SELECT session FROM usage_ledger_mixed_sessions WHERE provider=?").all(provider) as Array<{ session: string }>)
    .map(row => row.session));
  const dayFacts = db.query(`SELECT ${factColumns} FROM usage_ledger_facts f INDEXED BY usage_ledger_facts_day_${provider}
    WHERE f.provider=${P} AND f.day=? AND f.dim_id=? AND f.copy_state='canonical' AND f.accounting=1`);
  const chainFacts = db.query(`SELECT ${factColumns} FROM usage_ledger_facts f INDEXED BY usage_ledger_facts_session_${provider}
    WHERE f.provider=${P} AND f.session=? AND f.copy_state='canonical' AND f.source IS ? AND f.account_key IS ?`);
  /**
   * The calls of one generation: those on a built day row. A call the ledger has not summed yet (its day or dimension
   * not built while it catches up) is neither a contribution nor a predecessor until it is, as its tokens are not;
   * predecessors are taken from any day, however far back.
   */
  const publishedOf = (facts: readonly ActivityFact[]): ActivityFact[] => {
    const pairs = [...new Set(facts.filter(fact => fact.dim_id !== null).map(fact => JSON.stringify([fact.day, fact.dim_id])))];
    if (!pairs.length) return [];
    // Drive indexed day/dimension probes from the small requested set, not every published day of the provider.
    const built = new Set((db.query(`SELECT d.day, d.dim_id FROM json_each(?) j CROSS JOIN usage_ledger_days d
        ON d.provider=? AND d.day=json_extract(j.value,'$[0]') AND d.dim_id=json_extract(j.value,'$[1]')`).all(JSON.stringify(pairs.map(pair => JSON.parse(pair))), provider) as
      Array<{ day: string; dim_id: number }>).map(row => activityDayKey(row.day, row.dim_id)));
    return facts.filter(fact => fact.dim_id !== null && built.has(activityDayKey(fact.day, fact.dim_id)));
  };
  /**
   * One chain (session, source, account key, class; home for OpenCode-other) of published calls in (instant, identity)
   * order, built once per read with each call's position and the account's own previous call: one lookup per call.
   */
  type OwnedChain = { position: Map<string, number>; times: Float64Array; previous: Int32Array };
  const boundaryChains = new Map<string, OwnedChain>();
  const chainOf = (fact: ActivityFact): OwnedChain => {
    const key = JSON.stringify([fact.session, fact.source, fact.account_key, kind === "o" ? fact.home : null]);
    let chain = boundaryChains.get(key);
    if (!chain) {
      const facts = publishedOf((chainFacts.all(fact.session, fact.source, fact.account_key) as ActivityFact[])
        .filter(other => activityClass(provider, other) === kind && (kind === "e" || other.home === fact.home))).sort(byInstantThenIdentity);
      const previous = new Int32Array(facts.length);
      const times = new Float64Array(facts.length);
      let owned = -1;
      facts.forEach((other, index) => {
        times[index] = Date.parse(other.ts);
        previous[index] = owned;
        if (plan.owns(other.source, other.account_key, other.ts)) owned = index;
      });
      chain = { times, previous, position: new Map(facts.map((other, index) => [other.identity, index])) };
      boundaryChains.set(key, chain);
    }
    return chain;
  };
  for (const row of rows) {
    if (!row.active && row.gap_from_ts === null) continue;
    const lower = Date.parse(row.gap_from_ts !== null && row.gap_from_ts < row.first_ts ? row.gap_from_ts : row.first_ts), upper = Date.parse(row.last_ts);
    const source = row.source === null ? null : normEraKey(row.source);
    const cut = source !== null && plan.ranges.some(r => r.source === source
      && [r.from, r.until].some(at => Number.isFinite(at) && at > lower && at <= upper));
    if (!cut) { if (plan.owns(row.source, row.identity, row.first_ts)) add(row.day, row.dim_id, row.active); continue; }
    // An ownership boundary inside the row: each call and this account's own previous published call of its chain,
    // however far back (the stored gaps may name a call not summed yet).
    for (const fact of dayFacts.all(row.day, row.dim_id) as ActivityFact[]) {
      if (fact.session === null || mixed.has(fact.session) || activityClass(provider, fact) !== kind || !plan.owns(fact.source, fact.account_key, fact.ts)) continue;
      const chain = chainOf(fact), index = chain.position.get(fact.identity);
      if (index === undefined) continue;
      const previous = chain.previous[index]!;
      if (previous < 0) continue;
      const gap = chain.times[index]! - chain.times[previous]!;
      if (gap > 0) add(row.day, row.dim_id, Math.min(gap, cutoff), chain.times[index]);
    }
  }
  if (mixed.size) {
    // Sessions with calls in more than one chain: every call the account owns, per class, in (instant, identity) order.
    // Only published calls (`publishedOf`), as contributions and as predecessors.
    const facts = publishedOf(db.query(`SELECT ${factColumns} FROM (SELECT value session FROM json_each(?)) s CROSS JOIN usage_ledger_facts f
      INDEXED BY usage_ledger_facts_session_${provider} ON f.provider=${P} AND f.session=s.session WHERE f.copy_state='canonical'`)
      .all(JSON.stringify([...mixed])) as ActivityFact[]);
    const chains = new Map<string, ActivityFact[]>();
    for (const fact of facts) {
      if (activityClass(provider, fact) !== kind || !plan.owns(fact.source, fact.account_key, fact.ts)) continue;
      // An OpenCode-other call's owner is its home: one chain per session and home.
      const key = kind === "o" ? JSON.stringify([fact.session, fact.home]) : fact.session;
      (chains.get(key) ?? chains.set(key, []).get(key)!).push(fact);
    }
    for (const chain of chains.values()) {
      chain.sort(byInstantThenIdentity);
      for (let index = 1; index < chain.length; index++) {
        const fact = chain[index]!;
        if (!fact.accounting || fact.dim_id === null || !inRange(fact.day)) continue;
        const gap = Date.parse(fact.ts) - Date.parse(chain[index - 1]!.ts);
        if (gap > 0) add(fact.day, fact.dim_id, Math.min(gap, cutoff), Date.parse(fact.ts));
      }
    }
  }
  return out;
}


/** A Codex history key: the pricing day, the ledger dimension and the owner (`codexEventOwner`, null when nobody owns it). */
export const codexActivityKey = (day: string, dim: number, owner: string | null) => JSON.stringify([day, dim, owner]);
export interface CodexOwnedDay { day: string; dim: number; owner: string | null; calls: number; tokens: number; active_ms: number }
/**
 * Codex calls, tokens and active milliseconds per (pricing day, dimension, owner) for one idle cutoff (rule D2, decision D4):
 * the owner is the verified account of the call's source at its instant, or that account's business-credit pool. Tokens
 * are fresh, cached and written input plus output. Read from the day cohorts' stored sums; a cohort is read from its calls
 * only when an ownership boundary of its source lies between its earliest predecessor (or the day before its pricing day,
 * as far as a time-zone offset reaches) and two days after it; then each call and its stored predecessor are owned
 * separately, and a call whose predecessor belongs to another owner takes its own owner's previous call of the copy.
 * Raises `ActivityPending` until the activity was published.
 */
export function readCodexOwnedDays(db: Database, resolver: AccountResolver, cutoffMinutes: number,
  range: { since?: string; until?: string } = {}, intervals?: Map<string, ActivityInterval[]>): Map<string, CodexOwnedDay> {
  if (!(ACTIVITY_CUTOFF_MINUTES as readonly number[]).includes(cutoffMinutes)) throw new Error(`Unsupported idle cutoff: ${cutoffMinutes}`);
  const state = readCodexLedgerState(db);
  if (!state || !tableExists(db, "codex_price_ledger_aggregates")) return new Map();
  if (!state.activity_published) throw new ActivityPending("Codex active time awaits background preparation", "codex");
  const column = activityColumn(cutoffMinutes as ActivityCutoff), cutoff = cutoffMinutes * 60_000, out = new Map<string, CodexOwnedDay>();
  const prepared = intervals ? storedActivityIntervals(db, "codex", cutoffMinutes, range) : null;
  const addIntervals = (day: string, dim: number, owner: string | null, spans: ActivityInterval[] | undefined) => {
    if (!intervals) return;
    if (!spans) throw new ActivityPending("Codex active intervals await background preparation", "codex");
    const key = codexActivityKey(day, dim, owner);
    intervals.set(key, [...(intervals.get(key) ?? []), ...spans]);
  };
  const ranges = resolver.accounts("codex").flatMap(account => resolver.plan("codex", account).ranges);
  const ownerAt = (source: string | null, billing: string | null, ms: number) =>
    codexEventOwner(Number.isFinite(ms) ? resolver.resolve("codex", source, null, new Date(ms).toISOString()).account : null, { billing_mode: billing });
  const entry = (day: string, dim: number, owner: string | null) => {
    const key = codexActivityKey(day, dim, owner);
    return out.get(key) ?? out.set(key, { day, dim, owner, calls: 0, tokens: 0, active_ms: 0 }).get(key)!;
  };
  const terms = ["a.grain='day'", "a.copy_state='canonical'"], params: string[] = [];
  if (range.since) { terms.push("a.day>=?"); params.push(range.since); }
  if (range.until) { terms.push("a.day<=?"); params.push(range.until); }
  // The hour grain holds only calls with a valid instant: a day with fewer timed calls has a call no instant can own.
  const rows = db.query(`SELECT a.day, a.dim_id, SUM(a.calls) calls, SUM(a.uncached+a.cached+a.writes+a.output) tokens, SUM(a.${column}) active,
      MIN(a.gap_from_ms) gap_from, MIN(a.first_ts) first_ts, d.source, d.billing_mode,
      (SELECT COALESCE(SUM(h.calls), 0) FROM codex_price_ledger_aggregates h WHERE h.grain='hour' AND h.copy_state='canonical'
        AND h.day=a.day AND h.dim_id=a.dim_id) timed
    FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id WHERE ${terms.join(" AND ")} GROUP BY a.day, a.dim_id`)
    .all(...params) as Array<{ day: string; dim_id: number; calls: number; tokens: number; active: number; gap_from: number | null; first_ts: string;
      source: string | null; billing_mode: string | null; timed: number }>;
  const calls = db.query(`SELECT e.copy_id, e.source_offset, e.instant_ms, e.gap_ms, e.gap_from_ms, e.uncached+e.cached+e.writes+e.output tokens
    FROM codex_price_ledger_events e INDEXED BY codex_price_ledger_events_day WHERE e.day=? AND e.dim_id=? AND e.copy_state='canonical' AND e.admitted=1`);
  // One chain (copy, business billing or not) of published calls - those on a built day cohort - in (instant, offset)
  // order: a call the ledger has not summed yet is no predecessor until it is.
  const chainCalls = db.query(`SELECT e.source_offset, e.instant_ms FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id
    WHERE e.copy_id=? AND e.copy_state='canonical' AND e.admitted=1 AND e.instant_ms IS NOT NULL AND (d.billing_mode IS 'business_credits')=?
      AND EXISTS (SELECT 1 FROM codex_price_ledger_aggregates a WHERE a.grain='day' AND a.day=e.day AND a.dim_id=e.dim_id AND a.copy_state='canonical')
    ORDER BY e.instant_ms, e.source_offset`);
  // Built once per read with each call's position and the previous call of the same owner: one lookup per call.
  type OwnedChain = { position: Map<number, number>; calls: Array<{ source_offset: number; instant_ms: number }>; previous: Int32Array };
  const chains = new Map<string, OwnedChain>();
  const chainOf = (copy: number, business: number, source: string | null, billing: string | null): OwnedChain => {
    const key = `${copy}|${business}`;
    let chain = chains.get(key);
    if (!chain) {
      // A copy has one source and the chain one billing pool, so a call's owner depends on its instant alone.
      const calls = chainCalls.all(copy, business) as Array<{ source_offset: number; instant_ms: number }>;
      const previous = new Int32Array(calls.length), last = new Map<string | null, number>();
      calls.forEach((call, index) => {
        const owner = ownerAt(source, billing, call.instant_ms);
        previous[index] = last.get(owner) ?? -1;
        last.set(owner, index);
      });
      chain = { calls, previous, position: new Map(calls.map((call, index) => [call.source_offset, index])) };
      chains.set(key, chain);
    }
    return chain;
  };
  for (const row of rows) {
    const day = Date.parse(`${row.day}T00:00:00.000Z`);
    const from = Math.min(row.gap_from ?? Infinity, day - 86_400_000), until = day + 2 * 86_400_000;
    // Calls without a valid instant are owned call by call (by nobody), so a day holding one is read from its calls.
    if (row.timed === row.calls && Number.isFinite(Date.parse(row.first_ts)) && !codexOwnershipCuts(ranges, row.source, from - 1, until).length) {
      const target = entry(row.day, row.dim_id, ownerAt(row.source, row.billing_mode, Date.parse(row.first_ts)));
      target.calls += row.calls; target.tokens += row.tokens; target.active_ms += row.active;
      if (intervals && row.active > 0) addIntervals(row.day, row.dim_id, target.owner, prepared!.get(activityDayKey(row.day, row.dim_id)));
      continue;
    }
    const business = row.billing_mode === "business_credits" ? 1 : 0;
    for (const call of calls.all(row.day, row.dim_id) as Array<{ copy_id: number; source_offset: number; instant_ms: number | null; gap_ms: number | null;
      gap_from_ms: number | null; tokens: number }>) {
      const owner = ownerAt(row.source, row.billing_mode, call.instant_ms ?? NaN), target = entry(row.day, row.dim_id, owner);
      target.calls += 1; target.tokens += call.tokens;
      if (call.instant_ms === null) continue;
      // This owner's own previous published call of the copy, however far back (the stored gap may name one not summed yet).
      const instant = call.instant_ms, chain = chainOf(call.copy_id, business, row.source, row.billing_mode);
      const index = chain.position.get(call.source_offset);
      if (index === undefined) continue;
      const previous = chain.previous[index]!;
      if (previous >= 0 && instant > chain.calls[previous]!.instant_ms) {
        const ms = Math.min(instant - chain.calls[previous]!.instant_ms, cutoff);
        target.active_ms += ms;
        addIntervals(row.day, row.dim_id, owner, [[instant - ms, instant]]);
      }
    }
  }
  return out;
}

/**
 * Conflicted identities (their copies disagree) with a copy in the range, per account: one number each. Candidates are the
 * conflict markers of the range's day rows; each is decided as the fact index decided it - its eligible copies, owned by
 * the earliest copy's source and session identity at the earliest instant.
 */
export function readConflictedIdentities(db: Database, provider: string, plans: readonly AccountReadPlan[], since: string, until: string): Map<string, number> {
  const P = sqlProvider(provider), counts = new Map<string, number>(), DAY_MS = 86_400_000;
  const from = Date.parse(`${since}T00:00:00.000Z`), to = Date.parse(`${until}T00:00:00.000Z`) + DAY_MS;
  const lower = Number.isFinite(from) ? new Date(from).toISOString() : "0000-01-01T00:00:00.000Z";
  const upper = Number.isFinite(to) && to < Date.parse("10000-01-01T00:00:00.000Z") ? new Date(to).toISOString() : "9999-12-31T23:59:59.999Z";
  const days = (db.query(`SELECT DISTINCT day FROM usage_ledger_days WHERE provider=? AND day>=? AND day<=? AND conflicts>0`)
    .all(provider, since, until) as Array<{ day: string }>).map(row => row.day);
  if (!days.length) return counts;
  const rows = db.query(`SELECT a.identity, MIN(a.fingerprint)<>MAX(a.fingerprint) conflict, MIN(a.ts) ts,
      (SELECT k.source FROM usage_ledger_facts k INDEXED BY usage_ledger_facts_identity_${provider}
        WHERE k.provider=${P} AND k.identity=a.identity ORDER BY k.source_key LIMIT 1) source,
      (SELECT k.account_key FROM usage_ledger_facts k INDEXED BY usage_ledger_facts_identity_${provider}
        WHERE k.provider=${P} AND k.identity=a.identity ORDER BY k.source_key LIMIT 1) account_key
    FROM usage_ledger_facts a INDEXED BY usage_ledger_facts_identity_${provider}
    WHERE a.provider=${P} AND a.eligible=1 AND a.identity IN (SELECT b.identity FROM usage_ledger_facts b INDEXED BY usage_ledger_facts_day_${provider}
      WHERE b.provider=${P} AND b.day IN (SELECT value FROM json_each(?)) AND b.copy_state='conflict' AND b.ts>=? AND b.ts<?)
    GROUP BY a.identity`).all(JSON.stringify(days), lower, upper) as Array<{ conflict: number; ts: string; source: string | null; account_key: string | null }>;
  for (const row of rows) {
    if (!row.conflict) continue;
    for (const plan of plans) if (plan.owns(row.source, row.account_key, row.ts)) counts.set(plan.account, (counts.get(plan.account) ?? 0) + 1);
  }
  return counts;
}

/** Model and place of every dimension of a shared-ledger provider, by id (as text); its project follows the rules (rules-now.ts). */
export function readUsageLedgerPlaces(db: Database, provider: UsageLedgerProvider): Map<string, { source: string | null; repo: string | null;
  repo_group: string | null; model: string | null; home: string | null; cwd: string | null; project: string | null; shift: number | null }> {
  return new Map((db.query("SELECT id, source, repo, repo_group, model, home, cwd, project, shift FROM usage_ledger_dims WHERE provider=?").all(provider) as
    Array<{ id: number; source: string | null; repo: string | null; repo_group: string | null; model: string | null; home: string | null; cwd: string | null;
      project: string | null; shift: number | null }>).map(row => [String(row.id), row]));
}
/** Model and place of every Codex ledger dimension, by id. */
export function readCodexPlaces(db: Database): Map<number, { source: string | null; nested: string | null; model: string | null; repo: string | null; cwd: string | null; home: string | null;
  project: string | null }> {
  return new Map((db.query("SELECT id, source, nested, model, repo, cwd, home, project FROM codex_price_ledger_dims").all() as
    Array<{ id: number; source: string | null; nested: string | null; model: string | null; repo: string | null; cwd: string | null; home: string | null; project: string | null }>)
    .map(row => [row.id, row]));
}
/**
 * Day rows of OpenCode's providers outside the GLM plan (their dimension names a rate vendor not in `planVendors`): calls
 * without conflict markers and tokens of visible output (OpenCode's output total includes its reasoning).
 */
export function readOtherProviderDays(db: Database, planVendors: readonly string[], range: { since?: string; until?: string }):
  Array<{ day: string; dim_id: number; calls: number; tokens: number; source: string | null; home: string | null; model: string | null; repo: string | null;
    repo_group: string | null; subject: string | null }> {
  const terms = ["d.provider='glm'", "m.vendor IS NOT NULL", "m.vendor NOT IN (SELECT value FROM json_each(?))"];
  const params: string[] = [JSON.stringify(planVendors)];
  if (range.since) { terms.push("d.day>=?"); params.push(range.since); }
  if (range.until) { terms.push("d.day<=?"); params.push(range.until); }
  const projects = usageDimProjects(db, "glm");
  return (db.query(`SELECT d.day, d.dim_id, d.calls-d.conflicts calls, d.t_uncached+d.t_cache_read+d.t_write_unknown+d.t_out-d.t_thinking tokens,
      m.source, m.home, m.model, m.repo, m.repo_group, NULL subject
    FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id WHERE ${terms.join(" AND ")}`).all(...params) as
    Array<{ day: string; dim_id: number; calls: number; tokens: number; source: string | null; home: string | null; model: string | null; repo: string | null;
      repo_group: string | null; subject: string | null }>).map(row => ({ ...row, subject: projects(row.dim_id, row.day).subject }));
}

/**
 * The actual-mode rate key of each usage-ledger day row of `[since, until]` (migration 0070), by `activityDayKey`: the key
 * all its eligible calls carry, null without one. Its stored rates times the row's bucket sums are the row's priced amount
 * by token type.
 */
export function readDayActKeys(db: Database, provider: UsageLedgerProvider, since: string, until: string): Map<string, number | null> {
  return new Map((db.query("SELECT day, dim_id, act_key FROM usage_ledger_days WHERE provider=? AND day>=? AND day<=?")
    .all(provider, since, until) as Array<{ day: string; dim_id: number; act_key: number | null }>)
    .map(row => [activityDayKey(row.day, row.dim_id), row.act_key]));
}
/** Femto-dollars per token of each bucket of a usage-ledger rate key, by key id (`usage_ledger_keys`); null: no rate. */
export function readLedgerKeyRates(db: Database, provider: UsageLedgerProvider): Map<number, Record<string, string | null> | null> {
  return new Map((db.query("SELECT id, rates FROM usage_ledger_keys WHERE provider=?").all(provider) as Array<{ id: number; rates: string }>)
    .map(key => [key.id, JSON.parse(key.rates || "null") as Record<string, string | null> | null]));
}
/** One eligible canonical call of a usage-ledger day row with its stored actual and Standard valuations (limbs as text). */
export interface LedgerValuedCall {
  ts: string; source: string | null; account_key: string | null; model: string | null; usage_valid: number;
  q_uncached: number; q_cache_read: number; q_write_5m: number; q_write_1h: number; q_write_unknown: number; q_out: number;
  act_key: number | null; act_reason: string | null; act_usd: string; act_nano: string; act_femto: string;
  std_reason: string | null; std_usd: string | null; std_nano: string | null; std_femto: string | null;
}
/**
 * The eligible canonical calls of selected dimensions on one UTC day. Batch the exceptional rows whose sums cannot
 * be split, so the provider's day index is scanned once, not once per dimension. No other dimensions are returned.
 */
export function readDayRowsCalls(db: Database, provider: UsageLedgerProvider, day: string, dimIds: readonly number[]): Map<number, LedgerValuedCall[]> {
  const groups = new Map<number, LedgerValuedCall[]>();
  if (!dimIds.length) return groups;
  const rows = db.query(`SELECT dim_id, ts, source, account_key, model, usage_valid, q_uncached, q_cache_read, q_write_5m, q_write_1h, q_write_unknown,
      q_out, act_key, act_reason, CAST(act_usd AS TEXT) act_usd, CAST(act_nano AS TEXT) act_nano, CAST(act_femto AS TEXT) act_femto, std_reason,
      CAST(std_usd AS TEXT) std_usd, CAST(std_nano AS TEXT) std_nano, CAST(std_femto AS TEXT) std_femto
    FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_${provider}
    WHERE provider=${sqlProvider(provider)} AND day=? AND dim_id IN (SELECT value FROM json_each(?))
      AND copy_state='canonical' AND accounting=1 AND eligible=1
    ORDER BY ts, source_key`).all(day, JSON.stringify(dimIds)) as Array<LedgerValuedCall & { dim_id: number }>;
  for (const { dim_id, ...row } of rows) {
    const group = groups.get(dim_id) ?? [];
    group.push(row);
    groups.set(dim_id, group);
  }
  return groups;
}
