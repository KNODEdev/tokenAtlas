import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "./sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { relocateDatabase, validateDatabaseDestination } from "./relocate";
import { databaseEnvironmentContents, selectedDatabasePath } from "./location";
import { superviseServer } from "../server/supervisor";
import { resolveDbPath } from ".";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-db-move-"));
  directories.push(directory);
  const source = path.join(directory, "original.sqlite");
  const destination = path.join(directory, "new location", "atlas.sqlite");
  const envFile = path.join(directory, ".env");
  const db = new Database(source);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts(id INTEGER PRIMARY KEY, amount REAL, provenance TEXT); INSERT INTO facts VALUES(1,1.23456789,'original');");
  fs.writeFileSync(envFile, "PORT=7331\nTOKENATLAS_DB=old.sqlite\nOTHER=preserved\n");
  return { directory, source, destination, envFile, db };
}

describe("database relocation", () => {
  test("copies WAL facts, persists selection, and preserves completed facts across reopen and correction", () => {
    const f = fixture();
    try {
      expect(fs.statSync(f.source + "-wal").size).toBeGreaterThan(0);
      expect(relocateDatabase(f.source, f.destination, f.envFile)).toBe(f.destination);
      expect(selectedDatabasePath(f.envFile)).toBe(f.destination.replace(/\\/g, "/"));
      expect(fs.readFileSync(f.envFile, "utf8")).toContain("OTHER=preserved");
      const reopened = new Database(f.destination);
      try {
        expect(reopened.query("SELECT * FROM facts").all()).toEqual(f.db.query("SELECT * FROM facts").all());
        reopened.exec("UPDATE facts SET amount=2.34567891 WHERE id=1; INSERT INTO facts VALUES(2,3.25,'incremental');");
        expect((reopened.query("SELECT SUM(amount) AS n FROM facts").get() as { n: number }).n).toBeCloseTo(5.59567891, 8);
        expect((f.db.query("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n).toBe(1);
      } finally { reopened.close(); }
    } finally { f.db.close(); }
  });

  test("rejects unsafe, same, and occupied destinations without changing data", () => {
    const f = fixture();
    try {
      const cloud = path.join(f.directory, "cloud");
      const archive = path.join(f.directory, "archive");
      const env = { ...process.env, OneDrive: cloud, TOKENATLAS_ARCHIVE: archive };
      for (const target of [f.source, path.join(cloud,"a.sqlite"), path.join(archive,"a.sqlite"), path.join(f.directory,"OneDrive - Test","a.sqlite"), "relative.sqlite", "\\\\server\\share\\a.sqlite"]) {
        expect(() => validateDatabaseDestination(f.source, target, env)).toThrow();
      }
      fs.mkdirSync(cloud);
      const alias = path.join(f.directory,"innocent-alias");
      fs.symlinkSync(cloud, alias, "junction");
      expect(() => validateDatabaseDestination(f.source,path.join(alias,"a.sqlite"),env)).toThrow("outside OneDrive");
      fs.mkdirSync(path.dirname(f.destination));
      fs.writeFileSync(f.destination, "existing");
      expect(() => relocateDatabase(f.source, f.destination, f.envFile)).toThrow("already exists");
      expect(fs.readFileSync(f.destination, "utf8")).toBe("existing");
    } finally { f.db.close(); }
  });

  test("configuration failure leaves original writable and removes unpublished destination", () => {
    const f = fixture();
    try {
      const blockedParent = path.join(f.directory,"not-a-directory");
      fs.writeFileSync(blockedParent,"block");
      expect(() => relocateDatabase(f.source, f.destination, path.join(blockedParent,".env"))).toThrow();
      expect(fs.existsSync(f.destination)).toBe(false);
      f.db.exec("INSERT INTO facts VALUES(2,2,'after failure')");
      expect((f.db.query("SELECT COUNT(*) AS n FROM facts").get() as {n:number}).n).toBe(2);
      expect(fs.readFileSync(f.envFile,"utf8")).toContain("TOKENATLAS_DB=old.sqlite");
    } finally { f.db.close(); }
  });

  test("server supervisor restarts a new process using the verified selection", async () => {
    const f = fixture();
    f.db.close();
    const child = path.join(f.directory,"server.ts");
    fs.writeFileSync(child, `const result = JSON.parse(process.env.TOKENATLAS_DB_RELOCATION_RESULT || 'null');
if (!result) { process.send({type:'relocate-database', destination:${JSON.stringify(f.destination)}}); setTimeout(()=>process.exit(75),30); }
else { const {Database}=await import('bun:sqlite'); const db=new Database(process.env.TOKENATLAS_DB); const count=db.query('SELECT COUNT(*) AS n FROM facts').get().n; db.close(); process.exit(result.error || count!==1 || process.env.TOKENATLAS_DB!==${JSON.stringify(f.destination)} ? 1 : 0); }`);
    expect(await superviseServer(child, { database: f.source, envFile: f.envFile })).toBe(0);
    expect(selectedDatabasePath(f.envFile)).toBe(f.destination.replace(/\\/g,"/"));
    expect(fs.existsSync(f.source)).toBe(true);
    const freshChild = path.join(f.directory,"fresh-server.ts");
    fs.writeFileSync(freshChild, `import path from 'node:path'; process.exit(path.resolve(process.env.TOKENATLAS_DB)===${JSON.stringify(f.destination)} ? 0 : 1);`);
    const inherited = process.env.TOKENATLAS_DB;
    process.env.TOKENATLAS_DB = f.source;
    try { expect(await superviseServer(freshChild, { envFile:f.envFile })).toBe(0); }
    finally { if (inherited === undefined) delete process.env.TOKENATLAS_DB; else process.env.TOKENATLAS_DB = inherited; }
  });

  test("managed selection replaces duplicate assignments and round-trips special characters", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-db-selection-"));
    directories.push(directory);
    const envFile = path.join(directory,".env");
    const selected = path.join(directory,"space # $ quote'", "atlas.sqlite");
    fs.writeFileSync(envFile,databaseEnvironmentContents("TOKENATLAS_DB=a\nexport TOKENATLAS_DB=b\nOTHER=x",selected));
    expect(selectedDatabasePath(envFile)).toBe(selected.replace(/\\/g,"/"));
    expect(fs.readFileSync(envFile,"utf8").match(/TOKENATLAS_DB=/g)).toHaveLength(1);
  });

  test("a process started without the .env variable still opens the database chosen in Settings", () => {
    const saved = selectedDatabasePath();
    expect(resolveDbPath(undefined, {})).toBe(path.resolve(saved ?? path.join(os.homedir(), ".tokenatlas", "atlas.sqlite")));
    expect(resolveDbPath(undefined, { TOKENATLAS_DB: "/explicit/atlas.sqlite" })).toBe(path.resolve("/explicit/atlas.sqlite"));
  });

  test("supervisor restarts the original when destination publication fails", async () => {
    const f = fixture();
    f.db.close();
    const child = path.join(f.directory,"server-failure.ts");
    fs.writeFileSync(child, `const result = JSON.parse(process.env.TOKENATLAS_DB_RELOCATION_RESULT || 'null');
if (!result) { process.send({type:'relocate-database', destination:${JSON.stringify(f.destination)}}); setTimeout(()=>process.exit(1),30); }
else { process.exit(result.error && process.env.TOKENATLAS_DB===${JSON.stringify(f.source)} ? 0 : 1); }`);
    expect(await superviseServer(child, { database:f.source, envFile:f.envFile })).toBe(0);
    expect(fs.existsSync(f.destination)).toBe(false);
    expect(selectedDatabasePath(f.envFile)).toBeUndefined();
    expect(fs.existsSync(f.source)).toBe(true);
  });
});
