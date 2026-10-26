import { expect, test } from "bun:test";
import { publicTiboMeasurements } from "./export-tibo-measurements";
import { modelSpeedSeries } from "../../src/server/model-speed";
import type { TiboHour } from "../../src/shared/tibo-measurements";

const now = Date.parse("2026-10-18T14:19:49Z");
const privateAccount = "private-person@example.test";
const hour = (date: string, patch: Partial<TiboHour> = {}): TiboHour => ({
  at: Date.parse(date), account: privateAccount, model: "gpt-6.1-sol", mode: "default", plan: "pro", funding: "allowance",
  calls: 40, input: 1000, cached: 500, timed: 40, output: 1000, ms: 10000,
  longCalls: 40, longOutput: 1000, longMs: 10000, ...patch,
});
const history = () => modelSpeedSeries(["2026-09-20", "2026-10-04", "2026-10-06"].map(date => ({
  hour: Date.parse(date) / 3_600_000, model: "gpt-6.1-sol", calls: 40, timed_calls: 40, timed_out: 1000,
  timed_ms: 10000, timed_long_calls: 40, timed_long_out: 1000, timed_long_ms: 10000,
})), "day");

test("public export strips private identity and extra source fields, keeping cohorts independent", () => {
  const histories = history();
  Object.assign(histories[0]!.total, { machine: "PRIVATE-MACHINE" });
  Object.assign(histories[0]!.points[0]!, { path: "C:/PRIVATE-PATH", account: privateAccount });
  const rows = [hour("2026-10-04T08:00Z"), hour("2026-10-06T08:00Z", { longMs: 5000 }),
    ...[{ account: "second@example.test" }, { mode: "priority" }, { plan: "plus" }, { funding: "credits" }]
      .map(patch => hour("2026-10-06T08:00Z", patch))];
  const result = publicTiboMeasurements(rows, new Map([[privateAccount, histories]]), now, 3);
  expect(result.cohorts).toHaveLength(5);
  expect(new Set(result.cohorts.map(c => c.sample)).size).toBe(2);
  expect(result.excludedCalls).toBe(3);
  const selected = result.cohorts.find(c => c.speed.before.calls > 0)!;
  expect(selected.speed.before.calls).toBe(40);
  expect(selected.speed.after.calls).toBe(40);
  expect(selected.speed.speedChange).toBe(100);
  expect(selected.speedHistory!.points[0]!.at).toBe("2026-09-20");
  const serialized = JSON.stringify(result);
  for (const sentinel of [privateAccount, "second@example.test", "PRIVATE-MACHINE", "PRIVATE-PATH"]) expect(serialized).not.toContain(sentinel);
  expect(serialized).not.toMatch(/"(?:account|machine|path|profile|project)":/);
});

test("cache publication retains all 28 dates and gaps without inventing zero or a completed post-period", () => {
  const data = publicTiboMeasurements([hour("2026-10-05T08:00Z"), hour("2026-10-07T08:00Z", { cached: 0 })], new Map(), now, 0);
  const cohort = data.cohorts[0]!;
  expect(cohort.cacheHistory).toHaveLength(28);
  expect(cohort.cacheHistory[0]!.value).toBe(50);
  expect(cohort.cacheHistory[1]!.value).toBeNull();
  expect(cohort.cacheHistory[2]!.value).toBe(0);
  expect(cohort.cacheHistory[27]).toEqual({ day: 28, date: "2026-11-01", value: null, calls: 0, input: 0, cached: 0 });
  expect(cohort.cache.complete).toBe(false);
  expect(cohort.cache.after.cache).toBeNull();

});

test("speed publication keeps complete history, reference and challenge dates separate from before/after", () => {
  const data = publicTiboMeasurements([hour("2026-10-04T08:00Z"), hour("2026-10-06T08:00Z")], new Map([[privateAccount, history()]]), now, 0);
  const cohort = data.cohorts[0]!;
  expect(cohort.speedHistory!.points.map(point => point.at)).toEqual(["2026-09-20", "2026-10-04", "2026-10-06"]);
  expect(cohort.speed.before.calls).toBe(40);
  expect(cohort.speed.after.calls).toBe(40);
  expect(JSON.stringify(data)).not.toContain(privateAccount);
});
