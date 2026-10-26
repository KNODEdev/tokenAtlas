import { expect, test } from "bun:test";
import { capacityPreferencesKey, legacyCapacityMinimum, readCapacityPreferences, writeCapacityPreferences, type CapacityFilterPreferences } from "./capacity-filter-preferences";

const defaults = (): CapacityFilterPreferences => ({ unit: "api_standard", quality: "all", basis: "observed", minimum: 10,
  days: 30, custom: { since: "2026-08-01", until: "2026-09-12" }, plans: {}, hidden: {} });

function storage() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  return { values, restore: () => { if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage"); } };
}

test("capacity preferences round-trip every filter without mixing providers, accounts or counter IDs", () => {
  const store = storage();
  try {
    const selected: CapacityFilterPreferences = { ...defaults(), counter: "five_hour", unit: "tokens", quality: "partial", basis: "regular", minimum: 45,
      days: -1, plans: { weekly: "pro20", five_hour: "plus" }, hidden: { weekly: ["same-id"], five_hour: ["other-id"] } };
    expect(writeCapacityPreferences("codex", "a", selected)).toBe(true);
    expect(readCapacityPreferences("codex", "a", defaults())).toEqual(selected);
    expect(readCapacityPreferences("codex", "b", defaults())).toEqual(defaults());
    expect(readCapacityPreferences("claude", "a", defaults())).toEqual(defaults());
    expect(writeCapacityPreferences("codex", "b", { ...defaults(), hidden: { weekly: ["b-id"] } })).toBe(true);
    expect(readCapacityPreferences("codex", "a", defaults())).toEqual(selected);
  } finally { store.restore(); }
});

test("malformed preferences fall back per field and retain valid hidden IDs", () => {
  const store = storage();
  try {
    const key = capacityPreferencesKey("codex", "a");
    for (const raw of ["{", "null", "[]", "5"]) {
      store.values.set(key, raw);
      expect(readCapacityPreferences("codex", "a", defaults())).toEqual(defaults());
    }
    store.values.set(key, JSON.stringify({ unit: "bad", quality: "bad", basis: false, counter: 123, minimum: 150, days: 999,
      custom: { since: "2026-02-30", until: "2026-03-12" }, plans: { weekly: "pro20", invalid: null },
      hidden: { weekly: ["one", "one", null, 5, "two"], five_hour: false } }));
    expect(readCapacityPreferences("codex", "a", defaults())).toEqual({ ...defaults(), minimum: 100,
      plans: { weekly: "pro20" }, hidden: { weekly: ["one", "two"] } });
    store.values.set(key, JSON.stringify({ counter: "not-a-counter" }));
    expect(readCapacityPreferences("codex", "a", defaults()).counter).toBeUndefined();
    for (const custom of [{ since: "2026-09-12", until: "2026-08-01" }, { since: "2025-01-01", until: "2026-12-31" }]) {
      store.values.set(key, JSON.stringify({ custom }));
      expect(readCapacityPreferences("codex", "a", defaults()).custom).toEqual(defaults().custom);
    }
  } finally { store.restore(); }
});

test("unavailable storage is nonfatal and the legacy minimum is never rewritten globally", () => {
  const store = storage();
  try {
    store.values.set("tokenatlas.codex-capacity-min-observed-percent.v1", "25");
    expect(legacyCapacityMinimum()).toBe(25);
    writeCapacityPreferences("codex", "a", { ...defaults(), minimum: 80 });
    expect(legacyCapacityMinimum()).toBe(25);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    expect(readCapacityPreferences("codex", "a", defaults())).toEqual(defaults());
    expect(writeCapacityPreferences("codex", "a", defaults())).toBe(false);
    expect(legacyCapacityMinimum()).toBe(10);
  } finally { store.restore(); }
});
