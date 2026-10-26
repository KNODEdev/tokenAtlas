import type { Database } from "bun:sqlite";
import type { WindowEvidence } from "../shared/subscription-quality";

interface Entry {
  id: string; started: string; status: string; has_error: boolean; warnings: number; range: { from: string; to: string } | null;
}
type VendorSummary = { vendor: string | null; status: string | null; has_error: number; warnings: number; from: string | null; to: string | null };

/**
 * What a finished run said about each vendor, per database file. A stored result can be tens of
 * megabytes of diagnostics and never changes once the run has ended, so it is reduced to these
 * few fields inside SQLite, once per process, instead of being loaded and parsed on every read.
 */
const finishedRuns = new Map<string, Map<string, VendorSummary[] | null>>();
const transientRuns = new WeakMap<Database, Map<string, VendorSummary[] | null>>();
const FINISHED_RUN_LIMIT = 400;
function runMemo(db: Database): Map<string, VendorSummary[] | null> {
  const file = db.filename;
  if (!file || file === ":memory:") {
    let memo = transientRuns.get(db);
    if (!memo) { memo = new Map(); transientRuns.set(db, memo); }
    return memo;
  }
  let memo = finishedRuns.get(file);
  if (!memo) { memo = new Map(); finishedRuns.set(file, memo); }
  return memo;
}
const VENDOR_SUMMARY_SQL = `SELECT CASE WHEN json_valid(result_json) AND json_type(result_json,'$.vendors')='array' THEN (
    SELECT json_group_array(json_object('vendor', v.value->>'$.vendor', 'status', v.value->>'$.status',
      'has_error', COALESCE(length(v.value->>'$.error'),0) > 0,
      'warnings', COALESCE(json_array_length(v.value,'$.diagnostics.mirror.warnings'),0),
      'from', v.value->>'$.dirtyRange.from', 'to', v.value->>'$.dirtyRange.to'))
    FROM json_each(result_json,'$.vendors') v) END AS vendors
  FROM sync_runs WHERE run_id=?`;

/** Run results cover a provider, not an individual source or subscription. Read a bounded history. */
export function loadSubscriptionImportEvidence(db: Database, provider: string) {
  const columns = new Set((db.query("PRAGMA table_info(sync_runs)").all() as Array<{ name: string }>).map(r => r.name));
  if (!["run_id", "started_at", "result_json"].every(c => columns.has(c))) return null;
  const stored = (db.query("SELECT count(*) AS n FROM sync_runs").get() as { n: number }).n;
  const rows = db.query(`SELECT run_id,started_at,${columns.has("status") ? "status" : "NULL AS status"} FROM sync_runs
    ORDER BY started_at DESC LIMIT 200`).all() as Array<{ run_id: string; started_at: string; status: string | null }>;
  const vendor = provider === "glm" ? "opencode" : provider;
  const memo = runMemo(db);
  const entries: Entry[] = [];
  let unreadable = 0;
  for (const row of rows) {
    let vendors = memo.get(row.run_id);
    if (vendors === undefined) {
      try {
        const text = (db.query(VENDOR_SUMMARY_SQL).get(row.run_id) as { vendors: string | null } | null)?.vendors;
        vendors = text ? JSON.parse(text) as VendorSummary[] : null;
      } catch { vendors = null; }
      // A running result is still being written; only an ended run is final.
      if (row.status !== null && row.status !== "running") {
        memo.set(row.run_id, vendors);
        if (memo.size > FINISHED_RUN_LIMIT) memo.delete(memo.keys().next().value!);
      }
    }
    if (!vendors) { unreadable++; continue; }
    const item = vendors.find(r => r.vendor === vendor);
    if (!item) continue;
    entries.push({ id: row.run_id, started: row.started_at, status: String(item.status ?? "unknown"), has_error: !!item.has_error,
      warnings: item.warnings,
      range: typeof item.from === "string" && typeof item.to === "string" && Number.isFinite(Date.parse(item.from)) && Number.isFinite(Date.parse(item.to))
        ? { from: item.from, to: item.to } : null });
  }
  return { stored, inspected: rows.length, unreadable, entries };
}

export function importEvidenceForWindow(history: NonNullable<ReturnType<typeof loadSubscriptionImportEvidence>>, start: string, end: string): NonNullable<WindowEvidence["imports"]> {
  const from = Date.parse(start), to = Date.parse(end);
  const related = history.entries.flatMap(entry => {
    const changed = entry.range && Date.parse(entry.range.from) < to && Date.parse(entry.range.to) >= from;
    const ran = Date.parse(entry.started) >= from && Date.parse(entry.started) < to;
    if (!changed && !ran) return [];
    const { range: _, ...row } = entry;
    return [{ ...row, relation: changed ? "changed_range" as const : "run_time" as const }];
  });
  return { stored_runs: history.stored, inspected_runs: history.inspected, unreadable_runs: history.unreadable,
    truncated: history.stored > history.inspected, related_count: related.length, related: related.slice(0, 10) };
}
