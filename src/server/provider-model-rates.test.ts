import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { installAnalysisTracking } from "../db/analysis";
import { applyDrizzleMigrations } from "../db/migrate";
import { usageLedgerEvents } from "../db/usage-ledger-events";
import { getVendorRate, type RateCard } from "./pricing";
import { priceSubscriptionEvent, subscriptionAccountingAdapter, type SubscriptionEvent } from "./subscription-accounting-adapters";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { stepUsageLedger, usageLedgerState } from "./usage-ledger-producer";

const rates: RateCard = { version: 1, currency: "USD", unit: "per 1M", vendors: { zai: { models: {
  glm: { in_uncached: 99, in_cache_read: 99, out_total: 99 },
  "glm-5.3": { in_uncached: 2, in_cache_read: 1, out_total: 3, until: "2026-09-01",
    after: { in_uncached: 4, in_cache_read: 2, out_total: 6 } },
  "glm-5.3-explicit": { in_uncached: null, in_cache_read: 1, out_total: 3 },
} }, anthropic: { models: { claude: { in_uncached: 1, in_cache_read: 0, in_cache_write_5m: 0, in_cache_write_1h: 0, out_total: 1 } } } } };
function event(model = "glm-5.3-medium-control", day = "2026-09-01"): SubscriptionEvent {
  return { source:"glm/profile",account_key:null,eligible:true,vendor:"zai",account: "glm", home: "profile", identity: "message", ts: `${day}T12:00:00.000Z`, model,
    speed: "standard", precise_time: true, usage_valid: true,
    quantities: { in_uncached: 1_000_000, in_cache_read: 200_000, in_cache_write_5m: 0,
      in_cache_write_1h: 0, in_cache_write_unknown: 0, out_total: 100_000, out_thinking: 0 } };
}

test("configured provider families retain longest matching model and dated rates", () => {
  const adapter = subscriptionAccountingAdapter("glm");
  expect(getVendorRate(rates, "zai", event().model)?.in_uncached).toBe(2);
  expect(priceSubscriptionEvent(rates, adapter, event()).amount).toBe(2.5);
  expect(priceSubscriptionEvent(rates, adapter, event(undefined, "2026-09-02")).amount).toBe(5);
  expect(priceSubscriptionEvent(rates, adapter, event(), true, "2026-09-02").amount).toBe(5);
});

test("family lookup preserves missing bucket rates, exact unknown rates and Claude's existing lookup", () => {
  const adapter = subscriptionAccountingAdapter("glm"), missing = event();
  missing.quantities.in_cache_write_unknown = 1;
  const result = priceSubscriptionEvent(rates, adapter, missing);
  expect(result.amount).toBeNull();
  expect(result.costs.in_cache_write_unknown).toBeNull();
  expect(result.subtotal).toBe(2.5);
  expect(priceSubscriptionEvent(rates, adapter, event("glm-5.3-explicit")).amount).toBeNull();
  expect(priceSubscriptionEvent(rates, subscriptionAccountingAdapter("claude"), event("claude-new-unknown")).amount).toBeNull();
});

test("ledger valuations keep the selected dated rates and a changed rate revalues only the events it prices", () => {
  const db = new Database(":memory:");
  try {
    applyDrizzleMigrations(drizzle(db));
    installAnalysisTracking(db);
    const insert = db.prepare(`INSERT INTO oc_events(id,store,message_id,session_id,ts,model,provider,in_tok,out_tok,reasoning,cache_read,cache_write,cost)
      VALUES(?,'profile',?,'s',?,'glm-5.3-medium-control','zai-coding-plan',1000000,100000,0,200000,0,0)`);
    insert.run(1, "before", "2026-09-01T12:00:00.000Z");
    insert.run(2, "after", "2026-09-02T12:00:00.000Z");
    const amounts = (card: RateCard) => usageLedgerEvents(db, "glm", card)
      .load("2026-09-01T00:00:00.000Z", "2026-09-03T00:00:00.000Z").map(event => event.prices.actual?.amount);
    const valuations = () => db.query(`SELECT row_id,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto,glb_usd,glb_nano,glb_femto
      FROM usage_ledger_facts WHERE provider='glm' ORDER BY row_id`).all() as Array<Record<string, number>>;
    fillUsageLedger(db, "glm", rates, ARCHIVE_LOGICAL_ROOT);
    expect(amounts(rates)).toEqual([2.5, 5]);
    const before = valuations(), revision = usageLedgerState(db, "glm")!.revision;
    // An unchanged card is no work.
    expect(stepUsageLedger(db, "glm", rates, ARCHIVE_LOGICAL_ROOT)).toEqual({ complete: true, processed: 0 });
    expect(valuations()).toEqual(before);
    expect(usageLedgerState(db, "glm")!.revision).toBe(revision);
    const next = structuredClone(rates);
    next.vendors.zai!.models!["glm-5.3"]!.after!.in_uncached = 5;
    fillUsageLedger(db, "glm", next, ARCHIVE_LOGICAL_ROOT);
    expect(amounts(next)).toEqual([2.5, 6]);
    const changed = valuations();
    // The event priced by the earlier dated rate keeps its stored valuation.
    expect(changed[0]).toEqual(before[0]!);
    expect(changed[1]).not.toEqual(before[1]!);
  } finally { db.close(); }
});

test("an event that records no tokens costs zero even when its model has no card", () => {
  const adapter = subscriptionAccountingAdapter("claude");
  const empty = event("<synthetic>");
  for (const key of Object.keys(empty.quantities) as Array<keyof typeof empty.quantities>) empty.quantities[key] = 0;
  const result = priceSubscriptionEvent(rates, adapter, empty);
  expect(result.amount).toBe(0);
  expect(result.reason).toBeNull();
  // The absent card is still visible; the zero is a fact about the event, not about the rates.
  expect(result.rates.in_uncached).toBeNull();
  expect(result.note).toContain("no tokens");
  // A single nonzero bucket on the same unknown model is still refused.
  const oneToken = event("<synthetic>");
  for (const key of Object.keys(oneToken.quantities) as Array<keyof typeof oneToken.quantities>) oneToken.quantities[key] = 0;
  oneToken.quantities.out_total = 1;
  expect(priceSubscriptionEvent(rates, adapter, oneToken).amount).toBeNull();
  expect(priceSubscriptionEvent(rates, adapter, oneToken).reason).toBe("missing_rate");
  // Conflicting source counters still refuse, tokens or not.
  const invalid = { ...empty, usage_valid: false };
  expect(priceSubscriptionEvent(rates, adapter, invalid).amount).toBeNull();
  expect(priceSubscriptionEvent(rates, adapter, invalid).reason).toBe("invalid_cache_totals");
});
