import { initDb } from "./db";
import { claudeEvents, claudeFiles } from "./db/schema";
import { sql } from "drizzle-orm";
export function formatNum(n: number | null | undefined): string {
  if (n == null) return "0";
  return n.toLocaleString();
}
export async function verify(customDbPath?: string) {
  const { db, sqlite, dbPath } = initDb(customDbPath);
  console.log(`\n======================================================`);
  console.log(`           TOKENATLAS DATABASE VERIFICATION           `);
  console.log(`======================================================`);
  console.log(`Database path: ${dbPath}\n`);
  console.log(`--- [1] Existing Codex Archive Tables ---`);
  const codexTables = ["events", "ratelimit", "files", "meta"];
  for (const tableName of codexTables) {
    try {
      const row = sqlite
        .query(`SELECT count(*) as count FROM "${tableName}"`)
        .get() as { count: number } | null;
      if (row) {
        console.log(`  Table [${tableName}]: ${formatNum(row.count)} rows`);
      } else {
        console.log(`  Table [${tableName}]: not present`);
      }
    } catch {
      console.log(`  Table [${tableName}]: not present (or not accessible)`);
    }
  }
  console.log(`\n--- [2] Claude Usage Summary per Store ---`);
  const storesResult = sqlite
    .query(`SELECT DISTINCT store FROM claude_events UNION SELECT DISTINCT store FROM claude_files`)
    .all() as { store: string }[];
  const stores = storesResult.map((r) => r.store).filter(Boolean);
  if (stores.length === 0) {
    console.log("  No Claude records found in database.");
  }
  for (const store of stores) {
    console.log(`\nStore: [${store}]`);
    const filesCount = sqlite
      .query(`SELECT count(*) as count FROM claude_files WHERE store = ?`)
      .get(store) as { count: number };
    const metrics = sqlite
      .query(`
        SELECT
          count(*) as row_count,
          count(DISTINCT call_id) as distinct_calls,
          min(ts) as min_ts,
          max(ts) as max_ts,
          sum(in_uncached) as sum_in_uncached,
          sum(in_cache_read) as sum_in_cache_read,
          sum(in_cache_write) as sum_in_cache_write,
          sum(cache_write_5m) as sum_cache_write_5m,
          sum(cache_write_1h) as sum_cache_write_1h,
          sum(out_total) as sum_out_total,
          sum(out_thinking) as sum_out_thinking
        FROM claude_events
        WHERE store = ?
      `)
      .get(store) as any;
    console.log(`  Files tracked:           ${formatNum(filesCount?.count)}`);
    console.log(`  Row count:               ${formatNum(metrics?.row_count)}`);
    console.log(`  Distinct call IDs:       ${formatNum(metrics?.distinct_calls)}`);
    console.log(`  Min timestamp:           ${metrics?.min_ts || "N/A"}`);
    console.log(`  Max timestamp:           ${metrics?.max_ts || "N/A"}`);
    console.log(`  Token Totals:`);
    console.log(`    in_uncached:           ${formatNum(metrics?.sum_in_uncached)}`);
    console.log(`    in_cache_read:         ${formatNum(metrics?.sum_in_cache_read)}`);
    console.log(`    in_cache_write:        ${formatNum(metrics?.sum_in_cache_write)}`);
    console.log(`    cache_write_5m:        ${formatNum(metrics?.sum_cache_write_5m)}`);
    console.log(`    cache_write_1h:        ${formatNum(metrics?.sum_cache_write_1h)}`);
    console.log(`    out_total:             ${formatNum(metrics?.sum_out_total)}`);
    console.log(`    out_thinking:          ${formatNum(metrics?.sum_out_thinking)}`);
  }
  console.log(`\n--- [2b] opencode Usage Summary ---`);
  try {
    const oc = sqlite
      .query(`
        SELECT provider, model, count(*) as n, sum(in_tok) as in_tok, sum(out_tok) as out_tok,
               sum(reasoning) as reasoning, sum(cache_read) as cache_read,
               min(ts) as t0, max(ts) as t1
        FROM oc_events GROUP BY provider, model ORDER BY n DESC
      `)
      .all() as any[];
    if (oc.length === 0) console.log("  No opencode records (run: bun run ingest:opencode).");
    for (const r of oc) {
      console.log(
        `  ${r.provider} / ${r.model}: ${formatNum(r.n)} calls, in ${formatNum(r.in_tok)}, ` +
          `out ${formatNum(r.out_tok)}, cache read ${formatNum(r.cache_read)}, ` +
          `${(r.t0 || "").slice(0, 10)}..${(r.t1 || "").slice(0, 10)}`
      );
    }
  } catch {
    console.log("  Table [oc_events]: not present (run db:migrate).");
  }
  console.log(`\n--- [2c] Duplication Sentinels ---`);
  try {
    const codexDup = sqlite
      .query(`
        SELECT count(*) as n FROM (
          SELECT replace(path, rtrim(path, replace(path, '\\', '')), '') AS base,
                 count(DISTINCT home) AS homes
          FROM files GROUP BY base HAVING homes > 1
        )
      `)
      .get() as { n: number };
    console.log(
      codexDup.n === 0
        ? "  ✓ Codex: no rollout file indexed under more than one home"
        : `  ⚠ Codex: ${codexDup.n} rollout filename(s) indexed under MULTIPLE homes - events are double-counted!`
    );
  } catch {
    console.log("  Codex duplicate check failed (files table missing?)");
  }
  try {
    const claudeDup = sqlite
      .query(`
        SELECT count(*) as n FROM (
          SELECT call_id FROM claude_events GROUP BY call_id HAVING count(DISTINCT store) > 1
        )
      `)
      .get() as { n: number };
    console.log(
      claudeDup.n === 0
        ? "  ✓ Claude: no call_id appears in more than one store"
        : `  ⚠ Claude: ${claudeDup.n} call_id(s) present in MULTIPLE stores - overlapping store roots?`
    );
  } catch {
    console.log("  Claude duplicate check failed");
  }
  console.log(`\n--- [3] Cache Write Consistency Check ---`);
  const mismatches = sqlite
    .query(`
      SELECT store, call_id, ts, in_cache_write, cache_write_5m, cache_write_1h, (cache_write_5m + cache_write_1h) as sum_parts
      FROM claude_events
      WHERE in_cache_write != (cache_write_5m + cache_write_1h)
      LIMIT 20
    `)
    .all() as any[];
  const mismatchCount = sqlite
    .query(`
      SELECT count(*) as count
      FROM claude_events
      WHERE in_cache_write != (cache_write_5m + cache_write_1h)
    `)
    .get() as { count: number };
  if (mismatchCount.count === 0) {
    console.log(`  ✓ All rows are consistent: in_cache_write == cache_write_5m + cache_write_1h (0 mismatches)`);
  } else {
    console.log(`  ⚠ Found ${mismatchCount.count} rows where in_cache_write != (cache_write_5m + cache_write_1h):`);
    for (const m of mismatches) {
      console.log(`    Store: ${m.store}, Call: ${m.call_id}, Write: ${m.in_cache_write}, 5m: ${m.cache_write_5m}, 1h: ${m.cache_write_1h}`);
    }
  }
  console.log(`\n======================================================\n`);
  sqlite.close();
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  let customDb: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--db" && i + 1 < args.length) {
      const val = args[++i];
      if (val) customDb = val;
    }
  }
  verify(customDb).catch((err) => {
    console.error("Verification failed:", err);
    process.exit(1);
  });
}
