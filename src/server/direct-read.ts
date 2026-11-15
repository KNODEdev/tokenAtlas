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
import type { AnswerScope } from "../db/window-answers";

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
/**
 * A stored-row lookup every tab polls (the cycle batch, the sync check), read in the worker's one snapshot:
 * `cycleBatchRows` (data-read.ts) and `syncReadRows` (read-refresh.ts).
 */
export type LightRead = { kind: "cycle-batch"; urls: string[]; failures: Record<string, { scope: AnswerScope; checked: number }> }
  | { kind: "sync"; url: string };
/** The lookup's value, its failure, or null when its caller left. */
export type LightAnswer = { value: unknown } | { error: string } | null;
export type LightReader = (ctx: AppContext, read: LightRead, signal?: AbortSignal) => Promise<LightAnswer>;
export interface DirectReadWork {
  close?: undefined; dbPath: string; url: string; context: DataContext; rates: RateCard;
  homes: Array<[string, string]>; sourceHomes: string[]; light?: LightRead;
}
export type DirectReadAnswer = { status: number; headers: Array<[string, string]>; body: string } | { value: unknown } | { error: string };

/** Workers build at most this many screens at once; more requests wait for a free one. */
const WORKERS = 2;
/**
 * Lookups get a worker of their own (golden rule 9): a screen build of seconds on the screen workers never
 * holds them. They take milliseconds, so one worker (one more read-only connection) serves every tab.
 */
const LIGHT_WORKERS = 1;
/** Bun's Worker can stop keeping the process alive; the DOM type does not declare it. */
const held = (worker: Worker) => worker as Worker & { ref(): void; unref(): void };
const TIMEOUT_MS = 120_000, LIGHT_TIMEOUT_MS = 30_000;

export function createDirectReadWorker(): Worker {
  return new Worker(new URL("./direct-read-worker.ts", import.meta.url).href, {
    env: Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value] as [string, string]])),
  });
}

export function createDirectRead(workerFactory = createDirectReadWorker, options: { idleMs?: number; lightTimeoutMs?: number } = {}) {
  let stopped = false;
  /** A lane of workers: screens, or the light lookups. */
  const lane = (size: number, timeoutMs: number, submissionDeadline = false) => {
    type Slot = Worker | { error: string } | null;
    const waiting: Array<(worker: Slot) => void> = [];
    let started = 0;
    const idle = new IdleReadWorkers(() => { started--; }, options.idleMs);
    const create = (): Worker | { error: string } => {
      started++;
      try { return workerFactory(); } catch (error) { started--; return { error: String(error) }; }
    };
    const timeoutAnswer = () => ({ error: "The screen took too long to read" });
    const acquire = (signal?: AbortSignal, deadline?: number): Promise<Slot> => {
      if (stopped || signal?.aborted) return Promise.resolve(null);
      const free = idle.pop();
      if (free) { held(free).ref(); return Promise.resolve(free); }
      if (started < size) return Promise.resolve(create());
      return new Promise(resolve => {
        const take = (worker: Slot) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          resolve(worker);
        };
        const remove = (answer: Slot) => {
          const index = waiting.indexOf(take);
          if (index < 0) return;
          waiting.splice(index, 1);
          take(answer);
        };
        const abort = () => remove(null);
        const timeout = deadline === undefined ? undefined : setTimeout(() => remove(timeoutAnswer()), Math.max(0, deadline - Date.now()));
        waiting.push(take);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    };
    const release = (worker: Worker | null) => {
      if (!worker) started--;
      let next;
      while ((next = waiting.shift())) {
        if (worker) { next(worker); return; }
        if (stopped) { next(null); continue; }
        const created = create();
        next(created);
        if (!("error" in created)) return;
      }
      // An idle worker does not keep the process alive.
      if (worker) { held(worker).unref(); idle.push(worker); }
    };
    const run = (worker: Worker, work: DirectReadWork, remainingMs: number) => new Promise<DirectReadAnswer>(resolve => {
      const finish = (answer: DirectReadAnswer, broken: boolean) => {
        clearTimeout(timeout); worker.onmessage = null; worker.onerror = null;
        if (broken || stopped) worker.terminate();
        release(broken || stopped ? null : worker);
        resolve(answer);
      };
      const timeout = setTimeout(() => finish(timeoutAnswer(), true), remainingMs);
      worker.onmessage = (event: MessageEvent<DirectReadAnswer>) => finish(event.data, false);
      worker.onerror = (event) => finish({ error: event.message || "The screen worker failed" }, true);
      try { worker.postMessage(work); } catch (error) { finish({ error: String(error) }, true); }
    });
    /** The worker's answer, or null when the caller left (or the pool stopped) before the work was posted. */
    const perform = async (work: DirectReadWork, signal?: AbortSignal): Promise<DirectReadAnswer | null> => {
      const deadline = submissionDeadline ? Date.now() + timeoutMs : undefined;
      const worker = await acquire(signal, deadline);
      if (!worker || "error" in worker) return worker;
      // A granted slot can be abandoned before this continuation posts its work.
      if (signal?.aborted || stopped) {
        if (stopped) worker.terminate();
        release(stopped ? null : worker);
        return null;
      }
      if (deadline !== undefined && Date.now() >= deadline) { release(worker); return timeoutAnswer(); }
      // Once started, a snapshot finishes normally; cancellation never terminates a reader.
      return run(worker, work, deadline === undefined ? timeoutMs : deadline - Date.now());
    };
    const close = () => { waiting.splice(0).forEach(take => take(null)); return idle.close(); };
    return { perform, close };
  };
  const screens = lane(WORKERS, TIMEOUT_MS), lookups = lane(LIGHT_WORKERS, options.lightTimeoutMs ?? LIGHT_TIMEOUT_MS, true);
  const workOf = (ctx: AppContext, url: string, light?: LightRead): DirectReadWork => ({ dbPath: ctx.dbPath!, url, context: snapshotDataContext(ctx),
    rates: ctx.rateCards, homes: [...ctx.homeToSubId], sourceHomes: codexSourceHomes(ctx.homeToSubId), ...(light ? { light } : {}) });
  const read = async (ctx: AppContext, url: URL, signal?: AbortSignal): Promise<Response> => {
    if (signal?.aborted) return cancelledRead();
    const handler = directReadHandler(url.pathname);
    if (!handler) return Response.json({ error: "Not a direct read" }, { status: 404 });
    // A database without a file has no worker connection (tests): the screen is built in place.
    if (stopped || !ctx.dbPath || ctx.dbPath === ":memory:") return handler(ctx, url);
    const answer = await screens.perform(workOf(ctx, `${url.pathname}${url.search}`), signal);
    if (!answer) return cancelledRead();
    if (!("body" in answer)) return Response.json({ error: "error" in answer ? answer.error : "Not a screen" }, { status: 503 });
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  };
  /** Identical lookups in flight share one worker read; it is abandoned only when its last caller leaves. */
  const sharing = new Map<string, { waiters: number; controller: AbortController; promise: Promise<DirectReadAnswer | null> }>();
  const rateIds = new WeakMap<RateCard, number>();
  let nextRateId = 0;
  const light: LightReader = (ctx, request, signal) => {
    if (signal?.aborted) return Promise.resolve(null);
    if (stopped || !ctx.dbPath || ctx.dbPath === ":memory:") return Promise.resolve({ error: "No read worker" });
    const work = workOf(ctx, request.kind === "sync" ? request.url : "/api/cycle-breakdowns", request);
    // Pricing edits replace the card; avoid serializing its large contents on every poll.
    let rateId = rateIds.get(work.rates);
    if (rateId === undefined) { rateId = ++nextRateId; rateIds.set(work.rates, rateId); }
    const key = JSON.stringify({ ...work, rates: rateId });
    let entry = sharing.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created = { waiters: 0, controller, promise: lookups.perform(work, controller.signal)
        .finally(() => { if (sharing.get(key) === created) sharing.delete(key); }) };
      sharing.set(key, entry = created);
    }
    const current = entry;
    current.waiters++;
    return new Promise<LightAnswer>(resolve => {
      let done = false;
      const leave = (answer: LightAnswer) => {
        if (done) return;
        done = true; signal?.removeEventListener("abort", abort);
        if (--current.waiters === 0) { if (sharing.get(key) === current) sharing.delete(key); current.controller.abort(); }
        resolve(answer);
      };
      const abort = () => leave(null);
      signal?.addEventListener("abort", abort, { once: true });
      current.promise.then(answer => leave(!answer ? { error: "The read workers are stopped" }
        : "value" in answer ? { value: answer.value } : { error: "error" in answer ? answer.error : "Not a lookup" }),
      error => leave({ error: String(error) }));
    });
  };
  return Object.assign(read, {
    light,
    /** Idle workers close their connection first, so the database file is released when this resolves. */
    async close() {
      stopped = true;
      await Promise.all([screens.close(), lookups.close()]);
    },
  });
}
