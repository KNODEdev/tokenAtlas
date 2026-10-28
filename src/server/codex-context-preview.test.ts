import { afterEach, expect, test } from "bun:test";
import { contextPreviewFixture } from "./codex-context-preview.fixture";
import { handleSummary, handleBreakdown } from "./api-summary";
import { handleAccountHistory } from "./api-account-history";
import { handleEvents } from "./api-events";
import { buildGlobalUsage as originalbuildGlobalUsage } from "./global-usage";
import { readWindowProjects as originalreadWindowProjects } from "./window-projects";
import { buildCodexAccountingReport as originalbuildCodexAccountingReport } from "./codex-accounting";
import { buildProjectCost as originalbuildProjectCost } from "./project-cost";
import { buildRepoHistory as originalbuildRepoHistory, buildRepoHistoryCancellable as originalbuildRepoHistoryCancellable } from "./repo-history";
import { contextProjectionStamp, CONTEXT_RESPONSE_PATHS, contextRequested } from "./codex-context-preview";
import { dataVersion } from "./data-version";
import type { ContextPreviewResponse } from "../shared/context-preview";
import { handleGlobalUsage } from "./global-usage";
import { handleWindowProjects } from "./window-projects";
import { handleProjectCost, handleRepoHistory } from "./api-projects";
import { cacheKey } from "./cache";

const buildGlobalUsage = (...args: Parameters<typeof originalbuildGlobalUsage>) => originalbuildGlobalUsage(args[0], args[1], true);
const readWindowProjects = (...args: Parameters<typeof originalreadWindowProjects>) => originalreadWindowProjects(args[0], args[1], true);
const buildProjectCost = (...args: Parameters<typeof originalbuildProjectCost>) => originalbuildProjectCost(args[0], args[1], args[2], { ...args[3], contextPreview: true });
const buildRepoHistory = (...args: Parameters<typeof originalbuildRepoHistory>) => originalbuildRepoHistory(args[0], { ...args[1], contextPreview: true });
const buildRepoHistoryCancellable = (...args: Parameters<typeof originalbuildRepoHistoryCancellable>) => originalbuildRepoHistoryCancellable(args[0], { ...args[1], contextPreview: true }, args[2]);
const buildCodexAccountingReport = (...args: Parameters<typeof originalbuildCodexAccountingReport>) => { args[2] = { ...args[2], contextPreview: true }; return originalbuildCodexAccountingReport(...args); };

const open: ReturnType<typeof contextPreviewFixture>[] = [];
afterEach(() => { for (const f of open.splice(0)) f.db.close(); });
const fixture = (included = false) => { const f = contextPreviewFixture(included); open.push(f); return f; };
const url = (path: string, optIn = true) => { const value = new URL(`http://test${path}`); if (optIn) value.searchParams.set("context", "1"); return value; };
const json = async (response: Response): Promise<any> => { expect(response.status).toBe(200); return response.json(); };
const paired = <T>(value: T) => value as T & ContextPreviewResponse<T>;
const sum = (rows: any[], field: string) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);

test("all nine default handlers omit context fields and never query the context projection", async () => {
  const f = fixture(); f.fill();
  const calls: [string, (request: URL) => Response | Promise<Response>][] = [
    ["/api/global-usage?since=2026-09-01&until=2026-09-01", u => handleGlobalUsage(f.ctx, u)],
    ["/api/account-history?group=day", u => handleAccountHistory(f.ctx, u)],
    ["/api/summary?vendor=codex", u => handleSummary(f.ctx, u)],
    ["/api/breakdown?vendor=codex&dim=model", u => handleBreakdown(f.ctx, u)],
    ["/api/events?vendor=codex", u => handleEvents(f.ctx, u)],
    ["/api/project-cost?since=2026-09-01&until=2026-09-01", u => handleProjectCost(f.ctx, u)],
    ["/api/repo-history?project=a&granularity=day&by=none", u => handleRepoHistory(f.ctx, u)],
    ["/api/window-projects?account=owner&from=2026-09-01T12:00:00.000Z&until=2026-09-01T14:00:00.000Z", u => handleWindowProjects(f.ctx, u)],
    ["/api/codex-accounting?account=owner&since=2026-09-01&until=2026-09-01", u => Response.json(originalbuildCodexAccountingReport(f.db, f.rates, { ...f.range, account: "owner", contextPreview: contextRequested(u) }, f.ctx.homeToSubId, undefined, false))],
  ];
  const query = f.db.query.bind(f.db);
  let contextQueries = 0;
  f.db.query = ((sql: string) => {
    if (sql.includes("codex_context_")) contextQueries++;
    return query(sql);
  }) as typeof f.db.query;
  for (const [path, read] of calls) {
    const response = await read(url(path, false));
    expect(response.status, path + " " + await response.clone().text()).toBe(200);
    const plain = await json(response);
    expect(JSON.stringify(plain)).not.toContain("context_preview");
    if (path.startsWith("/api/events")) for (const row of plain.rows) {
      expect(row).not.toHaveProperty("context_price"); expect(row).not.toHaveProperty("ledger_event_id");
    }
  }
  expect(contextQueries).toBe(0);
  for (const [path, read] of calls) {
    const paired = await json(await read(url(path)));
    expect(paired.context_preview_status).toMatchObject({ ready: true });
    expect(paired.context_preview).toBeDefined();
  }
  expect(contextQueries).toBeGreaterThan(0);
});

test("only explicit opt-in keys depend on context publications", () => {
  const f = fixture(); f.fill();
  for (const path of CONTEXT_RESPONSE_PATHS) {
    const plain = url(path, false), preview = url(path);
    expect(contextRequested(plain)).toBe(false); expect(contextRequested(preview)).toBe(true);
    expect(cacheKey(plain)).not.toBe(cacheKey(preview));
    plain.searchParams.set("context", "0"); expect(contextRequested(plain)).toBe(false);
    const version = (u: URL) => dataVersion(f.db, { contextPrices: contextRequested(u) });
    const before = version(plain), optIn = version(preview);
    f.db.exec("UPDATE codex_context_state SET revision=revision+1");
    expect(version(plain)).toBe(before); expect(version(preview)).not.toBe(optIn);
  }
});

test("summary, breakdown and history preserve Standard prices and reconcile their exact priced population", async () => {
  const f = fixture();
  const before = await json(handleSummary(f.ctx, url("/api/summary?vendor=codex&group=day")));
  expect(before.context_preview_status.ready).toBe(false); expect(before.context_preview).toBeUndefined();
  f.fill(); const changes = f.db.query("SELECT total_changes() n").get();
  const summary = await json(handleSummary(f.ctx, url("/api/summary?vendor=codex&group=day")));
  const breakdown = await json(handleBreakdown(f.ctx, url("/api/breakdown?vendor=codex&dim=model")));
  const history = await json(handleAccountHistory(f.ctx, url("/api/account-history?group=day")));
  expect(summary.buckets).toEqual(before.buckets);
  expect(sum(summary.context_preview.buckets, "usd")).toBe(16.05);
  expect(sum(breakdown.context_preview.rows, "usd")).toBe(16.05);
  expect(history.context_preview.totals.priced_usd ?? history.context_preview.totals.usd).toBe(16.05);
  expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
});
test("global usage and window projects preserve actual-mode factors, unknown modes, ownership and exact edges", () => {
  const f = fixture(); f.fill();
  const global = paired(buildGlobalUsage(f.ctx, { ...f.range, vendors: ["codex"] }));
  expect(global.context_preview_status).toMatchObject({ ready: true, missing_groups: 0 });
  expect(global.rows.reduce((n, row) => n + row.api_usd.subtotal, 0)).toBeCloseTo(12.65, 12);
  expect(global.context_preview!.rows.reduce((n, row) => n + row.api_usd.subtotal, 0)).toBeCloseTo(20.05, 12);
  const request = { account: "owner", from: "2026-09-01T12:00:00.000Z", until: "2026-09-01T13:30:00.000Z" };
  const report = paired(readWindowProjects(f.ctx, request));
  expect(report.context_preview_status).toMatchObject({ ready: true, missing_groups: 0 });
  expect(sum(report.projects, "api_usd")).toBeCloseTo(5.65, 12);
  expect(sum(report.context_preview!.projects, "api_usd")).toBeCloseTo(11.05, 12);
  expect(sum(report.context_preview!.projects, "calls")).toBe(3);
});
test("events carry saved canonical identities, keep pagination and never price on a read", async () => {
  const f = fixture(); f.fill(); const before = f.db.query("SELECT total_changes() n").get();
  const events = await json(handleEvents(f.ctx, url("/api/events?vendor=codex&account=owner&order=ts_asc&limit=2")));
  expect(events.rows).toHaveLength(2);
  expect(events.rows.map((row: any) => row.usd)).toEqual([1.65, 1]);
  expect(events.context_preview.rows.map((row: any) => row.usd)).toEqual([3.05, 2]);
  expect(events.rows[0].context_price).toEqual({ base: 1.65, extra: 1.4, stored: 1.65, included: false });
  expect(events.rows[0].ledger_event_id).toBeNumber();
  expect(f.db.query("SELECT total_changes() n").get()).toEqual(before);
});
test("account/project and instant filters select the same saved contributions as a full scope", async () => {
  const f = fixture(); f.fill();
  const result = await json(handleBreakdown(f.ctx, url("/api/breakdown?vendor=codex&account=owner&dim=model&project_id=a&since_ts=2026-09-01T12:00:00.001Z&until_ts=2026-09-01T14:00:00.000Z")));
  expect(sum(result.context_preview.rows, "usd")).toBe(2);
  expect(result.context_preview_status.missing_groups).toBe(0);
});
test("accounting keeps API-only and joint credit-priced cohorts separate", () => {
  const f = fixture(); f.fill();
  const report = paired(buildCodexAccountingReport(f.db, f.rates, { ...f.range, account: "owner" }, f.ctx.homeToSubId, undefined, false,
    undefined, {}, { provider_groups: [] }, f.ctx.resolver, f.ctx.accounts.sources));
  expect(report.context_preview_status).toMatchObject({ ready: true, missing_groups: 0 });
  expect(report.context_preview!.normalization.standard_api_usd.priced_subtotal).toBeCloseTo(14.05, 12);
  expect(report.context_preview!.normalization.normalized_usd.priced_subtotal).toBeCloseTo(11, 12);
  expect(report.context_preview!.normalization.normalized_usd.unpriced_events).toBe(3);
});
test("project allocation uses preview numerator and denominator, conserves bills and catalog facts", async () => {
  const f = contextPreviewFixture(false, undefined, db => db.exec("DELETE FROM events WHERE model='missing'"));
  open.push(f); f.fill();
  const report = paired(buildProjectCost(f.db, f.rates, f.ctx.homeToSubId, { ...f.range, declarations: f.ctx.accounts.subscriptions,
    plansCatalog: f.ctx.plansCatalog }));
  expect(report.context_preview_status).toMatchObject({ ready: true, missing_groups: 0 });
  expect(report.context_preview!.totals.api_usd).toBe(16.05);
  expect(report.subscriptions.some(row => (row.paid_usd ?? 0) > 0)).toBe(true);
  expect(report.context_preview!.subjects.map(row => row.billed_usd)).not.toEqual(report.subjects.map(row => row.billed_usd));
  expect(report.context_preview!.subscriptions.map(row => row.paid_usd)).toEqual(report.subscriptions.map(row => row.paid_usd));
  for (const sub of report.subscriptions) {
    const before = sum(report.subjects.map(row => row.subscriptions[sub.id]).filter(Boolean), "billed_usd");
    const after = sum(report.context_preview!.subjects.map(row => row.subscriptions[sub.id]).filter(Boolean), "billed_usd");
    expect(after).toBeCloseTo(before, 10);
  }
  const opts = { repo: null, projectId: "a", granularity: "day" as const, by: "account" as const, idleGapMinutes: 15, ...f.range,
    rateCards: f.rates, homeToSubId: f.ctx.homeToSubId, declarations: f.ctx.accounts.subscriptions, plansCatalog: f.ctx.plansCatalog, machineOf: () => null };
  const history = paired(buildRepoHistory(f.db, opts)), cancellable = await buildRepoHistoryCancellable(f.db, opts);
  expect(cancellable).toEqual(history);
  expect(history.context_preview_status).toMatchObject({ ready: true, missing_groups: 0 });
  expect(history.context_preview!.totals.api_usd).toBe(7.05);
});
test("missing account weights withhold billed allocation in both context variants", () => {
  const f = fixture(); f.fill();
  const report = paired(buildProjectCost(f.db, f.rates, f.ctx.homeToSubId, { ...f.range, declarations: f.ctx.accounts.subscriptions,
    plansCatalog: f.ctx.plansCatalog }));
  for (const variant of [report, report.context_preview!]) {
    expect(variant.subscriptions.find(row => row.id === "owner")!.paid_usd).toBeGreaterThan(0);
    for (const subject of variant.subjects.filter(row => row.subscriptions.owner)) {
      expect(subject.subscriptions.owner!.billed_usd).toBeNull();
      expect(subject.billed_complete).toBe(false);
    }
  }
});
test("already included uplift is unchanged; projection revisions only invalidate declared responses", async () => {
  const f = fixture(true); f.fill();
  const result = await json(handleBreakdown(f.ctx, url("/api/breakdown?vendor=codex&dim=model")));
  expect(result.context_preview.rows).toEqual(result.rows);
  const independent = dataVersion(f.db), dependent = dataVersion(f.db, { contextPrices: true }), stamp = contextProjectionStamp(f.db);
  f.db.exec("UPDATE codex_context_state SET revision=revision+1");
  expect(dataVersion(f.db)).toBe(independent); expect(dataVersion(f.db, { contextPrices: true })).not.toBe(dependent);
  expect(contextProjectionStamp(f.db)).not.toBe(stamp); expect(CONTEXT_RESPONSE_PATHS.has("/api/health")).toBe(false);
});
test("unfinished and missing context prices never block reads or turn unknown uplift into zero", async () => {
  const f = contextPreviewFixture(false, rates => { delete rates.codex_ledger_policy!.base_rules[0]!.long_context!.rates.in_cache_write; });
  open.push(f);
  const endpoints = [() => handleSummary(f.ctx, url("/api/summary?vendor=codex")),
    () => handleBreakdown(f.ctx, url("/api/breakdown?vendor=codex&dim=model")),
    () => handleAccountHistory(f.ctx, url("/api/account-history")), () => handleEvents(f.ctx, url("/api/events?vendor=codex"))];
  for (const read of endpoints) {
    const body = await json(read()); expect(body.context_preview_status.ready).toBe(false); expect(body.context_preview).toBeUndefined();
  }
  const before = await json(handleBreakdown(f.ctx, url("/api/breakdown?vendor=codex&dim=model")));
  f.fill();
  const after = await json(handleBreakdown(f.ctx, url("/api/breakdown?vendor=codex&dim=model")));
  expect(after.rows).toEqual(before.rows); expect(after.context_preview_status.missing_groups).toBeGreaterThan(0);
  expect(after.context_preview.rows.find((row:any)=>row.name==="m").usd).toBeGreaterThan(before.rows.find((row:any)=>row.name==="m").usd);
  // The client declines this incomplete alternative as a whole; the API exposes why rather than calling its uplift complete.
});
test("all report builders expose preparation independently of the original ledger and preserve correction/retry results", () => {
  const f = fixture();
  const read = () => paired(readWindowProjects(f.ctx, { account: "owner", from: "2026-09-01T12:00:00.000Z", until: "2026-09-01T13:30:00.000Z" }));
  const original = read(); expect(original.context_preview_status!.ready).toBe(false);
  expect(buildGlobalUsage(f.ctx, { ...f.range, vendors: ["codex"] }).context_preview_status!.ready).toBe(false);
  expect(buildProjectCost(f.db, f.rates, f.ctx.homeToSubId, { ...f.range }).context_preview_status!.ready).toBe(false);
  expect(buildRepoHistory(f.db, { repo: null, projectId: "a", granularity: "day", by: "none", idleGapMinutes: 15,
    ...f.range, rateCards: f.rates, homeToSubId: f.ctx.homeToSubId, declarations: f.ctx.accounts.subscriptions,
    plansCatalog: f.ctx.plansCatalog, machineOf: () => null }).context_preview_status!.ready).toBe(false);
  expect(buildCodexAccountingReport(f.db, f.rates, { ...f.range, account: "owner" }, f.ctx.homeToSubId, undefined, false).context_preview_status!.ready).toBe(false);
  f.fill(); const first = read(); expect(first.context_preview_status!.ready).toBe(true);
  f.db.exec("UPDATE codex_context_state SET source_revision=source_revision+1");
  const pending = read(); expect(pending.projects).toEqual(first.projects); expect(pending.context_preview).toBeUndefined();
  f.fill(); const retry = read(); expect(retry.context_preview).toEqual(first.context_preview);
  const changes = f.db.query("SELECT total_changes() n").get();
  f.fill(); expect(read()).toEqual(retry); expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
});
test("the alternative adds only the saved unincluded uplift even if a newer rule's normal base differs", async () => {
  const f = fixture(); f.fill();
  const before = await json(handleBreakdown(f.ctx, url("/api/breakdown?vendor=codex&dim=model")));
  f.db.exec("UPDATE codex_context_aggregates SET base_n='999999999',base_d='1' WHERE reason IS NULL");
  const after = await json(handleBreakdown(f.ctx, url("/api/breakdown?vendor=codex&dim=model")));
  expect(after.rows).toEqual(before.rows); expect(after.context_preview.rows).toEqual(before.context_preview.rows);
});
test("a priced zero Standard value can gain a positive saved uplift without a ratio", async () => {
  const f = contextPreviewFixture(false, rates => { rates.codex_ledger_policy!.base_rules[0]!.rates = {
    in_uncached: "0", in_cache_read: "0", in_cache_write: "0", out_total: "0" }; }); open.push(f); f.fill();
  const result = await json(handleBreakdown(f.ctx, url("/api/breakdown?vendor=codex&dim=model")));
  expect(result.rows.find((row:any)=>row.name==="m").usd).toBe(0);
  expect(result.context_preview.rows.find((row:any)=>row.name==="m").usd).toBeGreaterThan(0);
  expect(result.context_preview_status.missing_groups).toBe(0);
});
test("a published context rule invalidates responses before the first context background turn", async () => {
  const f = fixture(); f.fill(); const stamp = contextProjectionStamp(f.db);
  const policy = JSON.parse((f.db.query("SELECT rules_json FROM usage_ledger_state WHERE provider='codex'").get() as {rules_json:string}).rules_json);
  policy.base_rules[0].long_context.rates.in_uncached = "4";
  f.db.query("UPDATE usage_ledger_state SET rules_json=? WHERE provider='codex'").run(JSON.stringify(policy));
  expect(contextProjectionStamp(f.db)).not.toBe(stamp);
  const report = await json(handleSummary(f.ctx, url("/api/summary?vendor=codex")));
  expect(report.context_preview_status.ready).toBe(false); expect(report.context_preview).toBeUndefined();
});
test("a yielded history never pairs reports from different projection publications", async () => {
  const f = fixture(); f.fill(); let changed = false;
  const result = await buildRepoHistoryCancellable(f.db, { repo: null, projectId: "a", granularity: "day", by: "none", idleGapMinutes: 15,
    ...f.range, rateCards: f.rates, homeToSubId: f.ctx.homeToSubId, declarations: f.ctx.accounts.subscriptions,
    plansCatalog: f.ctx.plansCatalog, machineOf: () => null }, { onCheckpoint() {
      if (!changed) { changed = true; f.db.exec("UPDATE codex_context_state SET revision=revision+1"); }
    } });
  expect(changed).toBe(true); expect(result.context_preview).toBeUndefined(); expect(result.context_preview_status!.ready).toBe(false);
});
