import { expect, test } from "bun:test";
import { speedDayAxis } from "./speed-axis";

test("short speed histories label consecutive dates and challenge days including quiet days", () => {
  const axis = speedDayAxis("2026-10-03", "2026-10-09", 900, { from: "2026-10-05", days: 28 });
  expect(axis.labels.map(tick => tick.label)).toEqual(["03.10", "04.10", "05.10", "06.10", "07.10", "08.10", "09.10"]);
  expect(axis.labels.map(tick => tick.day)).toEqual([null, null, 1, 2, 3, 4, 5]);
});
test("long histories keep first/last dates, years, ordered labels and bounded density", () => {
  const axis = speedDayAxis("2025-09-16", "2026-10-17", 900);
  expect(axis.labels[0]!.label).toBe("16.09.25");
  expect(axis.labels.at(-1)!.label).toBe("17.10.26");
  expect(axis.labels.length).toBeLessThanOrEqual(17);
  expect(new Set(axis.labels.map(tick => tick.at)).size).toBe(axis.labels.length);
  expect(axis.labels.map(tick => tick.at)).toEqual(axis.labels.map(tick => tick.at).sort());
});
test("UTC axis keeps every date across DST and ends challenge numbering after day28", () => {
  const axis = speedDayAxis("2026-10-31", "2026-11-03", 900, { from: "2026-10-05", days: 28 });
  expect(axis.ticks.map(tick => tick.day)).toEqual([27, 28, null, null]);
  expect(speedDayAxis("2026-10-17", "2026-10-17", 0).labels).toHaveLength(1);
  expect(speedDayAxis("invalid", "2026-10-17", 900).labels).toHaveLength(0);
});
