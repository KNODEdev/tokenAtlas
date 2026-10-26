import { Worker } from "node:worker_threads";
import type { CloudSyncResult } from "../sync/claude-cloud-sync";
import { readCloudSyncSetting } from "../sync/claude-cloud-settings";

export interface CloudSyncStatus { running: boolean; nextRunAt: string | null; last: CloudSyncResult | null; error: string | null }
type Message = { result: CloudSyncResult } | { error: string } | { closed: true };

/**
 * Claude cloud sessions on the interval chosen in Settings, in a worker so that copying and
 * hashing large session files never blocks HTTP. The interval is read again before every run.
 */
export function startClaudeCloudMaintenance(canStart: () => boolean, onPublished: (result: CloudSyncResult) => void,
  runtime: { now?: () => number; startupDelayMs?: number; minutes?: () => number } = {}) {
  const now = runtime.now ?? Date.now;
  const minutes = runtime.minutes ?? (() => { try { return readCloudSyncSetting().minutes; } catch { return 0; } });
  let nextWakeAt = now() + (runtime.startupDelayMs ?? 90_000);
  let worker: Worker | undefined, running = false, stopped = false;
  const status: CloudSyncStatus = { running: false, nextRunAt: null, last: null, error: null };
  const finish = (message: Exclude<Message, { closed: true }>) => {
    running = status.running = false;
    nextWakeAt = now() + Math.max(1, minutes()) * 60_000;
    if ("error" in message) {
      if (message.error !== status.error) console.warn("[tokenAtlas cloud sessions] run failed:", message.error);
      status.error = message.error;
      return;
    }
    status.last = message.result; status.error = null;
    for (const profile of message.result.profiles) for (const error of profile.errors.slice(0, 3))
      console.warn(`[tokenAtlas cloud sessions] ${profile.archiveDir}: ${error}`);
    if (message.result.archived.length) onPublished(message.result);
  };
  const update = () => {
    const interval = minutes();
    status.nextRunAt = interval > 0 ? new Date(nextWakeAt).toISOString() : null;
    if (stopped || running || interval <= 0 || now() < nextWakeAt || !canStart()) return;
    if (!worker) {
      const next = new Worker(new URL("./claude-cloud-worker.ts", import.meta.url));
      worker = next;
      next.on("message", (message: Message) => { if (worker === next && !("closed" in message)) finish(message); });
      const failed = () => {
        if (worker !== next || stopped) return;
        worker = undefined;
        if (running) finish({ error: "cloud session worker interrupted; the next run resumes from the archive" });
      };
      next.on("error", failed); next.on("exit", failed); next.unref();
    }
    running = status.running = true;
    worker.postMessage({ run: true });
  };
  /** Run as soon as the gate allows (the Settings field changed, or the user asked). */
  const runSoon = () => { nextWakeAt = now(); update(); };
  return { update, runSoon, status: () => ({ ...status }),
    async close() {
      stopped = true;
      const closing = worker;
      if (closing) {
        const idle = new Promise<void>(resolve => {
          closing.on("message", message => { if (message?.closed) resolve(); });
          closing.once("exit", () => resolve());
        });
        closing.ref(); closing.postMessage({ close: true }); await idle; await closing.terminate();
        worker = undefined;
      }
      running = status.running = false;
    } };
}
