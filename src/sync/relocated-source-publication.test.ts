import { expect, test } from "bun:test";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import { pinCanonicalArchiveRoot } from "../config/archive-paths";

for (const changedLive of [false, true]) {
  test(`a rebuild of a relocated archive publishes logical paths and the reading it made through the physical path${changedLive ? ", even when the file changes afterwards" : ""}`, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-moved-publication-"));
    const original = path.join(base, "original"), moved = path.join(base, "moved");
    const logicalFile = path.join(original, "claude", "fixture", "one.jsonl");
    fs.mkdirSync(path.join(original, ".archive-inventory"), { recursive: true });
    fs.mkdirSync(path.dirname(logicalFile), { recursive: true });
    fs.writeFileSync(path.join(original, ".archive-inventory", "identity.json"), JSON.stringify({ schema: 1, archiveId: "moved-fixture" }));
    fs.writeFileSync(logicalFile, "{\"tokens\":7}\n");
    pinCanonicalArchiveRoot(original);
    fs.renameSync(original, moved);
    const module = (relative: string) => JSON.stringify(path.resolve(import.meta.dir, relative));
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { Database } from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
      import { expect } from "bun:test";
      import { prepareReparse } from ${module("reparse.ts")};
      import { SyncCoordinator } from ${module("coordinator.ts")};
      import { adaptersWith, successfulNoop, noMirror } from ${module("test-support.ts")};
      import { drizzle } from "drizzle-orm/bun-sqlite";
      import { applyDrizzleMigrations } from ${module("../db/migrate.ts")};
      const logicalFile = ${JSON.stringify(logicalFile)};
      const archive = ${JSON.stringify(moved)};
      const physicalFile = path.join(archive, "claude", "fixture", "one.jsonl");
      expect(fs.existsSync(logicalFile)).toBe(false);
      // A registered logical source is found through the relocated physical archive.
      const temporary = new Database(":memory:");
      temporary.exec("CREATE TABLE files(home TEXT,path TEXT,size INT,mtime REAL)");
      temporary.query("INSERT INTO files VALUES ('fixture',?,1,1)").run(logicalFile);
      const plan = prepareReparse(temporary, temporary, {identity:["home","path"],bookmarkTable:"files"}, [], {});
      expect(plan.unavailable).toEqual([]);
      expect(plan.sources).toEqual([{home:"fixture",path:logicalFile}]);
      temporary.close();
      const directory = ${JSON.stringify(base)}, dbPath = path.join(directory,"atlas.sqlite");
      const active = new Database(dbPath);
      applyDrizzleMigrations(drizzle(active));
      const stat = fs.statSync(physicalFile);
      const coordinator = new SyncCoordinator({ dbPath, rootDir:process.cwd(), mirror:noMirror,
        configFingerprint:()=>"fixture", sourceFingerprint:()=>"fixture", prepareStage:()=>{}, refreshDerived:()=>{},
        adapters:adaptersWith({claude:async context=>{
          expect(context.rebuild).toBe(true);
          const stage = new Database(context.stageDbPath);
          stage.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('fixture','one',?,'2026-09-17T10:00:00Z',7)").run(logicalFile);
          stage.query("INSERT INTO claude_files(store,path,size,mtime,calls,parser_version,ingested_at) VALUES('fixture',?,?,?,1,1,'2026-09-17T10:00:00Z')").run(logicalFile,stat.size,stat.mtimeMs);
          stage.close();
          ${changedLive ? 'fs.writeFileSync(physicalFile, "changed-live-bytes-after-the-read");' : ""}
          return {...successfulNoop(),processedInputs:1,writtenRows:1};
        }}) });
      try {
        const result = await coordinator.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",
          collection:"archive",rebuildGeneration:12,reparse:{}}).completion;
        expect({status:result.status,error:result.error}).toEqual({status:"success",error:null});
        expect(active.query("SELECT path,in_uncached FROM claude_events").all()).toEqual([{path:logicalFile,in_uncached:7}]);
        // The position describes the bytes the rebuild read; a later change is left to the next ordinary read.
        expect(active.query("SELECT path,size,mtime FROM claude_files").get()).toEqual({path:logicalFile,size:stat.size,mtime:stat.mtimeMs});
        expect(fs.statSync(physicalFile).size === stat.size).toBe(${!changedLive});
        console.log("PASS");
      } finally {coordinator.close();active.close();}
    `;
    try {
      const worker = Bun.spawn([process.execPath, "--eval", script], {
        env: { ...process.env, TOKENATLAS_ARCHIVE: moved, TOKENATLAS_CONFIG: path.join(moved, "config"), TOKENATLAS_LOCAL_STATE: path.join(base, "local"), TOKENATLAS_DB: path.join(base, "unused.sqlite") },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(stdout).toContain("PASS");
    } finally { removeTestFixture(base, { recursive: true, force: true }); }
  }, 30_000);
}
