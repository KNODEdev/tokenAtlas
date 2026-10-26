import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** Change clocks describe arrival/correction, independently of the event's historical date. */
const SOURCES = ["events", "ratelimit", "claude_events", "claude_limit_hits", "oc_events", "grok_events", "gemini_events", "probe_windows",
  "sync_runs",
  "account_periods",
  "files", "claude_files", "meta", "sync_revisions", "vendor_sync_revisions"] as const;

/** The change-tracking schema (revision clocks of the source tables) is present. */
export function hasAnalysisSchema(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_source_revisions'").get() != null;
}

type TrackingOperation = "insert" | "delete" | "update";
const normalizedSql = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The current statement first, then exact former statements that tracked every change it tracks.
 * A table's change bumps its whole-table clock (`*`), which the response cache keys on. Former
 * versions also bumped one clock per stored day.
 */
function trackingStatements(table: string, columns: readonly string[], operation: TrackingOperation): string[] {
  const time=columns.includes("ts")?"ts":columns.includes("day")?"day":null;
  const total=`INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('${table}','*',1)
      ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1;`;
  const perDay=(side:string)=>`INSERT INTO analysis_source_revisions(source,bucket,revision)
      VALUES ('${table}',${time?`COALESCE(substr(${side}."${time}",1,10),'')`:"''"},1)
      ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1;
      ${total}`;
  const changed=columns.map(c=>`OLD."${c}" IS NOT NEW."${c}"`).join(" OR ");
  const name=`analysis_${table}_${operation}`;
  const formerBody=operation==="update"?`${perDay("OLD")} ${perDay("NEW")}` : perDay(operation==="insert"?"NEW":"OLD");
  const create=(when:string|null,statements:string)=>
    `CREATE TRIGGER ${name} AFTER ${operation.toUpperCase()} ON "${table}" ${when?`WHEN ${when}`:""} BEGIN ${statements} END`;
  const plainWhen=operation==="update"?changed||"1":null;
  // Projection progress is private writer state, not an analysis fact.
  const tracked = table === "meta" ? operation === "update"
    ? `(${changed||"1"}) AND (substr(OLD.key,1,11) <> 'current_v2_' OR substr(NEW.key,1,11) <> 'current_v2_')`
    : `substr(${operation === "insert" ? "NEW" : "OLD"}.key,1,11) <> 'current_v2_'`
    : plainWhen;
  const statements=[create(tracked,total),create(tracked,formerBody)];
  if(table==="meta")statements.push(create(plainWhen,formerBody));
  if(["events","ratelimit"].includes(table) && columns.includes("home") && columns.includes("path")) {
    // Former W6 dirty-queue side effect: the same revision bumps plus a queue row.
    const dirty=(side:string)=>`INSERT OR IGNORE INTO analysis_attribution_dirty(home,path)
      VALUES (COALESCE(${side}.home,''),COALESCE(${side}.path,''));`;
    statements.push(create(plainWhen,operation==="update"
      ? `${formerBody} ${dirty("OLD")} ${dirty("NEW")}` : `${formerBody} ${dirty(operation==="insert"?"NEW":"OLD")}`));
  }
  return statements;
}

/** Recognize generated revision tracking, never guards or unrelated same-prefix triggers. */
export function isAnalysisRevisionTrackingTrigger(db:Database,name:string,table:string,sql:string):boolean {
  if(!(SOURCES as readonly string[]).includes(table))return false;
  const operation=(["insert","delete","update"] as const).find(item=>name===`analysis_${table}_${item}`);
  if(!operation)return false;
  const columns=(db.query(`PRAGMA table_info("${table}")`).all() as {name:string}[]).map(column=>column.name);
  return columns.length>0 && trackingStatements(table,columns,operation).some(candidate=>normalizedSql(candidate)===normalizedSql(sql));
}

/** Migration 0041 replaces tracking it must drop for DDL with this guard, so no write can pass untracked. */
const trackingGuardSql = (name: string, table: string, operation: TrackingOperation) =>
  `CREATE TRIGGER ${name} BEFORE ${operation.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END`;
type TrackingHandoff = { columns: string[]; triggers: Record<string, string> };

function trackingHandoffs(db: Database): Map<string, TrackingHandoff> {
  const handoffs=new Map<string,TrackingHandoff>();
  if(!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_tracking_handoff'").get())return handoffs;
  for(const row of db.query("SELECT source,columns,triggers FROM analysis_tracking_handoff").all() as {source:string;columns:string;triggers:string}[])
    handoffs.set(row.source,{columns:JSON.parse(row.columns),triggers:JSON.parse(row.triggers)});
  return handoffs;
}

export function installAnalysisTracking(db: Database): void {
  if (!hasAnalysisSchema(db)) return;
  db.transaction(()=> {
    const handoffs=trackingHandoffs(db);
    for(const table of SOURCES) {
      const columns=(db.query(`PRAGMA table_info("${table}")`).all() as {name:string}[]).map(c=>c.name);
      if(!columns.length)continue;
      const handoff=handoffs.get(table);
      let invalidate=false;
      for(const operation of ["insert","delete","update"] as const) {
        const name=`analysis_${table}_${operation}`;
        const [sql,...former]=trackingStatements(table,columns,operation);
        const existing=db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as {sql:string}|null;
        const matches=(candidates:readonly string[],value:string|undefined)=>
          value!==undefined && candidates.some(candidate=>normalizedSql(candidate)===normalizedSql(value));
        if(handoff) {
          // The guard blocked every write since the migration dropped the recorded trigger,
          // so only the recorded trigger decides whether a change could have been missed.
          const guarded=matches([trackingGuardSql(name,table,operation)],existing?.sql);
          if(!guarded || !matches(trackingStatements(table,handoff.columns,operation),handoff.triggers[name]))invalidate=true;
        } else {
          if(existing && matches([sql!],existing.sql))continue;
          // A different predicate or revision statement could have missed a source correction.
          if(!existing || !matches(former,existing.sql))invalidate=true;
        }
        if(existing)db.exec(`DROP TRIGGER ${name}`);
        db.exec(sql!);
      }
      const registered=db.query("SELECT 1 FROM analysis_source_revisions WHERE source=? AND bucket='*'").get(table);
      if(!registered || invalidate) {
        // Missing or unrecognized tracking may have missed corrections or deletions.
        if (registered && invalidate) db.query("UPDATE analysis_source_revisions SET revision=revision+1 WHERE source=?").run(table);
        db.query("INSERT OR IGNORE INTO analysis_source_revisions(source,bucket,revision) VALUES (?,'*',1)").run(table);
      }
    }
    db.exec("DROP TABLE IF EXISTS analysis_tracking_handoff");
    // Retired W9 queue. It outlives migration 0041 because former tracking triggers above wrote
    // to it; dropping it there would break every later schema-validating ALTER before this runs.
    db.exec("DROP TABLE IF EXISTS analysis_attribution_dirty");
  }).immediate();
}

/**
 * Adds a column to a tracked source table (one the schema steps own, not a migration) without moving its analysis
 * revision, and tracks the column from then on: as migrations 0041 and 0065 do, the exact tracking triggers are
 * handed over and guarded, the column is added, and the triggers are reinstalled for the new columns. A table whose
 * tracking is not installed (or not exact) just gets the column; `installAnalysisTracking` then decides as always.
 */
export function addTrackedColumn(db: Database, table: string, column: string, declaration: string): void {
  const columns = (db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(c => c.name);
  if (!columns.length || columns.includes(column)) return;
  const names = (["insert", "update", "delete"] as const).map(operation => [operation, `analysis_${table}_${operation}`] as const);
  const triggers = Object.fromEntries(names.flatMap(([, name]) => {
    const row = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | null;
    return row ? [[name, row.sql]] : [];
  }));
  const exact = hasAnalysisSchema(db) && (SOURCES as readonly string[]).includes(table)
    && names.every(([operation, name]) => trackingStatements(table, columns, operation)
      .some(sql => triggers[name] !== undefined && normalizedSql(sql) === normalizedSql(triggers[name]!)));
  const step = () => {
    if (exact) {
      db.exec("CREATE TABLE IF NOT EXISTS analysis_tracking_handoff(source TEXT PRIMARY KEY,columns TEXT NOT NULL,triggers TEXT NOT NULL)");
      db.query("INSERT OR REPLACE INTO analysis_tracking_handoff(source,columns,triggers) VALUES(?,?,?)")
        .run(table, JSON.stringify(columns), JSON.stringify(triggers));
      for (const [operation, name] of names) { db.exec(`DROP TRIGGER IF EXISTS ${name}`); db.exec(trackingGuardSql(name, table, operation)); }
    }
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${declaration}`);
    if (exact) installAnalysisTracking(db);
  };
  if (db.inTransaction) step(); else db.transaction(step).immediate();
}

export const analysisHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * One consistent read of several stored registers: a deferred snapshot, or the caller's open
 * transaction. Nothing is remembered between reads (plan U4.4).
 */
export function withReadSnapshot<T>(db: Database, compute: () => T): T {
  return db.inTransaction ? compute() : db.transaction(compute).deferred();
}

/** The same snapshot around an asynchronous build; only on a connection no one else uses (a report worker's). */
export async function withReadSnapshotAsync<T>(db: Database, compute: () => Promise<T>): Promise<T> {
  if (db.inTransaction) return compute();
  db.exec("BEGIN DEFERRED");
  try {
    const result = await compute();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
