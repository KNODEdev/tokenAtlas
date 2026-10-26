import { expect, test } from "bun:test";
import { calendarDateLabels, calendarTimeTicks } from "./chart-dates";

test("window labels retain successive UTC days, not only month changes", () => {
  expect(calendarDateLabels(["2026-07-01T23:00:00Z", "2026-07-02T01:00:00Z", "2026-07-02T09:00:00Z", "2026-07-20", "bad"], "en-GB"))
    .toEqual(["01/07", "02/07", null, "20/07", null]);
  expect(calendarDateLabels([], "pl-PL")).toEqual([]);
  expect(calendarDateLabels(["bad"], "pl-PL")).toEqual([null]);
});

test("sub-day windows have dates and clock times; cross-year dates retain the year", () => {
  expect(calendarDateLabels(["2026-10-17T01:00Z", "2026-10-17T06:00Z"], "en-GB")).toEqual(["17/10, 01:00", "17/10, 06:00"]);
  expect(calendarDateLabels(["2025-12-31", "2026-01-01"], "en-GB")).toEqual(["31/12/25", "01/01/26"]);
  expect(calendarDateLabels(["2026-10", "2026-11"], "pl-PL")).toEqual(["01.10", "01.11"]);
});

test("continuous axes show each day when it fits and thin labels at smaller widths", () => {
  const from = Date.parse("2026-10-01"), until = Date.parse("2026-10-08");
  const wide = calendarTimeTicks(from, until, 900, "en-GB");
  expect(wide.map(tick => tick.label)).toEqual(["01/10", "02/10", "03/10", "04/10", "05/10", "06/10", "07/10", "08/10"]);
  const narrow = calendarTimeTicks(from, until, 250, "en-GB");
  expect(narrow.length).toBeLessThan(wide.length);
  expect(narrow[0]!.time).toBe(from); expect(narrow.at(-1)!.time).toBe(until);
  for (let i = 1; i < narrow.length; i++) expect(narrow[i]!.time).toBeGreaterThan(narrow[i - 1]!.time);
  expect(calendarTimeTicks(NaN, until, 800, "en-GB")).toEqual([]);
});


test("hourly axes retain both dates and intermediate hours across midnight", () => {
  const ticks = calendarTimeTicks(Date.parse("2026-10-17T18:00Z"), Date.parse("2026-10-19T06:00Z"), 900, "en-GB", true);
  expect(ticks.length).toBeGreaterThan(3);
  expect(ticks[0]!.label).toBe("17/10, 18:00");
  expect(ticks.at(-1)!.label).toBe("19/10, 06:00");
});
