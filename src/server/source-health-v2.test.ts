import { expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "../db/sqlite";
import { createTestDatabase } from "../sync/test-support";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { buildSourceHealth } from "./source-health";
import type { RateCard } from "./pricing";

test("Gemini source health follows periods while its physical store stays stable", () => {
  const fixture = createTestDatabase();
  const db = new Database(fixture.dbPath);
  const home = `${ARCHIVE_LOGICAL_ROOT}/gemini/PC-user`;
  const rates: RateCard = {version:1,currency:"USD",unit:"per 1M",vendors:{}};
  try {
    db.exec("CREATE TABLE ratelimit(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,used_percent REAL,window_minutes INTEGER,limit_id TEXT)");
    db.query(`INSERT INTO gemini_events(store,conversation_id,gen_idx,ts,ts_basis,path,fresh_in,cached_in,out_total,usd)
      VALUES ('source:gemini:PC-user','conversation',0,'2026-08-10T10:00:00.000Z','event',?,11,22,33,0)`).run(`${home}/conversations/a.db`);
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,[{provider:"gemini",subject:"gemini/pc-user",from:"2000-01-01",until:null,
      value:"seat-a",origin:"declared",firstSeen:null,lastSeen:null,readings:0,evidence:"fixture"}]);
    prepareUsageRegisters(db,rates);
    const accounts = {version:2 as const,subscriptions:[{id:"seat-a",vendor:"gemini"},{id:"seat-b",vendor:"gemini"}],
      sources:[{vendor:"gemini",machine:"PC",home,source_home:"C:/Users/user/.gemini"}]};
    const context = {sqlite:db,accounts};
    const before = buildSourceHealth(context,"2026-08-11T00:00:00Z","PC").sources.find(row=>row.archive===home);
    expect(before).toMatchObject({subscription:"seat-a",last_session:"2026-08-10T10:00:00.000Z"});
    const raw = db.query("SELECT store,path FROM gemini_events").all();
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,loadPeriods(db,ACCOUNT_PERIODS).filter(row=>row.origin==="declared")
      .map(row=>({...row,value:"seat-b"})));
    const after = buildSourceHealth(context,"2026-08-11T00:00:00Z","PC").sources.find(row=>row.archive===home);
    expect(after).toMatchObject({subscription:"seat-b",last_session:"2026-08-10T10:00:00.000Z"});
    expect(db.query("SELECT store,path FROM gemini_events").all()).toEqual(raw);
  } finally { db.close(); fs.rmSync(fixture.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});
