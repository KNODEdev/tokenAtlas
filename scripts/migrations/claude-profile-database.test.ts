import { expect, test } from "bun:test";
import path from "node:path";
import { Database } from "../../src/db/sqlite";
import { installAnalysisTracking } from "../../src/db/analysis";
import { migrateClaudeProfileDatabase } from "./claude-profile-database";

const root=path.resolve("archive-test"),bindings=[{logical:"projects",physical:"claude/MAIN",store:"hub"},{logical:"projectAsus",physical:"claude/LAPTOP",store:"asus"}];
function fixture(){
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE analysis_source_revisions(source TEXT NOT NULL,bucket TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(source,bucket));
    CREATE TABLE claude_events(id INTEGER PRIMARY KEY,store TEXT,path TEXT,call_id TEXT,ts TEXT,model TEXT,speed TEXT,in_uncached INTEGER,out_total INTEGER,subscription_id TEXT, UNIQUE(store,call_id));
    CREATE TABLE claude_files(store TEXT,path TEXT,size INTEGER,mtime REAL,parser_version INTEGER,PRIMARY KEY(store,path));`);
  db.query("INSERT INTO claude_events VALUES(7,'hub',?,'call','2026-09-01T00:00:00Z','m','standard',15,9,NULL)").run(path.join(root,"projects/session.jsonl"));
  db.query("INSERT INTO claude_files VALUES('hub',?,100,123456,3)").run(path.join(root,"projects/session.jsonl"));
  installAnalysisTracking(db); return db;
}
test("one-time conversion preserves row IDs, bookmarks and revision clocks",()=>{
  const db=fixture();
  try{
    const revisions=db.query("SELECT * FROM analysis_source_revisions ORDER BY source,bucket").all();
    migrateClaudeProfileDatabase(db,root,bindings,"test");
    expect(db.query("SELECT id,store,path,in_uncached,out_total FROM claude_events").get()).toEqual({id:7,store:"live",path:path.join(root,"claude/MAIN/session.jsonl"),in_uncached:15,out_total:9});
    expect(db.query("SELECT * FROM claude_files").get()).toEqual({store:"live",path:path.join(root,"claude/MAIN/session.jsonl"),size:100,mtime:123456,parser_version:3});
    expect(db.query("SELECT * FROM analysis_source_revisions ORDER BY source,bucket").all()).toEqual(revisions);
    expect(migrateClaudeProfileDatabase(db,root,bindings,"test")).toEqual({alreadyComplete:true});
  }finally{db.close();}
});
test("an identity collision rolls back data conversion and restores normal triggers",()=>{
  const db=fixture();
  try{
    db.query("INSERT INTO claude_events VALUES(8,'live',?,'call','2026-09-02','m','standard',1,2,NULL)").run(path.join(root,"claude/MAIN/conflict.jsonl"));
    const rows=db.query("SELECT * FROM claude_events ORDER BY id").all();
    const triggers=db.query("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    expect(()=>migrateClaudeProfileDatabase(db,root,bindings,"test")).toThrow();
    expect(db.query("SELECT * FROM claude_events ORDER BY id").all()).toEqual(rows);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).toEqual(triggers);
  }finally{db.close();}
});

test("portable source paths convert consistently",()=>{
  for(const slash of ['/','\\']) {
    const db=fixture();
    try {
      const old=path.join(root,'projects/session.jsonl').replace(/[\\/]/g,slash),next=path.join(root,'claude/MAIN/session.jsonl').replace(/[\\/]/g,slash);
      db.query("UPDATE claude_events SET path=?").run(old);db.query("UPDATE claude_files SET path=?").run(old);
      migrateClaudeProfileDatabase(db,root,bindings,'portable');
      expect(db.query("SELECT path,store FROM claude_events").get()).toEqual({path:next,store:'live'});
    } finally {db.close();}
  }
});
