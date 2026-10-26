import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "./sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { applyDrizzleMigrations, assertMigrationHistory } from "./migrate";
import { prepareProbeReaderFixture, splitProbeReaderFixtureConfig } from "../server/probe-reader.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { currentSnapshot } from "../server/current/http";
import type { BootstrapSnapshot } from "../web/lib/current-contract";

const ROOT = path.resolve(import.meta.dir, "../../drizzle");
const MIGRATION_COUNT = JSON.parse(fs.readFileSync(path.join(ROOT, "meta/_journal.json"), "utf8")).entries.length;
const CURRENT_SQL = "0021_current_read_models";
const LEGACY_TIME = 1788564706129; // review branch 463b142's divergent 0020, never in master
const PROBE_WINDOWS_TIME = 1787644523760; // journal timestamp of 0009_unify_probe_windows
const dbs: Database[] = [];
const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-lineage-")); dirs.push(dir); return dir;
}
function open(file = ":memory:"): Database {
  const sqlite = new Database(file, { create: true }); dbs.push(sqlite); return sqlite;
}
function journalFolder(count: number, crlf = false): string {
  const dir = temp(); fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, count);
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    const source = fs.readFileSync(path.join(ROOT, `${entry.tag}.sql`), "utf8").replace(/\r\n/g, "\n");
    fs.writeFileSync(path.join(dir, `${entry.tag}.sql`), crlf ? source.replace(/\n/g, "\r\n") : source);
  }
  return dir;
}
function legacyFolder(): string {
  const dir = journalFolder(20);
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.entries.push({ idx: 20, version: "6", when: LEGACY_TIME, tag: "0020_current_read_models", breakpoints: true });
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  fs.copyFileSync(path.join(ROOT, `${CURRENT_SQL}.sql`), path.join(dir, "0020_current_read_models.sql"));
  return dir;
}
const NOW = "2026-09-05T12:00:00.000Z";
const subscriptions = [{ id: "claude1", vendor: "claude", machine: "PC-A", login: "fixture",
  source_home: "C:/Users/fixture/.claude", home: `${ARCHIVE_LOGICAL_ROOT}/claude/PC-A-fixture` }];
const accounts = splitProbeReaderFixtureConfig(subscriptions);
function seed(sqlite: Database): void {
  sqlite.exec(`INSERT INTO claude_events (store,call_id,ts,path,subscription_id,in_uncached,out_total)
    VALUES ('local','1','2026-09-05T11:00:00.000Z','archive/claude/session.jsonl','claude1',100,20);
    INSERT INTO probe_windows (provider,subject,ts,kind,used_percent,reported_percent_side,resets_at,machine,profile,extra)
    VALUES ('claude','claude1','2026-09-05T11:59:00.000Z','weekly',42,'used','2026-09-06T12:00:00.000Z','PC-A',
      'fixture','{"home":"C:/Users/fixture/.claude"}');`);
}
function raw(sqlite: Database) {
  // Retain all probe fields; later nullable Claude columns (0065, 0092) read NULL before their migrations.
  const probes=(sqlite.query("SELECT * FROM probe_windows").all() as Array<Record<string,unknown>>)
    .map(({era_unattributed:_retired,...row})=>row);
  return [sqlite.query("SELECT * FROM claude_events").all().map(row=>({account_key:null,resp_ms:null,billing_mode:null,...row as object})),probes];
}
function snapshot(sqlite: Database): BootstrapSnapshot {
  return currentSnapshot({ sqlite, accounts }, NOW) as BootstrapSnapshot;
}
afterEach(() => {
  dbs.splice(0).forEach(db => db.close(true));
  dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("canonical migration lineage and current/history coexistence", () => {
  test("empty database gets both read models, and rerun writes no migration or fact", () => {
    const sqlite = open(); const db = drizzle(sqlite);
    applyDrizzleMigrations(db);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: MIGRATION_COUNT });
    // The summary tables and their coverage are gone: the ledgers carry every sum (0054).
    expect(sqlite.query(`SELECT name FROM sqlite_master WHERE name IN ('usage_daily_rollups','project_daily_rollups',
      'hourly_activity_rollups','codex_cycle_rollups','subscription_usage_daily','rollup_coverage')`).all()).toEqual([]);
    expect(snapshot(sqlite).status).toBe("initializing");
    const changes = sqlite.query("SELECT total_changes() AS n").get();
    applyDrizzleMigrations(db);
    expect(sqlite.query("SELECT total_changes() AS n").get()).toEqual(changes);
  });

  test("populated 0019 upgrades through both migrations without rewriting source facts", () => {
    const sqlite = open(); const db = drizzle(sqlite);
    applyDrizzleMigrations(db, journalFolder(20)); seed(sqlite);
    const before = raw(sqlite);
    applyDrizzleMigrations(db);
    expect(raw(sqlite)).toEqual(before);
    expect(snapshot(sqlite).data.subscriptions[0]?.limits).toEqual([]);
    prepareProbeReaderFixture(sqlite, subscriptions);
    expect(snapshot(sqlite).data.subscriptions[0]?.limits[0]?.used_percent).toBe(42);
    expect(raw(sqlite)).toEqual(before);
  });

  test("deployed master 0020 upgrades without rewriting source facts; its summary tables are retired", () => {
    const sqlite = open(); const db = drizzle(sqlite);
    applyDrizzleMigrations(db, journalFolder(21)); seed(sqlite);
    const revisions = sqlite.query("SELECT * FROM sync_revisions").all();
    const before = raw(sqlite);
    applyDrizzleMigrations(db);
    prepareProbeReaderFixture(sqlite, subscriptions);
    expect(raw(sqlite)).toEqual(before);
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name IN ('subscription_usage_daily','rollup_coverage')").all()).toEqual([]);
    expect(sqlite.query("SELECT * FROM sync_revisions").all()).toEqual(revisions);
    expect(snapshot(sqlite).data.subscriptions[0]?.limits[0]?.used_percent).toBe(42);
  });

  test("legacy divergent review 0020 is refused before any DDL or row change", () => {
    const file = path.join(temp(), "legacy.sqlite"); const sqlite = open(file); const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: legacyFolder() }); seed(sqlite);
    // The rejected database predates the current writer's source journal and periods.
    sqlite.query("INSERT INTO current_probe_subjects(provider,subject,data,generated_at) VALUES('claude','claude1',?,?)")
      .run(JSON.stringify({ limits: [{ kind: "weekly", used_percent: 42 }] }), NOW);
    expect(snapshot(sqlite).status).toBe("initializing");
    const before = fs.readFileSync(file);
    const schemas = sqlite.query("SELECT * FROM sqlite_master").all();
    const log = sqlite.query("SELECT * FROM __drizzle_migrations").all();
    expect(() => applyDrizzleMigrations(db)).toThrow("Migration history mismatch");
    expect(sqlite.query("SELECT * FROM sqlite_master").all()).toEqual(schemas);
    expect(sqlite.query("SELECT * FROM __drizzle_migrations").all()).toEqual(log);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  test("direct server context also refuses divergent history before recovery/configuration work", async () => {
    const file = path.join(temp(), "legacy-server.sqlite"); const sqlite = open(file);
    migrate(drizzle(sqlite), { migrationsFolder: legacyFolder() }); seed(sqlite);
    const before = raw(sqlite);
    const configRoot = path.join(temp(), "valid-config"); fs.mkdirSync(configRoot);
    fs.writeFileSync(path.join(configRoot, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
    sqlite.close(true);
    dbs.splice(dbs.indexOf(sqlite), 1);
    const apiUrl = pathToFileURL(path.resolve(import.meta.dir, "../server/api.ts")).href;
    const script = `import { createAppContext } from ${JSON.stringify(apiUrl)}; createAppContext(${JSON.stringify(file)});`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, TOKENATLAS_CONFIG: configRoot }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, stdout + stderr).not.toBe(0);
    expect(stdout + stderr).toContain("Migration history mismatch");
    const reopened = open(file);
    expect(raw(reopened)).toEqual(before);
  });

  test("historical Windows CRLF migration hashes upgrade to the canonical LF chain", () => {
    const sqlite = open(); const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: journalFolder(21, true) }); seed(sqlite);
    const before = raw(sqlite);
    applyDrizzleMigrations(db);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: MIGRATION_COUNT });
    expect(raw(sqlite)).toEqual(before);
  });

  test("0009's comment-only rewrite keeps already-migrated databases on the canonical lineage", () => {
    const sqlite = open(); const db = drizzle(sqlite);
    applyDrizzleMigrations(db, journalFolder(22)); seed(sqlite);
    const before = raw(sqlite);
    // Hash of 0009 as it read before d970e7d moved its parity-guard comment.
    sqlite.exec(`UPDATE __drizzle_migrations
      SET hash = 'bb9719f12d18c59772f4b440488d241ab47df86da3eaf2378dc16c84aa354c26'
      WHERE created_at = ${PROBE_WINDOWS_TIME}`);
    applyDrizzleMigrations(db);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: MIGRATION_COUNT });
    expect(raw(sqlite)).toEqual(before);
    sqlite.exec(`UPDATE __drizzle_migrations SET hash = 'other' WHERE created_at = ${PROBE_WINDOWS_TIME}`);
    expect(() => applyDrizzleMigrations(db)).toThrow("Migration history mismatch");
  });

  test("the shortened current-projection header preserves both published migration hashes", () => {
    const sqlite = open(); const db = drizzle(sqlite);
    applyDrizzleMigrations(db); seed(sqlite);
    const before = raw(sqlite);
    for (const hash of [
      "5aad1ae4ca840a7a26fb0ed2f50fb732772fadba5da5a87b63d227f39c53bd6e",
      "32bf52cc5be8768647c583c5c03b42818720bbc6d08fc3192cebf6b5ab2ff3b5",
    ]) {
      sqlite.query("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?").run(hash, 1788591000000);
      const changes = sqlite.query("SELECT total_changes() AS n").get();
      expect(() => assertMigrationHistory(db)).not.toThrow();
      expect(sqlite.query("SELECT total_changes() AS n").get()).toEqual(changes);
      expect(raw(sqlite)).toEqual(before);
    }
  });

  test("edited SQL, omitted intermediate migrations and future histories are not silently skipped", () => {
    for (const mutation of [
      "UPDATE __drizzle_migrations SET hash = 'changed' WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)",
      "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT MIN(created_at) FROM __drizzle_migrations)",
      "INSERT INTO __drizzle_migrations(hash,created_at) VALUES ('future',9999999999999)",
    ]) {
      const sqlite = open(); const db = drizzle(sqlite); applyDrizzleMigrations(db);
      sqlite.exec(mutation);
      const before = sqlite.query("SELECT total_changes() AS n").get();
      expect(() => applyDrizzleMigrations(db)).toThrow("Migration history mismatch");
      expect(sqlite.query("SELECT total_changes() AS n").get()).toEqual(before);
    }
  });

  test("failed current migration rolls back all its DDL and backfill; a clean retry succeeds", () => {
    const sqlite = open(); const db = drizzle(sqlite);
    applyDrizzleMigrations(db, journalFolder(21)); seed(sqlite);
    const before = raw(sqlite); const daily = sqlite.query("SELECT * FROM subscription_usage_daily").all();
    const broken = journalFolder(22);
    fs.appendFileSync(path.join(broken, `${CURRENT_SQL}.sql`), "\n--> statement-breakpoint\nSELECT * FROM deliberately_missing_table;\n");
    expect(() => applyDrizzleMigrations(db, broken)).toThrow();
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name='current_projection_state'").get()).toBeNull();
    expect(sqlite.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 21 });
    expect(raw(sqlite)).toEqual(before);
    expect(sqlite.query("SELECT * FROM subscription_usage_daily").all()).toEqual(daily);
    applyDrizzleMigrations(db);
    prepareProbeReaderFixture(sqlite, subscriptions);
    expect(snapshot(sqlite).data.subscriptions[0]?.limits[0]?.used_percent).toBe(42);
  });

  test("metadata retains master's immutable 0020 and links the union snapshot as 0021", () => {
    // Golden hash from master@69b1510; line endings are normalized for portability.
    const text = fs.readFileSync(path.join(ROOT, "0020_subscription_usage_daily.sql"), "utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(text).digest("hex")).toBe("74ad0fbc95545c908c3860e15d49e75b574361f6581da29fb7d50ccd4212cb6d");
    const previous = JSON.parse(fs.readFileSync(path.join(ROOT, "meta/0020_snapshot.json"), "utf8"));
    const next = JSON.parse(fs.readFileSync(path.join(ROOT, "meta/0021_snapshot.json"), "utf8"));
    expect(next.prevId).toBe(previous.id);
    expect(next.tables.subscription_usage_daily).toEqual(previous.tables.subscription_usage_daily);
    expect(next.tables.current_projection_state).toBeDefined();
    expect(next.tables.subscription_current).toBeDefined();
  });
});

test("populated 0021 upgrades without rewriting facts or inventing historical outbox entries", () => {
  const sqlite = open(); const db = drizzle(sqlite);
  applyDrizzleMigrations(db, journalFolder(22)); seed(sqlite);
  const before = raw(sqlite);
  const projection = sqlite.query("SELECT * FROM current_projection_state").all();
  applyDrizzleMigrations(db);
  expect(raw(sqlite)).toEqual(before);
  expect(sqlite.query("SELECT * FROM current_projection_state").all()).toEqual(projection);
  expect(sqlite.query("SELECT count(*) AS n FROM gauge_journal_outbox").get()).toEqual({ n: 0 });
  expect(sqlite.query("SELECT count(*) AS n FROM gauge_journal_receipts").get()).toEqual({ n: 0 });
});

test("failed 0022 DDL rolls back the entire migration and can be retried", () => {
  const sqlite = open(); const db = drizzle(sqlite);
  applyDrizzleMigrations(db, journalFolder(22)); seed(sqlite);
  const before = raw(sqlite);
  const broken = journalFolder(23);
  fs.appendFileSync(path.join(broken, "0022_durable_gauge_journal.sql"), "\n--> statement-breakpoint\nSELECT * FROM deliberately_missing_table;\n");
  expect(() => applyDrizzleMigrations(db, broken)).toThrow();
  expect(sqlite.query("SELECT name FROM sqlite_master WHERE name LIKE 'gauge_journal_%'").all()).toEqual([]);
  expect(sqlite.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 22 });
  expect(raw(sqlite)).toEqual(before);
  applyDrizzleMigrations(db);
  expect(sqlite.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: MIGRATION_COUNT });
});
