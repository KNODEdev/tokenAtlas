import type { Database } from "bun:sqlite";
/** Direct DML rows only; Bun's run().changes can include writes made by triggers. */
export function directChanges(sqlite: Database): number {
  return (sqlite.query("SELECT changes() AS count").get() as { count: number }).count;
}
