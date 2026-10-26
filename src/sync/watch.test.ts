import { describe, expect, it } from "bun:test";
import {
  resolvedSyncWatchRoots,
  startSyncWatcher,
  type SyncWatchClock,
  type SyncWatchFactory,
  type SyncWatchHandle,
} from "./watch";

class FakeClock implements SyncWatchClock {
  private nextId = 1;
  readonly timeouts = new Map<number, () => void>();
  readonly intervals = new Map<number, () => void>();
  readonly clearedTimeouts: number[] = [];
  readonly clearedIntervals: number[] = [];

  setTimeout(callback: () => void): unknown {
    const id = this.nextId++;
    this.timeouts.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    const id = Number(handle);
    this.timeouts.delete(id);
    this.clearedTimeouts.push(id);
  }

  setInterval(callback: () => void): unknown {
    const id = this.nextId++;
    this.intervals.set(id, callback);
    return id;
  }

  clearInterval(handle: unknown): void {
    const id = Number(handle);
    this.intervals.delete(id);
    this.clearedIntervals.push(id);
  }

  fireTimeouts(): void {
    const pending = [...this.timeouts.entries()];
    this.timeouts.clear();
    for (const [, callback] of pending) callback();
  }

  fireIntervals(): void {
    for (const callback of [...this.intervals.values()]) callback();
  }
}

interface FakeWatches {
  factory: SyncWatchFactory;
  changes: Array<(path: string | null) => void>;
  errors: Array<(error: unknown) => void>;
  handles: Array<SyncWatchHandle & { closed: boolean }>;
}

function fakeWatches(): FakeWatches {
  const changes: Array<(path: string | null) => void> = [];
  const errors: Array<(error: unknown) => void> = [];
  const handles: Array<SyncWatchHandle & { closed: boolean }> = [];
  return {
    changes,
    errors,
    handles,
    factory: (_root, onChange, onError) => {
      const handle = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      changes.push(onChange);
      errors.push(onError);
      handles.push(handle);
      return handle;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("sync watcher", () => {
  it("refreshes configured source roots without restarting the application",()=>{
    const watches=fakeWatches(),clock=new FakeClock();
    let roots=[{path:"C:/fixture/first",label:"source"}];
    const watcher=startSyncWatcher({resolveRoots:()=>roots,dbPath:"C:/fixture/atlas.sqlite",runIncremental:async()=>{},
      watch:watches.factory,clock,exists:()=>true,report:()=>{}});
    expect(watches.handles).toHaveLength(1);
    roots=[{path:"C:/fixture/second",label:"source"}];watcher.reconcile();
    expect(watches.handles[0]!.closed).toBe(true);expect(watches.handles).toHaveLength(2);
    expect(watches.handles[1]!.closed).toBe(false);watcher.close();
  });
  it("does not watch the Codex delegate ledger", () => {
    expect(resolvedSyncWatchRoots().some((root) => /delegate-ledger|[\\/]_ledger(?:[\\/]|$)/i.test(root.path))).toBe(false);
  });

  it("debounces a burst into one incremental request", async () => {
    const clock = new FakeClock();
    const watches = fakeWatches();
    let calls = 0;
    const watcher = startSyncWatcher({
      roots: [{ path: "C:/fixture/archive", label: "fixture" }],
      dbPath: "C:/fixture/atlas.sqlite",
      runIncremental: async () => {
        calls += 1;
      },
      clock,
      watch: watches.factory,
      exists: () => true,
      report: () => {},
    });
    watches.changes[0]!("C:/fixture/archive/a.jsonl");
    watches.changes[0]!("C:/fixture/archive/a.jsonl");
    watches.changes[0]!("C:/fixture/archive/a.jsonl");
    expect(calls).toBe(0);
    expect(clock.timeouts.size).toBe(1);
    clock.fireTimeouts();
    await flush();
    expect(calls).toBe(1);
    watcher.close();
  });

  it("coalesces a signal during a run into exactly one immediate follow-up", async () => {
    const clock = new FakeClock();
    const watches = fakeWatches();
    let releaseFirst = (): void => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const watcher = startSyncWatcher({
      roots: [{ path: "C:/fixture/archive", label: "fixture" }],
      dbPath: "C:/fixture/atlas.sqlite",
      minGapMs: 0,
      runIncremental: async () => {
        calls += 1;
        if (calls === 1) await first;
      },
      clock,
      watch: watches.factory,
      exists: () => true,
      report: () => {},
    });
    watcher.reconcile();
    await flush();
    expect(calls).toBe(1);
    watches.changes[0]!("C:/fixture/archive/new.jsonl");
    watches.changes[0]!("C:/fixture/archive/new.jsonl");
    releaseFirst();
    await flush();
    expect(calls).toBe(2);
    expect(clock.timeouts.size).toBe(0);
    watcher.close();
  });

  it("suppresses mirror destination events so one external append creates one heavy pass", async () => {
    const clock = new FakeClock();
    const watches = fakeWatches();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const watcher = startSyncWatcher({
      roots: [{ path: "C:/fixture", label: "fixture" }],
      dbPath: "C:/fixture/atlas.sqlite",
      runIncremental: async () => {
        calls += 1;
        await gate;
      },
      ignoreChange: (changedPath) => changedPath?.includes("/archive/own/") ?? false,
      clock,
      watch: watches.factory,
      exists: () => true,
      report: () => {},
    });
    watches.changes[0]!("C:/fixture/local/external.jsonl");
    clock.fireTimeouts();
    await flush();
    expect(calls).toBe(1);
    watches.changes[0]!("C:/fixture/archive/own/copied.jsonl");
    release();
    await flush();
    expect(calls).toBe(1);
    expect(watcher.status().followUpPending).toBe(false);
    watcher.close();
  });

  it("uses the periodic reconciliation when no filesystem event arrives", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const watcher = startSyncWatcher({
      roots: [],
      dbPath: "C:/fixture/atlas.sqlite",
      runIncremental: async () => {
        calls += 1;
      },
      clock,
      exists: () => true,
      report: () => {},
    });
    clock.fireIntervals();
    await flush();
    expect(calls).toBe(1);
    watcher.close();
  });

  it("reports missing roots and watcher errors without disabling reconciliation", async () => {
    const clock = new FakeClock();
    const watches = fakeWatches();
    const reports: string[] = [];
    let available = false;
    let calls = 0;
    const watcher = startSyncWatcher({
      roots: [{ path: "C:/fixture/onedrive", label: "OneDrive" }],
      dbPath: "C:/fixture/atlas.sqlite",
      runIncremental: async () => {
        calls += 1;
      },
      clock,
      watch: watches.factory,
      exists: () => available,
      report: (message) => reports.push(message),
    });
    expect(watcher.status().missingRoots).toHaveLength(1);
    available = true;
    clock.fireIntervals();
    await flush();
    expect(calls).toBe(1);
    expect(watcher.status().watchedRoots).toHaveLength(1);
    watches.errors[0]!(new Error("transient disconnect"));
    expect(watcher.status().errors.at(-1)).toContain("transient disconnect");
    expect(reports.length).toBeGreaterThan(0);
    watcher.close();
  });

  it("closes every watcher and scheduled callback", () => {
    const clock = new FakeClock();
    const watches = fakeWatches();
    const watcher = startSyncWatcher({
      roots: [{ path: "C:/fixture/archive", label: "fixture" }],
      dbPath: "C:/fixture/atlas.sqlite",
      runIncremental: async () => {},
      clock,
      watch: watches.factory,
      exists: () => true,
      report: () => {},
    });
    watcher.signal();
    watcher.close();
    expect(watches.handles.every((handle) => handle.closed)).toBe(true);
    expect(clock.timeouts.size).toBe(0);
    expect(clock.intervals.size).toBe(0);
    expect(clock.clearedTimeouts).toHaveLength(1);
    expect(clock.clearedIntervals).toHaveLength(1);
  });
});
