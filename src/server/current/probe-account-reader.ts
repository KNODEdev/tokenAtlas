import type { Database } from "bun:sqlite";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../../config/paths";
import { probeSourcesPublished } from "../../db/probe-sources";
import { loadAccountResolver, type AccountResolver } from "../account-resolver";
import { normEraKey, normEraVendor } from "../eras";
import { sourceOfProbeTuple, type ProbeSourceOptions, type ProbeSourceTuple } from "../probe-source";
import { resolveProbeEvidence, type ProbeEvidenceBasis } from "../probe-source-reader";
import type { ProbeSourceCorrection } from "../probe-source-corrections";
import type { SourceDeclaration } from "../archive-source";

/**
 * Readings of an account (plan U4.3): the account is a few dated source ranges of the account periods
 * (`resolver.plan`), each source a few physical tuples, and each tuple an index range of the
 * readings' stored evidence (`probe_sources`). Nothing here is maintained per account: a period or
 * declaration change is read through on the next call.
 */
export type ProbeAccountIndex = "all" | "resolved" | "success" | "codex-success" | "grok-percent" | "glm-kind"
  | "machine-ok" | "machine-error";
export type ProbeAccountRow = Record<string, unknown> & { id: number; provider: string; ts: string; kind: string };
export interface ProbeAccountRead { rows: ProbeAccountRow[]; visitedKeys: number }
export { ProbeAccountIndexUnavailable } from "./probe-account-unavailable";
export class ProbeAccountReadLimitExceeded extends Error {
  readonly code = "probe-account-read-limit-exceeded";
  constructor() { super("Prepared probe account range exceeds its bounded read limit"); }
}

const SOURCED: readonly ProbeEvidenceBasis[] = ["projection", "matched"];

/** The declarations and corrections the current projection writer last published, which readers resolve with. */
export interface ProbeReadContext { options: ProbeSourceOptions; resolver: AccountResolver }
const meta = (db: Database, name: string) => {
  try {
    return (db.query("SELECT value FROM meta WHERE key=?").get(`current_v2_${name}`) as { value: string } | null)?.value ?? null;
  } catch { return null; }
};
export function probeReadContext(db: Database): ProbeReadContext {
  const definitions = JSON.parse(meta(db, "definitions") ?? "null") as [string, string, unknown] | null;
  const declarations = JSON.parse(meta(db, "declarations") ?? "[]") as SourceDeclaration[];
  const corrections = JSON.parse(meta(db, "probe_source_corrections") ?? "[]") as ProbeSourceCorrection[];
  return { options: { declarations, corrections, archiveRoot: definitions?.[0] ?? ARCHIVE_LOGICAL_ROOT, defaultLogin: definitions?.[1] ?? LOGIN },
    resolver: loadAccountResolver(db) };
}

/** Readers answer only once every reading's evidence was written at least once (golden rules §9). */
export function preparedProbeAccountIndexReady(db: Database, _provider?: string, _account?: string): boolean {
  try { return probeSourcesPublished(db); } catch { return false; }
}

type Tuple = { machine: string; home: string; login: string };
/** The physical tuples a provider's readings were taken under (a few dozen; `probe_source_tuples`). */
const probeTuples = (db: Database, provider: string) =>
  db.query("SELECT machine,home,login FROM probe_source_tuples WHERE provider=? ORDER BY machine,home,login").all(provider) as Tuple[];
/** The physical tuples of a provider by the archive source they map to under the context's declarations. */
function tuplesOf(db: Database, context: ProbeReadContext, provider: string): Map<string, Tuple[]> {
  const bySource = new Map<string, Tuple[]>();
  for (const tuple of probeTuples(db, provider)) {
    const source = sourceOfProbeTuple(provider, tuple as ProbeSourceTuple, context.options);
    if (!source) continue;
    const key = normEraKey(source);
    bySource.set(key, [...bySource.get(key) ?? [], tuple]);
  }
  return bySource;
}
/** A reading's stored evidence rows (`probe_sources`), in order. */
export interface StoredProbeEvidence { provider: string; machine: string | null; home: string | null; login: string | null; basis: ProbeEvidenceBasis;
  at: number | null; accounting_at: number | null; observation_at: number | null; subject: string; bare: number }
export function readProbeEvidence(db: Database, id: number): StoredProbeEvidence[] {
  return db.query("SELECT provider,machine,home,login,basis,at,accounting_at,observation_at,subject,bare FROM probe_sources WHERE probe_id=? ORDER BY ord").all(id) as StoredProbeEvidence[];
}
/** The archive source of a reading from all its stored evidence rows, under the context's declarations and corrections. */
export function sourceOfStoredEvidence(context: ProbeReadContext, evidence: readonly StoredProbeEvidence[]): string | null {
  const head = evidence[0];
  if (!head) return null;
  const tuples = evidence.map(item => item.machine === null ? null : { machine: item.machine, home: item.home ?? "", login: item.login ?? "" });
  const ts = head.at === null ? undefined : new Date(head.at).toISOString();
  const resolved = resolveProbeEvidence(head.provider, { basis: head.basis, tuples },
    { subject: head.subject, ts, machine: head.bare ? null : "" }, context.options);
  return resolved.source && normEraKey(resolved.source);
}
/** The account that owns a reading by its stored evidence: the source's account period at the collection instant. */
export function ownerOfStoredEvidence(context: ProbeReadContext, evidence: readonly StoredProbeEvidence[]): string | null {
  const head = evidence[0];
  if (!head || head.at === null) return null;
  const at = head.at;
  return context.resolver.resolve(head.provider, sourceOfStoredEvidence(context, evidence), null,
    new Date(at).toISOString()).account?.toLowerCase() ?? null;
}
const readingSource = (db: Database, context: ProbeReadContext, row: ProbeAccountRow) =>
  sourceOfStoredEvidence(context, readProbeEvidence(db, row.id));

/** Indexed SQL nomination for a sibling reading; the shared observation reader still verifies the group. */
export function preparedProbeOwnedBySql(db: Database, context: ProbeReadContext, provider: string, account: string, alias: string):
  { sql: string; params: string[] } {
  const tuples = [...tuplesOf(db,context,provider)].flatMap(([source,rows])=>rows.map(row=>({...row,source})));
  const ranges = context.resolver.plan(provider,account).ranges.map(range=>({source:range.source,
    from:Number.isFinite(range.from)?range.from:-Number.MAX_SAFE_INTEGER,until:Number.isFinite(range.until)?range.until:Number.MAX_SAFE_INTEGER}));
  const corrections=(context.options.corrections??[]).filter(row=>normEraVendor(row.provider)===provider).map(row=>({
    subject:row.subject,source:normEraKey(row.source),from:Date.parse(row.from),until:Date.parse(row.until)}));
  const tupleMatch = "json_extract(t.value,'$.machine')=e.machine AND json_extract(t.value,'$.home')=e.home AND json_extract(t.value,'$.login')=e.login";
  const source = "json_extract(t.value,'$.source')";
  return {sql:`EXISTS(SELECT 1 FROM probe_sources h JOIN json_each(?) r
    ON h.at>=json_extract(r.value,'$.from') AND h.at<json_extract(r.value,'$.until')
    WHERE h.provider=? AND h.probe_id=${alias}.id AND h.ord=0 AND (
      (h.basis='projection' AND json_extract(r.value,'$.source')=(SELECT ${source} FROM probe_sources e
        JOIN json_each(?) t ON ${tupleMatch} WHERE e.probe_id=h.probe_id ORDER BY e.ord LIMIT 1))
      OR (h.basis='matched' AND json_extract(r.value,'$.source')=(SELECT CASE
        WHEN COUNT(*)=COUNT(${source}) AND COUNT(DISTINCT ${source})=1 THEN MIN(${source})
        WHEN COUNT(${source})=0 AND h.bare=1 THEN (SELECT json_extract(c.value,'$.source') FROM json_each(?) c
          WHERE json_extract(c.value,'$.subject')=h.subject AND h.at>=json_extract(c.value,'$.from') AND h.at<json_extract(c.value,'$.until') ORDER BY CAST(c.key AS INTEGER) LIMIT 1)
        END FROM probe_sources e LEFT JOIN json_each(?) t ON ${tupleMatch} WHERE e.probe_id=h.probe_id))
    ))`,params:[JSON.stringify(ranges),provider,JSON.stringify(tuples),JSON.stringify(corrections),JSON.stringify(tuples)]};
}

/** The stored instant a selection is bounded and ordered by: collection (ownership), accounting or Claude observation. */
export type ProbeKeyColumn = "at" | "accounting_at" | "observation_at";
const KEY_INDEX: Record<ProbeKeyColumn, string> = { at: "probe_sources_tuple", accounting_at: "probe_sources_accounting",
  observation_at: "probe_sources_observation" };
export interface OwnedProbeSelect {
  /** Collection instants `[from, until)` (ms), within the account's periods. */
  from?: number; until?: number;
  /** Bound and order by this stored instant instead, within `[keyFrom, keyUntil)`; the periods still bound collection. */
  key?: ProbeKeyColumn; keyFrom?: number; keyUntil?: number;
  where?: string; params?: Array<string | number | null>; order?: "asc" | "desc"; limit?: number;
  /** The reading columns to return (alias p; `p.id` included); all of them by default. */
  columns?: string }
export type OwnedProbe = { row: ProbeAccountRow; at: number; key: number };
const strip = ({ __at: _at, __tuples: _tuples, __correction: _correction, __key: _key, ...row }: Record<string, unknown>) => row as ProbeAccountRow;
/**
 * The account's readings of `[from, until)` (collection instant, ms) that satisfy `where` (alias p for
 * probe_windows), ordered by the key instant and id, at most `limit` of them. One index range per
 * source range and physical tuple, plus the owner's corrections for readings without a computer.
 */
export function selectOwnedProbes(db: Database, context: ProbeReadContext, providerName: string, account: string, select: OwnedProbeSelect): OwnedProbe[] {
  const provider = normEraVendor(providerName), plan = context.resolver.plan(provider, account.toLowerCase());
  const descending = select.order === "desc", limit = select.limit ?? Infinity;
  const window = { from: select.from ?? -Infinity, until: select.until ?? Infinity };
  const tuples = tuplesOf(db, context, provider);
  const corrections = (context.options.corrections ?? []).filter(item => normEraVendor(item.provider) === provider);
  const extra = select.where ? ` AND (${select.where})` : "";
  const order = descending ? "DESC" : "ASC", columns = select.columns ?? "p.*", keyColumn = select.key ?? "at";
  const safe = (value: number) => Number.isFinite(value) ? value : value < 0 ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  const keyBounds = keyColumn === "at" ? "" : ` AND s.${keyColumn}>=? AND s.${keyColumn}<?`;
  const keyParams = keyColumn === "at" ? [] : [safe(select.keyFrom ?? -Infinity), safe(select.keyUntil ?? Infinity)];
  for (let fetch = Number.isFinite(limit) ? limit + 8 : -1; ; fetch *= 2) {
    let truncated = false;
    const found = new Map<number, OwnedProbe>();
    const take = (rows: Array<Record<string, unknown>>, source: string) => {
      for (const raw of rows) {
        const row = strip(raw), at = raw.__at as number, key = raw.__key as number;
        if (found.has(row.id)) continue;
        // A reading with disagreeing deliveries or a correction is owned only through its whole evidence.
        if (((raw.__tuples as number) > 1 || raw.__correction) && readingSource(db, context, row) !== source) continue;
        found.set(row.id, { row, at, key });
      }
    };
    const limited = fetch > 0 ? ` LIMIT ${fetch}` : "";
    for (const range of plan.ranges) {
      const from = Math.max(range.from, window.from), until = Math.min(range.until, window.until);
      if (!(from < until)) continue;
      const lower = Number.isFinite(from) ? from : -Number.MAX_SAFE_INTEGER, upper = Number.isFinite(until) ? until : Number.MAX_SAFE_INTEGER;
      for (const tuple of tuples.get(range.source) ?? []) {
        const rows = db.query(`SELECT ${columns}, s.at AS __at, s.${keyColumn} AS __key, s.tuples AS __tuples
          FROM probe_sources s INDEXED BY ${KEY_INDEX[keyColumn]} JOIN probe_windows p ON p.id=s.probe_id
          WHERE s.provider=? AND s.machine=? AND s.home=? AND s.login=? AND s.basis IN ('projection','matched')
            AND s.at>=? AND s.at<?${keyBounds}${extra} ORDER BY s.${keyColumn} ${order}, s.probe_id ${order}${limited}`)
          .all(provider, tuple.machine, tuple.home, tuple.login, lower, upper, ...keyParams, ...(select.params ?? [])) as Array<Record<string, unknown>>;
        if (fetch > 0 && rows.length >= fetch) truncated = true;
        take(rows, range.source);
      }
      for (const correction of corrections) {
        if (normEraKey(correction.source) !== range.source) continue;
        const start = Math.max(lower, Date.parse(correction.from)), end = Math.min(upper, Date.parse(correction.until));
        if (!(start < end)) continue;
        const rows = db.query(`SELECT ${columns}, s.at AS __at, s.${keyColumn} AS __key, s.tuples AS __tuples, 1 AS __correction
          FROM probe_sources s JOIN probe_windows p ON p.id=s.probe_id WHERE s.provider=? AND s.subject=? AND s.bare=1
            AND s.at>=? AND s.at<?${keyBounds} AND s.basis='matched'${extra} ORDER BY s.${keyColumn} ${order}, s.probe_id ${order}${limited}`)
          .all(provider, correction.subject, start, end, ...keyParams, ...(select.params ?? [])) as Array<Record<string, unknown>>;
        if (fetch > 0 && rows.length >= fetch) truncated = true;
        take(rows, range.source);
      }
    }
    const ranked = [...found.values()].sort((a, b) => descending ? b.key - a.key || b.row.id - a.row.id : a.key - b.key || a.row.id - b.row.id);
    // Every index range read fewer rows than asked, or the merged answer already has its rows.
    if (fetch < 0 || !truncated || ranked.length >= limit) return Number.isFinite(limit) ? ranked.slice(0, limit) : ranked;
  }
}

const QUALIFIED = "(p.kind<>'error' AND (p.ok IS NULL OR p.ok=1))";
function qualifier(provider: string, index: ProbeAccountIndex, options: { kind?: string; machine?: string | null }):
  { where?: string; params?: Array<string | null> } | null {
  switch (index) {
    case "all": case "resolved": return {};
    case "success": return { where: QUALIFIED };
    case "codex-success": return provider === "codex" ? { where: QUALIFIED } : null;
    case "glm-kind": return provider === "glm" ? { where: "p.kind=?", params: [options.kind ?? ""] } : null;
    case "grok-percent": return provider === "grok" ? { where: "p.used_percent IS NOT NULL" } : null;
    case "machine-ok": return { where: `${QUALIFIED} AND p.machine IS ?`, params: [options.machine ?? null] };
    case "machine-error": return { where: "(p.kind='error' OR p.ok=0) AND p.machine IS ?", params: [options.machine ?? null] };
  }
}

/** The newest readings of an account that satisfy an index's predicate; `null` before the first build. */
export function readPreparedProbeAccountRows(db: Database, provider: string, account: string,
  options: { index: ProbeAccountIndex; limit: number; kind?: string; timestamp?: string; machine?: string | null }): ProbeAccountRead | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const cap = Math.max(1, Math.min(20_000, Math.floor(options.limit)));
  if (options.index === "glm-kind" && !options.kind) return { rows: [], visitedKeys: 0 };
  const predicate = qualifier(normEraVendor(provider), options.index, options);
  if (!predicate) return { rows: [], visitedKeys: 0 };
  const where = [predicate.where, options.timestamp === undefined ? undefined : "p.ts=?"].filter(Boolean).join(" AND ");
  const params = [...predicate.params ?? [], ...(options.timestamp === undefined ? [] : [options.timestamp])];
  const rows = selectOwnedProbes(db, probeReadContext(db), provider, account, { where: where || undefined, params, order: "desc", limit: cap })
    .map(item => item.row);
  return { rows, visitedKeys: rows.length };
}

/** The computers that took the account's readings. */
export function readPreparedProbeMachines(db: Database, provider: string, account: string): Array<string | null> | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const machines = new Set(selectOwnedProbes(db, probeReadContext(db), provider, account, { columns: "p.id,p.machine" })
    .map(item => item.row.machine as string | null));
  if (machines.size > 512) return null;
  return [...machines].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** The timestamp of the newest qualifying sample, followed by all resolved rows at that raw timestamp. */
export function readPreparedProbeTimestamp(db: Database, provider: string, account: string,
  index: "codex-success" | "resolved", tieLimit = 512): ProbeAccountRead | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const predicate = qualifier(normEraVendor(provider), index, {});
  if (!predicate) return { rows: [], visitedKeys: 0 };
  const context = probeReadContext(db);
  const head = selectOwnedProbes(db, context, provider, account, { where: predicate.where, params: predicate.params, order: "desc", limit: 1 })[0];
  if (!head) return { rows: [], visitedKeys: 0 };
  // Readings with the head's raw timestamp share its collection instant (`at` is parsed from `ts`): one instant, not all history.
  const ties = selectOwnedProbes(db, context, provider, account,
    { from: head.at, until: head.at + 1, where: "p.ts=?", params: [head.row.ts], order: "desc", limit: tieLimit + 1 }).map(item => item.row);
  if (ties.length > tieLimit) return null;
  return { rows: ties, visitedKeys: 1 + ties.length };
}

export interface PreparedProbeCoverage {
  first_at: string | null; last_at: string | null; samples: number; reset_samples: number; plan_samples: number;
  visitedBuckets: number;
}
export interface ProbeActivityDay {
  provider: string; account: string; source: string | null; day: string;
  samples: number; first_ts: string; last_ts: string; resets: Record<string, number>;
}

/** The accounts a provider-wide reader covers: the given one, or every account of the periods. */
function accountsOf(db: Database, context: ProbeReadContext, provider?: string, account?: string): Array<[string, string]> {
  const providers = provider ? [normEraVendor(provider)]
    : (db.query("SELECT DISTINCT provider FROM probe_source_tuples ORDER BY provider").all() as Array<{ provider: string }>).map(row => row.provider);
  return providers.flatMap(vendor => (account ? [account.toLowerCase()] : context.resolver.accounts(vendor))
    .map(id => [vendor, id] as [string, string]));
}
const hasText = (value: unknown) => typeof value === "string" && value.trim() !== "";
const HOME = "CASE WHEN json_valid(p.extra) AND json_type(p.extra,'$.home')='text' THEN json_extract(p.extra,'$.home') END";

/** Daily activity of the readings (failed observations included), per local source folder. */
export function readPreparedProbeActivity(db: Database, provider?: string, account?: string): ProbeActivityDay[] | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const context = probeReadContext(db), days = new Map<string, ProbeActivityDay>();
  for (const [vendor, id] of accountsOf(db, context, provider, account)) {
    for (const { row } of selectOwnedProbes(db, context, vendor, id, { columns: `p.id,p.ts,p.kind,p.resets_at,p.window_minutes,${HOME} AS home` })) {
      // The local source folder the probe recorded; missing or malformed labels stay unknown.
      const source = row.home as string | null;
      const day = row.ts.slice(0, 10), key = `${vendor}\u0000${id}\u0000${day}\u0000${JSON.stringify(source)}`;
      const bucket = days.get(key) ?? { provider: vendor, account: id, source, day, samples: 0, first_ts: row.ts, last_ts: row.ts,
        resets: Object.create(null) as Record<string, number> };
      bucket.samples++;
      if (row.ts < bucket.first_ts) bucket.first_ts = row.ts;
      if (row.ts > bucket.last_ts) bucket.last_ts = row.ts;
      const reset = row.resets_at as string | null, minutes = row.window_minutes as number | null;
      if (reset !== null && (minutes === 10080 || (minutes === null && row.kind.toLowerCase().includes("week"))))
        bucket.resets[reset] = (bucket.resets[reset] ?? 0) + 1;
      days.set(key, bucket);
      if (days.size > 100_000) throw new ProbeAccountReadLimitExceeded();
    }
  }
  return [...days.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, bucket]) => bucket);
}

/** Distinct observed counters and one newest reset reading per counter. */
export function readPreparedProbeCadences(db: Database, provider?: string, account?: string):
  Array<{ provider: string; account: string; kind: string; latest: ProbeAccountRow | null }> | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const context = probeReadContext(db);
  const out = new Map<string, { provider: string; account: string; kind: string; latest: ProbeAccountRow | null }>();
  for (const [vendor, id] of accountsOf(db, context, provider, account)) {
    for (const { row } of selectOwnedProbes(db, context, vendor, id, { where: QUALIFIED, columns: "p.id,p.ts,p.kind,p.resets_at" })) {
      const key = `${vendor}\u0000${id}\u0000${JSON.stringify(row.kind)}`;
      const entry = out.get(key) ?? { provider: vendor, account: id, kind: row.kind, latest: null };
      if (row.resets_at !== null && (!entry.latest || row.ts > entry.latest.ts || row.ts === entry.latest.ts && row.id > entry.latest.id))
        entry.latest = row;
      out.set(key, entry);
      if (out.size > 10_000) throw new ProbeAccountReadLimitExceeded();
    }
  }
  const full = db.query("SELECT * FROM probe_windows WHERE id=?");
  return [...out.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, entry]) => entry.latest ? { ...entry, latest: full.get(entry.latest.id) as ProbeAccountRow } : entry);
}

/** Whether the account has a usable meter reading (a percentage or counter of a successful sample). */
export function hasPreparedProbeAvailability(db: Database, provider: string, account: string): boolean | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  return selectOwnedProbes(db, probeReadContext(db), provider, account, { limit: 1, columns: "p.id", where: `${QUALIFIED} AND (p.used_percent IS NOT NULL
    OR p.remaining_percent IS NOT NULL OR p.vendor_percent IS NOT NULL OR p.allowance IS NOT NULL OR p.used IS NOT NULL OR p.remaining IS NOT NULL)` }).length > 0;
}

/** Percentage coverage of the account: samples, resets and plans over the observed days. */
export function readPreparedProbeCoverage(db: Database, provider: string, account: string): PreparedProbeCoverage | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const rows = selectOwnedProbes(db, probeReadContext(db), provider, account,
    { where: "p.used_percent IS NOT NULL AND (p.ok IS NULL OR p.ok=1)", columns: "p.id,p.ts,p.resets_at,p.plan" });
  const result: PreparedProbeCoverage = { first_at: null, last_at: null, samples: 0, reset_samples: 0, plan_samples: 0, visitedBuckets: 0 };
  const days = new Set<string>();
  for (const { row, at } of rows) {
    days.add(new Date(at).toISOString().slice(0, 10));
    result.samples++;
    if (hasText(row.resets_at)) result.reset_samples++;
    if (hasText(row.plan)) result.plan_samples++;
    if (!result.first_at || row.ts < result.first_at) result.first_at = row.ts;
    if (!result.last_at || row.ts > result.last_at) result.last_at = row.ts;
  }
  if (days.size > 20_000) throw new ProbeAccountReadLimitExceeded();
  result.visitedBuckets = days.size;
  return result;
}

type KeyTime = "collection" | "accounting" | "claude-observation";
/** The stored instant (`probe_sources`) a reader bounds and orders by; a reading without it is left out. */
const KEY_COLUMN: Record<KeyTime, ProbeKeyColumn> = { collection: "at", accounting: "accounting_at", "claude-observation": "observation_at" };
/**
 * Readings keyed by collection, accounting or Claude observation time within `[since, until)`
 * (observation: `until`'s millisecond included), each through its own index.
 */
/** A reading predicate (alias p for probe_windows) applied inside the indexed read. */
export type ProbeRowFilter = Pick<OwnedProbeSelect, "where" | "params">;
function timeSelect(since: string | null, until: string | null, time: KeyTime): OwnedProbeSelect {
  const lower = since === null ? -Infinity : Date.parse(since);
  const upper = until === null ? Infinity : Date.parse(until) + (time === "claude-observation" ? 1 : 0);
  const key = KEY_COLUMN[time];
  return key === "at" ? { from: lower, until: upper } : { key, keyFrom: lower, keyUntil: upper };
}
function readByTime(db: Database, provider: string, account: string, since: string | null, until: string | null, time: KeyTime,
  filter: ProbeRowFilter = {}): ProbeAccountRow[] {
  return selectOwnedProbes(db, probeReadContext(db), provider, account, { ...filter, ...timeSelect(since, until, time) }).map(item => item.row);
}

/**
 * A few columns of every reading of an account range, for a catalogue such as a report's counters.
 * Unbounded like the cadence and coverage readers: the caller keeps only a small distinct result.
 */
export function readPreparedProbeAccountCatalogue(db: Database, provider: string, account: string,
  since: string | null, until: string | null, time: KeyTime, select: ProbeRowFilter & { columns: string }): ProbeAccountRow[] | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  return selectOwnedProbes(db, probeReadContext(db), provider, account, { ...select, ...timeSelect(since, until, time) }).map(item => item.row);
}

/**
 * Bounded account/time range. Overflow is unavailable, never a truncated accounting history.
 * `filter` keeps readings the caller would discard out of the bound.
 */
export function readPreparedProbeAccountRange(db: Database, provider: string, account: string,
  since: string | null, until: string | null, limit = 20_000, time: KeyTime = "collection", filter?: ProbeRowFilter): ProbeAccountRead | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(20_000, Math.floor(limit))) : 20_000;
  const rows = readByTime(db, provider, account, since, until, time, filter);
  if (rows.length > cap) throw new ProbeAccountReadLimitExceeded();
  return { rows, visitedKeys: rows.length };
}

/** Complete history (or the part between two key times) for background preparation, in one read snapshot. */
export function readPreparedProbeAccountHistory(db: Database, provider: string, account: string,
  since: string | null = null, until: string | null = null, time: "collection" | "accounting" = "collection"): ProbeAccountRead | null {
  const read = () => {
    if (!preparedProbeAccountIndexReady(db)) return null;
    const rows = readByTime(db, provider, account, since, until, time);
    return { rows, visitedKeys: rows.length };
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}

/** All of an account's readings, oldest collection first, each with its stored Claude observation instant. */
export interface ProbeAccountReadings { rows: ProbeAccountRow[]; observation: Map<number, number | null> }
/**
 * One read of the account's readings in one snapshot, for a report that would otherwise read the same
 * history several times (newest rows, limit samples, observations); `readingsByObservation` and the
 * newest-first order give what those readers return.
 */
export function readPreparedProbeAccountReadings(db: Database, provider: string, account: string,
  selection: OwnedProbeSelect = {}): ProbeAccountReadings | null {
  const read = () => {
    if (!preparedProbeAccountIndexReady(db)) return null;
    const observation = new Map<number, number | null>();
    const rows = selectOwnedProbes(db, probeReadContext(db), provider, account, { ...selection, columns: "p.*, s.observation_at AS __observation" })
      .map(({ row }) => {
        const { __observation, ...reading } = row as ProbeAccountRow & { __observation: number | null };
        observation.set(reading.id, __observation);
        return reading as ProbeAccountRow;
      });
    return { rows, observation };
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}
/** `readPreparedProbeAccountRange(…, "claude-observation")` over readings already read: the same rows in the same order. */
export function readingsByObservation(readings: ProbeAccountReadings, since: string | null, until: string | null, limit = 20_000): ProbeAccountRead {
  const safe = (value: number) => Number.isFinite(value) ? value : value < 0 ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  const lower = safe(since === null ? -Infinity : Date.parse(since)), upper = safe(until === null ? Infinity : Date.parse(until) + 1);
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(20_000, Math.floor(limit))) : 20_000;
  const rows = readings.rows.filter(row => { const key = readings.observation.get(row.id); return key != null && key >= lower && key < upper; })
    .sort((a, b) => readings.observation.get(a.id)! - readings.observation.get(b.id)! || a.id - b.id);
  if (rows.length > cap) throw new ProbeAccountReadLimitExceeded();
  return { rows, visitedKeys: rows.length };
}

/** The first and last accounting instants of an account, or null when it has none. */
export function preparedProbeAccountingSpan(db: Database, provider: string, account: string): { first: string; last: string } | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const context = probeReadContext(db);
  const edgeKey = (order: "asc" | "desc") => selectOwnedProbes(db, context, provider, account,
    { key: "accounting_at", order, limit: 1, columns: "p.id" })[0]?.key;
  const first = edgeKey("asc"), last = edgeKey("desc");
  return first !== undefined && last !== undefined ? { first: new Date(first).toISOString(), last: new Date(last).toISOString() } : null;
}

/**
 * A stamp of the account's readings whose accounting instants can fall in `[since, until)`: it moves
 * with every reading written, corrected, removed or moved between accounts there.
 */
export function readPreparedProbeAccountingRevision(db: Database, provider: string, account: string,
  since: string, until: string): [string | null, Array<[string, number]>] | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const lower = Date.parse(since), upper = Date.parse(until), context = probeReadContext(db);
  const rows = [...new Map((["accounting_at", "observation_at"] as const).flatMap(key => selectOwnedProbes(db, context, provider, account,
    { key, keyFrom: lower, keyUntil: upper, columns: "p.id,s.revision AS revision" })).map(item => [item.row.id, item])).values()];
  let revisions = 0, newest = 0;
  for (const { row } of rows) {
    const value = row.revision as number;
    revisions += value; newest = Math.max(newest, value);
  }
  return [String(newest), [["readings", rows.length], ["revisions", revisions]]];
}

/** One indexed read per clock/source range serves every overlapping calibration cohort. */
export function readPreparedProbeAccountingRevisions(db: Database, provider: string, account: string,
  ranges: ReadonlyArray<readonly [string, string]>): Array<ReturnType<typeof readPreparedProbeAccountingRevision>> {
  if (!ranges.length) return [];
  if (!preparedProbeAccountIndexReady(db)) return ranges.map(() => null);
  const bounds = ranges.map(([since, until]) => [Date.parse(since), Date.parse(until)] as const);
  const lower = Math.min(...bounds.map(([from]) => from)), upper = Math.max(...bounds.map(([, until]) => until));
  const context = probeReadContext(db);
  const clocks = (["accounting_at", "observation_at"] as const).map(key => selectOwnedProbes(db, context, provider, account,
    { key, keyFrom: lower, keyUntil: upper, columns: "p.id,s.revision AS revision" }));
  return bounds.map(([from, until]) => {
    const rows = new Map<number, OwnedProbe>();
    for (const clock of clocks) for (const item of clock)
      if (item.key >= from && item.key < until) rows.set(item.row.id, item);
    let revisions = 0, newest = 0;
    for (const { row } of rows.values()) {
      const value = row.revision as number;
      revisions += value; newest = Math.max(newest, value);
    }
    return [String(newest), [["readings", rows.size], ["revisions", revisions]]];
  });
}

export interface PreparedProbeProfileHealth {
  provider: string; account: string | null; machine: string | null; profile: string | null;
  success: ProbeAccountRow | null; failure: ProbeAccountRow | null; preparing: boolean;
}

/**
 * Every physical profile of every provider with its newest success and failure; unowned readings
 * included. Per physical tuple, the time line of its source splits into the accounts' ranges and the
 * uncovered rest; each part needs two newest-reading lookups. Readings whose evidence names no
 * single tuple (no profile, disputed deliveries, no instant) are resolved one by one.
 */
export function readPreparedProbeProfileHealth(db: Database): PreparedProbeProfileHealth[] | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  const context = probeReadContext(db), entries = new Map<string, PreparedProbeProfileHealth>();
  const newer = (a: ProbeAccountRow | null, b: ProbeAccountRow) => !a || b.ts > a.ts || b.ts === a.ts && b.id > a.id;
  const record = (provider: string, account: string | null, machine: string | null, profile: string | null, row: ProbeAccountRow) => {
    const key = `${provider}\u0000${account ?? ""}\u0000${JSON.stringify([machine, profile])}`;
    const entry = entries.get(key) ?? { provider, account, machine, profile, success: null, failure: null, preparing: false };
    if (row.ok === 0) { if (newer(entry.failure, row)) entry.failure = row; }
    else if (newer(entry.success, row)) entry.success = row;
    entries.set(key, entry);
  };
  const rowHome = (row: ProbeAccountRow) => {
    try {
      const value = JSON.parse((row.extra as string | null) ?? "null") as { home?: unknown } | null;
      return typeof value?.home === "string" ? value.home : null;
    } catch { return null; }
  };
  const bound = (value: number) => Number.isFinite(value) ? value : value < 0 ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  const providers = (db.query("SELECT DISTINCT provider FROM probe_source_tuples ORDER BY provider").all() as Array<{ provider: string }>)
    .map(row => row.provider);
  for (const provider of providers) {
    const owned = context.resolver.accounts(provider).flatMap(account => context.resolver.plan(provider, account).ranges
      .map(range => ({ from: range.from, until: range.until, source: range.source, account: account as string | null })));
    for (const tuple of probeTuples(db, provider)) {
      const resolved = sourceOfProbeTuple(provider, tuple as ProbeSourceTuple, context.options);
      const source = resolved && normEraKey(resolved);
      const parts = owned.filter(range => range.source === source).sort((a, b) => a.from - b.from);
      // The uncovered rest of the time line belongs to no account.
      let cursor = -Infinity;
      for (const part of [...parts]) {
        if (part.from > cursor) parts.push({ source: source ?? "", from: cursor, until: part.from, account: null });
        cursor = Math.max(cursor, part.until);
      }
      if (cursor < Infinity) parts.push({ source: source ?? "", from: cursor, until: Infinity, account: null });
      // A machine-only tuple (GLM) leaves the profile to each reading's own computer and folder.
      const fixed = tuple.home !== "";
      for (const part of parts) {
        const from = bound(part.from), until = bound(part.until);
        const groups = fixed ? [{ machine: tuple.machine as string | null, home: tuple.home as string | null }]
          : db.query(`SELECT DISTINCT p.machine AS machine, ${HOME} AS home FROM probe_sources s JOIN probe_windows p ON p.id=s.probe_id
              WHERE s.provider=? AND s.machine=? AND s.home=? AND s.login=? AND s.basis IN ('projection','matched') AND s.tuples=1
                AND s.at>=? AND s.at<?`)
            .all(provider, tuple.machine, tuple.home, tuple.login, from, until) as Array<{ machine: string | null; home: string | null }>;
        for (const group of groups) {
          const profile = fixed ? "" : ` AND p.machine IS ? AND ${HOME} IS ?`;
          for (const outcome of ["(p.ok IS NULL OR p.ok<>0)", "p.ok=0"]) {
            const row = db.query(`SELECT p.* FROM probe_sources s JOIN probe_windows p ON p.id=s.probe_id
              WHERE s.provider=? AND s.machine=? AND s.home=? AND s.login=? AND s.basis IN ('projection','matched') AND s.tuples=1
                AND s.at>=? AND s.at<? AND ${outcome}${profile} ORDER BY s.at DESC, s.probe_id DESC LIMIT 1`)
              .get(provider, tuple.machine, tuple.home, tuple.login, from, until, ...(fixed ? [] : [group.machine, group.home])) as ProbeAccountRow | null;
            if (row) record(provider, part.account, group.machine, group.home, row);
          }
        }
      }
    }
  }
  // Readings without a single tuple or instant: resolved one by one, profiled by their own computer and folder.
  const single = db.query(`SELECT p.*, s.provider AS __provider FROM probe_sources s JOIN probe_windows p ON p.id=s.probe_id
    WHERE (s.machine IS NULL OR s.tuples<>1 OR s.at IS NULL) AND s.ord=0`).all() as Array<ProbeAccountRow & { __provider: string }>;
  for (const { __provider: provider, ...row } of single) {
    const evidence = readProbeEvidence(db, row.id);
    const account = ownerOfStoredEvidence(context, evidence);
    const tuples = SOURCED.includes(evidence[0]!.basis) ? evidence.filter(item => item.machine !== null && item.home) : [];
    const profiles = tuples.length ? tuples.map(item => ({ machine: item.machine, home: item.home }))
      : [{ machine: (row.machine ?? null) as string | null, home: rowHome(row as ProbeAccountRow) }];
    for (const profile of profiles) record(provider, account, profile.machine, profile.home, row as ProbeAccountRow);
  }
  if (entries.size > 4096) return null;
  return [...entries.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => entry);
}

/** One page of an account's readings of `[from, until)` after `(at, id)`, oldest first: the projection writer folds by such pages. */
export function readOwnedProbePage(db: Database, context: ProbeReadContext, provider: string, account: string,
  range: { after: { at: number; id: number } | null; from?: number; until?: number }, limit: number, columns?: string): OwnedProbe[] {
  const { after } = range;
  return selectOwnedProbes(db, context, provider, account, {
    from: after ? Math.max(after.at, range.from ?? -Infinity) : range.from, until: range.until, limit, columns,
    ...(after ? { where: "(s.at>? OR (s.at=? AND s.probe_id>?))", params: [after.at, after.at, after.id] } : {}) });
}

/** The first accounting instant at or after `from` (ms) of an account's readings, or null. */
export function nextPreparedProbeAccountingTime(db: Database, provider: string, account: string, from: number): number | null {
  if (!preparedProbeAccountIndexReady(db)) return null;
  return selectOwnedProbes(db, probeReadContext(db), provider, account, { key: "accounting_at", keyFrom: from, limit: 1, columns: "p.id" })[0]?.key ?? null;
}
