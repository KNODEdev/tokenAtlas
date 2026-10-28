import { test, expect, spyOn } from "bun:test";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { withContextRates } from "./rate-cards-file";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

const child = process.env.TOKENATLAS_LEDGER_REQUEST_CHILD === "1";
async function regression() {
  const { Database } = await import("../db/sqlite");
  const { createFetchHandler, periodEras, handleCycleBreakdown, handleSummary } = await import("./api");
  const { buildDataView } = await import("./data-views");
  const { createDataRead } = await import("./data-read");
  const { cacheKey } = await import("./cache");
  const { apiCodexLedgerRows } = await import("./api-codex-ledger");
  const { decimal, equal, add: addExact, rational } = await import("../db/price-ledger-exact");
  const { installAnalysisTracking } = await import("../db/analysis");
  const { readCodexWindowDetail } = await import("./codex-window-detail");
  const { createCodexLedgerSchema, CodexLedgerNotReady } = await import("../db/codex-price-ledger");
  const { fillCodexLedgerFixture } = await import("./codex-ledger.fixture");
  const nativeAdapters = await import("../db/codex-ledger-adapters");
  const { enqueueCodexLedgerRuleChanges, processCodexLedgerBatch } = await import("../db/codex-ledger-producer");
  const { codexLedgerReadContext } = await import("../db/codex-ledger-adapters");
  const { codexLedgerSettings } = await import("./codex-ledger-settings");
  const ledgerRequests = await import("./codex-ledger-request");
  // Reproduce the original warm-cache bypass without changing shared production files.
  if (process.env.TOKENATLAS_LEDGER_REQUEST_BYPASS === "1") spyOn(ledgerRequests, "codexLedgerRequestStamp").mockReturnValue(null);
  const { codexLedgerRequestRanges, codexLedgerRequestStamp, ratesWithoutAuthoritativeCodexPolicy } = ledgerRequests;
  const { SubscriptionFactsPending } = await import("../db/subscription-facts");
  const latestAccount = await import("./latest-account-state-query");
  // This fixture has no percentage readings; isolate its prepared empty probe metadata.
  const emptyProbes = spyOn(latestAccount, "readLatestAccountStateRows").mockReturnValue([]);
  const { buildEraIndex } = await import("./eras");
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,
    service_tier TEXT,usage_status TEXT,cache_write_status TEXT,project_id INTEGER,project TEXT,repo TEXT,surface TEXT);
    INSERT INTO events VALUES(1,'/synthetic/codex/main','a',100,'2026-04-01T12:00:00Z','known',1000000,0,0,0,0,'default','valid','reported',NULL,NULL,NULL,'cli'),
      (2,'/synthetic/codex/main','a',200,'2026-08-01T12:00:00Z','known',1000000,0,0,0,0,'default','valid','reported',NULL,NULL,NULL,'cli'),
      (3,'/synthetic/codex/main','a',300,'2026-07-27T12:00:00Z','known',1000000,0,0,0,0,'default','valid','reported',NULL,NULL,NULL,'cli');
    CREATE TABLE ratelimit(id INTEGER PRIMARY KEY,ts TEXT,home TEXT,path TEXT);
    CREATE TABLE sync_revisions(id INTEGER PRIMARY KEY,data_revision INTEGER,config_revision INTEGER);
    INSERT INTO sync_revisions VALUES(1,0,0); CREATE TABLE vendor_sync_revisions(vendor TEXT PRIMARY KEY,data_revision INTEGER);
    INSERT INTO vendor_sync_revisions VALUES('codex',0);`);
  createAnalysisSourceRevisions(db);
  db.exec(fs.readFileSync(new URL("../../drizzle/0040_account_periods.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  db.exec("INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence) VALUES('codex','codex/main','2026-01-01','owner','declared','synthetic')");
  installAnalysisTracking(db); createCodexLedgerSchema(db);
  const evidence = { verified_at: "2026-01-01", sources: ["https://example.test/synthetic"], confidence: "official" as const };
  const card: import("./pricing").RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: {}, codex_accounting: { version: 1, rules: [] },
    codex_ledger_policy: { version: 1, tiers: ["standard", "fast"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }], tier_rules: [],
      base_rules: [
        { id: "api", model: "known", billing_basis: "api_equivalent_usd", valid_from: "2026-01-01", multiplier: "1", ...evidence,
          rates: { in_uncached: "1", in_cache_read: "0.5", out_total: "2" } },
        { id: "credits", model: "known", billing_basis: "chatgpt_credits", valid_from: "2026-01-01", multiplier: "1", ...evidence,
          rates: { in_uncached: "100", in_cache_read: "50", out_total: "200" } },
      ] } };
  const ctx = { sqlite: db, rateCards: withContextRates(card), homeToSubId: new Map([["/synthetic/codex/main", "owner"]]),
    subIdToHomes: new Map([["owner", ["/synthetic/codex/main"]]]), accounts: { version: 2, subscriptions: [{ id: "owner", vendor: "codex" }], sources: [] },
    rootDir: process.cwd(), eras: buildEraIndex([]), eraErrors: [], homeConflict: null, claudeGauge: {}, grokGauge: {}, cycles: {}, plans: {}, plansCatalog: { provider_groups: [] } } as unknown as import("./api").AppContext;
  ctx.eras = buildEraIndex(periodEras(db,ctx.accounts),"instant");
  const options = () => {
    const current = codexLedgerReadContext(ctx.rateCards);
    return { bands: current.policy.baseBands, policy: current.policy.policy, rulesRevision: current.rulesRevision!, factsRevision: 0, batchSize: 1, anchorOf: () => null };
  };
  fillCodexLedgerFixture(db, { ...options(), sourceOf: () => "codex/main" });
  const publish = () => {
    enqueueCodexLedgerRuleChanges(db, options());
    for (let i = 0; i < 100; i++) if (processCodexLedgerBatch(db, options()).ready) return;
    throw new Error("Synthetic rule publication failed to drain");
  };
  publish();
  fs.writeFileSync(path.join(process.env.TOKENATLAS_CONFIG!, "rate-cards.json"), JSON.stringify(card));
  const fetch = createFetchHandler(ctx), reader = createDataRead();
  const april = new URL("http://127.0.0.1/api/summary?vendor=codex&since=2026-04-01&until=2026-04-30");
  const august = new URL("http://127.0.0.1/api/summary?vendor=codex&since=2026-08-01&until=2026-08-31");
  const claude = new URL("http://127.0.0.1/api/summary?vendor=claude&since=2026-08-01&until=2026-08-31");
  const request = (url: URL) => fetch(new Request(url));
  let assertions = 0;
  const eq = (actual: unknown, expected: unknown) => { assertions++; assert.deepEqual(actual, expected); };
  const ok = (value: unknown, message: string) => { assertions++; assert.ok(value, message); };
  try {
    eq(Bun.version, process.env.TOKENATLAS_EXPECTED_BUN);
    const raw = db.query("SELECT * FROM events ORDER BY id").all(), revisions = db.query("SELECT * FROM sync_revisions").all();
    for (const url of [april, august, claude]) {
      eq((await request(url)).status, 200); const hot = await request(url); eq(hot.status, 200); eq(hot.headers.get("X-Cache"), "hit");
    }
    eq((await (await request(august)).json()).totals.codex.usd, 1);
    eq((await buildDataView(ctx, august)).status, 200);
    const saved = (await buildDataView(ctx, april)).body; eq((await buildDataView(ctx, april)).status, 200);
    const aprilBody = async () => (await buildDataView(ctx, april)).body;
    const aprilStamp = codexLedgerRequestStamp(ctx, april), augustStamp = codexLedgerRequestStamp(ctx, august);
    const missing = new URL("http://127.0.0.1/api/missing-rates");
    eq(codexLedgerRequestRanges(ctx, missing), [{ dependencyProjects: false }]);
    eq((await request(missing)).status, 200);
    const invalidQueries = ["/api/events?vendor=codex&order=bad",
      "/api/events?vendor=codex&account=missing",
      "/api/events?vendor=codex&account=missing&since=bad",
      "/api/cycle-breakdown?account=missing&since_ts=2026-04-01T00:00:00Z&until_ts=2026-04-30T00:00:00Z"];
    const invalidBodies: unknown[] = [];
    for (const query of invalidQueries) { const response = await request(new URL("http://127.0.0.1" + query)); eq(response.status, 400); invalidBodies.push(await response.json()); }
    // Work is queued without a raw row, configuration or broad revision change.
    db.exec("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','{\"model\":\"known\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-08-01\",\"untilDay\":\"2026-08-31\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}')");
    eq((await request(august)).status, 202);
    eq((await request(april)).headers.get("X-Cache"), "hit"); eq((await request(claude)).headers.get("X-Cache"), "hit");
    eq((await buildDataView(ctx, august)).status, 202);
    eq(await aprilBody(), saved); eq((await reader(ctx, new Request(august))).status, 202);
    eq(db.query("SELECT * FROM sync_revisions").all(), revisions); eq(db.query("SELECT * FROM events ORDER BY id").all(), raw);
    for (let i = 0; i < invalidQueries.length; i++) {
      const response = await request(new URL("http://127.0.0.1" + invalidQueries[i])); eq(response.status, 400); eq(await response.json(), invalidBodies[i]);
    }
    const coldEvents = await request(new URL("http://127.0.0.1/api/events?vendor=codex&since=2026-04-01&until=2026-04-30"));
    eq(coldEvents.status, 200); eq((await coldEvents.json()).rows.length, 1);
    const aprilHistory = new URL("http://127.0.0.1/api/account-history?since=2026-04-01&until=2026-04-30");
    const coldHistory = await request(aprilHistory); eq(coldHistory.status,200); eq((await coldHistory.json()).totals.calls,1);
    eq((await request(new URL("http://127.0.0.1/api/account-history?since=2026-08-01&until=2026-08-31"))).status,202);
    const cycleUrl = new URL("http://127.0.0.1/api/cycle-breakdown?account=owner&since_ts=2026-04-01T00:00:00Z&until_ts=2026-04-30T00:00:00Z");
    eq(handleCycleBreakdown(ctx,cycleUrl).status,200);
    const coldCycle = await request(cycleUrl);
    eq(coldCycle.status, 200);
    const windowOptions = { account: "owner", homes: ["/synthetic/codex/main"], from: "2026-04-01T00:00:00Z", until: "2026-04-30T00:00:00Z",
      anchor: null, limitId: "codex", sessionMinutes: 300, homeToSubId: ctx.homeToSubId };
    const windowBefore = readCodexWindowDetail(db,ctx.rateCards,windowOptions);
    const aprilBaseBefore = db.query("SELECT * FROM codex_price_ledger_events WHERE day='2026-04-01'").all();
    const rosterContext = { ...ctx, accounts: { ...ctx.accounts, subscriptions: [{ id: "owner", vendor: "codex" }, { id: "claude-owner", vendor: "claude" }] } };
    // The roster and the window rail read stored window rows, never the Codex ledger.
    eq(codexLedgerRequestRanges(rosterContext, new URL("http://127.0.0.1/api/roster?account=claude-owner&window=7&since=ignored")).length, 0);
    eq(codexLedgerRequestRanges(rosterContext, new URL("http://127.0.0.1/api/windows")).length, 0);
    eq(codexLedgerRequestRanges(rosterContext, new URL("http://127.0.0.1/api/plan-capacity?provider=claude&plan_id=x&window_kind=weekly")).length, 0);
    db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind='rules' AND value='{\"model\":\"known\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-08-01\",\"untilDay\":\"2026-08-31\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}'");
    const originalRead = nativeAdapters.readCodexLedgerOwnedSeries;
    const bodyRace = spyOn(nativeAdapters,"readCodexLedgerOwnedSeries").mockImplementation((...args)=> {
      eq(db.inTransaction,false);
      db.exec("INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','{\"model\":\"known\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-04-01\",\"untilDay\":\"2026-05-01\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}')");
      return originalRead(...args);
    });
    try {
      assertions++; assert.throws(()=>handleSummary(ctx,new URL(april)),CodexLedgerNotReady);
      db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind='rules' AND value='{\"model\":\"known\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-04-01\",\"untilDay\":\"2026-05-01\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}'");
      const raced = await request(new URL(april.toString()+"&body_read=race")); eq(raced.status,202); eq(raced.headers.get("Cache-Control"),"no-store");
      eq(db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex' AND kind='rules' AND value='{\"model\":\"known\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-04-01\",\"untilDay\":\"2026-05-01\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}'").get(),{n:1});
    } finally { bodyRace.mockRestore(); db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind='rules' AND value='{\"model\":\"known\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-04-01\",\"untilDay\":\"2026-05-01\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}'"); }
    const originalStamp = ledgerRequests.codexLedgerRequestStamp;
    let readinessCalls = 0;
    const publicationRace = spyOn(ledgerRequests, "codexLedgerRequestStamp").mockImplementation((context, url) => {
      if (++readinessCalls === 2) throw new SubscriptionFactsPending("Synthetic publication race", "codex");
      return originalStamp(context, url);
    });
    try { eq((await request(april)).status, 202); eq(readinessCalls, 2); }
    finally { publicationRace.mockRestore(); }
    let stampCalls = 0;
    const finalPublicationRace = spyOn(ledgerRequests, "codexLedgerRequestStamp").mockImplementation((context, url) => {
      if (new Error().stack?.includes("currentStamp") && ++stampCalls === 2) {
        db.exec("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','{\"model\":\"known\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-04-01\",\"untilDay\":\"2026-05-01\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}')");
      }
      return originalStamp(context, url);
    });
    try {
      const response = await request(new URL(april.toString() + "&final_stamp=race")); eq(response.status, 202);
      eq(stampCalls, 2); eq(db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex' AND kind='rules' AND value='{\"model\":\"known\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-04-01\",\"untilDay\":\"2026-05-01\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}'").get(), { n: 1 });
    } finally { finalPublicationRace.mockRestore(); db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind='rules' AND value='{\"model\":\"known\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-04-01\",\"untilDay\":\"2026-05-01\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}'"); }
    const project = new URL("http://127.0.0.1/api/project-cost?since=2026-08-01&until=2026-08-31");
    eq(codexLedgerRequestRanges(ctx, project), [{ fromMs: Date.parse("2026-07-25"), toMs: Date.parse("2026-09-08") }]);
    eq(codexLedgerRequestRanges(ctx, new URL("http://127.0.0.1/api/project-cost")), [{}]);
    const projectBody = { fixture: "accepted project report" }, frozenClock = spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const cache = ctx.responseCache!;
      cache.set(cacheKey(project), cache.clockStamp(db) + ":codex:" + codexLedgerRequestStamp(ctx, project), JSON.stringify(projectBody));
      const warm = await request(project); eq(warm.status, 200); eq(warm.headers.get("X-Cache"), "hit"); eq(await warm.json(), projectBody);
      db.exec("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','{\"model\":\"known\",\"basis\":\"chatgpt_credits\",\"fromDay\":\"2026-07-27\",\"untilDay\":\"2026-07-28\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}')");
      eq((await request(project)).status, 202);
      eq((await request(august)).headers.get("X-Cache"), "hit");
      eq((await request(claude)).headers.get("X-Cache"), "hit");
      db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind='rules' AND value='{\"model\":\"known\",\"basis\":\"chatgpt_credits\",\"fromDay\":\"2026-07-27\",\"untilDay\":\"2026-07-28\",\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}'");
    } finally { frozenClock.mockRestore(); }
    const base = structuredClone(codexLedgerSettings(ctx.rateCards).policy.base_rules.find(rule => rule.id === "api")!);
    const edit = await fetch(new Request("http://127.0.0.1/api/codex-ledger-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      expected_revision: codexLedgerSettings(ctx.rateCards).revision, origin: "user", operations: [{ kind: "overlay_base_rule", replace_id: "api",
        rule: { ...base, id: "api-august", valid_from: "2026-08-01", valid_until: "2026-09-01", rates: { ...base.rates, in_uncached: "3" } } }],
    }) }));
    eq(edit.status, 200);
    eq(db.query("SELECT * FROM sync_revisions").all(), revisions); eq(db.query("SELECT * FROM events ORDER BY id").all(), raw);
    eq(codexLedgerRequestStamp(ctx, april), aprilStamp);
    const pending = await request(august); eq(pending.status, 202); eq(pending.headers.get("Cache-Control"), "no-store");
    eq((await request(missing)).status, 202);
    const aprilHot = await request(april); eq(aprilHot.status, 200); eq(aprilHot.headers.get("X-Cache"), "hit");
    const otherHot = await request(claude); eq(otherHot.status, 200); eq(otherHot.headers.get("X-Cache"), "hit");
    eq(await aprilBody(), saved);
    eq(readCodexWindowDetail(db,ctx.rateCards,windowOptions).detail, windowBefore.detail);
    eq(db.query("SELECT * FROM codex_price_ledger_events WHERE day='2026-04-01'").all(), aprilBaseBefore);
    eq((await reader(ctx, new Request(august))).status, 202);
    eq((await buildDataView(ctx, august)).status, 202);
    const compare = new URL("http://127.0.0.1/api/compare?vendor=codex&a_since=2026-04-01&a_until=2026-04-30&b_since=2026-10-01&b_until=2026-10-31");
    eq(codexLedgerRequestRanges(ctx, compare).length, 2); ok(codexLedgerRequestStamp(ctx, compare), "comparison excludes the pending August gap");
    eq((await request(compare)).status, 200);
    const emptyA = new URL("http://127.0.0.1/api/compare?vendor=codex&a_since=2026-04-30&a_until=2026-04-01&b_since=2026-08-01&b_until=2026-08-31");
    eq(codexLedgerRequestRanges(ctx, emptyA).length, 1); eq((await request(emptyA)).status, 202);
    for (const query of ["since=broken", "group=bad", "vendor=all"]) {
      eq((await request(new URL("http://127.0.0.1/api/summary?" + query))).status, 400);
    }
    for (const route of ["/api/breakdown?dim=bad", "/api/codex-accounting?window_minutes=7", "/api/subscription-accounting?provider=bad&since=broken"]) {
      eq((await request(new URL("http://127.0.0.1" + route))).status, 400);
    }
    const filtered = new URL("http://127.0.0.1/api/global-usage?vendors=claude&since=2026-08-01&until=2026-08-31");
    eq(codexLedgerRequestStamp(ctx, filtered), null);
    eq(ratesWithoutAuthoritativeCodexPolicy({ ...ctx.rateCards, vendors: { openai: { models: { other: { in_uncached: 7, in_cache_read: 1, out_total: 8 } } } } }).vendors.openai!.models!.other!.in_uncached, 7);
    publish();
    ok(codexLedgerRequestStamp(ctx, august) !== augustStamp, "published August amount changes the native stamp");
    eq((await request(missing)).status, 200);
    const updated = await request(august); eq(updated.status, 200); eq(updated.headers.get("X-Cache"), "miss");
    eq((await updated.json()).totals.codex.usd, 3); eq((await request(august)).headers.get("X-Cache"), "hit");
    eq(await aprilBody(), saved); eq((await request(april)).headers.get("X-Cache"), "hit");
    eq((await request(claude)).headers.get("X-Cache"), "hit");
    eq(db.query("SELECT * FROM sync_revisions").all(), revisions); eq(db.query("SELECT * FROM events ORDER BY id").all(), raw);
    let midpoint: { actual: number; required: number } | undefined;
    let largeMidpoint: { actual: number; required: number; nano: string } | undefined;
    if (process.env.TOKENATLAS_LEDGER_NUMERIC_PROBE === "1") {
      const boundary = async (input: number, rate: string | undefined, expected: string, required: number, second = false, legacy = false) => {
      const numericDb = new Database(":memory:");
      const numericCard: import("./pricing").RateCard = { ...structuredClone(ctx.rateCards),
        codex_ledger_policy: structuredClone(codexLedgerSettings(ctx.rateCards).policy) };
      if (rate) for (const rule of numericCard.codex_ledger_policy!.base_rules) {
        if (rule.billing_basis === "api_equivalent_usd" && rule.valid_from <= "2026-04-01" && (!rule.valid_until || rule.valid_until > "2026-04-01")) rule.rates.in_uncached = rate;
      }
      const numericCtx: import("./api").AppContext = { ...ctx, rateCards: numericCard, sqlite: numericDb, analysisReader: undefined, responseCache: undefined };
      try {
        numericDb.exec((db.query("SELECT sql FROM sqlite_master WHERE name='events'").get() as { sql: string }).sql);
        numericDb.exec(fs.readFileSync(new URL("../../drizzle/0040_account_periods.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
        numericDb.exec("INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence) VALUES('codex','codex/main','2026-01-01','owner','declared','synthetic')");
        const event: Record<string, string | number | null> = { ...(db.query("SELECT * FROM events WHERE id=1").get() as Record<string, string | number | null>), in_tok: input };
        const columns = Object.keys(event);
        numericDb.query(`INSERT INTO events(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(column => event[column]!));
        if (second) {
          const next = { ...event, id: 2, source_offset: 200, ts: "2026-04-02T12:00:00Z" } as Record<string, string | number | null>;
          numericDb.query(`INSERT INTO events(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(column => next[column]!));
        }
        createCodexLedgerSchema(numericDb);
        const context = codexLedgerReadContext(numericCard);
        fillCodexLedgerFixture(numericDb, { bands: context.policy.baseBands, policy: context.policy.policy,
          rulesRevision: context.rulesRevision!, factsRevision: 0, sourceOf: () => "codex/main" });
        const amount = decimal(expected), rows = apiCodexLedgerRows(numericCtx);
        eq(equal(rows.reduce((sum, row) => addExact(sum, row.usd), rational(0n)), amount), true);
        const numericFetch = createFetchHandler(numericCtx), response = await numericFetch(new Request(april)); eq(response.status, 200);
        const summary = await response.json(); eq(summary.totals.codex.usd, required); eq(summary.totals.usd, required);
        if (second) eq(summary.buckets.map((bucket: { usd: number }) => bucket.usd), [0, 0]);
        for (const [route, select] of [
          ["/api/breakdown?vendor=codex&dim=model&since=2026-04-01&until=2026-04-30", (body: any) => body.totals.usd],
          ["/api/cache?vendor=codex&since=2026-04-01&until=2026-04-30", (body: any) => body.codex.usd.total],
          ["/api/compare?vendor=codex&a_since=2026-03-01&a_until=2026-03-31&b_since=2026-04-01&b_until=2026-04-30", (body: any) => body.window_b.codex.usd],
          ["/api/account-history?group=day&since=2026-04-01&until=2026-04-30", (body: any) => body.totals.usd],
          ["/api/cycle-breakdown?account=owner&since_ts=2026-04-01T00:00:00Z&until_ts=2026-04-30T00:00:00Z", (body: any) => body.days.reduce((sum: number, day: { usd: number }) => sum + day.usd, 0)],
          ["/api/cycle-breakdown?account=owner&since_ts=2026-04-01T00:00:00Z&until_ts=2026-04-30T00:00:00Z&numeric_total=1", (body: any) => body.totals.usd],
        ] as const) {
          const report = await numericFetch(new Request("http://127.0.0.1" + route)); eq(report.status, 200);
          eq(select(await report.json()), second && route.includes("cycle-breakdown") && !route.includes("numeric_total") ? 0 : required);
        }
        if (legacy) {
          numericDb.exec(`CREATE TABLE claude_events(id INTEGER PRIMARY KEY,ts TEXT,model TEXT,speed TEXT,in_uncached INTEGER,
            in_cache_read INTEGER,in_cache_write INTEGER,cache_write_5m INTEGER,cache_write_1h INTEGER,out_total INTEGER,out_thinking INTEGER,project_id INTEGER);
            INSERT INTO claude_events VALUES(1,'2026-04-02T12:00:00Z','claude-known',NULL,4000,0,0,0,0,0,0,NULL)`);
          numericCard.vendors.anthropic = { models: { "claude-known": { in_uncached: 1, in_cache_read: 0.5, in_cache_write_5m: 1, in_cache_write_1h: 1, out_total: 2 } } };
          // Claude's day sums and valuations come from the shared usage ledger, as the maintenance worker fills it.
          installFactDayRevisions(numericDb); fillUsageLedgerFixture(numericDb, numericCard, ["claude"]);
          const mixed = await numericFetch(new Request("http://127.0.0.1/api/summary?vendor=both&since=2026-04-01&until=2026-04-30")); eq(mixed.status, 200);
          const mixedBody = await mixed.json(); eq(mixedBody.totals.usd, 0.01); eq(mixedBody.totals.codex.usd, 0); eq(mixedBody.totals.claude.usd, 0);
          eq(mixedBody.totals.claude.calls, 1); eq(mixedBody.buckets.map((bucket: { usd: number }) => bucket.usd), [0, 0]);
          const legacyOnly = await numericFetch(new Request("http://127.0.0.1/api/summary?vendor=claude&since=2026-04-01&until=2026-04-30")); eq(legacyOnly.status, 200);
          eq((await legacyOnly.json()).totals.claude, { calls: 1, usd: 0 });
        }
        return { actual: summary.totals.codex.usd, required, nano: String(amount.n * 1000000000n / amount.d) };
      } finally { numericCtx.analysisReader?.close(); await numericCtx.analysisReader?.whenIdle(); numericDb.close(); }
      };
      midpoint = await boundary(145000, undefined, "0.145", 0.15);
      largeMidpoint = await boundary(1000000, "10000.005", "10000.005", 10000.01);
      await boundary(1000000, "10000.0049999999999998", "10000.0049999999999998", 10000);
      await boundary(4000, "1", "0.008", 0.01, true);
      await boundary(4000, "1", "0.004", 0, false, true);
    }
    console.log(JSON.stringify({ assertions, bun: Bun.version, midpoint, largeMidpoint }));
  } finally { emptyProbes.mockRestore(); reader.close(); ctx.analysisReader?.close(); await reader.whenIdle(); await ctx.analysisReader?.whenIdle(); db.close(); }
}

if (child) await regression();
else test("warm HTTP responses and view builds fence scoped native changes while unrelated dates and providers remain cached", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-ledger-request-")), config = path.join(root, "config");
  fs.mkdirSync(config);
  try {
    const run = async (bypass: boolean) => {
    const childProcess = Bun.spawn([process.execPath, import.meta.path], { cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, TOKENATLAS_LEDGER_REQUEST_CHILD: "1", TOKENATLAS_EXPECTED_BUN: Bun.version, TOKENATLAS_CONFIG: config, TOKENATLAS_FROZEN_CONFIG: "1",
        TOKENATLAS_LEDGER_REQUEST_BYPASS: bypass ? "1" : "0",
        TOKENATLAS_LEDGER_NUMERIC_PROBE: "1",
        TOKENATLAS_ARCHIVE: path.join(root, "archive"), TOKENATLAS_LOCAL_STATE: path.join(root, "local"),
        TOKENATLAS_TEMP_DIR: path.join(root, "temporary"), TOKENATLAS_DB: path.join(root, "unused.sqlite"), USERPROFILE: path.join(root, "user") } });
    const [stdout, stderr, code] = await Promise.all([new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text(), childProcess.exited]);
    return { stdout, stderr, code };
    };
    const before = await run(true); expect(before.code).toBe(1); expect(before.stderr).toContain("200 !== 202");
    const { stdout, stderr, code } = await run(false);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const report = JSON.parse(stdout.trim().split("\n").at(-1)!); expect(report.bun).toBe(Bun.version); expect(report.assertions).toBeGreaterThan(40);
    console.log(JSON.stringify(report));
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Fixture cleanup escaped temporary root");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
