import { expect, test } from "bun:test";
import { IdleReadWorkers } from "./idle-read-workers";

function fixture() {
  let now = 0, retired = 0;
  const timers = new Set<{ at: number; callback: () => void; unref(): void }>();
  const clock = {
    setTimeout(callback: () => void, ms: number) {
      const timer = { at: now + ms, callback, unref() {} }; timers.add(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout> | undefined) { timers.delete(timer as never); },
  };
  const pool = new IdleReadWorkers(() => { retired++; }, 90_000, clock);
  const workers: Array<{ worker: Worker; closed: number; terminated: number; responsive: boolean }> = [];
  const worker = () => {
    const state = { worker: null as unknown as Worker, closed: 0, terminated: 0, responsive: true };
    state.worker = { onmessage: null, onerror: null,
      postMessage(message: unknown) { expect(message).toEqual({ close: true }); state.closed++; if (state.responsive) queueMicrotask(() => state.worker.onmessage?.({ data: { closed: true } } as MessageEvent)); },
      terminate() { state.terminated++; },
    } as unknown as Worker;
    workers.push(state); return state.worker;
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of [...timers]) if (timer.at <= now && timers.delete(timer)) timer.callback();
    await Promise.resolve(); await Promise.resolve();
  };
  return { pool, worker, workers, advance, retired: () => retired, timers };
}

test("excess idle workers release their database, keep one warm reader, and cancel expiry on reuse", async () => {
  const f = fixture(), one = f.worker(), two = f.worker(), active = f.worker();
  f.pool.push(one); f.pool.push(two); f.pool.push(active);
  expect(f.pool.pop()).toBe(active);
  await f.advance(90_000);
  expect(f.retired()).toBe(1); expect(f.pool.size).toBe(1);
  expect(f.workers.map(worker => worker.closed)).toEqual([1, 0, 0]);
  expect(f.workers.map(worker => worker.terminated)).toEqual([1, 0, 0]);
  expect(f.pool.pop()).toBe(two);
  f.pool.push(active); f.pool.push(two);
  await f.advance(90_000);
  expect(f.retired()).toBe(2); expect(f.pool.size).toBe(1);
  await f.pool.close(); expect(f.retired()).toBe(3); expect(f.timers.size).toBe(0);
});

test("shutdown waits for a retiring worker and forces an unresponsive idle reader closed", async () => {
  const f = fixture(), one = f.worker(), two = f.worker();
  f.workers[0]!.responsive = false;
  f.pool.push(one); f.pool.push(two);
  await f.advance(90_000);
  let closed = false;
  const closing = f.pool.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  await f.advance(1000); await closing;
  expect(f.workers.map(worker => worker.terminated)).toEqual([1, 1]);
  expect(f.timers.size).toBe(0);
});
