import type { Database, SQLQueryBindings } from "../db/sqlite";
import type { ReparseRange } from "./reparse";
import { quoteIdentifier, sqlString, tableColumns } from "./sync-sql";
import { restrictGaugeAccountPublication } from "./gauge-account-selection";
import type { RebuildAccount } from "../shared/rebuild-accounts";
import type { ProbeSourceOptions } from "../server/probe-source";
import { backfillProbeFacts, mergeProbeFacts, linkPublishedProbeFacts, advanceLinkedProbeBackfill, quarantineProbeConflict } from "../db/probe-facts";
import { loadAccountResolver } from "../server/account-resolver";
import { directChanges } from "../db/change-count";
import { publishFirstFill } from "./first-fill";
import { VENDOR_TABLES } from "./vendor-publication-schema";

/**
 * A ranged rebuild reads new or changed journal suffixes, but publication may expose
 * only the selected timestamps. Canonical probe dependencies are merged with
 * their counters. Transport receipts and file bookmarks are deliberately not
 * published: neither can truthfully acknowledge the intentionally omitted rows.
 */
function restrictStagedGaugeRange(
  active: Database,
  selected?: ReparseRange,
  accountSelection = false,
): { from: string | null; untilExclusive: string | null } | undefined {
  if (!selected?.from && !selected?.until) return;
  const endpoint = (raw: string, end: boolean): string => {
    const time = Date.parse(`${raw}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(time)
      || new Date(time).toISOString().slice(0, 10) !== raw) {
      throw new Error("Invalid ranged gauge publication UTC day");
    }
    return new Date(time + (end ? 86_400_000 : 0)).toISOString();
  };
  const from = selected.from ? endpoint(selected.from, false) : null;
  const until = selected.until ? endpoint(selected.until, true) : null;
  if (from && until && from >= until) throw new Error("Invalid ranged gauge publication interval");
  // Account selection replaces the staged projection itself after its preflight.
  if (accountSelection) return { from, untilExclusive: until };
  const predicate = (expression: string) => {
    const clauses: string[] = [], params: SQLQueryBindings[] = [];
    if (from) { clauses.push(`julianday(${expression}) >= julianday(?)`); params.push(from); }
    if (until) { clauses.push(`julianday(${expression}) < julianday(?)`); params.push(until); }
    return { sql: clauses.join(" AND "), params };
  };
  const timestamp = predicate(quoteIdentifier("ts"));
  active.query(`DELETE FROM sync_stage.probe_windows WHERE NOT COALESCE((${timestamp.sql}), 0)`).run(...timestamp.params);
  // Canonical evidence is immutable even in a stage; merge only its selected projection.
  // A receipt can cover more evidence than the selected projection, and a file
  // bookmark covers the whole byte prefix. Ordinary replay must revisit both.
  active.exec("DELETE FROM sync_stage.gauge_journal_receipts; DELETE FROM sync_stage.gauge_files");
  return { from, untilExclusive: until };
}

/**
 * Append publish for journal vendors: staged rows are added to the live tables
 * unless an equal sample is already there. The dedupe key deliberately leaves
 * out `subject` â€” an era re-stamp may have rewritten it since the sample was
 * journaled â€” and identifies a sample by when, where and what was read.
 */
export function publishAppendDelta(
  active: Database,
  stagePath: string,
  commitMetadata: (inserted: number, meters?: ReturnType<typeof restrictGaugeAccountPublication>) => void,
  retainLiveBookmarks = false,
  selectedRange?: ReparseRange,
  selectedAccounts?: readonly RebuildAccount[],
  sourceOptions?: ProbeSourceOptions,
  firstFillIndexes?: (elapsedMs:number) => void,
  measure:<T>(name:string,work:()=>T)=>T = (_name,work)=>work(),
): void {
  if (!selectedAccounts) measure("probeBackfillMs",()=>backfillProbeFacts(active));
  active.exec(`ATTACH DATABASE ${sqlString(stagePath)} AS sync_stage`);
  let failure: unknown = null;
  try {
    let receipt: {inserted:number;meters?:ReturnType<typeof restrictGaugeAccountPublication>} | undefined;
    const publishRows = () => {
      const publicationRange = measure("gaugeRangeMs",()=>restrictStagedGaugeRange(active, selectedRange, !!selectedAccounts));
      if (selectedAccounts && !sourceOptions) throw new Error("Gauge account publication requires source declarations");
      const meters = selectedAccounts
        ? restrictGaugeAccountPublication(active, selectedAccounts, {
          ...sourceOptions!, resolver: loadAccountResolver(active, sourceOptions!.declarations),
        }, publicationRange) : undefined;
      // A replay with altered content fails before facts, bookmarks or revisions move.
      if (active.query(`SELECT 1 FROM main.gauge_journal_receipts m
          JOIN sync_stage.gauge_journal_receipts s ON s.entry_id = m.entry_id
          WHERE s.payload_hash <> m.payload_hash LIMIT 1`).get()) {
        throw new Error("Gauge journal entry identity conflict");
      }
      const canonicalInserted = measure("probeFactMergeMs",()=>mergeProbeFacts(active, publicationRange, !!selectedAccounts));
      measure("journalReceiptMergeMs",()=>active.exec(`INSERT OR IGNORE INTO main.gauge_journal_receipts (entry_id,payload_hash,ts)
        SELECT entry_id,payload_hash,ts FROM sync_stage.gauge_journal_receipts`));
      let inserted = 0;
      const probeColumns = tableColumns(active, "probe_windows").filter((column) => column !== "id");
      // OR IGNORE: the partial unique indexes leave `machine` out, so two PCs
      // sampling the same subject in the same millisecond would otherwise
      // fail this transaction on every run and freeze the journal bookmark.
      const projectionInserted=measure("gaugeInsertMs",()=>{active
        .query(
          `INSERT OR IGNORE INTO main.probe_windows (${probeColumns.map(quoteIdentifier).join(", ")})
           SELECT ${probeColumns.map((column) => `s.${quoteIdentifier(column)}`).join(", ")}
             FROM sync_stage.probe_windows AS s
            WHERE NOT EXISTS (
              SELECT 1 FROM main.probe_windows AS m
               WHERE m.provider = s.provider AND m.ts = s.ts
                 AND m.kind IS s.kind AND m.limit_group IS s.limit_group AND m.scope IS s.scope
                 AND m.profile IS s.profile AND m.machine IS s.machine
                 AND json_extract(m.extra, '$.home') IS json_extract(s.extra, '$.home'))`
        )
        .run();return directChanges(active);});
      inserted += projectionInserted;
      const bookmarkNames = tableColumns(active, "gauge_files").map(quoteIdentifier);
      const bookmarkColumns = bookmarkNames.join(", ");
      // This publication only inserts journal rows, deduplicated by receipt and by
      // the probe uniqueness indexes, so it cannot have removed anything the live
      // journal position already covered. Replacing that position with the rebuild's
      // reading would discard real progress; a journal that was truncated or
      // rewritten keeps whatever the live ingest last recorded and is reread.
      measure("gaugeBookmarksMs",()=>active.exec(retainLiveBookmarks
        ? `INSERT INTO main.gauge_files (${bookmarkColumns})
           SELECT ${bookmarkNames.map((column) => `s.${column}`).join(", ")} FROM sync_stage.gauge_files AS s
            WHERE NOT EXISTS (SELECT 1 FROM main.gauge_files AS m WHERE m.store = s.store AND m.path = s.path)`
        : `INSERT OR REPLACE INTO main.gauge_files (${bookmarkColumns})
           SELECT ${bookmarkColumns} FROM sync_stage.gauge_files`
      ));
      measure("probeFactLinksMs",()=>linkPublishedProbeFacts(active, true, !!firstFillIndexes));
      receipt = {inserted:Math.max(inserted, canonicalInserted),meters};
    };
    const publish = () => {
      if (firstFillIndexes) {
        publishFirstFill(active,VENDOR_TABLES.gauges.publish,publishRows,firstFillIndexes,measure);
        // After the index rebuild: the check looks every row's link up.
        measure("probeBackfillCursorMs",()=>advanceLinkedProbeBackfill(active));
      } else publishRows();
      commitMetadata(receipt!.inserted,receipt!.meters);
    };
    active.transaction(publish).immediate();
  } catch (error) {
    quarantineProbeConflict(active, error);
    failure = error;
  }
  try {
    active.exec("DETACH DATABASE sync_stage");
  } catch (error) {
    if (failure == null) failure = error;
  }
  if (failure != null) throw failure;
}
