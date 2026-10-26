import { Database, type SQLQueryBindings } from "../db/sqlite";
import { randomUUID } from "node:crypto";

export type TimestampDifferenceIdentity = Record<string, string | number>;

export interface TimestampDifferenceSpec {
  identity: string[];
  tables: string[];
}

/** One ordinary, disk-backed stage table represents one complete snapshot. */
export interface TimestampEvidence {
  readonly table: string;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function identityKey(spec: TimestampDifferenceSpec, identity: TimestampDifferenceIdentity): string {
  return JSON.stringify(spec.identity.map(column => identity[column]));
}

function identityWhere(spec: TimestampDifferenceSpec,
  identity: TimestampDifferenceIdentity): { sql: string; params: SQLQueryBindings[] } {
  return {
    sql: spec.identity.map(column => `${quote(column)}=?`).join(" AND "),
    params: spec.identity.map(column => identity[column] as SQLQueryBindings),
  };
}

function tableColumns(sqlite: Database, table: string): string[] {
  return (sqlite.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>)
    .map(column => column.name);
}

// Encode in SQLite before values cross into JavaScript. This preserves int64,
// exact stored REAL values, storage classes, blobs and NULL distinctions.
function encodedValue(column: string): string {
  const name = quote(column);
  return `CASE typeof(${name})
    WHEN 'integer' THEN 'i:'||CAST(${name} AS TEXT)
    WHEN 'real' THEN 'r:'||printf('%!.26g',${name})
    WHEN 'text' THEN 't:'||${name}
    WHEN 'blob' THEN 'b:'||hex(${name}) ELSE 'n:' END`;
}

function encodedRow(columns: string[]): string {
  return `json_array(${columns.map(encodedValue).join(",")})`;
}

function timestampValue(): string {
  return `CASE WHEN typeof(${quote("ts")})='text' THEN ${quote("ts")} ELSE NULL END`;
}

function createEvidenceTable(scratch: Database, table: string): void {
  scratch.exec(`CREATE TABLE ${quote(table)}(
    identity_key TEXT NOT NULL,
    source_table TEXT NOT NULL,
    encoded TEXT NOT NULL,
    ts TEXT,
    copies INTEGER NOT NULL CHECK(copies>0),
    PRIMARY KEY(identity_key,source_table,encoded)
  ) WITHOUT ROWID`);
}

function populateEvidence(source: Database, scratch: Database, evidenceTable: string,
  sourceTable: string, key: string, columns: string[],
  where: { sql: string; params: SQLQueryBindings[] }): void {
  if (source === scratch) {
    scratch.query(`INSERT INTO ${quote(evidenceTable)}(
        identity_key,source_table,encoded,ts,copies)
      SELECT ?,?,${encodedRow(columns)},${timestampValue()},1
      FROM ${quote(sourceTable)} WHERE (${where.sql}) AND 1
      ON CONFLICT(identity_key,source_table,encoded)
      DO UPDATE SET copies=copies+1`).run(key, sourceTable, ...where.params);
    return;
  }

  const insert = scratch.query(`INSERT INTO ${quote(evidenceTable)}(
      identity_key,source_table,encoded,ts,copies) VALUES(?,?,?,?,1)
    ON CONFLICT(identity_key,source_table,encoded)
    DO UPDATE SET copies=copies+1`);
  const rows = source.query(`SELECT ${encodedRow(columns)} AS encoded,
      ${timestampValue()} AS ts
    FROM ${quote(sourceTable)} WHERE ${where.sql}`)
    .iterate(...where.params) as Iterable<{ encoded: string; ts: string | null }>;
  for (const row of rows) {
    if (typeof row.encoded !== "string") throw new Error("Invalid timestamp evidence encoding");
    insert.run(key, sourceTable, row.encoded, row.ts);
  }
}

/**
 * Materialize requested identities into one ordinary table in the disposable
 * stage database. Duplicate rows become an exact SQL count. Source payloads are
 * streamed one at a time when databases differ and never accumulated in JS.
 */
export function captureTimestampEvidence(source: Database, scratch: Database,
  spec: TimestampDifferenceSpec, identities: TimestampDifferenceIdentity[]): TimestampEvidence {
  const evidence: TimestampEvidence = {
    table: `__tokenatlas_timestamp_${randomUUID().replaceAll("-", "")}`,
  };
  try {
    scratch.transaction(() => {
      createEvidenceTable(scratch, evidence.table);
      for (const identity of identities) {
        const key = identityKey(spec, identity);
        const where = identityWhere(spec, identity);
        for (const sourceTable of spec.tables) {
          const columns = tableColumns(source, sourceTable).filter(column => column !== "id");
          if (!columns.includes("ts")) continue;
          populateEvidence(source, scratch, evidence.table, sourceTable, key, columns, where);
        }
      }
    }).immediate();
    return evidence;
  } catch (error) {
    dropTimestampEvidence(scratch, evidence);
    throw error;
  }
}

function absorbTimestamp(range: { from: string | null; to: string | null }, value: unknown): void {
  if (typeof value !== "string") return;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return;
  if (range.from === null || time < Date.parse(range.from)
      || time === Date.parse(range.from) && value < range.from) range.from = value;
  if (range.to === null || time > Date.parse(range.to)
      || time === Date.parse(range.to) && value > range.to) range.to = value;
}

/** Compare two exact multisets and stream only timestamps of differing rows. */
export function compareTimestampEvidence(scratch: Database, before: TimestampEvidence,
  after: TimestampEvidence, onTimestamp?:(timestamp:string)=>void,
  onIdentityTimestamp?:(key:string,timestamp:string)=>void): { from: string; to: string } | null {
  const left = quote(before.table);
  const right = quote(after.table);
  const match = `r.identity_key=l.identity_key
    AND r.source_table=l.source_table AND r.encoded=l.encoded`;
  const reverseMatch = `l.identity_key=r.identity_key
    AND l.source_table=r.source_table AND l.encoded=r.encoded`;
  const statement = scratch.prepare(`SELECT l.identity_key AS identity_key,l.ts AS ts
      FROM ${left} l LEFT JOIN ${right} r ON ${match}
      WHERE r.encoded IS NULL OR r.copies<>l.copies
    UNION ALL
    SELECT r.identity_key AS identity_key,r.ts AS ts
      FROM ${right} r LEFT JOIN ${left} l ON ${reverseMatch}
      WHERE l.encoded IS NULL`);
  const range: { from: string | null; to: string | null } = { from: null, to: null };
  try{
    const rows=statement.iterate() as Iterable<{identity_key:string;ts:string|null}>;
    for (const row of rows) {absorbTimestamp(range, row.ts);if(typeof row.ts==="string"&&Number.isFinite(Date.parse(row.ts))){onTimestamp?.(row.ts);onIdentityTimestamp?.(row.identity_key,row.ts);}}
  }finally{statement.finalize();}
  return range.from !== null && range.to !== null ? { from: range.from, to: range.to } : null;
}

/** One pair of local evidence tables serves the whole batch; source reads share a snapshot. */
export function measureTimestampDifferences(active:Database,stage:Database,
  spec:TimestampDifferenceSpec,identities:TimestampDifferenceIdentity[],onTimestamp?:(timestamp:string)=>void
):Map<string,{from:string;to:string}|null> {
  const ranges=new Map(identities.map(identity=>[identityKey(spec,identity),{from:null as string|null,to:null as string|null}]));
  if(!identities.length)return new Map();
  active.transaction(()=>{
    const before=captureTimestampEvidence(active,stage,spec,identities);
    let after:TimestampEvidence|undefined;
    try{
      after=captureTimestampEvidence(stage,stage,spec,identities);
      compareTimestampEvidence(stage,before,after,onTimestamp,(key,timestamp)=>{
        const range=ranges.get(key);
        if(!range)throw new Error("Unexpected source identity in timestamp evidence");
        absorbTimestamp(range,timestamp);
      });
    }finally{if(after)dropTimestampEvidence(stage,after);dropTimestampEvidence(stage,before);}
  }).deferred();
  return new Map([...ranges].map(([key,range])=>[key,range.from!==null&&range.to!==null?{from:range.from,to:range.to}:null]));
}

/** Direct before/stage measurement using the same comparator as post-replay measurement. */
export function measureTimestampDifference(active: Database, stage: Database,
  spec: TimestampDifferenceSpec, identities: TimestampDifferenceIdentity[], onTimestamp?:(timestamp:string)=>void): { from: string; to: string } | null {
  const before = captureTimestampEvidence(active, stage, spec, identities);
  let after: TimestampEvidence | undefined;
  try {
    after = captureTimestampEvidence(stage, stage, spec, identities);
    return compareTimestampEvidence(stage, before, after,onTimestamp);
  } finally {
    if (after) dropTimestampEvidence(stage, after);
    dropTimestampEvidence(stage, before);
  }
}

/** Best-effort cleanup cannot replace a publication or comparison error. */
export function dropTimestampEvidence(scratch: Database, evidence: TimestampEvidence): void {
  try { scratch.exec(`DROP TABLE IF EXISTS ${quote(evidence.table)}`); }
  catch { /* Its containing stage database is disposable and cleaned by its owner. */ }
}
