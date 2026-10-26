/** Explicit, read-only inspection of an operator's isolated database copy.
 * Never opens the default database, migrates, starts a worker or accesses the archive.
 */
import { Database } from "../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import fs from "node:fs";
import path from "node:path";
import { assertMigrationHistory } from "../src/db/migrate";

const migrationsFolder = path.resolve(import.meta.dir, "../drizzle");
type BlockReason = "database-missing" | "database-unreadable" | "integrity-failed"
  | "untracked-schema" | "migration-history-mismatch" | "incomplete-schema";
export interface ReviewPreflight {
  schema_version: 1;
  kind: "read-only-local-preflight";
  status: "compatible" | "upgrade-required" | "blocked";
  reason: BlockReason | null;
  migrations: { applied: number; available: number } | null;
  journal: { pending: number; receipts: number } | null;
  projection: { dirty_subjects: number; source_revision: number; published_revision: number } | null;
  // These checks require separate evidence. A successful preflight never closes them.
  acceptance: { private_golden: "not-run"; multi_pc: "not-run"; user_review: "not-recorded" };
}
export function reviewPreflight(databaseCopy: string): ReviewPreflight {
  const result: ReviewPreflight = {
    schema_version: 1, kind: "read-only-local-preflight", status: "blocked", reason: null,
    migrations: null, journal: null, projection: null,
    acceptance: { private_golden: "not-run", multi_pc: "not-run", user_review: "not-recorded" },
  };
  let db: Database | null = null;
  try {
    if (!databaseCopy || !fs.existsSync(databaseCopy)) {
      result.reason = "database-missing"; return result;
    }
    if (!fs.statSync(databaseCopy).isFile()) {
      result.reason = "database-unreadable"; return result;
    }
    db = new Database(databaseCopy, { readonly: true, strict: true });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000");
    const sqlite = db;
    return sqlite.transaction(() => {
      const integrity = sqlite.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
      if (!integrity.length || integrity.some(row => row.quick_check !== "ok")) {
        result.reason = "integrity-failed"; return result;
      }
      const has = (name: string) => sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
      if (!has("__drizzle_migrations")) { result.reason = "untracked-schema"; return result; }
      const count = (table: string) => (sqlite.query(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
      const applied = count("__drizzle_migrations");
      if (applied === 0) { result.reason = "untracked-schema"; return result; }
      result.migrations = { applied, available: readMigrationFiles({ migrationsFolder }).length };
      try { assertMigrationHistory(drizzle(sqlite), migrationsFolder); }
      catch { result.reason = "migration-history-mismatch"; return result; }
      const transport = has("gauge_journal_outbox") && has("gauge_journal_receipts");
      const current = has("current_projection_state") && has("current_projection_dirty")
        && has("probe_sources") && has("current_probe_subjects") && has("subscription_current");
      if (applied === result.migrations.available && (!transport || !current || !has("usage_ledger_hours"))) {
        result.reason = "incomplete-schema"; return result;
      }
      if (transport) result.journal = { pending: count("gauge_journal_outbox"), receipts: count("gauge_journal_receipts") };
      if (current) {
        const state = sqlite.query("SELECT probe_revision, published_probe_revision FROM current_projection_state WHERE id=1")
          .get() as { probe_revision: number; published_probe_revision: number } | null;
        if (!state) { result.reason = "incomplete-schema"; return result; }
        result.projection = { dirty_subjects: count("current_projection_dirty"),
          source_revision: state.probe_revision, published_revision: state.published_probe_revision };
      }
      result.status = applied < result.migrations.available ? "upgrade-required" : "compatible";
      return result;
    }).deferred();
  } catch {
    // Never echo SQLite errors, paths, payloads, email addresses or credentials.
    result.reason = "database-unreadable";
    result.status = "blocked";
    return result;
  } finally {
    try { db?.close(true); }
    catch { result.status = "blocked"; result.reason = "database-unreadable"; }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--db-copy" || !args[1]) {
    console.error("Usage: bun run review:preflight --db-copy <isolated-copy.sqlite>");
    process.exitCode = 2;
  } else {
    const report = reviewPreflight(args[1]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "blocked" ? 1 : 0;
  }
}
