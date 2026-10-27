import { expect, test } from "bun:test";
import { bankedGrants } from "./banked-grants";
import type { CreditReading } from "./window-end-causes";

const at = (day: number, hour = 0) => Date.UTC(2026, 8, day, hour);
const credit = (id: string) => ({ id, granted_at: "", expires_at: "" });
const count = (ts: number, n: number): CreditReading => ({ ts, count: n, list: null });
const list = (ts: number, ...ids: string[]): CreditReading => ({ ts, count: ids.length, list: ids.map(credit) });
const start = at(10), end = at(20);

test("before the credit list a grant is a rise of the count; a use is no grant", () => {
  const readings = [count(at(9, 20), 1), count(at(11), 2), count(at(12), 1), count(at(15), 3), count(at(25), 4)];
  expect(bankedGrants(readings, start, end)).toEqual({ count: 3, from: new Date(at(9, 20)).toISOString(), complete: true });
});

test("with the list a grant is a credit id not seen before, even when a use hides it from the count", () => {
  const readings = [list(at(9, 23), "a"), list(at(11), "b"), list(at(13), "b", "c"), list(at(14), "c", "b")];
  expect(bankedGrants(readings, start, end)?.count).toBe(2);
  // The count alone sees no rise from "a" to "b": the list era must not fall back to it.
  expect(bankedGrants([count(at(9, 23), 1), count(at(11), 1)], start, end)?.count).toBe(0);
});

test("the change from count to list readings counts by the count, then by the ids", () => {
  const readings = [count(at(9, 23), 0), list(at(11), "a"), list(at(12), "a", "b")];
  expect(bankedGrants(readings, start, end)?.count).toBe(2);
});

test("without a reading within a day before the cycle the count starts at the first reading and is a lower bound", () => {
  expect(bankedGrants([count(at(5), 0), count(at(12), 1), count(at(13), 2)], start, end)).toEqual({ count: 1, from: new Date(at(12)).toISOString(), complete: false });
  expect(bankedGrants([count(at(9, 23), 1)], start, end)).toBeNull();
  expect(bankedGrants([], start, end)).toBeNull();
});
