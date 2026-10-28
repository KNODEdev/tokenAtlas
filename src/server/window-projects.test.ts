import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { codexCallsScene, card, openedDatabases } from "./codex-window-calls.fixture";
import { subscriptionDeclarations } from "./capacity-equivalents";
import { ACCOUNTS, createClaudeCodeAcceptanceFixture, PROJECT, TIMES } from "./claude-code-capacity.fixture";
import { readWindowProjects, windowProjectsRequest, handleWindowProjects } from "./window-projects";
import { loadAccountResolver } from "./account-resolver";
import { usageLedgerEvents } from "../db/usage-ledger-events";
import { TOKEN_BUCKETS } from "./subscription-accounting-adapters";
import { overrideProjectRules, projectRulesOverride } from "../projects/resolve";
import { WINDOW_SCREENS } from "./window-screens";
import type { AppContext } from "./api";
import { createTestDatabase } from "../sync/test-support";
import { prepareProviderReaderFacts } from "./provider-reader.fixture";
import { ensureLimitWindowSchema } from "../db/limit-windows";
import fs from "node:fs";

afterEach(() => { for (const db of openedDatabases.splice(0)) db.close(); });
const total = (rows: Array<{ tokens: number; calls: number }>) => rows.reduce((sum, row) => ({ tokens: sum.tokens + row.tokens, calls: sum.calls + row.calls }), { tokens: 0, calls: 0 });
function claudeContext(f: ReturnType<typeof createClaudeCodeAcceptanceFixture>) {
  return { sqlite: f.db, rateCards: f.rates, accounts: { version: 2, sources: [], subscriptions:
    Object.values(ACCOUNTS).map(id => ({ id, vendor: "claude" })) } } as unknown as AppContext;
}

test("window project totals and hourly bars exclude the inactive plan spans", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    ensureLimitWindowSchema(f.db);
    const ctx = claudeContext(f), request = { account: ACCOUNTS.a, from: TIMES.start, until: TIMES.asOf };
    const spans = [{ start: TIMES.start, end: TIMES.first }, { start: "2026-09-16T12:00:00.000Z", end: TIMES.asOf }];
    const baseline = spans.map(span => readWindowProjects(ctx, { account: ACCOUNTS.a, from: span.start, until: span.end }));
    f.db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,
      window_minutes,plan_mismatch,readings,seen_reset,last_input,activity) VALUES('claude',?,'weekly',0,'paused',?,?,?,'scheduled',10080,0,'[]',1,'{}',?)`)
      .run(ACCOUNTS.a, TIMES.start, TIMES.asOf, TIMES.reset, JSON.stringify({ plan: "max-20x", spans }));
    const result = readWindowProjects(ctx, request);
    expect(total(result.projects)).toEqual(total(baseline.flatMap(report => report.projects)));
    expect(total(result.projects.flatMap(project => project.hours))).toEqual(total(result.projects));
  } finally { f.teardown(); }
});
test("Claude uses the exact half-open window, excludes copies and other accounts, and preserves unassigned traffic", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const ctx = claudeContext(f), request = { account: ACCOUNTS.a, from: TIMES.start, until: TIMES.asOf };
    const actual = readWindowProjects(ctx, request);
    const events = usageLedgerEvents(f.db, "claude", f.rates, loadAccountResolver(f.db).plan("claude", ACCOUNTS.a)).load(request.from, request.until);
    expect(total(actual.projects)).toEqual({ calls: events.length, tokens: events.reduce((sum, event) => sum + TOKEN_BUCKETS.reduce((n, key) => n + event.quantities[key], 0), 0) });
    expect(actual.projects.some(project => project.project_id === null)).toBe(true);
    expect(actual.projects.find(project => project.project_id === PROJECT)?.tokens).toBe(40_000);
    expect(actual.projects.reduce((sum, project) => sum + (project.api_usd ?? 0), 0)).toBeCloseTo(events.reduce((sum, event) => sum + (event.prices.actual?.amount ?? 0), 0), 12);
    for (const project of actual.projects) {
      expect(total(project.hours)).toEqual(total([project]));
      expect(total(project.models)).toEqual(total([project]));
    }
    const clipped = readWindowProjects(ctx, { ...request, from: "2026-09-16T12:30:00.000Z", until: "2026-09-16T14:00:00.000Z" });
    expect(total(clipped.projects)).toEqual({ calls: 1, tokens: 11_000 });
  } finally { f.teardown(); }
});
test("a readonly restart reads the same finished sums without writing or requiring original event tables", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const ctx = claudeContext(f), request = { account: ACCOUNTS.a, from: TIMES.start, until: TIMES.asOf };
    const expected = readWindowProjects(ctx, request);
    f.db.exec("DROP TABLE claude_events");
    const copy = new Database(f.dbPath, { readonly: true });
    try {
      expect(readWindowProjects({ ...ctx, sqlite: copy }, request)).toEqual(expected);
      expect(copy.query("SELECT total_changes() n").get()).toEqual({ n: 0 });
    } finally { copy.close(); }
  } finally { f.teardown(); }
});
test("Codex project and model timelines keep exact edges, canonical copies and period ownership", () => {
  const { db, base } = codexCallsScene();
  const ctx = { sqlite: db, rateCards: card, accounts: { version: 2, sources: subscriptionDeclarations(base.homeToSubId!),
    subscriptions: ["acct", "before", "other"].map(id => ({ id, vendor: "codex" })) } } as unknown as AppContext;
  const request = { account: "acct", from: base.from, until: base.until }, changes = db.query("SELECT total_changes() n").get();
  const report = readWindowProjects(ctx, request);
  expect(report.projects.some(project => project.project_id === "7")).toBe(true);
  for (const project of report.projects) expect(total(project.hours)).toEqual(total([project]));
  expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
  const copy = Database.deserialize(db.serialize(), { readonly: true });
  overrideProjectRules(copy, projectRulesOverride(db)!);
  try { expect(readWindowProjects({ ...ctx, sqlite: copy }, request)).toEqual(report); } finally { copy.close(); }
  overrideProjectRules(db, { projects: [{ id: "new", name: "New", matches: [{ project: "seven" }] }] });
  const changed = readWindowProjects(ctx, request);
  expect(total(changed.projects)).toEqual(total(report.projects));
  expect(changed.projects.some(project => project.project_id === "7")).toBe(false);
  expect(changed.projects.some(project => project.project_id === "new")).toBe(true);
});
test("unknown scopes and malformed, reversed or excessive ranges fail before report preparation", () => {
  const ctx = { accounts: { subscriptions: [] } } as unknown as AppContext;
  const url = new URL("http://local/api/window-projects?account=missing&from=2026-09-16T12:00:00Z&until=2026-09-16T13:00:00Z");
  expect(handleWindowProjects(ctx, url).status).toBe(400);
  expect(WINDOW_SCREENS[url.pathname]!.scope(url, ctx)).toBeNull();
  for (const edits of [{ account: "all" }, { from: "2026-09-16" }, { from: "2026-02-30T12:00:00Z" }, { until: "2026-09-16T11:00:00Z" }, { until: "2028-09-16T13:00:00Z" }]) {
    const invalid = new URL(url);
    for (const [key, value] of Object.entries(edits)) invalid.searchParams.set(key, value);
    expect(() => windowProjectsRequest(invalid)).toThrow();
  }
});
test("a correction is incremental, an identical retry is stable, and a full ledger refill gives the same projects", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const ctx = claudeContext(f), request = { account: ACCOUNTS.a, from: TIMES.start, until: TIMES.asOf };
    const before = readWindowProjects(ctx, request);
    f.db.exec("UPDATE claude_events SET in_uncached=in_uncached+1000 WHERE call_id='between'");
    f.prepareFacts();
    const corrected = readWindowProjects(ctx, request);
    expect(total(corrected.projects).tokens).toBe(total(before.projects).tokens + 1000);
    f.prepareFacts();
    expect(readWindowProjects(ctx, request)).toEqual(corrected);
    for (const table of ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_hours", "usage_ledger_day_reasons", "usage_ledger_dirty", "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_source_days", "usage_ledger_state", "usage_ledger_mixed_sessions"])
      f.db.query(`DELETE FROM ${table} WHERE provider='claude'`).run();
    f.prepareFacts();
    expect(readWindowProjects(ctx, request)).toEqual(corrected);
  } finally { f.teardown(); }
});
test("omitted Codex service tier uses Standard without unknown-mode quality", () => {
  const { db, base } = codexCallsScene();
  const ctx = { sqlite: db, rateCards: card, accounts: { version: 2, sources: subscriptionDeclarations(base.homeToSubId!), subscriptions: [{ id: "acct", vendor: "codex" }] } } as unknown as AppContext;
  const report = readWindowProjects(ctx, { account: "acct", from: "2026-09-11T11:10:52.114Z", until: "2026-09-11T11:10:52.115Z" });
  expect(report.projects[0]).toMatchObject({ calls: 1, unpriced_calls: 0, unknown_mode_tokens: 0 });
  expect(report.projects[0]!.models[0]!.unknown_mode_tokens).toBe(0);
});
test("explicitly unmapped Codex service tier keeps the actual price unknown", () => {
  const { db, base } = codexCallsScene(db => {
    db.exec("ALTER TABLE events ADD COLUMN service_tier TEXT");
    db.exec("UPDATE events SET service_tier=CASE speed WHEN 'fast' THEN 'priority' WHEN 'standard' THEN 'default' ELSE NULL END");
    db.query("UPDATE events SET service_tier='future-unmapped' WHERE ts=?").run("2026-09-11T11:10:52.114Z");
  });
  const ctx = { sqlite: db, rateCards: card, accounts: { version: 2, sources: subscriptionDeclarations(base.homeToSubId!),
    subscriptions: [{ id: "acct", vendor: "codex" }] } } as unknown as AppContext;
  const report = readWindowProjects(ctx, { account: "acct", from: "2026-09-11T11:10:52.114Z", until: "2026-09-11T11:10:52.115Z" });
  expect(report.projects[0]).toMatchObject({ calls: 1, unpriced_calls: 1, unknown_mode_tokens: 198597, api_usd: null });
  expect(report.projects[0]!.models[0]!.unknown_mode_tokens).toBe(198597);
});
test("GLM counts the subscription's projects and excludes other OpenCode vendors", () => {
  const { directory, dbPath } = createTestDatabase(), db = new Database(dbPath);
  try {
    db.exec(`INSERT INTO oc_events(store,message_id,session_id,ts,model,provider,project_id,in_tok,out_tok,reasoning,cache_read,cache_write)
      VALUES('seat','one','session','2026-09-01T13:00:00.000Z','fixture','zai-coding-plan','alpha',1000000,100000,30000,200000,10000),
      ('seat','two','session','2026-09-01T13:10:00.000Z','fixture','openai','alpha',999999,99999,0,0,0)`);
    const rates = { version: 1, currency: "USD", unit: "per 1M", vendors: { zai: { source: "fixture", models: {
      fixture: { in_uncached: 1, in_cache_read: 2, in_cache_write: 3, out_total: 4 } } } } } as AppContext["rateCards"];
    prepareProviderReaderFacts(db, "glm", "seat", undefined, 100, rates);
    const ctx = { sqlite: db, rateCards: rates, accounts: { subscriptions: [{ id: "seat", vendor: "glm" }] } } as AppContext;
    const report = readWindowProjects(ctx, { account: "seat", from: "2026-09-01T12:00:00.000Z", until: "2026-09-01T14:00:00.000Z" });
    expect(total(report.projects)).toEqual({ tokens: 1_340_000, calls: 1 });
    expect(report.projects[0]!.api_usd).toBe(1.95);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
