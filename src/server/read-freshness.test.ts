import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { codexCanonicalEventSql } from "../db/codex-ledger-canonical";
import { markCodexLedgerCopiesDirty } from "../db/codex-ledger-producer";
import { FRESHNESS_HEADER, freshnessHeader, registerFreshness } from "../db/read-freshness";
import { currentRegistry } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { createFetchHandler, type AppContext } from "./api";
import { buildEraIndex } from "./eras";
import type { RateCard } from "./pricing";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";

const CARD = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../../rate-cards.json"), "utf8")) as RateCard;
const CODEX = `${ARCHIVE_LOGICAL_ROOT}/codex/PC-A-user`;
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(true); });

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
const claude = (db: Database, ts: string, uncached: number) => db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,speed,in_uncached,out_total)
  VALUES ('live',?,?,?,?,'claude-opus-5','standard',?,0)`).run(`call-${++callId}`, `session-${callId}`, `${ARCHIVE_LOGICAL_ROOT}/claude/PC-A/${callId}.jsonl`, ts, uncached);
const codex = (db: Database, file: string, ts: string, input: number) => db.query(`INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok,reasoning_out)
  VALUES (?,?,?,'gpt-5',?,0,0,10,0)`).run(CODEX, `${CODEX}/sessions/${file}`, ts, input);
function fetcher(db: Database) {
  const ctx = { sqlite: db, rateCards: CARD, accounts: { subscriptions: [], sources: [] }, homeToSubId: new Map(), subIdToHomes: new Map(),
    eras: buildEraIndex([]), eraErrors: [], homeConflict: null, claudeGauge: {}, grokGauge: {}, plans: { segments: [] },
    plansCatalog: { provider_groups: [] } } as unknown as AppContext;
  const fetch = createFetchHandler(ctx);
  return async (route: string) => {
    const response = await fetch(new Request(`http://127.0.0.1${route}`));
    return { status: response.status, freshness: response.headers.get(FRESHNESS_HEADER), body: await response.json() as Record<string, any> };
  };
}

test("a first build answers preparing; once published, newer facts leave the previous sums readable with a freshness marker", async () => {
  const db = database();
  claude(db, "2026-09-10T10:00:00.000Z", 100);
  const get = fetcher(db);
  // Never built: the ledger has no published state yet.
  expect((await get("/api/activity?vendor=claude")).status).toBe(202);

  prepareUsageRegisters(db, CARD);
  const published = await get("/api/activity?vendor=claude");
  expect(published).toMatchObject({ status: 200, freshness: "current", body: { totals: { calls: 1, tokens: 100 } } });
  const revision = registerFreshness(db, "claude").revision;

  // A sync publishes a new call; the producer has not replayed it yet.
  claude(db, "2026-09-11T10:00:00.000Z", 50);
  const during = await get("/api/activity?vendor=claude");
  expect(during.status).toBe(200);
  expect(during.body.totals).toMatchObject({ calls: 1, tokens: 100 });
  expect(during.freshness).toBe(`pending; claude=${revision}`);
  // The Claude summary reads the same published day sums, priced.
  const summary = await get("/api/summary?vendor=claude");
  expect(summary).toMatchObject({ status: 200, freshness: `pending; claude=${revision}` });
  expect(summary.body.totals.calls).toBe(1);

  fillUsageLedgerFixture(db, CARD, ["claude"]);
  const caughtUp = await get("/api/activity?vendor=claude");
  expect(caughtUp).toMatchObject({ status: 200, freshness: "current", body: { totals: { calls: 2, tokens: 150 } } });
});

test("Codex copies being resolved keep the published sums and the resolved copies readable", async () => {
  const db = database();
  codex(db, "a.jsonl", "2026-09-10T10:00:00.000Z", 100);
  const get = fetcher(db);
  expect((await get("/api/summary?vendor=codex")).status).toBe(202);
  expect(() => codexCanonicalEventSql(db, "e")).toThrow("being resolved");

  prepareUsageRegisters(db, CARD);
  const published = await get("/api/summary?vendor=codex");
  expect(published).toMatchObject({ status: 200, freshness: "current" });
  expect(published.body.totals.codex.calls).toBe(1);
  const counted = () => (db.query(`SELECT COUNT(*) n FROM events e WHERE ${codexCanonicalEventSql(db, "e")}`).get() as { n: number }).n;
  expect(counted()).toBe(1);

  // A sync writes a new conversation and queues its copy; the facts revision moves ahead of the ledger.
  codex(db, "b.jsonl", "2026-09-11T10:00:00.000Z", 200);
  db.transaction(() => markCodexLedgerCopiesDirty(db, [{ home: CODEX, path: `${CODEX}/sessions/b.jsonl` }])).immediate();
  db.exec("INSERT INTO vendor_sync_revisions(vendor,data_revision,updated_at) VALUES('codex',99,'2026-09-11T10:00:00Z') ON CONFLICT(vendor) DO UPDATE SET data_revision=99");
  const during = await get("/api/summary?vendor=codex");
  expect(during.status).toBe(200);
  expect(during.body.totals.codex.calls).toBe(1);
  expect(during.freshness).toMatch(/^pending; codex=/);
  const activity = await get("/api/activity?vendor=codex");
  expect(activity).toMatchObject({ status: 200, body: { totals: { calls: 1 } } });
  expect(activity.freshness).toMatch(/^pending; codex=/);
  // Raw readers count the copies already resolved; the new one joins once it is.
  expect(counted()).toBe(1);

  prepareUsageRegisters(db, CARD);
  const caughtUp = await get("/api/summary?vendor=codex");
  expect(caughtUp).toMatchObject({ status: 200, freshness: "current" });
  expect(caughtUp.body.totals.codex.calls).toBe(2);
  expect(counted()).toBe(2);
});

test("limit readings: before the first evidence write they are not published; afterwards new readings are marked pending", () => {
  const db = database();
  db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent)
    VALUES('codex','a','2026-09-10T10:00:00.000Z','primary','used',10)`).run();
  expect(registerFreshness(db, "probe-sources")).toMatchObject({ published: false, pending: false });
  const config = { subscriptions: [], sources: [] };
  while (publishCurrentBatch(db, currentRegistry([]), "2026-09-10T12:00:00.000Z", 100, config)) { /* settle */ }
  const published = registerFreshness(db, "probe-sources");
  expect(published).toMatchObject({ published: true, pending: false });
  db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent)
    VALUES('codex','a','2026-09-10T11:00:00.000Z','primary','used',20)`).run();
  // The new reading's evidence is still to be written: the published evidence keeps answering.
  expect(registerFreshness(db, "probe-sources")).toMatchObject({ published: true, pending: true, revision: published.revision });
  expect(freshnessHeader(db, ["probe-sources"])).toBe(`pending; probe-sources=${published.revision}`);
  while (publishCurrentBatch(db, currentRegistry([]), "2026-09-10T12:00:00.000Z", 100, config)) { /* settle */ }
  expect(registerFreshness(db, "probe-sources")).toMatchObject({ published: true, pending: false });
  expect(Number(registerFreshness(db, "probe-sources").revision)).toBeGreaterThan(Number(published.revision));
});
