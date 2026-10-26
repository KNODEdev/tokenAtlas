import type { Database } from "bun:sqlite";

/**
 * Runs one runtime schema step (it reads the schema, then issues the DDL it decided on) as a single
 * writer. Processes that start together (the server and a sync child, two syncs) serialize on
 * BEGIN IMMEDIATE, so the later one reads the schema again after the first committed and finds its
 * columns, tables and triggers in place instead of adding them twice. Inside a caller's transaction the
 * step is part of that transaction.
 */
export function asSchemaWriter<T>(db: Database, step: () => T): T {
  return db.inTransaction ? step() : db.transaction(step).immediate();
}
