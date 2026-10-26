/**
 * Every HTTP handler, status poll and timer of the server shares one thread. Synchronous work there (a report
 * built on the request, a write waiting out the busy timeout) stalls all of them, and a status poll that times
 * out names no culprit. A stall of at least `STALL_MS` is reported with the requests that overlapped it.
 */
const STALL_MS = 1_000;
const TICK_MS = 250;
const RECENT = 64;
interface Request { path: string; startedAt: number; endedAt?: number }
const inFlight = new Map<number, Request>();
const finished: Request[] = [];
let nextRequest = 0;

/** Marks one request as in progress on this thread until the returned function is called. */
export function trackMainThreadRequest(path: string, now: () => number = () => performance.now()): () => void {
  const id = nextRequest++, request: Request = { path, startedAt: now() };
  inFlight.set(id, request);
  return () => {
    if (!inFlight.delete(id)) return;
    request.endedAt = now();
    finished.push(request);
    if (finished.length > RECENT) finished.shift();
  };
}

/** The requests that were in progress at some instant of `[from, to]`, oldest first. */
export function requestsDuring(from: number, to: number): string[] {
  return [...finished.filter(request => request.endedAt! >= from), ...inFlight.values()]
    .filter(request => request.startedAt <= to).sort((a, b) => a.startedAt - b.startedAt)
    .map(request => `${request.path} (${(((request.endedAt ?? to) - request.startedAt) / 1000).toFixed(1)} s${request.endedAt === undefined ? ", running" : ""})`);
}

/**
 * Checks the thread every `TICK_MS`: a tick that arrives `STALL_MS` late means the thread was blocked that long.
 * Returns the callback and interval for the caller to schedule, so the server's own timer registry clears it.
 */
export function mainThreadStallCheck(report: (message: string) => void = message => console.warn(message),
  now: () => number = () => performance.now()): { tick: () => void; intervalMs: number } {
  let last = now();
  return { intervalMs: TICK_MS, tick: () => {
    const at = now(), late = at - last - TICK_MS, since = last;
    last = at;
    if (late < STALL_MS) return;
    const requests = requestsDuring(since, at);
    report(`[tokenAtlas main] event loop blocked ${(late / 1000).toFixed(1)} s; requests meanwhile: ${requests.join(", ") || "none"}`);
  } };
}
