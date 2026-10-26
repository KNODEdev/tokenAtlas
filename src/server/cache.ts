import { Database } from "../db/sqlite";
import fs from "fs";
import { PROJECTS_PATH } from "../projects/remap";
import { ledgerRevision } from "../db/ledger-revision";
import { analysisHash, hasAnalysisSchema } from "../db/analysis";
import { WINDOW_USAGE_CLOCK } from "./window-usage-clock";
import { RESPONSE_MEMORY_BYTES, ResponseMemoryBudget, ResponseMemoryCache, stringMemoryBytes } from "./response-memory";
/** The window producer's clock and its per-account clocks (`window-usage:<provider>:<account>`). */
const WINDOW_USAGE_SOURCES = WINDOW_USAGE_CLOCK;
const MAX_ENTRIES = 256;
/** Bytes of response bodies kept in memory. */
export const RESPONSE_CACHE_BYTES = RESPONSE_MEMORY_BYTES;
export function readingsRevision(sqlite: Database): number | null {
  try {
    return (sqlite.query("SELECT probe_revision FROM current_projection_state WHERE id = 1").get() as
      { probe_revision: number } | null)?.probe_revision ?? null;
  } catch {
    return null;
  }
}
export const CACHEABLE_ROUTES: ReadonlySet<string> = new Set([
  "/api/health",
  "/api/repo-history",
  "/api/project-cost",
  "/api/account-history",
  "/api/global-usage",
  "/api/projects",
  "/api/projects/unassigned",
  "/api/projects/rows",
  "/api/summary",
  "/api/breakdown",
  "/api/compare",
  "/api/activity",
  "/api/events",
  "/api/cache",
  "/api/leverage",
  "/api/subscription-accounting",
]);
export const CLOCK_CACHEABLE_ROUTES: ReadonlySet<string> = new Set([
  "/api/accounts",
  "/api/claude-limit",
  "/api/claude-limit-card",
  // Card ages and window progress are minutes; the same data stamp within one minute answers the same body.
  "/api/roster",
  "/api/windows",
]);
export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  generations: number;
}
/** Responses kept in this process only, by request and the stamp of the data they were built from. */
export class ResponseCache {
  private entries: ResponseMemoryCache<{ stamp: string; body: string }>;
  constructor(private readonly configuration?:(includeReadings:boolean)=>unknown, budget = new ResponseMemoryBudget()) {
    this.entries = new ResponseMemoryCache(budget, entry => stringMemoryBytes(entry.stamp) + stringMemoryBytes(entry.body), MAX_ENTRIES);
  }
  private generation = 0;
  private readingsGeneration = 0;
  private hits = 0;
  private misses = 0;
  private lastTerminalStamp = new Map<string, string>();
  invalidate(): void {
    this.generation++;
    this.entries.clear();
  }
  invalidateReadings(): void { this.readingsGeneration++; }
  syncInProgress(sqlite: Database): boolean {
    try {
      return sqlite.query("SELECT 1 FROM sync_runs WHERE status = 'running' LIMIT 1").get() != null;
    } catch {
      return false;
    }
  }
  /** `windowSums` false: the route never reads stored window sums, so their publications do not move its stamp. */
  stamp(sqlite: Database, includeReadings = false, windowSums = true): string {
    const scope = `${includeReadings}:${windowSums}`;
    const terminal = this.lastTerminalStamp.get(scope);
    if (this.syncInProgress(sqlite) && terminal !== undefined) {
      return `${this.generation}.${includeReadings ? this.readingsGeneration : 0}:${terminal}`;
    }
    const dv = (sqlite.query(`PRAGMA data_version`).get() as { data_version?: number } | null)?.data_version ?? 0;
    let revisions = `${dv}:0`;
    try {
      const row = sqlite
        .query("SELECT data_revision, config_revision FROM sync_revisions WHERE id = 1")
        .get() as { data_revision: number; config_revision: number } | null;
      // Vendor revisions too: the gauge journal bumps only its own vendor
      // revision, and the identity report in /api/health reads those rows.
      const vendors = sqlite
        .query("SELECT COALESCE(SUM(data_revision), 0) AS total FROM vendor_sync_revisions")
        .get() as { total: number } | null;
      if (row) revisions = `${row.data_revision}:${row.config_revision}:${includeReadings || !hasAnalysisSchema(sqlite) ? vendors?.total ?? 0 : 0}`;
    } catch {
    }
    const derived = ledgerRevision(sqlite);
    let rules = 0;
    try {
      rules = fs.statSync(PROJECTS_PATH).mtimeMs;
    } catch {
    }
    const rows = hasAnalysisSchema(sqlite) ? sqlite.query(`SELECT source,revision FROM analysis_source_revisions
      WHERE bucket='*' ORDER BY source`).all() as Array<{source:string;revision:number}> : null;
    const probeSources = new Set(["probe_windows", "ratelimit", "sync_runs"]);
    const tracked = rows ? analysisHash(rows.filter(row => (includeReadings || !probeSources.has(row.source))
      // None of these cacheable routes reads first-token histograms.
      && row.source !== "response_time_hours"
      && (windowSums || !row.source.startsWith(WINDOW_USAGE_SOURCES)))) : "legacy";
    const schema = (sqlite.query("PRAGMA schema_version").get() as {schema_version:number}).schema_version;
    const stamp = `${schema}:${revisions}:${derived}:${rules}:${tracked}:${this.configuration?analysisHash(this.configuration(includeReadings)):""}`;
    this.lastTerminalStamp.set(scope, stamp);
    return `${this.generation}.${includeReadings ? this.readingsGeneration : 0}:${stamp}`;
  }
  get(key: string, stamp: string): string | null {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.stamp !== stamp) {
      if (entry !== undefined) this.remove(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.body;
  }
  set(key: string, stamp: string, body: string): void {
    this.entries.remember(key, { stamp, body });
  }
  private remove(key:string):void {
    this.entries.delete(key);
  }
  stats(): CacheStats {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses, generations: this.generation };
  }
  clockStamp(sqlite: Database, nowMs = Date.now(), windowSums = true): string {
    return `${this.stamp(sqlite, true, windowSums)}:${readingsRevision(sqlite) ?? "legacy"}:${Math.floor(nowMs / 60_000)}`;
  }
}
export function cacheKey(url: URL): string {
  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return url.pathname + "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
