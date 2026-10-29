import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { advanceModelSpeeds, MODEL_SPEED_SCHEMA } from "./model-speed-register";

function fixture() {
  const db = new Database(":memory:");
  db.exec(MODEL_SPEED_SCHEMA);
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source_offset INTEGER,effort TEXT);
    CREATE TABLE codex_price_ledger_copies(id INTEGER PRIMARY KEY,home TEXT,path TEXT);
    CREATE TABLE codex_price_ledger_dims(id INTEGER PRIMARY KEY,source TEXT,model TEXT,speed TEXT,service_tier TEXT,billing_mode TEXT);
    CREATE TABLE codex_price_ledger_events(id INTEGER PRIMARY KEY,copy_id INTEGER,source_offset INTEGER,dim_id INTEGER,
      ts TEXT,instant_ms INTEGER,admitted INTEGER,copy_state TEXT,output INTEGER,resp_ms INTEGER,common_reason TEXT,invalid_tokens INTEGER);
    INSERT INTO events VALUES(1,'h','p',1,'high');
    INSERT INTO codex_price_ledger_copies VALUES(1,'h','p');
    INSERT INTO codex_price_ledger_dims VALUES(1,'codex/pc','model','standard','default','allowance');
    INSERT INTO codex_price_ledger_events VALUES(1,1,1,1,'2026-10-29T00:00:00Z',1793232000000,1,'canonical',300,1000,NULL,0)`);
  advanceModelSpeeds(db, { budgetMs: 10000 });
  return db;
}

test("ledger UPSERT corrections and raw effort UPSERTs keep one pending timing per call", () => {
  const db = fixture();
  try {
    const correct = db.query(`INSERT INTO codex_price_ledger_events SELECT * FROM codex_price_ledger_events WHERE id=1
      ON CONFLICT(id) DO UPDATE SET output=output+10`);
    expect(() => correct.run()).not.toThrow();
    expect(() => correct.run()).not.toThrow();
    expect(() => db.exec(`INSERT INTO events VALUES(1,'h','p',1,'max') ON CONFLICT(id) DO UPDATE SET effort=excluded.effort`)).not.toThrow();
    expect(db.query("SELECT provider,event_id,priority FROM model_speed_queue").all()).toEqual([{ provider: "codex", event_id: 1, priority: 1 }]);
    advanceModelSpeeds(db, { budgetMs: 10000 });
    expect(db.query("SELECT calls,timed_out,timed_ms,effort FROM model_speed_hours").all())
      .toEqual([{ calls: 1, timed_out: 320, timed_ms: 1000, effort: "max" }]);
    const changes = db.query("SELECT total_changes() n").get();
    advanceModelSpeeds(db);
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
  } finally { db.close(); }
});

test("old timing triggers are repaired without reseeding history or replacing completed facts", () => {
  const db = fixture();
  try {
    db.exec(`DROP TRIGGER model_speed_codex_update;
      CREATE TRIGGER model_speed_codex_update AFTER UPDATE ON codex_price_ledger_events
      BEGIN INSERT OR IGNORE INTO model_speed_queue(provider,event_id) VALUES('codex',OLD.id);
        INSERT OR IGNORE INTO model_speed_queue(provider,event_id) VALUES('codex',NEW.id); END`);
    const facts = db.query("SELECT * FROM model_speed_facts").all();
    const state = db.query("SELECT * FROM model_speed_state").all();
    expect(advanceModelSpeeds(db, { budgetMs: 10000 })).toMatchObject({ processed: 0, pending: false, remaining: 0 });
    expect(db.query("SELECT * FROM model_speed_facts").all()).toEqual(facts);
    expect(db.query("SELECT * FROM model_speed_state").all()).toEqual(state);
    expect(() => db.exec(`INSERT INTO codex_price_ledger_events SELECT * FROM codex_price_ledger_events WHERE id=1
      ON CONFLICT(id) DO UPDATE SET output=output+10`)).not.toThrow();
    expect(advanceModelSpeeds(db, { budgetMs: 10000 }).processed).toBe(1);
  } finally { db.close(); }
});

test("shared provider corrections and deletions update the timing register once without duplicate queue failures", () => {
  const db = new Database(":memory:");
  try {
    db.exec(MODEL_SPEED_SCHEMA);
    db.exec(`CREATE TABLE claude_events(id INTEGER PRIMARY KEY,effort TEXT);
      CREATE TABLE usage_ledger_facts(provider TEXT,row_id INTEGER,dim_id INTEGER,ts TEXT,accounting INTEGER,copy_state TEXT,
        source TEXT,account_key TEXT,model TEXT,speed TEXT,q_out INTEGER,resp_ms INTEGER,usage_valid INTEGER,billing_mode TEXT,
        PRIMARY KEY(provider,row_id));
      INSERT INTO claude_events VALUES(1,'high');
      INSERT INTO usage_ledger_facts VALUES('claude',1,1,'2026-10-29T00:00:00Z',1,'canonical','claude/pc','a','model','standard',300,1000,1,'allowance')`);
    advanceModelSpeeds(db, { budgetMs: 10000 });
    const correct = () => db.exec(`INSERT INTO usage_ledger_facts SELECT * FROM usage_ledger_facts WHERE provider='claude' AND row_id=1
      ON CONFLICT(provider,row_id) DO UPDATE SET q_out=q_out+10`);
    expect(correct).not.toThrow(); expect(correct).not.toThrow();
    expect(() => db.exec("INSERT INTO claude_events VALUES(1,'max') ON CONFLICT(id) DO UPDATE SET effort=excluded.effort")).not.toThrow();
    expect(advanceModelSpeeds(db, { budgetMs: 10000 }).processed).toBe(1);
    expect(db.query("SELECT calls,timed_out,effort FROM model_speed_hours").all()).toEqual([{ calls: 1, timed_out: 320, effort: "max" }]);
    db.exec("DELETE FROM usage_ledger_facts WHERE provider='claude' AND row_id=1");
    advanceModelSpeeds(db, { budgetMs: 10000 });
    expect(db.query("SELECT * FROM model_speed_hours").all()).toEqual([]);
  } finally { db.close(); }
});
