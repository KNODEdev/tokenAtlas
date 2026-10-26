import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAnalysisMaintenance } from "./analysis-maintenance";

test("maintenance respects the writer gate and releases queued readers when idle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-maintenance-"));
  const dbPath = path.join(root, "test.sqlite"), db = new Database(dbPath);
  db.exec("CREATE TABLE sync_runs(status TEXT)"); db.close();
  let allowed = false, finished = 0;
  const maintenance = startAnalysisMaintenance(dbPath, () => ({ subscriptions: [], sources: [] }), () => allowed, () => { finished++; });
  try {
    maintenance.update(); expect(maintenance.running).toBe(false); expect(maintenance.pending).toBe(true);
    allowed = true; maintenance.update(); expect(maintenance.running).toBe(true); expect(maintenance.pending).toBe(false);
    await maintenance.waitForIdle();
    expect(maintenance.running).toBe(false); expect(finished).toBe(1);
  } finally { await maintenance.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("the worker resumes period backlogs, observes sync guards and reports declarations on its minute cadence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-maintenance-periods-"));
  const dbPath = path.join(root, "test.sqlite"), configRoot = path.join(root, "config"), archiveRoot = path.join(root, "archive");
  fs.mkdirSync(configRoot);
  const db = new Database(dbPath);
  db.exec("CREATE TABLE sync_runs(status TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE probe_windows(id INTEGER PRIMARY KEY,provider TEXT,ts TEXT,plan TEXT,machine TEXT,profile TEXT,extra TEXT,ok INTEGER)");
  db.exec(fs.readFileSync(path.join(import.meta.dir, "../../drizzle/0040_account_periods.sql"), "utf8"));
  db.transaction(() => {
    const insert = db.query("INSERT INTO probe_windows(provider,ts,plan,machine,extra) VALUES('codex',?,?, 'PC',?)");
    const extra = JSON.stringify({ codex_account: { subscription: "acc", home: "C:/Users/sample_a/.codex", machine: "PC", login: "sample_a" } });
    for (let i = 0; i < 10_000; i++) insert.run(i < 5000 ? "2026-09-20T00:00:00.000Z" : "2026-09-10T00:00:00.000Z", i < 5000 ? "pro" : "plus", extra);
  })();
  db.close();
  const script = path.join(root, "maintenance.ts");
  fs.writeFileSync(script, `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { Database } from ${JSON.stringify(path.join(import.meta.dir, "../db/sqlite.ts"))};
    import { startAnalysisMaintenance } from ${JSON.stringify(path.join(import.meta.dir, "analysis-maintenance.ts"))};
    import { WriteLease } from ${JSON.stringify(path.join(import.meta.dir, "../db/write-lease.ts"))};
    const db = new Database(${JSON.stringify(dbPath)});
    const file = ${JSON.stringify(path.join(configRoot, "account-periods.json"))};
    fs.writeFileSync(file, JSON.stringify({version:1,plans:[{provider:"codex",account:"declared",plan:"pro",from:"2026-01-01",evidence:"owner"}]}));
    const config = { subscriptions: [], sources: [{vendor:"codex",machine:"PC",home:${JSON.stringify(path.join(archiveRoot, "codex/PC-sample_a"))},source_home:"C:/Users/sample_a/.codex"}] };
    let result, timer, delay;
    const start = () => startAnalysisMaintenance(${JSON.stringify(dbPath)}, () => config, () => true, next => { result = next; },
      {turnMs:0,setTimeout:(callback,ms) => { timer=callback; delay=ms; return {unref(){}}; },clearTimeout:() => {timer=undefined;}});
    let maintenance = start();
    const turn = async () => { result=undefined; maintenance.update(); await maintenance.waitForIdle(); assert.ok(!result.error,result.error); return result; };
    // A sync run holding the write lease: the worker writes nothing until it is handed over.
    const sync = new WriteLease(db, "sync");
    try {
      assert.ok(sync.tryAcquire());
      assert.equal((await turn()).accountPeriods,undefined);
      assert.equal(db.query("SELECT value FROM meta WHERE key='account_periods_probe_cursor'").get(),null);
      sync.release();
      db.query("INSERT INTO meta VALUES('analysis_rebuild_status',?)").run(JSON.stringify({generation:1,phase:"sources",state:"queued"}));
      assert.equal((await turn()).accountPeriods,undefined);
      db.exec("DELETE FROM meta WHERE key='analysis_rebuild_status'");
      assert.equal((await turn()).accountPeriods.pending,true);
      assert.equal(result.accountPeriods.changed,true); assert.equal(result.catchUpNeeded,true); assert.equal(delay,25);
      assert.equal(db.query("SELECT value FROM meta WHERE key='account_periods_probe_cursor'").get().value,"5000");
      const resume=timer; timer=undefined; resume(); await maintenance.waitForIdle();
      assert.ok(!result.error,result.error); assert.equal(result.accountPeriods.pending,true);
      assert.equal(db.query("SELECT value FROM meta WHERE key='account_periods_probe_cursor'").get().value,"10000");
      assert.equal(db.query("SELECT from_ts FROM account_periods WHERE origin='observed'").get().from_ts,"2026-09-20T00:00:00.000Z");
      assert.ok(sync.tryAcquire());
      const blocked=timer; timer=undefined; blocked(); await maintenance.waitForIdle();
      assert.equal(result.accountPeriods,undefined); assert.equal(result.catchUpNeeded,false);
      sync.release();
      assert.equal((await turn()).accountPeriods.pending,false); assert.equal(result.accountPeriods.changed,true);
      assert.equal(db.query("SELECT from_ts FROM account_periods WHERE origin='observed'").get().from_ts,"2026-09-10T00:00:00.000Z");
      assert.equal(db.query("SELECT count(*) AS n FROM plan_periods WHERE origin='declared'").get().n,1);
      assert.equal((await turn()).accountPeriods,undefined);
      await maintenance.close(); maintenance=start();
      assert.equal((await turn()).accountPeriods.changed,true); assert.equal(result.accountPeriods.pending,false);
      await maintenance.close(); fs.writeFileSync(file,"broken declaration"); maintenance=start();
      const rejected=(await turn()).accountPeriods;
      assert.equal(rejected.pending,false); assert.equal(rejected.changed,true);
      assert.ok(rejected.declarationErrors.length); assert.equal(typeof rejected.declarationsDigest,"string");
      assert.equal(db.query("SELECT count(*) AS n FROM plan_periods WHERE origin='declared'").get().n,1);
      assert.equal((await turn()).accountPeriods,undefined);
    } finally { await maintenance.close(); db.close(); }
  `);
  try {
    const child = Bun.spawn([process.execPath, script], {env:{...process.env,TOKENATLAS_CONFIG:configRoot,TOKENATLAS_ARCHIVE:archiveRoot,
      TOKENATLAS_LOCAL_STATE:path.join(root,"state"),TOKENATLAS_LOGIN:"sample_a"},stdout:"pipe",stderr:"pipe"});
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({code,stderr}).toEqual({code:0,stderr:""});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
