import { createHash } from "node:crypto";
import { CODEX_WINDOW_MINUTES } from "../shared/codex-counters";
import type { Database } from "bun:sqlite";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import type { SourceDeclaration } from "./archive-source";
import { loadAccountResolver, type AccountResolver, type IdentityDeclaration } from "./account-resolver";
import { codexAccountSelector } from "./codex-source-account";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import type { DatedPeriod } from "./account-periods";
import { loadCycles, type CyclesConfig } from "./cycles";
import { readManualCapacity } from "./manual-capacity";
import { nextPreparedProbeAccountingTime, preparedProbeAccountingSpan, readPreparedProbeAccountHistory, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { codexLimitCounter, codexLimitReadings, loadCodexLimitProbes, type CodexFileModelCache } from "./codex-limit-windows";
import {
  acceptLimitHits, buildProbeLimitWindows, counterReadings, loadProbeLimitEvidence, ownedLimitHitRows, probeLimitCounter,
  probeLimitSamples, resolveSegment, segmentationInputs,
  RESET_JOIN_MS, segmentReadings, segmentClaudeReadings, windowResolution, withLimitHits, type ProbeLimitReading, type ProbeLimitWindow, type RawSegment,
  type SegmentInput, type SegmenterState, type WindowResolution,
} from "./probe-limit-windows";
import { markWindowUsageDirty } from "../db/window-usage";
import { markWindowAnswersDirty } from "../db/window-answers";
import { dropWindowEndEstimate } from "../db/window-end-estimates";
import {
  ALL_ACCOUNTS, ensureLimitWindowSchema, LIMIT_WINDOW_ALL, limitWindowScope, markLimitWindowsDirty, type LimitWindowRow,
} from "../db/limit-windows";
import { limitHitTableOf, usageProviderIds } from "./subscription-accounting-adapters";

/**
 * Producer of `limit_windows` (plan U1.1), run by the analysis maintenance worker.
 *
 * Work is ordered by writers: the probe projection, the Codex and Claude publications, the period store
 * and (for configuration files) this worker's own digest check enqueue `limit_window_dirty`. Deciding
 * whether work exists reads only that queue and `limit_window_state`; never readings or events.
 *
 * Each scope (Codex: account and counter; others: account) recomputes its segmentation inputs from the
 * earliest changed reading (`inputs_from`) in bounded, chronological slices, and stores them in
 * `limit_window_inputs`. Only when the inputs are complete is segmentation resumed from the last window
 * whose final reading precedes the earliest changed input, and the windows replaced atomically. Readers
 * meanwhile keep the previous complete windows.
 *
 * Bounded lookback. Reconciliation of Codex readings judges a reading group with other groups whose
 * reading spans or nominal windows overlap it, and joins readings by resets within 120 s; Claude refusals
 * join the samples of their reset. All reading times lie within [reset - lead_max, reset - lead_min] of
 * their reset, so a change at T can only alter groups whose reset is at least T - lead_max - margins, and
 * those groups only depend on readings from about T - 3 lead_max on. A chain check on the loaded group
 * anchors proves that no group of interest can be joined by readings outside the loaded range; otherwise
 * the range is widened. The bounds are recorded per scope from every reading the producer has loaded.
 */
export const LIMIT_WINDOW_VERSION = 1;
const CODEX_MINUTES = CODEX_WINDOW_MINUTES;
const MINUTE = 60_000, DAY = 86_400_000;
/**
 * Readings per recomputation step: eight weeks. Each slice also reads about three lead times before it, so a
 * long recomputation (a first fill) in week-long slices read most readings four times; on the full reference a
 * first fill took 127 s in 7-day slices, 39 s as one region and 20 s in 8-week slices, the longest step 6 s.
 */
const SLICE_MS = 56 * DAY;
const JOIN_MS = RESET_JOIN_MS;
const MARGIN_MS = 600_000;
/** Input rows per write transaction; keeps each transaction well under a second. */
const WRITE_BATCH = 2_000;

export interface LimitWindowProducerStats {
  /** Prepared probe rows, session rows and transcript model lookups read from sources. */
  probeRows: number; sessionRows: number; files: number; hitRows: number;
  /** Stored inputs read back for diffing or segmentation, and windows written. */
  inputRows: number; windowsWritten: number;
  slices: number; segmentations: number; resolutions: number;
  /** Longest single step (computation and its write) and its longest write transaction, in ms. */
  slowestStep: { ms: number; step: string }; slowestWriteMs: number;
}
export const emptyLimitWindowStats = (): LimitWindowProducerStats => ({ probeRows: 0, sessionRows: 0, files: 0, hitRows: 0,
  inputRows: 0, windowsWritten: 0, slices: 0, segmentations: 0, resolutions: 0, slowestStep: { ms: 0, step: "" }, slowestWriteMs: 0 });
/** One write transaction of a step, timed. */
function write(db: Database, stats: LimitWindowProducerStats, body: () => void): void {
  const started = performance.now();
  db.transaction(body).immediate();
  stats.slowestWriteMs = Math.max(stats.slowestWriteMs, performance.now() - started);
}

export interface LimitWindowProducerOptions {
  sources: readonly SourceDeclaration[];
  subscriptions?: readonly IdentityDeclaration[];
  cycles?: CyclesConfig;
  /** Manual measurements of a provider; defaults to the provider's measurement file. */
  manualCapacity?: (provider: string) => readonly ManualCapacityMeasurement[];
  /** Time a call may use; it always completes at least one step when work exists. */
  budgetMs?: number;
  sliceMs?: number;
  /** Re-checked before every write; false stops the call (a sync run owns the writer). */
  canWrite?: () => boolean;
  stats?: LimitWindowProducerStats;
}

interface State {
  provider: string; account: string; scope: string; version: number; status: "filling" | "ready";
  lead_max: number | null; lead_min: number | null; inputs_from: number | null; changed_from: number | null;
  resolve: number; revision: number;
}
interface InputRow {
  provider: string; account: string; scope: string; counter: string; ts: string; grp: string; ord: number; used_percent: number;
  resets_at: string; window_minutes: number; source: string; limit_hit: string | null; anchor: number;
  home: string | null; path: string | null;
  source_plan: string | null;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const measurementsOf = (options: LimitWindowProducerOptions, provider: string): readonly ManualCapacityMeasurement[] => {
  if (options.manualCapacity) return options.manualCapacity(provider);
  try { return readManualCapacity(provider).measurements; } catch { return []; }
};
const metaValue = (db: Database, key: string) => {
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  return (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value ?? null;
};
const putMeta = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);

/** Codex session readings (`ratelimit` with its counter columns); a partial schema has none to read. */
function hasCodexSessionReadings(db: Database): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ratelimit'").get()) return false;
  const columns = new Set((db.query("PRAGMA table_info(ratelimit)").all() as Array<{ name: string }>).map(column => column.name));
  return columns.has("limit_id") && columns.has("window_minutes");
}

/** Configuration inputs without a database writer: the worker enqueues their changes itself. */
function enqueueConfigChanges(db: Database, options: LimitWindowProducerOptions, cycles: CyclesConfig): void {
  // Identity declarations feed every provider's resolver; source declarations only the Codex transcript owner.
  const resolverConfig = digest(options.subscriptions ?? []);
  const codexSources = digest(options.sources.filter(source => (source.vendor ?? "codex").toLowerCase() === "codex")
    .map(source => [source.machine ?? "", source.home ?? "", source.source_home ?? "", (source as { id?: string }).id ?? ""]));
  const codexMerged = CODEX_MINUTES.filter(minutes => minutes !== 43200).map(minutes => hasCodexSessionReadings(db)
    && !!db.query("SELECT 1 FROM ratelimit WHERE limit_id='codex' AND window_minutes=? LIMIT 1").get(minutes));
  const checks: Array<[string, string, () => void]> = [
    ["limit_windows_version", String(LIMIT_WINDOW_VERSION), () => { for (const provider of usageProviderIds()) markLimitWindowsDirty(db, provider, ALL_ACCOUNTS, LIMIT_WINDOW_ALL); }],
    ["limit_windows_resolver", resolverConfig, () => { for (const provider of usageProviderIds()) markLimitWindowsDirty(db, provider, ALL_ACCOUNTS, LIMIT_WINDOW_ALL); }],
    ["limit_windows_codex_sources", codexSources, () => markLimitWindowsDirty(db, "codex", ALL_ACCOUNTS, LIMIT_WINDOW_ALL)],
    ["limit_windows_codex_source_plan", "1", () => markLimitWindowsDirty(db, "codex", ALL_ACCOUNTS, LIMIT_WINDOW_ALL)],
    ["limit_windows_claude_activity", "1", () => markLimitWindowsDirty(db, "claude", ALL_ACCOUNTS, LIMIT_WINDOW_ALL)],
    // Cadence declarations name counters of probe readings; Codex counters do not use them.
    ["limit_windows_cycles", digest(cycles.windows ?? []), () => { for (const provider of usageProviderIds())
      if (provider !== "codex") markLimitWindowsDirty(db, provider, ALL_ACCOUNTS, LIMIT_WINDOW_ALL); }],
    // A first session reading of a Codex counter makes its periodic readings subject to reconciliation.
    ["limit_windows_codex_merged", JSON.stringify(codexMerged), () => markLimitWindowsDirty(db, "codex", ALL_ACCOUNTS, LIMIT_WINDOW_ALL)],
    // Adding the 30-day scope must retain completed 5h/weekly windows and sums.
    ["limit_windows_codex_merged:43200", String(hasCodexSessionReadings(db)
      && !!db.query("SELECT 1 FROM ratelimit WHERE limit_id='codex' AND window_minutes=43200 LIMIT 1").get()), () => {
      db.query("UPDATE limit_window_state SET inputs_from=? WHERE provider='codex' AND scope=?")
        .run(LIMIT_WINDOW_ALL, codexLimitCounter(43200));
    }],
  ];
  for (const provider of usageProviderIds()) {
    const measurements = [...measurementsOf(options, provider)];
    const key = `limit_windows_manual:${provider}`;
    checks.push([key, JSON.stringify(measurements), () => {
      const previous = JSON.parse(metaValue(db, key) ?? "[]") as ManualCapacityMeasurement[];
      const before = new Map(previous.map(m => [m.id, JSON.stringify(m)])), after = new Map(measurements.map(m => [m.id, JSON.stringify(m)]));
      const changed = [...previous.filter(m => after.get(m.id) !== before.get(m.id)), ...measurements.filter(m => before.get(m.id) !== after.get(m.id))];
      for (const measurement of changed) {
        markLimitWindowsDirty(db, provider, measurement.account, LIMIT_WINDOW_ALL, "resolve");
        // Codex keeps an otherwise empty reading group only for a measurement inside its window.
        if (provider === "codex") markLimitWindowsDirty(db, provider, measurement.account, Date.parse(measurement.start) - 8 * DAY);
      }
    }]);
  }
  const stale = checks.filter(([key, value]) => metaValue(db, key) !== value);
  if (!stale.length) return;
  db.transaction(() => {
    for (const [key, value, enqueue] of stale) {
      if (metaValue(db, key) !== null || !key.startsWith("limit_windows_manual:")) enqueue();
      putMeta(db, key, value);
    }
  }).immediate();
}

function scopesOf(provider: string): string[] {
  return provider === "codex" ? CODEX_MINUTES.map(minutes => codexLimitCounter(minutes)) : ["*"];
}

/** State rows for every account a period names, and the provider marker readers use for unknown accounts. */
function discover(db: Database, resolver: AccountResolver): void {
  const insert = db.query(`INSERT INTO limit_window_state(provider,account,scope,version,status,inputs_from)
    VALUES(?,?,?,?,'filling',?) ON CONFLICT(provider,account,scope) DO NOTHING`);
  const missing: Array<[string, string, string]> = [];
  for (const provider of usageProviderIds()) {
    for (const account of resolver.accounts(provider)) for (const scope of scopesOf(provider))
      if (!db.query("SELECT 1 FROM limit_window_state WHERE provider=? AND account=? AND scope=?").get(provider, account.toLowerCase(), scope))
        missing.push([provider, account.toLowerCase(), scope]);
    if (!db.query("SELECT 1 FROM limit_window_state WHERE provider=? AND account='' AND scope=''").get(provider)) missing.push([provider, "", ""]);
  }
  if (!missing.length) return;
  db.transaction(() => {
    for (const [provider, account, scope] of missing) {
      if (account === "") db.query(`INSERT INTO limit_window_state(provider,account,scope,version,status)
        VALUES(?,'','',?,'ready') ON CONFLICT DO NOTHING`).run(provider, LIMIT_WINDOW_VERSION);
      else insert.run(provider, account, scope, LIMIT_WINDOW_VERSION, LIMIT_WINDOW_ALL);
    }
  }).immediate();
}

/** Moves queued writer entries into scope work, atomically per entry; a newer entry is kept for later. */
function applyDirty(db: Database, ownerAt: () => (home: string, ts: string) => string | null): void {
  const entries = db.query("SELECT provider,account,kind,from_ms,sequence FROM limit_window_dirty").all() as
    Array<{ provider: string; account: string; kind: "inputs" | "resolve" | "file"; from_ms: number; sequence: number }>;
  if (!entries.length) return;
  const hasRatelimit = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ratelimit'").get();
  db.transaction(() => {
    for (const entry of entries) {
      // A transcript's readings reach only the accounts that own them (by home and time, as `loadCodexLimitProbes`
      // resolves them) or owned them when the inputs were stored; each resumes from its own first reading of the file.
      const targets: Array<{ provider: string; account: string; from: number; kind: "inputs" | "resolve" }> = [];
      if (entry.kind === "file") {
        const [home, path] = JSON.parse(entry.account) as [string, string];
        fileModels.get(db)?.delete(entry.account);
        const firstOf = new Map<string, number>();
        const note = (account: string | null, ts: string) => {
          const at = Date.parse(ts);
          if (!account || !Number.isFinite(at)) return;
          const key = account.toLowerCase();
          firstOf.set(key, Math.min(firstOf.get(key) ?? at, at));
        };
        if (hasRatelimit) {
          const owner = ownerAt();
          for (const row of db.query("SELECT ts FROM ratelimit WHERE home=? AND path=? AND limit_id='codex'").all(home, path) as Array<{ ts: string }>)
            note(owner(home, row.ts), row.ts);
        }
        for (const row of db.query("SELECT account, MIN(ts) AS ts FROM limit_window_inputs WHERE home=? AND path=? GROUP BY account")
          .all(home, path) as Array<{ account: string; ts: string }>) note(row.account, row.ts);
        for (const [account, from] of firstOf) targets.push({ provider: "codex", account, from, kind: "inputs" });
      } else targets.push({ provider: entry.provider, account: entry.account, from: entry.from_ms, kind: entry.kind });
      for (const { provider, account, from, kind } of targets) if (Number.isFinite(from)) {
        if (account !== ALL_ACCOUNTS) for (const scope of scopesOf(provider))
          db.query(`INSERT INTO limit_window_state(provider,account,scope,version,status,inputs_from) VALUES(?,?,?,?,'filling',?)
            ON CONFLICT DO NOTHING`).run(provider, account, scope, LIMIT_WINDOW_VERSION, LIMIT_WINDOW_ALL);
        const where = account === ALL_ACCOUNTS ? "provider=? AND account<>''" : "provider=? AND account=?";
        const params = account === ALL_ACCOUNTS ? [provider] : [provider, account];
        if (kind === "resolve") db.query(`UPDATE limit_window_state SET resolve=1 WHERE ${where}`).run(...params);
        else db.query(`UPDATE limit_window_state SET inputs_from=MIN(COALESCE(inputs_from,?),?) WHERE ${where}`).run(from, from, ...params);
      }
      db.query("DELETE FROM limit_window_dirty WHERE provider=? AND account=? AND kind=? AND sequence=?")
        .run(entry.provider, entry.account, entry.kind, entry.sequence);
    }
  }).immediate();
}

/** Group anchors that readings before `loadedFrom` might join: resets reachable from that range in 240 s steps. */
function earliestExactAnchor(anchors: readonly number[], loadedFrom: number | null, leadMax: number): number {
  if (loadedFrom === null) return -Infinity;
  let reach = loadedFrom + leadMax + 2 * JOIN_MS;
  for (const anchor of [...anchors].sort((a, b) => a - b)) {
    if (anchor < reach) reach = Math.max(reach, anchor + 2 * JOIN_MS);
    else break;
  }
  return reach;
}

interface Region { cut: number; rows: InputRow[]; leadMax: number | null; leadMin: number | null }

const fileModels = new WeakMap<Database, CodexFileModelCache>();
/** Per connection; bounded so a long-running worker does not grow without limit. */
function fileModelCache(db: Database): CodexFileModelCache {
  let cache = fileModels.get(db);
  if (!cache || cache.size > 200_000) fileModels.set(db, cache = new Map());
  return cache;
}

function codexRegion(db: Database, state: State, resolver: AccountResolver, options: LimitWindowProducerOptions,
  T: number, until: number | null, stats: LimitWindowProducerStats): Region | null {
  const minutes = JSON.parse(state.scope)[2] as 300 | 10080 | 43200;
  const leadMax = Math.max(state.lead_max ?? 0, minutes * MINUTE), leadMin = Math.min(state.lead_min ?? 0, 0);
  // Groups whose output can change: reset at or after `cut`. Their reconciliation needs readings from `from`.
  let cut = T === LIMIT_WINDOW_ALL ? -Infinity : T - leadMax + 2 * leadMin - 2 * JOIN_MS - MARGIN_MS;
  for (let attempt = 0; ; attempt++) {
    const dependsFrom = cut - 4 * JOIN_MS - leadMax + leadMin;
    const from = cut === -Infinity || attempt > 4 ? null : dependsFrom - leadMax - 2 * JOIN_MS - MARGIN_MS;
    const loaded = loadCodexLimitProbes({ sqlite: db, resolver, account: state.account, minutes, sources: options.sources,
      measurements: measurementsOf(options, "codex") }, { from, until }, fileModelCache(db));
    stats.probeRows += loaded.read.periodic; stats.sessionRows += loaded.read.sessions; stats.files += loaded.read.files;
    if (from !== null && earliestExactAnchor(loaded.anchors, from, Math.max(leadMax, loaded.leadMax ?? 0)) > dependsFrom) {
      cut -= leadMax;
      continue;
    }
    const keep = loaded.probes.map((probe, index) => ({ probe, order: loaded.order[index]! }))
      .filter(item => Date.parse(item.probe.resets_at!) >= cut);
    // Group, place and session origin travel with each reading (segmentationInputs keeps extra fields).
    const readings = codexLimitReadings(keep.map(item => item.probe), minutes).map((reading, index) => ({ ...reading,
      group: keep[index]!.order.group, place: keep[index]!.order.index, home: keep[index]!.probe.home ?? null, path: keep[index]!.probe.path ?? null }));
    const rows = segmentationInputs(readings).map(input => {
      const origin = input as SegmentInput & { group: string; place: number; home: string | null; path: string | null };
      return toRow(state, state.scope, { ...input, grp: origin.group, ord: origin.place }, Date.parse(input.resets_at), origin.home, origin.path);
    });
    return { cut, rows, leadMax: loaded.leadMax, leadMin: loaded.leadMin };
  }
}

function toRow(state: State, counter: string, input: SegmentInput, anchor: number, home: string | null, path: string | null): InputRow {
  return { provider: state.provider, account: state.account, scope: state.scope, counter, ts: input.ts, grp: input.grp ?? "", ord: input.ord,
    used_percent: input.used_percent, resets_at: input.resets_at, window_minutes: input.window_minutes,
    source: input.source ?? "probe", limit_hit: input.limit_hit ? JSON.stringify(input.limit_hit) : null, anchor, home, path,
    source_plan: state.provider === "codex" || state.provider === "claude" ? input.plan ?? null : null };
}

function evidenceRegion(db: Database, state: State, resolver: AccountResolver, cycles: CyclesConfig,
  T: number, until: number | null, stats: LimitWindowProducerStats): Region | null {
  // A provider that records refusals (calls refused at 100%) reads them beside its readings.
  const refusals = limitHitTableOf(state.provider) !== undefined;
  const leadMax = Math.max(state.lead_max ?? 0, 10080 * MINUTE), leadMin = Math.min(state.lead_min ?? 0, 0);
  // Samples are local readings; only refusals depend on the samples of their reset.
  let cut = T === LIMIT_WINDOW_ALL ? -Infinity : refusals ? T - leadMax + 2 * leadMin - 3 * JOIN_MS - MARGIN_MS : T;
  for (let attempt = 0; ; attempt++) {
    const dependsFrom = cut - 2 * JOIN_MS;
    const from = cut === -Infinity || attempt > 4 ? null : refusals ? dependsFrom - leadMax - 2 * JOIN_MS - MARGIN_MS : cut;
    const iso = (value: number) => new Date(value).toISOString();
    const prepared = readPreparedProbeAccountHistory(db, state.provider, state.account,
      from === null ? null : iso(from - DAY), until === null ? null : iso(until + DAY), "accounting");
    if (!prepared) throw new ProbeAccountIndexUnavailable();
    stats.probeRows += prepared.rows.length;
    const inRange = (ts: string) => { const at = Date.parse(ts); return (from === null || at >= from) && (until === null || at < until); };
    const samples = probeLimitSamples(prepared.rows, state.provider).filter(sample => inRange(sample.ts));
    const hitRows = refusals ? ownedLimitHitRows(db, state.provider, state.account, resolver,
      from === null && until === null ? undefined : { from: from === null ? "" : iso(from - DAY), until: until === null ? "\uffff" : iso(until + DAY) })
      .filter(row => inRange(row.ts)) : [];
    stats.hitRows += hitRows.length;
    const leads = [...samples.filter(sample => sample.resets_at != null).map(sample => Date.parse(sample.resets_at!) - Date.parse(sample.ts)),
      ...hitRows.map(row => Date.parse(row.resets_at) - Date.parse(row.ts))].filter(Number.isFinite);
    if (refusals && from !== null) {
      const resets = [...samples.filter(sample => sample.resets_at != null).map(sample => Date.parse(sample.resets_at!)),
        ...hitRows.map(row => Date.parse(row.resets_at))].filter(Number.isFinite);
      if (earliestExactAnchor(resets, from, Math.max(leadMax, ...leads)) > dependsFrom) { cut -= leadMax; continue; }
    }
    const all = withLimitHits(samples, acceptLimitHits(state.provider, state.account, samples, hitRows));
    const byCounter = new Map<string, ProbeLimitReading[]>();
    for (const sample of all) {
      if (!sample.resets_at || sample.used_percent == null) continue;
      const counter = probeLimitCounter(sample, state.account, cycles);
      const readings = byCounter.get(counter) ?? [];
      readings.push({ ts: sample.ts, used_percent: sample.used_percent, resets_at: sample.resets_at,
        plan: sample.plan,
        window_minutes: JSON.parse(counter)[2] as number, source: sample.limitHit ? "limit_hit" : "probe",
        ...(sample.limitHit ? { limit_hit: { call_id: sample.limitHit.callId } } : {}) });
      byCounter.set(counter, readings);
    }
    const rows: InputRow[] = [];
    for (const [counter, readings] of byCounter) for (const input of segmentationInputs(readings)) {
      const anchor = Date.parse(input.ts);
      if (anchor >= cut) rows.push(toRow(state, counter, input, anchor, null, null));
    }
    return { cut, rows, leadMax: leads.length ? Math.max(...leads) : null, leadMin: leads.length ? Math.min(...leads) : null };
  }
}

const PAGE = 64;
/**
 * The earliest instant at or after `from` among rows read in text order from `start` (a day earlier: a text
 * time may carry an offset). Paged: a dense day holds more than a page of readings before `from`.
 */
function firstFrom(from: number, start: string, page: (after: string, first: boolean) => string[], instant: (text: string) => number): number | null {
  for (let after = start, first = true; ; first = false) {
    const texts = page(after, first);
    const later = texts.map(instant).filter(time => Number.isFinite(time) && time >= from);
    if (later.length) return Math.min(...later);
    if (texts.length < PAGE) return null;
    after = texts.at(-1)!;
  }
}

/** The provider's refusal table, when its adapter declares one and the database has it. */
function refusalTable(db: Database, provider: string): string | null {
  const table = limitHitTableOf(provider);
  return table && db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? table : null;
}

/** The first source reading of the scope at or after `from`, or null; index range reads only. */
function nextReading(db: Database, state: State, from: number): number | null {
  const iso = new Date(from - DAY).toISOString(), times: Array<number | null> = [];
  // Probe readings come from the stored source evidence, indexed by accounting instant: no paging needed.
  times.push(nextPreparedProbeAccountingTime(db, state.provider, state.account, from));
  if (state.provider === "codex" && hasCodexSessionReadings(db))
    times.push(firstFrom(from, iso, (after, first) => (db.query(`SELECT ts FROM ratelimit WHERE ts${first ? ">=" : ">"}? AND limit_id='codex'
      AND window_minutes=? ORDER BY ts LIMIT ${PAGE}`).all(after, JSON.parse(state.scope)[2] as number) as Array<{ ts: string }>).map(row => row.ts), Date.parse));
  const hits = refusalTable(db, state.provider);
  if (hits) times.push(firstFrom(from, iso, (after, first) => (db.query(`SELECT ts FROM ${hits} WHERE ts${first ? ">=" : ">"}? ORDER BY ts LIMIT ${PAGE}`)
      .all(after) as Array<{ ts: string }>).map(row => row.ts), Date.parse));
  const found = times.filter((time): time is number => time !== null);
  return found.length ? Math.min(...found) : null;
}

/** The instant range of an account's source readings, for slicing a recomputation. */
function dataSpan(db: Database, state: State): { first: number; last: number } | null {
  const times: number[] = [];
  const span = preparedProbeAccountingSpan(db, state.provider, state.account);
  if (span) times.push(Date.parse(span.first), Date.parse(span.last));
  if (state.provider === "codex" && hasCodexSessionReadings(db)) {
    const minutes = JSON.parse(state.scope)[2] as number;
    const row = db.query("SELECT MIN(ts) AS first, MAX(ts) AS last FROM ratelimit WHERE limit_id='codex' AND window_minutes=?")
      .get(minutes) as { first: string | null; last: string | null };
    if (row.first && row.last) times.push(Date.parse(row.first), Date.parse(row.last));
  }
  const hits = refusalTable(db, state.provider);
  if (hits) {
    const row = db.query(`SELECT MIN(ts) AS first, MAX(ts) AS last FROM ${hits}`).get() as { first: string | null; last: string | null };
    if (row.first && row.last) times.push(Date.parse(row.first), Date.parse(row.last));
  }
  const finite = times.filter(Number.isFinite);
  return finite.length ? { first: Math.min(...finite), last: Math.max(...finite) } : null;
}

const inputKey = (row: Pick<InputRow, "counter" | "ts" | "grp" | "ord">) => `${row.counter}\u0000${row.ts}\u0000${row.grp}\u0000${row.ord}`;
const inputValue = (row: InputRow) => JSON.stringify([row.used_percent, row.resets_at, row.window_minutes, row.source, row.limit_hit, row.anchor, row.source_plan]);

/** One bounded slice of a scope's input recomputation. */
function advanceInputs(db: Database, state: State, resolver: AccountResolver, cycles: CyclesConfig,
  options: LimitWindowProducerOptions, stats: LimitWindowProducerStats): void {
  const T = state.inputs_from!;
  const span = dataSpan(db, state);
  const sliceMs = options.sliceMs ?? SLICE_MS;
  const start = T === LIMIT_WINDOW_ALL ? span?.first ?? 0 : T;
  const until = !span || start + sliceMs > span.last ? null : start + sliceMs;
  const region = state.provider === "codex"
    ? codexRegion(db, state, resolver, options, T, until, stats)
    : evidenceRegion(db, state, resolver, cycles, T, until, stats);
  if (!region) return;
  const cutParam = region.cut === -Infinity ? LIMIT_WINDOW_ALL : Math.floor(region.cut);
  // The next slice continues with readings appended after `until`: with none in between, it can start at
  // the next reading (no stored input can lie in an empty stretch after this slice's own replacement).
  let resume = until;
  if (until !== null) { const next = nextReading(db, state, until); resume = next === null ? null : Math.max(until, next); }
  const old = db.query("SELECT * FROM limit_window_inputs WHERE provider=? AND account=? AND scope=? AND anchor>=?")
    .all(state.provider, state.account, state.scope, cutParam) as InputRow[];
  stats.inputRows += old.length;
  const before = new Map(old.map(row => [inputKey(row), row]));
  const after = new Map(region.rows.map(row => [inputKey(row), row]));
  const removed = old.filter(row => { const next = after.get(inputKey(row)); return !next || inputValue(next) !== inputValue(row)
    || next.home !== row.home || next.path !== row.path; });
  const added = region.rows.filter(row => { const prior = before.get(inputKey(row)); return !prior || inputValue(prior) !== inputValue(row)
    || prior.home !== row.home || prior.path !== row.path; });
  const changedTimes = [...old.filter(row => { const next = after.get(inputKey(row)); return !next || inputValue(next) !== inputValue(row); }),
    ...region.rows.filter(row => { const prior = before.get(inputKey(row)); return !prior || inputValue(prior) !== inputValue(row); })]
    .map(row => Date.parse(row.ts));
  if (options.canWrite && !options.canWrite()) return;
  const changedFrom = changedTimes.length ? Math.min(...changedTimes) : null;
  const where = [state.provider, state.account, state.scope];
  const recordChange = () => db.query(`UPDATE limit_window_state SET
    changed_from=CASE WHEN ? IS NULL THEN changed_from ELSE MIN(COALESCE(changed_from,?),?) END
    WHERE provider=? AND account=? AND scope=?`).run(changedFrom, changedFrom, changedFrom, ...where);
  const operations: Array<() => void> = [];
  const remove = db.query("DELETE FROM limit_window_inputs WHERE provider=? AND account=? AND scope=? AND counter=? AND ts=? AND grp=? AND ord=?");
  const insert = db.query(`INSERT INTO limit_window_inputs(provider,account,scope,counter,ts,grp,ord,used_percent,resets_at,window_minutes,
    source,limit_hit,anchor,home,path,source_plan) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of removed) operations.push(() => remove.run(row.provider, row.account, row.scope, row.counter, row.ts, row.grp, row.ord));
  for (const row of added) operations.push(() => insert.run(row.provider, row.account, row.scope, row.counter, row.ts, row.grp, row.ord,
    row.used_percent, row.resets_at, row.window_minutes, row.source, row.limit_hit, row.anchor, row.home, row.path, row.source_plan));
  // Large slices are written in several short transactions. The change is recorded first, so an interrupted
  // slice is recomputed (the cursor has not moved) and still segments from its earliest change.
  const batches = Math.max(1, Math.ceil(operations.length / WRITE_BATCH));
  for (let batch = 0; batch < batches; batch++) {
    if (batch > 0 && options.canWrite && !options.canWrite()) return;
    write(db, stats, () => {
      if (batch === 0) recordChange();
      for (const operation of operations.slice(batch * WRITE_BATCH, (batch + 1) * WRITE_BATCH)) operation();
      if (batch < batches - 1) return;
      // Queued changes enter the state only at the start of a turn (applyDirty), so the cursor is still T.
      db.query(`UPDATE limit_window_state SET inputs_from=?, version=?,
        lead_max=CASE WHEN ? IS NULL THEN lead_max ELSE MAX(COALESCE(lead_max,?),?) END,
        lead_min=CASE WHEN ? IS NULL THEN lead_min ELSE MIN(COALESCE(lead_min,?),?) END
        WHERE provider=? AND account=? AND scope=?`).run(resume, LIMIT_WINDOW_VERSION,
        region.leadMax, region.leadMax, region.leadMax, region.leadMin, region.leadMin, region.leadMin, ...where);
    });
  }
  stats.slices++;
}

function parseInput(row: InputRow): SegmentInput {
  return { ts: row.ts, grp: row.grp, ord: row.ord, used_percent: row.used_percent, resets_at: row.resets_at, window_minutes: row.window_minutes,
    source: row.source as SegmentInput["source"], ...(row.source_plan ? { plan: row.source_plan } : {}),
    ...(row.limit_hit ? { limit_hit: JSON.parse(row.limit_hit) as { call_id: string } } : {}) };
}

function windowRow(provider: string, seq: number, segment: RawSegment, window: ProbeLimitWindow): unknown[] {
  return [provider, segment.account, segment.counter, seq, window.id, window.start, window.end, window.reset, window.cycle_end_basis,
    window.window_minutes, window.plan, window.plan_detail ? JSON.stringify(window.plan_detail) : null,
    window.declared_plan_meter_mismatch ? 1 : 0, JSON.stringify(window.readings),
    window.manual_measurements ? JSON.stringify(window.manual_measurements) : null,
    window.startDrop ? JSON.stringify(window.startDrop) : null, window.endDrop ? JSON.stringify(window.endDrop) : null,
    segment.seenReset ? 1 : 0, JSON.stringify({ ts: segment.lastInput.ts, grp: segment.lastInput.grp ?? "", ord: segment.lastInput.ord,
      used_percent: segment.lastInput.used_percent, resets_at: segment.lastInput.resets_at,
      window_minutes: segment.lastInput.window_minutes, source: segment.lastInput.source ?? "probe" }),
    window.activity ? JSON.stringify(window.activity) : null];
}
const INSERT_WINDOW = `INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,
  window_minutes,plan,plan_detail,plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input,activity)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function storedWindowRow(row: LimitWindowRow): unknown[] {
  return [row.provider, row.account, row.counter, row.seq, row.window_id, row.start_ts, row.end_ts, row.reset_ts,
    row.cycle_end_basis, row.window_minutes, row.plan, row.plan_detail, row.plan_mismatch, row.readings, row.manual,
    row.start_drop, row.end_drop, row.seen_reset, row.last_input, row.activity ?? null];
}

/** Meter-plan provenance changes labels, never the paired traffic or its stored sums. */
function pairingReadings(readings: string): string {
  return JSON.stringify((JSON.parse(readings) as ProbeLimitWindow["readings"]).map(({ plan: _plan, ...reading }) => reading));
}
function usageShape(row: unknown[]): string {
  return JSON.stringify([row[5], row[6], row[7], row[9], pairingReadings(String(row[13])), row[14], row[19]]);
}

/** The segment a stored window was before a later segment closed it: the state to resume from. */
function restoreSegment(row: LimitWindowRow): RawSegment {
  return { id: row.window_id, account: row.account, counter: row.counter, start: row.start_ts, end: row.reset_ts,
    reset: row.reset_ts, cycle_end_basis: "scheduled", window_minutes: row.window_minutes,
    readings: (JSON.parse(row.readings) as ProbeLimitWindow["readings"]).filter(reading => reading.source !== "manual"),
    startDrop: row.start_drop === null ? null : JSON.parse(row.start_drop) as RawSegment["startDrop"], endDrop: null,
    seenReset: row.seen_reset === 1, lastInput: JSON.parse(row.last_input) as SegmentInput };
}

function nextCounter(db: Database, state: State, after: string): string | null {
  const input = db.query("SELECT counter FROM limit_window_inputs WHERE provider=? AND account=? AND scope=? AND counter>? ORDER BY counter LIMIT 1")
    .get(state.provider, state.account, state.scope, after) as { counter: string } | null;
  const window = db.query(`SELECT counter FROM limit_windows WHERE provider=? AND account=? AND counter>?
    ${state.provider === "codex" ? "AND counter=?" : ""} ORDER BY counter LIMIT 1`)
    .get(...[state.provider, state.account, after, ...(state.provider === "codex" ? [state.scope] : [])]) as { counter: string } | null;
  const found = [input?.counter, window?.counter].filter((counter): counter is string => counter != null).sort();
  return found[0] ?? null;
}

/** Resumes segmentation of every counter of a scope before its earliest changed input; replaces windows atomically. */
function publishWindows(db: Database, state: State, periods: readonly DatedPeriod[], options: LimitWindowProducerOptions,
  stats: LimitWindowProducerStats): void {
  const changedFrom = state.changed_from ?? LIMIT_WINDOW_ALL;
  const writes: Array<{ counter: string; rows: unknown[][]; removed: LimitWindowRow[]; replaced: LimitWindowRow[];
    ranges: Array<[number, number]> }> = [];
  const measurements = measurementsOf(options, state.provider);
  for (let counter = nextCounter(db, state, ""); counter !== null; counter = nextCounter(db, state, counter)) {
    const windows = db.query("SELECT * FROM limit_windows WHERE provider=? AND account=? AND counter=? ORDER BY seq")
      .all(state.provider, state.account, counter) as LimitWindowRow[];
    let resume: LimitWindowRow | null = null;
    for (const row of windows) if (Date.parse((JSON.parse(row.last_input) as SegmentInput).ts) < changedFrom) resume = row;
    const segState: SegmenterState = resume
      ? { last: JSON.parse(resume.last_input) as SegmentInput,
        seenResets: windows.filter(row => row.seq <= resume!.seq && row.seen_reset === 1).map(row => Date.parse(row.reset_ts)),
        out: [restoreSegment(resume)] }
      : { last: null, seenResets: [], out: [] };
    const last = segState.last;
    const inputs = (state.provider === "claude" ? [] : last
      ? db.query(`SELECT * FROM limit_window_inputs WHERE provider=? AND account=? AND scope=? AND counter=?
          AND (ts>? OR (ts=? AND (grp>? OR (grp=? AND ord>?)))) ORDER BY ts, grp, ord`)
        .all(state.provider, state.account, state.scope, counter, last.ts, last.ts, last.grp ?? "", last.grp ?? "", last.ord)
      : db.query(`SELECT * FROM limit_window_inputs WHERE provider=? AND account=? AND scope=? AND counter=? ORDER BY ts, grp, ord`)
        .all(state.provider, state.account, state.scope, counter)) as InputRow[];
    stats.inputRows += inputs.length;
    let segments: RawSegment[];
    let fromSeq = resume?.seq ?? 0;
    if (state.provider === "claude") {
      // Replay the overlapping tail, including its predecessor. A resumed meter can precede the latest row.
      const first = windows.findIndex(row => Date.parse(row.reset_ts) >= changedFrom);
      fromSeq = Math.max(0, (first < 0 ? windows.length - 1 : first) - 1);
      while (fromSeq > 0 && Math.abs(Date.parse(windows[fromSeq - 1]!.reset_ts) - Date.parse(windows[fromSeq]!.reset_ts)) <= RESET_JOIN_MS) fromSeq--;
      const from = windows[fromSeq]?.start_ts ?? "";
      const tailInputs = db.query(`SELECT * FROM limit_window_inputs WHERE provider=? AND account=? AND scope=? AND counter=?
        AND ts>=? ORDER BY ts,grp,ord`).all(state.provider, state.account, state.scope, counter, from) as InputRow[];
      stats.inputRows += tailInputs.length;
      segments = segmentClaudeReadings(state.account, counter, tailInputs.map(parseInput), periods, {
        last: fromSeq > 0 ? JSON.parse(windows[fromSeq - 1]!.last_input) as SegmentInput : null,
        seenResets: windows.slice(0, fromSeq).filter(row => row.seen_reset === 1).map(row => Date.parse(row.reset_ts)), out: [],
      });
    } else segments = segmentReadings(state.account, counter, inputs.map(parseInput), segState);
    const resolution: WindowResolution = windowResolution(state.provider, state.account, counter, periods, measurements);
    const rows = segments.map((segment, index) => windowRow(state.provider, fromSeq + index, segment, resolveSegment(segment, resolution)));
    const tail = windows.filter(row => row.seq >= fromSeq), before = new Map(tail.map(row => [row.seq, row]));
    const after = new Set(rows.map(row => row[3] as number));
    const changed = rows.filter(row => {
      const old = before.get(row[3] as number);
      return !old || JSON.stringify(row) !== JSON.stringify(storedWindowRow(old));
    });
    const removed = tail.filter(row => !after.has(row.seq));
    const replaced = [...removed, ...changed.flatMap(row => before.get(row[3] as number) ?? [])];
    // Both old and new bounds invalidate removed windows and every later overlapping dependent.
    const usageChanged = changed.filter(row => {
      const old = before.get(row[3] as number);
      return !old || usageShape(row) !== usageShape(storedWindowRow(old));
    });
    const ranges: Array<[number, number]> = [
      ...[...removed, ...usageChanged.flatMap(row => before.get(row[3] as number) ?? [])]
        .map(row => [Date.parse(row.start_ts), Date.parse(row.end_ts)] as [number, number]),
      ...usageChanged.map(row => [Date.parse(row[5] as string), Date.parse(row[6] as string)] as [number, number]),
    ];
    writes.push({ counter, rows: changed, removed, ranges, replaced });
  }
  if (options.canWrite && !options.canWrite()) return;
  write(db, stats, () => {
    for (const register of writes) {
      const remove = db.query("DELETE FROM limit_windows WHERE provider=? AND account=? AND counter=? AND seq=?");
      for (const row of register.removed) remove.run(state.provider, state.account, register.counter, row.seq);
      const insert = db.query(INSERT_WINDOW.replace("INSERT INTO", "INSERT OR REPLACE INTO"));
      for (const row of register.rows) insert.run(...(row as never[]));
      for (const row of register.rows) markWindowAnswersDirty(db, { provider: state.provider, account: state.account,
        fromMs: Date.parse(String(row[5])), untilMs: Date.parse(String(row[6])) });
      stats.windowsWritten += register.rows.length;
      // A window that is gone or whose bounds or readings changed loses its end estimate (window-end-estimate.ts).
      const fresh = new Map(register.rows.map(row => [row[4] as string, JSON.stringify([row[5], row[6], pairingReadings(String(row[13])), row[19]])]));
      for (const old of register.replaced) if (fresh.get(old.window_id) !== JSON.stringify([old.start_ts, old.end_ts, pairingReadings(old.readings), old.activity ?? null]))
        dropWindowEndEstimate(db, state.provider, state.account, register.counter, old.window_id);
      const ranges = register.ranges.filter(([from, until]) => Number.isFinite(from) && Number.isFinite(until) && until > from)
        .sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
      }
      for (const [fromMs, untilMs] of merged)
        markWindowUsageDirty(db, { provider: state.provider, account: state.account, counter: register.counter, fromMs, untilMs });
    }
    // Only a segmentation of the inputs as they were read clears the change; a newer slice keeps it.
    db.query(`UPDATE limit_window_state SET status='ready', revision=revision+1, resolve=0,
      changed_from=CASE WHEN changed_from IS ? THEN NULL ELSE changed_from END
      WHERE provider=? AND account=? AND scope=?`).run(state.changed_from, state.provider, state.account, state.scope);
  });
  stats.segmentations++;
}

/** Plan periods or manual measurements changed: re-resolve the stored segments without segmenting again. */
function resolveWindows(db: Database, state: State, periods: readonly DatedPeriod[], options: LimitWindowProducerOptions,
  stats: LimitWindowProducerStats): void {
  const rows = db.query(`SELECT * FROM limit_windows WHERE provider=? AND account=? ${state.provider === "codex" ? "AND counter=?" : ""}`)
    .all(...[state.provider, state.account, ...(state.provider === "codex" ? [state.scope] : [])]) as LimitWindowRow[];
  const measurements = measurementsOf(options, state.provider);
  const resolutions = new Map<string, WindowResolution>();
  const updates: unknown[][] = [];
  const sumsChanged: LimitWindowRow[] = [];
  for (const row of rows) {
    const resolution = resolutions.get(row.counter) ?? windowResolution(state.provider, state.account, row.counter, periods, measurements);
    resolutions.set(row.counter, resolution);
    const segment = { ...restoreSegment(row), end: row.end_ts, cycle_end_basis: row.cycle_end_basis as RawSegment["cycle_end_basis"],
      endDrop: row.end_drop === null ? null : JSON.parse(row.end_drop) as RawSegment["endDrop"] };
    const fresh = windowRow(state.provider, row.seq, segment, resolveSegment(segment, resolution));
    const stored = storedWindowRow(row);
    if (JSON.stringify(fresh) !== JSON.stringify(stored)) updates.push(fresh);
    // Manual readings change what the window pairs; a plan alone changes no sum.
    if (pairingReadings(String(fresh[13])) !== pairingReadings(String(stored[13])) || fresh[14] !== stored[14]) sumsChanged.push(row);
  }
  if (options.canWrite && !options.canWrite()) return;
  write(db, stats, () => {
    const replace = db.query(INSERT_WINDOW.replace("INSERT INTO", "INSERT OR REPLACE INTO"));
    for (const row of updates) replace.run(...(row as never[]));
    // A window's plan is shown by stored window screens even where its sums stay (db/window-answers.ts).
    for (const row of updates) markWindowAnswersDirty(db, { provider: String(row[0]), account: String(row[1]),
      fromMs: Date.parse(String(row[5])), untilMs: Date.parse(String(row[6])) });
    stats.windowsWritten += updates.length;
    for (const row of sumsChanged) {
      markWindowUsageDirty(db, { provider: row.provider, account: row.account, counter: row.counter,
        fromMs: Date.parse(row.start_ts), untilMs: Date.parse(row.end_ts) });
      dropWindowEndEstimate(db, row.provider, row.account, row.counter, row.window_id);
    }
    db.query(`UPDATE limit_window_state SET resolve=0, revision=revision+? WHERE provider=? AND account=? AND scope=?`)
      .run(updates.length ? 1 : 0, state.provider, state.account, state.scope);
  });
  stats.resolutions++;
}

/**
 * One maintenance turn of the limit-window producer. Returns whether queued work remains. Each step
 * computes outside a transaction and writes in one short transaction; the worker is the only writer of
 * these tables, so its reads stay valid until its own write.
 */
/** Limit-window registers (provider, account, scope) still waiting for work, for the progress register. */
export function limitWindowBacklog(db: Database): number | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='limit_window_state'").get()) return null;
  const states = (db.query(`SELECT count(*) n FROM limit_window_state WHERE account<>''
    AND (inputs_from IS NOT NULL OR changed_from IS NOT NULL OR status='filling' OR resolve=1 OR version<>?)`).get(LIMIT_WINDOW_VERSION) as { n: number }).n;
  // Queued changes not yet applied to a register count as one item each register they touch.
  const dirty = (db.query("SELECT count(DISTINCT provider||char(0)||account) n FROM limit_window_dirty").get() as { n: number }).n;
  return states + dirty;
}

export function advanceLimitWindows(db: Database, options: LimitWindowProducerOptions): { progressed: boolean; pending: boolean } {
  // Partial schemas used by maintenance callers have no prepared readings to segment.
  const inputs = db.query(`SELECT count(*) AS n FROM sqlite_master WHERE type='table'
    AND name IN ('probe_windows','probe_sources','account_periods')`).get() as { n: number };
  if (inputs.n !== 3) return { progressed: false, pending: false };
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='limit_window_state'").get()) {
    if (options.canWrite && !options.canWrite()) return { progressed: false, pending: true };
    ensureLimitWindowSchema(db);
  }
  const stats = options.stats ?? emptyLimitWindowStats();
  const cycles = options.cycles ?? loadCycles();
  const started = performance.now(), budget = options.budgetMs ?? 1000;
  if (options.canWrite && !options.canWrite()) return { progressed: false, pending: true };
  enqueueConfigChanges(db, options, cycles);
  const resolver = loadAccountResolver(db, options.subscriptions ?? []);
  discover(db, resolver);
  let ownerAt: ((home: string, ts: string) => string | null) | undefined;
  applyDirty(db, () => ownerAt ??= codexAccountSelector({ sqlite: db, resolver, accounts: { sources: options.sources } }).accountAt);
  let periods: DatedPeriod[] = [];
  try { periods = loadPeriods(db, PLAN_PERIODS); } catch { /* No period table leaves plans unknown, as readers did. */ }
  let progressed = false;
  const blocked = new Set<string>();
  for (;;) {
    if (progressed && performance.now() - started >= budget) break;
    if (options.canWrite && !options.canWrite()) break;
    const states = (db.query(`SELECT * FROM limit_window_state WHERE account<>''
      AND (inputs_from IS NOT NULL OR changed_from IS NOT NULL OR status='filling' OR resolve=1 OR version<>?)
      ORDER BY provider, account, scope`).all(LIMIT_WINDOW_VERSION) as State[])
      .filter(state => !blocked.has(`${state.provider}\u0000${state.account}\u0000${state.scope}`));
    const state = states[0];
    if (!state) break;
    const stepStarted = performance.now();
    const step = `${state.provider}:${state.account}:${state.scope}:${state.inputs_from !== null ? `inputs@${state.inputs_from}` : state.changed_from !== null || state.status === "filling" ? "segment" : "resolve"}`;
    try {
      if (state.version !== LIMIT_WINDOW_VERSION && state.inputs_from === null) {
        db.query("UPDATE limit_window_state SET inputs_from=? WHERE provider=? AND account=? AND scope=?")
          .run(LIMIT_WINDOW_ALL, state.provider, state.account, state.scope);
      } else if (state.inputs_from !== null) advanceInputs(db, state, resolver, cycles, options, stats);
      else if (state.changed_from !== null || state.status === "filling") publishWindows(db, state, periods, options, stats);
      else if (state.provider === "claude") publishWindows(db, state, periods, options, stats);
      else resolveWindows(db, state, periods, options, stats);
      progressed = true;
      const ms = performance.now() - stepStarted;
      if (ms > stats.slowestStep.ms) stats.slowestStep = { ms, step };
    } catch (error) {
      if (!(error instanceof ProbeAccountIndexUnavailable)) throw error;
      // The probe projection is still preparing this account; its writer queues the change again.
      blocked.add(`${state.provider}\u0000${state.account}\u0000${state.scope}`);
    }
  }
  const pending = !!db.query(`SELECT 1 FROM limit_window_state WHERE account<>''
    AND (inputs_from IS NOT NULL OR changed_from IS NOT NULL OR status='filling' OR resolve=1) LIMIT 1`).get()
    || !!db.query("SELECT 1 FROM limit_window_dirty LIMIT 1").get();
  return { progressed, pending };
}

export { limitWindowScope };

/**
 * The reference result: every register computed from all readings at once with the segmentation
 * definition, as `buildProbeLimitWindows` defines it. Tests and the acceptance script compare the
 * incrementally maintained table with it.
 */
export function computeLimitWindowsFull(db: Database, options: LimitWindowProducerOptions): Map<string, ProbeLimitWindow[]> {
  const resolver = loadAccountResolver(db, options.subscriptions ?? []), cycles = options.cycles ?? loadCycles();
  let periods: DatedPeriod[] = [];
  try { periods = loadPeriods(db, PLAN_PERIODS); } catch { /* No period table leaves plans unknown. */ }
  const out = new Map<string, ProbeLimitWindow[]>();
  for (const provider of usageProviderIds()) for (const account of resolver.accounts(provider).map(value => value.toLowerCase())) {
    const measurements = measurementsOf(options, provider);
    if (provider === "codex") for (const minutes of CODEX_MINUTES) {
      const counter = codexLimitCounter(minutes);
      const probes = loadCodexLimitProbes({ sqlite: db, resolver, account, minutes, sources: options.sources, measurements }).probes;
      out.set(JSON.stringify([provider, account, counter]), buildProbeLimitWindows({ provider, account, counter, periods, measurements,
        readings: codexLimitReadings(probes, minutes) }));
    } else {
      const evidence = loadProbeLimitEvidence(db, provider, account, resolver);
      const counters = [...new Set(evidence.samples.filter(sample => sample.resets_at && sample.used_percent != null)
        .map(sample => probeLimitCounter(sample, account, cycles)))];
      for (const counter of counters) out.set(JSON.stringify([provider, account, counter]), buildProbeLimitWindows({ provider, account,
        counter, periods, measurements, readings: counterReadings(evidence.samples, account, counter, cycles) }));
    }
  }
  return out;
}

export { publishWindows as publishLimitWindows };
