import { expect, test } from "bun:test";
import { mainThreadStallCheck, trackMainThreadRequest } from "./main-thread-stall";

test("a late tick reports the stall with the requests that overlapped it", () => {
  let clock = 1_000_000;
  const now = () => clock, reports: string[] = [];
  const check = mainThreadStallCheck(message => reports.push(message), now);
  const before = trackMainThreadRequest("/api/before", now);
  clock += 100; before();
  clock += check.intervalMs; check.tick();
  expect(reports).toEqual([]);

  // A synchronous handler holds the thread 4 s; a status poll arrives and waits behind it.
  const slow = trackMainThreadRequest("/api/roster", now);
  const poll = trackMainThreadRequest("/api/sync", now);
  clock += 4_000; slow();
  clock += check.intervalMs; check.tick();
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("blocked 4.0 s");
  expect(reports[0]).toContain("/api/roster (4.0 s)");
  expect(reports[0]).toContain("/api/sync (4.3 s, running)");
  expect(reports[0]).not.toContain("/api/before");
  poll();
});
