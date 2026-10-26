import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { buildEraIndex } from "./eras";
import { prepareProbeReaderFixture, probeReaderFixtureSource, splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { prepareClaudeCardMetadataFixture } from "./claude-card-metadata.fixture";
import { createDirectRead, createDirectReadWorker } from "./direct-read";
import { CoalescedReads } from "./coalesced-read";
import type { DirectReadWork } from "./direct-read";
import { handleRoster, handleWindows, periodEras, type AppContext } from "./api";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const subscriptions = [probeReaderFixtureSource("claude", "claude-seat"), probeReaderFixtureSource("grok", "grok")];
function fileContext(): AppContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-direct-read-")), file = path.join(dir, "atlas.sqlite");
  const sqlite = new Database(file, { create: true });
  cleanups.push(() => { sqlite.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  sqlite.exec("PRAGMA journal_mode=WAL");
  applyDrizzleMigrations(drizzle(sqlite), path.resolve(import.meta.dir, "../../drizzle"));
  sqlite.run(`INSERT INTO probe_windows (provider, subject, ts, kind, reported_percent_side, used_percent, ok, resets_at, window_minutes)
    VALUES ('claude', 'claude-seat', '2026-08-01T10:00:00.000Z', 'weekly_all', 'used', 42, 1, '2026-08-05T00:00:00.000Z', 10080)`);
  prepareProbeReaderFixture(sqlite, subscriptions);
  const rateCards = { version: 1, currency: "USD", unit: "per 1M", vendors: {} } as never;
  fillUsageLedgerFixture(sqlite, rateCards);
  prepareWindowUsageFixture(sqlite, { rateCards, claudeGauge: {}, manualCapacity: () => [], cycles: { windows: [] } });
  prepareClaudeCardMetadataFixture(sqlite, ["claude-seat"]);
  const accounts = splitProbeReaderFixtureConfig(subscriptions);
  return { sqlite, dbPath: file, accounts, homeToSubId: new Map(), subIdToHomes: new Map(),
    eras: buildEraIndex(periodEras(sqlite, accounts), "instant"), eraErrors: [],
    claudeGauge: { subscription: "claude-seat", vendor: "claude", plan: "max" },
    grokGauge: { subscription: "grok", store: "grok", plan: "xai", window_hours: 168 },
    rateCards: { vendors: {} }, cycles: { windows: [] }, plans: { segments: [] }, plansCatalog: { provider_groups: [] },
    rootDir: path.resolve(import.meta.dir, "../.."), manualCapacity: [] } as unknown as AppContext;
}
/** Ages and a rolling window without calls follow the clock of the moment each answer was built. */
const withoutAges = (body: string) => JSON.stringify(JSON.parse(body), (key, value) => /age|^since_ts$|^until_ts$/.test(key) ? null : value);

test("roster and windows are built in a worker, off the HTTP thread, with the same answer as in place", async () => {
  const ctx = fileContext();
  let workers = 0;
  const read = createDirectRead(() => { workers++; return createDirectReadWorker(); });
  cleanups.push(() => read.close());
  for (const route of ["/api/roster?window=10080", "/api/roster?window=300", "/api/windows?account=claude-seat"]) {
    const url = new URL(`http://localhost${route}`);
    const inPlace = await (url.pathname === "/api/roster" ? handleRoster(ctx, url) : handleWindows(ctx, url));
    const viaWorker = await read(ctx, url);
    expect(viaWorker.status).toBe(inPlace.status);
    expect(viaWorker.headers.get("X-Data-Version")).toBeTruthy();
    expect(withoutAges(await viaWorker.text())).toBe(withoutAges(await inPlace.text()));
  }
  // Requests one after another reuse one worker.
  expect(workers).toBe(1);
  // Two at once run on two workers; a third waits for a free one.
  const url = new URL("http://localhost/api/roster?window=10080");
  const answers = await Promise.all([read(ctx, url), read(ctx, url), read(ctx, url)]);
  expect(answers.map(answer => answer.status)).toEqual([200, 200, 200]);
  expect(workers).toBe(2);
});

test("an in-memory database builds the screen in place", async () => {
  let workers = 0;
  const read = createDirectRead(() => { workers++; return createDirectReadWorker(); });
  cleanups.push(() => read.close());
  const ctx = { ...fileContext(), dbPath: ":memory:" } as AppContext;
  expect((await read(ctx, new URL("http://localhost/api/roster?window=10080"))).status).toBe(200);
  expect(workers).toBe(0);
});

function controlledPool(options: { idleMs?: number } = {}) {
  const workers: Array<{ worker: Worker; requests: DirectReadWork[]; terminated: boolean }> = [];
  const read = createDirectRead(() => {
    const state = { requests: [] as DirectReadWork[], terminated: false, worker: null as unknown as Worker };
    state.worker = {
      onmessage: null, onerror: null, ref() {}, unref() {},
      terminate() { state.terminated = true; },
      postMessage(work: DirectReadWork | { close: true }) {
        if ("close" in work) queueMicrotask(() => state.worker.onmessage?.({ data: { closed: true } } as MessageEvent));
        else state.requests.push(work);
      },
    } as unknown as Worker;
    workers.push(state);
    return state.worker;
  }, options);
  cleanups.push(() => read.close());
  const ctx = { dbPath: "controlled.sqlite", homeToSubId: new Map(), subIdToHomes: new Map() } as AppContext;
  const url = (account: string) => new URL(`http://localhost/api/windows?account=${account}`);
  const answer = (index: number) => workers[index]!.worker.onmessage?.({
    data: { status: 200, headers: [], body: JSON.stringify({ account: workers[index]!.requests.at(-1)!.url }) },
  } as MessageEvent);
  return { read, ctx, url, workers, answer };
}

test("idle expiry preserves a warm reader and restores pool slots for a later burst", async () => {
  const { read, ctx, url, workers, answer } = controlledPool({ idleMs: 10 });
  const first = read(ctx, url("one")), second = read(ctx, url("two"));
  await Bun.sleep(0); answer(0); answer(1); await Promise.all([first, second]);
  await Bun.sleep(40);
  expect(workers.filter(state => state.terminated)).toHaveLength(1);
  const third = read(ctx, url("three")), fourth = read(ctx, url("four"));
  await Bun.sleep(0);
  expect(workers).toHaveLength(3);
  expect(workers[1]!.requests.at(-1)!.url).toContain("three");
  answer(1); answer(2);
  expect((await third).status).toBe(200); expect((await fourth).status).toBe(200);
});

test("an abandoned queued screen never occupies a worker ahead of the latest selection", async () => {
  const { read, ctx, url, workers, answer } = controlledPool();
  const first = read(ctx, url("one")), second = read(ctx, url("two"));
  const cancelled = new AbortController();
  const old = read(ctx, url("old"), cancelled.signal), latest = read(ctx, url("latest"));
  await Bun.sleep(0);
  cancelled.abort();
  expect((await old).status).toBe(499);
  answer(0);
  expect((await first).status).toBe(200);
  await Bun.sleep(0);
  expect(workers[0]!.requests.map(work => work.url)).toEqual(["/api/windows?account=one", "/api/windows?account=latest"]);
  answer(0); answer(1);
  expect((await latest).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(workers.some(state => state.terminated)).toBe(false);
});

test("cancellation before posting releases the granted slot, and already cancelled reads start no work", async () => {
  const { read, ctx, url, workers, answer } = controlledPool();
  const controller = new AbortController();
  controller.abort();
  expect((await read(ctx, url("old"), controller.signal)).status).toBe(499);
  expect(workers.length).toBe(0);
  const granted = new AbortController();
  const pending = read(ctx, url("old"), granted.signal);
  granted.abort();
  expect((await pending).status).toBe(499);
  expect(workers[0]!.requests.length).toBe(0);
  const latest = read(ctx, url("latest"));
  await Bun.sleep(0);
  expect(workers.length).toBe(1);
  answer(0);
  expect((await latest).status).toBe(200);
});

test("a coalesced queued screen survives one caller leaving and disappears when its last caller leaves", async () => {
  const { read, ctx, url, workers, answer } = controlledPool();
  const first = read(ctx, url("one")), second = read(ctx, url("two"));
  const reads = new CoalescedReads(), a = new AbortController(), b = new AbortController();
  const build = (signal: AbortSignal) => read(ctx, url("shared"), signal);
  const one = reads.run("shared", a.signal, build), two = reads.run("shared", b.signal, build);
  await Bun.sleep(0);
  a.abort();
  expect((await one).status).toBe(499);
  answer(0);
  await first;
  await Bun.sleep(0);
  expect(workers[0]!.requests.at(-1)!.url).toBe("/api/windows?account=shared");
  answer(0);
  expect((await two).status).toBe(200);
  const busy = read(ctx, url("three"));
  const c = new AbortController(), d = new AbortController();
  const three = reads.run("abandoned", c.signal, signal => read(ctx, url("abandoned"), signal));
  const four = reads.run("abandoned", d.signal, signal => read(ctx, url("abandoned"), signal));
  await Bun.sleep(0);
  c.abort(); d.abort();
  expect((await three).status).toBe(499);
  expect((await four).status).toBe(499);
  answer(0); answer(1);
  await busy; await second;
  await Bun.sleep(0);
  expect(workers.flatMap(state => state.requests).some(work => work.url.includes("abandoned"))).toBe(false);
});

test("a running snapshot finishes after cancellation, and closing drains queued callers", async () => {
  const { read, ctx, url, workers, answer } = controlledPool();
  const controller = new AbortController();
  const first = read(ctx, url("one"), controller.signal), second = read(ctx, url("two"));
  const queued = read(ctx, url("queued"));
  await Bun.sleep(0);
  controller.abort();
  expect(workers.some(state => state.terminated)).toBe(false);
  await read.close();
  expect((await queued).status).toBe(499);
  answer(0); answer(1);
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
});
