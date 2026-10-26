import { storeWindowAnswers } from "../db/window-answers";
import { loadAccountResolver } from "./account-resolver";
import { expect, spyOn, test } from "bun:test";
import { installAnalysisTracking } from "../db/analysis";
import { buildSubscriptionAccountingReport } from "./subscription-accounting";
import type { SubscriptionAccountingReport } from "../shared/subscription-accounting";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import type { Database } from "../db/sqlite";
import { usageLedgerState } from "./usage-ledger-producer";
import { usageLedgerEvents } from "../db/usage-ledger-events";
import { ACCOUNTS, createClaudeCodeAcceptanceFixture, TIMES } from "./claude-code-capacity.fixture";
import { advanceAllUsagePrices } from "./subscription-preparation";
import { advanceCodexLedger, USAGE_PRICE_WRITER_BUSY } from "./codex-ledger-preparation";
import type { DataWork } from "./data-worker";
import type { DataEnvelope } from "./data-views";
import type { ClaudeLimitReport } from "./claude-limit";
import { createDataReadWorker } from "./data-read";
import { createFetchHandler, type AppContext } from "./api";
import { buildEraIndex } from "./eras";
import { readUsagePriceAccountTotals, subscriptionUsagePriceReadiness } from "../db/usage-price-read-subscription";
import { CODEX_LEDGER_VERSION } from "../db/codex-ledger-state";
import { codexLedgerSettings } from "./codex-ledger-settings";

/** Discards a provider's usage ledger, as a fresh database or a journal discard leaves it. */
const discardLedger = (db: Database, provider: string) => {
  for (const table of ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_day_reasons", "usage_ledger_dirty",
    "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_state"]) db.query(`DELETE FROM ${table} WHERE provider=?`).run(provider);
};
/** The background writer's usage-price job over a fixture whose Codex source is empty. */
const backgroundPrices = (db: Database, rates: Parameters<typeof advanceAllUsagePrices>[1]) => {
  db.exec("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT)");
  // The new source table joins the report dependency tracking, as a migration would register it.
  installAnalysisTracking(db);
  return advanceAllUsagePrices(db, rates, [], [], { turnMs: 60_000 });
};
/** One reply of the real report worker. */
const workerReply = (worker: Worker, work: DataWork) => new Promise<{ report?: unknown; error?: string; pending?: boolean }>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Report worker timed out")), 15000);
  worker.onerror = error => { clearTimeout(timer); reject(new Error(error.message)); };
  worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
  worker.postMessage(work);
});

test("a report over a published ledger answers from it while newer facts are processed; a first build answers preparing", async () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  const ctx = ({sqlite:fixture.db,dbPath:fixture.dbPath,rateCards:fixture.rates,
    accounts: { version: 2, subscriptions: [], sources: [] },homeToSubId:new Map(),subIdToHomes:new Map(),eras:buildEraIndex([]),eraErrors:[],
    plans:{},plansCatalog:{provider_groups:[]},cycles:{},claudeGauge:{},grokGauge:{},rootDir:fixture.directory} as unknown as AppContext);
  const url = "http://local/api/subscription-accounting?provider=claude&account=" + ACCOUNTS.a + "&since=2026-09-13&until=2026-09-17";
  // A window screen (window-screens.ts): computed off the HTTP thread, then read from its answer.
  const fetch = createFetchHandler(ctx);
  const read = () => fetch(new Request(url));
  const publish = () => storeWindowAnswers(ctx.sqlite, ctx.analysisReader!.takeAnswersToStore());
  const settled = async () => { await read(); await ctx.analysisReader!.whenIdle(); publish(); return read(); };
  const clock = spyOn(Date, "now");
  try {
    discardLedger(fixture.db, "claude");
    expect((await read()).status).toBe(202);
    await ctx.analysisReader!.whenIdle();
    // The read wrote nothing: the ledger stays absent until the background writer runs.
    expect(usageLedgerState(fixture.db, "claude")).toBeNull();
    expect((await read()).status).toBe(202);
    await ctx.analysisReader!.whenIdle();
    backgroundPrices(fixture.db, fixture.rates);
    const initial = await settled();
    expect(initial.status).toBe(200);
    expect(initial.headers.get("X-Analysis")).toBe("stored");
    expect(initial.headers.get("X-Data-Version")).toBeString();
    const original = await initial.json();
    fixture.db.query("UPDATE claude_events SET in_uncached=in_uncached+800,out_total=out_total+200 WHERE call_id='at-asof'").run();
    // The published ledger stays readable: the report answers from it until the background writer catches up (golden rules §9).
    const during = await read();
    expect(during.status).toBe(200);
    expect((await during.json()).tokens).toBe(original.tokens);
    backgroundPrices(fixture.db, fixture.rates);
    // The republished days make the answer stale: it stays on screen while the current one is computed.
    clock.mockReturnValue(Date.now() + 60_000);
    const stale = await read();
    expect(stale.status).toBe(200);
    expect(stale.headers.get("X-Analysis")).toBe("stale");
    expect((await stale.json()).tokens).toBe(original.tokens);
    await ctx.analysisReader!.whenIdle();
    expect((await read()).headers.get("X-Analysis")).toBe("stale");
    publish();
    const fresh = await read();
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("X-Analysis")).toBe("stored");
    expect((await fresh.json()).tokens).toBe(original.tokens + 1000);
    ctx.sqlite = fixture.reopen();
    const corrected = await read();
    expect(corrected.status).toBe(200);
    expect((await corrected.json()).tokens).toBe(original.tokens + 1000);
  } finally { clock.mockRestore(); await ctx.analysisReader?.close(); await Bun.sleep(0); fixture.teardown(); }
},30000);

test("a report never values history: a discarded ledger raises preparing and writes nothing", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    discardLedger(fixture.db, "claude");
    expect(() => buildSubscriptionAccountingReport({sqlite: fixture.db, rateCards: fixture.rates, plans: {},
      plansCatalog: {provider_groups: []}, manualCapacity: []}, "claude",
      {since: "2026-09-13", until: "2026-09-17", account: ACCOUNTS.a})).toThrow(SubscriptionFactsPending);
    expect(fixture.db.query("SELECT COUNT(*) n FROM usage_ledger_state WHERE provider='claude'").get()).toEqual({n: 0});
  } finally { fixture.teardown(); }
});

test("a late correction reaches the ledger's events after one background pass", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    const build = () => usageLedgerEvents(db, "claude", fixture.rates, loadAccountResolver(db).plan("claude", ACCOUNTS.a))
      .load(TIMES.start, TIMES.reset).reduce((sum, event) => sum + event.quantities.in_uncached + event.quantities.out_total, 0);
    const initial = build();
    db.query("UPDATE claude_events SET in_uncached=in_uncached+800,out_total=out_total+200 WHERE call_id='at-asof'").run();
    // Until the pass, the published ledger answers as it stands (golden rules §9).
    expect(build()).toBe(initial);
    backgroundPrices(db, fixture.rates);
    expect(build()).toBe(initial + 1000);
  } finally { fixture.teardown(); }
});

test("a report reads the ownership the background writer published with the ledger", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  const range = {since:"2026-09-13",until:"2026-09-17"};
  const replacement = "account-after-preparation";
  try {
    const before = buildSubscriptionAccountingReport({sqlite:fixture.db,rateCards:fixture.rates,
      plans:{},plansCatalog:{provider_groups:[]},manualCapacity:[]},"claude",{...range,account:ACCOUNTS.a});
    expect(before.tokens).toBeGreaterThan(0);
    discardLedger(fixture.db, "claude");
    // The background writer's ledger pass also moves the account's period to another account.
    fixture.db.exec(`CREATE TRIGGER fixture_period_change_during_preparation
      AFTER INSERT ON usage_ledger_state
      WHEN NEW.provider='claude' AND NOT EXISTS(SELECT 1 FROM meta WHERE key='fixture_period_change_fired')
      BEGIN
        UPDATE account_periods SET account='${replacement}' WHERE provider='claude' AND account='${ACCOUNTS.a}';
        INSERT INTO meta(key,value) VALUES('account_periods_revision','1')
          ON CONFLICT(key) DO UPDATE SET value=CAST(COALESCE(value,'0') AS INTEGER)+1;
        INSERT INTO meta(key,value) VALUES('fixture_period_change_fired','1');
      END`);
    backgroundPrices(fixture.db, fixture.rates);
    expect(fixture.db.query("SELECT value FROM meta WHERE key='fixture_period_change_fired'").get()).toEqual({value:"1"});
    const result = buildSubscriptionAccountingReport({sqlite:fixture.db,rateCards:fixture.rates,
      plans:{},plansCatalog:{provider_groups:[]},manualCapacity:[]},"claude",{...range,account:replacement});
    expect(result.scope.account).toBe(replacement);
    expect(result.tokens).toBe(before.tokens);
    expect(result.events).toBe(before.events);
    expect(result.breakdown.every(row=>row.account===replacement)).toBe(true);
  } finally { fixture.teardown(); }
},30000);

test("the read-only view worker returns the common limit result from stored window sums and writes nothing", async () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  const worker = createDataReadWorker();
  try {
    discardLedger(fixture.db, "claude");
    const changes = fixture.db.query("SELECT total_changes() n").get();
    const work: DataWork = {dbPath:fixture.dbPath,rates:fixture.rates,homes:[],
      request:{kind:"view",url:"http://local/api/claude-limit?account=" + ACCOUNTS.a + "&from=" + TIMES.start + "&until=" + TIMES.afterAsOf},
      context:{accounts: { version: 2, subscriptions: [], sources: [] },claudeGauge:{subscription:ACCOUNTS.a,plan:"max",observations:[]},grokGauge:{},
        cycles:{},plans:{},plansCatalog:{provider_groups:[]},rootDir:fixture.directory,subHomes:[],eraErrors:[]}};
    const reply = await workerReply(worker, work);
    if (!reply.report) throw new Error("Worker returned no report: " + JSON.stringify(reply));
    const result = reply.report as DataEnvelope;
    expect(result.status).toBe(200);
    const capacity = (result.body as ClaudeLimitReport).claude_code_capacity!;
    expect(capacity).toMatchObject({
      account: ACCOUNTS.a, rule: "claude-code-local-traffic@3", api_value_basis: "standard", basis: "interval",
      source_from: TIMES.first, source_through: TIMES.asOf, observed_code_tokens: 111_000,
      coverage: { code_events: 5, other_product_events: 0, unknown_events: 0 },
    });
    // 70k CLI + 11k SDK + 13k Desktop + 17k unmarked: all are Code under rule @3.
    const expectedCapacity = (70_000 + 11_000 + 13_000 + 17_000) * 10_000 / (24*12 - 10*12);
    expect(capacity.weekly_capacity_tokens).toMatchObject({ absent: null });
    expect(capacity.weekly_capacity_tokens.value).toBeCloseTo(expectedCapacity, 6);
    // The limit reads the stored window sums (U1.4): serving it needs no fact preparation.
    expect(usageLedgerState(fixture.db, "claude")?.status).toBeUndefined();
    expect(fixture.db.query("SELECT total_changes() n").get()).toEqual(changes);
  } finally {
    // The worker keeps its connection between answers: it closes it before the file is removed.
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 2000); worker.onmessage = () => { clearTimeout(timer); resolve(); }; worker.postMessage({ close: true }); });
    worker.terminate();await Bun.sleep(0);fixture.teardown();
  }
},30000);

test("the usage-price job advances the provider's ledger for every account", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    discardLedger(db, "claude");
    expect(subscriptionUsagePriceReadiness(db,"claude",fixture.rates).state).toBe("absent");
    backgroundPrices(db, fixture.rates);
    const readiness = subscriptionUsagePriceReadiness(db,"claude",fixture.rates);
    expect(readiness).toMatchObject({state:"ready",reason:null});
    // One provider-scoped pass serves every account, so the second account is ready as well.
    expect(readUsagePriceAccountTotals(db,readiness.head!.scope,"claude",loadAccountResolver(db),[ACCOUNTS.b],null).calls).not.toBe("0");
  } finally { fixture.teardown(); }
}, 30000);

test("the usage-price job stops when the writer must yield and resumes when it may write", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    db.exec("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT)");
    discardLedger(db, "claude");
    const ledgers = () => db.query("SELECT COUNT(*) n FROM usage_ledger_state").get();
    const before = ledgers();
    expect(advanceCodexLedger(db, fixture.rates, [], { canWrite: () => false }))
      .toMatchObject({ complete: false, processed: 0, reason: USAGE_PRICE_WRITER_BUSY });
    advanceAllUsagePrices(db, fixture.rates, [], [], { canWrite: () => false, turnMs: 60_000 });
    expect(ledgers()).toEqual(before);
    expect(usageLedgerState(db, "claude")).toBeNull();
    advanceAllUsagePrices(db, fixture.rates, [], [], { canWrite: () => true, turnMs: 60_000 });
    expect(subscriptionUsagePriceReadiness(db, "claude", fixture.rates)).toMatchObject({ state: "ready" });
  } finally { fixture.teardown(); }
}, 30000);

test("Codex producers reuse one durable policy and changing copy preference never rebuilds bases", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    const stamp = () => db.query("SELECT version,rules_digest,rules_json,revision FROM usage_ledger_state WHERE provider='codex'").get();
    // A proven empty source publishes exact zero without a legacy journal consumer.
    db.exec("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT)");
    expect(advanceCodexLedger(db, fixture.rates, []).reason).toBeUndefined();
    const prepared = stamp();
    expect(prepared).toMatchObject({ version: CODEX_LEDGER_VERSION, rules_digest: codexLedgerSettings(fixture.rates).semantic_revision });
    expect(db.query("SELECT COUNT(*) n FROM codex_price_ledger_events").get()).toEqual({ n: 0 });
    advanceAllUsagePrices(db, fixture.rates, [], ["c:/users/a/.codex"], {});
    expect(stamp()).toEqual(prepared);
    // Copy selection is a request contract; its preference is not a price dependency.
    advanceAllUsagePrices(db, fixture.rates, [], [], {});
    expect(stamp()).toEqual(prepared);
  } finally { fixture.teardown(); }
}, 30000);

test("a backlog turn repeats passes until the providers are ready and reports work left for the continuation", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    // An empty Codex source, so the turn's Codex pass is a proven no-op.
    db.exec("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT)");
    const reset = () => discardLedger(db, "claude");
    reset();
    // Tiny batches and no turn time: one pass leaves Claude's register unfinished and says so.
    expect(advanceAllUsagePrices(db, fixture.rates, [], [], { limit: 1, steps: 1, ledger: { limit: 1, steps: 1 } }).othersPending).toBe(true);
    expect(subscriptionUsagePriceReadiness(db, "claude", fixture.rates).state).not.toBe("ready");
    reset();
    // The same batches within one long turn finish the backlog, and nothing is left to continue.
    expect(advanceAllUsagePrices(db, fixture.rates, [], [], { limit: 1, steps: 1, turnMs: 60_000, ledger: { limit: 1, steps: 1 } }).othersPending).toBe(false);
    expect(subscriptionUsagePriceReadiness(db, "claude", fixture.rates)).toMatchObject({ state: "ready" });
    // A finished register ends the next turn after one empty pass.
    const started = performance.now();
    expect(advanceAllUsagePrices(db, fixture.rates, [], [], { limit: 1, steps: 1, turnMs: 60_000, ledger: { limit: 1, steps: 1 } }).othersPending).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);
  } finally { fixture.teardown(); }
}, 120_000);
