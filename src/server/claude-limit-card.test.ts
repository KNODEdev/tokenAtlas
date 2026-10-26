import { expect, test, spyOn } from "bun:test";
import { ACCOUNTS, TIMES, createClaudeCodeAcceptanceFixture, measureAnalysis } from "./claude-code-capacity.fixture";
import { buildClaudeLimit, buildClaudeLimitCard, readClaudeLimitCardMetadata } from "./claude-limit";
import { getClaudeRate } from "./pricing";
import { CLAUDE_CARD_METADATA_SCHEMA, preparedClaudeCardMetadata, markClaudeCardProbeDirty } from "../db/claude-card-metadata";
import { advanceClaudeCardMetadata } from "./claude-card-metadata";
import { markClaudeCardRangeDirty } from "../db/claude-card-metadata";
import { readWindowAnswer, storeWindowAnswers, windowAnswerIsCurrent, windowAnswerMarkSeq } from "../db/window-answers";
import { preparedProbeOwnedBySql, probeReadContext, selectOwnedProbes } from "./current/probe-account-reader";

test("the small Claude card preserves the full report outside its independent observation history", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    f.db.exec(CLAUDE_CARD_METADATA_SCHEMA);
    f.db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine)
      SELECT provider,subject,ts,plan,'weekly_scoped',limit_group,'fable',reported_percent_side,30,30,resets_at,window_minutes,ok,extra,machine
      FROM probe_windows WHERE subject=? ORDER BY id DESC LIMIT 1`).run(ACCOUNTS.a);
    f.db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine)
      SELECT provider,subject,ts,plan,'session','session',NULL,reported_percent_side,40,40,'2026-09-17T05:00:00.000Z',300,ok,NULL,machine
      FROM probe_windows WHERE subject=? ORDER BY id DESC LIMIT 1`).run(ACCOUNTS.a);
    f.prepareProbes();
    const settle = () => { for (let i=0;i<20;i++) if (!advanceClaudeCardMetadata(f.db).pending) return; throw new Error("metadata did not settle"); };
    settle();
    const cfg = { subscription: ACCOUNTS.a, window_hours: 168, observations: [] };
    const price = (m: string | null, d: string, s: string | null) => getClaudeRate(f.rates, m, d, s);
    for (const bounds of [undefined, { from: TIMES.start, until: TIMES.reset }]) {
      const full = buildClaudeLimit(f.db, cfg, price, TIMES.asOf, { rateCards: f.rates }, bounds);
      const metadata = readClaudeLimitCardMetadata(f.db, cfg);
      expect(metadata).toEqual({ observationCount: full.observations.length, probeSampleCount: full.probe.samples });
      expect(preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toEqual(metadata);
      const card = measureAnalysis(f.db, () => buildClaudeLimitCard(f.db, cfg, price, TIMES.asOf, { rateCards: f.rates }, bounds, metadata));
      expect(card.value).toEqual({ ...full, observations: [] });
      expect(card.rawOrFactQueries).toEqual([]);
    }
    storeWindowAnswers(f.db,[{route:"/api/claude-limit-card",key:"share-correction",family:"share-correction",
      scope:{provider:"claude",account:ACCOUNTS.a,fromMs:-8_640_000_000_000_000,untilMs:null},configuration:"test",
      checked:windowAnswerMarkSeq(f.db),builtAt:Date.now(),expiresAt:null,status:200,version:"v",headers:[],body:"{}"}]);
    expect(windowAnswerIsCurrent(f.db,readWindowAnswer(f.db,"/api/claude-limit-card","share-correction")!,"test")).toBe(true);
    f.changeShare(15);
    expect(windowAnswerIsCurrent(f.db,readWindowAnswer(f.db,"/api/claude-limit-card","share-correction")!,"test")).toBe(false);
    expect(()=>preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toThrow();
    settle();
    f.reopen();
    const full = buildClaudeLimit(f.db, cfg, price, TIMES.asOf, { rateCards: f.rates });
    expect(buildClaudeLimitCard(f.db, cfg, price, TIMES.asOf, { rateCards: f.rates })).toEqual({ ...full, observations: [] });
  } finally { f.teardown(); }
});

test("connected reset chains, deletion and the rolling legacy cutoff retain exact metadata without full replay", () => {
  const f=createClaudeCodeAcceptanceFixture();
  try {
    const cfg={subscription:ACCOUNTS.a,window_hours:168,observations:[]};
    const insert=f.db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra,machine,window_minutes,limit_group,ok,reported_percent_side,vendor_percent)
      SELECT provider,subject,?,kind,scope,used_percent,?,json_set(extra,'$."claude.share.as_of"',?,'$."claude.share.window_started_at"',?),machine,window_minutes,limit_group,ok,reported_percent_side,vendor_percent
      FROM probe_windows WHERE subject=? ORDER BY id LIMIT 1`);
    // Seed scalar index witnesses directly: this test isolates metadata/cutoff work from source import.
    const project=(ts:string)=>{
      const id=Number((f.db.query('SELECT last_insert_rowid() id').get() as {id:number}).id);
      const at=Date.parse(ts);
      f.db.query(`INSERT INTO probe_sources SELECT ?,ord,provider,machine,home,login,'projection',tuples,?,?,?,subject,bare,revision
        FROM probe_sources WHERE probe_id=(SELECT MIN(id) FROM probe_windows WHERE subject=?)`)
        .run(id,at,at,at,ACCOUNTS.a);
      return id;
    };
    f.db.transaction(()=>{for(let i=0;i<19998;i++){
      const start=i===0?'2025-01-01T00:00:00.000Z':'2025-01-08T00:00:00.000Z';
      const ts=new Date(Date.parse(start)+i*1000).toISOString();
      insert.run(ts,i===0?'2025-01-08T00:00:00.000Z':'2025-01-15T00:00:00.000Z',ts,start,ACCOUNTS.a);
      project(ts);
    }})();f.db.exec(CLAUDE_CARD_METADATA_SCHEMA);
    const turns: ReturnType<typeof advanceClaudeCardMetadata>[]=[];
    const settle=()=>{for(let i=0;i<500;i++){const r=advanceClaudeCardMetadata(f.db);turns.push(r);if(!r.pending)return;}throw new Error('metadata did not settle');};
    settle();
    expect(turns.filter(row=>row.rows).every(row=>row.rows<=500)).toBe(true);
    expect(preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toEqual(readClaudeLimitCardMetadata(f.db,cfg));
    const before=(f.db.query("SELECT COUNT(*) n FROM claude_card_components WHERE account=?").get(ACCOUNTS.a) as {n:number}).n;
    // One new current reading evicts the sole oldest reset from the exact newest-20k membership.
    insert.run('2026-09-17T01:00:00.000Z',TIMES.reset,'2026-09-17T01:00:00.000Z',TIMES.start,ACCOUNTS.a);
    markClaudeCardProbeDirty(f.db,ACCOUNTS.a,project('2026-09-17T01:00:00.000Z'));turns.length=0;settle();
    expect(preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toEqual(readClaudeLimitCardMetadata(f.db,cfg));
    expect((f.db.query("SELECT COUNT(*) n FROM claude_card_components WHERE account=?").get(ACCOUNTS.a) as {n:number}).n).toBe(before-1);
    expect(turns.reduce((n,row)=>n+row.rows,0)).toBeLessThan(100);
    // A~B and B~C while A!~C: all three form one dependency, selected by the original greedy rules.
    const ids:number[]=[];
    for(const [i,delta] of [0,90_000,180_000].entries()){
      const ts=new Date(Date.parse('2026-09-17T02:00:00.000Z')+i*1000).toISOString();
      insert.run(ts,new Date(Date.parse(TIMES.reset)+delta).toISOString(),ts,TIMES.start,ACCOUNTS.a);
      ids.push(project(ts));markClaudeCardProbeDirty(f.db,ACCOUNTS.a,ids.at(-1)!);
    }
    turns.length=0;settle();
    expect(preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toEqual(readClaudeLimitCardMetadata(f.db,cfg));
    f.db.query('DELETE FROM probe_windows WHERE id=?').run(ids[1]!);markClaudeCardProbeDirty(f.db,ACCOUNTS.a,ids[1]!);
    settle();
    expect(preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toEqual(readClaudeLimitCardMetadata(f.db,cfg));
    f.reopen();expect(advanceClaudeCardMetadata(f.db)).toMatchObject({pending:false,rows:0,components:0});
    expect(preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toEqual(readClaudeLimitCardMetadata(f.db,cfg));
  } finally {f.teardown();}
},60_000);

test("new chained resets merge pending work and a global correction resets a same-time cursor", () => {
  const f=createClaudeCodeAcceptanceFixture();
  try {
    const cfg={subscription:ACCOUNTS.a,window_hours:168,observations:[]};
    f.db.exec(CLAUDE_CARD_METADATA_SCHEMA);
    expect(advanceClaudeCardMetadata(f.db,{canWrite:()=>false})).toMatchObject({pending:true,rows:0,components:0});
    expect(advanceClaudeCardMetadata(f.db).pending).toBe(true);
    expect(()=>preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toThrow();
    f.reopen();
    // Initial membership is saved but its component has not been published yet.
    for(const delta of [90_000,180_000]){
      f.db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine)
        SELECT provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,?,window_minutes,ok,extra,machine
        FROM probe_windows WHERE subject=? ORDER BY id LIMIT 1`).run(new Date(Date.parse(TIMES.reset)+delta).toISOString(),ACCOUNTS.a);
      const id=Number((f.db.query('SELECT last_insert_rowid() id').get() as {id:number}).id);
      f.db.query(`INSERT INTO probe_sources SELECT ?,ord,provider,machine,home,login,'projection',tuples,at,accounting_at,observation_at,subject,bare,revision
        FROM probe_sources WHERE probe_id=(SELECT MIN(id) FROM probe_windows WHERE subject=?)`).run(id,ACCOUNTS.a);
      markClaudeCardProbeDirty(f.db,ACCOUNTS.a,id);
      advanceClaudeCardMetadata(f.db);
    }
    const settle=()=>{for(let i=0;i<100;i++)if(!advanceClaudeCardMetadata(f.db).pending)return;throw new Error('metadata did not settle');};
    settle();
    expect(preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toEqual(readClaudeLimitCardMetadata(f.db,cfg));
    const first=f.db.query("SELECT id,ts FROM probe_windows WHERE subject=? ORDER BY id LIMIT 1").get(ACCOUNTS.a) as {id:number;ts:string};
    const at=Date.parse(first.ts);
    f.db.query("INSERT INTO claude_card_dirty_ranges VALUES(?,?,?,?)").run(ACCOUNTS.a,at,at+1,Number.MAX_SAFE_INTEGER);
    f.db.query("UPDATE probe_windows SET used_percent=42 WHERE id=?").run(first.id);
    markClaudeCardRangeDirty(f.db,'*',at,at+1);settle();
    const member=f.db.query("SELECT body FROM claude_card_members WHERE account=? AND probe_id=?").get(ACCOUNTS.a,first.id) as {body:string};
    expect(JSON.parse(member.body).used_percent).toBe(42);
    expect(preparedClaudeCardMetadata(f.db,ACCOUNTS.a)).toEqual(readClaudeLimitCardMetadata(f.db,cfg));
  } finally {f.teardown();}
});

test("twenty thousand session readings exclude old weekly probe state without excluding Code capacity witnesses", () => {
  const f=createClaudeCodeAcceptanceFixture();
  try {
    f.db.query(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<19999)
      INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine)
      SELECT p.provider,p.subject,strftime('%Y-%m-%dT%H:%M:%fZ','2026-09-18T00:00:00Z','+'||(i/1000.0)||' seconds'),p.plan,
      'session','session',NULL,p.reported_percent_side,40,40,'2026-09-18T05:00:00.000Z',300,p.ok,NULL,p.machine
      FROM n JOIN probe_windows p ON p.id=(SELECT MIN(id) FROM probe_windows WHERE subject=?)`).run(ACCOUNTS.a);
    f.db.query(`INSERT INTO probe_sources SELECT p.id,s.ord,s.provider,s.machine,s.home,s.login,'projection',s.tuples,
      CAST(ROUND(unixepoch(p.ts,'subsec')*1000) AS INTEGER),CAST(ROUND(unixepoch(p.ts,'subsec')*1000) AS INTEGER),NULL,s.subject,s.bare,s.revision
      FROM probe_windows p JOIN probe_sources s ON s.probe_id=(SELECT MIN(id) FROM probe_windows WHERE subject=?)
      WHERE p.subject=? AND p.kind='session'`).run(ACCOUNTS.a,ACCOUNTS.a);
    for(let i=0;i<500;i++)if(!advanceClaudeCardMetadata(f.db).pending)break;
    const cfg={subscription:ACCOUNTS.a,window_hours:168,observations:[]};
    const price=(m:string|null,d:string,s:string|null)=>getClaudeRate(f.rates,m,d,s);
    const full=buildClaudeLimit(f.db,cfg,price,TIMES.asOf,{rateCards:f.rates});
    const card=buildClaudeLimitCard(f.db,cfg,price,TIMES.asOf,{rateCards:f.rates});
    expect(full.probe.ok).toBe(false);expect(full.probe.weekly_percent).toBeNull();
    expect(full.claude_code_capacity?.weekly_capacity_tokens.value).not.toBeNull();
    expect(card).toEqual({...full,observations:[]});
  } finally {f.teardown();}
},60_000);

test("a card without a current meter retains the older Code witness behind several share-less closed weeks", () => {
  const f=createClaudeCodeAcceptanceFixture();
  let clock:ReturnType<typeof spyOn>|undefined;
  try {
    for(const [at,reset] of [['2026-09-22T00:00:00.000Z','2026-09-27T00:00:00.000Z'],
      ['2026-09-29T00:00:00.000Z','2026-10-04T00:00:00.000Z'],['2026-10-06T00:00:00.000Z','2026-10-11T00:00:00.000Z']]){
      f.db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine)
        SELECT provider,subject,?,plan,kind,limit_group,scope,reported_percent_side,24,24,?,window_minutes,ok,NULL,machine
        FROM probe_windows WHERE subject=? ORDER BY id LIMIT 1`).run(at!,reset!,ACCOUNTS.a);
    }
    f.prepareProbes();for(let i=0;i<100;i++)if(!advanceClaudeCardMetadata(f.db).pending)break;
    clock=spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-17T12:00:00.000Z'));
    const cfg={subscription:ACCOUNTS.a,window_hours:168,observations:[]};
    const price=(m:string|null,d:string,s:string|null)=>getClaudeRate(f.rates,m,d,s);
    const full=buildClaudeLimit(f.db,cfg,price,undefined,{rateCards:f.rates});
    expect(full.claude_code_capacity?.weekly_capacity_tokens.value).not.toBeNull();
    const card=buildClaudeLimitCard(f.db,cfg,price,undefined,{rateCards:f.rates});
    expect(card).toEqual({...full,observations:[]});
    f.db.query(`UPDATE probe_windows SET extra=(SELECT json_set(extra,'$."claude.share.as_of"','2026-09-22T00:00:00.000Z',
      '$."claude.share.window_started_at"','2026-09-20T00:00:00.000Z','$."claude.share.percent"',1000)
      FROM probe_windows WHERE subject=? ORDER BY id LIMIT 1) WHERE subject=? AND ts='2026-09-22T00:00:00.000Z'`).run(ACCOUNTS.a,ACCOUNTS.a);
    f.prepareProbes();for(let i=0;i<100;i++)if(!advanceClaudeCardMetadata(f.db).pending)break;
    const invalid=buildClaudeLimit(f.db,cfg,price,undefined,{rateCards:f.rates});
    expect(invalid.claude_code_capacity?.reason).toBe('share_invalid');
    expect(buildClaudeLimitCard(f.db,cfg,price,undefined,{rateCards:f.rates})).toEqual({...invalid,observations:[]});
  } finally {clock?.mockRestore();f.teardown();}
});

test("foreign same-time silent readings never cause fallback queries to walk account history", () => {
  const measure=(size:number)=>{
    const f=createClaudeCodeAcceptanceFixture();
    try {
      for(const account of [ACCOUNTS.a,ACCOUNTS.b]){
        f.db.query(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<?)
          INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine)
          SELECT p.provider,p.subject,strftime('%Y-%m-%dT%H:%M:%fZ','2026-10-06T00:00:00Z','+'||(i/1000.0)||' seconds'),p.plan,
          p.kind,p.limit_group,p.scope,p.reported_percent_side,p.used_percent,p.vendor_percent,'2026-10-11T00:00:00.000Z',p.window_minutes,p.ok,NULL,p.machine
          FROM n JOIN probe_windows p ON p.id=(SELECT MIN(id) FROM probe_windows WHERE subject=?)`).run(size-1,account);
        f.db.query(`INSERT INTO probe_sources SELECT p.id,s.ord,s.provider,s.machine,s.home,s.login,'projection',s.tuples,
          CAST(ROUND(unixepoch(p.ts,'subsec')*1000) AS INTEGER),CAST(ROUND(unixepoch(p.ts,'subsec')*1000) AS INTEGER),
          CAST(ROUND(unixepoch(p.ts,'subsec')*1000) AS INTEGER),s.subject,s.bare,s.revision
          FROM probe_windows p JOIN probe_sources s ON s.probe_id=(SELECT MIN(id) FROM probe_windows WHERE subject=?)
          WHERE p.subject=? AND p.ts>='2026-10-06'`).run(account,account);
      }
      for(let i=0;i<100;i++)if(!advanceClaudeCardMetadata(f.db).pending)break;
      const cfg={subscription:ACCOUNTS.a,window_hours:168,observations:[]};
      const price=(m:string|null,d:string,s:string|null)=>getClaudeRate(f.rates,m,d,s);
      const full=buildClaudeLimit(f.db,cfg,price,undefined,{rateCards:f.rates});
      const query=f.db.query;let nominations=0;
      f.db.query=function(this:typeof f.db,sql:string,...args:unknown[]){if(sql.includes("claude.share.%"))nominations++;return query.call(this,sql,...args as []);} as typeof query;
      try{expect(buildClaudeLimitCard(f.db,cfg,price,undefined,{rateCards:f.rates})).toEqual({...full,observations:[]});}
      finally{f.db.query=query;}
      return nominations;
    } finally {f.teardown();}
  };
  expect(measure(10)).toBe(1);expect(measure(1000)).toBe(1);
});

test("fallback SQL ownership matches the prepared reader for projections, unanimous evidence, conflicts and bare corrections", () => {
  const f=createClaudeCodeAcceptanceFixture();
  try {
    const head=(account:string)=>Number((f.db.query('SELECT MIN(id) id FROM probe_windows WHERE subject=?').get(account) as {id:number}).id);
    const a=head(ACCOUNTS.a),b=head(ACCOUNTS.b);
    const clone=(basis:string,tuples:number[])=>{
      f.db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine)
        SELECT provider,subject,ts,plan,kind,limit_group,scope,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,extra,machine
        FROM probe_windows WHERE id=?`).run(a);
      const id=Number((f.db.query('SELECT last_insert_rowid() id').get() as {id:number}).id);
      for(const [ord,source] of tuples.entries())f.db.query(`INSERT INTO probe_sources SELECT ?,?,provider,machine,home,login,?,?,at,accounting_at,observation_at,subject,bare,revision FROM probe_sources WHERE probe_id=? ORDER BY ord LIMIT 1`)
        .run(id,ord,basis,tuples.length,source);
      return id;
    };
    clone('projection',[a]);clone('projection',[a,b]);clone('matched',[a,a]);clone('matched',[a,b]);
    const mixed=clone('matched',[a,a]);f.db.query('UPDATE probe_sources SET machine=NULL,home=NULL,login=NULL WHERE probe_id=? AND ord=1').run(mixed);
    const bare=clone('matched',[a]);f.db.query('UPDATE probe_sources SET machine=NULL,home=NULL,login=NULL,bare=1 WHERE probe_id=?').run(bare);
    clone('stale-link',[a]);
    const context=probeReadContext(f.db),source=context.resolver.plan('claude',ACCOUNTS.a).ranges[0]!.source;
    context.options.corrections=[{provider:'claude',subject:ACCOUNTS.a,from:'2020-01-01',until:'2030-01-01',source,evidence:'synthetic ownership proof'}];
    for(const account of [ACCOUNTS.a,ACCOUNTS.b]){
      const predicate=preparedProbeOwnedBySql(f.db,context,'claude',account,'p');
      const actual=(f.db.query(`SELECT p.id FROM probe_windows p WHERE p.provider='claude' AND ${predicate.sql} ORDER BY p.id`).all(...predicate.params) as {id:number}[]).map(row=>row.id);
      const expected=selectOwnedProbes(f.db,context,'claude',account,{}).map(row=>row.row.id).sort((a,b)=>a-b);
      expect(actual).toEqual(expected);
    }
  } finally {f.teardown();}
});

test("the current window carries its stored grant-funded hours for the chart, and nothing without them", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const cfg = { subscription: ACCOUNTS.a, window_hours: 168, observations: [] };
    const price = (m: string | null, d: string, s: string | null) => getClaudeRate(f.rates, m, d, s);
    const before = buildClaudeLimit(f.db, cfg, price, TIMES.asOf, { rateCards: f.rates });
    expect(before.current).not.toBeNull();
    expect(before.current!.credit_funded).toBeUndefined();
    const funded = { calls: 2, tokens: 30, credits: 0, credits_unpriced: 2, api_standard: 1.5, api_unpriced: 0,
      first: TIMES.start, last: TIMES.start, hours: [[TIMES.start, 2, 30, 0, 1.5]] as Array<[string, number, number, number, number]> };
    f.db.query(`UPDATE window_usage SET rail=json_set(rail,'$.credit_funded',json(?)) WHERE provider='claude'`).run(JSON.stringify(funded));
    const after = buildClaudeLimit(f.db, cfg, price, TIMES.asOf, { rateCards: f.rates });
    expect(after.current!.credit_funded).toEqual(funded);
  } finally { f.teardown(); }
});
