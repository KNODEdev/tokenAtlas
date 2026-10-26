// Per-step cost of a time-only change of the busiest day, on a database COPY. Usage: bun scripts/acceptance/model-speed/profile-steps.ts <copy.sqlite>
import fs from "node:fs";
import { Database } from "../../../src/db/sqlite";
import { ARCHIVE_LOGICAL_ROOT, configFile } from "../../../src/config/paths";
import { stepUsageLedger } from "../../../src/server/usage-ledger-producer";
import type { RateCard } from "../../../src/server/pricing";
if (!process.argv[2] || /[\\/]live[\\/]/i.test(process.argv[2])) throw new Error("pass a copy of the database");
const db = new Database(process.argv[2]!);
const rates = JSON.parse(fs.readFileSync(configFile("rate-cards.json"), "utf8")) as RateCard;
const day = (db.query("SELECT substr(ts,1,10) day, COUNT(*) n FROM claude_events GROUP BY 1 ORDER BY 2 DESC LIMIT 1").get() as { day: string; n: number });
console.log(JSON.stringify(day));
db.query("UPDATE claude_events SET resp_ms=resp_ms+1 WHERE ts>=? AND ts<?||'~' AND resp_ms IS NOT NULL").run(day.day, day.day);
for (let i = 0; i < 200; i++) {
  const before = db.query("SELECT phase,bookmark FROM usage_ledger_state WHERE provider='claude'").get() as { phase: string; bookmark: string };
  const t = performance.now();
  const step = stepUsageLedger(db, "claude", rates, ARCHIVE_LOGICAL_ROOT, 500);
  console.log(JSON.stringify({ ms: Math.round(performance.now() - t), processed: step.processed, phase: before.phase, bookmark: before.bookmark.slice(0, 60) }));
  if (step.complete) break;
}
db.close();
