import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { currentAtlasSchemaVersion } from "../db/snapshot";

test("startup rejects legacy accounts before creating or migrating the database", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-accounts-startup-"));
  const config = path.join(root, "config"), database = path.join(root, "untouched.sqlite");
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({subscriptions:[]}));
  const script = path.join(root, "start.ts");
  fs.writeFileSync(script, `import {createAppContext,startServer} from ${JSON.stringify(path.join(import.meta.dir, "api.ts"))};
    for (const start of [() => createAppContext(${JSON.stringify(database)}), () => startServer(0, ${JSON.stringify(database)})]) {
      try { start(); throw new Error("legacy configuration was accepted"); }
      catch (error) { if (!String(error).includes("accounts v2:")) throw error; }
    }`);
  try {
    const child = Bun.spawn([process.execPath, script], {env:{...process.env,TOKENATLAS_CONFIG:config,
      TOKENATLAS_ARCHIVE:path.join(root,"archive"),TOKENATLAS_LOCAL_STATE:path.join(root,"state")},stdout:"pipe",stderr:"pipe"});
    const [code, stderr] = await Promise.all([child.exited,new Response(child.stderr).text()]);
    expect({code,stderr}).toEqual({code:0,stderr:""});
    expect(fs.existsSync(database)).toBe(false);
  } finally { fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});

test("server refuses a populated index awaiting migration before bootstrap can replace it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-schema-startup-"));
  const config = path.join(root, "config"), database = path.join(root, "atlas.sqlite");
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({version:2,subscriptions:[],sources:[]}));
  const sqlite = new Database(database, { create: true });
  sqlite.exec("CREATE TABLE __drizzle_migrations (hash TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE events (id INTEGER)");
  for (let index = 0; index < currentAtlasSchemaVersion(); index++) {
    sqlite.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(`hash-${index}`, index);
  }
  sqlite.exec("INSERT INTO events VALUES (7)");
  sqlite.close(true);
  const digest = () => createHash("sha256").update(fs.readFileSync(database)).digest("hex");
  const original = digest();
  const script = path.join(root, "start.ts");
  fs.writeFileSync(script, `import {startServer} from ${JSON.stringify(path.join(import.meta.dir, "api.ts"))};
    try { startServer(0, ${JSON.stringify(database)}); throw new Error("outdated schema was accepted"); }
    catch (error) { if (!String(error).includes("requires migration")) throw error; }`);
  try {
    const run = async () => {
      const child = Bun.spawn([process.execPath, script], {env:{...process.env,TOKENATLAS_CONFIG:config,
        TOKENATLAS_ARCHIVE:path.join(root,"archive"),TOKENATLAS_LOCAL_STATE:path.join(root,"state")},stdout:"pipe",stderr:"pipe"});
      const [code, stderr] = await Promise.all([child.exited,new Response(child.stderr).text()]);
      return {code,stderr};
    };
    const {code,stderr} = await run();
    expect({code,stderr}).toEqual({code:0,stderr:""});
    expect(digest()).toBe(original);
    expect(fs.existsSync(path.join(root, "atlas-index-snapshots"))).toBe(false);
    const interruptedBackup = `${database}.bootstrap-backup`;
    fs.renameSync(database, interruptedBackup);
    expect(await run()).toEqual({code:0,stderr:""});
    expect(fs.existsSync(database)).toBe(false);
    expect(createHash("sha256").update(fs.readFileSync(interruptedBackup)).digest("hex")).toBe(original);
  } finally { fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});
