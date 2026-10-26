// Incremental vs full reference on a frozen dataset: `incremental` is a COPY after the backfill and the ledger's
// catch-up; `reference` is a copy of that copy whose Claude ledger is discarded and rebuilt from the same claude_events
// by the same producer (first fill). Every timed and untimed column of days and hours must be equal.
// Usage: bun scripts/acceptance/model-speed/full-reference.ts <incremental.sqlite> <reference.sqlite>
import fs from "node:fs";
import { Database } from "../../../src/db/sqlite";
import { ARCHIVE_LOGICAL_ROOT, configFile } from "../../../src/config/paths";
import { advanceUsageLedger } from "../../../src/server/usage-ledger-producer";
import type { RateCard } from "../../../src/server/pricing";

const [incrementalFile, referenceFile] = process.argv.slice(2) as [string, string];
if (!referenceFile || /[\\/]live[\\/]/i.test(referenceFile)) throw new Error("pass copies of the database");
const rates = JSON.parse(fs.readFileSync(configFile("rate-cards.json"), "utf8")) as RateCard;
const ref = new Database(referenceFile);
for (const table of ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_hours", "usage_ledger_day_reasons", "usage_ledger_dirty",
  "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_source_days", "usage_ledger_state"])
  ref.query(`DELETE FROM ${table} WHERE provider='claude'`).run();
const started = performance.now();
for (;;) { const step = advanceUsageLedger(ref, "claude", rates, ARCHIVE_LOGICAL_ROOT, { limit: 2000, budgetMs: 60_000 }); if (step.complete || step.reason) break; }
console.log(JSON.stringify({ label: "full-rebuild", ms: Math.round(performance.now() - started) }));
const inc = new Database(incrementalFile, { readonly: true });
// Dimension ids differ between the two builds: rows are keyed by the dimension's key.
const read = (db: Database, table: "usage_ledger_days" | "usage_ledger_hours") => new Map((db.query(`SELECT x.*, m.key dim_key FROM ${table} x
  JOIN usage_ledger_dims m ON m.id=x.dim_id WHERE x.provider='claude'`).all() as Array<Record<string, unknown>>)
  .map(({ dim_id: _id, ...row }) => [`${row.day}|${row.hour ?? ""}|${row.dim_key}`, row]));
for (const table of ["usage_ledger_days", "usage_ledger_hours"] as const) {
  const a = read(inc, table), b = read(ref, table);
  const differences: unknown[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key), y = b.get(key);
    if (!x || !y) { differences.push({ key, missing: x ? "reference" : "incremental" }); continue; }
    for (const column of Object.keys(x)) if (x[column] !== y[column]) differences.push({ key, column, incremental: x[column], reference: y[column] });
  }
  const timedTotal = [...a.values()].reduce((sum, row) => sum + Number(row.timed_calls), 0);
  console.log(JSON.stringify({ table, rows: a.size, referenceRows: b.size, timedCalls: timedTotal, differences: differences.length, sample: differences.slice(0, 5) }));
}
inc.close(); ref.close();
