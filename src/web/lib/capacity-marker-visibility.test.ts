import { expect, test } from "bun:test";
import { CAPACITY_MARKER_TYPES, readCapacityMarkerTypes, writeCapacityMarkerTypes } from "./capacity-marker-visibility";

test("event preferences accept intentional empty choices and fall back safely for invalid or unavailable storage", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let value: string | null = null;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => value, setItem: (_key: string, next: string) => { value = next; },
  } });
  try {
    expect(readCapacityMarkerTypes()).toEqual(CAPACITY_MARKER_TYPES);
    writeCapacityMarkerTypes([]);
    expect(readCapacityMarkerTypes()).toEqual([]);
    writeCapacityMarkerTypes(["event", "model", "model"]);
    expect(readCapacityMarkerTypes()).toEqual(["model", "event"]);
    for (const invalid of ['{"reset":false}', '["unknown"]', 'false', '{']) {
      value = invalid;
      expect(readCapacityMarkerTypes()).toEqual(CAPACITY_MARKER_TYPES);
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage denied"); } });
    expect(readCapacityMarkerTypes()).toEqual(CAPACITY_MARKER_TYPES);
    expect(() => writeCapacityMarkerTypes([])).not.toThrow();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
