import { expect, test } from "bun:test";
import { LiveReadingsRefresh } from "./live-readings";

test("a manual reading pass joins a scheduled probe and awaits all scoped reads", async () => {
  const refresh = new LiveReadingsRefresh();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0, otherCalls = 0, finished = false;
  const scheduled = refresh.register("codex", "codex", async () => { calls++; await gate; });
  refresh.register("claude", "claude", () => { otherCalls++; });
  const inFlight = scheduled();
  expect(refresh.running).toBe(true);
  const progress: number[][] = [];
  const manual = refresh.run("codex", (done, total) => progress.push([done, total])).then(() => { finished = true; });
  await Bun.sleep(0);
  expect([calls, otherCalls, finished]).toEqual([1, 0, false]);
  release();
  await Promise.all([inFlight, manual]);
  expect(refresh.running).toBe(false);
  expect(progress).toEqual([[0, 1], [1, 1]]);
  await refresh.run();
  expect([calls, otherCalls]).toEqual([2, 1]);
});

test("one rejected account check does not block remaining reads or history import", async () => {
  const refresh = new LiveReadingsRefresh();
  refresh.register("codex", "codex", () => { throw new Error("fixture probe unavailable"); });
  let otherCalls = 0;
  refresh.register("claude", "claude", () => { otherCalls++; });
  let done = 0;
  await refresh.run(undefined, completed => { done = completed; });
  expect([done, otherCalls]).toEqual([2, 1]);
});

test("reads wait asynchronously for a bulk writer and still join manual refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release=resolve;});
  let calls=0;
  const refresh=new LiveReadingsRefresh(()=>gate);
  const poll=refresh.register("codex","codex",()=>{calls++;});
  const scheduled=poll(); const manual=refresh.run("codex");
  await Bun.sleep(0); expect(calls).toBe(0);
  release(); await Promise.all([scheduled,manual]); expect(calls).toBe(1);
});
test("closing the runtime cancels a deferred reading", async () => {
  let calls=0;const refresh=new LiveReadingsRefresh(()=>false);
  refresh.register("codex","codex",()=>{calls++;});await refresh.run();expect(calls).toBe(0);
});

test("an automatic pass skips reads attempted within the probe interval, failed ones included; a manual pass never does", async () => {
  const refresh = new LiveReadingsRefresh();
  let reads = 0, failures = 0;
  const scheduled = refresh.register("codex", "codex", () => { reads++; });
  refresh.register("gemini", "gemini", () => { failures++; throw new Error("fixture probe unavailable"); });
  await scheduled();
  await refresh.run(undefined, undefined, 60_000);
  // Codex was just read by its timer; Gemini had never been attempted.
  expect([reads, failures]).toEqual([1, 1]);
  const progress: number[][] = [];
  await refresh.run(undefined, (done, total) => progress.push([done, total]), 60_000);
  expect([reads, failures]).toEqual([1, 1]);
  expect(progress).toEqual([[0, 0]]);
  await refresh.run();
  expect([reads, failures]).toEqual([2, 2]);
  await Bun.sleep(15);
  await refresh.run(undefined, undefined, 10);
  expect([reads, failures]).toEqual([3, 3]);
});

test("a read made outside the registered task counts as its attempt", async () => {
  const refresh = new LiveReadingsRefresh();
  let reads = 0;
  refresh.register("claude", "claude", () => { reads++; });
  refresh.noteAttempt(["claude", "unknown"]);
  await refresh.run(undefined, undefined, 60_000);
  expect(reads).toBe(0);
  await refresh.run();
  expect(reads).toBe(1);
});
