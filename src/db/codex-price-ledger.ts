import { markContextRange } from "./codex-context-read-scope";
import { markWindowUsageRangesDirty } from "./window-usage";
import { publishActivityIntervals } from "./activity-intervals";
import type { LedgerPlace } from "./window-answers";
import type { Database, SQLQueryBindings } from "./sqlite";
import { compileNanoRates, nanoValuationSql, type NanoRateInput } from "./price-ledger-exact";
import { isAccountingDay } from "../server/codex-accounting-pricing";
import { createHash } from "node:crypto";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { codexLedgerBaseChanges } from "./codex-ledger-dependencies";
import { codexLedgerPublished, codexLedgerQueuedBands, codexLedgerQueuedRuleScopes, codexLedgerWorkPending, readCodexLedgerState } from "./codex-ledger-state";
import { ACTIVITY_CUTOFF_MINUTES, activityColumn, ensureUsageLedgerSchema, LONG_CALL_OUT, TIMED_SUMS } from "./usage-ledger";
import { codexProjectSql, currentProjectRules } from "../projects/rules-now";
import { subjectOf } from "../projects/resolve";

export const CODEX_LEDGER_ALGORITHM = "codex-two-base-exact-v1";
export interface LedgerBaseBand {
  id: string; model: string; basis: "chatgpt_credits" | "api_equivalent_usd";
  validFrom: string; validUntil?: string; band: "normal" | "long";
  threshold?: number; rates: NanoRateInput; multiplier: string; evidence: string;
}
export class CodexLedgerNotReady extends Error {}

/**
 * Timed sums of a cohort (migration 0065), as the shared ledger keeps them (usage-ledger.ts `TIMED_SUMS`): calls with a
 * known response time and valid counters, their output tokens and milliseconds, all and those with at least
 * `LONG_CALL_OUT` output tokens. Appended last, as the migration adds them, so positional aggregate inserts line up.
 */
const TIMED_COLUMNS = TIMED_SUMS.map(column => `${column} INTEGER NOT NULL DEFAULT 0`).join(", ");
const timed = "resp_ms>0 AND invalid_tokens=0", long = `${timed} AND output>=${LONG_CALL_OUT}`;
const timedValues = [[timed, "1"], [timed, "output"], [timed, "resp_ms"], [long, "1"], [long, "output"], [long, "resp_ms"]]
  .map(([when, value], index) => `SUM(CASE WHEN ${when} THEN ${value} ELSE 0 END) ${TIMED_SUMS[index]}`).join(",");
/**
 * Stored activity (migration 0067, docs/stored-activity-plan-2026-10-07.md): per day-grain cohort, for each idle cutoff, the
 * sum of min(gap, cutoff) over its canonical calls' positive gaps (integer ms), and the earliest predecessor instant of
 * those gaps. Hour-grain cohorts carry zeros. Appended after the timed sums, as the migration adds them.
 */
const ACTIVITY_COLUMNS = [...ACTIVITY_CUTOFF_MINUTES.map(activityColumn), "gap_from_ms"];
const ACTIVITY_SCHEMA = [...ACTIVITY_CUTOFF_MINUTES.map(minutes => `${activityColumn(minutes)} INTEGER NOT NULL DEFAULT 0`), "gap_from_ms INTEGER"].join(", ");
const counted = "copy_state='canonical' AND gap_ms>0";
const activityExpressions = [...ACTIVITY_CUTOFF_MINUTES.map(minutes => `SUM(CASE WHEN ${counted} THEN MIN(gap_ms,${minutes * 60_000}) ELSE 0 END)`),
  `MIN(CASE WHEN ${counted} THEN gap_from_ms END)`];
const activityValues = (grain: "day" | "hour") => grain === "hour" ? `${ACTIVITY_CUTOFF_MINUTES.map(() => "0").join(",")},NULL` : activityExpressions.join(",");
/** The call metadata a ledger dimension holds besides source and home. */
export const metadataFields = ["model", "service_tier", "speed", "subject", "billing_mode", "surface", "nested", "plan_type", "meter_reset", "repo", "project_id", "project", "cwd"] as const;
/**
 * The metadata a dimension is keyed and stored by (migration 0069): the place of a call, not its project. `subject` and
 * `project_id` of a stored group follow the project rules at read time (`metadataColumns`).
 */
export const dimensionFields = metadataFields.filter(field => field !== "subject" && field !== "project_id");
/**
 * `metadataFields` of the dimension `alias` as SQL, in that order: the stored ones, with `subject` and `project_id` left
 * NULL for `withPlaceProjects` to fill from the project rules (in JavaScript, once per place: the rules as one SQL
 * expression cost about 13 microseconds a row).
 */
export function metadataColumns(alias = "d"): string {
  return metadataFields.map(field => field === "project_id" || field === "subject" ? `NULL ${field}` : `${alias}.${field}`).join(",");
}
/** Rows read with `metadataColumns` (and their dimension's home), their project and subject set by the rules on their pricing day. */
export function withPlaceProjects<T extends { home: unknown; cwd: unknown; project: unknown; repo: unknown; day: unknown;
  project_id: unknown; subject: unknown; source?: unknown; nested?: unknown }>(db: Database, rows: T[]): T[] {
  if (!rows.length) return rows;
  const rules = currentProjectRules(db);
  for (const row of rows) {
    const repo = row.repo as string | null;
    const project = rules.projectOf("events", { store: row.home as string | null, cwd: row.cwd as string | null,
      project: row.project as string | null, repo, source: row.source as string | null, nested: row.nested as string | null }, String(row.day));
    row.project_id = project;
    row.subject = subjectOf(project, repo);
  }
  return rows;
}
const radix = 1_000_000_000;

/** Secondary indexes of the per-call ledger. */
const CODEX_LEDGER_EVENT_INDEXES: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "codex_price_ledger_events_identity", sql: "CREATE INDEX codex_price_ledger_events_identity ON codex_price_ledger_events(identity) WHERE identity IS NOT NULL" },
  { name: "codex_price_ledger_events_time", sql: "CREATE INDEX codex_price_ledger_events_time ON codex_price_ledger_events(instant_ms,copy_id)" },
  { name: "codex_price_ledger_events_day", sql: "CREATE INDEX codex_price_ledger_events_day ON codex_price_ledger_events(day,dim_id)" },
  { name: "codex_price_ledger_events_dim", sql: "CREATE INDEX codex_price_ledger_events_dim ON codex_price_ledger_events(dim_id,day,id)" },
];

/** Per-file evidence beside the copy-free sums, as migration 0061 creates it (see `fileModelsInsert`). */
const CODEX_LEDGER_FILE_MODELS_SQL = `CREATE TABLE codex_price_ledger_file_models(hour INTEGER NOT NULL,dim_id INTEGER NOT NULL,day TEXT NOT NULL,
      copy_id INTEGER NOT NULL,first_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,PRIMARY KEY(hour,dim_id,day,copy_id)) STRICT;
    CREATE INDEX codex_price_ledger_file_models_day ON codex_price_ledger_file_models(day,dim_id);`;
/**
 * The ledger tables, as migrations 0053, 0054 and 0061 create them; for fixtures and disposable databases. The state
 * and queue live in the shared ledger tables (codex-ledger-state.ts), which `createCodexLedgerSchema` also creates.
 */
export const CODEX_PRICE_LEDGER_SCHEMA_SQL = `
    CREATE TABLE codex_price_ledger_copies(id INTEGER PRIMARY KEY,identity TEXT NOT NULL UNIQUE,
      locator TEXT NOT NULL UNIQUE,home TEXT,path TEXT,source TEXT,relative_path TEXT,conversation TEXT) STRICT;
    CREATE INDEX codex_price_ledger_copies_conversation ON codex_price_ledger_copies(conversation);
    CREATE INDEX codex_price_ledger_copies_home_path ON codex_price_ledger_copies(home,path);
    CREATE TABLE codex_price_ledger_dims(id INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE,
      source TEXT,home TEXT,model TEXT,service_tier TEXT,speed TEXT,subject TEXT,billing_mode TEXT,
      surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER,repo TEXT,project_id ANY,project TEXT,cwd TEXT) STRICT;
    CREATE INDEX codex_price_ledger_dims_model ON codex_price_ledger_dims(model,id);
    CREATE TABLE codex_price_ledger_bands(id INTEGER PRIMARY KEY,rule_id TEXT NOT NULL,band TEXT NOT NULL,
      basis TEXT NOT NULL,denominator INTEGER NOT NULL,evidence TEXT NOT NULL,dependency_revision TEXT NOT NULL,band_json TEXT NOT NULL,
      UNIQUE(rule_id,band,dependency_revision)) STRICT;
    CREATE TABLE codex_price_ledger_events(id INTEGER PRIMARY KEY,copy_id INTEGER NOT NULL,source_offset INTEGER NOT NULL,
      dim_id INTEGER NOT NULL,ts TEXT NOT NULL,day TEXT NOT NULL,instant_ms INTEGER,admitted INTEGER NOT NULL,
      in_tok ANY,cached_in ANY,cache_write ANY,out_tok ANY,reasoning_out ANY,
      usage_status TEXT,cache_write_status TEXT,reported INTEGER NOT NULL,uncached INTEGER NOT NULL,
      cached INTEGER NOT NULL,writes INTEGER NOT NULL,output INTEGER NOT NULL,reasoning INTEGER NOT NULL,
      window_input INTEGER NOT NULL,window_cached INTEGER NOT NULL,window_output INTEGER NOT NULL,
      invalid_tokens INTEGER NOT NULL,common_reason TEXT,
      api_band INTEGER NOT NULL DEFAULT 0,api_reason TEXT,api_whole INTEGER,api_fraction_hi INTEGER,api_fraction_lo INTEGER,
      credit_band INTEGER NOT NULL DEFAULT 0,credit_reason TEXT,credit_whole INTEGER,credit_fraction_hi INTEGER,credit_fraction_lo INTEGER,
      identity TEXT,copy_state TEXT NOT NULL DEFAULT 'pending' CHECK(copy_state IN ('pending','canonical','duplicate','conflict')), resp_ms INTEGER,
      gap_ms INTEGER, gap_from_ms INTEGER,
      UNIQUE(copy_id,source_offset)) STRICT;
    ${CODEX_LEDGER_EVENT_INDEXES.map(index => `${index.sql};`).join("\n    ")}
    CREATE TABLE codex_price_ledger_aggregates(grain TEXT NOT NULL,day TEXT NOT NULL,hour INTEGER NOT NULL,dim_id INTEGER NOT NULL,
      api_band INTEGER NOT NULL,credit_band INTEGER NOT NULL,api_reason TEXT NOT NULL,credit_reason TEXT NOT NULL,
      api_zero INTEGER NOT NULL,credit_zero INTEGER NOT NULL,copy_state TEXT NOT NULL,calls INTEGER NOT NULL,first_ts TEXT NOT NULL,last_ts TEXT NOT NULL,
      reported INTEGER NOT NULL,uncached INTEGER NOT NULL,cached INTEGER NOT NULL,writes INTEGER NOT NULL,
      output INTEGER NOT NULL,reasoning INTEGER NOT NULL,window_input INTEGER NOT NULL,window_cached INTEGER NOT NULL,
      window_output INTEGER NOT NULL,invalid_tokens INTEGER NOT NULL,
      api_whole_hi INTEGER,api_whole_lo INTEGER,api_fraction_hi INTEGER,api_fraction_lo INTEGER,
      credit_whole_hi INTEGER,credit_whole_lo INTEGER,credit_fraction_hi INTEGER,credit_fraction_lo INTEGER, ${TIMED_COLUMNS}, ${ACTIVITY_SCHEMA},
      PRIMARY KEY(grain,day,hour,dim_id,api_band,credit_band,api_reason,credit_reason,api_zero,credit_zero,copy_state)) STRICT;
    CREATE INDEX codex_price_ledger_aggregates_day ON codex_price_ledger_aggregates(grain,day,dim_id);
    ${CODEX_LEDGER_FILE_MODELS_SQL}
  `;
/** The replayed calls of a fork file, by offset: what codexReadingEvidenceSql looks up per reading. */
export const CODEX_LEDGER_REPLAYS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS codex_price_ledger_events_replays
  ON codex_price_ledger_events(copy_id,source_offset) WHERE identity LIKE 'c:%'`;
export function createCodexLedgerSchema(db: Database): void {
  db.transaction(() => { db.exec(CODEX_PRICE_LEDGER_SCHEMA_SQL); db.exec(CODEX_LEDGER_REPLAYS_INDEX_SQL); }).immediate();
  ensureUsageLedgerSchema(db);
}

const zeroAmount = (prefix: string) => `CASE WHEN ${prefix}_reason IS NULL AND ${prefix}_whole=0 AND ${prefix}_fraction_hi=0 AND ${prefix}_fraction_lo=0 THEN 1 ELSE 0 END`;
const groupKeys = `day,dim_id,api_band,credit_band,COALESCE(api_reason,'') api_reason,COALESCE(credit_reason,'') credit_reason,
  ${zeroAmount("api")} api_zero,${zeroAmount("credit")} credit_zero,copy_state`;
const quantities = ["reported", "uncached", "cached", "writes", "output", "reasoning", "window_input", "window_cached", "window_output", "invalid_tokens"];
const baseValues = `COUNT(*) calls,MIN(ts) first_ts,MAX(ts) last_ts,${quantities.map(field => `SUM(${field}) ${field}`).join(",")},
  ${["api", "credit"].flatMap(prefix => [`SUM(${prefix}_whole/${radix}) ${prefix}_whole_hi`,
    `SUM(${prefix}_whole%${radix}) ${prefix}_whole_lo`, `SUM(${prefix}_fraction_hi) ${prefix}_fraction_hi`,
    `SUM(${prefix}_fraction_lo) ${prefix}_fraction_lo`]).join(",")},${timedValues}`;
/** What a stored cohort row holds, in its column order: the base sums and the activity sums. */
const aggregateValues = (grain: "day" | "hour") => `${baseValues},${activityValues(grain)}`;

/**
 * Which physical rollout files a dimension's calls came from, per calendar hour, with their first and last
 * instants: the Spark/main evidence of a file (and meter reset) that the copy-free sums do not carry. Published
 * with the sums from the same calls, so a read of the evidence is an indexed range of a few thousand rows.
 */
const fileModelsInsert = (filter: string, indexed = "") => `INSERT INTO codex_price_ledger_file_models(hour,dim_id,day,copy_id,first_ms,last_ms)
  SELECT CAST(floor(instant_ms/3600000.0) AS INTEGER) hour,dim_id,day,copy_id,MIN(instant_ms),MAX(instant_ms)
  FROM codex_price_ledger_events${indexed} WHERE admitted=1 AND copy_state<>'pending' AND instant_ms IS NOT NULL${filter}
  GROUP BY hour,dim_id,day,copy_id`;

const HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
/** The archive sources a ledger change touched (Codex records no session identity). */
function ledgerPlaces(db: Database, sql: string, ...params: string[]): LedgerPlace[] {
  return (db.query(sql).all(...params) as Array<{ source: string | null }>).map(row => ({ source: row.source, identity: null }));
}

export interface LedgerAggregatePartition { day: string; dimId: number; hour: number | null }
/**
 * Recompute only the changed old/new day and hour partitions, including their joint cohorts. Used for revaluation:
 * prices move, a call's file, dimension, admission and copy state do not (those are published by day), so the per-file
 * rows stay as they are.
 */
export function rebuildCodexLedgerPartitions(db: Database, partitions: readonly LedgerAggregatePartition[]): number {
  if (!db.inTransaction) throw new Error("Ledger partition publication requires the producer transaction");
  const unique = new Map(partitions.map(partition => [JSON.stringify(partition), partition]));
  // Window sums follow the exact instants of the changed hour partitions (every timed event has one); the stored window
  // answers only of the accounts owning the partitions' sources.
  markWindowUsageRangesDirty(db, "codex", [...unique.values()].flatMap(({ hour }) => hour === null ? [] : [[hour * HOUR_MS, (hour + 1) * HOUR_MS] as const]),
    ledgerPlaces(db, `SELECT DISTINCT source FROM codex_price_ledger_dims WHERE id IN (SELECT value FROM json_each(?))`,
      JSON.stringify([...new Set([...unique.values()].map(partition => partition.dimId))])));
  for (const { day, dimId, hour } of unique.values()) {
    const grain = hour === null ? "day" : "hour", keyHour = hour ?? -1;
    db.query("DELETE FROM codex_price_ledger_aggregates WHERE grain=? AND day=? AND dim_id=? AND hour=?").run(grain, day, dimId, keyHour);
    const filter = hour === null ? "" : " AND instant_ms>=? AND instant_ms<?";
    const params: (string | number)[] = [grain, keyHour, day, dimId];
    if (hour !== null) params.push(hour * 3600000, (hour + 1) * 3600000);
    db.query(`INSERT INTO codex_price_ledger_aggregates SELECT ?,day,? hour,dim_id,api_band,credit_band,
      COALESCE(api_reason,''),COALESCE(credit_reason,''),${zeroAmount("api")},${zeroAmount("credit")},copy_state,${aggregateValues(grain)}
      FROM codex_price_ledger_events WHERE admitted=1 AND copy_state<>'pending' AND day=? AND dim_id=?${filter}
      GROUP BY day,dim_id,api_band,credit_band,COALESCE(api_reason,''),COALESCE(credit_reason,''),${zeroAmount("api")},${zeroAmount("credit")},copy_state`)
      .run(...params);
  }
  return unique.size;
}
/** Both grains of one pricing day from its canonical events; the unit of work after copy resolution. */
export function rebuildCodexLedgerDay(db: Database, day: string): number {
  if (!db.inTransaction) throw new Error("Ledger day publication requires the producer transaction");
  db.query("DELETE FROM codex_price_ledger_aggregates WHERE day=?").run(day);
  db.query("DELETE FROM codex_price_ledger_file_models WHERE day=?").run(day);
  // The rebuilt cohorts carry the current activity sums too.
  db.query("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind='activity' AND value=?").run(day);
  db.query(fileModelsInsert(" AND day=?", " INDEXED BY codex_price_ledger_events_day")).run(day);
  // A pricing day is the timestamp's own calendar day; with an offset its instants reach the adjacent UTC days. The
  // day's sources before (its published sums) and after (its events) say whose stored window answers it touches.
  markWindowUsageRangesDirty(db, "codex", [[Date.parse(day) - DAY_MS, Date.parse(day) + 2 * DAY_MS]],
    ledgerPlaces(db, `SELECT DISTINCT d.source FROM codex_price_ledger_dims d WHERE d.id IN (
      SELECT dim_id FROM codex_price_ledger_aggregates WHERE grain='day' AND day=?1 UNION SELECT dim_id FROM codex_price_ledger_events WHERE day=?1)`, day));
  let partitions = 0;
  for (const grain of ["day", "hour"] as const) {
    const hour = grain === "day" ? "-1" : "CAST(floor(instant_ms/3600000.0) AS INTEGER)";
    const timeGuard = grain === "hour" ? " AND instant_ms IS NOT NULL" : "";
    partitions += db.query(`INSERT INTO codex_price_ledger_aggregates SELECT '${grain}',day,${hour} hour,dim_id,api_band,credit_band,
      COALESCE(api_reason,''),COALESCE(credit_reason,''),${zeroAmount("api")},${zeroAmount("credit")},copy_state,${aggregateValues(grain)}
      FROM codex_price_ledger_events INDEXED BY codex_price_ledger_events_day WHERE day=? AND admitted=1 AND copy_state<>'pending'${timeGuard}
      GROUP BY day,hour,dim_id,api_band,credit_band,COALESCE(api_reason,''),COALESCE(credit_reason,''),${zeroAmount("api")},${zeroAmount("credit")},copy_state`).run(day).changes;
  }
  publishActivityIntervals(db, "codex", [day]);
  return partitions;
}

/**
 * Only the timed sums of some pricing days, after calls of theirs changed nothing but their response time: their
 * cohorts, amounts, per-file rows and window sums stay as they are (no window usage is marked). The cohorts are those
 * `rebuildCodexLedgerDay` wrote from the same calls, so the values equal a rebuild's.
 */
export function retimeCodexLedgerDays(db: Database, days: readonly string[]): void {
  if (!db.inTransaction) throw new Error("Ledger day publication requires the producer transaction");
  const keys = `day,hour,dim_id,api_band,credit_band,api_reason,credit_reason,api_zero,credit_zero,copy_state`;
  for (const day of days) {
    db.query(`UPDATE codex_price_ledger_aggregates SET ${TIMED_SUMS.map(column => `${column}=0`).join(",")} WHERE day=?`).run(day);
    for (const grain of ["day", "hour"] as const) {
      const hour = grain === "day" ? "-1" : "CAST(floor(instant_ms/3600000.0) AS INTEGER)";
      const timeGuard = grain === "hour" ? " AND instant_ms IS NOT NULL" : "";
      db.query(`UPDATE codex_price_ledger_aggregates AS a SET ${TIMED_SUMS.map(column => `${column}=t.${column}`).join(",")}
        FROM (SELECT day,${hour} hour,dim_id,api_band,credit_band,COALESCE(api_reason,'') api_reason,COALESCE(credit_reason,'') credit_reason,
            ${zeroAmount("api")} api_zero,${zeroAmount("credit")} credit_zero,copy_state,${timedValues}
          FROM codex_price_ledger_events INDEXED BY codex_price_ledger_events_day WHERE day=? AND admitted=1 AND copy_state<>'pending'${timeGuard}
          GROUP BY ${keys}) t
        WHERE a.grain='${grain}' AND (${keys.split(",").map(key => `a.${key}`).join(",")})=(${keys.split(",").map(key => `t.${key}`).join(",")})`).run(day);
    }
  }
}

/**
 * Only the activity sums of some pricing days' day-grain cohorts, after gaps of their calls changed and nothing else:
 * cohorts, amounts, per-file rows and window sums stay as they are. The values are those `rebuildCodexLedgerDay` writes.
 */
export function reactivityCodexLedgerDays(db: Database, days: readonly string[]): void {
  if (!db.inTransaction) throw new Error("Ledger day publication requires the producer transaction");
  publishActivityIntervals(db, "codex", days);
  const keys = "day,dim_id,api_band,credit_band,api_reason,credit_reason,api_zero,credit_zero,copy_state";
  for (const day of days) {
    db.query(`UPDATE codex_price_ledger_aggregates SET ${ACTIVITY_COLUMNS.map(column => `${column}=${column === "gap_from_ms" ? "NULL" : "0"}`).join(",")}
      WHERE grain='day' AND day=?`).run(day);
    db.query(`UPDATE codex_price_ledger_aggregates AS a SET ${ACTIVITY_COLUMNS.map((column, index) => `${column}=t.a${index}`).join(",")}
      FROM (SELECT day,dim_id,api_band,credit_band,COALESCE(api_reason,'') api_reason,COALESCE(credit_reason,'') credit_reason,
          ${zeroAmount("api")} api_zero,${zeroAmount("credit")} credit_zero,copy_state,
          ${activityExpressions.map((value, index) => `${value} a${index}`).join(",")}
        FROM codex_price_ledger_events INDEXED BY codex_price_ledger_events_day WHERE day=? AND admitted=1 AND copy_state='canonical'
        GROUP BY ${keys}) t
      WHERE a.grain='day' AND (${keys.split(",").map(key => `a.${key}`).join(",")})=(${keys.split(",").map(key => `t.${key}`).join(",")})`).run(day);
  }
}

/**
 * Recomputes the activity gaps of some copies (D2). A chain is one physical copy and its billing (business credits or
 * not); its canonical admitted calls with an instant, in (instant, offset) order, each get the distance to the previous
 * one (`gap_ms`, zero for the same instant) and that call's instant (`gap_from_ms`); every other call gets none. Set-based
 * (window LAG over the copies' calls); writes only changed gaps and returns the pricing days of the calls it changed.
 */
export function regapCodexLedgerCopies(db: Database, copyIds: readonly number[]): Set<string> {
  if (!db.inTransaction) throw new Error("Ledger gap publication requires the producer transaction");
  const days = new Set<string>();
  if (!copyIds.length) return days;
  const chained = "l.copy_state='canonical' AND l.admitted=1 AND l.instant_ms IS NOT NULL";
  for (const row of db.query(`UPDATE codex_price_ledger_events AS e SET gap_ms=g.gap_ms, gap_from_ms=g.gap_from_ms
    FROM (SELECT l.id, CASE WHEN ${chained} THEN l.instant_ms-LAG(l.instant_ms) OVER chain END gap_ms,
        CASE WHEN ${chained} THEN LAG(l.instant_ms) OVER chain END gap_from_ms
      FROM (SELECT value id FROM json_each(?)) c CROSS JOIN codex_price_ledger_events l ON l.copy_id=c.id
        JOIN codex_price_ledger_dims d ON d.id=l.dim_id
      WINDOW chain AS (PARTITION BY l.copy_id, ${chained}, d.billing_mode IS 'business_credits' ORDER BY l.instant_ms, l.source_offset)) g
    WHERE e.id=g.id AND (e.gap_ms IS NOT g.gap_ms OR e.gap_from_ms IS NOT g.gap_from_ms) RETURNING day`).all(JSON.stringify(copyIds)) as { day: string }[])
    days.add(row.day);
  return days;
}

/** Set-based base valuation; metadata/tier edits do not call this for unchanged bases. */
export function codexLedgerBandRevision(band: LedgerBaseBand): string {
  const coefficients = compileNanoRates(band.rates, band.multiplier);
  return createHash("sha256").update(JSON.stringify([CODEX_LEDGER_ALGORITHM,band.model,band.basis,band.validFrom,
    band.validUntil ?? null,band.band,band.threshold ?? null,coefficients], (_, value) => typeof value === "bigint" ? value.toString() : value)).digest("hex");
}
export type PublishedCodexLedgerBand = LedgerBaseBand & { coefficients: ReturnType<typeof compileNanoRates> };
export function serializeCodexLedgerBand(band: LedgerBaseBand): string {
  const { id, model, basis, validFrom, validUntil, band: kind, threshold, rates, multiplier, evidence } = band;
  return JSON.stringify({ id, model, basis, validFrom, validUntil, band: kind, threshold, rates, multiplier, evidence });
}
interface PublishedBandRow { id: number; rule_id: string; band: string; basis: string; denominator: string; dependency_revision: string; band_json: string }
const publishedBands = new WeakMap<Database, Map<number, { json: string; revision: string; band: PublishedCodexLedgerBand }>>();
function decodePublishedBand(db: Database, row: PublishedBandRow): PublishedCodexLedgerBand {
  let cache = publishedBands.get(db);
  if (!cache) { cache = new Map(); publishedBands.set(db, cache); }
  const previous = cache.get(row.id);
  if (previous?.json === row.band_json && previous.revision === row.dependency_revision
    && previous.band.id === row.rule_id && previous.band.band === row.band && previous.band.basis === row.basis
    && previous.band.coefficients.denominator === BigInt(row.denominator)) return previous.band;
  const snapshot = JSON.parse(row.band_json) as LedgerBaseBand;
  const coefficients = compileNanoRates(snapshot.rates, snapshot.multiplier);
  if (snapshot.id !== row.rule_id || snapshot.band !== row.band || snapshot.basis !== row.basis
    || coefficients.denominator !== BigInt(row.denominator) || codexLedgerBandRevision(snapshot) !== row.dependency_revision) {
    throw new Error("Published coefficient snapshot contradicts its exact valuation band");
  }
  const band = { ...snapshot, coefficients };
  cache.set(row.id, { json: row.band_json, revision: row.dependency_revision, band });
  return band;
}
/** Breakdown readers use the coefficient that produced the stored base, independent of later declaration IDs. */
export function readCodexLedgerPublishedBand(db: Database, id: number): PublishedCodexLedgerBand | null {
  const row = db.query("SELECT id,rule_id,band,basis,CAST(denominator AS TEXT) denominator,dependency_revision,band_json FROM codex_price_ledger_bands WHERE id=?")
    .get(id) as PublishedBandRow | null;
  return row ? decodePublishedBand(db, row) : null;
}
export function readCodexLedgerPublishedBands(db: Database): Map<number, PublishedCodexLedgerBand> {
  const rows = db.query("SELECT id,rule_id,band,basis,CAST(denominator AS TEXT) denominator,dependency_revision,band_json FROM codex_price_ledger_bands")
    .all() as PublishedBandRow[];
  return new Map(rows.map(row => [row.id, decodePublishedBand(db, row)]));
}
export function persistCodexLedgerBand(db: Database, band: LedgerBaseBand): number {
  if (!db.inTransaction) throw new Error("Coefficient publication requires the producer transaction");
  const compiled = compileNanoRates(band.rates, band.multiplier);
  const rule = db.query("INSERT INTO codex_price_ledger_bands(rule_id,band,basis,denominator,evidence,dependency_revision,band_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(rule_id,band,dependency_revision) DO UPDATE SET dependency_revision=codex_price_ledger_bands.dependency_revision RETURNING id")
    .get(band.id, band.band, band.basis, compiled.denominator, band.evidence, codexLedgerBandRevision(band), serializeCodexLedgerBand(band)) as { id: number };
  return rule.id;
}
/** Tables a band values: the ledger, or the staging table of calls a copy write prepares (codex-ledger-copies.ts). */
export type CodexLedgerValuedTable = "codex_price_ledger_events" | "temp.codex_ledger_incoming";
/**
 * Values the calls a band covers: the given rows (by rowid), else every row of the table. A copy
 * write values its calls in its staging table before they reach the ledger, so a ledger row is
 * written once with its values instead of growing in place.
 */
export function valueCodexLedgerBand(db: Database, band: LedgerBaseBand, rowIds?: readonly number[],
  table: CodexLedgerValuedTable = "codex_price_ledger_events"): number {
  if (!db.inTransaction) throw new Error("Base valuation publication requires the producer transaction");
  const compiled = compileNanoRates(band.rates, band.multiplier), prefix = band.basis === "chatgpt_credits" ? "credit" : "api";
  if (rowIds && !rowIds.length) return 0;
  const rule = { id: persistCodexLedgerBand(db, band) };
  const filters = ["d.model=?", "e.day>=?", "e.common_reason IS NULL"];
  const params: (string | number | bigint)[] = [band.model, band.validFrom];
  if (band.validUntil) { filters.push("e.day<?"); params.push(band.validUntil); }
  if (band.threshold !== undefined) { filters.push(`e.in_tok${band.band === "long" ? ">" : "<="}?`); params.push(band.threshold); }
  // Selected rows drive the plan (CROSS JOIN keeps them outermost): a valuation costs what it
  // values, not the size of the ledger, also while a fill has its indexes dropped.
  const target = rowIds ? { sql: "rowid IN (SELECT value FROM json_each(?))", param: JSON.stringify(rowIds) } : null;
  if (target) { filters.push(`e.${target.sql}`); params.push(target.param); }
  const join = target ? "CROSS JOIN" : "JOIN";
  if (prefix === "credit") filters.push("e.cache_write=0");
  else if (band.rates.in_cache_write == null) {
    db.query(`WITH missing AS (SELECT e.rowid id FROM ${table} e
      ${join} codex_price_ledger_dims d ON d.id=e.dim_id WHERE ${filters.join(" AND ")} AND e.cache_write>0)
      UPDATE ${table} SET api_reason='missing_cache_write_rate' WHERE rowid IN (SELECT id FROM missing)`).run(...params);
    filters.push("e.cache_write=0");
  }
  // Values land in a keyed scratch table first: an UPDATE joined to the unkeyed result would
  // search it once per updated row. The table is created once per connection, so no schema change.
  db.exec("CREATE TEMP TABLE IF NOT EXISTS codex_ledger_valued(id INTEGER PRIMARY KEY,whole INTEGER,fraction_hi INTEGER,fraction_lo INTEGER)");
  db.exec("DELETE FROM temp.codex_ledger_valued");
  db.query(`WITH input AS (SELECT e.rowid id,e.in_tok-e.cached_in-e.cache_write in_uncached,e.cached_in in_cache_read,
    e.cache_write in_cache_write,e.out_tok out_total FROM ${table} e
    ${join} codex_price_ledger_dims d ON d.id=e.dim_id WHERE ${filters.join(" AND ")})
    INSERT INTO temp.codex_ledger_valued(id,whole,fraction_hi,fraction_lo) ${nanoValuationSql("input", compiled, ["id"])}`).run(...params);
  const result = db.query(`UPDATE ${table} AS e SET ${prefix}_band=?,${prefix}_reason=NULL,
      ${prefix}_whole=v.whole,${prefix}_fraction_hi=v.fraction_hi,${prefix}_fraction_lo=v.fraction_lo
      FROM temp.codex_ledger_valued v WHERE e.rowid=v.id`).run(rule.id);
  db.exec("DELETE FROM temp.codex_ledger_valued");
  const invalid = db.query(`SELECT COUNT(*) n FROM ${table} WHERE ${target ? `${target.sql} AND ` : ""}${prefix}_band=?
    AND (${prefix}_whole IS NULL OR ${prefix}_fraction_hi IS NULL OR ${prefix}_fraction_lo IS NULL)`).get(...(target ? [target.param] : []), rule.id) as { n: number };
  if (invalid.n) throw new Error("Unrepresentable exact base; ledger publication rejected");
  return result.changes;
}

/** UTC bounds also depend on adjacent quoted pricing days (source offsets are retained). */
export function codexLedgerQuotedDayRange(range: LedgerRange = {}): { since?: string; until?: string } {
  const day = (value: number) => new Date(value).toISOString().slice(0, 10);
  const since = range.fromMs === undefined ? range.since : day(range.fromMs - 86400000);
  const until = range.toMs === undefined ? range.until : day(range.toMs - (range.endInclusive ? 0 : 1) + 86400000);
  return { since: range.since && (!since || range.since > since) ? range.since : since,
    until: range.until && (!until || range.until < until) ? range.until : until };
}
export interface CodexLedgerDependencyScope {
  model?: string | null; basis: LedgerBaseBand["basis"]; fromDay: string; untilDay: string | null;
  inputAbove: number | null; inputUntil: number | null;
  rawTier?: string | null;
}
/** Probe only a changed date/model/context dependency; never replay or value source events. */
export function codexLedgerScopeIntersects(db: Database, scope: CodexLedgerDependencyScope, range: LedgerRange = {}): boolean {
  if (scope.model !== undefined && range.dependencyModels && !range.dependencyModels.includes(scope.model)
    || range.dependencyBases && !range.dependencyBases.includes(scope.basis)) return false;
  const bounds = codexLedgerQuotedDayRange(range);
  if (bounds.until && scope.fromDay > bounds.until || bounds.since && scope.untilDay && scope.untilDay <= bounds.since) return false;
  const fromDay = bounds.since && bounds.since > scope.fromDay ? bounds.since : scope.fromDay;
  const boundedUntil = bounds.until && bounds.until !== "9999-12-31" ? new Date(Date.parse(bounds.until) + 86400000).toISOString().slice(0,10) : null;
  const untilDay = scope.untilDay && (!boundedUntil || scope.untilDay < boundedUntil) ? scope.untilDay : boundedUntil;
  const p = predicate(range, "e"), terms = [p.sql, "e.day>=?"], params: (string | number | null)[] = [...p.params, fromDay];
  if (scope.model !== undefined) { terms.push("d.model IS ?"); params.push(scope.model); }
  else if (range.dependencyModels) {
    const names = range.dependencyModels.filter((model): model is string => model !== null);
    terms.push(`(${names.length ? `d.model IN (${names.map(()=>"?").join(",")})` : "0"}${range.dependencyModels.includes(null) ? " OR d.model IS NULL" : ""})`);
    params.push(...names);
  }
  if (scope.rawTier !== undefined) { terms.push("d.service_tier IS ?"); params.push(scope.rawTier); }
  if (untilDay) { terms.push("e.day<?"); params.push(untilDay); }
  if (scope.inputAbove !== null) { terms.push("e.in_tok>?"); params.push(scope.inputAbove); }
  if (scope.inputUntil !== null) { terms.push("e.in_tok<=?"); params.push(scope.inputUntil); }
  const from = bounds.since || bounds.until
    ? "codex_price_ledger_events e INDEXED BY codex_price_ledger_events_day CROSS JOIN codex_price_ledger_dims d ON d.id=e.dim_id"
    : scope.model === undefined
      ? "codex_price_ledger_dims d CROSS JOIN codex_price_ledger_events e INDEXED BY codex_price_ledger_events_dim ON e.dim_id=d.id"
      : "codex_price_ledger_dims d INDEXED BY codex_price_ledger_dims_model JOIN codex_price_ledger_events e INDEXED BY codex_price_ledger_events_dim ON e.dim_id=d.id";
  return !!db.query(`SELECT 1 FROM ${from} WHERE ${terms.join(" AND ")} LIMIT 1`).get(...params);
}
/**
 * Price-rule work of a published ledger that reaches the range: a price change re-values its own
 * scope, and that scope answers "preparing" until it is done. New or corrected facts are not here:
 * a published ledger stays readable while they are processed (read-freshness.ts).
 */
export function codexLedgerHasPendingWork(db: Database, range?: LedgerRange): boolean {
  // A fill from empty has no proved bounds until it ends.
  if (readCodexLedgerState(db)?.phase === "backfill") return true;
  const work: CodexLedgerDependencyScope[] = codexLedgerQueuedRuleScopes(db);
  if (!range) return work.length > 0;
  if (work.some(scope => !scope.model || !isAccountingDay(scope.fromDay)
    || scope.untilDay !== null && (!isAccountingDay(scope.untilDay) || scope.untilDay <= scope.fromDay)
    || !["api_equivalent_usd", "chatgpt_credits"].includes(scope.basis)
    || [scope.inputAbove, scope.inputUntil].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))
    || scope.inputAbove !== null && scope.inputUntil !== null && scope.inputAbove >= scope.inputUntil)) return true;
  return work.some(scope => codexLedgerScopeIntersects(db, scope, range));
}
/**
 * The ledger's committed sums are readable: published once under this algorithm and no price change
 * pending in the range. Copies and days still being processed leave the last published rows readable.
 * A rule change is published when its last queued scope is revalued; until then a range its changes
 * reach is not readable, even where its own scope is done, because the published rules are the old ones.
 */
export function requireCodexLedgerReady(db: Database, range?: LedgerRange): void {
  if (!codexLedgerPublished(db)) throw new CodexLedgerNotReady("Codex price ledger is not published");
  if (codexLedgerHasPendingWork(db, range)) throw new CodexLedgerNotReady("Codex price ledger has pending price dependencies");
  if (range && codexLedgerWorkPending(db, ["rules"])) {
    const published = readCodexLedgerState(db)!.rules_json;
    if (!published) throw new CodexLedgerNotReady("Codex price ledger has no published policy proof");
    if (codexLedgerBaseChanges(compileCodexLedgerPolicy(JSON.parse(published)).baseBands, codexLedgerQueuedBands(db))
      .some(scope => codexLedgerScopeIntersects(db, scope, range))) throw new CodexLedgerNotReady("Codex price ledger has unpublished policy dependencies");
  }
}

export interface LedgerRange {
  since?: string; until?: string; fromMs?: number; toMs?: number; startInclusive?: boolean; endInclusive?: boolean;
  instantValidity?: "invalid" | "valid"; grain?: "day" | "hour";
  /** Events of these physical files only (event-level read; a legacy reader's file admission). */
  copyPaths?: readonly string[];
  /** Calls of dimensions with these stored sources only (a reader that needs one account's sources). */
  sources?: readonly string[];
  /** Actual model selection, distinct from valuation dependencies. */
  models?: readonly (string | null)[];
  /** Valuation dependencies only. */
  dependencyModels?: readonly (string | null)[]; dependencyBases?: readonly LedgerBaseBand["basis"][];
  /** Model-only diagnostics do not depend on project attribution. Other readers retain it by default. */
  dependencyProjects?: false;
}
export interface LedgerStoredGroup {
  hour?: number | null;
  day: string; dim_id: number; home: string | null; source: string | null;
  model: string | null; service_tier: string | null; speed: string | null; subject: string | null; billing_mode: string | null;
  surface: string | null; nested: string | null; plan_type: string | null; meter_reset: number | null;
  repo: string | null; project_id: string | number | null; project: string | null; cwd: string | null;
  api_band: number; credit_band: number; api_reason: string; credit_reason: string; api_zero: number; credit_zero: number;
  /** Resolved at build time (codex-ledger-canonical.ts); only `canonical` cohorts count as usage. */
  copy_state: "canonical" | "duplicate" | "conflict";
  calls: string; first_ts: string; last_ts: string; reported: string; uncached: string; cached: string; writes: string;
  output: string; reasoning: string; window_input: string; window_cached: string; window_output: string; invalid_tokens: string;
  api_whole_hi: string | null; api_whole_lo: string | null; api_fraction_hi: string | null; api_fraction_lo: string | null;
  credit_whole_hi: string | null; credit_whole_lo: string | null; credit_fraction_hi: string | null; credit_fraction_lo: string | null;
  /** Timed sums (usage-ledger.ts `TIMED_SUMS`) as exact integer text. */
  timed_calls: string; timed_out: string; timed_ms: string; timed_long_calls: string; timed_long_out: string; timed_long_ms: string;
}
function predicate(range: LedgerRange, alias: string) {
  const terms: string[] = [], params: (string | number)[] = [];
  if (range.models !== undefined) {
    const names = range.models.filter((model): model is string => model !== null);
    terms.push(`${alias}.dim_id IN (SELECT id FROM codex_price_ledger_dims WHERE (${names.length ? `model IN (${names.map(() => "?").join(",")})` : "0"}${range.models.includes(null) ? " OR model IS NULL" : ""}))`);
    params.push(...names);
  }
  if (range.instantValidity !== undefined) {
    if (range.instantValidity !== "invalid" && range.instantValidity !== "valid") throw new Error("Invalid ledger instant validity filter");
    terms.push(`${alias}.instant_ms IS ${range.instantValidity === "valid" ? "NOT " : ""}NULL`);
  }
  if (range.since !== undefined) { if (!isAccountingDay(range.since)) throw new Error("Invalid lexical day range"); terms.push(`${alias}.day>=?`); params.push(range.since); }
  if (range.until !== undefined) { if (!isAccountingDay(range.until)) throw new Error("Invalid lexical day range"); terms.push(`${alias}.day<=?`); params.push(range.until); }
  if (range.copyPaths !== undefined) {
    // Only the events of these physical files; never available from the copy-free sums.
    terms.push(range.copyPaths.length ? `${alias}.copy_id IN (SELECT id FROM codex_price_ledger_copies WHERE path IN (${range.copyPaths.map(() => "?").join(",")}))` : "0");
    params.push(...range.copyPaths);
  }
  if (range.sources !== undefined) {
    terms.push(range.sources.length ? `${alias}.dim_id IN (SELECT id FROM codex_price_ledger_dims WHERE source IN (${range.sources.map(() => "?").join(",")}))` : "0");
    params.push(...range.sources);
  }
  for (const [key, comparison] of [["fromMs", range.startInclusive === false ? ">" : ">="], ["toMs", range.endInclusive ? "<=" : "<"]] as const) {
    const value = range[key];
    if (value !== undefined) { if (!Number.isSafeInteger(value)) throw new Error("Exact instant bounds require integer milliseconds"); terms.push(`${alias}.instant_ms${comparison}?`); params.push(value); }
  }
  return { sql: terms.length ? terms.join(" AND ") : "1", params };
}

/**
 * An instant range as whole calendar hours (read from the stored hour sums) and at most two cut hours at its ends (read
 * from the calls); null when it is read from the calls only (an open end, a filter the sums do not carry, or no whole hour).
 */
function instantParts(range: LedgerRange): { hours: [number, number]; edges: LedgerRange[] } | null {
  const from = range.fromMs, to = range.toMs, hour = 3_600_000;
  if (from === undefined || to === undefined || range.instantValidity !== undefined || range.copyPaths !== undefined
    || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
  const first = from % hour === 0 && range.startInclusive !== false ? from : Math.ceil((from + 1) / hour) * hour;
  const last = to % hour === 0 && !range.endInclusive ? to : Math.floor(to / hour) * hour;
  if (first >= last) return null;
  const edges: LedgerRange[] = [];
  if (from < first) edges.push({ ...range, fromMs: from, toMs: first, endInclusive: false });
  if (last < to || range.endInclusive) edges.push({ ...range, fromMs: last, toMs: to, startInclusive: true });
  return { hours: [first / hour, last / hour], edges };
}

/** Read-only grouped bases; each group is one copy-state cohort, and only `canonical` counts as usage. */
export function readCodexLedgerGroups(db: Database, range: LedgerRange = {}): LedgerStoredGroup[] {
  requireCodexLedgerReady(db, range);
  const grain = range.grain ?? "day";
  if (grain !== "day" && grain !== "hour") throw new Error("Invalid ledger aggregate grain");
  const hourSelect = grain === "hour" ? "hour," : "";
  const hourGrouped = grain === "hour" ? "CAST(floor(instant_ms/3600000.0) AS INTEGER) hour," : "";
  const hourGroupBy = grain === "hour" ? "hour," : "";
  const wholeDays = range.fromMs === undefined && range.toMs === undefined && range.instantValidity === undefined && range.copyPaths === undefined;
  const parts = wholeDays ? null : instantParts(range);
  const storedColumns = `day,dim_id,api_band,credit_band,api_reason,credit_reason,api_zero,credit_zero,copy_state,
    calls,first_ts,last_ts,${quantities.join(",")},api_whole_hi,api_whole_lo,api_fraction_hi,api_fraction_lo,
    credit_whole_hi,credit_whole_lo,credit_fraction_hi,credit_fraction_lo,${TIMED_SUMS.join(",")}`;
  const fromEvents = (part: LedgerRange, hour: string) => {
    const edge = predicate(part, "e");
    return { sql: `SELECT ${hour}${groupKeys},${baseValues} FROM codex_price_ledger_events e WHERE admitted=1 AND copy_state<>'pending' AND ${edge.sql}
      GROUP BY ${hour ? "hour," : ""}day,dim_id,api_band,credit_band,COALESCE(api_reason,''),COALESCE(credit_reason,''),${zeroAmount("api")},${zeroAmount("credit")},copy_state`,
      params: edge.params };
  };
  let grouped: string, p: { sql: string; params: (string | number)[] };
  if (wholeDays) {
    p = predicate(range, "a");
    grouped = `SELECT ${hourSelect}${storedColumns} FROM codex_price_ledger_aggregates a WHERE grain='${grain}' AND ${p.sql}`;
  } else if (!parts) {
    p = predicate(range, "e");
    grouped = fromEvents(range, hourGrouped).sql;
  } else {
    // Whole hours of an instant range from the stored hour sums, the cut hours at its ends from the calls, summed into one group each.
    const hours = predicate({ ...range, fromMs: undefined, toMs: undefined, startInclusive: undefined, endInclusive: undefined }, "a");
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const edges = parts.edges.map(edge => fromEvents(edge, "CAST(floor(instant_ms/3600000.0) AS INTEGER) hour,"));
    p = { sql: "", params: [day(parts.hours[0] * 3_600_000 - 86_400_000), day(parts.hours[1] * 3_600_000 + 86_400_000), parts.hours[0], parts.hours[1],
      ...hours.params, ...edges.flatMap(edge => edge.params)] };
    const summed = ["calls", ...quantities, "api_whole_hi", "api_whole_lo", "api_fraction_hi", "api_fraction_lo", "credit_whole_hi", "credit_whole_lo",
      "credit_fraction_hi", "credit_fraction_lo", ...TIMED_SUMS];
    grouped = `SELECT ${hourSelect}day,dim_id,api_band,credit_band,api_reason,credit_reason,api_zero,credit_zero,copy_state,
      ${summed.map(field => `SUM(${field}) ${field}`).join(",")},MIN(first_ts) first_ts,MAX(last_ts) last_ts FROM (
        SELECT hour,${storedColumns} FROM codex_price_ledger_aggregates a WHERE grain='hour' AND a.day>=? AND a.day<=? AND a.hour>=? AND a.hour<? AND ${hours.sql}
        ${edges.map(edge => `UNION ALL ${edge.sql}`).join("\n")})
      GROUP BY ${hourGroupBy}day,dim_id,api_band,credit_band,api_reason,credit_reason,api_zero,credit_zero,copy_state`;
  }
  const exactFields = ["calls", ...quantities, "api_whole_hi", "api_whole_lo", "api_fraction_hi", "api_fraction_lo",
    "credit_whole_hi", "credit_whole_lo", "credit_fraction_hi", "credit_fraction_lo", ...TIMED_SUMS];
  return markContextRange(db, withPlaceProjects(db, db.query(`SELECT ${grain === "hour" ? "g.hour," : ""}g.day,g.dim_id,d.home,d.source,${metadataColumns()},
    g.api_band,g.credit_band,g.api_reason,g.credit_reason,g.api_zero,g.credit_zero,g.copy_state,g.first_ts,g.last_ts,
    ${exactFields.map(f => `CAST(g.${f} AS TEXT) ${f}`).join(",")}
    FROM (${grouped}) g JOIN codex_price_ledger_dims d ON d.id=g.dim_id
    ORDER BY g.day,g.dim_id,g.copy_state`).all(...p.params) as LedgerStoredGroup[]), range);
}

/**
 * The stored source spellings of the ledger's dimensions whose normalized source `keep` accepts: what a reader of one
 * account's calls narrows to (its periods name sources, and a call's owner is the period covering its source).
 */
export function readCodexLedgerSources(db: Database, keep: (source: string) => boolean): string[] {
  return (db.query("SELECT DISTINCT source FROM codex_price_ledger_dims WHERE source IS NOT NULL").all() as Array<{ source: string }>)
    .map(row => row.source).filter(keep).sort();
}
/**
 * The dimensions a window read takes: those of these stored homes and/or sources (a list that is given and empty selects
 * none), optionally narrowed by a predicate on the dimension's columns.
 */
export interface LedgerDimFilter { homes?: readonly string[]; sources?: readonly string[]; where?: { sql: string; params: readonly SQLQueryBindings[] } | null }
const selectsNothing = (filter: LedgerDimFilter) => filter.homes?.length === 0 || filter.sources?.length === 0;
function dimSelection(filter: LedgerDimFilter) {
  const terms: string[] = [], params: SQLQueryBindings[] = [];
  for (const [column, values] of [["home", filter.homes], ["source", filter.sources]] as const) if (values) {
    terms.push(`${column} IN (${values.map(() => "?").join(",")})`); params.push(...values);
  }
  if (filter.where) { terms.push(`(${filter.where.sql})`); params.push(...filter.where.params); }
  return { sql: `SELECT id FROM codex_price_ledger_dims WHERE ${terms.join(" AND ") || "1"}`, params };
}
const storedExactFields = ["calls", ...quantities, "api_whole_hi", "api_whole_lo", "api_fraction_hi", "api_fraction_lo",
  "credit_whole_hi", "credit_whole_lo", "credit_fraction_hi", "credit_fraction_lo", ...TIMED_SUMS];
const storedGroupColumns = (alias: string) => `${alias}.day,${alias}.dim_id,d.home,d.source,${metadataColumns()},
  ${alias}.api_band,${alias}.credit_band,${alias}.api_reason,${alias}.credit_reason,${alias}.api_zero,${alias}.credit_zero,${alias}.copy_state,
  ${alias}.first_ts,${alias}.last_ts,${storedExactFields.map(f => `CAST(${alias}.${f} AS TEXT) ${f}`).join(",")}`;
/**
 * The stored hour sums of calendar hours `[fromHour, untilHour)` (hours since the epoch) of the selected dimensions:
 * a window's whole hours. The caller checks readiness once for its range.
 */
export function readCodexLedgerHourSums(db: Database, fromHour: number, untilHour: number, filter: LedgerDimFilter): Array<LedgerStoredGroup & { hour: number }> {
  if (selectsNothing(filter) || untilHour <= fromHour) return [];
  const dims = dimSelection(filter);
  // A call's pricing day is its timestamp's date: within a day of its UTC hour, so the day bound keeps the read on the key.
  const day = (hour: number) => new Date(hour * 3_600_000).toISOString().slice(0, 10);
  return markContextRange(db, withPlaceProjects(db, db.query(`SELECT a.hour,${storedGroupColumns("a")}
    FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id
    WHERE a.grain='hour' AND a.day>=? AND a.day<=? AND a.hour>=? AND a.hour<? AND a.dim_id IN (${dims.sql})
    ORDER BY a.hour,a.day,a.dim_id,a.copy_state`)
    .all(day(fromHour - 24), day(untilHour + 24), fromHour, untilHour, ...dims.params) as Array<LedgerStoredGroup & { hour: number }>), { fromMs: fromHour * 3_600_000, toMs: untilHour * 3_600_000 });
}
/**
 * The same sums over instant pieces `[from, until)` of the selected dimensions' calls, read from the calls: the parts of
 * hours a window's boundaries cut. Each piece's cohorts also keep invalid calls apart, so a cohort is valid or not as a whole.
 */
export function readCodexLedgerPieceSums(db: Database, pieces: ReadonlyArray<readonly [number, number]>, filter: LedgerDimFilter):
  Array<LedgerStoredGroup & { piece: number }> {
  if (selectsNothing(filter) || !pieces.length) return [];
  if (pieces.some(([from, until]) => !Number.isSafeInteger(from) || !Number.isSafeInteger(until))) throw new Error("Exact instant bounds require integer milliseconds");
  const dims = dimSelection(filter);
  const rows = withPlaceProjects(db, db.query(`SELECT g.piece,${storedGroupColumns("g")}
    FROM (SELECT piece,${groupKeys},${baseValues} FROM (SELECT CAST(p.key AS INTEGER) piece,e.invalid_tokens invalid_call,e.*
        FROM json_each(?) p CROSS JOIN codex_price_ledger_events e INDEXED BY codex_price_ledger_events_time
          ON e.instant_ms>=json_extract(p.value,'$[0]') AND e.instant_ms<json_extract(p.value,'$[1]')
        WHERE e.admitted=1 AND e.copy_state<>'pending' AND e.dim_id IN (${dims.sql}))
      GROUP BY piece,day,dim_id,api_band,credit_band,COALESCE(api_reason,''),COALESCE(credit_reason,''),${zeroAmount("api")},${zeroAmount("credit")},copy_state,invalid_call) g
    JOIN codex_price_ledger_dims d ON d.id=g.dim_id
    ORDER BY g.piece,g.day,g.dim_id,g.copy_state`).all(JSON.stringify(pieces), ...dims.params) as Array<LedgerStoredGroup & { piece: number }>);
  for (const row of rows) markContextRange(db, [row], { fromMs: pieces[row.piece]![0], toMs: pieces[row.piece]![1] });
  return rows;
}

/** What a cohort read groups calls by (see `readCodexLedgerCohorts`). */
export interface LedgerCohortSpec {
  /** Instants `[from, until)` of the calls. */
  from: number; until: number;
  /** Sources (as stored) with the instants a cohort's calls may come from. */
  owned: ReadonlyArray<{ sources: readonly string[]; from: number; until: number }>;
  /** No cohort spans one of these instants: each starts at the last cut at or before its calls. */
  cuts: readonly number[];
  /** No cohort spans a 1/400 of `[start, end)` (the rail's resolution), computed as the rail computes it. */
  activity: { start: number; end: number };
  /**
   * Context thresholds of the reference-day bands: a cohort's calls then fall in the same band of each (with the same
   * common reason and cache-write use, also cohort keys), so its reference valuation is that of its summed buckets.
   */
  referenceThresholds?: readonly number[];
}
/** One cohort: the stored sums of its calls and the call fields a window reads, summed. */
export type LedgerCohortRow = LedgerStoredGroup & { path: null; first_ms: number; first_id: number;
  in_tok: number; cached_in: number; cache_write: number; out_tok: number;
  /** The cohort's common reason and an input count of one of its calls (they share every context band). */
  common_reason: string | null; band_in_tok: unknown };
/** A call whose token fields a window cannot sum (a missing or negative count, cached above input) stays a cohort of its own. */
const summable = (column: string) => `(typeof(${column}) IN ('integer','real') AND ${column}>=0 AND ${column}<=9007199254740991)`;
const wholeCount = (column: string) => `(${summable(column)} AND ${column}=CAST(${column} AS INTEGER))`;
/**
 * Canonical calls of one window's span grouped into exact cohorts: calls of one source, file home, ledger dimension,
 * pricing day, stored price cohort and reference-day band, within one interval between the window's cuts, one
 * calendar hour and one rail step. Every rule a window applies to a call is then the same for the whole cohort, and
 * its sums are the sums of its calls (an unsummable call is its own cohort). The read touches each call once in SQL.
 */
export function readCodexLedgerCohorts(db: Database, spec: LedgerCohortSpec): LedgerCohortRow[] {
  requireCodexLedgerReady(db, { fromMs: spec.from, toMs: spec.until });
  if (!spec.owned.length) return [];
  const cuts = JSON.stringify(spec.cuts.filter(at => Number.isSafeInteger(at)));
  const valid = `(${wholeCount("e.in_tok")} AND ${wholeCount("e.out_tok")} AND ${wholeCount("e.cached_in")} AND e.cached_in<=e.in_tok
    AND (e.cache_write IS NULL OR ${summable("e.cache_write")}))`;
  const owned = spec.owned.map(range => `c.source IN (${range.sources.map(() => "?").join(",") || "NULL"}) AND e.instant_ms>=? AND e.instant_ms<?`).join(" OR ");
  const ownedParams = spec.owned.flatMap(range => [...range.sources, range.from, Number.isFinite(range.until) ? range.until : Number.MAX_SAFE_INTEGER]);
  const thresholds = (spec.referenceThresholds ?? []).filter(Number.isFinite);
  const band = `CASE WHEN typeof(e.in_tok) IN ('integer','real') THEN ${thresholds.map(() => "(e.in_tok>?)").join("+") || "0"} ELSE -1 END`;
  const exactFields = ["calls", ...quantities, "api_whole_hi", "api_whole_lo", "api_fraction_hi", "api_fraction_lo",
    "credit_whole_hi", "credit_whole_lo", "credit_fraction_hi", "credit_fraction_lo"];
  // The cuts and the span's calls in one instant order (a cut before the calls at its instant): the number of cuts
  // so far is the interval a call is in. Only the time index is read for it, then each call once by its id.
  const rows = db.query(`WITH marks AS (SELECT id,is_cut,SUM(is_cut) OVER (ORDER BY t,is_cut DESC ROWS UNBOUNDED PRECEDING) cut FROM (
        SELECT CAST(value AS INTEGER) t,1 is_cut,NULL id FROM json_each(?)
        UNION ALL SELECT instant_ms,0,id FROM codex_price_ledger_events INDEXED BY codex_price_ledger_events_time WHERE instant_ms>=? AND instant_ms<?))
    SELECT g.day,g.dim_id,g.home,g.source,NULL path,${metadataColumns()},
    g.api_band,g.credit_band,g.api_reason,g.credit_reason,g.api_zero,g.credit_zero,g.copy_state,g.first_ts,g.last_ts,g.first_ms,g.first_id,
    g.in_tok,g.cached_in,g.cache_write,g.out_tok,g.common_reason,g.band_in_tok,
    ${exactFields.map(f => `CAST(g.${f} AS TEXT) ${f}`).join(",")}
    FROM (SELECT ${groupKeys},home,source,${baseValues},MIN(instant_ms) first_ms,MIN(id) first_id,
        SUM(in_tok) in_tok,SUM(cached_in) cached_in,SUM(COALESCE(cache_write,0)) cache_write,SUM(out_tok) out_tok,
        common_reason,MIN(in_tok) band_in_tok
      FROM (SELECT e.*,c.home,c.source,m.cut,
          CAST(floor((e.instant_ms-?)*1.0/?*400) AS INTEGER) step,CAST(floor(e.instant_ms/3600000.0) AS INTEGER) hour,
          CASE WHEN ${valid} THEN NULL ELSE e.id END solo,${band} context_band,e.writes>0 writing
        FROM marks m CROSS JOIN codex_price_ledger_events e ON e.id=m.id CROSS JOIN codex_price_ledger_copies c ON c.id=e.copy_id
        WHERE m.is_cut=0 AND e.copy_state='canonical' AND (${owned}))
      GROUP BY cut,step,hour,solo,day,dim_id,home,source,api_band,credit_band,COALESCE(api_reason,''),COALESCE(credit_reason,''),
        ${zeroAmount("api")},${zeroAmount("credit")},common_reason,context_band,writing) g
    JOIN codex_price_ledger_dims d ON d.id=g.dim_id
    ORDER BY g.first_ms,g.first_id`).all(cuts, spec.from, spec.until, spec.activity.start, spec.activity.end - spec.activity.start,
      ...thresholds, ...ownedParams) as LedgerCohortRow[];
  return withPlaceProjects(db, rows);
}

/** Fixed UTC buckets retain lexical pricing days and exact source-time edge policies. */
export function readCodexLedgerBucketGroups(db: Database, range: LedgerRange, bucketMs: number): Array<{ bucketStartMs: number; group: LedgerStoredGroup }> {
  requireCodexLedgerReady(db, range);
  if (bucketMs !== 60000 && bucketMs !== 3600000) throw new Error("Unsupported fixed UTC ledger bucket");
  const p = predicate(range, "e");
  const exactFields = ["calls", ...quantities, "api_whole_hi", "api_whole_lo", "api_fraction_hi", "api_fraction_lo",
    "credit_whole_hi", "credit_whole_lo", "credit_fraction_hi", "credit_fraction_lo"];
  const rows = withPlaceProjects(db, db.query(`SELECT g.bucket_start_ms,g.day,g.dim_id,d.home,d.source,${metadataColumns()},
    g.api_band,g.credit_band,g.api_reason,g.credit_reason,g.api_zero,g.credit_zero,g.copy_state,g.first_ts,g.last_ts,
    ${exactFields.map(f => `CAST(g.${f} AS TEXT) ${f}`).join(",")}
    FROM (SELECT CAST(floor(instant_ms/${bucketMs}.0) AS INTEGER)*${bucketMs} bucket_start_ms,${groupKeys},${baseValues}
      FROM codex_price_ledger_events e WHERE admitted=1 AND copy_state<>'pending' AND instant_ms IS NOT NULL AND ${p.sql}
      GROUP BY bucket_start_ms,day,dim_id,api_band,credit_band,COALESCE(api_reason,''),COALESCE(credit_reason,''),${zeroAmount("api")},${zeroAmount("credit")},copy_state) g
    JOIN codex_price_ledger_dims d ON d.id=g.dim_id
    ORDER BY g.bucket_start_ms,g.day,g.dim_id,g.copy_state`).all(...p.params) as Array<LedgerStoredGroup & { bucket_start_ms: number }>);
  return rows.map(({ bucket_start_ms, ...group }) => ({ bucketStartMs: bucket_start_ms, group }));
}

/**
 * The burn of some Codex homes over windows ending now: calls and tokens of their ledger events
 * collected since `now - hours` for each window, every copy of a call counted (a source's own
 * traffic), plus the events without a valid instant, which no window can place. `projectId`
 * narrows to one project (`null`: calls without one).
 */
export function readCodexSourceBurn(db: Database, homes: readonly string[], nowMs: number, windowHours: readonly number[],
  projectId?: string | null): { windows: Array<{ hours: number; calls: number; input: bigint; cached: bigint; output: bigint }>; unplaced: number } {
  if (!homes.length) return { windows: [], unplaced: 0 };
  const projectOf = codexProjectSql(db, "d", "l.day");
  const sources = `c.home IN (${homes.map(() => "?").join(",")})`, project = projectId === undefined ? "" : ` AND ${projectOf} IS ?`;
  const projectParams = projectId === undefined ? [] : [projectId];
  const start = new Date(nowMs - Math.max(...windowHours) * 3_600_000).toISOString();
  const thresholds: string[] = [];
  // Valid original timestamps compare as text, as the source recorded them; future inputs included.
  const columns = windowHours.flatMap((hours, index) => {
    const threshold = new Date(nowMs - hours * 3_600_000).toISOString();
    thresholds.push(threshold, threshold, threshold, threshold);
    return [`CAST(SUM(CASE WHEN l.ts >= ? THEN 1 ELSE 0 END) AS TEXT) calls_${index}`,
      ...["in_tok", "cached_in", "out_tok"].map(field => `CAST(SUM(CASE WHEN l.ts >= ? THEN l.${field} END) AS TEXT) ${field}_${index}`)];
  });
  const row = db.query(`SELECT ${columns.join(",")} FROM codex_price_ledger_events l INDEXED BY codex_price_ledger_events_day
    JOIN codex_price_ledger_copies c ON c.id=l.copy_id JOIN codex_price_ledger_dims d ON d.id=l.dim_id
    WHERE ${sources} AND l.day >= ? AND l.ts >= ? AND l.instant_ms IS NOT NULL${project}`)
    .get(...thresholds, ...homes, start.slice(0, 10), start, ...projectParams) as Record<string, string | null>;
  const unplaced = db.query(`SELECT COUNT(*) n FROM codex_price_ledger_events l INDEXED BY codex_price_ledger_events_time
    JOIN codex_price_ledger_copies c ON c.id=l.copy_id JOIN codex_price_ledger_dims d ON d.id=l.dim_id
    WHERE l.instant_ms IS NULL AND ${sources}${project}`).get(...homes, ...projectParams) as { n: number };
  return { windows: windowHours.map((hours, index) => ({ hours, calls: Number(row[`calls_${index}`] ?? "0"),
    input: BigInt(row[`in_tok_${index}`] ?? "0"), cached: BigInt(row[`cached_in_${index}`] ?? "0"), output: BigInt(row[`out_tok_${index}`] ?? "0") })),
    unplaced: unplaced.n };
}

/** One canonical Codex call of the ledger with where it was made: what a per-call timeline (gaps within a session file) needs. */
/** The models each physical file's calls used (the stored per-file rows), for the files under the given stored homes. */
export function readCodexLedgerFileModels(db: Database, homes: readonly string[]): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>();
  if (!homes.length) return models;
  for (const row of db.query(`SELECT DISTINCT c.path, d.model FROM codex_price_ledger_file_models f
      JOIN codex_price_ledger_copies c ON c.id=f.copy_id JOIN codex_price_ledger_dims d ON d.id=f.dim_id
      WHERE c.home IN (${homes.map(() => "?").join(", ")}) AND d.model IS NOT NULL AND d.model <> ''`).all(...homes) as Array<{ path: string; model: string }>)
    models.set(row.path, (models.get(row.path) ?? new Set<string>()).add(row.model));
  return models;
}

/** First and last UTC day of the Codex ledger's canonical calls. */
export function codexLedgerDayBounds(db: Database): { first: string | null; last: string | null } {
  return db.query(`SELECT MIN(day) first, MAX(day) last FROM codex_price_ledger_aggregates
    WHERE grain='day' AND copy_state='canonical'`).get() as { first: string | null; last: string | null };
}
