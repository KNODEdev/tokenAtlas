import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { handleActivity, handleHealth, handleProjectCost, handleProjectsRows, handleSummary, type AppContext } from "./api";
import { buildEraIndex } from "./eras";
import type { RateCard } from "./pricing";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { ledgerSumsCurrent, localHour, readLedgerSums, readLedgerTotals, sumTokens } from "./ledger-sums";

const CARD = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../../rate-cards.json"), "utf8")) as RateCard;
const CLAUDE = `${ARCHIVE_LOGICAL_ROOT}/claude/PC-A`;
const CODEX = `${ARCHIVE_LOGICAL_ROOT}/codex/PC-A-user`;
const RETIRED = ["usage_daily_rollups", "project_daily_rollups", "hourly_activity_rollups", "codex_cycle_rollups",
  "subscription_usage_daily", "rollup_coverage"];
const databases: Database[] = [];
const zone = process.env.TZ;
afterEach(() => {
  for (const db of databases.splice(0)) db.close(true);
  if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
});

let callId = 0;
function database(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  applyDrizzleMigrations(drizzle(db));
  db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT,
    model TEXT, effort TEXT, project TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
    reasoning_out INTEGER, cwd TEXT, project_id TEXT)`);
  return db;
}
function claude(db: Database, row: { ts: string; uncached: number; out?: number; project?: string | null; cwd?: string }): void {
  db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,speed,in_uncached,out_total,project_id,project,cwd)
    VALUES ('live',?,?,?,?,'claude-opus-5','standard',?,?,?,?,?)`).run(`call-${++callId}`, `session-${callId}`,
    `${CLAUDE}/H---work/${callId}.jsonl`, row.ts, row.uncached, row.out ?? 0, row.project ?? null,
    row.project ? `${row.project}-name` : null, row.cwd ?? null);
}
function context(db: Database): AppContext {
  return { sqlite: db, rateCards: CARD, accounts: { subscriptions: [], sources: [] }, homeToSubId: new Map(), subIdToHomes: new Map(),
    eras: buildEraIndex([]), eraErrors: [], homeConflict: null, claudeGauge: {}, grokGauge: {}, plans: { segments: [] },
    plansCatalog: { provider_groups: [] } } as unknown as AppContext;
}
const get = async (response: Response | Promise<Response>) => {
  const resolved = await response;
  expect(resolved.status).toBe(200);
  return await resolved.json() as Record<string, any>;
};

test("summary, activity, project rows, project cost and health answer from the ledgers, with no summary table left", async () => {
  const db = database();
  claude(db, { ts: "2026-09-10T10:00:00.000Z", uncached: 1_000_000, out: 100_000, project: "alpha", cwd: "C:/work/alpha" });
  db.query(`INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,cwd,project,project_id)
    VALUES (?,?,'2026-09-10T11:00:00.000Z','gpt-5',300,100,0,50,0,'C:/work/alpha','alpha-name','alpha')`).run(CODEX, `${CODEX}/sessions/a.jsonl`);
  db.exec(`INSERT INTO oc_events(store,message_id,ts,model,provider,in_tok,out_tok,cache_read,cache_write)
      VALUES ('oc','m1','2026-09-10T12:00:00.000Z','mystery-model','openrouter',10,20,30,40);
    INSERT INTO gemini_events(store,conversation_id,gen_idx,ts,ts_basis,path,model,fresh_in,cached_in,out_total)
      VALUES ('gemini','g',0,'2026-09-10T13:00:00.000Z','event','${ARCHIVE_LOGICAL_ROOT}/gemini/profile/a','gemini-unpriced',5,6,7)`);
  prepareUsageRegisters(db, CARD);
  const ctx = context(db);
  expect(db.query(`SELECT name FROM sqlite_master WHERE name IN (${RETIRED.map(() => "?").join(",")})`).all(...RETIRED)).toEqual([]);

  const claudeDay = await get(handleSummary(ctx, new URL("http://test/api/summary?vendor=claude&group=day")));
  expect(claudeDay.buckets).toHaveLength(1);
  expect(claudeDay.buckets[0]).toMatchObject({ bucket: "2026-09-10", calls: 1,
    claude: { calls: 1, tokens: { in_uncached: 1_000_000, out_total: 100_000, total: 1_100_000 } } });
  // The ledger's stored valuation at the dated standard rates: 1M input at $5 and 0.1M output at $25.
  expect(claudeDay.buckets[0].claude.usd).toBeCloseTo(7.5, 9);
  const both = await get(handleSummary(ctx, new URL("http://test/api/summary?vendor=both&group=month&project_id=alpha")));
  expect(both.buckets[0]).toMatchObject({ bucket: "2026-09", claude: { calls: 1 }, codex: { calls: 1, tokens: { in_tok: 300, out_tok: 50 } } });
  const unassigned = await get(handleSummary(ctx, new URL("http://test/api/summary?vendor=both&project_id=unassigned")));
  expect(unassigned.buckets).toEqual([]);

  const activity = await get(handleActivity(ctx, new URL("http://test/api/activity?vendor=all")));
  expect(activity.totals.calls).toBe(4);
  expect(activity.burn.anchor_ts).toBe("2026-09-10T11:00:00.000Z");

  const rows = await get(handleProjectsRows(ctx, new URL("http://test/api/projects/rows?project_id=alpha")));
  expect(rows.rows.map((row: any) => [row.vendor, row.cwd, row.project, row.calls]).sort()).toEqual([
    ["claude", "C:/work/alpha", "alpha-name", 1], ["codex", "C:/work/alpha", "alpha-name", 1]]);

  const cost = await get(handleProjectCost(ctx, new URL("http://test/api/project-cost?since=2026-09-10&until=2026-09-10")));
  expect(cost.coverage.unattributable).toMatchObject({ vendor: "gemini", tokens: 18, calls: 1 });
  // OpenCode output carries its reasoning, a cache write of unknown duration counts as input.
  expect(cost.coverage.unpriced.models["mystery-model"]).toBe(100);

  const health = await get(handleHealth(ctx));
  expect(health.rollups).toMatchObject({ current: true, stale: false, status: "current" });
  // OpenRouter has no rate card: listed as unpriceable, never as a model the user can price.
  expect(health.unpriced.models["mystery-model"]).toBeUndefined();
  expect(health.unpriced.items).toContainEqual(expect.objectContaining({ model: "mystery-model", tokens: 100, observed_provider: "openrouter", reason: "no_rate_card" }));
  expect(health.unpriced.models["gemini-unpriced"]).toMatchObject({ tokens: 18, observed_provider: "google" });
});

test("an unbuilt ledger makes the sums wait; a published one behind its facts answers from its rows, never from the event tables", async () => {
  const db = database();
  claude(db, { ts: "2026-09-10T10:00:00.000Z", uncached: 10 });
  expect(() => readLedgerSums(db, { vendors: ["claude"], grain: "day" })).toThrow("await background preparation");
  prepareUsageRegisters(db, CARD);
  claude(db, { ts: "2026-09-11T10:00:00.000Z", uncached: 20 });
  // The journal names a fact the producer has not replayed yet: the published day sums answer.
  const sums = () => readLedgerSums(db, { vendors: ["claude"], grain: "day" }).map(row => [row.day, row.uncached]).sort();
  expect(sums()).toEqual([["2026-09-10", 10]]);
  expect(ledgerSumsCurrent(db)).toBe(false);
  prepareUsageRegisters(db, CARD);
  expect(sums()).toEqual([["2026-09-10", 10], ["2026-09-11", 20]]);
  expect(ledgerSumsCurrent(db)).toBe(true);
});

test("the weekday and hour map is local time across both DST changes", async () => {
  process.env.TZ = "Europe/Warsaw";
  const db = database();
  // Spring: 00:30Z is 01:30 CET, 01:30Z is 03:30 CEST. The 23:30Z call of Saturday is already Sunday locally.
  for (const ts of ["2026-03-28T23:30:00.000Z", "2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z",
    // Autumn: 00:30Z is 02:30 CEST and 01:30Z is 02:30 CET, the repeated hour.
    "2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]) claude(db, { ts, uncached: 10, out: 1 });
  prepareUsageRegisters(db, CARD);
  expect(localHour(Date.parse("2026-03-29T01:30:00.000Z") / 3_600_000)).toEqual({ day: "2026-03-29", dow: 0, hour: 3 });
  const cells = async (query: string) => (await get(handleActivity(context(db), new URL(`http://test/api/activity?vendor=claude${query}`))))
    .cells.map((cell: any) => [cell.dow, cell.hour, cell.calls, cell.tokens, cell.tokens_fresh]);
  // Monday is 0, so Sunday is 6.
  expect(await cells("&since=2026-03-29&until=2026-03-29")).toEqual([[6, 0, 1, 11, 11], [6, 1, 1, 11, 11], [6, 3, 1, 11, 11]]);
  expect(await cells("")).toEqual([[6, 0, 1, 11, 11], [6, 1, 1, 11, 11], [6, 2, 2, 22, 22], [6, 3, 1, 11, 11]]);
});

test("an incremental change re-aggregates its days to the result of a full refill, in day and hour sums alike", () => {
  const db = database();
  claude(db, { ts: "2026-09-10T10:15:00.000Z", uncached: 100, out: 10, project: "alpha" });
  claude(db, { ts: "2026-09-10T10:45:00.000Z", uncached: 200, out: 20, project: "alpha" });
  claude(db, { ts: "2026-09-11T08:00:00.000Z", uncached: 300, out: 30 });
  prepareUsageRegisters(db, CARD);
  db.exec("UPDATE claude_events SET in_uncached=150 WHERE in_uncached=100");
  claude(db, { ts: "2026-09-12T23:59:59.000Z", uncached: 400, out: 40, project: "beta" });
  prepareUsageRegisters(db, CARD);
  const state = () => ({
    days: readLedgerSums(db, { vendors: ["claude"], grain: "day" }).map(({ day, project_id, calls, uncached, out, first_ts, last_ts }) =>
      ({ day, project_id, calls, uncached, out, first_ts, last_ts })).sort((a, b) => a.day.localeCompare(b.day)),
    hours: readLedgerSums(db, { vendors: ["claude"], grain: "hour" }).map(({ day, hour, project_id, calls, uncached }) =>
      ({ day, hour, project_id, calls, uncached })).sort((a, b) => a.hour! - b.hour!),
  });
  const incremental = state();
  expect(incremental.days).toEqual([
    { day: "2026-09-10", project_id: "alpha", calls: 2, uncached: 350, out: 30, first_ts: "2026-09-10T10:15:00.000Z", last_ts: "2026-09-10T10:45:00.000Z" },
    { day: "2026-09-11", project_id: null, calls: 1, uncached: 300, out: 30, first_ts: "2026-09-11T08:00:00.000Z", last_ts: "2026-09-11T08:00:00.000Z" },
    { day: "2026-09-12", project_id: "beta", calls: 1, uncached: 400, out: 40, first_ts: "2026-09-12T23:59:59.000Z", last_ts: "2026-09-12T23:59:59.000Z" },
  ]);
  expect(incremental.hours.map(row => [row.day, row.hour! % 24, row.calls, row.uncached])).toEqual([
    ["2026-09-10", 10, 2, 350], ["2026-09-11", 8, 1, 300], ["2026-09-12", 23, 1, 400]]);
  for (const table of ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_hours", "usage_ledger_day_reasons", "usage_ledger_dirty",
    "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_state"]) db.exec(`DELETE FROM ${table} WHERE provider<>'codex'`);
  prepareUsageRegisters(db, CARD);
  expect(state()).toEqual(incremental);
  // Every canonical call of a day is in exactly one of its hours.
  expect(db.query(`SELECT day, SUM(calls - conflicts) calls, SUM(t_uncached) uncached FROM usage_ledger_days GROUP BY day ORDER BY day`).all())
    .toEqual(db.query(`SELECT day, SUM(calls) calls, SUM(t_uncached) uncached FROM usage_ledger_hours GROUP BY day ORDER BY day`).all());
});

test("project totals are the day sums added up by vendor and project", () => {
  const db = database();
  claude(db, { ts: "2026-09-10T10:00:00.000Z", uncached: 1_000, out: 100, project: "alpha" });
  claude(db, { ts: "2026-09-11T10:00:00.000Z", uncached: 2_000, out: 200, project: "alpha", cwd: "C:/work/alpha/sub" });
  claude(db, { ts: "2026-09-12T10:00:00.000Z", uncached: 3_000 });
  for (const [ts, project] of [["2026-09-09T11:00:00.000Z", "alpha"], ["2026-09-13T11:00:00.000Z", null], ["2026-09-14T11:00:00.000Z", "beta"]] as Array<[string, string | null]>)
    db.query(`INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,project_id)
      VALUES (?,?,?,'gpt-5',300,100,0,50,0,?)`).run(CODEX, `${CODEX}/sessions/${ts}.jsonl`, ts, project);
  prepareUsageRegisters(db, CARD);
  const vendors = ["claude", "codex", "opencode"];
  const expected = new Map<string, { vendor: string; project_id: string | null; calls: number; tokens: number; first_ts: string; last_ts: string }>();
  for (const row of readLedgerSums(db, { vendors, grain: "day" })) {
    const key = JSON.stringify([row.vendor, row.project_id]), total = expected.get(key)
      ?? { vendor: row.vendor, project_id: row.project_id, calls: 0, tokens: 0, first_ts: row.first_ts, last_ts: row.last_ts };
    total.calls += row.calls; total.tokens += sumTokens(row).gross;
    if (row.first_ts < total.first_ts) total.first_ts = row.first_ts;
    if (row.last_ts > total.last_ts) total.last_ts = row.last_ts;
    expected.set(key, total);
  }
  const order = (rows: Array<{ vendor: string; project_id: string | null }>) => [...rows].sort((a, b) =>
    JSON.stringify([a.vendor, a.project_id]).localeCompare(JSON.stringify([b.vendor, b.project_id])));
  expect(expected.size).toBe(5);
  expect(order(readLedgerTotals(db, vendors, "project_id").map(({ key, ...total }) => ({ ...total, project_id: key }))))
    .toEqual(order([...expected.values()]));
});

test("each Claude account's rows, first and last row from the ledger equal grouping every event by its account", async () => {
  const { claudeAccountHistoryFromLedger, claudeEventAccountSql } = await import("./claude-event-account");
  const { loadAccountResolver } = await import("./account-resolver");
  const { requireUsageLedgerSums } = await import("./ledger-sums");
  const db = database();
  // Account a until noon of the 10th, then b; an identity row belongs to its identity's account, a conflicted one to nobody.
  db.exec(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,evidence) VALUES
    ('claude','claude/pc-a','2026-09-01T00:00:00.000Z','2026-09-10T12:00:00.000Z','claude-a','declared','test'),
    ('claude','claude/pc-a','2026-09-10T12:00:00.000Z',NULL,'claude-b','declared','test')`);
  for (const ts of ["2026-09-09T10:00:00.000Z", "2026-09-10T06:00:00.000Z", "2026-09-10T18:00:00.000Z", "2026-09-11T10:00:00.000Z",
    "2026-08-20T10:00:00.000Z"]) claude(db, { ts, uncached: 10 });
  claude(db, { ts: "2026-09-11T11:00:00.000Z", uncached: 10 });
  db.query("UPDATE claude_events SET account_key='claude:org:user' WHERE ts='2026-09-11T11:00:00.000Z'").run();
  claude(db, { ts: "2026-09-12T11:00:00.000Z", uncached: 10 });
  db.query("UPDATE claude_events SET account_key='claude:org:other', subscription_conflict=1 WHERE ts='2026-09-12T11:00:00.000Z'").run();
  prepareUsageRegisters(db, CARD);
  const resolver = loadAccountResolver(db);
  const account = claudeEventAccountSql(db, resolver, {});
  const events = db.query(`SELECT id,count(*) n,min(ts) first,max(ts) last FROM (SELECT ${account.sql} id,ts FROM claude_events)
    WHERE id IS NOT NULL GROUP BY id`).all(...account.params) as Array<{ id: string; n: number; first: string; last: string }>;
  const ledger = claudeAccountHistoryFromLedger(db, resolver, () => requireUsageLedgerSums(db, "claude"));
  const order = (rows: Array<{ id: string }>) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  expect(events.map(row => row.id).sort()).toEqual(["claude-a", "claude-b", resolver.identityAccount("claude", "claude:org:user")!].sort());
  expect(order(ledger!)).toEqual(order(events));
});
