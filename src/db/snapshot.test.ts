import { createDataRead, storedAnswerConfiguration } from "../server/data-read";
import type { AppContext } from "../server/api";
import { cacheKey } from "../server/cache";
import { ensureWindowAnswersSchema, markWindowAnswersDirty, readWindowAnswer, storeWindowAnswers, windowAnswerIsCurrent } from "./window-answers";
import { pathToFileURL } from "node:url";
import { ledgerRevision } from "./ledger-revision";
import { createProbeCollection, acceptProbeFact, mapProbeLegacy, backfillProbeFacts } from "./probe-facts";
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";

// These integration cases migrate and copy databases and start backup/catch-up processes.
setDefaultTimeout(30_000);
import { Database } from "./sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncCoordinator } from "../sync/coordinator";
import { probeFactsDigest, validateProbeFacts } from "./probe-facts";
import { configureGaugeJournal } from "../providers/core/journal";
import { persistProbeWindows } from "../providers/core/probe";
import probeFixture from "../../test-fixtures/probe-facts-v1.json";
import type { WindowReading } from "../providers/types";
import { ingestGaugesAsync } from "../ingest/gauges";
import { USAGE_VENDOR_IDS, type UsageVendorId } from "../sync/contracts";
import type { VendorAdapters } from "../sync/adapters";
import {
  AtlasBootstrapCrashSimulation,
  bootstrapAtlasIndex,
  finishAtlasBootstrapRecovery,
  localAtlasIndexUsable,
  pendingAtlasBootstrapRecovery,
  pendingAtlasBootstrapVendors,
  type AtlasBootstrapFailpoints,
} from "./bootstrap";
import { applyDrizzleMigrations, snapshotBeforePendingMigrations } from "./migrate";
import { ARCHIVE_PATH_COLUMNS } from "./rebase";
import { writeRebuildStatusJson } from "./rebuild-status";
import * as schema from "./schema";
import {
  ATLAS_SNAPSHOT_DATABASE_SUFFIX,
  ATLAS_SNAPSHOT_BARRIER_SUFFIX,
  ATLAS_SNAPSHOT_MANIFEST_SUFFIX,
  ATLAS_SNAPSHOT_PUBLICATION_LEASE,
  currentAtlasSchemaVersion,
  discoverAtlasSnapshotCandidates,
  discoverNewestValidAtlasSnapshot,
  publishAtlasSnapshot,
  validateAtlasSnapshotCandidate,
  type AtlasIndexSnapshotManifest,
  type PublishAtlasSnapshotOptions,
} from "./snapshot";

const tempDirectories: string[] = [];
const fixtureConnections = new Set<Database>();

function openFixtureDatabase(...args: ConstructorParameters<typeof Database>): Database {
  const sqlite = new Database(...args);
  fixtureConnections.add(sqlite);
  return sqlite;
}
const FIXTURE_SCHEMA_VERSION = currentAtlasSchemaVersion() + 1;
test("schema24 snapshot retains canonical multiplicity, provenance and pending source work with internal integrity checks", async () => {
  const root = tempDirectory(), dbPath = path.join(root, "producer.sqlite"), archiveRoot = path.join(root, "archive"), poolPath = path.join(root, "pool");
  createAtlasFixture(dbPath, archiveRoot);
  const db = openFixtureDatabase(dbPath);
  try {
    configureGaugeJournal(path.join(archiveRoot, "gauges", "producer"));
    persistProbeWindows(db, "codex", "codex1", probeFixture.ts, [probeFixture.reading, probeFixture.reading] as WindowReading[]);
    const before = probeFactsDigest(db), ids = db.query("SELECT id FROM probe_counters ORDER BY id").all();
    const pending = db.query("SELECT * FROM gauge_journal_outbox").all(); expect(pending).toHaveLength(2);
    const snapshot = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "manual" }); expect(snapshot.status).toBe("created");
    expect(probeFactsDigest(db)).toBe(before); expect(db.query("SELECT * FROM gauge_journal_outbox").all()).toEqual(pending);
    const copy = openFixtureDatabase(snapshot.databasePath!);
    validateProbeFacts(copy); expect(probeFactsDigest(copy)).toBe(before);
    expect(copy.query("SELECT id FROM probe_counters ORDER BY id").all()).toEqual(ids);
    expect(copy.query("SELECT count(*) n FROM gauge_journal_outbox").get()).toEqual({ n: 0 });
    const recipientPath = path.join(root, "recipient.sqlite");
    copy.exec(`VACUUM INTO '${recipientPath.replaceAll("'", "''")}'`);
    const journalDir = path.join(archiveRoot, "gauges", "producer"); fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, "probe_windows.jsonl"), pending.map(r => (r as { payload: string }).payload).join("\n") + "\n");
    (await ingestGaugesAsync({ atlasPath: recipientPath, archiveRoot, ownStore: "recipient", force: true }));
    const recipient = openFixtureDatabase(recipientPath);
    expect(recipient.query("SELECT id FROM probe_counters ORDER BY id").all()).toEqual(ids);
    expect(recipient.query("SELECT DISTINCT json_extract(evidence,'$.role') AS role FROM probe_fact_deliveries WHERE json_extract(evidence,'$.role') IS NOT NULL ORDER BY role").all()).toEqual([{ role: "producer" }, { role: "receiver" }]);
    recipient.close(true); fixtureConnections.delete(recipient);
    // The pre-canonical reader supports schema 23; this contract must not require private Git objects.
    const oldReader = validateAtlasSnapshotCandidate(snapshot.manifestPath!, { currentSchemaVersion: 23 });
    expect(oldReader).toMatchObject({ valid: false, compatible: false });
    expect(oldReader.errors).toContain("snapshot schema is not compatible with this application");
    copy.exec("DROP TRIGGER probe_counters_no_update");
    copy.exec("UPDATE probe_counters SET payload=json_set(payload,'$.used_percent',999)");
    const manifest = JSON.parse(fs.readFileSync(snapshot.manifestPath!, "utf8"));
    expect(() => validateProbeFacts(copy)).toThrow("Canonical probe integrity");
    manifest.probeFactsDigest = probeFactsDigest(copy); copy.close(true); fixtureConnections.delete(copy);
    manifest.sizeBytes = fs.statSync(snapshot.databasePath!).size;
    manifest.checksum.value = createHash("sha256").update(fs.readFileSync(snapshot.databasePath!)).digest("hex");
    manifest.identityFingerprint = createHash("sha256").update(JSON.stringify({ schemaVersion: manifest.schemaVersion, registryDigest: manifest.registryDigest, probeFactsDigest: manifest.probeFactsDigest, bindingsDigest: manifest.bindingsDigest, revisions: manifest.revisions, vendors: USAGE_VENDOR_IDS.map(vendor => ({ vendor, revision: manifest.vendorDataRevisions[vendor], rows: manifest.vendorRowCounts[vendor] })), sourceArchiveRoot: path.normalize(manifest.sourceArchiveRoot).replaceAll("\\", "/") })).digest("hex");
    fs.writeFileSync(snapshot.manifestPath!, JSON.stringify(manifest));
    const invalid = validateAtlasSnapshotCandidate(snapshot.manifestPath!); expect(invalid.valid).toBe(false);
    expect(invalid.errors.some(e => e.includes("checksum") || e.includes("digest") || e.includes("identity does"))).toBe(false);
  } finally { configureGaugeJournal(null); db.close(true); }
});
test("new reader accepts schema22 snapshot then expands only the imported copy", () => {
  const root=tempDirectory(), migrations=path.join(root,"old-migrations");fs.mkdirSync(path.join(migrations,"meta"),{recursive:true});
  const journal=JSON.parse(fs.readFileSync("drizzle/meta/_journal.json","utf8"));journal.entries=journal.entries.filter((e:any)=>e.idx<=22);
  fs.writeFileSync(path.join(migrations,"meta/_journal.json"),JSON.stringify(journal));
  for(const entry of journal.entries)fs.copyFileSync("drizzle/"+entry.tag+".sql",path.join(migrations,entry.tag+".sql"));
  const file=path.join(root,"old.sqlite"),archiveRoot=path.join(root,"archive");createAtlasFixture(file,archiveRoot,migrations);
  const published=publishAtlasSnapshot({dbPath:file,archiveRoot,poolPath:path.join(root,"pool"),mode:"manual"});
  expect(published.manifest!.schemaVersion).toBe(22);expect(published.manifest!.registryDigest).toBeUndefined();
  expect(validateAtlasSnapshotCandidate(published.manifestPath!).valid).toBe(true);
  const from=openFixtureDatabase(published.databasePath!,{readonly:true}),recipient=path.join(root,"recipient.sqlite");
  from.exec(`VACUUM INTO '${recipient.replaceAll("'","''")}'`);
  const db=openFixtureDatabase(recipient);const before=historicalValues(db);applyDrizzleMigrations(drizzle(db));
  expect(historicalValues(db)).toEqual(before);
  expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('source_machines','account_observations')").all()).toEqual([]);
  expect(from.query("SELECT COUNT(*) n FROM account_observations").get()).toEqual({n:1});
});


afterEach(() => {
  const errors: unknown[] = [];
  for (const sqlite of fixtureConnections) {
    try { sqlite.close(true); } catch (error) { errors.push(error); }
  }
  fixtureConnections.clear();
  for (const directory of tempDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors,
    `Snapshot fixture cleanup failed: ${errors.map((error) => String(error)).join("; ")}`);
});

function retainedPrepareObserver() {
  const statements: Array<ReturnType<Database["prepare"]>> = [];
  const original = Database.prototype.prepare;
  const spy = spyOn(Database.prototype, "prepare").mockImplementation((function (
    this: Database, ...args: Parameters<Database["prepare"]>
  ) {
    const statement = Reflect.apply(original, this, args);
    // Strong references intentionally prevent GC from hiding an unfinalized handle.
    statements.push(statement);
    return statement;
  }) as Database["prepare"]);
  return {
    assertClosed() {
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter((statement) => statement.toString() !== "")).toEqual([]);
    },
    restore() {
      spy.mockRestore();
      for (const statement of statements) statement.finalize();
    },
  };
}

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-"));
  tempDirectories.push(directory);
  return directory;
}

function createCoreTables(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE files (home TEXT, path TEXT, size INTEGER, mtime REAL, events INTEGER, PRIMARY KEY (home, path));
    CREATE TABLE events (
      home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT, model TEXT, effort TEXT,
      project TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
      reasoning_out INTEGER, cwd TEXT, project_id TEXT, source_offset INTEGER
    );
    CREATE TABLE ratelimit (
      home TEXT, path TEXT, ts TEXT, window_minutes INTEGER, used_percent REAL,
      resets_at INTEGER, plan_type TEXT, limit_id TEXT, limit_name TEXT
    );
  `);
}

function createAtlasFixture(dbPath: string, archiveRoot: string, migrationsFolder?: string): void {
  const sqlite = openFixtureDatabase(dbPath, { create: true });
  try {
    // Keep fixture durability, but commit setup in batches rather than per statement.
    sqlite.transaction(() => createCoreTables(sqlite))();
    applyDrizzleMigrations(drizzle(sqlite, { schema }), migrationsFolder);
    sqlite.transaction(() => {
      const paths = {
        codexHome: path.join(archiveRoot, "codex", "machine-user"),
        codexFile: path.join(archiveRoot, "codex", "machine-user", "sessions", "rollout.jsonl"),
        claude: path.join(archiveRoot, "claude", "machine", "project.jsonl"),
        grok: path.join(archiveRoot, "grok", "machine-user", "session.json"),
        gemini: path.join(archiveRoot, "gemini", "machine-user", "conversation.pb"),
      };
      sqlite.run("INSERT INTO meta VALUES ('schema', '3')");
      sqlite.run("INSERT INTO meta VALUES ('opencode_snapshot:machine', ?)", [
        JSON.stringify({ path: path.join(archiveRoot, "opencode", "machine", "opencode.sqlite"), size: 1, mtime: 2 }),
      ]);
      sqlite.run("INSERT INTO meta VALUES ('sync_source_fingerprint:codex', 'source-pc-fingerprint')");
      sqlite.run(
        "INSERT INTO events (home,path,ts,project,cwd,in_tok,cached_in,cache_write,out_tok,reasoning_out) VALUES (?,?,?,?,?,1,0,0,1,0)",
        [paths.codexHome, paths.codexFile, "2026-08-01T00:00:00.000Z", "historical-codex-project", "C:\\work\\codex-repo"],
      );
      sqlite.run("INSERT INTO files VALUES (?,?,?,?,?)", [paths.codexHome, paths.codexFile, 10, 1, 1]);
      sqlite.run("INSERT INTO ratelimit (home,path,ts) VALUES (?,?,?)", [paths.codexHome, paths.codexFile, "2026-08-01T00:00:00.000Z"]);
      if (sqlite.query("SELECT 1 FROM sqlite_master WHERE name='account_periods'").get()) {
        sqlite.run(`INSERT INTO account_periods(provider,source,from_ts,account,origin,first_seen,last_seen,readings,evidence)
          VALUES ('codex','codex/machine-user','2026-08-01T00:00:00.000Z','codex-seat','observed',
          '2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',1,?)`,
          [JSON.stringify({raw_source:"C:\\Users\\source-pc\\.codex\\auth.json"})]);
      } else {
        // Historical schema22 snapshot: this retired derived table exists only in the old producer.
        sqlite.run("INSERT INTO account_observations (ts,vendor,source,identity_kind,identity,raw_source) VALUES (?,'codex',?,'email','codex@example.test',?)",
          ["2026-08-01T00:00:00.000Z",paths.codexHome,"C:\\Users\\source-pc\\.codex\\auth.json"]);
      }
      sqlite.run(
        "INSERT INTO claude_events (store,call_id,ts,project,cwd,path) VALUES ('machine','call-1',?,?,?,?)",
        ["2026-08-01T00:00:00.000Z", "historical-claude-project", "C:\\work\\claude-repo", paths.claude],
      );
      sqlite.run("INSERT INTO claude_files (store,path,size,mtime,calls,ingested_at) VALUES ('machine',?,10,1,1,?)", [paths.claude, "2026-08-01T00:00:00.000Z"]);
      sqlite.run(
        "INSERT INTO oc_events (store,message_id,ts,project,directory) VALUES ('machine','message-1',?,?,?)",
        ["2026-08-01T00:00:00.000Z", "historical-opencode-project", "C:\\work\\opencode-repo"],
      );
      sqlite.run(
        "INSERT INTO grok_events (store,session_id,prompt_id,ts,cwd,project,path) VALUES ('machine','session-1','prompt-1',?,?,?,?)",
        ["2026-08-01T00:00:00.000Z", "C:\\work\\grok-repo", "historical-grok-project", paths.grok],
      );
      sqlite.run("INSERT INTO grok_files (store,path,size,mtime,turns,ingested_at) VALUES ('machine',?,10,1,1,?)", [paths.grok, "2026-08-01T00:00:00.000Z"]);
      sqlite.run(
        "INSERT INTO gemini_events (store,conversation_id,gen_idx,ts,ts_basis,workspace,path) VALUES ('machine','conversation-1',0,?,?,?,?)",
        ["2026-08-01T00:00:00.000Z", "event", "C:\\work\\gemini-repo", paths.gemini],
      );
      sqlite.run("INSERT INTO gemini_files VALUES ('machine',?,10,1,1,?)", [paths.gemini, "2026-08-01T00:00:00.000Z"]);
      sqlite.run("UPDATE sync_revisions SET data_revision=1, config_revision=2, updated_at=? WHERE id=1", ["2026-08-01T00:00:00.000Z"]);
      for (const [index, vendor] of USAGE_VENDOR_IDS.entries()) {
        sqlite.run("INSERT INTO vendor_sync_revisions VALUES (?,?,?)", [vendor, index + 1, "2026-08-01T00:00:00.000Z"]);
      }
    })();
  } finally {
    sqlite.close(true);
  }
}

function advanceFixture(dbPath: string, revision: number): void {
  const sqlite = openFixtureDatabase(dbPath);
  sqlite.run("UPDATE sync_revisions SET data_revision=?, updated_at=? WHERE id=1", [revision, `2026-08-0${revision}T00:00:00.000Z`]);
  sqlite.run("UPDATE vendor_sync_revisions SET data_revision=data_revision+1, updated_at=?", [`2026-08-0${revision}T00:00:00.000Z`]);
  sqlite.run(
    "INSERT INTO events (home,path,ts,project,cwd,in_tok,cached_in,cache_write,out_tok,reasoning_out) SELECT home,path,?,project,cwd,1,0,0,1,0 FROM events LIMIT 1",
    [`2026-08-0${revision}T00:00:00.000Z`],
  );
  sqlite.close(true);
}

function historicalValues(sqlite: Database): Record<string, unknown> {
  return {
    events: sqlite.query("SELECT cwd, project FROM events ORDER BY rowid LIMIT 1").get(),
    claude: sqlite.query("SELECT cwd, project FROM claude_events LIMIT 1").get(),
    opencode: sqlite.query("SELECT directory, project FROM oc_events LIMIT 1").get(),
    grok: sqlite.query("SELECT cwd, project FROM grok_events LIMIT 1").get(),
    gemini: sqlite.query("SELECT workspace FROM gemini_events LIMIT 1").get(),
  };
}

function fixtureMigrations(directory: string): string {
  const target = path.join(directory, "migrations");
  fs.cpSync(path.resolve(import.meta.dir, "../../drizzle"), target, { recursive: true });
  const journalPath = path.join(target, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  // One migration past the real journal, whatever its current length.
  const tag = `${String(FIXTURE_SCHEMA_VERSION).padStart(4, "0")}_bootstrap_fixture`;
  journal.entries.push({
    idx: FIXTURE_SCHEMA_VERSION,
    version: "6",
    when: (journal.entries.at(-1)?.when ?? 0) + 1,
    tag,
    breakpoints: true,
  });
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  fs.writeFileSync(path.join(target, `${tag}.sql`), "CREATE TABLE bootstrap_fixture (value TEXT);\n");
  return target;
}

function noChangeAdapters(): VendorAdapters {
  const adapter = async () => ({
    processedInputs: 0,
    skippedInputs: 1,
    writtenRows: 0,
    dirtyRange: null,
    diagnostics: {},
    validationErrors: [],
  });
  return {
    codex: adapter,
    claude: adapter,
    opencode: adapter,
    grok: adapter,
    gemini: adapter,
    gauges: adapter,
  };
}

function codexWriteAdapters(): VendorAdapters {
  return {
    ...noChangeAdapters(),
    codex: async ({ stageDbPath }) => {
      const sqlite = openFixtureDatabase(stageDbPath);
      try {
        sqlite.run(
          `INSERT INTO events
             (home,path,ts,surface,nested,model,effort,project,in_tok,cached_in,cache_write,out_tok,reasoning_out,cwd,project_id)
           VALUES ('fixture-home','fixture.jsonl','2026-08-31T00:00:00.000Z','cli','0','gpt-test','high','fixture',1,0,0,1,0,'C:\\work','fixture')`,
        );
        sqlite.run("INSERT INTO files (home,path,size,mtime,events) VALUES ('fixture-home','fixture.jsonl',10,1,1)");
        sqlite.run(
          "INSERT INTO ratelimit (home,path,ts,window_minutes,used_percent) VALUES ('fixture-home','fixture.jsonl','2026-08-31T00:00:00.000Z',300,1)",
        );
      } finally {
        sqlite.close(true);
      }
      return {
        processedInputs: 1,
        skippedInputs: 0,
        writtenRows: 3,
        dirtyRange: { from: "2026-08-31T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z" },
        diagnostics: {},
        validationErrors: [],
      };
    },
  };
}

async function runCatchUp(dbPath: string, mode: "incremental" | "full"): Promise<void> {
  const coordinator = new SyncCoordinator({ archiveInputs: () => undefined,
    dbPath,
    rootDir: path.resolve(import.meta.dir, "../.."),
    adapters: noChangeAdapters(),
    mirror: async () => ({ copied: 0, skipped: 1, warnings: [], errors: [] }),
    configFingerprint: () => "fixture-config",
    sourceFingerprint: (vendor: string) => `fixture-${vendor}`,
    prepareStage: () => undefined,
    refreshDerived: () => undefined,
  });
  try {
    const run = await coordinator.enter({ trigger: "auto", mode, scope: { kind: "all" } }).completion;
    expect(run.status).toBe("success");
    expect(run.mode).toBe(mode);
  } finally {
    coordinator.close();
  }
}

async function runFullCodexPublication(dbPath: string): Promise<void> {
  const coordinator = new SyncCoordinator({ archiveInputs: () => undefined,
    dbPath,
    rootDir: path.resolve(import.meta.dir, "../.."),
    adapters: codexWriteAdapters(),
    mirror: async () => ({ copied: 1, skipped: 0, warnings: [], errors: [] }),
    configFingerprint: () => "fixture-config",
    sourceFingerprint: () => "fixture-codex-write",
    prepareStage: () => undefined,
  });
  try {
    const run = await coordinator.enter({
      trigger: "auto",
      mode: "full",
      scope: { kind: "vendor", vendor: "codex" },
    }).completion;
    expect(run.status).toBe("success");
    expect(run.vendors[0]).toMatchObject({ status: "success", writtenRows: 3, dataChanged: true });
  } finally {
    coordinator.close();
  }
}

describe("Atlas index snapshots", () => {
  test("reuses the logical snapshot identity at rest and creates after a data revision change", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    createAtlasFixture(dbPath, archiveRoot);

    const first = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-08-28T10:00:00Z"),
    });
    const unchanged = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-08-28T11:00:00Z"),
    });
    expect(unchanged).toMatchObject({
      status: "reused",
      reason: "identical-snapshot",
      snapshotId: first.snapshotId,
    });

    advanceFixture(dbPath, 2);
    const advanced = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-08-28T12:00:00Z"),
    });
    expect(advanced.status).toBe("created");
    expect(advanced.snapshotId).not.toBe(first.snapshotId);
  });

  test("a pending migration forces a fresh verified copy where ordinary publication reuses", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    createAtlasFixture(dbPath, archiveRoot);
    const publishToPool = (options: PublishAtlasSnapshotOptions) =>
      publishAtlasSnapshot({ ...options, archiveRoot, poolPath });

    const first = publishToPool({ dbPath, mode: "manual", now: new Date("2026-08-28T10:00:00Z") });
    expect(first.status).toBe("created");
    const automatic = publishToPool({ dbPath, mode: "automatic", requireFreshCopy: true, now: new Date("2026-08-28T11:00:00Z") });
    expect(automatic.status).toBe("created");
    expect(automatic.snapshotId).not.toBe(first.snapshotId);

    const fresh = snapshotBeforePendingMigrations(dbPath, {
      migrationsFolder: fixtureMigrations(root),
      targetSchemaVersion: FIXTURE_SCHEMA_VERSION,
      publish: publishToPool,
    });
    expect(fresh).toMatchObject({ status: "created", reason: null, leaseLostAfterCommit: false });
    expect(fresh!.snapshotId).not.toBe(automatic.snapshotId);
    expect(fresh!.manifest!.schemaVersion).toBe(FIXTURE_SCHEMA_VERSION - 1);
    expect(validateAtlasSnapshotCandidate(fresh!.manifestPath!, { currentSchemaVersion: FIXTURE_SCHEMA_VERSION }))
      .toMatchObject({ valid: true, compatible: true, errors: [] });

    // Ordinary manual and automatic semantics are unchanged.
    expect(publishToPool({ dbPath, mode: "manual", now: new Date("2026-08-28T12:00:00Z") }))
      .toMatchObject({ status: "reused", reason: "identical-snapshot", snapshotId: fresh!.snapshotId });
    expect(publishToPool({ dbPath, mode: "automatic", now: new Date("2026-08-29T12:00:00Z") }))
      .toMatchObject({ status: "skipped", reason: "unchanged-data", snapshotId: fresh!.snapshotId });
  });

  test("reuses a valid legacy-fingerprint manifest through its current logical identity", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    createAtlasFixture(dbPath, archiveRoot);
    const first = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-08-28T10:00:00Z"),
    });
    const legacyManifest = structuredClone(first.manifest!);
    const vendors = USAGE_VENDOR_IDS.map((vendor) => ({
      vendor,
      revision: legacyManifest.vendorDataRevisions[vendor],
      rows: legacyManifest.vendorRowCounts[vendor],
    }));
    legacyManifest.identityFingerprint = createHash("sha256")
      .update(JSON.stringify({
        schemaVersion: legacyManifest.schemaVersion,
        revisions: legacyManifest.revisions,
        vendors,
        sourceArchiveRoot: path.normalize(legacyManifest.sourceArchiveRoot).replaceAll("\\", "/"),
        sizeBytes: legacyManifest.sizeBytes,
        checksum: legacyManifest.checksum.value,
      }))
      .digest("hex");
    fs.writeFileSync(first.manifestPath!, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    expect(validateAtlasSnapshotCandidate(first.manifestPath!).valid).toBe(true);

    const reused = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-08-28T11:00:00Z"),
    });
    expect(reused).toMatchObject({
      status: "reused",
      reason: "identical-snapshot",
      snapshotId: first.snapshotId,
    });
    expect(discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid)).toHaveLength(1);
  });

  test("discovers the newest structurally valid pool snapshot without exposing paths", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    createAtlasFixture(dbPath, archiveRoot);
    const published = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-08-28T10:00:00Z"),
    });
    fs.writeFileSync(path.join(poolPath, `newer-invalid${ATLAS_SNAPSHOT_MANIFEST_SUFFIX}`), "{}");

    const discovered = discoverNewestValidAtlasSnapshot(poolPath, {
      now: new Date("2026-08-28T10:01:30Z"),
    });
    expect(discovered).toEqual({
      id: published.snapshotId!,
      created_at: "2026-08-28T10:00:00.000Z",
      age_seconds: 90,
      revisions: { data: 1, config: 2, derived: expect.any(Number) },
      vendor_revisions: { codex: 1, claude: 2, opencode: 3, grok: 4, gemini: 5 },
      compatible: true,
      validation: "manifest-only",
    });
    expect(JSON.stringify(discovered)).not.toContain(path.resolve(archiveRoot));
    expect(discoverNewestValidAtlasSnapshot(poolPath, {
      currentSchemaVersion: published.manifest!.schemaVersion - 1,
    })?.compatible).toBe(false);
  });

  test("publishes immutable validated manifests, enforces daily/changed gates, and retains one", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive-a");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    createAtlasFixture(dbPath, archiveRoot);

    const first = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, sourceMachine: "pc-a", mode: "manual", now: new Date("2026-08-28T10:00:00Z") });
    expect(first.status).toBe("created");
    expect(first.validation?.valid).toBe(true);
    expect(first.manifest).toMatchObject({
      kind: "tokenatlas-index",
      sourceArchiveRoot: path.resolve(archiveRoot),
      sourceMachine: "pc-a",
      revisions: { data: 1, config: 2, derived: expect.any(Number) },
      vendorRowCounts: { codex: 1, claude: 1, opencode: 1, grok: 1, gemini: 1 },
    });
    const rejectCopy = () => { throw new Error("database copy should have been skipped"); };
    const reused = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      sourceMachine: "pc-a",
      mode: "manual",
      now: new Date("2026-08-28T11:00:00Z"),
      failpoints: { beforeDatabaseCopy: rejectCopy },
    });
    expect(reused).toMatchObject({ status: "reused", reason: "identical-snapshot", snapshotId: first.snapshotId });

    advanceFixture(dbPath, 2);
    const daily = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      sourceMachine: "pc-a",
      mode: "automatic",
      now: new Date("2026-08-28T12:00:00Z"),
      failpoints: { beforeDatabaseCopy: rejectCopy },
    });
    expect(daily).toMatchObject({ status: "skipped", reason: "daily-limit" });
    const second = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, sourceMachine: "pc-a", mode: "manual", now: new Date("2026-08-29T10:00:00Z") });
    expect(second.status).toBe("created");
    advanceFixture(dbPath, 3);
    const staleTemp = path.join(poolPath, `stale${ATLAS_SNAPSHOT_DATABASE_SUFFIX}.tmp-old`);
    const freshTemp = path.join(poolPath, `fresh${ATLAS_SNAPSHOT_DATABASE_SUFFIX}.tmp-active`);
    fs.writeFileSync(staleTemp, "stale");
    fs.writeFileSync(freshTemp, "fresh");
    fs.utimesSync(staleTemp, new Date("2026-08-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
    fs.utimesSync(freshTemp, new Date("2026-08-30T09:50:00Z"), new Date("2026-08-30T09:50:00Z"));
    const third = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, sourceMachine: "pc-a", mode: "manual", now: new Date("2026-08-30T10:00:00Z") });
    expect(third.status).toBe("created");
    expect(fs.existsSync(staleTemp)).toBe(false);
    expect(fs.existsSync(freshTemp)).toBe(true);
    fs.rmSync(freshTemp);

    // Each snapshot is a full copy of the database; recovery only ever reads the newest.
    const valid = discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid);
    expect(valid.map((candidate) => candidate.snapshotId)).toEqual([third.snapshotId!]);
    expect(fs.existsSync(first.databasePath!)).toBe(false);
    expect(fs.existsSync(first.manifestPath!)).toBe(false);
    expect(fs.existsSync(second.databasePath!)).toBe(false);
    expect(fs.existsSync(second.manifestPath!)).toBe(false);

    const beforeFailure = fs.readdirSync(poolPath).sort();
    advanceFixture(dbPath, 4);
    const broken = openFixtureDatabase(dbPath);
    broken.exec("DROP TABLE events");
    broken.close(true);
    expect(() => publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "manual", now: new Date("2026-08-31T10:00:00Z") })).toThrow();
    expect(fs.readdirSync(poolPath).sort()).toEqual(beforeFailure);

    fs.writeFileSync(path.join(poolPath, `orphan${ATLAS_SNAPSHOT_DATABASE_SUFFIX}`), "not a database");
    fs.writeFileSync(path.join(poolPath, `manifest-only${ATLAS_SNAPSHOT_MANIFEST_SUFFIX}`), "{}");
    const afterInterruption = discoverAtlasSnapshotCandidates(poolPath);
    expect(afterInterruption.filter((candidate) => candidate.valid)).toHaveLength(1);
    expect(afterInterruption.find((candidate) => candidate.snapshotId === "manifest-only")?.valid).toBe(false);
  });

  test("rejects corrupt content and future schemas independently", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive-a");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    createAtlasFixture(dbPath, archiveRoot);
    const published = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "manual" });
    const originalManifest = JSON.parse(fs.readFileSync(published.manifestPath!, "utf8")) as AtlasIndexSnapshotManifest;
    const mismatchedChecksum = structuredClone(originalManifest);
    mismatchedChecksum.checksum.value = "0".repeat(64);
    fs.writeFileSync(published.manifestPath!, JSON.stringify(mismatchedChecksum));
    expect(validateAtlasSnapshotCandidate(published.manifestPath!).errors).toContain("snapshot checksum does not match its manifest");
    fs.writeFileSync(published.manifestPath!, JSON.stringify(originalManifest));
    const descriptor = fs.openSync(published.databasePath!, "r+");
    try {
      fs.writeSync(descriptor, Buffer.from("BROKEN"), 0, 6, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    const corrupt = validateAtlasSnapshotCandidate(published.manifestPath!);
    expect(corrupt.valid).toBe(false);
    expect(corrupt.errors).toContain("snapshot checksum does not match its manifest");
    expect(corrupt.errors).toContain("snapshot database could not be opened or inspected");

    const futureCandidate = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date(Date.now() + 1000),
    });
    const manifest = JSON.parse(fs.readFileSync(futureCandidate.manifestPath!, "utf8")) as AtlasIndexSnapshotManifest;
    manifest.schemaVersion = currentAtlasSchemaVersion() + 1;
    fs.writeFileSync(futureCandidate.manifestPath!, JSON.stringify(manifest));
    const incompatible = validateAtlasSnapshotCandidate(futureCandidate.manifestPath!);
    expect(incompatible.compatible).toBe(false);
    expect(incompatible.errors).toContain("snapshot schema is not compatible with this application");
  });

  test("requires lineage, vendor revisions, and row counts before manual reuse", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const sourceA = path.join(root, "source-a.sqlite");
    const sourceB = path.join(root, "source-b.sqlite");
    const sourceC = path.join(root, "source-c.sqlite");
    createAtlasFixture(sourceA, archiveRoot);
    createAtlasFixture(sourceB, archiveRoot);
    createAtlasFixture(sourceC, archiveRoot);
    const changed = openFixtureDatabase(sourceB);
    changed.run("UPDATE events SET project='different-content'");
    changed.run("UPDATE vendor_sync_revisions SET data_revision=99 WHERE vendor='codex'");
    changed.close(true);

    const first = publishAtlasSnapshot({ dbPath: sourceA, archiveRoot, poolPath, mode: "manual" });
    const second = publishAtlasSnapshot({
      dbPath: sourceB,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date(Date.now() + 1_000),
    });
    expect(second.status).toBe("created");
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.manifest?.revisions).toEqual(first.manifest?.revisions);
    expect(second.manifest?.vendorDataRevisions.codex).toBe(99);
    expect(second.manifest?.identityFingerprint).not.toBe(first.manifest?.identityFingerprint);

    const addedRow = openFixtureDatabase(sourceC);
    addedRow.run(
      "INSERT INTO claude_events (store,call_id,ts,project,cwd,path) VALUES ('machine','call-2','2026-08-01T00:00:00.000Z','project','C:\\work','extra.jsonl')",
    );
    addedRow.close(true);
    const third = publishAtlasSnapshot({
      dbPath: sourceC,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date(Date.now() + 2_000),
    });
    expect(third.status).toBe("created");
    expect(third.manifest?.revisions).toEqual(first.manifest?.revisions);
    expect(third.manifest?.vendorDataRevisions).toEqual(first.manifest?.vendorDataRevisions);
    expect(third.manifest?.vendorRowCounts.claude).toBe(2);
    expect(third.manifest?.identityFingerprint).not.toBe(first.manifest?.identityFingerprint);
  });

  test("serializes the automatic daily gate across independent processes", async () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    const scriptPath = path.join(root, "publish-child.ts");
    createAtlasFixture(dbPath, archiveRoot);
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, "snapshot.ts")).href;
    fs.writeFileSync(
      scriptPath,
      `import { publishAtlasSnapshot } from ${JSON.stringify(moduleUrl)};\n` +
      `const [dbPath, archiveRoot, poolPath] = process.argv.slice(2);\n` +
      `const result = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "automatic", now: new Date("2026-08-31T12:00:00.000Z") });\n` +
      `console.log(JSON.stringify({ status: result.status, reason: result.reason, snapshotId: result.snapshotId }));\n`,
    );
    const runChild = async () => {
      const child = Bun.spawn({
        cmd: [process.execPath, scriptPath, dbPath, archiveRoot, poolPath],
        cwd: path.resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as { status: string; reason: string | null; snapshotId: string };
    };

    const results = await Promise.all([runChild(), runChild()]);
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "skipped")).toHaveLength(1);
    expect(discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid)).toHaveLength(1);
    const lease = openFixtureDatabase(path.join(poolPath, ATLAS_SNAPSHOT_PUBLICATION_LEASE), { readonly: true });
    expect((lease.query("SELECT COUNT(*) AS n FROM publication_lease").get() as { n: number }).n).toBe(0);
    lease.close(true);
  });

  test("a resumed stale claimant cannot publish or release the renewing takeover owner", async () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const controlPath = path.join(root, "control");
    const dbPath = path.join(root, "source.sqlite");
    const scriptPath = path.join(root, "lease-child.ts");
    fs.mkdirSync(controlPath);
    createAtlasFixture(dbPath, archiveRoot);
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, "snapshot.ts")).href;
    fs.writeFileSync(
      scriptPath,
      `import fs from "node:fs";\n` +
      `import path from "node:path";\n` +
      `import { publishAtlasSnapshot } from ${JSON.stringify(moduleUrl)};\n` +
      `const [role, dbPath, archiveRoot, poolPath, controlPath] = process.argv.slice(2);\n` +
      `const waitSignal = new Int32Array(new SharedArrayBuffer(4));\n` +
      `let firstClaim = true;\n` +
      `const marker = (name) => path.join(controlPath, role + "-" + name);\n` +
      `const result = publishAtlasSnapshot({\n` +
      `  dbPath, archiveRoot, poolPath, mode: "automatic",\n` +
      `  now: new Date("2026-08-31T14:00:00.000Z"), lockTimeoutMs: 10000, leaseStaleMs: 500,\n` +
      `  failpoints: {\n` +
      `    afterClaimAcquired(token, renew) {\n` +
      `      if (!firstClaim) return;\n` +
      `      firstClaim = false;\n` +
      `      fs.writeFileSync(marker("acquired"), token);\n` +
      `      while (!fs.existsSync(marker("resume"))) {\n` +
      `        if (role === "B") renew();\n` +
      `        Atomics.wait(waitSignal, 0, 0, 20);\n` +
      `      }\n` +
      `      if (role === "B") renew();\n` +
      `    },\n` +
      `    afterLeaseLost(token) { fs.writeFileSync(marker("lost"), token); },\n` +
      `  },\n` +
      `});\n` +
      `console.log(JSON.stringify({ role, status: result.status, reason: result.reason, snapshotId: result.snapshotId }));\n`,
    );
    const children: Bun.Subprocess[] = [];
    function spawnChild(role: "A" | "B") {
      const child = Bun.spawn({
        cmd: [process.execPath, scriptPath, role, dbPath, archiveRoot, poolPath, controlPath],
        cwd: path.resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      return child;
    }
    const waitForMarker = async (name: string): Promise<string> => {
      const filePath = path.join(controlPath, name);
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(filePath)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name}`);
        await Bun.sleep(10);
      }
      return fs.readFileSync(filePath, "utf8");
    };
    const readChild = async (child: ReturnType<typeof spawnChild>) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as { role: "A" | "B"; status: string; reason: string | null; snapshotId: string };
    };

    try {
      const publisherA = spawnChild("A");
      const tokenA = await waitForMarker("A-acquired");
      await Bun.sleep(1_000);
      const publisherB = spawnChild("B");
      const tokenB = await waitForMarker("B-acquired");
      expect(tokenB).not.toBe(tokenA);
      fs.writeFileSync(path.join(controlPath, "A-resume"), "resume");
      expect(await waitForMarker("A-lost")).toBe(tokenA);

      const heldLease = openFixtureDatabase(path.join(poolPath, ATLAS_SNAPSHOT_PUBLICATION_LEASE), { readonly: true });
      try {
        // B keeps renewing in another process. Like the production lease connection,
        // this observer must wait for a brief commit lock, not treat contention as failure.
        heldLease.exec("PRAGMA busy_timeout = 5000");
        expect((heldLease.query("SELECT token FROM publication_lease WHERE id=1").get() as { token: string }).token).toBe(tokenB);
      } finally {
        heldLease.close(true);
      }
      expect(discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid)).toHaveLength(0);

      fs.writeFileSync(path.join(controlPath, "B-resume"), "resume");
      const results = await Promise.all([readChild(publisherA), readChild(publisherB)]);
      const byRole = Object.fromEntries(results.map((result) => [result.role, result])) as Record<"A" | "B", typeof results[number]>;
      expect(byRole.B.status).toBe("created");
      expect(byRole.A).toMatchObject({ status: "aborted", reason: "lease-lost" });
      expect(discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid)).toHaveLength(1);
      const releasedLease = openFixtureDatabase(path.join(poolPath, ATLAS_SNAPSHOT_PUBLICATION_LEASE), { readonly: true });
      expect((releasedLease.query("SELECT COUNT(*) AS n FROM publication_lease").get() as { n: number }).n).toBe(0);
      releasedLease.close(true);
    } finally {
      // A failed ownership assertion must not leave B renewing forever in the runner.
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  }, 15_000);

  test("a claimant suspended after renewal is fenced before final-name publication", async () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const controlPath = path.join(root, "control");
    const dbPath = path.join(root, "source.sqlite");
    const scriptPath = path.join(root, "fenced-child.ts");
    fs.mkdirSync(controlPath);
    createAtlasFixture(dbPath, archiveRoot);
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, "snapshot.ts")).href;
    fs.writeFileSync(
      scriptPath,
      `import fs from "node:fs";\n` +
      `import path from "node:path";\n` +
      `import { publishAtlasSnapshot } from ${JSON.stringify(moduleUrl)};\n` +
      `const [dbPath, archiveRoot, poolPath, controlPath] = process.argv.slice(2);\n` +
      `const waitSignal = new Int32Array(new SharedArrayBuffer(4));\n` +
      `const result = publishAtlasSnapshot({\n` +
      `  dbPath, archiveRoot, poolPath, mode: "automatic",\n` +
      `  now: new Date("2026-08-31T15:00:00.000Z"), lockTimeoutMs: 10000, leaseStaleMs: 500,\n` +
      `  failpoints: {\n` +
      `    afterPreCommitRenewal(token) {\n` +
      `      fs.writeFileSync(path.join(controlPath, "A-renewed"), token);\n` +
      `      while (!fs.existsSync(path.join(controlPath, "A-resume"))) Atomics.wait(waitSignal, 0, 0, 20);\n` +
      `    },\n` +
      `    afterLeaseLost(token) { fs.writeFileSync(path.join(controlPath, "A-lost"), token); },\n` +
      `  },\n` +
      `});\n` +
      `console.log(JSON.stringify(result));\n`,
    );
    const publisherA = Bun.spawn({
      cmd: [process.execPath, scriptPath, dbPath, archiveRoot, poolPath, controlPath],
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const renewedMarker = path.join(controlPath, "A-renewed");
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(renewedMarker)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for A's pre-commit renewal");
        await Bun.sleep(10);
      }
      const tokenA = fs.readFileSync(renewedMarker, "utf8");
      await Bun.sleep(1_000);

      const publisherB = publishAtlasSnapshot({
        dbPath,
        archiveRoot,
        poolPath,
        mode: "automatic",
        now: new Date("2026-08-31T15:00:00.000Z"),
        lockTimeoutMs: 10_000,
        leaseStaleMs: 500,
      });
      expect(publisherB.status).toBe("created");
      expect(discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid)).toHaveLength(1);

      fs.writeFileSync(path.join(controlPath, "A-resume"), "resume");
      const [exitCode, stdout, stderr] = await Promise.all([
        publisherA.exited,
        new Response(publisherA.stdout).text(),
        new Response(publisherA.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const publisherAResult = JSON.parse(stdout) as {
        status: string;
        reason: string | null;
        leaseLostAfterCommit: boolean;
      };
      expect(publisherAResult).toEqual(expect.objectContaining({
        status: "aborted",
        reason: "lease-lost",
        leaseLostAfterCommit: false,
      }));
      expect(fs.readFileSync(path.join(controlPath, "A-lost"), "utf8")).toBe(tokenA);
      expect(discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid)).toHaveLength(1);
      expect(fs.readdirSync(poolPath).filter((name) => name.endsWith(ATLAS_SNAPSHOT_DATABASE_SUFFIX))).toHaveLength(1);
      const lease = openFixtureDatabase(path.join(poolPath, ATLAS_SNAPSHOT_PUBLICATION_LEASE), { readonly: true });
      expect((lease.query("SELECT COUNT(*) AS n FROM publication_lease").get() as { n: number }).n).toBe(0);
      lease.close(true);
    } finally {
      if (publisherA.exitCode === null) publisherA.kill();
      await publisherA.exited;
    }
  }, 15_000);

  test("keeps prior snapshots safe across both rename windows and a retention interruption", () => {
    for (const failpoint of ["afterDatabaseRename", "afterManifestRename"] as const) {
      const root = tempDirectory();
      const archiveRoot = path.join(root, "archive");
      const poolPath = path.join(root, "pool");
      const dbPath = path.join(root, "source.sqlite");
      createAtlasFixture(dbPath, archiveRoot);
      const prior = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "manual" });
      advanceFixture(dbPath, 2);
      expect(() => publishAtlasSnapshot({
        dbPath,
        archiveRoot,
        poolPath,
        mode: "manual",
        now: new Date("2026-08-31T13:00:00.000Z"),
        failpoints: { [failpoint]: () => { throw new Error(failpoint); } },
      })).toThrow(failpoint);
      const candidates = discoverAtlasSnapshotCandidates(poolPath);
      expect(candidates.filter((candidate) => candidate.valid).map((candidate) => candidate.snapshotId)).toEqual([
        prior.snapshotId!,
      ]);
      expect(fs.existsSync(prior.databasePath!)).toBe(true);
      expect(fs.existsSync(prior.manifestPath!)).toBe(true);
      if (failpoint === "afterManifestRename") {
        const interrupted = candidates.find((candidate) => candidate.snapshotId !== prior.snapshotId);
        expect(interrupted?.errors).toContain("snapshot durable publication barrier is missing");
      }
    }

    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    createAtlasFixture(dbPath, archiveRoot);
    publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "manual", now: new Date("2026-08-28T00:00:00Z") });
    advanceFixture(dbPath, 2);
    publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "manual", now: new Date("2026-08-29T00:00:00Z") });
    advanceFixture(dbPath, 3);
    expect(() => publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-08-30T00:00:00Z"),
      failpoints: { beforeRetentionDelete: () => { throw new Error("retention-interruption"); } },
    })).toThrow("retention-interruption");
    // The interrupted retention keeps its predecessor; only the deletions it never
    // reached survive, and the new publication is complete and durable regardless.
    const afterRetentionCrash = discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid);
    expect(afterRetentionCrash).toHaveLength(2);
    const current = afterRetentionCrash.find(
      (candidate) => candidate.manifest?.createdAt === "2026-08-30T00:00:00.000Z",
    );
    expect(current).toBeDefined();
    expect(fs.existsSync(current!.barrierPath)).toBe(true);
  });

  test("retention protects a clock-skewed publication after its durable barrier", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    createAtlasFixture(dbPath, archiveRoot);
    publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "manual", now: new Date("2026-08-29T00:00:00Z") });
    advanceFixture(dbPath, 2);
    const newest = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "manual", now: new Date("2026-08-30T00:00:00Z") });
    advanceFixture(dbPath, 3);
    const skewed = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath, mode: "manual", now: new Date("2026-08-01T00:00:00Z") });

    expect(skewed.status).toBe("created");
    expect(fs.existsSync(skewed.databasePath!)).toBe(true);
    expect(fs.existsSync(skewed.manifestPath!)).toBe(true);
    expect(fs.existsSync(path.join(poolPath, `${skewed.snapshotId}${ATLAS_SNAPSHOT_BARRIER_SUFFIX}`))).toBe(true);
    // The protected publication is the one just committed, even though an older
    // timestamp sorts it last; retention keeps it and drops the surplus copy.
    const retained = discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid);
    expect(retained.map((candidate) => candidate.snapshotId)).toEqual([skewed.snapshotId!]);
    expect(fs.existsSync(newest.databasePath!)).toBe(false);
  });

  test("confirms the published pair against the manifest built from the inspected copy", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const dbPath = path.join(root, "source.sqlite");
    createAtlasFixture(dbPath, archiveRoot);
    const truncatedPool = path.join(root, "truncated-pool");
    const publishedFile = (pool: string, suffix: string) =>
      path.join(pool, fs.readdirSync(pool).find((name) => name.endsWith(suffix))!);

    expect(() => publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      failpoints: {
        afterManifestRename: () => {
          const manifestPath = publishedFile(poolPath, ATLAS_SNAPSHOT_MANIFEST_SUFFIX);
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as AtlasIndexSnapshotManifest;
          manifest.checksum.value = "0".repeat(64);
          fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        },
      },
    })).toThrow("snapshot manifest does not match the inspected database");

    expect(() => publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath: truncatedPool,
      mode: "manual",
      failpoints: {
        afterDatabaseRename: () => fs.truncateSync(publishedFile(truncatedPool, ATLAS_SNAPSHOT_DATABASE_SUFFIX), 512),
      },
    })).toThrow("snapshot size does not match its manifest");
  });
});

describe("Atlas bootstrap and archive-path rebase", () => {
  test("normal startup uses bounded reads instead of scanning populated data and indexes", () => {
    const root = tempDirectory();
    const localDbPath = path.join(root, "atlas.sqlite");
    createAtlasFixture(localDbPath, path.join(root, "archive"));
    const original = Database.prototype.prepare;
    const queries: string[] = [];
    const spy = spyOn(Database.prototype, "prepare").mockImplementation((function (
      this: Database, ...args: Parameters<Database["prepare"]>
    ) {
      queries.push(String(args[0]));
      return Reflect.apply(original, this, args);
    }) as Database["prepare"]);
    try {
      expect(bootstrapAtlasIndex({ localDbPath }).status).toBe("local-ready");
      expect(queries.some((sql) => /PRAGMA\s+(integrity_check|quick_check)/i.test(sql))).toBe(false);
      expect(queries.filter((sql) => /COUNT\s*\(/i.test(sql)))
        .toEqual(["SELECT COUNT(*) AS n FROM __drizzle_migrations"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("falls back from a corrupt newest snapshot, migrates, rebases, and catches up incrementally", async () => {
    const root = tempDirectory();
    const sourceRoot = path.join(root, "one-drive-a", "archive");
    const targetRoot = path.join(root, "one-drive-b", "archive");
    const poolPath = path.join(root, "pool");
    const sourceDb = path.join(root, "source.sqlite");
    const localDb = path.join(root, "local", "atlas.sqlite");
    createAtlasFixture(sourceDb, sourceRoot);
    const sourceSqlite = openFixtureDatabase(sourceDb, { readonly: true });
    const historicalBefore = historicalValues(sourceSqlite);
    sourceSqlite.close(true);
    const previous = publishAtlasSnapshot({ dbPath: sourceDb, archiveRoot: sourceRoot, poolPath, mode: "manual", now: new Date("2026-08-28T10:00:00Z") });
    // Retention keeps one snapshot, so the older copy is put back by hand: bootstrap must
    // still fall back over however many candidates the pool happens to hold.
    const keptAside = path.join(root, "kept-aside");
    fs.mkdirSync(keptAside, { recursive: true });
    const previousFiles = [previous.databasePath!, previous.manifestPath!,
      path.join(poolPath, `${previous.snapshotId}${ATLAS_SNAPSHOT_BARRIER_SUFFIX}`)];
    for (const file of previousFiles) fs.copyFileSync(file, path.join(keptAside, path.basename(file)));
    advanceFixture(sourceDb, 2);
    const newest = publishAtlasSnapshot({ dbPath: sourceDb, archiveRoot: sourceRoot, poolPath, mode: "manual", now: new Date("2026-08-29T10:00:00Z") });
    for (const file of previousFiles) fs.copyFileSync(path.join(keptAside, path.basename(file)), file);
    fs.appendFileSync(newest.databasePath!, "corruption");
    const migrationsFolder = fixtureMigrations(root);

    const bootstrap = bootstrapAtlasIndex({
      localDbPath: localDb,
      archiveRoot: targetRoot,
      poolPath,
      migrationsFolder,
      currentSchemaVersion: FIXTURE_SCHEMA_VERSION,
    });
    expect(bootstrap).toMatchObject({
      status: "snapshot-installed",
      selectedSnapshotId: previous.snapshotId,
      catchUpMode: "incremental",
    });
    expect(bootstrap.attempts.map((attempt) => [attempt.snapshotId, attempt.accepted])).toEqual([
      [newest.snapshotId!, false],
      [previous.snapshotId!, true],
    ]);

    const installed = openFixtureDatabase(localDb);
    expect(Object.values((installed.query("PRAGMA integrity_check").get() as Record<string, unknown>))[0]).toBe("ok");
    expect(installed.query("SELECT name FROM sqlite_master WHERE name='bootstrap_fixture'").get()).not.toBeNull();
    expect(installed.query("SELECT data_revision, config_revision FROM sync_revisions WHERE id=1").get()).toEqual({ data_revision: 1, config_revision: 2 });
    expect(ledgerRevision(installed)).toBe(previous.manifest!.revisions.derived);
    const vendorTables: Record<UsageVendorId, string> = {
      codex: "events",
      claude: "claude_events",
      opencode: "oc_events",
      grok: "grok_events",
      gemini: "gemini_events",
    };
    for (const vendor of USAGE_VENDOR_IDS) {
      const count = installed.query(`SELECT COUNT(*) AS n FROM "${vendorTables[vendor]}"`).get() as { n: number };
      expect(count.n).toBe(previous.manifest!.vendorRowCounts[vendor]);
    }
    expect(historicalValues(installed)).toEqual(historicalBefore);
    expect((installed.query("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'opencode_snapshot:%' OR key LIKE 'sync_source_fingerprint:%'").get() as { n: number }).n).toBe(0);
    for (const target of ARCHIVE_PATH_COLUMNS) {
      const columns = installed.query(`PRAGMA table_info("${target.table}")`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === target.column)) continue;
      const rows = installed.query(`SELECT "${target.column}" AS value FROM "${target.table}" WHERE "${target.column}" <> ''`).all() as Array<{ value: string }>;
      for (const row of rows) expect(row.value.toLowerCase().startsWith(targetRoot.toLowerCase())).toBe(true);
    }
    installed.close(true);
    expect(ARCHIVE_PATH_COLUMNS.some((target) => ["cwd", "directory", "workspace", "project", "repo"].includes(target.column))).toBe(false);
    await runCatchUp(localDb, "incremental");
  });

  test("atomically prepares an empty migrated index and requests full ingest when every candidate fails", async () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const sourceDb = path.join(root, "source.sqlite");
    const localDb = path.join(root, "local", "atlas.sqlite");
    createAtlasFixture(sourceDb, archiveRoot);
    const published = publishAtlasSnapshot({ dbPath: sourceDb, archiveRoot, poolPath, mode: "manual" });
    fs.appendFileSync(published.databasePath!, "corruption");
    expect(bootstrapAtlasIndex({ localDbPath: sourceDb, archiveRoot, poolPath })).toMatchObject({
      status: "local-ready",
      catchUpMode: null,
    });
    fs.mkdirSync(path.dirname(localDb), { recursive: true });
    fs.writeFileSync(localDb, "broken local database");

    const bootstrap = bootstrapAtlasIndex({ localDbPath: localDb, archiveRoot, poolPath });
    expect(bootstrap).toMatchObject({ status: "full-ingest-required", catchUpMode: "full" });
    const recoveryId = pendingAtlasBootstrapRecovery(localDb);
    expect(recoveryId).toBeTruthy();
    expect(bootstrapAtlasIndex({ localDbPath: localDb, archiveRoot, poolPath })).toMatchObject({
      status: "full-ingest-required", catchUpMode: "full",
    });
    expect(bootstrap.attempts).toHaveLength(1);
    const sqlite = openFixtureDatabase(localDb);
    expect(Object.values((sqlite.query("PRAGMA integrity_check").get() as Record<string, unknown>))[0]).toBe("ok");
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name='sync_revisions'").get()).not.toBeNull();
    for (const table of ["meta", "files", "events", "ratelimit"]) {
      expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).not.toBeNull();
    }
    sqlite.close(true);
    const observer = retainedPrepareObserver();
    try {
      await runFullCodexPublication(localDb);
      observer.assertClosed();
    } finally { observer.restore(); }
    const populated = openFixtureDatabase(localDb, { readonly: true });
    expect((populated.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(1);
    expect((populated.query("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n).toBe(1);
    expect((populated.query("SELECT COUNT(*) AS n FROM ratelimit").get() as { n: number }).n).toBe(1);
    populated.close(true);
    expect(bootstrapAtlasIndex({ localDbPath: localDb, archiveRoot, poolPath }).catchUpMode).toBe("full");
    const complete = openFixtureDatabase(localDb);
    finishAtlasBootstrapRecovery(complete, recoveryId!);
    complete.close(true);
    expect(bootstrapAtlasIndex({ localDbPath: localDb, archiveRoot, poolPath }).catchUpMode).toBeNull();
  });

  test("an older partial automatic bootstrap ignores incremental receipts and stale review flags", () => {
    const root = tempDirectory(), archiveRoot = path.join(root, "archive");
    const pendingDb = path.join(root, "pending.sqlite"), incrementalDb=path.join(root,"incremental.sqlite"),recoveredDb = path.join(root, "recovered.sqlite");
    for (const dbPath of [pendingDb, incrementalDb, recoveredDb]) {
      createAtlasFixture(dbPath, archiveRoot);
      const sqlite = openFixtureDatabase(dbPath);
      const insert = sqlite.query(`INSERT INTO sync_runs(run_id,trigger,scope,mode,status,started_at,finished_at,
        before_data_revision,after_data_revision,before_config_revision,after_config_revision,result_json)
        VALUES(?, 'auto', ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)`);
      insert.run("old-full", "all", "full", "partial_success", "2026-09-01T00:00:00Z", "2026-09-01T00:01:00Z",
        JSON.stringify({ status: "partial_success", scope:{kind:"all"}, vendors: [
          { vendor: "codex", status: "failure", inputsComplete: false },
          { vendor: "claude", status: "success", inputsComplete: true },
        ] }));
      if (dbPath !== pendingDb) insert.run("later-retry", "vendor", dbPath===recoveredDb?"full":"incremental", "success",
        "2026-09-02T00:00:00Z", "2026-09-02T00:01:00Z",
        JSON.stringify({ status: "success", scope:{kind:"vendor",vendor:"codex"}, vendors: [{ vendor: "codex", status: "success", inputsComplete: true, processedInputs:2 }] }));
      if (dbPath === incrementalDb) insert.run("second-small-retry", "vendor", "incremental", "success",
        "2026-09-02T00:05:00Z", "2026-09-02T00:06:00Z",
        JSON.stringify({ status: "success", scope:{kind:"vendor",vendor:"codex"}, vendors: [{ vendor: "codex", status: "success", inputsComplete: true, processedInputs:4 }] }));
      if (dbPath !== pendingDb) sqlite.query("INSERT INTO meta(key,value) VALUES('atlas_bootstrap_legacy_reviewed','1')").run();
      sqlite.close(true);
    }
    expect(bootstrapAtlasIndex({ localDbPath: pendingDb, archiveRoot }).catchUpMode).toBe("full");
    expect(pendingAtlasBootstrapVendors(pendingDb)).toEqual(["codex"]);
    expect(bootstrapAtlasIndex({localDbPath:incrementalDb,archiveRoot}).catchUpMode).toBe("full");
    expect(pendingAtlasBootstrapVendors(incrementalDb)).toEqual(["codex"]);
    const pendingRecovery = pendingAtlasBootstrapRecovery(incrementalDb);
    expect(pendingRecovery).not.toBeNull();
    expect(bootstrapAtlasIndex({localDbPath:incrementalDb,archiveRoot}).catchUpMode).toBe("full");
    expect(pendingAtlasBootstrapRecovery(incrementalDb)).toBe(pendingRecovery);
    expect(pendingAtlasBootstrapVendors(incrementalDb)).toEqual(["codex"]);
    expect(bootstrapAtlasIndex({ localDbPath: recoveredDb, archiveRoot })).toMatchObject({ status: "local-ready", catchUpMode: null });
    const recovered = openFixtureDatabase(recoveredDb, {readonly:true});
    expect(recovered.query("SELECT value FROM meta WHERE key='atlas_bootstrap_legacy_reviewed'").get()).toEqual({value:"2"});
    recovered.close(true);
    const original = Database.prototype.prepare, queries:string[] = [];
    const spy = spyOn(Database.prototype,"prepare").mockImplementation((function(this:Database,...args:Parameters<Database["prepare"]>) {
      queries.push(String(args[0]));return Reflect.apply(original,this,args);
    }) as Database["prepare"]);
    try { expect(bootstrapAtlasIndex({ localDbPath: recoveredDb, archiveRoot }).status).toBe("local-ready"); }
    finally { spy.mockRestore(); }
    expect(queries.some(sql=>sql.includes("SELECT result_json FROM sync_runs WHERE started_at>"))).toBe(false);
  });

  test("only a completed whole-history manual rebuild with matching source proof closes a failed bootstrap vendor", () => {
    const root=tempDirectory(),archiveRoot=path.join(root,"archive");
    const cases=[
      {name:"complete",job:{},receipt:{}},
      {name:"dated",job:{range:{from:"2026-09-01",until:"2026-09-29"}},receipt:{}},
      {name:"early",job:{requestedAt:"2026-08-31T00:00:00Z"},receipt:{}},
      {name:"accounts",job:{accounts:[{vendor:"codex",account:"codex1"}]},receipt:{}},
      {name:"unfinished",job:{state:"running"},receipt:{}},
      {name:"generation",job:{generation:43},receipt:{}},
      {name:"vendor-excluded",job:{vendors:["claude"]},receipt:{}},
      {name:"source-scope",job:{},receipt:{scope:{kind:"vendor",vendor:"claude"}}},
      {name:"unread",job:{},receipt:{inputsComplete:false}},
    ] as const;
    for(const item of cases) {
      const dbPath=path.join(root,`${item.name}.sqlite`);createAtlasFixture(dbPath,archiveRoot);
      const sqlite=openFixtureDatabase(dbPath);
      try {
        const insert=sqlite.query(`INSERT INTO sync_runs(run_id,trigger,scope,mode,status,started_at,finished_at,
          before_data_revision,after_data_revision,before_config_revision,after_config_revision,result_json)
          VALUES(?,?,?,?,?,?,?,0,0,0,0,?)`);
        insert.run("failed-full","auto","all","full","partial_success","2026-09-01T00:00:00Z","2026-09-01T00:01:00Z",
          JSON.stringify({status:"partial_success",scope:{kind:"all"},vendors:[{vendor:"codex",status:"failure",inputsComplete:false}]}));
        insert.run("rebuild-source","manual","all","incremental","success","2026-09-03T00:01:00Z","2026-09-03T00:02:00Z",
          JSON.stringify({status:"success",scope:(item.receipt as {scope?:unknown}).scope??{kind:"all"},rebuildGeneration:42,
            vendors:[{vendor:"codex",status:"success",inputsComplete:(item.receipt as {inputsComplete?:boolean}).inputsComplete??true}]}));
        const job={generation:42,state:"complete",scope:"all",range:null,accounts:null,requestedAt:"2026-09-03T00:00:00Z",
          report:{generation:42,lastRecordedSourceRunId:"rebuild-source"},...item.job};
        writeRebuildStatusJson(sqlite,JSON.stringify(job));
      } finally {sqlite.close(true);}
      const result=bootstrapAtlasIndex({localDbPath:dbPath,archiveRoot});
      expect(result.catchUpMode,item.name).toBe(item.name==="complete"?null:"full");
      if(item.name!=="complete")expect(pendingAtlasBootstrapVendors(dbPath)).toEqual(["codex"]);
    }
  });

  test("rejects row-bearing non-Atlas SQLite files while preserving a structurally valid populated index", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const malformed = path.join(root, "malformed.sqlite");
    const valid = path.join(root, "valid.sqlite");
    const malformedSqlite = openFixtureDatabase(malformed, { create: true });
    malformedSqlite.exec("CREATE TABLE events (ts TEXT); INSERT INTO events VALUES ('2026-08-31T00:00:00Z')");
    malformedSqlite.close(true);
    createAtlasFixture(valid, archiveRoot);

    expect(localAtlasIndexUsable(malformed)).toBe(false);
    expect(localAtlasIndexUsable(valid)).toBe(true);
    const recovered = bootstrapAtlasIndex({
      localDbPath: malformed,
      archiveRoot,
      poolPath: path.join(root, "empty-pool"),
    });
    expect(recovered.status).toBe("full-ingest-required");
    const replacement = openFixtureDatabase(malformed, { readonly: true });
    expect(replacement.query("SELECT name FROM sqlite_master WHERE name='sync_revisions'").get()).not.toBeNull();
    replacement.close(true);
  });

  test("records sanitized stage and reason codes for every candidate failure boundary", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const sourceDb = path.join(root, "source.sqlite");
    createAtlasFixture(sourceDb, archiveRoot);
    const published = publishAtlasSnapshot({ dbPath: sourceDb, archiveRoot, poolPath, mode: "manual" });
    const cases: Array<{
      key: keyof AtlasBootstrapFailpoints;
      stage: string;
      code: string;
    }> = [
      { key: "beforeCandidateCopy", stage: "copy", code: "snapshot-copy-failed" },
      { key: "beforeCandidateMigration", stage: "migration", code: "snapshot-migration-failed" },
      { key: "beforeCandidateRebase", stage: "rebase", code: "snapshot-rebase-failed" },
      { key: "beforeCandidateIntegrity", stage: "integrity", code: "snapshot-integrity-failed" },
      { key: "beforeFinalSwap", stage: "installation", code: "snapshot-installation-failed" },
    ];
    for (const item of cases) {
      const localDbPath = path.join(root, `local-${item.stage}`, "atlas.sqlite");
      const failpoints = {
        [item.key]: () => { throw new Error(`sensitive fixture path: ${root}`); },
      } as AtlasBootstrapFailpoints;
      const result = bootstrapAtlasIndex({ localDbPath, archiveRoot, poolPath, failpoints });
      const attempt = result.attempts.find((value) => value.snapshotId === published.snapshotId);
      expect(result.status).toBe("full-ingest-required");
      expect(attempt).toMatchObject({ accepted: false, stage: item.stage, code: item.code });
      expect(attempt?.reason).not.toContain(root);
    }

    const unreadablePool = path.join(root, "pool-is-a-file");
    fs.writeFileSync(unreadablePool, "not a directory");
    const discovery = bootstrapAtlasIndex({
      localDbPath: path.join(root, "discovery", "atlas.sqlite"),
      archiveRoot,
      poolPath: unreadablePool,
    });
    expect(discovery.attempts).toEqual([{
      snapshotId: null,
      accepted: false,
      stage: "discovery",
      code: "snapshot-pool-read-failed",
      reason: "Atlas snapshot pool could not be read",
    }]);
  }, 15_000);



  test("bootstrap finalizes retained migration statements before returning installed and fallback files", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "pool");
    const sourceDb = path.join(root, "source.sqlite");
    createAtlasFixture(sourceDb, archiveRoot);
    publishAtlasSnapshot({ dbPath: sourceDb, archiveRoot, poolPath, mode: "manual" });
    const observer = retainedPrepareObserver();
    try {
      const installedPath = path.join(root, "installed", "atlas.sqlite");
      expect(bootstrapAtlasIndex({ localDbPath: installedPath, archiveRoot, poolPath }).status)
        .toBe("snapshot-installed");
      observer.assertClosed();

      const fallbackPath = path.join(root, "fallback", "atlas.sqlite");
      expect(bootstrapAtlasIndex({
        localDbPath: fallbackPath, archiveRoot, poolPath,
        failpoints: { beforeCandidateRebase: () => { throw new Error("injected rebase failure"); } },
      }).status).toBe("full-ingest-required");
      observer.assertClosed();
      for (const dbPath of [installedPath, fallbackPath]) {
        // On Windows this also proves the native handles, not just JS state, are gone.
        fs.renameSync(dbPath, `${dbPath}.closed`);
        fs.renameSync(`${dbPath}.closed`, dbPath);
      }
    } finally { observer.restore(); }
  });

  test("bootstrap finalizes retained statements even when migration fails", () => {
    const root = tempDirectory();
    const archiveRoot = path.join(root, "archive");
    const localDbPath = path.join(root, "local", "atlas.sqlite");
    const migrationsFolder = fixtureMigrations(root);
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"));
    fs.writeFileSync(path.join(migrationsFolder, `${journal.entries.at(-1).tag}.sql`),
      "CREATE TABLE bootstrap_fixture (value TEXT);\n--> statement-breakpoint\nSELECT * FROM deliberately_missing_table;\n");
    const observer = retainedPrepareObserver();
    try {
      expect(() => bootstrapAtlasIndex({
        localDbPath, archiveRoot, poolPath: path.join(root, "empty-pool"),
        migrationsFolder, currentSchemaVersion: FIXTURE_SCHEMA_VERSION,
      })).toThrow();
      observer.assertClosed();
      expect(fs.existsSync(localDbPath)).toBe(false);
      expect(fs.readdirSync(path.dirname(localDbPath)).some((name) => name.includes("bootstrap-work"))).toBe(false);
    } finally { observer.restore(); }
  });

  test("prepares and reopens before the swap, then recovers crash and cleanup windows", () => {
    const root = tempDirectory();
    const sourceRoot = path.join(root, "source-archive");
    const targetRoot = path.join(root, "target-archive");
    const poolPath = path.join(root, "pool");
    const sourceDb = path.join(root, "source.sqlite");
    const localDb = path.join(root, "local", "atlas.sqlite");
    createAtlasFixture(sourceDb, sourceRoot);
    publishAtlasSnapshot({ dbPath: sourceDb, archiveRoot: sourceRoot, poolPath, mode: "manual" });
    const migrationsFolder = fixtureMigrations(root);
    fs.mkdirSync(path.dirname(localDb), { recursive: true });
    fs.writeFileSync(localDb, "previous-local");

    expect(() => bootstrapAtlasIndex({
      localDbPath: localDb,
      archiveRoot: targetRoot,
      poolPath,
      migrationsFolder,
      currentSchemaVersion: FIXTURE_SCHEMA_VERSION,
      failpoints: {
        afterInstallRename: () => { throw new AtlasBootstrapCrashSimulation(); },
      },
    })).toThrow(AtlasBootstrapCrashSimulation);
    expect(fs.existsSync(`${localDb}.bootstrap-backup`)).toBe(true);
    const interrupted = openFixtureDatabase(localDb, { readonly: true });
    expect(interrupted.query("SELECT name FROM sqlite_master WHERE name='bootstrap_fixture'").get()).not.toBeNull();
    const installedHome = (interrupted.query("SELECT home FROM events LIMIT 1").get() as { home: string }).home;
    expect(installedHome.toLowerCase().startsWith(targetRoot.toLowerCase())).toBe(true);
    expect(Object.values((interrupted.query("PRAGMA integrity_check").get() as Record<string, unknown>))[0]).toBe("ok");
    interrupted.close(true);

    const recovered = bootstrapAtlasIndex({
      localDbPath: localDb,
      archiveRoot: targetRoot,
      poolPath,
      migrationsFolder,
      currentSchemaVersion: FIXTURE_SCHEMA_VERSION,
    });
    expect(recovered.status).toBe("local-ready");
    expect(fs.existsSync(`${localDb}.bootstrap-backup`)).toBe(false);

    const cleanupLocal = path.join(root, "cleanup", "atlas.sqlite");
    fs.mkdirSync(path.dirname(cleanupLocal), { recursive: true });
    fs.writeFileSync(cleanupLocal, "previous-local");
    const committed = bootstrapAtlasIndex({
      localDbPath: cleanupLocal,
      archiveRoot: targetRoot,
      poolPath,
      migrationsFolder,
      currentSchemaVersion: FIXTURE_SCHEMA_VERSION,
      failpoints: { duringBackupCleanup: () => { throw new Error("cleanup interruption"); } },
    });
    expect(committed.status).toBe("snapshot-installed");
    expect(fs.existsSync(cleanupLocal)).toBe(true);
    expect(fs.existsSync(`${cleanupLocal}.bootstrap-backup`)).toBe(true);
    expect(bootstrapAtlasIndex({
      localDbPath: cleanupLocal,
      archiveRoot: targetRoot,
      poolPath,
      migrationsFolder,
      currentSchemaVersion: FIXTURE_SCHEMA_VERSION,
    }).status).toBe("local-ready");
    expect(fs.existsSync(`${cleanupLocal}.bootstrap-backup`)).toBe(false);
  });
});

test("distributed snapshots exclude local pending deliveries without draining the source", () => {
  const root = tempDirectory();
  const archiveRoot = path.join(root, "archive");
  const dbPath = path.join(root, "source.sqlite");
  createAtlasFixture(dbPath, archiveRoot);
  const source = openFixtureDatabase(dbPath);
  try {
    source.query(`INSERT INTO gauge_journal_outbox
      (entry_id, journal_root, archive_root, file_name, payload, queued_at)
      VALUES ('pending-test', ?, ?, 'probe_windows.jsonl', '{}', '2026-09-05T12:00:00Z')`)
      .run(path.join(archiveRoot, "gauges", "producer"), archiveRoot);
    const before = source.query("SELECT * FROM gauge_journal_outbox").all();
    const snapshot = publishAtlasSnapshot({ dbPath, archiveRoot, poolPath: path.join(root, "pool"), mode: "manual" });
    expect(snapshot.status).toBe("created");
    expect(source.query("SELECT * FROM gauge_journal_outbox").all()).toEqual(before);
    const replica = openFixtureDatabase(snapshot.databasePath!, { readonly: true });
    try {
      expect(replica.query("SELECT count(*) AS n FROM gauge_journal_outbox").get()).toEqual({ n: 0 });
      expect(replica.query("SELECT * FROM account_periods ORDER BY id").all())
        .toEqual(source.query("SELECT * FROM account_periods ORDER BY id").all());
    } finally { replica.close(true); }
  } finally { source.close(true); }
});

test("a snapshot transfers complete window answers and dirty marks, never an unpublished replacement", () => {
  const root=tempDirectory(), dbPath=path.join(root,"sender.sqlite"), archiveRoot=path.join(root,"archive"), poolPath=path.join(root,"pool");
  createAtlasFixture(dbPath,archiveRoot);
  const sender=openFixtureDatabase(dbPath);
  const from=Date.parse("2026-08-01T00:00:00.000Z"), until=from+86400000;
  try {
    ensureWindowAnswersSchema(sender);
    const complete={route:"/api/cycle-breakdown",key:"window-a",family:"window-a",
      scope:{provider:"codex",account:"a",fromMs:from,untilMs:until},configuration:"sender-settings",checked:0,
      builtAt:Date.now(),expiresAt:null,status:200,version:"rows-1",headers:[] as Array<[string,string]>,body:JSON.stringify({calls:1})};
    storeWindowAnswers(sender,[complete]);
    // A late input is committed with its mark; an unfinished reader replacement is still only in memory.
    sender.transaction(()=>{
      sender.query("UPDATE events SET in_tok=in_tok+1").run();
      markWindowAnswersDirty(sender,complete.scope);
    })();
    const raw=sender.query("SELECT in_tok FROM events ORDER BY rowid").all();
    const unpublished={...complete,body:JSON.stringify({calls:999})};
    const snapshot=publishAtlasSnapshot({dbPath,archiveRoot,poolPath,mode:"manual",requireFreshCopy:true});
    expect(snapshot.status).toBe("created");
    const localDbPath=path.join(root,"recipient.sqlite");
    expect(bootstrapAtlasIndex({localDbPath,archiveRoot,poolPath}).status).toBe("snapshot-installed");
    const recipient=openFixtureDatabase(localDbPath);
    const stored=readWindowAnswer(recipient,complete.route,complete.key)!;
    expect(stored.body).toBe(complete.body);
    expect(stored.body).not.toBe(unpublished.body);
    expect(recipient.query("SELECT in_tok FROM events ORDER BY rowid").all()).toEqual(raw);
    expect(windowAnswerIsCurrent(recipient,stored,"sender-settings")).toBe(false);

    expect(recipient.query("SELECT COUNT(*) n FROM window_answer_marks").get()).toEqual({n:1});
    // Rolling back to the old complete answer cannot erase the post-answer input or its dirty mark.
    storeWindowAnswers(recipient,[complete]);
    expect(windowAnswerIsCurrent(recipient,readWindowAnswer(recipient,complete.route,complete.key)!,"sender-settings")).toBe(false);
    expect(recipient.query("SELECT in_tok FROM events ORDER BY rowid").all()).toEqual(raw);
    recipient.close(true);
  } finally {sender.close(true);}
});

test("a clean snapshot answer is reused only under the recipient's actual scoped configuration", async () => {
  const root=tempDirectory(),dbPath=path.join(root,"sender.sqlite"),archiveRoot=path.join(root,"archive"),poolPath=path.join(root,"pool");
  createAtlasFixture(dbPath,archiveRoot);
  const sender=openFixtureDatabase(dbPath);
  const url=new URL("http://local/api/cycle-breakdown?account=codex-seat&since_ts=2026-08-01T00:00:00Z&until_ts=2026-08-02T00:00:00Z&valuation=dated");
  const context=(sqlite:Database,file:string)=>({sqlite,dbPath:file,accounts:{version:2,subscriptions:[{id:"codex-seat",vendor:"codex"}],sources:[]},
    subIdToHomes:new Map([["codex-seat",["sender-home"]]]),homeToSubId:new Map(),rateCards:null}) as unknown as AppContext;
  let jobs=0;
  const read=createDataRead(()=>({postMessage(){jobs++;},terminate(){},onmessage:null,onerror:null}) as unknown as Worker);
  let recipient:Database|undefined;
  try {
    const ctx=context(sender,dbPath),configuration=storedAnswerConfiguration(ctx,url);
    ensureWindowAnswersSchema(sender);
    const answer={route:url.pathname,key:cacheKey(url),family:"fixture",scope:{provider:"codex",account:"codex-seat",fromMs:Date.parse("2026-08-01"),untilMs:Date.parse("2026-08-02")},
      configuration,checked:0,builtAt:Date.now(),expiresAt:null,status:200,version:"complete",headers:[] as Array<[string,string]>,body:JSON.stringify({totals:{calls:1}})};
    storeWindowAnswers(sender,[answer]);
    expect(windowAnswerIsCurrent(sender,readWindowAnswer(sender,url.pathname,answer.key)!,configuration)).toBe(true);
    expect(publishAtlasSnapshot({dbPath,archiveRoot,poolPath,mode:"manual",requireFreshCopy:true}).status).toBe("created");
    const localDbPath=path.join(root,"recipient.sqlite");
    expect(bootstrapAtlasIndex({localDbPath,archiveRoot,poolPath}).status).toBe("snapshot-installed");
    recipient=openFixtureDatabase(localDbPath);
    const target=context(recipient,localDbPath);
    expect(recipient.query("SELECT COUNT(*) n FROM window_answer_marks").get()).toEqual({n:0});
    const compatible=await read(target,new Request(url));
    expect(compatible.headers.get("X-Analysis")).toBe("stored");expect(await compatible.json()).toEqual({totals:{calls:1}});expect(jobs).toBe(0);
    target.subIdToHomes.set("codex-seat",["recipient-home"]);
    expect(storedAnswerConfiguration(target,url)).not.toBe(configuration);
    const changed=await read(target,new Request(url));
    expect(changed.headers.get("X-Analysis")).toBe("stale");expect(await changed.json()).toEqual({totals:{calls:1}});expect(jobs).toBe(1);
    expect(read.takeAnswersToStore()).toEqual([]);
  } finally {await read.close();recipient?.close(true);sender.close(true);}
});
