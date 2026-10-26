/** Synthetic two-year Claude history, including sessions that cross day boundaries. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { ARCHIVE_LOGICAL_ROOT } from "../src/config/paths";
import path from "node:path";
import { Database } from "../src/db/sqlite";
import { installAnalysisTracking } from "../src/db/analysis";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../src/db/period-store";
import { fillUsageLedger } from "../src/server/usage-ledger.fixture";
import { buildRepoHistory } from "../src/server/repo-history";
import { ACCOUNTS, RATES, TIMES, createClaudeCodeAcceptanceFixture, measureAnalysis } from "../src/server/claude-code-capacity.fixture";
import { installFactDayRevisions } from "../src/db/fact-day-revisions";

const days = 730, callsPerAccountDay = 10;
const until = TIMES.asOf.slice(0,10);
const since = new Date(Date.parse(TIMES.asOf)-(days-1)*86_400_000).toISOString().slice(0,10);
const period = {since,until};
const recentPeriod = { since: until, until };
const uniqueSessions = process.argv.includes("--unique-sessions");
const conflictingCopies = process.argv.includes("--conflicting-copies");
const round = (n:number)=>Math.round(n*1000)/1000;
function sample(db:Database, selectedPeriod = period) {
  const start=performance.now();
  const result=measureAnalysis(db,()=>buildRepoHistory(db,{repo:null,projectId:"synthetic-history",
    ...selectedPeriod,granularity:"month",by:"account",idleGapMinutes:15,rateCards:RATES,homeToSubId:new Map()}));
  return {ms:round(performance.now()-start),raw_or_fact_queries:result.rawOrFactQueries.length,
    tokens:result.value.totals.tokens,calls:result.value.totals.calls,
    api_usd:result.value.totals.api_usd,active_seconds:result.value.totals.active_seconds,
    conflicting_identities:(result.value.claude?.conflicts ?? []).reduce((sum,row)=>sum+row.identities,0),
    buckets:result.value.points.length};
}

if (process.argv[2]==="--prepared-child") {
  const db=new Database(process.argv[3]!);
  try {console.log(JSON.stringify({full:sample(db),recent:sample(db,recentPeriod)}));} finally {db.close(true);}
} else {
  const f=createClaudeCodeAcceptanceFixture();
  try {
    f.db.exec("DELETE FROM claude_events; ALTER TABLE claude_events ADD COLUMN repo TEXT; ALTER TABLE claude_events ADD COLUMN repo_group TEXT");
    installAnalysisTracking(f.db);
    installFactDayRevisions(f.db);
    const insert=f.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,
      subscription_id,session_id,project_id,in_uncached,out_total)
      VALUES('synthetic-history',?,?,?,'claude-sonnet-fixture','standard',?,
        ?,'synthetic-history',800,200)`);
    f.db.transaction(()=>{
      for(let day=0;day<days;day++)for(let call=0;call<callsPerAccountDay;call++)for(const account of Object.values(ACCOUNTS)) {
        const ts=new Date(Date.parse(since)+day*86_400_000+(call+1)*60_000).toISOString();
        const identity = `${account}-${day}-${call}`;
        insert.run(identity,path.join(ARCHIVE_LOGICAL_ROOT,"claude",`benchmark-${account}`,"synthetic.jsonl"),ts,account,uniqueSessions ? identity : 'cross-day-session');
      }
    })();
    insert.finalize();
    // Declared through the store, so the account resolver sees the new revision.
    replaceDeclaredPeriods(f.db, ACCOUNT_PERIODS, [...loadPeriods(f.db, ACCOUNT_PERIODS).filter(period => period.origin === "declared"),
      ...Object.values(ACCOUNTS).map(account => ({ provider: "claude", subject: `claude/benchmark-${account}`, value: account,
        from: "2020-01-01", until: null, origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "synthetic" }))]);
    if (conflictingCopies) {
      const copy=f.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,
        subscription_id,session_id,project_id,in_uncached,out_total)
        SELECT 'synthetic-conflict-copy',call_id,path,CASE WHEN call_id=? THEN ? ELSE ts END,
          model,speed,subscription_id,session_id,'conflicting-subject',1600,400
        FROM claude_events WHERE call_id IN (?,?)`);
      const first=`${ACCOUNTS.a}-0-0`, later=`${ACCOUNTS.a}-100-0`;
      copy.run(first,`${until}T12:00:00.000Z`,first,later);
      copy.finalize();
    }
    const factStart=performance.now();
    fillUsageLedger(f.db,"claude",RATES,ARCHIVE_LOGICAL_ROOT,500);
    const factMs=round(performance.now()-factStart);
    const first=sample(f.db);
    assert.equal(first.calls,days*callsPerAccountDay*2-(conflictingCopies?2:0));
    assert.equal(first.tokens,first.calls*1000);
    assert.equal(first.api_usd,conflictingCopies?78.83:78.84);
    assert.equal(first.conflicting_identities,conflictingCopies?2:0);
    // Removing the first call on two days loses one 60-second interior gap on each day.
    assert.equal(first.active_seconds,uniqueSessions ? 0 : 2*((callsPerAccountDay-1)*60*days+(days-1)*900)-(conflictingCopies?120:0));
    const recentFirst=sample(f.db,recentPeriod);
    assert.equal(recentFirst.calls,callsPerAccountDay*2);
    assert.equal(recentFirst.tokens,20_000);
    assert.equal(recentFirst.conflicting_identities,conflictingCopies?1:0);
    assert.equal(recentFirst.active_seconds,uniqueSessions ? 0 : 2*((callsPerAccountDay-1)*60+900));
    f.changeShare(15);
    f.reopen();
    const changed=sample(f.db);
    const children=[];
    for(let i=0;i<3;i++) {
      const child=Bun.spawn([process.execPath,import.meta.path,"--prepared-child",f.dbPath],{stdout:"pipe",stderr:"inherit"});
      const output=await new Response(child.stdout).text();
      assert.equal(await child.exited,0);
      children.push(JSON.parse(output.trim().split("\n").at(-1)!) as {full:ReturnType<typeof sample>;recent:ReturnType<typeof sample>});
    }
    for(const [ready,reference] of [[changed,first],...children.flatMap(child=>
      [[child.full,first],[child.recent,recentFirst]])] as Array<[ReturnType<typeof sample>,ReturnType<typeof sample>]>) {
      for(const key of ["tokens","calls","api_usd","active_seconds","buckets","conflicting_identities"] as const)
        assert.equal(ready[key],reference[key]);
    }
    const report={kind:"synthetic-claude-history-two-year-read",generated_at:new Date().toISOString(),
      production_data_used:false,period,days,calls_per_account_day:callsPerAccountDay,
      session_pattern:uniqueSessions ? "one session per call" : "one long session per account",
      conflicting_source_copies:conflictingCopies?2:0,
      accounts:Object.values(ACCOUNTS),fact_preparation_ms:factMs,first_preparation:first,
      recent_period:recentPeriod,recent_first_preparation:recentFirst,
      changed_share_after_reopen:changed,new_process_reads:children,
      limitations:["Synthetic 14,600 calls; not a production workload.",
        "A session per call makes boundary cardinality equal event cardinality; this probe does not prove constant-cost recent-range reads.",
        "Backend history timing begins after imports and SQLite open; excludes process startup and desktop rendering.",
        "Each fresh process reads full history first, then the recent range; recent timings benefit from that preceding read.",
        "No concurrent import or HTTP queue; processes reuse the operating system filesystem cache."]};
    fs.writeFileSync(process.argv[2]??".dev-cache/claude-history-benchmark.json",`${JSON.stringify(report,null,2)}\n`);
    console.log(JSON.stringify(report,null,2));
  } finally {f.teardown();}
}
