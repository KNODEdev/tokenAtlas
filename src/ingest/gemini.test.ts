import { describe, expect, it } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { archiveLogical } from "../config/paths";
import { createTestDatabase } from "../sync/test-support";
import { persistedGeminiStores, storeForGeminiProfile, ingestGeminiAsync } from "./gemini";
import { removeTestFixture } from "../test-cleanup";

describe("Gemini physical profile identity", () => {
  it("keeps profiles separate without assigning an account", () => {
    expect(storeForGeminiProfile("EXAMPLE-MAIN-sample_a")).toEqual({store:"source:gemini:EXAMPLE-MAIN-sample_a",account:null});
    expect(storeForGeminiProfile("Case").store).not.toBe(storeForGeminiProfile("case").store);
    expect(storeForGeminiProfile("PC-user","agy-old")).toEqual({store:"agy-old",account:null});
    expect(()=>storeForGeminiProfile("../escape")).toThrow("Invalid Gemini");
  });

  it("discovers archive homes independently of account declarations", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-gemini-discovery-"));
    try {
      const archiveRoot = path.join(temp, "ArchiveRoot");
      const mappedProfile = "Mapped-Profile";
      const unmappedProfile = "Unmapped-Profile";
      fs.mkdirSync(path.join(archiveRoot, "gemini", mappedProfile, "conversations"), { recursive: true });
      fs.mkdirSync(path.join(archiveRoot, "gemini", unmappedProfile, "conversations"), { recursive: true });
      const runner = path.join(temp, "discover.ts");
      const geminiModule = pathToFileURL(path.join(import.meta.dir, "gemini.ts")).href;
      fs.writeFileSync(
        runner,
        `import { discoverStores } from ${JSON.stringify(geminiModule)};\n` +
          `process.stdout.write(JSON.stringify(discoverStores()));\n`,
        "utf-8",
      );

      const child = Bun.spawnSync({
        cmd: [process.execPath, runner],
        env: {
          ...process.env,
          TOKENATLAS_ARCHIVE: archiveRoot,
          TOKENATLAS_MACHINE: "NO-LIVE",
          TOKENATLAS_LOGIN: "nobody",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = child.stdout.toString();
      const stderr = child.stderr.toString();
      expect(child.exitCode, stderr).toBe(0);
      const stores = JSON.parse(stdout) as Array<{ dir: string; store: string }>;
      expect(stores.map((store) => ({ profile: path.basename(path.dirname(store.dir)), store: store.store }))).toEqual([
        { profile: mappedProfile, store: "source:gemini:Mapped-Profile" },
        { profile: unmappedProfile, store: "source:gemini:Unmapped-Profile" },
      ]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reassigns an unchanged physical source from main without duplicating its history", async () => {
    const created = createTestDatabase();
    try {
      const conversations = path.join(created.directory, "conversations");
      const conversation = path.join(conversations, "conversation.db");
      fs.mkdirSync(conversations, { recursive: true });
      const source = new Database(conversation, { create: true });
      source.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      source.close();
      const stat = fs.statSync(conversation);
      const atlas = new Database(created.dbPath);
      atlas
        .query(
          `INSERT INTO gemini_events
             (store, conversation_id, gen_idx, ts, ts_basis, path, fresh_in, project_id)
           VALUES ('main', 'conversation', 0, '2026-01-10T10:00:00.000Z', 'conversation', ?, 123, 'project-1')`
        )
        .run(conversation);
      atlas
        .query(
          `INSERT INTO gemini_files (store, path, size, mtime, generations, ingested_at)
           VALUES ('main', ?, ?, ?, 1, '2026-01-10T10:00:00.000Z')`
        )
        .run(conversation, stat.size, stat.mtimeMs);
      const before = atlas.query("SELECT COUNT(*) AS count, SUM(fresh_in) AS tokens FROM gemini_events").get() as {
        count: number;
        tokens: number;
      };
      atlas.close();

      const result = (await ingestGeminiAsync(conversations, "agy1", { archivedInput: true,
        atlasPath: created.dbPath,
        rootDir: process.cwd(),
      }));

      const verified = new Database(created.dbPath, { readonly: true });
      const after = verified.query("SELECT COUNT(*) AS count, SUM(fresh_in) AS tokens FROM gemini_events").get() as {
        count: number;
        tokens: number;
      };
      const events = verified
        .query("SELECT store, project_id FROM gemini_events ORDER BY id")
        .all() as Array<{ store: string; project_id: string | null }>;
      const files = verified.query("SELECT store FROM gemini_files ORDER BY store").all() as Array<{ store: string }>;
      verified.close();

      expect(result.skipped).toBe(1);
      expect(result.reassigned).toBe(1);
      expect(result.generations).toBe(0);
      expect(result.dirtyRange).toEqual({
        from: "2026-01-10T10:00:00.000Z",
        to: "2026-01-10T10:00:00.000Z",
      });
      expect(after).toEqual(before);
      expect(events).toEqual([{ store: "agy1", project_id: "project-1" }]);
      expect(files).toEqual([{ store: "agy1" }]);
    } finally {
      try {
        fs.rmSync(created.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
      }
    }
  });
  for (const authoritativeStore of ["main", "agy1", "older-profile"]) {
    it(`uses only the current ${authoritativeStore} history across colliding store labels`, async () => {
      const created = createTestDatabase();
      try {
        const conversations = path.join(created.directory, "conversations");
        fs.mkdirSync(conversations);
        const file = path.join(conversations, "collision.db");
        const source = new Database(file, { create: true });
        source.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
        source.close();
        const stat = fs.statSync(file);
        const atlas = new Database(created.dbPath);
        for (const candidate of ["agy1", "main", "older-profile"]) {
          const current = candidate === authoritativeStore;
          atlas.query(`INSERT INTO gemini_files (store, path, size, mtime, generations, ingested_at)
            VALUES (?, ?, ?, ?, ?, 'fixture')`).run(candidate, file, stat.size + (current ? 0 : 1), stat.mtimeMs, 2);
          atlas.query(`INSERT INTO gemini_events
            (store, conversation_id, gen_idx, ts, ts_basis, path, fresh_in, project_id)
            VALUES (?, 'collision', 0, '2026-01-10T10:00:00.000Z', 'conversation', ?, ?, ?)`)
            .run(candidate, file, current ? 123 : 10, candidate === "agy1" ? "target-project" : null);
          atlas.query(`INSERT INTO gemini_events
            (store, conversation_id, gen_idx, ts, ts_basis, path, fresh_in, project_id)
            VALUES (?, 'collision', ?, '2026-02-12T11:00:00.000Z', 'conversation', ?, ?, ?)`)
            .run(candidate, current ? 1 : 99, file, current ? 456 : 999, current ? "source-project" : "stale-project");
        }
        atlas.close();
        const result = (await ingestGeminiAsync(conversations, "agy1", { archivedInput: true, atlasPath: created.dbPath }));
        expect(result).toMatchObject({ skipped: 1, reassigned: 1, generations: 0,
          dirtyRange: { from: "2026-01-10T10:00:00.000Z", to: "2026-02-12T11:00:00.000Z" } });
        const check = new Database(created.dbPath, { readonly: true });
        expect(check.query("SELECT store, gen_idx, fresh_in, project_id FROM gemini_events ORDER BY gen_idx").all()).toEqual([
          { store: "agy1", gen_idx: 0, fresh_in: 123, project_id: "target-project" },
          { store: "agy1", gen_idx: 1, fresh_in: 456, project_id: "source-project" },
        ]);
        expect(check.query("SELECT store, generations FROM gemini_files").all()).toEqual([{ store: "agy1", generations: 2 }]);
        check.close();
        expect((await ingestGeminiAsync(conversations, "agy1", { archivedInput: true, atlasPath: created.dbPath })))
          .toMatchObject({ skipped: 1, reassigned: 0, generations: 0, dirtyRange: null });
      } finally {
        try {
          fs.rmSync(created.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (error) {
          // Bun may retain a Windows SQLite handle until process teardown.
          if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
        }
      }
    });
  }

  it("reparses ambiguous matching histories while retaining the target annotation", async () => {
    const created = createTestDatabase();
    try {
      const conversations = path.join(created.directory, "conversations");
      fs.mkdirSync(conversations);
      const file = path.join(conversations, "ambiguous.db");
      const source = new Database(file, { create: true });
      source.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      // Nested protobuf .1.4.2 contains fresh input tokens.
      source.query("INSERT INTO gen_metadata VALUES (0, ?)").run(new Uint8Array([10, 4, 34, 2, 16, 123]));
      source.close();
      const stat = fs.statSync(file);
      const atlas = new Database(created.dbPath);
      for (const candidate of ["main", "agy1"]) {
        atlas.query(`INSERT INTO gemini_files (store, path, size, mtime, generations, ingested_at)
          VALUES (?, ?, ?, ?, 1, 'fixture')`).run(candidate, file, stat.size, stat.mtimeMs);
        atlas.query(`INSERT INTO gemini_events
          (store, conversation_id, gen_idx, ts, ts_basis, path, fresh_in, project_id)
          VALUES (?, 'ambiguous', 0, '2026-01-10T10:00:00.000Z', 'conversation', ?, ?, ?)`)
          .run(candidate, file, candidate === "main" ? 10 : 20, candidate === "agy1" ? "target-project" : null);
      }
      atlas.close();
      expect((await ingestGeminiAsync(conversations, "agy1", { archivedInput: true, atlasPath: created.dbPath })))
        .toMatchObject({ files: 1, skipped: 0, generations: 1 });
      const check = new Database(created.dbPath, { readonly: true });
      expect(check.query("SELECT store, fresh_in, project_id FROM gemini_events").all())
        .toEqual([{ store: "agy1", fresh_in: 123, project_id: "target-project" }]);
      check.close();
    } finally {
      try {
        fs.rmSync(created.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (error) {
        // Bun may retain a Windows SQLite handle until process teardown.
        if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      }
    }
  });

});

it("unchanged Gemini files retain bookmark values and conflict checks cover the accepted database", async () => {
  const accepted=createTestDatabase(),stage=createTestDatabase();
  const directory=path.join(accepted.directory,"conversations"),file=path.join(directory,"chat.db");
  fs.mkdirSync(directory);
  const source=new Database(file);
  source.exec("CREATE TABLE gen_metadata(idx INTEGER,data BLOB)");
  source.query("INSERT INTO gen_metadata VALUES(0,?)").run(new Uint8Array([10,4,34,2,16,123]));source.close();
  const db=new Database(accepted.dbPath);
  try {
    (await ingestGeminiAsync(directory,"fixture",{ archivedInput: true,atlasPath:accepted.dbPath}));
    db.exec("UPDATE gemini_files SET ingested_at='retained'; CREATE TABLE writes(value INTEGER); CREATE TRIGGER bookmark_write AFTER UPDATE ON gemini_files BEGIN INSERT INTO writes VALUES(1); END");
    const bookmark=db.query("SELECT * FROM gemini_files").get();
    expect((await ingestGeminiAsync(directory,"fixture",{ archivedInput: true,atlasPath:accepted.dbPath}))).toMatchObject({files:0,skipped:1});
    expect(db.query("SELECT * FROM gemini_files").get()).toEqual(bookmark);
    expect(db.query("SELECT * FROM writes").all()).toEqual([]);
    db.query("UPDATE gemini_events SET path='conflicting.db'").run();
    await expect(ingestGeminiAsync(directory,"fixture",{ archivedInput: true,atlasPath:stage.dbPath,sourceAtlasPath:accepted.dbPath,force:true})).rejects.toThrow("source identity conflicts");
    const check=new Database(stage.dbPath);
    try {expect(check.query("SELECT * FROM gemini_events").all()).toEqual([]);}finally{check.close();}
    expect(db.query("SELECT path,fresh_in FROM gemini_events").get()).toEqual({path:"conflicting.db",fresh_in:123});
  } finally {db.close();for(const f of [accepted,stage])removeTestFixture(f.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

it("reuses the persisted store for a profile and refuses conflicting history", () => {
  const created = createTestDatabase();
  try {
    const db = new Database(created.dbPath);
    const file = archiveLogical("gemini", "PC-user", "conversations", "a.db");
    db.query("INSERT INTO gemini_files(store,path,size,mtime,generations,ingested_at) VALUES(?,?,?,?,?,?)")
      .run("old-account-label",file,1,1,1,"2026-01-01T00:00:00Z");
    db.close();
    const known = persistedGeminiStores(created.dbPath,["PC-user"]);
    expect(storeForGeminiProfile("PC-user",known.get("PC-user")).store).toBe("old-account-label");
    const second = new Database(created.dbPath);
    second.query("INSERT INTO gemini_files(store,path,size,mtime,generations,ingested_at) VALUES(?,?,?,?,?,?)")
      .run("conflicting-label",archiveLogical("gemini", "PC-user", "conversations", "b.db"),1,1,1,"2026-01-01T00:00:00Z");
    second.close();
    expect(() => persistedGeminiStores(created.dbPath,["PC-user"])).toThrow("conflicting persisted stores");
  } finally {
    fs.rmSync(created.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
