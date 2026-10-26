import { expect, test } from "bun:test";
import { mainCounterFor, mainCountersOf, parseCounter } from "./main-counter";

const WEEK = parseCounter('["codex","codex",10080]', 10080, { free: true, paid: true });
const FIVE = parseCounter('["codex","codex",300]', 300, { free: false, paid: true });
const MONTH = parseCounter('["codex","codex",43200]', 43200, { free: true, paid: false });

test("a paid cycle skips the Free-only 30-day counter; a Free cycle takes it as the longest", () => {
  expect(mainCounterFor([WEEK, FIVE, MONTH], false)?.id).toBe(WEEK.id);
  expect(mainCounterFor([WEEK, FIVE, MONTH], true)?.id).toBe(MONTH.id);
  expect(mainCountersOf([WEEK, FIVE, MONTH]).map((c) => c.id)).toEqual([WEEK.id, MONTH.id]);
});

test("counters without known plans fit both; with no fitting counter the account's longest stays", () => {
  const unknown = parseCounter('["codex","codex",43200]', 43200, { free: false, paid: false });
  expect(mainCounterFor([WEEK, unknown], false)?.id).toBe(unknown.id);
  expect(mainCounterFor([MONTH], false)?.id).toBe(MONTH.id);
  expect(mainCountersOf([WEEK, FIVE]).map((c) => c.id)).toEqual([WEEK.id]);
  expect(mainCounterFor([], true)).toBeNull();
});
