import type { Database } from "./sqlite";
import { subscriptionAccountingAdapters } from "../server/subscription-accounting-adapters";
import { asSchemaWriter } from "./schema-writer";

/**
 * Dirty ranges of the fact tables (plan §4 rule 3). Every write to a tracked fact table bumps, in
 * the writing transaction, the revision of each source day it touched (the day of the row's `ts`:
 * the new one for an insert, the old one for a deletion, both for a correction) and of the whole
 * table ('*'). Triggers write them row by row; a first fill without triggers records them once per
 * table (`recordFactDayRevisions`).
 *
 * A consumer keeps the revisions it has reconciled and recomputes the days whose revision differs
 * (a reset that lowers one differs too), so its work follows the changed days, never a replay of
 * row images. The revisions are the fact tables' own record: they do not depend on report memos.
 */
/** The tracked fact tables: those of the registered shared-ledger providers. */
const factDayTables = (): string[] => subscriptionAccountingAdapters().map(adapter => adapter.table);

export const FACT_DAY_REVISIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS fact_day_revisions (
  source TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(source, day)
) STRICT`;

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();
type Operation = "insert" | "update" | "delete";
const OPERATIONS: readonly Operation[] = ["insert", "update", "delete"];
const triggerName = (table: string, operation: Operation) => `fact_day_revision_${table}_${operation}`;

function triggerSql(table: string, columns: readonly string[], operation: Operation): string {
  const bump = (bucket: string) => `INSERT INTO fact_day_revisions(source,day,revision) VALUES(${literal(table)},${bucket},1)
      ON CONFLICT(source,day) DO UPDATE SET revision=revision+1;`;
  const day = (side: string) => bump(`COALESCE(substr(${side}.ts,1,10),'')`);
  const days = operation === "insert" ? day("NEW") : operation === "delete" ? day("OLD") : `${day("OLD")} ${day("NEW")}`;
  const changed = columns.map(column => `OLD.${quoted(column)} IS NOT NEW.${quoted(column)}`).join(" OR ");
  return `CREATE TRIGGER ${triggerName(table, operation)} AFTER ${operation.toUpperCase()} ON ${quoted(table)}
    ${operation === "update" ? `WHEN ${changed}` : ""} BEGIN ${days} ${bump("'*'")} END`;
}
const columnsOf = (db: Database, table: string) =>
  (db.query(`PRAGMA table_info(${quoted(table)})`).all() as Array<{ name: string }>).map(column => column.name);

/** The table and the triggers of every tracked fact table present (they follow its columns). */
export function installFactDayRevisions(db: Database): void {
  asSchemaWriter(db, () => {
    db.exec(FACT_DAY_REVISIONS_SCHEMA);
    for (const table of factDayTables()) {
      const columns = columnsOf(db, table);
      if (!columns.includes("ts")) continue;
      for (const operation of OPERATIONS) {
        const name = triggerName(table, operation), sql = triggerSql(table, columns, operation);
        const previous = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | null;
        if (previous && normalized(previous.sql) === normalized(sql)) continue;
        if (previous) db.exec(`DROP TRIGGER ${name}`);
        db.exec(sql);
      }
    }
  });
}

/** Recognizes only this module's generated triggers, body included (first fill and stages drop them). */
export function isFactDayRevisionTrigger(db: Database, name: string, table: string, sql: string): boolean {
  if (!factDayTables().includes(table)) return false;
  const operation = OPERATIONS.find(item => name === triggerName(table, item));
  return !!operation && normalized(sql) === normalized(triggerSql(table, columnsOf(db, table), operation));
}

/** What the dropped triggers would have recorded for rows written without them (a first fill). */
export function recordFactDayRevisions(db: Database, table: string): void {
  db.query(`INSERT INTO fact_day_revisions(source,day,revision)
    SELECT ?,COALESCE(substr(ts,1,10),''),count(*) FROM ${quoted(table)} GROUP BY 2 HAVING count(*)>0
    ON CONFLICT(source,day) DO UPDATE SET revision=revision+excluded.revision`).run(table);
  db.query(`INSERT INTO fact_day_revisions(source,day,revision) SELECT ?,'*',count(*) FROM ${quoted(table)} HAVING count(*)>0
    ON CONFLICT(source,day) DO UPDATE SET revision=revision+excluded.revision`).run(table);
}

/** Whether the table's writes are tracked (its triggers are installed). */
export function factDaysTracked(db: Database, table: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName(table, "insert"));
}
/** The whole table's change revision (0 before its first tracked write). */
export function factTableRevision(db: Database, table: string): number {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fact_day_revisions'").get()) return 0;
  return (db.query("SELECT revision FROM fact_day_revisions WHERE source=? AND day='*'").get(table) as { revision: number } | null)?.revision ?? 0;
}

/** Every source day of a table (`?1`) with its revision; '' is the day of rows without a time. */
export const FACT_DAY_REVISIONS_SQL = "SELECT day, revision FROM fact_day_revisions WHERE source=?1 AND day<>'*'";

/** Rows of a table on a source day (`?1`): the day the triggers record, found through a `ts` index. */
export const FACT_DAY_PREDICATE = "ts>=?1 AND ts<?1||'~' AND substr(ts,1,10)=?1";
