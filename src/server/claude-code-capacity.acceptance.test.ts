import {expect,test} from "bun:test";
import {buildClaudeCodeCapacityReport,selectClaudeCodeCapacityReport} from "./claude-code-capacity";
import {createClaudeCodeAcceptanceFixture,measureAnalysis,ACCOUNTS,TIMES,EXPECTED} from "./claude-code-capacity.fixture";

/**
 * Window sums are stored rows: a capacity read sums neither events nor ledger facts. The one event
 * read it makes is the account resolver's session-identity look (claude-event-account), excluded here.
 */
const eventOrFactReads=(queries:string[])=>queries.filter(query=>
  !/^SELECT (COALESCE\(MAX\(rowid\), 0\) AS top|COUNT\(\*\) AS n FROM claude_events WHERE rowid > \?$|DISTINCT account_key AS key FROM claude_events)/.test(query));

test("independent two-account evidence preserves boundaries, quantities, every local source and stored sums across restart",()=>{
  const f=createClaudeCodeAcceptanceFixture();
  const build=()=>buildClaudeCodeCapacityReport(f.db,ACCOUNTS.a,{rateCards:f.rates});
  try{
    const first=measureAnalysis(f.db,build);
    expect(eventOrFactReads(first.rawOrFactQueries)).toEqual([]);
    expect(first.value.selected?.kind).toBe("interval");
    // Rule @3: SDK, desktop and unlabelled calls of the account are Code too.
    expect(first.value.observed).toMatchObject({code_tokens:111_000,account_tokens:111_000});
    expect(first.value.observed!.code_api_usd).toBeCloseTo(0.5994,12);
    expect(first.value.weekly_capacity_tokens.value).toBeCloseTo(111_000*10_000/(24*12-10*12),8);
    expect(first.value.coverage).toMatchObject({other_product_events:0,unknown_events:0,complete_from_window_start:false});
    const cumulative=first.value.samples.find(s=>s.kind==="cumulative"&&s.through===TIMES.asOf)!;
    expect(cumulative.usage).toMatchObject({code_tokens:EXPECTED.aAllProducts.tokens,account_tokens:161_000});
    expect(cumulative.usage.code_api_usd).toBeCloseTo(EXPECTED.aAllProducts.usd,12);
    expect(cumulative.coverage.duplicate_copies).toBe(1);
    const foreign=buildClaudeCodeCapacityReport(f.db,ACCOUNTS.b,{rateCards:f.rates});
    expect(foreign.observed!.code_tokens).toBe(900_000);
    const saved=f.db.query("SELECT * FROM window_usage ORDER BY provider,account,counter,window_id").all();
    f.changeShare(15);f.reopen();
    const second=measureAnalysis(f.db,build);
    expect(eventOrFactReads(second.rawOrFactQueries)).toEqual([]);
    expect(second.value.observed).toEqual(first.value.observed);
    expect(second.value.weekly_capacity_tokens.value).toBeCloseTo(111_000*10_000/(24*15-10*12),8);
    // A share-only change reprices and recounts nothing: the stored sums are the same rows.
    expect(f.db.query("SELECT * FROM window_usage ORDER BY provider,account,counter,window_id").all()).toEqual(saved);
    // Window selection is pure and cannot revisit or reprice source data.
    const selected=measureAnalysis(f.db,()=>selectClaudeCodeCapacityReport(second.value,{since:TIMES.start,until:TIMES.asOf,resetAt:TIMES.reset}));
    expect(selected.rawOrFactQueries).toEqual([]);
    expect(selected.value.weekly_capacity_tokens).toEqual(second.value.weekly_capacity_tokens);
  }finally{f.teardown();}
});

test("a corrected CLI event matches independently prepared fresh facts and retains unrelated account sums",()=>{
  const f=createClaudeCodeAcceptanceFixture(),reference=createClaudeCodeAcceptanceFixture();
  const report=(fixture:typeof f,account:string)=>buildClaudeCodeCapacityReport(fixture.db,account,{rateCards:fixture.rates});
  try{
    report(f,ACCOUNTS.a);const foreign=report(f,ACCOUNTS.b);
    for(const target of [f,reference]){
      target.db.exec("UPDATE claude_events SET in_uncached=32000,out_total=8000 WHERE call_id='between'");
      target.prepareFacts();
    }
    const incremental=report(f,ACCOUNTS.a),fresh=report(reference,ACCOUNTS.a);
    expect(incremental.observed!.code_tokens).toBe(121_000);
    expect(incremental.observed!.code_api_usd).toBeCloseTo(0.6534,12);
    expect(incremental).toEqual(fresh);
    const unchanged=measureAnalysis(f.db,()=>buildClaudeCodeCapacityReport(f.db,ACCOUNTS.b,{rateCards:f.rates}));
    expect(unchanged.value).toEqual(foreign);
    expect(eventOrFactReads(unchanged.rawOrFactQueries)).toEqual([]);
  }finally{f.teardown();reference.teardown();}
});
