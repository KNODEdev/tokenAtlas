import { Worker } from "node:worker_threads";
import type { CurrentConfig } from "./current/registry";
import type { BackgroundTurnResult } from "./background-jobs";
import type { JournalDeliveryTarget } from "../providers/core/journal";
import { recordGaugeJournalDelivery } from "../providers/core/journal-runtime";
import type { WindowAnswer } from "../db/window-answers";

export type AnalysisMaintenanceResult = BackgroundTurnResult;
const CATCH_UP_DELAY_MS = 25;
/** A turn that failed as a whole (not one job) is retried after this. */
const FAILED_TURN_RETRY_MS = 15_000;

/**
 * The background writer of the server (U2.1): a worker thread running the job queue of
 * background-jobs.ts, one turn per `update()`. A turn that leaves executable work schedules the
 * next one shortly; `close()` lets a running turn finish (a journal delivery may hold an archive
 * writer) before the thread stops.
 */
export function startAnalysisMaintenance(dbPath: string, config: () => CurrentConfig, canStart: () => boolean = () => true,
  onIdle: (result: AnalysisMaintenanceResult) => void = () => {}, runtime: { now?: () => number; setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout; /** Time a backlog may use of one worker turn (default 2 s); 0 is one pass over the jobs. */ turnMs?: number;
    /** Where this server's gauge journal is delivered; null keeps delivery off. */ journal?: () => JournalDeliveryTarget | null;
    /** Window answers to publish (data-read.ts): taken for a turn, given back when the turn did not store them. */
    answers?: { take(): WindowAnswer[]; giveBack(answers: readonly WindowAnswer[]): void } } = {}) {
  const now = runtime.now ?? Date.now, setTimer = runtime.setTimeout ?? setTimeout, clearTimer = runtime.clearTimeout ?? clearTimeout;
  let continuation: ReturnType<typeof setTimeout> | undefined;
  let worker: Worker | null = null;
  let running = false, stopped = false, pending = false, retryAfter = 0;
  let idle: Promise<void> = Promise.resolve();
  let release: () => void = () => {};
  let reported: Record<string, string> = {};
  let sentAnswers: WindowAnswer[] = [];
  const finish = (result: AnalysisMaintenanceResult = { catchUpNeeded: false, errors: {} }) => {
    running = false; release();
    if (!result.answersStored && sentAnswers.length) runtime.answers?.giveBack(sentAnswers);
    sentAnswers = [];
    if (stopped) return;
    // A job failing the same way turn after turn is reported once.
    for (const [scope, message] of Object.entries(result.errors))
      if (reported[scope] !== message) console.warn(`[tokenAtlas background] ${scope} failed; its queue is retained:`, message);
    reported = result.errors;
    if (result.errors.turn) retryAfter = now() + FAILED_TURN_RETRY_MS;
    if (result.journal) recordGaugeJournalDelivery(result.journal);
    onIdle(result);
    if (result.catchUpNeeded && !result.errors.turn && !stopped && !continuation) {
      continuation = setTimer(() => { continuation = undefined; update(); }, CATCH_UP_DELAY_MS);
      continuation.unref?.();
    }
  };
  const update = () => {
    if (stopped || running || now() < retryAfter) return;
    pending = true;
    if (!canStart()) return;
    if (continuation) { clearTimer(continuation); continuation = undefined; }
    pending = false;
    if (!worker) {
      const next = new Worker(new URL("./analysis-maintenance-worker.ts", import.meta.url), {
        env: { ...process.env }, workerData: { dbPath, turnMs: runtime.turnMs },
      });
      worker = next;
      const failed = () => {
        if (worker !== next || stopped) return;
        worker = null;
        retryAfter = now() + 5000;
        void next.terminate().finally(() => finish());
        console.warn("[tokenAtlas background] writer interrupted; its queues resume");
      };
      next.on("error", failed);
      next.on("exit", failed);
      next.on("message", (result: AnalysisMaintenanceResult) => { if (worker === next && !stopped) finish(result); });
      next.unref();
    }
    running = true;
    idle = new Promise<void>(resolve => { release = resolve; });
    sentAnswers = runtime.answers?.take() ?? [];
    worker.postMessage({ config: config(), journal: runtime.journal?.() ?? null, answers: sentAnswers });
  };
  return { update, get pending() { return pending; }, get running() { return running; }, waitForIdle: () => idle,
    async close() {
      stopped = true;
      if (continuation) { clearTimer(continuation); continuation = undefined; }
      const closing = worker;
      worker = null;
      if (closing) {
        // The thread handles this after its current turn, then closes its connection and exits.
        const exited = new Promise<void>(resolve => closing.once("exit", () => resolve()));
        closing.ref();
        closing.postMessage({ close: true });
        await exited;
      }
      finish();
    } };
}
