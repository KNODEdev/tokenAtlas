/** Read-only operational diagnostic. No archive writes, credentials or raw payload output. */
import { Database } from "../src/db/sqlite";
import fs from "node:fs";
import { resolveDbPath } from "../src/db";
import { ARCHIVE_ROOT, PROFILE, archive } from "../src/config/paths";

const dbPath = resolveDbPath();
if (!fs.existsSync(dbPath)) {
  console.log(JSON.stringify({ status: "database-missing" }));
  process.exitCode = 1;
} else {
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gauge_journal_outbox'").get()) {
      console.log(JSON.stringify({ status: "migration-required" }));
      process.exitCode = 1;
    } else {
      const total = db.query("SELECT count(*) AS pending, min(queued_at) AS oldest_queued_at FROM gauge_journal_outbox").get() as { pending: number; oldest_queued_at: string | null };
      const current = db.query("SELECT count(*) AS n FROM gauge_journal_outbox WHERE journal_root = ? AND archive_root = ?")
        .get(archive("gauges", PROFILE), ARCHIVE_ROOT) as { n: number };
      console.log(JSON.stringify({ status: total.pending ? "pending" : "empty", ...total,
        pending_current_target: current.n, pending_other_targets: total.pending - current.n,
        meaning: "Local delivery queue only; empty does not confirm OneDrive or remote ingestion." }, null, 2));
    }
  } finally { db.close(); }
}
