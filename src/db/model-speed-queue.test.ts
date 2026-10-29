import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { MODEL_SPEED_SCHEMA } from "./model-speed-register";
import { modelSpeedQueueBatch, modelSpeedQueueRemaining, recordModelSpeedService, promoteTimingWork } from "./model-speed-queue";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("urgent promotions retain FIFO position and counts; small turns rotate providers and reserve history", () => {
  const db = new Database(":memory:");
  try {
    db.exec(MODEL_SPEED_SCHEMA);
    for (const provider of ["claude", "codex"]) for (let id=1;id<=20;id++)
      db.query("INSERT INTO model_speed_queue(provider,event_id) VALUES(?,?)").run(provider,id);
    const promote = db.query(`INSERT INTO model_speed_queue(provider,event_id,priority,queued_at) VALUES(?,?,1,?) ${promoteTimingWork}`);
    promote.run("codex", 19, 100); promote.run("codex", 18, 200); promote.run("codex", 19, 300);
    expect(modelSpeedQueueRemaining(db)).toBe(40);
    expect(db.query("SELECT queued_at FROM model_speed_queue WHERE provider='codex' AND event_id=19").get()).toEqual({ queued_at: 100 });
    const served: {provider:string;event_id:number}[]=[];
    for(let turn=0;turn<8;turn++) db.transaction(()=>{
      const row=modelSpeedQueueBatch(db,1)[0]!;served.push(row);
      db.query("DELETE FROM model_speed_queue WHERE provider=? AND event_id=?").run(row.provider,row.event_id);
      recordModelSpeedService(db,new Map([[row.provider,1]]));
    }).immediate();
    expect(served.slice(0,2).map(row=>row.provider)).toEqual(["claude","codex"]);
    expect(served.filter(row=>row.provider==='codex').slice(0,2).map(row=>row.event_id)).toEqual([19,18]);
    expect(served.some(row=>row.provider==='codex'&&row.event_id===1)).toBe(true);
    expect(modelSpeedQueueRemaining(db)).toBe(32);
    const snapshot=db.query("SELECT * FROM model_speed_queue_counts ORDER BY provider").all();
    expect(()=>db.transaction(()=>{db.exec("DELETE FROM model_speed_queue");throw new Error("rollback");}).immediate()).toThrow("rollback");
    expect(db.query("SELECT * FROM model_speed_queue_counts ORDER BY provider").all()).toEqual(snapshot);
  } finally { db.close(); }
});

test("queue scheduling and exact pending counts survive reopening between one-record turns", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-speed-queue-")),file=path.join(root,"queue.sqlite");
  let db=new Database(file);
  try {
    db.exec(MODEL_SPEED_SCHEMA);
    db.exec("INSERT INTO model_speed_queue(provider,event_id) VALUES('claude',1),('codex',1)");
    const row=modelSpeedQueueBatch(db,1)[0]!;
    db.transaction(()=>{db.query("DELETE FROM model_speed_queue WHERE provider=? AND event_id=?").run(row.provider,row.event_id);
      recordModelSpeedService(db,new Map([[row.provider,1]]));}).immediate();
    expect(row.provider).toBe('claude');db.close();db=new Database(file);
    expect(modelSpeedQueueRemaining(db)).toBe(1);expect(modelSpeedQueueBatch(db,1)[0]?.provider).toBe('codex');
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
});
