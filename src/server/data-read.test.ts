import { expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDataRead, currentStoredBody, EXCEPTION_VIEWS, storedAnswerConfiguration } from "./data-read";
import { WINDOW_SCREENS } from "./window-screens";
import { ensureWindowAnswersSchema, markWindowAnswersDirty, storeWindowAnswers } from "../db/window-answers";
import { DATA_VIEWS, type DataEnvelope } from "./data-views";
import { buildEraIndex } from "./eras";
import type { AppContext } from "./api";
import type { DataWork } from "./data-worker";
import { preparedResponse } from "../web/lib/prepared-response";
import { serveCycleReadBatch } from "./cycle-read-batch";
import { ResponseMemoryBudget } from "./response-memory";

/**
 * The exception list of plan U4.4 (data-read.ts): answers computed off the HTTP thread and kept in memory by
 * the version of the rows they were read from. A fake worker stands in for the real one so each test decides
 * when a job ends and what it answers.
 */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  work: DataWork[] = [];
  postMessage(work: DataWork | { close: true }) { if ("close" in work) this.reply({ closed: true }); else this.work.push(work); }
  terminate() {}
  reply(data: unknown) { this.onmessage?.({ data }); }
}
const envelope = (body: unknown, status = 200): DataEnvelope => ({ status, body, headers: [] });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-exception-read-")), dbPath = path.join(dir, "data.sqlite");
  const sqlite = new Database(dbPath);
  sqlite.exec(`CREATE TABLE sync_revisions(id INTEGER PRIMARY KEY,data_revision INTEGER,config_revision INTEGER);
    INSERT INTO sync_revisions VALUES(1,1,1);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);`);
  sqlite.exec(fs.readFileSync(new URL("../../drizzle/0040_account_periods.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  const ctx = { sqlite, dbPath, accounts: { version: 2, subscriptions: [], sources: [] }, homeToSubId: new Map(), subIdToHomes: new Map(),
    eras: buildEraIndex([]), eraErrors: [], homeConflict: null, rateCards: { version: 2, currency: "USD", unit: "per 1M", vendors: {} },
    claudeGauge: {}, grokGauge: {}, cycles: {}, plans: {}, plansCatalog: { provider_groups: [] }, rootDir: process.cwd() } as unknown as AppContext;
  const close = () => { sqlite.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };
  return { ctx, sqlite, close };
}
const url = "http://local/api/account-history?group=day";
const settle = () => Bun.sleep(0);
const reader = (worker: FakeWorker) => createDataRead(() => worker as unknown as Worker, { workers: 1 });

test("Claude calibration changes invalidate only the stored screens consuming its estimate", () => {
  const { ctx, close } = fixture();
  try {
    ctx.accounts.subscriptions = [{ id: "claude-seat", vendor: "claude" }, { id: "codex-seat", vendor: "codex" }] as typeof ctx.accounts.subscriptions;
    for (const path of ["/api/claude-limit?account=claude-seat", "/api/claude-limit-card?account=claude-seat", "/api/windows?account=claude-seat",
      "/api/subscription-accounting?provider=claude&account=claude-seat&since=2026-09-01&until=2026-09-30"]) {
      const configuration = JSON.parse(storedAnswerConfiguration(ctx, new URL(path, "http://local")));
      expect(configuration.at(-1)).toEqual(["claude-capacity", 12]);
    }
    for (const path of ["/api/codex-accounting?account=codex-seat",
      "/api/subscription-accounting?provider=gemini&account=gemini-seat&since=2026-09-01&until=2026-09-30"]) {
      expect(JSON.parse(storedAnswerConfiguration(ctx, new URL(path, "http://local")))).toHaveLength(2);
    }
  } finally { close(); }
});

test("model-usage answer version refreshes only Claude window projections", () => {
  const { ctx, close } = fixture();
  try {
    for (const route of ["/api/claude-limit", "/api/claude-limit-card"])
      expect(JSON.parse(storedAnswerConfiguration(ctx, new URL(`http://local${route}?account=claude-seat`))))
        .toContain("window-model-usage-1");
    for (const route of ["/api/windows?account=claude-seat", "/api/cycle-breakdown?account=codex-seat", "/api/account-history"])
      expect(JSON.parse(storedAnswerConfiguration(ctx, new URL(`http://local${route}`))))
        .not.toContain("window-model-usage-1");
  } finally { close(); }
});

test("context response version is scoped to the series and breakdown, with window-sum dependencies", () => {
  const { ctx, close } = fixture();
  try {
    ctx.accounts.subscriptions = [{ id: "codex-seat", vendor: "codex" }] as typeof ctx.accounts.subscriptions;
    for (const route of ["/api/usage-series?account=codex-seat", "/api/cycle-breakdown?account=codex-seat", "/api/windows?account=codex-seat"]) {
      expect(JSON.parse(storedAnswerConfiguration(ctx, new URL(route, "http://local"))).at(-1)).toBe("stored-context-price-1");
    }
    expect(JSON.parse(storedAnswerConfiguration(ctx, new URL("http://local/api/windows?account=claude-seat")))).toHaveLength(2);
    expect(DATA_VIEWS["/api/billing-cycles"]!.sources).toContain("window-usage");
    expect(DATA_VIEWS["/api/cycle-breakdown"]!.sources).toContain("window-usage");
  } finally { close(); }
});

test("every analytical view reads stored rows, is a stored window view, or names why it is on the exception list", () => {
  for (const [route, view] of Object.entries(DATA_VIEWS))
    expect([view.direct, EXCEPTION_VIEWS[route], WINDOW_SCREENS[route]].filter(Boolean).length, route).toBe(1);
  // One registry of window screens for every provider.
  for (const route of ["/api/cycle-breakdown", "/api/codex-accounting", "/api/subscription-accounting", "/api/usage-series", "/api/windows", "/api/claude-limit"])
    expect(WINDOW_SCREENS[route]?.reason).toBeString();
  // The project cost reads stored day sums since step 8 of docs/stored-activity-plan-2026-10-07.md.
  expect(EXCEPTION_VIEWS["/api/project-cost"]).toBeUndefined();
  expect(DATA_VIEWS["/api/project-cost"]?.direct).toBe(true);
  for (const route of ["/api/breakdown", "/api/compare", "/api/cache", "/api/account-history", "/api/activity"])
    expect(DATA_VIEWS[route]?.direct).toBe(true);
});

test("the first request is a preparation receipt; one job serves every request until it answers", async () => {
  const { ctx, close } = fixture(), worker = new FakeWorker(), read = reader(worker);
  try {
    for (let i = 0; i < 3; i++) {
      const receipt = await read(ctx, new Request(url));
      expect(receipt.status).toBe(202);
      expect(receipt.headers.get("X-Analysis")).toBe("preparing");
      await settle();
    }
    expect(worker.work).toHaveLength(1);
    expect(worker.work[0]!.request).toEqual({ kind: "view", url: "/api/account-history?group=day" });
    worker.reply({ report: envelope({ totals: { tokens: 30 } }) });
    await read.whenIdle();
    const answer = await read(ctx, new Request(url));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("X-Analysis")).toBe("memory");
    expect(answer.headers.get("X-Data-Version")).toBeString();
    expect(await answer.json()).toEqual({ totals: { tokens: 30 } });
    expect(worker.work).toHaveLength(1);
  } finally { read.close(); close(); }
});

test("new rows make the answer stale until the worker has the current one", async () => {
  const { ctx, sqlite, close } = fixture(), worker = new FakeWorker(), read = reader(worker);
  try {
    await read(ctx, new Request(url)); await settle();
    worker.reply({ report: envelope({ tokens: 1 }) }); await read.whenIdle();
    const before = (await read(ctx, new Request(url))).headers.get("X-Data-Version");
    sqlite.exec("UPDATE sync_revisions SET data_revision=2");
    const stale = await read(ctx, new Request(url));
    expect(stale.status).toBe(200);
    expect(stale.headers.get("X-Analysis")).toBe("stale");
    expect(stale.headers.get("Cache-Control")).toBe("no-store");
    expect(stale.headers.get("X-Analysis-Prepared-At")).not.toBeNull();
    expect(stale.headers.get("X-Data-Version")).toBe(before);
    expect(await stale.json()).toEqual({ tokens: 1 });
    await settle();
    expect(worker.work).toHaveLength(2);
    worker.reply({ report: envelope({ tokens: 2 }) }); await read.whenIdle();
    const current = await read(ctx, new Request(url));
    expect(current.headers.get("X-Analysis")).toBe("memory");
    expect(current.headers.get("X-Data-Version")).not.toBe(before);
    expect(await current.json()).toEqual({ tokens: 2 });
    // The client's poll loop ends on the current answer without waiting.
    const polled = await preparedResponse(url, { fetcher: (async () => read(ctx, new Request(url))) as unknown as typeof fetch, wait: async () => {} });
    expect(polled.status).toBe(200);
  } finally { read.close(); close(); }
});

test("a register still being prepared is retried only when the rows change; a refusal is answered as it is", async () => {
  const { ctx, sqlite, close } = fixture(), worker = new FakeWorker(), read = reader(worker);
  try {
    await read(ctx, new Request(url)); await settle();
    worker.reply({ error: "Usage ledger is awaiting background preparation", pending: true }); await read.whenIdle();
    expect((await read(ctx, new Request(url))).status).toBe(202);
    await settle();
    expect(worker.work).toHaveLength(1);
    sqlite.exec("UPDATE sync_revisions SET data_revision=2");
    expect((await read(ctx, new Request(url))).status).toBe(202);
    await settle();
    expect(worker.work).toHaveLength(2);
    expect(read.activity()).toEqual([{ path: "/api/account-history", failed: false }]);
    worker.reply({ error: "Selected counter is unavailable", clientStatus: 400 }); await read.whenIdle();
    const rejected = await read(ctx, new Request(url));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "Selected counter is unavailable" });
    expect(read.activity()).toEqual([{ path: "/api/account-history", failed: true, reason: "invalid-request" }]);
    sqlite.exec("UPDATE sync_revisions SET data_revision=3");
    await read(ctx, new Request(url)); await settle();
    worker.reply({ error: "Unknown account: private@example.com", clientStatus: 400 }); await read.whenIdle();
    expect(read.activity()).toEqual([{ path: "/api/account-history", failed: true, reason: "account-unavailable" }]);
    sqlite.exec("UPDATE sync_revisions SET data_revision=4");
    await read(ctx, new Request(url)); await settle();
    worker.reply({ error: "database is locked" }); await read.whenIdle();
    expect(read.activity()).toEqual([{ path: "/api/account-history", failed: true, reason: "database-busy" }]);
  } finally { read.close(); close(); }
});

test("nothing is written to the database and a new reader starts without answers", async () => {
  const { ctx, sqlite, close } = fixture(), worker = new FakeWorker();
  let read = reader(worker);
  try {
    const changes = sqlite.query("SELECT total_changes() n").get();
    await read(ctx, new Request(url)); await settle();
    worker.reply({ report: envelope({ tokens: 1 }) }); await read.whenIdle();
    expect((await read(ctx, new Request(url))).status).toBe(200);
    expect(sqlite.query("SELECT total_changes() n").get()).toEqual(changes);
    read.close();
    read = reader(worker);
    expect((await read(ctx, new Request(url))).status).toBe(202);
  } finally { read.close(); close(); }
});

test("an invalid request is refused before any work, and a database without a file is read in place", async () => {
  const { ctx, close } = fixture(), worker = new FakeWorker(), read = reader(worker);
  try {
    expect((await read(ctx, new Request("http://local/api/global-usage"))).status).toBe(404);
    const inline = await read({ ...ctx, dbPath: ":memory:" }, new Request("http://local/api/cycles"));
    // The fixture has no published cycle registers: the in-place read answers with the preparation receipt.
    expect(inline.status).toBe(202);
    expect(inline.headers.get("X-Analysis")).toBe("preparing");
    expect(worker.work).toHaveLength(0);
  } finally { read.close(); close(); }
});

test("a kept clock answer is computed again once a window it shows resets", async () => {
  const { ctx, close } = fixture(), worker = new FakeWorker(), read = reader(worker);
  const gauge = "http://local/api/gauge?account=a";
  const builtAt = Date.now(), resetAt = builtAt + 60_000;
  try {
    await read(ctx, new Request(gauge)); await settle();
    worker.reply({ report: { status: 200, body: { window: { reset_at: new Date(resetAt).toISOString() } },
      headers: [["X-Prepared-At", new Date(builtAt).toISOString()]] } }); await read.whenIdle();
    expect((await read(ctx, new Request(gauge))).headers.get("X-Analysis")).toBe("memory");
    expect(worker.work).toHaveLength(1);
    const clock = spyOn(Date, "now").mockReturnValue(resetAt + 1);
    try {
      const after = await read(ctx, new Request(gauge));
      expect(after.headers.get("X-Analysis")).toBe("stale");
      await settle();
      expect(worker.work).toHaveLength(2);
    } finally { clock.mockRestore(); }
  } finally { read.close(); close(); }
});

test("a kept day-scoped answer is computed again on the next UTC day", async () => {
  const { ctx, close } = fixture(), worker = new FakeWorker(), read = reader(worker);
  const health = "http://local/api/source-health";
  const noon = Date.parse("2026-09-18T12:00:00.000Z");
  const clock = spyOn(Date, "now").mockReturnValue(noon);
  try {
    await read(ctx, new Request(health)); await settle();
    worker.reply({ report: { status: 200, body: { sources: [] }, headers: [] } }); await read.whenIdle();
    clock.mockReturnValue(noon + 11 * 3_600_000);
    expect((await read(ctx, new Request(health))).headers.get("X-Analysis")).toBe("memory");
    clock.mockReturnValue(Date.parse("2026-09-19T00:00:00.000Z"));
    expect((await read(ctx, new Request(health))).headers.get("X-Analysis")).toBe("stale");
    await settle();
    expect(worker.work).toHaveLength(2);
  } finally { clock.mockRestore(); read.close(); close(); }
});

test("a view that answers the preparation receipt is waited for, not kept as its answer", async () => {
  const { ctx, sqlite, close } = fixture(), worker = new FakeWorker(), read = reader(worker);
  try {
    await read(ctx, new Request(url)); await settle();
    worker.reply({ report: envelope({ status: "preparing" }, 202) }); await read.whenIdle();
    const again = await read(ctx, new Request(url));
    expect(again.status).toBe(202);
    expect(again.headers.get("X-Analysis")).toBe("preparing");
    sqlite.exec("UPDATE sync_revisions SET data_revision=2");
    await read(ctx, new Request(url)); await settle();
    expect(worker.work).toHaveLength(2);
  } finally { read.close(); close(); }
});

test("a preparation receipt is asked again after the refresh spacing even when the rows did not change", async () => {
  const { ctx, close } = fixture(), worker = new FakeWorker(), read = reader(worker);
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-18T12:00:00.000Z"));
  try {
    await read(ctx, new Request(url)); await settle();
    worker.reply({ error: "Probe account index is preparing", pending: true }); await read.whenIdle();
    expect((await read(ctx, new Request(url))).status).toBe(202);
    await settle();
    expect(worker.work).toHaveLength(1);
    // A producer finished without a new row version: the next read after the spacing computes again.
    clock.mockReturnValue(Date.parse("2026-09-18T12:00:16.000Z"));
    expect((await read(ctx, new Request(url))).status).toBe(202);
    await settle();
    expect(worker.work).toHaveLength(2);
    worker.reply({ report: envelope({ tokens: 3 }) }); await read.whenIdle();
    expect(await (await read(ctx, new Request(url))).json()).toEqual({ tokens: 3 });
  } finally { clock.mockRestore(); read.close(); close(); }
});

/** Stored window views (db/window-answers.ts): the fake worker answers with the snapshot its rows were read from. */
const W1 = "2026-09-01T00:00:00.000Z", W2 = "2026-09-08T00:00:00.000Z", W3 = "2026-09-15T00:00:00.000Z";
const breakdown = (account: string, since: string, until: string) =>
  `http://local/api/cycle-breakdown?account=${account}&since_ts=${since}&until_ts=${until}&limit_id=codex&valuation=dated`;
function storedFixture() {
  const base = fixture();
  ensureWindowAnswersSchema(base.sqlite);
  const seq = () => (base.sqlite.query("SELECT seq FROM sqlite_sequence WHERE name='window_answer_marks'").get() as { seq: number } | null)?.seq ?? 0;
  const reply = (worker: FakeWorker, body: unknown) => worker.reply({ report: envelope(body), snapshot: { checked: seq(), version: "rows-1" } });
  return { ...base, reply };
}
/** The background writer's turn. */
const publish = (read: ReturnType<typeof reader>, sqlite: Database) => storeWindowAnswers(sqlite, read.takeAnswersToStore());

test("shared cache eviction preserves unpublished work and committed reads across restart", async () => {
  const { ctx, sqlite, close, reply } = storedFixture(), worker = new FakeWorker(), memory = new ResponseMemoryBudget(4096);
  let read = createDataRead(() => worker as unknown as Worker, { workers: 1, memory });
  const selected = breakdown("codex1", W1, W2), body = { totals: { calls: 7, tokens: 91, usd: 0.123456789 } };
  try {
    expect((await read(ctx, new Request(selected))).status).toBe(202);
    reply(worker, body); await read.whenIdle();
    expect(memory.stats().entries).toBe(1);
    const pressure = {}; memory.retain(pressure, memory.limit, () => {});
    expect(memory.stats().entries).toBe(1);
    const pending = read.takeAnswersToStore(); expect(pending).toHaveLength(1);
    storeWindowAnswers(sqlite, pending);
    await read.close();
    read = createDataRead(() => { throw new Error("Committed answers must not need a worker"); }, { memory });
    const response = await read(ctx, new Request(selected));
    expect(response.headers.get("X-Analysis")).toBe("stored");
    expect(await response.json()).toEqual(body);
    memory.release(pressure);
  } finally { await read.close(); close(); }
});

test("analysis pool returns retired idle slots to a later burst without interrupting work", async () => {
  const { ctx, close } = fixture();
  const workers: FakeWorker[] = [], terminated: FakeWorker[] = [];
  const read = createDataRead(() => {
    const worker = new FakeWorker(); worker.terminate = () => { terminated.push(worker); };
    workers.push(worker); return worker as unknown as Worker;
  }, { workers: 3, idleMs: 10 });
  try {
    for (let i = 0; i < 3; i++) await read(ctx, new Request(`${url}&scope=${i}`));
    expect(workers).toHaveLength(3); expect(terminated).toHaveLength(0);
    for (const worker of workers) worker.reply({ report: envelope({ totals: { calls: 1 } }) });
    await read.whenIdle(); await Bun.sleep(40);
    expect(terminated).toHaveLength(2);
    for (let i = 3; i < 6; i++) await read(ctx, new Request(`${url}&scope=${i}`));
    expect(workers).toHaveLength(5);
    for (const worker of workers.slice(2)) worker.reply({ report: envelope({ totals: { calls: 1 } }) });
    await read.whenIdle();
  } finally { await read.close(); close(); }
});

test("an oversized exception answer reaches its polling caller without escaping the cache budget", async () => {
  const { ctx, sqlite, close } = fixture(), worker = new FakeWorker(), memory = new ResponseMemoryBudget(512);
  const read = createDataRead(() => worker as unknown as Worker, { memory, workers: 1 });
  const body = { totals: { calls: 11 }, payload: "ą😀".repeat(1024) };
  try {
    expect((await read(ctx, new Request(url))).status).toBe(202);
    worker.reply({ report: envelope(body) }); await read.whenIdle();
    expect(memory.stats().bytes).toBe(0);
    const polling = read(ctx, new Request(url));
    expect(worker.work).toHaveLength(2);
    worker.reply({ report: envelope(body) });
    const response = await polling;
    expect(response.status).toBe(200); expect(response.headers.get("X-Analysis")).toBe("computed");
    expect(await response.json()).toEqual(body); expect(memory.stats().bytes).toBe(0);
    // An abandoned caller detaches without stopping its read snapshot.
    const aborted = new AbortController(), abandoned = read(ctx, new Request(url, { signal: aborted.signal }));
    aborted.abort(); expect((await abandoned).status).toBe(499);
    worker.reply({ report: envelope(body) }); await read.whenIdle();
    // A result computed across a source change keeps its captured version and is stale.
    const changed = read(ctx, new Request(url));
    sqlite.exec("UPDATE sync_revisions SET data_revision=2");
    worker.reply({ report: envelope(body) });
    const stale = await changed;
    expect(stale.headers.get("X-Analysis")).toBe("stale"); expect(stale.headers.get("Cache-Control")).toBe("no-store");
    const stopped = read(ctx, new Request(url));
    await read.close(); expect((await stopped).status).toBe(503);
  } finally { await read.close(); close(); }
});

test("shared pressure cannot trap a completed exception in repeated preparation", async () => {
  const { ctx, close } = fixture(), worker = new FakeWorker(), memory = new ResponseMemoryBudget(4096);
  const read = createDataRead(() => worker as unknown as Worker, { memory, workers: 1 });
  const body = { totals: { calls: 19 } }, pressure = {};
  try {
    expect((await read(ctx, new Request(url))).status).toBe(202);
    worker.reply({ report: envelope(body) }); await read.whenIdle();
    expect(memory.stats().entries).toBe(1);
    memory.retain(pressure, memory.limit, () => {});
    const request = read(ctx, new Request(url));
    worker.reply({ report: envelope(body) });
    expect(await (await request).json()).toEqual(body);
    expect(memory.stats().bytes).toBeLessThanOrEqual(memory.limit);
    memory.release(pressure);
  } finally { await read.close(); close(); }
});

test("an uncached reply crossing a reset during computation is delivered stale", async () => {
  const { ctx, close } = fixture(), worker = new FakeWorker(), memory = new ResponseMemoryBudget(512);
  const read = createDataRead(() => worker as unknown as Worker, { memory, workers: 1 });
  const gauge = "http://local/api/gauge?account=a", builtAt = Date.now(), resetAt = builtAt + 60_000;
  const report = { status: 200, body: { window: { reset_at: new Date(resetAt).toISOString() }, payload: "x".repeat(1024) },
    headers: [["X-Prepared-At", new Date(builtAt).toISOString()]] };
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    expect((await read(ctx, new Request(gauge))).status).toBe(202);
    worker.reply({ report }); await read.whenIdle();
    const polling = read(ctx, new Request(gauge));
    clock = spyOn(Date, "now").mockReturnValue(resetAt + 1);
    worker.reply({ report });
    const response = await polling;
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Analysis")).toBe("stale");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(memory.stats().bytes).toBe(0);
  } finally { clock?.mockRestore(); await read.close(); close(); }
});

test("bounded cycle batch equals single committed reads across restart, pending and historical correction", async () => {
  const { ctx, sqlite, close, reply } = storedFixture(), worker = new FakeWorker();
  let read = reader(worker);
  const urls = [new URL(breakdown("codex1", W1, W2)), new URL(breakdown("codex1", W2, W3))];
  try {
    for (const [index, url] of urls.entries()) {
      expect((await read.batch(ctx, [url]))[0]!.status).toBe(202);
      await settle(); reply(worker, { totals: { calls: index + 3, tokens: 100 + index, usd: 1.23456789 + index }, unpriced: { tokens: index } });
      await read.whenIdle(); publish(read, sqlite);
    }
    await read.close(); read = reader(worker);
    const query = spyOn(sqlite, "query");
    const batch = await read.batch(ctx, urls);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("FROM window_answers a WHERE"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("SELECT * FROM window_answers WHERE"))).toHaveLength(0);
    query.mockClear();
    for (const [index, url] of urls.entries()) {
      const single = await read(ctx, new Request(url));
      expect(await batch[index]!.json()).toEqual(await single.json());
      expect([...batch[index]!.headers]).toEqual([...single.headers]);
    }
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("SELECT * FROM window_answers WHERE"))).toHaveLength(2);
    query.mockRestore();
    expect(worker.work).toHaveLength(2);
    markWindowAnswersDirty(sqlite, { provider: "codex", account: "codex1", fromMs: Date.parse(W1) + 1000, untilMs: Date.parse(W1) + 2000 });
    const corrected = await read.batch(ctx, urls);
    expect(corrected.map(response => response.headers.get("X-Analysis"))).toEqual(["stale", "stored"]);
    expect((await corrected[0]!.json()).totals.usd).toBe(1.23456789);
    await settle(); reply(worker, { totals: { calls: 4, tokens: 102, usd: 2.34567891 } }); await read.whenIdle(); publish(read, sqlite);
    expect((await (await read.batch(ctx, urls))[0]!.json()).totals.usd).toBe(2.34567891);
    const aborted = new AbortController(); aborted.abort();
    expect((await read.batch(ctx, urls, aborted.signal)).map(response => response.status)).toEqual([499, 499]);
    expect(worker.work).toHaveLength(3);
  } finally { await read.close(); close(); }
});

test("cycle batch transport rejects non-cycle URLs and oversized groups without reading", async () => {
  let reads = 0;
  const invoke = (paths: unknown) => serveCycleReadBatch(new Request(`http://local/api/cycle-breakdowns?requests=${encodeURIComponent(JSON.stringify(paths))}`), async () => { reads++; return []; });
  for (const paths of [[], ["https://evil/api/cycle-breakdown?x=1"], ["/api/sync"], Array(13).fill("/api/cycle-breakdown?x=1")])
    expect((await invoke(paths)).status).toBe(400);
  expect(reads).toBe(0);
});

test("a stored window answer is read from its row after a restart, without any work", async () => {
  const { ctx, sqlite, close, reply } = storedFixture(), worker = new FakeWorker();
  let read = reader(worker);
  const closed = breakdown("codex1", W1, W2);
  try {
    expect((await read(ctx, new Request(closed))).status).toBe(202);
    await settle();
    expect(worker.work).toHaveLength(1);
    reply(worker, { totals: { calls: 7 } }); await read.whenIdle();
    expect(publish(read, sqlite)).toBe(1);
    read.close();
    read = reader(worker);
    const answer = await read(ctx, new Request(closed));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("X-Analysis")).toBe("stored");
    expect(answer.headers.get("X-Data-Version")).toBe("rows-1");
    expect(await answer.json()).toEqual({ totals: { calls: 7 } });
    await settle();
    expect(worker.work).toHaveLength(1);
  } finally { read.close(); close(); }
});

test("model cache history is published once, survives reader restart and follows its account's interval marks", async () => {
  const { ctx, sqlite, close, reply } = storedFixture(), worker = new FakeWorker();
  let read = reader(worker);
  const selected = "http://local/api/model-cache-history?account=codex1&model=model-a&since=2026-09-01&until=2026-09-12";
  const body = { account: "codex1", model: "model-a", grain: "day", hours: [{ input: 1000, cached: 950 }] };
  try {
    expect((await read(ctx, new Request(selected))).status).toBe(202);
    await settle(); reply(worker, body); await read.whenIdle();
    expect(publish(read, sqlite)).toBe(1);
    read.close(); read = reader(worker);
    expect(await (await read(ctx, new Request(selected))).json()).toEqual(body);
    await settle(); expect(worker.work).toHaveLength(1);
    markWindowAnswersDirty(sqlite, { provider: "codex", account: "codex2", fromMs: Date.parse(W1), untilMs: Date.parse(W2) });
    expect((await read(ctx, new Request(selected))).headers.get("X-Analysis")).toBe("stored");
    markWindowAnswersDirty(sqlite, { provider: "codex", account: "codex1", fromMs: Date.parse(W1), untilMs: Date.parse(W2) });
    expect((await read(ctx, new Request(selected))).headers.get("X-Analysis")).toBe("stale");
  } finally { read.close(); close(); }
});

test("changes of other accounts, providers or weeks leave the answer current; a change inside it is served stale and recomputed", async () => {
  const { ctx, sqlite, close, reply } = storedFixture(), worker = new FakeWorker(), read = reader(worker);
  const closed = breakdown("codex1", W1, W2);
  const clock = spyOn(Date, "now");
  try {
    await read(ctx, new Request(closed)); await settle();
    reply(worker, { calls: 1 }); await read.whenIdle();
    publish(read, sqlite);
    // The global data version moves with every sync; the answer's scope does not.
    sqlite.exec("UPDATE sync_revisions SET data_revision=2");
    markWindowAnswersDirty(sqlite, { provider: "claude", account: "*", fromMs: Date.parse(W1), untilMs: Date.parse(W3) });
    markWindowAnswersDirty(sqlite, { provider: "codex", account: "codex2", fromMs: Date.parse(W1), untilMs: Date.parse(W3) });
    markWindowAnswersDirty(sqlite, { provider: "codex", account: "*", fromMs: Date.parse(W2) + 1, untilMs: Date.parse(W3) });
    const kept = await read(ctx, new Request(closed));
    expect(kept.headers.get("X-Analysis")).toBe("stored");
    await settle();
    expect(worker.work).toHaveLength(1);
    // A late call of the week (the ledger marks it for every account).
    markWindowAnswersDirty(sqlite, { provider: "codex", account: "*", fromMs: Date.parse(W1) + 3_600_000, untilMs: Date.parse(W1) + 7_200_000 });
    const stale = await read(ctx, new Request(closed));
    expect(stale.status).toBe(200);
    expect(stale.headers.get("X-Analysis")).toBe("stale");
    expect(await stale.json()).toEqual({ calls: 1 });
    await settle();
    // Just computed: the refresh waits (marks arrive every turn while the background writer catches up).
    expect(worker.work).toHaveLength(1);
    clock.mockReturnValue(Date.now() + 20_000);
    expect((await read(ctx, new Request(closed))).headers.get("X-Analysis")).toBe("stale");
    await settle();
    expect(worker.work).toHaveLength(2);
    // A refresh of a screen already on display is not reported as waiting.
    expect(read.activity()).toEqual([]);
    reply(worker, { calls: 2 }); await read.whenIdle();
    publish(read, sqlite);
    const fresh = await read(ctx, new Request(closed));
    expect(fresh.headers.get("X-Analysis")).toBe("stored");
    expect(await fresh.json()).toEqual({ calls: 2 });
  } finally { clock.mockRestore(); read.close(); close(); }
});

test("a request seen first is answered from its family while computed; stale answers read lately are refreshed in the background", async () => {
  const { ctx, sqlite, close, reply } = storedFixture(), worker = new FakeWorker(), read = reader(worker);
  try {
    await read(ctx, new Request(breakdown("codex1", W2, "2026-09-10T00:00:00.000Z"))); await settle();
    reply(worker, { until: 10 }); await read.whenIdle();
    publish(read, sqlite);
    // The current window's observation range ends at its newest reading: a new reading is a new request of the same family.
    const moved = await read(ctx, new Request(breakdown("codex1", W2, "2026-09-11T00:00:00.000Z")));
    expect(moved.status).toBe(200);
    expect(moved.headers.get("X-Analysis")).toBe("stale");
    expect(await moved.json()).toEqual({ until: 10 });
    await settle();
    expect(worker.work).toHaveLength(2);
    reply(worker, { until: 11 }); await read.whenIdle();
    publish(read, sqlite);
    markWindowAnswersDirty(sqlite, { provider: "codex", account: "codex1", fromMs: Date.parse(W2), untilMs: null });
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 20_000);
    read.refreshStale();
    clock.mockRestore();
    await settle();
    // Both answers of the family were read lately and both are stale: one worker takes them in turn.
    expect(worker.work).toHaveLength(3);
    reply(worker, { until: 11, again: true }); await settle();
    expect(worker.work).toHaveLength(4);
    reply(worker, { until: 10, again: true }); await read.whenIdle();
  } finally { read.close(); close(); }
});

test("a request outside the stored shape is an exception view kept in memory", async () => {
  const { ctx, close } = storedFixture(), worker = new FakeWorker(), read = reader(worker);
  const live = `http://local/api/cycle-breakdown?account=codex1&since_ts=${W1}&until_ts=${W2}`;
  try {
    await read(ctx, new Request(live)); await settle();
    worker.reply({ report: envelope({ live: true }) }); await read.whenIdle();
    expect((await read(ctx, new Request(live))).headers.get("X-Analysis")).toBe("memory");
    expect(read.takeAnswersToStore()).toEqual([]);
  } finally { read.close(); close(); }
});

test("a window screen is built by its producer and its clock fields are presented at read time", async () => {
  const { ctx, sqlite, close } = storedFixture(), worker = new FakeWorker(), read = reader(worker);
  const series = "http://local/api/usage-series?account=codex1&window=10080&points=900";
  const builtAt = Date.parse("2026-10-06T10:00:00.000Z");
  const clock = spyOn(Date, "now").mockReturnValue(builtAt);
  try {
    expect((await read(ctx, new Request(series))).status).toBe(202);
    await settle();
    expect(worker.work[0]!.request).toEqual({ kind: "screen", url: "/api/usage-series?account=codex1&points=900&window=10080" });
    worker.reply({ report: { status: 200, body: { latest: { ts: "2026-10-06T09:00:00.000Z", age_hours: 1 } },
      headers: [["X-Prepared-At", new Date(builtAt).toISOString()]] }, snapshot: { checked: 0, version: "rows-1" } });
    await read.whenIdle();
    publish(read, sqlite);
    clock.mockReturnValue(builtAt + 3 * 60_000);
    const later = await read(ctx, new Request(series));
    expect(later.headers.get("X-Analysis")).toBe("stored");
    expect(await later.json()).toEqual({ latest: { ts: "2026-10-06T09:00:00.000Z", age_hours: 1.05 } });
    // A request with its own date range is not a stored screen.
    expect((await read(ctx, new Request(`${series}&since=2026-09-01`))).status).toBe(404);
  } finally { clock.mockRestore(); await read.close(); close(); }
});

test("a subscription's window rail is computed before the other screens waiting for a worker", async () => {
  const { ctx, close, reply } = storedFixture(), worker = new FakeWorker(), read = reader(worker);
  try {
    await read(ctx, new Request(breakdown("codex1", W1, W2)));
    await read(ctx, new Request(breakdown("codex1", W2, W3)));
    await read(ctx, new Request("http://local/api/usage-series?account=codex1&window=10080&points=900"));
    await settle();
    expect(worker.work).toHaveLength(1);
    reply(worker, { first: true }); await settle();
    expect(worker.work[1]!.request).toEqual({ kind: "screen", url: "/api/usage-series?account=codex1&points=900&window=10080" });
    reply(worker, { rail: true }); await settle();
    reply(worker, { second: true }); await read.whenIdle();
  } finally { await read.close(); close(); }
});

test("prefill computes every screen's default answers one at a time, rails first, then goes idle until a mark", async () => {
  const { ctx, sqlite, close, reply } = storedFixture(), worker = new FakeWorker(), read = reader(worker);
  (ctx.accounts as { subscriptions: unknown[] }).subscriptions = [{ id: "grok-x", vendor: "grok" }];
  const urls = () => worker.work.map(work => (work.request as { url: string }).url.split("?")[0]);
  const step = async () => { read.prefill(ctx); await Bun.sleep(5); };
  try {
    await step();
    expect(worker.work).toHaveLength(0);
    read.prefillReady(true);
    await step();
    expect(urls()).toEqual(["/api/windows"]);
    // A request for a screen queued meanwhile goes first; the prefill waits for a free worker.
    await read(ctx, new Request(breakdown("codex1", W1, W2)));
    reply(worker, { windows: [] }); await step();
    expect(urls()).toEqual(["/api/windows", "/api/cycle-breakdown"]);
    reply(worker, { totals: { calls: 1 } }); await step(); await step();
    // The range screen's default (a moving end) once its family has no answer.
    expect(urls()).toEqual(["/api/windows", "/api/cycle-breakdown", "/api/subscription-accounting"]);
    reply(worker, { windows: [] }); await step(); await step(); await step();
    expect(worker.work).toHaveLength(3);
    expect(read.prefillState()).toMatchObject({ idle: true, computed: 0 });
    publish(read, sqlite);
    // A mark over the account makes its rail stale: only it is computed again.
    markWindowAnswersDirty(sqlite, { provider: "grok", account: "grok-x", fromMs: 0, untilMs: null });
    await step();
    expect(urls()).toEqual(["/api/windows", "/api/cycle-breakdown", "/api/subscription-accounting", "/api/windows"]);
    reply(worker, { windows: [] }); await step(); await step(); await step();
    expect(worker.work).toHaveLength(4);
  } finally { await read.close(); close(); }
});

test("another view reads a stored answer only while nothing it read has changed", () => {
  const { ctx, sqlite, close } = storedFixture();
  const url = new URL("http://local/api/claude-limit?account=claude-a"), now = Date.now();
  const answer = (configuration: string) => ({ route: url.pathname, key: "/api/claude-limit?account=claude-a", family: "f",
    scope: { provider: "claude", account: "claude-a", fromMs: -1e15, untilMs: null }, configuration, checked: 0, builtAt: now,
    expiresAt: now + 300_000, status: 200, version: "v", headers: [["X-Prepared-At", new Date(now).toISOString()]] as Array<[string, string]>,
    body: JSON.stringify({ plan: "max", current: null }) });
  try {
    storeWindowAnswers(sqlite, [answer("other")]);
    expect(currentStoredBody(ctx, url, now)).toBeNull();
    storeWindowAnswers(sqlite, [{ ...answer(storedAnswerConfiguration(ctx, url)), builtAt: now + 1 }]);
    expect(currentStoredBody(ctx, url, now + 1)).toEqual({ plan: "max", current: null });
    markWindowAnswersDirty(sqlite, { provider: "claude", account: "claude-b", fromMs: 0, untilMs: null });
    expect(currentStoredBody(ctx, url, now + 1)).not.toBeNull();
    markWindowAnswersDirty(sqlite, { provider: "claude", account: "claude-a", fromMs: 0, untilMs: null });
    expect(currentStoredBody(ctx, url, now + 1)).toBeNull();
  } finally { close(); }
});

test("a closed Claude window's answer is not computed again by the clock, the live window's is", async () => {
  const { ctx, close, reply } = storedFixture(), worker = new FakeWorker(), read = reader(worker);
  (ctx.accounts as { subscriptions: unknown[] }).subscriptions = [{ id: "claude-a", vendor: "claude" }];
  try {
    await read(ctx, new Request("http://local/api/claude-limit?account=claude-a&from=2026-06-07T11:00:00.000Z&until=2026-06-14T11:00:00.000Z"));
    await settle(); reply(worker, { current: null }); await read.whenIdle();
    await read(ctx, new Request("http://local/api/claude-limit?account=claude-a"));
    await settle(); reply(worker, { current: null }); await read.whenIdle();
    const [closed, live] = read.takeAnswersToStore();
    expect(closed!.expiresAt).toBeNull();
    expect(live!.expiresAt).toBeGreaterThan(Date.now());
  } finally { await read.close(); close(); }
});


test("a dated breakdown keeps unrelated configuration changes across restart, but follows its actual dependencies", async () => {
  const { ctx, sqlite, close, reply } = storedFixture(), worker = new FakeWorker();
  let read = reader(worker);
  const closed = breakdown("codex1", W1, W2), selected = new URL(closed);
  try {
    ctx.subIdToHomes.set("codex1", ["fixture-home"]);
    expect((await read(ctx, new Request(closed))).status).toBe(202);
    reply(worker, { totals: { calls: 7 } }); await read.whenIdle(); publish(read, sqlite);
    const configuration = storedAnswerConfiguration(ctx, selected);
    ctx.claudeGauge = { unrelated: "new" } as never;
    ctx.grokGauge = { unrelated: "new" } as never;
    ctx.accounts.subscriptions.push({ id: "claude-other", vendor: "claude", label: "Changed" });
    ctx.subIdToHomes.set("other", ["other-home"]);
    ctx.plansCatalog = { provider_groups: [], unrelated: "new" } as never;
    ctx.cycles = { unrelated: "new" } as never;
    expect(storedAnswerConfiguration(ctx, selected)).toBe(configuration);
    await read.close(); read = reader(worker);
    const response = await read(ctx, new Request(closed));
    expect(response.headers.get("X-Analysis")).toBe("stored");
    expect(await response.json()).toEqual({ totals: { calls: 7 } });
    expect(currentStoredBody(ctx, selected)).toEqual({ totals: { calls: 7 } });
    expect(worker.work).toHaveLength(1);
    ctx.subIdToHomes.set("codex1", ["new-home"]);
    expect(storedAnswerConfiguration(ctx, selected)).not.toBe(configuration);
    expect(currentStoredBody(ctx, selected)).toBeNull();
    expect((await read(ctx, new Request(closed))).headers.get("X-Analysis")).toBe("stale");
    expect(worker.work).toHaveLength(2);
    reply(worker, { totals: { calls: 9 } }); await read.whenIdle(); publish(read, sqlite);
    const beforePolicy = storedAnswerConfiguration(ctx, selected);
    ctx.rateCards = { ...ctx.rateCards, codex_accounting: { version: 1, rules: [] } };
    expect(storedAnswerConfiguration(ctx, selected)).not.toBe(beforePolicy);
  } finally { await read.close(); close(); }
});

test("a configuration changed while a worker computes cannot make its captured answer current", async () => {
  const { ctx, sqlite, close, reply } = storedFixture(), worker = new FakeWorker();
  let read = reader(worker);
  const closed = breakdown("codex1", W1, W2);
  try {
    ctx.subIdToHomes.set("codex1", ["old-home"]);
    expect((await read(ctx, new Request(closed))).status).toBe(202);
    ctx.subIdToHomes.set("codex1", ["new-home"]);
    reply(worker, { totals: { calls: 1 } }); await read.whenIdle(); publish(read, sqlite);
    await read.close(); read = reader(worker);
    const old = await read(ctx, new Request(closed));
    expect(old.headers.get("X-Analysis")).toBe("stale");
    expect(await old.json()).toEqual({ totals: { calls: 1 } });
    // A failed replacement never overwrites the last complete answer.
    worker.reply({ error: "synthetic producer failure" }); await read.whenIdle();
    expect(read.takeAnswersToStore()).toEqual([]);
    expect((await read(ctx, new Request(closed))).headers.get("X-Analysis")).toBe("stale");
    await read.close(); read = reader(worker);
    await read(ctx, new Request(closed));
    reply(worker, { totals: { calls: 2 } }); await read.whenIdle(); publish(read, sqlite);
    expect((await read(ctx, new Request(closed))).headers.get("X-Analysis")).toBe("stored");
  } finally { await read.close(); close(); }
});
