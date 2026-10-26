import { Worker } from "node:worker_threads";
import type { ScheduledArchiveCompressionTurn } from "../sync/archive-compression-schedule";
import type { ArchiveCompressionOptions } from "../sync/archive-compression";

type Result = ScheduledArchiveCompressionTurn & { error?: string };
/** One file per worker turn, outside both HTTP and analytical maintenance. Startup gives import priority. */
export function startArchiveCompressionMaintenance(options: ArchiveCompressionOptions, canStart: () => boolean,
  onIdle: (result: Result) => void = () => {}, runtime: { now?: () => number; startupDelayMs?: number } = {}) {
  const now = runtime.now ?? Date.now;
  let nextWakeAt = now() + (runtime.startupDelayMs ?? 60_000);
  let worker: Worker | undefined, running = false, stopped = false;
  let idle = Promise.resolve(), release = () => {};
  let lastError: string | undefined;
  const finish = (result: Result) => {
    running = false; nextWakeAt = result.nextWakeAt; release();
    if (stopped) return;
    const error = result.error ?? result.turn?.errors[0]?.message;
    if (error && error !== lastError) console.warn("[tokenAtlas archive compression] work retained for retry:", error);
    lastError = error; onIdle(result);
  };
  const update = () => {
    if (stopped || running || now() < nextWakeAt || !canStart()) return;
    if (!worker) {
      const next = new Worker(new URL("./archive-compression-worker.ts", import.meta.url), {
        env: { ...process.env, ...options.env }, workerData: options,
      });
      worker = next;
      next.on("message", (result: Result | { closed: true }) => { if (worker === next && !("closed" in result)) finish(result); });
      const failed = () => {
        if (worker !== next || stopped) return;
        worker = undefined;
        void next.terminate().finally(() => finish({ nextWakeAt: now() + 15_000, scanned: false,
          error: "compression worker interrupted; durable jobs resume" }));
      };
      next.on("error", failed); next.on("exit", failed); next.unref();
    }
    running = true; idle = new Promise<void>(resolve => { release = resolve; });
    worker.postMessage({ now: now() });
  };
  return { update, get running() { return running; }, waitForIdle: () => idle,
    async close() {
      stopped = true;
      const closing = worker;
      if (closing) {
        // Ack arrives after the synchronous file turn, so terminating here cannot cut a publication.
        const idle = new Promise<void>(resolve => {
          closing.on("message", message => { if (message?.closed) resolve(); });
          closing.once("exit", () => resolve());
        });
        closing.ref(); closing.postMessage({ close: true }); await idle; await closing.terminate();
        worker = undefined;
      }
      running = false; release();
    } };
}
