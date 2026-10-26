export const READ_WORKER_IDLE_MS = 90_000;
interface IdleWorkerClock {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout> | undefined): void;
}

/** Only idle workers enter here; a running snapshot is never interrupted. */
export class IdleReadWorkers {
  private idle = new Map<Worker, ReturnType<typeof setTimeout>>();
  private closing = new Set<Promise<void>>();
  constructor(private retired: () => void, private idleMs = READ_WORKER_IDLE_MS,
    private clock: IdleWorkerClock = { setTimeout, clearTimeout }) {}
  get size() { return this.idle.size; }
  pop(): Worker | undefined {
    const worker = [...this.idle.keys()].at(-1);
    if (worker) { this.clock.clearTimeout(this.idle.get(worker)); this.idle.delete(worker); }
    return worker;
  }
  push(worker: Worker): void {
    const timer = this.clock.setTimeout(() => {
      // Keep one warm worker per pool so the usual return to a screen stays warm.
      if (this.idle.size <= 1 || !this.idle.has(worker)) return;
      this.remove(worker);
    }, this.idleMs);
    timer.unref?.();
    this.idle.set(worker, timer);
  }
  private remove(worker: Worker): void {
    this.clock.clearTimeout(this.idle.get(worker)); this.idle.delete(worker); this.retired();
    const closing = new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true; this.clock.clearTimeout(timer); worker.onmessage = null; worker.onerror = null;
        try { Promise.resolve(worker.terminate()).then(() => resolve(), () => resolve()); } catch { resolve(); }
      };
      const timer = this.clock.setTimeout(finish, 1000);
      worker.onmessage = finish; worker.onerror = finish;
      try { worker.postMessage({ close: true }); } catch { finish(); }
    });
    this.closing.add(closing);
    void closing.then(() => this.closing.delete(closing));
  }
  async close(): Promise<void> {
    for (const worker of this.idle.keys()) this.remove(worker);
    await Promise.all(this.closing);
  }
}
