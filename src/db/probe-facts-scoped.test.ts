import {test,expect} from "bun:test";
import {Database} from "./sqlite";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {randomUUID} from "node:crypto";
import {applyDrizzleMigrations} from "./migrate";
import {canonicalJson,digest} from "../config/canonical-json";
import {acceptProbeFact,createProbeCollection,linkPublishedProbeFacts,mergeProbeFacts,PROBE_FACT_TABLES,type CanonicalProbe} from "./probe-facts";

function fixture() {
  const db=new Database(":memory:"); applyDrizzleMigrations(drizzle(db));
  db.exec("ATTACH DATABASE ':memory:' AS sync_stage");
  for(const table of PROBE_FACT_TABLES) db.exec(`CREATE TABLE sync_stage.${table} AS SELECT * FROM main.${table} WHERE 0`);
  db.exec("CREATE TABLE sync_stage.gauge_replay_counters(counter_id TEXT PRIMARY KEY,ts TEXT)");
  const ns=randomUUID();
  db.query("INSERT INTO sync_stage.probe_fact_backfill_checkpoints VALUES ('local',?,0,?)").run(ns,digest([]));
  db.query("UPDATE main.probe_fact_backfill_checkpoints SET cursor=0 WHERE id='local'").run();
  const fact=(day:string)=>createProbeCollection([{provider:"codex",subject:"A",ts:`2026-09-${day}T12:00:00Z`,kind:"weekly",reported_percent_side:"used",used_percent:20}])[0]!;
  const selected=fact("02"),outside=fact("03"),unselected=fact("02"),existing=fact("04");
  for(const c of [selected,outside,unselected]) {
    db.query("INSERT INTO sync_stage.probe_observations VALUES (?,?)").run(c.observation_id,canonicalJson(c.header));
    db.query("INSERT INTO sync_stage.probe_counters VALUES (?,?,?,?,?)").run(c.counter_id,c.observation_id,canonicalJson(c.discriminator),canonicalJson(c.payload),c.payload_digest);
    db.query("INSERT INTO sync_stage.probe_fact_deliveries VALUES (?,?,?)").run(`delivery:${c.counter_id}`,c.counter_id,"{}");
    db.query("INSERT INTO sync_stage.probe_fact_legacy_map VALUES (?,?,NULL,?,?,?)").run(`legacy:${c.counter_id}`,ns,c.payload_digest,c.counter_id,"legacy-journal-unresolved-origin");
    db.query("INSERT INTO sync_stage.probe_fact_legacy_map VALUES (?,?,123,?,?,?)").run(`temporary:${c.counter_id}`,ns,c.payload_digest,c.counter_id,"journal-projection");
  }
  for(const c of [selected,outside]) db.query("INSERT INTO sync_stage.gauge_replay_counters VALUES (?,?)").run(c.counter_id,c.payload.ts!);
  db.query("INSERT INTO sync_stage.probe_fact_conflicts VALUES (?,?,?,?,?)").run("unrelated","codex","synthetic","old","new");
  db.transaction(()=>acceptProbeFact(db,existing)).immediate();
  const project=(c:CanonicalProbe,id:number)=>{
    const keys=Object.keys(c.payload).filter(k=>!["source_home","raw_subject","login"].includes(k));
    db.query(`INSERT INTO probe_windows(id,${keys.join(",")}) VALUES (?,${keys.map(()=>"?").join(",")})`).run(id,...keys.map(k=>c.payload[k]!));
  };
  project(selected,10); project(existing,99);
  return {db,selected,outside,unselected,existing};
}

test("scoped fact merge intersects replay IDs with dates and links only selected live projections",()=>{
  const {db,selected,outside,unselected,existing}=fixture();
  try {
    const range={from:"2026-09-02T00:00:00Z",untilExclusive:"2026-09-03T00:00:00Z"};
    expect(db.transaction(()=>mergeProbeFacts(db,range,true)).immediate()).toBe(1);
    expect(db.query("SELECT id FROM probe_counters ORDER BY id").all()).toEqual([selected.counter_id,existing.counter_id].sort().map(id=>({id})));
    expect(db.query("SELECT id FROM probe_observations ORDER BY id").all()).toEqual([selected.observation_id,existing.observation_id].sort().map(id=>({id})));
    expect(db.query("SELECT counter_id FROM probe_fact_deliveries").all()).toEqual([{counter_id:selected.counter_id}]);
    expect(db.query("SELECT counter_id,legacy_id FROM probe_fact_legacy_map").all()).toEqual([{counter_id:selected.counter_id,legacy_id:null}]);
    expect(db.query("SELECT count(*) n FROM probe_fact_conflicts").get()).toEqual({n:0});
    db.transaction(()=>linkPublishedProbeFacts(db,true)).immediate();
    expect(db.query("SELECT counter_id,legacy_id FROM probe_fact_legacy_map WHERE legacy_id IS NOT NULL").all()).toEqual([{counter_id:selected.counter_id,legacy_id:10}]);
    expect(db.query("SELECT cursor FROM probe_fact_backfill_checkpoints WHERE id='local'").get()).toEqual({cursor:0});
    const maps=db.query("SELECT * FROM probe_fact_legacy_map ORDER BY id").all();
    expect(db.transaction(()=>mergeProbeFacts(db,range,true)).immediate()).toBe(0);
    db.transaction(()=>linkPublishedProbeFacts(db,true)).immediate();
    expect(db.query("SELECT * FROM probe_fact_legacy_map ORDER BY id").all()).toEqual(maps);
    expect(db.query("SELECT 1 FROM probe_counters WHERE id IN (?,?)").get(outside.counter_id,unselected.counter_id)).toBeNull();
  } finally {db.close(true);}
});

test("ordinary merge retains all evidence and global link checkpoint behavior",()=>{
  const {db}=fixture();
  try {
    expect(db.transaction(()=>mergeProbeFacts(db)).immediate()).toBe(3);
    expect(db.query("SELECT count(*) n FROM probe_fact_deliveries").get()).toEqual({n:3});
    expect(db.query("SELECT count(*) n FROM probe_fact_conflicts").get()).toEqual({n:1});
    db.transaction(()=>linkPublishedProbeFacts(db)).immediate();
    expect(db.query("SELECT cursor FROM probe_fact_backfill_checkpoints WHERE id='local'").get()).toEqual({cursor:99});
  } finally {db.close(true);}
});

test("replay-only merge without dates honors both populated and empty whitelists",()=>{
  for(const empty of [false,true]) {
    const {db,selected,outside}=fixture();
    try {
      if(empty) db.exec("DELETE FROM sync_stage.gauge_replay_counters");
      expect(db.transaction(()=>mergeProbeFacts(db,undefined,true)).immediate()).toBe(empty?0:2);
      expect(db.query("SELECT counter_id FROM probe_fact_deliveries ORDER BY counter_id").all())
        .toEqual(empty?[]:[selected.counter_id,outside.counter_id].sort().map(counter_id=>({counter_id})));
      db.transaction(()=>linkPublishedProbeFacts(db,true)).immediate();
      expect(db.query("SELECT cursor FROM probe_fact_backfill_checkpoints WHERE id='local'").get()).toEqual({cursor:0});
      expect(db.query("SELECT count(*) n FROM probe_fact_conflicts").get()).toEqual({n:0});
    } finally {db.close(true);}
  }
});
