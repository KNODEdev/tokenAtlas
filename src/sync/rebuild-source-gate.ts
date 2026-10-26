import type { Database } from "../db/sqlite";
import { readRebuildStatusJson } from "../db/rebuild-status";

/**
 * A rebuild owns sync publication during its source phase: an ordinary sync would publish
 * sources the rebuild is replacing.
 */
export function rebuildBlockingSync(sqlite: Database): number | null {
  const json = readRebuildStatusJson(sqlite);
  if (!json) return null;
  const job = JSON.parse(json) as { generation?: number; phase?: string; state?: string };
  const active = (job.state === "queued" || job.state === "running") && Number.isSafeInteger(job.generation);
  return active && job.phase === "sources" ? job.generation! : null;
}
