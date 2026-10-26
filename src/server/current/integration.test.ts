import { afterEach, expect, test } from "bun:test";
import { Database } from "../../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../../db/migrate";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../../db/period-store";
import { acceptProbeFact, createProbeCollection, mapProbeLegacy } from "../../db/probe-facts";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../../config/paths";
import { createFetchHandler, type AppContext } from "../api";
import { buildEraIndex } from "../eras";
import { currentRegistry } from "./registry";
import { publishCurrentBatch } from "./store";
import { declareClaudeLabelPeriods } from "../subscription-reader.fixture";
import { prepareUsageRegisters } from "../usage-register.fixture";
import type { RateCard } from "../pricing";
import type { SourceDeclaration } from "../archive-source";
import type { SubscriptionDeclaration } from "../../web/lib/current-contract";

const connections: Database[] = [];
afterEach(() => connections.splice(0).forEach(db => db.close(true)));
const HOME = `C:/Users/${LOGIN}/.claude`;
function linkProbe(db: Database) {
  const row = db.query("SELECT * FROM probe_windows LIMIT 1").get() as Record<string, unknown>;
  const fact = createProbeCollection([{ ...row, raw_subject: null, login: LOGIN, source_home: HOME }])[0]!;
  db.transaction(() => { acceptProbeFact(db, fact); mapProbeLegacy(db, fact, Number(row.id), "fixture-linked"); }).immediate();
}
function split(rows: readonly (SubscriptionDeclaration & SourceDeclaration)[]) {
  return { subscriptions: rows.map(({ id, vendor, account, account_key, label, note, status }) =>
    ({ id, vendor, account, account_key, label, note, status })),
    sources: rows.map(({ vendor, machine, login, home, source_home }) => ({ vendor, machine, login, home, source_home })) };
}
function settle(db: Database, rows: readonly (SubscriptionDeclaration & SourceDeclaration)[]) {
  const config = split(rows);
  const now = new Date().toISOString();
  for (let i = 0; i < 100; i++) {
    if (!publishCurrentBatch(db, currentRegistry(config.subscriptions, now), now, 32, config)) return;
  }
  throw new Error("current projection did not settle");
}
function fixture(file = ":memory:") {
  const sqlite = new Database(file); connections.push(sqlite);
  applyDrizzleMigrations(drizzle(sqlite));
  const subscriptions = [{ id: "claude1", vendor: "claude", machine: "PC-A", source_home: HOME,
    home: `${ARCHIVE_LOGICAL_ROOT}/claude/PC-A-${LOGIN}`, account: "alpha@example.test" }];
  const ts = new Date(Date.now() - 60_000).toISOString();
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  sqlite.query(`INSERT INTO claude_events(store,call_id,ts,path,subscription_id,in_uncached,out_total)
    VALUES ('local','1',?,'archive/claude/session.jsonl','claude1',100,20)`).run(ts);
  sqlite.query(`INSERT INTO probe_windows(provider,subject,ts,kind,used_percent,reported_percent_side,resets_at,machine)
    VALUES ('claude','old-captured-target',?,'weekly',42,'used',?,'PC-A')`).run(ts, reset);
  linkProbe(sqlite);
  declareClaudeLabelPeriods(sqlite);
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, [...loadPeriods(sqlite, ACCOUNT_PERIODS), {
    provider: "claude", subject: `claude/PC-A-${LOGIN}`.toLowerCase(), value: "claude1",
    from: "2000-01-01", until: null, origin: "declared", firstSeen: null, lastSeen: null,
    readings: 0, evidence: "fixture",
  }]);
  settle(sqlite, subscriptions);
  const rateCards = { version: 1, currency: "USD", unit: "per 1M", vendors: {} } as RateCard;
  // History reads Claude usage from the shared price register, prepared as the maintenance worker does.
  const homeToSubId = new Map<string, string>();
  prepareUsageRegisters(sqlite, rateCards, [], homeToSubId);
  const ctx = { sqlite, accounts: split(subscriptions), homeToSubId, subIdToHomes: new Map(),
    eras: buildEraIndex(subscriptions), eraErrors: [], homeConflict: null, claudeGauge: {}, grokGauge: {}, rateCards,
  } as unknown as AppContext;
  const fetch = createFetchHandler(ctx);
  const get = (url: string, headers?: HeadersInit) => fetch(new Request(`http://fixture${url}`, { headers }));
  return { sqlite, ctx, subscriptions, get };
}

test("combined router serves current from its projection with probe rows unavailable, and history without writes", async () => {
  const f = fixture();
  const before = f.sqlite.query("SELECT total_changes() AS n").get();
  // Current cards come from the projection alone.
  f.sqlite.exec("ALTER TABLE probe_windows RENAME TO probe_windows_hidden");
  const bootstrap = await f.get("/api/bootstrap");
  expect(bootstrap.status).toBe(200);
  expect((await bootstrap.json()).data.subscriptions[0].limits[0].used_percent).toBe(42);
  f.sqlite.exec("ALTER TABLE probe_windows_hidden RENAME TO probe_windows");
  // Claude history joins its account from the account periods at read time to the prepared register.
  const history = await f.get("/api/era-timelines");
  expect(history.status).toBe(200);
  expect(history.headers.get("X-Usage-Source")).toBe("register-v8");
  expect((await history.json()).subscriptions[0].segments[0].stats.tokens).toBe(120);
  expect(f.sqlite.query("SELECT total_changes() AS n").get()).toEqual(before);
});

test("probe publication changes current ETag without advancing usage coverage or history cache identity", async () => {
  const f = fixture();
  const before = await f.get("/api/subscriptions/claude1/current");
  const etag = before.headers.get("ETag")!;
  expect((await before.json()).data.limits[0].used_percent).toBe(42);
  const stamp = f.ctx.responseCache!.stamp(f.sqlite);
  const ledgers = f.sqlite.query("SELECT * FROM usage_ledger_state").all();
  const revisions = f.sqlite.query("SELECT * FROM sync_revisions").all();
  f.sqlite.exec("UPDATE probe_windows SET used_percent=65");
  linkProbe(f.sqlite);
  settle(f.sqlite, f.subscriptions);
  const after = await f.get("/api/subscriptions/claude1/current", { "If-None-Match": etag });
  expect(after.status).toBe(200);
  expect(after.headers.get("ETag")).not.toBe(etag);
  expect((await after.json()).data.limits[0].used_percent).toBe(65);
  expect(f.ctx.responseCache!.stamp(f.sqlite)).toBe(stamp);
  expect(f.sqlite.query("SELECT * FROM usage_ledger_state").all()).toEqual(ledgers);
  expect(f.sqlite.query("SELECT * FROM sync_revisions").all()).toEqual(revisions);
});

test("stale analytics and broken legacy cache cannot block read-only current routes", async () => {
  const f = fixture();
  f.sqlite.exec("UPDATE usage_ledger_state SET status='pending'");
  f.ctx.responseCache!.stamp = () => { throw new Error("legacy path must not run for current"); };
  const before = f.sqlite.query("SELECT total_changes() AS n").get();
  for (const path of ["/api/bootstrap", "/api/subscriptions/claude1/current", "/api/revisions"]) {
    const res = await f.get(path);
    expect(res.status).toBe(200);
    const body = await res.json();
    if (path !== "/api/revisions") expect(body.status).toBe("ready");
  }
  expect(f.sqlite.query("SELECT total_changes() AS n").get()).toEqual(before);
});

test("attribution conflict suppresses current readings but keeps subscription identity reachable", async () => {
  const f = fixture();
  f.ctx.homeConflict = new Error("test conflict") as AppContext["homeConflict"];
  const current = await f.get("/api/bootstrap");
  expect(current.status).toBe(200);
  expect((await current.json()).data.subscriptions[0]).toMatchObject({ id: "claude1", limits: [], declaration_conflict: true });
  expect((await f.get("/api/era-timelines")).status).toBe(503);
});

test("a preparing probe index answers the direct account API and stored-row views as 202 without preparing usage", async () => {
  const f = fixture();
  // The readings' evidence before its first complete write.
  f.sqlite.exec("DELETE FROM meta WHERE key='probe_sources_published'");
  const prices = f.sqlite.query("SELECT provider,phase,status,covered,revision,(SELECT COUNT(*) FROM usage_ledger_facts) facts FROM usage_ledger_state ORDER BY provider").all();
  const direct = await f.get("/api/account-state");
  expect(direct.status).toBe(202);
  expect(direct.headers.get("Cache-Control")).toBe("no-store");
  const response = await f.get("/api/claude-limit?account=claude1");
  expect(response.status).toBe(202);
  expect(response.headers.get("X-Analysis")).toBe("preparing");
  expect(await response.json()).toMatchObject({ status: "preparing" });
  expect(f.sqlite.query("SELECT provider,phase,status,covered,revision,(SELECT COUNT(*) FROM usage_ledger_facts) facts FROM usage_ledger_state ORDER BY provider").all()).toEqual(prices);
});
