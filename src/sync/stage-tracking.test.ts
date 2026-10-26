import { afterAll, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import path from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { removeTestFixture } from "../test-cleanup";
import { createIncrementalStage, SyncCoordinator } from "./coordinator";
import { createProductionAdapters } from "./adapters";
import { omitStageAnalysisTracking } from "./stage-tracking";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";

const directories: string[] = [];
afterAll(() => { for (const directory of directories) removeTestFixture(directory,{recursive:true,force:true}); });

test("attached stage seeding preserves SQLite values and selected bookmarks with guards intact", () => {
  const {directory,dbPath}=createTestDatabase();
  directories.push(directory);
  const active=new Database(dbPath),stagePath=path.join(directory,"seed.sqlite");
  try {
    installAnalysisTracking(active);
    installFactDayRevisions(active);
    active.exec(`ALTER TABLE meta ADD COLUMN exact INTEGER;
      ALTER TABLE meta ADD COLUMN fraction REAL;
      ALTER TABLE meta ADD COLUMN bytes BLOB;
      INSERT INTO meta(key,value,exact,fraction,bytes) VALUES('seed',NULL,9007199254740993,1.25,x'00ff');
      CREATE TABLE seed_audit(key TEXT);
      CREATE TRIGGER seed_audit_insert AFTER INSERT ON meta BEGIN INSERT INTO seed_audit VALUES(NEW.key); END;
      CREATE TRIGGER seed_guard BEFORE INSERT ON meta WHEN NEW.key='forbidden'
        BEGIN SELECT RAISE(ABORT,'seed guard'); END;`);
    const files=Array.from({length:405},(_,i)=>path.join(directory,`selected-${i}.jsonl`));
    const insert=active.query("INSERT INTO claude_files(store,path,size,mtime,calls,ingested_at) VALUES('live',?,10,1,1,'2026-01-10T00:00:00Z')");
    for(const file of [...files,path.join(directory,"unselected.jsonl")]) insert.run(file);
    createIncrementalStage(active,stagePath,"claude",[...files,files[0]!]);
    const stage=new Database(stagePath,{safeIntegers:true});
    try {
      expect(stage.query("SELECT exact,fraction,bytes,value,typeof(exact) kind FROM meta WHERE key='seed'").get())
        .toEqual({exact:9007199254740993n,fraction:1.25,bytes:new Uint8Array([0,255]),value:null,kind:"integer"});
      expect(stage.query("SELECT count(*) n FROM claude_files").get()).toEqual({n:405n});
      expect(stage.query("SELECT key FROM seed_audit WHERE key='seed'").all()).toEqual([{key:"seed"}]);
      expect(stage.query("SELECT count(*) n FROM fact_day_revisions").get()).toEqual({n:0n});
      expect(() => stage.exec("INSERT INTO meta(key) VALUES('forbidden')")).toThrow("seed guard");
      expect(stage.query("SELECT name FROM sqlite_master WHERE name='probe_current_after_insert'").get())
        .toEqual(active.query("SELECT name FROM sqlite_master WHERE name='probe_current_after_insert'").get());
    } finally {stage.close();}
    expect(active.query("SELECT * FROM seed_audit").all()).toEqual([]);
  } finally {active.close();}
});

for (const mode of ["incremental", "full"] as const) {
  test(`${mode} stage omits disposable analysis tracking while publication tracks facts`, async () => {
    const { directory, dbPath } = createTestDatabase();
    directories.push(directory);
    const active = new Database(dbPath);
    installAnalysisTracking(active);
    installFactDayRevisions(active);
    active.exec(`CREATE TABLE stage_custom_audit(id INTEGER PRIMARY KEY);
      CREATE TRIGGER fact_day_revision_claude_events_custom AFTER INSERT ON claude_events
      BEGIN INSERT INTO stage_custom_audit(id) VALUES (NEW.rowid); END;
      CREATE TRIGGER claude_before_delete_guard BEFORE DELETE ON claude_events
      BEGIN SELECT RAISE(ABORT,'custom guard'); END;`);
    const changedDays = () => active.query("SELECT day,revision FROM fact_day_revisions WHERE source='claude_events' ORDER BY day").all();
    expect(changedDays()).toEqual([]);
    const beforeRevision = (active.query("SELECT revision FROM analysis_source_revisions WHERE source='claude_events' AND bucket='*'").get() as {revision:number}).revision;
    let stageEvidence: { diaryBefore:number; diaryAfter:number; revisionBefore:number; revisionAfter:number; triggers:string[]; rows:number } | undefined;
    const instance = new SyncCoordinator({ archiveInputs: () => undefined,
      dbPath, rootDir: process.cwd(), adapters: adaptersWith({claude: async context => {
        const stage = new Database(context.stageDbPath);
        try {
          const diary = () => (stage.query("SELECT COALESCE(SUM(revision),0) AS n FROM fact_day_revisions").get() as {n:number}).n;
          const revision = () => (stage.query("SELECT COALESCE(SUM(revision),0) AS n FROM analysis_source_revisions WHERE source='claude_events'").get() as {n:number}).n;
          const diaryBefore = diary(), revisionBefore = revision();
          const triggers = (stage.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='claude_events' ORDER BY name").all() as {name:string}[]).map(row => row.name);
          for (let i = 0; i < 3; i++) stage.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc',?,?,?,10)")
            .run(`call-${i}`,`call-${i}.jsonl`,`2026-01-10T10:00:0${i}.000Z`);
          expect(() => stage.query("DELETE FROM claude_events WHERE call_id='call-0'").run()).toThrow("custom guard");
          expect((stage.query("SELECT COUNT(*) AS n FROM stage_custom_audit").get() as {n:number}).n).toBe(3);
          stageEvidence = {diaryBefore, diaryAfter:diary(), revisionBefore, revisionAfter:revision(), triggers,
            rows:(stage.query("SELECT COUNT(*) AS n FROM claude_events").get() as {n:number}).n};
        } finally { stage.close(); }
        return {...successfulNoop(), processedInputs:3, skippedInputs:0, writtenRows:3,
          dirtyRange:{from:"2026-01-10T10:00:00.000Z",to:"2026-01-10T10:00:02.000Z"}};
      }}), mirror:noMirror, configFingerprint:()=>"stage-fixture", sourceFingerprint:()=>"stage-fixture",
      prepareStage:()=>{}, refreshDerived:()=>{},
    });
    try {
      const result = await instance.enter({trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode}).completion;
      expect(result.status).toBe("success");
      expect(stageEvidence?.triggers).toContain("fact_day_revision_claude_events_custom");
      expect(stageEvidence?.triggers).toContain("claude_before_delete_guard");
      expect(stageEvidence?.triggers).not.toContain("fact_day_revision_claude_events_insert");
      expect(stageEvidence?.triggers).not.toContain("analysis_claude_events_insert");
      expect(stageEvidence?.diaryAfter).toBe(stageEvidence?.diaryBefore);
      expect(stageEvidence?.diaryBefore).toBe(0);
      expect(stageEvidence?.revisionAfter).toBe(stageEvidence?.revisionBefore);
      expect(stageEvidence?.rows).toBe(3);
      expect(active.query("SELECT COUNT(*) AS n FROM claude_events").get()).toEqual({n:3});
      expect(active.query("SELECT call_id,path,in_uncached FROM claude_events ORDER BY call_id").all()).toEqual(
        [0,1,2].map(i=>({call_id:`call-${i}`,path:`call-${i}.jsonl`,in_uncached:10})));
      // The publication recorded the day it changed, once per published row.
      expect(changedDays()).toEqual([{day:"*",revision:3},{day:"2026-01-10",revision:3}]);
      expect((active.query("SELECT revision FROM analysis_source_revisions WHERE source='claude_events' AND bucket='*'").get() as {revision:number}).revision).toBeGreaterThan(beforeRevision);
    } finally { instance.close(); active.close(); }
  });
}

test("stage filtering preserves same-name altered triggers and migration guards", () => {
  const {directory,dbPath}=createTestDatabase();
  directories.push(directory);
  const stage=new Database(dbPath);
  try {
    installAnalysisTracking(stage);
    installFactDayRevisions(stage);
    stage.exec(`CREATE TABLE stage_custom_audit(id INTEGER PRIMARY KEY);
      CREATE TRIGGER analysis_stage_custom_audit_insert AFTER INSERT ON stage_custom_audit BEGIN SELECT 1; END;
      DROP TRIGGER fact_day_revision_claude_events_insert;
      CREATE TRIGGER fact_day_revision_claude_events_insert AFTER INSERT ON claude_events
      BEGIN INSERT INTO stage_custom_audit(id) VALUES (NEW.rowid); END;
      DROP TRIGGER analysis_claude_events_delete;
      CREATE TRIGGER analysis_claude_events_delete BEFORE DELETE ON claude_events
      BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;`);
    const semanticBefore=(stage.query(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND (name LIKE 'analysis_stage_%' OR name LIKE 'probe_current_after_%') ORDER BY name`).all() as {name:string}[]).map(row=>row.name);
    omitStageAnalysisTracking(stage);
    const remaining=(stage.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='claude_events'").all() as {name:string}[]).map(row=>row.name);
    expect(remaining).toContain("fact_day_revision_claude_events_insert");
    expect(remaining).toContain("analysis_claude_events_delete");
    expect(remaining).not.toContain("analysis_claude_events_insert");
    const semanticAfter=(stage.query(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND (name LIKE 'analysis_stage_%' OR name LIKE 'probe_current_after_%') ORDER BY name`).all() as {name:string}[]).map(row=>row.name);
    expect(semanticBefore).toEqual(["analysis_stage_custom_audit_insert","probe_current_after_delete","probe_current_after_insert","probe_current_after_update"]);
    expect(semanticAfter).toEqual(semanticBefore);
    stage.query("INSERT INTO claude_events(store,call_id,path,ts) VALUES('pc','call','call.jsonl','2026-01-10T00:00:00.000Z')").run();
    expect(stage.query("SELECT COUNT(*) AS n FROM stage_custom_audit").get()).toEqual({n:1});
    expect(() => stage.query("DELETE FROM claude_events").run()).toThrow("analysis tracking reinstall pending");
  } finally {stage.close();}
});

test("selected Claude production adapter does not reinstall disposable stage tracking", async () => {
  const {directory,dbPath}=createTestDatabase();
  directories.push(directory);
  const input=path.join(directory,"source","session.jsonl");
  fs.mkdirSync(path.dirname(input),{recursive:true});
  fs.writeFileSync(input,JSON.stringify({type:"assistant",sessionId:"session",timestamp:"2026-01-10T10:00:00Z",
    message:{id:"call",model:"claude-sonnet",usage:{input_tokens:10,output_tokens:1}}})+"\n");
  const active=new Database(dbPath);
  const stagePath=path.join(directory,"stage.sqlite");
  try {
    installAnalysisTracking(active);
    installFactDayRevisions(active);
    active.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    fs.copyFileSync(dbPath, stagePath);
    const stage=new Database(stagePath);
    try { omitStageAnalysisTracking(stage); }
    finally {stage.close();}
    const result=await createProductionAdapters().claude({activeDbPath:dbPath,stageDbPath:stagePath,
      mode:"incremental",rootDir:directory,changedFiles:[input]});
    expect(result.processedInputs).toBe(1);
    const read=new Database(stagePath,{readonly:true});
    try {
      expect(read.query("SELECT call_id,in_uncached,out_total FROM claude_events").all())
        .toEqual([{call_id:"call",in_uncached:10,out_total:1}]);
      expect(read.query("SELECT COUNT(*) AS n FROM fact_day_revisions").get()).toEqual({n:0});
      expect(read.query("SELECT revision FROM analysis_source_revisions WHERE source='claude_events' AND bucket='*'").get())
        .toEqual(active.query("SELECT revision FROM analysis_source_revisions WHERE source='claude_events' AND bucket='*'").get());
      expect(read.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name='fact_day_revision_claude_events_insert'").get()).toBeNull();
    } finally {read.close();}
  } finally {active.close();}
});
