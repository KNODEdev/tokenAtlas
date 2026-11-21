import type { Database } from "../db/sqlite";
import { fingerprintColumns, tableColumns } from "./sync-sql";
import { identityKey } from "./publication-identities";
import { DELTA_SPECS, vendorIdentityFingerprints, type DeltaIdentity } from "./vendor-publication-schema";

/** A change to how the same transcript is stored must still publish its physical parser bookmark. */
export function changedCodexFacts(active: Database, staged: Database, changed: DeltaIdentity[]): DeltaIdentity[] {
  if (changed.length === 0) return changed;
  const table = "codex_file_evidence";
  const fields = tableColumns(active, table);
  if (!fields.includes("first_token_json") || JSON.stringify(fields) !== JSON.stringify(tableColumns(staged, table))) return changed;
  const fieldsWithoutTiming = fields.filter(column => column !== "first_token_json");
  const sql = `SELECT ${fingerprintColumns(fieldsWithoutTiming)}, first_token_json AS timing,
    CASE WHEN json_valid(first_token_json) THEN json_remove(first_token_json, '$.bookmark') END AS timedFacts
    FROM codex_file_evidence WHERE home=? AND path=?`;
  const readActive = active.query(sql), readStage = staged.query(sql);
  const candidates = changed.filter(identity => {
    const { home, path } = identity;
    const before = readActive.get(home!, path!) as Record<string, unknown> | null;
    const after = readStage.get(home!, path!) as Record<string, unknown> | null;
    if (!before || !after) return false;
    const { timing: oldTiming, ...oldFacts } = before, { timing: newTiming, ...newFacts } = after;
    return oldTiming !== newTiming && oldFacts.timedFacts != null && JSON.stringify(oldFacts) === JSON.stringify(newFacts);
  });
  if (!candidates.length) return changed;
  const before = vendorIdentityFingerprints(active, "codex", candidates, false).byIdentity;
  const after = vendorIdentityFingerprints(staged, "codex", candidates, false).byIdentity;
  const unchanged = new Set(candidates.map(identity => identityKey(DELTA_SPECS.codex, identity))
    .filter(key => before.get(key) === after.get(key)));
  return changed.filter(identity => !unchanged.has(identityKey(DELTA_SPECS.codex, identity)));
}
