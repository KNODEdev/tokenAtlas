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
  expect(bankedGrants(readings, start, end)).toEqual({ count: 2, from: new Date(at(9, 20)).toISOString(), complete: false });
});

test("provider grant dates determine the cycle even when first observed after its start", () => {
  const dated = (id: string, ts: number) => ({ id, granted_at: new Date(ts).toISOString(), expires_at: "" });
  const readings: CreditReading[] = [{ ts: at(9, 22), count: 0, list: [] },
    { ts: at(10, 1), count: 2, list: [dated("before", at(9, 23)), dated("inside", at(10))] }];
  expect(bankedGrants(readings, start, end)).toMatchObject({ count: 1, complete: true });
  expect(bankedGrants([{ ts: at(9, 22), count: 0, list: null }, readings[1]!], start, end))
    .toMatchObject({ count: 1, complete: false });
});

test("dated grants in the first available list count once without inventing complete coverage", () => {
  const reading: CreditReading = { ts: at(12), count: 1, list: [{ id: "inside", granted_at: new Date(at(11)).toISOString(), expires_at: "" }] };
  expect(bankedGrants([reading, { ...reading, ts: at(13) }], start, end)).toMatchObject({ count: 1, complete: false });
});

test("with the list a grant is a credit id not seen before, even when a use hides it from the count", () => {
  const readings = [list(at(9, 23), "a"), list(at(11), "b"), list(at(13), "b", "c"), list(at(14), "c", "b")];
  expect(bankedGrants(readings, start, end)?.count).toBe(1);
  // The count alone sees no rise from "a" to "b": the list era must not fall back to it.
  expect(bankedGrants([count(at(9, 23), 1), count(at(11), 1)], start, end)?.count).toBe(0);
});

test("the change from count to list readings counts by the count, then by the ids", () => {
  const readings = [count(at(9, 23), 0), list(at(11), "a"), list(at(12), "a", "b")];
  expect(bankedGrants(readings, start, end)?.count).toBe(1);
});

test("a later dated list does not count the same grant a second time", () => {
  const readings: CreditReading[] = [count(at(9, 23), 0), count(at(10, 1), 0), count(at(10, 2), 1),
    { ts: at(10, 3), count: 1, list: [{ id: "same", granted_at: new Date(at(10, 1)).toISOString(), expires_at: "" }] }];
  expect(bankedGrants(readings, start, end)).toMatchObject({ count: 1, complete: false });
});

test("an undated rise across the cycle boundary is not proof of an in-cycle grant", () => {
  expect(bankedGrants([count(at(9, 23), 0), count(at(10, 1), 1)], start, end)).toMatchObject({ count: 0, complete: false });
});

test("a later list can disprove an apparent in-cycle count rise", () => {
  const old: CreditReading = { ts: at(10, 3), count: 1, list: [{ id: "old", granted_at: new Date(at(9, 23)).toISOString(), expires_at: "" }] };
  expect(bankedGrants([count(at(10, 1), 0), old], start, end)).toMatchObject({ count: 0, complete: false });
  expect(bankedGrants([count(at(10, 1), 0), count(at(10, 2), 1), old], start, end)).toMatchObject({ count: 0, complete: false });
});

test("mixed observation histories never exceed the independently known grants", () => {
  for (let seed = 0; seed < 80; seed++) {
    const grants = Array.from({ length: 16 }, (_, index) => ({ id: `credit-${index}`,
      granted: at(8) + ((index * 37 + seed * 13) % 280) * 3_600_000,
      lifetime: (1 + (index + seed) % 4) * 86_400_000 }));
    const readings = Array.from({ length: 41 }, (_, index): CreditReading => {
      const ts = at(9, 23) + index * 6 * 3_600_000;
      const active = grants.filter(grant => grant.granted <= ts && grant.granted + grant.lifetime > ts);
      return { ts, count: active.length, list: (index + seed) % 3 === 0 ? null : active.map(grant => ({
        id: grant.id, granted_at: new Date(grant.granted).toISOString(), expires_at: new Date(grant.granted + grant.lifetime).toISOString(),
      })) };
    });
    const actual = grants.filter(grant => grant.granted >= start && grant.granted < end).length;
    const result = bankedGrants(readings, start, end)!;
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(result.count).toBeLessThanOrEqual(actual);
    expect(result.complete).toBe(false);
  }
});

test("without a reading within a day before the cycle the count starts at the first reading and is a lower bound", () => {
  expect(bankedGrants([count(at(5), 0), count(at(12), 1), count(at(13), 2)], start, end)).toEqual({ count: 1, from: new Date(at(12)).toISOString(), complete: false });
  expect(bankedGrants([count(at(9, 23), 1)], start, end)).toBeNull();
  expect(bankedGrants([], start, end)).toBeNull();
});
