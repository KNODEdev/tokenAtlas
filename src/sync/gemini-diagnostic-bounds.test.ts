import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FILES = 60;

test("Gemini files retain physical source evidence without assigning an account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-diagnostic-bounds-"));
  const module = (name: string) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, name)).href);
  try {
    const archive = path.join(root, "archive");
    const config = path.join(root, "config");
    fs.mkdirSync(config, { recursive: true });
    // The physical profile is configured, but no account period owns it.
    fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [],
      sources: [{ vendor: "gemini", machine: "PC-unknown", home: path.join(archive, "gemini", "PC-unknown") }] }));
    const script = path.join(root, "run.ts");
    fs.writeFileSync(script, `
      import fs from 'node:fs';import path from 'node:path';
      import {Database} from ${module("../db/sqlite.ts")};
      import {createTestDatabase} from ${module("test-support.ts")};
      import {createProductionAdapters} from ${module("adapters.ts")};
      import {subscriptionEventFromRow,subscriptionAccountingAdapter} from ${module("../server/subscription-accounting-adapters.ts")};
      import {buildAccountResolver} from ${module("../server/account-resolver.ts")};
      const archive=process.env.TOKENATLAS_ARCHIVE!;
      const directory=path.join(archive,'gemini','PC-unknown','conversations');
      fs.mkdirSync(directory,{recursive:true});
      const files=Array.from({length:${FILES}},(_,index)=>path.join(directory,'chat-'+index+'.db'));
      for(const file of files){
        const db=new Database(file);
        db.exec('CREATE TABLE gen_metadata(idx INTEGER,data BLOB)');
        db.query('INSERT INTO gen_metadata VALUES(0,?)').run(new Uint8Array([10,4,34,2,16,123]));
        db.close();
      }
      const fixture=createTestDatabase();
      try{
        const queued=await createProductionAdapters().gemini({
          activeDbPath:fixture.dbPath,stageDbPath:fixture.dbPath,rootDir:process.cwd(),
          mode:'incremental',changedFiles:files});
        const db=new Database(fixture.dbPath);
        const row=db.query('SELECT * FROM gemini_events ORDER BY rowid LIMIT 1').get();
        const event=subscriptionEventFromRow(subscriptionAccountingAdapter('gemini'),row,archive);
        const owner=event&&buildAccountResolver([]).resolve('gemini',event.source,event.account_key,event.ts).account;
        console.log('RESULT:'+JSON.stringify({
          processedInputs:queued.processedInputs,
          rows:db.query('SELECT count(*) AS n FROM gemini_events').get().n,
          source:event?.source??null,account:event?.account??null,owner}));
        db.close(true);
      }finally{fs.rmSync(fixture.directory,{recursive:true,force:true});}
    `);
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, TOKENATLAS_ARCHIVE: archive, TOKENATLAS_CONFIG: config,
        TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_TEMP_DIR: path.join(root, "scratch") },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, err }).toEqual({ exit: 0, err: "" });
    const result = JSON.parse(out.split(/\r?\n/).find((line) => line.startsWith("RESULT:"))!.slice(7));
    expect(result.processedInputs).toBe(FILES);
    expect(result.rows).toBe(FILES);
    expect(result.source).toBe("gemini/pc-unknown");
    expect(result.account).toBeNull();
    expect(result.owner).toBeNull();
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);
