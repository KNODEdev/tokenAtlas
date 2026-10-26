import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Database } from '../db/sqlite';
import { createCodexLedgerSchema } from '../db/codex-price-ledger';
import { enqueueCodexLedgerRuleChanges } from '../db/codex-ledger-producer';
import { codexLedgerReadContext } from '../db/codex-ledger-adapters';
import { installAnalysisTracking } from '../db/analysis';
import { buildGlobalUsage } from './global-usage';
import { buildProjectCost } from './project-cost';
import { buildRepoHistory } from './repo-history';
import { resolveCodexCapacities,restoreSubscriptionHomes } from './capacity-equivalents';
import type { RateCard } from './pricing';
import type { CodexLedgerPolicy } from './codex-ledger-policy';
import { fillCodexLedgerFixture } from "./codex-ledger.fixture";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

const A={since:'2026-04-01',until:'2026-04-01'},B={since:'2026-10-01',until:'2026-10-01'};
const evidence={verified_at:'2026-01-01',sources:['https://example.test/prices'],confidence:'official' as const};
function policy():CodexLedgerPolicy {
  return {version:1,tiers:['standard','fast'],mappings:[{id:'default',raw_value:'default',tier:'standard'}],
    base_rules:['api_equivalent_usd','chatgpt_credits'].map(billing_basis=>({id:billing_basis,model:'model',
      billing_basis:billing_basis as 'api_equivalent_usd'|'chatgpt_credits',valid_from:'2026-01-01',multiplier:'1',
      rates:{in_uncached:'1',in_cache_read:'0.1',out_total:'5'},...evidence})),
    tier_rules:['api_equivalent_usd','chatgpt_credits'].flatMap(billing_basis=>['standard','fast'].map(tier=>({
      id:`${billing_basis}-${tier}`,model:'model',billing_basis:billing_basis as 'api_equivalent_usd'|'chatgpt_credits',
      tier,valid_from:'2026-01-01',multiplier:tier==='fast'?'2':'1',...evidence})))};
}
function fixture(run:(db:Database,card:RateCard)=>void) {
  const db=new Database(':memory:'),card:RateCard={version:2,currency:'USD',unit:'per 1M',vendors:{},codex_ledger_policy:policy()};
  try {
    db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,
      speed TEXT,service_tier TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,
      project_id TEXT,repo TEXT,repo_group TEXT,gap_seconds REAL);
      INSERT INTO events VALUES(1,'/archive','/archive/a.jsonl',1,'2026-04-01T12:00:00Z','model','standard','default',1000000,0,0,0,0,'a','repo-a','test',0);
      INSERT INTO events VALUES(2,'/archive','/archive/b.jsonl',2,'2026-10-01T12:00:00Z','model','standard','default',1000000,0,0,0,0,'b','repo-b','test',0);
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);`);
    db.exec(readFileSync(new URL('../../drizzle/0040_account_periods.sql',import.meta.url),'utf8'));
    db.query("INSERT INTO account_periods(provider,source,account,from_ts,origin,evidence) VALUES('codex','codex/main','accounta','2026-01-01T00:00:00Z','declared','fixture')").run();
    createCodexLedgerSchema(db);
    const context=codexLedgerReadContext(card);
    fillCodexLedgerFixture(db,{bands:context.policy.baseBands,policy:context.policy.policy,
      rulesRevision:context.rulesRevision!,factsRevision:0,sourceOf:()=> 'codex/main'});
    enqueueCodexLedgerRuleChanges(db,{bands:context.policy.baseBands,policy:context.policy.policy,rulesRevision:context.rulesRevision!});
    db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind IN ('copy','blocked','rules')");
    createAnalysisSourceRevisions(db);installAnalysisTracking(db);
    run(db,card);
  } finally {db.close();}
}
function future(db:Database,card:RateCard,basis:'api_equivalent_usd'|'chatgpt_credits'='api_equivalent_usd') {
  const next=structuredClone(card),rule=next.codex_ledger_policy!.base_rules.find(rule=>rule.billing_basis===basis)!;
  rule.valid_until=B.since;
  next.codex_ledger_policy!.base_rules.push({...rule,id:'future-'+basis,valid_from:B.since,valid_until:undefined,rates:{...rule.rates,in_uncached:'3'}});
  const context=codexLedgerReadContext(next);
  enqueueCodexLedgerRuleChanges(db,{bands:context.policy.baseBands,policy:context.policy.policy,rulesRevision:context.rulesRevision!});
  return next;
}
test('global UTC usage keeps A readable before pending B and requires both price bases',()=>fixture((db,card)=> {
  const read=(rateCards:RateCard,range=A)=>buildGlobalUsage({sqlite:db,rateCards,homeToSubId:new Map()},{...range,vendors:['codex']});
  const original=read(card),next=future(db,card,'chatgpt_credits');
  expect(read(next)).toEqual(original);
  expect(()=>read(next,B)).toThrow();expect(()=>read(next,{since:A.since,until:B.until})).toThrow();
  const unrelated=buildGlobalUsage({sqlite:db,rateCards:card,homeToSubId:new Map()},{...A,vendors:['claude']});
  db.exec("UPDATE usage_ledger_state SET status='pending' WHERE provider='codex'");
  expect(buildGlobalUsage({sqlite:db,rateCards:next,homeToSubId:new Map()},{...A,vendors:['claude']})).toEqual(unrelated);
}));
test('project report keeps A readable during independent B work and guards normalized/capacity credit dependencies',()=>fixture((db,card)=> {
  const read=(rates:RateCard,range=A)=>buildProjectCost(db,rates,new Map(),range);
  const original=read(card),next=future(db,card);
  expect(read(next)).toEqual(original);
  expect(()=>read(next,B)).toThrow();expect(()=>read(next,{since:A.since,until:B.until})).toThrow();
  const credit=structuredClone(next),rule=credit.codex_ledger_policy!.base_rules.find(rule=>rule.billing_basis==='chatgpt_credits')!;
  rule.rates.in_uncached='2';const context=codexLedgerReadContext(credit);
  enqueueCodexLedgerRuleChanges(db,{bands:context.policy.baseBands,policy:context.policy.policy,rulesRevision:context.rulesRevision!});
  expect(()=>read(credit)).toThrow();
}));
test('repository USD range remains readable during unrelated credit and future API work',()=>fixture((db,card)=> {
  const read=(rateCards:RateCard,range=A)=>buildRepoHistory(db,{repo:null,projectId:'a',granularity:'day',by:'none',idleGapMinutes:15,
    ...range,rateCards,homeToSubId:new Map()});
  const original=read(card),next=future(db,card);
  expect(read(next)).toEqual(original);expect(()=>read(next,B)).toThrow();
  const credit=structuredClone(next),rule=credit.codex_ledger_policy!.base_rules.find(rule=>rule.billing_basis==='chatgpt_credits')!;
  rule.rates.in_uncached='2';const context=codexLedgerReadContext(credit);
  enqueueCodexLedgerRuleChanges(db,{bands:context.policy.baseBands,policy:context.policy.policy,rulesRevision:context.rulesRevision!});
  expect(read(credit)).toEqual(original);
}));
test('a copied call counts once and keeps the project of its canonical copy',()=>fixture((db,card)=> {
  // /mirror/a.jsonl is a longer copy of /archive/a.jsonl: its first record is the archived call.
  db.exec(`INSERT INTO events(id,home,path,source_offset,ts,model,speed,service_tier,in_tok,cached_in,cache_write,out_tok,reasoning_out,project_id,repo,repo_group,gap_seconds) VALUES(3,'/mirror','/mirror/a.jsonl',1,'2026-04-01T12:00:00Z','model','standard','default',1000000,0,0,0,0,'winner','repo-winner','test',0);
    INSERT INTO events(id,home,path,source_offset,ts,model,speed,service_tier,in_tok,cached_in,cache_write,out_tok,reasoning_out,project_id,repo,repo_group,gap_seconds) VALUES(4,'/mirror','/mirror/a.jsonl',2,'2026-04-01T14:00:00Z','model','standard','default',1000000,0,0,0,0,'winner','repo-winner','test',0);`);
  for(const table of ['codex_price_ledger_aggregates','codex_price_ledger_events','codex_price_ledger_dims','codex_price_ledger_copies','codex_price_ledger_bands']) db.exec('DELETE FROM '+table);db.exec("DELETE FROM usage_ledger_state WHERE provider='codex'");
  const context=codexLedgerReadContext(card);
  fillCodexLedgerFixture(db,{bands:context.policy.baseBands,policy:context.policy.policy,
    rulesRevision:context.rulesRevision!,factsRevision:0,sourceOf:()=> 'codex/main'});
  const global=buildGlobalUsage({sqlite:db,rateCards:card,homeToSubId:new Map()},{...A,vendors:['codex']});
  expect(global.sources[0]!.events).toBe(3);expect(global.excluded_duplicates).toBe(1);expect(global.rows.reduce((n,row)=>n+row.calls,0)).toBe(2);
  const project=buildProjectCost(db,card,new Map(),A);
  // The canonical copy is the least source key (the archive), so the shared call keeps its project.
  expect(project.subjects.find(row=>row.subject==='p:a')!.calls).toBe(1);
  expect(project.subjects.find(row=>row.subject==='p:winner')!.calls).toBe(1);
  const history=buildRepoHistory(db,{repo:null,projectId:'a',granularity:'day',by:'none',idleGapMinutes:15,...A,
    rateCards:card,homeToSubId:new Map()});
  expect(history.totals.calls).toBe(1);
}));
test('a cold project read reads only its requested native days',()=>fixture((db,card)=> {
  const next=future(db,card);
  const report=buildProjectCost(db,next,new Map(),A);
  expect(report.subjects.find(row=>row.subject==='p:a')!.calls).toBe(1);
  expect(report.subjects.some(row=>row.subject==='p:b')).toBe(false);
  expect(()=>buildProjectCost(db,next,new Map(),B)).toThrow();
}));

test('capacity memo proves scoped readiness before reuse and observes same-card publication changes',()=>fixture((db,card)=> {
  const homes=restoreSubscriptionHomes([['/archive','accounta']],[]),configs={accounta:{usd_per_month:20}};
  const read=()=>resolveCodexCapacities(db,card,homes,configs,undefined,A);
  const original=read();
  expect(read()).toBe(original);
  const next=future(db,card);card.codex_ledger_policy=next.codex_ledger_policy;
  expect(read()).toBe(original);
  const rule=card.codex_ledger_policy!.base_rules.find(rule=>rule.billing_basis==='chatgpt_credits')!;
  rule.rates.in_uncached='2';const changed=codexLedgerReadContext(card);
  enqueueCodexLedgerRuleChanges(db,{bands:changed.policy.baseBands,policy:changed.policy.policy,rulesRevision:changed.rulesRevision!});
  const pending=read();expect(pending).not.toBe(original);
  expect(pending.get('accounta')!.note).toContain('awaiting background preparation');
  const ready=codexLedgerReadContext(card);
  for(const table of ['codex_price_ledger_aggregates','codex_price_ledger_events','codex_price_ledger_dims','codex_price_ledger_copies','codex_price_ledger_bands']) db.exec('DELETE FROM '+table);db.exec("DELETE FROM usage_ledger_state WHERE provider='codex'");
  fillCodexLedgerFixture(db,{bands:ready.policy.baseBands,policy:ready.policy.policy,
    rulesRevision:ready.rulesRevision!,factsRevision:1,sourceOf:()=> 'codex/main'});
  enqueueCodexLedgerRuleChanges(db,{bands:ready.policy.baseBands,policy:ready.policy.policy,rulesRevision:ready.rulesRevision!});
  db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind IN ('copy','blocked','rules')");
  expect(read()).not.toBe(original);
  db.exec("UPDATE usage_ledger_state SET status='pending' WHERE provider='codex'");
  expect(resolveCodexCapacities(db,card,homes,configs,undefined,A,new Set()).size).toBe(0);
}));
