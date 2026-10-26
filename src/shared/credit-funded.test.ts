import { expect, test } from "bun:test";
import { creditFundedByLocalDay, localDayKey } from "./credit-funded";

test("credit-funded hours regroup into local days", () => {
  const hours: Array<[string, number, number, number, number]> = [["2026-10-01T08:00:00.000Z", 1, 10, 2, 0.1],
    ["2026-10-01T09:00:00.000Z", 2, 20, 4, 0.2], ["2026-10-02T08:00:00.000Z", 3, 30, 6, 0.3]];
  const days = creditFundedByLocalDay({ hours });
  expect([...days.values()].reduce((sum, day) => sum + day.tokens, 0)).toBe(60);
  expect(days.get(localDayKey(Date.parse("2026-10-02T08:00:00.000Z")))).toMatchObject({ calls: 3, tokens: 30 });
  expect(creditFundedByLocalDay(null).size).toBe(0);
});
