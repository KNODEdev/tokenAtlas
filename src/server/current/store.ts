import type { Database } from "bun:sqlite";
import type { CurrentIdentity, CurrentLimit, CurrentProbeError } from "../../web/lib/current-contract";
import { publishCurrentV2, type CurrentPhysicalConfig } from "./v2";
import type { CurrentConfig } from "./registry";

export interface ProjectionState {
  schema_version: number;
  generation: number;
  probe_revision: number;
  published_probe_revision: number;
  config_fingerprint: string;
  generated_at: string | null;
  error_code: string | null;
}
export interface StoredLimit extends Omit<CurrentLimit, "age_minutes" | "freshness"> {
  conflicting: boolean;
}
export interface StoredSubject {
  limits: StoredLimit[];
  latest_error: CurrentProbeError | null;
  clock_warning: boolean;
  limits_truncated: boolean;
  next_refresh_at: string | null;
}
export function hasCurrentSchema(sqlite: Database): boolean {
  return sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='current_projection_state'").get() != null;
}
export function projectionState(sqlite: Database): ProjectionState | null {
  if (!hasCurrentSchema(sqlite)) return null;
  return sqlite.query(`SELECT schema_version, generation, probe_revision, published_probe_revision, config_fingerprint,
    generated_at, error_code FROM current_projection_state WHERE id = 1`).get() as ProjectionState | null;
}
/** Writer-only entry point. Version 1 rows are adopted by the resumable version 2 writer. */
export function publishCurrentBatch(sqlite: Database, registry: CurrentIdentity[], now: string | undefined,
  batchSize: number | undefined, config: CurrentConfig, physical?: CurrentPhysicalConfig): boolean {
  if (!hasCurrentSchema(sqlite)) return false;
  return publishCurrentV2(sqlite, registry, config.sources, now ?? new Date().toISOString(), batchSize ?? 8, physical);
}
export function readCurrentSubject(sqlite: Database, provider: string, subject: string): StoredSubject | null {
  // The card's reading history (activity, health) is read by its own readers (`probe-health.ts`).
  const row = sqlite.query("SELECT json_remove(data,'$.__activity','$.__health') AS data FROM current_probe_subjects WHERE provider = ? AND subject = ?")
    .get(provider, subject) as { data: string } | null;
  return row ? JSON.parse(row.data) as StoredSubject : null;
}
