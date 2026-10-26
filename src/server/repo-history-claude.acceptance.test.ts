import { publishFixtureRules } from "../projects/rules.fixture";
import { expect, test } from "bun:test";
import { installAnalysisTracking } from "../db/analysis";
import type { Database } from "../db/sqlite";
import { ACCOUNTS, createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";
import { buildRepoHistory, listSubjects, type RepoHistoryOpts } from "./repo-history";
import { buildProjectCost } from "./project-cost";
import { createDataRead } from "./data-read";
import { buildEraIndex } from "./eras";
import type { AppContext } from "./api";

/** The ledger's stored valuations of every Claude fact; repricing would change them. */
const storedValuations = (db: Database) => db.query(`SELECT row_id,std_key,std_reason,std_nano,std_femto,
  act_key,act_reason,act_nano,act_femto,glb_key,glb_reason,glb_nano,glb_femto FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all();

function historyFixture() {
  const f = createClaudeCodeAcceptanceFixture();
  f.db.exec("DELETE FROM claude_events; ALTER TABLE claude_events ADD COLUMN repo TEXT; ALTER TABLE claude_events ADD COLUMN repo_group TEXT");
  installAnalysisTracking(f.db);
  const rates = structuredClone(f.rates);
  rates.vendors.anthropic!.models!["claude-sonnet-fixture"]!.fast = {
    in_uncached: 9, in_cache_read: 0.9, in_cache_write_5m: 11.25, in_cache_write_1h: 18, out_total: 45,
  };
  rates.subscriptions = { [ACCOUNTS.a]: { usd_per_month: 30.44 }, [ACCOUNTS.b]: { usd_per_month: 60.88 } };
  const insert = f.db.query(`INSERT INTO claude_events
    (store,call_id,path,ts,model,speed,subscription_id,session_id,project_id,repo,repo_group,in_uncached,out_total)
    VALUES (?,?,'synthetic.jsonl',?,'claude-sonnet-fixture',?,?,?,?,'repo-alpha','internal',?,?)`);
  const event = (id: string, ts: string, tokens: number, account: string | null = ACCOUNTS.a,
    project = "alpha", session: string | null = "shared-session", speed: string | null = "standard", store = "same-store") =>
    insert.run(store,id,ts,speed,account,session,project,tokens * .8,tokens * .2);
  event("previous","2026-09-14T23:58:00.000Z",1000);
  event("first","2026-09-15T00:02:00.000Z",2000,ACCOUNTS.a,"alpha","shared-session","fast");
  event("first","2026-09-15T00:02:00.000Z",2000,ACCOUNTS.a,"alpha","shared-session","fast","copy-store");
  event("other-project","2026-09-15T00:03:00.000Z",3000,ACCOUNTS.a,"beta");
  event("back","2026-09-15T00:04:00.000Z",4000);
  event("b-first","2026-09-15T00:03:00.000Z",5000,ACCOUNTS.b);
  event("b-next","2026-09-15T00:08:00.000Z",6000,ACCOUNTS.b);
  event("zero-no-session","2026-09-15T00:10:00.000Z",0,ACCOUNTS.a,"alpha",null);
  event("no-session","2026-09-15T00:12:00.000Z",1000,ACCOUNTS.a,"alpha",null);
  event("next-day","2026-09-16T00:00:00.000Z",8000);
  f.prepareFacts(rates);
  const opts: RepoHistoryOpts = { repo: null, projectId: "alpha", since: "2026-09-15", until: "2026-09-16",
    granularity: "day", by: "account", idleGapMinutes: 15, rateCards: rates, homeToSubId: new Map() };
  return { f, rates, event, opts, build: (override: Partial<RepoHistoryOpts> = {}) =>
    buildRepoHistory(f.db,{...opts,...override}) };
}

test("Claude history uses canonical accounts and the same actual project amounts, with cross-day session activity", () => {
  const { f, opts, rates, build } = historyFixture();
  try {
    const history = build();
    // Alpha: A=15k tokens/.1026 USD, B=11k/.0594 USD. The 2k copy is excluded.
    expect(history.totals.tokens).toBe(26_000);
    expect(history.totals.calls).toBe(7);
    expect(history.totals.api_usd).toBe(.16);
    expect(history.vendor_coverage.find(row=>row.vendor==="claude"))
      .toEqual({vendor:"claude",first:"2026-09-14",last:"2026-09-16"});
    expect(Object.keys(history.totals.by_sub).sort()).toEqual([ACCOUNTS.a,ACCOUNTS.b]);
    expect(history.points.map(p=>p.tokens)).toEqual([18_000,8_000]);
    // Intervals follow UTC wall time: the midnight-ending 15 min belongs to September 15.
    // The first gap contributes only its two minutes inside the selected range.
    expect(history.points.map(p=>p.active_seconds)).toEqual([1380,0]);
    expect(history.totals.active_seconds).toBe(1380);
    expect(history.points[0]!.split![ACCOUNTS.a]).toEqual({tokens:7000,calls:4,active_seconds:1080});
    expect(history.points[0]!.split![ACCOUNTS.b]).toEqual({tokens:11000,calls:2,active_seconds:300});
    const project = buildProjectCost(f.db,rates,new Map(),{
      since:opts.since,until:opts.until,
    }).subjects.find(row=>row.subject==="p:alpha")!;
    expect(history.totals.billed_usd).toBe(3.73);
    expect(history.totals.billed_usd).toBe(project.billed_usd);
    expect(history.totals.api_usd).toBe(project.api_usd);
    const subjects = listSubjects(f.db,15,{since:opts.since,until:opts.until},{rateCards:rates});
    const alpha = subjects.find(row=>row.kind==="project"&&row.id==="alpha")!;
    expect(alpha.tokens).toBe(history.totals.tokens);
    expect(alpha.calls).toBe(history.totals.calls);
    expect(alpha.active_seconds).toBe(history.totals.active_seconds);
  } finally { f.teardown(); }
});

test("a share-only change after reopen leaves Claude history and valuations unchanged", () => {
  const { f, build } = historyFixture();
  try {
    const first = build();
    const valuations = storedValuations(f.db);
    expect(valuations.length).toBeGreaterThan(0);
    f.changeShare(18);
    f.reopen();
    const second = build();
    expect(second).toEqual(first);
    expect(storedValuations(f.db)).toEqual(valuations);
  } finally { f.teardown(); }
});

test("Claude session metadata correction updates later activity and keeps valuations identical to the prior register", () => {
  const live = historyFixture(), reference = historyFixture();
  const correct = (f: typeof live.f) => {
    f.db.exec("UPDATE claude_events SET session_id='different-session' WHERE call_id='other-project'");
    f.prepareFacts();
  };
  try {
    live.build();
    const valuations = storedValuations(live.f.db);
    expect(valuations.length).toBeGreaterThan(0);
    correct(live.f);
    correct(reference.f);
    live.f.reopen();
    const changed = live.build();
    expect(changed).toEqual(reference.build());
    expect(changed.totals.active_seconds).toBe(1440);
    expect(storedValuations(live.f.db)).toEqual(valuations);
  } finally { live.f.teardown(); reference.f.teardown(); }
});

test("a correction before the selected day repairs its following session gap and matches a fresh reference", () => {
  const live = historyFixture(), reference = historyFixture();
  const correct = (f: typeof live.f) => {
    f.db.exec("UPDATE claude_events SET ts='2026-09-14T23:55:00.000Z' WHERE call_id='previous'");
    f.prepareFacts();
  };
  try {
    live.build();
    correct(live.f);
    correct(reference.f);
    live.f.reopen();
    const changed = live.build();
    expect(changed).toEqual(reference.build());
    // Moving the predecessor further before the range cannot add wall time inside it.
    expect(changed.totals.active_seconds).toBe(1380);
    expect(changed.totals.tokens).toBe(26_000);
  } finally { live.f.teardown(); reference.f.teardown(); }
});

test("an unpriced Claude call retains its tokens and blocks that account's whole-fee allocation", () => {
  const { f, build } = historyFixture();
  try {
    // A model without a rate (a record without a mode is Standard, so it would be priced).
    f.db.exec("UPDATE claude_events SET model='claude-unrated' WHERE call_id='other-project'");
    f.prepareFacts();
    const alpha = build();
    expect(alpha.totals.tokens).toBe(26_000);
    expect(alpha.totals.by_sub[ACCOUNTS.a]!.billed_usd).toBeNull();
    expect(alpha.totals.by_sub[ACCOUNTS.b]!.billed_usd).toBe(2);
    expect(alpha.totals.billed_complete).toBe(false);
    const beta = build({projectId:"beta"});
    expect(beta.totals.tokens).toBe(3000);
    expect(beta.totals.calls).toBe(1);
    expect(beta.totals.by_sub[ACCOUNTS.a]!.billed_usd).toBeNull();
    expect(beta.totals.billed_complete).toBe(false);
    expect(beta.totals.api_complete).toBe(false);
    expect(beta.points[0]!.api_complete).toBe(false);
  } finally { f.teardown(); }
});

test("a valid zero-token Claude call retains its verified account and known zero price", () => {
  const { f, event, build } = historyFixture();
  try {
    f.db.exec("DELETE FROM claude_events");
    event("zero-only", "2026-09-15T12:00:00.000Z", 0);
    f.prepareFacts();
    const report = build();
    expect(report.totals.tokens).toBe(0);
    expect(report.totals.calls).toBe(1);
    expect(report.totals.api_usd).toBe(0);
    expect(report.totals.api_complete).toBe(true);
    expect(Object.keys(report.totals.by_sub)).toEqual([ACCOUNTS.a]);
    expect(Object.keys(report.points[0]!.by_sub)).toEqual([ACCOUNTS.a]);
  } finally { f.teardown(); }
});

test("Claude source coverage uses actual UTC evidence, including unverified rows, and disappears after deletion", () => {
  const { f, event, build } = historyFixture();
  try {
    f.db.exec("DELETE FROM claude_events");
    event("unverified-utc", "2026-09-13T23:30:00-02:00", 1000, null);
    f.prepareFacts();
    const report = build();
    expect(report.vendor_coverage.find(row => row.vendor === "claude"))
      .toEqual({ vendor: "claude", first: "2026-09-14", last: "2026-09-14" });
    expect(report.totals.calls).toBe(0);
    f.reopen();
    expect(build()).toEqual(report);
    f.db.exec("DELETE FROM claude_events");
    f.prepareFacts();
    expect(build().vendor_coverage.find(row => row.vendor === "claude"))
      .toEqual({ vendor: "claude", first: null, last: null });
  } finally { f.teardown(); }
});

test("UTC day selection and calendar granularity preserve history tokens, calls and activity", () => {
  const { f, build } = historyFixture();
  try {
    // The source date is the previous day, but it denotes the same instant.
    f.db.exec("UPDATE claude_events SET ts='2026-09-14T22:02:00-02:00' WHERE call_id='first'");
    f.prepareFacts();
    const day=build();
    expect(day.totals.tokens).toBe(26_000);
    expect(day.totals.calls).toBe(7);
    expect(day.totals.active_seconds).toBe(1380);
    for(const granularity of ["week","month"] as const) {
      const other=build({granularity});
      expect(other.totals).toEqual(day.totals);
      expect(other.points).toHaveLength(1);
    }
  } finally {f.teardown();}
});

test("history rounds API totals once across verified accounts", () => {
  const { f, event, build } = historyFixture();
  try {
    f.db.exec("DELETE FROM claude_events");
    for(const account of Object.values(ACCOUNTS))
      event(`fraction-${account}`,"2026-09-15T12:00:00.000Z",1000,account);
    f.prepareFacts();
    const history=build();
    // Two .0054 USD calls total .0108 USD; individually rounded account cents are .02.
    expect(history.totals.api_usd).toBe(.01);
    expect(history.points[0]!.api_usd).toBe(.01);
    expect(history.totals.tokens).toBe(2000);
  } finally {f.teardown();}
});

test("a new canonical mirror cannot move activity between simultaneous calls' projects", () => {
  const { f, event, build } = historyFixture();
  try {
    f.db.exec("DELETE FROM claude_events");
    event("previous","2026-09-15T00:00:00.000Z",1000);
    event("a-simultaneous","2026-09-15T00:05:00.000Z",1000);
    event("b-simultaneous","2026-09-15T00:05:00.000Z",1000,ACCOUNTS.a,"beta");
    f.db.exec("UPDATE claude_events SET id=200 WHERE call_id='a-simultaneous'; UPDATE claude_events SET id=100 WHERE call_id='b-simultaneous'");
    f.prepareFacts();
    const before=build();
    event("a-simultaneous","2026-09-15T00:05:00.000Z",1000,ACCOUNTS.a,"alpha","shared-session","standard","new-copy");
    f.db.exec("UPDATE claude_events SET id=10 WHERE store='new-copy'");
    f.prepareFacts();
    const after=build();
    expect(after.totals.tokens).toBe(2000);
    expect(after.totals.calls).toBe(2);
    expect(after.totals.active_seconds).toBe(before.totals.active_seconds);
  } finally {f.teardown();}
});

test("deleting an intermediate session day recomposes the following day without losing predecessor context", () => {
  const live=historyFixture(), reference=historyFixture();
  const correct=(f:typeof live.f)=>{
    f.db.exec("DELETE FROM claude_events WHERE call_id IN ('first','other-project','back')");
    f.prepareFacts();
  };
  try {
    live.build();
    correct(live.f);
    correct(reference.f);
    live.f.reopen();
    const changed=live.build({since:"2026-09-16"});
    expect(changed).toEqual(reference.build({since:"2026-09-16"}));
    // The capped interval ends at September 16 midnight, so all of it belongs to September 15.
    expect(changed.totals.tokens).toBe(8000);
    expect(changed.totals.calls).toBe(1);
    expect(changed.totals.active_seconds).toBe(0);
  } finally {live.f.teardown();reference.f.teardown();}
});

test("Claude history refuses an unsafe combined token total even when each account is safe", () => {
  const { f, build } = historyFixture();
  try {
    f.db.exec("DELETE FROM claude_events");
    const insert=f.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,subscription_id,
      project_id,in_uncached) VALUES('synthetic',?,'synthetic.jsonl','2026-09-15T12:00:00.000Z',
      'claude-sonnet-fixture','standard',?,'alpha',?)`);
    for(const account of Object.values(ACCOUNTS))insert.run(account,account,2**52);
    f.prepareFacts();
    expect(()=>build()).toThrow(/unsafe/i);
  } finally {f.teardown();}
});

test("a resumed session keeps its capped predecessor gap beyond the account's two most recent active days", () => {
  const { f, event, build }=historyFixture();
  try {
    f.db.exec("DELETE FROM claude_events");
    event("old-session-call","2026-09-01T12:00:00.000Z",1000);
    for(const day of [12,13,14])event(`unrelated-${day}`,`2026-09-${day}T12:00:00.000Z`,1000,
      ACCOUNTS.a,"beta",`unrelated-${day}`);
    event("resumed","2026-09-15T12:00:00.000Z",1000);
    f.prepareFacts();
    const report=build({since:"2026-09-15",until:"2026-09-15"});
    expect(report.totals.calls).toBe(1);
    expect(report.totals.active_seconds).toBe(900);
  } finally {f.teardown();}
});

test("fractional activity remains additive across model splits and subject summaries", () => {
  const { f, event, rates, opts, build }=historyFixture();
  try {
    f.db.exec("DELETE FROM claude_events");
    for(let i=0;i<4;i++) {
      const model=`fractional-model-${i}`;
      rates.vendors.anthropic!.models![model]=structuredClone(rates.vendors.anthropic!.models!["claude-sonnet-fixture"]!);
      event(`fractional-${i}`,`2026-09-15T00:00:00.${String(i*333).padStart(3,"0")}Z`,1000);
      f.db.query("UPDATE claude_events SET model=? WHERE call_id=?").run(model,`fractional-${i}`);
    }
    f.prepareFacts();
    const report=build({by:"model"});
    expect(report.totals.active_seconds).toBeCloseTo(.999,9);
    expect(Object.values(report.points[0]!.split!).reduce((sum,row)=>sum+row.active_seconds,0)).toBeCloseTo(.999,9);
    const subjects=listSubjects(f.db,15,{since:opts.since,until:opts.until},{rateCards:rates});
    expect(subjects.find(row=>row.id==="alpha")!.active_seconds).toBeCloseTo(.999,9);
  } finally {f.teardown();}
});

test("the real Claude history worker answers read-only, and the same after reopen", async () => {
  const { f, rates } = historyFixture();
  const ctx = { sqlite:f.db,dbPath:f.dbPath,rateCards:rates,accounts:{version:2,subscriptions:[],sources:[]},
    homeToSubId:new Map(),subIdToHomes:new Map(),eras:buildEraIndex([]),eraErrors:[],homeConflict:null,
    claudeGauge:{},grokGauge:{},cycles:{},plans:{},plansCatalog:{provider_groups:[]},
    rootDir:f.directory,attribution:null } as unknown as AppContext;
  let reader = createDataRead();
  // The analysis worker reads projects.json.
  const restoreRules = publishFixtureRules(f.db);
  const url = "http://local/api/repo-history?project=alpha&since=2026-09-15&until=2026-09-16&granularity=day&by=account";
  try {
    expect((await reader(ctx,new Request(url))).status).toBe(202);
    await reader.whenIdle();
    const before = f.db.query("SELECT total_changes() n").get();
    const response = await reader(ctx,new Request(url));
    expect(response.status,await response.clone().text()).toBe(200);
    expect(response.headers.get("X-Analysis")).toBe("memory");
    expect(f.db.query("SELECT total_changes() n").get()).toEqual(before);
    const report = await response.json();
    expect(report.totals.tokens).toBe(26_000);
    expect(report.totals.active_seconds).toBe(1380);
    await reader.close();
    ctx.sqlite=f.reopen();
    reader=createDataRead();
    // A restart keeps no answers; the stored rows give the same one again.
    expect((await reader(ctx,new Request(url))).status).toBe(202);
    await reader.whenIdle();
    const reopened=await reader(ctx,new Request(url));
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual(report);
  } finally {await reader.close();restoreRules();f.teardown();}
},30_000);
