import { markWindowUsageRangesDirty } from "../db/window-usage";
import { publishActivityIntervals } from "../db/activity-intervals";
import type { LedgerPlace } from "../db/window-answers";
import type { Database } from "bun:sqlite";
import { analysisHash } from "../db/analysis";
import { BATCH_MS } from "../db/batches";
import { FACT_DAY_PREDICATE, FACT_DAY_REVISIONS_SQL, factDaysTracked, factTableRevision } from "../db/fact-day-revisions";
import { ACTIVITY_CUTOFF_MINUTES, activityColumn, ensureUsageLedgerSchema, LONG_CALL_OUT, splitFemto, sqlProvider, TIMED_SUMS,
  usageLedgerFactIndexes, USAGE_LEDGER_VERSION, type UsageLedgerProvider } from "../db/usage-ledger";
import { subscriptionRulesDigest } from "../db/usage-price-totals";
import { isAccountingDay, resolveCodexAccountingConfig, type CodexAccountingConfig } from "./codex-accounting-pricing";
import type { RateCard } from "./pricing";
import { modelRateKey, recordedSpeed, subscriptionAccountingAdapter, subscriptionEventFromRow, subscriptionContextBand,
  type SubscriptionAccountingAdapter, type SubscriptionEvent, type SubscriptionRateEvent, type TokenBucket, type TokenQuantities } from "./subscription-accounting-adapters";
import { codexGlobalValuation, ledgerRateChoice, valueLedgerQuantities, type LedgerRateChoice, type LedgerRates,
  type LedgerValuation } from "./usage-ledger-rates";

/**
 * Producer of the usage ledger (docs/shared-register-plan-2026-10-03.md). Background only: every
 * step is one bounded immediate transaction.
 *
 * - `backfill` turns the provider's source rows into typed facts with their valuations;
 * - `resolve` decides each identity's canonical copy, duplicates and conflicts set-wise;
 * - `revalue` revisits facts after a rate card change and rewrites only changed valuations;
 * - `reconcile` follows the source table's changed days (fact-day-revisions.ts, plan §4 rule 3):
 *   each changed day's rows are compared with their facts by content hash; a new or changed row
 *   gets its fact again, a fact whose row left the day is dropped. Their identities are resolved
 *   again and the days they touch re-aggregated. Each reconciled day's revision is kept in
 *   `usage_ledger_source_days`, so a restart resumes at the first day still differing.
 * - `session` recomputes the activity gaps of the sessions those changes touched (`regapSessions`, stored activity,
 *   docs/stored-activity-plan-2026-10-07.md), between identities and days; a day whose gaps alone changed has its
 *   activity sums re-summed in place (kind `activity`), never rebuilt.
 * The state is `ready` once every source day is reconciled (`covered` equals the table's revision)
 * and no identity, session or day is left dirty; `activity_published` is set the first time it is, from then on the
 * activity sums are part of what `ready` vouches for.
 *
 * Every step is one write transaction sized to stay near BATCH_MS: the rows, identities or days a step
 * takes adapt to how long the last step of the same kind took, so no step holds the writer for seconds
 * (a waiting sync gives up after its busy timeout).
 */
type Row = Record<string, string | number | null>;
type State = { provider: string; version: number; phase: "backfill" | "resolve" | "revalue" | "reconcile";
  status: "pending" | "ready"; covered: number; bookmark: string; rules_digest: string; revision: number;
  /** The revision of the last time the ledger was complete; 0 before its first build (read-freshness.ts). */
  published_revision: number;
  /** 1 once every session's gaps and every day's activity sums have been computed (migration 0066 queues them all). */
  activity_published: number };
/**
 * A source day being reconciled across steps: its revision when it started and the last row id done; `retime` lists the
 * fact days whose response times alone changed, re-summed when the source day is done.
 */
type DayProgress = { day: string; revision: number; after: number; retime?: string[] };
/** `processed` counts units of work done (rows, identities, days, or 1 for a phase step), never 0 when a step changed anything. */
export interface UsageLedgerStep { complete: boolean; processed: number; reason?: string; /** Facts read again after a rate card change. */ revalued?: number }
const DAY_CHUNK = 64;
const SESSION_CHUNK = 256;
/** Units of the next step per kind, adapted to stay near BATCH_MS; kept per connection and provider, not durable. */
const stepSizes = new WeakMap<Database, Map<string, number>>();

const nonBlank = (value: unknown): string | null => value == null || String(value) === "" ? null : String(value);
const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
/** The day the change revisions record for a source row (fact-day-revisions.ts). */
const sourceDay = (row: Row) => row.ts == null ? "" : String(row.ts).slice(0, 10);
/** A source row's response time (Claude `resp_ms`): a positive integer, or null when unknown. */
const responseMs = (row: Row): number | null => {
  const value = row.resp_ms;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
};
/**
 * The content hash a fact keeps of its source row. The response time is left out: it never changes what a call
 * is or costs, so a row whose only change is its time keeps its fact and only the fact's time and timed sums follow
 * (`reconcileDay`). Without the column the hash is the one computed before it existed.
 */
function sourceHash(row: Row): string {
  // An empty funding (migration 0092) keeps the hash computed before the column existed; only funded rows change.
  const { billing_mode: funding, ...unfunded } = row;
  const hashed = funding == null ? unfunded : row;
  if (!("resp_ms" in hashed)) return analysisHash(hashed);
  const { resp_ms: _time, ...rest } = hashed;
  return analysisHash(rest);
}
/** Changed source days of a provider's table: their revision differs from the one reconciled. */
const CHANGED_DAYS_SQL = `FROM (${FACT_DAY_REVISIONS_SQL}) r
  LEFT JOIN usage_ledger_source_days s ON s.provider=?2 AND s.day=r.day WHERE s.revision IS NOT r.revision`;

/** Everything one fact needs from the card, compiled once per producer call. */
interface Context {
  db: Database; provider: UsageLedgerProvider; adapter: SubscriptionAccountingAdapter; card: RateCard;
  archiveRoot: string; codex: CodexAccountingConfig | null; keys: Map<string, number>;
  choices: Map<string, LedgerRateChoice>;
}
function rateChoice(context: Context, adapter: Pick<SubscriptionAccountingAdapter, "rateVendor" | "speed">,
  fact: SubscriptionRateEvent, standard: boolean): LedgerRateChoice {
  const cacheKey = JSON.stringify([adapter.rateVendor, adapter.speed, fact.model, fact.speed, standard, fact.ts.slice(0, 10),
    subscriptionContextBand(context.card, adapter, fact, standard)]);
  let choice = context.choices.get(cacheKey);
  if (!choice) { choice = ledgerRateChoice(context.card, adapter, fact, standard); context.choices.set(cacheKey, choice); }
  return choice;
}
/** A valuation with its rate key and, for card keys, the key's bucket rates (readers derive per-bucket costs from them). */
type Valuations = Record<"std" | "act" | "glb", (LedgerValuation & { key: string; rates?: LedgerRates }) | null>;

/** Upserts a key once per step, so its stored rates follow the card the valuations use. */
function keyId(context: Context, key: string, rates?: LedgerRates): number {
  let id = context.keys.get(key);
  if (id === undefined) {
    context.db.query(`INSERT INTO usage_ledger_keys(provider,key,rates) VALUES(?,?,?)
      ON CONFLICT(provider,key) DO UPDATE SET rates=excluded.rates`).run(context.provider, key,
      rates ? JSON.stringify(Object.fromEntries(Object.entries(rates).map(([bucket, rate]) => [bucket, typeof rate === "bigint" ? String(rate) : rate]))) : "null");
    id = (context.db.query("SELECT id FROM usage_ledger_keys WHERE provider=? AND key=?").get(context.provider, key) as { id: number }).id;
    context.keys.set(key, id);
  }
  return id;
}


type ValuedFact = Pick<SubscriptionEvent, "model" | "ts" | "speed" | "eligible" | "vendor" | "usage_valid"> & { quantities: Pick<TokenQuantities, TokenBucket> };
/** The three variants of one fact, exactly as the old register's contribution recorded them. */
function valuationsOf(context: Context, fact: ValuedFact): Valuations {
  const { adapter, card } = context, valid = fact.usage_valid !== false;
  const own = (standard: boolean) => {
    const choice = rateChoice(context, adapter, fact, standard);
    // The register checks the counters before pricing: invalid usage is its own reason there.
    return valid ? { key: choice.key, rates: choice.rates, ...valueLedgerQuantities(fact.quantities, true, choice) }
      : { key: choice.key, rates: choice.rates, reason: "invalid_usage", subtotal: 0n };
  };
  const std = fact.eligible ? own(true) : null, act = fact.eligible ? own(false) : null;
  // The rate vendor global usage gives a call this provider's own track owns (old register `trackVendor`).
  const vendor = fact.eligible ? adapter.modelRateVendor?.(fact.model) ?? adapter.rateVendor : fact.vendor;
  const model = adapter.modelFamilyKeys ? modelRateKey(card, vendor, fact.model) : fact.model;
  let glb: Valuations["glb"];
  if (fact.eligible && vendor === adapter.rateVendor && model === fact.model) glb = act;
  else if (vendor === "openai") glb = codexGlobalValuation(context.codex ??= resolveCodexAccountingConfig(card), fact);
  else {
    const choice = rateChoice(context, { rateVendor: vendor, speed: adapter.speed }, { ...fact, model }, false);
    glb = { key: choice.key, rates: choice.rates, ...valueLedgerQuantities(fact.quantities, valid, choice) };
  }
  return { std, act, glb };
}
function valuationColumns(context: Context, valuations: Valuations): Array<number | string | null> {
  return (["std", "act", "glb"] as const).flatMap(variant => {
    const value = valuations[variant];
    if (!value) return [null, null, null, null, null];
    const money = splitFemto(value.subtotal);
    // Whole dollars past 2^53 have no exact JS number: such a call is unpriced, never rounded.
    if (money.usd > BigInt(Number.MAX_SAFE_INTEGER)) return [keyId(context, value.key, value.rates), "invalid_valuation", 0, 0, 0];
    return [keyId(context, value.key, value.rates), value.reason, Number(money.usd), Number(money.nano), Number(money.femto)];
  });
}

const FACT_COLUMNS = `provider,row_id,identity,source_key,fingerprint,ts,day,accounting,model,speed,source,account_key,
  identity_conflict,eligible,vendor,home,source_id,q_uncached,q_cache_read,q_write_5m,q_write_1h,q_write_unknown,q_out,q_thinking,
  usage_valid,precise_time,product,subject,session,repo,repo_group,project,cwd,project_name,reported_raw,reported_unit,reported_provenance,copy_state,
  src_day,src_hash,std_key,std_reason,std_usd,std_nano,std_femto,act_key,act_reason,act_usd,act_nano,act_femto,glb_key,glb_reason,glb_usd,glb_nano,glb_femto,
  resp_ms,billing_mode`;
const FACT_PLACEHOLDERS = FACT_COLUMNS.split(",").map(() => "?").join(",");

/** Facts of one source row: none without a usable timestamp. Returns the identity it now belongs to. */
function putFact(context: Context, row: Row, clocks: Clocks): string | null {
  const event = subscriptionEventFromRow(context.adapter, row, context.archiveRoot);
  if (!event) return null;
  event.ts = new Date(event.ts).toISOString();
  const day = event.ts.slice(0, 10), q = event.quantities;
  // Subject, session, repository, product and reported money stay out of the fingerprint: their
  // corrections move where a call belongs, they never make two copies of it disagree.
  const fingerprint = analysisHash([event.ts, event.model, event.speed, event.quantities, event.precise_time, event.usage_valid]);
  const valuations = valuationsOf(context, event);
  context.db.query(`INSERT INTO usage_ledger_facts(${FACT_COLUMNS}) VALUES(${FACT_PLACEHOLDERS})`).run(
    context.provider, Number(row.id), event.identity, String(row.id), fingerprint, event.ts, day, isAccountingDay(day) ? 1 : 0,
    event.model ?? null, event.speed, event.source, event.account_key, event.identity_conflict ? 1 : 0, event.eligible ? 1 : 0,
    event.vendor, event.home ?? "", event.source_id ?? "", q.in_uncached, q.in_cache_read, q.in_cache_write_5m, q.in_cache_write_1h,
    q.in_cache_write_unknown, q.out_total, q.out_thinking, event.usage_valid === false ? 0 : 1, event.precise_time ? 1 : 0,
    event.product ?? null, event.subject ?? null, event.session ?? null, event.repo ?? null, event.repo_group ?? null,
    // The raw project column, as the old fact index filtered on it (Gemini records no subject).
    row.project_id == null ? null : String(row.project_id),
    // Where the call was made, for the project views; OpenCode names its working directory `directory`.
    nonBlank(row.cwd ?? row.directory), nonBlank(row.project),
    event.reported?.raw ?? null, event.reported?.unit ?? null, event.reported?.provenance ?? null, "pending",
    sourceDay(row), sourceHash(row), ...valuationColumns(context, valuations), responseMs(row), event.funding ?? null);
  if (event.session) markDirty(context, "session", event.session);
  clocks.add();
  return event.identity;
}

/** The provider's ledger clock, bumped once per published batch; the response cache keys on it. */
class Clocks {
  private changed = false;
  constructor(private readonly provider: UsageLedgerProvider) {}
  add(): void { this.changed = true; }
  flush(db: Database): void {
    if (!this.changed || !tableExists(db, "analysis_source_revisions")) return;
    db.query(`INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES(?,'*',1)
      ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1`).run(usageLedgerClock(this.provider));
    this.changed = false;
  }
}
export const usageLedgerClock = (provider: string) => `usage-ledger:${provider}`;

/** Removes the facts of source rows; their identities and days become dirty. */
function dropFacts(context: Context, rowIds: readonly number[], clocks: Clocks): void {
  if (!rowIds.length) return;
  const ids = JSON.stringify(rowIds);
  const old = context.db.query(`SELECT identity,day,session FROM usage_ledger_facts
    WHERE provider=? AND row_id IN (SELECT value FROM json_each(?))`).all(context.provider, ids) as
    Array<{ identity: string; day: string; session: string | null }>;
  for (const fact of old) {
    clocks.add();
    markDirty(context, "identity", fact.identity);
    markDirty(context, "day", fact.day);
    if (fact.session) markDirty(context, "session", fact.session);
  }
  context.db.query("DELETE FROM usage_ledger_facts WHERE provider=? AND row_id IN (SELECT value FROM json_each(?))").run(context.provider, ids);
}
function markDirty(context: Context, kind: "identity" | "day" | "session", value: string): void {
  context.db.query("INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value) VALUES(?,?,?)").run(context.provider, kind, value);
}

/**
 * Canonical copy, duplicates and conflicts, the old fact index's rule: copies that disagree on the
 * fingerprint are a conflict with no accepted usage; agreeing copies keep the lexically least
 * `source_key`. A conflicted identity contributes one marker per day, carried by that day's least
 * copy. Product and reported money merge over every live copy.
 *
 * The rule needs every copy of an identity, so it runs in two parts: `resolutionStats` gathers
 * per-identity (and, for conflicts, per-day) figures into connection-temporary tables, and
 * `applyResolution` writes them onto the facts of those identities. Incremental work resolves the
 * dirty identities; the first fill resolves every identity in identity order, a bounded range per step.
 */
const resolveTables = (provider: string) => ({ stats: `temp.usage_ledger_resolve_${provider}`, days: `temp.usage_ledger_resolve_days_${provider}` });
function resolutionStats(context: Context, identities: readonly string[]): void {
  const { db, provider } = context, { stats, days } = resolveTables(provider);
  db.exec(`CREATE TABLE IF NOT EXISTS ${stats}(identity TEXT PRIMARY KEY, copies INTEGER, flagged INTEGER,
    conflict INTEGER, least TEXT, first_day TEXT, product TEXT, reported_variants INTEGER, reported_raw REAL);
    CREATE TABLE IF NOT EXISTS ${days}(identity TEXT, day TEXT, copies INTEGER, flagged INTEGER, least TEXT,
    PRIMARY KEY(identity, day));
    DELETE FROM ${stats}; DELETE FROM ${days};`);
  const P = sqlProvider(provider);
  // The identities are read through the identity index, driven by their list (CROSS JOIN keeps it outermost):
  // the cost follows their copies, never the provider's facts.
  const source = `(SELECT DISTINCT value identity FROM json_each(?1)) i CROSS JOIN usage_ledger_facts f
      INDEXED BY usage_ledger_facts_identity_${provider} ON f.provider=${P} AND f.identity=i.identity`;
  db.query(`INSERT INTO ${stats} SELECT f.identity, COUNT(*), SUM(f.identity_conflict), MIN(f.fingerprint)<>MAX(f.fingerprint),
      MIN(f.source_key), MIN(f.day),
      CASE WHEN SUM(f.product IN ('code_cli','conflict'))>0 AND SUM(f.product IN ('other_product','conflict'))>0 THEN 'conflict'
        WHEN SUM(f.product IN ('code_cli','conflict'))>0 THEN 'code_cli' WHEN SUM(f.product='other_product')>0 THEN 'other_product'
        WHEN COUNT(f.product)>0 THEN 'unknown' END,
      COUNT(DISTINCT CASE WHEN f.reported_raw IS NOT NULL THEN f.reported_unit||char(31)||CAST(f.reported_raw AS TEXT) END), MAX(f.reported_raw)
    FROM ${source} GROUP BY f.identity`).run(JSON.stringify(identities));
  // Driven by the gathered identities (CROSS JOIN keeps that order), never by the provider's facts.
  db.query(`INSERT INTO ${days} SELECT f.identity, f.day, COUNT(*), SUM(f.identity_conflict), MIN(f.source_key)
    FROM ${stats} s CROSS JOIN usage_ledger_facts f INDEXED BY usage_ledger_facts_identity_${provider} ON f.provider=${P} AND f.identity=s.identity
    WHERE s.conflict GROUP BY f.identity, f.day`).run();
}

/**
 * Writes the gathered figures onto the facts of the gathered identities. Each row is written once: its
 * dimension is registered first from a read of the same rows, then one update sets the copy state, the
 * conflict marker figures, the merged fields and the dimension. The facts are found by rowid through the
 * identity index; `+f.provider` keeps the planner off the provider's primary key, which would visit
 * every fact of the provider to test each against that list.
 */
function applyResolution(context: Context): void {
  const { db, provider } = context, { stats, days } = resolveTables(provider), P = sqlProvider(provider);
  const where = `f.rowid IN (SELECT x.rowid FROM ${stats} sx CROSS JOIN usage_ledger_facts x
    INDEXED BY usage_ledger_facts_identity_${provider} ON x.provider=${P} AND x.identity=sx.identity)`;
  const dayOf = (column: string) => `(SELECT d.${column} FROM ${days} d WHERE d.identity=f.identity AND d.day=f.day)`;
  // A conflicted identity's marker of each day rides on that day's least copy.
  const marker = `(s.conflict AND f.source_key=${dayOf("least")})`, canonical = `(NOT s.conflict AND f.source_key=s.least)`;
  const model = `CASE WHEN ${canonical} THEN f.model END`, speed = `CASE WHEN ${canonical} THEN f.speed END`;
  const vendor = "CASE WHEN f.eligible THEN NULL ELSE f.vendor END";
  // Keyed by the place of a call (migration 0069): its project follows the rules at read time (projects/resolve.ts). The
  // shift is the raw day of its timestamp less its UTC day, so a dated rule reads a stored row on its calls' raw day.
  const shift = "CAST(julianday(f.src_day) - julianday(f.day) AS INTEGER)";
  const key = `json_array(f.source, f.account_key, ${model}, ${speed}, ${vendor}, f.home, f.project_name, f.cwd, f.repo, f.repo_group, ${shift})`;
  db.query(`INSERT OR IGNORE INTO usage_ledger_dims(provider,key,source,identity,model,speed,vendor,home,project,cwd,repo,repo_group,shift)
    SELECT DISTINCT ${P}, ${key}, f.source, f.account_key, ${model}, ${speed}, ${vendor}, f.home, f.project_name, f.cwd,
      f.repo, f.repo_group, ${shift}
    FROM usage_ledger_facts f JOIN ${stats} s ON s.identity=f.identity
    WHERE +f.provider=${P} AND ${where} AND (${canonical} OR ${marker})`).run();
  db.query(`UPDATE usage_ledger_facts AS f SET
      copy_state=CASE WHEN s.conflict THEN 'conflict' WHEN f.source_key=s.least THEN 'canonical' ELSE 'duplicate' END,
      copies=CASE WHEN ${canonical} THEN s.copies WHEN ${marker} THEN ${dayOf("copies")} END,
      flagged=CASE WHEN ${canonical} THEN s.flagged WHEN ${marker} THEN ${dayOf("flagged")} END,
      conflict_first=CASE WHEN ${marker} THEN f.day=s.first_day END,
      m_product=CASE WHEN f.source_key=s.least THEN s.product END,
      m_reported_raw=CASE WHEN f.source_key=s.least AND s.reported_variants=1 THEN s.reported_raw END,
      m_reported_conflict=CASE WHEN f.source_key=s.least THEN s.reported_variants>1 END,
      dim_id=CASE WHEN ${canonical} OR ${marker} THEN (SELECT id FROM usage_ledger_dims WHERE provider=${P} AND key=${key}) END
    FROM ${stats} s WHERE +f.provider=${P} AND f.identity=s.identity AND ${where}`).run();
  db.query(`INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value) SELECT DISTINCT f.provider,'day',f.day
    FROM usage_ledger_facts f WHERE +f.provider=${P} AND ${where}`).run();
  // A moved canonical copy can carry another session: every copy's session has its gaps recomputed.
  db.query(`INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value) SELECT DISTINCT f.provider,'session',f.session
    FROM usage_ledger_facts f WHERE +f.provider=${P} AND ${where} AND f.session<>''`).run();
}

function resolveIdentities(context: Context, identities: readonly string[]): void {
  resolutionStats(context, identities);
  applyResolution(context);
}


/** Per variant: priced/unpriced events and tokens, subtotal and priced subtotal, from one contribution row. */
const variantSums = (prefix: string, applies: string) => `
  SUM(CASE WHEN ${applies} AND ${prefix}_reason IS NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN ${applies} AND ${prefix}_reason IS NOT NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN ${applies} AND ${prefix}_reason IS NULL THEN reported ELSE 0 END),
  SUM(CASE WHEN ${applies} AND ${prefix}_reason IS NOT NULL THEN reported ELSE 0 END),
  ${["usd", "nano", "femto"].map(limb => `SUM(CASE WHEN ${applies} THEN ${prefix}_${limb} ELSE 0 END)`).join(", ")},
  ${["usd", "nano", "femto"].map(limb => `SUM(CASE WHEN ${applies} AND ${prefix}_reason IS NULL THEN ${prefix}_${limb} ELSE 0 END)`).join(", ")}`;

/** A canonical call with a known response time and valid counters (its output tokens are then the billed ones). */
const TIMED = "(CASE WHEN f.resp_ms>0 AND f.usage_valid=1 THEN 1 ELSE 0 END)";
/** The timed sums (`TIMED_SUMS`, in that order) of contribution rows. */
const TIMED_SUM_SQL = ["SUM(timed)", "SUM(timed*q_out)", "SUM(timed*resp_ms)", "SUM(timed_long)", "SUM(timed_long*q_out)", "SUM(timed_long*resp_ms)"];
const HOUR_OF_TS = "CAST(strftime('%s', ts) AS INTEGER)/3600";
/**
 * The activity sums of contribution rows, in the day table's column order: per idle cutoff the sum of min(gap, cutoff),
 * the earliest predecessor instant of those gaps and the calls whose source day is not their UTC day.
 */
const ACTIVITY_SUM_SQL = [...ACTIVITY_CUTOFF_MINUTES.map(minutes => `SUM(MIN(gap, ${minutes * 60_000}))`), "MIN(gap_from)", "SUM(src_shift)"];
const ACTIVITY_DAY_COLUMNS = [...ACTIVITY_CUTOFF_MINUTES.map(activityColumn), "gap_from_ts", "src_shift_calls"];
/** The actual-mode rate key every eligible call of a day row carries (migration 0070), NULL without one or with several. */
const ROW_ACT_KEY_SQL = `CASE WHEN COUNT(DISTINCT CASE WHEN valued AND eligible THEN act_key END)=1
  AND SUM(CASE WHEN valued AND eligible AND act_key IS NULL THEN 1 ELSE 0 END)=0 THEN MAX(CASE WHEN valued AND eligible THEN act_key END) END`;

/**
 * The register's contribution rows of some days: one per canonical fact on an accounting day,
 * one marker per conflicted identity and day. `valued` is 0 on markers, which carry no amounts.
 */
function contributionRows(provider: string, speedTracked: boolean): string {
  const P = sqlProvider(provider);
  const reported = "CASE WHEN f.usage_valid THEN f.q_uncached+f.q_cache_read+f.q_write_5m+f.q_write_1h+f.q_write_unknown+f.q_out ELSE 0 END";
  // A positive gap counts unless its session has calls in more than one chain: such a session is read from its facts.
  const counted = `f.gap_ms>0 AND NOT EXISTS (SELECT 1 FROM usage_ledger_mixed_sessions m WHERE m.provider=${P} AND m.session=f.session)`;
  return `SELECT f.day, f.dim_id dim, f.ts, f.source_key, 1 valued, f.eligible,
      f.q_uncached, f.q_cache_read, f.q_write_5m, f.q_write_1h, f.q_write_unknown, f.q_out, f.q_thinking, ${reported} reported,
      f.copies-1 duplicates, 0 conflicts, 0 conflicted_identities, 1-f.precise_time approximate, 1-f.usage_valid invalid,
      ${speedTracked ? `CASE WHEN f.speed NOT IN ('standard','fast') THEN ${reported} ELSE 0 END` : "0"} unknown_speed,
      f.copies source_events, f.flagged attribution,
      f.std_reason, f.std_usd, f.std_nano, f.std_femto, f.act_reason, f.act_usd, f.act_nano, f.act_femto,
      f.glb_reason, f.glb_usd, f.glb_nano, f.glb_femto,
      ${TIMED} timed, ${TIMED} AND f.q_out>=${LONG_CALL_OUT} timed_long, COALESCE(f.resp_ms, 0) resp_ms,
      CASE WHEN ${counted} THEN f.gap_ms ELSE 0 END gap, CASE WHEN ${counted} THEN f.gap_from END gap_from,
      CASE WHEN f.src_day<>f.day THEN 1 ELSE 0 END src_shift, CASE WHEN f.eligible THEN f.act_key END act_key
    FROM usage_ledger_facts f INDEXED BY usage_ledger_facts_day_${provider} WHERE f.provider=${P} AND f.day IN (SELECT value FROM json_each(?2))
      AND f.copy_state='canonical' AND f.accounting=1
    UNION ALL
    SELECT f.day, f.dim_id, f.day||'T00:00:00.000Z', f.source_key, 0, 0, 0,0,0,0,0,0,0, 0,
      0, 1, f.conflict_first, 0, 0, 0, f.copies, f.flagged, NULL,0,0,0, NULL,0,0,0, NULL,0,0,0, 0, 0, 0, 0, NULL, 0, NULL
    FROM usage_ledger_facts f INDEXED BY usage_ledger_facts_day_${provider} WHERE f.provider=${P} AND f.day IN (SELECT value FROM json_each(?2))
      AND f.copy_state='conflict' AND f.conflict_first IS NOT NULL`;
}

function rebuildDays(context: Context, days: readonly string[]): void {
  const { db, provider } = context, list = JSON.stringify(days);
  // A fact's day is the UTC day of its instant: window sums follow exactly those days. The days' sources and session
  // identities before (their published sums) and after (their facts) say whose stored window answers they touch.
  const places = db.query(`SELECT m.source, m.identity FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id
      WHERE d.provider=?1 AND d.day IN (SELECT value FROM json_each(?2))
    UNION SELECT f.source, f.account_key FROM usage_ledger_facts f INDEXED BY usage_ledger_facts_day_${provider}
      WHERE f.provider=${sqlProvider(provider)} AND f.day IN (SELECT value FROM json_each(?2))`).all(provider, list) as LedgerPlace[];
  markWindowUsageRangesDirty(db, provider, days.map(day => [Date.parse(day), Date.parse(day) + 86_400_000] as const), places);
  // The days' contribution rows are read once into a connection-temporary table; the three sums read it.
  db.exec("DROP TABLE IF EXISTS temp.usage_ledger_contributions");
  db.query(`CREATE TEMP TABLE usage_ledger_contributions AS ${contributionRows(provider, context.adapter.speed)}`).run(provider, list);
  const rows = "SELECT * FROM temp.usage_ledger_contributions";
  db.query("DELETE FROM usage_ledger_days WHERE provider=? AND day IN (SELECT value FROM json_each(?))").run(provider, list);
  db.query("DELETE FROM usage_ledger_day_reasons WHERE provider=? AND day IN (SELECT value FROM json_each(?))").run(provider, list);
  // (first_ts, first_key) is the least (instant, key-as-text) pair; instants are fixed-width ISO texts.
  db.query(`INSERT INTO usage_ledger_days SELECT ?1, day, dim, COUNT(*),
      substr(MIN(ts||char(31)||source_key),1,24), substr(MIN(ts||char(31)||source_key),26), MAX(ts),
      SUM(q_uncached), SUM(q_cache_read), SUM(q_write_5m), SUM(q_write_1h), SUM(q_write_unknown), SUM(q_out), SUM(q_thinking),
      SUM(reported), SUM(duplicates), SUM(conflicts), SUM(conflicted_identities), SUM(approximate), SUM(invalid),
      SUM(unknown_speed), SUM(source_events), SUM(attribution),
      ${variantSums("std", "valued AND eligible")}, ${variantSums("act", "valued AND eligible")}, ${variantSums("glb", "valued")},
      ${TIMED_SUM_SQL.join(", ")}, ${ACTIVITY_SUM_SQL.join(", ")}, ${ROW_ACT_KEY_SQL}
    FROM (${rows}) GROUP BY day, dim`).run(provider);
  db.query(`INSERT INTO usage_ledger_day_reasons SELECT ?1, day, dim, variant, reason, COUNT(*), SUM(reported) FROM (
      SELECT day, dim, v.variant, CASE v.variant WHEN 'api_standard' THEN std_reason WHEN 'api_actual' THEN act_reason ELSE glb_reason END reason,
        reported FROM (${rows}) CROSS JOIN (SELECT 'api_standard' variant UNION ALL SELECT 'api_actual' UNION ALL SELECT 'api_global') v
      WHERE valued AND (eligible OR v.variant='api_global'))
    WHERE reason IS NOT NULL GROUP BY day, dim, variant, reason`).run(provider);
  // Calendar-hour sums of the same canonical calls (UTC epoch hours): local-time and hour-grain views read these.
  db.query("DELETE FROM usage_ledger_hours WHERE provider=? AND day IN (SELECT value FROM json_each(?))").run(provider, list);
  db.query(`INSERT INTO usage_ledger_hours SELECT ?1, day, ${HOUR_OF_TS} hour, dim, COUNT(*), MIN(ts), MAX(ts),
      SUM(q_uncached), SUM(q_cache_read), SUM(q_write_5m), SUM(q_write_1h), SUM(q_write_unknown), SUM(q_out), SUM(q_thinking),
      ${TIMED_SUM_SQL.join(", ")}
    FROM (${rows}) WHERE valued GROUP BY day, hour, dim`).run(provider);
  db.exec("DROP TABLE temp.usage_ledger_contributions");
  publishActivityIntervals(db, provider, days);
  // The rebuilt rows carry the current activity sums too.
  db.query("DELETE FROM usage_ledger_dirty WHERE provider=? AND kind='activity' AND value IN (SELECT value FROM json_each(?))").run(provider, list);
}

/**
 * Only the timed sums of some days, after facts of theirs changed nothing but their response time: their
 * calls, tokens, valuations and window sums stay as they are. The day and hour rows are those `rebuildDays`
 * wrote from the same canonical calls, so these values are the ones a full rebuild would write.
 */
function retimeDays(context: Context, days: readonly string[]): void {
  const { db, provider } = context, list = JSON.stringify(days);
  const columns = (prefix: string) => TIMED_SUMS.map((column, index) => `${prefix}${index}`);
  db.exec("DROP TABLE IF EXISTS temp.usage_ledger_timing");
  db.query(`CREATE TEMP TABLE usage_ledger_timing AS SELECT day, ${HOUR_OF_TS} hour, dim,
      ${TIMED_SUM_SQL.map((sum, index) => `${sum} s${index}`).join(", ")}
    FROM (${contributionRows(provider, context.adapter.speed)}) WHERE valued GROUP BY day, hour, dim`).run(provider, list);
  const set = TIMED_SUMS.map((column, index) => `${column}=t.s${index}`).join(", ");
  const daySums = `(SELECT day, dim, ${columns("s").map(name => `SUM(${name}) ${name}`).join(", ")} FROM temp.usage_ledger_timing GROUP BY day, dim)`;
  for (const [table, hourKey, source] of [["usage_ledger_hours", "h.hour=t.hour AND ", "temp.usage_ledger_timing"],
    ["usage_ledger_days", "", daySums]] as const) {
    db.query(`UPDATE ${table} SET ${TIMED_SUMS.map(column => `${column}=0`).join(", ")}
      WHERE provider=? AND day IN (SELECT value FROM json_each(?))`).run(provider, list);
    db.query(`UPDATE ${table} AS h SET ${set} FROM ${source} t
      WHERE h.provider=? AND h.day=t.day AND ${hourKey}h.dim_id=t.dim`).run(provider);
  }
  db.exec("DROP TABLE temp.usage_ledger_timing");
}

/** OpenCode's plan vendors: the GLM ledger's other ineligible calls are an activity class of their own (repo-history.ts). */
const GLM_RATE_VENDORS = new Set(["zai", "z-ai"]);
type GapRow = { rid: number; session: string; source: string | null; account_key: string | null; home: string; eligible: number; vendor: string;
  copy_state: string; ts: string; identity: string; day: string; gap_ms: number | null; gap_from: string | null };
/** A fact's activity class (D2): `e` canonical eligible, `o` canonical OpenCode-other in the GLM ledger, null in no chain. */
function chainClass(provider: string, row: Pick<GapRow, "copy_state" | "eligible" | "vendor">): "e" | "o" | null {
  if (row.copy_state !== "canonical") return null;
  if (row.eligible === 1) return "e";
  return provider === "glm" && !GLM_RATE_VENDORS.has(row.vendor) ? "o" : null;
}

/**
 * Recomputes the activity gaps of some sessions (D2). A chain is one session, source, account key and class (and home
 * for OpenCode-other, whose owner the home is); its
 * canonical calls in (instant, identity) order each get the distance to the previous one (`gap_ms`, zero for the
 * same instant) and that call's instant (`gap_from`); the first call of a chain and every call outside one get none.
 * Only changed gaps are written and only their days are queued, for an in-place re-sum of their activity (kind
 * `activity`). A session with calls in more than one chain is listed in `usage_ledger_mixed_sessions`: owners are
 * resolved at read time, so its activity is read from its facts; entering or leaving the list re-sums all its days.
 * Returns the facts whose gap changed plus the sessions whose mixed state changed.
 */
function regapSessions(context: Context, sessions: readonly string[], clocks: Clocks): number {
  const { db, provider } = context, P = sqlProvider(provider), list = JSON.stringify(sessions);
  // Driven by the session list through the session index (CROSS JOIN keeps it outermost): the cost follows the sessions' calls.
  const rows = db.query(`SELECT f.rowid rid, f.session, f.source, f.account_key, f.home, f.eligible, f.vendor, f.copy_state, f.ts, f.identity,
      f.day, f.gap_ms, f.gap_from
    FROM (SELECT DISTINCT value session FROM json_each(?1)) s CROSS JOIN usage_ledger_facts f INDEXED BY usage_ledger_facts_session_${provider}
      ON f.provider=${P} AND f.session=s.session`).all(list) as GapRow[];
  const chains = new Map<string, GapRow[]>(), chainsOf = new Map<string, Set<string>>();
  const next = new Map<GapRow, { gap: number | null; from: string | null }>();
  for (const row of rows) {
    next.set(row, { gap: null, from: null });
    const kind = chainClass(provider, row);
    if (!kind) continue;
    // An OpenCode-other call's owner is its home (no plan accounts it): homes never chain into each other.
    const key = JSON.stringify([row.source, row.account_key, kind, ...(kind === "o" ? [row.home] : [])]);
    const chain = JSON.stringify([row.session, key]);
    (chains.get(chain) ?? chains.set(chain, []).get(chain)!).push(row);
    (chainsOf.get(row.session) ?? chainsOf.set(row.session, new Set()).get(row.session)!).add(key);
  }
  for (const chain of chains.values()) {
    chain.sort((a, b) => a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
    for (let index = 1; index < chain.length; index++)
      next.set(chain[index]!, { gap: Date.parse(chain[index]!.ts) - Date.parse(chain[index - 1]!.ts), from: chain[index - 1]!.ts });
  }
  const days = new Set<string>();
  const write = db.query("UPDATE usage_ledger_facts SET gap_ms=?, gap_from=? WHERE rowid=?");
  let changed = 0;
  for (const [row, value] of next) {
    if (row.gap_ms === value.gap && row.gap_from === value.from) continue;
    write.run(value.gap, value.from, row.rid);
    days.add(row.day);
    changed++;
  }
  const mixed = new Set((db.query("SELECT session FROM usage_ledger_mixed_sessions WHERE provider=? AND session IN (SELECT value FROM json_each(?))")
    .all(provider, list) as Array<{ session: string }>).map(row => row.session));
  const flipped = new Set<string>();
  for (const session of sessions) {
    const now = (chainsOf.get(session)?.size ?? 0) > 1;
    if (now === mixed.has(session)) continue;
    if (now) db.query("INSERT INTO usage_ledger_mixed_sessions(provider,session) VALUES(?,?)").run(provider, session);
    else db.query("DELETE FROM usage_ledger_mixed_sessions WHERE provider=? AND session=?").run(provider, session);
    for (const row of rows) if (row.session === session && row.copy_state === "canonical") flipped.add(row.day);
    changed++;
  }
  // A session entering or leaving the list moves its activity between the stored sums and the readers' walk of its facts:
  // its days are re-summed in this transaction, so no reader sees the list and the sums of different generations (its
  // activity counted twice or not at all).
  if (flipped.size) {
    reactivityDays(context, [...flipped]);
    db.query("DELETE FROM usage_ledger_dirty WHERE provider=? AND kind='activity' AND value IN (SELECT value FROM json_each(?))")
      .run(provider, JSON.stringify([...flipped]));
  }
  for (const day of flipped) days.delete(day);
  if (days.size) db.query("INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value) SELECT ?,'activity',value FROM json_each(?)")
    .run(provider, JSON.stringify([...days]));
  if (changed) clocks.add();
  return changed;
}

/**
 * Only the activity sums of some days, after gaps of their calls or their sessions' mixed state changed and nothing
 * else: tokens, valuations and window sums stay as they are. The values are those `rebuildDays` writes from the same
 * contribution rows.
 */
function reactivityDays(context: Context, days: readonly string[]): void {
  const { db, provider } = context, list = JSON.stringify(days);
  db.exec("DROP TABLE IF EXISTS temp.usage_ledger_activity");
  db.query(`CREATE TEMP TABLE usage_ledger_activity AS SELECT day, dim, ${ACTIVITY_SUM_SQL.map((sum, index) => `${sum} a${index}`).join(", ")}
    FROM (${contributionRows(provider, context.adapter.speed)}) GROUP BY day, dim`).run(provider, list);
  db.query(`UPDATE usage_ledger_days SET ${ACTIVITY_DAY_COLUMNS.map(column => `${column}=${column === "gap_from_ts" ? "NULL" : "0"}`).join(", ")}
    WHERE provider=? AND day IN (SELECT value FROM json_each(?))`).run(provider, list);
  db.query(`UPDATE usage_ledger_days AS d SET ${ACTIVITY_DAY_COLUMNS.map((column, index) => `${column}=t.a${index}`).join(", ")}
    FROM temp.usage_ledger_activity t WHERE d.provider=? AND d.day=t.day AND d.dim_id=t.dim`).run(provider);
  db.exec("DROP TABLE temp.usage_ledger_activity");
  publishActivityIntervals(db, provider, days);
}

/** Whether a fact's stored mode is one the provider's mode normalization would now change. */
const staleSpeed = (context: Context, speed: string) =>
  !!context.adapter.speedNormalization && recordedSpeed(context.adapter, speed) !== speed;

function revalue(context: Context, rows: Array<Row>, clocks: Clocks): number {
  const update = context.db.query(`UPDATE usage_ledger_facts SET std_key=?,std_reason=?,std_usd=?,std_nano=?,std_femto=?,
    act_key=?,act_reason=?,act_usd=?,act_nano=?,act_femto=?,glb_key=?,glb_reason=?,glb_usd=?,glb_nano=?,glb_femto=?
    WHERE provider=? AND row_id=?`);
  // The mode is part of the fact and its fingerprint: such a fact is read again from its source row, as a
  // corrected row is, and its identity and day are resolved and summed again. One drop for the page.
  const reread = rows.filter(row => staleSpeed(context, String(row.speed))).map(row => Number(row.row_id));
  if (reread.length) {
    const sources = context.db.query(`SELECT * FROM ${context.adapter.table} WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(reread)) as Row[];
    dropFacts(context, reread, clocks);
    for (const sourceRow of sources) {
      const identity = putFact(context, sourceRow, clocks);
      if (identity) markDirty(context, "identity", identity);
    }
  }
  const rereadIds = new Set(reread);
  let changed = reread.length;
  for (const row of rows) {
    if (rereadIds.has(Number(row.row_id))) continue;
    const fact: ValuedFact = { model: row.model as string | null, ts: String(row.ts), speed: String(row.speed),
      eligible: row.eligible === 1, vendor: String(row.vendor), usage_valid: row.usage_valid === 1,
      quantities: { in_uncached: Number(row.q_uncached), in_cache_read: Number(row.q_cache_read), in_cache_write_5m: Number(row.q_write_5m),
        in_cache_write_1h: Number(row.q_write_1h), in_cache_write_unknown: Number(row.q_write_unknown), out_total: Number(row.q_out) } };
    const next = valuationColumns(context, valuationsOf(context, fact));
    const stored = ["std", "act", "glb"].flatMap(variant => ["key", "reason", "usd", "nano", "femto"].map(field => row[`${variant}_${field}`] ?? null));
    if (next.every((value, index) => value === stored[index])) continue;
    update.run(...next, context.provider, Number(row.row_id));
    markDirty(context, "day", String(row.day));
    changed++;
  }
  return changed;
}

/** The JSON a key row stores for its rates (bigints as strings), so a stored and a fresh choice compare as text. */
const ratesJson = (rates?: LedgerRates) => rates
  ? JSON.stringify(Object.fromEntries(Object.entries(rates).map(([bucket, rate]) => [bucket, typeof rate === "bigint" ? String(rate) : rate]))) : "null";
type ScopeGroup = [model: string | null, speed: string, day: string, eligible: number, vendor: string];
/**
 * The facts a rate card change can revalue (golden rules §3): groups of model, mode, day and admission whose
 * fresh rate key or key rates differ from the stored ones. A price change from a date moves only that model's
 * days after it to a new key; every other fact keeps its key and rates and is not read again. OpenAI rows
 * valued by the Codex rules depend on each call's context size, so their groups stay in scope. A changed
 * mode normalization adds the groups whose stored mode it changes.
 */
function revaluationScope(context: Context): ScopeGroup[] {
  const { db, provider } = context;
  const stored = new Map((db.query("SELECT id,key,rates FROM usage_ledger_keys WHERE provider=?").all(provider) as
    Array<{ id: number; key: string; rates: string }>).map(row => [row.id, row]));
  const groups = db.query(`SELECT model,speed,day,eligible,vendor,std_key,act_key,glb_key,MIN(row_id) row_id
    FROM usage_ledger_facts WHERE provider=? GROUP BY model,speed,day,eligible,vendor,std_key,act_key,glb_key`).all(provider) as
    Array<{ model: string | null; speed: string; day: string; eligible: number; vendor: string; std_key: number | null; act_key: number | null; glb_key: number | null; row_id: number }>;
  const representative = db.query("SELECT * FROM usage_ledger_facts WHERE provider=? AND row_id=?");
  const scope = new Map<string, ScopeGroup>();
  for (const group of groups) {
    const row = representative.get(provider, group.row_id) as Row;
    const fact: ValuedFact = { model: row.model as string | null, ts: String(row.ts), speed: String(row.speed),
      eligible: row.eligible === 1, vendor: String(row.vendor), usage_valid: row.usage_valid === 1,
      quantities: { in_uncached: Number(row.q_uncached), in_cache_read: Number(row.q_cache_read), in_cache_write_5m: Number(row.q_write_5m),
        in_cache_write_1h: Number(row.q_write_1h), in_cache_write_unknown: Number(row.q_write_unknown), out_total: Number(row.q_out) } };
    const fresh = valuationsOf(context, fact);
    const differs = (["std", "act", "glb"] as const).some(variant => {
      const next = fresh[variant], id = group[`${variant}_key`], before = id === null ? null : stored.get(id);
      if (!next || !before) return !!next !== !!before;
      return next.key !== before.key || ratesJson(next.rates) !== before.rates;
    }) || fact.vendor === "openai" || staleSpeed(context, group.speed);
    if (differs) {
      const key: ScopeGroup = [group.model, group.speed, group.day, group.eligible, group.vendor];
      scope.set(JSON.stringify(key), key);
    }
  }
  return [...scope.values()];
}

/**
 * One page of a changed source day: rows whose content hash differs from their fact's get it
 * again; after the day's last page, facts whose row left the day are dropped and the day's revision
 * is recorded as reconciled. That is the revision the day had when it started: a write during its
 * pages makes it differ again, and the next pass reconciles it once more.
 */
function reconcileDay(context: Context, progress: DayProgress, limit: number, clocks: Clocks):
  { rows: number; after: number; done: boolean; retime?: string[] } {
  const { db, provider, adapter } = context, P = sqlProvider(provider);
  const rows = db.query(`SELECT * FROM ${adapter.table} WHERE ${FACT_DAY_PREDICATE} AND id>?2 ORDER BY id LIMIT ?3`)
    .all(progress.day, progress.after, limit) as Row[];
  const stored = db.query(`SELECT src_hash, resp_ms, day FROM usage_ledger_facts WHERE provider=${P} AND row_id=?`);
  const timeOnly = db.query(`UPDATE usage_ledger_facts SET resp_ms=? WHERE provider=${P} AND row_id=?`);
  const retime = new Set(progress.retime ?? []);
  for (const row of rows) {
    const fact = stored.get(Number(row.id)) as { src_hash: string; resp_ms: number | null; day: string } | null;
    if (fact?.src_hash === sourceHash(row)) {
      // Only the response time can differ: the fact keeps its identity, copy state and valuations.
      const time = responseMs(row);
      if (fact.resp_ms !== time) { timeOnly.run(time, Number(row.id)); retime.add(fact.day); clocks.add(); }
      continue;
    }
    dropFacts(context, [Number(row.id)], clocks);
    const identity = putFact(context, row, clocks);
    if (identity) markDirty(context, "identity", identity);
  }
  if (rows.length === limit)
    return { rows: rows.length, after: Number(rows.at(-1)!.id), done: false, ...(retime.size ? { retime: [...retime] } : {}) };
  if (retime.size) retimeDays(context, [...retime].sort());
  // Facts of this source day whose row is gone, or moved to another day (reconciled with that day).
  const gone = (db.query(`SELECT row_id FROM usage_ledger_facts INDEXED BY usage_ledger_facts_src_day_${provider}
    WHERE provider=${P} AND src_day=?1 AND row_id NOT IN (SELECT id FROM ${adapter.table} WHERE ${FACT_DAY_PREDICATE})`)
    .all(progress.day) as Array<{ row_id: number }>).map(fact => fact.row_id);
  dropFacts(context, gone, clocks);
  db.query(`INSERT INTO usage_ledger_source_days(provider,day,revision) VALUES(?,?,?)
    ON CONFLICT(provider,day) DO UPDATE SET revision=excluded.revision`).run(provider, progress.day, progress.revision);
  return { rows: Math.max(rows.length + gone.length, 1), after: progress.after, done: true };
}

function readState(db: Database, provider: string): State | null {
  return db.query("SELECT * FROM usage_ledger_state WHERE provider=?").get(provider) as State | null;
}
/** Every table of a provider's ledger. */
const LEDGER_TABLES = ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_hours", "usage_ledger_day_reasons", "usage_ledger_dirty",
  "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_source_days", "usage_ledger_state", "usage_ledger_mixed_sessions", "usage_activity_intervals"] as const;
/** Discards a provider's ledger: the next step starts its backfill again from the source rows. */
function discard(db: Database, provider: string): void {
  db.transaction(() => {
    for (const table of LEDGER_TABLES) db.query(`DELETE FROM ${table} WHERE provider=?`).run(provider);
  }).immediate();
}

/**
 * One bounded step of a provider's ledger. Callers loop it within their own time slice; a step
 * that reports `complete` found nothing left to do.
 */
export function stepUsageLedger(db: Database, provider: UsageLedgerProvider, card: RateCard, archiveRoot: string,
  limit = 2000): UsageLedgerStep {
  const adapter = subscriptionAccountingAdapter(provider);
  // Without change revisions the ledger could not follow its source after the backfill.
  if (!tableExists(db, adapter.table) || !factDaysTracked(db, adapter.table)) return { complete: true, processed: 0 };
  ensureUsageLedgerSchema(db);
  const digest = subscriptionRulesDigest(card, provider);
  const existing = readState(db, provider);
  if (existing && existing.version !== USAGE_LEDGER_VERSION) {
    discard(db, provider);
    return { complete: false, processed: 1 };
  }
  const context: Context = { db, provider, adapter, card, archiveRoot, codex: null, keys: new Map(), choices: new Map() };
  const sizes = stepSizes.get(db) ?? new Map<string, number>();
  stepSizes.set(db, sizes);
  let taken: { kind: string; size: number; cap: number } | null = null;
  /** How many units a step of this kind takes now (at most `cap`). */
  const take = (kind: string, initial: number, cap = limit) => {
    const size = Math.max(1, Math.min(cap, sizes.get(`${provider}:${kind}`) ?? initial));
    taken = { kind, size, cap };
    return size;
  };
  const started = performance.now();
  const step = db.transaction((): UsageLedgerStep => {
    let state = readState(db, provider);
    if (!state) {
      // The backfill reads the rows as they are now: every day counts as reconciled at its current
      // revision, and only later writes make a day differ.
      db.query(`INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest)
        VALUES(?,?,'backfill','pending',?,'0',?)`).run(provider, USAGE_LEDGER_VERSION, factTableRevision(db, adapter.table), digest);
      db.query("DELETE FROM usage_ledger_source_days WHERE provider=?").run(provider);
      db.query(`INSERT INTO usage_ledger_source_days(provider,day,revision) SELECT ?2,day,revision FROM (${FACT_DAY_REVISIONS_SQL})`)
        .run(adapter.table, provider);
      state = readState(db, provider)!;
    }
    {
      // The provider's indexes stay in place while it is filled: building one afterwards is one statement
      // over the whole table, seconds for a large source, and no step may hold the writer that long. A
      // ledger an older version left without them gets them back here, one per step.
      const indexes = usageLedgerFactIndexes(provider);
      const missing = indexes.names.findIndex(name => !db.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name));
      if (missing >= 0) { db.exec(indexes.create[missing]!); return { complete: false, processed: 1 }; }
    }
    const clocks = new Clocks(adapter.id);
    const save = (fields: Partial<State>) => {
      const next = { ...state!, ...fields };
      db.query(`UPDATE usage_ledger_state SET phase=?,status=?,covered=?,bookmark=?,rules_digest=?,revision=?,published_revision=?,
        activity_published=? WHERE provider=?`).run(next.phase, next.status, next.covered, next.bookmark, next.rules_digest, next.revision,
        next.published_revision, next.activity_published, provider);
      state = next;
    };
    try {
      if (state.phase === "backfill") {
        const size = take("backfill", 250);
        const rows = db.query(`SELECT * FROM ${adapter.table} WHERE id>? ORDER BY id LIMIT ?`).all(Number(state.bookmark), size) as Row[];
        for (const row of rows) putFact(context, row, clocks);
        save({ status: "pending", bookmark: rows.length === size ? String(rows.at(-1)!.id) : "",
          phase: rows.length === size ? "backfill" : "resolve" });
        // The last, short page also moves the ledger to resolution: that is work, not idleness.
        return { complete: false, processed: Math.max(rows.length, 1) };
      }
      if (state.phase === "resolve") {
        // Every identity in identity order, a range per step; the bookmark is the last one resolved (JSON text).
        // A bookmark of another form (an older version's row cursor) starts the resolution again.
        const after = state.bookmark.startsWith('"') ? JSON.parse(state.bookmark) as string : null;
        const size = take("resolve", 250);
        const identities = (db.query(`SELECT DISTINCT identity FROM usage_ledger_facts INDEXED BY usage_ledger_facts_identity_${provider}
          WHERE provider=${sqlProvider(provider)} ${after === null ? "" : "AND identity>?"} ORDER BY identity LIMIT ?`)
          .all(...(after === null ? [size] : [after, size])) as Array<{ identity: string }>).map(row => row.identity);
        if (identities.length) resolveIdentities(context, identities);
        if (identities.length === size) {
          save({ bookmark: JSON.stringify(identities.at(-1)!) });
          return { complete: false, processed: identities.length };
        }
        save({ phase: state.rules_digest === digest ? "reconcile" : "revalue", bookmark: state.rules_digest === digest ? "" : "0" });
        return { complete: false, processed: Math.max(identities.length, 1) };
      }
      // A rate card change revalues once the day being reconciled is done.
      if (state.rules_digest !== digest && state.phase === "reconcile" && state.bookmark === "")
        save({ phase: "revalue", bookmark: "0", status: "pending" });
      if (state.phase === "revalue") {
        // The first step fixes the scope of the change; later steps revalue only its facts, in row order.
        if (!state.bookmark.startsWith("{")) {
          const groups = revaluationScope(context);
          save(groups.length ? { bookmark: JSON.stringify({ after: 0, groups }) } : { phase: "reconcile", bookmark: "", rules_digest: digest });
          return { complete: false, processed: 1 };
        }
        const progress = JSON.parse(state.bookmark) as { after: number; groups: ScopeGroup[] };
        const size = take("revalue", 250);
        // The scope goes to a keyed connection-temporary table first: joined as JSON, every fact read was
        // compared with every group (0.2-0.7 s per page for some 450 groups over 357k facts).
        db.exec(`CREATE TEMP TABLE IF NOT EXISTS revalue_scope(day TEXT, speed TEXT, model TEXT, eligible INTEGER, vendor TEXT);
          CREATE INDEX IF NOT EXISTS temp.revalue_scope_day ON revalue_scope(day, speed); DELETE FROM temp.revalue_scope`);
        db.query(`INSERT INTO temp.revalue_scope SELECT json_extract(value,'$[2]'), json_extract(value,'$[1]'), json_extract(value,'$[0]'),
          json_extract(value,'$[3]'), json_extract(value,'$[4]') FROM json_each(?)`).run(JSON.stringify(progress.groups));
        const rows = db.query(`SELECT f.* FROM usage_ledger_facts f WHERE f.provider=? AND f.row_id>? AND EXISTS (SELECT 1 FROM temp.revalue_scope g
            WHERE g.day=f.day AND g.speed=f.speed AND g.model IS f.model AND g.eligible=f.eligible AND g.vendor=f.vendor)
          ORDER BY f.row_id LIMIT ?`).all(provider, progress.after, size) as Row[];
        revalue(context, rows, clocks);
        save(rows.length === size ? { bookmark: JSON.stringify({ ...progress, after: Number(rows.at(-1)!.row_id) }) }
          : { phase: "reconcile", bookmark: "", rules_digest: digest });
        return { complete: false, processed: Math.max(rows.length, 1), revalued: rows.length };
      }
      // Reconcile: the next changed source day, a page of its rows per step.
      const tableRevision = factTableRevision(db, adapter.table);
      let progress: DayProgress | null = state.bookmark ? JSON.parse(state.bookmark) as DayProgress : null;
      if (!progress && state.covered !== tableRevision) {
        // A ledger with no facts (its source was empty when it was first built, as on a first import) fills
        // from the source rows: the backfill and the identity-range resolution do in one pass what a
        // day-by-day reconciliation would do row by row and identity by identity.
        // Its sums go too (the facts of a source emptied by its last write leave them behind).
        if (!db.query("SELECT 1 FROM usage_ledger_facts WHERE provider=? LIMIT 1").get(provider)) {
          for (const table of LEDGER_TABLES) db.query(`DELETE FROM ${table} WHERE provider=?`).run(provider);
          return { complete: false, processed: 1 };
        }
        const changed = db.query(`SELECT r.day, r.revision ${CHANGED_DAYS_SQL} ORDER BY r.day LIMIT 1`)
          .get(adapter.table, provider) as { day: string; revision: number } | null;
        // Every day reconciled: the ledger covers the table's revision (no writer runs inside this step).
        if (!changed) { save({ covered: tableRevision }); return { complete: false, processed: 1 }; }
        progress = { day: changed.day, revision: changed.revision, after: 0 };
      }
      if (progress) {
        const page = reconcileDay(context, progress, take("reconcile", 250), clocks);
        // Readers see "pending" from the first reconciled page until its days are re-aggregated.
        save({ status: "pending", bookmark: page.done ? "" : JSON.stringify({ ...progress, after: page.after, ...(page.retime ? { retime: page.retime } : {}) }) });
        return { complete: false, processed: page.rows };
      }
      const identities = (db.query("SELECT value FROM usage_ledger_dirty WHERE provider=? AND kind='identity' LIMIT ?")
        .all(provider, take("identity", 250)) as Array<{ value: string }>).map(row => row.value);
      if (identities.length) {
        resolveIdentities(context, identities);
        // Resolution can move an identity's canonical copy or conflict markers: the ledger changed.
        clocks.add();
        db.query("DELETE FROM usage_ledger_dirty WHERE provider=? AND kind='identity' AND value IN (SELECT value FROM json_each(?))")
          .run(provider, JSON.stringify(identities));
        if (state.status === "ready") save({ status: "pending" });
        return { complete: false, processed: identities.length };
      }
      const P = sqlProvider(provider);
      /** Queued values of a kind, as many as fit a budget of calls (the first always): a session or a day of heavy use holds many times another's. */
      const withinCalls = (kind: "session" | "day" | "activity", chunk: number, unit: string, initial: number): string[] => {
        const queued = (db.query("SELECT value FROM usage_ledger_dirty WHERE provider=? AND kind=? ORDER BY value LIMIT ?")
          .all(provider, kind, chunk) as Array<{ value: string }>).map(row => row.value);
        if (!queued.length) return queued;
        const budget = take(unit, initial, Number.MAX_SAFE_INTEGER), list = JSON.stringify(queued);
        const counts = (kind === "session"
          ? db.query(`SELECT f.session value, COUNT(*) n FROM (SELECT value FROM json_each(?)) s CROSS JOIN usage_ledger_facts f
              INDEXED BY usage_ledger_facts_session_${provider} ON f.provider=${P} AND f.session=s.value GROUP BY f.session`)
          : db.query(`SELECT day value, COUNT(*) n FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_${provider}
              WHERE provider=${P} AND day IN (SELECT value FROM json_each(?)) GROUP BY day`)).all(list) as Array<{ value: string; n: number }>;
        const calls = new Map(counts.map(row => [row.value, row.n]));
        const picked: string[] = [];
        let total = 0;
        for (const value of queued) {
          const n = calls.get(value) ?? 0;
          if (picked.length && total + n > budget) break;
          picked.push(value); total += n;
        }
        taken = { kind: unit, size: Math.max(total, 1), cap: Number.MAX_SAFE_INTEGER };
        return picked;
      };
      const done = (kind: "session" | "day" | "activity", values: readonly string[]) =>
        db.query("DELETE FROM usage_ledger_dirty WHERE provider=? AND kind=? AND value IN (SELECT value FROM json_each(?))")
          .run(provider, kind, JSON.stringify(values));
      // Gaps before days, so a rebuilt day sums its calls' current gaps.
      const sessions = withinCalls("session", Math.min(SESSION_CHUNK, limit), "session-calls", 2000);
      if (sessions.length) {
        regapSessions(context, sessions, clocks);
        done("session", sessions);
        // Before the first publication the activity sums vouch for nothing and the token sums do not move.
        if (state.activity_published && state.status === "ready") save({ status: "pending" });
        return { complete: false, processed: sessions.length };
      }
      const days = withinCalls("day", DAY_CHUNK, "day-calls", 2000);
      if (days.length) {
        rebuildDays(context, days);
        done("day", days);
        save({ status: "pending", revision: state.revision + 1 });
        return { complete: false, processed: days.length };
      }
      const activity = withinCalls("activity", Math.min(DAY_CHUNK, limit), "activity-calls", 4000);
      if (activity.length) {
        reactivityDays(context, activity);
        done("activity", activity);
        if (state.activity_published) { clocks.add(); save({ status: "pending", revision: state.revision + 1 }); }
        return { complete: false, processed: activity.length };
      }
      if (state.status !== "ready" || !state.activity_published) {
        // The first publication of the activity sums is a change readers of the ledger clock must see.
        if (!state.activity_published) clocks.add();
        save({ status: "ready", revision: state.revision + 1, published_revision: state.revision + 1, activity_published: 1 });
      }
      return { complete: true, processed: 0 };
    } finally {
      clocks.flush(db);
    }
  }).immediate();
  // The next step of the same kind takes what fits BATCH_MS at this pace, growing at most twofold: the cost
  // of a row or a day varies (a day of heavy use is many times another), so a fast step must not size a slow one.
  const measured = taken as { kind: string; size: number; cap: number } | null;
  if (measured) {
    const elapsed = Math.max(performance.now() - started, 1);
    sizes.set(`${provider}:${measured.kind}`, Math.max(1, Math.min(measured.cap, measured.size * 2, Math.floor(measured.size * BATCH_MS / elapsed))));
  }
  return step;
}

/** Steps a provider's ledger until it is ready, `budgetMs` passes, or a step reports a reason. */
export function advanceUsageLedger(db: Database, provider: UsageLedgerProvider, card: RateCard, archiveRoot: string,
  budget: { limit?: number; steps?: number; budgetMs?: number; stop?: () => boolean } = {}): UsageLedgerStep {
  const end = performance.now() + (budget.budgetMs ?? 250);
  let processed = 0;
  for (let steps = 1; ; steps++) {
    if (budget.stop?.()) return { complete: false, processed };
    const step = stepUsageLedger(db, provider, card, archiveRoot, budget.limit);
    processed += step.processed;
    if (step.complete || step.reason || performance.now() >= end || steps === budget.steps) return { ...step, processed };
  }
}

/**
 * What a provider's ledger still has to do, for the progress register: its phase and the
 * items left in it (source rows, facts or changed source days); null `pending` where a phase
 * has no cheap count. Once every source day is reconciled, queued sessions and activity days are
 * the phase `activity`, so data is never reported current while its active time is prepared.
 * Null before the first step.
 */
export function usageLedgerBacklog(db: Database, provider: UsageLedgerProvider): { phase: State["phase"] | "activity"; pending: number | null } | null {
  if (!tableExists(db, "usage_ledger_state")) return null;
  const state = readState(db, provider);
  if (!state) return null;
  const table = subscriptionAccountingAdapter(provider).table;
  const count = (sql: string, ...params: Array<string | number>) => (db.query(sql).get(...params) as { n: number }).n;
  switch (state.phase) {
    case "backfill": return { phase: state.phase, pending: count(`SELECT count(*) n FROM ${table} WHERE id>?`, Number(state.bookmark) || 0) };
    case "resolve": return { phase: state.phase, pending: state.bookmark.startsWith('"')
      ? count(`SELECT count(*) n FROM usage_ledger_facts INDEXED BY usage_ledger_facts_identity_${provider} WHERE provider=? AND identity>?`, provider, JSON.parse(state.bookmark) as string)
      : count("SELECT count(*) n FROM usage_ledger_facts WHERE provider=?", provider) };
    case "reconcile": {
      const changed = count(`SELECT count(*) n ${CHANGED_DAYS_SQL}`, table, provider);
      const activity = changed ? 0 : count("SELECT count(*) n FROM usage_ledger_dirty WHERE provider=? AND kind IN ('session','activity')", provider);
      return activity ? { phase: "activity", pending: activity } : { phase: state.phase, pending: changed };
    }
    default: return { phase: state.phase, pending: null };
  }
}

/** The state readers check; null before the first step. */
export function usageLedgerState(db: Database, provider: string): Pick<State, "status" | "phase" | "covered" | "rules_digest" | "revision"> | null {
  if (!tableExists(db, "usage_ledger_state")) return null;
  return db.query("SELECT status,phase,covered,rules_digest,revision FROM usage_ledger_state WHERE provider=?").get(provider) as
    Pick<State, "status" | "phase" | "covered" | "rules_digest" | "revision"> | null;
}
