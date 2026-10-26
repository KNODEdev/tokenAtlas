import { codexLedgerFactsPending } from "./read-freshness";
import { expect, test, spyOn } from "bun:test";
import { Database } from "./sqlite";
import { createCodexLedgerSchema, readCodexLedgerGroups } from "./codex-price-ledger";
import { enqueueCodexLedgerRuleChanges, markCodexLedgerCopiesDirty } from "./codex-ledger-producer";
import { ensureUsageLedgerSchema } from "./usage-ledger";
import { codexLedgerReadContext, codexLedgerPendingReason, codexLedgerReadStamp } from "./codex-ledger-adapters";
import type { CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { apiCodexLedgerRows } from "../server/api-codex-ledger";
import { handleSummary, handleBreakdown, handleCompare, handleCache, type AppContext } from "../server/api";
import { buildCodexAccountingReport } from "../server/codex-accounting";
import { buildAccountResolver } from "../server/account-resolver";
import { installAnalysisTracking } from "./analysis";
import type { RateCard } from "../server/pricing";
import { codexUsageSeries, codexReadings } from "./codex-ledger-query";
import { fillCodexLedgerFixture } from "../server/codex-ledger.fixture";
import { createAnalysisSourceRevisions } from "./analysis-source-revisions.fixture";

const april = { since: "2026-04-01", until: "2026-04-01" };
const october = { since: "2026-10-01", until: "2026-10-01" };
const evidence = { verified_at: "2026-01-01", sources: ["https://example.test/prices"], confidence: "official" as const };
function policy(): CodexLedgerPolicy {
  return { version: 1, tiers: ["standard", "fast"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }],
    base_rules: ["api_equivalent_usd", "chatgpt_credits"].map(billing_basis => ({ id: billing_basis, model: "model",
      billing_basis: billing_basis as "api_equivalent_usd" | "chatgpt_credits", valid_from: "2026-01-01", multiplier: "1",
      rates: { in_uncached: "1", in_cache_read: "0.1", out_total: "5" }, ...evidence })),
    tier_rules: ["api_equivalent_usd", "chatgpt_credits"].flatMap(billing_basis => ["standard", "fast"].map(tier => ({
      id: `${billing_basis}-${tier}`, model: "model", billing_basis: billing_basis as "api_equivalent_usd" | "chatgpt_credits",
      tier, valid_from: "2026-01-01", multiplier: tier === "fast" ? "2" : "1", ...evidence }))) };
}
function fixture(run: (db: Database, card: RateCard, resolver: ReturnType<typeof buildAccountResolver>) => void, additionalModel = false) {
  const db = new Database(":memory:");
  const card: RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: {}, codex_ledger_policy: policy() };
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,speed TEXT,service_tier TEXT,
      in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,project_id TEXT);
      INSERT INTO events VALUES('/archive','/archive/a.jsonl',1,'2026-04-01T12:00:00Z','model','standard','default',100,0,0,0,'a');
      INSERT INTO events VALUES('/archive','/archive/b.jsonl',2,'2026-10-01T12:00:00Z','model','standard','default',100,0,0,0,'b');`);
    if (additionalModel) {
      db.exec("INSERT INTO events VALUES('/archive','/archive/other.jsonl',3,'2026-04-01T13:00:00Z','other','standard','default',100,0,0,0,'other')");
      const rules = card.codex_ledger_policy!;
      rules.base_rules.push(...rules.base_rules.map(rule=>({...structuredClone(rule),id:rule.id+'-other',model:'other'})));
      rules.tier_rules.push(...rules.tier_rules.map(rule=>({...structuredClone(rule),id:rule.id+'-other',model:'other'})));
    }
    createCodexLedgerSchema(db);
    ensureUsageLedgerSchema(db);
    const context = codexLedgerReadContext(card);
    fillCodexLedgerFixture(db, { bands: context.policy.baseBands, policy: context.policy.policy,
      rulesRevision: context.rulesRevision!, factsRevision: 0, sourceOf: () => "codex/main" });
    enqueueCodexLedgerRuleChanges(db, { bands: context.policy.baseBands, rulesRevision: context.rulesRevision!, policy: context.policy.policy });
    // The bootstrap notification from an empty target is explicitly completed in this prepared fixture.
    db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind IN ('copy','blocked','rules')");
    const resolver = buildAccountResolver([{ provider: "codex", subject: "codex/main", from: "2026-01-01", until: null,
      value: "accounta", origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
    run(db, card, resolver);
  } finally { db.close(); }
}
function changed(card: RateCard): RateCard {
  const next = structuredClone(card), rule = next.codex_ledger_policy!.base_rules.find(rule => rule.billing_basis === "api_equivalent_usd")!;
  rule.valid_until = "2026-10-01";
  next.codex_ledger_policy!.base_rules.push({ ...rule, id: "october-api", valid_from: "2026-10-01", valid_until: undefined,
    rates: { ...rule.rates, in_uncached: "3" } });
  return next;
}
test("unrelated dated base work preserves April API/accounting, while October and full reads stay pending", () => fixture((db, card, resolver) => {
  createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
  const report = (rates: RateCard, range = april) => buildCodexAccountingReport(db, rates, { ...range, account: "accounta" },
    new Map(), undefined, false, undefined, {}, { provider_groups: [] }, resolver, []);
  const original = report(card), before = db.query("SELECT * FROM codex_price_ledger_events WHERE day='2026-04-01'").all();
  const context = codexLedgerReadContext(card), stamp = codexLedgerReadStamp(db, context, april);
  const next = changed(card), current = codexLedgerReadContext(next);
  enqueueCodexLedgerRuleChanges(db, { bands: current.policy.baseBands, rulesRevision: current.rulesRevision!, policy: current.policy.policy });
  expect(codexLedgerPendingReason(db, { ...current, range: april })).toBeNull();
  expect(codexLedgerPendingReason(db, { range: april })).not.toBeNull();
  expect(codexLedgerReadStamp(db, current, april)).toBe(stamp);
  expect(readCodexLedgerGroups(db, april)).toHaveLength(1);
  expect(apiCodexLedgerRows({ sqlite: db, rateCards: next, homeToSubId: new Map() }, april, undefined, resolver)).toHaveLength(1);
  const ctx = { sqlite: db, rateCards: next, homeToSubId: new Map(), resolver } as AppContext;
  for (const handler of [handleSummary, handleBreakdown, handleCache]) {
    expect(handler(ctx, new URL("http://test/?dim=model&vendor=codex&since=2026-04-01&until=2026-04-01")).status).toBe(200);
    expect(handler(ctx, new URL("http://test/?dim=model&vendor=codex&since=2026-10-01&until=2026-10-01")).status).toBe(202);
  }
  expect(handleCompare(ctx, new URL("http://test/?vendor=codex&a_since=2026-04-01&a_until=2026-04-01&b_since=2026-04-01&b_until=2026-04-01")).status).toBe(200);
  expect(handleCompare(ctx, new URL("http://test/?vendor=codex&a_since=2026-04-01&a_until=2026-04-01&b_since=2026-10-01&b_until=2026-10-01")).status).toBe(202);
  expect(report(next)).toEqual(original);
  for (const range of [october, { since: april.since, until: october.until }]) {
    expect(() => readCodexLedgerGroups(db, range)).toThrow();
    expect(() => apiCodexLedgerRows({ sqlite: db, rateCards: next, homeToSubId: new Map() }, range, undefined, resolver)).toThrow();
    expect(() => report(next, range)).toThrow();
  }
  expect(db.query("SELECT * FROM codex_price_ledger_events WHERE day='2026-04-01'").all()).toEqual(before);
  // A completed rule chunk is still not a published generation while any other work remains.
  db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind IN ('copy','blocked','rules'); INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','{\"model\":\"other\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-10-01\",\"untilDay\":null,\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}')");
  expect(() => readCodexLedgerGroups(db, october)).toThrow();
  expect(() => report(next, october)).toThrow();
  expect(report(next)).toEqual(original);
  // A queued copy is newer facts: the published sums stay readable, marked pending (golden rules §9).
  db.transaction(() => markCodexLedgerCopiesDirty(db, [{ home: '/archive', path: '/archive/new.jsonl' }])).immediate();
  expect(codexLedgerPendingReason(db, { ...current, range: april })).toBeNull();
  expect(codexLedgerFactsPending(db)).toBe(true);
  expect(report(next)).toEqual(original);
}));
test("API-only reads remain ready during credit work, while accounting keeps both bases as dependencies", () => fixture((db, card, resolver) => {
  const next = structuredClone(card), credit = next.codex_ledger_policy!.base_rules.find(rule => rule.billing_basis === "chatgpt_credits")!;
  credit.rates.in_uncached = "3";
  const current = codexLedgerReadContext(next), range = { ...april, dependencyBases: ["api_equivalent_usd"] as const };
  const stamp = codexLedgerReadStamp(db, codexLedgerReadContext(card), range);
  enqueueCodexLedgerRuleChanges(db, { bands: current.policy.baseBands, rulesRevision: current.rulesRevision!, policy: current.policy.policy });
  expect(codexLedgerPendingReason(db, { ...current, range })).toBeNull();
  expect(codexLedgerReadStamp(db, current, range)).toBe(stamp);
  expect(apiCodexLedgerRows({ sqlite: db, rateCards: next, homeToSubId: new Map() }, april, undefined, resolver)).toHaveLength(1);
  expect(handleSummary({ sqlite: db, rateCards: next, homeToSubId: new Map(), resolver } as AppContext,
    new URL("http://test/?vendor=codex&since=2026-04-01&until=2026-04-01")).status).toBe(200);
  expect(codexLedgerPendingReason(db, { ...current, range: april })).not.toBeNull();
  expect(() => buildCodexAccountingReport(db, next, { ...april, account: "accounta" }, new Map(), undefined,
    false, undefined, {}, { provider_groups: [] }, resolver, [])).toThrow();
}));
test("context-only changes block only intersecting stored inputs, including offset quoted-day UTC edges", () => fixture((db, card) => {
  const stamp = codexLedgerReadStamp(db, codexLedgerReadContext(card), april);
  const next = structuredClone(card), rule = next.codex_ledger_policy!.base_rules.find(rule => rule.billing_basis === "api_equivalent_usd")!;
  rule.long_context = { above_input_tokens: 100, rates: { ...rule.rates, in_uncached: "3" } };
  const current = codexLedgerReadContext(next);
  enqueueCodexLedgerRuleChanges(db, { bands: current.policy.baseBands, rulesRevision: current.rulesRevision!, policy: current.policy.policy });
  expect(codexLedgerPendingReason(db, { ...current, range: april })).toBeNull();
  expect(codexLedgerReadStamp(db, current, april)).toBe(stamp);
  expect(readCodexLedgerGroups(db, april)).toHaveLength(1);
  db.exec("UPDATE codex_price_ledger_events SET in_tok=101,ts='2026-04-01T00:30:00+02:00',instant_ms=" + Date.parse("2026-04-01T00:30:00+02:00") + " WHERE day='2026-04-01'");
  const utc = { fromMs: Date.parse("2026-03-31T22:00:00Z"), toMs: Date.parse("2026-03-31T23:00:00Z") };
  expect(codexLedgerPendingReason(db, { ...current, range: utc })).not.toBeNull();
  expect(() => readCodexLedgerGroups(db, utc)).toThrow();
}));
test("model-filtered charts and readings keep full copy candidates while depending only on the requested model", () => fixture((db, card) => {
  const next = structuredClone(card), rule = next.codex_ledger_policy!.base_rules.find(rule => rule.model === 'other' && rule.billing_basis === 'api_equivalent_usd')!;
  rule.rates.in_uncached = '3';
  const current = codexLedgerReadContext(next), range = { ...april, dependencyModels: ['model'] };
  const stamp = codexLedgerReadStamp(db, codexLedgerReadContext(card), range);
  enqueueCodexLedgerRuleChanges(db, { bands: current.policy.baseBands, rulesRevision: current.rulesRevision!, policy: current.policy.policy });
  expect(() => readCodexLedgerGroups(db, april)).toThrow();
  expect(readCodexLedgerGroups(db, range)).toHaveLength(2);
  expect(codexLedgerReadStamp(db, current, range)).toBe(stamp);
  const fromMs = Date.parse(april.since), toMs = fromMs + 86400000;
  expect(codexUsageSeries(db, current.policy, { fromMs, toMs, grain: 'hour', models: ['model'] }).reduce((sum,row)=>sum+row.calls,0n)).toBe(1n);
  expect(codexReadings(db, current.policy, { startMs: fromMs, endMs: toMs, models: ['model'] }).calls).toBe(1n);
}, true));
test("unused raw-tier mappings keep independent scoped reads ready, while a used mapping remains pending", () => fixture((db, card) => {
  const next = changed(card);
  next.codex_ledger_policy!.mappings.push({ id: 'unused-priority', raw_value: 'priority', tier: 'fast' });
  const current = codexLedgerReadContext(next), stamp = codexLedgerReadStamp(db,codexLedgerReadContext(card),april);
  enqueueCodexLedgerRuleChanges(db, { bands:current.policy.baseBands, rulesRevision:current.rulesRevision!, policy:current.policy.policy });
  expect(codexLedgerPendingReason(db,{...current,range:april})).toBeNull();
  expect(codexLedgerReadStamp(db,current,april)).toBe(stamp);
  const affected = structuredClone(next);
  affected.codex_ledger_policy!.mappings[0]!.tier = 'fast';
  expect(codexLedgerPendingReason(db,{...codexLedgerReadContext(affected),range:april})).toBe('usage-price-rules-pending');
}));

test("unrelated base-only work does not repeatedly probe unchanged tier history before cache reads", () => fixture((db, card) => {
  const next = changed(card), current = codexLedgerReadContext(next);
  enqueueCodexLedgerRuleChanges(db, { bands: current.policy.baseBands, rulesRevision: current.rulesRevision!, policy: current.policy.policy });
  const original = db.query.bind(db), probes: string[] = [];
  const query = spyOn(db, "query").mockImplementation(((sql: string) => {
    if (sql.includes("e.day>=?") && sql.includes("LIMIT 1")) probes.push(sql);
    return original(sql);
  }) as typeof db.query);
  try {
    for (let i = 0; i < 3; i++) expect(codexLedgerPendingReason(db, { ...current, range: april })).toBeNull();
    expect(probes).toHaveLength(0);
    expect(codexLedgerPendingReason(db, { ...current, range: october })).not.toBeNull();
  } finally { query.mockRestore(); }
}));

test("UTC reads ending before a dated tier change keep their ready proof during unrelated base work", () => fixture((db, card) => {
  const range = { fromMs: Date.parse("2026-04-01"), toMs: Date.parse("2026-04-02") };
  const before = codexLedgerReadStamp(db, codexLedgerReadContext(card), range), next = changed(card);
  const old = next.codex_ledger_policy!.tier_rules.find(rule => rule.billing_basis === "chatgpt_credits" && rule.tier === "fast")!;
  old.valid_until = "2026-04-02";
  next.codex_ledger_policy!.tier_rules.push({ ...old, id: "later-fast", valid_from: "2026-04-02", valid_until: undefined, multiplier: "3" });
  const current = codexLedgerReadContext(next);
  enqueueCodexLedgerRuleChanges(db, { bands: current.policy.baseBands, rulesRevision: current.rulesRevision!, policy: current.policy.policy });
  expect(codexLedgerPendingReason(db, { ...current, range })).toBeNull();
  expect(codexLedgerReadStamp(db, current, range)).toBe(before);
}));

test('an adjacent lexical tier day inside the UTC request remains dependent, including raw NULL counterfactuals',()=>fixture((db,card)=>{
  db.exec("UPDATE events SET ts='2026-04-02T00:30:00+02:00',service_tier=NULL,speed=NULL WHERE ts LIKE '2026-04-01%'");
  for(const table of ['codex_price_ledger_aggregates','codex_price_ledger_events','codex_price_ledger_dims','codex_price_ledger_copies','codex_price_ledger_bands'])db.exec('DELETE FROM '+table);db.exec("DELETE FROM usage_ledger_state WHERE provider='codex'");
  const original=codexLedgerReadContext(card);
  fillCodexLedgerFixture(db,{bands:original.policy.baseBands,policy:original.policy.policy,
    rulesRevision:original.rulesRevision!,factsRevision:1,sourceOf:()=> 'codex/main'});
  const range={fromMs:Date.parse('2026-04-01'),toMs:Date.parse('2026-04-02')};
  const api={...range,dependencyBases:['api_equivalent_usd'] as const},apiStamp=codexLedgerReadStamp(db,original,api);
  const next=changed(card),old=next.codex_ledger_policy!.tier_rules.find(rule=>rule.billing_basis==='chatgpt_credits'&&rule.tier==='fast')!;
  old.valid_until='2026-04-02';next.codex_ledger_policy!.tier_rules.push({...old,id:'offset-day-fast',valid_from:'2026-04-02',valid_until:undefined,multiplier:'3'});
  const current=codexLedgerReadContext(next);
  enqueueCodexLedgerRuleChanges(db,{bands:current.policy.baseBands,policy:current.policy.policy,rulesRevision:current.rulesRevision!});
  expect(codexLedgerPendingReason(db,{...current,range})).toBe('usage-price-rules-pending');
  expect(()=>codexLedgerReadStamp(db,current,range)).toThrow();
  expect(codexLedgerPendingReason(db,{...current,range:api})).toBeNull();
  expect(codexLedgerReadStamp(db,current,api)).toBe(apiStamp);
}));

test('dated mapping and tier evidence preserve unaffected scope stamps through metadata-only publication',()=>fixture((db,card)=>{
  const range={fromMs:Date.parse('2026-04-01'),toMs:Date.parse('2026-04-02')},original=codexLedgerReadContext(card);
  const stamp=codexLedgerReadStamp(db,original,range),parts=db.query('SELECT * FROM codex_price_ledger_events ORDER BY id').all();
  const next=structuredClone(card),mapping=next.codex_ledger_policy!.mappings[0]!;
  mapping.valid_until='2026-04-02';next.codex_ledger_policy!.mappings.push({...mapping,id:'later-default',valid_from:'2026-04-02',valid_until:undefined,tier:'fast'});
  const tier=next.codex_ledger_policy!.tier_rules.find(rule=>rule.billing_basis==='chatgpt_credits'&&rule.tier==='fast')!;
  tier.valid_until='2026-04-02';next.codex_ledger_policy!.tier_rules.push({...tier,id:'later-fast-evidence',valid_from:'2026-04-02',valid_until:undefined,multiplier:'3',note:'Later evidence'});
  const current=codexLedgerReadContext(next);
  expect(codexLedgerPendingReason(db,{...current,range})).toBeNull();expect(codexLedgerReadStamp(db,current,range)).toBe(stamp);
  expect(codexLedgerPendingReason(db,{...current,range:october})).toBe('usage-price-rules-pending');
  expect(codexLedgerPendingReason(db,{...current,range:{}})).toBe('usage-price-rules-pending');
  // Tier-only publication is immediate because neither stored base needs pricing work.
  expect(enqueueCodexLedgerRuleChanges(db,{bands:current.policy.baseBands,policy:current.policy.policy,rulesRevision:current.rulesRevision!})).toBe(0);
  expect(codexLedgerPendingReason(db,{...current,range:october})).toBeNull();
  expect(codexLedgerReadStamp(db,current,range)).toBe(stamp);
  expect(db.query('SELECT * FROM codex_price_ledger_events ORDER BY id').all()).toEqual(parts);
}));

test('actual fast-tier date provenance refreshes the applied rules without blocking unchanged money',()=>fixture((db,card,resolver)=>{
  card.codex_ledger_policy!.mappings.push({id:'priority',raw_value:'priority',tier:'fast'});
  db.exec("UPDATE events SET service_tier='priority',speed='fast' WHERE ts LIKE '2026-04-01%'");
  for(const table of ['codex_price_ledger_aggregates','codex_price_ledger_events','codex_price_ledger_dims','codex_price_ledger_copies','codex_price_ledger_bands'])db.exec('DELETE FROM '+table);db.exec("DELETE FROM usage_ledger_state WHERE provider='codex'");
  const initial=codexLedgerReadContext(card);
  fillCodexLedgerFixture(db,{bands:initial.policy.baseBands,policy:initial.policy.policy,
    rulesRevision:initial.rulesRevision!,factsRevision:1,sourceOf:()=> 'codex/main'});
  enqueueCodexLedgerRuleChanges(db,{bands:initial.policy.baseBands,policy:initial.policy.policy,rulesRevision:initial.rulesRevision!});
  createAnalysisSourceRevisions(db);installAnalysisTracking(db);
  const report=(rates:RateCard)=>buildCodexAccountingReport(db,rates,{...april,account:'accounta'},new Map(),undefined,false,undefined,{},
    {provider_groups:[]},resolver,[]);
  const before=report(card),parts=db.query('SELECT * FROM codex_price_ledger_events ORDER BY id').all();
  const originalStamp=codexLedgerReadStamp(db,initial,april),next=structuredClone(card);
  const fast=next.codex_ledger_policy!.tier_rules.find(rule=>rule.billing_basis==='chatgpt_credits'&&rule.tier==='fast')!;
  fast.valid_until='2026-04-02';next.codex_ledger_policy!.tier_rules.push({...fast,id:'later-credit-fast',valid_from:'2026-04-02',valid_until:undefined,multiplier:'3'});
  const current=codexLedgerReadContext(next);
  expect(codexLedgerPendingReason(db,{...current,range:april})).toBeNull();
  expect(codexLedgerReadStamp(db,current,april)).not.toBe(originalStamp);
  const after=report(next);
  expect(before.applied_rules.some(rule=>rule.speed==='fast'&&rule.billing_basis==='chatgpt_credits'&&rule.valid_until===undefined)).toBe(true);
  expect(after.applied_rules.some(rule=>rule.speed==='fast'&&rule.billing_basis==='chatgpt_credits'&&rule.valid_until==='2026-04-02')).toBe(true);
  expect(after.amounts).toEqual(before.amounts);
  expect(db.query('SELECT * FROM codex_price_ledger_events ORDER BY id').all()).toEqual(parts);
}));
