import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { ensureWindowAnswersSchema, markWindowAnswersDirty, storeWindowAnswers } from "../db/window-answers";
import { buildEraIndex } from "./eras";
import type { AppContext } from "./api";
import type { DataWork } from "./data-worker";
import type { DataEnvelope } from "./data-views";
import { createDataRead, cycleBatchRows } from "./data-read";
import { createDirectRead, createDirectReadWorker, type DirectReadWork } from "./direct-read";
import { readSyncRows, syncReadRows } from "./read-refresh";

/**
 * The cycle batch and the sync check are polled by every tab: with a database file they query nothing on the
 * HTTP thread (a pinned WAL made such reads take seconds there), and a long screen build never holds them.
 */
const cleanups: Array<() => unknown> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  work: DataWork[] = [];
  postMessage(work: DataWork | { close: true }) { if ("close" in work) this.reply({ closed: true }); else this.work.push(work); }
  terminate() {}
  reply(data: unknown) { this.onmessage?.({ data }); }
}
const envelope = (body: unknown, status = 200): DataEnvelope => ({ status, body, headers: [] });
const settle = () => Bun.sleep(0);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-read-lane-")), dbPath = path.join(dir, "data.sqlite");
  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec(`CREATE TABLE sync_revisions(id INTEGER PRIMARY KEY,data_revision INTEGER,config_revision INTEGER);
    INSERT INTO sync_revisions VALUES(1,1,1);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);`);
  sqlite.exec(fs.readFileSync(new URL("../../drizzle/0040_account_periods.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  ensureWindowAnswersSchema(sqlite);
  const ctx = { sqlite, dbPath, accounts: { version: 2, subscriptions: [{ id: "claude-seat", vendor: "claude" }], sources: [] },
    homeToSubId: new Map(), subIdToHomes: new Map(), eras: buildEraIndex([]), eraErrors: [], homeConflict: null,
    rateCards: { version: 2, currency: "USD", unit: "per 1M", vendors: {} }, claudeGauge: {}, grokGauge: {}, cycles: {}, plans: {},
    plansCatalog: { provider_groups: [] }, rootDir: process.cwd() } as unknown as AppContext;
  cleanups.push(() => { sqlite.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const seq = () => (sqlite.query("SELECT seq FROM sqlite_sequence WHERE name='window_answer_marks'").get() as { seq: number } | null)?.seq ?? 0;
  const reply = (worker: FakeWorker, body: unknown) => worker.reply({ report: envelope(body), snapshot: { checked: seq(), version: "rows-1" } });
  return { ctx, sqlite, reply };
}
/** The main-thread connection, recording (and refusing) every statement while armed. */
function guarded(ctx: AppContext) {
  const calls: string[] = [];
  let armed = false;
  const sqlite = new Proxy(ctx.sqlite, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (armed && typeof prop === "string" && ["query", "prepare", "run", "exec", "transaction"].includes(prop))
      return (...args: unknown[]) => { calls.push(`${prop} ${String(args[0] ?? "").slice(0, 60)}`); throw new Error(`main-thread ${prop}`); };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ctx: { ...ctx, sqlite } as AppContext, calls, async during<T>(run: () => Promise<T>): Promise<T> {
    armed = true;
    try { return await run(); } finally { armed = false; }
  } };
}
const W1 = "2026-09-01T00:00:00.000Z", W2 = "2026-09-08T00:00:00.000Z", W3 = "2026-09-15T00:00:00.000Z";
const breakdown = (account: string, since: string, until: string) =>
  new URL(`http://local/api/cycle-breakdown?account=${account}&since_ts=${since}&until_ts=${until}&limit_id=codex&valuation=dated`);
const envelopes = (responses: Response[]) => Promise.all(responses.map(async response =>
  ({ status: response.status, headers: [...response.headers], body: await response.text() })));

/** Stored A and B (B then marked stale), a request of A's family, one without any answer, and a kept failure. */
async function storedRows() {
  const f = fixture(), seedWorker = new FakeWorker(), seed = createDataRead(() => seedWorker as unknown as Worker, { workers: 1 });
  const stored = breakdown("codex1", W1, W2), stale = breakdown("codex1", W2, W3);
  for (const [index, url] of [stored, stale].entries()) {
    expect((await seed(f.ctx, new Request(url))).status).toBe(202);
    await settle(); f.reply(seedWorker, { totals: { calls: index + 3, usd: 1.25 + index } }); await seed.whenIdle();
    storeWindowAnswers(f.sqlite, seed.takeAnswersToStore());
  }
  await seed.close();
  markWindowAnswersDirty(f.sqlite, { provider: "codex", account: "codex1", fromMs: Date.parse(W2) + 1000, untilMs: Date.parse(W2) + 2000 });
  const urls = [stored, stale, breakdown("codex1", W1, W3), breakdown("codex2", W1, W2), breakdown("codex3", W1, W2)];
  /** A reader whose last request failed: kept while nothing in its scope changes. */
  const withFailure = async (read: ReturnType<typeof createDataRead>, worker: FakeWorker) => {
    expect((await read(f.ctx, new Request(urls[4]!))).status).toBe(202);
    await settle(); worker.reply({ error: "boom" }); await read.whenIdle();
  };
  return { ...f, urls, withFailure };
}

test("no main-thread read for the batch route: stored, stale, family, preparing and failed answers equal the in-place read", async () => {
  const f = await storedRows();
  const direct = createDirectRead(createDirectReadWorker);
  cleanups.push(() => direct.close());
  const inPlaceWorker = new FakeWorker(), laneWorker = new FakeWorker();
  const inPlace = createDataRead(() => inPlaceWorker as unknown as Worker, { workers: 1 });
  const viaLane = createDataRead(() => laneWorker as unknown as Worker, { workers: 1, light: direct.light });
  cleanups.push(() => inPlace.close(), () => viaLane.close());
  await f.withFailure(inPlace, inPlaceWorker); await f.withFailure(viaLane, laneWorker);
  const expected = await envelopes(await inPlace.batch(f.ctx, f.urls));
  expect(expected.map(answer => [answer.status, answer.headers.find(([name]) => name === "x-analysis")?.[1]]))
    .toEqual([[200, "stored"], [200, "stale"], [200, "stale"], [202, "preparing"], [503, "memory"]]);
  const guard = guarded(f.ctx);
  const answers = await guard.during(async () => envelopes(await viaLane.batch(guard.ctx, f.urls)));
  expect(guard.calls).toEqual([]);
  expect(answers).toEqual(expected);
  // The stale, family and missing answers were queued for recompute on the data workers, as in place.
  await settle();
  expect(viaLane.activity()).toEqual(inPlace.activity());
  expect(laneWorker.work.map(work => work.request.url)).toEqual(inPlaceWorker.work.map(work => work.request.url));
  expect(laneWorker.work.map(work => work.eras)).toEqual(inPlaceWorker.work.map(work => work.eras));
  // An aborted batch starts no work.
  const queued = laneWorker.work.length, aborted = new AbortController();
  const cancelled = guard.during(() => viaLane.batch(guard.ctx, f.urls, aborted.signal));
  aborted.abort();
  expect((await cancelled).map(response => response.status)).toEqual([499, 499, 499, 499, 499]);
  await settle();
  expect(laneWorker.work.length).toBe(queued);
  expect(guard.calls).toEqual([]);
  // The guard does see the in-place path (the batch before the lookup lane).
  await guard.during(async () => { try { await inPlace.batch(guard.ctx, f.urls); } catch { /* refused by the guard */ } });
  expect(guard.calls.length).toBeGreaterThan(0);
}, 30_000);

test("no main-thread read for the sync read-changes check: the same rows as in place", async () => {
  const f = fixture();
  const direct = createDirectRead(createDirectReadWorker);
  cleanups.push(() => direct.close());
  const paths = ["/api/codex-accounting?account=seat-a&since=2026-09-01&until=2026-09-07",
    "/api/codex-accounting?account=seat-b&since=2026-09-01&until=2026-09-07", "/api/windows?account=claude-seat",
    `/api/cycle-breakdown?account=seat-a&since_ts=${W1}&until_ts=${W2}&valuation=dated`];
  const check = (cursor?: number) => {
    const url = new URL("http://local/api/sync");
    url.searchParams.set("read_paths", JSON.stringify(paths));
    if (cursor !== undefined) url.searchParams.set("read_cursor", String(cursor));
    return url;
  };
  const guard = guarded(f.ctx);
  const first = await guard.during(() => readSyncRows(guard.ctx, check(), direct.light));
  expect(guard.calls).toEqual([]);
  expect(first).toEqual(syncReadRows(f.ctx, check()));
  expect(first!.read_changes?.reset).toBe(true);
  expect(first!.outbox).toEqual({ pending: 0, oldestQueuedAt: null });
  markWindowAnswersDirty(f.sqlite, { provider: "codex", account: "seat-a", fromMs: Date.parse("2026-09-03"), untilMs: Date.parse("2026-09-04") });
  const next = await guard.during(() => readSyncRows(guard.ctx, check(first!.read_changes!.cursor), direct.light));
  expect(guard.calls).toEqual([]);
  expect(next).toEqual(syncReadRows(f.ctx, check(first!.read_changes!.cursor)));
  expect(next!.read_changes?.unchanged).toEqual([paths[1]!, paths[2]!]);
  const aborted = new AbortController(); aborted.abort();
  expect(await readSyncRows(guard.ctx, check(), direct.light, aborted.signal)).toBeNull();
  // The guard does see the in-place check.
  await guard.during(async () => { try { syncReadRows(guard.ctx, check()); } catch { /* refused by the guard */ } });
  expect(guard.calls.length).toBeGreaterThan(0);
}, 30_000);

test("the light lane answers while every screen worker and the data worker run long builds; identical lookups share one read", async () => {
  const f = await storedRows();
  const workers: Array<{ requests: DirectReadWork[] }> = [];
  // Screens never answer (an 8.5 s build); a lookup answers from the rows, as the real worker does.
  const direct = createDirectRead(() => {
    const state = { requests: [] as DirectReadWork[] };
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null, onerror: null, ref() {}, unref() {}, terminate() {},
      postMessage(work: DirectReadWork | { close: true }) {
        if ("close" in work) { queueMicrotask(() => worker.onmessage?.({ data: { closed: true } } as MessageEvent)); return; }
        state.requests.push(work);
        const light = work.light;
        if (light) queueMicrotask(() => worker.onmessage?.({ data: { value: light.kind === "sync"
          ? syncReadRows(f.ctx, new URL(work.url, "http://local")) : cycleBatchRows(f.ctx, light) } } as MessageEvent));
      },
    };
    workers.push(state);
    return worker as unknown as Worker;
  });
  cleanups.push(() => direct.close());
  const dataWorker = new FakeWorker();
  const read = createDataRead(() => dataWorker as unknown as Worker, { workers: 1, light: direct.light });
  cleanups.push(() => read.close());
  const screens = ["a", "b", "c"].map(account => direct(f.ctx, new URL(`http://local/api/windows?account=${account}`)));
  // The one data worker builds an exception view that does not end during the test.
  expect((await read(f.ctx, new Request("http://local/api/account-history?group=day"))).status).toBe(202);
  await settle();
  expect(dataWorker.work).toHaveLength(1);
  expect(workers.map(state => state.requests.length)).toEqual([1, 1]);
  const sync = new URL("http://local/api/sync");
  sync.searchParams.set("read_paths", JSON.stringify(["/api/windows?account=claude-seat"]));
  const [one, two, rows] = await Promise.all([read.batch(f.ctx, f.urls.slice(0, 2)), read.batch(f.ctx, f.urls.slice(0, 2)),
    readSyncRows(f.ctx, sync, direct.light)]);
  expect(one.map(response => response.headers.get("X-Analysis"))).toEqual(["stored", "stale"]);
  expect(await envelopes(two)).toEqual(await envelopes(one));
  expect(rows?.read_changes?.reset).toBe(true);
  // A third worker, the lookup lane's: the two identical batches shared one read.
  expect(workers).toHaveLength(3);
  expect(workers[2]!.requests.map(work => work.light?.kind)).toEqual(["cycle-batch", "sync"]);
  expect(dataWorker.work).toHaveLength(1);
  void screens;
}, 30_000);
