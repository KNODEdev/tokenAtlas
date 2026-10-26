import { latestAccountState } from "./account-probes";
import { periodEras } from "./subscription-maps";
import type { AppContext } from "./app-context-types";
import { cacheKey } from "./cache";
import { withReadSnapshot } from "../db/analysis";
import { buildEraIndex } from "./eras";
import { DATA_VIEWS, dataConfigurationStamp, preparingRows, presentDataView, buildDataView, dataViewResponse, snapshotDataContext,
  readsWindowSums, type DataEnvelope } from "./data-views";
import { codexSourceHomes } from "./capacity-equivalents";
import type { DataWork, AnalysisRequest, AnalysisReport, AnalysisSnapshot } from "./data-worker";

import { SubscriptionFactsPending } from "../db/subscription-facts";
import { CodexLedgerNotReady } from "../db/codex-price-ledger";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { dataVersion, DATA_VERSION_HEADER } from "./data-version";
import { clockBoundaryMs, preparedAtMs, presentClockFields } from "./data-clock";
import type { ActivityIssueReason } from "../shared/app-activity";
import { hasFamilyAnswer, readFamilyAnswer, readWindowAnswer, readWindowAnswerState, windowAnswerIsCurrent, windowAnswerMarkedSince,
  windowAnswerMarkSeq, readWindowAnswerBatch, type AnswerScope, type WindowAnswer } from "../db/window-answers";
import { prefillRequests, storedScopeOf, WINDOW_SCREENS, type StoredScope } from "./window-screens";
import { CLAUDE_CODE_CAPACITY_ALGORITHM } from "../shared/claude-code-capacity";
import { IdleReadWorkers } from "./idle-read-workers";
import { ResponseMemoryBudget, ResponseMemoryCache, stringMemoryBytes } from "./response-memory";
import { contextRequested, contextProjectionStamp } from "./codex-context-preview";

/**
 * The exception list of plan U4.4: views that still need more than the stored rows give in a second
 * (they read calls or observation history over a range), each with its reason. Every other analytical
 * view is built on its request from stored rows (`serveDataView`) or is a window screen (window-screens.ts).
 *
 * An exception view is computed off the HTTP thread, in a worker, from the current rows. Its answer is
 * kept in memory only, keyed by the request and the version of the stored rows and configuration it was
 * computed from: nothing is persisted, queued across restarts or warmed up, and a restart starts empty.
 * A request whose answer is older than the current version gets that answer marked stale while the
 * worker computes the current one; with no answer yet it gets the preparation receipt.
 */
export const EXCEPTION_VIEWS: Readonly<Record<string, string>> = {
  "/api/source-health": "per-source activity over the whole history of calls and Codex meter samples",
  "/api/health": "per-day row counts of the event and observation tables",
  "/api/gauge": "Codex meter samples of the range",
  "/api/planhealth": "Codex meter samples and calls over the whole history",
  "/api/history-coverage": "Codex meter samples over the whole history",
  "/api/codex-timeline-markers": "first call of each model over the whole history",
  "/api/subscription-timeline-markers": "first call of each model over the whole history",
};

/** Bumped when a stored view's answer changes shape or meaning: older stored answers are recomputed. */
export const STORED_ANSWER_VERSION = 2;
/** An answer over instants still to come is computed again this long after it was built (burn rates, today's day). */
export const OPEN_ANSWER_REFRESH_MS = 5 * 60_000;
/** Answers read within this time are recomputed in the background when they become stale. */
const RECENT_MS = 30 * 60_000;

export { preparingDataResponse } from "./preparing-response";

/** The configuration a stored window answer is computed under (rate cards, accounts, projects…). */
export const storedAnswerConfiguration = (ctx: AppContext, url?: URL, readLatest?: () => ReturnType<typeof import("./account-probes").latestAccountState>) => {
  const calibrationView = url && ["/api/subscription-accounting", "/api/claude-limit", "/api/claude-limit-card", "/api/windows"].includes(url.pathname)
    && WINDOW_SCREENS[url.pathname]?.scope(url, ctx)?.provider === "claude";
  const contextView = url && (["/api/usage-series", "/api/cycle-breakdown"].includes(url.pathname)
    || url.pathname === "/api/windows" && WINDOW_SCREENS[url.pathname]?.scope(url, ctx)?.provider === "codex");
  return JSON.stringify([STORED_ANSWER_VERSION,
    url && WINDOW_SCREENS[url.pathname]?.configuration?.(ctx, url, readLatest) || dataConfigurationStamp(ctx, false),
    ...(contextView ? ["stored-context-price-1"] : []),
    ...(url && ["/api/claude-limit", "/api/claude-limit-card"].includes(url.pathname) ? ["window-model-usage-1"] : []),
    ...(url && contextRequested(url) ? [contextProjectionStamp(ctx.sqlite, url)] : []),
    ...(calibrationView ? [["claude-capacity", CLAUDE_CODE_CAPACITY_ALGORITHM]] : [])]);
};
/**
 * The stored answer of a window screen request while nothing it read has changed since (no newer mark, the same
 * configuration, no reset or opening of a window it shows), its ages and countdowns presented now; otherwise null.
 * Another view that shows the same producer's answer reads it here instead of computing it again.
 */
export function currentStoredBody(ctx: AppContext, url: URL, nowMs = Date.now()): unknown {
  const answer = readWindowAnswer(ctx.sqlite, url.pathname, cacheKey(url));
  if (!answer || answer.status !== 200 || answer.dirty || answer.configuration !== storedAnswerConfiguration(ctx, url)
    || windowAnswerMarkedSince(ctx.sqlite, answer.scope, answer.checked)) return null;
  const body = JSON.parse(answer.body), built = preparedAtMs(answer.headers) ?? answer.builtAt;
  const boundary = clockBoundaryMs(body, built);
  if (boundary !== null && nowMs >= boundary) return null;
  return WINDOW_SCREENS[url.pathname]?.clock && nowMs !== built ? presentClockFields(body, nowMs, built) : body;
}

function refreshPeriodIndex(ctx: AppContext) {
  const declarations = periodEras(ctx.sqlite, ctx.accounts);
  const index = buildEraIndex(declarations, "instant");
  if (ctx.eras?.fingerprint !== index.fingerprint) ctx.eras = index;
  return declarations;
}

export function createDataReadWorker(): Worker {
  return new Worker(new URL("./data-worker.ts", import.meta.url).href, {
    env: Object.fromEntries(Object.entries(process.env).flatMap(([key,value])=>value===undefined ? [] : [[key,value] as [string,string]])),
  });
}

type Answer = { version: string; preparedAt: number; status: number; body: string; headers: Array<[string, string]>; issue?: ActivityIssueReason;
  /** The instant the body stops describing the present (a window it shows resets or opens); null when the clock never does. */
  expiresAt: number | null }
  | { version: string; pending: true };
/** A stored view's failure: kept while nothing in its scope changes. */
interface Failure { checked: number; configuration: string; status: number; body: string; issue: ActivityIssueReason; scope: AnswerScope }
/** Answers kept in memory: a bounded number of the most recently used ones. */
const MAX_ANSWERS = 256;

/** An exception answer for the activity panel: being computed, or failed. */
export interface ReportActivity { path: string; failed: boolean; reason?: ActivityIssueReason }

/** The category of a failed answer; neither the request parameters nor the error text reach the activity panel. */
function issueOf(status: number, error: string): ActivityIssueReason {
  const text = error.toLowerCase();
  if (status === 400 && text.includes("unknown account")) return "account-unavailable";
  if (status === 503 && (text.includes("busy") || text.includes("database is locked"))) return "database-busy";
  return status === 400 ? "invalid-request" : "preparation-failed";
}

type WorkerMessage = { report?: AnalysisReport; snapshot?: AnalysisSnapshot; error?: string; pending?: boolean; clientStatus?: 400 };
interface Job { key: string; work: DataWork; background: boolean; first: boolean; prefill: boolean; finish(message: WorkerMessage | null): void }
/** Requests a prefill step checks at most before it yields the thread. */
const PREFILL_CHECKS = 200;
/**
 * Workers computing answers at once: a long one does not hold every other screen. The prefill uses all but one of them
 * (on the measurement machine a sustained load runs each core at about a sixth of its burst speed, so answers computed
 * side by side finish sooner), and a request finds the last one free.
 */
const WORKERS = 3;
/**
 * A background refresh of the same answer waits at least this long after the previous computation, or three
 * times its duration: while the background writer catches up, marks arrive every turn, and recomputing on
 * each would keep the workers busy with the same answers.
 */
const REFRESH_SPACING_MS = 15_000;

export function createDataRead(workerFactory = createDataReadWorker, options: { workers?: number; idleMs?: number; memory?: ResponseMemoryBudget } = {}) {
  const memory = options.memory ?? new ResponseMemoryBudget();
  const answers = new ResponseMemoryCache<Answer>(memory, answer => stringMemoryBytes(answer.version)
    + ("body" in answer ? stringMemoryBytes(answer.body) + stringMemoryBytes(JSON.stringify(answer.headers)) : 0), MAX_ANSWERS);
  // Computed candidates are used only to plan prefill; public reads use the committed database row.
  const prepared = new ResponseMemoryCache<WindowAnswer>(memory, answer => stringMemoryBytes(answer.body)
    + stringMemoryBytes(answer.configuration) + stringMemoryBytes(answer.version) + stringMemoryBytes(JSON.stringify(answer.headers)), 2 * MAX_ANSWERS);
  const failures = new Map<string, Failure>();
  const running = new Map<string, { promise: Promise<Answer | undefined>; background: boolean }>();
  /** Stored answers read lately: the ones kept current in the background. */
  const recent = new Map<string, { at: number; url: URL; scope: StoredScope }>();
  let toStore: WindowAnswer[] = [];
  let lastContext: AppContext | null = null;
  const queue: Job[] = [], busy = new Map<Worker, Job>();
  const poolSize = Math.max(1, options.workers ?? WORKERS);
  let started = 0, stopped = false;
  const idle = new IdleReadWorkers(() => { started--; }, options.idleMs);
  /** When each answer was last computed and how long it took. */
  const computed = new Map<string, { finished: number; ms: number }>();
  const refreshAllowed = (key: string, now = Date.now()) => {
    const last = computed.get(key);
    return !last || now - last.finished >= Math.max(REFRESH_SPACING_MS, 3 * last.ms);
  };

  /** Starts queued jobs on free workers: a screen's window rail first, then other requests, then background refreshes, then prefill. */
  const dispatch = () => {
    while (queue.length && !stopped) {
      let thread = idle.pop();
      if (!thread) {
        if (started >= poolSize) return;
        started++; thread = workerFactory();
      }
      const rank = (job: Job) => job.prefill ? 3 : job.background ? 2 : job.first ? 0 : 1;
      let index = 0;
      for (let i = 1; i < queue.length; i++) if (rank(queue[i]!) < rank(queue[index]!)) index = i;
      const job = queue.splice(index, 1)[0]!;
      run(thread, job);
    }
  };
  const run = (thread: Worker, job: Job) => {
    busy.set(thread, job);
    const finish = (message: WorkerMessage | null, broken: boolean) => {
      clearTimeout(timeout); thread.onmessage = null; thread.onerror = null;
      if (!busy.delete(thread)) return;
      if (broken || stopped) { thread.terminate(); started--; } else idle.push(thread);
      job.finish(message);
      dispatch();
    };
    const timeout = setTimeout(() => finish(null, true), 600_000);
    thread.onmessage = (event: MessageEvent<WorkerMessage>) => finish(event.data, false);
    thread.onerror = () => finish(null, true);
    try { thread.postMessage(job.work); } catch { finish(null, true); }
  };
  /** Queues one computation of `key`; requests asking for the same key share it. */
  const enqueue = (ctx: AppContext, request: AnalysisRequest, key: string, background: boolean, done: (message: WorkerMessage | null) => Answer | void,
    prefill = false): boolean => {
    const current = running.get(key);
    if (current) {
      // A screen now waits on a queued refresh or prefill: it goes ahead of them.
      if (!background && current.background) {
        const job = queue.find(item => item.key === key);
        if (job) { job.background = false; job.prefill = false; }
        current.background = false;
      }
      return false;
    }
    const periods = refreshPeriodIndex(ctx);
    const work: DataWork = { context: snapshotDataContext(ctx), dbPath: ctx.dbPath!, rates: ctx.rateCards, request,
      plans: ctx.plans, catalog: ctx.plansCatalog, cycles: ctx.cycles, homes: [...ctx.homeToSubId], sourceHomes: codexSourceHomes(ctx.homeToSubId),
      subscriptions: ctx.accounts.subscriptions, sources: ctx.accounts.sources, eras: periods };
    const queuedAt = Date.now(), first = !!WINDOW_SCREENS[new URL(key, "http://local").pathname]?.first;
    const promise = new Promise<Answer | undefined>(resolve => {
      queue.push({ key, work, background, first, prefill, finish(message) {
        let answer: Answer | undefined;
        try { answer = done(message) ?? undefined; }
        finally { computed.set(key, { finished: Date.now(), ms: Date.now() - queuedAt }); running.delete(key); resolve(answer); }
      } });
    });
    running.set(key, { promise, background });
    dispatch();
    return true;
  };

  /** The request a URL names, or the 400/404 that refuses it. */
  const requestOf = (url: URL): AnalysisRequest | Response => {
    if (DATA_VIEWS[url.pathname]) return { kind: "view", url: cacheKey(url) };
    return Response.json({ error: "Not an exception view" }, { status: 404 });
  };
  /** A view whose answer depends on the clock is answered again on a new UTC day (its countdowns follow `presentDataView`). */
  const versionOf = (ctx: AppContext, url: URL) => {
    const view = DATA_VIEWS[url.pathname], day = view?.clock && view.preparationClock === "day" && !url.searchParams.has("as_of")
      ? new Date(Date.now()).toISOString().slice(0, 10) : null;
    const rows = dataVersion(ctx.sqlite, { windowSums: readsWindowSums(url.pathname), capacityCycles: view?.sources.includes("capacity_cycle_results") ?? false,
      firstTokenTimes: view?.sources.includes("response_time_hours") ?? false,
      contextPrices: contextRequested(url) ? url.pathname : false });
    return { rows, key: JSON.stringify([rows, dataConfigurationStamp(ctx, false), day]) };
  };
  const configurationOf = storedAnswerConfiguration;
  const respondBody = (url: URL, body: string, status: number, headers: Array<[string, string]>, rows: string, state: string, preparedAt: number) => {
    const view = DATA_VIEWS[url.pathname];
    const envelope: DataEnvelope = { status, body: JSON.parse(body), headers };
    const response = view ? dataViewResponse(presentDataView(view, envelope), state)
      : Response.json(envelope.body, { status, headers: { "X-Analysis": state } });
    response.headers.set(DATA_VERSION_HEADER, rows);
    if (state === "stale") { response.headers.set("Cache-Control", "no-store"); response.headers.set("X-Analysis-Prepared-At", String(preparedAt)); }
    return response;
  };
  const respond = (url: URL, answer: Extract<Answer, { body: string }>, rows: string, state: string) =>
    respondBody(url, answer.body, answer.status, answer.headers, rows, state, answer.preparedAt);
  /** When the clock makes a body stale: a window it shows resets or opens. */
  const expiryOf = (url: URL, envelope: DataEnvelope) => {
    const dataView = DATA_VIEWS[url.pathname], screen = WINDOW_SCREENS[url.pathname];
    const clock = screen ? screen.clock : !!dataView?.clock && dataView.preparationClock !== false;
    const builtAt = preparedAtMs(envelope.headers);
    return clock && builtAt !== null && envelope.status === 200 ? clockBoundaryMs(envelope.body, builtAt) : null;
  };
  const envelopeOf = (request: AnalysisRequest, message: WorkerMessage): DataEnvelope => {
    const { report, error, clientStatus } = message;
    return error !== undefined ? { status: clientStatus ?? 503, body: { error }, headers: [] }
      : report as DataEnvelope;
  };
  const isPending = (request: AnalysisRequest, message: WorkerMessage) =>
    message.pending || message.error === undefined && (message.report as DataEnvelope).status === 202;

  /** Builds one exception answer in a worker, off the HTTP thread; with an older answer on screen it is a background refresh. */
  const compute = (ctx: AppContext, request: AnalysisRequest, version: string, rows: string, key: string, background: boolean) =>
    enqueue(ctx, request, key, background, message => {
      if (!message) return;
      // A view that answered the preparation receipt is a register still being prepared, not an answer.
      if (isPending(request, message)) { const answer: Answer = { version, pending: true }; answers.remember(key, answer); return answer; }
      const envelope = envelopeOf(request, message);
      const url = request.kind === "view" ? new URL(request.url, "http://local") : null;
      const answer: Answer = { version, preparedAt: Date.now(), status: envelope.status, body: JSON.stringify(envelope.body),
        expiresAt: url ? expiryOf(url, envelope) : null, headers: [...envelope.headers, [DATA_VERSION_HEADER, rows]],
        ...(envelope.status >= 400 ? { issue: issueOf(envelope.status, message.error ?? String((envelope.body as { error?: unknown } | null)?.error ?? "")) } : {}) };
      answers.remember(key, answer);
      return answer;
    });

  /** Builds one stored answer in a worker and hands it to the background writer. */
  /** `prefill`: queued behind every other job, and called once it ended; returns whether a computation was queued. */
  const computeStored = (ctx: AppContext, url: URL, key: string, scope: StoredScope, background: boolean, prefill?: () => void,
    knownConfiguration?: string): boolean => {
    if (!prefill && (background || prepared.get(key)) && !refreshAllowed(key)) return false;
    const request: AnalysisRequest = { kind: "screen", url: key };
    const configuration = knownConfiguration ?? configurationOf(ctx, url);
    const keep = (message: WorkerMessage | null) => {
      if (!message || isPending(request, message)) return;
      const envelope = envelopeOf(request, message), checked = message.snapshot?.checked ?? 0;
      const { family, ...answerScope } = scope;
      if (envelope.status !== 200 || !message.snapshot) {
        failures.set(key, { checked, configuration, status: envelope.status, body: JSON.stringify(envelope.body), scope: answerScope,
          issue: issueOf(envelope.status, message.error ?? String((envelope.body as { error?: unknown } | null)?.error ?? "")) });
        return;
      }
      failures.delete(key);
      const builtAt = preparedAtMs(envelope.headers) ?? Date.now(), clock = expiryOf(url, envelope);
      const clockEnd = WINDOW_SCREENS[url.pathname]?.clockEnd?.(url), end = clockEnd != null && Number.isFinite(clockEnd) ? clockEnd : answerScope.untilMs;
      const open = end === null || end > builtAt ? builtAt + OPEN_ANSWER_REFRESH_MS : null;
      const expiresAt = clock === null ? open : open === null ? clock : Math.min(clock, open);
      const answer: WindowAnswer = { route: url.pathname, key, family, scope: answerScope, configuration, checked, builtAt, expiresAt,
        status: 200, version: message.snapshot.version, headers: envelope.headers, body: JSON.stringify(envelope.body) };
      const previous = prepared.get(key);
      if (previous && previous.checked > checked) return;
      prepared.remember(key, answer);
      toStore.push(answer);
      // Without a writer taking them (tests, a borrowed context) the queue keeps only the newest.
      if (toStore.length > MAX_ANSWERS) toStore.splice(0, toStore.length - MAX_ANSWERS);
    };
    return enqueue(ctx, request, key, background, message => { try { keep(message); } finally { prefill?.(); } }, !!prefill);
  };
  /** A stored answer, its ages and countdowns presented now when its screen declares a clock. */
  const respondStored = (url: URL, answer: WindowAnswer, state: "stored" | "stale") => {
    const body = JSON.parse(answer.body), built = preparedAtMs(answer.headers), nowMs = Date.now();
    const presented = WINDOW_SCREENS[url.pathname]?.clock && built !== null && nowMs !== built ? presentClockFields(body, nowMs, built) : body;
    const headers = Object.fromEntries(answer.headers.filter(([name]) => !["content-type", "content-length"].includes(name.toLowerCase())));
    const response = Response.json(presented, { status: answer.status,
      headers: { ...headers, "X-Analysis": state, "X-Cache": state === "stored" ? "hit" : "miss" } });
    response.headers.set(DATA_VERSION_HEADER, answer.version);
    if (state === "stale") { response.headers.set("Cache-Control", "no-store"); response.headers.set("X-Analysis-Prepared-At", String(answer.builtAt)); }
    return response;
  };

  const readStored = (ctx: AppContext, url: URL, key: string, scope: StoredScope,
    loaded?: { answer: WindowAnswer | null; marked: boolean; configuration?: string }): Response => {
    lastContext = ctx;
    recent.delete(key); recent.set(key, { at: Date.now(), url, scope });
    const configuration = loaded?.configuration ?? configurationOf(ctx, url);
    // Only the committed row may be presented as stored. Computation can precede a failed writer turn.
    const answer = loaded ? loaded.answer : readWindowAnswer(ctx.sqlite, url.pathname, key);
    const current = answer && (loaded
      ? answer.configuration === configuration && !answer.dirty && (answer.expiresAt === null || Date.now() < answer.expiresAt) && !loaded.marked
      : windowAnswerIsCurrent(ctx.sqlite, answer, configuration));
    if (answer && current) return respondStored(url, answer, "stored");
    const failure = failures.get(key);
    if (!answer && failure && failure.configuration === configuration && !windowAnswerMarkedSince(ctx.sqlite, failure.scope, failure.checked))
      return respondBody(url, failure.body, failure.status, [], "", "memory", 0);
    // The last answer, or the newest of its family, stays on screen while the current one is computed.
    computeStored(ctx, url, key, scope, !!answer, undefined, configuration);
    if (answer) return respondStored(url, answer, "stale");
    const family = readFamilyAnswer(ctx.sqlite, url.pathname, scope.family);
    return family ? respondStored(url, family, "stale") : preparingRows();
  };

  /**
   * Prefill (window-screens.ts `prefill`): the answers of every window screen the UI opens by default, for every
   * account and window, computed one at a time on a worker no request waits for, behind every other job: the rails,
   * then current windows, then closed windows newest first. An answer is computed when it is missing, or stale by a
   * mark or the configuration (the clock alone does not make a prefilled answer worth recomputing; a read refreshes
   * it). A pass over the list that computes nothing leaves the prefill idle until a new mark, configuration or day.
   */
  const prefill = { ready: false, plan: [] as ReturnType<typeof prefillRequests>, cursor: 0, computed: 0, railsComputed: 0, pass: "",
    idle: null as string | null, jobs: new Set<string>(), attempted: new Map<string, string>(),
    /** Since when the prefill has been computing, and how many answers, for one line when it goes idle. */
    busySince: null as number | null, total: 0 };
  const prefillStamp = (ctx: AppContext) => JSON.stringify([windowAnswerMarkSeq(ctx.sqlite), configurationOf(ctx), new Date().toISOString().slice(0, 10)]);
  /** The stored body of a request: the newest computed one (also before the writer published it), else the stored row. */
  const storedBody = (ctx: AppContext) => (url: URL): unknown => {
    const key = cacheKey(url), answer = prepared.get(key) ?? readWindowAnswer(ctx.sqlite, url.pathname, key);
    return answer && answer.status === 200 ? JSON.parse(answer.body) : null;
  };
  const prefillNeeded = (ctx: AppContext, item: ReturnType<typeof prefillRequests>[number]): boolean => {
    const configuration = configurationOf(ctx, item.url);
    const failure = failures.get(item.key);
    if (failure && failure.configuration === configuration && !windowAnswerMarkedSince(ctx.sqlite, failure.scope, failure.checked)) return false;
    const route = item.url.pathname;
    if (item.moving) return !toStore.some(answer => answer.route === route && answer.family === item.scope.family)
      && !hasFamilyAnswer(ctx.sqlite, route, item.scope.family);
    const state = prepared.get(item.key) ?? readWindowAnswerState(ctx.sqlite, route, item.key);
    return !state || state.configuration !== configuration || !!state.dirty || windowAnswerMarkedSince(ctx.sqlite, state.scope, state.checked);
  };
  const prefillStep = (ctx: AppContext) => {
    // Only on a worker no request waits for, and on all workers but one (one at a time with a single worker).
    if (!prefill.ready || stopped || prefill.jobs.size >= Math.max(1, poolSize - 1) || queue.length || busy.size >= poolSize
      || !ctx.dbPath || ctx.dbPath === ":memory:") return;
    if (prefill.cursor >= prefill.plan.length) {
      const stamp = prefillStamp(ctx);
      if (prefill.idle === stamp) return;
      // A new pass over a list derived from the rails as stored now (a pass stores rails the next one reads).
      prefill.plan = prefillRequests(ctx, storedBody(ctx));
      prefill.cursor = 0; prefill.computed = 0; prefill.railsComputed = 0; prefill.pass = stamp; prefill.idle = null;
    }
    for (let checks = 0; prefill.cursor < prefill.plan.length && checks < PREFILL_CHECKS; checks++) {
      const item = prefill.plan[prefill.cursor];
      // Rails computed in this pass list windows it does not know yet: the next pass, over a new list, starts with them.
      if (item!.order > 0 && prefill.railsComputed > 0) {
        prefill.cursor = prefill.plan.length;
        if (!stopped) setTimeout(() => prefillStep(ctx), 0);
        return;
      }
      prefill.cursor++;
      if (running.has(item!.key) || prefill.attempted.get(item!.key) === prefill.pass || !prefillNeeded(ctx, item!)) continue;
      const next = item!;
      // Tried once per pass: a register still preparing answers nothing, and a failure is kept until its scope changes.
      prefill.attempted.set(next.key, prefill.pass);
      prefill.jobs.add(next.key);
      const queued = computeStored(ctx, next.url, next.key, next.scope, true, () => {
        prefill.jobs.delete(next.key);
        // The next request right away, after the current turn of the event loop.
        if (!stopped) setTimeout(() => prefillStep(ctx), 0);
      });
      if (!queued) { prefill.jobs.delete(next.key); continue; }
      prefill.computed++; prefill.total++;
      if (next.order === 0) prefill.railsComputed++;
      prefill.busySince ??= Date.now();
      // Another prefill on the next free worker, if one may run beside this one.
      if (!stopped) setTimeout(() => prefillStep(ctx), 0);
      return;
    }
    if (prefill.cursor >= prefill.plan.length) {
      if (prefill.computed === 0) {
        prefill.idle = prefill.pass;
        if (prefill.busySince !== null) console.log(`[tokenAtlas window screens] prefill idle: ${prefill.total} answers computed in `
          + `${((Date.now() - prefill.busySince) / 1000).toFixed(1)} s, ${prefill.plan.length} requests listed`);
        prefill.busySince = null; prefill.total = 0;
      }
      if (prefill.attempted.size > 4 * prefill.plan.length + 1000) prefill.attempted.clear();
    }
  };

  const read = async (ctx: AppContext, req: Request): Promise<Response> => {
    // A client that went away gets nothing and starts no work.
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const url = new URL(req.url);
    const scope = storedScopeOf(ctx, url);
    const request = scope && !DATA_VIEWS[url.pathname] ? { kind: "screen" as const, url: cacheKey(url) } : requestOf(url);
    if (request instanceof Response) return request;
    // A database without a file has no worker connection (tests): the answer is computed in place.
    if (req.method !== "GET" || !ctx.dbPath || ctx.dbPath === ":memory:") {
      refreshPeriodIndex(ctx);
      try {
        if (request.kind === "screen") return await WINDOW_SCREENS[url.pathname]!.produce(ctx, url);
        return dataViewResponse(await buildDataView(ctx, url), "inline");
      } catch (error) {
        if (error instanceof SubscriptionFactsPending || error instanceof ProbeAccountIndexUnavailable || error instanceof CodexLedgerNotReady)
          return preparingRows();
        throw error;
      }
    }
    if (stopped) return Response.json({ error: "Data preparation is stopped" }, { status: 503 });
    const key = cacheKey(url);
    if (scope) return readStored(ctx, url, key, scope);
    const version = versionOf(ctx, url), answer = answers.get(key);
    if (answer?.version === version.key && !("body" in answer && answer.expiresAt !== null && Date.now() >= answer.expiresAt)) {
      answers.remember(key, answer);
      return "body" in answer ? respond(url, answer, version.rows, "memory") : preparingRows();
    }
    if (!running.has(key)) compute(ctx, request, version.key, version.rows, key, !!answer && "body" in answer);
    // A completed reply may exceed the budget or have been evicted before polling. Deliver
    // the next computation to its live caller instead of looping through preparation forever.
    if (!answer && computed.has(key)) {
      const pending = running.get(key)?.promise;
      const completed = pending && await new Promise<Answer | undefined | "cancelled">(resolve => {
        const abort = () => { req.signal.removeEventListener("abort", abort); resolve("cancelled"); };
        req.signal.addEventListener("abort", abort, { once: true });
        void pending.then(value => { req.signal.removeEventListener("abort", abort); resolve(value); });
        if (req.signal.aborted) abort();
      });
      if (completed === "cancelled") return new Response(null, { status: 499 });
      if (completed && "body" in completed) return respond(url, completed, JSON.parse(completed.version)[0],
        completed.version === versionOf(ctx, url).key && (completed.expiresAt === null || Date.now() < completed.expiresAt) ? "computed" : "stale");
      if (stopped) return Response.json({ error: "Data preparation is stopped" }, { status: 503 });
    }
    return answer && "body" in answer ? respond(url, answer, JSON.parse(answer.version)[0], "stale") : preparingRows();
  };
  return Object.assign(read, {
    /** The same stored publication contract as single reads, with one bounded row/mark query. */
    batch(ctx: AppContext, urls: readonly URL[], signal?: AbortSignal): Promise<Response[]> {
      if (urls.length > 12 || urls.some(url => url.pathname !== "/api/cycle-breakdown")) throw new Error("Invalid cycle batch");
      if (signal?.aborted) return Promise.resolve(urls.map(() => new Response(null, { status: 499 })));
      const scopes = urls.map(url => storedScopeOf(ctx, url));
      if (!stopped && ctx.dbPath && ctx.dbPath !== ":memory:" && scopes.every(Boolean)) {
        return Promise.resolve(withReadSnapshot(ctx.sqlite, () => {
          const rows = readWindowAnswerBatch(ctx.sqlite, "/api/cycle-breakdown", urls.map(cacheKey));
          let latest: ReturnType<typeof import("./account-probes").latestAccountState> | undefined;
          const readLatest = () => latest ??= latestAccountState(ctx);
          return urls.map((url, index) => readStored(ctx, url, cacheKey(url), scopes[index]!, {
            ...(rows.get(cacheKey(url)) ?? { answer: null, marked: false }), configuration: configurationOf(ctx, url, readLatest),
          }));
        }));
      }
      return Promise.all(urls.map(url => read(ctx, new Request(url, { signal }))));
    },
    async whenIdle() { while (running.size) await Promise.all([...running.values()].map(job => job.promise)); },
    /** Answers being computed for a screen, or failed, for the activity panel; background refreshes of answers on screen are not listed. */
    activity(): ReportActivity[] {
      return [...[...answers.entries()].flatMap(([key, answer]) => "issue" in answer && answer.issue
        ? [{ path: key.split("?")[0]!, failed: true, reason: answer.issue }] : []),
        ...[...failures].map(([key, failure]) => ({ path: key.split("?")[0]!, failed: true, reason: failure.issue })),
        ...[...running].flatMap(([key, job]) => job.background ? [] : [{ path: key.split("?")[0]!, failed: false }])];
    },
    /**
     * Recomputes, in the background, the stored answers read lately that a mark, the clock or the
     * configuration made stale: returning to a screen finds them current. Others wait until they are read.
     */
    refreshStale(limit = 4) {
      const ctx = lastContext;
      if (!ctx || stopped) return;
      const now = Date.now();
      let scheduled = 0;
      for (const [key, entry] of [...recent].reverse()) {
        if (now - entry.at > RECENT_MS) { recent.delete(key); continue; }
        if (scheduled >= limit || running.has(key)) continue;
        const answer = readWindowAnswer(ctx.sqlite, entry.url.pathname, key);
        if (!answer || windowAnswerIsCurrent(ctx.sqlite, answer, configurationOf(ctx, entry.url), now)) continue;
        computeStored(ctx, entry.url, key, entry.scope, true);
        scheduled++;
      }
    },
    /** Whether the registers window screens read (limit windows, window sums) have caught up: prefill runs only then. */
    prefillReady(ready: boolean) { prefill.ready = ready; },
    /** One bounded prefill step (see `prefillStep`); called on a timer and after each prefilled answer. */
    prefill(ctx: AppContext) { prefillStep(ctx); },
    /** Prefill progress: requests listed, checked and computed in the current pass; idle once a pass computed nothing. */
    prefillState() { return { ready: prefill.ready, listed: prefill.plan.length, checked: prefill.cursor, computed: prefill.computed,
      running: [...prefill.jobs][0] ?? null, idle: prefill.idle !== null }; },
    /** Computed answers for the background writer to publish (`storeWindowAnswers`). */
    takeAnswersToStore(): WindowAnswer[] { const taken = toStore; toStore = []; return taken; },
    /** Answers the writer could not publish this turn go back to the queue. */
    returnAnswersToStore(answers: readonly WindowAnswer[]) { toStore = [...answers, ...toStore]; },
    /** Idle workers close their connection first, so the database file is released when this resolves. */
    async close() {
      stopped = true;
      queue.splice(0).forEach(job => job.finish(null));
      for (const [thread, job] of [...busy]) { busy.delete(thread); thread.terminate(); job.finish(null); }
      await idle.close();
      answers.clear(); prepared.clear();
    },
  });
}
