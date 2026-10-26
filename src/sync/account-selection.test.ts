import {afterEach,expect,test} from "bun:test";
import {Database} from "../db/sqlite";
import fs from "node:fs";
import {removeTestFixture} from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import {accountReparseSelection,accountReparseOwnershipStamp} from "./account-selection";
import {buildAccountResolver} from "../server/account-resolver";
import {ARCHIVE_LOGICAL_ROOT} from "../config/paths";
import {preserveReparseOutsideRange,type ReparsePlan} from "./reparse";

const directories:string[]=[];
afterEach(()=>{
  Bun.gc(true);
  for(const directory of directories.splice(0))removeTestFixture(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});
});
function pair() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-account-owners-"));directories.push(directory);
  return {active:new Database(path.join(directory,"active.sqlite")),stage:new Database(path.join(directory,"stage.sqlite"))};
}
for(const vendor of ["claude","grok","gemini","opencode"] as const)test(`${vendor} account repair uses historical subscription ownership in a shared source`,()=>{
  const {active,stage}=pair();
  const declared=vendor==="opencode"?"glm":vendor;
  const period=(value:string,from:string,until:string)=>({provider:declared,subject:`${declared}/shared`,from,until,value,
    origin:"declared" as const,firstSeen:null,lastSeen:null,readings:0,evidence:"fixture"});
  const resolver=buildAccountResolver([period("a","2026-01-01","2026-09-02"),period("b","2026-09-02","2026-09-03")]);
  const file=vendor==="opencode"?"same":`${ARCHIVE_LOGICAL_ROOT}/${declared}/shared/session.jsonl`;
  const spec={identity:["store","path"],bookmarkTable:null},identities=[{store:"shared",path:file}];
  for(const db of [active,stage]) {
    db.exec(`CREATE TABLE facts(row_key TEXT PRIMARY KEY,store TEXT,path TEXT,ts TEXT,
      provider TEXT,account_key TEXT,subscription_id TEXT,subscription_conflict INTEGER,value INTEGER)`);
    db.query(`INSERT INTO facts VALUES('a','shared',?,'2026-09-01T12:00:00Z','zai-coding-plan',NULL,NULL,0,1),
      ('b','shared',?,'2026-09-02T12:00:00Z','zai-coding-plan',NULL,NULL,0,9007199254740993)`).run(file,file);
  }
  let selection:ReturnType<typeof accountReparseSelection>|undefined;
  try {
    stage.exec("UPDATE facts SET value=10 WHERE row_key='a'");
    selection=accountReparseSelection(active,stage,vendor,[{vendor,account:"a"}],resolver,spec,identities);
    const plan:ReparsePlan={identities,sources:[],unavailable:[],protectedBookmarks:[],partialIdentities:new Set(),selection};
    preserveReparseOutsideRange(active,stage,spec,["facts"],identities,plan);
    expect(stage.query("SELECT row_key,CAST(value AS TEXT) AS value FROM facts ORDER BY row_key").all())
      .toEqual([{row_key:"a",value:"10"},{row_key:"b",value:"9007199254740993"}]);
    expect([...plan.selectedDays!]).toEqual(["2026-09-01"]);
    selection.dispose();selection=undefined;
    // A missing historical owner is an error, not permission to discard a row.
    stage.exec(vendor==="claude"?"UPDATE facts SET subscription_conflict=1 WHERE row_key='b'"
      :"UPDATE facts SET ts='invalid-time' WHERE row_key='b'");
    selection=accountReparseSelection(active,stage,vendor,[{vendor,account:"a"}],resolver,spec,identities);
    expect(()=>preserveReparseOutsideRange(active,stage,spec,["facts"],identities,{...plan,selection}))
      .toThrow("ownership cannot be proven");
    expect(active.query("SELECT value FROM facts WHERE row_key='a'").get()).toEqual({value:1});
  } finally {selection?.dispose();active.close(true);stage.close(true);}
});

for (const vendor of ["claude","grok","gemini","opencode"] as const) test(`${vendor} account repair preserves gaps and uncovered time`,()=>{
  const {active,stage}=pair();
  const provider=vendor==="opencode"?"glm":vendor;
  const period=(value:string,from:string,until:string|null)=>({provider,subject:`${provider}/shared`,from,until,value,
    origin:"declared" as const,firstSeen:null,lastSeen:null,readings:0,evidence:"fixture"});
  // A gap between the two periods, and time before the first: both are explicitly nobody's.
  const resolver=buildAccountResolver([period("a","2026-01-01","2026-09-02"),period("b","2026-09-05",null)]);
  const file=`${ARCHIVE_LOGICAL_ROOT}/${provider}/shared/session.jsonl`;
  const spec={identity:["store","path"],bookmarkTable:null},identities=[{store:"shared",path:file}];
  for(const db of [active,stage]) {
    db.exec(`CREATE TABLE facts(row_key TEXT PRIMARY KEY,store TEXT,path TEXT,ts TEXT,
      account_key TEXT,subscription_id TEXT,subscription_conflict INTEGER,value INTEGER,provider TEXT)`);
    db.query(`INSERT INTO facts VALUES('a','shared',?,'2026-09-01T12:00:00.000Z',NULL,NULL,0,1,'zai'),
      ('gap','shared',?,'2026-09-03T12:00:00.000Z',NULL,NULL,0,2,'zai'),('before','shared',?,'2025-12-01T12:00:00.000Z',NULL,NULL,0,3,'zai')`)
      .run(file,file,file);
    if (vendor === "opencode") db.query("INSERT INTO facts VALUES('foreign','shared',?,'2026-09-01T12:00:00.000Z',NULL,NULL,0,4,'openai')").run(file);
  }
  let selection:ReturnType<typeof accountReparseSelection>|undefined;
  try {
    // The repair re-read changed the selected account's row; the unowned rows of the same file came back as accepted.
    stage.exec("UPDATE facts SET value=value+10 WHERE row_key='a'");
    selection=accountReparseSelection(active,stage,vendor,[{vendor,account:"a"}],resolver,spec,identities);
    const plan:ReparsePlan={identities,sources:[],unavailable:[],protectedBookmarks:[],partialIdentities:new Set(),selection};
    preserveReparseOutsideRange(active,stage,spec,["facts"],identities,plan);
    // Proven unowned rows do not block the repair of the account that shares their file.
    expect(stage.query("SELECT row_key,value FROM facts ORDER BY row_key").all())
      .toEqual([{row_key:"a",value:11},{row_key:"before",value:3},
        ...(vendor === "opencode" ? [{row_key:"foreign",value:4}] : []),{row_key:"gap",value:2}]);
    const selected = selection.predicate("main", "facts", "f");
    expect(active.query(`SELECT row_key FROM facts f WHERE ${selected.sql}`).all(...selected.params)).toEqual([{row_key:"a"}]);
    selection.dispose(); selection=undefined;
    stage.exec("UPDATE facts SET value=value+10 WHERE row_key<>'a'");
    selection=accountReparseSelection(active,stage,vendor,[{vendor,account:"a"}],resolver,spec,identities);
    expect(() => preserveReparseOutsideRange(active,stage,spec,["facts"],identities,{...plan,selection})).toThrow("hybrid source identity");
    expect(active.query("SELECT value FROM facts WHERE row_key='a'").get()).toEqual({value:1});
  } finally {selection?.dispose();active.close(true);stage.close(true);}
});

test("publication fences all vendors' selected periods while ignoring unrelated ownership and evidence", () => {
  for (const vendor of ["codex", "claude", "gemini", "grok", "opencode"] as const) {
    const provider = vendor === "opencode" ? "glm" : vendor;
    const period = (source:string, value:string, until:string|null) => ({provider,subject:`${provider}/${source}`,value,
      from:"2026-09-01T00:00:00.000Z",until,origin:"declared" as const,firstSeen:null,lastSeen:null,readings:0,evidence:"original"});
    const a = period("selected", "a", "2026-09-02T00:00:00.000Z"), b = period("other", "b", null);
    const selected = [{vendor,account:"a"}];
    const stamp = (rows:typeof a[]) => accountReparseOwnershipStamp(buildAccountResolver(rows), vendor, selected);
    expect(stamp([a,b])).toBe(stamp([{...a,evidence:"description-only"},{...b,value:"c"}]));
    expect(stamp([a,b])).not.toBe(stamp([{...a,until:"2026-09-03T00:00:00.000Z"},b]));
    expect(stamp([b])).not.toBe(stamp([a,b]));
    const bounds = {from:"2026-09-01T00:00:00.000Z",untilExclusive:"2026-09-01T12:00:00.000Z"};
    const bounded = (rows:typeof a[]) => accountReparseOwnershipStamp(buildAccountResolver(rows),vendor,selected,bounds);
    expect(bounded([a,b])).toBe(bounded([{...a,until:"2026-09-04T00:00:00.000Z"},b]));
    expect(bounded([a,b])).not.toBe(bounded([{...a,until:"2026-09-01T06:00:00.000Z"},b]));
  }
});

test("Codex selects events and limit samples by the account period of their source and instant",()=>{
  const {active,stage}=pair();
  // One rollout crosses a handover: each row belongs to the period covering its own instant (stage 4, W6).
  const home=`${ARCHIVE_LOGICAL_ROOT}/codex/shared`;
  const period=(value:string,from:string,until:string|null)=>({provider:"codex",subject:"codex/shared",from,until,value,
    origin:"declared" as const,firstSeen:null,lastSeen:null,readings:0,evidence:"fixture"});
  const resolver=buildAccountResolver([period("a","2026-01-01","2026-09-02"),period("b","2026-09-02",null)]);
  const spec={identity:["home","path"],bookmarkTable:null},identities=[{home,path:"same"}];
  for(const db of [active,stage]) {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,ts TEXT,in_tok INTEGER);
      CREATE TABLE ratelimit(home TEXT,path TEXT,source_offset INTEGER,source_slot INTEGER,ts TEXT,
        window_minutes INTEGER,limit_id TEXT,resets_at INTEGER,used_percent REAL);`);
    db.query(`INSERT INTO events VALUES(?,'same',10,'2026-09-01T12:00:00.000Z',1),(?,'same',20,'2026-09-02T12:00:00.000Z',2)`).run(home,home);
    db.query(`INSERT INTO ratelimit VALUES(?,'same',10,0,'2026-09-01T12:00:00.000Z',10080,'codex',123,10),
      (?,'same',20,0,'2026-09-02T12:00:00.000Z',10080,'codex',123,20)`).run(home,home);
  }
  let selection:ReturnType<typeof accountReparseSelection>|undefined;
  try {
    // The re-read changed the rows of the selected account only; the other account's rows came back as accepted.
    stage.exec("UPDATE events SET in_tok=in_tok+10 WHERE source_offset=10; UPDATE ratelimit SET used_percent=used_percent+1 WHERE source_offset=10");
    selection=accountReparseSelection(active,stage,"codex",[{vendor:"codex",account:"a"}],resolver,spec,identities);
    const plan:ReparsePlan={identities,sources:[],unavailable:[],protectedBookmarks:[],partialIdentities:new Set(),selection};
    preserveReparseOutsideRange(active,stage,spec,["events","ratelimit"],identities,plan);
    expect(stage.query("SELECT in_tok FROM events ORDER BY source_offset").all()).toEqual([{in_tok:11},{in_tok:2}]);
    expect(stage.query("SELECT used_percent FROM ratelimit ORDER BY source_offset").all())
      .toEqual([{used_percent:11},{used_percent:20}]);
    expect([...plan.selectedDays!]).toEqual(["2026-09-01"]);
  } finally {selection?.dispose();active.close(true);stage.close(true);}
});
