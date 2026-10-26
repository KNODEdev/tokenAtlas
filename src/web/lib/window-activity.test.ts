import { expect, test } from "bun:test";
import { activeCourses } from "./window-activity";

test("the chart breaks both the line and fill across the inactive interval", () => {
  const points = [{ t: 0, pct: 0 }, { t: 40, pct: 94 }, { t: 70, pct: 94 }, { t: 90, pct: 99 }];
  const iso = (n: number) => new Date(n).toISOString();
  const activity = { plan: "max-20x", spans: [{ start: iso(0), end: iso(500) }, { start: iso(700), end: iso(1000) }] };
  expect(activeCourses(points, activity, 0, 1000)).toEqual([points.slice(0, 2), points.slice(2)]);
  expect(activeCourses(points, undefined, 0, 1000)).toEqual([points]);
});
