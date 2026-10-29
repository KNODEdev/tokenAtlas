import { addTrackedColumn, installAnalysisTracking } from "./analysis";
import { backfillProbeFacts, probeFactShadow } from "./probe-facts";
import { ensureDerivedColumns } from "./derived-columns";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createHash } from "node:crypto";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "./sqlite";
import fs from "node:fs";
import type { StartupUpdate } from "../shared/startup";
import { activeDatabasePath, initDb, resolveDbPath } from "./index";
import { ensureGaugeBookmarkSchema } from "../ingest/gauges";
import { ensureCodexSchema } from "../ingest/codex";
import { CODEX_LEDGER_REPLAYS_INDEX_SQL } from "./codex-price-ledger";
import { ensureCodexFileModelsIndex, CODEX_FORKED_FROM_INDEX_SQL, CODEX_SOURCE_EVIDENCE_SCHEMA_SQL, CODEX_SOURCE_LOCATOR_INDEX_SQL, retireCodexEventEvidence } from "./codex-source-evidence";
import path from "path";
import { MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION, type AtlasSnapshotPublishResult, type PublishAtlasSnapshotOptions } from "./snapshot-contracts";
import { publishAtlasSnapshot } from "./snapshot-publish";
import { installFactDayRevisions } from "./fact-day-revisions";
import { asSchemaWriter } from "./schema-writer";
const DEFAULT_MIGRATIONS_FOLDER = path.resolve(import.meta.dir, "../../drizzle");
/** Hashes of migration files that were later edited without changing a single statement.
 * A database that applied the earlier text is on the same lineage, so it must still verify.
 * Keyed by journal timestamp, which identifies the migration independently of its text.
 * Only comment-only rewrites belong here; a changed statement is a real divergence.
 */
const SUPERSEDED_HASHES: ReadonlyMap<number, readonly string[]> = new Map([
  // 0009_unify_probe_windows: d970e7d moved the parity-guard comment onto the DROP block. LF, then CRLF.
  [1787644523760, [
    "8b332d4b45633caf46e9fac7a25af85a965a5619e8ccfb6937966676256308bc",
    "bb9719f12d18c59772f4b440488d241ab47df86da3eaf2378dc16c84aa354c26",
  ]],
  // 0021_current_read_models: the published header comment was shortened; SQL is unchanged.
  [1788591000000, [
    "5aad1ae4ca840a7a26fb0ed2f50fb732772fadba5da5a87b63d227f39c53bd6e",
    "32bf52cc5be8768647c583c5c03b42818720bbc6d08fc3192cebf6b5ab2ff3b5",
  ]],
]);
/** Fail before DDL when a database belongs to a divergent or edited migration history.
 * Drizzle 0.45 advances by timestamp, so a different 0020 must not silently skip ours.
 * Historical Windows checkouts may have hashed CRLF bytes; accept either line ending,
 * but never a different statement, missing intermediate migration or unknown timestamp.
 */
export function assertMigrationHistory(
  db: Parameters<typeof migrate>[0],
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER
): void {
  const exists = db.get(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`);
  if (!exists) return;
  const applied = db.all<{ hash: string; created_at: number }>(
    sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at`
  );
  assertAppliedMigrationHistory(applied, migrationsFolder);
}

function assertAppliedMigrationHistory(
  applied: Array<{ hash: string; created_at: number }>,
  migrationsFolder: string,
): void {
  if (applied.length === 0) return;
  const expected = readMigrationFiles({ migrationsFolder });
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  for (const [index, actual] of applied.entries()) {
    const entry = expected[index];
    const source = entry?.sql.join("--> statement-breakpoint").replace(/\r\n/g, "\n");
    const matches = entry && Number(actual.created_at) === entry.folderMillis && source != null
      && [entry.hash, digest(source), digest(source.replace(/\n/g, "\r\n")),
        ...(SUPERSEDED_HASHES.get(entry.folderMillis) ?? [])].includes(actual.hash);
    if (!matches) {
      throw new Error("Migration history mismatch: database and checkout have different migration lineages. "
        + "No migration was applied. Keep a backup and use an isolated compatible database; "
        + "see README.md. Do not edit __drizzle_migrations to bypass this check.");
    }
  }
}

/** Reviewed non-destructive migrations: additions, new companion-table seeds and their trigger
 * handoffs preserve existing source facts and calculated rows. Drizzle applies migrations in one
 * transaction, so a failure leaves the database as it was. The snapshot is skipped only when every
 * pending migration is listed; an unlisted one keeps it.
 * Keyed by journal timestamp. List a migration after reading it, never by matching its SQL.
 */
const ADDITIVE_MIGRATIONS: ReadonlySet<number> = new Set([
  1789776000005, // 0038_usage_price_buckets: two new empty tables
  1789776000009, // 0042_claude_remembered_identity: one partial index on claude_events
  1789776000013, // 0046_usage_ledger: new usage ledger tables and their indexes
  1789776000017, // 0050_limit_windows: new limit window tables and their indexes
  1789776000018, // 0051_window_usage: new window usage tables
  1789776000019, // 0052_window_usage_intervals: one new table
  1789776000033, // 0065_model_speed: new columns (nullable or defaulted) on claude_events and the usage ledger, tracking-trigger handoff
  1789776000043, // 0075_window_end_estimates: one new table
  1789776000044, // 0076_window_point_values: two new tables and an index
  1789776000045, // 0077_window_end_causes: two new tables
  1789776000046, // 0078_subscription_capacity: three new empty tables and an index
  1789776000047, // 0079_subscription_hours: three new empty tables
  1789776000048, // 0080_project_plan: three new empty tables
  1789776000049, // 0081_capacity_cycle_results: three new empty tables and an index
  1789776000050, // 0082_claude_card_metadata: six new empty tables and two indexes
  1789776000051, // 0083_fx_rates: one new empty table
  1789776000052, // 0084_limit_window_source_plan: one nullable column on prepared meter inputs
  1789776000054, // 0086_codex_context_prices: companion tables and triggers writing only those tables
  1789776000055, // 0087_codex_context_details: new companion tables, seeds and their tracking triggers
  1789776000056, // 0088_codex_context_window_ranges: new queue/index; removes only 0087 companion triggers
  1789776000057, // 0089_codex_context_final_projections: seeds/clears only newly created companions
  1789776000058, // 0090_codex_context_final_scopes: triggers write only the new companion queue
  1789776000059, // 0091_codex_context_final_queues: two new empty companion queues
  1789776000060, // 0092_claude_billing_mode: nullable columns on claude_events and usage_ledger_facts, tracking-trigger handoff
  1789776000063, // 0095_first_token: empty companion tables; background adapters install their file queues
]);

interface PreMigrationSnapshotOptions {
  migrationsFolder?: string;
  targetSchemaVersion?: number;
  additiveMigrations?: ReadonlySet<number>;
  publish?: (options: PublishAtlasSnapshotOptions) => AtlasSnapshotPublishResult;
  onProgress?: (update: StartupUpdate) => void;
}

function migrationTableExists(sqlite: Database): boolean {
  const statement = sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
  );
  try {
    return Boolean(statement.get());
  } finally {
    statement.finalize();
  }
}

function appliedMigrationRows(sqlite: Database): Array<{ hash: string; created_at: number }> {
  const statement = sqlite.prepare(
    "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at"
  );
  try {
    return statement.all() as Array<{ hash: string; created_at: number }>;
  } finally {
    statement.finalize();
  }
}

function installedMigrationVersion(dbPath: string): number | null {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return null;
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    if (!migrationTableExists(sqlite)) return null;
    const countStatement = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations");
    try {
      const row = countStatement.get() as { n: number } | null;
      return (row?.n ?? 0) - 1;
    } finally {
      countStatement.finalize();
    }
  } finally {
    sqlite.close(true);
  }
}

export function snapshotBeforePendingMigrations(
  dbPath: string,
  options: PreMigrationSnapshotOptions = {},
): AtlasSnapshotPublishResult | null {
  const folder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const targetSchemaVersion = options.targetSchemaVersion ?? migrations.length - 1;
  const installedSchemaVersion = installedMigrationVersion(dbPath);
  if (installedSchemaVersion == null) {
    if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0)
      refusePreMigrationSnapshot("an existing database has no migration history");
    return null;
  }
  if (installedSchemaVersion >= targetSchemaVersion) return null;
  if (installedSchemaVersion < MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION)
    refusePreMigrationSnapshot(`schema ${installedSchemaVersion} predates the oldest supported snapshot`);
  const additive = options.additiveMigrations ?? ADDITIVE_MIGRATIONS;
  const pending = migrations.slice(installedSchemaVersion + 1, targetSchemaVersion + 1);
  // A target beyond the known files leaves unidentified migrations pending; those keep the snapshot.
  if (
    pending.length === targetSchemaVersion - installedSchemaVersion
    && pending.every((migration) => additive.has(migration.folderMillis))
  ) {
    return null;
  }
  options.onProgress?.({ phase: "snapshot-wait",
    snapshotMigrations: migrationTags(folder, pending.filter((migration) => !additive.has(migration.folderMillis))
      .map((migration) => migration.folderMillis)) });
  let result: AtlasSnapshotPublishResult;
  try {
    result = (options.publish ?? publishAtlasSnapshot)({
      dbPath,
      mode: "manual",
      currentSchemaVersion: targetSchemaVersion,
      requireFreshCopy: true,
      copyMethod: "file",
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  } catch (error) {
    throw new Error(`Pre-migration snapshot failed: ${error instanceof Error ? error.message : String(error)} No migration was applied.`,
      { cause: error });
  }
  assertFreshPreMigrationSnapshot(result, installedSchemaVersion);
  return result;
}

/** Journal tags (e.g. `0085_activity_intervals`) for display; an unknown entry keeps its timestamp. */
function migrationTags(migrationsFolder: string, folderMillis: number[]): string[] {
  let tags = new Map<number, string>();
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
      entries?: Array<{ when: number; tag: string }>;
    };
    tags = new Map((journal.entries ?? []).map((entry) => [entry.when, entry.tag]));
  } catch { /* The tags only label the startup screen. */ }
  return folderMillis.map((millis) => tags.get(millis) ?? String(millis));
}

function refusePreMigrationSnapshot(detail: string): never {
  throw new Error(`Pre-migration snapshot rejected: ${detail}. No migration was applied.`);
}

/** A non-additive migration may run only behind a snapshot this call just created and
 * confirmed, of the schema it is about to change. Anything else stops before any DDL.
 */
function assertFreshPreMigrationSnapshot(
  result: AtlasSnapshotPublishResult | null | undefined,
  installedSchemaVersion: number,
): void {
  if (!result) refusePreMigrationSnapshot("the publisher returned no result");
  if (result.status !== "created") {
    refusePreMigrationSnapshot(`expected a newly created snapshot, got status "${result.status}"`
      + (result.reason ? ` (${result.reason})` : ""));
  }
  const { snapshotId, databasePath, manifestPath, manifest, validation } = result;
  if (result.leaseLostAfterCommit) {
    refusePreMigrationSnapshot(`the publication lease was lost after snapshot ${snapshotId} was committed`);
  }
  if (!snapshotId || !databasePath || !manifestPath || !manifest) {
    refusePreMigrationSnapshot("the created snapshot is missing its id, files or manifest");
  }
  if (!validation || !validation.valid || !validation.compatible || validation.errors.length > 0) {
    refusePreMigrationSnapshot(
      `snapshot ${snapshotId} failed validation: ${validation?.errors.join("; ") || "no validation result"}`,
    );
  }
  if (manifest.snapshotId !== snapshotId) {
    refusePreMigrationSnapshot(`snapshot ${snapshotId} carries the manifest of ${manifest.snapshotId}`);
  }
  if (manifest.schemaVersion !== installedSchemaVersion) {
    refusePreMigrationSnapshot(
      `snapshot ${snapshotId} has schema ${manifest.schemaVersion}, the database has ${installedSchemaVersion}`,
    );
  }
  if (!fs.existsSync(databasePath) || !fs.existsSync(manifestPath)) {
    refusePreMigrationSnapshot(`snapshot ${snapshotId} files are missing`);
  }
}

function assertExistingMigrationHistory(dbPath: string, migrationsFolder: string): void {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return;
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    if (migrationTableExists(sqlite)) {
      assertAppliedMigrationHistory(appliedMigrationRows(sqlite), migrationsFolder);
    }
  } finally {
    sqlite.close(true);
  }
}
const TRACKING_RECOVERY_KEY = "migration_claude_tracking_handoff";
type MigrationTrackingEvidence = { columns: string; triggers: string };

/** Keep the first trigger evidence durable when several guarded migrations run in one upgrade. */
function migrationTrackingEvidence(sqlite: Database, migrationsFolder: string): MigrationTrackingEvidence | null {
  const exists = (table: string) => !!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists("meta")) return null;
  const saved = sqlite.query("SELECT value FROM meta WHERE key=?").get(TRACKING_RECOVERY_KEY) as { value: string } | null;
  if (saved) {
    const evidence = JSON.parse(saved.value) as MigrationTrackingEvidence;
    if (typeof evidence.columns !== "string" || typeof evidence.triggers !== "string") throw new Error("Invalid migration tracking recovery evidence");
    return evidence;
  }
  if (!exists("claude_events")) return null;
  const lastApplied = migrationTableExists(sqlite) ? appliedMigrationRows(sqlite).at(-1)?.created_at ?? -1 : -1;
  if (!readMigrationFiles({ migrationsFolder }).some(entry => entry.folderMillis > lastApplied
    && entry.sql.some(statement => statement.includes("analysis_tracking_handoff")))) return null;
  const handed = exists("analysis_tracking_handoff")
    ? sqlite.query("SELECT columns,triggers FROM analysis_tracking_handoff WHERE source='claude_events'").get() as MigrationTrackingEvidence | null : null;
  const triggerRows = sqlite.query(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='claude_events'
    AND name IN ('analysis_claude_events_insert','analysis_claude_events_update','analysis_claude_events_delete')`).all() as Array<{ name: string; sql: string }>;
  const evidence = handed ?? {
    columns: JSON.stringify((sqlite.query("PRAGMA table_info(claude_events)").all() as Array<{ name: string }>).map(column => column.name)),
    triggers: JSON.stringify(Object.fromEntries(triggerRows.map(trigger => [trigger.name, trigger.sql]))),
  };
  sqlite.query("INSERT INTO meta(key,value) VALUES(?,?)").run(TRACKING_RECOVERY_KEY, JSON.stringify(evidence));
  return evidence;
}

export function applyDrizzleMigrations(
  db: Parameters<typeof migrate>[0] & { $client: ReturnType<typeof initDb>["sqlite"] },
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER
): void {
  assertMigrationHistory(db, migrationsFolder);
  const evidence = migrationTrackingEvidence(db.$client, migrationsFolder);
  migrate(db, { migrationsFolder });
  if (evidence && db.$client.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_tracking_handoff'").get())
    db.$client.query("UPDATE analysis_tracking_handoff SET columns=?,triggers=? WHERE source='claude_events'")
      .run(evidence.columns, evidence.triggers);
  backfillProbeFacts(db.$client);
  probeFactShadow(db.$client);
  installAnalysisTracking(db.$client);
  installFactDayRevisions(db.$client);
  if (evidence) db.$client.query("DELETE FROM meta WHERE key=?").run(TRACKING_RECOVERY_KEY);
}
export function ensureRawSyncIndexes(sqlite: ReturnType<typeof initDb>["sqlite"]): void {
  asSchemaWriter(sqlite, () => {
    // A new database has never run a Codex import; its first fill publishes into these tables.
    if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) ensureCodexSchema(sqlite);
    sqlite.exec(CODEX_SOURCE_EVIDENCE_SCHEMA_SQL);
    for (const [table, index] of [
      ["events", "events_global_ts"],
      ["ratelimit", "ratelimit_global_ts"],
    ] as const) {
      const exists = sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (exists) {
        sqlite.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(ts)`);
        // Reporting filters use calendar days; preserve indexed access for those expressions too.
        sqlite.exec(`CREATE INDEX IF NOT EXISTS ${table}_analysis_day ON ${table}(substr(ts,1,10))`);
        sqlite.exec(`CREATE INDEX IF NOT EXISTS ${table}_range_sources ON ${table}(ts,home,path)`);
      }
    }
    // Global usage deduplicates unassigned traffic by `[vendor, owner ?? home, identity]`, so the
    // shared register looks a provider identity up across stores. Every unique index of these
    // tables leads with `store` (Grok's leads with `source_id` as well), so without these the
    // lookup is a table scan (WP4f; measured with EXPLAIN QUERY PLAN).
    for (const [table, columns] of [
      ["claude_events", ["call_id"]],
      ["gemini_events", ["conversation_id", "gen_idx"]],
      ["grok_events", ["session_id", "prompt_id", "model"]],
      ["oc_events", ["message_id"]],
    ] as const) {
      if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const present = new Set((sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
      if (columns.every(column => present.has(column)))
        sqlite.exec(`CREATE INDEX IF NOT EXISTS ${table}_identity_idx ON ${table}(${columns.join(",")})`);
    }
    if (sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ratelimit'").get()) {
      const columns = new Set((sqlite.query("PRAGMA table_info(ratelimit)").all() as Array<{ name: string }>).map(c => c.name));
      if (!columns.has("source_offset")) sqlite.exec("ALTER TABLE ratelimit ADD COLUMN source_offset INTEGER");
      if (!columns.has("source_slot")) sqlite.exec("ALTER TABLE ratelimit ADD COLUMN source_slot TEXT");
      if (["home", "path"].every(c => columns.has(c)))
        sqlite.exec("CREATE INDEX IF NOT EXISTS ratelimit_source_identity ON ratelimit(home,path,source_offset,source_slot)");
      if (["home", "path", "window_minutes", "limit_id", "ts"].every(c => columns.has(c)))
        sqlite.exec("CREATE INDEX IF NOT EXISTS ratelimit_identity_window ON ratelimit(home,path,window_minutes,limit_id,ts)");
    }
    ensureDerivedColumns(sqlite);
    // `files` holds the Codex import's bookmarks (src/ingest/codex.ts). The sync stage copies the
    // active schema, so the columns have to exist here for a bookmark to survive a publish.
    const files = sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'").get();
    if (files) {
      const columns = (sqlite.query("PRAGMA table_info(files)").all() as Array<{ name: string }>).map((c) => c.name);
      if (!columns.includes("offset")) sqlite.exec("ALTER TABLE files ADD COLUMN offset INTEGER");
      if (!columns.includes("parser_version")) sqlite.exec("ALTER TABLE files ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0");
      if (!columns.includes("parser_state")) sqlite.exec("ALTER TABLE files ADD COLUMN parser_state TEXT");
    }
    // The Codex import owns these raw tables (ensureCodexSchema); keep its additive schema in sync
    // before a staged import. Legacy facts retain an explicit unknown speed.
    if (sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()) {
      const columns = new Set((sqlite.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).map(c => c.name));
      for (const [name, type] of [
        ["service_tier", "TEXT"], ["speed", "TEXT NOT NULL DEFAULT 'unknown'"],
        ["speed_source", "TEXT"], ["speed_source_offset", "INTEGER"],
        ["source_offset", "INTEGER"], ["plan_type", "TEXT"],
        ["billing_mode", "TEXT NOT NULL DEFAULT 'unknown'"], ["meter_reset", "INTEGER"], ["account_id", "TEXT"],
        ["response_id", "TEXT"], ["turn_id", "TEXT"], ["usage_source", "TEXT"], ["producer_version", "TEXT"],
        ["cache_write_status", "TEXT NOT NULL DEFAULT 'missing'"], ["usage_status", "TEXT NOT NULL DEFAULT 'unknown'"],
        ["provider_ids_observed", "INTEGER"],
      ]) {
        if (!columns.has(name!)) sqlite.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
      }
      // Codex parser 7: a tracked column added without moving the events revision (analysis.ts).
      addTrackedColumn(sqlite, "events", "resp_ms", "INTEGER");
      sqlite.exec("CREATE INDEX IF NOT EXISTS events_billing_mode ON events(billing_mode) WHERE billing_mode = 'business_credits'");
      sqlite.exec(CODEX_SOURCE_LOCATOR_INDEX_SQL);
      ensureCodexFileModelsIndex(sqlite);
    }
    const evidence = new Set((sqlite.query("PRAGMA table_info(codex_file_evidence)").all() as Array<{ name: string }>).map(c => c.name));
    for (const name of ["provider_thread_id", "provider_session_id", "provider_forked_from_id", "first_token_json"])
      if (!evidence.has(name)) sqlite.exec(`ALTER TABLE codex_file_evidence ADD COLUMN ${name} TEXT`);
    sqlite.exec(CODEX_FORKED_FROM_INDEX_SQL);
    if (sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_price_ledger_events'").get())
      sqlite.exec(CODEX_LEDGER_REPLAYS_INDEX_SQL);
    retireCodexEventEvidence(sqlite);
    ensureGaugeBookmarkSchema(sqlite);
    if (sqlite.query("SELECT 1 FROM sqlite_master WHERE name='probe_counters'").get()) {
      sqlite.exec(`CREATE INDEX IF NOT EXISTS probe_counter_legacy_coordinates
        ON probe_counters(json_extract(payload,'$.provider'),json_extract(payload,'$.ts'));
        CREATE INDEX IF NOT EXISTS probe_delivery_counter ON probe_fact_deliveries(counter_id);`);
    }
    installAnalysisTracking(sqlite);
    installFactDayRevisions(sqlite);
  });
}
export async function runMigrations(customPath?: string, migrationsFolder?: string, onProgress?: (update: StartupUpdate) => void) {
  const folder = migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const resolvedDbPath = resolveDbPath(customPath);
  console.log(`Migration target: ${resolvedDbPath}`);
  onProgress?.({ phase: "migration-check" });
  assertExistingMigrationHistory(resolvedDbPath, folder);
  const safetySnapshot = snapshotBeforePendingMigrations(resolvedDbPath, { migrationsFolder: folder, onProgress });
  if (safetySnapshot) console.log(`Pre-migration snapshot created: ${safetySnapshot.snapshotId}`);
  onProgress?.({ phase: "migration" });
  const { db, sqlite, dbPath } = initDb(resolvedDbPath);
  console.log(`Running migrations against DB at: ${dbPath}`);
  console.log(`Migrations folder: ${folder}`);
  applyDrizzleMigrations(db, folder);
  ensureRawSyncIndexes(sqlite);
  console.log("Migrations applied successfully.");
  const tables = process.argv.includes("--counts") ? sqlite
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[] : [];
  if (tables.length) console.log("Database tables:");
  for (const t of tables) {
    if (t.name.startsWith("sqlite_") || t.name === "__drizzle_migrations") continue;
    try {
      const countRes = sqlite.query(`SELECT count(*) as c FROM "${t.name}"`).get() as { c: number };
      console.log(`  - ${t.name}: ${countRes.c.toLocaleString()} rows`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  - ${t.name}: (error reading count: ${message})`);
    }
  }
  sqlite.close();
}
/** A test copy must be named explicitly; a stale inherited variable must never silently
 * redirect the CLI away from the database selected in Settings. */
export function migrationCliTarget(
  argv: readonly string[],
  selectedPath?: string,
  inheritedPath = process.env.TOKENATLAS_DB,
): string {
  const args = argv.filter((arg) => arg !== "--counts");
  if (args.length === 2 && args[0] === "--db" && args[1]?.trim() && !args[1].startsWith("--"))
    return resolveDbPath(args[1]);
  if (args.length !== 0) throw new Error("Usage: bun run db:migrate [--db <path>] [--counts]");
  const active = resolveDbPath(selectedPath ?? activeDatabasePath());
  if (inheritedPath?.trim() && resolveDbPath(inheritedPath).toLowerCase() !== active.toLowerCase())
    throw new Error(`TOKENATLAS_DB differs from the database selected in Settings (${active}); use --db <path> explicitly for a copy`);
  return active;
}
if (import.meta.main) {
  const target = migrationCliTarget(process.argv.slice(2));
  const onProgress = (update: StartupUpdate) => {
    console.log(`[tokenAtlas startup] ${JSON.stringify(update)}`);
  };
  runMigrations(target, undefined, onProgress).catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
