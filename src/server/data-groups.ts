import type { Database, SQLQueryBindings } from "bun:sqlite";

/**
 * The rows of one statement over the whole requested range. `order` sorts rows by these columns
 * (missing values first) for statements without their own ORDER BY.
 */
export function queryRows<T = unknown>(db: Database, sql: string, params: SQLQueryBindings[] = [], order?: readonly string[]): T[] {
  const rows = db.query(sql).all(...params) as T[];
  if (order) rows.sort((a, b) => {
    for (const key of order) {
      const left = (a as Record<string, unknown>)[key], right = (b as Record<string, unknown>)[key];
      if (left === right) continue;
      if (left == null) return -1;
      if (right == null) return 1;
      return (left as string | number) < (right as string | number) ? -1 : 1;
    }
    return 0;
  });
  return rows;
}

/** A WHERE list together with its parameters, in order. */
export class WhereClause {
  readonly where: string[] = [];
  readonly params: SQLQueryBindings[] = [];

  add(sql: string, params: SQLQueryBindings[] = []): this {
    this.where.push(sql); this.params.push(...params); return this;
  }
  clause(keyword = "WHERE"): string {
    return this.where.length ? `${keyword} ${this.where.join(" AND ")}` : "";
  }
}
