import {expect,test} from "bun:test";
import {Database} from "./sqlite";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {migrate} from "drizzle-orm/bun-sqlite/migrator";
import {applyDrizzleMigrations} from "./migrate";
import {installAnalysisTracking} from "./analysis";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrationFixtureThrough } from "./migration-range.fixture";

const migrations=path.resolve(import.meta.dir,"../../drizzle");
const retired=["account_observations","analysis_attribution_dirty","logical_sources",
  "probe_attribution_checkpoints","probe_attribution_dirty","probe_attribution_generations",
  "probe_attribution_state","probe_attributions","ratelimit_owner","rollout_owner",
  "source_aliases","source_backfill_checkpoints","source_binding_conflicts",
  "source_binding_versions","source_machines","source_mapping_conflicts",
  "source_mapping_versions","source_replicas","source_runtimes",
  "subscription_fact_total_contributions","subscription_fact_total_days",
  "subscription_fact_total_dirty","subscription_fact_total_state",
  "subscription_price_contributions","subscription_price_days",
  "subscription_price_dependencies","subscription_price_dirty","subscription_price_state"];
/** The old register, fact index and valuation cache; migration 0047 drops them for the usage ledger. */
const replaced=[...fs.readFileSync(path.join(migrations,"0047_drop_usage_price_register.sql"),"utf8")
  .matchAll(/DROP TABLE IF EXISTS (\w+);/g)].map(match=>match[1]!);
const tableExists=(db:Database,table:string)=>!!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const measures=["calls","in_tok","cached_in","cache_read","cache_write","out_tok","reasoning",
  "in_uncached","in_cache_read","in_cache_write","cache_write_5m","cache_write_1h",
  "out_total","out_thinking","cost_ticks","vendor_usd"];
const columns=(db:Database,table:string)=>(db.query(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(row=>row.name);
const count=(db:Database,table:string)=>(db.query(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n;
function preW9Folder(root:string):string {
  const folder=path.join(root,"pre-w9");fs.mkdirSync(path.join(folder,"meta"),{recursive:true});
  const journal=JSON.parse(fs.readFileSync(path.join(migrations,"meta/_journal.json"),"utf8"));
  journal.entries=journal.entries.slice(0,41);
  fs.writeFileSync(path.join(folder,"meta/_journal.json"),JSON.stringify(journal));
  for(const entry of journal.entries)
    fs.copyFileSync(path.join(migrations,`${entry.tag}.sql`),path.join(folder,`${entry.tag}.sql`));
  return folder;
}
function fixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-w9-migration-"));
  const file=path.join(directory,"atlas.sqlite"),db=new Database(file,{create:true});
  return {directory,file,db,close(){this.db.close(true);fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}};
}
function seed(db:Database):void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS events(home TEXT,path TEXT,ts TEXT);
    CREATE TABLE IF NOT EXISTS ratelimit(home TEXT,path TEXT,ts TEXT);
    INSERT INTO meta VALUES('eras_fingerprint','retired'),('local_mapping_cache','retired'),('current_v2_probe_cursor','keep');
    INSERT INTO claude_events(store,call_id,ts,path,subscription_id,account_key)
      VALUES('physical','call','2026-09-01T10:00:00Z','archive/claude/a.jsonl','authentic-session','authentic-session');
    INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,era_unattributed)
      VALUES('claude','authentic-session','2026-09-01T11:00:00Z','weekly','used',1);
    INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence)
      VALUES('claude','claude/machine','2020-01-01','dated-owner','declared','test');
    INSERT INTO usage_price_scopes(scope,provider,version,cursor,phase,status,bookmark,rules_digest,sources,attribution,mirror_policy)
      VALUES('usage-price-8-claude','claude',8,42,'replay','ready','','rules','physical','',1);
    INSERT INTO usage_price_dims(scope,dim,account,home,model,speed)
      VALUES('usage-price-8-claude','dimension','authentic-session','claude/machine','model','standard');
    INSERT INTO usage_price_copies(scope,copy,home,path,account,mirror_identity,calls,last_ts,tokens,selected_all)
      VALUES('usage-price-8-claude','copy','physical','archive/claude/a.jsonl','claude/machine','mirror',3,'2026-09-01T10:00:00Z','[3]',1);
    INSERT INTO usage_price_meter_models(scope,home,path,meter_reset,day,account,spark,main)
      VALUES('usage-price-8-claude','physical','archive/claude/a.jsonl',-1,'2026-09-01','claude/machine',1,2);
    INSERT INTO usage_price_days(scope,day,dim,calls,first_ts,last_ts,tokens,tokens_reported,counts,quality)
      VALUES('usage-price-8-claude','2026-09-01','dimension',3,'2026-09-01T09:00:00Z','2026-09-01T10:00:00Z','[3]','[3]','{}','{}');
    INSERT INTO usage_price_contributions(scope,identity,day,copy,dim,ts,calls,tokens,tokens_reported,counts,quality,dependency)
      VALUES('usage-price-8-claude','fact','2026-09-01','copy','dimension','2026-09-01T10:00:00Z',3,'[3]','[3]','{}','{}','dependency');
    INSERT INTO usage_price_tasks(scope,copy,home,path,phase,bookmark)
      VALUES('usage-price-8-claude','copy','physical','archive/claude/a.jsonl','ready','checkpoint');
    INSERT INTO event_valuations(provider,identity,variant,day,facts_stamp,rules_stamp,source_stamp,value)
      VALUES('claude','["old","event","bare-account","copy"]','dated-actual-api','2026-09-01','fact','rule','source','old'),
            ('claude','["new","event","claude/machine","copy"]','dated-actual-api','2026-09-01','fact','rule','source','current'),
            ('codex','["old","event","bare-account","copy"]','dated-actual-api','2026-09-01','fact','rule','source','codex');`);
  const dims=["day","vendor","store","path","cwd","project","project_id","repo","model","speed","provider"];
  const insert=db.query(`INSERT INTO project_daily_rollups(${[...dims,"owner",...measures,"first_ts","last_ts"].join(",")})
    VALUES(${Array(dims.length+1+measures.length+2).fill("?").join(",")})`);
  for(let group=0;group<5;group++)for(let part=1;part<=2;part++)
    insert.run("2026-09-01","codex",`store-${group}`,"path","cwd","project",`project-${group}`,
      "repo","model","standard","openai",`owner-${part}`,
      ...measures.map((_,index)=>index===15?part/2:part*(index+1)),
      part===1?"2026-09-01T09:00:00Z":"2026-09-01T09:30:00Z",
      part===1?"2026-09-01T10:00:00Z":"2026-09-01T11:00:00Z");
  installAnalysisTracking(db);
}

const codexPriceTables=["codex_price_state","codex_price_scopes","codex_price_invalidations","codex_price_tasks",
  "codex_price_contributions","codex_price_copies","codex_price_copy_days","codex_price_days","codex_price_dependencies"];
/** Frozen copy of the pre-v8 register schema and revision triggers (6940edb~1:src/db/codex-price-totals.ts). */
function installPreV8CodexPriceRegister(db:Database):void {
  db.exec(`CREATE TABLE codex_price_state(scope TEXT PRIMARY KEY,version INTEGER NOT NULL,cursor INTEGER NOT NULL,status TEXT NOT NULL,rules TEXT NOT NULL,sources TEXT NOT NULL,attribution TEXT NOT NULL);
    CREATE TABLE codex_price_tasks(scope TEXT NOT NULL,copy TEXT NOT NULL,home TEXT NOT NULL,path TEXT NOT NULL,phase TEXT NOT NULL,bookmark TEXT NOT NULL,PRIMARY KEY(scope,copy));
    CREATE TABLE codex_price_contributions(scope TEXT NOT NULL,identity TEXT NOT NULL,copy TEXT NOT NULL,day TEXT NOT NULL,ts TEXT NOT NULL,tokens TEXT NOT NULL,dependency TEXT NOT NULL,counts TEXT NOT NULL,PRIMARY KEY(scope,identity));
    CREATE TABLE codex_price_copies(scope TEXT NOT NULL,copy TEXT NOT NULL,home TEXT NOT NULL,path TEXT NOT NULL,identity TEXT NOT NULL,calls INTEGER NOT NULL,last TEXT NOT NULL,tokens TEXT NOT NULL,selected INTEGER NOT NULL,PRIMARY KEY(scope,copy));
    CREATE INDEX codex_price_copy_source_scope ON codex_price_copies(home,path,scope);
    CREATE TABLE codex_price_copy_days(scope TEXT NOT NULL,copy TEXT NOT NULL,day TEXT NOT NULL,counts TEXT NOT NULL,PRIMARY KEY(scope,copy,day));
    CREATE TABLE codex_price_days(scope TEXT NOT NULL,day TEXT NOT NULL,counts TEXT NOT NULL,PRIMARY KEY(scope,day));
    CREATE TABLE codex_price_dependencies(scope TEXT NOT NULL,dependency TEXT NOT NULL,model TEXT,day TEXT NOT NULL,stamp TEXT NOT NULL,bookmark TEXT,PRIMARY KEY(scope,dependency));
    CREATE TABLE codex_price_scopes(scope TEXT PRIMARY KEY,account TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,prepared_revision INTEGER NOT NULL,applying_revision INTEGER,scoped_from INTEGER NOT NULL);
    CREATE TABLE codex_price_invalidations(scope TEXT NOT NULL,revision INTEGER NOT NULL,source TEXT NOT NULL,before_json TEXT,after_json TEXT,PRIMARY KEY(scope,revision));
    INSERT INTO codex_price_scopes VALUES('scope','owner',1,1,NULL,0);
    INSERT INTO codex_price_copies VALUES('scope','copy','home','path','identity',1,'2026-09-01','[]',1);`);
  const eventColumns=columns(db,"events");
  const eventJson=(side:string)=>`json_object(${eventColumns.map(column=>`'${column}',${side}."${column}"`).join(",")})`;
  const affected=(sides:readonly string[],owner:boolean)=>sides.flatMap(side=>[owner
    ? `SELECT s.scope FROM codex_price_scopes s WHERE s.account=lower(trim(${side}.account)) AND trim(coalesce(${side}.account,''))<>''`
    : `SELECT s.scope FROM rollout_owner o JOIN codex_price_scopes s ON s.account=o.account WHERE o.home=${side}.home AND o.path=${side}.path`,
    `SELECT c.scope FROM codex_price_copies c WHERE c.home=${side}.home AND c.path=${side}.path AND c.calls>0`]).join(" UNION ");
  const invalidate=(source:string,scopes:string,before:string,after:string)=>`
    UPDATE codex_price_scopes SET revision=revision+1 WHERE scope IN (${scopes});
    INSERT INTO codex_price_invalidations(scope,revision,source,before_json,after_json)
      SELECT scope,revision,'${source}',${before},${after} FROM codex_price_scopes WHERE scope IN (${scopes});`;
  for(const operation of ["insert","update","delete"] as const) {
    const sides=operation==="insert"?["NEW"]:operation==="delete"?["OLD"]:["OLD","NEW"];
    const when=operation==="update"?`WHEN ${["home","path","ts","in_tok"].map(c=>`OLD."${c}" IS NOT NEW."${c}"`).join(" OR ")}`:"";
    db.exec(`CREATE TRIGGER codex_price_revision_events_${operation} AFTER ${operation.toUpperCase()} ON events ${when} BEGIN
      ${invalidate("events",affected(sides,false),operation==="insert"?"NULL":eventJson("OLD"),operation==="delete"?"NULL":eventJson("NEW"))} END`);
    db.exec(`CREATE TRIGGER codex_price_revision_rollout_owner_${operation} AFTER ${operation.toUpperCase()} ON rollout_owner BEGIN
      ${invalidate("rollout_owner",affected(sides,true),"NULL","NULL")} END`);
  }
}
/**
 * The live database still carries the W6 dirty-queue side effect on its Codex tracking triggers, together
 * with the former clock per stored day (frozen copy of that tracking).
 */
function installFormerDirtyTracking(db:Database):void {
  db.exec("CREATE TABLE IF NOT EXISTS analysis_attribution_dirty(home TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(home,path))");
  const dirty=(side:string)=>`INSERT OR IGNORE INTO analysis_attribution_dirty(home,path)
    VALUES (COALESCE(${side}.home,''),COALESCE(${side}.path,''));`;
  for(const table of ["events","ratelimit"])for(const operation of ["insert","update","delete"] as const) {
    const bump=(side:string)=>`INSERT INTO analysis_source_revisions(source,bucket,revision)
      VALUES ('${table}',COALESCE(substr(${side}."ts",1,10),''),1)
      ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1;
      INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('${table}','*',1)
      ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1;`;
    const when=operation==="update"?`WHEN ${columns(db,table).map(c=>`OLD."${c}" IS NOT NEW."${c}"`).join(" OR ")}`:"";
    const side=operation==="insert"?"NEW":"OLD";
    const body=operation==="update"?`${bump("OLD")} ${bump("NEW")} ${dirty("OLD")} ${dirty("NEW")}`:`${bump(side)} ${dirty(side)}`;
    db.exec(`DROP TRIGGER analysis_${table}_${operation}`);
    db.exec(`CREATE TRIGGER analysis_${table}_${operation} AFTER ${operation.toUpperCase()} ON "${table}" ${when} BEGIN ${body} END`);
  }
}
const retiredReference=new RegExp(`\\b(${[...retired,...codexPriceTables,"analysis_tracking_handoff","era_unattributed"].join("|")})\\b|reinstall pending`);
function assertNoRetiredReferences(db:Database):void {
  const objects=db.query("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<{type:string;name:string;sql:string}>;
  expect(objects.filter(object=>retiredReference.test(object.name)||retiredReference.test(object.sql))).toEqual([]);
  expect(columns(db,"project_daily_rollups")).not.toContain("owner");
  // Renaming revalidates every trigger and view of the schema.
  db.exec("BEGIN; ALTER TABLE probe_windows RENAME TO probe_windows_w9_check; ALTER TABLE probe_windows_w9_check RENAME TO probe_windows; ROLLBACK;");
}
const revisionsOf=(db:Database,sources:readonly string[])=>db.query(`SELECT * FROM analysis_source_revisions
  WHERE source IN (${sources.map(()=>"?").join(",")}) ORDER BY source,bucket`).all(...sources);
const trackedSources=["events","ratelimit","probe_windows","claude_events"] as const;
function preV8Database(f:ReturnType<typeof fixture>) {
  migrate(drizzle(f.db),{migrationsFolder:preW9Folder(f.directory)});
  f.db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,in_tok INTEGER);
    CREATE TABLE ratelimit(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,used_percent REAL);
    CREATE TABLE rollout_owner(home TEXT,path TEXT,account TEXT,PRIMARY KEY(home,path));
    INSERT INTO rollout_owner VALUES('home','path','owner');
    INSERT INTO events(home,path,source_offset,ts,model,in_tok) VALUES('home','path',1,'2026-09-01T10:00:00Z','gpt',10);
    INSERT INTO ratelimit(home,path,ts,used_percent) VALUES('home','path','2026-09-01T10:00:00Z',5);`);
  seed(f.db);
  installFormerDirtyTracking(f.db);
  installPreV8CodexPriceRegister(f.db);
  return {revisions:revisionsOf(f.db,trackedSources)};
}

test("W9 removes the pre-v8 Codex register and keeps change clocks while later corrections advance them",()=>{
  const f=fixture();
  try {
    const before=preV8Database(f);
    // The failure the migration must not leave behind: the old trigger reads the dropped owner table.
    expect(f.db.query("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND sql LIKE '%rollout_owner%' AND tbl_name='events'").get()).toEqual({n:3});
    applyDrizzleMigrations(drizzle(f.db));
    for(const table of codexPriceTables)expect(f.db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(table)).toBeNull();
    assertNoRetiredReferences(f.db);
    // Intentional trigger replacement and identical merged sums keep every revision.
    expect(revisionsOf(f.db,trackedSources)).toEqual(before.revisions);

    const revision=(source:string)=>(f.db.query("SELECT revision FROM analysis_source_revisions WHERE source=? AND bucket='*'")
      .get(source) as {revision:number}).revision;
    const clocks=Object.fromEntries(trackedSources.map(source=>[source,revision(source)]));
    f.db.exec("INSERT INTO events(home,path,source_offset,ts,model,in_tok) VALUES('home','path',2,'2026-09-01T11:00:00Z','gpt',20)");
    f.db.exec("UPDATE events SET in_tok=30 WHERE source_offset=2");
    f.db.exec("DELETE FROM events WHERE source_offset=2");
    expect(revision("events")).toBe(clocks.events!+3);
    f.db.exec("UPDATE ratelimit SET used_percent=6");
    expect(revision("ratelimit")).toBe(clocks.ratelimit!+1);
    f.db.exec("UPDATE probe_windows SET used_percent=40");
    expect(revision("probe_windows")).toBe(clocks.probe_windows!+1);
    expect(revision("claude_events")).toBe(clocks.claude_events!);
    // Only whole-table clocks remain and grow.
    expect(f.db.query("SELECT COUNT(*) n FROM analysis_source_revisions WHERE bucket<>'*'").get()).toEqual({n:0});
    expect(f.db.query("SELECT 1 FROM sqlite_master WHERE name='analysis_attribution_dirty'").get()).toBeNull();
  } finally {f.close();}
});

test("W9 invalidates only sources whose former tracking was missing or not exact",()=>{
  const f=fixture();
  try {
    const before=preV8Database(f);
    const current=(f.db.query("SELECT sql FROM sqlite_master WHERE name='analysis_probe_windows_update'").get() as {sql:string}).sql;
    f.db.exec("DROP TRIGGER analysis_probe_windows_update");
    f.db.exec(current.replace(/WHEN .*? BEGIN/s,"WHEN OLD.ts IS NOT NEW.ts BEGIN"));
    f.db.exec("UPDATE probe_windows SET used_percent=70");
    applyDrizzleMigrations(drizzle(f.db));
    assertNoRetiredReferences(f.db);
    // The inexact predicate missed the update above, so the migration advances the probe clock.
    const probe=(rows:unknown[])=>rows.filter(row=>(row as {source:string}).source==="probe_windows");
    expect(probe(revisionsOf(f.db,["probe_windows"]))).not.toEqual(probe(before.revisions));
    expect(revisionsOf(f.db,["events","ratelimit","claude_events"])).toEqual(before.revisions
      .filter(row=>["events","ratelimit","claude_events"].includes((row as {source:string}).source)));
  } finally {f.close();}
});

test("chained handoffs preserve broken Claude tracking as evidence requiring invalidation",()=>{
  const f=fixture();
  try {
    const before=preV8Database(f);
    f.db.exec("DROP TRIGGER analysis_claude_events_update");
    applyDrizzleMigrations(drizzle(f.db));
    const rows=revisionsOf(f.db,trackedSources);
    expect(rows.filter(row=>(row as {source:string}).source!=="claude_events")).toEqual(before.revisions
      .filter(row=>(row as {source:string}).source!=="claude_events"));
    expect(rows.filter(row=>(row as {source:string}).source==="claude_events")).not.toEqual(before.revisions
      .filter(row=>(row as {source:string}).source==="claude_events"));
    expect(f.db.query("SELECT value FROM meta WHERE key='migration_claude_tracking_handoff'").get()).toBeNull();
    assertNoRetiredReferences(f.db);
  } finally {f.close();}
});

test("a failed chained upgrade retries with the original durable tracking evidence",()=>{
  const f=fixture();
  try {
    const before=preV8Database(f);
    const folder=migrationFixtureThrough(f.directory,"0095_first_token");
    const file=path.join(folder,"0092_claude_billing_mode.sql"),original=fs.readFileSync(file,"utf8");
    fs.appendFileSync(file,"\n--> statement-breakpoint\nSELECT missing_migration_fixture_function();\n");
    expect(()=>applyDrizzleMigrations(drizzle(f.db),folder)).toThrow();
    expect(f.db.query("SELECT value FROM meta WHERE key='migration_claude_tracking_handoff'").get()).not.toBeNull();
    expect(revisionsOf(f.db,trackedSources)).toEqual(before.revisions);
    fs.writeFileSync(file,original);
    applyDrizzleMigrations(drizzle(f.db),folder);
    expect(revisionsOf(f.db,trackedSources)).toEqual(before.revisions);
    expect(f.db.query("SELECT value FROM meta WHERE key='migration_claude_tracking_handoff'").get()).toBeNull();
    assertNoRetiredReferences(f.db);
  } finally {f.close();}
});

for (const installed of [false,true]) test(`tracking recovery survives reopen ${installed ? "after" : "before"} installer commit`,()=>{
  const f=fixture();
  try {
    const before=preV8Database(f);
    const folder=migrationFixtureThrough(f.directory,"0095_first_token");
    const file=path.join(folder,"0092_claude_billing_mode.sql"),original=fs.readFileSync(file,"utf8");
    fs.appendFileSync(file,"\n--> statement-breakpoint\nSELECT missing_migration_fixture_function();\n");
    expect(()=>applyDrizzleMigrations(drizzle(f.db),folder)).toThrow();
    fs.writeFileSync(file,original);
    migrate(drizzle(f.db),{migrationsFolder:folder});
    const saved=f.db.query("SELECT value FROM meta WHERE key='migration_claude_tracking_handoff'").get() as {value:string};
    expect(saved).not.toBeNull();
    if(installed) {
      const evidence=JSON.parse(saved.value);
      f.db.query("UPDATE analysis_tracking_handoff SET columns=?,triggers=? WHERE source='claude_events'").run(evidence.columns,evidence.triggers);
      installAnalysisTracking(f.db);
    }
    f.db.close(true);
    f.db=new Database(f.file);
    applyDrizzleMigrations(drizzle(f.db),folder);
    expect(revisionsOf(f.db,trackedSources)).toEqual(before.revisions);
    expect(f.db.query("SELECT value FROM meta WHERE key='migration_claude_tracking_handoff'").get()).toBeNull();
    assertNoRetiredReferences(f.db);
    f.db.exec("UPDATE claude_events SET in_uncached=in_uncached+1");
    expect(revisionsOf(f.db,trackedSources)).not.toEqual(before.revisions);
  } finally {f.close();}
});

test("W9 guards reject source writes until tracking is reinstalled",()=>{
  const f=fixture();
  try {
    preV8Database(f);
    migrate(drizzle(f.db),{migrationsFolder:migrations});
    expect(()=>f.db.exec("UPDATE probe_windows SET used_percent=1")).toThrow("analysis tracking reinstall pending");
    // Former Codex tracking stays intact, together with the queue it writes, until reinstalled.
    const star=()=>(f.db.query("SELECT revision FROM analysis_source_revisions WHERE source='events' AND bucket='*'").get() as {revision:number}).revision;
    const events=star();
    // The former trigger bumps the whole-table clock once per side of an update.
    f.db.exec("UPDATE events SET in_tok=11");
    expect(star()).toBe(events+2);
    installAnalysisTracking(f.db);
    f.db.exec("UPDATE probe_windows SET used_percent=1; UPDATE events SET in_tok=12");
    expect(star()).toBe(events+3);
    assertNoRetiredReferences(f.db);
  } finally {f.close();}
});

test("fresh schema has the usage ledger's physical columns and no retired or replaced tables or columns",()=>{
  const f=fixture();
  try {
    applyDrizzleMigrations(drizzle(f.db));
    for(const table of retired)expect(tableExists(f.db,table)).toBe(false);
    expect(retired).toHaveLength(28);
    expect(replaced).toEqual(expect.arrayContaining(["usage_price_scopes","event_valuations","subscription_fact_versions"]));
    for(const table of replaced)expect(tableExists(f.db,table)).toBe(false);
    expect(columns(f.db,"probe_windows")).not.toContain("era_unattributed");
    expect(tableExists(f.db,"project_daily_rollups")).toBe(false);
    expect(columns(f.db,"usage_ledger_dims")).toEqual(expect.arrayContaining(["identity","source"]));
    expect(columns(f.db,"usage_ledger_facts")).toEqual(expect.arrayContaining(["source","account_key","identity_conflict"]));
    expect(columns(f.db,"claude_events")).toContain("subscription_id");
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    assertNoRetiredReferences(f.db);
  } finally {f.close();}
});

test("upgrade drops the replaced register and the daily summaries and preserves probes, periods and restart state",()=>{
  const f=fixture();
  let closed=false;
  try {
    migrate(drizzle(f.db),{migrationsFolder:preW9Folder(f.directory)});
    seed(f.db);
    const before={
      period:f.db.query("SELECT * FROM account_periods").all(),
      probe:f.db.query("SELECT id,provider,subject,ts,kind,reported_percent_side FROM probe_windows").all(),
      claude:f.db.query("SELECT store,call_id,subscription_id,account_key FROM claude_events").all(),
    };
    expect(count(f.db,"project_daily_rollups")).toBe(10);
    applyDrizzleMigrations(drizzle(f.db));
    // W9 merged the owner collisions of the daily summaries; the ledgers replaced those tables (0054).
    expect(tableExists(f.db,"project_daily_rollups")).toBe(false);
    // The old register's rows go with its tables; the usage ledger refills from the retained sources.
    for(const table of replaced)expect(tableExists(f.db,table)).toBe(false);
    expect(count(f.db,"usage_ledger_state")).toBe(0);
    expect(f.db.query("SELECT * FROM account_periods").all()).toEqual(before.period);
    expect(f.db.query("SELECT id,provider,subject,ts,kind,reported_percent_side FROM probe_windows").all()).toEqual(before.probe);
    expect(f.db.query("SELECT store,call_id,subscription_id,account_key FROM claude_events").all()).toEqual(before.claude);
    // Stage 4 keeps the current projection's state; 0058 later starts that projection over from the readings' evidence.
    expect(f.db.query("SELECT key,value FROM meta ORDER BY key").all()).toEqual([]);
    expect(count(f.db,"probe_source_dirty")).toBe(before.probe.length);
    for(const table of retired)expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeNull();
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    assertNoRetiredReferences(f.db);
    f.db.close(true);
    closed=true;
    const reopened=new Database(f.file);
    try {
      applyDrizzleMigrations(drizzle(reopened));
      for(const table of replaced)expect(tableExists(reopened,table)).toBe(false);
      expect(reopened.query("SELECT store,call_id,subscription_id,account_key FROM claude_events").all()).toEqual(before.claude);
      expect(tableExists(reopened,"project_daily_rollups")).toBe(false);
      for(const table of retired)expect(reopened.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeNull();
    } finally {reopened.close(true);}
  } finally {
    if(!closed)f.db.close(true);
    fs.rmSync(f.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
