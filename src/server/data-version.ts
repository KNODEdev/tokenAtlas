import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { contextProjectionStamp } from "./codex-context-preview";

/**
 * The version of the stored rows an analytical response is read from (plan U4.4, "data version
 * header"): the state rows of the registers the screens read — the usage ledger and the Codex price
 * ledger, the limit-window registers, window usage, the probe readings and account periods, and the
 * sync revisions (window usage only for a view that reads window sums, `readsWindowSums`). It changes whenever
 * any of them publishes, and only then; it is sent as
 * `X-Data-Version` and keys the in-memory answers of the views on the exception list.
 * Reading it costs a handful of single-row queries.
 */
export const DATA_VERSION_HEADER = "X-Data-Version";

const exists = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
function rows(db: Database, table: string, sql: string): unknown {
  return exists(db, table) ? db.query(sql).all() : null;
}

export function dataVersion(db: Database, scope: { windowSums?: boolean; capacityCycles?: boolean; contextPrices?: boolean | string; firstTokenTimes?: boolean } = {}): string {
  const parts = [
    // The Codex price ledger's state is the `codex` row.
    rows(db, "usage_ledger_state", "SELECT provider,version,status,covered,rules_digest,revision FROM usage_ledger_state ORDER BY provider"),
    rows(db, "limit_window_state", "SELECT COUNT(*) n,COALESCE(SUM(revision),0) revision,SUM(status<>'ready') filling FROM limit_window_state"),
    // A view that never reads window sums does not follow their publications (several per synchronization).
    scope.windowSums === false ? null
      : rows(db, "analysis_source_revisions", "SELECT revision FROM analysis_source_revisions WHERE source='window-usage' AND bucket='*'"),
    rows(db, "current_projection_state", "SELECT probe_revision,generated_at FROM current_projection_state WHERE id=1"),
    rows(db, "meta", "SELECT value FROM meta WHERE key='account_periods_revision'"),
    rows(db, "sync_revisions", "SELECT data_revision,config_revision FROM sync_revisions WHERE id=1"),
    rows(db, "subscription_capacity_state", "SELECT value FROM subscription_capacity_state WHERE key='revision'"),
    rows(db, "subscription_hours_state", "SELECT value FROM subscription_hours_state WHERE key='revision'"),
    rows(db, "project_plan_state", "SELECT value FROM project_plan_state WHERE key='revision'"),
    scope.firstTokenTimes ? rows(db, "response_time_state", "SELECT provider,version,revision FROM response_time_state ORDER BY provider") : null,
    scope.capacityCycles === false ? null
      : rows(db, "analysis_source_revisions", "SELECT revision FROM analysis_source_revisions WHERE source='capacity_cycle_results' AND bucket='*'"),
  ];
  if (scope.contextPrices) parts.push(contextProjectionStamp(db, typeof scope.contextPrices === "string" ? new URL(scope.contextPrices, "http://context") : undefined));
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
