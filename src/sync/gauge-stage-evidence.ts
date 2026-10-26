import { Database, type SQLQueryBindings } from "../db/sqlite";
import { digest } from "../config/canonical-json";
import type { CanonicalProbe } from "../db/probe-facts";

/** A stable read snapshot supplies only evidence required by the decoded journal suffix. */
export function gaugeStageEvidence(stage: Database, activePath: string) {
  const active = new Database(activePath, { readonly: true });
  try {
    active.exec("BEGIN DEFERRED");
    active.query("SELECT namespace FROM probe_fact_backfill_checkpoints WHERE id='local'").get();
  } catch (error) { active.close(); throw error; }
  const copiedCounters = new Set<string>();
  const copiedDependencies = new Set<string>();
  const copy = (table: string, where: string, parameters: SQLQueryBindings[]) => {
    const rows = active.query(`SELECT * FROM ${table} WHERE ${where}`).all(...parameters) as Record<string, SQLQueryBindings>[];
    for (const row of rows) {
      const key = table === "gauge_journal_receipts" ? "entry_id" : "id";
      // Immutable evidence triggers reject duplicate INSERT attempts before conflict handling.
      if (stage.query(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(row[key]!)) continue;
      const keys = Object.keys(row);
      stage.query(`INSERT OR IGNORE INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
        .run(...keys.map(key => row[key]!));
    }
    return rows;
  };
  const counter = (id: string, dependencies: boolean) => {
    if (!copiedCounters.has(id)) {
      copy("probe_observations", "id IN (SELECT observation_id FROM probe_counters WHERE id=?)", [id]);
      copy("probe_counters", "id=?", [id]);
      copiedCounters.add(id);
    }
    if (dependencies && !copiedDependencies.has(id)) {
      copy("probe_fact_legacy_map", "counter_id=?", [id]);
      copy("probe_fact_deliveries", "counter_id=?", [id]);
      copiedDependencies.add(id);
    }
  };
  return {
    // Hydrated rows participate in the caller's transaction and disappear on rollback.
    invalidate() { copiedCounters.clear(); copiedDependencies.clear(); },
    hydrate(entryId: string | null, row?: Record<string, unknown>, evidenceKey?: string, fact?: CanonicalProbe) {
      if (entryId) copy("gauge_journal_receipts", "entry_id=?", [entryId]);
      if (fact) {
        copy("probe_observations", "id=?", [fact.observation_id]);
        counter(fact.counter_id, true);
      } else if (row && evidenceKey) {
        const mapping = copy("probe_fact_legacy_map", "id=?", [digest(["legacy-journal", evidenceKey])]);
        for (const entry of mapping) counter(String(entry.counter_id), true);
        // Legacy collections have no immutable producer ID; equal coordinates require ambiguity evidence.
        for (const neighbor of active.query(`SELECT id FROM probe_counters
          WHERE json_extract(payload,'$.provider')=? AND json_extract(payload,'$.ts')=?`)
          .all(String(row.provider), String(row.ts)) as { id: string }[]) counter(neighbor.id, false);
      }
    },
    /** The accepted fact a compact journal line builds on. */
    base(counterId: string) { counter(counterId, false); },
    close() { try { active.exec("ROLLBACK"); } finally { active.close(); } },
  };
}
