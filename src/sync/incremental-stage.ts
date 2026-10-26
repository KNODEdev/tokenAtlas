import { Database } from "../db/sqlite";
import type { VendorId } from "./contracts";
import type { ValidationStep } from "./vendor-progress";
import { VENDOR_TABLES, acceptedFactsSpecs, DELTA_SPECS } from "./vendor-publication-schema";
import { tableColumns, quoteIdentifier, tableExists } from "./sync-sql";
import fs from "node:fs";
import { constants } from "bun:sqlite";
import { omitStageAnalysisTracking } from "./stage-tracking";
import { omitAcceptedFactsTracking } from "./accepted-facts";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { SQLQueryBindings } from "../db/sqlite";
import { ARCHIVE_ROOT, toArchiveLogicalPath } from "../config/paths";
import type { ClaudePublicationRow } from "./claude-source-publication";
import { mergeClaudePublicationRows } from "./claude-source-publication";

export function validateStage(sqlite: Database, vendor: VendorId, validationErrors: string[],
  report?: (operation: ValidationStep, item?: number, items?: number) => void, acceptedUnchanged = false,
  measure: (name:string,work:()=>void)=>void = (_name,work)=>work(), integrity = true): void {
  if (validationErrors.length > 0) throw new Error(validationErrors.join("; "));
  report?.("integrity");
  if (integrity) measure("quickCheckMs",()=>{
    const check = sqlite.query("PRAGMA quick_check").get() as { quick_check: string } | null;
    if (check?.quick_check !== "ok") throw new Error(`SQLite validation failed: ${check?.quick_check ?? "no result"}`);
  });
  // Matching accepted facts cannot introduce a timestamp defect. Integrity still checks the scratch file.
  if (acceptedUnchanged) return;
  measure("timestampValidationMs",()=>{for (const [index, table] of VENDOR_TABLES[vendor].data.entries()) {
    report?.("timestamps", index + 1, VENDOR_TABLES[vendor].data.length);
    if (tableColumns(sqlite, table).length === 0) throw new Error(`Validation failed: ${table} is missing`);
    const invalid = sqlite
      .query(`SELECT count(*) AS n FROM ${quoteIdentifier(table)} WHERE ts IS NULL OR ts = ''`)
      .get() as { n: number } | null;
    if ((invalid?.n ?? 0) > 0) throw new Error(`Validation failed: ${table} contains empty timestamps`);
  }});
}

export function createIncrementalStage(active: Database, stagePath: string, vendor: VendorId, selectedFiles?:string[]): void {
  if (fs.existsSync(stagePath)) fs.unlinkSync(stagePath);
  const stage = new Database(stagePath, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_URI);
  try {
    stage.exec("PRAGMA foreign_keys = OFF");
    // Scratch file: it is validated with quick_check before publish and
    // deleted on any failure, so durability per DDL statement only costs
    // fsyncs (about a second per vendor on Windows).
    stage.exec("PRAGMA journal_mode = OFF");
    stage.exec("PRAGMA synchronous = OFF");
    const schema = active
      .query(
        `SELECT type, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
          ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name`
      )
      .all() as Array<{ type: string; sql: string }>;
    stage.transaction(() => {
      for (const item of schema) stage.exec(item.sql);
    }).immediate();
    omitStageAnalysisTracking(stage);
    // Accepted proofs belong to the active database; scratch imports have no proofs to invalidate.
    omitAcceptedFactsTracking(stage, acceptedFactsSpecs());
    stage.query("ATTACH DATABASE ? AS seed_source")
      .run(`${pathToFileURL(path.resolve(active.filename)).href}?mode=ro`);
    const copy = (table: string, where = "", params: SQLQueryBindings[] = []) => {
      if (!tableExists(active, table) || !tableExists(stage, table)) return;
      const columns = tableColumns(active, table).map(quoteIdentifier).join(", ");
      stage.query(`INSERT INTO main.${quoteIdentifier(table)} (${columns})
        SELECT ${columns} FROM seed_source.${quoteIdentifier(table)} AS s ${where}`).run(...params);
    };
    // The rules the stage's rows are mapped with are the stage remap's own, never the main database's.
    copy("meta", "WHERE s.key <> 'projects_fingerprint'");
    if (vendor === "gauges") {
      copy("probe_fact_backfill_checkpoints");
      // Only counters actually read from journals may recover projections.
      stage.exec("CREATE TABLE gauge_replay_counters (counter_id TEXT PRIMARY KEY NOT NULL, ts TEXT NOT NULL)");
    }
    const bookmarkTable = DELTA_SPECS[vendor].bookmarkTable;
    if (bookmarkTable) {
      if(selectedFiles && vendor === "gauges") {
        const files = selectedFiles.map(file => {
          const relative = path.relative(path.join(ARCHIVE_ROOT, "gauges"), file).split(path.sep);
          if (relative.length !== 2 || relative[0] === ".." || path.isAbsolute(relative.join(path.sep))) throw new Error(`Invalid gauge bookmark path: ${file}`);
          return { store: relative[0]!, path: relative[1]! };
        });
        copy(bookmarkTable, `WHERE EXISTS (SELECT 1 FROM json_each(?) f
          WHERE json_extract(f.value,'$.store')=s.store AND json_extract(f.value,'$.path')=s.path)`, [JSON.stringify(files)]);
      } else if(selectedFiles) {
        copy(bookmarkTable, "WHERE s.path IN (SELECT value FROM json_each(?))", [JSON.stringify(selectedFiles.map(toArchiveLogicalPath))]);
      } else copy(bookmarkTable);
    }
    stage.exec("DETACH DATABASE seed_source");
  } finally {
    stage.close();
  }
}

/** Incremental stages start empty, so retain evidence from earlier copies before publication. */
export function retainClaudeIdentityEvidence(active: Database, stage: Database): void {
  type Identity = { store: string; call_id: string; account_key: string | null; subscription_id: string | null; subscription_conflict: number };
  const columns = "store,call_id,account_key,subscription_id,subscription_conflict";
  const prior = active.query(`SELECT ${columns} FROM claude_events WHERE store=? AND call_id=? AND (account_key IS NOT NULL OR subscription_conflict=1)`);
  const update = stage.query("UPDATE claude_events SET account_key=?,subscription_id=?,subscription_conflict=? WHERE store=? AND call_id=?");
  stage.transaction(() => {
    for (const row of stage.query(`SELECT ${columns} FROM claude_events`).all() as Identity[]) {
      const old = prior.get(row.store, row.call_id) as Identity | null;
      if (!old) continue;
      const conflict = Boolean(old.subscription_conflict || row.subscription_conflict || (old.account_key && row.account_key && old.account_key !== row.account_key));
      if (conflict) update.run(row.account_key ?? old.account_key, null, 1, row.store, row.call_id);
      else if (!row.account_key && old.account_key) update.run(old.account_key, old.subscription_id, 0, row.store, row.call_id);
    }
  }).immediate();
}

/** Compare the eventual merged facts, including calls owned by an unread or pruned file. */
export function retainClaudeUnreadOwners(active: Database, stage: Database, selectedFiles: string[]): void {
  const selected = new Set(selectedFiles.map(toArchiveLogicalPath));
  const columns = tableColumns(stage, "claude_events").filter(column => column !== "id");
  const readStage = new Database(stage.filename, { readonly: true, safeIntegers: true });
  let rows: ClaudePublicationRow[];
  try { rows = readStage.query("SELECT * FROM claude_events").all() as ClaudePublicationRow[]; }
  finally { readStage.close(); }
  const readActive = new Database(active.filename, { readonly: true, safeIntegers: true });
  try {
    const prior = readActive.query("SELECT * FROM claude_events WHERE store=? AND call_id=?");
    const retainedOwners = new Set<string>();
    const retainedTables = VENDOR_TABLES.claude.publish.map(table => {
      const names = tableColumns(stage, table).filter(column => column !== "id");
      return { names, read: readActive.query(`SELECT * FROM ${quoteIdentifier(table)} WHERE store=? AND path=?`),
        write: stage.query(`INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${names.map(quoteIdentifier).join(",")})
          VALUES (${names.map(() => "?").join(",")})`) };
    });
    const update = stage.query(`UPDATE claude_events SET ${columns.map(column => `${quoteIdentifier(column)}=?`).join(",")}
      WHERE store=? AND call_id=?`);
    stage.transaction(() => {
      for (const row of rows) {
        const old = prior.get(row.store!, row.call_id!) as ClaudePublicationRow | null;
        if (!old || selected.has(String(old.path))) continue;
        const merged = mergeClaudePublicationRows([row, old], columns);
        update.run(...columns.map(column => merged[column] ?? null), row.store!, row.call_id!);
        if (merged.path === old.path) {
          const owner = JSON.stringify([old.store, old.path]);
          if (retainedOwners.has(owner)) continue;
          retainedOwners.add(owner);
          // Adding the owner's identity also admits its other calls, refusals and bookmark to the diff.
          for (const table of retainedTables) {
            for (const retained of table.read.all(old.store!, old.path!) as ClaudePublicationRow[])
              table.write.run(...table.names.map(column => retained[column] ?? null));
          }
        }
      }
    }).immediate();
  } finally { readActive.close(); }
}
