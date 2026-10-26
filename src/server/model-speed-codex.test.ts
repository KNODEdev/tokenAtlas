import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { createCodexLedgerSchema } from "../db/codex-price-ledger";
import { enqueueCodexLedgerRuleChanges } from "../db/codex-ledger-producer";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { ensureUsageLedgerSchema, TIMED_SUMS, type TimedSums } from "../db/usage-ledger";
import type { CodexLedgerPolicy } from "./codex-ledger-policy";
import type { RateCard } from "./pricing";
import { apiCodexLedgerRows } from "./api-codex-ledger";
import { buildAccountResolver } from "./account-resolver";
import { fillCodexLedgerFixture } from "./codex-ledger.fixture";
import { modelSpeedSeries } from "./model-speed";
import { readCodexOwnedTimedHours } from "./ledger-sums";

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
const BOUNDARY = "2026-04-01T10:30:00.000Z";
const period = (value: string, from: string, until: string | null) => ({ provider: "codex", subject: "codex/main", from, until, value,
  origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });

/**
 * One archive source stored as `Codex/Main` (the periods name it `codex/main`), signed in to "main" until 10:30 and to
 * "later" from then on. Projects make several dimensions on both sides of the boundary; 12:00 is an hour nothing cuts.
 */
function fixture(run: (db: Database, card: RateCard, resolver: ReturnType<typeof buildAccountResolver>) => void) {
  const db = new Database(":memory:");
  const card: RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: {}, codex_ledger_policy: policy() };
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,speed TEXT,service_tier TEXT,
      in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,project_id TEXT,resp_ms INTEGER);
      INSERT INTO events VALUES
        ('/archive','/archive/a.jsonl',1,'2026-04-01T10:15:00Z','model','standard','default',100,0,0,300,'a',1000),
        ('/archive','/archive/a.jsonl',2,'2026-04-01T10:20:00Z','model','standard','default',100,0,0,10,'b',500),
        ('/archive','/archive/a.jsonl',3,'2026-04-01T10:40:00Z','model','standard','default',100,0,0,20,'a',2000),
        ('/archive','/archive/a.jsonl',4,'2026-04-01T10:45:00Z','model','standard','default',100,0,0,400,'c',4000),
        ('/archive','/archive/a.jsonl',5,'2026-04-01T12:00:00Z','model','standard','default',100,0,0,30,'a',3000);`);
    createCodexLedgerSchema(db);
    ensureUsageLedgerSchema(db);
    const context = codexLedgerReadContext(card);
    fillCodexLedgerFixture(db, { bands: context.policy.baseBands, policy: context.policy.policy,
      rulesRevision: context.rulesRevision!, factsRevision: 0, sourceOf: () => "Codex/Main" });
    enqueueCodexLedgerRuleChanges(db, { bands: context.policy.baseBands, rulesRevision: context.rulesRevision!, policy: context.policy.policy });
    db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind IN ('copy','blocked','rules')");
    run(db, card, buildAccountResolver([period("main", "2026-01-01", BOUNDARY), period("later", BOUNDARY, null)]));
  } finally { db.close(); }
}
/** The reader Speed used before: the valued owned series, kept to one account. */
function pricedReader(db: Database, card: RateCard, resolver: ReturnType<typeof buildAccountResolver>, account: string) {
  return apiCodexLedgerRows({ sqlite: db, rateCards: card, homeToSubId: new Map() }, { grain: "hour" }, undefined, resolver)
    .filter(row => row.account?.toLowerCase() === account && row.group.stored.hour != null)
    .map(row => ({ hour: Number(row.group.stored.hour), model: row.model, calls: row.calls,
      ...Object.fromEntries(TIMED_SUMS.map(column => [column, Number(row.group.stored[column])])) as TimedSums }));
}

test("Codex speed owns calls per dimension and splits at a boundary of a source spelled differently, as the valued reader does", () => fixture((db, card, resolver) => {
  expect((db.query("SELECT DISTINCT source FROM codex_price_ledger_dims").all() as Array<{ source: string }>).map(row => row.source)).toEqual(["Codex/Main"]);
  for (const account of ["main", "later"]) for (const grain of ["hour", "day"] as const)
    expect(modelSpeedSeries(readCodexOwnedTimedHours(db, resolver, account), grain)).toEqual(modelSpeedSeries(pricedReader(db, card, resolver, account), grain));
  const total = (account: string) => modelSpeedSeries(readCodexOwnedTimedHours(db, resolver, account), "day")[0]!.total;
  // 10:15 and 10:20 are main's; 10:40, 10:45 and 12:00 belong to later, whatever project shares their dimension.
  expect(total("main")).toMatchObject({ calls: 2, timed_calls: 2, timed_out: 310, timed_ms: 1500, long_calls: 1 });
  expect(total("later")).toMatchObject({ calls: 3, timed_calls: 3, timed_out: 450, timed_ms: 9000, long_calls: 1 });
}));

test("pending credit-price work does not block Codex speed, in hours a boundary splits or not", () => fixture((db, card, resolver) => {
  const next = structuredClone(card), credit = next.codex_ledger_policy!.base_rules.find(rule => rule.billing_basis === "chatgpt_credits")!;
  credit.rates.in_uncached = "3";
  const current = codexLedgerReadContext(next);
  enqueueCodexLedgerRuleChanges(db, { bands: current.policy.baseBands, rulesRevision: current.rulesRevision!, policy: current.policy.policy });
  const apiOnly = { dependencyBases: ["api_equivalent_usd"] as const };
  expect(readCodexOwnedTimedHours(db, resolver, "main", apiOnly).map(row => row.calls)).toEqual([1, 1]);
  expect(readCodexOwnedTimedHours(db, resolver, "later", apiOnly).reduce((sum, row) => sum + row.calls, 0)).toBe(3);
  // Without the restriction the split hour's slices wait for the credit work: the test reaches that read.
  expect(() => readCodexOwnedTimedHours(db, resolver, "main")).toThrow("pending price dependencies");
}));
