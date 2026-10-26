import { afterEach, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { installAnalysisTracking } from "../db/analysis";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { handleAccountHistory, handleActivity, handleBreakdown, handleCache, handleCompare, handleModelSpeed, type AppContext } from "./api";
import { buildEraIndex } from "./eras";
import type { RateCard } from "./pricing";
import { declareClaudeLabelPeriods } from "./subscription-reader.fixture";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { buildRepoHistory, listSubjects } from "./repo-history";
import { overrideProjectRules, projectRulesOverride } from "../projects/resolve";

/**
 * Screens that used to total the provider fact tables read the usage ledger (plan U4.7 legacy
 * readers): each call once (its canonical copy), at its stored valuation, and nothing here reads a
 * fact table while answering.
 */
const cards: RateCard = {
  version: 1, currency: "USD", unit: "per 1M",
  vendors: {
    anthropic: { models: { test: { in_uncached: 2, in_cache_read: 1, in_cache_write_5m: 3, in_cache_write_1h: 4, out_total: 8,
      fast: { in_uncached: 12, in_cache_read: 6, in_cache_write_5m: 18, in_cache_write_1h: 24, out_total: 48 } } } },
    google: { models: { "gemini-x": { in_uncached: 1, in_cache_read: 0.5, out_total: 4 } } },
  },
} as RateCard;
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(true); });

function fixture(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  applyDrizzleMigrations(drizzle(db));
  db.exec(`
    INSERT INTO claude_events (store, call_id, ts, path, subscription_id, model, speed, in_uncached, in_cache_read,
                               in_cache_write, cache_write_5m, cache_write_1h, out_total, project_id)
      VALUES ('pc', 'c1', '2026-08-10T10:00:00.000Z', 'a.jsonl', 'claude1', 'test', 'standard', 100, 20, 30, 10, 20, 50, 'p1'),
             -- A second copy of the same call: counted once.
             ('laptop', 'c1', '2026-08-10T10:00:00.000Z', 'b.jsonl', 'claude1', 'test', 'standard', 100, 20, 30, 10, 20, 50, 'p1'),
             ('pc', 'c2', '2026-08-11T09:00:00.000Z', 'a.jsonl', 'claude1', 'test', 'fast', 10, 0, 0, 0, 0, 5, NULL),
             ('pc', 'c3', '2026-08-11T12:00:00.000Z', 'a.jsonl', 'claude1', 'other', 'standard', 7, 0, 0, 0, 0, 3, NULL);
    INSERT INTO gemini_events (store, conversation_id, gen_idx, ts, ts_basis, path, model, fresh_in, cached_in, out_total, out_thinking, usd)
      VALUES ('source:gemini:profile', 'g', 0, '2026-08-10T10:00:00.000Z', 'event', '${ARCHIVE_LOGICAL_ROOT}/gemini/profile/a', 'gemini-x', 1000, 2000, 300, 100, 99);
    INSERT INTO grok_events (store, session_id, prompt_id, ts, path, model, in_tok, cached_in, cache_write, out_tok, reasoning, model_calls, cost_ticks)
      VALUES ('source:grok:profile', 's', 'p', '2026-08-10T10:00:00.000Z', '${ARCHIVE_LOGICAL_ROOT}/grok/profile/a', 'grok-4', 44, 5, 6, 7, 2, 3, 2500000000);
    INSERT INTO oc_events (store, message_id, ts, model, provider, in_tok, out_tok, reasoning, cache_read, cache_write, cost)
      VALUES ('oc1', 'm1', '2026-08-10T10:00:00.000Z', 'glm-4', 'zai', 10, 20, 4, 30, 40, 0.75),
             ('oc1', 'm2', '2026-08-10T11:00:00.000Z', 'claude-x', 'anthropic', 1, 2, 0, 3, 4, 0.25);
  `);
  declareClaudeLabelPeriods(db);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [...loadPeriods(db, ACCOUNT_PERIODS).filter(row => row.origin === "declared"),
    ...[{ provider: "gemini", subject: "gemini/profile", value: "agy1" }, { provider: "grok", subject: "grok/profile", value: "grok1" },
      { provider: "glm", subject: "glm/oc1", value: "glm" }].map(row => ({ ...row, from: "2000-01-01", until: null,
      origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }))]);
  prepareUsageRegisters(db, cards);
  return db;
}
function context(db: Database): AppContext {
  return { sqlite: db, rateCards: cards, accounts: { version: 2, subscriptions: [], sources: [] }, homeToSubId: new Map(),
    subIdToHomes: new Map(), eras: buildEraIndex([]), eraErrors: [], homeConflict: null, claudeGauge: {}, grokGauge: {}, cycles: {},
    plans: {}, plansCatalog: { provider_groups: [] }, rootDir: process.cwd() } as unknown as AppContext;
}
/** Fails the read if it touches a provider fact table. */
function noFactScan(db: Database): Database {
  // The proxy reads with the rules of the database it wraps.
  const rules = projectRulesOverride(db), proxy = new Proxy(db, { get(target, property) {
    if (property === "query") return (sql: string) => {
      // A presence check (`SELECT 1 ... LIMIT 1`) is not a read of facts.
      if (/\b(?:FROM|JOIN)\s+(?:events|claude_events|gemini_events|grok_events|oc_events)\b/i.test(sql)
        && !/^SELECT 1 FROM \w+ LIMIT 1$/.test(sql.trim())) throw new Error(`fact scan: ${sql}`);
      return target.query(sql);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  if (rules) overrideProjectRules(proxy, rules);
  return proxy;
}
const url = (path: string) => new URL(`http://test${path}`);
type BreakdownBody = { rows: Array<{ name: string; vendor: string; calls: number; usd: number; tokens: number; token_details: Record<string, number> }>;
  totals: { calls: number; usd: number; tokens: number }; unpriced: { tokens: number; models: Record<string, number> } };

test("breakdown by model totals each provider's calls once from the usage ledger", async () => {
  const db = fixture(), ctx = { ...context(db), sqlite: noFactScan(db) };
  const body = await handleBreakdown(ctx, url("/api/breakdown?dim=model&vendor=all")).json() as BreakdownBody;
  const row = (vendor: string, name: string) => body.rows.find(item => item.vendor === vendor && item.name === name)!;
  // c1 (standard, once): 100*2+20*1+10*3+20*4+50*8 = 730; c2 (fast): 10*12+5*48 = 360 -> 1090 / 1e6.
  expect(row("claude", "test")).toMatchObject({ calls: 2, tokens: 215, usd: 0, token_details: { in_uncached: 110, in_cache_read: 20,
    in_cache_write: 30, cache_write_5m: 10, cache_write_1h: 20, out_total: 55 } });
  // c3 has no rate: its tokens are unpriced.
  expect(row("claude", "other")).toMatchObject({ calls: 1, tokens: 10, usd: 0 });
  expect(body.unpriced.models.other).toBe(10);
  // Gemini at its stored valuation: 1000*1 + 2000*0.5 + 300*4 = 3200 / 1e6.
  expect(row("gemini", "gemini-x")).toMatchObject({ calls: 1, tokens: 3300,
    token_details: { in_uncached: 1000, in_cache_read: 2000, out_total: 300, out_thinking: 100, fresh_in: 1000 } });
  // Grok and OpenCode show the money they recorded themselves.
  expect(row("grok", "grok-4")).toMatchObject({ calls: 1, tokens: 51, usd: 2.5,
    token_details: { in_uncached: 39, in_cache_read: 5, in_cache_write: 6, out_total: 7, out_thinking: 2, fresh_in: 39 } });
  expect(row("opencode", "glm-4")).toMatchObject({ calls: 1, tokens: 100, usd: 0.75,
    token_details: { in_uncached: 10, in_cache_read: 30, in_cache_write: 40, out_total: 20, out_thinking: 4 } });
  expect(row("opencode", "claude-x")).toMatchObject({ calls: 1, tokens: 10, usd: 0.25 });
  expect(body.totals.calls).toBe(7);
  // An instant range reads the facts of the range from the ledger.
  const window = await handleBreakdown(ctx, url("/api/breakdown?dim=model&vendor=claude&since_ts=2026-08-11T08:00:00Z&until_ts=2026-08-11T10:00:00Z")).json() as BreakdownBody;
  expect(window.rows).toEqual([expect.objectContaining({ name: "test", calls: 1, tokens: 15 })]);
  // Project filter and dimension.
  const projects = await handleBreakdown(ctx, url("/api/breakdown?dim=project&vendor=claude&project_id=p1")).json() as BreakdownBody;
  expect(projects.rows.map(item => [item.name, item.calls, item.tokens])).toEqual([["p1", 1, 200]]);
});

test("compare and cache read Claude windows and bucket costs from the usage ledger", async () => {
  const db = fixture(), ctx = { ...context(db), sqlite: noFactScan(db) };
  const compare = await handleCompare(ctx, url("/api/compare?vendor=claude&a_since=2026-08-10&a_until=2026-08-10&b_since=2026-08-11&b_until=2026-08-11"))
    .json() as { window_a: { calls: number; tokens: number; usd: number }; window_b: { calls: number; tokens: number; usd: number } };
  expect(compare.window_a).toMatchObject({ calls: 1, tokens: 200, usd: 0 });
  expect(compare.window_b).toMatchObject({ calls: 2, tokens: 25, usd: 0 });
  const cache = await handleCache(ctx, url("/api/cache?vendor=claude")).json() as { claude: { tokens: Record<string, number>;
    usd: Record<string, number>; cost_savings_usd: number } };
  expect(cache.claude.tokens).toEqual({ in_uncached: 117, in_cache_read: 20, cache_write_5m: 10, cache_write_1h: 20, in_cache_write: 30,
    out_total: 58, total_input: 167, total: 225 });
  expect(cache.claude.usd).toEqual({ in_uncached: 0, in_cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, in_cache_write: 0, out_total: 0, total: 0 });
});

test("ledger valuations survive rounding: dollars in the cents range", async () => {
  // Scaled-up copy of c1 so the stored valuation is visible after rounding to cents.
  const db = fixture();
  db.exec("UPDATE claude_events SET in_uncached=in_uncached*10000, out_total=out_total*10000 WHERE call_id='c1'");
  prepareUsageRegisters(db, cards);
  const ctx = { ...context(db), sqlite: noFactScan(db) };
  const body = await handleBreakdown(ctx, url("/api/breakdown?dim=model&vendor=claude")).json() as BreakdownBody;
  // c1: 1_000_000*2 + 20 + 30 + 80 + 500_000*8 = 6_000_130 -> 6.00; c2 fast 360 -> 0.00036.
  expect(body.rows.find(item => item.name === "test")?.usd).toBe(6);
  const cache = await handleCache(ctx, url("/api/cache?vendor=claude")).json() as { claude: { usd: Record<string, number>; cost_savings_usd: number } };
  expect(cache.claude.usd.in_uncached).toBe(2);
  expect(cache.claude.usd.out_total).toBe(4);
});

test("account history totals Gemini, OpenCode and Grok from the usage ledger", async () => {
  const db = fixture(), ctx = { ...context(db), sqlite: noFactScan(db) };
  const body = await handleAccountHistory(ctx, url("/api/account-history?group=day")).json() as { accounts: Array<{ id: string; vendor: string;
    tokens: number; calls: number; usd: number | null; first_ts: string | null }> };
  const account = (id: string) => body.accounts.find(row => row.id === id);
  expect(account("source:gemini:profile")).toMatchObject({ vendor: "gemini", tokens: 3300, calls: 1, first_ts: "2026-08-10T10:00:00.000Z" });
  // OpenCode counts visible output once (its output total includes reasoning) and shows its own cost.
  expect(account("opencode")).toMatchObject({ vendor: "opencode", tokens: 110, calls: 2, usd: 1 });
  expect(account("grok")).toMatchObject({ vendor: "grok", tokens: 57, calls: 1, usd: 2.5 });
});

test("a Claude account's activity splits an hour a period boundary cuts, exactly at the boundary", async () => {
  const db = fixture();
  // Same place of call as c1 (model, mode, project): one hour row holds both calls.
  db.exec(`INSERT INTO claude_events (store, call_id, ts, path, subscription_id, model, speed, in_uncached, out_total, project_id)
    VALUES ('pc', 'late', '2026-08-10T10:45:00.000Z', 'a.jsonl', 'claude1', 'test', 'standard', 1, 1, 'p1')`);
  declareClaudeLabelPeriods(db);
  const folder = loadPeriods(db, ACCOUNT_PERIODS).find(row => row.value === "claude1")!;
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [...loadPeriods(db, ACCOUNT_PERIODS).filter(row => row.origin === "declared" && row.value !== "claude1"),
    { ...folder, until: "2026-08-10T10:30:00.000Z" }, { ...folder, value: "claude9", from: "2026-08-10T10:30:00.000Z", until: null }]);
  prepareUsageRegisters(db, cards);
  const accounts = { version: 2 as const, subscriptions: [{ id: "claude1", vendor: "claude" }, { id: "claude9", vendor: "claude" }], sources: [] };
  const ctx = { ...context(db), sqlite: noFactScan(db), accounts };
  const read = async (account: string) => (await handleActivity(ctx, url(`/api/activity?account=${account}`)).json() as
    { totals: { calls: number; tokens: number } }).totals;
  // c1 at 10:00 stays with claude1; the 10:45 call of the same hour and the later calls belong to claude9.
  expect(await read("claude1")).toMatchObject({ calls: 1, tokens: 200 });
  expect(await read("claude9")).toMatchObject({ calls: 3, tokens: 27 });
  const hours = db.query("SELECT calls FROM usage_ledger_hours WHERE provider='claude' AND day='2026-08-10'").all();
  expect(hours).toEqual([{ calls: 2 }]);
});

test("model speed of a Claude account reads its owned hours, split exactly at a period boundary, without a fact scan", async () => {
  const db = fixture();
  db.exec(`UPDATE claude_events SET resp_ms = 1000 WHERE call_id = 'c1';
    UPDATE claude_events SET resp_ms = 4000 WHERE call_id = 'c2';
    INSERT INTO claude_events (store, call_id, ts, path, subscription_id, model, speed, in_uncached, out_total, project_id, resp_ms)
      VALUES ('pc', 'late', '2026-08-10T10:45:00.000Z', 'a.jsonl', 'claude1', 'test', 'standard', 1, 300, 'p1', 600)`);
  declareClaudeLabelPeriods(db);
  const folder = loadPeriods(db, ACCOUNT_PERIODS).find(row => row.value === "claude1")!;
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [...loadPeriods(db, ACCOUNT_PERIODS).filter(row => row.origin === "declared" && row.value !== "claude1"),
    { ...folder, until: "2026-08-10T10:30:00.000Z" }, { ...folder, value: "claude9", from: "2026-08-10T10:30:00.000Z", until: null }]);
  prepareUsageRegisters(db, cards);
  const accounts = { version: 2 as const, subscriptions: [{ id: "claude1", vendor: "claude" }, { id: "claude9", vendor: "claude" }], sources: [] };
  const ctx = { ...context(db), sqlite: noFactScan(db), accounts };
  type Body = { grain: string; long_out_min: number; models: Array<{ model: string; total: Record<string, number | null>;
    points: Array<Record<string, number | string | null>> }> };
  const read = async (query: string) => (await handleModelSpeed(ctx, url(`/api/model-speed?${query}`)).json()) as Body;
  // c1 (10:00, one call of its two copies) stays with claude1.
  const first = await read("account=claude1&grain=hour");
  expect(first.models.map(model => [model.model, model.total.calls, model.total.timed_calls, model.total.timed_out, model.total.timed_ms]))
    .toEqual([["test", 1, 1, 50, 1000]]);
  expect(first.models[0]!.total.speed).toBe(50);
  expect(first.models[0]!.points.map(point => point.at)).toEqual(["2026-08-10T10:00:00.000Z"]);
  // The 10:45 call of the same hour belongs to claude9: a long call (300 out), timed; c3 has no time.
  const ninth = await read("account=claude9");
  const byModel = Object.fromEntries(ninth.models.map(model => [model.model, model.total]));
  expect(byModel.test).toMatchObject({ calls: 2, timed_calls: 2, timed_out: 305, timed_ms: 4600, long_calls: 1, long_out: 300, long_ms: 600,
    long_speed: 500, coverage: 1 });
  expect(byModel.other).toMatchObject({ calls: 1, timed_calls: 0, speed: null, coverage: 0 });
  expect(ninth.long_out_min).toBe(256);
  expect(ninth.models.find(model => model.model === "test")!.points.map(point => point.at)).toEqual(["2026-08-10", "2026-08-11"]);
  expect((await handleModelSpeed(ctx, url("/api/model-speed"))).status).toBe(400);
  expect((await handleModelSpeed(ctx, url("/api/model-speed?account=nobody"))).status).toBe(400);
  expect((await handleModelSpeed(ctx, url("/api/model-speed?account=claude1&grain=week"))).status).toBe(400);
});

test("repository history and its subject list read OpenCode's other providers from the usage ledger, gaps per session", () => {
  const db = fixture();
  const columns = new Set((db.query("PRAGMA table_info(oc_events)").all() as Array<{ name: string }>).map(row => row.name));
  for (const column of ["repo", "repo_group"]) if (!columns.has(column)) db.exec(`ALTER TABLE oc_events ADD COLUMN ${column} TEXT`);
  // The change journal records the new columns from here on, as after the project remap.
  installAnalysisTracking(db);
  db.exec(`INSERT INTO oc_events (store, message_id, session_id, ts, model, provider, in_tok, out_tok, reasoning, cache_read, cache_write, cost, repo, repo_group)
    VALUES ('oc1', 'r1', 's1', '2026-08-12T12:00:00.000Z', 'claude-x', 'anthropic', 10, 2, 0, 0, 0, 0.1, 'repo-x', 'g'),
           ('oc1', 'r2', 's1', '2026-08-12T12:05:00.000Z', 'claude-x', 'anthropic', 10, 2, 0, 0, 0, 0.1, 'repo-x', 'g'),
           ('oc1', 'r3', 's2', '2026-08-12T13:00:00.000Z', 'claude-x', 'anthropic', 10, 2, 0, 0, 0, 0.1, 'repo-x', 'g'),
           -- A GLM plan call belongs to the GLM provider history, not to this source.
           ('oc1', 'r4', 's1', '2026-08-12T12:10:00.000Z', 'glm-4', 'zai', 10, 2, 0, 0, 0, 0.1, 'repo-x', 'g')`);
  prepareUsageRegisters(db, cards);
  const history = buildRepoHistory(noFactScan(db), { repo: "repo-x", projectId: null, granularity: "day", by: "vendor", idleGapMinutes: 15,
    since: "2026-08-12", until: "2026-08-12", rateCards: cards, homeToSubId: new Map(), declarations: [] });
  // Three other-provider calls of 12 tokens; 300 s between the two calls of session s1, none across sessions.
  expect(history.points.find(point => point.bucket === "2026-08-12")?.split?.opencode).toEqual({ tokens: 36, calls: 3, active_seconds: 300 });
  const subjects = listSubjects(noFactScan(db), 15, { since: "2026-08-12", until: "2026-08-12" }, { rateCards: cards, declarations: [], homeToSubId: new Map() });
  expect(subjects.find(row => row.id === "repo-x")).toMatchObject({ kind: "repo", group: "g" });
});
