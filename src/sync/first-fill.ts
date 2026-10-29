import { Database } from "../db/sqlite";
import { isAnalysisRevisionTrackingTrigger } from "../db/analysis";
import { isFactDayRevisionTrigger, recordFactDayRevisions } from "../db/fact-day-revisions";
import type { VendorSourceImpact } from "./contracts";
import { unavailableSourceImpact } from "./source-impact";
import { runInBatches } from "../db/batches";
import { isModelTimelineTrigger, recordModelTimelineChanges } from "../db/model-timeline";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export function tablesAreEmpty(db: Database, tables: readonly string[]): boolean {
  return tables.every(table => !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
    || !db.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get());
}

type Measure = (name: string, work: () => void) => void;
const unmeasured: Measure = (_name, work) => work();

/** An index or trigger a table being filled from empty does without until the fill ends. */
interface FillOnlyObject { type: string; name: string; tbl_name: string; sql: string }

/**
 * Non-unique indexes, the analysis revision trackers, the fact-day revision triggers and the accepted-facts
 * trackers of `tables`. An empty vendor has no accepted proof for the last to invalidate, the
 * trackers' effect is recorded once for the whole table, and the indexes are built once.
 */
function fillOnlyObjects(db: Database, tables: readonly string[]): FillOnlyObject[] {
  const objects = db.query(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE type IN ('index','trigger') AND sql IS NOT NULL`).all() as FillOnlyObject[];
  return objects.filter(item => tables.includes(item.tbl_name) && (item.type === "index"
    ? !(db.query(`PRAGMA index_list(${quote(item.tbl_name)})`).all() as Array<{name:string;unique:number}>).find(index => index.name === item.name)?.unique
    : isAnalysisRevisionTrackingTrigger(db,item.name,item.tbl_name,item.sql)
      || isFactDayRevisionTrigger(db,item.name,item.tbl_name,item.sql)
      || isModelTimelineTrigger(item.name,item.tbl_name,item.sql)
      || item.name.startsWith("sync_accepted_facts_")));
}
const isRevision = (name: string) => name.startsWith("analysis_");

/** Qualified: a stage attached for the copy has objects of the same names. */
function dropObjects(db: Database, objects: readonly FillOnlyObject[]): void {
  for (const item of objects) db.exec(`DROP ${item.type.toUpperCase()} IF EXISTS main.${quote(item.name)}`);
}

/** The global change clocks and fact-day revisions the dropped triggers would have counted. */
function recordTrackedChanges(db: Database, tables: readonly string[], objects: readonly FillOnlyObject[]): void {
  for (const table of tables) {
    if (objects.some(item => item.tbl_name === table && isRevision(item.name))) {
      db.query(`INSERT INTO analysis_source_revisions(source,bucket,revision)
        SELECT ?,'*',count(*) FROM ${quote(table)} HAVING count(*)>0
        ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+excluded.revision`).run(table);
    }
    if (objects.some(item => item.tbl_name === table && item.name.startsWith("fact_day_revision_"))) recordFactDayRevisions(db, table);
    if (objects.some(item => item.tbl_name === table && isModelTimelineTrigger(item.name,item.tbl_name,item.sql))) recordModelTimelineChanges(db, table);
  }
}

/**
 * First fill inside the caller's single transaction, for a publication that is one set-based
 * statement (the gauge readings' canonical merge): the plan's named first-fill exception,
 * held while no other writer runs.
 */
export function publishFirstFill(db: Database, tables: readonly string[], write: () => void,
  onIndexes?: (elapsedMs: number) => void, measure: Measure = unmeasured): void {
  if (!db.inTransaction) throw new Error("First fill requires a publication transaction");
  if (!tablesAreEmpty(db, tables)) throw new Error("First-fill destination changed; retry publication");
  const owned = fillOnlyObjects(db, tables);
  measure("dropIndexesMs", () => dropObjects(db, owned));
  write();
  measure("changeClocksMs", () => recordTrackedChanges(db, tables, owned));
  const started = performance.now();
  measure("indexBuildMs", () => { for (const item of owned) db.exec(item.sql); });
  onIndexes?.(Math.round(performance.now() - started));
}

/** Runs one unit of publication work in its own write transaction (and under its change origin). */
export type Transact = (work: () => void) => void;

const MARKER = "first_fill:";

/**
 * First fill of an empty vendor in short transactions. While the synchronization run holds the
 * run lock no other writer runs, so the rows can move batch by batch instead of in one
 * transaction lasting minutes:
 *
 * 1. `begin` drops the fill-only objects of the vendor's tables and leaves a marker in `meta`
 *    naming them (one short transaction);
 * 2. `move` runs a batch step repeatedly, each in its own transaction (src/db/batches.ts);
 * 3. `restore` rebuilds the indexes and trackers; each index is built in its own transaction -
 *    a single statement, the plan's named first-fill exception;
 * 4. `commit` records the change clocks, runs the receipt and removes the marker in one
 *    transaction.
 *
 * Until `commit` the vendor counts as not imported: its files stay queued, and `abort` (or
 * {@link recoverFirstFills} after a crash) removes the moved rows and restores the objects, so
 * the next run fills the vendor again from empty. The rows end up identical to one
 * transaction's: batches follow the same order.
 */
export class FirstFillPublication {
  private constructor(private readonly db: Database, private readonly vendor: string,
    private readonly tables: readonly string[], private readonly objects: readonly FillOnlyObject[],
    private readonly transact: Transact) {}

  static begin(db: Database, vendor: string, tables: readonly string[], transact: Transact, measure: Measure = unmeasured): FirstFillPublication {
    let objects: FillOnlyObject[] = [];
    measure("dropIndexesMs", () => transact(() => {
      if (!tablesAreEmpty(db, tables)) throw new Error("First-fill destination changed; retry publication");
      objects = fillOnlyObjects(db, tables);
      db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(`${MARKER}${vendor}`, JSON.stringify({ tables, objects }));
      // The accepted-facts trackers would delete this vendor's proofs row by row; there are none to keep.
      if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_accepted_facts'").get())
        db.query("DELETE FROM sync_accepted_facts WHERE vendor=?").run(vendor);
      dropObjects(db, objects);
    }));
    return new FirstFillPublication(db, vendor, tables, objects, transact);
  }

  /** Moves rows in successive short transactions until `step(size)` reports it is done (see {@link runInBatches}). */
  move(step: (size: number) => boolean): void {
    runInBatches(this.transact, step);
  }

  /** Indexes, each in its own transaction, then the trackers; reports indexes built of all. */
  restore(onIndex?: (built: number, total: number) => void, measure: Measure = unmeasured): void {
    const indexes = this.objects.filter(item => item.type === "index"), triggers = this.objects.filter(item => item.type !== "index");
    measure("indexBuildMs", () => {
      onIndex?.(0, indexes.length);
      for (const [built, item] of indexes.entries()) {
        this.transact(() => this.db.exec(item.sql));
        onIndex?.(built + 1, indexes.length);
      }
    });
    this.transact(() => { for (const item of triggers) this.db.exec(item.sql); });
  }

  /** The change clocks, the receipt and the marker's removal, together. */
  commit(receipt: () => void, measure: Measure = unmeasured): void {
    this.transact(() => {
      // Read through the rebuilt day indexes; committed with the receipt, so an undone fill counts nothing.
      measure("changeClocksMs", () => recordTrackedChanges(this.db, this.tables, this.objects));
      receipt();
      this.db.query("DELETE FROM meta WHERE key=?").run(`${MARKER}${this.vendor}`);
    });
  }

  /** Back to empty: the moved rows go, the objects come back, the marker is removed. */
  abort(): void {
    restoreEmpty(this.db, this.vendor, this.tables, this.objects);
  }
}

function restoreEmpty(db: Database, vendor: string, tables: readonly string[], objects: readonly FillOnlyObject[]): void {
  db.transaction(() => {
    // Without trackers and indexes a whole-table delete is a truncation, not a row-by-row change.
    dropObjects(db, objects);
    for (const table of tables) db.exec(`DELETE FROM main.${quote(table)}`);
    for (const item of objects) db.exec(item.sql);
    db.query("DELETE FROM meta WHERE key=?").run(`${MARKER}${vendor}`);
  }).immediate();
}

/**
 * A first fill a stopped process left unfinished: its rows are removed and its objects
 * restored, so the vendor is empty again and is filled again from its still-queued files.
 * Called by the run that holds the run lock, when no fill of its own has begun.
 */
/** Whether a stopped run left a first fill to undo (`recoverFirstFills` has work). */
export function hasUnfinishedFirstFills(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()
    && !!db.query("SELECT 1 FROM meta WHERE key LIKE ? LIMIT 1").get(`${MARKER}%`);
}

export function recoverFirstFills(db: Database): string[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) return [];
  const markers = db.query("SELECT key,value FROM meta WHERE key LIKE ?").all(`${MARKER}%`) as Array<{key:string;value:string}>;
  for (const marker of markers) {
    const { tables, objects } = JSON.parse(marker.value) as { tables: string[]; objects: FillOnlyObject[] };
    restoreEmpty(db, marker.key.slice(MARKER.length), tables, objects);
  }
  return markers.map(marker => marker.key.slice(MARKER.length));
}

/** No old record exists: counts are exact, while canonical cross-copy selection remains unknown. */
export function firstFillImpact(db: Database, tables: readonly string[]): VendorSourceImpact {
  const result = unavailableSourceImpact("first-fill-canonical-selection-not-proven", true);
  const count = tables.reduce((total, table) => total + BigInt((db.query(`SELECT CAST(count(*) AS TEXT) n FROM ${quote(table)}`).get() as {n:string}).n), 0n);
  result.sourceFactsChanged = {status:"available",value:String(count),reason:null};
  result.sourceCorrections = {status:"available",value:"0",reason:null};
  result.sourceDeletions = {status:"available",value:"0",reason:null};
  return result;
}
