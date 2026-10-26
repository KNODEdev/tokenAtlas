import { test, expect } from "bun:test";
import { DATA_VIEWS } from "./data-views";
import { CAPACITY_CYCLE_RESULTS_CLOCK } from "./capacity-cycle-producer";
import { handleCapacityCycles } from "./capacity-cycles";
import type { AppContext } from "./api";

test("the capacity comparison is a stored-row view that follows the window sums", () => {
  const view = DATA_VIEWS["/api/capacity-cycles"];
  expect(view?.direct).toBe(true);
  expect(view?.clock).toBe(false);
  expect(view?.sources).toContain(CAPACITY_CYCLE_RESULTS_CLOCK);
});

test("the capacity comparison refuses a malformed range or window length before reading anything", () => {
  // No database: a refused request must not touch it.
  const ctx = {} as AppContext;
  const status = (query: string) => handleCapacityCycles(ctx, new URL(`http://local/api/capacity-cycles?${query}`)).status;
  expect(status("since=2026-10-10&until=2026-10-01&window_minutes=10080")).toBe(400);
  expect(status("since=2026-10&until=2026-10-10&window_minutes=10080")).toBe(400);
  expect(status("since=2026-10-01&until=2026-10-10&window_minutes=60")).toBe(400);
  expect(status("since=2026-99-99&until=2026-99-99")).toBe(400);
  expect(status("since=2026-02-30&until=2026-03-03")).toBe(400);
});
