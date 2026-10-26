// Test support: Codex calls grouped per day or session from the fact table, for pricing tests.
// Screens read cycle sums from window_usage (window-usage.ts).
import { codexPriceGroupSql } from "./pricing";
import type { Database, SQLQueryBindings } from "bun:sqlite";

export interface CycleEventGroup {
  kind: "day" | "session";
  bucket: string | number | null;
  model: string | null;
  calls: number;
  in_tok: number | null;
  cached_in: number | null;
  cache_write: number | null;
  out_tok: number | null;
  price_day?: string;
  context_input?: number;
  cache_write_status?: string | null;
  usage_status?: string | null;
}

export function readCycleEventGroups(
  sqlite: Database,
  where: string[],
  params: SQLQueryBindings[],
  fromSeconds: number,
  blockSeconds: number,
  _priceByDay = false,
): CycleEventGroup[] {
  const day = "date(ts, 'localtime')";
  const block = `CAST((CAST(strftime('%s', ts) AS INTEGER) - ${fromSeconds}) / ${blockSeconds} AS INTEGER)`;
  const pricing = codexPriceGroupSql(sqlite);
  const sums = `model, ${pricing.select}, COUNT(*) AS calls, SUM(in_tok) AS in_tok, SUM(cached_in) AS cached_in, SUM(cache_write) AS cache_write, SUM(out_tok) AS out_tok`;
  const tariffGroup = `, ${pricing.group}`;
  // Materialize only the exact selected input: ownership is checked once, and
  // both independent groupings retain SQLite's NULL, sum and model tie ordering.
  try {
    return sqlite.query(`WITH cycle_events AS MATERIALIZED (
      SELECT * FROM events
      WHERE ${where.join(" AND ")}
    )
    SELECT 'day' AS kind, ${day} AS bucket, ${sums} FROM cycle_events GROUP BY bucket, model${tariffGroup}
    UNION ALL
    SELECT 'session' AS kind, ${block} AS bucket, ${sums} FROM cycle_events GROUP BY bucket, model${tariffGroup}
    ORDER BY kind, bucket, model`).all(...params) as CycleEventGroup[];
  } catch {
    // Preserve the old independent best-effort reads when one grouping fails.
    const rows: CycleEventGroup[] = [];
    for (const [kind, bucket] of [["day", day], ["session", block]] as const) {
      try {
        rows.push(...sqlite.query(`SELECT '${kind}' AS kind, ${bucket} AS bucket, ${sums}
          FROM events WHERE ${where.join(" AND ")} GROUP BY bucket, model${tariffGroup}`).all(...params) as CycleEventGroup[]);
      } catch {}
    }
    return rows;
  }
}
