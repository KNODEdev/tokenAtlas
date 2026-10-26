import { Database } from "../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { isDeepStrictEqual } from "node:util";
import { applyDrizzleMigrations } from "../src/db/migrate";
import { subscriptionDailyUsage, type DayUsage } from "../src/server/subscription-usage";
import { prepareUsageRegisters } from "../src/server/usage-register.fixture";
import { declareClaudeLabelPeriods } from "../src/server/subscription-reader.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../src/config/paths";
import type { RateCard } from "../src/server/pricing";

const rows = Number(process.argv[2] ?? 200_000);
if (!Number.isSafeInteger(rows) || rows < 1 || rows > 1_000_000) {
  throw new Error("Usage: bun scripts/benchmark-subscription-usage.ts [rows: 1..1000000]");
}
const sqlite = new Database(":memory:");
try {
  applyDrizzleMigrations(drizzle(sqlite));
  sqlite.query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ?)
    INSERT INTO claude_events (store,call_id,ts,path,subscription_id,model,in_uncached,in_cache_read,out_total)
    SELECT 'machine', 'call-' || x, printf('2026-08-%02dT10:00:00.000Z', 1 + x % 28),
      'archive/claude/source-' || (x % 3) || '/session.jsonl', 'claude1', 'test', 100, 50, 20 FROM n`).run(rows);
  const rateCards: RateCard = { version: 1, currency: "USD", unit: "per 1M", vendors: {} };
  const ctx = { sqlite, rateCards };
  declareClaudeLabelPeriods(sqlite);
  const writeStart = performance.now();
  prepareUsageRegisters(sqlite,rateCards);
  const rebuildMs = performance.now() - writeStart;
  // Independent SQL oracle: this synthetic model has no price, so all of its tokens
  // and calls remain unpriced. No ledger consumer supplies the reference.
  const rawRead = () => new Map<string,DayUsage[]>([["claude1", (sqlite.query(`SELECT substr(ts,1,10) day,
    ? source,COUNT(*) calls,SUM(in_uncached+in_cache_read+out_total) tokens,0 usd,
    COUNT(*) unpriced_calls,SUM(in_uncached+in_cache_read+out_total) unpriced_tokens
    FROM claude_events GROUP BY substr(ts,1,10)`).all(`${ARCHIVE_LOGICAL_ROOT}/claude/claude1`) as DayUsage[])]]);
  const raw = rawRead(), derived = subscriptionDailyUsage(ctx);
  const normalized = (value: ReturnType<typeof subscriptionDailyUsage>) =>
    [...value].sort(([a], [b]) => a.localeCompare(b)).map(([id, days]) => [id,
      [...days].sort((a, b) => `${a.day}:${a.source}`.localeCompare(`${b.day}:${b.source}`)),
    ]);
  if (!isDeepStrictEqual(normalized(raw), normalized(derived))) throw new Error("Projection differs from the raw reference");
  const measure = (read: () => unknown): number => {
    const samples: number[] = [];
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      read();
      samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b)[4]!;
  };
  const rawMs = measure(rawRead);
  const derivedMs = measure(() => subscriptionDailyUsage(ctx));
  const facts = sqlite.query("SELECT COUNT(*) AS n FROM usage_ledger_days WHERE provider='claude'").get() as { n: number };
  console.log(JSON.stringify({
    scenario: "synthetic Claude history, warm in-memory SQLite, 9 reads per path; not a live endpoint benchmark",
    entry_point:"subscriptionDailyUsage",mode:"warm synthetic in-memory database",excludes:"HTTP, rendering, real archive and startup",
    raw_rows: rows, fact_rows: facts.n, initial_ledger_fill_ms: rebuildMs,
    raw_read_p50_ms: rawMs, derived_read_p50_ms: derivedMs, speedup: rawMs / derivedMs, parity: true,
  }, null, 2));
} finally { sqlite.close(); }
