import { expect, test } from "bun:test";
import { codexCounterMinutes, codexHeadlineWindowMinutes } from "./codex-counters";

const row = (window_minutes: number, ts = "2026-10-19T00:17:00Z", limit_id = "codex") => ({ limit_id, window_minutes, ts });

test("counter identities keep 5h, weekly and 30-day denominators distinct", () => {
  expect(["five_hour", "weekly", "thirty_day"].map(codexCounterMinutes)).toEqual([300, 10080, 43200]);
  expect(codexCounterMinutes("monthly")).toBeNull();
  expect(codexCounterMinutes("unrecognized")).toBeNull();
});

test("the default headline follows the latest main 30-day meter, never a reserve or stale weekly meter", () => {
  const monthly = row(43200);
  expect(codexHeadlineWindowMinutes([monthly, row(10080, "2026-10-12T00:00:00Z")])).toBe(43200);
  expect(codexHeadlineWindowMinutes([row(300), row(10080), row(43200, undefined, "reserve")])).toBe(10080);
  expect(codexHeadlineWindowMinutes([monthly], 300)).toBe(300);
  expect(codexHeadlineWindowMinutes([monthly], 43200)).toBe(43200);
});
