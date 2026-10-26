import { afterEach, describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Database } from "./sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { USAGE_VENDOR_IDS, type UsageVendorId } from "../sync/contracts";
import type {
  AtlasIndexSnapshotManifest,
  AtlasSnapshotPublishResult,
  PublishAtlasSnapshotOptions,
} from "./snapshot";
import { migrationCliTarget, snapshotBeforePendingMigrations } from "./migrate";

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function migrationDatabase(version: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-migration-snapshot-"));
  created.push(root);
  const dbPath = path.join(root, "atlas.sqlite");
  const sqlite = new Database(dbPath, { create: true });
  try {
    sqlite.exec("CREATE TABLE __drizzle_migrations (hash TEXT NOT NULL, created_at INTEGER NOT NULL)");
    const insert = sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
    for (let index = 0; index <= version; index += 1) insert.run(`hash-${index}`, index);
    insert.finalize();
  } finally {
    sqlite.close(true);
  }
  return dbPath;
}

/** A created result whose files exist beside the fixture database. */
function createdSnapshot(dbPath: string, schemaVersion: number): AtlasSnapshotPublishResult {
  const snapshotId = `fresh-${schemaVersion}`;
  const databasePath = path.join(path.dirname(dbPath), `${snapshotId}.atlas.sqlite`);
  const manifestPath = path.join(path.dirname(dbPath), `${snapshotId}.atlas-manifest.json`);
  const zeros = Object.fromEntries(USAGE_VENDOR_IDS.map((vendor) => [vendor, 0])) as Record<UsageVendorId, number>;
  const manifest: AtlasIndexSnapshotManifest = {
    manifestVersion: 2,
    kind: "tokenatlas-index",
    snapshotId,
    schemaVersion,
    revisions: { data: 0, config: 0, derived: 0 },
    vendorDataRevisions: zeros,
    sourceArchiveRoot: "archive",
    sourceMachine: "test",
    createdAt: "2026-09-24T00:00:00.000Z",
    sizeBytes: 0,
    checksum: { algorithm: "sha256", value: "0".repeat(64) },
    vendorRowCounts: zeros,
    identityFingerprint: "0".repeat(64),
  };
  fs.writeFileSync(databasePath, "");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    status: "created",
    reason: null,
    snapshotId,
    databasePath,
    manifestPath,
    manifest,
    validation: { valid: true, compatible: true, manifest, errors: [] },
    leaseLostAfterCommit: false,
  };
}

const reused: AtlasSnapshotPublishResult = {
  status: "reused",
  reason: "identical-snapshot",
  snapshotId: "existing",
  databasePath: null,
  manifestPath: null,
  manifest: null,
  validation: null,
  leaseLostAfterCommit: false,
};

describe("pre-migration snapshot policy", () => {
  test.each([86, 87, 88, 89, 90])("the reviewed context upgrade from %s through 0091 skips the full copy", (version) => {
    expect(snapshotBeforePendingMigrations(migrationDatabase(version), { targetSchemaVersion: 91, publish: () => {
      throw new Error("The non-destructive context upgrade must not copy historical data");
    } })).toBeNull();
  });

  test("an earlier unlisted migration still requires a copy before the context additions", () => {
    const dbPath = migrationDatabase(84), snapshot = createdSnapshot(dbPath, 84);
    const updates: unknown[] = [];
    expect(snapshotBeforePendingMigrations(dbPath, { targetSchemaVersion: 91, publish: () => snapshot,
      onProgress: (update) => updates.push(update) })).toBe(snapshot);
    expect(updates).toEqual([{ phase: "snapshot-wait", snapshotMigrations: ["0085_activity_intervals"] }]);
  });

  test("the actual 0081–0084 upgrade skips a full copy because it only adds tables, indexes and nullable metadata", () => {
    const dbPath = migrationDatabase(80);
    expect(snapshotBeforePendingMigrations(dbPath, { targetSchemaVersion: 84, publish: () => {
      throw new Error("The additive 0081–0084 upgrade must not copy historical data");
    } })).toBeNull();
  });

  test("explains a safety snapshot failure without claiming database corruption", () => {
    const dbPath = migrationDatabase(25);
    const failure = new Error("Timed out waiting for the Atlas snapshot publication lease");
    const attempt = () => snapshotBeforePendingMigrations(dbPath, {
      targetSchemaVersion: 26, publish: () => { throw failure; },
    });
    expect(attempt).toThrow("Pre-migration snapshot failed: Timed out waiting for the Atlas snapshot publication lease No migration was applied.");
    try { attempt(); } catch (error) { expect((error as Error).cause).toBe(failure); }
    const db = new Database(dbPath, { readonly: true });
    try { expect((db.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(26); }
    finally { db.close(true); }
  });

  test("0085 queues historical activity preparation behind the existing snapshot policy", () => {
    const dbPath = migrationDatabase(84), snapshot = createdSnapshot(dbPath, 84);
    let copies = 0;
    const updates: unknown[] = [];
    expect(snapshotBeforePendingMigrations(dbPath, { targetSchemaVersion: 85, onProgress: (update) => updates.push(update),
      publish: () => { copies++; return snapshot; } })).toBe(snapshot);
    expect(copies).toBe(1);
    // The startup screen names the migration that requires the copy.
    expect(updates).toEqual([{ phase: "snapshot-wait", snapshotMigrations: ["0085_activity_intervals"] }]);
  });

  test("names only the non-additive pending migrations as the reason for the copy", () => {
    const dbPath = migrationDatabase(83), snapshot = createdSnapshot(dbPath, 83);
    const updates: unknown[] = [];
    snapshotBeforePendingMigrations(dbPath, { targetSchemaVersion: 85, onProgress: (update) => updates.push(update),
      publish: () => snapshot });
    expect(updates).toEqual([{ phase: "snapshot-wait", snapshotMigrations: ["0085_activity_intervals"] }]);
  });

  test("publishes a forced fresh copy only when a compatible database has a pending schema migration", () => {
    const pending = migrationDatabase(25);
    const snapshot = createdSnapshot(pending, 25);
    const calls: PublishAtlasSnapshotOptions[] = [];
    const publish = (options: PublishAtlasSnapshotOptions) => {
      calls.push(options);
      return snapshot;
    };

    expect(snapshotBeforePendingMigrations(pending, {
      targetSchemaVersion: 26,
      publish,
    })).toBe(snapshot);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ dbPath: pending, mode: "manual", currentSchemaVersion: 26, requireFreshCopy: true });

    expect(snapshotBeforePendingMigrations(pending, {
      targetSchemaVersion: 25,
      publish,
    })).toBeNull();
    expect(() => snapshotBeforePendingMigrations(migrationDatabase(12), {
      targetSchemaVersion: 26,
      publish,
    })).toThrow("predates the oldest supported snapshot");
    expect(calls).toHaveLength(1);
  });

  test("refuses an existing database without migration history before destructive DDL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-migration-no-history-"));
    created.push(root);
    const dbPath = path.join(root, "atlas.sqlite");
    const sqlite = new Database(dbPath, { create: true });
    sqlite.exec("CREATE TABLE old_data(id INTEGER PRIMARY KEY)");
    sqlite.close(true);
    expect(() => snapshotBeforePendingMigrations(dbPath, { targetSchemaVersion: 26 }))
      .toThrow("an existing database has no migration history");
    expect(snapshotBeforePendingMigrations(path.join(root, "missing.sqlite"), { targetSchemaVersion: 26 })).toBeNull();
  });

  test("CLI selects Settings unless a different database is named explicitly", () => {
    const selected = path.resolve("selected.sqlite");
    const copy = path.resolve("copy.sqlite");
    expect(migrationCliTarget([], selected, selected)).toBe(selected);
    expect(() => migrationCliTarget([], selected, copy)).toThrow("TOKENATLAS_DB differs");
    expect(migrationCliTarget(["--db", copy], selected, selected)).toBe(copy);
    expect(migrationCliTarget(["--counts", "--db", copy], selected, selected)).toBe(copy);
    expect(() => migrationCliTarget(["--db"], selected, selected)).toThrow("Usage:");
  });

  test("skips the snapshot only when every pending migration is declared additive", () => {
    const migrations = readMigrationFiles({ migrationsFolder: path.resolve(import.meta.dir, "../../drizzle") });
    const pending = migrationDatabase(25);
    const snapshot = createdSnapshot(pending, 25);
    let published = 0;
    const publish = () => {
      published += 1;
      return snapshot;
    };
    const first = migrations[26]!.folderMillis;
    const second = migrations[27]!.folderMillis;

    expect(snapshotBeforePendingMigrations(pending, {
      targetSchemaVersion: 27,
      additiveMigrations: new Set([first, second]),
      publish,
    })).toBeNull();
    expect(published).toBe(0);

    expect(snapshotBeforePendingMigrations(pending, {
      targetSchemaVersion: 27,
      additiveMigrations: new Set([second]),
      publish,
    })).toBe(snapshot);
    expect(snapshotBeforePendingMigrations(pending, {
      targetSchemaVersion: migrations.length,
      additiveMigrations: new Set(migrations.map((migration) => migration.folderMillis)),
      publish,
    })).toBe(snapshot);
    expect(published).toBe(2);
  });

  test("refuses every result other than a newly created, verified snapshot of the installed schema", () => {
    const pending = migrationDatabase(25);
    const attempt = (result: AtlasSnapshotPublishResult | null) => () => snapshotBeforePendingMigrations(pending, {
      targetSchemaVersion: 26,
      publish: () => result as AtlasSnapshotPublishResult,
    });
    const good = createdSnapshot(pending, 25);
    const aborted: AtlasSnapshotPublishResult = { ...reused, status: "aborted", reason: "lease-lost", snapshotId: null };
    const skipped: AtlasSnapshotPublishResult = { ...reused, status: "skipped", reason: "daily-limit" };

    expect(attempt(null)).toThrow("Pre-migration snapshot rejected: the publisher returned no result");
    expect(attempt(aborted)).toThrow('got status "aborted" (lease-lost). No migration was applied.');
    expect(attempt(reused)).toThrow('got status "reused" (identical-snapshot)');
    expect(attempt(skipped)).toThrow('got status "skipped" (daily-limit)');
    expect(attempt({ ...good, leaseLostAfterCommit: true })).toThrow("publication lease was lost");
    expect(attempt({ ...good, manifestPath: null })).toThrow("missing its id, files or manifest");
    expect(attempt({ ...good, manifest: null })).toThrow("missing its id, files or manifest");
    expect(attempt({ ...good, validation: null })).toThrow("no validation result");
    expect(attempt({ ...good, validation: { ...good.validation!, valid: false, errors: ["snapshot checksum does not match its manifest"] } }))
      .toThrow("failed validation: snapshot checksum does not match its manifest");
    expect(attempt({ ...good, validation: { ...good.validation!, compatible: false } })).toThrow("failed validation");
    expect(attempt({ ...good, snapshotId: "other" })).toThrow("carries the manifest of fresh-25");
    expect(attempt(createdSnapshot(pending, 24))).toThrow("has schema 24, the database has 25");

    fs.rmSync(good.databasePath!);
    expect(attempt(good)).toThrow(`snapshot ${good.snapshotId} files are missing`);
  });
});
