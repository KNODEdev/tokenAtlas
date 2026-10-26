import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { ensureLimitWindowSchema } from "../db/limit-windows";
import { readClaudeRosterMeters } from "./roster-meters";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("basic meters use only current committed windows, survive restart and preserve unknown baselines", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-roster-meters-"));
  const file=path.join(root,"copy.sqlite"); let db=new Database(file,{create:true});
  const now=Date.parse("2026-10-18T11:12:00Z"), iso=(at:number)=>new Date(at).toISOString();
  try {
    ensureLimitWindowSchema(db);
    db.query("INSERT INTO limit_window_state(provider,account,scope,version,status) VALUES('claude','seat','*',1,'ready')").run();
    const insert=db.query(`INSERT INTO limit_windows
      (provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_detail,
      plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input)
      VALUES('claude','seat',?,?,?,?,?,?,'scheduled',?,NULL,NULL,0,?,NULL,NULL,NULL,0,'fixture')`);
    const week='["weekly_all","weekly",10080]', session='["session","session",300]';
    // Old reading payloads must not be decoded or confused with the reset's 0/1%.
    insert.run(week,0,"old",iso(now-8*86400000),iso(now-86400000),iso(now-86400000),10080,"not-json");
    const start=now-12*60000, end=start+7*86400000;
    insert.run(week,1,"new",iso(start),iso(end),iso(end),10080,JSON.stringify([
      {ts:iso(start),percent:0,source:"probe"},{ts:iso(now-60000),percent:1,source:"probe"}]));
    const sessionEnd=now+4*3600000;
    insert.run(session,0,"session",iso(now-20*60000),iso(sessionEnd),iso(sessionEnd),300,
      JSON.stringify([{ts:iso(now-60000),percent:7,source:"probe"}]));
    const before=readClaudeRosterMeters(db,"seat",now);
    expect(before).toMatchObject({weekly:{window_id:"new",percent:1,baseline_percent:0,measured_at:iso(now-60000)},
      session:{percent:7,baseline_percent:null}});
    db.close();db=new Database(file,{readonly:true});
    expect(readClaudeRosterMeters(db,"SEAT",now)).toEqual(before);
    expect(readClaudeRosterMeters(db,"seat",end+1)).toEqual({weekly:null,session:null});
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
