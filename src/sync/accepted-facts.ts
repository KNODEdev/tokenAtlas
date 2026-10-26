import { createHash } from "node:crypto";
import type { Database } from "../db/sqlite";

export interface FactsSpec {
  identity: string[];
  tables: Array<{ table: string; order?: string[] }>;
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const key = (spec: FactsSpec, row: Record<string, unknown>) => JSON.stringify(spec.identity.map(column => row[column]));
const columns = (db: Database, table: string) =>
  (db.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map(row => row.name).filter(name => name !== "id");
export function factsValue(column: string): string {
  const name = quote(column);
  return `CASE typeof(${name}) WHEN 'integer' THEN 'i:' || CAST(${name} AS TEXT)
    WHEN 'real' THEN 'r:' || printf('%!.26g', ${name}) WHEN 'text' THEN 't:' || ${name}
    WHEN 'blob' THEN 'b:' || hex(${name}) ELSE 'n:' END`;
}
const triggerName = (table: string, operation: string) => `sync_accepted_facts_${table}_${operation}`;
function triggerSql(vendor: string, spec: FactsSpec, table: string, operation: string): string {
  const identity = (side: string) => `json_array(${spec.identity.map(column => `${side}.${quote(column)}`).join(",")})`;
  const sides = operation === "update" ? ["OLD", "NEW"] : [operation === "insert" ? "NEW" : "OLD"];
  return `CREATE TRIGGER ${quote(triggerName(table, operation))}
    AFTER ${operation.toUpperCase()} ON ${quote(table)} BEGIN
    ${sides.map(side => `DELETE FROM sync_accepted_facts WHERE vendor=${literal(vendor)} AND identity=${identity(side)};`).join("\n")}
    END`;
}
const normalizedSql = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** Strip only our exact generated invalidators, preserving semantic/custom stage guards. */
export function omitAcceptedFactsTracking(db: Database, specs: Record<string, FactsSpec>): void {
  for (const [vendor, spec] of Object.entries(specs)) for (const { table } of spec.tables)
    for (const operation of ["insert", "update", "delete"]) {
      const name = triggerName(table, operation);
      const row = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | null;
      if (row && normalizedSql(row.sql) === normalizedSql(triggerSql(vendor, spec, table, operation)))
        db.exec(`DROP TRIGGER ${quote(name)}`);
    }
}

/** Missing or invalidated proofs fall back to reading facts; no history backfill at startup. */
export function ensureAcceptedFacts(db: Database, specs: Record<string, FactsSpec>): void {
  const install = () => {
    db.exec(`CREATE TABLE IF NOT EXISTS sync_accepted_facts (
      vendor TEXT NOT NULL, identity TEXT NOT NULL, contract TEXT NOT NULL, digest TEXT NOT NULL,
      PRIMARY KEY(vendor,identity))`);
    for (const [vendor, spec] of Object.entries(specs)) for (const { table } of spec.tables) {
      if (!columns(db, table).length) continue;
      for (const operation of ["insert", "update", "delete"]) {
        // Every writer, including migrations/remapping and identity moves, invalidates the proof atomically.
        const name = triggerName(table, operation);
        const row = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | null;
        const sql = triggerSql(vendor, spec, table, operation);
        if (row && normalizedSql(row.sql) !== normalizedSql(sql)) throw new Error(`Unrecognized accepted-facts trigger: ${name}`);
        if (!row) {
          db.query("DELETE FROM sync_accepted_facts WHERE vendor=?").run(vendor);
          db.exec(sql);
        }
      }
    }
  };
  if (db.inTransaction) install();
  else db.transaction(install).immediate();
}

export function factsContract(db: Database, spec: FactsSpec): string {
  return createHash("sha256").update(JSON.stringify([1, spec.identity, spec.tables.map(({ table, order }) => [table,
    db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table), columns(db, table), order])])).digest("hex");
}

export function identityFacts(db: Database, vendor: string, spec: FactsSpec,
  identities: Array<Record<string, string | number>>, accepted = false) {
  const contract = factsContract(db, spec);
  const byIdentity = new Map<string, string>();
  const cachedIdentities = new Set<string>();
  // A writer cannot invalidate a proof after a migration removed its trigger.
  const tracked = accepted && !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_accepted_facts'").get()
    && spec.tables.every(({ table }) => ["insert", "update", "delete"].every(operation => {
    const row = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(triggerName(table, operation)) as { sql: string } | null;
    return row !== null && normalizedSql(row.sql) === normalizedSql(triggerSql(vendor, spec, table, operation));
  }));
  const missing = identities.filter(identity => {
    if (tracked) {
      const row = db.query("SELECT digest FROM sync_accepted_facts WHERE vendor=? AND identity=? AND contract=?")
        .get(vendor, key(spec, identity), contract) as { digest: string } | null;
      if (row && typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest)) {
        byIdentity.set(key(spec, identity), row.digest); cachedIdentities.add(key(spec, identity)); return false;
      }
    }
    return true;
  });
  const tables = missing.length ? spec.tables.map(({ table, order }) => {
    const fields = columns(db, table);
    const sort = order ?? fields;
    const primary = (db.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string; pk: number; notnull: number }>)
      .filter(column => column.pk > 0).sort((left, right) => left.pk-right.pk);
    // Rowid-table composite primary keys can repeat NULLs; retain the typed-row tie breaker there.
    const uniqueOrder = primary.length > 0 && primary.every(column => column.notnull && sort.includes(column.name));
    const primaryOrder = uniqueOrder && primary.every((column,index) => sort[index] === column.name)
      && spec.identity.every((column,index) => primary[index]?.name === column);
    // Otherwise ORDER BY can choose a whole-home time index instead of the selected source lookup.
    const ordering = sort.map(column => `${primaryOrder ? "" : "+"}${quote(column)}`).join(",")
      + (uniqueOrder ? "" : ",encoded");
    const sql = `SELECT json_array(${fields.map(factsValue).join(",")}) AS encoded FROM ${quote(table)}
      WHERE ${spec.identity.map(column => `${quote(column)}=?`).join(" AND ")}
      ORDER BY ${ordering}`;
    // Most sources fit one block. Large sources use a bounded ordered aggregate, never one giant string.
    return { table, sql, remainder: null as ReturnType<Database["prepare"]> | null,
      statement: db.prepare(`SELECT group_concat(encoded || char(10), '') AS encoded,count(*) AS rows
        FROM (${sql} LIMIT 4096)`) };
  }) : [];
  try {
    for (const identity of missing) {
      const hash = createHash("sha256");
      const params = spec.identity.map(column => identity[column]!);
      for (const item of tables) {
        hash.update(item.table + "\n");
        const row = item.statement.get(...params) as { encoded: string | null; rows: number };
        if (row.encoded !== null) hash.update(row.encoded);
        if (row.rows === 4096) {
          item.remainder ??= db.prepare(`WITH ordered AS (
            SELECT encoded,row_number() OVER () AS seq FROM (${item.sql})
          ) SELECT group_concat(encoded || char(10), '' ORDER BY seq) AS encoded FROM ordered WHERE seq>4096
            GROUP BY CAST((seq-4097)/4096 AS INTEGER) ORDER BY CAST((seq-4097)/4096 AS INTEGER)`);
          for (const block of item.remainder.iterate(...params) as Iterable<{ encoded: string }>) hash.update(block.encoded);
        }
      }
      byIdentity.set(key(spec, identity), hash.digest("hex"));
    }
  } finally { for (const { statement, remainder } of tables) { statement.finalize(); remainder?.finalize(); } }
  const hash = createHash("sha256");
  for (const identity of identities) hash.update(key(spec, identity) + "\n" + byIdentity.get(key(spec, identity)) + "\n");
  return { fingerprint: hash.digest("hex"), byIdentity, contract, cachedIdentities };
}

/** Call only inside the transaction that publishes/accepts these facts. */
export function saveAcceptedFacts(db: Database, vendor: string, facts: ReturnType<typeof identityFacts>): void {
  if (!db.inTransaction) throw new Error("Accepted facts require a publication transaction");
  using write = db.prepare(`INSERT INTO sync_accepted_facts VALUES(?,?,?,?)
    ON CONFLICT(vendor,identity) DO UPDATE SET contract=excluded.contract,digest=excluded.digest
    WHERE contract<>excluded.contract OR digest<>excluded.digest`);
  for (const [identity, digest] of facts.byIdentity) write.run(vendor, identity, facts.contract, digest);
}
