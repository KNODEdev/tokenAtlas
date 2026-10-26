import { handleRoster as apiHandleRoster } from "./api-roster";
import { handleWindows as apiHandleWindows } from "./api-window-rail";
import { handleUsageSeries as apiHandleUsageSeries } from "./api-usage-series";
import { handleAccountPeriods as apiHandleAccountPeriods } from "./api-setup";
import type { AppContext } from "./app-context-types";
import { DATA_VIEWS, serveDataView, snapshotDataContext, type DataContext } from "./data-views";
import { codexSourceHomes } from "./capacity-equivalents";
import type { RateCard } from "./pricing";
import { cancelledRead } from "./coalesced-read";
import { IdleReadWorkers } from "./idle-read-workers";

/**
 * Stored-row screens whose cold read still takes a noticeable time (plan U1.3/U1.4): built on each request
 * like before, but in a worker (`direct-read-worker.ts`), so the HTTP thread stays responsive while a long
 * Claude history is read. Nothing is kept here; the response cache in front of them is unchanged.
 */
export const DIRECT_READ_HANDLERS: Readonly<Record<string, (ctx: AppContext, url: URL) => Promise<Response>>> = {
  "/api/roster": (ctx, url) => apiHandleRoster(ctx, url),
  "/api/windows": (ctx, url) => apiHandleWindows(ctx, url),
  // A Codex account's window rail: on the HTTP thread it held every other read of a subscription switch.
  "/api/usage-series": async (ctx, url) => apiHandleUsageSeries(ctx, url),
  // The account periods drawer (Okresy) reads every account's periods and observed identities (1-3 s).
  "/api/account-periods": (ctx, url) => apiHandleAccountPeriods(ctx, new Request(url)),
};
/**
 * The builder of a direct read: a declared screen above, or a stored-row data view (`DataView.direct`). Rows views
 * are built here too, off the HTTP thread: one taking a second (projects after a sync) held every other request.
 */
export function directReadHandler(pathname: string): ((ctx: AppContext, url: URL) => Promise<Response>) | undefined {
  return DIRECT_READ_HANDLERS[pathname] ?? (DATA_VIEWS[pathname]?.direct ? (ctx, url) => serveDataView(ctx, url) : undefined);
}
export interface DirectReadWork {
  close?: undefined; dbPath: string; url: string; context: DataContext; rates: RateCard;
  homes: Array<[string, string]>; sourceHomes: string[];
}
export type DirectReadAnswer = { status: number; headers: Array<[string, string]>; body: string } | { error: string };

/** Workers build at most this many screens at once; more requests wait for a free one. */
const WORKERS = 2;
/** Bun's Worker can stop keeping the process alive; the DOM type does not declare it. */
const held = (worker: Worker) => worker as Worker & { ref(): void; unref(): void };
const TIMEOUT_MS = 120_000;

export function createDirectReadWorker(): Worker {
  return new Worker(new URL("./direct-read-worker.ts", import.meta.url).href, {
    env: Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value] as [string, string]])),
  });
}

export function createDirectRead(workerFactory = createDirectReadWorker, options: { idleMs?: number } = {}) {
  const waiting: Array<(worker: Worker | null) => void> = [];
  let started = 0, stopped = false;
  const idle = new IdleReadWorkers(() => { started--; }, options.idleMs);
  const acquire = (signal?: AbortSignal): Promise<Worker | null> => {
    if (stopped || signal?.aborted) return Promise.resolve(null);
    const free = idle.pop();
    if (free) { held(free).ref(); return Promise.resolve(free); }
    if (started < WORKERS) { started++; return Promise.resolve(workerFactory()); }
    return new Promise(resolve => {
      const take = (worker: Worker | null) => {
        signal?.removeEventListener("abort", abort);
        resolve(worker);
      };
      const abort = () => {
        const index = waiting.indexOf(take);
        if (index < 0) return;
        waiting.splice(index, 1);
        take(null);
      };
      waiting.push(take);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
  const release = (worker: Worker | null) => {
    if (!worker) started--;
    const next = waiting.shift();
    if (next) { if (worker) next(worker); else if (!stopped) { started++; next(workerFactory()); } }
    // An idle worker does not keep the process alive.
    else if (worker) { held(worker).unref(); idle.push(worker); }
  };
  const run = (worker: Worker, work: DirectReadWork) => new Promise<DirectReadAnswer>(resolve => {
    const finish = (answer: DirectReadAnswer, broken: boolean) => {
      clearTimeout(timeout); worker.onmessage = null; worker.onerror = null;
      if (broken || stopped) worker.terminate();
      release(broken || stopped ? null : worker);
      resolve(answer);
    };
    const timeout = setTimeout(() => finish({ error: "The screen took too long to read" }, true), TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<DirectReadAnswer>) => finish(event.data, false);
    worker.onerror = (event) => finish({ error: event.message || "The screen worker failed" }, true);
    try { worker.postMessage(work); } catch (error) { finish({ error: String(error) }, true); }
  });
  const read = async (ctx: AppContext, url: URL, signal?: AbortSignal): Promise<Response> => {
    if (signal?.aborted) return cancelledRead();
    const handler = directReadHandler(url.pathname);
    if (!handler) return Response.json({ error: "Not a direct read" }, { status: 404 });
    // A database without a file has no worker connection (tests): the screen is built in place.
    if (stopped || !ctx.dbPath || ctx.dbPath === ":memory:") return handler(ctx, url);
    const work: DirectReadWork = { dbPath: ctx.dbPath, url: `${url.pathname}${url.search}`, context: snapshotDataContext(ctx),
      rates: ctx.rateCards, homes: [...ctx.homeToSubId], sourceHomes: codexSourceHomes(ctx.homeToSubId) };
    const worker = await acquire(signal);
    if (!worker) return cancelledRead();
    // A granted slot can be abandoned before this continuation posts its work.
    if (signal?.aborted || stopped) {
      if (stopped) worker.terminate();
      release(stopped ? null : worker);
      return cancelledRead();
    }
    // Once started, a snapshot finishes normally; cancellation never terminates a reader.
    const answer = await run(worker, work);
    if ("error" in answer) return Response.json({ error: answer.error }, { status: 503 });
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  };
  return Object.assign(read, {
    /** Idle workers close their connection first, so the database file is released when this resolves. */
    async close() {
      stopped = true;
      waiting.splice(0).forEach(take => take(null));
      await idle.close();
    },
  });
}
