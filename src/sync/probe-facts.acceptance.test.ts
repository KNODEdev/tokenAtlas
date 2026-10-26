import { expect, test } from "bun:test";
import { dailyJournalFile } from "../providers/core/journal-files";
import { PROBE_DEATH_TEST_TIMEOUT_MS, runProbeDeathProcess } from "./probe-death-test-support";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { applyDrizzleMigrations } from "../db/migrate";
import { probeFactShadow, validateProbeFacts } from "../db/probe-facts";
import fixture from "../../test-fixtures/probe-facts-v1.json";
import { removeTestFixture } from "../test-cleanup";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../db/period-store";

const url = (p: string) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, p)).href);
test("unarmed external-death child is terminated before its diagnostic pipe is drained",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"probe-unarmed-"));
  const marker=path.join(root,"armed"),pidFile=path.join(root,"child.pid");
  try {
    await expect(runProbeDeathProcess(`import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
      process.stderr.write("unarmed-child-diagnostic");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,process.env,marker,true,3000))
      .rejects.toThrow(/death boundary not armed after \d+ms: unarmed-child-diagnostic/);
    expect(fs.existsSync(marker)).toBe(false);
    const pid=Number(fs.readFileSync(pidFile,"utf8"));
    expect(()=>process.kill(pid,0)).toThrow();
  } finally {removeTestFixture(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},15000);

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-death-")), archive = path.join(root, "archive");
  fs.mkdirSync(archive);
  for (const name of ["producer", "receiver"]) {
    const db = new Database(path.join(root, `${name}.sqlite`)); db.exec("PRAGMA journal_mode=WAL"); applyDrizzleMigrations(drizzle(db));
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [{ provider: "codex", subject: "codex/synthetic-producer-fixture",
      value: fixture.subject, from: "2000-01-01", until: null, origin: "declared", firstSeen: null, lastSeen: null,
      readings: 0, evidence: "external-death fixture" }]);
    db.close(true);
  }
  const env = { ...process.env, TOKENATLAS_LOCAL_STATE: path.join(root, "identity"), TOKENATLAS_CONFIG: path.join(root, "config"), TOKENATLAS_ARCHIVE: archive,
    TOKENATLAS_DB: path.join(root, "unused.sqlite"), TOKENATLAS_MACHINE: "synthetic-producer", TOKENATLAS_LOGIN: "fixture" };
  const marker = path.join(root, "armed");
  const common = `import { Database } from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
    import fs from "node:fs";
    import { persistProbeWindows } from ${url("../providers/core/probe.ts")};
    import { configureGaugeJournal, flushGaugeJournal } from ${url("../providers/core/journal.ts")};
    import { ingestGaugesAsync } from ${url("../ingest/gauges.ts")};
    import { publishCurrentBatch } from ${url("../server/current/store.ts")};
    import { currentRegistry } from ${url("../server/current/registry.ts")};
    import { ARCHIVE_LOGICAL_ROOT } from ${url("../config/paths.ts")};
    const producer=${JSON.stringify(path.join(root, "producer.sqlite"))},receiver=${JSON.stringify(path.join(root, "receiver.sqlite"))};
    const archive=${JSON.stringify(archive)}, target={journalRoot:${JSON.stringify(path.join(archive, "gauges", "producer-fixture"))},archiveRoot:archive};
    const fixture=${JSON.stringify(fixture)};
    const pause=()=>{fs.writeFileSync(${JSON.stringify(marker)},"armed");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
    const open=p=>{const db=new Database(p);db.exec("PRAGMA busy_timeout=1000");return db;};
    const arm=(needle,activeOnly=false,premature=false)=>{const original=Database.prototype.query;Database.prototype.query=function(sql){const db=this,st=original.call(this,sql);if(!sql.includes(needle) || (activeOnly && !original.call(this,"PRAGMA database_list").all().some(r=>r.name==="sync_stage")))return st;return new Proxy(st,{get(target,key){if(key==="run")return(...args)=>{const result=target.run(...args);if(premature){db.exec("ROLLBACK");target.run(...args);}pause();return result;};const v=target[key];return typeof v==="function"?v.bind(target):v;}});};};
    const produce=(ts=fixture.ts,percent=42)=>{const db=open(producer);configureGaugeJournal(target.journalRoot,{archiveRoot:archive});persistProbeWindows(db,"codex",fixture.subject,ts,[{...fixture.reading,usedPercent:percent}]);db.close(true);};
    const deliver=()=>{const db=open(producer);const result=flushGaugeJournal(db,target);db.close(true);if(result.error)throw Error(result.error);};
    // Steps run in order, as the sync pipeline runs them: an import holds its writer until it commits.
    const ingest=async()=>await ingestGaugesAsync({atlasPath:receiver,archiveRoot:archive,ownStore:"receiver",force:true,now:()=>"2026-09-01T12:01:00Z"});
    const current=()=>{const db=open(receiver);const declarations=[{id:fixture.subject,vendor:"codex",machine:"synthetic-producer",
      home:ARCHIVE_LOGICAL_ROOT+"/codex/synthetic-producer-fixture",source_home:"fixture/a"}];
      const accounts={version:2,subscriptions:[{id:fixture.subject,vendor:"codex"}],sources:[{vendor:"codex",machine:"synthetic-producer",
        home:ARCHIVE_LOGICAL_ROOT+"/codex/synthetic-producer-fixture",source_home:"fixture/a"}]};
      const now="2026-09-01T12:01:00Z";let steps=0;
      while(publishCurrentBatch(db,currentRegistry(accounts.subscriptions,now),now,32,accounts)){
        if(++steps>500)throw Error("current projection did not settle");
      }
      db.close(true);};
  `;
  const run = (code: string, kill = false) => runProbeDeathProcess(common + code, env, marker, kill);
  const connections: Database[] = [];
  const open = (name = "receiver") => {const db=new Database(path.join(root, `${name}.sqlite`));connections.push(db);return db;};
  const clear = (name: string) => { const db = open(name); db.exec("DROP TRIGGER IF EXISTS death_boundary"); db.close(true); };
  const cleanup = () => {for(const db of connections)try{db.close(true);}catch{}removeTestFixture(root, { recursive: true, force: true, maxRetries:5,retryDelay:50 });};
  return { root, archive, common, run, open, clear, cleanup };
}
function state(db: Database) {
  return Object.fromEntries(["probe_observations", "probe_counters", "gauge_journal_outbox", "gauge_journal_receipts", "gauge_files", "current_projection_dirty", "current_projection_state"].map(t => [t, db.query(`SELECT * FROM ${t}`).all()]));
}
test("external backfill death rolls back its fact/map/checkpoint batch and resumes in a new process", async () => {
  const f = setup();
  const backfill = `const {backfillProbeFacts}=await import(${url("../db/probe-facts.ts")});const db=open(producer);backfillProbeFacts(db,{batchSize:1});db.close(true);`;
  try {
    const db = f.open("producer");
    db.exec("INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side) VALUES ('codex','codex1','2026-09-01','primary','used'),('codex','codex1','2026-09-02','primary','used')"); db.close(true);
    await f.run('arm("UPDATE probe_fact_backfill_checkpoints");' + backfill, true);
    let check = f.open("producer"); expect(check.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 0 });
    expect(check.query("SELECT cursor FROM probe_fact_backfill_checkpoints WHERE id='local'").get()).toEqual({ cursor: 0 }); check.close(true);
    await f.run(backfill); check = f.open("producer"); const ids = check.query("SELECT id FROM probe_counters ORDER BY id").all(); expect(ids).toHaveLength(2); check.close(true);
    await f.run(backfill); check = f.open("producer"); expect(check.query("SELECT id FROM probe_counters ORDER BY id").all()).toEqual(ids); check.close(true);
  } finally { f.cleanup(); }
}, PROBE_DEATH_TEST_TIMEOUT_MS);
test("external process death after fact INSERT rolls back fact/outbox, restart commits one collection", async () => {
  const f = setup();
  try {
    await f.run(`arm("INSERT INTO probe_counters");produce();`, true);
    let db = f.open("producer"); expect(db.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 0 }); expect(db.query("SELECT count(*) n FROM gauge_journal_outbox").get()).toEqual({ n: 0 }); db.close(true);
    f.clear("producer"); await f.run("produce();deliver();await ingest();current();");
    db = f.open(); validateProbeFacts(db); expect(db.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 1 }); db.close(true);
  } finally { f.cleanup(); }
}, PROBE_DEATH_TEST_TIMEOUT_MS);
test("external drainer death after fsync preserves IDs through physical duplicate delivery", async () => {
  const f = setup();
  try {
    await f.run("produce();");
    await f.run(`const {interruptJournalFsync}=await import(${url("../providers/core/journal-fault-fixture.ts")});
      const {dailyJournalFile}=await import(${url("../providers/core/journal-files.ts")});
      interruptJournalFsync(target.journalRoot + "/" + dailyJournalFile("probe_windows.jsonl", new Date()), pause); deliver();`, true);
    let db = f.open("producer"); const ids = db.query("SELECT id FROM probe_counters").all(); expect(db.query("SELECT count(*) n FROM gauge_journal_outbox").get()).toEqual({ n: 1 }); db.close(true);
    await f.run("deliver();await ingest();current();");
    db = f.open(); expect(db.query("SELECT id FROM probe_counters").all()).toEqual(ids); expect(db.query("SELECT count(*) n FROM gauge_journal_receipts").get()).toEqual({ n: 1 }); db.close(true);
    const lines = fs.readFileSync(path.join(f.archive, "gauges/producer-fixture", dailyJournalFile("probe_windows.jsonl", new Date())), "utf8").trim().split("\n"); expect(lines).toHaveLength(2); expect(lines[0]).toBe(lines[1]);
  } finally { f.cleanup(); }
}, PROBE_DEATH_TEST_TIMEOUT_MS);
test("external import death rejects an actually committed early receipt and preserves normal atomicity", async () => {
  const assertUnacknowledged = (db: Database) => {
    for (const table of ["probe_counters", "gauge_journal_receipts", "gauge_files"])
      expect(db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  };
  for (const premature of [true, false]) {
    const f = setup();
    try {
      await f.run("produce();deliver();");
      // The mutant rolls back the file transaction, commits its actual receipt alone, then awaits external kill.
      await f.run(`arm("INSERT INTO gauge_journal_receipts",false,${premature});await ingest();`, true);
      let db = f.open();
      if (premature) {
        expect(db.query("SELECT count(*) n FROM gauge_journal_receipts").get()).toEqual({ n: 1 });
        expect(db.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 0 });
        expect(() => assertUnacknowledged(db)).toThrow();
        console.info("negative-control early committed real receipt: interrupted atomicity gate rejected");
        db.close(true); continue;
      }
      assertUnacknowledged(db); db.close(true);
      await f.run("await ingest();current();");
      db = f.open(); const before = state(db); db.close(true);
      await f.run('await ingestGaugesAsync({atlasPath:receiver,archiveRoot:archive,ownStore:"receiver",force:false});');
      db = f.open(); expect(state(db)).toEqual(before); db.close(true);
    } finally { f.cleanup(); }
  }
}, PROBE_DEATH_TEST_TIMEOUT_MS);

test("external death in real SyncCoordinator active publication retains stage input for retry", async () => {
  const f = setup();
  const sync = `
    const {SyncCoordinator,enterSyncPipeline}=await import(${url("./coordinator.ts")});
    const {adaptersWith,noMirror,successfulNoop}=await import(${url("./test-support.ts")});
    const coordinator=new SyncCoordinator({dbPath:receiver,rootDir:${JSON.stringify(path.resolve(import.meta.dir, "../.."))},mirror:noMirror,configFingerprint:()=>"probe-v1",sourceFingerprint:()=>"new",prepareStage:()=>{},refreshDerived:()=>{},adapters:adaptersWith({gauges:async ctx=>{const r=await ingestGaugesAsync({atlasPath:ctx.stageDbPath,archiveRoot:archive,ownStore:"receiver",force:true,now:()=>"2026-09-01T12:01:00Z"});return {...successfulNoop(),processedInputs:r.files,writtenRows:r.rows};}})});
    const result=await enterSyncPipeline(coordinator,{trigger:"manual",scope:{kind:"vendor",vendor:"gauges"},mode:"full"}).completion;
    coordinator.close();if(result.status!=="success")throw Error(JSON.stringify(result));
  `;
  try {
    await f.run("produce();deliver();");
    await f.run('arm("INSERT INTO probe_counters",true);'+sync, true);
    let check = f.open(); expect(check.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 0 }); expect(check.query("SELECT count(*) n FROM gauge_files").get()).toEqual({ n: 0 }); check.close(true);
    f.clear("receiver");
    const concurrent=sync.replace("return {...successfulNoop()", 'const active=open(receiver);configureGaugeJournal(null);persistProbeWindows(active,"codex",fixture.subject,"2026-09-01T12:00:30Z",[{...fixture.reading,usedPercent:99}]);active.close(true);return {...successfulNoop()');
    await expect(f.run(concurrent)).rejects.toThrow("First-fill destination changed; retry publication");
    check = f.open();
    expect(check.query("SELECT used_percent FROM probe_windows").all()).toEqual([{used_percent:99}]);
    expect(check.query("SELECT count(*) n FROM gauge_files").get()).toEqual({n:0});
    check.close(true);
    await f.run(sync + "current();");
    await f.run("produce('2026-08-31T12:00:00Z',21);deliver();" + sync + "current();");
    check = f.open(); validateProbeFacts(check); expect(check.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 3 }); check.close(true);
    await f.run(`const {digest}=await import(${url("../config/canonical-json.ts")});const {dailyJournalFile}=await import(${url("../providers/core/journal-files.ts")});const file=target.journalRoot+"/"+dailyJournalFile("probe_windows.jsonl",new Date());const {expandProbeJournal}=await import(${url("../providers/core/journal-compact.ts")});const row=expandProbeJournal(fs.readFileSync(file,"utf8").trim().split("\\n"))[0];row.journal_version=2;row.journal_entry_id=crypto.randomUUID();row.used_percent=999;row.canonical_probe.payload.used_percent=999;row.canonical_probe.payload_digest=digest(row.canonical_probe.payload);fs.appendFileSync(file,JSON.stringify(row)+"\\n");`);
    await expect(f.run(sync)).rejects.toThrow("counter-identity-conflict");
    check=f.open();expect((check.query("SELECT count(*) n FROM probe_fact_conflicts").get() as {n:number}).n).toBeGreaterThan(0);expect(check.query("SELECT count(*) n FROM probe_counters").get()).toEqual({n:3});check.close(true);
  } finally { f.cleanup(); }
}, PROBE_DEATH_TEST_TIMEOUT_MS);
test("external current death rejects early committed publication acknowledgment and rollback keeps newer facts", async () => {
  const assertPendingPublication = (db: Database, before: ReturnType<typeof state>) => expect(state(db)).toEqual(before);
  for (const premature of [true, false]) {
    const f = setup();
    try {
      await f.run("current();produce();deliver();await ingest();");
      let db = f.open(); const before = state(db);
      const prior = db.query("SELECT generation,probe_revision,published_probe_revision FROM current_projection_state").get() as
        { generation: number; probe_revision: number; published_probe_revision: number };
      expect(prior.probe_revision).toBeGreaterThan(prior.published_probe_revision); db.close(true);
      // The mutant discards projection writes, commits their publication acknowledgment alone, then awaits external kill.
      await f.run(`arm("UPDATE current_projection_state SET generation=generation+1",false,${premature});current();`, true);
      db = f.open();
      if (premature) {
        expect(db.query("SELECT generation FROM current_projection_state").get()).toEqual({ generation: prior.generation + 1 });
        expect(() => assertPendingPublication(db, before)).toThrow();
        console.info("negative-control early committed real publication acknowledgment: interrupted publication gate rejected");
        db.close(true); continue;
      }
      assertPendingPublication(db, before); db.close(true);
      await f.run("current();produce(fixture.ts,77);deliver();await ingest();current();");
      db = f.open(); const first = db.query("SELECT id FROM probe_counters ORDER BY id").all(); expect(first).toHaveLength(2); expect(probeFactShadow(db)[0]!.cutover).toBe("blocked"); db.close(true);
      await f.run("produce('2026-09-01T12:00:30Z',88);deliver();await ingest();current();");
      db = f.open(); expect(db.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 3 }); expect(db.query("SELECT id FROM probe_counters ORDER BY id").all()).toEqual(expect.arrayContaining(first)); validateProbeFacts(db); db.close(true);
    } finally { f.cleanup(); }
  }
}, PROBE_DEATH_TEST_TIMEOUT_MS);
