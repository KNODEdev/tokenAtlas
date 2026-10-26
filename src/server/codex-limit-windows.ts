import type { Database } from "bun:sqlite";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import type { SourceDeclaration } from "./archive-source";
import type { AccountResolver } from "./account-resolver";
import { codexAccountSelector } from "./codex-source-account";
import { loadCapacitySessionProbes, mergeCapacityProbes } from "./codex-capacity-probes";
import type { CodexProbe } from "./codex-calibration";
import { excludeConflictingWindowSamples } from "./codex-window-ownership";
import { readPreparedProbeAccountHistory, readPreparedProbeAccountReadings, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { codexLimitCounter, probeLimitSamples, type ProbeLimitReading, type ProbeLimitWindow } from "./probe-limit-windows";
import { readLimitWindows } from "../db/limit-windows";

export { codexLimitCounter } from "./probe-limit-windows";

/** Empty rolling placeholders are evidence, but they are not spent Capacity or rail windows. */
export function codexVisibleLimitWindows(windows: readonly ProbeLimitWindow[]): ProbeLimitWindow[] {
  return windows.filter(window => {
    const manual = window.readings.filter(reading => reading.source === "manual");
    const first = manual[0] ?? window.readings[0], last = manual.at(-1) ?? window.readings.at(-1);
    if (!first || !last) return false;
    const baseline = manual.length === 0 && !window.startDrop && Date.parse(window.start) < Date.parse(first.ts)
      ? 0 : first.percent;
    return last.percent > baseline;
  });
}

export interface CodexLimitWindowInput {
  sqlite: Database;
  resolver: AccountResolver;
  account: string;
  minutes: 300 | 10080 | 43200;
  sources?: readonly SourceDeclaration[];
  measurements?: readonly ManualCapacityMeasurement[];
}

/** Reading times, in ms, that a bounded recomputation reads; null is unbounded. */
export interface CodexLimitRegion { from: number | null; until: number | null }
type FileModels = Array<{ reset: number | null; spark: boolean; main: boolean }>;
/**
 * Models of transcripts read by earlier bounded recomputations. An entry is reused only while the file's
 * event rows are the same (count and newest rowid, read from the index); any published change replaces rows.
 */
export type CodexFileModelCache = Map<string, { rows: number; newest: number; models: FileModels }>;
export interface CodexLimitProbes {
  probes: CodexProbe[];
  /** Each kept reading's reading group (creation key) and place in it: the order among equal times. */
  order: Array<{ group: string; index: number }>;
  /** False when no session reading of this counter exists at all: periodic readings are then used as they are. */
  merged: boolean;
  /** Anchors of every merged reading group, and the reset lead (reset - reading, ms) of the merged readings. */
  anchors: number[]; leadMax: number | null; leadMin: number | null;
  /** Rows read, for proving that a bounded recomputation does not read the account's history. */
  read: { periodic: number; sessions: number; files: number };
}

const DAY_MS = 86_400_000;
const within = (region: CodexLimitRegion, ts: string) => {
  const at = Date.parse(ts);
  return (region.from === null || at >= region.from) && (region.until === null || at < region.until);
};

/**
 * Prepared account probes and owned transcript percentages, with Spark and false resets removed, for all
 * readings or only those whose time lies in the region. Every step but the reconciliation is local to a
 * reading (its file, its owner, its ±24 h ownership bracket); the producer chooses a region wide enough
 * for the reconciliation of the reading groups it keeps (limit-window-producer.ts).
 */
export function loadCodexLimitProbes(input: CodexLimitWindowInput,
  region: CodexLimitRegion = { from: null, until: null }, modelCache?: CodexFileModelCache): CodexLimitProbes {
  const { sqlite, resolver, minutes } = input, account = input.account.toLowerCase();
  const bounded = region.from !== null || region.until !== null;
  const iso = (value: number) => new Date(value).toISOString();
  // Collection time is accounting time for Codex. The key range is widened and the exact bound applied below.
  const prepared = minutes === 43200
    ? readPreparedProbeAccountReadings(sqlite, "codex", account, {
      key: "at", keyFrom: region.from === null ? undefined : region.from - DAY_MS,
      keyUntil: region.until === null ? undefined : region.until + DAY_MS,
      where: "p.limit_group='codex' AND p.window_minutes=?", params: [minutes],
    })
    : readPreparedProbeAccountHistory(sqlite, "codex", account,
      region.from === null ? null : iso(region.from - DAY_MS), region.until === null ? null : iso(region.until + DAY_MS));
  if (!prepared) throw new ProbeAccountIndexUnavailable();
  const samples = probeLimitSamples(prepared.rows, "codex").filter(row => !bounded || within(region, row.ts));
  const periodic: CodexProbe[] = samples.filter(row => row.limit_group === "codex"
    && Number(row.window_minutes) === minutes && row.used_percent != null && row.resets_at != null)
    .map(row => ({ subject: account, ts: row.ts, kind: "probe", plan: row.plan,
      used_percent: row.used_percent!, resets_at: row.resets_at, window_minutes: minutes }));
  const read = { periodic: prepared.rows.length, sessions: 0, files: 0 };
  const unmerged = (): CodexLimitProbes => ({ probes: periodic, order: periodic.map((_, index) => ({ group: "", index })),
    merged: false, anchors: [], leadMax: null, leadMin: null, read });
  if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ratelimit'").get()) return unmerged();
  const span = sqlite.query(`SELECT MIN(ts) AS first, MAX(ts) AS last FROM ratelimit
    WHERE limit_id='codex' AND window_minutes=?`).get(minutes) as { first: string | null; last: string | null };
  if (!span.first || !span.last) return unmerged();
  const since = region.from !== null ? iso(region.from - DAY_MS) : span.first.slice(0, 10);
  const until = region.until !== null ? iso(region.until + DAY_MS)
    : new Date(Date.parse(span.last.slice(0, 10)) + 86_400_000).toISOString().slice(0, 10);
  const ownerAt = codexAccountSelector({ sqlite, resolver, accounts: { sources: input.sources ?? [] } }).accountAt;
  const all = loadCapacitySessionProbes(sqlite, since, until, ownerAt, new Set(), minutes);
  read.sessions = all.length;
  const loaded = all.filter(probe => probe.subject === account && (!bounded || within(region, probe.ts)));
  const modelsAtPath = new Map<string, FileModels>();
  const eventColumns = sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()
    ? new Set((sqlite.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).map(row => row.name)) : new Set<string>();
  const resetColumn = eventColumns.has("meter_reset") ? "meter_reset" : "NULL AS meter_reset";
  // A file's row count and newest row come with its models, so a file read for the first time costs one statement.
  const modelRows = eventColumns.has("path") && eventColumns.has("home") && eventColumns.has("model")
    ? sqlite.query(`SELECT model,${resetColumn},count(*) AS n,max(rowid) AS newest FROM events WHERE path=? AND home=?
      GROUP BY model${eventColumns.has("meter_reset") ? ",meter_reset" : ""}`) : null;
  const fileRows = modelCache && modelRows ? sqlite.query("SELECT count(*) AS n, max(rowid) AS newest FROM events WHERE path=? AND home=?") : null;
  for (const probe of loaded) {
    if (!probe.path || !probe.home) continue;
    const key = JSON.stringify([probe.home, probe.path]);
    if (modelsAtPath.has(key)) continue;
    const cached = modelCache?.get(key);
    const shape = cached && fileRows?.get(probe.path, probe.home) as { n: number; newest: number | null } | undefined;
    if (cached && shape && cached.rows === shape.n && cached.newest === (shape.newest ?? -1)) { modelsAtPath.set(key, cached.models); continue; }
    const rows = modelRows?.all(probe.path, probe.home) as Array<{ model: string | null; meter_reset: number | null; n: number; newest: number }> | undefined ?? [];
    const models = rows.map(row => ({ reset: row.meter_reset,
      spark: row.model === "gpt-5.3-codex-spark", main: row.model !== "gpt-5.3-codex-spark" }));
    modelsAtPath.set(key, models);
    read.files++;
    if (modelCache && modelRows) modelCache.set(key, { rows: rows.reduce((sum, row) => sum + row.n, 0),
      newest: rows.reduce((newest, row) => Math.max(newest, row.newest), -1), models });
  }
  const nonSpark = loaded.filter(probe => {
    const models = modelsAtPath.get(JSON.stringify([probe.home, probe.path])) ?? [];
    if (models.length && models.every(model => model.spark)) return false;
    const reset = Date.parse(probe.resets_at!) / 1000;
    const matching = models.filter(model => model.reset != null && Math.abs(model.reset - reset) <= 120);
    return !matching.some(model => model.spark) || matching.some(model => model.main);
  });
  const owned = excludeConflictingWindowSamples(sqlite, account, minutes,
    nonSpark.map(probe => ({ probe, ts: probe.ts, resets_at: Date.parse(probe.resets_at!) / 1000,
      limit_id: "codex" }))).samples.map(row => row.probe);
  const reconciled = mergeCapacityProbes(periodic, owned, minutes);
  let leadMax: number | null = null, leadMin: number | null = null;
  for (const probe of [...periodic, ...owned]) {
    const lead = Date.parse(probe.resets_at!) - Date.parse(probe.ts);
    if (!Number.isFinite(lead)) continue;
    leadMax = leadMax === null ? lead : Math.max(leadMax, lead);
    leadMin = leadMin === null ? lead : Math.min(leadMin, lead);
  }
  const groups = new Map<string, CodexProbe[]>();
  for (const probe of reconciled.probes) {
    const rows = groups.get(probe.resets_at!) ?? [];
    rows.push(probe);
    groups.set(probe.resets_at!, rows);
  }
  const useful = new Set([...groups].filter(([reset, rows]) => rows.some(row => row.used_percent > 0)
    || (input.measurements ?? []).some(measurement => measurement.account.toLowerCase() === account
      && measurement.counter === codexLimitCounter(minutes)
      && Date.parse(measurement.start) >= Date.parse(reset) - minutes * 60_000
      && Date.parse(measurement.end) <= Date.parse(reset))).map(([reset]) => reset));
  const kept = reconciled.probes.map((probe, index) => ({ probe, order: reconciled.order[index]! }))
    .filter(item => useful.has(item.probe.resets_at!));
  return { probes: kept.map(item => item.probe), order: kept.map(item => item.order), merged: true,
    anchors: reconciled.anchors, leadMax, leadMin, read };
}

/** Segmentation readings of the Codex register, in the order the segmenter consumes them. */
export const codexLimitReadings = (probes: readonly CodexProbe[], minutes: number): ProbeLimitReading[] =>
  probes.map(probe => ({ ts: probe.ts, used_percent: probe.used_percent, resets_at: probe.resets_at!,
    window_minutes: minutes, source: probe.kind === "session" ? "session" as const : "probe" as const,
    ...(probe.plan ? { plan: probe.plan } : {}) }));

/** The one Codex register consumed by Capacity, accounting and the Overview rail: its stored windows. */
export function readCodexLimitWindows(sqlite: Database, account: string, minutes: 300 | 10080 | 43200): ProbeLimitWindow[] {
  return readLimitWindows(sqlite, "codex", account.toLowerCase(), codexLimitCounter(minutes));
}
