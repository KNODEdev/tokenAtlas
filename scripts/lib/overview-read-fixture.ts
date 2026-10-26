import { Database } from "../../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../../src/db/migrate";

/** Entirely synthetic, canonical fixture. The caller owns its temporary directory. */
export function createOverviewReadFixture(file: string, subjects = 12, samples = 10_000): void {
  using sqlite = new Database(file, { create: true });
  applyDrizzleMigrations(drizzle(sqlite));
  // This diagnostic compares frozen pre-W9 SQL, whose attribution marker is no longer in the app schema.
  sqlite.exec("ALTER TABLE probe_windows ADD COLUMN era_unattributed INTEGER NOT NULL DEFAULT 0");
  sqlite.transaction(() => {
    const insert = sqlite.query(`INSERT INTO probe_windows
      (provider, subject, ts, kind, limit_group, reported_percent_side, used_percent, ok, machine, window_minutes)
      VALUES ('codex', ?, ?, 'secondary', 'codex', 'used', ?, 1, ?, 10080)`);
    const end = Date.parse("2026-09-06T09:00:00.000Z");
    for (let s = 0; s < subjects; s++) for (let n = 0; n < samples; n++)
      insert.run(`synthetic-${s}`, new Date(end - n * 60_000).toISOString(), n % 99, s % 2 ? "PC-B" : "PC-A");
  })();
}
