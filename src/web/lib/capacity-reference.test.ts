import { expect, test } from "bun:test";
import { readCapacityReference, referenceDifference, referencePercent, resolveReference, snapReference } from "./capacity-reference";

test("snaps within eight pixels and detaches beyond the cycle endpoint", () => {
  const candidates = [{ id: "cycle-a", value: 20 }, { id: "cycle-b", value: 40 }];
  expect(snapReference(41, candidates, 50, 400)).toEqual({ percent: 40, cycleId: "cycle-a" });
  expect(snapReference(43, candidates, 50, 400)).toEqual({ percent: 43, cycleId: null });
  expect(snapReference(79, candidates, 50, 400).cycleId).toBe("cycle-b");
});

test("pins follow cycle identity when refreshed estimates or scale change", () => {
  const reference = { percent: 40, cycleId: "cycle-a" };
  const fresh = resolveReference(reference, [{ id: "cycle-b", value: 20 }, { id: "cycle-a", value: 30 }], 100);
  expect(fresh.value).toBe(30);
  expect(fresh.percent).toBe(30);
  expect(fresh.pinned?.id).toBe("cycle-a");
  const hidden = resolveReference(reference, [], 50);
  expect(hidden.pinned).toBeUndefined();
  expect(hidden.value).toBe(20);
  expect(resolveReference(reference, [{ id: "cycle-a", value: 30 }], 100).pinned?.id).toBe("cycle-a");
});

test("preserves exact out-of-scale pinned values without snapping to clipped ends", () => {
  const candidates = [{ id: "outlier", value: 500 }];
  expect(snapReference(100, candidates, 50, 400).cycleId).toBeNull();
  expect(resolveReference({ percent: 50, cycleId: "outlier" }, candidates, 50)).toMatchObject({ percent: 100, value: 500 });
  expect(referencePercent(-20)).toBe(1);
  expect(referencePercent(120)).toBe(100);
  expect(referencePercent(NaN)).toBe(1);
});

test("reads the optional comparison line and measures it against the first", () => {
  const store = new Map([
    ["old", JSON.stringify({ percent: 40, cycleId: null, badgePosition: 0.5 })],
    ["pair", JSON.stringify({ percent: 40, cycleId: "a", badgePosition: null, compare: { percent: 140, cycleId: "b" } })],
    ["broken", JSON.stringify({ percent: 40, cycleId: null, badgePosition: null, compare: { percent: "x", cycleId: null } })],
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => store.get(key) ?? null } });
  try {
    expect(readCapacityReference("old", 50)).toEqual({ percent: 40, cycleId: null, badgePosition: 0.5, compare: null });
    expect(readCapacityReference("pair", 50).compare).toEqual({ percent: 100, cycleId: "b" });
    expect(readCapacityReference("broken", 50).compare).toBeNull();
    expect(readCapacityReference("missing", 50)).toEqual({ percent: 50, cycleId: null, badgePosition: null, compare: null });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  expect(referenceDifference(1247, 1561)).toEqual({ value: 314, relative: 314 / 1247 * 100 });
  expect(referenceDifference(0, 10).relative).toBeNull();
});
