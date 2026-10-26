import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { fillCodexLedgerFixture } from "./codex-ledger.fixture";
import { advanceCodexContextPrices } from "./codex-context-producer";
import { loadAccountResolver } from "./account-resolver";
import type { RateCard } from "./pricing";
import type { AppContext } from "./app-context-types";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { subscriptionAccountingAdapters } from "./subscription-accounting-adapters";
import { fillUsageLedger } from "./usage-ledger.fixture";

const proof = { verified_at: "2026-01-01", sources: ["https://example.test/prices"], confidence: "official" as const };
export function contextPreviewFixture(included = false, configure?: (rates: RateCard) => void, events?: (db: Database) => void) {
  const db = new Database(":memory:"); applyDrizzleMigrations(drizzle(db));
  const rates: RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: {},
    subscriptions: { owner: { usd_per_month: 30 }, before: { usd_per_month: 10 } },
    codex_ledger_policy: { version: 1, long_context_premium: included, tiers: ["standard", "fast"],
      mappings: [{ id: "standard", raw_value: "default", tier: "standard" }, { id: "fast", raw_value: "priority", tier: "fast" }],
      tier_rules: (["api_equivalent_usd", "chatgpt_credits"] as const).map(billing_basis => ({ id: billing_basis, model: "m", billing_basis,
        tier: "fast", valid_from: "2026-01-01", multiplier: billing_basis === "api_equivalent_usd" ? "3" : "2", ...proof })),
      base_rules: ["m", "api-only"].flatMap(model => (["api_equivalent_usd", ...(model === "m" ? ["chatgpt_credits" as const] : [])] as const)
        .map(billing_basis => ({ id: `${model}-${billing_basis}`, model, billing_basis, valid_from: "2026-01-01", multiplier: "1", ...proof,
          rates: { in_uncached: "1", in_cache_read: "0.1", ...(billing_basis === "api_equivalent_usd" ? { in_cache_write: "1.25" } : {}), out_total: "5" },
          ...(billing_basis === "api_equivalent_usd" ? { long_context: { above_input_tokens: 1000,
            rates: { in_uncached: "2", in_cache_read: "0.2", in_cache_write: "2.5", out_total: "7.5" } } } : {}) }))) } };
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,
    service_tier TEXT,usage_status TEXT,cache_write_status TEXT,project_id TEXT,project TEXT,repo TEXT,surface TEXT,cwd TEXT);
    INSERT INTO events VALUES
    (1,'/archive/codex/main','session',100,'2026-09-01T11:00:00.000Z','m',1000000,0,0,0,0,'default','valid','reported','a','a','repo-a','cli',NULL),
    (2,'/archive/codex/main','session',200,'2026-09-01T12:00:00.000Z','m',2000000,1000000,200000,100000,0,'default','valid','reported','a','a','repo-a','cli',NULL),
    (3,'/archive/codex/main','session',300,'2026-09-01T12:30:00.000Z','m',1000000,0,0,0,0,'priority','valid','reported','b','b','repo-b','cli',NULL),
    (4,'/archive/codex/main','session',400,'2026-09-01T13:00:00.000Z','m',1000000,0,0,0,0,NULL,'valid','reported','b','b','repo-b','cli',NULL),
    (5,'/archive/codex/main','session',500,'2026-09-01T13:30:00.000Z','api-only',1000000,0,0,0,0,'default','valid','reported','a','a','repo-a','cli',NULL),
    (6,'/archive/codex/main','session',600,'2026-09-01T14:00:00.000Z','missing',1000000,0,0,0,0,'default','valid','reported',NULL,NULL,NULL,'cli',NULL),
    (7,'/archive/codex/main','session',700,'2026-09-01T15:00:00.000Z','m',0,0,0,1000000,0,'default','valid','reported','b','b','repo-b','cli',NULL);`);
  const periods = [{ provider: "codex", subject: "codex/main", value: "before", from: "2026-01-01T00:00:00Z", until: "2026-09-01T12:00:00.000Z" },
    { provider: "codex", subject: "codex/main", value: "owner", from: "2026-09-01T12:00:00.000Z", until: null }]
    .map(period => ({ ...period, origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }));
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, periods);
  const home = `${ARCHIVE_LOGICAL_ROOT}/codex/main`;
  db.query("UPDATE events SET home=?").run(home);
  events?.(db);
  configure?.(rates);
  const ledger = codexLedgerReadContext(rates);
  fillCodexLedgerFixture(db, { bands: ledger.policy.baseBands, rulesRevision: ledger.rulesRevision!, factsRevision: 0,
    policy: ledger.policy.policy, sourceOf: () => "codex/main" });
  for (const adapter of subscriptionAccountingAdapters()) fillUsageLedger(db, adapter.id, rates, ARCHIVE_LOGICAL_ROOT);
  const sources = [{ vendor: "codex", home }];
  const subscriptions = ["before", "owner"].map(id => ({ id, vendor: "codex" }));
  const ctx = { sqlite: db, rateCards: rates, homeToSubId: new Map([[home, "owner"]]), subIdToHomes: new Map([["owner", [home]], ["before", [home]]]),
    resolver: loadAccountResolver(db, subscriptions), accounts: { version: 2, sources, subscriptions }, rootDir: process.cwd(),
    plans: {}, plansCatalog: { provider_groups: [] } } as unknown as AppContext;
  const fill = () => { for (let i = 0; i < 1000; i++) if (!advanceCodexContextPrices(db, { limit: 2 })!.pending) return; throw new Error("Context fixture did not finish"); };
  return { db, ctx, rates, fill, range: { since: "2026-09-01", until: "2026-09-01" } };
}
