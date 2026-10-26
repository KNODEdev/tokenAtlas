import { createHash } from "node:crypto";
import type { Database } from "./sqlite";
import { CODEX_LEDGER_PROVIDER } from "./codex-ledger-state";

/**
 * The published state of the shared usage ledger, whose revision moves with every re-aggregated day.
 * A prepared view or cached response that reads its sums names it. The Codex ledger has its own,
 * range-scoped stamp (codex-ledger-request.ts), so an unrelated Codex date never invalidates a view.
 */
export function ledgerSumsStamp(db: Database): unknown {
  try { return db.query(`SELECT provider,version,covered,status,rules_digest,revision FROM usage_ledger_state
    WHERE provider<>'${CODEX_LEDGER_PROVIDER}' ORDER BY provider`).all(); }
  catch { return null; }
}

/** The Codex price ledger's published head, for readers that report it whatever range they cover (health). */
export function codexLedgerHead(db: Database): unknown {
  try { return db.query(`SELECT status,version,covered,rules_digest,revision FROM usage_ledger_state WHERE provider='${CODEX_LEDGER_PROVIDER}'`).all(); }
  catch { return null; }
}

/** The derived revision clients and snapshots compare, including independently published screen projections. */
export function ledgerRevision(db: Database): number {
  const projection = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_source_revisions'").get()
    ? db.query("SELECT revision FROM analysis_source_revisions WHERE source='capacity_cycle_results' AND bucket='*'").get() : null;
  // Projection publication can finish after source sync and pricing, with no further fact change.
  const ledger = ledgerSumsStamp(db);
  // Existing snapshot manifests retain the pre-projection digest until this register first publishes.
  return Number.parseInt(createHash("sha256").update(JSON.stringify(projection === null ? ledger : [ledger, projection])).digest("hex").slice(0, 12), 16);
}
