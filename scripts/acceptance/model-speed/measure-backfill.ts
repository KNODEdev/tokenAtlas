// Measurement on a COPY of the live database (never the live file): migration 0065, the parser-6 timing backfill
// (sync/claude-timing-backfill.ts, the function the sync cycle calls, with the default per-cycle budget) and the usage
// ledger producer's catch-up (the steps the background worker runs: limit 500, 4 steps, 250 ms slices).
// Usage: bun scripts/acceptance/model-speed/measure-backfill.ts <copy.sqlite>
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Database } from "../../../src/db/sqlite";
import { applyDrizzleMigrations, ensureRawSyncIndexes } from "../../../src/db/migrate";
import { initDb } from "../../../src/db";
import { ARCHIVE_LOGICAL_ROOT, configFile } from "../../../src/config/paths";
import { ParsePool, parseWorkerCount } from "../../../src/ingest/parse-pool";
import { backfillClaudeTiming } from "../../../src/sync/claude-timing-backfill";
import { advanceUsageLedger, usageLedgerState } from "../../../src/server/usage-ledger-producer";
import { usageLedgerReadiness } from "../../../src/db/usage-ledger-read";
import type { RateCard } from "../../../src/server/pricing";

const file = process.argv[2]!;
if (!file || /[\\/]live[\\/]/i.test(file)) throw new Error("pass a copy of the database");
const hash = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
const log = (label: string, value: unknown) => console.log(JSON.stringify({ label, ...value as object }));

// The migrations runMigrations applies, without its pre-migration snapshot (0063 is not declared additive, and a
// snapshot of a copy has no purpose); 0063 only creates empty tables.
let t = performance.now();
{ const { db, sqlite } = initDb(file); applyDrizzleMigrations(db); ensureRawSyncIndexes(sqlite); sqlite.close(); }
log("migrate", { ms: Math.round(performance.now() - t) });

const db = new Database(file);
db.exec("PRAGMA busy_timeout=5000");
const rates = JSON.parse(fs.readFileSync(configFile("rate-cards.json"), "utf8")) as RateCard;
log("readiness-before", usageLedgerReadiness(db, "claude", rates));
// Work the copy owes before this feature (a rules change since the live server last ran): done and measured first.
const catchUp = (label: string) => {
  const started = performance.now();
  let turns = 0, slowest = 0, overSecond = 0;
  for (;;) {
    const s = performance.now();
    const step = advanceUsageLedger(db, "claude", rates, ARCHIVE_LOGICAL_ROOT, { limit: 500, steps: 4, budgetMs: 250 });
    const d = performance.now() - s; slowest = Math.max(slowest, d); turns++; if (d > 1000) overSecond++;
    if (step.complete || step.reason) { if (step.reason) log(label + "-reason", step); break; }
  }
  log(label, { ms: Math.round(performance.now() - started), turns, slowestTurnMs: Math.round(slowest), turnsOverOneSecond: overSecond, state: usageLedgerState(db, "claude") });
};
catchUp("ledger-preexisting");
log("readiness-ready", usageLedgerReadiness(db, "claude", rates));
const untimed = () => ({
  facts: hash(db.query(`SELECT row_id,identity,fingerprint,copy_state,dim_id,std_key,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto,glb_usd,glb_nano,glb_femto
    FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all()),
  days: hash(db.query(`SELECT * FROM usage_ledger_days WHERE provider='claude' ORDER BY day,dim_id`).all()
    .map(row => Object.fromEntries(Object.entries(row as object).filter(([key]) => !key.startsWith("timed_"))))),
  hours: hash(db.query(`SELECT * FROM usage_ledger_hours WHERE provider='claude' ORDER BY day,hour,dim_id`).all()
    .map(row => Object.fromEntries(Object.entries(row as object).filter(([key]) => !key.startsWith("timed_"))))),
  reasons: hash(db.query("SELECT * FROM usage_ledger_day_reasons WHERE provider='claude' ORDER BY day,dim_id,variant,reason").all()),
  dims: hash(db.query("SELECT * FROM usage_ledger_dims WHERE provider='claude' ORDER BY id").all()),
  marks: (db.query("SELECT COUNT(*) n FROM window_answer_marks").get() as { n: number }).n,
  windowDirty: (db.query("SELECT COUNT(*) n FROM window_usage_dirty").get() as { n: number }).n,
  otherProviders: hash(db.query("SELECT provider,revision,published_revision FROM usage_ledger_state WHERE provider<>'claude' ORDER BY provider").all()),
});
const before = untimed();
log("before", { ...before, state: usageLedgerState(db, "claude") });

// Backfill: one call per sync cycle, each with the default budget, until the pass is complete.
const pool = new ParsePool(parseWorkerCount());
t = performance.now();
const cycles: Array<Record<string, unknown>> = [];
for (let cycle = 1; cycle < 100; cycle++) {
  const started = performance.now();
  let writeMs = 0, writes = 0, longestWrite = 0;
  const step = await backfillClaudeTiming(db, pool, async apply => { const w = performance.now(); try { return apply(); }
    finally { const d = performance.now() - w; writeMs += d; writes++; longestWrite = Math.max(longestWrite, d); } });
  cycles.push({ cycle, files: step.files, bytes: step.bytes, updated: step.updated, skipped: step.skipped, ms: Math.round(performance.now() - started),
    writeMs: Math.round(writeMs), writes, longestWriteMs: Math.round(longestWrite), failures: step.failures });
  log("backfill-cycle", cycles.at(-1));
  if (step.done) break;
}
await pool.close();
log("backfill", { cycles: cycles.length, ms: Math.round(performance.now() - t),
  timedRows: (db.query("SELECT COUNT(*) n FROM claude_events WHERE resp_ms IS NOT NULL").get() as { n: number }).n,
  rows: (db.query("SELECT COUNT(*) n FROM claude_events").get() as { n: number }).n,
  filesLeft: (db.query("SELECT COUNT(*) n FROM claude_files WHERE parser_version<6").get() as { n: number }).n });

// The ledger catches up as the background worker runs it.
catchUp("ledger");
const after = untimed();
log("after", after);
log("unchanged", Object.fromEntries(Object.keys(before).map(key => [key, (before as Record<string, unknown>)[key] === (after as Record<string, unknown>)[key]])));
db.close();
