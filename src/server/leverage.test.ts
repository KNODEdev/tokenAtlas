import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { ACCOUNT_PERIODS, PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { loadAccountResolver } from "./account-resolver";
import { buildLeverage } from "./leverage";
import { handleAccountHistory, handleLeverage, type AppContext } from "./api";
import { buildDataView } from "./data-views";
import { prepareUsageRegisters } from "./usage-register.fixture";
import type { RateCard } from "./pricing";
import type { PlansCatalog } from "./plans-catalog";
import type { DatedPeriod } from "./account-periods";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = `${ARCHIVE_LOGICAL_ROOT}/claude/pc`;
const codexHome = `${ARCHIVE_LOGICAL_ROOT}/codex/pc`;
const cards: RateCard = { version: 1, currency: "USD", unit: "per 1M", vendors: {
  anthropic: { models: { sonnet: { in_uncached: 2, in_cache_read: 1, in_cache_write_5m: 3,
    in_cache_write_1h: 4, out_total: 8 } } },
}, subscriptions: { claude: { usd_per_month: 200 } } };
const accounts = [
  { id: "seat-a", vendor: "claude", home: source },
  { id: "seat-b", vendor: "claude", home: source },
  { id: "codex1", vendor: "codex", home: codexHome },
];
const period = (provider: string, subject: string, value: string, from: string, until: string | null): DatedPeriod =>
  ({ provider, subject, value, from, until, origin: "declared", firstSeen: null,
    lastSeen: null, readings: 0, evidence: "fixture" });
const initial = [
  period("claude", "claude/pc", "seat-a", "2026-08-10T00:00:00.000Z", "2026-08-10T12:00:00.000Z"),
  period("claude", "claude/pc", "seat-b", "2026-08-10T12:00:00.000Z", null),
  period("codex", "codex/pc", "codex1", "2026-08-10T00:00:00.000Z", null),
];
const opened: Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(file = ":memory:", unknown = false, secondDay = false) {
  const db = new Database(file); opened.push(db);
  applyDrizzleMigrations(drizzle(db));
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,model TEXT,
    in_tok INTEGER DEFAULT 0,cached_in INTEGER DEFAULT 0,cache_write INTEGER DEFAULT 0,
    out_tok INTEGER DEFAULT 0,reasoning_out INTEGER DEFAULT 0);`);
  const insert = db.query(`INSERT INTO claude_events(store,call_id,ts,path,model,speed,in_uncached)
    VALUES('fixture',?,?,? || '/session.jsonl',?,'standard',1000000)`);
  insert.run("a", "2026-08-10T10:00:00.000Z", source, "sonnet");
  insert.run("b", "2026-08-10T14:00:00.000Z", source, unknown ? "unknown" : "sonnet");
  if (secondDay) insert.run("c", "2026-08-11T14:00:00.000Z", source, "sonnet");
  db.query(`INSERT INTO events(home,path,ts,model,in_tok,out_tok)
    VALUES(?,?,'2026-08-10T11:00:00.000Z','gpt-5.6-luna',1000,100)`)
    .run(codexHome, `${codexHome}/rollout.jsonl`);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, initial);
  replaceDeclaredPeriods(db, PLAN_PERIODS, [
    period("claude", "seat-a", "max-5x", "2026-08-10T00:00:00.000Z", null),
    period("claude", "seat-b", "max-20x", "2026-08-10T00:00:00.000Z", null),
  ]);
  const homes = new Map([[codexHome.toLowerCase(), "codex1"]]);
  prepareUsageRegisters(db, cards, accounts, homes);
  // Plan prices come from the Plans catalog version of the plan the plan periods give.
  const catalog: PlansCatalog = { provider_groups: [{ id: "anthropic", label: "Anthropic", aliases: ["claude"], plans: [
    { plan_id: "claude-max-5x", label: "Max 5x", aliases: ["max-5x"], versions: [{ from: "2026-08-01", usd_per_month: 30 }] },
    { plan_id: "claude-max-20x", label: "Max 20x", aliases: ["max-20x"], versions: [{ from: "2026-08-01", usd_per_month: 60 }] },
  ] }] };
  const context = () => ({ sqlite: db, resolver: loadAccountResolver(db, accounts), accounts,
    declarations: accounts, homeToSubId: homes, rateCards: cards, plansCatalog: catalog });
  const api = () => ({ ...context(), accounts: { subscriptions: accounts },
    subIdToHomes: new Map(), claudeGauge: { subscription: "claude", plan: "Max" },
    grokGauge: {}, cycles: { windows: [] }, plans: { segments: [] }, eras: { fingerprint: "" } }) as unknown as AppContext;
  return { db, context, api, catalog };
}

function addConflict(db: Database): void {
  db.exec(`INSERT INTO claude_events(store,call_id,ts,path,model,speed,in_uncached)
    SELECT 'conflict-copy',call_id,ts,path,model,speed,in_uncached+1 FROM claude_events WHERE call_id='a'`);
  prepareUsageRegisters(db,cards,accounts,new Map([[codexHome.toLowerCase(),"codex1"]]));
}
function addAccepted(db: Database): void {
  db.query(`INSERT INTO claude_events(store,call_id,ts,path,model,speed,in_uncached)
    VALUES('fixture','accepted','2026-08-10T10:01:00.000Z',?,'sonnet','standard',1000000)`)
    .run(`${source}/session.jsonl`);
  prepareUsageRegisters(db,cards,accounts,new Map([[codexHome.toLowerCase(),"codex1"]]));
}

test("leverage separates real Claude accounts at a period boundary and ignores the legacy global price", async () => {
  const f = fixture();
  const body = await handleLeverage(f.api(), new URL("http://local/api/leverage?since=2026-08-10&until=2026-08-10")).json() as
    { subscriptions: Array<{ id: string; vendor: string; api_usd: number | null; paid_usd: number | null;
      usd_per_month: number | null; plan: string | null; days: number }> };
  const claude = body.subscriptions.filter(row => row.vendor === "claude");
  expect(claude.map(row => row.id)).toEqual(["seat-a", "seat-b"]);
  expect(claude.map(row => row.api_usd)).toEqual([2, 2]);
  expect(claude.map(row => row.plan)).toEqual(["max-5x", "max-20x"]);
  expect(claude.map(row => row.usd_per_month)).toEqual([30, 60]);
  expect(claude.map(row => row.days)).toEqual([1, 1]);
  expect(claude.every(row => row.paid_usd !== null)).toBe(true);
  expect(body.subscriptions.some(row => row.id === "claude")).toBe(false);
  expect(body.subscriptions.find(row => row.id === "codex1")?.vendor).toBe("codex");
  const periodOnly = buildLeverage({ ...f.context(), accounts: [accounts[0]!, accounts[2]!] }, {});
  expect(periodOnly.subscriptions.find(row => row.id === "seat-b")?.api_usd).toBe(2);
});

test("period correction and read-only restart reuse register prices", () => {
  const dir = mkdtempSync(join(tmpdir(), "leverage-w8-")); dirs.push(dir);
  const file = join(dir, "fixture.sqlite");
  const f = fixture(file);
  const before = buildLeverage(f.context(), {});
  replaceDeclaredPeriods(f.db, ACCOUNT_PERIODS, [
    period("claude", "claude/pc", "seat-b", "2026-08-10T00:00:00.000Z", null),
    initial[2]!,
  ]);
  const corrected = buildLeverage(f.context(), {});
  expect(before.subscriptions.find(row => row.id === "seat-a")?.api_usd).toBe(2);
  expect(corrected.subscriptions.find(row => row.id === "seat-a")?.api_usd).toBe(0);
  expect(corrected.subscriptions.find(row => row.id === "seat-b")?.api_usd).toBe(4);
  const context = f.context();
  f.db.close(true); opened.splice(opened.indexOf(f.db), 1);
  const readonly = new Database(file, { readonly: true }); opened.push(readonly);
  expect(buildLeverage({ ...context, sqlite: readonly, resolver: loadAccountResolver(readonly, accounts) }, {}))
    .toEqual(corrected);
});

test("unpriced traffic and a plan without a catalog price remain absent instead of zero", () => {
  const f = fixture(":memory:", true);
  f.catalog.provider_groups[0]!.plans.splice(1, 1);
  const result = buildLeverage(f.context(), {});
  const seat = result.subscriptions.find(row => row.id === "seat-b")!;
  expect(seat.api_usd).toBeNull();
  expect(seat.paid_usd).toBeNull();
  expect(seat.usd_per_month).toBeNull();
  expect(seat.leverage_ratio).toBeNull();
  expect(result.unpriced.models.unknown).toBe(1000000);
});

test("dated catalog prices and plan period changes apply only to their account", () => {
  const f = fixture(":memory:", false, true);
  f.catalog.provider_groups[0]!.plans[1]!.versions.push({ from: "2026-08-11", usd_per_month: 120 });
  const before = buildLeverage(f.context(), {});
  const seat = before.subscriptions.find(row => row.id === "seat-b")!;
  expect(seat.api_usd).toBe(4);
  expect(seat.days).toBe(2);
  expect(seat.usd_per_month).toBe(90);
  expect(seat.paid_usd).toBeGreaterThan(0);
  expect(before.subscriptions.find(row => row.id === "seat-a")?.usd_per_month).toBe(30);
  replaceDeclaredPeriods(f.db, PLAN_PERIODS, [
    period("claude", "seat-a", "max-5x", "2026-08-10T00:00:00.000Z", null),
    period("claude", "seat-b", "max-20x", "2026-08-10T00:00:00.000Z", "2026-08-11T00:00:00.000Z"),
    period("claude", "seat-b", "max-5x", "2026-08-11T00:00:00.000Z", null),
  ]);
  const corrected = buildLeverage(f.context(), {});
  // The plan periods are the plan history: day one Max 20x at 60, day two Max 5x at 30.
  expect(corrected.subscriptions.find(row => row.id === "seat-b")?.usd_per_month).toBe(45);
  expect(corrected.subscriptions.find(row => row.id === "seat-b")?.plan).toBe("max-5x");
  expect(corrected.subscriptions.find(row => row.id === "seat-a")?.paid_usd).toBe(before.subscriptions.find(row => row.id === "seat-a")?.paid_usd);
});

test("a receipt overrides a stale plan estimate only for an exact USD interval; a correction changes leverage without repricing the register", async () => {
  const f = fixture();
  const url = new URL("http://local/api/leverage?since=2026-08-10&until=2026-08-10");
  const planRows = (amountMinor: number | null, currency: string | null, until: string | null) => [
    period("claude", "seat-a", "max-5x", "2026-08-10T00:00:00.000Z", null),
    { ...period("claude", "seat-b", "max-20x", "2026-08-10T00:00:00.000Z", until),
      amountMinor, currency },
  ];
  replaceDeclaredPeriods(f.db, PLAN_PERIODS, planRows(1234, "EUR", "2026-08-11T00:00:00.000Z"));
  let seat = buildLeverage(f.context(), { since: "2026-08-10", until: "2026-08-10" }).subscriptions.find(r => r.id === "seat-b")!;
  expect([seat.paid_usd, seat.usd_per_month, seat.paid_basis]).toEqual([null, null, "unknown"]);
  replaceDeclaredPeriods(f.db, PLAN_PERIODS, planRows(1234, null, "2026-08-11T00:00:00.000Z"));
  expect(buildLeverage(f.context(), {}).subscriptions.find(r => r.id === "seat-b")?.paid_usd).toBeNull();
  replaceDeclaredPeriods(f.db, PLAN_PERIODS, planRows(null, "USD", "2026-08-11T00:00:00.000Z"));
  expect(buildLeverage(f.context(), {}).subscriptions.find(r => r.id === "seat-b")?.paid_usd).toBeNull();
  replaceDeclaredPeriods(f.db, PLAN_PERIODS, planRows(1234, "USD", "2026-08-12T00:00:00.000Z"));
  seat = buildLeverage(f.context(), {}).subscriptions.find(r => r.id === "seat-b")!;
  expect([seat.paid_usd, seat.paid_basis]).toEqual([null, "unknown"]);
  replaceDeclaredPeriods(f.db, PLAN_PERIODS, planRows(1234, "USD", null));
  seat = buildLeverage(f.context(), {}).subscriptions.find(r => r.id === "seat-b")!;
  expect(seat.paid_usd).toBeNull();
  replaceDeclaredPeriods(f.db, PLAN_PERIODS, planRows(1234, "USD", "2026-08-11T00:00:00.000Z"));
  const ctx = f.api();
  const built = await buildDataView(ctx, url);
  expect((built.body as ReturnType<typeof buildLeverage>).subscriptions.find(r => r.id === "seat-b")?.paid_usd).toBe(12.34);
  const registerBefore = f.db.query("SELECT provider,covered,rules_digest FROM usage_ledger_state ORDER BY provider").all();
  replaceDeclaredPeriods(f.db, PLAN_PERIODS, planRows(3456, "USD", "2026-08-11T00:00:00.000Z"));
  expect(((await buildDataView(ctx, url)).body as ReturnType<typeof buildLeverage>).subscriptions.find(r => r.id === "seat-b")?.paid_usd).toBe(34.56);
  seat = buildLeverage(f.context(), {}).subscriptions.find(r => r.id === "seat-b")!;
  expect([seat.paid_usd, seat.paid_basis, seat.usd_per_month]).toEqual([34.56, "receipt-usd", null]);
  expect(f.db.query("SELECT provider,covered,rules_digest FROM usage_ledger_state ORDER BY provider").all()).toEqual(registerBefore);
});

test("conflict-only and mixed-conflict register slices retain unknown quality instead of verified zero", () => {
  const f = fixture();
  addConflict(f.db);
  let seat = buildLeverage(f.context(), {}).subscriptions.find(r => r.id === "seat-a")!;
  expect(seat.api_usd).toBeNull();
  expect(seat.api_quality).toMatchObject({ conflicts: 1, reasons: { conflicts: 1 } });
  addAccepted(f.db);
  seat = buildLeverage(f.context(), {}).subscriptions.find(r => r.id === "seat-a")!;
  expect(seat.api_usd).toBeNull();
  expect(seat.api_quality?.conflicts).toBe(1);
});

test("Claude account history groups durable prices by period and survives raw-table loss", async () => {
  const f = fixture();
  const url = new URL("http://local/api/account-history?group=day&since=2026-08-10&until=2026-08-10");
  const read = async () => await handleAccountHistory(f.api(), url).json() as {
    accounts: Array<{ id: string; vendor: string; tokens: number; usd: number }>;
    points: Array<{ bucket: string; split: Record<string, { usd: number }> }>;
  };
  const before = await read();
  expect(before.accounts.filter(r => r.vendor === "claude").map(r => [r.id, r.usd]))
    .toEqual([["seat-a", 2], ["seat-b", 2]]);
  expect(before.points[0]?.split["seat-a"]?.usd).toBe(2);
  replaceDeclaredPeriods(f.db, ACCOUNT_PERIODS, [
    period("claude", "claude/pc", "seat-b", "2026-08-10T00:00:00.000Z", null), initial[2]!,
  ]);
  f.db.exec("DROP TABLE claude_events");
  const after = await read();
  expect(after.accounts.filter(r => r.vendor === "claude").map(r => [r.id, r.usd])).toEqual([["seat-b", 4]]);
  expect(after.points[0]?.split["seat-b"]?.usd).toBe(4);
});

test("Claude account history keeps day bounds, week/month buckets and unpriced tokens", async () => {
  const f = fixture(":memory:", true, true);
  const read = async (query: string) => await handleAccountHistory(f.api(), new URL(`http://local/api/account-history?${query}`)).json() as {
    accounts: Array<{ id: string; usd: number }>;
    points: Array<{ bucket: string }>;
    unpriced: { tokens: number; models: Record<string, number> };
  };
  const day = await read("group=day&since=2026-08-10&until=2026-08-10");
  expect(day.points.map(p => p.bucket)).toEqual(["2026-08-10"]);
  expect(day.accounts.find(r => r.id === "seat-b")?.usd).toBeNull();
  expect(day.unpriced.models.unknown).toBe(1000000);
  const nextDay = await read("group=day&since=2026-08-11&until=2026-08-11");
  expect(nextDay.accounts.find(r => r.id === "seat-b")?.usd).toBe(2);
  expect(nextDay.unpriced.tokens).toBe(0);
  expect((await read("group=week")).points.map(p => p.bucket)).toEqual(["2026-08-10"]);
  expect((await read("group=month")).points.map(p => p.bucket)).toEqual(["2026-08"]);
});

test("account history follows an account period correction without repricing", async () => {
  const f = fixture();
  const url = new URL("http://local/api/account-history?group=day");
  const before = (await buildDataView(f.api(), url)).body as { accounts: Array<{ id: string; vendor: string; usd: number }> };
  expect(before.accounts.filter(row => row.vendor === "claude").map(row => [row.id, row.usd])).toEqual([["seat-a", 2], ["seat-b", 2]]);
  const registers = f.db.query("SELECT * FROM usage_ledger_state ORDER BY provider").all();
  replaceDeclaredPeriods(f.db, ACCOUNT_PERIODS, [
    period("claude", "claude/pc", "seat-b", "2026-08-10T00:00:00.000Z", null), initial[2]!,
  ]);
  const changed = await buildDataView(f.api(), url);
  const body = changed.body as { accounts: Array<{ id: string; vendor: string; usd: number }> };
  expect(body.accounts.filter(row => row.vendor === "claude").map(row => [row.id, row.usd])).toEqual([["seat-b", 4]]);
  expect(f.db.query("SELECT * FROM usage_ledger_state ORDER BY provider").all()).toEqual(registers);
});

test("serialized Claude history distinguishes a zero-token conflict from accepted spend beside a conflict", async () => {
  const f = fixture();
  const read = async () => await handleAccountHistory(f.api(),
    new URL("http://local/api/account-history?group=day&since=2026-08-10&until=2026-08-10")).json() as {
      accounts: Array<{ id: string; usd: number | null; priced_usd?: number;
        api_quality?: { complete: boolean; conflicts: number } }>;
      points: Array<{ usd: number | null; priced_usd?: number;
        split: Record<string, { usd: number | null; priced_usd?: number; api_quality?: { conflicts: number } }> }>;
      totals: { usd: number | null; priced_usd?: number; api_quality?: { conflicts: number } };
    };
  addConflict(f.db);
  let body = await read();
  expect(body.accounts.find(r => r.id === "seat-a")).toMatchObject({ usd: null, priced_usd: 0,
    api_quality: { complete: false, conflicts: 1 } });
  expect(body.points[0]?.split["seat-a"]).toMatchObject({ usd: null, priced_usd: 0,
    api_quality: { conflicts: 1 } });
  expect(body.totals).toMatchObject({ usd: null, api_quality: { conflicts: 1 } });
  addAccepted(f.db);
  body = await read();
  expect(body.accounts.find(r => r.id === "seat-a")).toMatchObject({ usd: null, priced_usd: 2,
    api_quality: { conflicts: 1 } });
  expect(body.points[0]?.split["seat-a"]).toMatchObject({ usd: null, priced_usd: 2 });
  expect(body.totals.priced_usd).toBeGreaterThan(2);
});

test("a missing or unsupported register reports unavailable or pending, never a fabricated zero", async () => {
  const db = new Database(":memory:"); opened.push(db);
  applyDrizzleMigrations(drizzle(db));
  const ctx = { sqlite: db, accounts: { subscriptions: accounts }, homeToSubId: new Map(),
    rateCards: cards, plans: { segments: [] } } as unknown as AppContext;
  const missing = handleLeverage(ctx, new URL("http://local/api/leverage"));
  expect(missing.status).toBe(503);
  expect(await missing.json()).toMatchObject({ usage_unavailable: [{ provider: "codex" }] });
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,model TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER)`);
  expect(() => handleLeverage(ctx, new URL("http://local/api/leverage"))).toThrow("awaiting background preparation");
  expect(() => handleAccountHistory(ctx, new URL("http://local/api/account-history"))).toThrow("awaiting background preparation");
});
