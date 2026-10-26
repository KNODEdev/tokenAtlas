import { projectRulesFromRawRows } from "../projects/rules.fixture";
import { codexLedgerFactsPending } from "./read-freshness";
import { describe, expect, test, spyOn } from "bun:test";
import { Database } from "./sqlite";
import { createCodexLedgerSchema, readCodexLedgerPublishedBand, persistCodexLedgerBand } from "./codex-price-ledger";
import { CODEX_LEDGER_VARIANTS, readCodexLedgerSeries } from "./codex-price-ledger-read";
import { CODEX_LEDGER_SCOPE, codexLedgerReadContext, ledgerAmountFromCompatibility, readCodexLedgerCompatibilityDimRows,
  readPublishedCodexLedgerContext, sumCodexLedgerCompatibilityAmounts, readCodexLedgerCompatibilityTotals, readCodexLedgerOwnedSeries,
  codexLedgerApiTokenAmounts } from "./codex-ledger-adapters";
import { readCodexRegisterDays, readCodexMeterModels, sumCodexRegisterAmounts } from "./usage-price-read-codex";
import { codexUsagePriceReadiness, readUsagePriceAccountTotals, sumUsagePriceAmounts } from "./usage-price-read-subscription";
import { readRegisterDays } from "./usage-price-read-account";
import { decodeCounts, encodeCounts } from "./usage-price-measures";
import { buildAccountResolver } from "../server/account-resolver";
import { readCodexEventRange, normalizePublishedCodexEvent, pricePublishedCodexEvent, getPublishedCodexLedgerGroup } from "../server/codex-priced-events";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";
import type { RateCard } from "../server/pricing";
import type { DatedPeriod } from "../server/account-periods";
import { rational } from "./price-ledger-exact";
import { fillCodexLedgerFixture } from "../server/codex-ledger.fixture";

const day = "2026-09-01", range = { since: day, until: day };
const evidence = { verified_at: day, sources: ["https://example.test/pricing"], confidence: "official" as const };
function policy(): CodexLedgerPolicy {
  return { version: 1, tiers: ["standard", "fast", "ultrafast"],
    mappings: [{ id: "raw-default", raw_value: "default", tier: "standard" }, { id: "raw-priority", raw_value: "priority", tier: "fast" },
      { id: "raw-hyper", raw_value: "hyper", tier: "ultrafast" }], base_rules: [
      { id: "api", model: "model", billing_basis: "api_equivalent_usd", valid_from: "2026-01-01", multiplier: "1", ...evidence,
        rates: { in_uncached: "1", in_cache_read: "0.1", out_total: "5" } },
      { id: "credit", model: "model", billing_basis: "chatgpt_credits", valid_from: "2026-01-01", multiplier: "1", ...evidence,
        rates: { in_uncached: "100", in_cache_read: "10", out_total: "500" } },
    ], tier_rules: ["api_equivalent_usd", "chatgpt_credits"].flatMap(basis => [
      { id: `${basis}-standard`, model: "model", billing_basis: basis as "api_equivalent_usd" | "chatgpt_credits", tier: "standard",
        valid_from: "2026-01-01", multiplier: "1", ...evidence },
      { id: `${basis}-fast`, model: "model", billing_basis: basis as "api_equivalent_usd" | "chatgpt_credits", tier: "fast",
        valid_from: "2026-01-01", multiplier: basis === "api_equivalent_usd" ? "2" : "2.5", ...evidence },
      { id: `${basis}-ultra`, model: "model", billing_basis: basis as "api_equivalent_usd" | "chatgpt_credits", tier: "ultrafast",
        valid_from: "2026-01-01", multiplier: { numerator: basis === "api_equivalent_usd" ? "1" : "7", denominator: "3" }, ...evidence },
    ]) };
}
type Input = { ts?: string; home?: string; path?: string; model?: string | null; raw?: string | null; input?: number; output?: number;
  billing?: string; reset?: number; plan?: string; subject?: string | null; offset?: number };
function fixture(events: Input[], fn: (db: Database, context: ReturnType<typeof codexLedgerReadContext>, card: RateCard) => void) {
  const db = new Database(":memory:"), card: RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: {}, codex_ledger_policy: policy() };
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok ANY,cached_in ANY,
      cache_write ANY,out_tok ANY,reasoning_out ANY,usage_status TEXT,cache_write_status TEXT,service_tier TEXT,speed TEXT,
      subject TEXT,billing_mode TEXT,surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER) STRICT`);
    const insert = db.query("INSERT INTO events VALUES (?,?,?,?,?,?,0,0,?,0,'valid','missing',?,'unknown',?,?,'chat',NULL,?,?)");
    events.forEach((event, index) => insert.run(event.home ?? "/archive/codex/main", event.path ?? `${event.home ?? "/archive/codex/main"}/sessions/shared.jsonl`, event.offset ?? index * 100,
      event.model === undefined ? "model" : event.model, event.ts ?? `${day}T12:00:00.000Z`, event.input ?? 1_000_000, event.output ?? 0,
      event.raw === undefined ? "default" : event.raw, event.subject ?? null, event.billing ?? "subscription", event.plan ?? "plus", event.reset ?? 123));
    projectRulesFromRawRows(db);
    const context = codexLedgerReadContext(card);
    createCodexLedgerSchema(db);
    fillCodexLedgerFixture(db, { bands: context.policy.baseBands, rulesRevision: context.rulesRevision!, factsRevision: 0,
      policy: context.policy.policy, sourceOf: () => "codex/main" });
    fn(db, context, card);
  } finally { db.close(); }
}
const period = (from: string, until: string | null, value: string): DatedPeriod => ({ provider: "codex", subject: "codex/main",
  from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "test" });
const resolver = () => buildAccountResolver([period(day, "2026-09-02", "owner")]);

describe("published Codex compatibility adapters", () => {
  test("UTC calendar ranges retain interior aggregates and admit original offset pricing days only at their exact edges",()=>fixture([
    {ts:"2026-08-31T23:30:00-02:00",input:100},
    {ts:"2026-09-01T04:00:00+02:00",input:200},
    {ts:"2026-09-02T12:00:00Z",input:300},
    {ts:"2026-09-03T12:00:00Z",input:400},
    {ts:"2026-09-04T23:30:00-02:00",input:500},
    {ts:"2026-09-05T01:00:00+02:00",input:600},
  ],(db,context)=>{
    const owners=buildAccountResolver([period("2026-08-01","2026-10-01","owner")]);
    const bounds={since:"2026-09-01",until:"2026-09-04"};
    const before=db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    const queries=spyOn(db,"query");
    let rows:ReturnType<typeof readCodexRegisterDays>;
    try {
      rows=readCodexRegisterDays(db,CODEX_LEDGER_SCOPE,bounds,owners,context);
      expect(queries.mock.calls.some(([sql])=>sql.includes("FROM codex_price_ledger_aggregates"))).toBe(true);
    } finally {queries.mockRestore();}
    expect(rows!.reduce((sum,row)=>sum+row.calls,0)).toBe(5);
    expect(rows!.reduce((sum,row)=>sum+row.tokensReported,0)).toBe(1600);
    expect(rows!.map(row=>row.day).sort()).toEqual(["2026-08-31","2026-09-01","2026-09-02","2026-09-03","2026-09-05"]);
    expect(rows!.every(row=>row.account==="owner")).toBe(true);
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(before);
  }));
  test("token breakdown retains its original exact coefficient snapshot after equivalent declaration IDs change", () => fixture([
    { input: 1_000_000, output: 1_000_000 },
  ], (db, context) => {
    const before = db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    const group = readCodexLedgerSeries(db, context.policy, {})[0]!;
    const changed = structuredClone(context.policy.policy);
    changed.base_rules[0]!.id = "renamed-api";
    changed.base_rules[0]!.rates.in_uncached = "1.0000";
    const result = codexLedgerApiTokenAmounts(db, group, { ...context, policy: compileCodexLedgerPolicy(changed) });
    expect(result!.in_uncached).toEqual(rational(1n));
    expect(result!.out).toEqual(rational(5n));
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(before);
    const snapshot = readCodexLedgerPublishedBand(db, group.stored.api_band)!;
    expect(snapshot.id).toBe("api");
    expect(snapshot.rates.in_uncached).toBe("1");
    expect(JSON.parse(snapshot.evidence).sources).toEqual(evidence.sources);
    const changedEvidence = { ...snapshot, evidence: JSON.stringify({ ...JSON.parse(snapshot.evidence), sources: ["https://example.test/later"] }) };
    const reused = db.transaction(() => persistCodexLedgerBand(db, changedEvidence)).immediate();
    expect(reused).toBe(group.stored.api_band);
    expect(readCodexLedgerPublishedBand(db, reused)!.evidence).toBe(snapshot.evidence);
    // Cached snapshots still reject a stored header that no longer matches the published coefficient.
    db.query("UPDATE codex_price_ledger_bands SET denominator=denominator+1 WHERE id=?").run(group.stored.api_band);
    expect(() => readCodexLedgerPublishedBand(db, group.stored.api_band)).toThrow("snapshot contradicts");
  }));
  test("hourly account-boundary slices retain each original hour exactly once", () => fixture([
    { ts:`${day}T10:00:00Z` }, { ts:`${day}T12:00:00Z` }, { ts:`${day}T14:00:00Z` },
  ], (db, context) => {
    const owner = buildAccountResolver([period(day,`${day}T13:00:00Z`,"a"),period(`${day}T13:00:00Z`,null,"b")]);
    const rows = readCodexLedgerOwnedSeries(db,{since:day,until:day,grain:"hour"},owner,context);
    expect(rows.reduce((sum,row)=>sum+row.group.calls,0n)).toBe(3n);
    expect(rows.map(row=>[row.group.stored.hour,row.account,row.group.calls])).toEqual([
      [Date.parse(`${day}T10:00:00Z`)/3600000,"a",1n],
      [Date.parse(`${day}T12:00:00Z`)/3600000,"a",1n],
      [Date.parse(`${day}T14:00:00Z`)/3600000,"b",1n],
    ]);
    const daily=readCodexLedgerOwnedSeries(db,{since:day,until:day},owner,context);
    expect(daily.map(row=>[row.account,row.group.calls])).toEqual([["a",2n],["b",1n]]);
  }));
  test("all eleven variants remain exact across groups and nonterminating tier multipliers", () => fixture([
    { raw: "hyper", subject: "p:one" }, { raw: "hyper", subject: "p:two" }, { raw: "hyper", subject: "p:three" },
  ], (db, context) => {
    const result = readCodexLedgerCompatibilityTotals(db, context, range, "range");
    expect(result.status).toBe("available"); expect(result.calls).toBe("3");
    for (const variant of CODEX_LEDGER_VARIANTS) expect(result.variants![variant]).toBeDefined();
    expect(result.variants!.api_actual!.exact!.subtotal).toEqual({ numerator: "1", denominator: "1", decimal: "1" });
    const days = readCodexRegisterDays(db,CODEX_LEDGER_SCOPE,range,resolver(), context);
    expect(days.every(row => row.speed === "ultrafast")).toBe(true);
    const parts = days.map(row => row.variants.api_actual!);
    expect(parts.every(part => part.exact!.subtotal.decimal === null)).toBe(true);
    expect(sumCodexRegisterAmounts(parts).exact!.subtotal.decimal).toBe("1");
    expect(sumUsagePriceAmounts(parts).exact!.subtotal.decimal).toBe("1");
    expect(decodeCounts(encodeCounts({ api_actual: parts[0]! })).api_actual!.exact).toEqual(parts[0]!.exact);
    expect(sumCodexLedgerCompatibilityAmounts(parts).pricedSubtotal).toBe("1");
  }));

  test("a duplicate copy is resolved at build time, before account and project filters, with the canonical copy's metadata", () => fixture([
    { home: "/local/.codex", ts: `${day}T12:01:00Z`, subject: "p:wanted", offset: 0 },
    { home: "/archive/codex/main", ts: `${day}T12:01:00Z`, subject: "p:other", offset: 0 },
    { home: "/archive/codex/main", ts: `${day}T12:02:00Z`, subject: "p:other", offset: 100 },
  ], (db, context) => {
    const rows = readCodexRegisterDays(db,CODEX_LEDGER_SCOPE,range,resolver(), context);
    expect(rows.find(row => row.subject === "p:wanted")!.selected).toBe(false);
    expect(rows.filter(row => row.selected).reduce((sum, row) => sum + row.calls, 0)).toBe(2);
    const scoped = readUsagePriceAccountTotals(db, CODEX_LEDGER_SCOPE, "codex", resolver(), ["owner"], range, context);
    expect(scoped.calls).toBe("2");
  }));

  test("period boundaries split stored bases at exact instants, preserving gaps and separate pools", () => fixture([
    { ts: `${day}T12:01:00Z`, raw: "hyper" }, { ts: `${day}T12:10:00Z`, raw: "hyper" },
    { ts: `${day}T14:00:00Z`, billing: "business_credits" },
  ], (db, context) => {
    const owner = buildAccountResolver([period(day, `${day}T12:05:00Z`, "a"), period(`${day}T12:05:00Z`, `${day}T13:00:00Z`, "b")]);
    const before = db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    const days = readCodexRegisterDays(db,CODEX_LEDGER_SCOPE,range,owner, context);
    expect(days.map(row => [row.account, row.calls]).sort()).toEqual([["a", 1], ["b", 1], ["codex-unassigned::business", 1]].sort());
    const changed = readCodexRegisterDays(db,CODEX_LEDGER_SCOPE,range,resolver(), context);
    expect(changed.map(row => row.account).sort()).toEqual(["owner", "owner::business"]);
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(before);
    expect([...new Set(readCodexMeterModels(db, CODEX_LEDGER_SCOPE, range, owner, undefined, context).map(row => row.account))].sort()).toEqual(["", "a", "b"]);
    const source = readRegisterDays(db, CODEX_LEDGER_SCOPE, "codex", owner, range, context);
    expect(source.map(row => row.account).sort()).toEqual(days.map(row => row.account).sort());
  }));

  test("inclusive counter endpoint on an ownership boundary is counted once for its new owner", () => fixture([
    { ts: `${day}T12:04:59.999Z` }, { ts: `${day}T12:05:00.000Z` },
  ], (db, context) => {
    const owner = buildAccountResolver([period(day, `${day}T12:05:00Z`, "a"), period(`${day}T12:05:00Z`, "2026-09-02", "b")]);
    const rows = readCodexLedgerOwnedSeries(db, { since: day, until: day, fromMs: Date.parse(`${day}T12:00:00Z`), toMs: Date.parse(`${day}T12:05:00Z`), endInclusive: true }, owner, context);
    expect(rows.map(row => [row.account, String(row.group.calls)]).sort()).toEqual([["a", "1"], ["b", "1"]]);
  }));

  test("an unrecorded tier is priced at Standard, an unrecognized one stays unknown, a confirmed zero stays priced", () => fixture([
    { raw: null }, { raw: "unmapped" }, { input: 0, output: 0, raw: "hyper" },
  ], (db, context, card) => {
    const changes = db.query("SELECT total_changes() n").get();
    const result = readCodexLedgerCompatibilityTotals(db, context, range, "range");
    expect(result.variants!.api_standard!.pricedEvents).toBe("3");
    // An omitted tier is Standard; an explicitly unmapped tier has no actual price.
    expect(result.variants!.api_actual!.pricedEvents).toBe("2");
    expect(result.variants!.api_actual!.unpricedEvents).toBe("1");
    expect(result.variants!.api_actual!.pricedSubtotal).toBe("1");
    expect(result.variants!.api_actual!.reasons).toEqual({ unknown_speed: { events: "1", tokens: "1000000" } });
    expect(result.variants!.api_actual!.value).toBeNull();
    expect(result.quality!.unknown_speed_tokens).toBe("1000000");
    const groups = readCodexLedgerSeries(db, context.policy, { range });
    const standard = groups.find(group => group.stored.service_tier === null)!;
    expect(standard.tier).toBe("standard");
    expect(standard.quality.unknown_speed_tokens).toBe(0n);
    expect(standard.variants.normalized_usd.value).toEqual(rational(1n));
    expect(standard.variants.extra_credits.value).toEqual(rational(0n));
    expect(standard.variants.window_credits_low).toEqual(standard.variants.window_credits_high);
    const rows = readCodexRegisterDays(db, CODEX_LEDGER_SCOPE, range, resolver(), context);
    expect(rows.find(row => row.speed === "standard")!.quality.unknown_speed_tokens).toBe(0);
    expect(readCodexLedgerCompatibilityTotals(db, codexLedgerReadContext(card), range, "range")).toEqual(result);
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    const reopened = Database.deserialize(db.serialize(), { readonly: true });
    try {
      expect(readCodexLedgerCompatibilityTotals(reopened, codexLedgerReadContext(card), range, "range")).toEqual(result);
      expect(reopened.query("SELECT total_changes() n").get()).toEqual({ n: 0 });
    } finally { reopened.close(); }
  }));

  test("bounded stored event reads preserve offset instants and carry exact valuation evidence", () => fixture([
    { ts: `${day}T14:00:00+02:00`, raw: "hyper" }, { ts: `${day}T12:01:00Z` },
  ], (db, context) => {
    const legacy = { version: 1 as const, rules: [] };
    const events = readCodexEventRange(db, legacy, `${day}T12:00:00Z`, `${day}T12:00:00.001Z`, undefined, context);
    expect(events).toHaveLength(1); expect(events[0]!.speed).toBe("ultrafast");
    expect(getPublishedCodexLedgerGroup(events[0]!)!.variants.api_actual.value).toEqual(rational(1n, 3n));
    expect(normalizePublishedCodexEvent(legacy, events[0]!).credits).toBeCloseTo(700 / 3, 12);
    expect(pricePublishedCodexEvent(legacy, { ...events[0]!, speed: "standard" }, "api_equivalent_usd").amount).toBe(1);
    expect(pricePublishedCodexEvent(legacy, { ...events[0]!, speed: "fast" }, "api_equivalent_usd").amount).toBe(2);
  }));

  test("published policy is reused without historical source reads, legacy tables or writes", () => fixture([{ raw: "hyper" }], (db, context) => {
    const changes = (db.query("SELECT total_changes() n").get() as { n: number }).n;
    const query = db.query.bind(db);
    const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
      if (/\b(?:FROM|JOIN)\s+(?:original\.)?events\b|event_valuations|usage_price_(?:days|contributions)/i.test(sql)) throw new Error("Historical pricing read forbidden");
      return query(sql);
    }) as typeof db.query);
    try {
      // No caller context: the ledger's own published policy prices the read.
      expect(readCodexLedgerCompatibilityTotals(db, undefined, range, "range").calls).toBe("1");
      expect(readCodexLedgerCompatibilityDimRows(db, readPublishedCodexLedgerContext(db), range, "range")).toHaveLength(1);
      expect(codexUsagePriceReadiness(db, { rulesRevision: context.rulesRevision }).state).toBe("ready");
      expect((db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(changes);
    } finally { spy.mockRestore(); }
  }));

  test("a missing ledger and price work are pending; newer facts leave the published ledger ready", () => {
    const absent = new Database(":memory:");
    try { expect(codexUsagePriceReadiness(absent, {}).state).toBe("pending");
      expect(readCodexLedgerCompatibilityTotals(absent, undefined).status).toBe("unavailable"); }
    finally { absent.close(); }
    fixture([{}], (db, context) => {
      expect(codexUsagePriceReadiness(db, { rulesRevision: "different" }).reason).toBe("usage-price-rules-pending");
      // Facts newer than the published ledger, and copies queued for it, leave its committed sums readable (§9).
      db.exec("CREATE TABLE vendor_sync_revisions(vendor TEXT,data_revision INTEGER); INSERT INTO vendor_sync_revisions VALUES('codex',1)");
      expect(codexUsagePriceReadiness(db, {}).state).toBe("ready");
      expect(codexLedgerFactsPending(db)).toBe(true);
      db.exec("UPDATE vendor_sync_revisions SET data_revision=0; INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','copy','[\"home\",\"file\"]')");
      expect(codexUsagePriceReadiness(db, { rulesRevision: context.rulesRevision }).state).toBe("ready");
      expect(codexLedgerFactsPending(db)).toBe(true);
      db.exec("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','{\"model\":\"other\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-01-01\",\"untilDay\":null,\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}')");
      expect(codexUsagePriceReadiness(db, { rulesRevision: context.rulesRevision }).reason).toBe("usage-price-rules-pending");
    });
  });
});
