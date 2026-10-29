import { expect, test, spyOn } from "bun:test";
import { Database } from "./sqlite";
import { MODEL_TIMELINE_SCHEMA, advanceModelTimelines, readModelTimeline } from "./model-timeline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataVersion } from "../server/data-version";
import { handleCodexTimelineMarkers } from "../server/codex-timeline-markers";
import { createAnalysisSourceRevisions } from "./analysis-source-revisions.fixture";
import { ResponseCache } from "../server/cache";

test("timeline uses prepared raw minima, corrects and removes earliest evidence without reacting to timing-only writes", () => {
  const db=new Database(":memory:");
  try {
    db.exec(MODEL_TIMELINE_SCHEMA);
    db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,model TEXT,ts TEXT,resp_ms INTEGER);
      CREATE INDEX events_time ON events(ts);
      INSERT INTO events VALUES(1,'a','2026-01-01T10:00:00Z',100),(2,'a','2026-02-01T10:00:00Z',200),
        (3,'b','not-a-date',300),(4,'b','2026-02-01T10:00:00Z',400),(5,'empty-time','',500)`);
    expect(readModelTimeline(db,"codex").ready).toBe(false);
    expect(advanceModelTimelines(db,{limit:1,budgetMs:10000}).pending).toBe(true);
    expect(readModelTimeline(db,"codex").ready).toBe(false);
    const drain=()=>{for(let i=0;i<100;i++)if(!advanceModelTimelines(db,{limit:2,budgetMs:10000}).pending)return;throw new Error("not drained");};
    drain();
    const reference=()=>db.query("SELECT model,MIN(ts) first_ts FROM events GROUP BY model ORDER BY first_ts,model").all() as { model: string; first_ts: string }[];
    expect(readModelTimeline(db,"codex").models).toEqual(reference());
    db.exec("UPDATE events SET ts='2026-03-01' WHERE id=5");drain();
    expect(readModelTimeline(db,"codex").models).toEqual(reference());
    db.exec("UPDATE events SET resp_ms=resp_ms+100");
    expect(db.query("SELECT * FROM model_timeline_dirty").all()).toEqual([]);
    db.exec("DELETE FROM events WHERE id=1");
    expect(readModelTimeline(db,"codex").pending).toBe(true);drain();
    expect(readModelTimeline(db,"codex").models).toEqual(reference());
    db.exec("UPDATE events SET model='c',ts='2025-12-01' WHERE id=2");drain();
    expect(readModelTimeline(db,"codex").models).toEqual(reference());
    db.exec("DELETE FROM events WHERE model='b'");drain();
    expect(readModelTimeline(db,"codex").models).toEqual(reference());
    const changes=db.query("SELECT total_changes() n").get();
    const queries=spyOn(db,"query");
    try {readModelTimeline(db,"codex");expect(queries.mock.calls.some(([sql])=>/FROM events\b/.test(sql))).toBe(false);}
    finally {queries.mockRestore();}
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    expect(advanceModelTimelines(db,{budgetMs:10000})).toEqual({processed:0,pending:false});
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
  } finally {db.close();}
});

test("timeline resumes after reopening and advertises pending corrections before publishing a new version", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-model-timeline-")), file=path.join(root,"atlas.sqlite");
  let db=new Database(file);
  try {
    db.exec(MODEL_TIMELINE_SCHEMA);
    db.exec("CREATE TABLE events(model TEXT,ts TEXT); INSERT INTO events VALUES('m','2026-01-01'),('m','2026-02-01')");
    createAnalysisSourceRevisions(db);
    expect(advanceModelTimelines(db,{limit:1,budgetMs:10000}).pending).toBe(true);
    db.close();db=new Database(file);
    for(let i=0;i<10;i++)if(!advanceModelTimelines(db,{limit:1,budgetMs:10000}).pending)break;
    expect(readModelTimeline(db,"codex").models).toEqual([{model:"m",first_ts:"2026-01-01"}]);
    const before=dataVersion(db,{modelTimeline:"codex"}), unrelated=dataVersion(db);
    const cache=new ResponseCache(), unrelatedCache=cache.stamp(db);
    db.exec("DELETE FROM events WHERE ts='2026-01-01'");
    const pendingVersion=dataVersion(db,{modelTimeline:"codex"});
    expect(pendingVersion).not.toBe(before);expect(dataVersion(db)).toBe(unrelated);
    const response=await handleCodexTimelineMarkers(db,new Request("http://local/api/codex-timeline-markers"),root);
    expect(response.status).toBe(200);expect(response.headers.get("X-Data-Freshness")).toContain("pending");
    advanceModelTimelines(db,{budgetMs:10000});
    expect(dataVersion(db,{modelTimeline:"codex"})).not.toBe(pendingVersion);
    expect(cache.stamp(db)).toBe(unrelatedCache);
    expect(readModelTimeline(db,"codex").models).toEqual([{model:"m",first_ts:"2026-02-01"}]);
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
});
