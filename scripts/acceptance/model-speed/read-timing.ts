// Read path on a database COPY: readModelSpeed (the reader /api/model-speed calls) for every Claude account, whole
// history, day and hour grain; then an idle timing pass (restart with nothing left). Usage: bun scripts/acceptance/model-speed/read-timing.ts <copy>
import { Database } from "../../../src/db/sqlite";
import { loadAccountResolver } from "../../../src/server/account-resolver";
import { readModelSpeed } from "../../../src/server/model-speed";
import { ParsePool } from "../../../src/ingest/parse-pool";
import { backfillClaudeTiming } from "../../../src/sync/claude-timing-backfill";
if (!process.argv[2] || /[\\/]live[\\/]/i.test(process.argv[2])) throw new Error("pass a copy of the database");
const db = new Database(process.argv[2]!, { readonly: true });
const resolver = loadAccountResolver(db);
for (const account of resolver.accounts("claude")) for (const grain of ["day", "hour"] as const) {
  const plan = resolver.plan("claude", account), times: number[] = [];
  let models: ReturnType<typeof readModelSpeed> = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); models = readModelSpeed(db, "claude", plan, { grain }); times.push(performance.now() - t); }
  const total = models.reduce((s, m) => ({ calls: s.calls + m.total.calls, timed: s.timed + m.total.timed_calls }), { calls: 0, timed: 0 });
  console.log(JSON.stringify({ account: account.slice(0, 3) + "…", grain, models: models.length, points: models.reduce((s, m) => s + m.points.length, 0),
    ...total, firstMs: Math.round(times[0]!), medianMs: Math.round([...times].sort((a, b) => a - b)[2]!) }));
}
db.close();
const writable = new Database(process.argv[2]!);
const pool = new ParsePool(2);
const t = performance.now();
const idle = await backfillClaudeTiming(writable, pool, async apply => apply());
console.log(JSON.stringify({ label: "idle-pass", ms: Math.round(performance.now() - t), ...idle }));
await pool.close(); writable.close();
