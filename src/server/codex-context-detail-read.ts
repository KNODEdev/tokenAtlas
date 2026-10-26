import type { Database } from "../db/sqlite";
import { contextPreviewReader } from "./codex-context-read";
import { contextDetailsState, readContextBucketParts, CONTEXT_PART_KEYS, contextWindowRangesPending } from "../db/codex-context-details";
import type { ContextModelWindow } from "./codex-context-model-producer";
import { add, equal, subtract, rational } from "../db/price-ledger-exact";

export const CONTEXT_DETAIL_PATHS = new Set(["/api/cycle-breakdown", "/api/model-capacity", "/api/model-usage-share"]);
export function contextDetailPreviewReader(db: Database, kind: "details" | "models") {
  const reader = contextPreviewReader(db), state = contextDetailsState(db);
  reader.status.ready &&= !!state && !state.pending && !contextWindowRangesPending(db);
  reader.status.revision = state?.revision ?? 0;
  if (kind === "details") {
    reader.scope.bucketParts = new WeakMap();
    const apply = reader.scope.apply;
    reader.scope.apply = (group, policy) => {
      apply(group, policy);
      const before = reader.scope.originals.get(group), after = group.variants.api_standard?.value;
      if (before == null || after == null) return;
      const parts = readContextBucketParts(db, group.stored, reader.scope.ranges.get(group.stored));
      if (!equal(CONTEXT_PART_KEYS.reduce((sum, key) => add(sum, parts[key]), rational(0n)), subtract(after, before))) {
        reader.status.missing_groups++; return;
      }
      reader.scope.bucketParts!.set(group.stored, parts);
    };
  } else reader.scope.modelWindow = (account, counter, id, preparing) => {
    if (preparing) reader.status.ready=false;
    if (!reader.status.ready) return null;
    const row = db.query(`SELECT m.data,EXISTS(SELECT 1 FROM codex_context_model_pending p
      WHERE p.account=m.account AND p.counter=m.counter AND p.window_id=m.window_id) pending
      FROM codex_context_model_windows m WHERE m.account=? AND m.counter=? AND m.window_id=?`).get(account,counter,id) as {data:string;pending:number}|null;
    if (!row || row.pending) {reader.status.ready=false;return null;}
    const data = JSON.parse(row.data) as ContextModelWindow;
    if(data.version!==1){reader.status.ready=false;return null;}
    reader.status.missing_groups+=data.missing;
    return data;
  };
  return reader;
}
