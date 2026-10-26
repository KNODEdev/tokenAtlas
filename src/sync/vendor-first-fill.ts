import type { VendorTelemetry } from "./vendor-progress";
import type { Database } from "../db/sqlite";
import { DELTA_SPECS, VENDOR_TABLES, vendorSourceTables } from "./vendor-publication-schema";
import { firstFillIdentities } from "./publication-identities";
import { compareClaudePublicationText } from "./claude-source-publication";
import { quoteIdentifier, tableColumns } from "./sync-sql";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { FirstFillPublication, firstFillImpact } from "./first-fill";
import { directChanges } from "../db/change-count";
import { markCodexLedgerCopiesDirty } from "../db/codex-ledger-producer";
import { markLimitWindowsDirty, ALL_ACCOUNTS, LIMIT_WINDOW_ALL } from "../db/limit-windows";
import { dirtyRangesFromTimestamps } from "./dirty-ranges";
import type { StagePublicationServices, StagePublicationWork } from "./vendor-stage-publication";

export function publishVendorFirstFill(
  services: StagePublicationServices,
  work: StagePublicationWork,
  telemetry: VendorTelemetry,
  stage: Database,
  recordProjectRules: () => void,
): void {
  const { sqlite, options, store, now, saveRun } = services;
  const { outcome, result, publicationState, saveCompletedSourceBookmark } = work;
  const { timings, measureTiming, publicationProgress, timingStart, timingEnd, measurePublication } = telemetry;
  // An empty provider needs no comparison; keep the skipped span explicit even on rollback.
  timings.comparisonMs = 0;
  outcome.diagnostics.firstFill = true;
  const vendor = outcome.vendor;
  const tables = VENDOR_TABLES[vendor].publish;
  const identities = measureTiming("identitySelectionMs",()=>firstFillIdentities(stage,vendor));
  if(vendor === "claude") identities.sort((left,right)=>
    compareClaudePublicationText(String(left.store),String(right.store))
    || compareClaudePublicationText(String(left.path),String(right.path)));
  const alias = "__tokenatlas_first_fill";
  sqlite.query(`ATTACH DATABASE ? AS ${quoteIdentifier(alias)}`)
    .run(`${pathToFileURL(path.resolve(stage.filename)).href}?mode=ro`);
  const transact = (work: () => void) => sqlite.transaction(work).immediate();
  const spec=DELTA_SPECS[vendor];
  const keys=spec.identity.map(quoteIdentifier);
  let fill: FirstFillPublication | undefined;
  let committed = false;
  options.beforeIncrementalPublish?.();
  const publicationStarted = timingStart();
  try {
    // Row counts of the staged tables give the transfer a real denominator.
    const stagedTotal = tables.reduce((sum, table) => sum + (sqlite.query(
      `SELECT count(*) n FROM ${quoteIdentifier(alias)}.${quoteIdentifier(table)}`).get() as {n:number}).n, 0);
    let transferred = 0;
    publicationProgress.report("write", 0, stagedTotal);
    fill = FirstFillPublication.begin(sqlite, vendor, tables, transact, measurePublication);
    sqlite.exec(`DROP TABLE IF EXISTS temp.first_fill_identities;
      CREATE TEMP TABLE first_fill_identities (seq INTEGER PRIMARY KEY, ${keys.join(",")})`);
    try {
      measureTiming("insertMs",() => {
        using add=sqlite.prepare(`INSERT INTO temp.first_fill_identities (${keys.join(",")}) VALUES (${keys.map(()=>"?").join(",")})`);
        sqlite.transaction(()=>{for(const identity of identities) add.run(...spec.identity.map(column=>identity[column]!));}).deferred();
        for (const table of tables) {
          const columns = tableColumns(sqlite,table).filter(column => column !== "id").map(quoteIdentifier);
          const within = vendor==="claude" && VENDOR_TABLES[vendor].data.includes(table) ? "s.call_id" : "s.rowid";
          // Identity order, then call_id or rowid: the ordinary publisher's row order, batch after batch.
          // CROSS JOIN keeps the identities as the outer loop; each looks its rows up by key, and
          // `+` keeps the inner term off index selection (the (store,call_id) index scanned a whole
          // store per file).
          using move = sqlite.prepare(`INSERT INTO main.${quoteIdentifier(table)} (${columns.join(",")})
            SELECT ${columns.map(column=>`s.${column}`).join(",")} FROM temp.first_fill_identities i
            CROSS JOIN ${quoteIdentifier(alias)}.${quoteIdentifier(table)} s ON ${keys.map(key=>`s.${key}=i.${key}`).join(" AND ")}
            WHERE i.seq BETWEEN ? AND ? ORDER BY i.seq, +${within}`);
          let from = 1;
          fill!.move(size => {
            const to = Math.min(identities.length, from + size - 1);
            move.run(from, to);
            transferred += directChanges(sqlite);
            publicationProgress.report("write", transferred, stagedTotal);
            from = to + 1;
            return from > identities.length;
          });
        }
        if (vendor === "opencode") transact(() => sqlite.exec(`INSERT INTO main.meta(key,value)
          SELECT key,value FROM ${quoteIdentifier(alias)}.meta WHERE key LIKE 'opencode_snapshot:%'
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`));
      });
    } finally { sqlite.exec("DROP TABLE IF EXISTS temp.first_fill_identities"); }
    const indexesStarted = performance.now();
    fill.restore((built, total) => publicationProgress.report("indexes", built, total), measurePublication);
    timings.indexBuildMs = Math.round(performance.now() - indexesStarted);
    // Read before the receipt, so its transaction holds only the receipt's writes.
    const sourceImpact = firstFillImpact(sqlite,VENDOR_TABLES[vendor].data);
    const timestamps: string[] = [];
    for (const table of VENDOR_TABLES[vendor].data)
      for (const row of sqlite.query(`SELECT min(ts) low,max(ts) high FROM ${quoteIdentifier(table)} WHERE ts IS NOT NULL GROUP BY substr(ts,1,10)`).all() as Array<{low:string;high:string}>) timestamps.push(row.low,row.high);
    const dataChanged = vendorSourceTables(vendor).some(table=>!!sqlite.query(`SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1`).get());
    publicationProgress.report("commit");
    fill.commit(() => {
      // No accepted-facts proofs here: they would encode every row of history in JS. A later
      // ordinary publication proves the identities it touches; missing proofs read the facts.
      if (vendor === "codex") markCodexLedgerCopiesDirty(sqlite,
        identities.map(identity => ({home:String(identity.home),path:String(identity.path)})));
      // A first fill replaces every transcript reading: the registers are prepared from the start.
      if (vendor === "codex" || vendor === "claude") markLimitWindowsDirty(sqlite, vendor, ALL_ACCOUNTS, LIMIT_WINDOW_ALL);
      outcome.sourceImpact = sourceImpact;
      outcome.dirtyRanges = dirtyRangesFromTimestamps(timestamps);
      const sorted=[...timestamps].sort();
      outcome.dirtyRange=sorted.length?{from:sorted[0]!,to:sorted.at(-1)!}:null;
      outcome.dataChanged = dataChanged;
      outcome.diagnostics.deltaIdentities = identities.length;
      outcome.diagnostics.changedIdentities = outcome.dataChanged ? identities.length : 0;
      recordProjectRules();
      if (outcome.dataChanged) {
        options.afterPublishBeforeRevision?.();
        result.afterRevisions = store.advanceDataInTransaction(vendor,now());
        result.aggregateWorkRequested = true;
        publicationState.affected.set(vendor,identities);
      }
      outcome.status = "success";
      outcome.finishedAt = now();
      saveCompletedSourceBookmark();
      saveRun(result);
    }, measurePublication);
    committed = true;
  } catch (error) {
    // Until its receipt commits the vendor is not imported: back to empty, files still queued.
    // An undo that fails leaves the marker, and the next run undoes the fill instead.
    if (fill && !committed) {
      try { fill.abort(); }
      catch (undo) { console.warn(`[sync] first fill of ${vendor} left for the next run to undo: ${undo instanceof Error ? undo.message : String(undo)}`); }
    }
    throw error;
  } finally {
    timingEnd("publicationMs",publicationStarted);
    sqlite.exec(`DETACH DATABASE ${quoteIdentifier(alias)}`);
  }
}
