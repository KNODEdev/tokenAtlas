import type { Database } from "../db/sqlite";

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (((error as Error & { code?: string }).code ?? "") === "SQLITE_BUSY" ||
      /database is (?:locked|busy)/i.test(error.message))
  );
}

const connectionRetrySignal = new Int32Array(new SharedArrayBuffer(4));

export function execWithBusyRetry(sqlite: Database, statement: string): void {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      sqlite.exec(statement);
      return;
    } catch (error) {
      if (!isBusyError(error) || Date.now() >= deadline) throw error;
      Atomics.wait(connectionRetrySignal, 0, 0, 10);
    }
  }
}

export function tableColumns(sqlite: Database, table: string): string[] {
  return (
    sqlite.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

// SQLite INTEGER spans more bits than JS Number. Encode storage type and value in
// SQL so fingerprints preserve int64 counters and distinguish adjacent REAL values.
function fingerprintValue(column: string): string {
  const name = quoteIdentifier(column);
  return `CASE typeof(${name})
      WHEN 'integer' THEN 'i:' || CAST(${name} AS TEXT)
      WHEN 'real' THEN 'r:' || printf('%!.26g', ${name})
      WHEN 'text' THEN 't:' || ${name}
      WHEN 'blob' THEN 'b:' || hex(${name}) ELSE 'n:' END`;
}

export function fingerprintColumns(columns: string[]): string {
  return columns.map(column => `${fingerprintValue(column)} AS ${quoteIdentifier(column)}`).join(", ");
}

export function tableExists(sqlite: Database, table: string): boolean {
  return sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}
