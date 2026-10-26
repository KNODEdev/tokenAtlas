import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { constants } from "bun:sqlite";
import { Database } from "../db/sqlite";

export type SourceDatabaseVendor = "opencode" | "gemini";
export interface SourceDatabaseMergeReport {
  status: "unchanged" | "updated";
  inserted: number;
  corrected: number;
  retained: number;
  excludedTables?: string[];
}
export class SourceDatabaseConflict extends Error {
  constructor(public readonly reason: "unsupported-schema" | "unsupported-table-change" | "invalid-source-value" | "ordinal-identity-reuse" | "sensitive-source-schema", public readonly table: string, detail: string) {
    super(`Source database conflict [${reason}]${table ? ` in ${table}` : ""}: ${detail}`);
    this.name = "SourceDatabaseConflict";
  }
}
type Column = { name: string; type: string; pk: number | bigint; hidden: number | bigint };
type Table = { name: string; columns: Column[] };
type TablePlan = { table: Table; keys: readonly string[] | null; inserted: number; corrected: number; retained: number };
const OPENCODE_KEYS: Record<string, readonly string[]> = {
  session: ["id"], message: ["id"], project: ["id"], part: ["id"], workspace: ["id"], event: ["id"],
  session_message: ["id"], session_input: ["id"], permission: ["id"], event_sequence: ["aggregate_id"],
  session_context_epoch: ["session_id"], project_directory: ["project_id", "directory"], todo: ["session_id", "position"],
};
const EXCLUDED_TABLES = new Set(["account", "control_account", "account_state", "credential", "session_share"]);
const SENSITIVE_COLUMNS = new Set(["access_token", "refresh_token", "password", "api_key", "secret"]);
const DERIVED_TABLES = new Set(["sqlite_stat1", "sqlite_stat4"]);
const GEMINI_ORDINAL_TABLES = new Set(["gen_metadata","steps","executor_metadata","parent_references","battle_mode_infos"]);
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const relation = (schema: string, table: Table) => `${identifier(schema)}.${identifier(table.name)}`;
const column = (alias: string, name: string) => `${alias}.${identifier(name)}`;
const conflict = (reason: SourceDatabaseConflict["reason"], table: string, detail: string): never => { throw new SourceDatabaseConflict(reason, table, detail); };

function boundMemory(db: Database, schema = "main"): void {
  // Sorters spill to disk; neither database pages nor raw BLOBs become JS arrays.
  db.exec(`PRAGMA ${identifier(schema)}.cache_size=-8192; PRAGMA ${identifier(schema)}.mmap_size=0; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-8192; PRAGMA cache_spill=ON`);
}
function attachReadonly(db: Database, file: string, name: string): void {
  db.query(`ATTACH DATABASE ? AS ${identifier(name)}`).run(`${pathToFileURL(path.resolve(file)).href}?mode=ro`);
  boundMemory(db,name);
}
function exists(db: Database, sql: string): boolean {
  return Boolean((db.query(`SELECT EXISTS(${sql}) AS found`).get() as {found: number | bigint}).found);
}
function count(db: Database, sql: string): number {
  const value = (db.query(`SELECT COUNT(*) AS n FROM (${sql})`).get() as {n: number | bigint}).n;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Source row count exceeds supported exact reporting range");
  return result;
}
function checkIntegrity(db: Database, schema = "main"): void {
  const result = db.query(`PRAGMA ${identifier(schema)}.quick_check(1)`).get() as Record<string,string> | null;
  if (!result || Object.values(result)[0] !== "ok") conflict("unsupported-schema", "", "SQLite integrity check failed");
}
function tables(db: Database, schema = "main"): Map<string, Table> {
  const result = new Map<string,Table>();
  for (const {name} of db.query(`SELECT name FROM ${identifier(schema)}.sqlite_schema WHERE type='table' ORDER BY name`).all() as {name:string}[]) {
    if (DERIVED_TABLES.has(name)) continue;
    const columns = db.query(`PRAGMA ${identifier(schema)}.table_xinfo(${identifier(name)})`).all() as Column[];
    result.set(name,{name,columns});
  }
  return result;
}
function requireColumn(table: Table, name: string): void {
  if (!table.columns.some(column => column.name === name)) conflict("unsupported-schema",table.name,`Missing required column ${name}`);
}
function validateSensitiveColumns(metadata: Map<string,Table>): void {
  for (const table of metadata.values()) {
    if (EXCLUDED_TABLES.has(table.name.toLowerCase())) continue;
    const risky = table.columns.find(column => SENSITIVE_COLUMNS.has(column.name.toLowerCase()));
    if (risky) conflict("sensitive-source-schema",table.name,`Column ${risky.name} requires an explicit credential exclusion; no source evidence may be exported`);
  }
}
/** Names only: never load credential payloads into JavaScript or diagnostics. */
export function sourceDatabaseCredentialTables(file: string): string[] {
  const db = new Database(file,{readonly:true,safeIntegers:true});
  try {
    boundMemory(db);
    const metadata = tables(db);
    validateSensitiveColumns(metadata);
    return [...metadata.values()].filter(table => EXCLUDED_TABLES.has(table.name.toLowerCase()) && exists(db,`SELECT 1 FROM ${relation("main",table)}`)).map(table => table.name);
  } finally {db.close(true);}
}
function validateKeys(db: Database, schema: string, table: Table, keys: readonly string[], ordinal: boolean): void {
  for (const key of keys) {
    requireColumn(table,key);
    const name = identifier(key), integer = ordinal || (table.name === "todo" && key === "position");
    const invalid = integer ? `typeof(${name})<>'integer' OR ${name}<0` : `typeof(${name})<>'text' OR length(${name})=0`;
    if (exists(db,`SELECT 1 FROM ${relation(schema,table)} WHERE ${invalid}`)) conflict("invalid-source-value",table.name,`Invalid ${key}: expected ${integer ? "nonnegative integer" : "nonempty opaque text ID"}`);
  }
  if (exists(db,`SELECT 1 FROM ${relation(schema,table)} GROUP BY ${keys.map(key=>`${identifier(key)} COLLATE BINARY`).join(",")} HAVING COUNT(*)>1`)) {
    conflict("invalid-source-value",table.name,`Duplicate ${keys.join(",")}`);
  }
}
function validateVendor(db: Database, schema: string, metadata: Map<string,Table>, vendor: SourceDatabaseVendor): void {
  const required = vendor === "opencode" ? {session:["id","directory"],message:["id","session_id","data"]} : {gen_metadata:["idx","data"]};
  for (const [name,columns] of Object.entries(required)) {
    const table = metadata.get(name);
    if (!table) conflict("unsupported-schema",name,"Required vendor table is absent");
    for (const column of columns) requireColumn(table!,column);
  }
  if (vendor === "opencode") {
    for (const [name,keys] of Object.entries(OPENCODE_KEYS)) {
      const table = metadata.get(name);
      if (table) validateKeys(db,schema,table,keys,false);
    }
  } else {
    for(const name of GEMINI_ORDINAL_TABLES) {
      const table=metadata.get(name);if(table)validateKeys(db,schema,table,["idx"],true);
    }
    const trajectory=metadata.get("trajectory_meta");
    if(trajectory){validateKeys(db,schema,trajectory,["trajectory_id"],false);if(count(db,`SELECT 1 FROM ${relation(schema,trajectory)} LIMIT 2`)>1)conflict("invalid-source-value",trajectory.name,"Expected one conversation identity");}
    for (const name of ["gen_metadata","executor_metadata","parent_references","battle_mode_infos","trajectory_metadata_blob"]) {
      const table = metadata.get(name); if (!table) continue;
      requireColumn(table,"data");
      if (name === "trajectory_metadata_blob" && count(db,`SELECT 1 FROM ${relation(schema,table)} LIMIT 2`)>1) conflict("invalid-source-value",name,"Expected at most one metadata row");
      if (exists(db,`SELECT 1 FROM ${relation(schema,table)} WHERE typeof(data) NOT IN ('null','blob')`)) conflict("invalid-source-value",name,"Expected BLOB data");
    }
    const steps=metadata.get("steps");
    if(steps)for(const name of ["metadata","error_details","permissions","task_details","render_info","step_payload"]){requireColumn(steps,name);if(exists(db,`SELECT 1 FROM ${relation(schema,steps)} WHERE typeof(${identifier(name)}) NOT IN ('null','blob')`))conflict("invalid-source-value",steps.name,`Expected BLOB ${name}`);}
  }
}
const keyMatch = (keys: readonly string[], left: string, right: string) => keys.map(key=>`${column(left,key)} COLLATE BINARY = ${column(right,key)} COLLATE BINARY`).join(" AND ");
const differs = (table: Table, left: string, right: string) => `NOT (${table.columns.map(({name})=>`(typeof(${column(left,name)})=typeof(${column(right,name)}) AND ${column(left,name)} COLLATE BINARY IS ${column(right,name)} COLLATE BINARY)`).join(" AND ")})`;
function groupedRows(schema: string, table: Table): string {
  const values = table.columns.flatMap(({name})=>[`typeof(${identifier(name)})`,`${identifier(name)} COLLATE BINARY`]).join(",");
  return `SELECT ${values},COUNT(*) FROM ${relation(schema,table)} GROUP BY ${values}`;
}
/** Typed grouped counts retain duplicates; EXCEPT and sorting stay inside SQLite's disk temp store. */
function sameMultiset(db: Database, table: Table, left: string, right: string): boolean {
  const a = groupedRows(left,table), b = groupedRows(right,table);
  return !exists(db,`${a} EXCEPT ${b}`) && !exists(db,`${b} EXCEPT ${a}`);
}
function knownCounts(db: Database, table: Table, keys: readonly string[]): Omit<TablePlan,"table"|"keys"> {
  const incoming = relation("main",table), old = relation("accepted",table), match = keyMatch(keys,"s","a");
  return {
    inserted:count(db,`SELECT 1 FROM ${incoming} s LEFT JOIN ${old} a ON ${match} WHERE ${column("a",keys[0]!)} IS NULL`),
    corrected:count(db,`SELECT 1 FROM ${incoming} s JOIN ${old} a ON ${match} WHERE ${differs(table,"s","a")}`),
    retained:count(db,`SELECT 1 FROM ${old} a LEFT JOIN ${incoming} s ON ${match} WHERE ${column("s",keys[0]!)} IS NULL`),
  };
}

/** Consistent SQLite snapshot including committed WAL contents and the complete schema. */
export function snapshotSourceDatabase(source: string, destination: string, vendor?: SourceDatabaseVendor): void {
  if (path.resolve(source) === path.resolve(destination) || fs.existsSync(destination)) throw new Error("Snapshot output must be a new file distinct from its source");
  const db = new Database(source,{readonly:true,safeIntegers:true});
  try {
    boundMemory(db); checkIntegrity(db);
    const metadata = tables(db);
    if (vendor) validateSensitiveColumns(metadata);
    db.query("VACUUM INTO ?").run(destination);
    if (vendor && [...metadata.keys()].some(name=>EXCLUDED_TABLES.has(name.toLowerCase()))) {
      const clean = new Database(destination,{safeIntegers:true});
      try {
        boundMemory(clean);
        clean.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
        const triggers = clean.query("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as {name:string;sql:string}[];
        for (const trigger of triggers) clean.exec(`DROP TRIGGER ${identifier(trigger.name)}`);
        for (const table of metadata.values()) if (EXCLUDED_TABLES.has(table.name.toLowerCase())) clean.exec(`DELETE FROM ${identifier(table.name)}`);
        for (const trigger of triggers) clean.exec(trigger.sql);
        clean.exec("COMMIT; VACUUM");
      } finally {clean.close(true);}
    }
  } catch (error) {fs.rmSync(destination,{force:true});throw error;}
  finally {db.close(true);}
}

function verifyMerged(db: Database, metadata: Map<string,Table>, plans: TablePlan[]): void {
  for (const table of metadata.values()) {
    if (table.name === "sqlite_sequence") {
      if (exists(db,`SELECT 1 FROM (SELECT name,seq FROM incoming.sqlite_sequence UNION ALL SELECT name,seq FROM accepted.sqlite_sequence) s LEFT JOIN main.sqlite_sequence o ON o.name=s.name WHERE o.name IS NULL OR o.seq<s.seq`)) conflict("unsupported-schema",table.name,"AUTOINCREMENT high-water mark was lost");
      continue;
    }
    if (EXCLUDED_TABLES.has(table.name.toLowerCase())) {
      if (exists(db,`SELECT 1 FROM ${relation("main",table)}`)) conflict("unsupported-schema",table.name,"Credential rows survived sanitization");
      continue;
    }
    const plan = plans.find(plan=>plan.table.name===table.name);
    let valid: boolean;
    if (plan?.keys) {
      const keys = plan.keys, output = relation("main",table), source = relation("incoming",table), old = relation("accepted",table);
      validateKeys(db,"main",table,keys,GEMINI_ORDINAL_TABLES.has(table.name));
      valid = !exists(db,`SELECT 1 FROM ${source} s LEFT JOIN ${output} o ON ${keyMatch(keys,"s","o")} WHERE ${column("o",keys[0]!)} IS NULL OR ${differs(table,"s","o")}`)
        && !exists(db,`SELECT 1 FROM ${old} a LEFT JOIN ${source} s ON ${keyMatch(keys,"a","s")} LEFT JOIN ${output} o ON ${keyMatch(keys,"a","o")} WHERE ${column("s",keys[0]!)} IS NULL AND (${column("o",keys[0]!)} IS NULL OR ${differs(table,"a","o")})`)
        && count(db,`SELECT 1 FROM ${output}`) === count(db,`SELECT 1 FROM ${source}`)+plan.retained;
    } else if (plan) {
      valid = sameMultiset(db,table,"main",exists(db,`SELECT 1 FROM ${relation("incoming",table)}`)?"incoming":"accepted");
    } else valid = sameMultiset(db,table,"main","accepted");
    if (!valid) conflict("unsupported-schema",table.name,"Provider constraints or generated values changed raw rows during reconciliation");
  }
}

/** Prepares a complete scratch database; the caller exclusively owns atomic publication. */
export function mergeSourceDatabase(options: {snapshot:string;archive:string|null;output:string;vendor:SourceDatabaseVendor}): SourceDatabaseMergeReport {
  if (fs.existsSync(options.output) || [options.snapshot,options.archive].some(file=>file!==null&&path.resolve(file)===path.resolve(options.output))) throw new Error("Merge output must be a new scratch file distinct from both inputs");
  const source = new Database(options.snapshot,constants.SQLITE_OPEN_READONLY|constants.SQLITE_OPEN_URI);
  let output: Database | undefined, createdOutput = false, archiveNeedsScrub = false;
  try {
    boundMemory(source); checkIntegrity(source);
    const incoming = tables(source);
    validateSensitiveColumns(incoming); validateVendor(source,"main",incoming,options.vendor);
    const report: SourceDatabaseMergeReport = {status:"unchanged",inserted:0,corrected:0,retained:0};
    const excludedTables = [...incoming.keys()].filter(name=>EXCLUDED_TABLES.has(name.toLowerCase()));
    if (excludedTables.length) report.excludedTables=excludedTables;
    if (options.archive===null) {
      snapshotSourceDatabase(options.snapshot,options.output,options.vendor);createdOutput=true;
      return {...report,status:"updated",inserted:[...incoming.values()].filter(table=>!EXCLUDED_TABLES.has(table.name.toLowerCase())).reduce((sum,table)=>sum+count(source,`SELECT 1 FROM ${relation("main",table)}`),0)};
    }
    attachReadonly(source,options.archive,"accepted"); checkIntegrity(source,"accepted");
    const previous = tables(source,"accepted"); validateSensitiveColumns(previous);
    archiveNeedsScrub=[...previous.values()].some(table=>EXCLUDED_TABLES.has(table.name.toLowerCase())&&exists(source,`SELECT 1 FROM ${relation("accepted",table)}`));
    const readSchema = (name:string) => source.query(`SELECT type,name,tbl_name,sql FROM ${identifier(name)}.sqlite_schema WHERE name NOT IN ('sqlite_stat1','sqlite_stat4') ORDER BY type,name`).values();
    if (JSON.stringify(readSchema("main"))!==JSON.stringify(readSchema("accepted"))) conflict("unsupported-schema","","Source and archive schemas differ; explicit migration is required");
    for (const pragma of ["user_version","application_id"]) {
      if (String(source.query(`PRAGMA main.${pragma}`).values()[0]?.[0])!==String(source.query(`PRAGMA accepted.${pragma}`).values()[0]?.[0])) conflict("unsupported-schema","",`${pragma} changed`);
    }
    validateVendor(source,"accepted",previous,options.vendor);
    const plans: TablePlan[]=[];
    let sequenceChanged=false;
    for (const table of incoming.values()) {
      if (EXCLUDED_TABLES.has(table.name.toLowerCase())) continue;
      if (table.name === "sqlite_sequence") {
        for (const schema of ["main","accepted"]) {
          validateKeys(source,schema,table,["name"],false);
          if (exists(source,`SELECT 1 FROM ${relation(schema,table)} WHERE typeof(seq)<>'integer' OR seq<0`)) conflict("invalid-source-value",table.name,"Invalid AUTOINCREMENT sequence");
        }
        sequenceChanged=exists(source,`SELECT 1 FROM main.sqlite_sequence s LEFT JOIN accepted.sqlite_sequence a ON s.name=a.name WHERE a.name IS NULL OR s.seq>a.seq`);
        continue;
      }
      const ordinal=options.vendor==="gemini"&&GEMINI_ORDINAL_TABLES.has(table.name);
      const keys=options.vendor==="opencode"?OPENCODE_KEYS[table.name]:ordinal?["idx"]:table.name==="trajectory_meta"?["trajectory_id"]:undefined;
      if (keys) {
        const counts=knownCounts(source,table,keys);
        if(options.vendor==="gemini"&&table.name==="trajectory_meta"&&counts.inserted&&counts.retained)conflict("ordinal-identity-reuse",table.name,"Conversation identity changed");
        if (ordinal) {
          const max=(source.query(`SELECT CAST(COALESCE(MAX(idx),-1) AS TEXT) AS value FROM ${relation("accepted",table)}`).get() as {value:string}).value;
          const old=relation("accepted",table),fresh=relation("main",table);
          if ((counts.corrected&&(counts.retained>0||exists(source,`SELECT 1 FROM ${fresh} s JOIN ${old} a ON s.idx=a.idx WHERE ${differs(table,"s","a")} AND s.idx<>${max}`)))
            || (counts.inserted&&(counts.retained>0||exists(source,`SELECT 1 FROM ${fresh} s LEFT JOIN ${old} a ON s.idx=a.idx WHERE a.idx IS NULL AND s.idx<=${max}`)))) conflict("ordinal-identity-reuse",table.name,"Ordinal changed outside a proven append or completion of the last generation");
        }
        plans.push({table,keys,...counts});
      } else if (options.vendor==="gemini"&&table.name==="trajectory_metadata_blob") {
        const before=count(source,`SELECT 1 FROM ${relation("accepted",table)}`),after=count(source,`SELECT 1 FROM ${relation("main",table)}`);
        const changed=after>0&&!sameMultiset(source,table,"main","accepted");
        plans.push({table,keys:null,inserted:changed&&before===0?1:0,corrected:changed&&before>0?1:0,retained:after===0?before:0});
      } else if (!sameMultiset(source,table,"main","accepted")) conflict("unsupported-table-change",table.name,"Unknown table changed; its raw rows cannot be safely reconciled without an identity contract");
    }
    for (const plan of plans) {report.inserted+=plan.inserted;report.corrected+=plan.corrected;report.retained+=plan.retained;}
    if (!report.inserted&&!report.corrected&&!archiveNeedsScrub&&!sequenceChanged) return report;
    snapshotSourceDatabase(options.archive,options.output,options.vendor);createdOutput=true;
    output=new Database(options.output,constants.SQLITE_OPEN_READWRITE|constants.SQLITE_OPEN_URI);boundMemory(output);
    attachReadonly(output,options.snapshot,"incoming");attachReadonly(output,options.archive,"accepted");
    output.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    const triggers=output.query("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as {name:string;sql:string}[];
    for (const trigger of triggers) output.exec(`DROP TRIGGER ${identifier(trigger.name)}`);
    for (const {table,keys,inserted,corrected} of plans) {
      const columns=table.columns.filter(column=>Number(column.hidden)===0), names=columns.map(({name})=>identifier(name)).join(","),fresh=relation("incoming",table),target=relation("main",table);
      if (corrected) output.exec(`UPDATE ${target} AS o SET ${columns.map(({name})=>`${identifier(name)}=${column("s",name)}`).join(",")} FROM ${fresh} AS s${keys?` WHERE ${keyMatch(keys,"o","s")} AND ${differs(table,"o","s")}`:""}`);
      if (inserted) output.exec(`INSERT INTO ${target} (${names}) SELECT ${columns.map(({name})=>column("s",name)).join(",")} FROM ${fresh} s${keys?` LEFT JOIN ${target} o ON ${keyMatch(keys,"s","o")} WHERE ${column("o",keys[0]!)} IS NULL`:""}`);
    }
    if (incoming.has("sqlite_sequence")) {
      output.exec("UPDATE main.sqlite_sequence AS o SET seq=MAX(o.seq,s.seq) FROM incoming.sqlite_sequence s WHERE o.name=s.name; INSERT INTO main.sqlite_sequence(name,seq) SELECT s.name,s.seq FROM incoming.sqlite_sequence s LEFT JOIN main.sqlite_sequence o ON o.name=s.name WHERE o.name IS NULL");
    }
    for (const trigger of triggers) output.exec(trigger.sql);
    verifyMerged(output,incoming,plans);
    if (exists(output,"SELECT 1 FROM incoming.sqlite_schema WHERE name IN ('sqlite_stat1','sqlite_stat4') UNION ALL SELECT 1 FROM accepted.sqlite_schema WHERE name IN ('sqlite_stat1','sqlite_stat4')")) output.exec("ANALYZE main");
    checkIntegrity(output);output.exec("COMMIT");
    return {...report,status:"updated"};
  } catch(error) {
    if (output) {try {output.exec("ROLLBACK");} catch {}output.close(true);output=undefined;}
    if (createdOutput) fs.rmSync(options.output,{force:true});
    if (archiveNeedsScrub&&error instanceof SourceDatabaseConflict) throw new SourceDatabaseConflict(error.reason,error.table,`${error.message}; existing archive credential rows require explicit cleanup because publication was refused`);
    throw error;
  } finally {output?.close(true);source.close(true);}
}
