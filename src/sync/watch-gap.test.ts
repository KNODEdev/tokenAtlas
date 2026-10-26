import { describe, expect, it } from "bun:test";
import { resolvedSyncWatchRoots, startSyncWatcher, type SyncWatchClock, type SyncWatchFactory } from "./watch";

class FakeClock implements SyncWatchClock {
  private nextId = 1;
  readonly timeouts = new Map<number, { callback: () => void; delayMs: number }>();
  readonly intervals = new Map<number, () => void>();
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, delayMs });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(Number(handle));
  }
  setInterval(callback: () => void): unknown {
    const id = this.nextId++;
    this.intervals.set(id, callback);
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(Number(handle));
  }
  fireTimeouts(): void {
    const pending = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const { callback } of pending) callback();
  }
}

const watch: SyncWatchFactory = () => ({ close() {} });

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("sync watcher cadence", () => {
  it("watches only the shared archive and configuration, never local transcript folders", () => {
    const roots = resolvedSyncWatchRoots().map((root) => root.label);
    expect(roots).toContain("shared archive");
    expect(roots.some((label) => /Codex|Claude|OpenCode|Grok|Antigravity/.test(label))).toBe(false);
  });

  it("keeps a minimum gap between runs and folds the signals in between into one deferred run", async () => {
    const clock = new FakeClock();
    let nowMs = Date.parse("2026-09-02T12:00:00.000Z");
    let runs = 0;
    const watcher = startSyncWatcher({
      roots: [{ path: "C:/archive", label: "shared archive" }],
      dbPath: "C:/atlas.sqlite",
      runIncremental: async () => {
        runs += 1;
      },
      reconciliationMs: 0,
      debounceMs: 100,
      minGapMs: 5 * 60_000,
      watch,
      clock,
      exists: () => true,
      now: () => new Date(nowMs).toISOString(),
    });
    watcher.signal();
    clock.fireTimeouts();
    await flush();
    expect(runs).toBe(1);

    nowMs += 60_000;
    watcher.signal();
    watcher.signal();
    clock.fireTimeouts(); // debounce fires, but the gap defers the run
    await flush();
    expect(runs).toBe(1);
    const deferred = [...clock.timeouts.values()];
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.delayMs).toBe(4 * 60_000);
    expect(watcher.status().nextRunNotBefore).toBe("2026-09-02T12:05:00.000Z");

    nowMs += 4 * 60_000;
    clock.fireTimeouts();
    await flush();
    expect(runs).toBe(2);
    watcher.close();
  });

  it("a signal received while a run is in progress is deferred to the gap boundary, not run back-to-back", async () => {
    const clock = new FakeClock();
    let nowMs = Date.parse("2026-09-02T12:00:00.000Z");
    let runs = 0;
    let release: (() => void) | null = null;
    const watcher = startSyncWatcher({
      roots: [{ path: "C:/archive", label: "shared archive" }],
      dbPath: "C:/atlas.sqlite",
      runIncremental: () =>
        new Promise<void>((resolve) => {
          runs += 1;
          release = resolve;
        }),
      reconciliationMs: 0,
      debounceMs: 100,
      minGapMs: 5 * 60_000,
      watch,
      clock,
      exists: () => true,
      now: () => new Date(nowMs).toISOString(),
    });
    watcher.signal();
    clock.fireTimeouts();
    await flush();
    expect(runs).toBe(1);
    watcher.signal(); // arrives mid-run
    nowMs += 30_000;
    release!();
    await flush();
    await flush();
    expect(runs).toBe(1);
    expect([...clock.timeouts.values()].map((t) => t.delayMs)).toEqual([5 * 60_000]);
    watcher.close();
  });

  it("a configuration edit during a run gets its follow-up pass right away", async () => {
    const clock = new FakeClock();
    let runs = 0;
    let release: (() => void) | null = null;
    const watcher = startSyncWatcher({
      roots: [{ path: "C:/archive", label: "shared archive" }],
      dbPath: "C:/atlas.sqlite",
      runIncremental: () =>
        new Promise<void>((resolve) => {
          runs += 1;
          release = resolve;
        }),
      reconciliationMs: 0,
      debounceMs: 100,
      minGapMs: 5 * 60_000,
      watch,
      clock,
      exists: () => true,
    });
    watcher.signal();
    clock.fireTimeouts();
    await flush();
    watcher.signal({ urgent: true });
    const first = release!;
    first();
    await flush();
    await flush();
    expect(runs).toBe(2);
    release!();
    await flush();
    watcher.close();
  });

  it("with minGapMs 0 a new signal runs again right away", async () => {
    const clock = new FakeClock();
    let runs = 0;
    const watcher = startSyncWatcher({
      roots: [{ path: "C:/archive", label: "shared archive" }],
      dbPath: "C:/atlas.sqlite",
      runIncremental: async () => {
        runs += 1;
      },
      reconciliationMs: 0,
      debounceMs: 100,
      minGapMs: 0,
      watch,
      clock,
      exists: () => true,
    });
    watcher.signal();
    clock.fireTimeouts();
    await flush();
    watcher.signal();
    clock.fireTimeouts();
    await flush();
    expect(runs).toBe(2);
    watcher.close();
  });
});
