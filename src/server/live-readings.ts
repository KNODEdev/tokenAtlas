import type { VendorId } from "../sync/contracts";

/** Manual refreshes join scheduled reads instead of starting duplicate requests. */
export class LiveReadingsRefresh {
  constructor(private readonly beforeRead?: () => boolean | void | Promise<boolean | void>) {}

  private activeReads = 0;
  get running(): boolean { return this.activeReads > 0; }
  private tasks = new Map<string, { vendor: VendorId; poll: () => Promise<unknown>; attemptedAt: number }>();

  register(key: string, vendor: VendorId, read: () => unknown | Promise<unknown>): () => Promise<unknown> {
    let active: Promise<unknown> | null = null;
    const poll = () => {
      if (active) return active;
      this.activeReads++;
      active = Promise.resolve().then(async () => {
        if (await this.beforeRead?.() === false) return;
        return read();
      }).finally(() => { active = null; this.activeReads--; task.attemptedAt = Date.now(); });
      return active;
    };
    const task = { vendor, poll, attemptedAt: 0 };
    this.tasks.set(key, task);
    return poll;
  }

  /** Starts (or joins) one registered read now; false when no read has that key. */
  readNow(key: string): boolean {
    const task = this.tasks.get(key);
    if (!task) return false;
    void task.poll().catch(error => console.warn(`[tokenAtlas readings] ${task.vendor} refresh failed`, error));
    return true;
  }

  /** A read of these tasks' accounts made outside them, such as the scheduled cycle over every account. */
  noteAttempt(keys: readonly string[]): void {
    for (const key of keys) { const task = this.tasks.get(key); if (task) task.attemptedAt = Date.now(); }
  }

  /**
   * `notWithinMs` leaves out reads attempted that recently, failed ones included. Automatic sync
   * runs pass the probe interval: each run used to start a full probe cycle, so under a busy
   * file watcher accounts were probed every minute whatever the interval said.
   */
  async run(vendor?: VendorId, progress?: (completed: number, total: number) => void, notWithinMs = 0): Promise<void> {
    const tasks = [...this.tasks.values()].filter(task => (!vendor || vendor === "gauges" || task.vendor === vendor)
      && (notWithinMs <= 0 || Date.now() - task.attemptedAt >= notWithinMs));
    let completed = 0;
    progress?.(completed, tasks.length);
    await Promise.all(tasks.map(async task => {
      try { await task.poll(); }
      catch (error) { console.warn(`[tokenAtlas readings] ${task.vendor} refresh failed`, error); }
      finally { progress?.(++completed, tasks.length); }
    }));
  }
}
