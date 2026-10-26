import { expect, test } from "bun:test";
import { dirtyRangesFromTimestamps } from "./dirty-ranges";

test("old correction and today's append retain disjoint days including moved timestamps", () => {
  expect(dirtyRangesFromTimestamps([
    "2026-09-19T12:00:00Z", "2026-03-01T10:00:00Z", "2026-03-02T10:00:00Z",
    "2026-03-01T11:00:00Z", "2026-03-01T10:00:00Z",
  ])).toEqual([
    { from: "2026-03-01T10:00:00Z", to: "2026-03-01T11:00:00Z" },
    { from: "2026-03-02T10:00:00Z", to: "2026-03-02T10:00:00Z" },
    { from: "2026-09-19T12:00:00Z", to: "2026-09-19T12:00:00Z" },
  ]);
  expect(dirtyRangesFromTimestamps([])).toEqual([]);
  expect(() => dirtyRangesFromTimestamps(["invalid"])).toThrow("Invalid dirty timestamp");
});
