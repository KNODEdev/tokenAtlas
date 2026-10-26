import {expect,test} from "bun:test";
import {Database} from "../db/sqlite";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {applyDrizzleMigrations} from "../db/migrate";
import {CODEX_CANONICAL_COPY_POLICY as CODEX_MIRROR_POLICY_VERSION} from "../db/codex-ledger-canonical";
import {buildEraIndex,type EraDeclaration} from "./eras";
import {captureRebuildAccountTotals} from "./rebuild-account-totals";
import {captureAccountPrices} from "./rebuild-account-prices";
import {installAnalysisTracking} from "../db/analysis";
import {currentSubscriptionHomes} from "./capacity-equivalents";
import {prepareCodexLedgerFixture} from "./codex-ledger.fixture";
import {CODEX_LEDGER_SCOPE} from "../db/codex-ledger-adapters";
import type {RateCard} from "./pricing";
import {ARCHIVE_LOGICAL_ROOT} from "../config/paths";
import {join} from "node:path";


const codexRates: RateCard = {
  version: 1, currency: "USD", unit: "per 1M", vendors: {},
  codex_accounting: {
    version: 1, rules: [{
      id: "fixture", model: "fixture", speed: "standard", billing_basis: "api_equivalent_usd",
      valid_from: "2026-01-01", verified_at: "2026-01-01", sources: ["https://example.test/rate"],
      confidence: "user", multiplier: 1, rates: { in_uncached: 1, in_cache_read: 1, in_cache_write: 1, out_total: 1 },
    }],
  },
};

function codexFixture() {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE events(home TEXT NOT NULL,path TEXT NOT NULL,source_offset INTEGER NOT NULL,ts TEXT NOT NULL,
      model TEXT,speed TEXT,in_tok INTEGER NOT NULL,cached_in INTEGER NOT NULL,cache_write INTEGER NOT NULL,
      out_tok INTEGER NOT NULL,cache_write_status TEXT,usage_status TEXT,billing_mode TEXT,
      PRIMARY KEY(home,path,source_offset))`);
  installAnalysisTracking(db);
  const subscriptions: EraDeclaration[] = [{ id: "a", vendor: "codex" }];
  const sources = [{ vendor: "codex", home: join(ARCHIVE_LOGICAL_ROOT,"codex/pc"), source_home: "live" }];
  db.exec("INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence) VALUES('codex','codex/pc','2020-01-01','a','declared','test')");
  const eras = buildEraIndex(subscriptions);
  const context = { subscriptions, sources, eras, rateCards: codexRates, sourceHomes: ["live"] };
  db.exec(`INSERT INTO events(home,path,source_offset,ts,model,speed,in_tok,cached_in,cache_write,out_tok,cache_write_status,usage_status,billing_mode) VALUES
      ('live','live/sessions/one.jsonl',1,'2026-01-01T10:00:00Z','fixture','standard',1000,200,300,400,'known','complete',NULL),
      ('live','live/sessions/one.jsonl',2,'2026-01-02T10:00:00Z','fixture','standard',2000,0,0,500,'known','complete','business_credits')`);
  
  return { db, context };
}

/** Publishes the Codex price ledger for the fixture's declared source, as its producer would. */
function finishCodexRegister(db: Database, context: { sources: Array<{vendor:string;home:string;source_home:string}> }) {
  prepareCodexLedgerFixture(db, codexRates, currentSubscriptionHomes(context.sources.map(source => ({ id: "a", ...source }))));
}

test("Codex account token buckets use the shared register, base plus business", () => {
  const { db, context } = codexFixture();
  try {
    const accounts = [{ vendor: "codex" as const, account: "a" }];
    const projection = captureRebuildAccountTotals(db, accounts, null, context)[0]!;
    expect(projection.reason).toBe("usage-price-preparation-required");
    finishCodexRegister(db, context);
    const register = captureRebuildAccountTotals(db, accounts, null, context)[0]!;
    expect(register.provenance?.source).toBe("codex_price_ledger_aggregates");
    expect(register.status).toBe("available");
    expect(register.buckets).toMatchObject({in_uncached:"2500",in_cache_read:"200",out_total:"900"});
    // The business funding identity is reconstructed from the billing mode dimension.
    expect(register.buckets!.in_uncached).toBe("2500");
    expect(register.calls).toBe("2");
    // A day range cuts both sources the same way.
    const range = { from: "2026-01-01", until: "2026-01-01" };
    expect(captureRebuildAccountTotals(db, accounts, range, context)[0]!.buckets!.in_uncached).toBe("500");
    // Restart does not recompute: a second capture writes nothing and reads no events.
    db.exec("PRAGMA query_only=ON");
    const repeated = captureRebuildAccountTotals(db, accounts, null, context)[0]!;
    expect(repeated.buckets).toEqual(register.buckets);
  } finally { db.close(true); }
});

test("a register that is prepared but not current stops the token boundary explicitly", () => {
  const { db, context } = codexFixture();
  try {
    const accounts = [{ vendor: "codex" as const, account: "a" }];
    finishCodexRegister(db, context);
    expect(captureRebuildAccountTotals(db, accounts, null, context)[0]!.status).toBe("available");
    db.exec("UPDATE usage_ledger_state SET status='pending' WHERE provider='codex'");
    const stopped = captureRebuildAccountTotals(db, accounts, null, context)[0]!;
    expect(stopped.status).toBe("unavailable");
    expect(stopped.reason).toBe("usage-price-preparation-required");
    expect(stopped.buckets).toBeNull();
  } finally { db.close(true); }
});

test("Codex account prices read the register once it is prepared", () => {
  const { db, context } = codexFixture();
  try {
    const accounts = [{ vendor: "codex" as const, account: "a" }];
    finishCodexRegister(db, context);
    const boundary = captureAccountPrices(db, accounts, null, "2026-01-03T00:00:00.000Z", context);
    const row = boundary.accounts[0]!;
    expect(row.status).toBe("available");
    expect(row.totals?.scope).toBe(CODEX_LEDGER_SCOPE);
    // Codex identity quality stays unknown, so a rebuild delta still refuses an exact number.
    expect(row.totals?.quality).toEqual({ complete: false, invalidIdentityDays: null,
      conflictedIdentityDays: null, duplicateCopies: null });
    expect(row.totals?.standard?.value).toBe("0.0039");
  } finally { db.close(true); }
});

test("account boundaries sum stored token totals exactly beyond the JS integer limit and refuse an inexact day",()=>{
  const {db,context}=codexFixture();
  try {
    finishCodexRegister(db,context);
    const capture=()=>captureRebuildAccountTotals(db,[{vendor:"codex",account:"a"}],null,context)[0]!;
    // The first day's stored event and aggregates at the largest exact JS integer.
    const store=(uncached:string)=>db.exec(`UPDATE codex_price_ledger_events SET uncached=${uncached} WHERE day='2026-01-01';
      UPDATE codex_price_ledger_aggregates SET uncached=${uncached} WHERE day='2026-01-01'`);
    store("9007199254740991");
    expect(capture().calls).toBe("2");
    expect(capture().buckets!.in_uncached).toBe("9007199254742991");
    // A day the ledger cannot represent exactly is refused instead of rounded.
    store("9007199254740993");
    expect(capture).toThrow("compatibility integer domain");
  } finally {db.close();}
});

test("missing price configuration, invalid range and ambiguous OpenCode provider remain explicit",()=>{
  const {db,context}=codexFixture();
  try {
    const accounts=[{vendor:"codex" as const,account:"a"}];
    expect(captureRebuildAccountTotals(db,accounts,null,{...context,rateCards:undefined})[0]!.reason).toBe("price-configuration-not-provided");
    expect(()=>captureRebuildAccountTotals(db,accounts,{from:"invalid",until:"2026-01-01"},context)).toThrow();
    const selected=[{vendor:"opencode" as const,account:"glm-account"}];
    expect(captureRebuildAccountTotals(db,selected,null,context)[0]!.reason).toBe("account-provider-unavailable");
    const declared={...context,subscriptions:[{id:"glm-account",vendor:"glm"}]};
    expect(captureRebuildAccountTotals(db,selected,null,declared)[0]).toMatchObject({provider:"glm",reason:"usage-price-register-absent"});
    expect(captureRebuildAccountTotals(db,selected,null,{...declared,subscriptions:[...declared.subscriptions,{id:"glm-account",vendor:"claude"}]})[0]!.reason).toBe("account-provider-ambiguous");
  } finally {db.close();}
});
