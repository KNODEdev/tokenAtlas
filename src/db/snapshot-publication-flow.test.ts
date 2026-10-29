import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "./sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ATLAS_SNAPSHOT_DATABASE_SUFFIX,
  ATLAS_SNAPSHOT_PUBLICATION_LEASE,
  discoverAtlasSnapshotCandidates,
  publishAtlasSnapshot,
  validateAtlasSnapshotFiles,
} from "./snapshot";
import type { StartupUpdate } from "../shared/startup";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function minimalSnapshotDatabase(filePath: string): void {
  const sqlite = new Database(filePath, { create: true });
  try {
    sqlite.exec(`
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER);
      CREATE TABLE meta (key TEXT, value TEXT);
      CREATE TABLE events (home TEXT, path TEXT, ts TEXT, cwd TEXT);
      CREATE TABLE files (home TEXT, path TEXT);
      CREATE TABLE ratelimit (home TEXT, path TEXT, ts TEXT);
      CREATE TABLE claude_events (store TEXT, path TEXT, ts TEXT, cwd TEXT, project TEXT);
      CREATE TABLE claude_files (store TEXT, path TEXT);
      CREATE TABLE oc_events (store TEXT, ts TEXT, directory TEXT, project TEXT);
      CREATE TABLE grok_events (store TEXT, path TEXT, ts TEXT, cwd TEXT, project TEXT);
      CREATE TABLE grok_files (store TEXT, path TEXT);
      CREATE TABLE gemini_events (store TEXT, path TEXT, ts TEXT, workspace TEXT);
      CREATE TABLE gemini_files (store TEXT, path TEXT);
      CREATE TABLE sync_revisions (id INTEGER PRIMARY KEY, data_revision INTEGER, config_revision INTEGER);
      CREATE TABLE vendor_sync_revisions (vendor TEXT PRIMARY KEY, data_revision INTEGER);
      INSERT INTO sync_revisions VALUES (1, 1, 1);
    `);
    for (let id = 1; id <= 14; id += 1) {
      sqlite.run("INSERT INTO __drizzle_migrations VALUES (?, ?, ?)", [id, `migration-${id}`, id]);
    }
    for (const vendor of ["codex", "claude", "opencode", "grok", "gemini"]) {
      sqlite.run("INSERT INTO vendor_sync_revisions VALUES (?, 1)", [vendor]);
    }
  } finally {
    sqlite.close(true);
  }
}

describe("local snapshot publication flow", () => {
  test("backs up committed WAL, preserves free pages and rowids, and excludes an uncommitted write", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-wal-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite");
    minimalSnapshotDatabase(dbPath);
    const source = new Database(dbPath);
    try {
      source.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE retained(value TEXT); CREATE TABLE scratch(value BLOB);
        INSERT INTO retained(rowid,value) VALUES(7,'disk');
        WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1024)
          INSERT INTO scratch SELECT zeroblob(4096) FROM n;
        DELETE FROM scratch; PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO retained(rowid,value) VALUES(29,'committed WAL');
        BEGIN IMMEDIATE; UPDATE retained SET value='uncommitted';`);
      const freePages = source.query("PRAGMA freelist_count").get() as { freelist_count: number };
      expect(freePages.freelist_count).toBeGreaterThan(0);
      const before = fs.readFileSync(dbPath), walBefore = fs.readFileSync(`${dbPath}-wal`);
      let expectedBytes: number | undefined;
      const result = publishAtlasSnapshot({ dbPath, poolPath: path.join(root, "pool"), archiveRoot: root,
        mode: "manual", onProgress(update) {
          if (update.phase === "snapshot-copy") expectedBytes = update.snapshotTotalBytes;
        } });
      expect(result.status).toBe("created");
      expect(expectedBytes).toBe(result.manifest!.sizeBytes);
      const copy = new Database(result.databasePath!, { readonly: true });
      try {
        expect(copy.query("SELECT rowid,value FROM retained ORDER BY rowid").all()).toEqual([
          { rowid: 7, value: "disk" }, { rowid: 29, value: "committed WAL" },
        ]);
        expect(copy.query("PRAGMA freelist_count").get()).toEqual(freePages);
        expect(copy.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
        expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally { copy.close(true); }
      for (const suffix of ["-wal", "-shm", "-journal"])
        expect(fs.existsSync(`${result.databasePath}${suffix}`)).toBe(false);
      expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
      expect(fs.readFileSync(`${dbPath}-wal`).equals(walBefore)).toBe(true);
      source.exec("ROLLBACK");
    } finally { source.close(true); }
  });

  test("reports copy, validation, checksum and publication in their actual order", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-progress-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite");
    minimalSnapshotDatabase(dbPath);
    const stages: string[] = [];
    const checksumProgress: StartupUpdate[] = [];
    let expectedBytes: number | undefined;
    const result = publishAtlasSnapshot({ dbPath, poolPath: path.join(root, "pool"), archiveRoot: root,
      mode: "manual", onProgress(update) {
        if (stages.at(-1) !== update.phase) stages.push(update.phase);
        if (update.phase === "snapshot-checksum" && update.snapshotProcessedBytes != null) checksumProgress.push(update);
        if (update.phase === "snapshot-copy") expectedBytes = update.snapshotTotalBytes;
        if (update.phase === "snapshot-validation" || update.phase === "snapshot-checksum")
          expect(fs.statSync(update.snapshotFile!).size).toBeGreaterThan(0);
      },
    });
    expect(result.status).toBe("created");
    expect(stages).toEqual(["snapshot-wait", "snapshot-copy", "snapshot-validation", "snapshot-checksum", "snapshot-publication", "snapshot-retention"]);
    // Backup retains all source pages, including free ones.
    expect(expectedBytes).toBe(result.manifest!.sizeBytes);
    expect(checksumProgress[0]?.snapshotProcessedBytes).toBe(0);
    expect(checksumProgress.at(-1)?.snapshotProcessedBytes).toBe(result.manifest!.sizeBytes);
    expect(checksumProgress.every((update, index) => update.snapshotTotalBytes === result.manifest!.sizeBytes
      && (index === 0 || update.snapshotProcessedBytes! >= checksumProgress[index - 1]!.snapshotProcessedBytes!))).toBe(true);
  });

  test("creates a fresh safety copy without a full integrity scan and retains full restore validation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-fresh-checks-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite");
    minimalSnapshotDatabase(dbPath);
    const queries: string[] = [];
    const original = Database.prototype.prepare;
    const spy = spyOn(Database.prototype, "prepare").mockImplementation((function (
      this: Database, ...args: Parameters<Database["prepare"]>
    ) {
      queries.push(args[0]);
      return Reflect.apply(original, this, args);
    }) as Database["prepare"]);
    try {
      const result = publishAtlasSnapshot({ dbPath, poolPath: path.join(root, "pool"), archiveRoot: root,
        mode: "manual", requireFreshCopy: true });
      expect(result.status).toBe("created");
      expect(queries.some(sql => /PRAGMA\s+(integrity_check|quick_check|foreign_key_check)/i.test(sql))).toBe(false);
      expect(queries.filter(sql => /^SELECT COUNT\(\*\) AS n FROM \"(?:events|claude_events|oc_events|grok_events|gemini_events)\"$/.test(sql))).toHaveLength(5);
      queries.length = 0;
      expect(validateAtlasSnapshotFiles(result.databasePath!, result.manifest!).valid).toBe(true);
      expect(queries.some(sql => /PRAGMA\s+integrity_check/i.test(sql))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  test("publishes a pre-migration file copy without starting SQLite's backup process", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-os-copy-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite");
    minimalSnapshotDatabase(dbPath);
    const spy = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("SQLite backup must not run"); });
    try {
      const result = publishAtlasSnapshot({ dbPath, poolPath: path.join(root, "pool"), archiveRoot: root,
        mode: "manual", requireFreshCopy: true, copyMethod: "file" });
      expect(result.status).toBe("created");
      expect(validateAtlasSnapshotFiles(result.databasePath!, result.manifest!).valid).toBe(true);
    } finally { spy.mockRestore(); }
  });

  test("keeps the previous snapshot and removes partial backup files when the backup process fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-backup-failure-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite"), poolPath = path.join(root, "pool");
    minimalSnapshotDatabase(dbPath);
    const options = { dbPath, poolPath, archiveRoot: root, mode: "manual" as const, requireFreshCopy: true };
    const previous = publishAtlasSnapshot(options);
    const original = Bun.spawnSync;
    const spy = spyOn(Bun, "spawnSync").mockImplementation(((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = args[0] as string[];
      if (command[1]?.endsWith("snapshot-backup.ts")) {
        for (const suffix of ["", "-journal", "-wal", "-shm"])
          fs.writeFileSync(`${command[3]}${suffix}`, "partial");
        return { exitCode: 1, stderr: Buffer.from("injected backup failure") } as ReturnType<typeof Bun.spawnSync>;
      }
      return Reflect.apply(original, Bun, args);
    }) as typeof Bun.spawnSync);
    try {
      expect(() => publishAtlasSnapshot(options)).toThrow("SQLite snapshot backup failed: injected backup failure");
    } finally { spy.mockRestore(); }
    expect(fs.readdirSync(poolPath).some(name => name.includes(".tmp-"))).toBe(false);
    expect(discoverAtlasSnapshotCandidates(poolPath).map(candidate => [candidate.snapshotId, candidate.valid]))
      .toEqual([[previous.snapshotId!, true]]);
  });

  test("removes the older copy without hashing or integrity-checking it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-retention-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite"), poolPath = path.join(root, "pool");
    minimalSnapshotDatabase(dbPath);
    const older = publishAtlasSnapshot({ dbPath, poolPath, archiveRoot: root, mode: "manual",
      now: new Date("2026-10-18T12:00:00Z") });
    // Same size, different bytes: a full validation would reject it and keep it.
    const bytes = fs.readFileSync(older.databasePath!);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    fs.writeFileSync(older.databasePath!, bytes);
    const original = Database.prototype.prepare;
    const retentionQueries: string[] = [];
    let retaining = false;
    const spy = spyOn(Database.prototype, "prepare").mockImplementation((function (
      this: Database, ...args: Parameters<Database["prepare"]>
    ) {
      if (retaining) retentionQueries.push(String(args[0]));
      return Reflect.apply(original, this, args);
    }) as Database["prepare"]);
    let newer;
    try {
      newer = publishAtlasSnapshot({ dbPath, poolPath, archiveRoot: root, mode: "manual", requireFreshCopy: true,
        now: new Date("2026-10-19T12:00:00Z"), onProgress(update) { retaining = update.phase === "snapshot-retention"; } });
    } finally {
      spy.mockRestore();
    }
    expect(newer.status).toBe("created");
    // The lease release follows retention; no integrity pass or probe-fact read runs on the older copy.
    expect(retentionQueries.filter((sql) => /integrity_check|quick_check|probe/i.test(sql))).toEqual([]);
    expect(fs.existsSync(older.databasePath!)).toBe(false);
    expect(fs.existsSync(older.manifestPath!)).toBe(false);
    expect(discoverAtlasSnapshotCandidates(poolPath).map((candidate) => `${candidate.snapshotId}:${candidate.valid}`))
      .toEqual([`${newer.snapshotId}:true`]);
  });

  for (const stage of ["afterClaimAcquired", "afterDatabaseRename"] as const) {
    test(`recovers immediately after a publisher exits at ${stage}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-abandoned-"));
      roots.push(root);
      const dbPath = path.join(root, "atlas.sqlite"), poolPath = path.join(root, "pool");
      minimalSnapshotDatabase(dbPath);
      const moduleUrl = pathToFileURL(path.join(import.meta.dir, "snapshot.ts")).href;
      const script = path.join(root, "publisher.ts");
      fs.writeFileSync(script, `import { publishAtlasSnapshot } from ${JSON.stringify(moduleUrl)};
        publishAtlasSnapshot({ dbPath: ${JSON.stringify(dbPath)}, poolPath: ${JSON.stringify(poolPath)},
          archiveRoot: ${JSON.stringify(root)}, mode: "manual",
          failpoints: { ${stage}() { process.exit(17); } } });`);
      const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect({ code, stdout, stderr }).toEqual({ code: 17, stdout: "", stderr: "" });
      const lease = new Database(path.join(poolPath, ATLAS_SNAPSHOT_PUBLICATION_LEASE), { readonly: true });
      try {
        const row = lease.query("SELECT token, renewed_at FROM publication_lease WHERE id=1").get() as {
          token: string; renewed_at: number;
        };
        expect(JSON.parse(row.token).ownerPid).toBe(child.pid);
        expect(Date.now() - row.renewed_at).toBeLessThan(30 * 60_000);
      } finally { lease.close(true); }
      const result = publishAtlasSnapshot({ dbPath, poolPath, archiveRoot: root, mode: "manual", lockTimeoutMs: 100 });
      expect(result).toMatchObject({ status: "created", leaseLostAfterCommit: false, validation: { valid: true } });
      expect(discoverAtlasSnapshotCandidates(poolPath).filter(candidate => candidate.valid)).toHaveLength(1);
    });
  }

  test("keeps a live process's claim and reports its owner instead of stealing it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-live-owner-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite"), poolPath = path.join(root, "pool");
    minimalSnapshotDatabase(dbPath);
    const options = { dbPath, poolPath, archiveRoot: root, mode: "manual" as const };
    const result = publishAtlasSnapshot({ ...options, failpoints: { afterClaimAcquired(token) {
      expect(() => publishAtlasSnapshot({ ...options, lockTimeoutMs: 20 }))
        .toThrow(`publisher PID ${process.pid}`);
      const lease = new Database(path.join(poolPath, ATLAS_SNAPSHOT_PUBLICATION_LEASE), { readonly: true });
      try {
        expect(lease.query("SELECT token FROM publication_lease WHERE id=1").get()).toEqual({ token });
      } finally { lease.close(true); }
    } } });
    expect(result.status).toBe("created");
  });

  test("preserves a legacy claim until expiry, then recovers it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-legacy-owner-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite"), poolPath = path.join(root, "pool");
    minimalSnapshotDatabase(dbPath);
    fs.mkdirSync(poolPath);
    const lease = new Database(path.join(poolPath, ATLAS_SNAPSHOT_PUBLICATION_LEASE), { create: true });
    try {
      lease.exec("CREATE TABLE publication_lease (id INTEGER PRIMARY KEY, token TEXT NOT NULL, renewed_at INTEGER NOT NULL)");
      lease.query("INSERT INTO publication_lease VALUES (1, ?, ?)").run(crypto.randomUUID(), Date.now());
      const options = { dbPath, poolPath, archiveRoot: root, mode: "manual" as const, lockTimeoutMs: 20 };
      expect(() => publishAtlasSnapshot(options)).toThrow("Timed out waiting for the Atlas snapshot publication lease");
      expect(lease.query("SELECT COUNT(*) AS n FROM publication_lease").get()).toEqual({ n: 1 });
      lease.query("UPDATE publication_lease SET renewed_at=?").run(Date.now() - 31 * 60_000);
      expect(publishAtlasSnapshot(options).status).toBe("created");
    } finally { lease.close(true); }
  });

  test("releases evicted query handles before publishing or cleaning up a snapshot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-snapshot-handles-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite");
    minimalSnapshotDatabase(dbPath);
    const original = Database.prototype.query;
    const statements: Array<ReturnType<Database["query"]>> = [];
    const visited = new WeakSet<Database>();
    const spy = spyOn(Database.prototype, "query").mockImplementation((function (
      this: Database, ...args: Parameters<Database["query"]>
    ) {
      if (!visited.has(this)) {
        visited.add(this);
        // Exceed Bun's query cache, as the current schema's validators do.
        for (let i = 0; i < 40; i++) statements.push(this.query(`SELECT ${i} AS cache_pressure`));
      }
      return Reflect.apply(original, this, args);
    }) as Database["query"]);
    try {
      const options = { dbPath, poolPath: path.join(root, "pool"), archiveRoot: root, mode: "manual" as const };
      expect(publishAtlasSnapshot(options).status).toBe("created");
      expect(statements.every(statement => statement.toString() === "")).toBe(true);
      const failedPool = path.join(root, "failed-pool");
      expect(() => publishAtlasSnapshot({ ...options, poolPath: failedPool,
        failpoints: { afterPreCommitRenewal: () => { throw new Error("injected failure"); } },
      })).toThrow("injected failure");
      expect(statements.every(statement => statement.toString() === "")).toBe(true);
      expect(fs.readdirSync(failedPool).some(name => name.includes(".tmp-"))).toBe(false);
    } finally {
      spy.mockRestore();
      for (const statement of statements) statement.finalize();
    }
  });

  test("checks unchanged and daily gates before copying and scavenges only stale temporary files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-local-snapshot-"));
    roots.push(root);
    const dbPath = path.join(root, "atlas.sqlite");
    const archiveRoot = path.join(root, "archive");
    const poolPath = path.join(root, "snapshots");
    minimalSnapshotDatabase(dbPath);

    const first = publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-09-10T10:00:00Z"),
    });
    expect(first.status).toBe("created");

    const rejectCopy = () => { throw new Error("database copy should have been skipped"); };
    expect(publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-09-10T11:00:00Z"),
      failpoints: { beforeDatabaseCopy: rejectCopy },
    })).toMatchObject({ status: "reused", reason: "identical-snapshot" });

    const source = new Database(dbPath);
    source.exec("UPDATE sync_revisions SET data_revision = 2 WHERE id = 1");
    source.close(true);
    expect(publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "automatic",
      now: new Date("2026-09-10T12:00:00Z"),
      failpoints: { beforeDatabaseCopy: rejectCopy },
    })).toMatchObject({ status: "skipped", reason: "daily-limit" });

    const stale = path.join(poolPath, `stale${ATLAS_SNAPSHOT_DATABASE_SUFFIX}.tmp-old`);
    const fresh = path.join(poolPath, `fresh${ATLAS_SNAPSHOT_DATABASE_SUFFIX}.tmp-active`);
    fs.writeFileSync(stale, "stale");
    fs.writeFileSync(fresh, "fresh");
    fs.utimesSync(stale, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
    fs.utimesSync(fresh, new Date("2026-09-11T09:50:00Z"), new Date("2026-09-11T09:50:00Z"));

    expect(publishAtlasSnapshot({
      dbPath,
      archiveRoot,
      poolPath,
      mode: "manual",
      now: new Date("2026-09-11T10:00:00Z"),
    }).status).toBe("created");
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    // Retention keeps the publication it just protected and nothing else.
    expect(discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid)).toHaveLength(1);
  });
});
